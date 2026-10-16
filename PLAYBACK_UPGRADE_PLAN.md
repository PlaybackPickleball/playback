# PlayBack upgrade plan: Play Now, Smart Queue, Smart Court Fill, bookings

This is an upgrade of the existing PlayBack app. It is not a rewrite. The stack stays: Express + `node:sqlite` on the server, React 19 + Vite + Tailwind on the web, Vitest and Playwright for tests.

Status words used below: **Implemented** means code exists and a test or manual run covered it. **Roadmap** means not built.

## Phase 0 findings (2026-10-15, before any change)

### Coordination with the player-intelligence work

- Checked `find . -path ./node_modules -prune -o -type f -mmin -5 -print`: nothing had changed for about 17 minutes, so shared files were quiet. The last source write was 21:54.
- The repo has no commits (`git status`: no commits yet), so there is no diff to compare. Everything is untracked.
- `server/src/club.ts` and `server/src/club-routes.ts` are the **wired** player/match/check-in/PIR/facility implementation. `app.ts` mounts them. They are what the 40 existing server tests exercise.
- `server/src/intelStore.ts` and `server/src/intelRoutes.ts` are a second, **unwired** draft. Nothing imports them. Their `players` table (`slug`, `pir`) conflicts with `club.ts`. I did not touch them and I do not build on them. Dependency note: if the other work later wires `IntelStore`, both would fight over the `players`, `matches`, and `rating_*` tables, so one of them has to win.
- The checked-in data file `data/court-replay.db` had a third, older shape (`players.is_demo`, `rating_history.id`). The current code then failed to boot against it (`no such column: demo`). The unit tests do not show this because they use fresh databases. I made a repair migration (below) rather than deleting anything.

### What works today (reused as is)

| Area | Where | Reuse |
| --- | --- | --- |
| Laptop webcam record, save, replay, last-point replay | `app.ts`, `RecordPage`, `ReplayPanel`, `media.ts` | untouched |
| Phone QR court page, no `getUserMedia` | `CourtPage`, `QrCard` | untouched |
| Manual score to 11, no end switch, watch left/right scoring, serve reminder, red/blue teams | `ScorePage`, `TapBoard`, `lib/score.ts` | untouched |
| Zalo/WhatsApp contact with skip, facility contacts, demo credit balance | `contacts`, `people`, `ContactScreen`, `PersonPage` | untouched |
| Players, court check-in, match lifecycle scheduled, ready, recording, completed, verified | `club.ts`, `lifecycle.ts` | reused: `joinCourt`, `verifyMatch`, `getPlayer` |
| PIR rating, confidence (`n / (n + 8)`) | `pir.ts` | reused for skill and provisional flag |
| Three-pairing evaluator | `matchmaking.ts` `recommendDoubles` | reused for balanced teams |
| 8 demo courts on the facility dashboard | `club.ts` `facilitySummary` | reused, new panels added beside it |
| EN/VI dictionaries and key-parity test | `i18n/*` | extended |

### Gaps this upgrade fills

No court inventory or prices, no bookings, no holds, no geography, no open games, no queue, no notifications, no owner controls, no per-role authorization, no facility other than `demo-facility`, no demo players beyond 8.

## Design decisions

1. **New server code lives in `server/src/play/`.** Existing files change only at four seams: `club.ts` (legacy repair call, one hook after verify), `club-routes.ts` / `app.ts` (mount), `club.ts` `resetDemo` (also reseed play data). No new dependency.
2. **Identity.** Players keep their existing `players.id`. There is no second identity system. A demo sign-in (`POST /api/auth/player`) issues a random session token for that player id. It is labeled demo and there is no password. Facility owner actions need a facility session from `POST /api/auth/facility` with the demo PIN (`FACILITY_DEMO_PIN`, default `2468`). Both are `X-Auth-Token` bearer tokens stored in `auth_sessions`. This is local-demo authorization, not production auth, and the UI says so.
3. **Inventory = slots.** `court_availability` holds one row per court per hour with price, source, last-updated, and `booking_id`. A booking occupies slots by a conditional `UPDATE ... WHERE booking_id IS NULL` inside a `BEGIN IMMEDIATE` transaction. `UNIQUE(booking_slots.slot_id)` is a second guard. Two concurrent requests for the same slot cannot both win.
4. **Holds are bookings in state `held` with an expiry.** `court_holds` records the hold lifecycle. A sweep at the start of every play request, plus a timer, expires holds and releases slots.
5. **Idempotency.** Mutating booking endpoints accept an `Idempotency-Key` header. `idempotency_keys(scope, key)` stores the first response. A replay returns the same body and does not mutate again.
6. **Time.** A clock is injected so tests control "now". Slots are hourly. Display timezone is Asia/Ho_Chi_Minh (UTC+7). Stored times are ISO UTC.
7. **Money.** Integer VND. Format `Intl.NumberFormat('vi-VN', {currency:'VND'})`. Pay at Facility only. The app never says a payment was taken.
8. **Ranking.** Hard filters first, then weighted score. Weights are in one exported constant: skill 0.45, schedule 0.25, distance 0.20, reliability 0.10. Reliability needs at least 5 real outcomes; if absent the weight is dropped and the rest are renormalized, and the response says so. Ratings and confidence come from `players.pir_rating` and `pir.confidence`.
9. **Rating safety.** Nothing in the play module writes `pir_rating`. Only `verifyMatch` does, once, as before.
10. **No fake AI, no fake inventory.** All facilities, players, slots, bookings, and queue entries seeded by this upgrade carry `demo = 1` and a visible "Demo data" label. Estimated waits are `null` unless there are at least 5 real queue assignments to compute a median from.

