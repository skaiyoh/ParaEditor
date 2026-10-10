# D3 return

## What changed

- `src/session/driver.ts`: boot model fetch/verification, import sequence, generation checks, watchdogs, resident warmed decoder, queued inpaint, timings and dev-only sink rows.
- `src/session/products.ts`: SHA-256 asset ids and owned depth, mask and plate maps, plus projection to the renderer's scene fields.
- `src/session/policy.ts`: pure generation, readiness, two-second start spacing, stage deadlines and coalesced plate queue.
- `src/session/scene.ts`: composes the driver, applies core products, publishes masks/depth/plate, clears discarded references, and exposes document/Motion/plate operations.
- `src/session/test-hooks.ts`: analysis, document and product summaries, Motion and plate hooks, and dev-only mask injection.
- `src/ui/app.tsx`: analysis status line and last timing in dev builds only.
- `test/driver-policy.test.ts`: 12 focused lifecycle and product-ownership tests.
- `test/browser/scenarios/driver.scenario.ts`: adds `driver.import`, `driver.plate` and `driver.failure`, retaining the three existing harness scenarios.
- `test/browser/scenarios/index.ts`: documents the existing driver-file registration's new D3 scenarios.
- `test/browser/page-globals.d.ts`: declares the extended dev hooks without importing build-only globals into the test project.

No runtime dependency, branch, commit, publication, object-selection UI or motion rendering was added.
The only object construction is the explicitly authorized dev mask fixture.
The ignored dev build was regenerated.

## Acceptance

1. **PASS**: final typecheck and dev build exited 0; the required non-Chrome Node suite passed all 769 tests.
2. **PASS**: all 12 focused tests passed, including stale callbacks, start at the first start plus 2000 ms, all three stage timeouts, a plate queued until done, coalesced requests, import refusal, explicit retry, and replacement/product eviction.
3. **LEAD**: `driver.import`, target dev, timeout 300 s, uses actual production import and service paths with the real models.
   It checks boot readiness, a 4032 x 3024 JPEG, document depth within 60 s, warmed decoder within 150 s, warm-up timing, normal status transitions, worker ownership, immediate second/third replacement, one surviving product generation and console errors.
   The browser driver also checks CSP violations.
   It writes `driver-initial-timeline.json`, `driver-replacement-timeline.json` and screenshots.
   Chrome was not launched here; these results and timings are unobserved.
4. **LEAD - rerun required after Resume 1**: the lead's original `driver.plate` run **FAILED** with `timed out after 5000 ms waiting for plate reports preparing; last value null`.
   The injected object's invalid `thickness: 0` rejected mask construction before the driver was called; Resume 1 changes it to schema-valid `1`.
   The corrected fixture passes a Node schema check and makes `plateNeeded` true with Motion enabled.
   `driver.plate`, target dev, timeout 200 s, now writes `driver-plate-timeline.json` before every wait, including status, analysis, products, plate freshness and request outcome.
   It accepts visible `preparing` or an already-complete fresh plate, records which occurred, and exposes request errors immediately.
   Master size, freshness, timings and worker ownership still require the lead's real-model rerun within 90 s.
   No browser rerun or actual inpaint output is claimed by Resume 1.
5. **LEAD** for the rendered normal/failure status paths: `driver.import` checks `Fetching models`, `Analyzing: depth`, `Analyzing: encoder`, `Ready to tap` and the dev timing annotation.
   `driver.failure`, target dev, timeout 120 s, installs `path:/models/:corrupt` through `/dev/fault`, checks a `Models unavailable: <reason>` sentence and no workers, then removes the fault.
   It writes `driver-model-failure.json` and a screenshot.
   **PASS** at the policy boundary: Node tests exercise the three timeout sentences and `Analysis failed at encode: missing bytes`.
   Actual browser fault response and stage/decoder failure rendering remain unobserved.
6. **LEAD**: read the scenario check details and timeline artifacts, then append the Mac's observed depth, encoder, warm-up, replacement and inpaint timings here and to `plan/findings.tsv`.
   No end-to-end timings are invented, and that TSV was not edited.

