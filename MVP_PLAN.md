# PlayBack functional MVP

PlayBack is a local pickleball demo. The laptop webcam records Court 1, saves the file on this computer, and replays it with a manual score. A phone that scans a court QR code opens the court page only. It does not start a camera.

This plan is the functional MVP. It does not include ball tracking, line calls, face recognition, or brand recognition. Computer vision is a later phase and must not change the rating number.

## Preserved

- Record, save, and replay on http://127.0.0.1:5173 with the laptop webcam.
- Recording consent is required before the camera turns on.
- The phone court page does not call `getUserMedia`.
- Localhost may use the laptop camera. A LAN address may not.
- Manual score in a game to 11, teams staying on their starting sides, and last-point replay.
- Watch-page scoring from the left or the right when that mode is selected.
- Optional Zalo or WhatsApp number, with skip. Marketing consent is separate. Nothing is sent.
- Facility contacts and a demo credit balance that is not a payment.
- Court photos on the home, court, setup, watch, and dashboard screens.

## Players

Each player has a unique id, display name, avatar initials, language, optional skill, preferred hand, match history, PIR rating, confidence, wins, losses, optional equipment, and consent timestamps.

Demo players are seeded and labeled demo. A typed name creates a guest. A player check-in QR is only the player page URL. It contains no password.

## Court check-in

The court QR opens check-in. A person picks a demo profile or types a name, joins, and is placed on Team A (red) or Team B (blue). Names stay visible. Singles holds one player per team. Doubles holds two. The same player cannot join twice. Filling the roster marks the match ready. The host starts it by hand. Nothing starts by itself.

Court 1 then continues to the existing consent and camera screens. Courts 2–8 are simulated and never open the laptop webcam.

## Matches

A match is stored separately from the recording session. Status moves scheduled → ready → recording → completed → verified.

The row stores the court, the demo facility, time, singles or doubles, players, teams, duration, host-entered score, winner, linked recording when there is one, and status. The host types the score and confirms it. The result is not read from the video. Verification applies the rating once.

## PIR

PIR is an Elo-style rating in its own module, not a widget inside the page. Doubles use the average rating of each team. Confidence is lower when a player has few matches. It is not DUPR. Future computer-vision signals are not inputs.

## Dashboards

The player page shows stored wins, losses, rating, confidence, and rating history. Serve speed, placement, and movement say they are not available yet. A separate brochure box is labeled as a demo illustration and is not calculated from matches.

The facility page is the PlayBack Demo Club: 8 courts, active sessions, completed matches, players, recording time, and participation. Court 1 is the laptop webcam. Courts 2–8 are labeled simulated. There is no revenue figure. Reset asks for a confirmation phrase and restores demo players and demo matches only. Recording files stay.

## Demo persistence

Players, check-in, matches, scores, and ratings are in SQLite, so a refresh keeps them. Language choice stays in the browser. The facility page says this is a local demo with no production login.
