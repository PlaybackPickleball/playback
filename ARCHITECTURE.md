# PlayBack architecture

PlayBack is a local demo. The product name in the interface is PlayBack. English and Vietnamese are both required.

## Processes

`npm run dev` starts two processes:

- The API is Express on http://127.0.0.1:8787.
- The site is Vite on http://127.0.0.1:5173. Vite proxies `/api` to the API.

`npm run dev:lan` binds both to `0.0.0.0` and puts the laptop LAN address in QR codes. The laptop still records at http://127.0.0.1:5173. Chrome allows the camera on loopback only.

`npm run build` then `npm start` serves the built site and the API together on port 8787.

## Two records that stay separate

A **session** is a recording. Its statuses are draft, recording, saving, ready, and failed. Only Court 1 can create one. Consent is stored before the camera starts. The phone court page does not import the camera module and does not call `getUserMedia`.

A **match** is a competitive result. Its statuses are scheduled, ready, recording, completed, and verified. The host types the score and verifies it. The video is not read to decide the winner. Verifying applies PIR once.

Court 1 links the match to the session token when the host starts from check-in. Courts 2–8 can start, score, and verify with no session and no webcam. Their facility cards say they are simulated.

## Modules

- `server/src/app.ts` owns sessions, manual score events, video files, contacts, and people.
- `server/src/club.ts` owns players, check-in, match state, equipment, the facility summary, and the one-time rating write.
- `server/src/pir.ts` is the rating function. The UI does not calculate PIR.
- `server/src/matchmaking.ts` recommends a doubles split. It does not create a match.
- `server/src/videoJob.ts` always returns an unavailable analysis job. It has no events and a null confidence. It cannot change a rating.
- `web/src/lib/media.ts` is the only place that calls `getUserMedia`. Record and setup pages use it. The court page does not.

## What is stored

SQLite file `data/court-replay.db`. Video files live under `data/recordings/`. Resetting demo data deletes club rows and seeds the demo players again. It does not delete recording files.

Demo players and the facility summary survive a browser refresh because they are in the database, not in page memory.
