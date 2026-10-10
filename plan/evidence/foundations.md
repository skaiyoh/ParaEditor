# D0a - Foundations available to a Mac/Chrome demo

**VERIFIED** means supported by inspected code or observed command output.
**INFERRED** means a planning conclusion drawn from that evidence.
VERIFIED code behavior does not imply that the workflow was exercised in Chrome.

## 1. Analysis service and workers

### Creation and public contracts

**VERIFIED** - The factory is synchronous; its loader dependency is asynchronous.
Exact export at `src/analysis/service.ts:225`:

```ts
export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService
```

**VERIFIED** - Exact dependency declaration at `src/analysis/service.ts:118`, with comments omitted:

```ts
export type AnalysisServiceDeps = {
  readonly clock: Pick<Clock, 'now'>;
  readonly diag: DiagnosticSink<AnalysisEvent>;
  readonly spawn: () => SequenceWorkerPort;
  readonly spawnDecoder: () => DecodeWorkerPort;
  readonly ortBase: string;
  readonly threads: number | 'default';
  readonly lock: ParsedLock;
  readonly loader: Promise<Result<ModelLoader, AnalysisError>>;
};
```

**VERIFIED** - Exact members of the exported `AnalysisService` interface at `src/analysis/service.ts:135`, with comments omitted:

```ts
runSequence(scene: SceneId, stages: NonEmpty<HeavyStage>, input: SequenceInput, on: SequenceListener, signal: AbortSignal): void;
cancelHeavy(): void;
openDecoder(input: DecoderInput): Decoder;
fetchModels(ops: readonly AnalysisOp[], signal: AbortSignal, onProgress: (model: ModelId, fraction: number) => void): Promise<Result<void, AnalysisError>>;
readonly alive: { readonly heavy: boolean; readonly decoder: boolean };
readonly lastHeavyTermination: HeavyTermination | null;
```

**VERIFIED** - Exact input exports at `src/analysis/service.ts:67` and `src/analysis/service.ts:101`:

```ts
export type SequenceInput = { readonly master: () => Promise<ImageBitmap> };
export type DecoderInput = { readonly scene: SceneId; readonly embeddings: SamEmbeddings; readonly guide: Rgb8 };
```

**VERIFIED** - Exact stage export at `src/analysis/protocol.ts:44`:

```ts
export type HeavyStage =
  | { readonly kind: 'depth' }
  | { readonly kind: 'encode' }
  | { readonly kind: 'inpaint'; readonly hole: Plane<'u8'> };
```

**VERIFIED** - Exact listener declaration at `src/analysis/service.ts:70`, with comments omitted:

```ts
export type SequenceListener = {
  readonly onPhase: (stage: StageKind, phase: 'session' | 'infer', fraction: number | null) => void;
  readonly onDepth: (map: Plane<'f32'>, stats: DepthStats) => void;
  readonly onEmbeddings: (embeddings: SamEmbeddings) => void;
  readonly onPlate: (image: Rgb8) => void;
  readonly onFailed: (stage: StageKind, error: AnalysisError) => void;
  readonly onDone: () => void;
};
```

**VERIFIED** - `src/dev/service.ts:161` provides the construction example: browser clock, diagnostics, module workers from `NOISY_WORKER_URLS.sequence` and `.decode`, `ortBase: NOISY_ORT_DIR`, parsed bundled lock, and `openModelLoader(...)`.
At `src/dev/service.ts:202`, it awaits successful `service.fetchModels(...)` before calling `runSequence`.
The sequence call returns `void`; completion is delivered through the listener.

**VERIFIED** - A three-stage call uses `[{ kind: 'depth' }, { kind: 'encode' }, { kind: 'inpaint', hole }]`.
Stages execute in the supplied order; the service does not derive the hole from depth or embeddings.
For every stage, `master()` must return a fresh, open bitmap because the service transfers it to the worker (`src/analysis/service.ts:265`).
The dev example creates each bitmap from retained `ImageData` (`src/dev/service.ts:228`).

### Photo inputs and products

**VERIFIED** - Exact shared raster exports at `src/core/raster.ts:7`, `:21`, and `:27`:

```ts
export type Size = { readonly width: number; readonly height: number };
export type Plane<F extends PlaneFormat> = {
  readonly format: F;
  readonly size: Size;
  readonly data: F extends 'f32' ? Float32Array : Uint8Array;
};
export type Rgb8 = { readonly size: Size; readonly data: Uint8Array };
```

