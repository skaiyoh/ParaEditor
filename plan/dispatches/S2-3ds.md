# S2: the 3DS viewer and remote

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: no.

Needs before dispatch: devkitPro installed on this Mac (`dkp-pacman -S 3ds-dev 3ds-libjpeg-turbo`, so `/opt/devkitpro/devkitARM` and the `3ds-dev` portlibs exist), S1 merged (the stereo pair), R1 merged (`renderView`).

## Mission

A homebrew app on Nathan's original Nintendo 3DS (custom firmware) that shows the scene from the Mac in glasses-free stereoscopic 3D on its top screen, live, and streams the console's gyroscope back so tilting the handheld tilts the picture on the Mac.
The page gets a `3DS stream` toggle: on, each loop frame (or the still, when Motion is off) is rendered for the left and right eye and sent; off, the stream stops and the 3DS shows its last frame.
A still-pair mode is the fallback the demo can fall to: the page sends one pair on demand and the 3DS holds it.

## Context

- `src/render/types.ts` after R1: `renderView(camera, frame?, showSelection?)`. `src/export/stereo.ts` after S1: the eye cameras (`±0.5 * parallaxClamp(doc).x`) and the JPEG encoding of a view at a size. `src/session/scene.ts`: the loop stepper and `renderFrameAt`; `src/session/window.ts` after H1 if merged, as the model of a session driver that renders views each frame.
- `tools/serve.mjs`: the dev and production server, plain Node, the one origin the page may talk to (`headers.json`: `connect-src 'self'`), so every page-to-bridge exchange is same-origin HTTP: a POST per frame pair to `/3ds/frame`, and `EventSource` on `/3ds/gyro` for the console's data. No WebSocket, no new dependency.
- libctru (`/opt/devkitpro/libctru`, docs at libctru.devkitpro.org): `gfxInitDefault`, `gfxSet3D(true)`, `gfxGetFramebuffer(GFX_TOP, GFX_LEFT | GFX_RIGHT, ...)` (the top framebuffers are 240 x 400, column-major, BGR8 by default; `gfxSetScreenFormat`), `gfxFlushBuffers`, `gfxSwapBuffers`, `gspWaitForVBlank`; `socInit` with a 0x100000 buffer aligned to 0x1000 and the BSD sockets; `HIDUSER_EnableGyroscope`, `hidGyroRead`, `HIDUSER_GetGyroscopeRawToDpsCoefficient`, `hidAccelRead`; `osGet3DSliderState`; `consoleInit(GFX_BOTTOM, ...)` for a status console. AtticPad (db.universal-team.net/3ds/atticpad) streams gyro over Wi-Fi from libctru and is prior art to read, not to copy.
- `3ds-libjpeg-turbo` from the devkitPro portlibs decodes the JPEGs on the console.
- `PRODUCT.md`: "The handheld" and "Technical constraints" (the unit, 802.11g, 400 x 240 per eye).

Decisions already made:

- Layout: the homebrew lives in `hardware/3ds/` with the devkitPro 3ds Makefile template, sources in `hardware/3ds/source/`, output `noisy.3dsx`; the bridge is `tools/3ds-bridge.mjs`, mounted into `tools/serve.mjs` under `/3ds/*` in both modes behind a `--3ds` flag, off by default.
- Discovery: the bridge broadcasts a UDP beacon (`noisy-bridge <port>`) on the subnet once a second on port 8792; the app listens, learns the Mac's address, and connects over TCP to the bridge's frame port; both ends log the peer on their consoles.
- Frames from the page: `POST /3ds/frame` with a body of two JPEGs (left, right, each 400 x 240, quality 0.7) framed as `magic 'NSY1', u32 leftLength, u32 rightLength, bytes`; the bridge forwards the same framing over the TCP connection; the console decodes each eye with libjpeg-turbo into the matching framebuffer, rotating into the 240 x 400 column-major layout, then flushes and swaps. The page drops a frame while the previous POST is in flight, so the rate is whatever the link sustains; the page shows the rate in the status (`3DS 4 fps`).
- Gyro back: every vblank the console sends one UDP datagram to the bridge (`magic 'NSYG', i16 x, i16 y, i16 z raw, f32 coefficient, u8 slider`); the bridge republishes the latest as a server-sent event on `/3ds/gyro` at most 30 times a second; the page integrates pitch and yaw into a camera through the same smoother and gain H1 uses (or a local one if H1 is absent), with a resting bias measured over the first second after the toggle, and renders views from it exactly as the window does. Which source drives the camera when both Window and 3DS are on: the 3DS.
- Modes: `3DS stream` on sends every rendered pair; `Send to 3DS` (S1's button) also pushes one pair when the bridge is connected, so a still pair reaches the console without the stream; the console keeps showing the last pair it received.
- Determinism and safety: the page never blocks on the bridge; a bridge that is not running makes the toggle set the status `3DS bridge not running` and turn itself off; a console that disconnects shows `3DS disconnected` and the stream pauses until it reconnects.
- Build verification you can do: `make` in `hardware/3ds/` produces `noisy.3dsx` with no warnings under the template's flags; the bridge's framing and beacon are node-tested with a fake TCP peer; a browser scenario `3ds.stream` drives the toggle against a fake bridge the test starts in-process and checks that frames arrive with the right framing and that gyro events move the object centroid as `render.view` measures.
- What only Nathan can verify, marked LEAD: the console decodes and displays a pair in 3D, the 3D slider works, the gyro tilts the Mac's picture within about 200 ms, the rate over the venue network.

## Scope

- Create: `hardware/3ds/Makefile`, `hardware/3ds/source/*.c`, `hardware/3ds/README.md` (build, install through the SD card or ftpd, launch), `tools/3ds-bridge.mjs`, `src/session/handheld.ts`, `test/3ds-bridge.test.ts`, `test/browser/scenarios/handheld.scenario.ts` (id `3ds.stream`).
- Change: `tools/serve.mjs` (mounting the bridge behind `--3ds`), `src/session/scene.ts` (the methods), `src/ui/app.tsx` (the toggle in the direction's slot, `data-testid="handheld-enabled"`), `test/browser/scenarios/index.ts`, `test/browser/page-globals.d.ts`, `.gitignore` (the homebrew build output).
- Do not touch: `src/render/`, `src/core/`, `src/analysis/`, `src/photo/`, `headers.json`, `plan/`.

## Acceptance

1. `npm run typecheck`, `npm run build`, `npm run build:production`, and the node tests that do not launch Chrome pass (the command in `AGENTS.md`); the bundle guard still passes.
2. `make -C hardware/3ds` produces `noisy.3dsx`; paste the last lines.
3. LEAD, scenario `3ds.stream`, with the fake bridge: toggling on sends at least three framed pairs in two seconds with Motion on, each with two JPEGs of 400 x 240; a synthetic gyro event sequence moves the injected object's centroid as `render.view` measures; toggling off stops the POSTs; the status shows the rate and the disconnect sentence when the fake bridge closes.
4. LEAD, on hardware: the console shows the pair in 3D and the gyro tilts the picture; the rate over the demo network is recorded in the Return.
5. LEAD: every existing scenario still passes.

## Return

Write `plan/evidence/S2-return.md` in the shape `AGENTS.md` gives, with the framing, the ports, the console's install steps, and the rate, then stop.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
If the live stream will not reach three frames a second on the fake bridge, return with the still-pair mode PASS and the stream FAILED with its measured rate; the plan cuts the stream first.
