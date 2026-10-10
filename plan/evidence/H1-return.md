# H1 return

## What changed

- `models.lock.json`: Pins UltraFace version-RFB-320 as the fourth local model, including its MIT license source, commit, byte length and digest.
- `src/analysis/lock.ts`: Adds the `face` session and `ModelOp` without changing core scene-analysis operations.
- `src/analysis/models.ts`: Lets the loader fetch/cache the face operation alongside the existing operations.
- `src/analysis/protocol.ts`: Adds strict face init/track/reply schemas and boundary parsers.
- `src/analysis/service.ts`: Adds a resident face handle with ready, track, release, one frame in flight, dropped-frame closure and pending-job cancellation.
- `src/analysis/face-check.ts`: Adds RGB preprocessing, output validation, the synthetic known-answer check, confidence filtering, box clamping and non-maximum suppression.
- `src/analysis/face-worker.ts`: Runs the pinned graph on one wasm thread, reads models only from verified Cache Storage, warms/checks the model, and closes transferred frames.
- `src/session/window.ts`: Owns camera/video/tracker cleanup, 15 Hz capture, 120 ms smoothing, selfie-coordinate conversion, brief detection-loss hold, camera mapping and the independent view clock.
- `src/session/driver.ts`: Fetches all five operations/four models at boot, exposes tracker opening/model count plus Window-aware plate freshness, and wires the face worker factory to its built module URL.
- `src/session/scene.ts`: Adds Window state/control, renderView playback, plate requests, replacement/reset/detach cleanup, and tap zoom correction.
- `src/session/test-hooks.ts`: Exposes injectFace, tracker readiness, completed webcam-frame count and actual stream tracks.
- `src/ui/app.tsx`: Adds the existing-style Window mode button after Symbols and derives the local model count from the lock.
- `test/analysis-service.test.ts`: Covers frame dropping/ownership, release cancellation, stale replies, init failure and malformed face replies.
- `test/model-loader.test.ts`: Adds the face model to the loader fixture lock.
- `test/models.test.ts`: Adds face lock coverage and real wasm known-answer/preprocessing/NMS/clamping checks.
- `test/browser/page-globals.d.ts`: Types the Window dev hooks.
- `test/browser/scenarios/window.scenario.ts`: Adds window.track with real tracking before injection, direction/centroid checks, plate preparation, Motion coexistence, track stop, still restoration, camera denial and zero model-request delta.
- `test/browser/scenarios/index.ts`: Registers window.track.
- `tools/build.mjs`: Registers the face worker in both build modes and publishes its content-hashed URL.
- `src/app-env.d.ts`: Declares the face worker URL alongside sequence, decode and gif.
- `test/browser/driver/chrome.ts`: Adds the fake media device and automatic camera permission flags to the actual launcher.
- `test/build.test.ts`: Extends metadata parsing, source fixtures and worker bundle assertions for face in both modes.
- `test/bundle-guard.test.ts`: Adds the face entry to the static asset build fixture.
- `test/browser/scenarios/shell.scenario.ts`: Extends the worker census and malformed-request smoke check for the fourth worker.

No dependencies, branches or commits were added.
The renderer, core, photo and export sources, headers, model files, tools/drive-chrome.mjs and other plan files were not modified.
The only existing scenario changed during the scope extension is shell.workers, which enumerates worker entries.

## Acceptance

1. **PASS (required commands)**: Final typecheck, dev build, production build and all 814 node tests that do not launch Chrome pass.
   The real UltraFace wasm test loads the checked-in model and verifies its names, shapes and synthetic output.
2. **PASS**: `node tools/fetch-models.mjs` and `--verify-only` verify all seven files, including `face-34cd7e60.onnx`, with zero downloads.
   The face file was already present; it was not modified.
3. **PASS (integration); browser assertions remain LEAD**: The explicitly granted scope extension is applied.
   Both build modes publish face alongside sequence, decode and gif, the app receives its face URL, and the real driver supplies `spawnFaceTracker: () => new Worker(NOISY_WORKER_URLS.face, { type: 'module', name: 'face' })`.
   The Chrome launcher now includes `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`; tools/drive-chrome.mjs remains untouched.
   Real CLI build tests pass for all four worker bundles and compile-time URL propagation in both modes.
   The production bundle guard includes the published face worker and reports `[]`.
   The earlier missing-factory blocker is resolved.
   No browser was launched; getUserMedia, injected centroid direction, track ending and four-point still restoration remain LEAD under window.track.

   Exact production worker map:

   ```json
   {"sequence":"/assets/sequence-worker-YP2Q7S7Q.js","decode":"/assets/decode-worker-J4PBGYNH.js","gif":"/assets/gif-worker-BVYJC2XO.js","face":"/assets/face-worker-ULWZIIQY.js"}
   ```

