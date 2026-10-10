# Decisions

> **Owns:** the project's architecture decision records: what was decided, why, what it costs, what was rejected, and what would reopen it.
> Entries are append-only; a reversed decision gets a new entry that supersedes the old one.
> **Does not own:** how the code works today ([ARCHITECTURE.md](ARCHITECTURE.md)) or what changed when ([CHANGELOG.md](CHANGELOG.md)).

## ADR-001 - Toolchain and pinned dependency set

Status: Accepted

Date: 2026-10-01

### Context

noisy is a client-only web app that the owner runs on an iPhone and a Mac, with no service behind it.
Every dependency is code the owner maintains for as long as the app lives, so each was weighed on maturity, maintenance activity, security posture, dependency surface, and replaceability, against the size of the in-repo code that would replace it, with neither building nor buying as the default.
The owner approved `onnxruntime-web` as the model runtime on 2026-09-29, approved the rest of the list on 2026-09-30 (owner decision Q1), and amended Q1 on 2026-10-01 to add `@types/node`; the browser test harness was settled on 2026-09-30 (owner decision Q14).
The full evaluation is section 18 of the v1 design, which is kept outside version control under `.claude/work/noisy-v1/`.

### Decision

Four runtime dependencies and three dev dependencies, each pinned to an exact version with no range ([ARCHITECTURE.md](ARCHITECTURE.md#npm-scripts) has the mechanism):

| Package | Version | Role |
| --- | --- | --- |
| `preact` | 10.29.8 | UI |
| `zod` | 4.6.5 | schemas at the file, store, and worker boundaries |
| `mediabunny` | 1.60.0 | MP4 muxing |
| `onnxruntime-web` | 1.30.0 | model runtime; its wasm build is served same-origin, not bundled |
| `typescript` | 7.0.2 | type checking only (dev) |
| `esbuild` | 0.28.2 | bundling (dev) |
| `@types/node` | 25.9.8 | typings for the `node:test` files only (dev) |

The toolchain around them:

- esbuild bundles and TypeScript 7 type-checks, in three projects (app, worker, node tests), because one program cannot check worker code against the `webworker` library and app code against `dom` at once.
- Unit tests run under Node's own `node:test`, which runs the TypeScript sources by type stripping.
- A dependency-free dev server (`tools/serve.mjs`) serves the build with the response headers of `headers.json`.
- Browser end-to-end runs use an in-repo Chrome DevTools Protocol driver against headless Chrome, plus macOS `safaridriver` for Safari, with no browser automation library.
- Dependency install scripts stay off ([ARCHITECTURE.md](ARCHITECTURE.md#npm-scripts) has the mechanism).

### Consequences

- Moving any version is a separate decision, and the dependency test (`test/dependencies.test.ts`) fails on any drift, a newer version included.
  Preact 11.0.0 and Mediabunny 1.61.0 already exist and are not taken.
- The project owns its dev server now, and later parts write the browser driver, GIF encoder, zip codec, and WebGL harness that the rejected libraries would otherwise provide.
- `skipLibCheck` is on, because `mediabunny`'s typings pull in the `@types/dom-webcodecs` declarations, which collide with TypeScript's own `lib.dom.d.ts` (TS2717, TS2374, TS2300) when library files are checked; the project's own sources are still checked in full.
- The app project's `lib` adds `esnext.disposable`, because without it a call to a `VideoSample`'s `Symbol.dispose` fails (TS2550).
- `@types/node` is visible only to the test project, so app and worker code never see Node's globals.
- TypeScript 7 only checks and esbuild emits, so the design names TypeScript 5.9 as the drop-in if TypeScript 7 misbehaves.

### Alternatives considered

The reasons below are the design's (section 18).

- **Vite** for bundling and the dev server: not taken; esbuild is one native binary with no JavaScript dependencies, and the dev server needs only static files, one header contract, and the dev-only levers.
- **Playwright** for browser end-to-end tests: not taken; the Chrome DevTools Protocol and `safaridriver` reach both browsers with no dependency (Q14).
- **vitest** for unit tests: not taken; `node:test` needs no dependency.
- **`gifenc`**: rejected; its generic quantizer fights the palette the app owns.
- **`fflate`**: not taken for now, in favor of an in-repo zip reader and writer over `CompressionStream`; it is the runner-up if that reader passes 400 lines.
- **`libheif-js`**: rejected; HEIC decoding in Chrome is out of scope (Q10), which avoids a 1.4 MB wasm and LGPL-3.0 obligations at release.
- **`@huggingface/transformers`**: rejected; it hides session lifetime and memory, which the app must control per stage.
- **`three`** and **`regl`**: rejected; either would add a dependency larger than the WebGL2 harness the app needs.

### Revisit when

- A pinned package ships a fix the app needs, or a security advisory against a pinned version appears.
- The owner decides to take Preact 11 or a newer Mediabunny.
- TypeScript 7 misbehaves on the project's sources, which points to TypeScript 5.9.
- The CDP driver or `safaridriver` cannot reach a behavior a scenario must check, which reopens a browser automation library.
- The in-repo zip reader passes its size bound, which points to `fflate`.

## ADR-002 - Models and their runtime served from noisy's origin

Status: Accepted

Date: 2026-10-01

### Context

Analysis runs four ONNX Runtime Web sessions from three weight sets: Depth Anything V2 Small, the SAM 2.1 hiera-tiny encoder and decoder, and MI-GAN.
The phone reaches noisy over Tailscale from the Mac, and the app makes no third-party request at run time; the CSP's `connect-src`, `script-src`, and `worker-src` are `'self'`.
The bench that chose these models loaded the runtime from jsDelivr and the weights from Hugging Face at run time.
The owner approved `onnxruntime-web` on 2026-09-29 and the three weight sets with the rest of the dependency list on 2026-09-30 (owner decision Q1, [ADR-001](#adr-001---toolchain-and-pinned-dependency-set)); the evaluation is section 18 of the v1 design, kept outside version control under `.claude/work/noisy-v1/`.

### Decision

The runtime and the weights are served from noisy's own origin, fetched before the app runs and verified against a lock.

- The runtime is `onnxruntime-web` 1.30.0's plain wasm build: `ort.wasm.min.mjs`, the glue module it imports, and the threaded wasm, copied byte for byte from the pinned package into every build under `/vendor/ort/1.30.0/`, imported by workers at run time and never bundled.
- `models.lock.json` pins every model file: its Hugging Face URL at the commit the bench used, its SHA-256 and byte length from Hugging Face's LFS metadata at that commit, its license, and its served path `/models/<model>-<sha8>.<ext>`.
  It holds three models, `depth`, `sam`, and `migan`; SAM's encoder and decoder files are one model, so their one `ModelId` changes when either changes, and embeddings computed by one encoder are never decoded by a different decoder.
- `tools/fetch-models.mjs` downloads only missing files, verifies each against the lock before renaming it into place, refuses a present file that does not match, and runs offline as a verify-only check.
- The runtime's path is cached as immutable, which its versioned name allows, so a worker start does not download it again.
  Model responses are `no-store`: the server does not check a model file against the lock, so the HTTP cache must not keep bytes the browser has not verified; verified model files are for the app to cache, not the HTTP cache.

[ARCHITECTURE.md](ARCHITECTURE.md#vendored-model-runtime) documents the runtime's files, and its [Models](ARCHITECTURE.md#models) section the lock, the `ModelId` rule, and the tool.

### Consequences

- The Mac holds the model files, 117,304,669 bytes as the lock pins them, and `npm test` fails until `node tools/fetch-models.mjs` has fetched them.
- Upgrading the runtime is a dependency change under ADR-001, and its files move to a new versioned directory; changing a model is a lock change, which gives the file a new served name and the model a new `ModelId`.
- ORT's pthread workers are same-origin module workers running the vendored glue, which `worker-src 'self'` allows: in headless Chrome 154 on the Mac the thread probe started 3 pthread workers at ORT's default of 4 threads with no CSP violation reported; the iPhone's figure is not yet measured.
- A browser never asks again for a runtime path it holds under the immutable rule, so a dev-server fault on `/vendor/ort/` reaches only a browser that has no copy, such as a fresh profile, or a request that bypasses the HTTP cache; a fault on `/models/` reaches every request.
- The release host must serve the same files under the same paths, with `models/` filled by the fetch tool.

### Alternatives considered

The first two are rejected outright by the design (section 18).

- **A runtime model CDN**: rejected; it ties every analysis to a third party's availability and shares the owner's IP address with it.
- **`@huggingface/transformers`**: rejected; it hides session lifetime and memory, which the app must control per stage.
- **The runtime from jsDelivr, as the bench loaded it**: not taken, for the CDN's reasons; in addition, when the glue module is on another origin and threads are on, the 1.30.0 entry fetches it into a `blob:` URL before importing it (read from `ort.wasm.min.mjs`), which `worker-src 'self'` does not allow for the pthread workers.
- **Bundling the runtime with esbuild**: not taken; the entry imports the glue and the glue loads the wasm relative to their own URLs, and serving the pinned files unchanged keeps them byte-identical to the package.

### Revisit when

- `onnxruntime-web` is upgraded, which re-reads which files the plain wasm entry loads.
- A model or its pinned commit changes, or Hugging Face stops serving a pinned file.
- The phone's thread probe reports a CSP violation or a thread count other than ORT's default.

## ADR-003 - One heavy sequence worker per sequence, and a resident decoder

Status: Accepted

Date: 2026-10-01

### Context

Analysis runs three heavy stages, depth, the SAM encoder, and MI-GAN's inpainting, plus the small SAM decoder, all in ONNX Runtime Web's wasm build ([ADR-002](#adr-002---models-and-their-runtime-served-from-noisys-origin)).
The iPhone's content process is the budget: the v1 design records the SAM encoder as the largest stage, at about 0.8 GB of wasm, and infers from a bench's allocations that the phone kills the tab somewhere between about 1.15 and 1.5 GB of content-process memory.
A wasm heap does not shrink, so a worker's memory is released only by terminating the worker.
This decision was made in planning (sections 7.1 and 21 of the v1 design, kept outside version control under `.claude/work/noisy-v1/`); the two worker entries were stubs when it was recorded, and the analysis parts build them to it.

### Decision

- Heavy stages run back to back in one module worker per sequence, `analysis/sequence-worker.ts`, in one wasm heap: each session is released before the next is created, each product is posted as it lands, and the worker is terminated when its list ends.
- The SAM decoder runs in its own worker, `analysis/decode-worker.ts`, held while the Objects tab is active or a tap is pending.
  It is released when the tab is left, after `decoderIdleMs`, when the hidden grace elapses, when a sequence that contains the encoder starts, when an export leaves its wait, or on close, so it can be released while the tab is active.
- The automatic subject's decode opens the same worker outside the Objects tab; it is released once that decode has been composed, unless the tab is active or a tap is pending then, in which case it stays as the resident decoder.
- At most one heavy worker exists in the page, and the decoder never runs beside a sequence that contains the encoder.
- A heavy worker never starts within a cooldown of the previous one's termination, keyed to the largest stage that worker ran, and the page's one analysis service records that termination so that a scene switch keeps the cooldown.

### Consequences

- The memory peak is the largest stage, not a sum that depends on timing, and an import pays one worker start for its stages instead of one per stage.
- The cooldown constants are provisional until the phone memory measurements set them.
- Leaving the Objects tab releases the decoder, and returning to it starts the decoder again before the first tap.

### Alternatives considered

The reasons below are the design's (section 21).

- **Per-stage workers, terminated then spawned**: not taken; the peak becomes a timing-dependent sum of stages, with three releases per sequence and two more worker starts on import.
- **One long-lived analysis worker holding every model**: not taken; it would keep about 0.8 GB resident while the owner edits.

### Revisit when

- The phone measurements show a stage other than the encoder is the largest, or no cooldown survives.
- Browsers gain a way to release a wasm heap without terminating its worker.

## ADR-004 - WebGL2 through an in-repo harness, not WebGPU

Status: Accepted

Date: 2026-10-01

### Context

The renderer draws noisy's look at master size on the iPhone and on the Mac.
Its passes are vertex and fragment work: two mesh draws, fullscreen filters, a short ray march, a radial blur, and a separable DCT; none needs compute.
This decision was made in planning (sections 9.1 and 21 of the v1 design); no renderer code exists yet.

### Decision

- The renderer uses WebGL2 through an in-repo harness, `render/gl.ts`: a program cache, a framebuffer pool keyed by format and size, ping-pong pairs, a fullscreen quad, grid meshes, uniform blocks, and residency accounting, with no rendering library ([ADR-001](#adr-001---toolchain-and-pinned-dependency-set)).
- The app creates one renderer per page, at boot, and compiles every program there.
- A context must enable `EXT_color_buffer_float` or `EXT_color_buffer_half_float`, and every float render target is 16-bit; no pass blends into a float target, and no 32-bit float texture is filtered or rendered to, so neither `EXT_float_blend` nor `OES_texture_float_linear` is ever needed.
- The renderer reports what it found at creation, and the environment snapshot carries that report.

### Consequences

- The project owns the harness code, and the passes are written so that a WebGPU port changes the shader language, not the passes.
- Shader compilation is paid once per page, while the Library is showing, not inside the first look after an import.
- A device whose context misses a required extension, a renderable format, or a limit is refused with a named reason.

### Alternatives considered

- **WebGPU**: not taken; iOS 26 is its first iOS release, GPU-process kills are reported without an API attribution, a device created without `requiredLimits` gets defaults that trap compute-heavy passes, the pass list needs nothing WebGL2 lacks, and a WebGL2 renderer is the cheaper decision to reverse.
- **`three`** and **`regl`**: not taken ([ADR-001](#adr-001---toolchain-and-pinned-dependency-set)); either would be a dependency larger than the harness.

### Revisit when

- WebGPU on iOS Safari has matured, or a pass needs compute.
- The phone's WebGL2 refuses the capability table, or a GPU-process limit makes the render targets unaffordable.

## ADR-005 - The scene file is a zip with a version rule

Status: Accepted

Date: 2026-10-01

### Context

Scenes move between the iPhone and the Mac as files, through AirDrop, the Files app, and Finder, which may unpack and re-zip them.
A build must never destroy a scene that a newer build wrote, and a scene's assets should stay readable even when its document is not.
This decision was made in planning (sections 5.8, 13.4, and 21 of the v1 design, and owner decision Q18, settled 2026-09-30); no scene file code exists yet.

### Decision

- A scene file is a zip named `<title>.noisy`: `scene.json`, compressed, holding the format name, the writing build's id, the document, and a manifest; then each asset as `assets/<sha256 hex>.<ext>`, PNG, JPEG, and HEIC stored and raw planes compressed.
- The writer is deterministic: a fixed entry order, every timestamp from the document's `updatedAt`, and sizes and CRC-32 in the local headers, so exporting a document twice yields identical bytes.
- The reader reads the central directory, tolerates what Finder re-zips add (data descriptors, `__MACOSX/` and `._` entries, one leading directory), refuses encryption, ZIP64, and archives past fixed entry-count and size bounds, and verifies every asset against its hash.
- The zip codec is in-repo, over `CompressionStream` and `DecompressionStream` ([ADR-001](#adr-001---toolchain-and-pinned-dependency-set)).
- The version rule: the document carries an integer `version`; a version above the build's is `newer-version`, never opened or rewritten, and exported verbatim; a lower version runs total migrations from `core/migrate.ts` before the strict parse; unknown keys at a known version make a record damaged, never rewritten.
- The version stays 0, with no migrations, until the owner declares the first scene worth keeping (Q18); from then on every change to the document's shape appends a migration with a fixture pair.

### Consequences

- Any unzip tool opens a scene file, and its PNG and JPEG assets are readable even when `scene.json` is not.
- Until the freeze, a change to the document's shape lists every earlier scene as damaged, and the owner makes it again from its photo; originals are worth keeping.
- The rows that need a record older than the build's version run in a harness build, through `tools/build.mjs --migrations`, which exists today and which a production build refuses ([ARCHITECTURE.md](ARCHITECTURE.md#build)).

### Alternatives considered

The reasons below are the design's (section 21).

- **JSON with base64 assets, or a custom container**: not taken; base64 inflates the assets by a third and parses as one large string on the phone, and a custom container cannot be opened without noisy, where a zip lets the owner recover the photo with any unzip tool.
- **`fflate`** for the codec: not taken for now ([ADR-001](#adr-001---toolchain-and-pinned-dependency-set)).
- **Dropping unknown keys with a notice**: not taken, on cost against need; it had grown to about ten contract points across five packages, needed a fix in each of three review rounds, and by then bought only one button over listing the record as damaged.
- **Passing unknown keys through**: not taken; it carries another branch's fields through every save, and the schema stops owning the shape.
- Strict rejection loses nothing in either case, because the record is never rewritten and the build that wrote it opens the exported file.

### Revisit when

- An archive the owner's devices produce is refused by the reader.
- The in-repo reader passes 400 lines, which points to `fflate`.
- The owner declares the first scene worth keeping, which starts the freeze that binds the migration rule.

## ADR-006 - The 2048 px master on both devices

Status: Accepted

Date: 2026-10-01

### Context

Every photo becomes a master, the canonical grid that analysis, the renderer, and the exports read.
The look erases fine detail by design, and the phone's GPU texture memory bounds the grid's size.
The owner settled the 2048 px output ceiling on both devices on 2026-09-30 (owner decision Q17); the design's resolution table (section 8) implements it.
No import code exists yet.

### Decision

- The master's long edge is `min(2048, the photo's long edge)` floored to an even number, and its short edge is scaled to match and rounded to the nearest even number, on the iPhone and on the Mac alike.
- The preview renders at master size and is scaled by CSS, and stills and MP4 loops export at master size.
- A GIF loop exports at a 480 px long edge by default, settable in the Export tab (owner decision Q8, settled with Q17), rendered at master size and downsampled to that grid.

### Consequences

- One canonical grid gives one render path, one set of golden images, and identical analysis on both devices.
- The preview equals the PNG and MP4 exports pixel for pixel, unless the phone cannot hold its frame target at master size; the design's named fallback then renders the phone's preview at half size, and the UI marks that preview approximate, while exports stay at master size.
- Both sides are even because an H.264 encoder scales a frame whose visible size differs from its configured size, which would resample the grain and the block effects.
- The picked file's bytes are kept beside the master (owner decision Q2), so a later larger master on the Mac would be a version bump with re-analysis, not a rewrite, and the phone would keep 2048.

### Alternatives considered

- **A larger master on the Mac**: not taken (Q17); it would split the render path, the golden images, and the analysis between the two devices.

### Revisit when

- The owner wants larger output on the Mac.
- The phone memory measurements show that a 2048 px master does not fit.

## ADR-007 - PNG masters and lossless planes as assets

Status: Accepted

Date: 2026-10-01

### Context

The palette statistics, the masks, the depth, and the look are all computed from the master's pixels, on whichever device opens the scene.
A lossy encoding decodes to slightly different pixels in different browsers, and a lossy plate would move band boundaries wherever it is composited.
This decision was made in planning (sections 5.1, 8, 12, and 21 of the v1 design); no import or asset code exists yet.

### Decision

- The master is a PNG, sRGB and opaque, encoded through `OffscreenCanvas.convertToBlob`; `core/raster.ts`'s `ImageRef` names it.
- The inpainted plate is a master-size PNG, composited only inside the hole.
- Depth and masks are raw planes, little-endian and row-major with no header, `f32` for depth and `u8` for masks; `core/raster.ts`'s `PlaneRef` carries their format and size.
- Every asset is addressed by the SHA-256 of its bytes and never changes; the picked file's bytes are stored verbatim beside the master.

### Consequences

- Both devices analyze identical pixels, because a PNG decodes to the same pixels in every browser.
  Rendering matches across devices only up to GPU float differences: the design's determinism rule compares stills of one scene file across devices within a stated tolerance.
- A master costs more bytes and more encode time at import than a JPEG would; the design records about 3.4 to 4 MB per master and about half a second of encode on the phone.
- A new plane encoding is a new `PlaneFormat` member, and a migration never rewrites asset bytes.

### Alternatives considered

The reasons below are the design's (section 21).

- **A JPEG master**: not taken; the two devices could analyze slightly different images.
- **A JPEG plate**: not taken; lossy bytes flip band boundaries across the scene when motion toggles.

### Revisit when

- Storage on the phone becomes the binding limit.
- A browser decodes the same PNG to different pixels.