**VERIFIED** - The sequence accepts decoded `ImageBitmap` pixels, not JPEG/PNG file bytes.
Protocol validation requires positive integer bitmap dimensions and ordinary, non-shared buffers for typed-array payloads (`src/analysis/protocol.ts:138`, `:154`, `:321`).
Planes contain exactly `width × height` elements; `Rgb8` contains interleaved RGB bytes, exactly `width × height × 3`.
The document’s master constraint is stricter: both sides must be even integers from 2 through 2048 (`src/core/ranges.ts:34`, `src/core/schema.ts:128`).

**VERIFIED** - Worker preprocessing and outputs:

| Stage | Input processing | Product |
| --- | --- | --- |
| Depth | Bitmap resampled with high-quality canvas smoothing; ImageNet-normalized planar float32 RGB, `[1,3,H,W]`. | `Plane<'f32'>`, `Float32Array`, one value per depth texel; normalized inverse depth 0..1, larger nearer, plus `{ p10, median, p90 }`. |
| Encode | Bitmap stretched to 1024 × 1024; same normalized planar RGB format. | `SamEmbeddings`, with the encoder’s `ModelId` and three float32 tensors below. |
| Inpaint | Full bitmap size; planar uint8 RGB `[1,3,H,W]` and uint8 mask `[1,1,H,W]`. | `Rgb8` at the original bitmap size, interleaved RGB, without alpha or PNG encoding. |

Sources: `src/analysis/sequence-worker.ts:123`, `:133`, `:142`; `src/analysis/stage-math.ts:158`, `:181`, `:266`, `:290`.

**VERIFIED** - Exact depth-size export at `src/analysis/depth-size.ts:27`:

```ts
export function depthInputSize(master: Size): Size
```

**VERIFIED** - The short side initially maps to 518; dimensions round to multiples of 14, then scale down toward 1813 patches.
A 2048 × 1536 master produces 686 × 518; the tested panorama produces 1190 × 294.
The documented bound covers masters with long edge 512..2048 and short edge at least 64; it is not a universal guarantee for arbitrarily extreme aspect ratios (`src/analysis/depth-size.ts:19`; `test/depth-size.test.ts`).

**VERIFIED** - Exact embedding type exports at `src/analysis/protocol.ts:464`:

```ts
export type SamTensor = z.infer<typeof samTensorSchema>;
export type SamEmbeddings = z.infer<typeof samEmbeddingsSchema>;
```

**VERIFIED** - The schema holds `{ model, tensors: [tensor, tensor, tensor] }`; each tensor has `{ name, dims, data: Float32Array }`.
The decoder requires these names, dimensions, order, and the matching SAM model ID (`src/analysis/protocol.ts:355`; `src/analysis/stage-math.ts:361`):

| Name | Dimensions | Float32 elements |
| --- | --- | --- |
| `image_embeddings.0` | `[1,32,256,256]` | 2,097,152 |
| `image_embeddings.1` | `[1,64,128,128]` | 1,048,576 |
| `image_embeddings.2` | `[1,256,64,64]` | 1,048,576 |

**VERIFIED** - Inpaint’s hole is a `Plane<'u8'>` at exactly the bitmap’s size.
Bytes ≥128 mean fill; bytes <128 mean keep.
The worker converts that to MI-GAN’s opposite polarity, 0 for fill and 255 for keep (`src/analysis/stage-math.ts:259`).
The hole is cloned rather than transferred (`src/analysis/service.ts:278`).

**VERIFIED** - Existing hole construction is exported at `src/core/derive.ts:272`:

```ts
export function holeMask(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, size: Size): Plane<'u8'>
```

**VERIFIED** - It unions available object masks at the requested size and dilates by a disc of radius `ceil(longEdge / 100)`.
Its output is 255 inside and 0 outside; at long edge 2048 the radius is 21 pixels (`src/core/derive.ts:266`).

### Decode prompts and results

**VERIFIED** - Exact members of exported `Decoder` at `src/analysis/service.ts:104`:

```ts
readonly scene: SceneId;
decode(points: NonEmpty<TapPoint>, signal: AbortSignal): Promise<Result<DecodeResult, AnalysisError>>;
release(): void;
```

**VERIFIED** - Exact supporting exports:

```ts
export type NonEmpty<T> = readonly [T, ...T[]];
export type TapPoint = z.infer<typeof tapPointSchema>;
export function decoderPrompt(points: NonEmpty<TapPoint>): Result<DecoderPrompt, string>
export function decodeCandidates(outputs: TensorMap, size: Size): Result<DecodeResult, string>
export type Candidate = z.infer<typeof candidateSchema>;
export type DecodeResult = z.infer<typeof decodeResultSchema>;
```