4. **LEAD**: Real webcam response within about 150 ms and settled jitter require Nathan and hardware.
   The temporary driver harness confirms the filter, mirrored horizontal mapping, brief-miss hold, prolonged-miss recentering and cleanup at the browser-API boundary; it does not measure real camera latency.
5. **LEAD**: Existing browser scenarios, including driver.import and story.production, were not run.
   Their implementations are unchanged.
   The production bundle guard passes with `[]` over the actual build, including the face worker.
6. **PASS**: The last impeccable detector command exited 0 with no blocking findings.

   ```text
   /Users/nathandavis/.agents/skills/impeccable/scripts/impeccable detect --json src/ui/app.tsx
   []
   ```

Lead scenario commands:

```sh
node tools/drive-chrome.mjs window.track driver.import story.production
node tools/drive-chrome.mjs
```

Exact new scenario id: `window.track`.
The second command runs every existing scenario as well.
Hardware verification remains separate.

### Actual model interface and known answer

Model id: `face@f6d68add9cf8b223b024f38f83349aff59bcfb6d764fb4effd21d04e87984dc7`.
Pinned Hub commit: `6fd293d22b523ec88959f104b8eef5395e3adfbc`.
File: 1,270,727 bytes, SHA-256 `34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017`.

Observed through ONNX Runtime Web 1.30.0 on plain wasm, one thread:

```text
inputNames: ["input"]
input: float32 [1, 3, 240, 320]
outputNames: ["scores", "boxes"]
scores: float32 [1, 4420, 2]
boxes: float32 [1, 4420, 4]
```

Synthetic RGB 127 input, normalized to an all-zero tensor:

```text
scores min: 0.0015048333443701267
scores max: 0.9984952211380005
scores first pair: [0.9426578879356384, 0.05734214186668396]
max foreground score: 0.064802385866642
boxes min: -0.25587034225463867
boxes max: 1.2449984550476074
boxes first row: [0.0021090004593133926, 0.003878403455018997, 0.023492833599448204, 0.04172082617878914]
decodeFace: null
```

The worker gate checks stable shape and broad synthetic ranges; approximate individual values are checked in the node test.
Raw normalized boxes can extend outside [0, 1]; decoding clamps them before NMS and center/size calculation.
Confidence is 0.7 and hard NMS IoU is 0.3, selecting the largest surviving face.

## Checks run

