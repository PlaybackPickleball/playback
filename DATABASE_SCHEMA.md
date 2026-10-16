# Database schema

SQLite file: `data/court-replay.db`. Video bytes stay in `data/recordings/`. The app uses `node:sqlite`.

Recording tables and club tables share one file and do not share a winner. A session never infers a match result.

## Recording tables

`sessions` stores the laptop recording: public token, court, singles or doubles, status (`draft`, `recording`, `saving`, `ready`, `failed`), team name JSON, consent time, timing, and video metadata.

`score_events` and `highlights` hang off a session. A game is to 11, and new sessions do not store an end switch. Teams stay on the sides where they started. `contacts` and `people` store an optional Zalo or WhatsApp number and a demo credit balance. That balance is not a payment.

Deleting a session deletes its rows and its recording files.

## Club tables

`players` — id, display name, language (`en` or `vi`), optional skill, preferred hand (`left`, `right`, `either`), `pir_rating`, wins, losses, matches played, equipment JSON, equipment consent time, recording consent time, demo flag, guest flag.

Demo ids are `demo-minh`, `demo-lan`, `demo-an`, `demo-khoa`, `demo-ha`, `demo-quang`, `demo-mai`, and `demo-tuan`. Guest ids start with `guest-`. The id is the public check-in id. It is not a password.

`matches` — id, court, facility id `demo-facility`, mode, status (`scheduled`, `ready`, `recording`, `completed`, `verified`), times, duration, score, winner (`A` or `B`), session token, score confirmation time, verification time, `ratings_applied`, simulated flag.

`match_players` — match id, player id, team `A` or `B`. One player row per match.

`rating_history` — one row per player per match (`PRIMARY KEY (match_id, player_id)`), with rating and confidence before and after. A second verify cannot insert another row.

`demo_analytics` — one brochure row (English and Vietnamese title and body). It is not a stat and it is not an input to PIR.

## Reset

`POST /api/facility/reset` with `{ "confirm": "RESET DEMO" }` deletes club matches, rating history, and players, then inserts the demo players again. It does not delete `sessions`, `contacts`, `people`, or files in `data/recordings/`.