Sources: `src/core/ids.ts:22`; `src/core/types.ts:60`; `src/analysis/stage-math.ts:337`, `:443`; `src/analysis/protocol.ts:466`.

**VERIFIED** - A point is `{ at: { x, y }, label: 'include' | 'exclude' }`, with x/y frame fractions in 0..1.
For example, `[{ at: { x: 0.5, y: 0.5 }, label: 'include' }]`.
The prompt builder multiplies both coordinates by 1024, supplies float32 points `[1,1,n,2]`, and int64 labels `[1,1,n]`, with include=1 and exclude=0 (`src/core/schema.ts:291`; `src/analysis/stage-math.ts:330`).

**VERIFIED** - There is no caller-supplied box prompt in the service or worker protocol.
`input_boxes` is always an empty float32 tensor with dimensions `[1,0,4]` (`src/analysis/protocol.ts:447`; `src/analysis/stage-math.ts:353`).

**VERIFIED** - The guide is interleaved `Rgb8`; the dev decoder page makes it with long edge 1024 and aspect-preserving rounded short edge.
Its private `guideSize` and `makeGuide` implementations are at `src/dev/decoder.ts:157` and `:164`.
The worker retains the guide’s dimensions, not its pixel data, and does not enforce the 1024-long-edge convention (`src/analysis/decode-worker.ts:85`).

**VERIFIED** - Decode returns `{ candidates: [candidate, candidate, candidate] }`, each `{ mask: Plane<'u8'>, score: number }`.
Masks match the guide’s dimensions, contain one byte per texel, and are soft probability-like values rather than binary flags.
The worker bilinearly resamples 256 × 256 logits and applies rounded sigmoid scaling to 0..255; ≥128 means inside.
Candidates sort by descending model `iou_scores`, preserve original order on ties, and retain empty masks (`src/analysis/stage-math.ts:402`, `:436`).
`src/dev/decoder.ts:340` demonstrates fetching encode/decode models, capturing embeddings, opening the decoder, decoding, and releasing it.

### Ownership, termination, and driver policies

**VERIFIED** - Each heavy stage creates and releases its own session before posting its product, but all stages in a sequence share one worker/runtime heap.
Products’ buffers transfer to the page.
The service retains no products; the caller owns returned planes, embeddings, and plates (`src/analysis/sequence-worker.ts:85`, `:131`, `:140`, `:154`).

**VERIFIED** - Every sequence terminal path terminates its worker before `onDone`/`onFailed`.
Starting another sequence cancels the current one immediately.
`lastHeavyTermination` records only stages that reached an `infer` phase, ranked encode above inpaint above depth; a failure during session creation may leave the record unchanged (`src/analysis/service.ts:235`, `:299`, `:429`).

**VERIFIED** - The decoder retains a session and embeddings across calls; `openDecoder` clones its input and replaces any existing decoder.
`release()` terminates it and cancels pending/later calls.
Aborting one decode resolves that call as cancelled but does not stop its queued/running worker computation; a late reply is dropped (`src/analysis/service.ts:341`, `:375`, `:406`, `:468`; `src/analysis/decode-worker.ts:31`).
The sequence thread setting does not control decoder threads: the decoder loads ORT with `'default'` (`src/analysis/decode-worker.ts:74`).

**VERIFIED** - Policies present outside the service:

| Concern | Existing behavior |
| --- | --- |
| Cooldown | `export const COOLDOWN_MS = { depth: 5_000, encode: 20_000, inpaint: 5_000 } as const;` at `src/dev/harness/lines.ts:32`; enforced by the harness, not the service. |
| Watchdog | Service/decoder pages use 150,000 ms timeouts (`src/dev/service.ts:29`; `src/dev/decoder.ts:46`); the harness defaults to 180 seconds and cancels heavy work on expiry (`src/dev/harness/lines.ts:61`; `sequence-run.ts:218`). |
| Visible-time timeout | `AnalysisError` defines `{ kind: 'timeout'; op; visibleMs }`, but the service implements no visible-time watchdog (`src/analysis/protocol.ts:35`; `service.ts:9`). |
| Hidden tab | `export const HIDDEN_GRACE_MS = 4_000;` at `src/dev/harness/lines.ts:35`; the harness tracks visibility, waits before starting hidden steps, and voids overly hidden readings (`engine.ts:543`, `:735`; `load.ts:117`). |
| Liveness | Harness-only localStorage markers, a page-lifetime `noisy-tab-<tab>` Web Lock, 1-second heartbeat, and lock rereads after 2/10 seconds (`liveness.ts:28`, `:38`, `:130`; `engine.ts:56`, `:527`; `lines.ts:71`). |