Run against the lead's dev server:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev driver.import driver.plate driver.failure
```

### Public contract for D4 and D6

`scene.ts` owns document changes and publishes a `DemoScene` with `doc`, retained `master`/`masterPixels`/`masterPng`, `path`, `masks`, `depth`, `plate` and `selected`.
There is no renderer implementation in this checkout; these fields match the plan's RenderScene contract.
Subscribers receive the projected products whenever the driver changes the document or products.

```ts
createAnalysisDriver(host: {
  read(): { doc: SceneDocument; masterPixels: ImageData } | null;
  produce(product: Produce): void;
  changed(): void;
  products: Products;
}): AnalysisDriver

// AnalysisDriver
snapshot(): AnalysisSnapshot
generation(): number
guide(): Rgb8 | null
decoder(): Decoder | null // only the successfully warmed resident decoder
lastTiming(): { stage: string; ms: number } | null
diagnostics(): { threads: number; generation: number; timings: Record<string, number>; events: readonly unknown[] }
beginImport(): number
importFailed(generation: number): void
sceneReady(generation: number, master: ImageData): Promise<void>
requestPlateIfNeeded(): Promise<void>

// AnalysisSnapshot
// status, modelsReady, depth, embeddings, decoderReady, plate,
// alive: { heavy: boolean; decoder: boolean }, timings: Record<string, number>

productAsset(data: Uint8Array | Float32Array): Promise<AssetId>
createProducts(): Products

// Products
depths: ReadonlyMap<AssetId, Plane<'f32'>>
masks: ReadonlyMap<AssetId, Plane<'u8'>>
plates: ReadonlyMap<AssetId, Rgb8>
putDepth(asset: AssetId, plane: Plane<'f32'>): void
putMask(asset: AssetId, plane: Plane<'u8'>): void
putPlate(asset: AssetId, image: Rgb8): void // evicts the previous plate
clear(): void
forScene(doc: SceneDocument): {
  masks: ReadonlyMap<ObjectId, Plane<'u8'>>;
  depth: Plane<'f32'> | null;
  plate: Rgb8 | null;
}
```

The diagnostics event array actually has the foundation's `AnalysisEvent` type, with timestamps.
Its threads field records the hardware concurrency clamped to 2..8, and timings includes warm-up milliseconds.
The embeddings flag records successful encoder production; the original embedding arrays are not retained in a second cache after opening the decoder.

The demo session exposes `analysis`, `products`, `setDocument(doc)`, `setMotion(patch)` and `requestPlateIfNeeded()`.
D4 should hash and store masks, change the document through `setDocument`, then request a plate.
D6 should change Motion through the session and request a plate.
The session's plate method waits for any dev mask injection before delegating.
Concurrent requests settle together; replacement or failure rejects outstanding requests.
A new explicit request can retry failed inpaint, while failures never retry automatically.
If masks change during inpaint, the obsolete result is discarded and the latest mask set is produced next.
A sequence ending without a fresh plate for its unchanged mask set fails rather than looping.

## Checks run

### `npm run typecheck` - PASS, exit 0

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

An earlier attempt imported the runtime-dependent test-surface type into page globals and failed because the test project does not include build constants.
Representative exact output:

```text
src/analysis/bundled-lock.ts(13,20): error TS2304: Cannot find name 'NOISY_MODEL_LOCK'.
src/session/driver.ts(60,54): error TS2304: Cannot find name 'NOISY_ORT_DIR'.
src/session/driver.ts(61,29): error TS2304: Cannot find name 'NOISY_WORKER_URLS'.
src/session/scene.ts(60,9): error TS2304: Cannot find name 'NOISY_DEV'.
```

The declarations now describe the hooks directly, importing only the core document type.
Subsequent typechecks passed.

### `npm run build` - PASS, exit 0

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev 8e8a3b058ae4-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo-driver/build/dev (41 files)
```

### Required Node suite - PASS, exit 0

```sh
node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)
```

```text
✔ matMulModel loads in ONNX Runtime and multiplies (273.980333ms)
ℹ tests 769
ℹ suites 0
ℹ pass 769
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37856.256416
```

The final diagnostics-only shape addition was followed by typecheck, build and focused tests; the full suite was not repeated for that pure snapshot addition.

### Focused Node tests - PASS, exit 0

```sh
node --test test/driver-policy.test.ts
```

```text
✔ product ids hash actual view bytes and replacement clears every raster map (8.955875ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 170.360125
```

### Route, header and registration checks - PASS

Started `tools/serve.mjs --mode dev --port 0` with results/request logs in `/tmp`; it selected port 58613 and was stopped before return.
Curl observed `/` and `/build.json` success, accepted and cleared the corrupt-model fault rule, and accepted a separate transport-check sink row.
The page response included:

