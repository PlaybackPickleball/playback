# Playback Rating 1.0

Playback Rating is the one rating on each player in `players`. It is the familiar pickleball scale, not DUPR and not a raw 1500 Elo number.

| Category | Range |
| --- | --- |
| Beginner | 2.0–2.9 |
| Intermediate | 3.0–3.9 |
| Advanced | 4.0–4.9 |
| Expert | 5.0 and above |

The number is stored in the existing `players.pir_rating` column. There is no second rating column and no second player id. `club.ts` remains the live player source.

## Legacy Elo mapping

Older rows stored an Elo-style integer (start 1500). On the first schema pass after this change, a value of 100 or more is converted once and the database is marked `rating_scale = playback-1.0` in `app_meta`:

```
playback = round(3.5 + (elo - 1500) / 200, 2)
```

So 1500 becomes 3.50, 1300 becomes 2.50, and 1700 becomes 4.50. Two hundred stored points were one level. A value below 100 is already on the pickleball scale and is left alone. New writes store the scale directly (3.42, not 1484). `toPlayback` still converts a leftover Elo integer on read, so Play Now, the profile, and history show 2.0–5.0 even if a snapshot was missed.

The live database was copied to `data/court-replay-pre-playback-rating-20261016.db` before the schema additions.

## Provisional starts

A self-selected start has zero verified matches. It is provisional and never established.

| Choice | Start |
| --- | --- |
| Beginner | 2.5 |
| Intermediate | 3.5 |
| Advanced | 4.5 |
| Expert | 5.0 |

An optional precise start from 2.00 to 8.00 replaces that mark and is still provisional. New guests with no choice start at 3.5. A start can be set only while the player has no verified matches and no rating history.

Established means 5 or more verified matches. That is the same count that leaves the Low confidence band. The two fields are still separate: K uses provisional or established, and the label uses the band below. They can be split later without changing the stored rating.

## Algorithm `playback-rating-1.0`

The engine is `server/src/playbackRating.ts`. Every history row stores `algorithm_version`.

Team rating is the average of the players on that side (one player in singles, two in doubles).

```
ExpectedA = 1 / (1 + 10 ^ ((TeamB - TeamA) / 0.8))
ExpectedB = 1 - ExpectedA
raw       = K * (actual - expected) * scoreModifier
```

`actual` is 1 for a win and 0 for a loss. K is **0.08** while that player has fewer than 5 verified matches, and **0.04** from the fifth match on. Each player is updated from their own pre-match rating and their own K. The stored rating is rounded to 0.01. The history delta is `ratingAfter - ratingBefore`.

### Score modifier

The modifier is always between 0.25 and 1.25, so it cannot flip the sign of `(actual - expected)`.

```
marginRatio = |winner - loser| / target
decisive    = 6/11
raw         = marginRatio / decisive
modifier    = clamp(raw, 0.25, 1.25)
```

On a game to 11 that is 11–9 close (about 0.33), 11–5 decisive (1), and 11–1 or 11–0 dominant (capped at 1.25). Games to 15 and 21 use the same ratio. A legal score reaches the target and wins by two. Past the target the margin must be exactly two (12–10, 16–14, 22–20).

### Zero-sum

When every player has the same K, the raw deltas sum to 0 because the sides use opposite `(actual - expected)` and the same K. Rounding to 0.01 can leave a residue of at most 0.01 per player.

When K differs, the match is not zero-sum. A provisional player moves twice as far as an established player in the same match. That is the deviation from equal weighting. Confidence does not scale the delta.

### Explanations

| Code | Sentence |
| --- | --- |
| `beat_stronger` | Your rating increased because you beat a stronger team. |
| `expected_win` | Your rating changed little because your team was expected to win. |
| `lost_to_weaker` | Your rating decreased because your team lost to a weaker team. |
| `expected_loss` | Your rating changed little because your team was expected to lose. |

A win against a side you were not expected to beat uses `beat_stronger`. A win you were expected to take (team expected score at least 0.60) uses `expected_win`.

## Confidence

Confidence is a label, not a probability:

| Verified matches | Label |
| --- | --- |
| 0–4 | Low |
| 5–19 | Medium |
| 20 or more | High |

Play Now still needs a number for the level window. That weight is 0.15 / 0.55 / 0.85 for Low / Medium / High. It only widens or tightens the existing tolerance. It is not shown as a percent. Opponent reliability, recency, and opponent diversity are future inputs. They are not in the label and not in K.

## Verification

A recording, a simulated start, or a saved score does not move ratings.