`npm run typecheck` - exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build` - exit 0:

```text
build: dev 3bcfa627b157-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-analysis/build/dev (45 files)
```

`npm run build:production` - exit 0:

```text
build: production 3bcfa627b157-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-analysis/build/production (14 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - exit 0 on the final tree:

```text
ℹ tests 814
ℹ suites 0
ℹ pass 814
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36505.975
```

Focused real-model/service checks in the initial dispatch also passed: 70 tests, 70 pass, 0 fail.
The full 814-test suite was rerun after the scope extension, including the model, service, build and guard tests.

`node tools/fetch-models.mjs` and `node tools/fetch-models.mjs --verify-only` - exit 0:

```text
fetch-models: verified face-34cd7e60.onnx
fetch-models: 7 files verified in /Users/nathandavis/dev/sandbox/noisy-demo-analysis/models, 0 downloaded
```

`node --input-type=module` importing `checkProductionBuild` and reading build metadata - exit 0.
The check asserts no production guard findings, all four worker keys in both modes, that each face URL names a published file, and that the corresponding app bundle contains that URL.

```text
production bundle guard []
dev worker map {"sequence":"/assets/sequence-worker-5WEPST4W.js","decode":"/assets/decode-worker-YYITF2B2.js","gif":"/assets/gif-worker-YJISNILC.js","face":"/assets/face-worker-PCY4NE6I.js"}
production worker map {"sequence":"/assets/sequence-worker-YP2Q7S7Q.js","decode":"/assets/decode-worker-J4PBGYNH.js","gif":"/assets/gif-worker-BVYJC2XO.js","face":"/assets/face-worker-ULWZIIQY.js"}
```

Temporary unshipped driver harnesses from the initial dispatch - exit 0:

```text
PASS: Window smoothing/sign, Motion clock, stop, late camera cancellation and denial
PASS: worker-fed selfie direction, brief-miss hold, prolonged-miss recenter and capture cleanup
```

The latter observed six captures, six consumed/closed bitmaps, stopped tracks, one tracker release and no failure callback.
These harnesses simulate unavailable browser APIs; they do not replace the LEAD scenario or hardware checks.

`npm run serve` with curl HEAD checks: `/` and `/models/face-34cd7e60.onnx` returned 200.
The model response reported `Content-Length: 1270727`, `application/octet-stream`, `no-store`, COOP/COEP, and the existing self-only worker CSP.
No camera-denying Permissions-Policy was present.
The server was stopped before return.

`node tools/drive-chrome.mjs --list window.track driver.import story.production` lists all three requested ids.
This lists scenarios; it does not execute them.
`git diff --check -- tools/build.mjs src/app-env.d.ts src/session/driver.ts test/browser/driver/chrome.ts test/build.test.ts test/bundle-guard.test.ts test/browser/scenarios/shell.scenario.ts` passed.
`git diff --quiet -- tools/drive-chrome.mjs` passed, confirming the wrapper is untouched.
An unrestricted `git diff --check` reported pre-existing, out-of-scope whitespace:

```text
plan/log.tsv:38: trailing whitespace.
```

That lead-owned log was not edited.
The last impeccable report is pasted under acceptance 6.

Two read-only Claude CLI reviews completed.
Their substantive findings were addressed: real-camera x orientation, detection-loss jitter, camera versus tracker failure status, models-readiness guarding, actual worker tracking before injection, request-count deltas, asynchronous aria-pressed checking, still sampling at object edges, and Window tap zoom.
The reviews inspected pre-correction snapshots; no claim of a fresh final-tree Claude verdict is made.
Node/harness checks were rerun after the corrections.
A third read-only Claude CLI review inspected only the final scope-extension integration and reported no concrete defects in its diffed hunks.
Its two conditional concerns were checked directly: the browser BuildInfo uses a worker record and therefore retains face, and jsFiles has no count assertion.
The final node suite and actual production guard both pass.

## Noticed, not done

- The granted worker registration and fake-camera scope extension is complete.
- Pre-existing trailing whitespace in plan/log.tsv:38 was left untouched.
- Browser screenshots, window.track execution, every existing scenario, and real webcam latency/jitter remain LEAD.
- No docs, ADRs, changelog, Linear status, next dispatch, dependency changes, commits or branches were attempted.

## Findings

- **VERIFIED**: A production-capable worker needs explicit registration in `tools/build.mjs` and `src/app-env.d.ts`; H1 omitted both from Scope.
  The granted scope extension adds both, plus the real driver factory and corresponding fixtures; this blocker is resolved.
- **VERIFIED**: Chrome is launched in `test/browser/driver/chrome.ts`.
  The granted extension adds the two fake-camera flags there and leaves the wrapper unchanged.
- **VERIFIED**: `plateNeeded(doc)` returns false with Motion off and with orbit zero/no object motion.
  Window needs an enabled/orbit-one projection solely for plate freshness, which the session now uses without changing the stored Motion settings.
- **VERIFIED**: UltraFace raw box outputs extend beyond image bounds.
  They are clamped before constructing the returned center and size.
- **VERIFIED**: This graph's exporter lists its initializers as inputs; setting `ort.env.logLevel` alone still emits native graph warnings.
  The face worker reads its single graph from the existing verified store and creates its wasm session with `logSeverityLevel: 3`, preserving actual errors and avoiding browser-console warning failures without changing the shared runtime foundation.
- **VERIFIED**: The pinned model card's body License section says MIT, while Hub metadata labels Apache-2.0.
  The lock follows the dispatch's MIT decision and cites the pinned [model-card License section](https://huggingface.co/onnxmodelzoo/version-RFB-320/blob/6fd293d22b523ec88959f104b8eef5395e3adfbc/README.md#license).
- **INFERRED**: Real head-direction agreement after the selfie-coordinate conversion requires the hardware check.
  Injected-coordinate and worker-fed mapping checks pass at the safe boundary.

## Time

Start, from `date`: `2026-10-09 23:41:44 EDT`.
Initial return, from `date`: `2026-10-10 00:12:04 EDT`.
Scope-extension start, from `date`: `2026-10-10 00:14:53 EDT`.
End, from `date`: `2026-10-10 00:18:39 EDT`.