```text
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'
Content-Type: text/html; charset=utf-8
```

The fault endpoint returned `{"isolation":true,"rules":[{"spec":"path:/models/:corrupt","hits":0,"remaining":null}]}` and then `{"isolation":true,"rules":[]}` after clearing.
No model execution or model corruption response was exercised by curl.
A Node import of `SCENARIO_FILES` confirmed all six driver scenarios are registered with the new scenarios' stated targets/timeouts.
An empirical Node call to `newDocument` observed default Motion `{enabled:false, orbit:0.6, loopSeconds:3, focus:null}`; enabling Motion therefore supplies orbit for the plate fixture.
`git diff --check` passed.

### Independent Claude review

The read-only review completed and reported import-refusal liveness, stale readiness text, retained plates, poisoned retry state, guide-error replacement and an unbounded-plate-loop concern.
The first five were resolved; unchanged-mask completion now also fails explicitly if no fresh plate exists.
The source proves `reconcile`'s plate need uses the same `plateNeeded` predicate, so disagreement between those two is not a current defect.
The reviewer also listed residual watchdog gaps beyond the specified session-phase timers, recorded below.
Its factual questions about the sink, Motion default and nonempty color tuple were resolved by curl, empirical Node output and typecheck respectively.
The warm-cache network-request assumption was removed from the browser scenario.
Actual worker-spawn observation remains part of the lead's scenario.

A follow-up Claude review of a newer snapshot did not complete within its bound:

```text
Claude review timed out after 180 s without a completed review.
```

The initial review was completed; a clean follow-up review of the final fixes is not claimed.
Logs and temporary review inputs are in `/tmp/noisy-D3-review*`; check logs are `/tmp/noisy-D3-typecheck.log`, `/tmp/noisy-D3-build.log`, `/tmp/noisy-D3-tests.log` and `/tmp/noisy-D3-policy.log`.

## Noticed, not done

- Existing `demo.import` and `demo.download` scenarios still expect the status line to say `Drop a photo` or `Ready`; D3 now shows model/analysis status there.
  Their source is outside this dispatch's scope and needs the lead's update.
- D2a's renderer contract file and return are absent from this checkout.
  The plan's RenderScene fields are provided through `scene.ts`; the existing raw-photo Stage was not changed.
- Pre-existing changes to `plan/codex.sh` and `plan/dispatches/D3-driver.md`, plus untracked `models` and `node_modules`, were preserved.
- Chrome, real models in the browser, browser screenshots, production build and the Mac end-to-end timeline were not run here.
- `plan/findings.tsv` was left to the lead as required.

## Findings

- **VERIFIED**: `reconcile` was used for encode and plate needs; import depth is the prescribed first stage.
  Its `auto-subject` need is filtered out for D3, and Objects intent is supplied to prewarm encoding even though the page has no Objects tab yet.
- **VERIFIED**: products use SHA-256 of the actual typed-array view bytes.
  A representative 686 x 518 f32 plane, 1,421,392 bytes, including the copy, took 0.630..5.608 ms across 12 local Node WebCrypto measurements.
  That evidence supported SHA-256 rather than a cheaper id; browser cost is still LEAD and is recorded as `depth-hash`.
- **VERIFIED** by code and policy tests: the demo uses the specified two-second spacing only between import sequence starts, with no phone cooldowns or visibility/liveness/idle-release policy.
  Those lifecycle policies depart from the broader design deliberately for this foreground Mac demo.
- **VERIFIED** by code: watchdogs use monotonic wall time starting at each stage's session phase, not accumulated visible time.
  Decoder opening waits until `onDone`, after heavy termination; warm-up can coexist with a subsequent inpaint sequence.
- **INFERRED**, review residual: no additional watchdog covers worker startup before a session phase, a missing terminal message after the last product, or a hung decoder warm-up.
  The dispatch specifies session-phase heavy timers only; browser scenarios have overall deadlines, and replacement still releases the workers.
- **VERIFIED**: model faults can be installed with the quick `path:/models/:corrupt` grammar.
  Curl verified grammar acceptance only; the corrupt-model browser result remains LEAD.
- **VERIFIED**: plate buffers are master-sized by the service contract and freshness is tied to the sorted mask asset set.
  Runtime master-size/freshness observations remain LEAD.

## Time

- Start, first recorded `date`: Fri Oct 9 09:41:27 EDT 2026.
- End, from `date`: Fri Oct 9 10:11:59 EDT 2026.

