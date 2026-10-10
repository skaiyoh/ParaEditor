# PH1: the phone, served from the Mac

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: yes (two buttons in the shell; the portrait layout is M2, not this package).

## Mission

The same app opens on Nathan's iPhone 16 Pro in Safari over the venue Wi-Fi, served by the Mac over HTTPS with a certificate the phone trusts.
A photo taken with the phone's camera opens in the app and analyzes there; a Tilt mode drives the parallax camera from the phone's gyroscope; the Window mode works with the phone's front camera.
The desktop page and every existing scenario are unchanged in behavior.
This package is the plumbing and the inputs; M2 lays the page out for a portrait screen.

## Context

- `tools/serve.mjs`: plain Node, `parseArgs` flags (`--mode`, `--port`, `--root`, `--models`, `--vendor-ort`, `--headers`), `HOST` hard-coded to `127.0.0.1`, the `headers.json` contract applied to every response. The isolation headers (COOP, COEP) only take effect on a secure context, and iOS grants `DeviceOrientationEvent` and `getUserMedia` only on HTTPS, so the LAN origin must be HTTPS.
- `src/session/window.ts` after H1: the view driver pattern (per-generation attempt, the 120 ms exponential smoother, the camera mapping `-(center - 0.5) * 2 * parallaxClamp(doc)`, `renderView` on each animation frame, the plate request through the session). `src/session/scene.ts`: `setWindow`, `windowEnabled` in the state, the mode rail wiring in `src/ui/app.tsx` (`.mode-rail`, `aria-pressed` buttons Motion, Symbols, Window).
- `src/photo/decode.ts`, `src/photo/limits.ts`: decode with EXIF orientation; the HEIC sentence. A photo captured through a file input with `capture` on iOS arrives as JPEG.
- `src/app/root.ts` and the `isolated` flag the footer shows; the no-isolation scenarios (`shell.no-isolation`, `sequence.no-isolation`) show the app runs single-threaded when isolation is absent.
- `DESIGN.md` and `.impeccable/surfaces/src-ui-app-tsx.md`: the two new buttons follow the existing rules (the mode rail's buttons; the top bar's actions); nothing else in the shell changes here.
- The Mac's Bonjour name is `Nathans-MacBook-Air.local`; its venue address today is 172.31.84.5 and changes per network; `openssl` 3.6 is on the PATH.

Decisions already made:

- `tools/make-cert.mjs`: creates, once, a local certificate authority under `.local/tls/` (gitignored) and a server certificate signed by it, SANs: `Nathans-MacBook-Air.local`, `localhost`, `127.0.0.1`, and every IPv4 address `os.networkInterfaces()` reports at the time; 825 days (Apple's trust limit); RSA 2048 or P-256; through `openssl` as a child process, no dependency. Rerunning refreshes the server certificate (new addresses) and keeps the CA. It prints the CA path and the three phone steps (AirDrop `ca.pem`, install the profile under Settings, enable full trust under General > About > Certificate Trust Settings).
- `tools/serve.mjs` gains `--host <address>` (default `127.0.0.1`; `0.0.0.0` for the LAN) and `--tls <dir>` (reads `server.pem` and `server-key.pem` there and serves HTTPS through `node:https`; without it, HTTP as today). The headers contract, the routes and the dev surfaces are unchanged; the request log records the scheme.
- Tilt: `src/session/tilt.ts` as a second source for the view driver. Refactor `createWindowDriver` into a view driver with a pluggable target source (face or orientation) so the smoother, the camera mapping, the view clock, the plate request and the stop path are shared and tested once; Window and Tilt are mutually exclusive (enabling one stops the other). On enable, inside the user's gesture, call `DeviceOrientationEvent.requestPermission()` when it exists; capture the rest pose from the first event as the bias; map `gamma - gamma0` (left and right tilt) and `beta - beta0` (forward and back) through 20 degrees of travel to the full parallax reach, clamped; no event within 2 s sets the status `Tilt unavailable` and turns Tilt off. Button `data-testid="tilt-enabled"` in the mode rail after Window.
- Take a photo: a top-bar action `data-testid="take-photo"` rendered only when `navigator.maxTouchPoints > 0`, opening a file input with `accept="image/*"` and `capture="environment"`; it imports through the existing `importFile`. Desktop keeps Open as today.
- The Window mode on the phone needs no change beyond the view driver refactor; `facingMode: 'user'` and the mirrored mapping already match the front camera.
- `plan/phone.md`: Nathan's steps, in order: `node tools/make-cert.mjs`, AirDrop the CA, install and trust it, join the same network as the Mac (the iPhone hotspot with Maximize Compatibility is the fallback at the venue), start `node tools/serve.mjs --mode production --host 0.0.0.0 --tls .local/tls`, open `https://nathans-macbook-air.local:8790/` on the phone, Try a sample first, then Take a photo.
- `.gitignore` gains `.local/`.
- No new runtime dependency.

## Scope

- Create: `tools/make-cert.mjs`, `src/session/view-driver.ts` (the shared driver) or the equivalent refactor inside `window.ts`, `src/session/tilt.ts`, `test/make-cert.test.ts`, `test/browser/scenarios/phone.scenario.ts` (id `phone.tilt`), `plan/phone.md`.
- Change: `tools/serve.mjs`, `test/serve.test.ts` (a `--tls` case with a certificate the test generates into a temp dir), `src/session/window.ts`, `src/session/scene.ts`, `src/session/test-hooks.ts` (`injectOrientation`), `src/ui/app.tsx` (the two buttons only), `src/assets/app.css` only if a rule is missing, `test/browser/scenarios/index.ts`, `test/browser/page-globals.d.ts`, `.gitignore`, `docs/ARCHITECTURE.md` only for the server flags if its "Dev server" section lists them.
- Do not touch: `src/render/`, `src/core/`, `src/analysis/`, `src/photo/`, `headers.json`, `plan/` beyond `plan/phone.md`.

## Acceptance

1. `npm run typecheck`, `npm run build`, `npm run build:production`, and the node tests that do not launch Chrome pass (the command in `AGENTS.md`), including the new certificate and `--tls` tests.
2. `node tools/make-cert.mjs` writes `.local/tls/ca.pem`, `server.pem`, `server-key.pem`; `openssl x509 -in .local/tls/server.pem -noout -text` lists the SANs above; paste them.
3. `node tools/serve.mjs --mode production --host 0.0.0.0 --tls .local/tls --port 8797` answers `curl -sk https://127.0.0.1:8797/` with 200 and the isolation headers, and `curl -sk https://127.0.0.1:8797/assets-static/app.css` with `text/css`; stop it before you return.
4. LEAD, scenario `phone.tilt` (dev, HTTP on 127.0.0.1): on the sample with depth present, toggling `tilt-enabled` on and injecting orientation events through the dev surface moves the injected object's centroid in opposite horizontal directions for gamma plus and minus 15 degrees around the captured rest pose, with the near object moving against the tilt as the window does; Window and Tilt exclude each other (enabling one sets the other's `aria-pressed` to false); toggling off restores `renderFrame(0)` at four sampled points; with no event for 2 s the status reads `Tilt unavailable` and the button is off.
5. LEAD, on the phone (Nathan): the page opens over HTTPS, `Try a sample` reaches `Ready to tap`, a photo taken with the phone opens and reaches `Ready to tap` with the timings recorded in the Return, Tilt moves the picture, Window works with the front camera. Record the observed memory behavior (a crash or a reload is a finding, not a failure of this package).
6. LEAD: every existing scenario still passes; the desktop page shows no new control except Window as before (no Take a photo without a touch screen).
7. The impeccable detector reports no blocking findings on the UI file you changed; paste its last report.

## Return

Write `plan/evidence/PH1-return.md` in the shape `AGENTS.md` gives, with the server flags, the SANs, and the phone steps, then stop.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not lay out the page for a portrait screen; M2 does that under its own surface brief.