## Database changes (additive migrations, `schema_migrations` table)

Nothing existing is dropped or overwritten. `data/backups/` holds a timestamped copy of the SQLite file taken before any change (`court-replay-20261015-221326.db`). It is ignored by git through `data/`.

| Migration | Contents |
| --- | --- |
| `000_legacy_repair` | If `players.demo/guest` are missing, add them and copy from `is_demo/is_guest`. If `rating_history` has an `id` column, copy it into the current shape inside a transaction and swap. No row is lost. |
| `001_play_core` | `facilities`, `courts`, `player_preferences`, `player_availability`, `court_availability`, `bookings`, `booking_players`, `booking_slots`, `booking_status_log`, `court_holds`, `idempotency_keys`, `auth_sessions` |
| `002_open_matches` | `open_matches`, `open_match_players`, `match_invitations`, `play_now_requests` |
| `003_queue` | `queue_entries` (partial unique index on active players), `queue_assignments`, `queue_events` |
| `004_fill_notify` | `promotion_rules`, `revenue_attributions`, `notifications`, `notification_prefs` |
| `005_demo_seed` | Idempotent seed (`INSERT OR IGNORE`) of 3 demo facilities, 17 courts, 12 more demo players with coordinates, preferences, slots, example bookings, an open match, invitations, queue entries. Also re-run by the protected reset. |

Full column lists are in `DATABASE_SCHEMA.md`.

## API endpoints (new, all under `/api`)

- Auth: `POST /auth/player`, `POST /auth/facility`, `GET /auth/me`
- Facilities and availability: `GET /facilities`, `GET /facilities/:id/availability?date=`
- Bookings: `POST /bookings` (hold), `GET /bookings/:id`, `POST /bookings/:id/confirm|cancel|check-in`, `GET /me/bookings`, `GET /checkin/:token`, `POST /checkin/:token`
- Play Now: `PUT /me/preferences`, `GET /me/preferences`, `POST /play/now`, `POST /play/build`, `POST /play/open/:id/join`, `POST /play/open/:id/leave`, `GET /play/open/:id`, `GET /play/open/:id/teams`, invitation endpoints (`GET /invitations/:token`, `POST /invitations/:token/accept|decline`)
- Queue: `POST /queue/join`, `POST /queue/:id/cancel`, `POST /queue/offers/:id/accept|decline`, `GET /facilities/:id/queue`, `GET /me/queue`
- Facility owner (token required): `GET /facility-admin/overview`, `POST /facility-admin/smart-fill/settings`, `POST /facility-admin/smart-fill/publish`, `POST /facility-admin/requests/:id/approve|reject`, `POST /facility-admin/queue/policy`, `POST /facility-admin/queue/add`, `POST /facility-admin/courts/:id/free`, `POST /facility-admin/courts/:id/status`
- Notifications: `GET /me/notifications`, `POST /me/notifications/read`, `GET|PUT /me/notification-prefs`
- Demo: `POST /demo/play-reset` (requires `{confirm:"RESET DEMO"}` and facility token); the existing `POST /facility/reset` also reseeds.

Public (no token) endpoints return no private data: no phone, no Zalo number, no email, no equipment, no consent timestamps. Open match listings show first name, initials, rating, and confidence only.

## Order of work

1. DB backup, legacy repair, plan. (done first)
2. Slice 1: facilities, courts, slots, bookings, holds, state machine, idempotency, concurrency test.
3. Play Now (preferences, hard filters, ranking, 3 categories, join, build, invitations), balanced teams, check-in QR, match bridge to `club.ts`.
4. Smart Queue.
5. Smart Court Fill and revenue attribution.
6. Notifications.
7. Web: dictionaries, Play Now, bookings, queue, notifications, player dashboard, facility business panel.
8. Docs, e2e, final checks.

## Tests

Server (Vitest, in `server/test/play-*.test.ts`): distance and radius, hard filters, ranking weights and renormalization, provisional ratings, balanced teams, double-booking under concurrent HTTP requests, hold expiry, cancellation release, transition table and log, idempotency, player conflict, queue uniqueness, FIFO/skill/hybrid, decline and timeout, invitation accept/decline, rating only after verify and only once, authorization (public APIs hide private fields, wrong role gets 401/403). Web: EN/VI parity (existing test covers all keys), VND formatting. Playwright: existing flow must still pass; one new demo-path spec if the environment allows it.

## Honest limits

- Zalo messages are never sent. Invitation links are copied or shared by hand.
- Payment is never processed. Pay at Facility only.
- Estimated queue wait is `null` unless real history supports it.
- Balanced teams is an estimate from PIR, not guaranteed fairness.
- Demo auth is not production auth.
