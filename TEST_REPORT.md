# Court Replay test report

Date: 15 October 2026

## Environment

- macOS, Node v22.14.0, npm 10.9.2
- Automated browser: Playwright Chromium (Chrome for Testing 156.0.8078.4) with `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`
- Production UI check: Cursor’s built-in browser against `http://127.0.0.1:8787`
- `node:sqlite` `DatabaseSync` (experimental warning only)
- ffmpeg is not installed and is not used by the app
- No `.env` file. Defaults match `.env.example`

## Commands and results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. Server and web TypeScript checks completed with no errors. |
| `npm run test:unit` | Passed. Server API tests: 7. Web tests: 4 (score undo and EN/VI key parity). |
| `npx playwright test` | Passed. 6 tests, 1 worker, about 24 seconds. |
| `npm run build` | Passed. Server `tsc` and Vite production build completed. |
| `npm start` | Production server listened on `http://127.0.0.1:8787`, served the built UI, and returned config and dashboard without a server exception. |

## Recording evidence

Synthetic camera only. Playwright recorded a singles session (Lan vs Minh), switched to Vietnamese while the timer was running, and waited until the on-screen timer reached 15 seconds. After save:

- Playback duration was finite and greater than 10 seconds.
- A decoded frame had non-black pixels (width and height above 0, lit-pixel sample above 10).
- Both scores were incremented and the last point was undone, leaving 1–1 after reload.
- Two highlight bookmarks were saved. Clicking each sought to about 3 seconds before that mark.
- Download returned `video/*` larger than 1000 bytes with a `court-replay_court-1` filename.
- The session link opened the same score in a second tab.
- Dashboard saved-session count included that session. Delete removed it. The old watch URL showed the Vietnamese not-found page.
- The only HTTP 404s in that journey were the expected requests for the deleted session token.

A second Playwright journey refused the microphone, still recorded video, failed the first save on purpose, retried once, and left exactly one ready session.

## What was fixed during this run

- Score and highlight rows were stored, but the read queries did not bind the session id, so replay showed 0–0.
- The e2e folder cleanup ran after the API had already created `data/e2e`, so the first real upload could not write the file. The test server now clears that folder as it starts, and the upload path creates the recordings directory again if it is missing.
- `npm start` did not set production mode, so the built site was not served. It now does.
- Vietnamese used the English word “Camera” for the camera section. It now says “Máy quay”.
- A strict text locator matched the player name twice during recording.

## Browser check of the built site

On `http://127.0.0.1:8787` the home page showed Court 1, a court link of `http://127.0.0.1:8787/court/court-1`, and the note that the laptop camera does not evaluate ball tracking or automatic scoring. Switching to Tiếng Việt translated the page, including “Bắt đầu phiên chơi” and “Sân 1”. Setup kept Tiếp tục disabled until consent. The dashboard empty state showed “0 đã lưu”, “0 phút”, and “Bắt đầu phiên đầu tiên”. No server exception appeared in the production log.

## Physical webcam

Passed on 15 October 2026. This check used the laptop’s FaceTime HD Camera, not Playwright’s synthetic camera.

What ran: `npm run dev` from the project root (API on `http://127.0.0.1:8787`, Vite on `http://127.0.0.1:5173`). The Cursor IDE browser opened `http://127.0.0.1:5173`. Court 1, singles, players Nicola and Minh, consent checked, microphone left off. Enable camera opened the FaceTime HD Camera (`640×480`, 30 fps, track label `FaceTime HD Camera (CDBF:5350)`). The live preview showed the room and a person. Recording then ran until Stop & save. One point was added for each side and the Team B point was undone, leaving 1–0. Two highlights were marked.

Saved session:

- Watch URL: `http://127.0.0.1:5173/watch/Uao0H4K7kEioUM1eByCQ8g-pKK33US7d`
- File: `data/recordings/Uao0H4K7kEioUM1eByCQ8g-pKK33US7d.webm`
- Size: 11,481,844 bytes (the watch page shows 10.9 MB)
- Duration: 37.248 seconds (finite). The on-screen timer reached about 0:37. The intended length was about 15 seconds; the timer kept running while the points and highlights were entered.
- Replay at 8 seconds decoded a `640×480` frame with real room detail, not a blank player. Highlight 1 (26 sec) sought to 22.931 seconds, about 3 seconds before that mark.
- Server log for this session had no exception. Create, start, and video upload returned 201 or 200.

No remaining blocker for this laptop camera path. The dev server was left running so the watch URL can still be opened.

## Limitations

- Safari and Firefox were not part of this run.
- A localhost link is not reachable from a phone. A phone that opens the QR code does not start the laptop camera.
- Closing the browser during recording can lose unsaved footage. There is no crash recovery.
- Highlight clips are not exported. Bookmarks only seek inside the full recording.
- Share via Zalo copies the link or opens the device share sheet. It does not send a Zalo message.
