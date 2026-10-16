# PlayBack

Local demo for a pickleball facility. A laptop records Court 1 from the cameras plugged into it, saves the full video on that computer, and plays it back with the manual score. Players check in, the host confirms the score, and a verified result updates the PlayBack Internal Rating (PIR) once. PIR is an Elo-style club rating. It is not DUPR. Video analysis does not change it.

Each court end has its own camera slot. Two cameras record two files. One camera records the end it is assigned to, and the other end stays unavailable. The app does not copy one webcam onto both ends. Older sessions that have a single unlabeled file still play.

The score is entered by hand. A game is to 11. Teams stay on the sides where they started. Team A stays red and Team B stays blue.

Full files are kept. Rally windows are derived from the score, with a short pause trimmed at each end. Mark highlight only stars a rally. Replay can show the full match, every rally with the dead time skipped, or starred rallies only. A rally is played from the camera on that team’s end at that moment. There is no rendered highlight export.

On the replay screen, “Send this video on Zalo” is optional. It stores a Zalo or phone number on this computer for a later delivery. Watching and downloading do not need it. Marketing consent is a separate checkbox with its own timestamp. Opt-out is a button on the same screen. No Zalo message is sent, and there is no Zalo API.

This is not a SwingVision copy. The layout, name, and visual design are original. SwingVision is only a reminder that players want replay, a scoreboard, bookmarks, and a session list. PlayBack does not track the ball, call lines, identify players, or coach with AI. The laptop webcam proves the recording and delivery workflow only. Real court footage is required later before anyone can evaluate ball tracking or automatic scoring.

## Prerequisites

- Node.js 22.13 or newer (`node -v`)
- npm 10
- A Chromium-based browser for the demo (Chrome or Edge). Playwright downloads its own Chromium for tests.
- A laptop webcam for the physical check. Automated tests use a synthetic camera.

No cloud account, API key, or paid service is required.

## Install

```bash
npm install
npx playwright install chromium
```

Defaults live in code and match `.env.example`. Copy that file to `.env` only when you need to change them.

## Five-minute demo

`DEMO_GUIDE.md` walks through language, the 8-court dashboard, Court 1 check-in, a verified score, PIR, a player profile, matchmaking, and optional equipment. Courts 2–8 can run that result path with no webcam. Only Court 1 uses the laptop camera.

## Develop

```bash
npm run dev
```

Open http://127.0.0.1:5173

The API listens on http://127.0.0.1:8787. Vite proxies `/api` to it. This default is localhost only. A phone cannot open it.

## Client test on the same Wi-Fi

The phone and the laptop must join the same Wi-Fi. On a phone, `localhost` means the phone itself, so the QR code has to use the laptop’s LAN address.

```bash
npm run dev:lan
```

LAN mode binds the dev site and the API to `0.0.0.0`. The terminal prints a URL such as `http://192.168.x.x:5173`. That address is for the phone QR. The laptop records at http://127.0.0.1:5173. An amber bar says this is a demo with no production login. The QR code and the court link use the LAN address, for example `http://192.168.x.x:5173/court/court-1`. They do not silently stay on localhost.

Scan the QR code with the phone. The phone only opens the QR. The phone browser opens the Court Replay page for that court. The page says recording stays on the laptop. It does not ask for the phone camera, and it cannot start the laptop webcam. Start the session in Chrome on the laptop at http://127.0.0.1:5173.

To force a chosen address, set `PUBLIC_BASE_URL` to that host before starting, for example `PUBLIC_BASE_URL=http://192.168.1.20:5173 npm run dev:lan`. A localhost value is ignored while LAN mode is on. `npm run dev` stays on this computer only.

## Production build

```bash
npm run build
npm start
```

Open http://127.0.0.1:8787

`npm start` serves the built site and the API together. If `PUBLIC_BASE_URL` is unset and LAN mode is off, production links use `http://127.0.0.1:8787`. With `LAN_MODE=true`, they use the laptop’s LAN address on port 8787. An explicit `PUBLIC_BASE_URL` that is not localhost still wins. QR codes and session links use that value.

## Tests

```bash
npm run typecheck
npm test
```

`npm test` runs server tests, translation checks, and Playwright. Playwright uses a synthetic camera, not the physical webcam.

## Storage

- Database: `data/court-replay.db`
- Recordings: `data/recordings/`
- End-to-end tests use `data/e2e/` and the test server clears that folder when it starts

The facility dashboard can restore demo players and club matches. Type `RESET DEMO` there. That reset keeps files in `data/recordings/`. Do not delete the recordings folder to reset ratings.

## Camera, QR, and LAN

- The browser asks for the camera only after consent and Enable camera.
- Camera-only recording works if the microphone is refused.
- The laptop records at http://127.0.0.1:5173. The phone only opens the QR. `http://127.0.0.1` and `http://localhost` can use the laptop camera, including the FaceTime camera. Chrome blocks the camera on a LAN address such as http://192.168.x.x:5173.
- `localhost` on a phone means the phone itself. For a client on the same Wi-Fi, run `npm run dev:lan` and scan the QR code. The phone opens `http://192.168.x.x:5173/court/court-1` and does not start a camera.
- LAN mode is a demo on a trusted network. There is no production login. Do not expose this demo on the public internet. Recording stays on the laptop.

## Browsers

Automated tests ran in Playwright’s Chromium with a synthetic camera. Use current Chrome or Edge on the laptop for the physical webcam check. Safari and Firefox were not part of the automated run.

## What a session link means

A watch link is an unguessable token. Anyone who has the link can open that session. It is not a user account. A `localhost` or `127.0.0.1` link works only on the recording computer.