**VERIFIED** - The service independently permits a heavy worker and decoder to coexist.
The accepted design says the decoder must not run beside an encoder-containing sequence and specifies additional idle/hidden/export release conditions (`docs/DECISIONS.md:138`).
Those are caller policies, not implemented service guarantees; `docs/ARCHITECTURE.md:797` explicitly identifies the missing driver.

**INFERRED** - A foreground-only demo can call the service without adopting the memory harness, crash markers, or its hidden-run scoring.
Cooldown enforcement, watchdog cancellation, and release before encoder work remain explicit driver responsibilities if the demo is to satisfy the repository’s documented lifecycle policy.
Worker termination and bitmap ownership are required regardless of those policy choices.

## 2. Model loading and sessions

**VERIFIED** - Exact exported loader/cache signatures:

| Signature | Source |
| --- | --- |
| `export function bundledLock(): Result<ParsedLock, string>` | `src/analysis/bundled-lock.ts:12` |
| `export function parseLock(json: unknown): Result<ParsedLock, string>` | `src/analysis/lock.ts:87` |
| `export async function openModelLoader(deps: ModelLoaderDeps): Promise<Result<ModelLoader, AnalysisError>>` | `src/analysis/models.ts:384` |
| `export function webLocks(locks: Pick<LockManager, 'request'>): FileLocks` | `src/analysis/models.ts:52` |
| `fetchModels(ops: readonly AnalysisOp[], signal: AbortSignal, onProgress: (model: ModelId, fraction: number) => void): Promise<Result<void, AnalysisError>>;` | Exported `ModelLoader`, `src/analysis/models.ts:86` |
| `export async function lockHash(lock: ModelLock, subtle: Pick<SubtleCrypto, 'digest'>): Promise<string>` | `src/analysis/lock.ts:132` |
| `export function modelCacheNames(hash: string): { readonly verified: string; readonly partial: string }` | `src/analysis/lock.ts:140` |
| `export function modelFileUrl(file: Pick<LockedFile, 'served'>, origin: string): string` | `src/analysis/lock.ts:145` |
| `export async function createSession(runtime: OrtRuntime, store: ModelStore, files: OpFiles): Promise<Result<OpenSession, string>>` | `src/analysis/ort-runtime.ts:124` |

**VERIFIED** - The bytes follow this path:

1. Build injects `models.lock.json` as `NOISY_MODEL_LOCK`; `bundledLock()` parses it in the page and workers (`tools/build.mjs:244`; `src/analysis/bundled-lock.ts:12`).
2. Lock operations select depth/depth, sam/encoder, sam/decoder, or migan/migan session files (`src/analysis/lock.ts:58`).
3. The page opens the loader with parsed lock, origin, Cache Storage, fetch, SHA-256 digest, Web Locks, and timer clock (`src/analysis/models.ts:59`; `src/dev/models.ts:97`).
4. Before first execution it awaits successful `fetchModels` for every required operation; worker startup does not download models (`src/dev/service.ts:202`; `src/analysis/ort-runtime.ts:107`).
5. Downloads use same-origin served URLs, 4 MiB partial segments, and a default 30-second no-byte/lock-wait stall bound; whole-file SHA-256 verification precedes promotion (`src/analysis/models.ts:22`, `:423`).
6. Verified cache is `noisy-models-<lock hash>`; partial cache is `noisy-models-<lock hash>-partial`, keyed by absolute served URL plus segment range (`src/analysis/lock.ts:140`; `models.ts:100`).
7. Workers read only the named verified cache; missing entries fail. Session creation supplies graph bytes and external data under the lock’s `externalDataPath`, with WASM provider and graph optimization `'all'` (`src/analysis/ort-runtime.ts:107`, `:124`).

**VERIFIED** - Startup deletes other locks’ model caches and preserves resumable contiguous partial bytes for unverified current files.
There is a documentation discrepancy: `docs/ARCHITECTURE.md:2906` says reload deletes every planted segment; current `src/analysis/models.ts:401` preserves resumable segments, consistent with the main loader description at `docs/ARCHITECTURE.md:447`.

