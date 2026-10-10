# H1: the window

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: yes.


## Mission

With Window on, the laptop's webcam finds the viewer's face and the picture turns as they lean, so the fried scene reads as a window rather than a screen.
A fourth open model, UltraFace, runs in its own worker on plain WebAssembly like the other three; nothing leaves the machine.
Window off restores the still or the loop exactly as before.

## Context

- `src/render/types.ts` after R1: `renderView(camera, frame?, showSelection?)`; cameras are per-axis frame fractions, clamped by the renderer to the parallax reach. `src/core/derive.ts`: `parallaxClamp`, `plateNeeded`; `src/core/motion.ts`: `Vec2`.
- `src/session/scene.ts`: `createLoopStepper` drives `renderer.renderFrame(frame)` at `LOOP_FPS`; `setMotion` and the Motion toggle; `requestPlateIfNeeded`; the status sentences `preparing` and `Ready`.
- `src/session/driver.ts`: `fetchModels` at boot for every operation, the `[depth, encode]` sequence, the resident decoder opened on embeddings and warmed; the lifecycle policy (`src/session/policy.ts`): timeouts, cancel on replacement, a scene generation checked in every callback.
- `src/analysis/lock.ts`, `models.lock.json`, `tools/fetch-models.mjs`, `src/analysis/models.ts`: how an operation names its model, session and files, how the lock hash and the served name are derived, and how workers read Cache Storage only. `src/analysis/decode-worker.ts` and `src/analysis/protocol.ts`: the resident worker pattern (open, prompt, release) and its parsers. `src/analysis/checks.ts`: the known-answer checks per model.
- `docs/ARCHITECTURE.md`: "Models", "The worker protocol", "The decode worker", "The analysis service", "Browser driver". `plan/evidence/foundations.md`: the service and loader signatures.
- `tools/drive-chrome.mjs`: how Chrome is launched for the scenarios.
- `src/ui/app.tsx` and `src/assets/app.css` as D7 left them, and the direction contract at `.impeccable/surfaces/src-ui-app-tsx.md`: the bottom strip's mode rail (`.mode-rail`, `aria-pressed` buttons for Motion and Symbols) is where Window joins, as a third button after Symbols.
- `PRODUCT.md`: "Positioning" (the window) and "Technical constraints".

Decisions already made:

- The model: UltraFace version-RFB-320 from the Hub, repo `onnxmodelzoo/version-RFB-320`, file `version-RFB-320.onnx`, 1,270,727 bytes, sha256 `34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017`, served as `/models/face-34cd7e60.onnx`. License: the ONNX Model Zoo lists it as MIT; record the license and its source from the repo card in the lock as the other entries do. Input `1 x 3 x 240 x 320` float32 RGB, mean 127, scale 1/128; outputs `scores` `[1, N, 2]` and `boxes` `[1, N, 4]` normalized; confidence threshold 0.7; non-maximum suppression; read `session.outputNames` before writing the decoder and put a known-answer check beside the other three (a synthetic input, a stable output shape and value range).
- A new operation `face` with its own session in the lock and the loader; `fetchModels` at boot fetches it with the others, so the first Window toggle never waits on the network.
- A resident face worker, `src/analysis/face-worker.ts`, modeled on the decode worker: `openFaceTracker()` in the service returns a handle with `track(frame: ImageBitmap): Promise<{ center: Vec2; size: number } | null>` and `release()`; one frame in flight at a time, newer frames dropped while one runs; every frame is a fresh `ImageBitmap` because it is transferred.
- The session's window driver, `src/session/window.ts`: `getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } })` on toggle, frames drawn to a 320 x 240 canvas at most 15 times a second, the face center smoothed with an exponential filter (time constant about 120 ms) and mapped to a camera with `x = -(center.x - 0.5) * gain`, `y = -(center.y - 0.5) * gain`, `gain = 2 * parallaxClamp(doc)`, so leaning right reveals the left side of near objects as a window would; `renderView(camera, frame)` each animation frame, with `frame` advancing at `LOOP_FPS` only while Motion is also on and 0 otherwise. The sign is verified by the scenario through the object centroid, as `render.view` measures it.
- While Window is on and `plateNeeded(doc)` is true, the driver requests the plate as it does for Motion and the status says `preparing`; views render meanwhile and the plate joins when it lands.
- Window off: the stream's tracks stop, the tracker is released, the still or the loop resumes. A denied or missing camera sets the status to `Camera unavailable` and leaves Window off; the page never throws.
- The Scene panel's "3 models local" line in `app.tsx` becomes "4 models local" once the face model is in the lock (derive it from the lock's model count if the session can expose it cheaply; otherwise the literal 4).
- The toggle: an `aria-pressed` button labeled Window with `data-testid="window-enabled"` in the bottom mode rail after Symbols, styled by the existing `.mode-rail` rules; one wiring change in `app.tsx`. The dev surface gains `injectFace(center: Vec2 | null)`, which feeds the smoother in place of the worker, for the scenario.
- `tools/drive-chrome.mjs` launches Chrome with `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream` so `getUserMedia` resolves without a prompt in the scenarios.
- No new runtime dependency; ONNX Runtime Web on wasm as the others; nothing fetched at toggle time.

## Scope

- Create: `src/analysis/face-worker.ts`, `src/session/window.ts`, `test/browser/scenarios/window.scenario.ts` (id `window.track`), a face known-answer check in `src/analysis/checks.ts` or beside it as the file layout prefers.
- Change: `models.lock.json`, `src/analysis/lock.ts`, `src/analysis/models.ts`, `src/analysis/protocol.ts`, `src/analysis/service.ts`, `src/analysis/bundled-lock.ts` if it embeds the lock, `src/session/scene.ts`, `src/session/driver.ts`, `src/session/test-hooks.ts`, `src/app/test-surface.ts` (only if a hook needs it), `src/ui/app.tsx` (the toggle only), `tools/drive-chrome.mjs` (the two flags), `test/browser/scenarios/index.ts`, `test/browser/page-globals.d.ts`, the tests that enumerate operations or lock entries.
- Do not touch: `src/render/`, `src/core/`, `src/export/`, `src/photo/`, `plan/`, `headers.json`.

## Acceptance

1. `npm run typecheck`, `npm run build`, `npm run build:production`, and the node tests that do not launch Chrome pass (the command in `AGENTS.md`), including the lock and known-answer tests with the fourth model.
2. `node tools/fetch-models.mjs` (or the project's verify command) accepts `models/` with the new file in place; the lead places the file from the Hub if the tool does not fetch it.
3. LEAD, scenario `window.track`: on the sample with depth present, toggling `window-enabled` on resolves `getUserMedia` with the fake device, the status is not an error, and `injectFace({x: 0.7, y: 0.5})` followed by `injectFace({x: 0.3, y: 0.5})` moves the injected object's centroid in opposite horizontal directions by more than two pixels with the near object moving against the head; toggling off stops the tracks (`MediaStreamTrack.readyState === 'ended'`) and the next draw equals `renderFrame(0)` with Motion off at four sampled points.
4. LEAD, on hardware: with the real webcam and Nathan in front of it, the picture follows his head within about 150 ms and settles without jitter. Mark it LEAD.
5. LEAD: every existing scenario still passes; `driver.import` and `story.production` are unchanged in behavior; the production bundle guard still passes.
6. The impeccable detector reports no blocking findings on the UI file you changed; paste its last report.

## Return

Write `plan/evidence/H1-return.md` in the shape `AGENTS.md` gives, with the exact output names and shapes the model reports, then stop.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not change the renderer, the loop's own camera, or the export.
