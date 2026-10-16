# PlayBack roadmap

## Phase 1 — functional MVP

This phase is the current app.

Players check in from a court QR, join Team A (red) or Team B (blue), and the host starts the match. Court 1 records with the laptop webcam after consent. Courts 2–8 are labeled simulated and do not open that camera. The host types the score and verifies it. Verification updates PIR once. Profiles show stored results, a rating history chart, and an honest “not available yet” line for anything the app does not measure. Doubles matchmaking recommends the closest average split and says it is not a guarantee. Equipment is optional, typed by hand, and covered by a separate consent. The facility page is a local demo with no production login and no revenue number.

PIR does not read video. There is no ball tracking, line call, or face recognition.

## Phase 2 — computer vision

A later job can read a saved recording and emit events with a confidence and a model version. `server/src/videoJob.ts` is the empty slot for that job. It returns no events today.

Any future signal stays beside the manual result. It must not change PIR, must not call a line, and must not identify a face or a brand. A real court camera, not the laptop webcam, is the footage that phase would need.

## Phase 3 — multi-facility and equipment intelligence

More than one facility, real sign-in, and equipment that is still entered by a person or a purchase record rather than recognized from video. Production auth is out of scope until this phase. The phase 1 dashboard stays labeled as a local demo.