**VERIFIED** - `/models/` mounts the repository’s `models/` directory by default, independently of build output.
The six locked graph/data filenames are present there.
`/vendor/ort/` mounts `<build root>/vendor/ort/`; the build copies exactly `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, and `ort-wasm-simd-threaded.wasm` from installed ORT 1.30.0 into its version directory (`tools/serve.mjs:118`, `:615`; `tools/build.mjs:37`, `:163`, `:351`).

## 3. Build entries and page instrumentation

**VERIFIED** - `tools/build.mjs` is an executable script with no exported module API.
Its CLI accepts `--mode dev|production`, `--outdir`, `--src`, `--lock`, and dev-only `--migrations` (`tools/build.mjs:44`).

**VERIFIED** - Production-capable entries are `main.tsx` and the `WORKERS` map: sequence, decode, and GIF.
Workers build first; their content-hashed URLs are then injected into page bundles.
Output uses `assets/[name]-[hash]`, ESM, ES2024, and Preact JSX (`tools/build.mjs:22`, `:222`, `:315`).

**VERIFIED** - A new dev page entry consists of `src/dev/<name>.html` plus adjacent `<name>.ts` or `.tsx`.
HTML must contain `%NOISY_SCRIPT%`, normally in a module script tag; build replaces it with the hashed bundle URL.
One subdirectory level is supported, as in `dev/harness/memory.html`; deeper directories supply imported modules, not page entries (`tools/build.mjs:178`, `:343`; `src/dev/service.html:9`).

**VERIFIED** - A new dev worker is a top-level `src/dev/<name>-worker.ts`, automatically exposed through `NOISY_DEV_WORKER_URLS[<name>]`.
Dev workers in subdirectories fail the build.
A production-capable worker requires an entry in `WORKERS` and its URL member in `src/app-env.d.ts:6`.
Entry basenames must be unique across all pages/workers; duplicate basenames fail the build (`tools/build.mjs:198`, `:204`, `:311`).
The worker typecheck includes `src/**/*-worker.ts`; page typecheck excludes those files (`tsconfig.worker.json:6`; `tsconfig.json:7`).

**VERIFIED** - Dev mode emits linked source maps, retains console/debugger, sets `NOISY_DEV=true`, and builds dev entries.
Production minifies, omits maps/dev entries, drops console/debugger, and sets `NOISY_DEV=false`.
A successful build replaces its output directory; there is no watch/reload mechanism in this script (`tools/build.mjs:235`, `:310`, `:369`).

**VERIFIED** - Instrumentation exports:

```ts
export function bootRoot(win: Window): Root
export function installTestSurface(win: Window, root: Root): void
export type TestSurface = {
  diagnostics(): readonly DiagnosticEvent[];
  environment(): Promise<EnvironmentSnapshot>;
};
```

Sources: `src/app/root.ts:21`; `src/app/test-surface.ts:17`, `:10`; comments omitted.

**VERIFIED** - Main installs `window.__noisyTest` only after successful boot and under `NOISY_DEV`.
It is frozen, non-enumerable, non-writable, and non-configurable.
It currently exposes diagnostics/environment only; build does not automatically install it in dev pages (`src/main.tsx:33`; `src/app/test-surface.ts:22`).

**VERIFIED** - `/api/log` is a server endpoint, not an automatically installed page hook.
Dev pages explicitly POST JSON reports with `Content-Type: application/json`; the service page’s private example is `src/dev/service.ts:116`.
Binary bodies use the same endpoint with `?name=...` (`tools/serve.mjs:507`).

## 4. Serving, headers, and isolation

**VERIFIED** - `tools/serve.mjs` has no exported module API.
It requires `--mode`, defaults to `127.0.0.1:8790`, and accepts build/model/vendor roots and a header-contract path (`tools/serve.mjs:66`, `:83`).

**VERIFIED** - Route surface (`tools/serve.mjs:469`, `:489`, `:507`, `:568`, `:599`, `:612`):

| Route | Behavior |
| --- | --- |
| `/`, build files | Static GET/HEAD; `/` resolves to `index.html`; missing files return 404. |
| `/models/*`, `/vendor/ort/*` | Separate static mounts; byte ranges supported with 206 or 416. |
| `/dev/fault` | Dev-only GET current faults, POST replacement rules, DELETE clear; supports isolation and model/vendor faults. |
| `/dev/requests?since=N` | Dev-only GET request-log rows with sequence number >N. |
| `/api/log` | Dev-only POST; JSON object rows ≤1 MiB append to `log.jsonl`; binary captures ≤256 MiB land under `captures/` with SHA-256 metadata. |
| `/dev/csp-report` | Dev-only POST CSP reports or GET stored reports. |
| `/dev/synth/master?width=W&height=H` | Dev-only GET/HEAD raw opaque RGBA fixture; even dimensions 2..4096. |

**VERIFIED** - Production rejects `/dev`, `/api`, and descendants, including alternative spellings/path escapes.
It has no sink, fault state, request logging, or CSP-report endpoint (`tools/serve.mjs:634`; `:416`).

**VERIFIED** - `headers.json:2` supplies COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, and `X-Content-Type-Options: nosniff`.
Its exact enforced CSP is:

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'
```

**VERIFIED** - Assets/vendor runtime are immutable for one year; models are `no-store`; pages and other successful paths are `no-cache`; errors are `no-store`.
WASM uses `application/wasm`, JS/MJS use JavaScript MIME, and model graph/data use octet-stream (`headers.json:9`, `:18`).
Dev adds a report-only copy of the CSP and forces faulted responses to `no-store` (`tools/serve.mjs:360`).

**VERIFIED** - Header helper exports are `export async function loadHeaderContract(file)` at `tools/headers.mjs:25`, `export function contentTypeFor(contract, urlPath)` at `:50`, and `export function expectedHeaders(contract, urlPath, { isolation = true, status = 200 } = {})` at `:62`.

**INFERRED** - A normal top-level Chrome page served from the default loopback origin is cross-origin isolated under these headers.
The `no-isolation` fault removes COOP/COEP; reloading then changes isolation.
The existing `shell.isolated` scenario checks this behavior; it was not executed during this investigation (`test/browser/scenarios/shell.scenario.ts`; `tools/headers.mjs:19`).

## 5. Core document, edits, undo, and rendering arithmetic

**VERIFIED** - Exact document/type exports include `export type SceneDocument = z.infer<typeof currentDocumentSchema>;` at `src/core/types.ts:38`, and analogous `Style`, `Symbols`, `Motion`, and `Lighting` aliases at `:50`, `:54`, `:55`, and `:56`.
`export function sceneDocumentSchema<const V extends number>(version: V)` is at `src/core/schema.ts:419`.
The schema owns the actual fields and rejects unknown keys.

**VERIFIED** - The document contains identity/version/timestamps/seed, frame asset references, analysis, style, symbols, motion, lighting, objects, lights, and provenance.
Analysis requires color clusters and tone statistics, with nullable depth/plate and `autoSubject: 'pending' | 'done'`; embeddings are outside the document (`src/core/schema.ts:205`, `:419`; `src/core/derive.ts:379`).

**VERIFIED** - Look settings and ranges from `src/core/schema.ts:218`, `:250`, `:273`, `:277`, `:286` and `src/core/ranges.ts:53`:

| Fields/types | Allowed values |
| --- | --- |
| Style numeric fields: `fry`, `saturation`, `simplify`, `outline`, `subjectClarity`, `grain`, `colorNoise`, `crunch`, `clipping` | Real numbers 0..1. |
| `style.colors`, `bands`, `grainSize`, `grainHold` | Integers 2..12, 2..6, 1..4, 1..3 respectively. |
| `style.harmony` | `{kind:'off'}` or `{kind:'auto'|'analogous'|'complementary'|'split-complementary'|'triadic', strength:number}`; strength 0..1. |
| `style.paletteTargets` | Sorted unique `{cluster:number,color:Oklch}` entries; cluster 0..15 and below actual cluster count; color l 0..1, c 0..0.4, h 0..360. |
| Symbols | `enabled:boolean`, `cellSize:number` even integer 6..48, `amount:number` 0..1. |
| Motion | `enabled:boolean`, `orbit:number` 0..1, `loopSeconds:number` 2..6, `focus:number|null` 0..1 when set. |
| Lighting | `ambient:number` 0..1, `relief:number` 0.25..4. |
| Objects | Subject boolean, recolor none/target Oklch, symbols slider/always/never, motion none/wobble/bob/sway with amount 0..1, thickness 0.05..2; maximum 32 objects. |
| Lights | Position x/y -0.5..1.5, depth 0..1, Oklch color c≤0.25, intensity 0..2, radius 0.05..2, rays/softness 0..1, shadows boolean; maximum four lights. |

**VERIFIED** - `RANGES`, `FLOORS`, and `LENGTHS` are exported tables at `src/core/ranges.ts:43`, `:115`, `:138`.
Exact helper: `export function clampToRange(path: ClampPath, value: number): number` at `:160`.
Defaults start fry at 0.6, colors at 7, bands at 4, symbols disabled with cellSize 12/amount 0.3, motion disabled, and ambient/relief at 0.7/1 (`src/core/defaults.ts:16`).

**VERIFIED** - Exact mutation exports:

| Signature | Source |
| --- | --- |
| `export function newDocument(input: NewDocumentInput): SceneDocument` | `src/core/defaults.ts:70` |
| `export type StylePatch = Partial<Omit<Style, 'paletteTargets'>>;` | `src/core/edits.ts:12` |
| `export function applyEdit(doc: SceneDocument, edit: Edit, now: string): EditResult` | `src/core/reduce.ts:422` |
| `export function applyEdits(doc: SceneDocument, edits: NonEmpty<Edit>, now: string): EditResult` | `src/core/reduce.ts:439` |
| `export function applyProduce(doc: SceneDocument, product: Produce, now: string): ProduceResult` | `src/core/produce.ts:48` |

**VERIFIED** - `Edit` covers title, style/fry, symbols, motion, lighting, palette targets, and object/light add/set/remove/refine operations (`src/core/edits.ts:25`).
Results are applied with a new document/inverse edit list, unchanged, or refused.
Finite numeric edit values clamp/round to their ranges; invalid values and unknown patch keys are refused.
`applyEdits` is atomic on refusal and reverses inverse order for undo.
The caller supplies UTC ISO `now`; products use a separate API and never enter undo history (`src/core/reduce.ts:158`, `:413`; `src/core/edits.ts:48`).

**VERIFIED** - Exact undo exports are `export function coalesceKey(edit: Edit): string | null` at `src/core/history.ts:62`, `export function push(history: History, entry: HistoryEntry, doc: SceneDocument): History` at `:120`, `export function undo(history: History): HistoryStep | null` at `:145`, and `export function redo(history: History): HistoryStep | null` at `:156`.
History stores forward/inverse edit lists, caps undo at 50 entries, and coalesces matching single-field edits within 600 ms.
Undo/redo return edits for the caller to apply; they do not mutate a document themselves (`src/core/history.ts:14`, `:26`, `:37`).

**VERIFIED** - Core computes some parameters: `export function fryCurve(f: number): FriedStyle` at `src/core/fry.ts:34` interpolates eight stored style fields.
Derive exports layer ordering, hit testing, hole masks, plate freshness, anchor disparity, camera radius, object motion bounds, and reconciliation.
Motion exports camera/object displacement and loop timing arithmetic (`src/core/derive.ts:63`, `:139`, `:272`, `:330`, `:411`; `src/core/motion.ts:58`, `:97`, `:206`).
There is no cell-grid generation, symbol selection/rasterization, palette-generation pipeline, or complete render-parameter/render implementation in `src/core`; symbol settings are stored data.

## 6. Platform and photo/PNG reuse

**VERIFIED** - Platform exports and exact function signatures:

| Module/contracts | Function signatures |
| --- | --- |
| Clock, `Clock` | `export function createBrowserClock(win: Pick<Window, 'setTimeout' | 'clearTimeout' | 'performance'>): Clock` (`src/platform/clock.ts:17`). |
| Visibility, `VisibilitySource`, `VisibilityTargets` | `export function createVisibilitySource({ document, window }: VisibilityTargets): VisibilitySource` (`visibility.ts:17`). |
| Diagnostics, `DiagnosticSink`, `Diagnostics`, `DEFAULT_CAPACITY` | `export function createDiagnostics<E extends AnyEvent>(clock: Clock, capacity: number = DEFAULT_CAPACITY): Diagnostics<E>` (`diagnostics.ts:32`). |
| Capabilities, `DeviceClass`, `Capabilities`, `CapabilitySources`, `STORAGE_READ_MS` | `export function deviceClassOf(userAgent: string, coarsePointerWithoutHover: boolean): DeviceClass` (`capabilities.ts:40`); `export async function readCapabilities({ navigator, window, clock }: CapabilitySources): Promise<Capabilities>` (`:45`). |
| Build identity | `export function readBuildId(): BuildId` (`build-id.ts:7`). |
| Tab identity | `export function mintTabId(random: Pick<Crypto, 'randomUUID'>): TabId` (`tab-id.ts:5`). |

**VERIFIED** - Clock supplies monotonic/wall time and timers; visibility supplies hidden state and subscriptions with unsubscribe functions.
Diagnostics is a default 500-event ring with timestamps and JSON export.
Capabilities reads isolation, concurrency, environment and bounded storage facts; build identity reads a build-only constant, and tab identity requires secure-context `randomUUID` (`src/platform/clock.ts:4`; `visibility.ts:4`; `diagnostics.ts:17`; `capabilities.ts:14`; `tab-id.ts:5`).

**VERIFIED** - `src/platform` provides no photo-file decoder, resize helper, EXIF parser/orientation adapter, or PNG encoder/export helper.
The dev pages consume raw RGBA fixture files rather than normal photo files (`src/dev/service.ts:187`; `src/dev/sequence.html:14`).
Reusable local examples are the decoder page’s private canvas guide-resize/RGB extraction code and sequence worker’s private canvas resampling code (`src/dev/decoder.ts:164`; `src/analysis/sequence-worker.ts:60`).
They assume already-decoded pixels and contain no explicit EXIF handling.
The only current export-worker entry is a GIF stub, not a PNG implementation (`src/export/gif-worker.ts:1`).

## 7. Chrome scenario verification

**VERIFIED** - One scenario against an existing dev server is selected with:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev shell.isolated
```

**VERIFIED** - `--base-url` requires `--target`; attachment checks served `build.json`, clears dev faults around the scenario, and leaves the server running.
The driver still launches its own Chrome with a temporary profile and DevTools pipe, opens a fresh browser context, and writes results.
Default Chrome is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; default mode is headless (`test/browser/driver/cli.ts:35`, `:182`; `server.ts:250`; `chrome.ts:18`, `:626`).

**VERIFIED** - Exact exported scenario contract at `test/browser/scenario.ts:35`, comments omitted:

```ts
export type Scenario = {
  readonly id: string;
  readonly title: string;
  readonly target: TargetName;
  readonly covers: readonly string[];
  readonly timeoutMs?: number;
  readonly readsSinkFiles?: boolean;
  run(t: ScenarioContext): Promise<void>;
};
```

**VERIFIED** - Minimal valid scenario-file shape, using existing exported APIs (`test/browser/scenarios/boot.scenario.ts:40`; `test/browser/scenario.ts:15`):

```ts
import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

export const scenarios: readonly Scenario[] = [{
  id: 'demo.smoke',
  title: 'the page is isolated',
  target: 'dev',
  covers: [],
  async run(t) {
    await t.page.goto('/');
    const isolated = await t.page.evaluate(z.boolean(), () => window.crossOriginIsolated);
    t.equal('cross-origin isolated', isolated, true);
  },
}];
```

**VERIFIED** - New files must be imported and entered in exported `SCENARIO_FILES` at `test/browser/scenarios/index.ts:23`.
Unregistered files and invalid/duplicate IDs produce usage errors.
Scenario timeout defaults to 60 seconds; page evaluation functions cannot close over external values.
The page API supplies real clicks/typing/file input, waits, screenshots, worker census, lifecycle control, and renderer crashes (`cli.ts:71`; `scenario.ts:42`; `driver/browser.ts:85`).

**VERIFIED** - Every run checks same-origin requests, browser/page/server CSP violations, and undeclared app warnings/errors/exceptions.
Results include `checks.jsonl`, `summary.json`, and per-scenario captures/logs.
An attached run skips `readsSinkFiles` scenarios; explicitly naming one is a usage error, because attachment cannot read the sink’s local files (`driver/run.ts:228`; `driver/cli.ts:195`).

**VERIFIED** - Current command evidence: `npm run typecheck` exited 0.
`npm test` exited 1: 753 tests, 639 passed, 114 failed, none skipped/cancelled.
Failure output includes `EPERM: operation not permitted, mkdtemp` and `listen EPERM: operation not permitted 127.0.0.1`; the suite is not green in this sandbox.
Browser scenarios, builds, serving, and real-model Chrome workflows were not run because they create files or server/browser state.

## Risks for a demo built on these

- **VERIFIED** - Fetch and verify every required operation’s models before execution; workers only read Cache Storage and fail on missing/evicted files.
- **VERIFIED** - A stage consumes its bitmap by transfer; returning one cached bitmap repeatedly breaks later stages.
- **VERIFIED** - Inpaint needs a master-size hole with the repository’s fill polarity; decode masks commonly have guide-size dimensions.
- **VERIFIED** - Box prompts are unavailable, and decoded masks are soft bytes with a 128 inside threshold.
- **VERIFIED** - Decoder abort does not stop computation; release/replacement terminates its resident worker.
- **VERIFIED** - The service does not enforce cooldowns, watchdogs, hidden-tab cleanup, or decoder/encoder exclusion; termination records also omit session-only failures.
- **INFERRED** - Worker termination is not an immediate memory-reclamation guarantee; delayed Chrome target detachment and WASM heaps make rapid replacement a memory risk (`docs/ARCHITECTURE.md:926`; `src/analysis/ort-runtime.ts:25`).
- **VERIFIED** - Build discovery depends on naming, adjacent scripts, placeholders, directory depth, and unique basenames; raw source worker URLs bypass hashed-entry wiring.
- **VERIFIED** - Dev pages do not automatically receive `__noisyTest` or log posting; production removes dev pages and sink routes.
- **VERIFIED** - Core settings are not a renderer, and platform has no normal-photo/EXIF/PNG pipeline; existing dev imports are raw-pixel examples.