1. A participant submits the teams and a score to 11, 15, or 21. The submitted players must be exactly the people on the recorded match. Anyone else is rejected.
2. The result stays `pending`. Ratings do not change.
3. A player on the **other** team confirms. The submitter cannot confirm their own side.
4. Confirmation sets the match verified and applies the rating once inside a transaction (`BEGIN IMMEDIATE`, and the row updates only while `ratings_applied = 0`). The history primary key also rejects a second row for the same player and match.
5. A second confirm is idempotent: same ratings, `replayed: true`.
6. A dispute sets `result_status` to `disputed` and does not change ratings. Confirm is refused until a facility admin resolves it.
7. An admin with the existing `x-admin-token` (local demo token `demo-admin` unless `PLAYBACK_ADMIN_TOKEN` is set) can resolve a dispute, which then applies ratings once. Correcting an already verified score replays that match and every later verified match that shares a player, in `verified_at` order, from each player's pre-match rating. The old delta is not subtracted.

Joining a court, booking a slot, or accepting a Play Now game does not write a rating.

## Profile

The player page shows the Playback Rating, wins, losses, and one plain sentence for each verified match (`pbExplainBeatStronger`, `pbExplainExpectedWin`, `pbExplainLostWeaker`, `pbExplainExpectedLoss`, plus the small-change sentences). English and Vietnamese keys live in both dictionaries. The page also shows category, confidence, verified matches, win rate, last match date, and provisional or established. History rows show teammate, opponents, score, and a recording link when the match has one. Demo rows are labeled demo.

## Screens

The rating math is unchanged.

- **Leaderboard** is `/leaderboard` (`GET /api/leaderboard`, `LeaderboardPage`). Overall and this club. Rank, name, rating, confidence, verified matches. Competitive rows need at least 5 verified matches and are not ordered by win rate. Provisional players are listed apart. Opted-out players are omitted. Facility scope uses `home_facility_id`. Linked from the player list and the player page.
- **Play Now** is `/play`. It calls `POST /api/play/search` (doubles, 5 km, ASAP by default) and shows join an existing game, build a game, and join the queue, with rating, the plain explanation, and the recommended pairing once four players are known. Join uses `POST /api/play/open-matches/:id/join` and does not write a rating. The demo user picks a seeded demo player; that id is sent as `x-player-id`.

## Schema

Added, not rebuilt:

- `players.leaderboard_opt_out`
- `matches.result_status`, `submitted_by`, `confirmed_by`, `disputed_by`, `score_target`
- `rating_history.algorithm_version`, `delta`, `won`, `explanation`, `band_before`, `band_after`
- `app_meta` for the one-time scale migration

`result_status` is `none`, `pending`, `disputed`, or `verified`. The match lifecycle status stays `scheduled`, `ready`, `recording`, `completed`, or `verified` so the existing check constraint is unchanged. Disputed matches stay `completed` until an admin resolves them.

Demo reset still restores demo players and removes demo-only matches. It does not delete sessions, recordings, or players with `demo = 0`.

## Tests

- `server/test/playbackRating.test.ts` — scale mapping, provisional starts, confidence bands, upset versus favorite, doubles averages, score cap and sign, equal-K near zero-sum, mixed-K deviation, Play Now still reading the scale.
- `server/test/playbackResult.test.ts` — opponent confirm, one update, idempotent second confirm, history and algorithm version, fabricated roster, dispute blocks the update, admin resolve, concurrent confirms apply once, correction replays later matches, self-selected start stays provisional, leaderboard minimum and opt-out.
- `web/src/i18n/parity.test.ts` — the new English and Vietnamese strings exist in both dictionaries.

## Confirm-result demo

Four labeled demo players:

| Player | Id | Rating |
| --- | --- | --- |
| Minh Trần | `demo-minh` | 3.40 |
| An Nguyễn | `demo-an` | 3.50 |
| Khoa Lê | `demo-khoa` | 3.60 |
| Hà Vũ | `demo-ha` | 3.70 |

On a simulated court (not court 1), put Minh and An on team A and Khoa and Hà on team B, start the match, then open the result page.

1. Acting as Minh, game to 11, score 11–7, **Submit result**. Ratings do not move. The result is pending.
2. Acting as Khoa or Hà, **Confirm match result**. Ratings move once. History and the player page show the change and a sentence such as the underdog win.
3. Confirm again. The rating does not move a second time.

The same steps are covered by `playbackResult.test.ts`. Reset demo restores these four ratings and does not delete real recordings.

## Future work

- Feed opponent reliability, recency, and opponent diversity into confidence. They are not in the number yet.
- Separate the provisional threshold from the Low band if a longer provisional period is wanted.
- Let an admin edit teams during a correction, not only the score.
- Calibrate K against a larger set of real matches before treating the scale as established for the club.