## Resume 1

The lead reported `driver.import` PASS in 12.7 s, depth 1959 ms, and `driver.failure` PASS in headless Chrome 155 with real models.
The remaining import timings were not supplied here and were not inferred.
The original plate run failed with no console errors or plate timeline artifact:

```text
timed out after 5000 ms waiting for plate reports preparing; last value null
    at Object.waitFor (test/browser/driver/chrome.ts:489:17)
```

### Cause

**VERIFIED**: `src/session/scene.ts:149` parses the injected object as part of the document, but line 150 originally supplied `thickness: 0`.
The object schema checks that field through `inRange` at `src/core/schema.ts:373`.
Parsing the equivalent injected object with the exported `sceneObjectSchema` reproduced this exact issue:

```json
{
  "origin": "number",
  "code": "too_small",
  "minimum": 0.05,
  "inclusive": true,
  "path": ["thickness"],
  "message": "Too small: expected number to be >=0.05"
}
```

The rejection happens before `products.putMask` and `setDocument` at `scene.ts:153`, so the document has no injected object and `plateNeeded` remains false (`core/derive.ts:296`).
`setMotion` publishes enabled Motion synchronously at `scene.ts:130-131`; it does not create an object.
`requestPlateIfNeeded` rejects at `await pendingMask` (`scene.ts:124`) and never calls the driver at line 125.
Consequently the driver's plate request/status dispatch (`driver.ts:278`) never runs.
The published analysis field and the probe's field agree; there was no inpaint completion or failure racing a poll because inpaint never started.

The injection's attached catch suppresses an unhandled rejection (`scene.ts:156`).
The original scenario's request handler stored the rejected request in `data-plate-request` at its pre-resume line 396, but its pre-resume line 399 checked only analysis status plus the rendered line.
That condition stayed false and explicitly returned `null` on every poll.
It was a fixture defect in the session and a loss of diagnostic evidence in the scenario.

### Changes and verification

- `src/session/scene.ts:150`: the dev injected object now uses `thickness: 1`.
  Parsing the corrected fixture and calling core's real `plateNeeded` with Motion enabled produced `{"fixtureValid":true,"plateNeeded":true}` in Node.
- `test/browser/scenarios/driver.scenario.ts:278`: `readPlate` reports analysis status, rendered status, analysis snapshot, products summary, `plateNeeded`, request state, elapsed time and master size, including nulls before hooks exist.
- `test/browser/scenarios/driver.scenario.ts:405`: the timeline is rewritten with accumulated checkpoints before models readiness, initial analysis completion, preparing/fresh completion and final request completion waits.
  A failure records its reason and a final snapshot when the page is still readable; prior checkpoints survive a page failure.
- `test/browser/scenarios/driver.scenario.ts:431`: the progress probe returns `preparing` or `completed-between-polls` when a plate exists and `plateNeeded` is false.
  The assertion at line 441 checks those alternatives and records `preparingObservation` in the timeline and check details.
  Both plate waits throw with the stored request error instead of silently polling it to a timeout.

A temporary Node check extracted the actual serialized progress predicate and exercised controlled page values for pending, visible preparing, fast fresh completion, stale plate and rejected request:

```text
PASS: actual probe handles pending, preparing, fast fresh completion, stale plate, and request failure.
```

This checks the probe boundary; it does not claim a Chrome or MI-GAN result.
No browser was launched and no server was started during this resume.
The lead must rerun only the affected scenario:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev driver.plate
```

`npm run typecheck` - **PASS**, exit 0, last lines:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build` - **PASS**, exit 0, last lines:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev 8e8a3b058ae4-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo-driver/build/dev (41 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - **PASS**, exit 0, last lines:

```text
✔ matMulModel loads in ONNX Runtime and multiplies (167.649458ms)
ℹ tests 769
ℹ suites 0
ℹ pass 769
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36451.218417
```

The three logs are `/tmp/noisy-D3-resume1-typecheck.log`, `/tmp/noisy-D3-resume1-build.log` and `/tmp/noisy-D3-resume1-tests.log`.
The scoped diff check passed.
An unscoped diff check reported the lead's pre-existing `plan/log.tsv:12` trailing whitespace; that file was left untouched.

Start, from `date`: Fri Oct 9 10:16:59 EDT 2026.
End, from `date`: Fri Oct 9 10:24:46 EDT 2026.
