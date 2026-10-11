# Architecture

> **Owns:** how the code in this repository is laid out and how it runs today: the source layout, the module map and the import-graph rules, the npm scripts, the three type-check projects and their rules, the tests, the build, the bundle guard, the vendored model runtime, the model lock, the fetch tool, and the model loader, the analysis workers' message protocol and its parsers, the analysis stages' math, the known-answer checks, the ONNX Runtime module, the sequence worker, and the decode worker, the analysis service, the store's schema, connection, and scene lock, the synth fixtures, the response-header contract, the server's dev and production modes with their routes and formats, the start command, the `core` primitives, `platform/`, the composition root and its boot, the dev pages, and the browser driver with its scenarios.
> **Does not own:** why a tool or dependency was chosen ([DECISIONS.md](DECISIONS.md)), what changed when ([CHANGELOG.md](CHANGELOG.md)), current product/demo requirements ([PRODUCT.md](../PRODUCT.md) and [the revision](../plan/revision.md)), or the historical full-product reference design under `plan/reference/`.

This file describes only what exists.
Parts that land later add their own sections.

## Current application map

The long layout inventory below began with the foundations and is not an exhaustive map of the later demo modules.
The composed application also includes these delivered boundaries:

| Boundary | Responsibility |
| --- | --- |
| `src/main.tsx`, `src/app/` | Composition, platform boot, local/hybrid analysis wiring, session creation. |
| `src/ui/` | Preact shell, compact/tablet tools, layers, swatches, Projects, and status. |
| `src/session/` | Photo lifecycle, analysis policy, object selection/refinement, history, render clock, live viewing, exports, and Projects coordination. |
| `src/photo/` | One-still decode, orientation, size limits, canonical master and guide. |
| `src/analysis/` | Local workers/model loading and remote depth/plate adapter/composition; resident device SAM decoder. |
| `src/render/` | WebGL2 math treatment, photo/object composition, motion/live-view rendering and captures. |
| `src/export/` | GIF encoding, browser movie capture, and stereo foundations. |
| `src/projects/` | Shared-store transport, scene serialization and photo/mask validation. |
| `src/core/`, `src/platform/`, `src/store/` | Pure document/edit/math primitives, browser utilities, and existing local-store foundations. |
| `gpu/`, `tools/cloudflare/` | Standalone Radeon service and hosted application infrastructure. |

Product and UI requirements are in [PRODUCT.md](../PRODUCT.md) and the [feature handoff](../plan/handoffs/ui-redesign.md).
Proposed creative primitives belong to the plan until their implementation lands; this file does not claim them as delivered.

## Layout

```
src/
  main.tsx                   app entry: boots the composition root and renders the shell (see "The composition root")
  app/                       the composition root's types and shell (see "The composition root")
    events.ts                  DiagnosticEvent and EnvironmentSnapshot
    root.ts                    bootRoot: the page's clock, diagnostics, tab id, build id, and environment
    test-surface.ts            the dev-only window.__noisyTest
  core/                      pure primitives (see "Core")
    ids.ts, result.ts, raster.ts
    zod.ts                     the one module that imports the zod package
    schema.ts                  the scene document's strict schema (see "The scene document")
    types.ts                   the document's types, inferred from schema.ts
    ranges.ts                  the document's numeric ranges and length bounds
    migrate.ts                 the migration table and SCENE_VERSION
    defaults.ts                a new document's settings, a new object, a new light (see "Defaults")
    edits.ts                   the Edit and Produce types and the reducer's results (see "Edits and the reducer")
    reduce.ts                  applyEdit and applyEdits
    fry.ts                     the Fry curve (see "The Fry curve")
    produce.ts                 applyProduce and dropSource (see "Products and the dropped source")
    history.ts                 the undo history and coalescing (see "The undo history")
    equal.ts                   sameValue, the structural equality the reducer and products share
    derive.ts                  the derivations and reconcile (see "Derivations and reconcile")
    motion.ts                  the loop crop and the motion math (see "Motion")
    percentile.ts              nearest-rank percentiles (see "Core")
  platform/                  generic browser-facing modules, no domain type (see "Platform")
    diagnostics.ts, clock.ts, visibility.ts, capabilities.ts, build-id.ts, tab-id.ts
  analysis/                  the analysis leaf (see "The model loader", "The analysis stages' math", "The known-answer checks", "The sequence worker", "The decode worker", and "The analysis service")
    lock.ts                    the model lock's schema, its parse, each operation's files, the lock hash, and the model caches' names and keys
    bundled-lock.ts            bundledLock: the build's lock, parsed
    models.ts                  the model loader
    protocol.ts                AnalysisError, and the worker messages with their parsers (see "The worker protocol")
    depth-size.ts              depthInputSize and DEPTH_MAX_TOKENS (see "The depth input size")
    stage-math.ts              what goes into each analysis model and what its outputs become (see "The stage functions" and "The decoder's functions")
    checks.ts                  the known-answer checks of a depth map, a mask, and a plate against truth planes (see "The known-answer checks")
    ort-runtime.ts             the ONNX Runtime plumbing for the two analysis workers (see "The ONNX Runtime module")
    sequence-worker.ts         worker entry: the heavy stages (see "The sequence worker")
    service.ts                 createAnalysisService, the page's owner of the two analysis workers, and AnalysisEvent (see "The analysis service")
    decode-worker.ts           worker entry: the resident SAM decoder (see "The decode worker")
  store/                     the store leaf (see "The store")
    connection.ts              StoreError, StoreEvent, and the connection every store operation runs through
    idb.ts                     the database's name, version, and schema, the IndexedDB opener, requestDone, and transactionDone
    lock.ts                    the scene lock over Web Locks
  export/gif.ts                pure palette quantization, GIF89a/LZW encoding and worker protocol
  export/gif-worker.ts         worker entry, incremental GIF frame encoding
  export/movie.ts              browser movie format selection and canvas MediaRecorder
  index.html                 page template; the build fills in the app script
  manifest.webmanifest       web app manifest, copied as is
  icon.svg                   icon for the page and the manifest, copied as is
  build-env.d.ts             compile-time constants of every entry
  app-env.d.ts               compile-time constant of the app entry only
  vendor-ort.d.ts            types of the vendored runtime's import specifier
  dev/                       dev pages and dev workers, built in dev mode only (see "Dev pages")
    threads.html, threads.ts   the thread probe page
    checklist.html, checklist.tsx  the phone checklist page, with checklist-*.ts beside it (see "The phone checklist")
    models.html, models.ts     the model loader page (see "The model loader page")
    sequence.html, sequence.ts  the sequence worker page (see "The sequence worker page")
    service.html, service.ts   the analysis service page (see "The analysis service page")
    decoder.html, decoder.ts   the decoder page (see "The decoder page")
    store.html, store.ts       the store page (see "The store page")
    checklist-rows.ts          the phone rows' registry and its types
    checklist-post.ts          the rows the checklist posts, and the posting
    checklist-environment.ts   the checklist's own environment snapshot and CSP violations
    checklist-style.ts         the checklist's constructed stylesheet
    threads-worker.ts          the thread probe's worker
    threads-protocol.ts        the worker's messages to the page
    tiny-model.ts              a one-node ONNX model built in code
    dev-env.d.ts               compile-time constant of the dev pages
    harness/                   the memory harness's modules (see "The memory harness")
      holes.ts                 the holes, `corners` and `full` (see "The harness's holes")
      lines.ts                 the pass lines and the plan's constants
      rows.ts                  the posted row contract
      catalog.ts               the harness's pages and their keys, the row ids, the plan kinds, and each row's family
      steps.ts                 a step, what the shared rules read per step kind, and the scores a step that returned reports
      states.ts                every row family's persisted state, the plan row, and the row verdicts
      context.ts               what a row program reads beyond its row: the levers, the encode mode, and the plan context
      plan.ts                  the plan's persisted state, the context it builds, and its lifecycle
      registry.ts              the row programs' contract and the dispatch over them
      load.ts                  the step marker and the load-time verdicts
      outbox.ts                the write-ahead outbox and the post
      engine.ts                the engine that runs a plan on the page, and the runner's interface
      wake-lock.ts             the screen wake lock the engine holds while a run is wanted (see "The wake lock")
      liveness.ts              the app-shaped marker, the tab lock, and the liveness report (see "The liveness report")
      programs/runs.ts         the program of the rows that count runs
      programs/untouched.ts    the program of the untouched calibration
      programs/killpoint.ts    the program of the two kill-point rows
      memory.html, memory.ts   the memory harness page (see "The page")
      levers.ts                the page's levers
      ballast.ts               the filled ballast, its checksum, the stand-in, and the allocator (see "The ballast")
      inputs.ts                the synth master and the holes a sequence step runs on (see "The inputs")
      sequence-run.ts          the wait every step makes and one heavy run of a sequence step (see "A sequence run")
      runner.ts                the memory page's runner and the rows its executors run
      status-view.ts           the status a harness page renders
      style.ts                 the harness pages' constructed stylesheet
tools/
  build.mjs                  the esbuild build
  serve.mjs                  the server, in dev and production modes
  headers.mjs                reads headers.json; shared by serve.mjs and check-headers.mjs
  check-headers.mjs          checks a running server against headers.json
  fetch-models.mjs           fetches and verifies the model files against models.lock.json
  drive-chrome.mjs           the browser driver's command line (see "Browser driver")
  start.mjs                  npm start, the owner's start command (see "The start command")
test/                        node:test files, test/support/ (cli.ts, import-graph.ts, bundle-guard.ts, dev-only-paths.ts, tailscale-stub.ts, harness-world.ts, ballast-reference.ts), and test/fixtures/ (documents.ts, edits.ts, harness.ts, migrate-synthetic.ts, products.ts, and synth/, see "The synth fixtures")
  browser/                   the browser driver and its scenarios (see "Browser driver")
headers.json                 the response-header contract
models.lock.json             the model files, pinned (see "Models")
tsconfig.base.json           shared compiler options
tsconfig.json                the app project
tsconfig.worker.json         the worker project
tsconfig.test.json           the node test project
```

Generated and local-only paths, all gitignored: `node_modules/`, `build/` (build output), `models/` (the model files, written by `tools/fetch-models.mjs` and served at `/models/`), `test-results/` (the dev server's sink, request log, and CSP reports, and the browser driver's run directories), and `.local/`.

## npm scripts

| Script | Runs |
| --- | --- |
| `npm run typecheck` | `tsc -p` on `tsconfig.json`, `tsconfig.worker.json`, and `tsconfig.test.json`, in that order |
| `npm test` | `node --test --test-timeout=60000 "test/**/*.test.ts"` |
| `npm run test:browser` | `npm run build && npm run build:production && node tools/drive-chrome.mjs`: both builds, then every browser scenario (see "Browser driver") |
| `npm run build` | `node tools/build.mjs --mode dev` |
| `npm run build:production` | `node tools/build.mjs --mode production` |
| `npm run serve` | `node tools/serve.mjs --mode dev` |
| `npm run check:headers -- <base-url>` | `node tools/check-headers.mjs <base-url>` |
| `npm start` | `node tools/start.mjs`: the production build, served on this Mac and shared to the tailnet until Ctrl-C (see "The start command") |

Dependencies are pinned exactly (`.npmrc` sets `save-exact=true`) and the versions are in `package.json`.
`package.json`'s `allowScripts` denies the install scripts of `esbuild` and `protobufjs`, so `npm ci` runs no dependency install script; esbuild runs from its platform package without its own script.

## Type checking

TypeScript checks the sources and never emits; esbuild does the emit.
`tsconfig.base.json` holds the shared options: `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions` with `noEmit`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: "preserve"`, `moduleResolution: "bundler"`, `target: "es2024"`, `jsx: "react-jsx"` with `jsxImportSource: "preact"`, `types: []`, and `skipLibCheck`.
Three projects extend it, so that worker code is checked against the `webworker` library alone and everything else against `dom`; one program holding both libraries would let a worker name a DOM-only global:

| Project | Checks | `lib` | `types` |
| --- | --- | --- | --- |
| `tsconfig.json` | every file under `src/` except `src/**/*-worker.ts` | `es2024`, `esnext.disposable`, `dom`, `dom.iterable` | none |
| `tsconfig.worker.json` | `src/**/*-worker.ts`, every module they import, `src/build-env.d.ts`, and `src/vendor-ort.d.ts` | `es2024`, `webworker` | none |
| `tsconfig.test.json` | every file under `test/`, every module it imports, and `src/vendor-ort.d.ts` | as the app | `node` |

Two rules keep the three projects whole:

1. Worker-global calls (`self.postMessage`, the message handler, `self.close`) appear only in `*-worker.ts` entries.
   Under the app's `dom` library, `self.postMessage` with a transfer list fails with TS2769.
2. Main-thread code that sets timers calls `window.setTimeout` and `window.clearTimeout`, never the bare globals.
   Under the test project's Node typings the bare `setTimeout` returns `NodeJS.Timeout`, not `number`.
   `window` does not exist under the `webworker` library, so such a module must not be reachable from a worker entry.

Sources use no `enum` and no `namespace`, import relative files with their `.ts` extension, and use `import type` for type-only imports, so Node's type stripping can run the modules the node tests import.

Why `skipLibCheck` and `esnext.disposable` are on is recorded in [ADR-001](DECISIONS.md#adr-001---toolchain-and-pinned-dependency-set).

## Tests

`npm test` runs every `test/**/*.test.ts` file under `node:test`, with Node running the TypeScript by type stripping.
The glob is explicit so that the experiment files named `*.test.ts` under the gitignored `.claude/work/` never run.
The test project type-checks the same files, so run `npm run typecheck` beside `npm test`.

- `test/headers.test.ts` reads the working tree's `headers.json` and checks that it names COOP, COEP, and the CSP.
- `test/dependencies.test.ts` reads the working tree's `package.json`, `package-lock.json`, and `node_modules/`, and checks the exact pins, the installed versions, and that no rejected package is in `package-lock.json`.
- `test/build.test.ts` runs `tools/build.mjs` as a child process (`test/support/cli.ts`) on `src/` and on throwaway source trees, in both modes, into temporary directories.
- `test/serve.test.ts` runs `tools/serve.mjs` and `tools/check-headers.mjs` as child processes, with the server on a free port and every root, sink, and log in temporary directories.
- `test/serve-production.test.ts` does the same for production mode, on a throwaway production build with a `dev/` and an `api/` directory planted in it and symlinks into them: the header contract and no header beyond it, `Range` on a model, `404` for every request in `test/support/dev-only-paths.ts` and for every way to the planted files, through `/`, a symlink, `/models/`, and `/vendor/ort/` among them, four of which a dev-mode server on the same root serves with `200`, as it does the planted files reached through `/models/` and `/vendor/ort/`, and the refusal of the dev-only flags.
- `test/start.test.ts` runs `tools/start.mjs` with `test/support/tailscale-stub.ts` standing in for `tailscale` first on `PATH`, so no test needs a tailnet or touches the real Tailscale configuration, and with its build, models, and lock in temporary directories and its server on a free port (see "The start command").
- `test/models.test.ts` checks `models.lock.json`'s shape, with the schema of `src/analysis/lock.ts`, and its `ModelId`s, each operation's files, what `parseLock` refuses, the lock hash's text and digest, and the model caches' names and keys; it runs `tools/fetch-models.mjs --verify-only` on the working tree's `models/`, and runs the tool in temporary directories on tampered and truncated files, on malformed locks, and with `--origin` on a local server that serves good, wrong, and endless bodies, with a partial download left by an exited process beside them.
  It reads the real `models/`, so it fails, and never skips, until `node tools/fetch-models.mjs` has fetched the files.
- `test/model-loader.test.ts` runs `src/analysis/models.ts` against a local HTTP server with Node's own `fetch`, WebCrypto, and Web Locks (`navigator.locks`), and an in-memory stand-in for Cache Storage, which Node lacks: every error the loader returns, the segments a download keeps and resumes from, a server that ignores `Range`, a file stored in several segments, a refused segment closing its connection, the startup cleanup, two fetches of one file at once, a file another holder keeps past the stall timeout, caches deleted under an open loader, and `clearModelCaches`.
- `test/protocol.test.ts` runs the worker protocol's four parsers on every valid form of each message, as built and after `structuredClone` (a form's stand-in bitmap is carried across the clone as it is, since a clone would strip its tag), and on malformed forms, each of which must fail at its own path; it checks at the type level that each parsed type equals the shape written out by hand in the test (see "The worker protocol").
- `test/analysis-decoder.test.ts` drives the service's decoder half with scripted decode-worker ports and a clock it sets: `openDecoder` and its `init`, decodes answered in and out of order, a `failed` reply, an abort before the call and while pending with the late reply dropped, `release()` before, during, and after decodes and twice, `openDecoder` while a decoder is alive, an `error` event with and without a message, a `messageerror` event, and a reply that does not parse, a `spawnDecoder` that throws, an `init` or a decode whose post throws, a reply naming no pending decode, and the events of each (see "The decoder").
- `test/analysis-service.test.ts` drives `src/analysis/service.ts` with a scripted worker port, a clock it sets, and a stand-in loader: depth then encode, each failure (a `failed` reply, an `error` event with and without a message, a `messageerror` event, and a reply that does not parse) at five points of a sequence, `master()` rejecting, a run or `init` whose post throws, a spawn that throws, replies the running stage cannot give, `cancelHeavy` and an abort at the same five points and after the end, an already aborted signal, a sequence started while one is alive or from inside the cancelled one's `onFailed`, the termination record's cases, the events with their fields, and `fetchModels` with a loader that failed to open, a failing fetch, a fetch that throws, and success (see "The analysis service").
- `test/percentile.test.ts` checks `core/percentile.ts` on hand-computed arrays: an even count's lower middle value, `p` 1 the maximum, the exact rank where `Math.ceil` in doubles is one too high, an input left unchanged, and the refusals.
- `test/depth-size.test.ts` checks `depthInputSize` against fixed expected sizes for six landscape masters from 2048 x 1536 to 2048 x 64 and a portrait master, and over every even master from 512 to 2048 px on its long edge and from 64 px on its short edge, either way up, that both sides are whole patches and the patches at most `DEPTH_MAX_TOKENS`.
- `test/stage-math.test.ts` runs each function of `analysis/stage-math.ts` on hand-computed inputs with exact expected outputs and on malformed inputs, each refused with its reason; it runs `depthProduct`, `miganInput`, and `plateFromResult` on the synth fixtures at their real sizes, and `depthProduct`, `plateFromResult`, and `decodeCandidates` on outputs made of `onnxruntime-web`'s own `Tensor` objects; the depth, embeddings, plate, and candidates it builds parse as the workers' replies (see "The stage functions" and "The decoder's functions").
- `test/synth.test.ts` pins the SHA-256 of every synth fixture output at every fixture size and regenerates each to check it, and checks the even sides, the masks, the hole, the depth check's near and far regions, and the ring against the scene's geometry, the plate against the master, and every depth texel against the inverse distance painted there (see "The synth fixtures").
- `test/checks.test.ts` runs each known-answer check on hand-computed planes, with exact expected numbers, a case on each side of every threshold, a case on each side of each of the eight roundings that decide a verdict, the median rule, the region threshold, and every refusal; then each check on every synth fixture at its real size, passing on the fixture's own truth and failing on a wrong product (see "The known-answer checks").
- `test/holes.test.ts` checks `src/dev/harness/holes.ts`: the corner radius's rounding, every pixel of both shapes at several sizes against the corner discs' rule written out again, the corner discs' share of each master, their mirror symmetry, the SHA-256 of each shape at 2048 x 1536 and 2048 x 2048 against the digests `test/fixtures/hole-digests.ts` pins, and the `RangeError` (see "The harness's holes").
- `test/harness-plan.test.ts` checks `src/dev/harness/plan.ts` with the modules it builds on (`catalog.ts`, `steps.ts`, `states.ts`, `context.ts`, and `registry.ts`), `rows.ts`, and `programs/runs.ts`: the plan Start makes and the plans it refuses, the encode mode in both plan kinds, the run-counting program ending at its first non-survival at the first, a middle, and the last run and with every run surviving, a step voided one to five times, every event parsing through the row schema, the constants, and the serialized plan at the full plan's largest state under its budget, whose length it prints (see "The memory harness").
- `test/harness-load.test.ts` checks `src/dev/harness/load.ts`: every row of the load-time verdict table, a completed step hidden for less than, exactly, and more than the grace, and how each verdict changes the plan, the rows it posts, and the least wait (see "The memory harness").
- `test/harness-outbox.test.ts` checks `src/dev/harness/outbox.ts` over a fake storage with an origin quota and a fake `fetch`: the post's answers, its timeout, and its keepalive bound, rows kept until the sink answers `ok` or a 4xx, one post at a time, a backlog past the cap, a write past the quota, `makeRoom`, and a storage and a post that throw (see "The memory harness").
- `test/harness-engine.test.ts` drives `src/dev/harness/engine.ts` on pages of `test/support/harness-world.ts`, a fake origin whose pages share one storage, clock, Web Locks manager, and sink and each have their own timers, visibility, outbox, and scripted runner; a page's `kill()` stops its timers, its writes, and its posts and releases its lock, as a killed process's are.
  It covers a run of the untouched row to DONE; a page killed in each phase of a step, between its plan write and its marker write, between the plan write that folds the step and the marker's clearing, and between a load's plan write and its clearing of the marker, each followed by a new page's load over the same storage; `pagehide`, a hidden page, and a brief hide before a kill; a step that completes after a hidden period past the grace; five voids of one step; a page hidden when a step would start; a sink that answers 500 and then ok, and one that never answers; a stored run of another build or that does not parse; plan, marker, and heartbeat writes that throw once, and plan, marker, heartbeat, and completion writes that throw twice; a second page while the first holds the runner lock, with the lock released within and after the wait, the holder moving on to another step during the wait, and the rows it stores meanwhile; a page left open at DONE while another page runs; Start refused; Start's own `load` row, with Web Locks and without; Start over a run another page left unfinished, with a step in flight or between steps, from a page that loaded before that run began and from one whose load answered `elsewhere` while that page held the lock (after `LOCK_WAIT_MS` with a step in flight, at once between steps), which it refuses, and over a DONE run, a plan of another build, and a plan that does not parse, which it replaces; Stop mid-step and at DONE, and Start after Stop; a death in a wait after a sequence step; and `programs/untouched.ts`.
  The world records every write a page makes to the harness's keys before it first held the runner lock, and every write to the plan or the marker while another page holds it, and every test that opens a page with Web Locks asserts there is none; the outbox's flushes after DONE and Stop are not recorded, since they run without the lock by design.
  They share `test/fixtures/harness.ts`.
- `test/harness-ballast.test.ts` checks `src/dev/harness/ballast.ts` against `test/support/ballast-reference.ts`, a second coding of the fill and the checksum that writes each word through a `DataView`: the bytes and the sums of 1 MB chunks at indexes 0, 1, 7, 29, and the stand-in's, and of 100 MB chunks at indexes 0 and 39, byte for byte; chunk 0's sums at both sizes against recorded values; the checksum's stride; the throwAtMb lever at, just below, and just above a total, and an allocation that throws; the heap growing by its new chunks only and keeping the buffers it made, truncated, thrown, stopped, and released; and the stand-in (see "The ballast").
- `test/harness-killpoint.test.ts` checks `src/dev/harness/programs/killpoint.ts` through the plan: the ladder at 1 MB and 100 MB chunks ending at its ceiling (a multiple of the chunk, not a multiple, and below one chunk), by a kill in a fill, in a hold, and in a phase that names no size, by a renderer death read at the next load, and by a throw; the outcomes it ignores; `U1.killpoint.after` after `U1.killpoint` in one plan; and the headroom ceiling `planContext` reads, against the row's last held step at every ending.
- `test/harness-runner.test.ts` checks `src/dev/harness/runner.ts` over node's timers: the untouched step's chunks, phases, hold, and release with no buffer touched; the ballast step at 1 MB and 100 MB chunks, each ladder step allocating only its new chunk, its checksums against `test/support/ballast-reference.ts`, the ballast held from step to step and past the ladder's last step, kept below a throw with the lever at, just below, and just above a step's size, dropped by Stop in the fill and in the hold and by `release()` mid-row and at the row's end, the second kill-point row's first step, and a step run again, the ladder's last and one that threw included; each step's `wait` reported first; the steps it rejects; and `unexecutedRows`.
- `test/harness-sequence.test.ts` checks `src/dev/harness/sequence-run.ts`, `inputs.ts`, and the runner's sequence executor and setup over node's timers, with the real `createAnalysisService` on scripted sequence worker ports from `test/support/harness-service.ts`, which answer each stage as the test says (a product with a high-water mark, a `failed` reply, an `error` event, or nothing), a scripted model loader, and inputs whose fetch the test scripts: a `[depth, encode]` run's phases, `after` only once its port is terminated, and every field of its reading; the cooldown before the next run, its setup after the wait, and its gap; the setup's time as `setupMs`; no timeout timer left after a run ends; the wait's end on a clock whose timers fire early; the cooldown after a worker whose encoder failed before inference, waited as an encoder's; the stand-in filled once, summed after each run, and released by a step that does not keep it and by `release()`; the kill-point ballast dropped before a sequence spawns; the cooldown before ballast and untouched steps after a run; a timeout, a failed reply, an error event, and Stop in the run and in the wait at `defaultsScale` 1; a master fetch that fails and recovers after the retry time, which a later attempt waits in its `setup` phase once the cooldown has ended, a master of the wrong length, and a model fetch that fails; `waitMsAfter` at `defaultsScale` 1 and 0.01; a service per thread count; the release order and the refused conditions; an inpaint run's hole; and the inputs alone, the fetch timeout included.
- `test/harness-liveness.test.ts` drives `src/dev/harness/liveness.ts` and `wake-lock.ts` through the engine on pages of `test/support/harness-world.ts`, whose Web Locks answer `query()`, whose kills may leave named locks held, and whose pages each have a fake wake lock that grants, refuses, or answers later, is absent, or is released as the browser does: every death verdict and every other verdict at load, the dead tab's marker present and absent, its lock held, pending, and free at the load, 2 s, and 10 s, and held with the dead page's runner lock, a reload before the late rows, the late rows and a step, the tab lock, the app-shaped marker's life, an engine without the liveness dependency, each wake-lock answer, a refusal and a grant that answer while a lock is held among them, and the wake lock released by a Start whose plan write throws twice and by a Start that rejects (see "The liveness report").
- `test/tiny-model.test.ts` loads `src/dev/tiny-model.ts`'s model in `onnxruntime-web`'s own Node build and checks its output.
- `test/core.test.ts` imports every module of `src/core/`, statically, so the test project type-checks each one, and again under node, and fails when `src/core/` holds a module its list does not name; it also checks the id checks, the `Result` constructors, and that `core/zod.ts` leaves zod jitless.
- `test/schema.test.ts` checks the scene document's schema against the ranges table, the invariants, unknown keys, the round trip, and the version's type-level guard (see "The scene document").
  Its documents come from `test/fixtures/documents.ts`.
- `test/parse.test.ts` checks the parse chain: `peekVersion`'s version rule, the bound `parseDocument` on the fixture documents, `parseDocumentWith` on the synthetic chain of `test/fixtures/migrate-synthetic.ts` and on tables whose migrations fail, a table of hostile values that must each get a `Result`, and at the type level that the synthetic module has `core/migrate.ts`'s shape (see "The parse chain").
- `test/defaults.test.ts` checks that a document built from `core/defaults.ts` parses and holds the defaults (see "Defaults").
- `test/reduce.test.ts` runs every edit of `test/fixtures/edits.ts` and checks its outcome, that the result parses, that an applied edit's inverse list restores the document but `updatedAt` and that the inverse of that list redoes it, that an unchanged or refused edit returns its input, that no edit writes to its input or changes `analysis`, and that only `object.refine` changes a `produced`; it also checks the clamp of every number an edit sets at both ends of its range against a table that must name every such `RANGES` path, the rounding, the limits, the refusals, and the side effects (see "Edits and the reducer").
- `test/fry.test.ts` checks the Fry curve's ends, its default position against `defaultStyle()`, its linearity, and the `fry` edit.
- `test/reduce-random.test.ts` applies 2000 seeded random sequences of 12 steps each to the fixture documents, about a quarter of the steps analysis products and the rest edits, with values in and out of range, non-finite numbers, the fixture edits the types forbid, unknown ids, and products the document has moved past, and checks after every step that the document parses, that an unchanged or refused step returned its input, that an applied edit's inverse list restores the document before it, and that no edit changed `analysis`; it prints how many steps had each outcome.
- `test/produce.test.ts` checks each product kind against the rules of "Products and the dropped source": what applies, what is unchanged, what is refused, that no product writes to its input, and `dropSource`.
  Its products come from `test/fixtures/products.ts`.
- `test/history.test.ts` checks the coalescing keys, the bound, redo cleared by a new edit, coalescing within the window and not across fields, swatches, an undo, or a redo, a drag back to its start leaving no step, a swatch dragged under both zeros, undo and redo through `applyEdits`, `referencedAssets`, and undo after a product (see "The undo history").
- `test/derive.test.ts` checks the draw order on cases and on 500 seeded random scenes, the bilinear rule's cases, `labelAt`, `holeMask` byte for byte against a brute-force union and disc and its radius's rounding, `plateNeeded`, `anchorDisparity`'s fallbacks, and `assetRefs` against every `AssetId` field the schema declares (see "Derivations and reconcile").
  It times `holeMask` over four 2048 x 1536 masks, prints the times, and fails when the best of three runs takes 2000 ms or more.
- `test/reconcile.test.ts` checks the plan's cases, and its invariants on every fixture document and on a grid of 288 generated documents (depth absent or present, the guess pending or done, 0 to 2 objects with the first one's motion none or bob, motion off or on, orbit 0 or 0.6, and no plate, a current one, or a stale one), each under every cache state, set of blocked operations, and intent (see "Reconcile").
- `test/motion.test.ts` checks `effectiveOrbit`, the loop crop's constants, `frameCount`, that every periodic term has the same value at phase 1 as at phase 0 bit for bit, the camera's parallax and its clamp, the amplitudes of bob, sway, and wobble, that every object motion is at rest at phase 0, and the bound on an object's motion, sway's against a brute-force rotation of the bounds' corners.
  On the fixture documents and on a grid of 4320 generated documents (three frame shapes, motion on or off, three orbits, four focus values, ten placements of an object at, near, inside, and across the frame's edges, and each motion at two amounts) it checks that no frame-edge point moves inward past `PARALLAX_MARGIN` and that every object's own motion keeps its bounds inside the frame (see "Motion").
- `test/history-random.test.ts` runs 200 seeded random sessions of 160 steps each, of edits (most of them one-field drags, half of them continuing the drag before), products of every kind, undos, and redos, the way a session runs them, with the driver's `found: null` after the owner's first object; it checks after every step that the document parses, after every undo or redo that the document equals, but for what products own (`analysis`, each object's depth statistics, and a guessed subject) and `updatedAt`, the document before or after the step, and after a drag that returned to its start that no step remains and the document equals the one before the drag; it prints how many steps took each path (pushed, coalesced, returned to the start, dropped past the bound, unchanged, undone, redone, products applied, `object.depth` applied, and subjects guessed), and fails when any path but the guessed subject ran 100 times or fewer, or the guessed subject 10 times or fewer.
- `test/store-connection.test.ts` drives `src/store/connection.ts` with a scripted opener whose handles it closes, fails, and fires events on: healthy operations, one and two `InvalidStateError`s and `UnknownError`s at the first and at the third operation, a connection error followed by the operation's own error, a handle the browser closes while idle and during an operation, a `versionchange` while idle and with an operation in flight, a database at a newer version alone and after a connection error, failed opens and an opener that throws or rejects, the operation's own errors, and concurrent operations during a reopen (see "The connection").
- `test/store-lock.test.ts` runs `src/store/lock.ts` on Node's own Web Locks (`navigator.locks`): a held scene asked for again from the same context and from a worker thread is refused at once with nothing pending, the lock is held while `fn` awaits, and it is released when `fn` resolves, rejects, or throws (see "The scene lock").
- `test/platform.test.ts` drives the `platform/` modules but `build-id.ts` through the narrow browser interface each takes, with fakes: the ring buffer, the clock, the visibility source, the device facts, and the tab id.
- `test/diagnostic-vocabulary.test.ts` is mostly a type test of the diagnostic vocabulary (see "The composition root").
- `test/import-graph.test.ts` runs the import-graph checker on `src/` and on synthetic trees (see "Module map and the import graph").
- `test/bundle-guard.test.ts` runs the bundle guard on a production build and on output that breaks it (see "Bundle guard").

- `test/drive-chrome.test.ts` checks the browser driver's DevTools pipe and cleanup with in-memory streams, then builds a dev build into a temporary directory and runs four scenarios of its own in headless Chrome (see "Browser driver"): one that hangs the page's main thread, one that crashes the renderer, and one whose server dies must each fail within bounds, and the fourth must still pass after them.
  It needs Chrome at the driver's default path, and fails, never skips, without it.

No `node:test` test writes to the working tree's `build/`, `models/`, or `test-results/`.
The browser scenarios under `test/browser/` are not `node:test` files and the glob does not match them; `npm run test:browser` runs them, and the test project type-checks them.
`npm run test:browser` does write to the working tree: it rebuilds `build/dev/` and `build/production/`, and each run adds a directory under `test-results/`.

## Build

`tools/build.mjs` bundles four entries with esbuild: the app `src/main.tsx` and the three workers `src/analysis/sequence-worker.ts`, `src/analysis/decode-worker.ts`, and `src/export/gif-worker.ts`.
The workers are built first, so the app can be given their content-hashed URLs.
The gif worker encodes loop frames incrementally (see "Loop exports"); the sequence and decode workers are built (see "The sequence worker" and "The decode worker").
The manifest, copied as is, sets `display: standalone`.
In both modes it also copies the vendored model runtime (see "Vendored model runtime"), and in dev mode it builds the dev pages (see "Dev pages").

| Flag | Meaning |
| --- | --- |
| `--mode dev` | the default: linked source maps, not minified, `NOISY_DEV` true |
| `--mode production` | minified, no source maps, `NOISY_DEV` false, and esbuild's `drop: ['console', 'debugger']`, so no bundle it writes carries a `console.` call, the bundled third-party code's included |
| `--outdir <dir>` | the output directory; default `build/dev` or `build/production` |
| `--src <dir>` | the source root holding the four entries, `index.html`, `manifest.webmanifest`, `icon.svg`, and the optional `dev/`; default `src`; tests point it at throwaway trees |
| `--gpu <url>` | analysis service base URL, default `NOISY_GPU_URL` or empty; only its origin is added to `connect-src` |
| `--lock <file>` | the model lock the bundles carry as `NOISY_MODEL_LOCK`; default `models.lock.json` (see "The model loader") |
| `--migrations <module>` | dev builds only: every import that resolves to `<src>/core/migrate.ts` loads `<module>` instead, through an esbuild resolve rule |

The rule catches an import however it is spelled (`./core/migrate.ts`, `../core/migrate.js`, or a wrong-case `../core/Migrate.ts` that macOS's case-insensitive file system resolves), because it resolves each import and compares where it lands on disk, symlinks resolved and in the on-disk case.
A production build given `--migrations` exits with status 1 and one sentence on stderr before writing anything.
A dev build given `--migrations` fails the same way when no import resolves to `<src>/core/migrate.ts`, since it would substitute nothing, and when a bundle's inputs still hold `<src>/core/migrate.ts` after the substitution.
Any other failure also exits 1 with one sentence and leaves the previous output in place: the build writes into `<outdir>.staging-<pid>` and renames it over `<outdir>` only on success.
The build refuses an `--outdir` that is a file, or a directory that is not empty and holds no `build.json`, so it never deletes anything it did not write.

Output layout:

```
<outdir>/
  index.html               from src/index.html, with %NOISY_APP% replaced by the app's URL
  manifest.webmanifest
  icon.svg
  build.json               what this build wrote (below)
  assets/main-<hash>.js
  assets/sequence-worker-<hash>.js
  assets/decode-worker-<hash>.js
  assets/gif-worker-<hash>.js
  assets/<dev page or dev worker>-<hash>.js   dev builds only
  assets/*.js.map          dev builds only
  vendor/ort/<version>/    the vendored runtime's three files
  dev/<name>.html          dev builds only
  dev/<dir>/<name>.html    dev builds only, a page one directory deep
```

Every content-hashed bundle is under `/assets/`, and the runtime under a directory named for its version, which is what the contract's immutable caching rules key on.
`index.html` has no inline `<script>` or `<style>`, since the CSP has no `'unsafe-inline'`.

`build.json` also carries `gpu` (empty by default) and the generated `headers` contract.
The app reads `gpu` once at boot; the server applies the configured origin to the source header contract without widening other directives.
The hosted prepare step takes `NOISY_GPU_URL` from the environment, falling back to the production build configuration, and writes the same GPU URL and policy into the hosted `build.json` and routing worker.
For local hosted preparation, load `.local/cloudflare.env` into the environment before running the command.

`build.json` records the build for tests and drivers:

```json
{
  "mode": "dev",
  "buildId": "nocommit-20261001",
  "app": "/assets/main-<hash>.js",
  "workers": { "sequence": "/assets/sequence-worker-<hash>.js", "decode": "...", "gif": "..." },
  "devPages": { "checklist": "/dev/checklist.html", "decoder": "/dev/decoder.html", "harness/memory": "/dev/harness/memory.html", "models": "/dev/models.html", "sequence": "/dev/sequence.html", "service": "/dev/service.html", "store": "/dev/store.html", "threads": "/dev/threads.html" },
  "devWorkers": { "threads": "/assets/threads-worker-<hash>.js" },
  "ort": { "version": "1.30.0", "dir": "/vendor/ort/1.30.0/", "files": ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"] },
  "migrations": null,
  "files": ["assets/...", "build.json", "dev/checklist.html", "dev/decoder.html", "dev/harness/memory.html", "dev/models.html", "dev/sequence.html", "dev/service.html", "dev/store.html", "dev/threads.html", "icon.svg", "index.html", "manifest.webmanifest",
            "vendor/ort/1.30.0/ort-wasm-simd-threaded.mjs", "vendor/ort/1.30.0/ort-wasm-simd-threaded.wasm", "vendor/ort/1.30.0/ort.wasm.min.mjs"]
}
```

A page one directory deep, `src/dev/<dir>/<name>.html`, has the key `"<dir>/<name>"` in `devPages`, beside the flat pages' `"<name>"` (see "Dev pages").
`devPages` and `devWorkers` are empty in a production build, and its `files` has no `dev/` entry and no source map.
`migrations` is the absolute path of the substituted module, or `null`; `files` lists every file in the output, relative to it.

### Build id and compile-time constants

The build id is `<commit>-<yyyymmdd>`: `git rev-parse --short=12 HEAD` (12 hex digits, more if git needs them to stay unambiguous) and the build's UTC date.
When `git rev-parse` fails, as in a repository with no commit, the commit part is `nocommit`.
A build from a working tree with uncommitted changes carries HEAD's commit, so the id does not say the tree was dirty.

esbuild's `define` injects six constants, declared for the type checker in `src/build-env.d.ts`, `src/app-env.d.ts`, and `src/dev/dev-env.d.ts`:

| Constant | Type | Entries |
| --- | --- | --- |
| `NOISY_BUILD_ID` | `string` | all four, and the dev pages and dev workers |
| `NOISY_DEV` | `boolean` | all four, and the dev pages and dev workers |
| `NOISY_ORT_DIR` | `string`, `/vendor/ort/<version>/`, for `env.wasm.wasmPaths` | all four, and the dev pages and dev workers |
| `NOISY_MODEL_LOCK` | `unknown`: the lock `--lock` names, `models.lock.json` by default, as an object literal, which `analysis/bundled-lock.ts` parses (see "The model loader") | all four, and the dev pages and dev workers, though only a bundle that reads it carries it |
| `NOISY_WORKER_URLS` | `{ sequence, decode, gif }`, each a root-relative URL for `new Worker(url, { type: 'module' })` | the app and the dev pages |
| `NOISY_DEV_WORKER_URLS` | the dev workers' URLs by name; `{}` in a production build | the app and the dev pages |

`tsconfig.test.json` includes none of these three declaration files, so a module that a node test imports fails the type check if it reads a constant that only a build provides.
It does include `src/vendor-ort.d.ts`, which declares types and no value, so such a module can take the runtime's types with `import type` from `noisy:vendor-ort`; Node's type stripping erases that import.

## Vendored model runtime

The models run on `onnxruntime-web` 1.30.0's plain wasm build, served from noisy's own origin ([ADR-002](DECISIONS.md#adr-002---models-and-their-runtime-served-from-noisys-origin)).
Both builds copy three files byte for byte from `node_modules/onnxruntime-web/dist/` into `<outdir>/vendor/ort/<version>/`, where `<version>` is the installed package's:

| File | Role |
| --- | --- |
| `ort.wasm.min.mjs` | the entry a worker imports |
| `ort-wasm-simd-threaded.mjs` | the Emscripten glue the entry imports from the same directory; each pthread worker runs it too, as a same-origin module worker (`new Worker(new URL(import.meta.url), { type: 'module', name: 'em-pthread' })`) |
| `ort-wasm-simd-threaded.wasm` | the threaded wasm the glue loads |

No other file of the package ships: no `jsep`, `jspi`, `asyncify`, WebGPU, WebGL, or bundle variant, and no source map.
Sources import the entry as `noisy:vendor-ort` (`const ort = await import('noisy:vendor-ort')`); the build rewrites that specifier to an external import of `/vendor/ort/<version>/ort.wasm.min.mjs`, so the runtime is fetched at run time and never bundled, and `src/vendor-ort.d.ts` gives it the package's own types.
A source that imports from `onnxruntime-web` or `onnxruntime-common` fails the build, with one exception: an `import type` statement builds, because esbuild drops it before resolving it, while `import { type X }` does not, since `verbatimModuleSyntax` keeps it as a side-effect import; sources take the types from `noisy:vendor-ort` either way.
The thread probe's worker sets `ort.env.wasm.wasmPaths = NOISY_ORT_DIR`, and the sequence and decode workers set it to their `init` request's `ortBase`, which the dev pages send as `NOISY_ORT_DIR`.
ORT's default `numThreads` is 1 when the page is not cross-origin isolated, and otherwise `min(4, ceil(hardwareConcurrency / 2))`, read from the 1.30.0 entry; at `n` threads the glue starts `n - 1` pthread workers.

## Models

### The lock

`models.lock.json` pins every file of every model:

```json
{
  "lockVersion": 1,
  "models": {
    "sam": {
      "modelId": "sam@<64 hex>",
      "repo": "onnx-community/sam2.1-hiera-tiny-ONNX",
      "commit": "<40 hex>",
      "license": "Apache-2.0",
      "licenseSource": "https://huggingface.co/facebook/sam2.1-hiera-tiny",
      "files": [
        { "session": "encoder", "role": "graph", "source": "https://huggingface.co/<repo>/resolve/<commit>/onnx/vision_encoder_quantized.onnx",
          "sha256": "<64 hex>", "bytes": 441167, "served": "/models/sam-8800fdd0.onnx" },
        { "session": "encoder", "role": "external-data", "source": ".../onnx/vision_encoder_quantized.onnx_data",
          "sha256": "<64 hex>", "bytes": 52573088, "served": "/models/sam-ea1f6775.onnx_data",
          "externalDataPath": "vision_encoder_quantized.onnx_data" },
        { "session": "decoder", "role": "graph", "...": "..." },
        { "session": "decoder", "role": "external-data", "...": "..." }
      ]
    }
  }
}
```

The models are `depth`, `sam`, and `migan`; the file itself is the authority for their sources, hashes, sizes, and licenses.
`session` names the ONNX Runtime session a file belongs to: `encoder` and `decoder` for `sam`, and the model's own name for `depth` and `migan`.
A model lists each session's files together, its one `graph` file first, then any `external-data` file.
`source` is the Hugging Face URL at the pinned commit; `sha256` and `bytes` are Hugging Face's LFS metadata at that commit.
`served` is `/models/<model name>-<first 8 hex of sha256>.<extension>`, so a changed file gets a new URL.
`externalDataPath` is the name the graph file references its weights by, which is the `path` ORT's `externalData` session option must be given for that file's bytes.

`ModelId` rule: a model's `modelId` is `<model name>@<hex>`, where `<hex>` is the SHA-256 of the text formed by each of its files' `sha256` hex digest followed by one line feed (`\n`), in the order of `files`.
Any change to any of a model's files changes its `ModelId`; SAM's encoder and decoder are one model, so a change to either changes the one `sam` id.
The lock records each `modelId`, and `test/models.test.ts` recomputes it by this rule.

### The fetch tool

`tools/fetch-models.mjs [--models <dir>] [--lock <file>] [--verify-only] [--origin <url>]` keeps the models directory in step with the lock.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--models` | `models` | the directory served at `/models/` |
| `--lock` | `models.lock.json` | the lock |
| `--verify-only` | off | check the files present and download nothing; no network |
| `--origin` | `https://huggingface.co` | the origin each source's path is fetched from, such as a mirror; the tests point it at a local server |

It refuses a lock in which a file's `source` is not under `https://huggingface.co/<repo>/resolve/<commit>/` for its model's `repo` and `commit`, or two files share a `served` path, so it asks no host but `--origin`.
It then hashes every file of the lock that is present.
A file whose length or SHA-256 differs from the lock, or that is not a readable file, is refused: one sentence on stderr naming it and saying to delete it and rerun, and the file is left as it is.
Only when every present file verifies does it download the missing ones, each from its `source` to `<served name>.part-<pid>` in the same directory, hashing as it writes, and renames it to its served name only when its length and SHA-256 match.
It stops reading a body once it is longer than the lock's `bytes`.
A download that does not match is deleted, and so is one interrupted by SIGINT, SIGTERM, or SIGHUP, which exits 130.
Before downloading, a run without `--verify-only` deletes each `<served name>.part-<pid>` whose process no longer exists, as a run killed by SIGKILL leaves; `--verify-only` deletes nothing.
The tool never puts a file at a served name unless it matched the lock.
Files in the directory that the lock does not name are left alone.

| Exit | Meaning |
| --- | --- |
| 0 | every file of the lock is present and verified |
| 1 | a present file does not match the lock, or cannot be read |
| 2 | a usage error, or the lock cannot be read or is malformed, a source off its pinned URL and a repeated `served` path included |
| 3 | `--verify-only` and files are missing; the sentence names `node tools/fetch-models.mjs` |
| 4 | a download failed or did not match the lock; nothing was placed for it, and the sentence says to check the network when the transfer failed or ended short, or the lock's entry when the source sent other bytes |
| 130 | interrupted by SIGINT, SIGTERM, or SIGHUP; the partial download was removed |

### The model loader

`src/analysis/models.ts` gets every file an analysis operation needs into Cache Storage, verified against the lock, from noisy's own origin.
The analysis service's `fetchModels` calls it (see "The analysis service"), and the model loader page and the sequence worker page drive it directly (see "The model loader page" and "The sequence worker page").

#### The lock in the bundle

`src/analysis/lock.ts` holds the lock's one shape, `modelLockSchema`, a strict zod schema built with `core/zod.ts`'s `z`.
`test/models.test.ts`, `test/build.test.ts`, and the browser scenarios read the lock through it too, so node tooling and the browser read one shape; `tools/fetch-models.mjs` keeps its own checks.
`parseLock(json)` returns a `Result` and, beyond the schema, refuses a `served` path used twice, a `modelId` that does not start with its own model's name, and a lock missing the session an operation needs or that session's graph file.
Its `ParsedLock` holds the lock and, under `ops`, each operation's files, which `OP_SESSIONS` reads from the lock's `session` field:

| Operation | Model | Session |
| --- | --- | --- |
| `depth` | `depth` | `depth` |
| `encode` | `sam` | `encoder` |
| `decode` | `sam` | `decoder` |
| `inpaint` | `migan` | `migan` |

An operation needs every file of its session, the `graph` and any `external-data` file, in the lock's order.

`tools/build.mjs` reads the lock its `--lock` flag names, `models.lock.json` by default, and injects it as the compile-time constant `NOISY_MODEL_LOCK`, an object literal (see "Build id and compile-time constants"); `npm start` passes its own `--lock`, so the bundle carries the lock the served files were verified against.
A lock that is not JSON fails the build; the schema check is the browser's parse, so a lock that `tools/fetch-models.mjs` accepts but the schema refuses builds and fails the model loader page at load.
`analysis/bundled-lock.ts` exports `bundledLock()`, which parses that constant with `parseLock` at startup; esbuild writes the literal only where the constant is read, so only a bundle that imports `bundled-lock.ts` carries the lock.
The lock arrives as a constant rather than a JSON import because an import of `../../models.lock.json` would leave the source root, which the import-graph checker refuses (see "Module map and the import graph").

The lock hash is the SHA-256, as 64 lowercase hex digits, of `lockHashText(lock)`: for each model in ascending code unit order of its name, and each of its files in the lock's order, the line `<served> <sha256> <bytes>` ended by a line feed.
A file is cached under its served URL and checked against its SHA-256 and length, so a lock that changes any of the three names new caches, and one that changes only a license, a source, or a session does not.
`lockHash(lock, subtle)` computes it with WebCrypto's `digest` in the browser and under Node alike, and `test/models.test.ts` checks it against `node:crypto` over the same text.

#### The caches

| Cache | Holds |
| --- | --- |
| `noisy-models-<lock hash>` | each verified file, whole, under its absolute served URL |
| `noisy-models-<lock hash>-partial` | the segments of downloads not yet verified: the entry `<served URL>?noisy-partial=<start>-<end>` holds the file's bytes from `start` up to, not including, `end` |

`lock.ts` names both, `MODEL_CACHE_PREFIX` (`noisy-models-`) and `modelCacheNames(hash)`, and a file's key, `modelFileUrl(file, origin)`, its served path made absolute on the origin, so the loader that writes the caches and the sequence worker that reads the verified one use one rule.

`openModelLoader(deps)` computes the lock hash and cleans up before it returns the loader:

1. Every cache whose name starts with `noisy-models-` other than the current lock's two is deleted.
2. In the partial cache, an entry that is not a segment, or whose file the lock does not name, is deleted.
3. For each file of the lock whose Web Lock (below) no other tab holds, no download owns its segments, so they are what a page that closed or reloaded mid-download left behind: a verified file's segments are deleted, and an unverified file keeps the segments that run from byte 0 without a gap and loses every other one.

So a later page's fetch, or a retry in the same page, resumes a download from the bytes already kept, with `Range: bytes=N-`, and the SHA-256 check at the end guards every kept byte as it guards the new ones; another tab's running download keeps all its segments.
Deleting embeddings whose encoder `ModelId` is not in the lock belongs to the embeddings cache, which is not built yet.

#### A fetch

`fetchModels(ops, signal, onProgress)` takes the files `ops` need, each once, in the order of `ops` and then of the lock, and makes them verified one at a time.
For each file it holds the exclusive Web Lock `noisy-models-<lock hash>:<served>` (`webLocks(navigator.locks)`), so a second fetch of the same file, in this page or another tab, waits and then finds it verified.
The wait counts toward the stall timeout: when the lock is not granted within it, as when the browser froze the holding tab mid-download, the fetch fails as `download` with `stalled` and requests nothing, even when the holder is still receiving bytes.
The loader opens both caches by name at the start of each fetch, so a fetch after a page of another lock deleted them stores its files where a later open by name finds them.
Holding the lock, it makes the file verified:

1. A file in the verified cache is not requested.
2. Otherwise the kept segments give the bytes already held, `N`, and while `N` is below the lock's `bytes` the loader sends `GET <origin><served>` with `cache: 'no-store'`, `mode: 'same-origin'`, `credentials: 'same-origin'`, `redirect: 'error'`, and `Range: bytes=N-` when `N` is above 0.
3. A `206` whose `Content-Range` starts at `N` and gives the lock's length continues the file; a `206` for any other range deletes the segments and fails as `integrity`.
   A `200` to a `Range` request deletes the segments and reads the file from its first byte.
   Any other status fails as `download` with that status, and a `416` also deletes the segments.
4. The body is read as it arrives; each time `SEGMENT_BYTES` (4 MiB) have been read, and when the transfer fails as `offline`, `stalled`, or `cancelled`, the bytes read since the last segment are stored as one segment.
   Bytes the browser received but the page had not read when the connection failed are lost, and a page that closes mid-download loses what it read since its last segment.
   A body longer than the lock's `bytes` deletes the segments and fails as `integrity`.
   However the transfer ends, a failure or an exception included, the request is then aborted, so no connection is left open with its body unread.
5. After the last byte the segments are read back into one buffer of the file's length, hashed with WebCrypto's SHA-256, and deleted.
   A digest other than the lock's, a missing segment, or one of the wrong length fails as `integrity`; a match is put in the verified cache from the buffer.

`onProgress(model, fraction)` reports, after each chunk, the fraction of the bytes `ops` need of that model that are verified or held.
WebCrypto has no incremental digest, so the whole file is in memory while it is hashed: 52,573,088 bytes for the lock's largest file, the encoder's external data.
The segments are deleted before the verified entry is put, so Cache Storage never holds a file twice; a page that closes between the two loses the file and fetches it again.

`fetchModels` resolves with a `Result` at the first failure and never rejects for one; it returns `AnalysisError` (`analysis/protocol.ts`):

| Error | When |
| --- | --- |
| `download` with the HTTP status | the server answered a status other than `200`, or than `206` to a `Range` request |
| `download` with `offline` | the request got no answer, as with no connection, the answer was a redirect, which the loader refuses, the body failed partway, as a connection cut before the declared length does, or the body ended short of the file |
| `download` with `stalled` | the file's Web Lock was not granted within the stall timeout, or no byte arrived for it, counted from the request and restarted by every chunk; the request is aborted |
| `integrity` with the `ModelId` | the bytes do not hash to the lock's SHA-256, the body is longer than the file, a `206` is for another range, or a kept segment cannot be read back whole |
| `quota` | a Cache Storage call rejected, as a `put` that does not fit does |
| `cancelled` | `signal` fired, before the fetch or during it |

A download that fails as `offline`, `stalled`, or `cancelled` stores what it read first, so a retry in the same page resumes with `Range`; if that store is refused, the earlier segments stay and the error is still the download's own.
A `quota` failure while promoting leaves nothing of the file, so a retry after space is freed downloads it again.
The stall timeout is `deps.stallMs`, by default `FETCH_STALL_MS`, 30000 ms.

`clearModelCaches(caches)` deletes every cache whose name starts with `noisy-models-`, of any lock, and returns their names; the phone checklist's "Clear model cache" calls it.
A download running in another page meanwhile writes into caches that are gone: its fetch can return ok with the file in no cache a later open finds, and its next fetch downloads the file again.

Every browser object the loader uses arrives in `deps` as a narrow interface: `caches` (`ModelCaches`, which the browser's `caches` satisfies), `fetch`, `subtle`, `locks` (`FileLocks`), a `Clock`'s timers, and `origin`, the page's origin, which every URL is built on.

## The worker protocol

`src/analysis/protocol.ts` declares the messages the page and the two analysis workers exchange, the types those messages carry, and one parser per direction.
The sequence worker and the decode worker each speak their half (see "The sequence worker" and "The decode worker"); the analysis service (see "The analysis service") and the sequence worker page send the sequence worker requests and parse its replies, and the service sends the decode worker its requests and parses its replies.
A worker is a boundary, so each parser is written for the side that receives its direction, on the page or in a worker.

| Message | Sent by | Received by | Parsed with |
| --- | --- | --- | --- |
| `SequenceRequest` | the page | the sequence worker | `parseSequenceRequest` |
| `SequenceReply` | the sequence worker | the page | `parseSequenceReply` |
| `DecodeRequest` | the page | the decode worker | `parseDecodeRequest` |
| `DecodeReply` | the decode worker | the page | `parseDecodeReply` |

Each message is discriminated by `type`:

| Message | `type` | Fields |
| --- | --- | --- |
| `SequenceRequest` | `init` | `ortBase`, a non-empty string; `threads`, a whole number of at least 1 or `'default'` |
| | `run` | `stage` `depth` or `encode`, and `image`, an open `ImageBitmap`; or `stage` `inpaint`, `image`, and `hole`, a `Plane<'u8'>` |
| | `end` | none |
| `SequenceReply` | `phase` | `stage`, a `HeavyStage['kind']` (`depth`, `encode`, or `inpaint`); `phase`, `session` or `infer`; `fraction`, 0 to 1, or null |
| | `depth` | `map`, a `Plane<'f32'>`; `stats`, the document's `DepthStats`; `timings` |
| | `embeddings` | `embeddings`, a `SamEmbeddings`; `timings` |
| | `plate` | `image`, an `Rgb8`; `timings` |
| | `failed` | `stage`, a `HeavyStage['kind']`; `message`, a string |
| `DecodeRequest` | `init` | `ortBase`; `embeddings`; `guide`, an `Rgb8` |
| | `decode` | `jobId`, a whole number of at least 0; `points`, a `NonEmpty<TapPoint>` |
| `DecodeReply` | `decoded` | `jobId`; `result`, a `DecodeResult`; `timings` |
| | `failed` | `jobId`; `message` |

`HeavyStage` is `{ kind: 'depth' }`, `{ kind: 'encode' }`, or `{ kind: 'inpaint', hole: Plane<'u8'> }`; no message carries a whole `HeavyStage`, only its `kind`.
`stats` and each tap point are parsed with `core/schema.ts`'s `depthStatsSchema` and `tapPointSchema`, so they hold the bounds the scene document gives them (see "The ranges table").

What each carried value must be:

| Value | The parser checks |
| --- | --- |
| `Plane<'u8'>`, `Plane<'f32'>` | `format` is that literal; `size` has whole sides of at least 1; `data` is a `Uint8Array` or a `Float32Array` over an `ArrayBuffer`, not a `SharedArrayBuffer`, of exactly width x height elements; every element of an f32 plane is finite, and the first that is not is reported at `data[i]` |
| `Rgb8` | `size` as above; `data` is a `Uint8Array` over an `ArrayBuffer` of exactly width x height x 3 bytes |
| `ImageBitmap` | its tag is `[object ImageBitmap]`, and its width and height are whole and at least 1, which a closed bitmap's are not |
| `StageTimings` | `sessionMs` and `inferMs` are numbers of at least 0; `wasmHighWaterBytes` is a whole number of at least 0 |
| `SamTensor` | `name` is non-empty; each of `dims` is whole and at least 1; `data` is a `Float32Array` over an `ArrayBuffer` whose length is the product of `dims`, every element finite |
| `SamEmbeddings` | `model` is a `ModelId`; `tensors` holds exactly three, no name twice |
| `Candidate` | `mask` is a `Plane<'u8'>`; `score` is a number |
| `DecodeResult` | `candidates` holds exactly three, no score above the one before it, and every mask the size of the first |

zod 4's `z.number()` refuses `NaN` and both infinities, so every number field of every message is finite.
A parser reads the value it is given with zod, without copying it first.
On the receiving side that value is what `postMessage` delivered, a structured clone: plain objects and arrays with own data properties, primitives, typed arrays, bitmaps, and the other built-ins a clone carries, with no getter, no prototype of the sender's, and no proxy.
For such a value a valid message parses, and a malformed one fails with at least one path at or above the defect and a reason true of the value at that path, without throwing, hanging, or costing time or memory beyond proportion to the message's own size.
A value of the caller's own realm, as the node tests build them, is read the way zod reads it: an inherited field or a getter counts as present, and a proxy answers whatever its traps answer.
For such a value the parsers promise only a parse that never throws.

Every object is strict: an unknown `type` fails at `type`, an unknown key fails at its own path, and a missing field fails at its path.
A whole message that is a primitive, `null`, or an array fails at `(message)`, and one that is another object without a known `type` fails at `type`.
So a `depth` or `encode` run that carries a `hole` fails at `hole` as an unknown key, and an `inpaint` run without one fails at `hole` as missing.
zod reads nothing under an unknown key, so a field the protocol does not have fails as an unknown key whatever it holds, a structure that shares its parts many levels deep included.
An object lists at most eight unknown keys at their own paths and counts the rest in one failure at its own path, such as `timings: 92 more unknown keys`.
Every object a message carries takes only a plain object, one whose `Object.prototype.toString` tag is `Object`, as every object of a structured clone is that is not an array or a built-in.
Anything else where such an object belongs fails at that object's path with one reason, such as `timings: expected an object, got a number` or `image.size: expected an object, got a Uint8Array`, before zod reads it.
zod's object schemas go through a value's enumerable keys with for-in, and a typed array's or a `String` object's are its indices, so without that check a typed array of a photo's bytes where an object belongs would make one unknown-keys issue listing every element's index, many times the array's own size.
A typed array or a bitmap as the whole message fails at `(message)` with a reason that names it, such as `expected an object with a type, got a Uint8Array`.
A value that holds one of its own ancestors at a known key fails at that key or under it, since the ancestor lacks the fields the key needs.

The four array fields, `candidates`, `tensors`, `points`, and a tensor's `dims`, each take only a dense array: one whose own string keys are exactly its indices, 0 to length - 1.
A structured clone keeps a hole, the length around it, and an own key that is not an index, and zod's array schemas read every index up to the length and no other key.
So a hole, an own key that is not an index, or a typed array in an array's place fails at the field's path with one reason, before anything reads an element, and an array of a few bytes that claims 2^32 - 1 elements fails at once.
`points` and `dims` have no bound on their length, so each reports only its first element that fails: zod reports an issue for every element that fails, and under node a list of 200,000 issues overflows the call stack as zod copies it into the enclosing object's.
Each of their elements is parsed in one pass that stops at the first that fails.
An object that `points` holds more than once is parsed once, and its one output stands at each of its places in the parsed message: a structured clone writes each repeat of an object as a reference of a few bytes, so a new output for each would cost many times the message's size.
An empty `points` fails at `points`.

A typed array's kind is read with `%TypedArray%.prototype[Symbol.toStringTag]`'s getter, which reads the array's internal name and answers `undefined` for any other value.
So a typed array made in another realm passes, and an object built on `Float32Array.prototype`, one with a `Symbol.toStringTag` of its own, or a proxy around a typed array fails; `test/protocol.test.ts` checks each.
Its length is read the same way, with `%TypedArray%.prototype`'s `length` getter, so a `length` of the array's own or a subclass's `length` getter does not change it; a structured clone carries neither, so this matters only for a value of the caller's own realm.
A typed array over a `SharedArrayBuffer` fails, because the sender still holds that memory after `postMessage` and could change a length or an element the parse has checked; `ArrayBuffer.prototype`'s `byteLength` getter, called on the array's buffer, throws on a shared buffer, and that is the test.
An `ImageBitmap` is recognized by its tag, through `Object.prototype.toString`, rather than by the `ImageBitmap` global, which node lacks, so the node tests run the same parser with an object of their own that declares the tag.
A structured clone keeps no prototype and no symbol-keyed property, so after `postMessage` only a real `ImageBitmap` carries the tag; the test checks that a clone of its stand-in, and a clone of an object with the tag as its own symbol-keyed property, each fail.

Every parser takes `unknown` and returns `Result<Message, MessageError>`.
`MessageError` holds `paths`, the path of each issue (`result.candidates[1].mask.data`, an unknown key at its own path, `(message)` for the root), and `detail`, one line of `<path>: <reason>` entries joined by `; `.
A line break is a line feed, vertical tab, form feed, carriage return, next line (U+0085), line separator (U+2028), or paragraph separator (U+2029).
A key's line break is written as an escape, such as `\n` or `\u2028`, in its path and in a reason that names the key, and each other run of line breaks in a reason, such as a thrown error's message, is made one space.
A parse names at least one failure, not every one: an f32 array reports only its first element that is not finite, `points` and `dims` only their first element that fails, an object only its first eight unknown keys and a count of the rest, and a check that compares fields, such as a plane's length against its size or the candidates' order and sizes, runs only when nothing else in the object holding those fields has failed.
A parse never throws: a getter or proxy trap that throws while the value is read fails at `(message)`, with the thrown error in `detail`.
A parsed message is a new object, frozen at every level, but the typed arrays and bitmaps in it are the ones received, not copies, and a tap point `points` repeats is one object at each of its places.
A parse that fails can leave parts of the received value frozen: where a frozen object or array belongs and zod builds none, as for a whole message whose `type` matches no message or a `run` whose `stage` matches none, zod freezes the value it was given.
The message types are inferred from the parsers' zod schemas, and `test/protocol.test.ts` checks at the type level that each equals the shape written out by hand there.

## The analysis stages' math

### The depth input size

`src/analysis/depth-size.ts` exports `DEPTH_PATCH` (14), `DEPTH_SHORT_SIDE` (518), `DEPTH_MAX_TOKENS` (1813, 37 x 49 patches), and `depthInputSize(master: Size): Size`, the depth stage's input size and so the depth map's.
The master's short side maps to 518 and the long side follows the aspect, each rounded to the nearest multiple of 14 and at least 14; when that holds more than 1813 patches, both sides are scaled by `sqrt(1813 / patches)` and rounded down to multiples of 14, each at least 14.
So a 2048 x 1536 master gives 686 x 518, 2048 x 512 gives 1190 x 294, and 2048 x 64 gives 3360 x 98.
The module reads no compile-time constant, so the workers, the page, and node tests import it alike.
It is defined for sides that are whole numbers of at least 1, and `test/depth-size.test.ts` shows the bound for every even master from 512 to 2048 px on its long edge and from 64 px on its short edge.

### The stage functions

`src/analysis/stage-math.ts` holds the arithmetic between a bitmap's pixels and the heavy stages' products: what goes into each model and what its outputs become.
Reading a bitmap's pixels through a canvas and running the sessions are the sequence worker's (see "The sequence worker"); nothing here touches a bitmap, ONNX Runtime, or a worker.
The module reads no DOM global and no clock, so a worker can import it.

A model's outputs arrive as a `TensorMap`, `{ readonly [name: string]: { dims: readonly number[]; data: unknown } }`, which ONNX Runtime's `InferenceSession.ReturnType` satisfies, so the worker can pass the map `run` returns as it is.
An output is looked up as an own property of the map by its name, and its dims are compared with the expected dims, then its data's kind, then its length with the dims' product, before anything is allocated.
Every function returns a `Result` whose error is one line naming the value and what was wrong, such as `predicted_depth: expected dims [1, 518, 686], got [1, 686, 518]`, and none throws.
Pixels are `RgbaBytes`, a `Uint8ClampedArray` or `Uint8Array` of interleaved R, G, B, A, as a canvas's `ImageData` holds them; a size must have whole sides of at least 1 and the bytes must number width x height x 4.

| Function | Takes | Returns | Refuses |
| --- | --- | --- | --- |
| `imagenetInput(rgba, size)` | pixels | `pixel_values` for the depth model and the SAM encoder: planar float32, R then G then B, each `(byte / 255 - mean) / std` with `IMAGENET_MEAN` [0.485, 0.456, 0.406] and `IMAGENET_STD` [0.229, 0.224, 0.225], computed in doubles and held as float32; alpha dropped; dims [1, 3, height, width] | a size that is not one, or bytes of another length |
| `depthProduct(outputs, inputSize)` | the depth model's outputs and `depthInputSize(master)` | `{ map: Plane<'f32'>, stats: DepthStats }` | no `predicted_depth`, dims other than [1, height, width], data that is not a `Float32Array`, a length other than the dims', or an element that is NaN or an infinity |
| `samEmbeddings(outputs, model)` | the SAM encoder's outputs and its `ModelId` | `SamEmbeddings` | an output of `SAM_EMBEDDING_TENSORS` missing, of other dims, not a `Float32Array`, of another length, or with an element that is not finite |
| `miganInput(rgba, size, hole)` | pixels and a hole of the same size | `{ image, mask }`, MI-GAN's two inputs | pixels as above, a hole whose size differs, or whose data is not width x height bytes |
| `plateFromResult(outputs, size)` | MI-GAN's outputs and the master's size | the plate as `Rgb8` | no `result`, dims other than [1, 3, height, width], data that is not a `Uint8Array`, or another length |

The depth map is min-max normalized, `(value - min) / (max - min)` in doubles, so its nearest point is 1 and its farthest 0, as the document's depth map is.
A flat output, max equal to min, has no nearer or farther point and becomes all zeros, with statistics of 0.
`stats` are `p10`, `median`, and `p90` by `core/percentile.ts` over the normalized map.

`SAM_EMBEDDING_TENSORS` is the one table of the encoder's outputs, in the order a `SamEmbeddings` holds them: `image_embeddings.0` [1, 32, 256, 256], `image_embeddings.1` [1, 64, 128, 128], and `image_embeddings.2` [1, 256, 64, 64]; the decoder takes the same names and dims.
Outputs of other names are ignored.
Each tensor's data is the output's own array when that array spans the whole of an `ArrayBuffer` that is not shared, as each output of ONNX Runtime 1.30.0 does (checked on the real encoder under ONNX Runtime's node build), so the worker can transfer it without a second copy at the encoder's memory peak; any other array is copied into one that does.
`SAM_INPUT_SIZE` is 1024 x 1024: the master is stretched to it, its aspect not kept.
The decoder's functions are below (see "The decoder's functions").

MI-GAN's `image` is the pixels as planar uint8, R then G then B, alpha dropped, dims [1, 3, height, width].
Its `mask`, dims [1, 1, height, width], has the opposite polarity to the repository's: `holeMask` writes 255 in the hole and MI-GAN takes 255 to keep and 0 in the hole, so each byte is inverted.
A hole byte of `MIGAN_HOLE_THRESHOLD`, 128, or more is in the hole, so a soft hole is cut at 0.5 as a mask is read everywhere else.
`plateFromResult` interleaves MI-GAN's planar `result` into R, G, B per pixel.
Every array a function returns is new, except an embedding tensor's data, which `samEmbeddings` passes on uncopied when it spans a whole unshared buffer, as above; the inputs are only read.

The names of the models' inputs and outputs are exported beside the functions: `PIXEL_VALUES` (`pixel_values`), `DEPTH_OUTPUT` (`predicted_depth`), and `MIGAN_OUTPUT` (`result`); MI-GAN's inputs are named as `MiganInput`'s fields, `image` and `mask`.

### The decoder's functions

`stage-math.ts` also holds what goes into SAM's decoder and what its outputs become, for the decode worker (see "The decode worker"), under the same rules: each returns a `Result` whose error is one line, and none throws, with one exception: `decodeCandidates` makes its three masks at the size it is given, which nothing bounds but the caller, so a size too large to allocate throws a `RangeError`; the decode worker's size is the parsed guide's, whose data is that size already, and a throw there is answered `failed`.

| Function | Takes | Returns | Refuses |
| --- | --- | --- | --- |
| `decoderPrompt(points)` | a `NonEmpty<TapPoint>`, each point in frame fractions of the master | `DecoderPrompt`, the decoder's three prompt inputs: `input_points` float32 [1, 1, n, 2], each point's x then y times 1024; `input_labels` int64 [1, 1, n], 1 for `include` and 0 for `exclude`; `input_boxes` float32 [1, 0, 4], no box | a coordinate outside 0 to 1 or not finite |
| `decoderEmbeddings(embeddings, model)` | `SamEmbeddings` and the decoder's `ModelId` | the embeddings' tensors | embeddings made by another model, or whose tensors are not `SAM_EMBEDDING_TENSORS`'s names and dims in its order, or of another length |
| `decodeCandidates(outputs, size)` | the decoder's outputs and the guide's size | a `DecodeResult`: three candidates, each a `Plane<'u8'>` mask at `size` and its score | a size that is not one; no `iou_scores` or `pred_masks`; dims other than [1, 1, 3] and [1, 1, 3, 256, 256]; data that is not a `Float32Array`; a length other than the dims'; an element that is NaN or an infinity |

The coordinates are times 1024 on each axis because the encoder saw the master stretched to `SAM_INPUT_SIZE`.
`pred_masks` holds each candidate's logits, 256 x 256 (`SAM_MASK_SIZE`) over the whole stretched input, so resampling them to the guide's size, which keeps the master's aspect, undoes the stretch.
The resample is bilinear with texel centers aligned: output texel `o` of `n` reads source position `(o + 0.5) x 256 / n - 0.5`, clamped to the first and last source texel, so on a guide 1024 x 768 a step between the logits' columns 127 and 128 lands between the guide's columns 511 and 512, and one between rows 127 and 128 between rows 383 and 384.
Each resampled logit becomes the byte `round(255 x sigmoid(logit))`, with one exception: a logit below 0 that the formula would round to 128, because the sigmoid of a logit that close to 0 is 0.5 in doubles, reads 127.
So a byte is 128 or more exactly when its logit is 0 or more, and a mask is read at 128 as every other mask is; the bench that judged the model counted a logit in the mask when it was above 0, so the two differ only at a logit of exactly 0.
A logit of 6.3 or more reads 255 and one of -6.3 or less reads 0 without computing the sigmoid, which gives the same bytes as the formula, since 255 x sigmoid(6.3) is 254.53 and the formula is symmetric about 127.5; `test/stage-math.test.ts` compares every byte with the formula over 196,608 logits from -10 to 10.
The three candidates are ordered by `iou_scores`, highest first, a tie keeping the decoder's order, as the protocol's parser requires; a candidate with no byte of 128 or more, an empty one, is kept, and what to do with one is its caller's.
Refining a mask against the master is not done here.
The names are exported: `DECODER_POINTS`, `DECODER_LABELS`, `DECODER_BOXES`, `DECODER_SCORES` (`iou_scores`), `DECODER_MASKS` (`pred_masks`), and `SAM_CANDIDATES` (3).

## The known-answer checks

`src/analysis/checks.ts` tells whether a stage's product on a scene with known truth is right, so a harness on any device can judge a model's output on the synth scene without comparing it bit for bit with another device's.
Each check takes the product and truth planes, never a scene's geometry, so the module imports only `core/` and serves any fixture; the synth fixtures supply the truth planes (see "The synth fixtures").
A region is a `Plane<'u8'>`, and a byte of `REGION_THRESHOLD`, 128, or more is inside it.
The module reads no DOM global and no clock, so a page, a worker, or a node test can call it alike.

The rules and thresholds are those of the bench that judged the models before this code was written; the bench, like the synth scene's original painter, is recorded only in the gitignored `.claude/work/`.
They differ from the bench in three ways.
A median here is `core/percentile.ts`'s nearest rank, the lower middle value of an even count, where the bench took the upper middle.
The depth check reads the stage's normalized map and the mask check a mask, where the bench read the model's raw output and its logits (see the Depth and Mask notes below).
An empty region, a truth or a hole that covers everything, or a depth texel that is not finite, which the bench's arithmetic turned into a failing verdict, is refused here with an error (see the refusals below).
Where the bench rounded a value to the precision it reported before comparing it with its threshold, the check rounds it the same way before the comparison, so on the same values a verdict is the bench's; the numbers a check returns are unrounded.
`CHECK_THRESHOLDS` holds the thresholds.

| Function | Takes | Numbers | Passes when |
| --- | --- | --- | --- |
| `checkDepth({ depth, near, far })` | a depth map, `Plane<'f32'>`, larger nearer, and its near and far regions at its size | `nearCount`, `farCount`; the map's `min`, `max`, and `range`; `nearMedian` and `farMedian`; `gapShare`, `(nearMedian - farMedian) / range`, or 0 when the range is 0 | `range` > 1e-4 and `nearMedian - farMedian` > 0.1 x `range`, compared unrounded |
| `checkMask({ mask, truth })` | a mask and the region it should cover, both regions of one size | `maskCount`, `truthCount`, `intersection`, `union`, `backgroundCount` (texels outside the truth), `falsePositiveCount`; `iou`, intersection over union; `backgroundFalsePositive`, false positives over the background | `iou` at 4 decimals >= 0.85 and `backgroundFalsePositive` at 5 decimals <= 0.02 |
| `checkInpaint({ original, plate, hole, ring })` | the `Rgb8` image the stage was given and the plate it returned, the hole it filled, and a ring of the original's surroundings, all of one size | `outsideCount`, `holeCount`, `ringCount`; `outsideMeanDifference` and `outsideChangedShare`; the plate's `holeMean`, the original's `ringMean` and `originalHoleMean`; `holeToRing`, `originalToRing`, and `holeChange`, the Euclidean RGB distances between them; `redShare` | `outsideMeanDifference` at 4 decimals <= 1.0, `outsideChangedShare` at 6 decimals <= 0.001, `holeToRing` at 1 decimal <= 0.25 x `originalToRing` at 1 decimal and <= 40, and `redShare` at 4 decimals <= 0.05 |

- **Depth.** A texel in both regions counts as near only, as the bench's `else if` counted it.
  The depth stage's map is min-max normalized, so its range is 1, or 0 for a flat output; the bench applied the same rule to the model's raw output.
  Normalizing leaves the gap over the range unchanged but for rounding, so the verdicts differ only for a raw output whose range is above 0 and at most 1e-4, which the bench failed and whose normalized map can pass, and for a gap within rounding of the threshold.
- **Mask.** The check takes a mask, read at 128 like the truth, not the model's logits, which the bench counted in the mask when above 0.
- **Inpaint.** Outside the hole, a pixel's difference is the largest of its three channels' absolute differences between original and plate, and it has changed when that is more than 16.
  The ring's mean is the original's over the ring's pixels outside the hole; a ring pixel inside the hole is ignored.
  A pixel of the hole is red when the plate's R is more than its G and more than its B each by more than 60.

Each check returns a `Result` and never throws: its error is one line naming the plane and what was wrong.
It refuses a plane whose sides are not whole numbers of at least 1 or whose data is not width x height elements (x 3 for an `Rgb8`), planes of different sizes, such as `near: expected the depth's size 686 x 518, got 685 x 518`, an empty near, far, truth, hole, or ring region, a truth or a hole that covers everything, and a depth texel that is NaN or an infinity.
Sizes are checked before anything is allocated, and each check makes at most two passes over its planes, so its cost is in proportion to them; a median also sorts its region's values.

The sequence worker page runs `checkDepth` and `checkInpaint` on the products as they arrive (see "The sequence worker page"), and the decoder page runs `checkMask` on each candidate a decode returns (see "The decoder page").

## The sequence worker

### The ONNX Runtime module

`src/analysis/ort-runtime.ts` holds the ONNX Runtime plumbing for the analysis workers.
It makes no worker-global call and reads no compile-time constant, so the app project and the worker project both check it; the sequence worker and the decode worker are its callers.
Each function returns a `Result` for a failure it expects, its error one line:

| Export | What it does |
| --- | --- |
| `loadOrt({ ortBase, threads })` | installs the high-water wrapper (below), then imports `noisy:vendor-ort`, sets `env.wasm.wasmPaths` to `ortBase`, and sets `env.wasm.numThreads` when `threads` is a number; `'default'` leaves ORT's default (see "Vendored model runtime"); resolves with `{ ort, wasmHighWaterBytes }`, or with `ONNX Runtime did not load: ` and the import's own error |
| `modelStore({ lock, subtle, caches, origin })` | the lock's verified cache, `modelCacheNames(<lock hash>).verified`, and the origin its keys are built on; it opens no cache, so it creates none |
| `createSession(runtime, store, files)` | reads each file of one operation's session, `ParsedLock.ops[op]`, with `caches.match(modelFileUrl(file, origin), { cacheName })`, then calls `InferenceSession.create` on the graph file's bytes with `executionProviders: ['wasm']`, `graphOptimizationLevel: 'all'`, and each external-data file's bytes under its `externalDataPath`; resolves with `{ session, sessionMs }` |
| `runSession(session, feeds)` | runs the session; resolves with `{ outputs, inferMs }`, or with `the run threw ` and the error |
| `releaseSession(session)` | releases the session; resolves with the error when the release throws |
| `describeThrown(thrown)` | a thrown value as one line: an `Error`'s name and message, anything else as text |

`createSession` does not hash a file again, since the loader verified it before putting it in the verified cache.
A file the cache does not hold, as after the browser evicted it, fails with `the verified model cache <name> holds no <served path>; fetch the models again`, and a creation that throws fails with `the <session> session could not be created: ` and the error.
The files' bytes are held in the function's own variables and the session options, so nothing refers to them once it returns.
`sessionMs` runs from the first file read to the session's creation, and `inferMs` is the `run` call alone.

The high-water wrapper replaces the scope's `WebAssembly.Memory` with a subclass that records every memory created after it, so it is installed before the runtime is imported.
`wasmHighWaterBytes()` is the largest `buffer.byteLength` among those memories, in whole bytes, or null before the runtime has created one; ORT 1.30.0's glue creates its heap with `new WebAssembly.Memory` when the first session is created.
A wasm memory never shrinks, so in a worker that runs several sessions the reading is the heap's running maximum so far, not the last session's own peak: a stage that follows a larger one reports the larger one's reading.
The reading is not a fixed property of a stage.
At 2 threads in Chrome 154 on the Mac, the SAM encoder in a worker of its own reads 794 MB and the encoder after the depth stage in one worker 722 MB; at ORT's default thread count, 4 there, the encoder's reading after depth varies from run to run, between about 720 and 820 MB in the runs measured.
MI-GAN's reading depends on the hole it fills.
`sequence.scenario.ts` asserts each case's band and records the default thread count's readings.

### The worker

`src/analysis/sequence-worker.ts` runs the heavy stages a page asks for, one after another, in one wasm heap.
Its message handler parses every message with `parseSequenceRequest` and queues it, and the worker handles one request at a time, in arrival order: a `run` posted while another runs waits, and so does an `end`.

| Request | What the worker does | What it answers |
| --- | --- | --- |
| `init` | the first one parses the build's lock with `bundledLock()`, names the model store from it, and loads the runtime with the request's `ortBase` and `threads`; a later one changes nothing | nothing; a failure is held and answered to each later `run` |
| `run` | runs the stage on the bitmap (below) | `phase` `session` and `phase` `infer`, each with `fraction` null, then the product; or one `failed` in place of the rest |
| `end` | answers each `run` queued behind it with `failed` and closes its bitmap, then calls `self.close()` | nothing |
| a message that does not parse | closes the bitmap the message carries at `image`, if it carries one, and throws `Error('the sequence worker cannot read a request: <detail>')` from the handler, `<detail>` the parser's | an `error` event at the page's `Worker`, since nothing in the worker cancels it |
| a message that cannot be deserialized | throws `Error('the sequence worker received a request it could not deserialize')` from its `messageerror` handler | an `error` event, likewise (INFERRED: no scenario makes a worker fire `messageerror`) |

Each `run` the worker receives before it closes is answered with exactly one product or one `failed`.
A run draws its bitmap on an `OffscreenCanvas` 2D context created with `willReadFrequently`, with smoothing on at `high` quality, closes the bitmap once drawn, reads the pixels back with `getImageData`, and shrinks the canvas to 1 x 1; only the model's input, built from those pixels by the stage functions, outlives the draw.
It then posts the `session` phase, creates the stage's session, posts the `infer` phase, runs it, makes the product from its outputs, and releases the session whatever happened, before the product is posted, so one session at most is alive and none is alive between requests.
The reply's arrays are transferred, not copied.

| Stage | Drawn at | Session | Inputs | Reply |
| --- | --- | --- | --- | --- |
| `depth` | `depthInputSize` of the bitmap's size | `ops.depth` | `imagenetInput` as `pixel_values` | `depth`: `depthProduct`'s map, at the size drawn, and statistics |
| `encode` | `SAM_INPUT_SIZE`, 1024 x 1024, stretched | `ops.encode` | `imagenetInput` as `pixel_values` | `embeddings`: `samEmbeddings` with `ops.encode.model` |
| `inpaint` | the bitmap's own size | `ops.inpaint` | `miganInput`'s `image` and `mask` | `plate`: `plateFromResult` at the bitmap's size |

`timings` are the run's own: `sessionMs` and `inferMs` as `createSession` and `runSession` measure them, and `wasmHighWaterBytes` read after the session is released.

Every failure is one `failed` reply, its `message` one line:

| Failure | When | `message` |
| --- | --- | --- |
| no `init` came first | before anything is drawn | `no init request came before this run` |
| `init` failed: the lock does not parse, or the runtime's import fails, as with `/vendor/ort/` answering 500 | before anything is drawn | `the worker did not start: ` and why, such as `ONNX Runtime did not load: TypeError: Failed to fetch dynamically imported module: <the entry's URL>` |
| an `inpaint` hole of another size than its bitmap | before anything is drawn | `hole: expected the image's size <w> x <h>, got <w> x <h>` |
| a file of the session missing from the verified cache | after the `session` phase | `the verified model cache <name> holds no <served path>; fetch the models again` |
| the session's creation throws, as when the runtime's wasm does not load, which ORT loads with the first session and then refuses every later one for | after the `session` phase | `the <session> session could not be created: ` and the error |
| the run throws | after the `infer` phase | `the run threw ` and the error |
| a stage function refuses the outputs, a non-finite element among them | after the `infer` phase | the function's reason (see "The stage functions") |
| the release throws | after the `infer` phase, in place of the product | `the session's release threw ` and the error |
| anything else that throws during the run | wherever it throws | the thrown value as one line |

The worker posts nothing for `end`, so a page sees the close only as the absence of replies; the sequence worker page checks it with a `run` posted after every answer, which goes unanswered, and then calls `terminate()` (see "The sequence worker page").

## The decode worker

`src/analysis/decode-worker.ts` is the resident SAM decoder for one scene: `init` loads it once with the scene's embeddings and guide, and each `decode` after it runs on its tap points.
Like the sequence worker, its message handler parses every message with `parseDecodeRequest` and queues it, and the worker handles one request at a time, in arrival order, so a decode posted before `init` has been handled waits for it.
The protocol has no `end` for this worker; the page terminates it, and the session goes with the worker.

| Request | What the worker does | What it answers |
| --- | --- | --- |
| `init` | the first one parses the build's lock with `bundledLock()`, checks the embeddings with `decoderEmbeddings` against `ops.decode.model`, names the model store, loads the runtime with the request's `ortBase` and ORT's default thread count, creates the session of `ops.decode` with `createSession`, and keeps the embeddings as the session's input tensors, by name, and the guide's size; a later one changes nothing | nothing; a failure is held and answered to each later `decode` |
| `decode` | runs the session on the embeddings and `decoderPrompt(points)`, and makes the candidates with `decodeCandidates` at the guide's size (see "The decoder's functions") | one `decoded`, its masks' buffers transferred, or one `failed` |
| a message that does not parse | throws `Error('the decode worker cannot read a request: <detail>')` from the handler, `<detail>` the parser's | an `error` event at the page's `Worker`, since nothing in the worker cancels it |
| a message that cannot be deserialized | throws `Error('the decode worker received a request it could not deserialize')` from its `messageerror` handler | an `error` event, likewise (INFERRED: no scenario makes a worker fire `messageerror`) |

The embeddings are checked before the runtime is loaded, so embeddings of another model or with other tensors fail `init` without loading anything.
The guide's pixels are not kept, only its size: every candidate mask is made at it, whatever it is; the guide is the master at long edge 1024 because its caller makes it so.
`timings` are the decode's own: `inferMs` the session's run, as `runSession` measures it, and `wasmHighWaterBytes` read after the candidates are made.
`sessionMs` is the session's creation time, as `createSession` measures it, on the first `decoded` reply after `init` and 0 on every later one, so a sum over a decoder's replies counts it once.
`init` carries no thread count, so the decoder runs at ORT's default, `min(4, ceil(hardwareConcurrency / 2))` when cross-origin isolated and one thread otherwise (see "Vendored model runtime").

Each `decode` the worker receives is answered with exactly one `decoded` or one `failed`, its `message` one line:

| Failure | `message` |
| --- | --- |
| no `init` came first | `no init request came before this decode` |
| `init` failed: the lock does not parse; the embeddings are another model's, as `embeddings: made by <model>, not by the decoder's model <model>`, or hold other tensors, as `embeddings.tensors[<i>]: expected <name> with dims <dims>, got <name> with dims <dims>`; the runtime's import fails; a file of the session is missing from the verified cache; or the session's creation throws | `the decoder did not start: ` and why, in the words of "The sequence worker"'s failures for the last three |
| a point outside the frame, which the parser already refuses | `points[<i>].at: expected x and y from 0 to 1, got <x>, <y>` |
| the run throws | `the run threw ` and the error |
| `decodeCandidates` refuses the outputs | its reason |
| anything else that throws during the decode | the thrown value as one line |

In Chrome 154 on this Mac, cross-origin isolated with 8 logical cores, so at ORT's default of 4 threads, the decode worker runs three `em-pthread` workers; in seven runs of `decoder.sphere-box` on the synth scene's embeddings, every decode read a high-water mark of 76,808,192 bytes, the first decode's `inferMs` was 85 to 101 ms and the second's 46 to 77 ms, and `sessionMs` was 201 to 277 ms.
That mark is not fixed at this thread count: a probe page, not kept in the tree, that decoded the synth scene nine times with one or two points each read 92,209,152 bytes from its seventh decode on in one of three runs, and 76,808,192 bytes throughout the other two.
The same probe with the decode worker's `threads` set to 2 read 75,890,688 bytes on every decode of its one run.

## The analysis service

`src/analysis/service.ts` is the page's one owner of the two analysis workers.
`createAnalysisService(deps)` returns an `AnalysisService`, which runs an ordered list of heavy stages in one sequence worker, hands each product to its caller as it lands, terminates the worker on every path out of a sequence, and records the termination a cooldown is counted from; opens the resident decode worker and hands back the `Decoder` that decodes on it (see "The decoder"); fetches models through the model loader; and logs the analysis part of the diagnostic vocabulary.
The session driver owns stage policy, watchdogs, cooldowns, and decoder warm-up.
`src/main.tsx` installs the service factory from `src/app/analysis.ts` before creating the session.
The dev service, decoder, and memory harness pages continue to construct the local service directly.

### Remote analysis and automatic fallback

`src/analysis/remote.ts` adapts session/depth/plate requests from [the GPU contract](../plan/gpu-contract.md).
The hybrid composition uses GPU depth and background plates when healthy; MI-GAN is the default remote inpaint model, with LaMa behind the server flag.
The SAM Tiny encoder, all taps and refinement, and the face tracker run on the device.
The app does not call the remote tap endpoint, including during warmup.
The master is uploaded as JPEG at quality 92.
The adapter validates dimensions, plane lengths and finite normalized depth, and decodes the RGB plate before publishing it.
Depth statistics use the same nearest-rank implementation as the local service.
The local encoder produces real embeddings for the resident decoder; no remote embedding token is used.
The callback interface and rehearsal status sentences remain the driver's existing interface.
The Scene Analysis fact shows `GPU · <health name>` when GPU depth succeeded, or `on device` otherwise.
`analysisDiagnostics()` records depth/plate routing, the device encoder/tap routing, and full HTTP session/depth/inpaint timings separately.

`src/analysis/composed.ts` probes health at boot and again per import after a failed probe or remote operation.
A healthy boot fetches the local encode/decode/face models; depth/inpaint models are fetched if fallback needs them.
GPU depth runs first, followed by the local encoder on the same master and the driver's unchanged resident decoder warming.
An initial remote failure before depth is published falls back to device depth/plate and leaves the decoder path local.
The composition displays `Analyzing: depth` while remote requests run, buffering phase callbacks until depth succeeds so remote time and cold fallback downloads never consume the device worker watchdog.
HTTP deadlines are 20 seconds for session creation, 10 for depth, 30 for inpaint and 5 for health; they include body reading and PNG decoding.
Inpaint retries once and invalidates cached health on failure, so the next import re-probes even if the retry succeeds or the driver's watchdog cancels it.
Heavy cancellation preserves an established photo's session through plate failure, timeout, queued warming and decoder retry.
The composition's `releaseImport()` ends that lease on photo replacement; `beginImport()` calls it after the existing policy changes generation, so cancellation callbacks cannot publish stale products.
The session stays available after a successful plate because another subject or refinement can need another plate; same-photo Reset also retains it.
The composition reports local heavy-worker termination to MEM1 so encoder cooldown and queued-background ordering remain unchanged.
Failed boot model preparation is retried on the next import, re-probing health before choosing the required downloads.
With `gpu` empty, no remote request occurs and all model operations use the local service.


### Its dependencies

| Dependency | What it is |
| --- | --- |
| `clock` | a `Clock`'s `now`, for the events' times and the termination record |
| `diag` | a `DiagnosticSink<AnalysisEvent>`, which the page's one `Diagnostics<DiagnosticEvent>` satisfies (see "The composition root") |
| `spawn` | starts a sequence worker and returns a `SequenceWorkerPort`; a page passes `() => new Worker(NOISY_WORKER_URLS.sequence, { type: 'module', name: 'sequence' })` |
| `spawnDecoder` | starts a decode worker and returns a `DecodeWorkerPort`; a page passes `() => new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' })` |
| `ortBase` | sent in each worker's `init`; a page passes `NOISY_ORT_DIR` |
| `threads` | sent in the sequence worker's `init` (see "The worker"); the decode worker's `init` carries none |
| `lock` | the `ParsedLock` the loader was opened with, which names the model of each operation for the fetch events |
| `loader` | the promise `openModelLoader` returns, not awaited by the factory; `fetchModels` awaits it |

`WorkerPort<Request>` is the part of a dedicated worker the service uses: `postMessage(message, transfer)` with a `Request`, `terminate()`, and `addEventListener` for `message`, `error`, and `messageerror`; `SequenceWorkerPort` is `WorkerPort<SequenceRequest>` and `DecodeWorkerPort` is `WorkerPort<DecodeRequest>`, and the browser's `Worker` satisfies both, which the dev pages' type check shows.
The v1 design's factory took the clock and the sink alone; it takes more because a synchronous factory cannot otherwise reach the asynchronous loader or the worker, and because the service reads no compile-time constant and names no `window` global, so `test/analysis-service.test.ts` and `test/analysis-decoder.test.ts` import it under node and drive it with scripted ports.
The lock is a dependency of its own because the loader's promise can resolve to a failure, which names no model, and the fetch events name one.

### A sequence

`runSequence(scene, stages, input, on, signal)` returns nothing; every outcome reaches `on`, a `SequenceListener`.
`scene` is not used yet.

1. A sequence still alive is cancelled first, as `cancelHeavy` cancels it, so the service never holds two sequence workers it has not terminated.
   When the cancelled sequence's `onFailed` starts another sequence, that one stands, and this call ends at once in `onFailed` with the first stage and `cancelled`, without a worker.
   The new worker is spawned right after the old one's `terminate()`, while the browser may still be tearing the old one down (see "Nested workers"); holding the next heavy sequence back after a termination is the caller's, which reads `lastHeavyTermination`.
2. When `signal` has already aborted, `onFailed` gets the first stage and `cancelled` at once, and no worker starts.
3. Otherwise the service spawns the worker, posts `init`, and runs the stages in order.
   For each stage it calls `input.master()`, posts the stage's `run` with that bitmap in the transfer list, and waits for the stage's product before it calls `master()` for the next stage, so the page holds one fresh bitmap at a time.
   An inpaint run's hole is cloned with the message, not transferred, so the caller's plane stays whole.
4. Every reply is parsed with `parseSequenceReply`.
   A `phase` of the running stage goes to `onPhase`.
   The running stage's product, `depth` for depth, `embeddings` for encode, and `plate` for inpaint, goes to `onDepth`, `onEmbeddings`, or `onPlate`, and the service keeps no reference to it or to a bitmap once it has handed it on.
5. When the last product arrives the service posts `end`, calls `terminate()` at once without waiting for the worker to close itself, and records the termination; it then hands the product on and calls `onDone`.

Each sequence ends in exactly one of `onDone` and `onFailed`, after every product of the stages that completed.
The worker is terminated before either is called, and `alive.heavy`, true exactly while a sequence worker is alive, from its spawn to the service's `terminate()`, is already false, so the callback may start the next sequence.
Once a sequence has ended, nothing its worker sends and no later cancel or abort reaches its listener; a bitmap `master()` gives after the end is closed.
A stage is answered when its product arrives, before the listener gets the product, so a listener that cancels or starts a sequence from inside a product callback ends the current one at the next stage, and from inside the last product's callback, when the worker is already terminated, it leaves the sequence to end in `onDone`, which then reads `alive.heavy` true if that callback started a sequence.

### Failures and cancels

| What happens | `onFailed`'s error | Its `message` |
| --- | --- | --- |
| a `failed` reply | `worker` | the reply's message |
| an `error` event | `worker` | `the worker raised an error: ` and the event's message, or `an error event without a message` |
| a `messageerror` event | `worker` | `a reply from the worker could not be deserialized` |
| a reply that does not parse | `worker` | `a reply from the worker did not parse: ` and the parser's detail |
| a reply the running stage cannot give: a phase of another stage, another stage's product, or anything but `failed` while no run is posted | `worker` | the reply and the stage, such as `the worker answered embeddings to the depth run`; while no run is posted, `the worker sent a <type> reply while no run was posted`, the stage only in the error's `op` |
| `master()` rejects or throws | `worker` | `the master bitmap for the <stage> stage could not be made: ` and the error |
| posting a run throws, as a closed bitmap's `DataCloneError` does | `worker` | `the <stage> run could not be posted: ` and the error; the bitmap is closed |
| posting `init` throws | `worker` | `init could not be posted: ` and the error |
| `spawn` throws | `worker` | `the sequence worker could not be started: ` and the error; no worker is alive |
| `cancelHeavy()`, an abort of `signal`, or a `runSequence` while the sequence is alive | `cancelled` | |

The stage `onFailed` names, and the `op` of a `worker` error, is the stage whose run was posted and not yet answered, or, before a stage's run is posted, while its `master()` is pending or inside the product callback of the stage before it, that stage, which before any run is the first listed.
Every failure and cancel terminates the worker before `onFailed`; `cancelHeavy()` with no sequence alive does nothing.
A caller tells a cancel from a failure by the error's kind, `cancelled` or `worker`.

### The termination record

`lastHeavyTermination` is `{ atMs, largest }`, or null until a sequence worker that ran a stage is terminated.
A stage counts as run once the worker has reported its `infer` phase.
At every terminate after at least one stage ran, whether the sequence is done, failed, or cancelled, `atMs` becomes `clock.now()` just after `terminate()` and `largest` the largest stage that ran, encode above inpaint above depth; the record is set before the terminal callback, so that callback and anything it starts read the new record.
A worker terminated before any stage reported `infer`, as when the runtime did not load or a session could not be created, leaves the record unchanged.
The record outlives each sequence on its service; the app is to build one service per page (not built yet), so a caller made for the next scene will read the termination the one before it caused.

### The decoder

`openDecoder({ scene, embeddings, guide })` returns a `Decoder`, the only way to decode: there is no decode without the embeddings the handle was opened on.
`guide` is an `Rgb8`, the master at long edge 1024, and every candidate mask is made at its size.

1. A decoder alive is terminated first, as its `release()` would, with `worker.terminate` reason `replaced`, so the service never holds two decode workers it has not terminated; that handle then acts as released.
2. The service spawns the worker with `spawnDecoder`, logs `worker.spawn`, and posts `init` with `ortBase`, the embeddings, and the guide, with nothing in the transfer list, so `postMessage` copies both and the caller keeps its own; the service keeps no reference to either.
3. `alive.decoder` is true from that spawn until the service terminates that worker, so it is true exactly while a decode worker is alive.

`decode(points, signal)` returns a promise that resolves exactly once, never rejects, and resolves with:

| What happens | The result |
| --- | --- |
| the worker's `decoded` reply for this decode | `ok`, its `DecodeResult` as `parseDecodeReply` parsed it |
| the worker's `failed` reply for this decode, an `init` failure included | `err` `worker`, op `decode`, the reply's message; the decoder stays alive |
| posting the decode throws | `err` `worker`, `the decode could not be posted: ` and the error; the decoder stays alive |
| `signal` aborts before the reply | `err` `cancelled`; a reply that comes after it is dropped |
| `signal` had aborted before the call | `err` `cancelled`, and nothing is posted |
| `release()`, or `openDecoder` replacing this decoder, before the reply | `err` `cancelled` |
| an `error` or `messageerror` event, or a reply that does not parse, before the reply | `err` `worker` with the message the sequence's failure table gives for it; every pending decode resolves so, the worker is terminated with reason `failed`, and the decoder is stopped |
| a decode on a stopped decoder | `err` `worker`, `the decoder stopped: ` and the message that stopped it, and nothing is posted |
| a decode after `release()` or a replacement | `err` `cancelled`, and nothing is posted |

A decode posts `{ type: 'decode', jobId, points }`, its `jobId` one more than the last any decoder of the service used, and the worker answers decodes in the order they were posted, each after `init`.
A reply whose `jobId` names no pending decode, as the late answer to a cancelled one, is dropped.
`release()` terminates the worker, resolves every pending decode with `cancelled`, and makes every later decode resolve `cancelled`; a second call does nothing, and on a stopped decoder it terminates nothing, since its worker is already terminated.
`openDecoder` whose `spawnDecoder` throws terminates the decoder alive as above and returns a stopped decoder, whose decodes resolve `worker` with `the decoder stopped: the decode worker could not be started: ` and the error, and logs no worker event; one whose `init` cannot be posted is stopped the same way, with `init could not be posted: ` and the error, after its worker is terminated.
The decoder and the sequence worker are independent: neither half reads or changes the other's worker, and when a decoder may be opened beside a sequence is its caller's.

The demo session calls `beginImport()` before loading a replacement source, aborting warming (including a pending retry), cancelling the old sequence and releasing the resident decoder before the new sequence can spawn.
The driver opens the new decoder only after the service has terminated the import sequence and any queued background sequence has finished; a background request during warming aborts that warmup and defers it until the sequence ends.
If decoder startup reports `Out of memory`, `no available backend`, or a decoder session that could not start (including wasm loading), warming releases the failed decoder and all heavy work, waits 1500 ms, and retries once with the retained embeddings and guide; cancelled results and `AbortError` are never retried.
A second failure leaves tapping unavailable with `Tapping needs a reload on this device`; edits, Motion, downloads and Projects remain usable, and the raw startup error goes only to dev diagnostics.

### Fetching models

`fetchModels(ops, signal, onProgress)` logs `fetch.start` for each model of `ops`, once each, in the order of `ops`, then awaits the loader.
A loader that failed to open is that failure; otherwise it is the loader's own `fetchModels(ops, signal, onProgress)`, with the same progress (see "A fetch").
However the call ends, it logs `fetch.end` for each of the same models.
It rejects only when the loader's open or fetch rejects, and it does not check whether a sequence is alive, which is the caller's to order.

### The events

`AnalysisEvent` is the module's part of the diagnostic vocabulary, and the composition root's `DiagnosticEvent` includes it.

| Event | Fields | Logged |
| --- | --- | --- |
| `worker.spawn` | `worker: 'sequence'`; `reason`, the stage kinds joined by commas, such as `depth,encode` | when the worker is spawned |
| | `worker: 'decode'`; `reason` `open` | when `openDecoder` spawns the worker |
| `stage.start` | `op`; `ms` 0; `wasmHighWaterBytes` null | just before a stage's `run` or a `decode` is posted |
| `stage.end` | `op`; `ms`, the time on the service's clock since that stage's or that decode's `stage.start`; `wasmHighWaterBytes`, from the reply's timings | when the stage's product arrives, before the listener gets it, or when the decode's `decoded` reply arrives, before its promise resolves |
| `stage.failed` | `op`, the stage `onFailed` names; `error`, the error `onFailed` gets | before the terminate of a sequence that fails or is cancelled |
| | `op: 'decode'`; `error`, the decode's error | when a decode resolves with an error, before its promise resolves |
| `worker.terminate` | `worker: 'sequence'`; `reason` `done`, `failed`, or `cancelled` | just after `terminate()`, before the record is set |
| | `worker: 'decode'`; `reason` `released`, `replaced`, or `failed` | just after `terminate()`, after the `stage.failed` of each decode it ends |
| `fetch.start`, `fetch.end` | `model`, a `ModelId` | around each `fetchModels` call, for each model of its operations |

A sequence therefore logs one `worker.spawn` and one `worker.terminate`, a `stage.start` and then a `stage.end` or a `stage.failed` for each stage whose run was posted, and one `stage.failed` for each sequence that fails or is cancelled.
A sequence that ends before a stage's run is posted, while its `master()` is pending or inside the product callback of the stage before it, logs that stage's `stage.failed` with no `stage.start`, and one that never had a worker, because `signal` had aborted, `spawn` threw, or the sequence it cancelled had started another from its `onFailed`, logs only its `stage.failed`.
A decoder whose worker started logs one `worker.spawn` and at most one `worker.terminate`, one whose `spawnDecoder` threw logs no worker event, and each decode one `stage.end` or one `stage.failed`, after its `stage.start` when the service posted its request or tried to, and alone when it did not: a decode on a released or stopped decoder, or with a signal already aborted.

### Nested workers

ONNX Runtime starts its pthread workers, named `em-pthread`, inside the sequence worker, one fewer than its threads.
In Chrome 154 each appears as a worker target under the sequence worker's DevTools session, which the browser driver attaches to, and the driver's `workers()` page operation lists them (see "The scenario API").
The service scenarios check that the sequence worker and its pthread worker are attached while a sequence runs and that Chrome has detached both within 10 seconds of the page's report settling, after a sequence ends, after its encoder stage fails, and after a cancel during the encoder; with the service's `terminate()` removed, a cancel leaves both attached and that check fails.
Chrome detaches a terminated worker's targets seconds after `terminate()`, not at once, so a sequence started right after another is cancelled runs while the old worker's targets are still attached; no scenario starts one that way.
The decoder scenarios check the same for the decode worker: it and its pthread workers are attached while the decoder decodes, and all are detached within 10 seconds of the report settling after `release()`, after the decoder stopped on an `error` event, and after a replacement.
A detached target is what DevTools reports; whether the memory went back to the system is not measured here.
Safari and the phone are not checked: Safari's census is blocked until its WebDriver sessions open.

## The store

`src/store/` is the store leaf.
Today it holds the database's schema, the one connection every store operation runs through, and the scene lock; the scenes, the assets, the caches, and the device record are not built yet.
Nothing in it names `window` or reads a compile-time constant: the connection takes its opener, its diagnostic sink, and what to do on a `versionchange`; the opener takes the IndexedDB factory and the database's name; and the lock takes a lock manager.
The composition root does not create a connection or a lock yet; the store page does (see "The store page").

| Module | Exports |
| --- | --- |
| `connection.ts` | `StoreError`, `StoreEvent`, `StoreOpener<D>`, `OpenedHandle<D>`, `HandleListeners`, `OpenFailure`, `StoreConnectionDeps<D>`, `StoreOperation<D, T>`, `StoreConnection<D>`, `createStoreConnection(deps)`, `isConnectionError(e)`, `describeError(e)` |
| `idb.ts` | `DB_NAME`, `DB_VERSION`, `STORE_NAMES`, `SCENES_BY_UPDATED_AT`, `createSchema(db)`, `idbOpener(factory, name)`, `requestDone(request)`, `transactionDone(tx)` |
| `lock.ts` | `WithSceneLock`, `SceneLockRefusal`, `SceneLockManager`, `sceneLockName(id)`, `createSceneLock(locks)` |

### The schema

The database is `noisy` (`DB_NAME`) at schema version 1 (`DB_VERSION`), with four object stores:

| Store | Key | Index |
| --- | --- | --- |
| `scenes` | key path `id` | `updatedAt`, on `updatedAt` |
| `assets` | key path `[sceneId, assetId]` | none |
| `caches` | given with each value (`[sceneId, key]`, by its writer, not built yet) | none |
| `device` | given with each value (`'state'`, by its writer, not built yet) | none |

`createSchema(db)` creates all four, and `idbOpener` calls it from `upgradeneeded` only when the database's old version is below 1, which is when the database is new.
The schema version changes only when an object store or an index changes, never for a change to the scene document.

### The connection

`createStoreConnection({ open, diag, onVersionChange })` returns a `StoreConnection<D>`, generic over the handle type `D`, which is `IDBDatabase` in the browser and a scripted handle in the node tests.
It holds at most one handle, opened by the first operation and not before.

Every store operation runs through `run(op)`, which hands `op` the current handle, opening one when none is held, and answers `Result<T, StoreError>`; it never rejects.
An operation answers its own expected failures as an `err`, which `run` passes on as it is.
What an operation throws or rejects with, and how an open fails, is classified:

| What happened | Counts as | What `run` answers |
| --- | --- | --- |
| an error named `InvalidStateError` | a connection error | the operation run once more on a fresh handle |
| an error named `UnknownError` | a connection error | the same |
| any error from an operation on a handle the browser had closed (its `close` event fired) by the time the error reached `run` | a connection error | the same |
| an open that fails with anything but `VersionError`, or an opener that throws or rejects | a connection error | the same |
| an open that fails with `VersionError` | a database at a newer version | `newer-version` with `version`, the database's schema version, and `writer` null, at once and without a retry |
| an error named `QuotaExceededError` | the operation's own | `quota`, without a retry |
| any other error: `ConstraintError`, `DataError`, an `AbortError` on a handle still open, a `TypeError`, a thrown value that is not an error | the operation's own | `io` with the error as `<name>: <message>` (its name alone when the message is empty, and its text for a thrown value with no string `name`), without a retry |

The two names are the ones a lost connection reports.
`transaction()` on a closed handle throws `InvalidStateError`: Chrome's message is "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", which the `store.close-handle` scenario records.
`UnknownError` is the name Web IDL gives a failure with a transient, unknown reason; what Safari reports when it drops a connection after backgrounding is not checked yet, and the owner's phone row H8 records the `store.reconnect` count.
`AbortError` is not counted by name, because when one request of a transaction fails, the transaction aborts and IndexedDB fails its other pending requests with `AbortError`, which is the operation's own failure.
When Chrome closes a handle itself, as clearing the site's data does, it fails each pending request with `AbortError`, then aborts the transaction with `UnknownError`, then fires `close`.
On Chrome 154 a read that awaited each request through its own `onerror` was answered `io` with no `store.reconnect` each time this was tried; the `store.browser-close` scenario checks the other half, that a read awaiting `requestDone` is not.
An operation that rejected with a request's `AbortError` would reach `run` before the `close` event and be answered as its own `io`, so operations await their requests with `requestDone`, which waits for the transaction and rejects with its error, and their transaction with `transactionDone`; the `UnknownError` then reaches `run` and is retried.
The `close` rule covers an error that reaches `run` after the `close` event.
An `InvalidStateError` an operation causes itself, such as `objectStore()` on a transaction that has finished, counts as a connection error too: it is run once more and then answered `unavailable`.

A connection error drops the handle, closes it, and runs the operation once more on a fresh one.
A second connection error in that operation drops that handle too and answers `unavailable` with the detail `connection lost twice: <first cause>; then <second cause>`; the next operation starts again from scratch, with a fresh open and its own two attempts.
Because an operation may run twice, it must be one transaction, or safe to repeat.

The connection logs `store.reconnect` with `cause` each time it opens a fresh handle because the one before was lost, once per such open.
The cause is the error as `<name>: <message>`, `close` for a handle dropped by its `close` event, and `open: <failure>` for a failed open.
An error that reaches `run` after the `close` event is logged under that event's `close`.
In an `unavailable` detail, such an error that is not itself a connection error is named `close: <error>`, and an `InvalidStateError` or `UnknownError` keeps its own `<name>: <message>`.
So one connection error logs one `store.reconnect`; two in one operation log one, for the retry's open, and the next operation's open logs another.
The first open, an open after a `versionchange`, and a `newer-version` answer log nothing.
An `InvalidStateError` from a handle the connection itself closed for a `versionchange` is retried once on a fresh handle like any connection error, but logs nothing, because the connection was not lost: `onVersionChange` has already reported it.
`StoreEvent`, `{ event: 'store.reconnect', cause }`, is the store's part of the diagnostic vocabulary, and the composition root's `DiagnosticEvent` includes it.

Operations that start while an open is under way wait for that open and share its handle, and operations that fail on the same lost handle drop it once and share one reopen.

A `versionchange` on the handle, which another connection's upgrade or deletion of the database sends, makes the connection close the handle at once, so the other connection can go on, drop it, and call `onVersionChange` once for that handle.
Transactions already running on it finish, since closing a connection waits for them; the next operation opens a fresh handle.
The store page passes a reload as `onVersionChange`.
A `close` event drops the handle, and the next operation reopens.

`idbOpener(factory, name)` opens the database `name`, which is `DB_NAME` for the app, at `DB_VERSION`, and hands the handle's `close` and `versionchange` events to the connection's listeners.
On `VersionError` it opens the database again without a version, reads the version it has, and closes it; if that read fails the open counts as a failed open.
Any other error, or a throw from `factory.open`, answers `failed` naming it.
It does not handle `blocked`, which an open fires only while it waits to upgrade a database other connections hold open at an older version; version 1 is the first, so there is no older version to hold.
`requestDone(request)` resolves with the request's result; when the request fails, it waits for the request's transaction to end and rejects with the transaction's error when the transaction aborted with one, and with the request's own error otherwise.
For an operation's own failure the two are the same error: a `ConstraintError` aborts the transaction with that `ConstraintError`, and a transaction the operation aborts itself has no error, so the request's `AbortError` is used.
`transactionDone(tx)` resolves when `tx` commits and rejects with the transaction's error when it aborts, or with an `AbortError` when it was aborted without one.

`StoreError` is the store's error type: `quota`, `missing`, `damaged` with a detail, `newer-version` with `version` and `writer`, `unavailable` with a detail, and `io` with a detail.
The connection answers `quota`, `io`, `newer-version`, and `unavailable`; the other kinds are for the operations built on it.

### The scene lock

`createSceneLock(locks)` returns `withSceneLock(id, fn)`, over a lock manager (`navigator.locks` in the browser, which every tab and frame of the origin shares).
It requests the lock named `noisy-scene-<id>` (`sceneLockName(id)`) with `ifAvailable: true`, so the request is granted or answered with no lock at once, and never waits behind a holder.
With no lock it answers `open-elsewhere` without calling `fn`; this holds for a second request from the holder's own page, so the lock is not re-entrant.
With the lock it calls `fn` and holds the lock until `fn`'s promise settles, then answers `fn`'s value as `ok`.
When `fn` rejects or throws, the lock is released and `withSceneLock` rejects with the same error.

## The synth fixtures

`test/fixtures/synth/` paints the synthetic scene the models were measured on before this code was written, sky, a checkered ground plane, a near red sphere with its shadow, and a far grey box, with its exact truth.
Those experiments, their painter among them, are recorded only in the gitignored `.claude/work/` on the owner's Mac, so the repository holds no copy of them; the scene's constants and colors are taken from that painter.
`scene.ts` holds the scene: its constants (`SCENE`), its layout in master pixels for a master size (`sceneGeometry`), the predicates for the sphere's disk, the box's face, the shadow, and the inpainting hole, `surfaceAt`, which says which surface is painted at a point, `colorAt`, the color painted there, and `inverseDistanceAt`; and the regions the known-answer checks read, as the bench that judged the models drew them (`CHECK_REGIONS`, `inDepthNear`, `inDepthFar`, `inHoleGrown`, and `holeBounds`).
`synth.ts` holds `SYNTH_FIXTURES`, `synth` at 2048 x 1536 and 512 x 384 and `synth-pano` at 2048 x 512, and `synthScene(size)`, which throws for a side that is odd or not a whole number, since import makes every master's sides even.

| Output | Holds |
| --- | --- |
| `masterRgba()` | the master as RGBA bytes, alpha 255, a `Uint8ClampedArray` that `new ImageData(data, width, height)` takes |
| `master()` | the master as `Rgb8` |
| `plate()` | the scene painted without the sphere and its shadow, as `Rgb8` at the master size |
| `depth(size?)` | a `Plane<'f32'>`, by default at `depthInputSize(master)`: the inverse of the distance along the view axis of the surface painted at each texel, divided by the plane's largest, so the nearest texel is 1 and the sky, at infinite distance, 0 |
| `sphereMask(size?)`, `boxMask(size?)` | a `Plane<'u8'>`, 255 where that surface is painted and 0 elsewhere, by default at long edge 1024 with the short side the master's aspect rounded to the nearest pixel (`maskSize`) |
| `hole()` | a `Plane<'u8'>` at the master size, 255 inside the sphere's disk and the shadow's ellipse each grown by 0.04 of the sphere's radius, the hole the experiments inpainted, in `holeMask`'s polarity |
| `depthNear(size?)`, `depthFar(size?)` | the depth check's regions, a `Plane<'u8'>` by default at `depthInputSize(master)`: near is 255 strictly inside the sphere's disk shrunk to 0.8 of its radius, far 255 strictly inside the box's face inset by 0.1 of its width and height on each side; the two do not overlap at any fixture size |
| `ring()` | the inpaint check's ring, a `Plane<'u8'>` at the master size: 255 at the pixels outside the hole and inside the sphere and the shadow grown by 0.3 of the sphere's radius that the bench sampled, every second pixel along each axis from the corner of `holeBounds(0.3)`, the bounds of that growth floored and ceiled to whole pixels and clamped to the master |

The distances are the ground plane's at each row, the box's front at 10, and on the sphere's disk the front of a world sphere of radius 0.55 centered at distance 2.2, at the depth its shading normal gives, `2.2 - 0.55 nz`, so the disk's rim meets the ground at the sphere's own distance.
The nearest texel is the ground at the bottom row, so the sphere lies at about 0.63 to 0.84 and the box at about 0.14.

Every output samples the scene at texel centers: texel (u, v) of a w x h plane reads the master point ((u + 0.5) W / w, (v + 0.5) H / h) of a W x H master, and the painter paints pixel (x, y) at its center, (x + 0.5, y + 0.5).
The painter, the masks, and the depth all ask `surfaceAt` at that point, so a truth plane at the master size is exactly what was painted, and at another size it is what would be painted at its texel centers.
The experiments' painter sampled a pixel at its corner, (x, y), for which surface is painted, its shading, the checker's column, and the sky's gradient, but took the ground's distance, and so the checker's row and the fog, at the row's center, y + 0.5, and cut its hole at centers; so these bytes differ from that painter's.

The generator is pure arithmetic with no randomness and no clock, and `test/synth.test.ts` pins the SHA-256 of every output, so regenerating gives the same bytes in one JavaScript engine.
`Math.exp`, `Math.pow`, and `Math.hypot` may differ in their low bits between engines (V8 and JavaScriptCore differ by more than one unit in the last place for `Math.pow` and `Math.hypot`), so the bytes are not promised to match across engines.
The 2048 x 1536 and 512 x 384 masters scale the scene by a power of two, so their depth and masks at the default sizes are the same bytes.
A dev page cannot import the generator, since the import graph keeps every `src/` import inside `src/`; the sequence worker's scenarios paint a fixture in node, write its bytes to a temporary file, and hand that file to the sequence worker page through its file input (see "The sequence worker page"), and a page can fetch a master from the dev server's `/dev/synth/master` (see "The synth master route").

## Response-header contract

`headers.json` is the one statement of the response headers, read by the dev server now and mirrored by the AWS response-headers policy at release.

| Key | Meaning |
| --- | --- |
| `all` | headers on every response |
| `byPath` | rules in order; on a response with a status below 400, the first whose `path` matches adds its `headers`; a `path` is exact (`/index.html`), a prefix ending in `*` (`/assets/*`), or `*` |
| `errors` | headers a response with a status of 400 or above carries in place of its `byPath` rule's |
| `contentTypes` | `Content-Type` by file extension |
| `defaultContentType` | `Content-Type` for any other extension |

`all` carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, the `Content-Security-Policy`, and two hardening headers, `Cross-Origin-Resource-Policy: same-origin` and `X-Content-Type-Options: nosniff`.
The CSP's `script-src` has no `'unsafe-eval'`, so browser code must not evaluate strings.
zod 4.6.5 tries `new Function` when a bundle creates its first object schema, and under this CSP that attempt is blocked and reported as a `script-src` violation, unless `z.config({ jitless: true })` ran first in that bundle.
`src/core/zod.ts` makes that call and re-exports `z`, and every module under `src/` imports `z` from it, never from `zod`, which the import-graph test enforces; an ES module runs after the modules it imports, so the call runs before any importer creates a schema.
`byPath` gives `/assets/*` and `/vendor/ort/*` `Cache-Control: public, max-age=31536000, immutable`, since each of their file names changes with its content (a hash, or the runtime's version).
It gives `/models/*` `Cache-Control: no-store`: the server does not check a model file against the lock, so the HTTP cache never keeps one the browser has not verified, and a retry after a failed check reaches the server.
Every other path, `/` and `/index.html` named explicitly, gets `Cache-Control: no-cache`.
`errors` gives every error `Cache-Control: no-store`, so a browser never caches a `404` for a hashed file that a later build puts back.
`.wasm` is served as `application/wasm`.
The source file is the authority for the base values.
A GPU build records its generated policy in `build.json`: the configured service origin alone is appended to `connect-src`.
An empty `gpu` preserves the base policy byte for byte.
`test/headers.test.ts` builds and serves both forms, and checks that a service URL path cannot inject a policy directive.

`tools/check-headers.mjs <base-url> [--path <path>]... [--headers <file>]` fetches `/`, `/index.html`, every same-origin `src` and `href` in the index page, and each `--path`, and compares each response with what the contract requires for that path, `Content-Type` included.
It prints one JSON line per path (`{ path, status, ok, mismatches }`) and exits 0 when every response is a 200 that carries every required header with the required value, 1 when one does not, 2 on a usage error (a malformed `--path` included), and 3 with one sentence on stderr when a request gets no response, such as an unreachable host.
It only needs a base URL, so it can check the AWS host at release.

## Dev server

`tools/serve.mjs` is dependency-free and binds `127.0.0.1` by default; `--host 0.0.0.0` exposes it on the LAN.
It has two modes: `dev`, which `npm run serve` and the browser driver's dev targets run, and `production`, which `npm start` runs (see "Production mode").
Its first line of output is `serve: <mode> mode on <scheme>://<host>:<port>/`, with HTTPS when `--tls` is supplied and HTTP otherwise.
It stops on SIGINT or SIGTERM and closes any open connection.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--mode` | none, required | `dev` or `production` |
| `--port` | `8790` | `0` picks a free port |
| `--host` | `127.0.0.1` | bind address; `0.0.0.0` for LAN access |
| `--tls` | none, HTTP | serve HTTPS using `server.pem` and `server-key.pem` in this directory |
| `--root` | the mode's build output, `build/dev` or `build/production` | the build output served at `/` |
| `--models` | `models` | the directory served at `/models/` |
| `--vendor-ort` | `<root>/vendor/ort`, the build's copy of the runtime | the directory served at `/vendor/ort/` |
| `--headers` | `headers.json` | the header contract |
| `--gpu-stub` | false | dev only: serve `build.json` with `gpu: "/dev/gpu"` |
| `--results` | `test-results` | dev mode only: the results sink's directory |
| `--request-log` | `test-results/requests.jsonl` | dev mode only: the request log |

Default paths are relative to the repository root, except `--vendor-ort`'s, which is under `--root`; paths given on the command line are relative to the working directory.

Every response carries the contract's `all` headers, less COOP and COEP while the `no-isolation` fault is set.
A response with a status below 400 adds the `byPath` headers for its path, and one with a status of 400 or above adds the `errors` headers instead.
In dev mode two more rules apply:

- Every response also carries `Content-Security-Policy-Report-Only` with the contract's CSP followed by `; report-uri /dev/csp-report`, so a violation in the page or in any worker, nested ones included, is reported to the server; the enforced `Content-Security-Policy` stays the contract's.
  This header is dev-only and not part of `headers.json`.
- A response the fault state altered, one a fault rule applied to or any response while `no-isolation` is set, carries `Cache-Control: no-store` in place of the contract's, so a corrupt, truncated, stalled, or unisolated response is never cached under the immutable rule.
File responses take `Content-Type` from the contract; responses the server writes itself are `application/json` or `text/plain; charset=utf-8`.
In dev mode the server checks at startup that it can write the request log and create the results directory, and exits 1 with one sentence when it cannot.

### Routes

| Route | Methods | Mode | Behavior |
| --- | --- | --- | --- |
| `/models/<file>` | GET, HEAD | all | a file under `--models`; Range; faultable |
| `/vendor/ort/<file>` | GET, HEAD | all | a file under `--vendor-ort`; Range; faultable |
| `/dev/fault` | GET, POST, DELETE | dev | the fault state (below) |
| `/dev/requests` | GET | dev | the request log as a JSON array; `?since=<seq>` returns rows after that seq |
| `/api/log` | POST | dev | the results sink (below) |
| `/dev/csp-report` | POST, GET | dev | CSP violation reports (below) |
| `/dev/gpu/v1/...` | GET, POST, DELETE | dev | synthetic GPU contract, including health, sessions, depth, taps, inpaint, and deletion |
| `/dev/synth/master` | GET, HEAD | dev | the synth fixture's master as raw RGBA bytes (below) |
| anything else | GET, HEAD | all | a file under `--root`; `/` is `index.html` |

Static files answer a single `Range` of the forms `bytes=N-`, `bytes=N-M`, and `bytes=-N` with `206` and `Content-Range: bytes <start>-<end>/<size>`.
An unsatisfiable range (one that starts at or past the end, ends before it starts, is `bytes=-0`, or asks for any range of an empty file) answers `416` with `Content-Range: bytes */<size>`.
A malformed or multi-range header is ignored and the whole file is sent with `200`.

The server never serves a file outside its roots.
The path is percent-decoded once; in dev mode a path with a `..` or `.` segment, a NUL, or a backslash answers `400`, and so does a request target that does not start with `/`.
In dev mode a file whose real path, symlinks resolved, is outside its root answers `400`; production mode answers each of these with `404` (see "Production mode").
A missing file or a directory answers `404`.

`MODES` in `serve.mjs` lists each mode with a `dev` flag and the build output it serves at `/` by default: `dev` with `dev: true` and `build/dev`, `production` with `dev: false` and `build/production`.
Only a mode with `dev: true` creates the fault state, the sink, the request log, and their routes.

### GPU contract stub

The dev server exposes the GPU contract under `/dev/gpu` without enabling remote analysis for ordinary dev runs.
`--gpu-stub` changes the served configuration to opt into it; `driver.gpu` opts in for its own page by intercepting only the configuration request.
The scenario is registered through the existing driver scenario export in `test/browser/scenarios/index.ts`.
The stub decodes JPEG or PNG uploads using macOS's built-in `/usr/bin/sips`, in a temporary directory removed after conversion.
This OS tool is dev-only; neither hosting nor the browser acquires a dependency.
It returns a normalized depth gradient, three soft candidate discs of increasing radii around include taps (exclude taps remove regions), and a PNG plate filled with the mean outside-hole color.
Pixels outside the hole remain equal to the decoded uploaded master.
The stub retains at most 16 sessions and expires them after 30 idle minutes.
Its responses are no-store and implement the contract's CORS allowlist and preflight; production exposes none of these routes.
The existing fault grammar accepts `/dev/gpu/` prefixes and `http503`, `slow=<ms>`, and `stall`, consuming a rule per request including POST requests.
A stall flushes valid resource headers without a body, exercising the client's body deadline.

### Production mode

`tools/serve.mjs --mode production` serves the build at `/`, `/models/`, and `/vendor/ort/`, with `Range`, and nothing else.
Every response it writes carries the contract's headers as the rules above give them, and no header the contract does not name beyond the transport's own (`Date`, `Connection`, `Keep-Alive`, `Content-Length`, `Transfer-Encoding`) and the range headers (`Accept-Ranges`, `Content-Range`): there is no report-only CSP and, with no fault state, no `no-store` override.
It has no fault state, no sink, no request log, and no CSP report endpoint, and writes nothing to disk; given `--results` or `--request-log` it exits 1 with one sentence.

It answers `404` for `/dev`, `/api`, and every path under them, to every method, however the request spells them, and for any other path it cannot serve, such as one holding a backslash or a NUL byte, which dev mode answers with `400`.
A request Node's HTTP parser rejects before the server sees it, such as one with a malformed request line, gets Node's own bare `400` or `431`, in either mode, with none of the contract's headers.
Two checks make that hold, and each is tested as if it were the only one:

1. The path, percent-decoded once, has its `.` and `..` segments resolved and its empty segments collapsed; if its first segment is `dev` or `api` compared without regard to case, the answer is `404` before any route or file is looked at.
   So `//dev/x`, `/%2Fdev/x`, `/DEV/x`, `/%64ev/x`, `/./dev/x`, and `/assets/../dev/x` all answer `404`.
2. A file whose real path, symlinks resolved, begins with `dev/` or `api/` relative to `--root`'s real path, in any case, answers `404`, whichever of `/`, `/models/`, and `/vendor/ort/` reached it.
   This covers a symlink into such a directory, a `--models` or `--vendor-ort` that points into one, and any spelling that macOS's case-insensitive file system resolves there.

A production build writes no `/dev/` page (see "Bundle guard"), so these checks are a second line, there so that a dev page added later cannot leak through the server the owner runs.
`test/support/dev-only-paths.ts` lists the requests the tests and the production scenarios send raw.

### Fault grammar

`POST /dev/fault` with the JSON body `{"rules": [<rule>, ...]}` replaces the whole fault state.
If any rule is invalid the server answers `400` with the reason and the state does not change.
`GET /dev/fault` returns the state, and `DELETE /dev/fault` clears it; each answers `{"isolation": <bool>, "rules": [{"spec", "hits", "remaining"}, ...]}`.

```
rule     = "no-isolation" | "path:" prefix ":" kind [ ":method=" verb ] [ ":times=" n ]
prefix   = a path starting with "/models/", "/vendor/ort/", "/api/projects" or "/dev/gpu/", with no ":"
kind     = "http500" | "http503" | "corrupt" | "truncate=" n | "stall" | "slow=" n
verb     = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "OPTIONS"
n        = a whole number, at least 1; for slow, at most 2147483647
```

Examples: `path:/models/:http500`, `path:/models/depth:truncate=1000:times=1`, `path:/vendor/ort/:slow=2000`, `no-isolation`.

A request on a faultable route whose decoded path starts with a rule's prefix and whose method matches the optional verb matches it.
Without a method qualifier the existing route rules apply; file routes accept GET and HEAD, and GPU and project routes accept their supported methods.
`path:/dev/gpu/v1/sessions:http503:method=POST:times=1` fails session creation without consuming the fault on old-session DELETE.
The first live rule in list order applies, and it consumes one of its `times` whatever the response turns out to be; without `times` a rule never runs out.
A rule that has run out stays in the list with `remaining: 0` and no longer matches.

| Kind | Behavior |
| --- | --- |
| `http500` | answers `500` with a short text body |
| `http503` | answers `503`; GPU and project routes use their JSON error shape, file routes use a short text body |
| `corrupt` | answers as usual (`200` or `206`, the same `Content-Length`) with every body byte inverted (XOR `0xff`) |
| `truncate=<bytes>` | declares the full length, sends the first `<bytes>` bytes of the body, then closes the connection; a body no longer than `<bytes>` is sent whole |
| `stall` | sends the status and headers, then nothing until the client disconnects or the server stops |
| `slow=<ms>` | waits `<ms>` milliseconds, then answers as usual |

`corrupt`, `truncate`, and `stall` apply to a file that exists; for a missing file the answer is `404`.
`no-isolation` drops `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` from every response on every route until the state is cleared or replaced, so a reload shows `crossOriginIsolated` false.

A partial download and its resume: set `path:/models/<file>:truncate=<N>:times=1`, let the client's first request fail, and its retry with `Range: bytes=<N>-` is answered `206` with the remaining bytes.

### Results sink

`POST /api/log` stores what a page or a driver sends:

- With the media type `application/json` (matched without regard to case, any parameters such as `charset` ignored), the body must be one JSON object of at most 1,048,576 bytes.
  The server appends `{"at": "<ISO time>", "row": <object>}` to `<results>/log.jsonl` and answers `{"ok": true}`.
- With any other `Content-Type`, `application/jsonl` included, the body is a binary capture of at most 268,435,456 bytes.
  It is written byte for byte to `<results>/captures/<UTC timestamp>-<6 hex>-<name>`, where `<name>` is the `?name=` query parameter with every character outside `A-Z a-z 0-9 . _ -` replaced by `_`, leading dots removed, and at most 100 characters (default `capture.bin`).
  The server answers `{"ok": true, "path", "file", "bytes", "sha256", "contentType", "name"}`, where `path` is relative to `<results>` and `file` is absolute, and appends `{"at", "capture": {...}}` with the same fields to `log.jsonl`.

A body over its bound is read to the end, discarded, and answered `413`.

### CSP reports

`POST /dev/csp-report` takes a violation report in any JSON media type browsers send (`application/csp-report`, `application/reports+json`), at most 65,536 bytes, and appends `{"at", "contentType", "userAgent", "report": <body>}` to `<results>/csp-reports.jsonl`.
A body that is not JSON answers `400`.
`GET /dev/csp-report` returns the stored lines as a JSON array.
A run with no violation leaves no `csp-reports.jsonl`, or adds no line to it.

### The synth master route

`GET /dev/synth/master?width=<w>&height=<h>` answers the synth scene's master at that size as raw RGBA bytes, four a pixel with alpha 255, `application/octet-stream` with `Cache-Control: no-store`: the bytes of `synthScene({ width, height }).masterRgba()` from `test/fixtures/synth/synth.ts`.
It serves bytes rather than letting a page paint them because the painter's `Math.exp`, `Math.pow`, and `Math.hypot` may differ in their last bits between engines (see "The synth fixtures"), so a page in Safari or on the phone reads the same bytes node paints for the browser scenarios.
`width` and `height` must each be given once, as an even whole number from 2 to 4096 in plain digits; anything else, an odd, zero, negative, fractional, or non-numeric value, a missing or repeated one, or one above 4096, answers `400`, and any method but GET and HEAD answers `405`.
The server imports the fixture the first time the route is asked for, so production mode never loads it, and keeps the last four sizes it painted, dropping the least recently asked for.
Production mode has no such route: its `/dev` guard answers `404` first.

### Request log

Every response the dev server sends appends one line to the request log when its status and headers are sent, so a stalled response is logged too:

```json
{"seq": 12, "at": "<ISO time>", "method": "GET", "path": "/models/depth.onnx", "headers": {"range": "bytes=1000-"}, "status": 206, "fault": null}
```

`path` is the request target as received, query included; `headers` holds every request header, lowercased; `fault` is the spec of the fault rule applied, or `null`.
`seq` rises by one per line and continues from the last line of an existing log after a restart.
If the log's directory is removed while the server runs, the next line recreates it.
If a line cannot be written for any other reason, the server prints one line to stderr, keeps answering requests, and leaves those requests unlogged until a write succeeds again.

## The start command

`npm start` runs `tools/start.mjs`, which is dependency-free and runs noisy's current production build on this Mac, shared to the tailnet, until Ctrl-C.
It is a command the owner runs when wanted, not a service.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `8791` | the production server's port on `127.0.0.1`; `0` picks a free one; the dev server's default, `8790`, stays free for `npm run serve` |
| `--outdir` | `build/production` | where the production build is written and served from |
| `--models` | `models` | the model files, fetched, verified, and served at `/models/` |
| `--lock` | `models.lock.json` | the model lock, which the fetch verifies the files against and the build carries |

Flags go after `--`: `npm start -- --port 8792`.
The tests use `--port 0` and temporary `--outdir`, `--models`, and `--lock`.

In order, it:

1. Refuses to start, changing nothing, unless Tailscale is usable and no serve configuration exists.
   It reads `tailscale status --json` and refuses when `tailscale` is not on `PATH`, when the command fails, when `BackendState` is not `Running`, when `Self.Online` is not `true`, and when `Self.DNSName` is empty.
   A non-empty `Health` list alone refuses nothing, because Tailscale lists benign warnings there too; the refusals for `BackendState` and `Self.Online` quote every `Health` line.
   It then reads `tailscale serve status --json` and refuses when it shows any configuration at all, as a phone sitting's share or another `npm start` leaves it.
   It also refuses when `--port` is taken on `127.0.0.1`, before fetching or building anything.
2. Runs `tools/fetch-models.mjs --models <models> --lock <lock>`, which downloads what is missing and verifies every file (see "The fetch tool"); if it exits non-zero, nothing is built or started.
3. Runs `tools/build.mjs --mode production --outdir <outdir> --lock <lock>`, so the bundle carries the lock the files were verified against.
4. Starts `tools/serve.mjs --mode production --port <port> --root <outdir> --models <models>` and waits, at most 30 seconds, for its `serve: production mode on http://127.0.0.1:<port>/` line.
5. Runs `tailscale serve --https=443 http://127.0.0.1:<port>` in the foreground, waits, at most 30 seconds, until `tailscale serve status --json` shows a handler proxying to that URL, and prints the tailnet URL, `https://<Self.DNSName without its final dot>/`.

The server, the share, the fetch, the build, and each `tailscale` query run in a process group of their own, so a Ctrl-C in the terminal reaches the command (and, under `npm start`, npm) but none of them; the command stops them in turn, and the output of all but the queries passes through to the terminal.
A `tailscale` query that has not answered within 15 seconds is killed with its process group and counts as failed.
Ctrl-C, SIGTERM, or SIGHUP stops both, and so does either child exiting on its own.
The share is stopped first, with SIGINT, as a Ctrl-C in its own terminal would, then the server with SIGTERM; each gets 5 seconds and is then sent SIGKILL.
Then it reads `tailscale serve status --json` once more.
If a handler still proxies to its server, it runs `tailscale serve --https=443 off`, which removes the share it made, and reads the configuration again; it never runs `tailscale serve reset`, which would remove a configuration it did not make.
If the command itself is killed with SIGKILL, the processes it started keep running.

Its own lines on a run that comes up are these; the output of the fetch, the build, the server, and the share comes between them as it arrives:

```
start: checking Tailscale (tailscale status --json, tailscale serve status --json)
start: fetching and verifying the model files (tools/fetch-models.mjs)
start: building the production bundle (tools/build.mjs --mode production)
start: starting the production server (tools/serve.mjs --mode production on 127.0.0.1:8791)
start: sharing it over Tailscale (tailscale serve --https=443 http://127.0.0.1:8791)
start: noisy is up at https://<this Mac's MagicDNS name>/
start: server pid <pid>, share pid <pid>; press Ctrl-C to stop both
```

and on Ctrl-C, `start: stopping the share and the server`, then `start: stopped; nothing it started is running and no configuration of its share is left.`
Every refusal is one sentence on stderr that says what to do, and a failed step or child ends with one sentence on stderr that names its command; a failed fetch or build prints its own sentence first.

| Exit | Meaning |
| --- | --- |
| 0 | stopped by Ctrl-C, SIGTERM, or SIGHUP after noisy was up, with both children stopped and no configuration of its share left |
| 1 | the fetch or the build failed, the server or the share exited on its own or failed to come up, or the share's configuration could not be shown removed; nothing it started is left running |
| 2 | a usage error |
| 3 | refused before changing anything: Tailscale is not usable, a serve configuration exists, or the port is taken |
| 130 | interrupted before noisy was up: while checking Tailscale, whose query in flight is killed, during the fetch, which removes its partial download, during the build, which is left to finish, or while the server or the share was starting, which are stopped |

`test/start.test.ts` exercises exits 0, 1, 2, 3, and 130 (a Ctrl-C while checking Tailscale) through `test/support/tailscale-stub.ts`, a stand-in `tailscale` that answers `status --json`, `serve status [--json]`, a foreground `serve --https=443 <target>` that writes its configuration and stays up until signalled, `serve --https=443 off`, and `serve reset`, can delay any answer, and records every call and signal; it runs either as the `tailscale` script itself or, as the real `/usr/local/bin/tailscale` runs the CLI, as that script's child.
The stub models the real command and is not it: whether the real foreground share removes its own configuration when it stops, and whether `off` removes a foreground share's leftover, are checked only by a run against a real tailnet.

## Editable object layers

Object layers persist their `name` and `hidden` flag in scene documents.
Version 3 adds `hidden: false` to legacy objects and supplies `Object N` only when a legacy name is missing.
`object.rename`, `object.hide`, `object.show` and `object.remove` are individual undo steps applied through the reducer.
The session owns the bounded history, records object creation and refinement alongside its edits, and clears history on Reset or installation of another photo or project.
Deleting the selected object selects the scene.
Each history entry retains the mask planes named by its forward and inverse edits; the active product store retains only current document masks, and undo restores the original planes before rendering and autosave.
History is transient; autosave persists the current names, visibility and object list under the existing project revision rules.

Desktop layers and the phone sheet share the layer rows and Object inspector.
Rows provide selection, double-click rename, Hide or Show, and immediate Delete.
The Object inspector provides the name and Rename action, swatches, Hide or Show, then Delete.
Inline rename commits on Enter or blur, cancels on Escape and refuses an empty name.
Layers headers expose Undo and Redo; Cmd/Ctrl-Z and Shift-Cmd/Ctrl-Z operate history except in text editing controls.

Hidden layers leave draw order and hit testing, while all current masks remain inputs to plate preparation and freshness.
Hiding requests the existing Preparing path even with Motion off.
Once a fresh plate is resident, still rendering reuses the Motion geometry compositor at zero camera offset and zoom 1, drawing only visible objects above the plate.
PNG export uses that same still compositor and omits the screen selection overlay.
No shader or analysis change is involved.

## Shared projects and the Projects API

`src/projects/` is a leaf importing only itself and `core/`.
`serialize.ts` writes the whole scene document as JSON and reads it through `parseDocument`, including version migration.
It validates exactly one size entry for each distinct object-mask asset, a nonnegative safe-integer scene revision, and represents masks as raw row-major u8 bytes with no header.
Mask planes are bounded to 4096 px per side and 16 MiB, and byte length must equal width times height.
`store.ts` uses same-origin fetch with a 15 second request timeout and verifies loaded photo and mask content hashes.
Every successful mutation reads and validates its complete `{ ok: true }` JSON body within that timeout.
Headers alone never complete a write; stalled or malformed acknowledgements fail it.
UI reaches it through `src/session/projects.ts` and `scene.ts`, preserving `ui -> session -> leaves -> core`.
The import checker recognizes projects as a leaf.

One GET /api/projects probe runs when the page's project session is created.
All writes, loads, deletes and list refreshes wait for that probe.
A 204 or 404 permanently disables the store for that page load, cancels pending saves and leaves an empty Projects panel reporting No project store on this server.
The local production server returns a bodyless 204 for this GET only; 404 remains supported for a hosted server whose store is not deployed yet.
Photo imports and editing keep working without project requests after that initial probe.
Other failures retain Not saved and permit later save/refresh attempts.
The initial successful probe supplies the list without a duplicate refresh while it is in flight.

The session starts the original-photo upload once a successful import has its new project id.
While a new photo is fetched and decoded, the project session reports Saving instead of treating the temporarily absent current id as Saved.
A committed import owns its fresh id; a refused import ends preparation and reports Not saved.
Document and referenced-mask changes restart a 1500 ms trailing debounce; selection and status changes do not save.
Each project's serial queue writes any unsaved photo, new immutable mask assets, the thumbnail, then scene JSON.
Scene PUT is the final checkpoint; an older in-flight save cannot overwrite a newer queued edit in the same session.
New projects start at revision zero; restored projects retain their saved revision, and each changed snapshot increments it before saving.
The store atomically rejects a scene revision that is not strictly greater than the existing one with HTTP 409, including a request whose client timed out before the server finishes.
HTTP 409 and 410 are terminal for that snapshot; the client preserves any newer pending snapshot and does not retry the refused one.
A new import flushes the previous pending snapshot before replacing its renderer, and those writes finish under the previous id.
Reset saves the reset document under the same id.
Projects deletion immediately hides the named row and offers Undo for eight seconds.
The project session owns each pending deletion and its timer, independently of panel mounting and document history.
Refresh cannot reinsert a pending row, and closing or reopening Projects preserves its Undo opportunity.
Undo cancels the pending deletion while retaining the existing saved assets and normal autosave ownership.
The irreversible store DELETE runs only after the Undo window closes, freezes new writes for that id and waits for queued writes before deleting its resources and dropping its job, File and retained masks.
Observations during a committing delete retain the newest document and masks so an HTTP refusal can restore a recoverable row without losing edits.
Deletion failures have named feedback independent of save and list feedback.
A missing or malformed DELETE acknowledgement is unconfirmed: the session retains local data, freezes writes and opening, and offers an idempotent deletion retry.
Pagehide cancels pending deletion that has not dispatched DELETE and leaves a BFCache-restored session usable.
The immediate low-level remove operation remains available for fixture cleanup; UI uses the deferred requestRemove and undoRemove operations.
DELETE 404 is success, including a first import whose photo upload failed before creating server resources.
The fixture keeps an in-memory tombstone for every deleted id, including an unknown id, until the server restarts; all subsequent PUTs under it return HTTP 410 without writing.
Continued edits of the deleted scene do not recreate it.
Save failures remain in project state as Not saved until a later save succeeds, and never change the analysis status line.
There is no cross-device merging; a device starts from the loaded revision and only a strictly greater scene revision can own the next checkpoint.

Thumbnails come from the renderer's frame-zero still export without selection, downsampled with a 2D canvas to a 256 px long edge.
They are JPEGs smaller than 60,000 bytes; the session tries decreasing JPEG qualities to enforce the bound.
Projects reuse the 64 px layer row, a 48 px thumbnail, a name, an 11 px secondary saved time and a stable single-press Delete target.
The title and local Return to editor action remain fixed across empty, preparing, saving, saved, failed and deleted states.
Save feedback describes only the current project's checkpoint; browsing existing rows does not claim a recent save.
Opening a project and observing unsaved edits retain its last known save timestamp; only a successful scene checkpoint advances that time.
An empty available store offers the existing photo import and sample actions.
Desktop Projects replaces the left sidebar; portrait Projects fills the stage, hides the editing sheet, Reset and viewer rail, and retains a visible editor status sentence.
With a store available, the panel refreshes on opening and every 15 seconds while visible.

Project opening flushes a retained pending debounce before loading, including Undo immediately followed by Open, and rechecks the latest revision after awaited work.
Queued snapshots retain their captured preview so retrying an old project's save never exports another project's renderer.
Project opening then has a guarded preparation branch using importSource's current AbortController identity and generation.
It loads scene, original photo and masks, decodes a File with the original filename and checks the candidate render while preserving the current document, selection, products, analysis readiness and autosave ownership.
A preparation failure reports its error on the existing scene without cancelling that analysis or suspending its saves.
Only a prepared project commits a new import generation: it flushes the previous project's thumbnail with its original renderer, publishes the first look using the saved id, then installs every mask by asset id and sets the whole saved document before sceneReady can start depth analysis.
Selection is cleared and the normal analysis driver recomputes depth and any needed plate.
A persisted plate whose pixels are absent is treated as missing only in the analysis driver's read projection so reconcile can rebuild it without discarding the persisted look.
Obsolete imports close their decoded bitmaps and never publish or begin autosave.

The same-origin API is JSON except for binary assets:

| Request | Response or body |
| --- | --- |
| GET `/api/projects` | Available store: `{ projects: [{ id, name, updatedAt, thumbnail }] }`, newest server save first, then id for ties; thumbnail is `/api/projects/<id>/thumbnail`. Local production without a store: 204 with no body |
| PUT or GET `/api/projects/<id>/scene` | `{ document, masks: { [asset]: { width, height } }, revision }`; document id equals path id, revision is a nonnegative safe integer; PUT revision must exceed the existing one or returns 409 |
| PUT or GET `/api/projects/<id>/photo` | Original bytes and original image content type (application/octet-stream for untyped files); filename lives in document.frame.original.name |
| PUT or GET `/api/projects/<id>/masks/<asset>` | application/octet-stream, u8 row-major bytes, SHA-256 equals asset id; dimensions live in scene metadata |
| PUT or GET `/api/projects/<id>/thumbnail` | image/jpeg, less than 60,000 bytes |
| DELETE `/api/projects/<id>` | Removes the scene and every asset beneath the id and tombstones the id for the server's lifetime; later PUTs return 410; missing-id 404 is success to the client |

Successful mutations return `{ ok: true }` with HTTP 200.
Missing projects or resources return 404; malformed paths, metadata, media types or bodies return 400 with `{ error: "One sentence." }`.
All responses pass through the existing header contract; the CSP is unchanged.
Scene JSON is limited to 1 MiB and original photos to 256 MiB in the dev fixture.
PUTs can arrive before scene metadata; existing mask bytes are checked against dimensions when metadata arrives, and existing metadata is checked when mask bytes arrive.
The client writes binary assets before scene JSON; only ids with a scene appear in the list.
updatedAt in the list is the server's scene-write timestamp, independently of document.updatedAt.

In dev mode, tools/serve.mjs persists atomic files under `<results>/projects/<id>/`, serializing each id's reads, writes and delete.
scene.json contains the transport document, mask sizes, revision and server updatedAt; photo and thumbnail are binary, photo.json holds the content type, and masks/<asset> contains raw bytes.
Legacy fixture metadata without a revision reads as revision zero; new scene PUTs must supply the revision.
The existing path fault grammar accepts `/api/projects` for HTTP 500, slow, stalled, byte-inverted corrupt or connection-ending truncated API responses, including mutation acknowledgements.
Production mode exposes only the bodyless GET absence probe and writes no project files; every other method or path under `/api/projects` remains 404 until the hosted Worker supplies the API.
The local production server therefore cannot save projects before that Worker is connected.
test/serve-projects.test.ts exercises this contract through real HTTP, and projects.autosave is the real-page dev scenario.

The hosted Pages Worker dispatches `/api/projects` before its static route table.
One shared space has no login: Neon stores `projects(id, name, updated_at, scene, masks, revision)` and persistent `tombstones(id)`, while the `PROJECTS` R2 binding stores photo, masks and thumbnail beneath `projects/<id>/`.
Photos retain their original content type in R2 HTTP metadata and are limited to 24 MiB on the hosted API; the other byte limits match the fixture.
The Worker reuses the scene serializer, returns the transport revision with document and masks, and never includes the database timestamp in scene JSON.
Only completed scene rows appear in the list, ordered by server updated_at descending then id ascending; binary writes update that timestamp only after a scene exists.
Parameterized Neon HTTP queries use the pooled connection host's `/sql` endpoint with the connection string in `Neon-Connection-String`, never in an asset or response.
Scene upserts and deletion use a READ COMMITTED HTTP batch whose first statement obtains a per-id PostgreSQL transaction advisory lock, so revision/tombstone checks see the previous holder's committed work.
R2 cannot join that transaction: binary PUTs check tombstones before and after writing, and a late upload removes its prefix when deletion wins; tombstoned resources remain unreadable even during cleanup.
`deploy.mjs projects`, `migrate` and `secrets` are one-time Mac setup commands; migration is idempotent and the mode-600 `.local/cloudflare.env` supplies the Pages secret in both environments.
GitHub deployment runs the existing `verify.mjs` before promotion, including an isolated-id store round trip with binary equality, revision conflict, deletion and tombstone checks alongside the static/model contract.
`hosted.projects` exercises import, editing, save, reload, reopening and deletion through the production UI; it uses its own id and preserves other shared projects.

## Module map and the import graph

Each module under `src/` belongs to the module named by its top-level directory, and `src/main.tsx` is its own:

| Module | What it is | May import |
| --- | --- | --- |
| `main.tsx` | the app entry | anything but itself and `dev/` |
| `app/` | the composition root's types and shell | anything but `main.tsx` and `dev/` |
| `core/` | pure primitives | `core/` only |
| `platform/` | generic browser-facing modules | `platform/` and `core/ids.ts` only |
| `photo/`, `analysis/`, `render/`, `export/`, `store/`, `scenefile/` | the leaves | itself, `core/`, and `platform/`; `export/` also `import type { Renderer }` from `render/` and nothing else of it |
| `session/` | the open scene's lifecycle | `session/`, the leaves, `core/`, and `platform/` |
| `ui/` | the Preact screens | `ui/`, `session/`, and `core/` |
| `dev/` | dev pages and dev workers, entries nothing imports | `dev/`, `core/`, `platform/`, `analysis/`, `store/`, and `app/` through `import type` only |

Nothing imports `main.tsx`, only `main.tsx` and `app/` import `app/`, apart from the dev pages' type imports, and nothing outside `dev/` imports `dev/`.
Today `src/` holds `main.tsx`, `app/`, `core/`, `platform/`, `dev/`, `analysis/` (the model loader, the worker protocol, the depth input size, the stage functions, the known-answer checks, the ONNX Runtime module, the sequence worker, the decode worker, and the analysis service), `store/` (the schema, the connection, and the scene lock), and the worker stub under `export/`; the rules for the other modules apply to the first file that appears in each.

Packages are allowed only where these rules put them, and any other bare specifier, `node:` built-ins included, fails:

| Package | Who may import it |
| --- | --- |
| `zod`, and any `zod/...` path | `core/zod.ts` only |
| `preact`, and any `preact/...` path | `ui/`, `app/`, `main.tsx`, and `dev/` |
| `mediabunny` | `export/` |
| `noisy:vendor-ort` | `analysis/` and `dev/` |

A `.tsx` file counts as importing `preact`, because esbuild's automatic JSX transform imports `preact/jsx-runtime`, so only those four modules may hold one.

`test/support/import-graph.ts` exports `checkImportGraph(root)`, which reads every `.ts` and `.tsx` file under a source root, finds every static import, `export ... from`, dynamic `import()`, and `import('...')` type, resolves each relative specifier to a file, extension and case exact, and returns every violation with its file, line, and the rule it breaks.
`.d.ts` files are ambient declarations and are not read.
So an edge that exists only at the type level, outside a `.ts` or `.tsx` module's own imports, is not checked: an import inside a `.d.ts` file, a `/// <reference path>`, a `declare module` augmentation of a relative path, or a JSDoc `@import`; none of them adds a runtime import, and review is what catches one.
The files are parsed by the pinned TypeScript compiler through its API, `typescript/unstable/sync`, in one compiler process per check, with a project held in memory that lists the files and resolves nothing; the imports are the specifiers the compiler collects for each file (`SourceFile.imports`), and `readImports(root, files)` exposes them.
A file the compiler reports a syntax error in, a dynamic `import()` whose specifier is not a string literal, a `require()` call, and an import form the checker does not recognize are each reported as a violation.
An `import('...')` type is type-only, so it is allowed where `import type` is; `import { type X }` is not type-only, since `verbatimModuleSyntax` keeps it as a runtime import.
The API is marked unstable and may change in a later `typescript` release; the checker's use of it is type-checked by `tsconfig.test.json`, so such a change fails `npm run typecheck` or `test/import-graph.test.ts`.

`test/import-graph.test.ts` asserts that `src/` has no violation, and runs the checker on synthetic trees that break each rule: a leaf that imports `app/`, a `platform/` module that imports `analysis/`, a module that imports `zod` directly, and the rest of the table side by side with the edges it allows.
It also runs it on code a hand-written tokenizer misreads (a generic arrow function in `.tsx`, an `import()` after `...`, a `/` after `i++`), on files it cannot check, and on package names that are `Object.prototype` members.
A part that adds a package or an exception changes the tables in `test/support/import-graph.ts` and adds the violating case to the synthetic tree.

## Core

`src/core/` is pure: no browser global, no Node API, no I/O, no clock, and no compile-time constant, so node tests import it as it is.

- `ids.ts`: `Brand<T, B>`, the branded ids `SceneId`, `ObjectId`, `LightId`, `AssetId`, `ModelId`, `BuildId`, and `TabId`, `NonEmpty<T>`, and a check per id that brands a string: `isBuildId` (12 or more lowercase hex digits or `nocommit`, a hyphen, and 8 digits), `isTabId`, `isSceneId`, `isObjectId`, and `isLightId` (a lowercase UUID v4), `isAssetId` (64 lowercase hex digits), and `isModelId` (a lowercase letter, then lowercase letters, digits, and hyphens, `@`, and 64 lowercase hex digits).
- `result.ts`: `Result<T, E>`, and `ok(value)` and `err(error)`.
- `raster.ts`: `Size`, `Rect`, `ImagePoint`, `Oklab`, `Oklch`, `PlaneFormat`, `PlaneRef`, `ImageRef`, `Plane<F>`, and `Rgb8`, types only.
- `zod.ts`: the configured `z` (see "Response-header contract").
- `schema.ts`, `types.ts`, `ranges.ts`, and `migrate.ts`: the scene document and its parse chain (see "The scene document").
- `defaults.ts`: what a new scene, object, and light start with (see "Defaults").
- `edits.ts`, `reduce.ts`, and `fry.ts`: the owner's edits, the reducer that applies them, and the Fry curve (see "Edits and the reducer").
- `produce.ts`: analysis products and the dropped source (see "Products and the dropped source").
- `history.ts`: the undo history and the coalescing keys (see "The undo history").
- `equal.ts`: `sameValue`, structural equality over the values a document holds, which the reducer and the products use to tell whether anything changed.
- `derive.ts`: the derivations every later layer reads from a document, and `reconcile` (see "Derivations and reconcile").
- `motion.ts`: the loop crop's `PARALLAX_MARGIN` and `LOOP_ZOOM`, `effectiveOrbit`, and the motion math a loop is made of (see "Motion").
- `percentile.ts`: nearest-rank percentiles, the value at rank ceil(p n) of n values in ascending order, so the median of an even count is the lower middle value.
  `rank(values)` copies the values into a new `Float64Array`, which holds a float32 or a double exactly, sorts it, and refuses an empty input or a NaN; an infinity sorts to its end.
  `nearestRank(ranked, p)` takes `p` in (0, 1] and refuses any other; it takes p n as exact, so the rank is the least r from 1 to n with r / n >= p, and p 0.07 over 100 values is rank 7 where `Math.ceil(0.07 * 100)` is 8.
  `percentile(values, p)` is the two together; none of them writes to its input or throws.
  The depth stage's statistics are read through it (see "The stage functions"), and the renderer's hole fill is to read its median through it too, so the two agree.

## The scene document

Holding a stage pointer over an existing object for 350 ms without moving more than 8 CSS pixels starts selection refinement in `session/scene.ts`.
The session decodes the stored tap points once, orders its three soft masks by area, and maps selection `size` in 0..1 through the smallest, middle and largest candidates; each third passes through thresholds 192, 128 and 96 at its start, midpoint and end.
`session/refine.ts` remaps the chosen threshold onto the renderer's existing 128 crossing, and 120 CSS pixels left or right reaches the shrink or grow endpoint from the current size.
Legacy selections parse with size 0.5; a decoder choice outside the middle is preserved at its candidate's neutral size, with legacy .5 gestures anchored there until commit.
Frame-coalesced previews replace only the renderer's object products, leaving the document, layer thumbnail, plate and autosave unchanged; pointer up applies `object.refine` with recomputed statistics and a content-addressed mask, releases the old mask and allows the usual plate reconciliation and autosave.
Escape, returning to the starting size, a second pointer, lost capture, Reset or import discards the preview and retains the original document and mask.
The session exposes the live pointer size in page state as `refinementSize`, without changing the document or notifying autosave.
While the hold is live, the stage shows a 0..100 selection-size meter centered 12 CSS pixels below its top edge, including below the phone strip; release hides it immediately through the 140 ms opacity transition, even while commit finishes.
The meter reports refinement size, not mask area.
The renderer's final screen-selection compositor multiplies pixels outside the selected label toward deep blue (Oklab lightness reduced by 0.35, hue 260 degrees) at 55% strength, then retains the white boundary outline.
The selected interior is untouched, and each preview mask replaces the label input for this compositor on its next draw.
Still, stereo view and loop-frame exports disable this entire selection pass, so neither the dim nor the DOM meter enters their bytes.
The dev-only `selectionPixel` probe reads the actual final screen-pass RGB and its undimmed input at a master-space point, with row zero at the photo's top.

The scene document is the JSON a scene is stored and exported as.
Its shape has one owner, `core/schema.ts`, a zod schema; `core/types.ts` exports the types zod infers from it (`SceneDocument`, `Frame`, `Analysis`, `Style`, `SceneObject`, `Light`, and the rest) and declares none by hand.
The primitives the document is built from, `Size`, `Rect`, `ImagePoint`, `Oklab`, `Oklch`, `PlaneRef`, and `ImageRef`, stay `core/raster.ts`'s, and `test/schema.test.ts` checks at the type level that the document's fields of those types equal them.
The depth map and an object's mask are typed `PlaneRef`, with either `PlaneFormat`; the schema checks that the depth map's format is `f32` and a mask's `u8`, and fails any other at the field's `format`.

The schema is strict at every depth:

- Every object is a `z.strictObject`, so a key the schema does not name fails the parse, at its own path, and nothing is dropped; a parse of a valid document deep-equals its input.
- A union (`Harmony`, `Selection`, `Recolor`, `ObjectMotion`) is discriminated by `kind`, and each arm is strict, so a field of another arm is an unknown key.
- Ids are checked by `ids.ts`'s checks through `z.custom`, so a parsed id carries its brand because a check proved it.
- `createdAt` and `updatedAt` are ISO 8601 date-times in UTC (`z.iso.datetime()`, which refuses an offset).
- The parse returns a new document, frozen at every level (`.readonly()` on every object, array, and union).

### The ranges table

`core/ranges.ts` holds three tables, and the schema reads every numeric bound, and every bound on a string's or an array's length, from them.
`RANGES` maps the path of every numeric field bounded at both ends to `{ min, max, kind }`: both ends inclusive unless the entry sets `minExclusive: true`, which only the analysis's cluster weights do (every weight above 0), and `kind` one of `real`, `integer`, or `even-integer`.
`FLOORS` maps the path of every numeric field bounded below only to `{ min, kind }`, `kind` `real` or `integer`: the sizes in pixels, a mask's bounding box, and a source's byte length, which analysis measures and no slider sets.
`LENGTHS` maps the path of every bounded string and array to `{ min, max }`.
A string's length is counted in Unicode code points, as zod counts it and `[...text].length` does, so an emoji is one, though `text.length` counts it two; code that clamps or truncates a title or a name must count the same way, which also keeps it from splitting a surrogate pair.
A `NonEmpty<T>` array with no maximum, a tapped selection's `points`, takes its minimum of one from its type and has no `LENGTHS` entry.
A path joins object keys with dots and writes `[]` for every element of an array: `style.colors`, `lights[].color.c`, `objects[].produced.selection.points[].at.x`.
A field that more than one union arm holds has one path, such as `style.harmony.strength`.
Code that clamps a field or builds its slider looks the entry up by the field's path.
`clampToRange(path, value)` clamps a finite number to a `RANGES` entry, rounding it to a whole or even number first when the entry's kind says so, and returns a value already in range and on its grid as it is; its `path` is a `ClampPath`, a `RANGES` path whose minimum is inclusive, so the analysis's cluster weights are not one.

`test/schema.test.ts` converts the schema to JSON Schema (`z.toJSONSchema`), walks it, and checks every numeric field's bounds, minimum, exclusive minimum, maximum, integer, and multiple, against its `RANGES` or `FLOORS` entry, and a field with no entry against no bound at all; such a field must be named in the test's `UNBOUNDED_NUMBERS`, which holds the Oklab values and tone percentiles analysis measures.
It checks every string's and array's length bounds against its `LENGTHS` entry the same way, a field with no entry having no maximum and no minimum but a `NonEmpty<T>`'s one, and that no entry of any table is unused.
So a bound written into `schema.ts` without its entry, or changed there and not in the table, fails the test.
The test then sets every field of the five-cluster fixture that an entry covers past each end, at an exclusive minimum, and off its grid for an integer or even field, and every bounded string and array past its bounds, and checks that each fails at its own path.

Bounds the design states are taken from it.
The rest are this code's choice, and the tables are where they live:

- A palette target's and a recolor target's color: lightness 0 to 1, chroma 0 to 0.4 (above the largest Oklch chroma of any sRGB color, about 0.32), and hue 0 to 360.
- The depth statistics, the analysis's and each object's, 0 to 1, the range of the normalized depth map they are taken from.
- A tap point's and an automatic subject's seed coordinates, 0 to 1, inside the frame.
- An object's color cluster weights, 0 to 1.
- An object's name, 1 to 80 code points, like the title, and the original file's name, at most 255.
- The master's smallest side, 2, the smallest even size.
- A mask's bounding box, at least 0 in every field, and a source's byte length, a whole number of at least 0.

### Invariants

The schema also checks what the types cannot express, each failure reported at the path of the field that broke it:

- `frame.master.size` has even sides of at most 2048 (`RANGES`).
- Object ids are unique, and light ids are unique; a repeat fails at the later element's `id`.
- `analysis.plate.forMasks` is sorted; an id may repeat, since two masks with the same bytes have the same id.
- `motion.focus` is in 0 to 1 or null.
- At most 32 objects and 4 lights (`LENGTHS`).
- `style.paletteTargets` is sorted by cluster with each cluster once, every cluster an integer, and every cluster below the document's own `analysis.colors.length`.
- `selection.candidate` is an integer in 0 to 2.
- `analysis.colors` holds 1 to 16 clusters in descending order of weight, every weight above 0 (`RANGES`), the weights summing to 1 within `WEIGHT_SUM_TOLERANCE` (1e-4, exported by `schema.ts`).
- An object's color has 2 or 3 clusters whose weights sum to 1 within the same tolerance.
- The title is 1 to 80 code points, and `seed` is an integer in 0 to 2^32 - 1.

The cluster bound on palette targets reads two subtrees, so it is a refinement on the whole document.
zod runs it only when no issue has stopped it at a field it parses on the way: a field missing, of the wrong type, or not an allowed value (a literal such as `format` or `version`, an enum member, a union's `kind`, or an id its check refuses), a fraction where a whole number is required, or an array shorter than its minimum skips it.
`test/schema.test.ts` pins each case.
The other refinements, the order, uniqueness, and weight sums above, each sit on their own array; the remaining invariants are bounds from the tables.
Whether every `AssetId` the document names resolves is not checked by the schema alone.
The delivered shared Projects reader validates referenced photo/mask bytes and content hashes at its persistence boundary (see "Shared projects and the Projects API").
A portable scene-file archive remains a separate unbuilt format.

### The version

`core/migrate.ts` exports `Migration` (`(json: unknown) => unknown`, a total function from one version to the next), the `MIGRATIONS` tuple, and `SCENE_VERSION = MIGRATIONS.length`.
The current four migrations add Surface, Parallax amount, layer visibility/names, and Drift while preserving legacy circular Orbit behavior.
The tuple's literal length makes the current `SCENE_VERSION` and `SceneDocument['version']` literal `4`.
Appending a migration advances the version in the same edit, so the version and table cannot disagree.
A migration returns the document at the next version, its `version` field included, and the parse chain refuses one whose `version` is not the next (see "The parse chain").
For example, a migration that changes only version 0 to 1 is `(json) => ({ ...json, version: 1 })`, not the identity function, which the chain refuses.
A dev build may substitute another module for `migrate.ts` (`tools/build.mjs --migrations`, see "Build"); the substitute exports the same three names, and `test/fixtures/migrate-synthetic.ts` is the one the tests use (see "The synthetic migration chain").

### What a parse chain calls

`schema.ts` exports `sceneDocumentSchema(version)`, the document's schema with `version` as a literal, so that a migration table of any length yields a schema of its own version: `sceneDocumentSchema(table.length)` with a two-entry `as const` table parses and types documents at version 2.
`currentDocumentSchema` is `sceneDocumentSchema(SCENE_VERSION)`, and `SceneDocumentAt<V>` in `types.ts` is the type a schema of version `V` yields.
An issue that stops zod at a field also skips the checks above it that read that field, so a document broken in several places may report one problem at first and another once that one is fixed (see "Invariants").
`describeIssues(issues)` turns a failed parse's issues into one line that lists the path of every issue zod reported, `; `-separated, each as `<path>: <message>`, an unknown key as `<path of the key>: unknown key`; `formatPath(path)` writes one path, `objects[0].produced.mask`, quoting a key that is not an identifier, and `(document)` for the root.

`test/fixtures/documents.ts` holds the hand-written documents the node tests share: `minimalDocument()`, `fiveClusterDocument()` (five clusters, every product present, two objects, two lights, palette targets on clusters 1 and 3), `validDocuments()` (those two and a copy of the second with automatic harmony, so that together they hold every arm of every union and nullable field), `invalidVariants()`, each naming the path its failure must report, and `getAt`, `setAt`, and `withValues`, which change a document as JSON.

### The parse chain

`schema.ts` also holds the parse chain the store and the scene file will share.
It returns a `Result` and never throws for any JSON value; a value whose getters or proxy traps throw while it is read gets a `Result` too.

```ts
type ParseError =
  | { kind: 'not-a-scene' }
  | { kind: 'newer-version'; version: number; writer: BuildId | null }
  | { kind: 'invalid'; detail: string };

peekVersion(json: unknown): Result<{ version: number; writer: BuildId | null }, { kind: 'not-a-scene' }>;
parseDocumentWith<const M extends readonly Migration[]>(migrations: M): (json: unknown) => Result<SceneDocumentAt<M['length']>, ParseError>;
parseDocument: (json: unknown) => Result<SceneDocument, ParseError>;   // parseDocumentWith(MIGRATIONS)
```

`peekVersion` reads `format`, `version`, and `provenance.writer`, and ignores the rest.
`format` must be `'noisy-scene'` and `version` a whole number of at least 0, however large: the schema refines `z.number().nonnegative()` with `Number.isInteger`, because `z.int()` stops at `Number.MAX_SAFE_INTEGER`, and a larger version is newer, not a value that is not a scene.
Anything else, a negative or fractional version, a version that is a string, or a value that is not an object, is `not-a-scene`, and so is a value whose getters or proxy traps throw while `format` or `version` is read.
The writer is `provenance.writer` when that is a build id, and `null` when it is absent, is not one, or throws when read.

`parseDocumentWith(migrations)` builds `sceneDocumentSchema(migrations.length)` once and returns a function that, for each value:

1. Peeks; `not-a-scene` stops here.
2. Answers a version above `migrations.length` with `newer-version`, the version, and the writer, without reading anything but the peek's three fields.
3. Copies the value, arrays and objects all the way down, then runs `migrations[v]` on the copy for each `v` from the document's version up to `migrations.length - 1`, in order.
   `migrations[v]` must return the document at version `v + 1`, its `version` field included.
   A migration that throws, returns `null`, an array, or a primitive, or returns an object whose `version` is not `v + 1`, fails as `invalid` with the detail `migration <v> (version <v> to <v + 1>) threw <the error>`, `... returned no object`, or `... returned a document whose version is not <v + 1>`, and no later migration runs.
   A value that cannot be copied, because a getter or proxy trap throws or it nests deeper than the stack allows, fails as `invalid` before any migration runs.
   Because the migrations get the copy, a migration that writes to its argument never changes the caller's value; a document at the chain's own version is not copied, and the strict parse neither writes to it nor freezes it.
4. Parses the result with the strict schema; its issues become one `invalid` detail, `describeIssues`'s line, which lists every failing path, an unknown key at its own path.
   Nothing is dropped: a document with a key the schema does not name fails.
   A throw from inside the parse is `invalid` too, with the detail `the strict parse threw <the error>`.
   zod copies a field's issues into its parent with one spread call, so an array of enough malformed elements overflows the engine's limit on a call's arguments: under node 25.4, about 15,500 empty objects as `objects` are enough to throw a `RangeError`.

A document at the chain's own version runs no migration.
Because the peek comes first, a document at a version above the chain's is `newer-version` even when the strict schema alone would refuse it at `version`: `invalidVariants()`'s version-1 variant answers `newer-version` through `parseDocument`, and `invalid` through `currentDocumentSchema`.
The result's type is `SceneDocumentAt<M['length']>`, so a chain of two migrations yields documents typed at version 2.
`parseDocument` is the chain of `migrate.ts`'s table, and is what production code imports; a test passes another table to `parseDocumentWith`.
Nothing under `src/` outside `core/` imports either yet.

### The synthetic migration chain

`test/fixtures/migrate-synthetic.ts` stands in for `migrate.ts` with two migrations, so its `SCENE_VERSION` is 2.
`MIGRATIONS[0]` adds `analysis.legacyPlate`, `null` for a version-0 document, and `MIGRATIONS[1]` deletes it, so a version-1 document whose `legacyPlate` names an `ImageRef` is one whose migration drops an asset reference, and a version-0 document walks both.
Each writes the version it yields and builds new objects rather than writing to its input; a document with no `analysis` object keeps what it has, for the strict parse to refuse.
It exports `Migration` (as a type), `MIGRATIONS`, and `SCENE_VERSION`, the names `migrate.ts` exports, and it imports from `migrate.ts` only that type, which esbuild erases.

Under node, `test/parse.test.ts` passes its `MIGRATIONS` to `parseDocumentWith` directly, and checks at the type level that the module has `migrate.ts`'s shape: the same export names, the same `Migration`, and a `SCENE_VERSION` typed as its table's literal length.
In the browser, a dev build given `--migrations test/fixtures/migrate-synthetic.ts` loads it wherever an import resolves to `src/core/migrate.ts`, so `parseDocument` and `currentDocumentSchema` run on the two-migration table.
That build refuses today, because no entry under `src/` imports `core/migrate.ts` yet (see "Build").

## Defaults

`core/defaults.ts` holds what a new scene, object, and light start with.
The values are written into the document when it is made, so changing a default later never changes a saved scene.
Ids, the time, and the seed are arguments: nothing in the module mints an id, reads a clock, or draws a random number.

- `newDocument({ id, title, now, seed, frame, analysis, writer, importedOn })` returns a `SceneDocument` at `SCENE_VERSION` with `createdAt` and `updatedAt` both `now`, no objects or lights, and the four defaults below; it does not validate, and the caller's parse is what checks it.
- `defaultStyle()`: `fry` 0.6 and the eight fields the macro dial sets at that position, `colors` 7, `saturation` 0.62, `simplify` 0.52, `bands` 4, `grain` 0.52, `colorNoise` 0.32, `crunch` 0.42, and `clipping` 0.3, stored as literals; then `harmony` automatic at strength 0.5, no palette targets, `outline` 0.4, `subjectClarity` 0.6, and `grainSize` and `grainHold` 2.
- `defaultSymbols()`: off, `cellSize` 12, `amount` 0.3.
- `defaultMotion()`: off, `orbit` 0.6, `loopSeconds` 3, `focus` null.
- `defaultLighting()`: `ambient` 0.7, `relief` 1.
- `newObject({ id, produced, existing })`: `subject` false, `recolor` none, `symbols` `'slider'`, `motion` none, `thickness` 0.3, and the name `nextObjectName(existing)` gives, `Object N` for the smallest N from 1 up that no existing object has.
  Making the first object the subject when the scene has none is left to the edit that adds it (see "Edits and the reducer").
  The selection, with its candidate index, is part of `produced`, which the caller passes in.
- `newLight({ id, at })`: `depth` 0.8, white (`l` 0.95, `c` 0, `h` 0), `intensity` 1, `radius` 0.6, `rays` 0.3, shadows on, `softness` 0.3.

`defaultStyle`, `defaultSymbols`, `defaultMotion`, and `defaultLighting` return fresh objects on each call, so no two scenes share their settings.
The values passed in, such as `frame`, `analysis`, `produced`, and `at`, are placed in the result as they are, not copied.

## Edits and the reducer

`core/edits.ts` declares what changes a scene document, and `core/reduce.ts` applies the owner's edits.
Both are pure: the time arrives as an argument, and nothing reads a clock or draws a random number.

An `Edit` is one of the owner's actions, and every edit is undoable.
A `Produce` is an analysis result (`depth`, `plate`, `object.depth`, or `auto-subject`), which the analysis driver applies with `core/produce.ts` and which never enters the undo history (see "Products and the dropped source").

```ts
applyEdit(doc: SceneDocument, edit: Edit, now: string): EditResult;
applyEdits(doc: SceneDocument, edits: NonEmpty<Edit>, now: string): EditResult;

type EditResult =
  | { kind: 'applied'; doc: SceneDocument; inverse: NonEmpty<Edit> }
  | { kind: 'unchanged'; doc: SceneDocument }
  | { kind: 'refused'; doc: SceneDocument; reason: RefusalReason; detail: string };
```

An applied edit returns the new document, with `updatedAt` set to `now`, and its inverse list.
Applied in order to the new document with `applyEdits`, the inverse list restores the input document in every field but `updatedAt`.
`now` must be ISO 8601 in UTC, as `Date.prototype.toISOString` writes it, since the schema requires that form; the reducer does not check it.
A refused edit returns the input document itself, the same object, unchanged and with `updatedAt` as it was, and has no inverse, so it belongs on no undo history.
`applyEdits` applies a list in order as one step, the form an undo or redo entry takes.
Its inverse undoes the last edit first and holds the inverses of the edits that changed the document only.
A list whose edits are all unchanged is unchanged, and if any edit of the list is refused, the whole list is: the result holds the input document, and the detail names the refused edit's index.

The input document is never written to.
The output shares with the input every field and list element the edit does not set, at every depth: a style patch of `saturation` returns the same `analysis`, `objects`, `lights`, `style.harmony`, and `style.paletteTargets`, and an `object.set` of `thickness` returns the same `produced` for that object and the same object for every other one.
A value the edit sets is a copy the reducer made, so the caller's patch can change afterwards without reaching the document.

An edit that leaves the document as it was is unchanged: an empty patch, a patch that sets each of its fields to the value it holds, a number that clamps to the value the field holds, a title equal to the current one, a `fry` at the stored position while the style holds the curve's values for it, a `palette.target` that clears a cluster with no target or sets the cluster number and color a target holds, or an `object.refine` to the `produced` the object holds.
The reducer tells from the fields the edit sets, comparing each with `sameValue` (`core/equal.ts`), and never compares whole documents.
An unchanged edit returns the input document itself, unstamped, and no inverse, so a caller has no undo step to record and nothing to save.
An `object.set` that sets an object's motion to the one it holds is unchanged when that motion is `none` or the scene's motion is on; when the motion is another kind and the scene's motion is off, the edit turns the scene's motion on, and is applied.
`sameValue` compares numbers with `Object.is`, so a `-0` where `0` is stored is a change, and is applied, which keeps the round trip exact.

### What each edit does

| Edit | Effect | Inverse |
| --- | --- | --- |
| `title` | sets the title | `title` with the previous title |
| `style` | lays a patch over the style; the patch may carry `fry`, which stores the dial's position and changes no other field | `style` with the previous values of the patched fields |
| `fry` | sets `fry`, and writes `fryCurve(fry)`'s eight values into the style | one `style` patch with the nine previous values |
| `symbols`, `motion`, `lighting` | lays a patch over that part of the document | the same kind with the previous values |
| `palette.target` | sets the target of one cluster, or clears it when `color` is null, keeping the list sorted by cluster | `palette.target` with the previous color, or null when the cluster had none |
| `object.add` | appends the object; when no object in the scene is the subject, it becomes the subject | `[object.remove]` |
| `object.set` | lays a patch over one object | `object.set` with the previous values; when the patch sets `motion`, then `motion { enabled }` with its previous value |
| `object.rename` | sets a nonempty layer name | `object.set` with the previous name |
| `object.hide`, `object.show` | sets layer visibility | the opposite visibility edit |
| `object.refine` | replaces what analysis produced for one object, its selection and mask together | `object.refine` with the previous `produced` |
| `object.remove` | removes one object; nothing else changes, `motion.focus` included | `[object.add]` alone, with `restore` |
| `light.add` | appends the light | `[light.remove]` |
| `light.set` | lays a patch over one light | `light.set` with the previous values |
| `light.remove` | removes one light | `[light.add]`, with `restore` |

Two edits have a side effect, and an inverse edit captures each:

- An `object.set` that gives an object a motion other than `none` turns the scene's motion on (`motion.enabled` true).
  Either the edit or its primary inverse can do that, since setting a moving object to `none` has an inverse that sets its motion back, so every `object.set` whose patch sets `motion` has the inverse `[object.set { motion }, motion { enabled }]`, the trailing edit applied after the primary one.
- An ordinary `object.add` into a scene where no object is the subject marks the added object `subject: true`.
  The inverse, `object.remove`, takes the flag away with the object.

`object.add` and `light.add` may carry `restore: { index }`, and only the inverse of a removal sets it.
A restoring add puts the object or light back at the index it had, so that undoing a removal restores the order of the list, and it has no side effect, so that an object that was not the subject comes back as it was.
The index is rounded and clamped to the list.

Patches only set fields the owner sets.
A `style` patch never carries `paletteTargets`, which have their own edit; an `object.set` patch never carries `id` or `produced`, so only `object.refine` changes what analysis produced; a `light.set` patch never carries `id`.
No edit changes an `analysis` field.

### Clamping and refusals

Every number an edit sets is brought into its `RANGES` entry by `clampToRange` (see "The ranges table"): rounded to a whole number for an `integer` field and to an even one for an `even-integer` field, then held between the entry's ends.
That covers every field of the style, symbols, motion, and lighting, a palette target's and a recolor target's color, an object's motion amount and thickness, and every number of a light, whether an edit patches it or adds it with an object or a light.
What analysis produced for an object is not clamped: `object.add` and `object.refine` refuse a `produced` the schema refuses.

The reducer is typed, but the session will pass the UI's patches through to it, so it checks them again at runtime.
Each patch kind has a table of the keys it may set, with a coercer per key, and a key outside the table refuses the patch.
After coercion the changed part of the document, the style, the symbols, the motion, the lighting, one object, or one light, is parsed by its strict schema from `core/schema.ts`, and a failure refuses the edit with the schema's paths in the detail.
So the result of an edit on a valid document is always a valid document.

A refused edit changes nothing and carries one of these reasons:

- `non-finite`: a number the reducer clamps is NaN or infinite, or so is a palette target's cluster or a restoring add's index; such a value is refused, never clamped and never stored.
  A NaN or an infinity inside an object's `produced`, which is not clamped, is refused as `invalid` by the schema instead.
- `unknown-key`: a patch has a key it may not set.
- `invalid`: a value of the wrong type, a title or name outside 1 to 80 code points, an unknown key inside a value, an object's `produced` with a `selection.candidate` outside 0 to 2, or anything else the schema refuses.
- `unknown-id`: no object or light has the id an `object.set`, `object.refine`, `object.remove`, `light.set`, or `light.remove` names.
- `duplicate-id`: an object or light with the added one's id exists.
- `limit`: the scene already holds 32 objects or 4 lights (`LENGTHS`).
- `out-of-range`: a palette target's cluster is not a whole number from 0 up to `analysis.colors.length - 1`; a color out of range is clamped instead.

A cluster of -0 is the cluster 0, as `===` compares them.
A `palette.target` sets its target outright, the cluster number as given, so a target given -0 where the entry holds 0, or 0 where it holds -0, is a change, as any other `-0` is; the inverse carries the replaced or cleared entry's own number, so undoing it never swaps one zero for the other.

### The Fry curve

`core/fry.ts` exports `fryCurve(f)`, the macro dial's mapping from one number to the eight fried style fields, `FRIED_FIELDS`, and the curve's two ends, `FRY_AT_0` and `FRY_AT_1`.

| Field | at 0 | at 1 |
| --- | --- | --- |
| `colors` | 12 | 4 |
| `saturation` | 0.2 | 0.9 |
| `simplify` | 0.1 | 0.8 |
| `bands` | 6 | 3 |
| `grain` | 0.1 | 0.8 |
| `colorNoise` | 0.05 | 0.5 |
| `crunch` | 0 | 0.7 |
| `clipping` | 0 | 0.5 |

Between the ends each field is interpolated linearly, with `f` clamped to 0 to 1 first.
`colors` and `bands` are rounded to whole numbers, as their ranges require, and the other fields to six decimal places, so that the ends and the default position give exactly their literal values: unrounded, `0.2 + (0.9 - 0.2) * 1` is `0.8999999999999999` in doubles.
At 0.6 the curve gives the values `defaultStyle()` stores (see "Defaults"), and `test/fry.test.ts` holds the two equal.
The `fry` edit writes the curve's values as absolute numbers, so a stored scene never depends on the curve, and changing the curve later changes no saved scene.

## Products and the dropped source

`core/produce.ts` applies analysis products, and drops a scene's source.
Neither is an edit: neither has an inverse or enters the undo history.

```ts
applyProduce(doc: SceneDocument, product: Produce, now: string): ProduceResult;
dropSource(doc: SceneDocument, now: string): SceneDocument;
sortedMasks(doc: SceneDocument): readonly AssetId[];

type ProduceResult =
  | { kind: 'applied'; doc: SceneDocument }
  | { kind: 'unchanged'; doc: SceneDocument }
  | { kind: 'refused'; doc: SceneDocument; detail: string };
```

An applied product returns the new document with `updatedAt` set to `now`.
An unchanged or refused one returns the input document itself, unstamped.
A product the document has moved past is unchanged, so a result that lands late never undoes what the owner did after it was asked for:

| Product | Effect | Unchanged when |
| --- | --- | --- |
| `depth` | replaces `analysis.depth`, whatever it held | it equals the depth stored |
| `plate` | replaces `analysis.plate` | its `forMasks` differs from `sortedMasks(doc)`, the objects' mask ids sorted, repeats kept; or it equals the plate stored |
| `object.depth` | replaces `produced.depth` of the object with the id, statistics or null | no object has the id; or the object holds those statistics |
| `auto-subject` | sets `analysis.autoSubject` to `done`; when the scene has no object and `found` is not null, adds `found` as the only object, with `subject` true, and when any object exists, drops `found` | `autoSubject` is already `done` |

Every value a product writes is parsed first by its strict schema from `core/schema.ts`, `depthProductSchema`, `plateProductSchema`, `objectProducedSchema`, or `sceneObjectSchema`, so a product applied to a document that parses yields one that parses.
A product whose value fails is refused, with the failing paths in `detail`; it is not clamped, since the driver builds products from typed replies and a failure means the reply was wrong.
A `plate` is checked before the mask sets are compared, so an unsorted `forMasks` is refused even when it is stale.
The input document is never written to, and the output shares with it every field the product does not set.

Since no edit changes an `analysis` field, an edit's inverse list still restores the document after a product has applied in between: undo after `depth` lands keeps the new depth.
The inverses of `object.refine` and of `object.remove` carry a whole `produced`, so undoing either restores the object's depth statistics as they were when the edit applied.

`dropSource` sets `frame.source` to null and stamps `updatedAt` with `now`, whatever the source was.

## The undo history

`core/history.ts` holds the undo history the session keeps while a scene is open; it is never persisted.

```ts
type HistoryEntry = { key: string | null; at: number; forward: NonEmpty<Edit>; inverse: NonEmpty<Edit>; masks?: ReadonlyMap<AssetId, Plane<'u8'>> };
type History = { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] };
type HistoryStep = { edits: NonEmpty<Edit>; history: History };

EMPTY_HISTORY: History;
HISTORY_LIMIT = 50;
COALESCE_WINDOW_MS = 600;
coalesceKey(edit: Edit): string | null;
push(history: History, entry: HistoryEntry, doc: SceneDocument): History;
undo(history: History): HistoryStep | null;
redo(history: History): HistoryStep | null;
referencedAssets(history: History): ReadonlySet<AssetId>;
```

Both stacks list their entries oldest first.
Only edits enter the history: `HistoryEntry` holds edit lists, and a product or a dropped source has no inverse to push.
Times are milliseconds on a clock the session passes in.

The session pushes an edit only when `applyEdit` answered `applied`, as `{ key: coalesceKey(edit), at, forward: [edit], inverse }` with the document that edit produced; an unchanged edit has no inverse and is no step.
`push` clears the redo stack.
When the last undo entry has the same key, the key is not null, and the new entry's `at` is 0 to 600 ms after the last entry's, the two become one entry, which keeps the earlier inverse and takes the later forward and the later `at`; so a drag of any length is one step while each move follows the one before within the window.
If `applyEdits` answers that earlier inverse `unchanged` on the document, the drag has returned its fields to where they started, and the entry is dropped instead of kept, so no step that undoes nothing stays on the stack.
The entry that dropping it leaves on top is closed, as after an undo, so the next edit starts a step of its own rather than joining one taken before the dropped drag.
Otherwise the entry is added, and past 50 entries the oldest is dropped.

For undo, the session calls `undo(history)`, applies `step.edits`, the last entry's inverse, with `applyEdits`, and keeps `step.history`, in which that entry has moved onto the redo stack.
`redo(history)` is the same with the last redo entry's forward, moving it back onto the undo stack.
Both return null when their stack is empty.
Each closes the entry it leaves on top of the undo stack, setting its key to null, so the next edit starts a step of its own instead of joining one taken before the undo or the redo.
Since a push adds at most one entry and clears the redo stack, and undo and redo only move entries between the stacks, the two stacks together never hold more than 50.

`coalesceKey` gives the key consecutive edits coalesce under, or null for an edit that is always a step of its own:

| Edit | Key |
| --- | --- |
| `title` | `title` |
| `style`, `symbols`, `motion`, `lighting` with a one-field patch | `<kind>:<field>`, such as `style:saturation` |
| `fry` | `fry` |
| `palette.target` | `palette.target:<cluster>`; `String(-0)` is `0`, so -0 and 0 share the key of cluster 0 |
| `object.set` with a one-field patch | `object.set:<id>:<field>`, but null for a patch that sets the object's motion to `none` |
| `light.set` with a one-field patch | `light.set:<id>:<field>` |
| a patch of several fields or none, `object.add`, `object.refine`, `object.rename`, `object.hide`, `object.show`, `object.remove`, `light.add`, `light.remove` | null |

Every edit under one key sets the same fields, and sets them to the same stored value whatever they held before, which is what makes the last forward of a coalesced entry redo the whole entry and its first inverse undo it; `palette.target` qualifies because it sets the cluster number outright as well as the color.
Two sliders, two swatches, or two fields of one light therefore keep their own steps within the window.
An `object.set` to motion `none` is its own step because the edits before it under the same key may have turned the scene's motion on, which its forward alone would not redo.

`referencedAssets` lists every asset a mask in the history names: the mask of each `object.add` and each `object.refine` in any entry's forward or inverse list, on either stack, which includes the inverse of every `object.remove`.
The session keeps these mask planes in the history entries while the scene is open, so any undo or redo restores its mask; an asset referenced only by an entry that was dropped past 50 is no longer listed.

## Derivations and reconcile

`core/derive.ts` holds what every later layer derives from a scene document.
Every function is pure: no browser global, no Node API, no I/O, no clock, and no randomness.

```ts
type Layer = { kind: 'plate' } | { kind: 'object'; object: SceneObject };

layers(doc: SceneDocument): NonEmpty<Layer>;
maskCovers(mask: Plane<'u8'>, at: ImagePoint): boolean;
labelAt(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, at: ImagePoint): ObjectId | null;
holeMask(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, size: Size): Plane<'u8'>;
plateNeeded(doc: SceneDocument): boolean;
anchorDisparity(doc: SceneDocument): number | null;
parallaxClamp(doc: SceneDocument): number;
cameraRadius(doc: SceneDocument): number;
objectMotionBound(doc: SceneDocument, id: ObjectId): Vec2;
assetRefs(doc: SceneDocument): ReadonlySet<AssetId>;
reconcile(doc: SceneDocument, cache: CacheIndex, blocked: ReadonlySet<AnalysisOp>, intent: Intent): readonly Need[];
NEED_OPS: Readonly<Record<Need['kind'], readonly AnalysisOp[]>>;
```

### The draw order

`layers` returns the plate's layer first, then one layer per visible object.
The objects are sorted far to near by `produced.depth.median`, a disparity in which 0 is the farthest point and 1 the nearest, so a smaller median draws earlier.
An object whose depth statistics are null sorts nearest, after every object that has them.
Objects with the same median, or with null statistics, keep their order in `doc.objects`.

Containment overrides depth.
An object draws after another when more than half of its bounds' area lies inside the other's bounds and no more than half of the other's area lies inside its own.
Exactly half is not more than half, so an object exactly half inside another keeps its depth order.
Two boxes that each lie more than half inside the other constrain neither way, whatever their areas (which differ by less than a factor of 2), so their depth order decides between them.
The two conditions together make the inner box's area strictly smaller than the outer's, so the relation can have no cycle.
The objects are then placed one at a time, each step placing the first object, in depth order, that no unplaced object contains, so the result is the same for the same document every time.
A chain of containers draws outermost first.
Containment can reorder objects it does not relate: when a far object waits on a near container, an object between them in depth that no box contains or is contained by is placed first, ahead of the farther object.
No order can keep every depth pair in that case, and this one is fixed by the rule above.

### Which layer a point belongs to

`maskCovers(mask, at)` reads a mask at a frame point.
For a `w x h` mask the point `(at.x, at.y)` lies at `(at.x w - 0.5, at.y h - 0.5)` in texel coordinates, where texel centers lie at whole numbers.
The two nearest texels on each axis are clamped to the mask's edge and weighted bilinearly, and the value is compared with 0.5, that is 128 of 255.
A value of exactly 128 is covered, so a point midway between texels of 120 and 136 is covered, one midway between 120 and 134 reads 127 and is not, and a point at `u` 0 reads the edge column's own value.

The rule is defined on the quantized point.
Its fraction of a texel on each axis is rounded to the nearest 1/65536 of a texel, and the weighted sum is formed from those whole-number weights and the byte values, so it is a whole number (at most 255 * 2^32, exact in a double) compared exactly with 128 * 2^32.
A point whose fraction is a whole multiple of 1/65536, a point midway between two texel centers among them, reads the exact bilinear value, since floating error in computing its position is far smaller than the rounding step: on a 49-texel row, `1/49 * 49` is `0.9999999999999999`, and the point `u = 1/49`, midway between texels 0 and 1, still reads their exact mean.
Elsewhere the value read can differ from the exact bilinear value at the unrounded point by up to half a step of weight on each axis, and a point whose computed fraction lands within floating error of a half step can round either way, so the rule is reproduced bit for bit only by the same arithmetic.
A point past the frame reads the clamped edge, and the point is clamped to the outer texel centers before its taps are taken, so a finite coordinate whose product with the mask's size overflows still reads the edge; a point with a non-finite coordinate is covered by no mask.

`labelAt` returns the object of the last layer in `layers(doc)` whose mask covers the point, or null, the plate, when none does.
The renderer uses the shared layer ordering and CPU mask coverage when building labels, and session hit testing uses `labelAt`.
GPU filtering need not agree with the CPU rule bit for bit within a texel of a 0.5 crossing.
An object whose mask the map does not hold covers nothing, here and in `holeMask`.

### The hole mask

`holeMask(doc, masks, size)` returns a `u8` plane of `size`, 255 inside the hole and 0 outside.
A texel is in the union when some object's mask covers the texel's center, `((x + 0.5) / width, (y + 0.5) / height)`, by `maskCovers`'s rule, so at another size the union is the masks resampled by that rule, not a nearest copy.
The union is then grown by a disc whose radius is 1% of the long edge of `size`, rounded up to whole texels: `ceil(max(width, height) / 100)`, 21 at 2048 and 4 at 301.
A texel is in the result when its Euclidean distance to a texel of the union is at most that radius.
The distance is computed with the exact two-pass distance transform of Felzenszwalb and Huttenlocher (a row pass, then the lower envelope of parabolas down each column), every compared distance a whole number, so the result equals a brute-force disc byte for byte, which `test/derive.test.ts` checks.

### The plate, the anchor, and the assets

`plateNeeded(doc)` is true when the scene has a hidden object or enabled Motion moves a layer, and the current mask ids differ from `analysis.plate.forMasks` or no plate exists.
Hidden masks remain part of that freshness comparison and the inpaint hole.
With motion off a loop is the still's scene with moving grain, so an object's motion counts only while `motion.enabled` is on; an `object.set` that gives an object motion turns it on (see "Edits and the reducer"), but a later `motion { enabled: false }` turns it off with the object's motion kept.
A loop at `orbit` 0 with no object motion moves no layer under the identity camera and needs no plate.

`anchorDisparity(doc)` is `motion.focus` when it is not null; else the depth median of the first object marked `subject`, when that object has depth statistics; else `analysis.depth.stats.median`; else null.

`parallaxClamp`, `cameraRadius`, and `objectMotionBound` are the document's side of the motion math (see "Motion").

`assetRefs(doc)` is every asset the document references: `frame.source` when it is kept, `frame.master`, the depth map, the plate's image, and every object's mask.
A plate's `forMasks` names asset ids too, but it records which masks the plate was made for, for comparison, and every one of them still in use is an object's mask, so it is not a reference.
`test/derive.test.ts` finds, in the schema's JSON Schema, every field the schema checks with a custom check, as it checks every id, requires the five-cluster fixture to hold a value at each, and fails when an `AssetId` field is neither read by `assetRefs` nor named as not a reference.
The walk follows `properties`, `items`, `prefixItems`, `anyOf`, `oneOf`, and `allOf`, and throws on a `$ref` or on any other keyword holding an object, such as the `additionalProperties` schema of a record, so a field added to the schema later cannot be missed silently: the test either checks it or fails until the walk is extended.

### Reconcile

`reconcile` lists what the document is missing or holds stale, as a plan in dependency order: `depth`, `encode`, `auto-subject`, `plate`.

```ts
type AnalysisOp = 'depth' | 'encode' | 'decode' | 'inpaint';
type Intent = { objectsActive: boolean; tapPending: boolean };
type CacheIndex = { embeddings: boolean };
type Need = { kind: 'depth' } | { kind: 'encode' } | { kind: 'auto-subject' } | { kind: 'plate'; forMasks: readonly AssetId[] };
```

`intent.objectsActive` is the UI's, true while the Objects tab is open, and `intent.tapPending` the analysis driver's, true while a tap waits on embeddings that do not exist yet.
`cache.embeddings` says whether the driver holds embeddings for `frame.master.asset`; `encode` fills that cache, not the document.

- `depth` when `analysis.depth` is null.
- The subject is wanted when `analysis.autoSubject` is `pending`, the scene has no object, and depth exists or is listed.
- `encode` when the cache lacks embeddings and the subject is wanted, or `intent.objectsActive`, or `intent.tapPending`.
- `auto-subject` when the subject is wanted and embeddings exist or `encode` is listed.
- `plate`, with `forMasks` the current `sortedMasks(doc)`, when `plateNeeded(doc)`.

`NEED_OPS` names the operations each need runs: `depth` runs `depth`, `encode` runs `encode`, `auto-subject` runs `encode` and `decode`, and `plate` runs `inpaint`.
A need any of whose operations is in `blocked` is omitted, and "listed" above means listed after that omission.
So a blocked `depth` unlists the guess and the encoder run that existed only for it, and a fresh document with `depth` blocked yields nothing until the owner shows intent, then `[encode]`.
A blocked `decode` omits `auto-subject` but not the `encode` the wish for a subject lists.
A fresh document yields `[depth, encode, auto-subject]`.
In every plan each listed need's inputs exist or are listed before it: `auto-subject` follows depth and embeddings, and `plate` is listed only with objects, whose masks are its input.
Timing (debounce, cooldown, visibility) is the driver's.

The owner's first object ends the guess: `auto-subject` requires an empty object list, and once the analysis driver applies `{ kind: 'auto-subject', found: null }` after the first object the owner adds, `autoSubject` is `done`, so removing or undoing that object never lists the need again.
`applyProduce` refuses an `auto-subject` whose `found` fails its schema and leaves `autoSubject` `pending` (see "Products and the dropped source"); `reconcile` then lists `auto-subject` again whenever its conditions hold, and it is the analysis driver, not `reconcile`, that is to apply `found: null` after a refused guess so that the need is not listed over and over.
The driver is not built yet.

## Motion

`core/motion.ts` holds the loop crop and the motion math a loop is made of, and no other module writes the crop.
`core/derive.ts` holds the three functions that read a document for it: `parallaxClamp`, `cameraRadius`, and `objectMotionBound`.
Every function is pure: no browser global, no Node API, no I/O, no clock, and no randomness.

```ts
type Vec2 = { x: number; y: number };

// core/motion.ts
PARALLAX_MARGIN = 0.02;  LOOP_ZOOM = 1 / (1 - 2 * PARALLAX_MARGIN);
effectiveOrbit(motion: Motion): number;
frameCount(motion: Motion, fps: number): number;
loopPhase(frame: number, count: number): number;
cycleTurn(cycles: number, phase: number): number;
cameraOffset(radius: number, phase: number, direction?: Motion['drift']['direction']): Vec2;
parallaxReach(anchor: number): number;
parallaxDisplacement(offset: Vec2, disparity: number, anchor: number): Vec2;
bobOffset(amount: number, boundY: number, height: number, phase: number): number;
swayAngle(amount: number, boundX: number, phase: number): number;
swayDisplacement(at: Vec2, angle: number): Vec2;
wobbleDisplacement(amount: number, boundX: number, boundY: number, height: number, u: number, v: number, phase: number): Vec2;
objectDisplacement(motion: ObjectMotion, bound: Vec2, bounds: Rect, at: Vec2, phase: number): Vec2;
motionBound(motion: ObjectMotion, bounds: Rect, frame: Size): Vec2;

// core/derive.ts
parallaxClamp(doc: SceneDocument): number;
cameraRadius(doc: SceneDocument): number;
objectMotionBound(doc: SceneDocument, id: ObjectId): Vec2;
```

The renderer evaluates `cameraOffset` and `parallaxDisplacement` on the CPU and sends displacement endpoints to its geometry vertex shader.
The per-object bob, sway, and wobble formulas exist in core but are not animated by this renderer; the UI therefore exposes no Sway control.

### Object coverage in the renderer

The hard geometry pass writes source color, labels, and disparity with the original mask threshold.
A fourth attachment holds styled color composited from the plate upward in layer order.
Each layer reuses the existing palette and outline or Symbols passes, then a color-only geometry draw feathers its coverage inward over two master pixels with a radius-two triangular kernel.
Every kernel sample thresholds the mask before filtering, keeping the radius in master pixels even when the mask is smaller than the master.
This ordering keeps palette quantization and glyph filling from discarding coverage.
The color draw tests equal to the hard pass's resolved depth, disables depth writes, and blends RGB while retaining opaque output alpha, so folds cannot blend twice and hard labels/disparity remain unchanged.
Selection's white boundary still reads the hard labels after the downstream effects.
The shared path serves loop preview, frame PNG, GIF/movie capture, stereo views, and stills with hidden objects; ordinary stills keep their existing path and pixels.
The additional styling work scales with visible object count; no new shaders duplicate palette or glyph math.
The dev renderer exposes `motionCamera()` and `setMotionFeather()` for direction readback and comparison with the preceding hard compositor.

### Loop exports

With Motion enabled, the Motion node and phone sheet offer `export-gif` and `export-movie`.
`session/scene.ts` owns the export job and its progress, separate from analysis and document state.
The existing Preparing pill prioritizes `exportProgress` on desktop and phone.
A new export, import intent (including project open), Reset, document edit, refinement or renderer teardown aborts the job.
Only the current job for the same document can save a file or clear its progress.
An export failure becomes one status sentence and keeps the document intact.

The existing renderer `exportStill` accepts an optional `{ frame, canvas }` capture.
It renders the exact integer loop frame without selection, synchronously copies the stage to the output canvas, and restores its previous frame and camera in `finally` before the next paint.
The output is scaled from the master's render into a canvas at 640 px long-edge for GIF and capped at 1080 px for movie; the master-sized render targets and all shader math stay unchanged.
Live Parallax, selection dim, Debug and UI overlays do not enter these frames.
Movie uses the loop's 30 fps; GIF samples the whole period at a nominal 15 fps, excluding the duplicate endpoint.
For a period with a fractional GIF frame count, the rounded frame count is distributed uniformly over the existing loop frames and its delays preserve the exact period.

`session/loop.ts` transfers one `ImageData` buffer per frame to a dedicated gif worker and waits for its acknowledgement before drawing another.
The worker's Zod-validated protocol is `start`, `frame`, `finish`, with `ready`, `progress`, `done` and `failed` replies.
Worker errors, invalid replies and a 30-second response timeout fail the job; every exit terminates the worker.
`export/gif.ts` retains exact colors up to 256, otherwise uses a bounded RGB histogram and weighted median-cut palette for each frame.
The pure encoder writes GIF89a, local 256-entry palettes, LZW with dictionary reset, opaque full-frame disposal, and the NETSCAPE infinite-loop extension.
GIF frame delays use cumulative centisecond rounding with 6 and 7 centisecond delays, preserving the period at its reduced frame rate.
The resulting file is `<title>-loop.gif`.

Movies prepare exact frames as PNG blobs, with a 128 MiB compressed-memory ceiling, before starting `MediaRecorder` on a separate canvas populated from the stage exports.
This keeps renderer cost out of the recording clock and prevents selection or preview redraws entering the stream.
At most three decoded frames are held as bitmaps; all bitmaps and stream tracks are released on success, cancellation or failure.
Continuous Motion and Parallax preview draws pause only during recording; document edits abort recording and normal draws resume immediately.
Recording requests capture frames explicitly when the browser supports it and uses absolute wall-clock deadlines, holds the final available frame until the period ends and skips to the current loop time when capture falls behind.
An independent timer stops the recording at the period boundary even when a frame decode remains pending; skipped bitmaps close when their decode resolves.
MediaRecorder is a real-time API, so browser scheduling and codec timestamps remain a limit; this is not an offline muxer.
Safari prefers supported MP4/H.264, Chromium prefers supported WebM/VP9 then VP8, with the other supported container as fallback.
The button names the selected container and disables with an explanatory title when recording is unavailable.
The file is `<title>-loop.mp4` or `<title>-loop.webm`.

`test/gif.test.ts` decodes exact small frames and stresses LZW growth/reset, quantization and loop delays.
`export.loop` captures actual download blobs, decodes the GIF in-page, compares selected and unselected animation bytes, checks movie decoding and duration, exercises cancellation/failure paths and captures the desktop and phone export row.

### Live Parallax

PX10 merged into the demo at `ab48fa1` on 2026-10-10.
The live path reconstructs a bounded surface from the photo's inferred depth and uses off-axis perspective projection; it does not reconstruct unseen object sides.
`src/core/perspective.ts` defines aperture/eye/geometry mappings, including the contained image rectangle inside the stage.
`renderer.renderPerspective` prepares coverage-aware geometry and source-coordinate outputs used for picking.
The procedural Motion loop remains a separate path and output behavior.

`session/view-driver.ts` owns one live render clock fed by `session/window.ts` camera observations and `session/tilt.ts` orientation observations.
Both permission requests start in the enable gesture, before yielding.
Sources own permission, calibration, observation timestamps/sequences, timeout, and cleanup.
Auto prefers a fresh calibrated camera observation and uses tilt when the camera is unavailable or stale; it no longer adds the sources' offsets.
The driver accepts ordered observations, retains a recent tracking sample during a short loss, blends source changes over 200ms, and applies 35ms exponential smoothing.
Public states include `Parallax: calibrating`, `Parallax: hold still to calibrate`, `Parallax: tracking face`, `Parallax: tilt fallback`, and `Parallax: tracking lost`.
If both sources fail, Parallax stops and reports their failure sentences.
Disabling, replacement, or document visibility loss stops the active clock and releases owned resources.

The Parallax node exposes Strength in 0.5–3, step 0.1, default 2, sharing `motion.parallax` with Motion Depth.
Recenter resets both sources' calibration and the handoff trajectory; compact mode exposes a quick Recenter action.
Saved legacy documents retain their migrated amounts.
Head/tilt calibration, portrait/landscape signs, permission behavior, and memory still need actual-iPad verification; desktop evidence does not establish device behavior.

Live picking reads the current render's source UV and generation/view identity before applying a tap to the source photo.
Generated revealed background cannot be selected as original content; its status asks the user to Recenter.
Coverage/preparation limits are reported rather than exposing stale or unrepaired source content.
`src/core/live-coverage.ts` gives live plate preparation its own coverage identity and hole mask.

Debug exposes Auto/Camera/Tilt source override, camera frame/face box, sample state/age/quality, calibration and tilt basis/angles, raw/filtered targets, view offset, view id, preparation/coverage, stage/viewport/DPR, and numeric trace download.
It stays outside renderer/export pixels and is not the default judge-facing surface.
Current scenario/review results are in the PX10 Returns and `plan/log.tsv`; the [iPad checklist](../plan/phone.md) owns physical checks still owed.

### The loop crop

`PARALLAX_MARGIN` is 0.02, the frame fraction a loop with camera orbit hides on each side, and `LOOP_ZOOM` is `1 / (1 - 2 * PARALLAX_MARGIN)`, the zoom about the frame center that shows the central 96% of each axis.
`effectiveOrbit(motion)` retains its helper name and reads `motion.drift.amount` while `motion.enabled` is true and 0 while it is false; at 0 the loop camera is to be the identity, so a loop keeps the still's framing.

### Frames and phase

`frameCount(motion, fps)` is `round(loopSeconds * fps)` with a half rounded up, and at least 1: a 3 s loop has 90 frames at 30 fps, 30 at 10 fps, and 38 at 12.5 fps, where 37.5 rounds up.
A half is the half decimal arithmetic gives: a product within `1e-9` of a half counts as that half, since a decimal `loopSeconds` is not exact in binary and `2.3 * 25` comes out as `57.49999999999999`, which `Math.round` alone would round down to 57 rather than up to 58.
An `fps` that is not a finite number above 0 throws a `RangeError`, so a rate computed from a GIF delay of 0 cannot give an endless or a `NaN` frame count.
`loopPhase(frame, count)` is `frame / count`, so frame `count` is phase 1 and shows frame 0 again.

Every periodic term has a whole number of cycles per loop and reads its phase through `cycleTurn(cycles, phase)`, the fractional part of `cycles * phase` in turns.
At phase 1 that is 0, exactly as at phase 0, so each term's value at phase 1 is its value at phase 0 bit for bit, where `Math.sin(2 * Math.PI)` alone is about -2.4e-16 and not 0.
The camera, bob, and sway run 1 cycle per loop; wobble runs 2 along x and 3 along y.

### The camera

`motion.drift` stores `{ direction: 'side' | 'vertical' | 'circle', amount }`, with amount in 0..1.
The version-3-to-4 migration maps `motion.orbit` to Circle at the exact old amount and removes `orbit`.
New documents start at Side to side with amount 0.6.
`cameraOffset(radius, phase, direction)` uses `(radius cos 2 pi s, radius sin 2 pi s)` with `s = cycleTurn(1, phase)` for Circle; Side to side sets y to zero, and Up and down sets x to zero.
The optional direction defaults to Circle for numerical callers; the renderer always passes the document's direction.
The Motion controls read Depth (`motion.parallax`), Drift direction, Amount, Loop seconds, then Export on desktop and phone.
`cameraRadius(doc)` is `effectiveOrbit(doc.motion) * parallaxClamp(doc)`, 0 while motion is off.

`parallaxDisplacement(offset, d, anchor)` is the displacement of a point at disparity `d`, in frame fractions: `offset * (d - anchor) * gain`, with the gain `1 / parallaxReach(anchor)` and `parallaxReach(anchor) = max(anchor, 1 - anchor)`.
It divides by the reach rather than multiplying by the gain, so the point farthest from the anchor moves by exactly the offset and a point at the anchor by exactly 0.
The gain lies between 1, for an anchor of 0 or 1, and 2, for an anchor of 0.5, and the anchor is `anchorDisparity(doc)` (see "The plate, the anchor, and the assets").

`parallaxClamp(doc)` is `PARALLAX_MARGIN` when the document has a depth map and 0 when it has none, a `motion.focus` set or not: a focus gives `anchorDisparity` a value before depth exists, but without a depth map no point has a disparity to move by, so the camera's radius is 0.
With a depth map `anchorDisparity` is never null, since it falls back to the map's median.
At orbit 1 the camera's offset is the clamp, so the point farthest from the anchor moves by exactly the clamp and no point moves farther on either axis.

The design left three things open here, and these are the code's choices:

- The farthest point from the anchor ranges over the whole disparity range, 0 to 1, of the depth map, which is normalized to that range.
  Its percentiles or the objects' medians would let a point beyond them move farther than the clamp; over 0 to 1 every point of the map moves at most the offset, and the one at 0 or 1 that lies farther from the anchor moves by exactly it.
- The gain, not the clamp, absorbs where the anchor lies, so the clamp is `PARALLAX_MARGIN` itself; it depends on the document only in being 0 when no depth map exists.
- The camera's circle is in frame fractions of each axis, where the design says "a circle ... in the image plane".
  On a frame that is not square it is an ellipse in pixels: on a 2048 x 512 panorama at orbit 1 the camera moves 41 px across and 10 px up and down.
  The margin is a fraction of each axis, so this uses all of it on both; a circle in pixels with a radius of `PARALLAX_MARGIN` of the short side would also stay within the margin, with less parallax along the long side.

### Object motion

An object's own motion is computed in master pixels over its bounds, `height` being the bounds' height, at the bound `objectMotionBound` gives it:

- **Bob** moves every point of the object along y by `bobOffset = 0.15 * amount * bound.y * height * sin(2 pi s)`, positive downward.
- **Sway** turns the object about the bottom center of its bounds by `swayAngle = 0.10 * amount * bound.x * sin(2 pi s)` radians, and `swayDisplacement(at, angle)` moves a point `at` that offset from the pivot.
  The top center lies `height` from the pivot, so its arc peaks at `0.10 * amount * bound.x * height`, and the pivot moves by exactly 0.
- **Wobble** moves the point at `(u, v)` across the bounds (0 at the left or top edge, 1 at the right or bottom) along x by `0.03 * amount * bound.x * height * sin(2 pi cycleTurn(2, phase)) * cos(pi v)` and along y by `0.03 * amount * bound.y * height * sin(2 pi cycleTurn(3, phase)) * cos(pi u)`.
  Each axis stays within `0.03 * amount * bound * height`.

Here `s` is `cycleTurn(1, phase)`, and halving `amount` halves bob's offset, sway's angle, and wobble's displacement exactly.
Every one of them is 0 at phase 0, at every point, so frame 0 of a loop shows each object where the still does.
`objectDisplacement(motion, bound, bounds, at, phase)` picks the formula by the motion's kind and gives 0 for `none`.

The design gives wobble two sines, in x and y, at 2 and 3 cycles; which sine drives which axis, and the weights `cos(pi v)` and `cos(pi u)`, are the code's choices.
The weight runs from 1 at one edge of the bounds to -1 at the other, so the top and bottom rows move opposite ways along x and the left and right columns opposite ways along y: wobble bends the outline rather than only moving it.
A weight on the amplitude, rather than a phase that shifts across the object, keeps every point at rest at phase 0, as bob and sway are, so a loop with orbit 0 matches the still outside its moving objects at frame 0.

### The bound on object motion

`motionBound(motion, bounds, frame)` is, along each axis, the largest fraction from 0 to 1 of the motion at amount 1 that moves no point of the bounds out of the frame, and 0 on an axis whose frame edge the bounds touch or cross.

- Bob and wobble move a point of the bounds the same distance both ways along an axis, so each axis's bound is `min(1, gap / reach)`, with the gap the bounds' distance to the nearer frame edge on that axis (0 for bounds that touch or cross an edge) and the reach `0.15 * height` for bob along y and `0.03 * height` for wobble on each axis; an axis the motion does not move along gets 1.
- Sway turns by one angle, so it gets one bound on both axes: the largest fraction of the full angle of 0.10 at which the bounds, turned either way about their bottom center, stay inside all four edges, and 0 when they touch or cross any edge.
  With `w` half the bounds' width and `h` their height, a turn by `t` takes a top corner out sideways by `h sin t - w (1 - cos t)`, a top corner up by `w sin t - h (1 - cos t)`, and a bottom corner down by `w sin t`, measured from the left or right, top, and bottom of the bounds.
  Each reach rises with `t` to a peak and falls after it, so the bound solves `reach = gap` on the rising part, in closed form, for each edge, and takes the smallest.
- `none` gets 0.

The bound does not depend on the amount, so halving the amount always halves the motion and every amount up to 1 keeps the object inside the frame.
`objectMotionBound(doc, id)` is `motionBound` of the object's motion, its bounds, and the master's size while `motion.enabled` is on, and 0 on both axes while it is off or when no object has the id, so an object moves only while motion is on, whatever motion it keeps.

How the bound shrinks near the edge is the code's choice, the one that keeps every moving object inside the frame: it is 1 for bounds at least their motion's reach from every edge, falls with the gap below that (in proportion to it for bob and wobble), and is 0 for bounds that touch an edge.
So an object whose bounds touch an edge does not move along that edge's normal, and its cut edge stays where the crop hides it.
Sway's one angle moves both axes, so a swaying object stops when its bounds touch any edge, the bottom edge included.
The design's formula ties sway's angle to `bound.x` alone, and its edge rule scales motion only along the axis of the edge an object touches; a turn about the bottom center of bounds on the bottom edge would lift one bottom corner and dip the other, moving the cut edge across it, so the code stops sway there and leaves the choice of another sway for such objects open.

The design says the clamp keeps every displacement within `PARALLAX_MARGIN`; the code's reading is that what the margin bounds is the displacement at the frame's edges, the only displacement the crop can show past.
Bob alone reaches 0.15 of an object's height, which exceeds 0.02 of the frame's height for any object taller than about 13% of that height, so no reading that bounds every point's total displacement by the margin lets the amplitudes the design gives hold.
A point at a frame edge, of the back layer at any disparity or of an object whose bounds touch that edge, moves inward by at most the camera's offset, which is at most `PARALLAX_MARGIN`, since an object's own motion along that edge's normal is 0.
A point inside the frame moves by the camera's parallax plus its object's own motion, which can be larger than the margin (bob reaches 0.15 of the object's height), and that motion keeps the object's bounds inside the frame, so the crop shows nothing past the frame either way.

## Platform

`src/platform/` declares no domain type: everything in it is generic or about the browser, and it imports nothing of `src/` but `core/ids.ts`.
Each module but `build-id.ts` takes the browser objects it reads as a narrow parameter (a `Pick` of `Window`, `Navigator`, `Document`, `Crypto`, or `Clock`), so `test/platform.test.ts` drives it with fakes under node; `build-id.ts` reads a compile-time constant instead (see below).

| Module | Exports |
| --- | --- |
| `diagnostics.ts` | `DiagnosticSink<E>`, `Diagnostics<E>`, `createDiagnostics<E>(clock, capacity = 500)`, `DEFAULT_CAPACITY` |
| `clock.ts` | `Clock` (`now`, `wallNow`, `setTimeout`, `clearTimeout`), `createBrowserClock(window)` |
| `visibility.ts` | `VisibilitySource` (`hidden`, `onChange`, `onPageHide`), `createVisibilitySource({ document, window })` |
| `capabilities.ts` | `DeviceClass`, `Capabilities`, `deviceClassOf(userAgent, coarsePointerWithoutHover)`, `readCapabilities({ navigator, window, clock })`, `STORAGE_READ_MS` |
| `build-id.ts` | `readBuildId()` |
| `tab-id.ts` | `mintTabId(crypto)` |

`createDiagnostics` is a ring buffer: `log(e)` stores `{ ...e, t: clock.now() }`, and once `capacity` events are held each new one overwrites the oldest, without throwing.
`events` lists the held events oldest first, and `export()` returns the JSON text `{ "capacity", "dropped", "events" }`, where `dropped` counts overwritten events.
`export()` never throws: a field holding an `Error` exports as its `name` and `message`, a `bigint` as its decimal text, and an event JSON cannot hold, such as one with a cycle, as its `event` and `t` with an `unserializable` reason.
`DiagnosticSink<E>` declares `log` as a function-typed property, not a method, because TypeScript checks method parameters bivariantly, which would let a sink of one module's events stand in where every event is logged.

`createBrowserClock` wraps `performance.now`, `Date.now`, and the window's `setTimeout` and `clearTimeout` (rule 2 of "Type checking").
`createVisibilitySource` reads `document.visibilityState` and listens for `visibilitychange` on the document and `pagehide` on the window; each subscription returns its unsubscribe.
`readCapabilities` reads the user agent, `deviceClass`, `crossOriginIsolated`, `hardwareConcurrency`, `standalone` (`matchMedia('(display-mode: standalone)')`, or iOS Safari's `navigator.standalone`), and `storage`: `quota` from `navigator.storage.estimate()`, and `persisted` from `navigator.storage.persisted()`.
It never rejects: a `matchMedia` that is missing or throws counts as no match, and a storage read that throws, rejects, or has not answered after `STORAGE_READ_MS` (2000 ms, timed on the clock it is given) gives `quota: null` or `persisted: false`.
`deviceClass` is `phone` when the user agent names iPhone or iPad or `matchMedia('(pointer: coarse) and (hover: none)')` matches, and `desktop` otherwise.
`readBuildId` reads `NOISY_BUILD_ID`, so no module a node test imports may import `build-id.ts` (see "Build id and compile-time constants"); it throws if the build injected an id `isBuildId` refuses.
`mintTabId` calls `randomUUID` and throws if it is missing, as it is outside a secure context, or if the result is not a lowercase UUID v4.

## The composition root

`src/main.tsx` and `src/app/` are the composition root, the one place that may import every module.

`main.tsx` calls `bootRoot(window)` from `app/root.ts`, which, in this order, creates the browser clock and the page's one `Diagnostics<DiagnosticEvent>`, starts logging every `securitypolicyviolation` on the document as a `csp.violation` event (`directive` is the event's `effectiveDirective`, `blocked` its `blockedURI`, and `disposition` its `disposition`, `enforce` or `report`), mints the tab id, reads the build id, and starts reading the capabilities, which it logs as one `env` event whose `snapshot` is the capabilities plus `build`.
It returns `{ clock, diagnostics, tab, build, environment }`, where `environment` is a promise of that snapshot, which never rejects because `readCapabilities` does not.
A violation from before the module ran is not logged.
In the dev server's dev mode one violation of a directive both policies share is logged twice, once with `disposition: 'enforce'` for the enforced CSP and once with `disposition: 'report'` for its report-only copy, so a count of violations counts one disposition.
`main.tsx` then installs the test surface when `NOISY_DEV` is true and renders the shell into `#app`: `isolated: yes` when `window.crossOriginIsolated` is true and `isolated: no` otherwise, in an element with `data-testid="isolation"`, and `build <build id>` in an element with `data-testid="build-id"`.
If `bootRoot` throws, as `mintTabId` does on an origin that is not a secure context, where `crypto.randomUUID` does not exist (its message says so), `main.tsx` still renders the shell, with the build id read from `NOISY_BUILD_ID` and the error's message in an element with `data-testid="boot-error"`, and installs no test surface.

`app/events.ts` declares the vocabulary.
`DiagnosticEvent` is the union of `CspViolationEvent` (`{ event: 'csp.violation', directive, blocked, disposition }`), `EnvEvent` (`{ event: 'env', snapshot }`), `analysis/service.ts`'s `AnalysisEvent` (see "The events"), and `store/connection.ts`'s `StoreEvent` (see "The connection"); `EnvironmentSnapshot` is `Capabilities & { build: BuildId }`.
A module that logs declares its own part of the vocabulary and takes a `DiagnosticSink` of that part only; when it lands, its part joins the `DiagnosticEvent` union, and the root hands it the page's one buffer, which a narrower sink accepts.
`test/diagnostic-vocabulary.test.ts` holds that rule: `tsconfig.test.json` checks that the root's buffer is accepted where each part's sink is taken, and its `@ts-expect-error` lines check that a sink of one part does not take another part's event and does not stand in for a sink of the whole union; each new part adds a line to each.
`EnvironmentSnapshot` gains a field when the module that reports it lands.
`bootRoot` builds the snapshot as `{ ...capabilities, build }` inside the promise that `readCapabilities` returns and logs the one `env` event there, so a new field is added to `EnvironmentSnapshot`'s type in `app/events.ts` and supplied in that promise chain in `app/root.ts`, before the log, and the reader of a field that can hang or throw bounds it as `readCapabilities` bounds the storage reads.

`app/test-surface.ts` declares `TestSurface`, `{ diagnostics(), environment() }`: `diagnostics()` returns every event the ring holds, oldest first, each with its `t`, and `environment()` returns the snapshot's promise.
`installTestSurface(window, root)` defines `window.__noisyTest` as a frozen, non-writable, non-enumerable, non-configurable property.
`main.tsx` calls it only under `if (NOISY_DEV)`; a production build defines `NOISY_DEV` as `false`, esbuild drops the call and the module, and the bundle guard checks that no production file names `__noisyTest`.
Each module adds its members to `TestSurface` once the types they name exist.

## Bundle guard

`test/bundle-guard.test.ts` runs `tools/build.mjs --mode production` into a temporary directory and checks the output with `checkProductionBuild(outdir)` from `test/support/bundle-guard.ts`, which reads the files on disk rather than `build.json`:

- No file is under `dev/`.
- No file outside `vendor/` names a string of `DEV_ONLY_STRINGS`: `__noisyTest`, `/dev/`, `/dev/fault`, `/dev/csp-report`, `/dev/requests`, and `/api/log`.
- No `.js` file outside `vendor/`, which is every bundle esbuild wrote, refers to the global `console`, bare or through `window`, `globalThis`, or `self` (`window.console.log`, which `drop: ['console']` keeps): `console.x`, `console?.x`, `console[...]`, or the bare name, as in `const { log } = console`, which the drop also leaves in place; a property named `console` of any other object does not count, nor does a reference the pattern cannot see, such as `window['console']`, and the word inside a string does, which fails safe.
- Every file under `vendor/` is under `vendor/ort/<installed onnxruntime-web version>/` and is byte-identical to the file of the same name in `node_modules/onnxruntime-web/dist/`.

The test shows each check failing: a dev build of `src/` names `__noisyTest` and writes `dev/threads.html`; a probe that bundles `mediabunny` minified without `drop` carries `console.` calls, which `checkBundle` reports; a probe built with `drop: ['console']` keeps a destructured `console`, which it reports too; and a production build with an edited runtime file, a runtime file outside the installed version's directory, and `/api/log` written into `index.html` gets one finding for each.
A part that adds a dev-only route, or a name that only dev code uses and a correct production bundle never contains, adds it to `DEV_ONLY_STRINGS`.
Test-surface members are not added: their names, such as `diagnostics` and `environment`, are ordinary identifiers that a production bundle also holds (the production `main` bundle keeps both as `Root`'s property names), and the surface is reached only through `__noisyTest`, which the list already holds.

## Dev pages

A dev build turns every `src/dev/<name>.html` into `/dev/<name>.html`, with `%NOISY_SCRIPT%` replaced by the URL of its script, `src/dev/<name>.ts` or `src/dev/<name>.tsx`, bundled like the app.
It reads one level of subdirectory the same way: `src/dev/<dir>/<name>.html` with `src/dev/<dir>/<name>.ts` or `.tsx` beside it becomes `/dev/<dir>/<name>.html`, recorded in `build.json`'s `devPages` as `"<dir>/<name>"`.
A page without a script fails the build.
Every `src/dev/<name>-worker.ts` is bundled like the workers, and the pages read its URL from `NOISY_DEV_WORKER_URLS[<name>]`.
A `*-worker.ts` in a subdirectory, at any depth, fails the build, naming the file, since no worker is built from there.
Directories deeper than one level are not read for pages; they hold modules, bundled when an entry imports them.
No two entries may share a file name, wherever they are: pages `src/dev/memory.html` and `src/dev/harness/memory.html`, with their scripts `memory.ts` beside them, fail the build, since each bundle is named for its entry's file name; a module that is not an entry may share an entry's file name.
A production build reads nothing under `src/dev/` and writes no `/dev/` page.

### The thread probe

`/dev/threads.html` runs ONNX Runtime in a module worker at its default thread count.
Run starts `src/dev/threads-worker.ts` as a dedicated module worker, which wraps its scope's `Worker` constructor before ORT loads, imports `noisy:vendor-ort`, sets `wasmPaths` to `NOISY_ORT_DIR`, leaves `numThreads` at ORT's default, creates a session on `src/dev/tiny-model.ts`'s 256 x 256 `MatMul` model with the `wasm` execution provider, runs it once, and checks the product.
The page shows the result as text in `#result`, whose `data-state` is `idle`, `running`, then `completed`, `failed`, or `timed-out` as soon as the outcome is known.
It then posts one row to `/api/log`, and `#result`'s `data-row` is `posting`, then `posted`, or `not-posted` when the sink answers with an error or has not answered after 10 seconds; Run is enabled again once `data-row` settles.
The row:

```json
{
  "kind": "threads-probe",
  "buildId": "<build id>",
  "env": { "userAgent": "...", "crossOriginIsolated": true, "standalone": false, "hardwareConcurrency": 8 },
  "outcome": { "kind": "completed", "numThreads": 4, "sessionMs": 215.1, "runMs": 8.2, "outputOk": true },
  "pthreadWorkers": 3,
  "csp": { "seenBy": "page and probe worker", "count": 0, "violations": [] }
}
```

`outcome` is one of `{ "kind": "completed", numThreads, sessionMs, runMs, outputOk }`, `{ "kind": "failed", error, numThreads }`, and `{ "kind": "timed-out", afterMs }`, the last after 120 seconds.
`numThreads` is `ort.env.wasm.numThreads` after the session was created, as ORT set it, or `null` when the run failed before then.
`pthreadWorkers` counts the nested workers constructed with a name starting `em-pthread`.
A nested worker's `error` event ends the run as `failed` at once, naming the worker.
`csp.violations` lists each `securitypolicyviolation` event seen by the page since it loaded and by the probe worker during the run, as `{ scope, directive, blockedURI, disposition }`; one violation of a directive both policies share appears twice, once with `enforce` and once with `report`.
Violations in ORT's pthread workers reach only the server's `/dev/csp-report`, which `csp.seenBy` and the page's text say, so a row's `count` of 0 does not cover them.
`standalone` is `matchMedia('(display-mode: standalone)')`.

### The phone checklist

`/dev/checklist.html` is the page the owner follows during a phone sitting.
`/dev/checklist.html?sitting=A` lists sitting A's rows; the letter is matched without regard to case.
With no `sitting`, or one that names no sitting with rows, the page lists the sittings that have rows (`Sitting A: H1, H2` and `Sitting C: H8`), each linking to its page, and says so when the one asked for has none.

A sitting's page starts with the conditions card (on the charger, Low Power Mode on, other Safari tabs closed, each yes or no, then Send), followed by the sitting's rows in registry order.
Each row shows its id and part, its action, its question with the expected answer in brackets, and what is recorded automatically.
Where an action names a page, those words link to it on the same origin and open in a new tab.
A yes or no row posts on the tap; a number row posts on Send or Return.
Every link, button, and field is at least 44 by 44 CSS pixels; a link inside an action's sentence gets that height from vertical padding, which does not move the text.
Each card's status says whether its latest answer was recorded, whether it matched, and what the page recorded with it (`isolated yes` or `no`, and the build id); answering again posts a new row, and of a sitting's rows for one checklist row the one with the latest `answeredAt` counts, not the last in the sink (below).
After the rows, the "Model cache" card's "Clear model cache" deletes every model cache with `clearModelCaches` (see "The model loader") and says how many it cleared, so the next analysis downloads its models again.
The page writes nothing but its posts and that deletion, and reads nothing from the sink, so a reload shows every card unanswered, whatever the sink holds.
The CSP blocks `<style>` and style attributes, so `checklist-style.ts` adopts a constructed stylesheet; Chrome applies it with no violation reported, and each post carries the violations the page saw, so a phone sitting shows whether WebKit does too.

#### The row registry

`src/dev/checklist-rows.ts` exports `CHECKLIST_ROWS`, every phone row the page lists, and its types.
A row is a `ManualRow` or a `BatchRow`, and both carry:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `` `H${number}` `` | the row's H number |
| `part` | `` `P${string}` `` | the part that owns it |
| `sitting` | `'A'` to `'I'` | the sitting it runs in |
| `action` | `readonly ActionPart[]` | the action's words; a piece is a string or `{ text, href, code }`, a same-origin link, set as code when `code` is true |
| `question` | `string` | the question |
| `recorded` | `string \| null` | what is recorded without asking |

A `ManualRow` adds `kind: 'manual'`, `answer`, and `attach`.
`answer` is `{ kind: 'yes-no', expected: 'yes' | 'no' | null }`, `{ kind: 'number', expected: number | null }`, or `{ kind: 'observation', expected: string | null }`; an observation's `expected` describes what the Mac judges, so the page never marks it as matching.
The brackets show `expected` as it is; an answer these three kinds cannot hold, such as a yes or no with a remark beside it, is a new `answer` kind, added with its input by the part whose row needs it.
`attach` is `'none'` or `'screenshot'`.
A `BatchRow` adds `kind: 'batch'` and `run(context)`, which is to get a `BatchContext` (`app`, a `TestSurface`; `post(row)`; `capture(name, blob)`) and resolve to `{ kind: 'done' }` or `{ kind: 'failed', reason }`.
`BatchContext` is what the part that adds the first batch row provides: an app instance the batch drives through its test surface, hosted by the checklist for the batch's length, and the sink.
That part decides how the instance is hosted (a frame is the likely host); nothing builds one yet.

To add rows, a part adds them to `CHECKLIST_ROWS` where the owner runs them within their sitting, with the action and question word for word as the owner's checklist gives them.
The page lists only manual rows with `attach: 'none'` in full today: for a row with `attach: 'screenshot'` it says attaching is not built yet, and for a batch row that it cannot run batch rows yet.
The first part that adds a screenshot row or a batch row builds the Attach button (the picture uploaded as a binary capture) or the batch runner (one tap, DONE or FAILED), with a scenario that exercises it.
Rows that run on the owner's start command are not in the registry, since that command serves no dev page.

#### What a post contains

Each answer is one JSON row to `POST /api/log`:

```json
{
  "kind": "checklist-answer",
  "sitting": "A", "row": "H2", "part": "P0.2",
  "answer": { "kind": "number", "value": 3 }, "expected": 2, "matches": false,
  "buildId": "<the checklist page's build id>",
  "answeredAt": "<ISO time of the tap, by the device's clock>",
  "environment": { "kind": "read", "snapshot": { "...": "the checklist page's EnvironmentSnapshot" } },
  "cspViolations": [{ "directive": "style-src-elem", "blocked": "inline", "disposition": "enforce" }]
}
```

`answer.kind` is the row's answer kind, and `expected` is the row's expected value or `null`.
`matches` is whether the answer equals the expected one, or `null` when nothing is expected or the answer is an observation.
The conditions card posts `{ "kind": "checklist-conditions", "sitting", "conditions": { "onCharger", "lowPowerMode", "otherSafariTabsClosed" }, "buildId", "answeredAt", "environment", "cspViolations" }`, each condition `"yes"` or `"no"`.

`environment.snapshot` is an `EnvironmentSnapshot` (`app/events.ts`, by `import type`): `checklist-environment.ts` builds it once as the page loads, with the functions `app/root.ts` uses (`readCapabilities` with a browser clock, and `readBuildId`), and the first post waits for it.
It is the checklist page's own snapshot, not one taken from the app.
It describes the browser context the checklist is opened in: its `userAgent`, `standalone`, `crossOriginIsolated`, `hardwareConcurrency`, `deviceClass`, and `storage`.
When the checklist and the app are open in Safari tabs, that is the Safari the app runs in.
Nothing in the app links to `/dev/checklist.html` and `checklist.html` has no manifest, so the checklist is not reached from inside the noisy Home Screen app: a post made for a row run in the Home Screen app records the checklist's own context, not the Home Screen app's.
`readCapabilities` never rejects; `readBuildId` throws on a malformed build id, and then `environment` is `{ "kind": "unavailable", "reason": "<why>" }` and the row is posted all the same.
The checklist records no iOS version as such: published reports say Safari on iOS 26 freezes the OS version in its user agent (at 18.6) but keeps a `Version/<n>` token that tracks the Safari release, which a post from a Safari tab carries in the snapshot's `userAgent`; a page opened from the Home Screen may have a user agent without that token, and neither has been checked on the owner's phone.
`cspViolations` lists every `securitypolicyviolation` event the page has seen by the time of the post, as `{ directive, blocked, disposition }`, the fields of the app's `csp.violation` event; its listener is in place before the rest of the page's script runs, and a violation of a directive both policies share appears twice, once with `enforce` and once with `report`.
The app's diagnostics are not in a post: they belong to the owner's app session, which this page cannot see.

Posts go out one at a time, in the order the owner answered; a row of at most 60,000 bytes is sent with `keepalive`, so the request outlives the page.
The sink's order is still not the answers' order: a post with no reply can reach the server after a later answer was recorded, and the posts sent as the page is hidden or left (below) can reach it before a post still in flight.
A reader of the sink takes, of a sitting's rows for one checklist row, the one with the latest `answeredAt`; the phone's clock stamps every answer, so that order holds across reloads too.
The card says "Not recorded" when the sink answers with an error status, which it sends before appending anything, and "No reply" when no answer arrives within 10 seconds or the request fails; a post with no reply may still have been recorded, and answering again posts a new row either way.

A post can wait behind a slow earlier one, for up to its 10 seconds, or behind the first read of the environment.
When the page is hidden (`visibilitychange` to `hidden`: another tab, such as one a row's link opened, or another app) or left (`pagehide`: a reload, a navigation, a closed tab) while posts still wait, each is sent at once, with the environment if it has been read and otherwise `{ "kind": "unavailable", "reason": "the checklist page was hidden or left before its environment was read" }`.
Those go out together, so they may reach the sink in any order.
In the Page Lifecycle model a page is hidden before the browser can discard it in the background, so its waiting posts have gone out by then (not checked on iOS); a page that ends with neither event, such as one whose renderer crashes, loses its waiting posts, and a reloaded page cannot show which answers were recorded, since it reads nothing from the sink.

### The model loader page

`/dev/models.html` runs the model loader in the page (see "The model loader").
At load it parses the build's lock with `bundledLock()` and opens the loader with the page's `caches`, `fetch`, `crypto.subtle`, `navigator.locks`, and browser clock, which runs the startup cleanup; Run fetches the files of the operation chosen in the page.
`?op=` picks the operation, `depth`, `encode`, `decode`, or `inpaint` (default `decode`), and `?stallMs=` the stall timeout in whole milliseconds above 0 (default 30000); a value the page cannot use fails the page at load, naming it.
`#report` (`data-testid="report"`) holds one JSON object, and its `data-phase` is `starting`, `ready`, `running`, or `failed`:

| Field | Meaning |
| --- | --- |
| `phase`, `detail` | the phase, and why the page failed at load when it did |
| `lockHash`, `cacheName`, `partialCacheName` | the loader's lock hash and its two caches |
| `stallMs`, `op` | the stall timeout and the operation Run fetches |
| `runs`, `result`, `elapsedMs` | how many runs have finished, and the last one's `Result` (`{"ok": true}` or `{"ok": false, "error": <AnalysisError>}`) and time |
| `progress` | the last fraction reported for each `ModelId` |
| `caches` | every `noisy-models-*` cache, each entry as its path and query, read at load and after each run |

Run is disabled while a run is under way.

### The sequence worker page

`/dev/sequence.html` drives the real sequence worker over its protocol (see "The sequence worker").
At load it parses the build's lock and its levers and opens the model loader; Run reads the master's raw RGBA bytes from the `#master` file input and, for an inpaint run, the hole's bytes, one per pixel, from `#hole`, fetches the models of the listed stages with the loader, and starts the worker from `NOISY_WORKER_URLS.sequence`.
Run also reads the truth planes chosen beside them: `#near` and `#far`, the depth check's regions, one byte per texel of `depthInputSize` of the master, both or neither; and `#ring`, the inpaint check's ring, one byte per pixel of the master, which needs the hole's file.
A file of another length, one of near and far without the other, or a ring without the hole's file fails the page, naming it.
It posts `init` with `ortBase` `NOISY_ORT_DIR`, then a `run` per stage, each with a fresh `ImageBitmap` made from the master with `createImageBitmap` and transferred, then `end`, all at once, so the worker queues them; it waits until every run is answered, at most 150 seconds.
It then posts one more `run` of the first stage, which a worker that closed on `end` never answers, listens for one second, and calls `terminate()`; a reply in that second, to that run or a second answer to the last one, lands in the report like any other.

| Lever | Meaning |
| --- | --- |
| `?width=`, `?height=` | the master's size, which the files must match; required |
| `?stages=` | the stages, comma-separated: `depth`, `encode`, `inpaint`; default `depth` |
| `?threads=` | `init`'s `threads`: a whole number, or `default` (the default) |
| `?hole=mismatched` | send inpaint a hole of half the master's size each way in place of the file's |
| `?init=0` | send no `init` |
| `?secondInit=1` | send a second `init` after the first, with an `ortBase` under `NOISY_ORT_DIR` that serves no runtime and `threads` 1, so a worker that honored it would fail the run |
| `?unparseable=1` | after `init`, send a `run` without its `image`, which the worker cannot parse |
| `?afterEnd=1` | send one more `run` of the first stage after `end` |
| `?evict=<served path>` | after the fetch, delete that file of the lock from the verified cache |

`#report` (`data-testid="report"`) holds one JSON object, and its `data-phase` is `starting`, `ready`, `fetching`, `running`, `done`, or `failed`; a lever the page cannot use fails it at load, naming the lever.
The report holds the levers, the page's `crossOriginIsolated`, `hardwareConcurrency`, and user agent, the fetch's result, whether `evict` deleted its file, the requests posted in order, every reply in arrival order, each parsed with `parseSequenceReply` and summarized (a product's sizes, lengths, statistics, tensor names and dims, and timings, the depth map's least and largest values, a `failed` reply as it came, and a reply that did not parse as `unparsed` with the parser's detail), the message of each `error` event the `Worker` received, the count of `messageerror` events, how many replies other than a `phase` came (products, `failed`, and replies that did not parse), and the time from the worker's start to the last answer.
A `depth` summary's `check` is `checkDepth`'s `Result` on the map with the near and far planes, and a `plate` summary's `check` is `checkInpaint`'s on the plate with the master as `Rgb8`, the hole sent, and the ring (see "The known-answer checks"); each is null when its planes were not chosen.
The page runs each check as the product arrives, so the planes and the products stay in the page and only the numbers reach the report.
Once the run is done the page posts the report to `/api/log` as `{ "kind": "sequence-run", "buildId", ...report }`, and `#report`'s `data-row` is `posting`, then `posted` or `not-posted`.

### The analysis service page

`/dev/service.html` runs the analysis service on the real sequence worker (see "The analysis service").
At load it parses the build's lock and its levers, starts opening the model loader with the page's `caches`, `fetch`, `crypto.subtle`, `navigator.locks`, and browser clock, and builds one service whose `spawn` starts `NOISY_WORKER_URLS.sequence`, with `ortBase` `NOISY_ORT_DIR` and a `Diagnostics<AnalysisEvent>` of its own as `diag`.
Each Run reads the master's raw RGBA bytes from the `#master` file input, fetches the stages' models with the service's `fetchModels`, and runs the stages as one sequence, its `master()` making a fresh `ImageBitmap` from those bytes each time the service calls it; the service outlives a run, so a second Run reads the record the first left.

| Lever | Meaning |
| --- | --- |
| `?width=`, `?height=` | the master's size, which the file must match; required |
| `?stages=` | the stages, comma-separated: `depth`, `encode`; default `depth,encode` |
| `?threads=` | the service's `threads`: a whole number, or `default`; default 2 |
| `?closed=<stage>` | the master for that stage is a bitmap closed before it is returned, so posting its run throws |
| `?cancelAt=<stage>:<phase>` | cancel the sequence when the worker reports that phase, `session` or `infer`, of that stage |
| `?cancelBy=` | how that cancel is made: `cancelHeavy` (the default) or `abort`, the signal passed to `runSequence` |

`#report` (`data-testid="report"`) holds one JSON object, and its `data-phase` is `starting`, `ready`, `fetching`, `running`, `done`, or `failed`; a lever the page cannot use, a fetch that fails, or a sequence that has not ended after 150 seconds fails it, naming the cause.
The report holds the levers, the page's `crossOriginIsolated`, `hardwareConcurrency`, and user agent, and one entry per run: the fetch's result, the termination record before the run, `alive.heavy` just after `runSequence` returned, every listener callback in order (a product summarized by its sizes, statistics, or tensor names and dims; `onFailed` and `onDone` with `alive.heavy` and the record as the callback read them), the events the service logged during the run with their times, the fetch's included, and the record and `alive.heavy` once the run was over.
Once a sequence has ended the page posts the report to `/api/log` as `{ "kind": "service-run", "buildId", ...report }`, and `#report`'s `data-row` is `posting`, then `posted` or `not-posted`; Run is enabled again after that.
The page's service is given a `spawnDecoder` and never opens a decoder; the decoder page does (see "The decoder page").

### The decoder page

`/dev/decoder.html` runs the analysis service's decoder on the real decode worker (see "The decoder").
At load it parses the build's lock and its levers, starts opening the model loader, and builds one service as the analysis service page does, its `spawnDecoder` starting `NOISY_WORKER_URLS.decode` with a listener of the page's own on each worker, which records every reply, parsed with `parseDecodeReply`, and the message of each `error` event.
Run reads the master's raw RGBA bytes from `#master` and the truth masks from `#truths`, one byte per guide texel each, the nth truth for the nth decode, and fetches the models through the service: the encoder's and the decoder's, or only the decoder's when the embeddings are stand-ins.
It then gets the embeddings, by running the encoder as one sequence on the master through the service or by making stand-ins, and builds the guide: the master drawn on an `OffscreenCanvas` at long edge 1024, the short side the master's aspect rounded to the nearest texel, with smoothing on at `high` quality.
It opens the decoder, reads `alive.decoder`, makes every listed decode at once, each with its own signal, waits for all of them, reads `alive.decoder` again, releases the decoder, releases it a second time, reads `alive.decoder`, and makes one more decode, which a released decoder resolves `cancelled`.
Each candidate is checked against its decode's truth with `checkMask` in the page, so only the numbers reach the report.

| Lever | Meaning |
| --- | --- |
| `?width=`, `?height=` | the master's size, which the file must match; required |
| `?threads=` | the service's `threads`, the encoder's: a whole number, or `default`; default 2 |
| `?embeddings=` | `encoder` (the default): the encoder's, through the service; `zeros`: the table's tensors filled with 0, made by the decoder's model; `other-model`: those, made by the depth model; `wrong-tensors`: those, the third tensor's dims [1, 64, 256, 64] |
| `?decode=` | repeatable, one decode each: its points as `x,y,include` or `x,y,exclude`, in frame fractions of the master, joined by `;` |
| `?abort=<index>:<when>` | repeatable: that decode's signal aborts `before` the call or right after it, `during` |
| `?release=` | `before` the decodes are made, right after they are made (`during`), or once they resolve (`after`, the default) |
| `?reopen=1` | open a decoder, make one decode on it, open the decoder the decodes use, which replaces it, and make one more decode on the replaced one |
| `?unparseable=1` | post the live decode worker a string right after the decodes are made, which it cannot parse |
| `?step=1` | after the encoder, wait at `data-phase` `encoded` until `#continue` is clicked |
| `?evict=<served path>` | after the fetch, delete that file of the lock from the verified cache |

`#report` (`data-testid="report"`) holds one JSON object, and its `data-phase` is `starting`, `ready`, `fetching`, `encoding`, `encoded`, `decoding`, `done`, or `failed`; a lever the page cannot use, a file of another length, a fetch that fails, an encoder that gives no embeddings, or an encoder run or a set of decodes that has not ended after 150 seconds fails it, naming the cause.
The report holds the levers, the page's `crossOriginIsolated`, `hardwareConcurrency`, and user agent, the fetch's result, whether `evict` deleted its file, how the encoder sequence ended, the guide's size, the replaced decoder's two outcomes with `reopen`, `alive.decoder` at the three reads, each decode's points, abort, outcome, and milliseconds from the call to its resolution, the outcome of the decode after the release, every reply the decode workers sent (a `decoded` reply by its `jobId` and timings), every `error` event's message, and the events the service logged during the run with their times.
An outcome is `ok` with each candidate's score, size, count of texels at or above 128, and `checkMask`'s numbers and verdict against the decode's truth, or null without a truth; or `err` with the error.
Once the run is done the page posts the report to `/api/log` as `{ "kind": "decoder-run", "buildId", ...report }`, and `#report`'s `data-row` is `posting`, then `posted` or `not-posted`.

### The store page

`/dev/store.html` runs the store's connection over the page's real IndexedDB and the scene lock over its real `navigator.locks` (see "The store").
Its connection opens a database of the page's own, `noisy-dev-store`, at the app's schema version with the app's schema, and never the app's `noisy`.
A phone sitting's dev server and the owner's `npm start` are both served at `https://<MagicDNS name>/`, so they share one origin and its databases, and the page's records and levers stay out of the app's.
The connection's `diag` is a `Diagnostics<StoreEvent>` of the page's own, and its `onVersionChange` notes the event in `sessionStorage` and reloads the page.
Write saves a test record, `{ write, at }` under the key `dev-store-write` in the `device` store, as one `put` in one transaction through `run`.
`#status` (`data-testid="status"`) then says `<ordinal> write saved`, such as `second write saved`, or `<ordinal> write failed: <kind>` with the detail in brackets when the error has one; `#reconnects` says `store.reconnect: <count>`.
Each write is posted to `/api/log` as `{ "kind": "store-write", "buildId", "userAgent", "navigation", "write", "reconnects", "events" }`, where `write` is the write's number, kind, `Result`, and milliseconds, and `events` every event the page's diagnostics hold.
That is all the owner's phone row H8 uses: Write, ten minutes in another app, Write.

`?levers=1` shows the levers the browser scenarios pull:

| Lever | What it does |
| --- | --- |
| Inject 1 error, Inject 2 errors | the next one or two `transaction()` calls on the connection's handles throw `InvalidStateError`: the page wraps the opener and shadows each handle's `transaction` |
| Clear injection | sets the injection back to none |
| Close handle | closes the connection's latest handle behind its back, so the next `transaction()` throws Chrome's own `InvalidStateError` |
| Upgrade to version 2 | opens `noisy-dev-store` at version 2 from a second connection, which sends a `versionchange` to a handle the connection holds and leaves the database newer than this build; the reload `onVersionChange` asks for waits until that upgrade ends, so the reload does not abort it |
| Add duplicate | adds the key `dev-store-duplicate` twice in one transaction, awaiting each add with `requestDone`, an operation's own `ConstraintError` |
| Read many | stores 4000 records of 2000 bytes under `dev-store-read-<n>` in one transaction, then reads them back in one transaction, awaiting each `get` with `requestDone`, which runs long enough for a scenario to clear the site's IndexedDB while it reads |
| Hold | holds the scene lock of a test scene id until Release (`fn` resolves) or Release by rejecting (`fn` rejects) |
| Ask from this page, Ask from the frame | asks for that lock from the page, or from `/dev/store.html?frame=1` in a same-origin frame that stands in for a second tab, and records what came back and how long it took |
| Lock with a throwing function | runs `withSceneLock` with a function that throws |

After Upgrade to version 2 every Write answers `newer-version` until the site's data is cleared; H8's link has no `?levers=1`.

`#report` (`data-testid="report"`) holds one JSON object, and its `data-phase` is `starting`, `ready`, or `failed`.
It holds whether the levers are shown, this load's navigation type (`navigate` or `reload`), the `versionchange` the page before a reload noted, the injection left, how many handles the opener produced, how many times `onVersionChange` was called, every write and duplicate add with its `Result` and milliseconds, the last Read many's phase (`storing`, `reading`, or `done`), how many times the connection ran its read, and its `Result`, the `store.reconnect` count and every event, the upgrade's state, whether the frame is ready, every lock action with its outcome, its milliseconds, and the lock's held and pending requests from `navigator.locks.query()` just after, and how many posts the sink accepted and did not.

### The harness's holes

`src/dev/harness/holes.ts` makes the holes the memory harness hands the inpainting model; it is a module the harness's inputs import (see "The inputs"), not a page of its own.
`holePlane(shape, size)` returns a `Plane<'u8'>` at the master's size in the hole mask's polarity, 255 inside the hole and 0 outside, for the two `HoleShape`s in `HOLE_SHAPES`:

| Shape | The hole |
| --- | --- |
| `full` | every pixel |
| `corners` | four discs of radius `cornerRadius(size)`, `round(0.1 x min(width, height))` with halves up, centred at `(r, r)`, `(width - r, r)`, `(r, height - r)`, and `(width - r, height - r)`; a pixel `(x, y)` is inside a disc when `(2x + 1 - 2cx)^2 + (2y + 1 - 2cy)^2 <= (2r)^2`, its centre within `r` of the disc's centre in doubled integer coordinates |

Every step is integer arithmetic, so the bytes are the same in every JavaScript engine, unlike the synth painter's (see "The synth fixtures").
The corner discs cover 9.5% of a 2048 x 1536 master and 12.6% of a 2048 x 2048 one, while their bounding box is the whole frame.
`holePlane` throws a `RangeError` for a side that is not a whole number of at least 1.
`test/holes.test.ts` checks every pixel against the rule above, the two areas, and the SHA-256 of each shape's bytes at both sizes.

### The memory harness

The memory harness is the dev page that runs the phone memory rows from `/dev/harness/memory.html` (see "The page"); its runner executes the untouched calibration's step, the kill-point ladder's steps, and the runs of `U1.survival.none` so far.
Under the page is its core in `src/dev/harness/`: the plan, the rows it posts, the step marker with what a page load makes of it, the outbox, and the engine that runs a plan on the page.
Every function of the core is pure or takes what it touches (storage, `fetch`, locks, the clock, visibility, the runner) as arguments, and none reads a browser global when its module loads, so the node tests run them as the page will.
The table lists the core's modules, from `lines.ts` to `liveness.ts` (`holes.ts` is under "The harness's holes"), then the page's: `levers.ts`, `ballast.ts`, `inputs.ts`, `sequence-run.ts`, `runner.ts`, `status-view.ts`, and `style.ts` read no browser global when they load either, while `memory.ts` reads the page's elements, `navigator`, and `matchMedia` when it loads, so only a browser runs it.

| Module | What it holds |
| --- | --- |
| `lines.ts` | the pass lines and the plan's constants, which the page and the readers both take from it: runs per row (10), the headroom line (300 MB), the chunk (100 MB), U2's gaps, U3's cycles, the leak and panorama ratios, the Mac's depth band, the cooldown defaults, `COOLDOWN_MS` (depth 5 s, encode 20 s, inpaint 5 s), the hidden grace (4 s), the void cap (5), the outbox's cap, the plan's size budget, the GL texture counts, the levers' defaults, and the post's keepalive bound and timeout |
| `rows.ts` | the posted row contract: one zod schema per event inside one envelope, `HarnessRow` inferred from it, and `parseHarnessRow` |
| `catalog.ts` | the harness's pages and their storage keys, the row ids, the plan kinds with the page and the rows of each, and the family each row belongs to |
| `steps.ts` | `Step`, what the shared rules read per step kind, the scores a step that returned reports, and the reasons a step is voided |
| `states.ts` | every row family's persisted state, the plan row with how the shared layer ended it, the row verdicts, and `verdictText` |
| `context.ts` | what a row program reads beyond its own row: the levers as the plan holds them, the encode mode with `encodeMode`, and the `PlanContext` type |
| `plan.ts` | `PlanState` and `parsePlan`, `planContext`, which builds a program's `PlanContext` from the plan, and the plan's lifecycle |
| `registry.ts` | the `Program` contract, the families with a built program, and the dispatch over the row programs: `missingPrograms`, `nextStep`, `foldStep`, and `rowVerdict` |
| `programs/runs.ts` | the program of the rows that run one sequence N times |
| `programs/untouched.ts` | the program of the untouched calibration, and its phase names |
| `programs/killpoint.ts` | the program of the two kill-point rows, their phase names, and the ladder's last step |
| `load.ts` | the step marker, `classifyLoad`, `scoreCompleted`, and `applyLoad` |
| `outbox.ts` | the write-ahead outbox and the post it sends rows with |
| `engine.ts` | the engine: a plan's load, Start, step loop, DONE, and Stop over injected storage, locks, clock, visibility, outbox, and runner; the runner's interface, the step facts it hands the runner, and the phase names `wait`, `setup`, `run:<stage>`, and `after` |
| `wake-lock.ts` | the screen wake lock the engine holds while a run is wanted, and its answers |
| `liveness.ts` | the app-shaped marker, the tab lock, and the liveness report, which the engine takes as one optional dependency |
| `levers.ts` | the page's levers, parsed from its URL, and whether a run is levered |
| `ballast.ts` | the filled ballast's chunks, fill, and checksum, the heap the kill-point ladder grows, the stand-in, and the allocator every buffer the runner holds is made through |
| `inputs.ts` | the synth master's bytes from the dev server, a fresh bitmap of a master for each stage, and the holes, each kept until the runner releases its inputs |
| `sequence-run.ts` | the wait every step makes from the latest heavy termination, and one heavy run of a sequence step through the analysis service, with its phases, timeout, score, and reading |
| `runner.ts` | the memory page's runner: its untouched, ballast, and sequence executors, the setup's release order, the services and the stand-in it holds, and the rows its executors run |
| `status-view.ts` | the status a harness page renders, with the page's own step descriptions |
| `style.ts` | the harness pages' constructed stylesheet |
| `memory.html`, `memory.ts` | the memory page, which wires the engine to the browser |

MB in the harness is 10^6 bytes.
The harness stores each page's run under three `localStorage` keys, named only by `harnessKeys(page)` in `catalog.ts`: `noisy.harness.<page>.plan`, `.step`, and `.outbox`.
`HarnessPage` is `memory` alone, so the keys written are `noisy.harness.memory.plan`, `noisy.harness.memory.step`, and `noisy.harness.memory.outbox`; a second page on the same origin gets keys of its own.

#### The plan

The plan holds the rows of one run, in order:

| Plan kind | Rows |
| --- | --- |
| `full` (Start) | `U1.untouched`, `U1.killpoint`, `U1.survival.full`, `U1.survival.low`, `U1.survival.none`, `U1.killpoint.after`, `U1.headroom`, `U1.migan-probe`, `U1.exemption`, `U1.panorama`, `U1.threads`, `U2.encode`, `U2.inpaint`, `U3.depth` |
| `short` (Short run) | `U1.killpoint`, `U1.survival.full`, `U1.killpoint.after`, `U1.headroom` |

`PLAN_PAGE` maps each plan kind to the page it runs on, both kinds to `memory`, so an engine made for one page can tell which plan kinds are its own; `PlanKindOf<P>` is the plan kinds of page `P`.

`PlanState`, parsed from the page's plan key by `parsePlan`, is `{ v: 1, run, kind, build, levers, levered, ascentCapMb, rows, cursor, inFlight, reruns, seq, loads, kills, voids, deaths, startedAt }`.
`run` is `<UTC yyyymmddThhmmssZ>-<4 hex>` (`mintRunId`); `build` is the build id the run started under; `levers` are the parsed levers with their defaults in `lines.ts`.
The schema is a union keyed by `kind` with one variant, the memory plan kinds with the memory levers, so another page's levers would be a variant of their own; the `plan` event's `levers` are keyed by its `planKind` the same way.
Each of `rows` is `{ state, halt }`: the row program's state, and how the shared layer ended the row, or null: `{ kind: 'no-reading', stepKey }` for the step whose fifth void ended it, or `{ kind: 'gl-unavailable', stepKey }` for the step whose GL could not be made.
`cursor` is the index of the row being run, `rows.length` once every row has ended.
`inFlight` is `{ row, stepKey, attempt, voids, tab }` from a step's start until its outcome is folded, `tab` the tab id of the page that began the step, which a load reads when the step's marker was lost; `reruns` holds the same counts, without the tab, for each step that may run again with counts of its own (one voided or blocked, or the step that was waiting when a died-after-terminate death came) until it starts again; when the row's program ends a row, that row's entries stay there after the cursor leaves it until the next `beginStep` drops them, so a finished plan whose last row its program ended keeps that row's last entries, and when the shared layer ends a row (`no-reading` or `gl-unavailable`) its entries are dropped as the cursor leaves it; it exists so a death between saving a voided step and clearing its marker reads as a death after completion, not as a death of a step in flight, and a voided step's count survives other steps of its row run before it.
`seq` is the next posted row's sequence number, and `loads`, `kills`, and `voids` count the run's page loads, kills, and voids; `deaths` counts the deaths the liveness report covers that the load verdicts found (see `isProcessDeath` below).
The plan holds counts, positions, and outcomes; its one reading is each MI-GAN probe cell's `highWaterBytes`, and every other reading travels in the posted rows; every row family's state is defined now (`untouched`, `killpoint`, `runs`, `headroom`, `probe`, `exemption`, `threads`, `gaps`, `cycles`), and the node test "the serialized plan at the full plan largest state is under 16,000 characters and parses back" fills every one at its largest and prints the length.

`createPlan` makes the plan at load 1 with its `plan` row and, stamped right after it, the `opening` events it is given, which Start uses for its own `load` row.
It refuses, naming the rows, a `rows` lever that names a row outside the plan kind, and a plan holding a row whose family has no program yet (`missingPrograms`); today the `untouched`, `killpoint`, and `runs` families have one, so Start and Short run with default levers are refused until the other programs land.
`beginStep(plan, nowWall, tab)` raises the step's attempt (carrying its counts from `reruns` when the step reruns, and dropping the reruns of any row the cursor has left) and posts `step-start`; `completeStep` folds the outcome `scoreCompleted` gave and posts `step-end`.
Every function that changes the plan returns the new plan and the rows to post, stamped with the run, the next sequence numbers, the time, and the load, so the engine persists one value and then enqueues the rows.

The shared layer owns what holds for every row, so no program repeats it:
- A `void` outcome is counted in `voids`, and the step reruns with its own void count raised; the fifth void of one step ends what `voidCapScopeFor` names for its kind, which for every memory step is its row, `no-reading`, posted in its `row-end`.
- A `blocked` outcome reruns the step without counting it.
- A `gl-unavailable` outcome, a GL context or texture the step's setup could not make after its retries, ends the row `gl-unavailable`, posted in its `row-end`, without counting a kill or a void.
- Any other outcome goes to the row's program; when the row then has no next step, its `row-end` is posted and the cursor moves past it.
- An outcome folded into a row before the cursor's (a death in a later step's wait, below) posts a new `row-end` with `amends: true` when it changes the row's verdict, and never moves the cursor back; when the amended row changes what the cursor's row reads from the plan so that it has no next step, the cursor's row's `row-end` is posted and the cursor moves past it.
- A row the shared layer ended keeps its verdict: an outcome folded into it later changes nothing.

A row program is `{ next, fold, verdict }` over its own state: `next(state, ctx)` is the row's next step and its key, or null when the row has ended; `fold(state, planned, outcome)` the state after an outcome; `verdict(state)` the row's verdict.
`ctx` is the `PlanContext`: the load, the encode mode, the headroom ladder's ceiling (`U1.killpoint`'s last held step, or the `ceilingMb` lever when that row reached it or is not in the plan, less one chunk, floored to a chunk, at most `ascentCapMb`), the probe's chosen MI-GAN input, and the levers.
`encodeMode(kind, rows)` is `full` when `U1.survival.full` ran all its runs with no GL context loss; in the full plan, else `low` when `U1.survival.low` did, else `none` when `U1.survival.none` ran all its runs, else none survived; in Short run, else `low`.

A `Step` is `untouched` (`mb`), `ballast` (`mb`, `release: 'all'`), or `sequence`: its `stages`, `master` size, `hole`, `condition` (`standIn`, `gl`, `ballastMb`, `decoder`), `threads`, `wait`, `decode`, and `after` (`gl`, `openDecoder`).
A sequence's `wait` is `{ kind: 'cooldown', scale }`, the cooldown default of the largest stage the previous worker ran times the `defaultsScale` lever, which a row program cannot know, since it depends on the previous worker's run, so the program names the rule and not the number, or `{ kind: 'gap', ms }`, the gap a U2 row measures.

What the shared rules read per step kind is in three functions in `steps.ts`, each an exhaustive switch over `Step['kind']` with no default, so a new kind adds its case there and the rules stay as they are:

| Function | What it gives | Every memory kind |
| --- | --- | --- |
| `hiddenGraceMsFor(step)` | the hidden time a completed step may have and still count, which `scoreCompleted` reads | the hidden grace, 4 s |
| `resumeWaitMsFor(step, scale)` | the least wait after a load that was not fresh, when `step` is the dead one, which `applyLoad` reads | a sequence's largest stage's cooldown default times `scale`; 0 for `untouched` and `ballast` |
| `voidCapScopeFor(step)` | what the step's fifth void ends, `row` or `step`, which `voidStep` reads | `row` |

No step kind's fifth void ends the step alone yet, and `voidStep` throws if one does.

The `runs` program serves `U1.survival.full`, `.low`, `.none`, and `U1.panorama`.
Each run is the step `run-<k>`: `[depth, encode]` at 2 threads beside the stand-in, on 2048 x 1536 (the panorama on 2048 x 512), under the row's own GL (the panorama under the encode mode, `none` when none survived, returning to full in `after` when that mode is not full), waiting the cooldown.
A survival counts the run; the first `failed`, `timeout`, or `killed` ends the row; a `died-after-terminate` for the run last counted turns it into the row's first non-survival.
Its verdict reads `k of N, then <score> in <phase>`, or `N of N` (`verdictText`); its state also records whether a counted run lost its GL context, which the encode mode reads.

The `untouched` program serves `U1.untouched`: one step, keyed `untouched`, of the `untouchedMb` lever's size.
The runner reports its phases with `untouchedPhase`: `alloc:<mb>` while it allocates the chunk that brings the total to `mb`, and `hold:<mb>` while it holds them; the verdict reads a kill's phase back with `parseUntouchedPhase`, from the same module, so the two cannot drift.
A `held` outcome reads `survived`, a `throw` reads `throw at N MB`, and a kill reads `killed at N MB` with N from its phase, or `killed in <phase>` when the phase names no size (`wait`, `setup`, `after`, or `unknown`); before the step ends the verdict reads `not run`.

The `killpoint` program serves `U1.killpoint` and `U1.killpoint.after`, each a ladder of `ballast` steps keyed `mb-<N>`, one chunk of the `chunkMb` lever apart, from one chunk up to the ladder's last step, `topMb`: the `ceilingMb` lever floored to a whole chunk (`ladderTopMb`), which the row's state takes from the levers when the plan is made.
Its state holds `topMb`, `heldMb` (the last step held, 0 before the first), and `end`.
A `held` step moves `heldMb` up to its size, and holding `topMb` ends the row at the ceiling; a `throw` ends it `throw at` the step's size, and a kill ends it with the kill point the step's size, keeping the phase the kill came in; so after a throw or a kill, `heldMb` is the step below.
A step run after a reload grows the ballast again from nothing (see "The page"), so its `fill:` phases, and a throw while it does, name totals below the step's size; the kill point is still the step's size, and the kill's phase, kept in `end.phase`, shows the smaller total.
A ceiling below one chunk leaves the ladder no step, so the row is made already ended at its ceiling.
The runner reports its phases with `ballastPhase`, `fill:<mb>` while it allocates and fills the chunk that brings the ballast to `mb` and `hold:<mb>` while it holds it, and the program reads a kill's phase back with `parseBallastPhase`, from the same module.
Its verdict is `{ kind: 'killpoint', heldMb, end }` and reads `kill point N MB in fill` (or `in hold`, or `in <phase>` for a phase that names no size), `throw at N MB`, or `no kill up to N MB` with N the last held step, which is the `ceilingMb` lever when the chunk divides it; before the row ends it reads `not run`, or `held N MB so far`.
The headroom ceiling `planContext` reads from `U1.killpoint` agrees with that row's own last held step at every ending: holding `topMb` gives the same floored step as the lever does, which `test/harness-killpoint.test.ts` checks.

#### The rows

Every row the harness posts is `{ kind: 'harness', v: 1, run, seq, rowId, at, load, event }`, where `rowId` is `<run>:<seq>`, the key readers dedupe by, `at` is the device's ISO wall time, and `load` the page load that posted it.
Every row is typed `HarnessRow` where `stampRows` in `plan.ts` builds it, and the readers parse it with `parseHarnessRow`, so both hold the one schema, `harnessRowSchema`.

| `event.type` | Fields |
| --- | --- |
| `plan` | `planKind`, `rows`, `levers`, `levered`, `ascentCapMb` |
| `load` | `tab`, `environment` (the checklist's `EnvironmentRead`), `navigatorStandalone`, `navigation`, `lockHash`, `models`, `wakeLock` (the wake lock's latest answer when the row was made, after the load's or Start's own request has had up to `WAKE_ANSWER_MS`, 1,000 ms, to answer: `held`, `refused` with the error's name, `unsupported`, or `released`; null when none had answered), `webLocks`, `runnerLock` (`held` with `waitedMs`, how long the load waited for the runner lock, or `absent` without Web Locks), `verdict`, `outboxDropped` |
| `step-start` | `row`, `stepKey`, `attempt`, `step` |
| `step-end` | `row`, `stepKey`, `outcome` |
| `step-lost` | `row`, `stepKey`, `attempt`, `verdict`, `phase`, `markerAgeMs`, `aliveAgeMs`, `hiddenMs`, `attributedTo`, `afterCompletion` |
| `liveness` | `deadTab`, `killIndex` (the plan's `deaths` after this death, from 1), `appMarker` (`survived`, and the stored `value`, parsed as JSON when it parses, or null), `lockAtLoad` (the dead tab's lock as the load read it before it waited for the runner lock, or after the wait when the run was written during it) |
| `liveness-late` | `deadTab`, `afterMs` (2,000 or 10,000 after the `lockAtLoad` reading), `lock` |
| `wake-lock` | `state` |
| `row-end` | `row`, `verdict`, `amends` |
| `done`, `stopped` | `loads`, `kills`, `voids` |

A `LockReading` is `{ kind: 'read', held, pending }`, whether `navigator.locks.query()` lists a held lock and a pending request of the dead tab's lock name (both false: free), `absent` without Web Locks, or `failed` with the reason when the query threw or did not answer within `LOCK_QUERY_MS` (1,000 ms).
A `StepOutcome` is `held` (a ballast step's `mb`, `chunks`, `checksums`, and `fillMs`), `throw` (`atMb`, `message`), `ran` (a `Score`, `survived`, `failed` with its phase and `AnalysisError`, or `timeout` with its phase, and the run's `SequenceReading`), `killed`, `died-after-terminate`, `void` (`hidden`, `left`, `background`, or `died-idle`), `blocked`, or `gl-unavailable` (with the reason).
A `SequenceReading` holds each stage's `op`, `ms`, and high-water mark in stage order, the run's wall time, the gap from the latest termination, the setup's time, the products' shapes, the condition (GL mode, texture bytes, the GL build's time and spot check, frames drawn, when the context was lost, the stand-in's and the ballast's `ChecksumPair`s, and whether they match), the hidden time, and the load.

#### The step marker and the load verdicts

The step marker, stored under the page's step key, is `{ run, row, stepKey, step, attempt, voids, tab, load, phase, startedAtWall, aliveAtWall, visibility, hiddenSinceWall, hiddenMs, longestHiddenMs, pagehideAtWall, waitingOut }`; `waitingOut` names the step whose worker termination this step's wait is waiting out, with that step, its largest stage, and when it terminated, or is null when no worker has terminated in this load.
`classifyLoad(plan, marker, build, nowWall)` reads the stored plan and marker and answers the first row that matches:

| Plan | Marker | Verdict |
| --- | --- | --- |
| none | any | `fresh` |
| another build's | any | `stale` |
| no step in flight | none, or another run's | `fresh` |
| no step in flight | this run's, written before the plan's latest load (a later load applied it and died before clearing it) | `applied-earlier`, named `fresh` in the `load` row |
| no step in flight | this run's, written in the plan's latest load | `after-completion`, with how the process died by the rows below |
| a step in flight | none, or not this run's, step, and attempt | `marker-lost` |
| a step in flight | `pagehideAtWall` set | void `left` |
| a step in flight | `visibility: 'hidden'` | void `background` |
| a step in flight | `longestHiddenMs` above the grace | void `hidden` |
| a step in flight | phase `wait`, a `U2.` row | `killed` in `wait` |
| a step in flight | phase `wait`, `waitingOut` set | `died-after-terminate`, attributed to `waitingOut` |
| a step in flight | phase `wait`, `waitingOut` null | void `died-idle` |
| a step in flight | any other phase | `killed` in that phase |

A kill's outcome carries `markerAgeMs` (from the step's start), `aliveAgeMs` (from the last heartbeat), and `hiddenMs`; a `died-after-terminate` carries `sinceTerminateMs`, from the termination to the last heartbeat.
The death rules above use the 4 s hidden grace for every step kind.
`scoreCompleted(outcome, marker, nowWall)` voids as `hidden` a step that completed after a hidden period longer than its kind's grace (`hiddenGraceMsFor`), the period it is still in included; a period of exactly the grace counts, a `blocked` outcome stays blocked, and a `void` keeps its reason.

`isProcessDeath(verdict)` says whether a verdict is one of the deaths the liveness report covers: `killed`, `died-after-terminate`, `marker-lost`, and the voids `died-idle` and `background`.
`fresh`, `stale`, `applied-earlier`, and the void `left` are not deaths; `after-completion` and the void `hidden` are deaths of the process that ran the step, but the report does not cover them.

`applyLoad(plan, verdict, nowWall)` raises `loads` (a stale plan is left as it is), raises `deaths` for a verdict `isProcessDeath` names, and the rows it posts carry the new load:

| Verdict | What it does to the plan |
| --- | --- |
| `fresh` | nothing more |
| `applied-earlier` | nothing more: the load that applied the marker posted its rows |
| void | posts `step-lost`, raises `voids`, and the step reruns with its void count raised; the fifth void ends the row `no-reading` |
| `killed` | posts `step-lost`, raises `kills`, and folds the kill into the step's row; the step never reruns |
| `died-after-terminate` | posts `step-lost` with `attributedTo`, raises `kills`, and folds the death into the row that ran the waited-out step, amending that row's verdict when it had ended; the waiting step runs next, as its next attempt, if its row still wants it |
| `after-completion` | posts `step-lost` with `afterCompletion: true`, and folds nothing |
| `marker-lost` | posts `step-lost` in phase `unknown` with no ages, raises `kills`, and folds a kill in phase `unknown`; when the row no longer names the step in flight, it folds nothing |

It also answers `leastWaitMs`: after any verdict but `fresh` and `stale`, the next step waits at least `resumeWaitMsFor` of the dead step with the `defaultsScale` lever, from the load: its largest stage's cooldown default, times `defaultsScale`, and 0 for a ballast or untouched step.
For `died-after-terminate`, and for an `after-completion` or `applied-earlier` marker that records a death in a wait while an earlier step's worker drained, the dead step is the waited-out one, whose worker may still be tearing down, not the waiting step, which had started none; for a lost marker whose step the row no longer names, it is the longest default (20 s).
`applied-earlier` waits `resumeWaitMsFor` of the marker's dead step by the same rule, counted from this load, since the load that applied the marker died before its first step could wait it.

#### The outbox

`createOutbox({ page, storage, post })` keeps every row the page enqueues under the page's outbox key, stored as `{"v":1,"dropped":D,"refused":R,"rows":[...]}`, before any post of it.
`flush()` posts the oldest row, one request at a time, until none waits or a post fails; a row leaves when the sink answers `{ "ok": true }` or a 4xx, which counts it in `refused`, and anything else keeps it; a flush already running is joined.
Past 500,000 UTF-16 code units the oldest rows are dropped, and a write that throws drops the oldest rows until it fits; both count in `dropped`.
A row dropped while its post was in flight is no longer counted dropped once the sink records or refuses it.
`dropped` and `refused` are stored with the rows, so a later page reads them back; they are totals for as long as the key exists, across runs, since nothing resets them, so the drops between two `load` rows are the rise in their `outboxDropped`.
Storage is the record: `enqueue`, `makeRoom`, and each step of a flush read the stored outbox again before they change it, so a page's change starts from what is stored, not from the copy it read when it was created, and two pages may both post a row, which readers dedupe.
When not even the empty outbox fits, the key is removed to free its space for the plan and marker writes: the counts stay in memory until a write fits, and a page that loads before then reads them as 0, leaving the `seq` gaps as the record of what was lost.
`makeRoom()` drops the oldest rows until at least the plan's 16,000-unit budget is freed, for a plan or marker write that threw.
Nothing the outbox does throws, and `flush` never rejects.
`createPost({ fetch })` calls `fetch` unbound, so the page passes the browser's own, and posts a body to `/api/log` as `application/json`, with `keepalive` when it is at most 60,000 bytes and a 10 s timeout, as the checklist does, and answers `recorded`, `refused` with the status, or `failed` with the reason.
The 30 s flush timer belongs to the engine.

#### The engine

`createEngine(deps)` in `engine.ts` runs a plan on a page.
Its dependencies are the page, its `Storage`, a lock manager (`navigator.locks`, or null without Web Locks), the `Clock`, the `VisibilitySource` of `platform/visibility.ts`, the outbox over the same storage and page, the runner, the build id, the tab id, the load's facts the `load` row carries (`environment`, `navigatorStandalone`, `navigation`, `lockHash`, `models`), a `getRandomValues` for the run id, `onStatus`, which the page renders, `wakeLock` (`navigator.wakeLock`, or null without it), and `onWakeLock`, which hears each wake-lock answer and null when the engine releases the lock.
One dependency is optional: `liveness`, `{ locks }` (the lock manager with `query()`, or null without Web Locks), which the memory page passes; without it the engine takes no tab lock, writes no app-shaped marker, and posts no liveness row (see "The liveness report").
The `Engine` it returns has five methods: `load()`, `start(kind, { levers, levered })`, `continue()`, `stop()`, and `requestWakeLock()`.
None of them throws to the page: a failure ends in the status.

The runner implements `Runner`, declared in `engine.ts`: `execute(step, phase, signal, facts)` runs the step's phases, reporting each name as it begins, and answers a `StepOutcome`; `release()` drops everything it holds.
`facts()` answers the step's `StepFacts` when it is called: the plan's load and the marker's `hiddenMs` and `longestHiddenMs`, a hidden period the page is still in counted in both, which a sequence's reading records.
Everything a step does ends in an outcome; a rejection is kept for a step the runner cannot execute at all, and the engine stops the run with the status `failed`, `the runner threw: <message>`, as a write that throws twice does.
A runner reports `wait` (`WAIT_PHASE`) before a step's work, and a sequence step reports `setup` (`SETUP_PHASE`) after its wait, while an untouched step goes from its wait to its `alloc:` phases and a ballast step to its `fill:` phases, or straight to `hold:<mb>` when it holds its size already; a heavy stage runs in the phase `runPhase(stage)`, `run:depth`, `run:encode`, or `run:inpaint`, and `after` (`AFTER_PHASE`) begins once the step's worker has terminated.
The engine reads those names back with `stageOfPhase`: a step that reported a `run:` phase becomes the load's latest termination, with its largest stage by cooldown default and the wall time it reported `after` (or answered, when it reported no `after`), and every later step's marker in that load names it as `waitingOut`.

`load()` reads the plan and the marker under the page's keys and answers one of `idle`, `resume`, `done`, `stale`, `elsewhere`, or `storage-failed` with the reason.
Before anything else it requests the wake lock and, with the liveness dependency, the tab lock (see "The liveness report").
With the liveness dependency and a stored verdict `isProcessDeath` names, it then reads the lock manager at once, before step 2, since the dead page held the runner lock as well as its tab lock, and the wait in step 2 lasts as long as the browser keeps them, up to `LOCK_WAIT_MS`; it reads it again 2 s and 10 s after that.
1. No stored plan answers `idle`; a plan of another build answers `stale`, its `build` read before its shape, so a plan an earlier build stored is stale even when this build no longer parses it; a plan that does not parse, a plan of another page's kind, and, beside a plan of this build, a marker that does not parse answer `storage-failed`, naming what failed.
   None of these writes anything or requests the runner lock.
2. Otherwise the engine requests the runner lock, `noisy-harness-runner`, with `ifAvailable`.
   When another page holds it and the stored plan has a step in flight, the engine requests it again with an abort signal of `LOCK_WAIT_MS` (10,000 ms), with the status `waiting-for-lock` ("Waiting for the previous run to let go"); when that wait expires, or at once when no step is in flight, it answers `elsewhere` ("Running in another tab") and has written nothing.
3. Holding the lock, it reads and classifies the stored run again, since the page that held the lock may have changed it.
4. With the liveness dependency and a verdict `isProcessDeath` names, it reads the dead page's app-shaped marker, and takes its tab lock from the reading made before step 2 when the stored plan and marker are as they were then; it reads the lock manager again now, and counts the 2 s and 10 s readings from this reading, when the verdict became a death only in step 3 or the page that held the lock wrote the run while this page waited, which shows it was alive after the first reading.
   A holder alive at the first reading and killed before its next heartbeat (at most 1 s later) leaves the run as it was, so the early reading, which saw its lock held, stands, and the 2 s and 10 s readings show when the lock came back; with one tab, as on the phone, the dead page is the one this page replaced, and no holder is alive.
   It then gives its wake-lock request up to `WAKE_ANSWER_MS` to answer.
5. It then makes one plan write holding the `load` row, stamped first with the new load and the lock's `waitedMs`, the rows `applyLoad` posts, the `liveness` row after a death, with the next two seqs reserved for its late rows, and the `done` row when the verdict ended the plan's last row; clears the marker and the app-shaped marker the verdict's tab left; enqueues the rows; flushes the outbox; and arms the 30 s flush timer.
   The first step after the load waits at least `applyLoad`'s least wait, counted from here.
6. A plan with no next step answers `done`, releasing the runner, the lock, and the wake lock; any other answers `resume`, holding the lock until DONE or Stop.

Without Web Locks the lock is skipped and the `load` row says `absent`.

`start(kind, { levers, levered })` answers a refusal in the status, naming it: `createPlan`'s (a `rows` lever outside the plan kind, or rows with no program) or a plan kind of another page.
It then requests the wake lock, before its first await, so the tap that called Start carries the request, and the runner lock with `ifAvailable`, answering `elsewhere` when another page holds it; holding the lock, it gives its wake-lock request up to `WAKE_ANSWER_MS` to answer before it makes its `load` row.
Holding the lock, it reads and classifies the stored run again, since another page of the same storage may have started a run after this page loaded and died with it unfinished.
A run `load()` would apply (a plan of this page and build, with a marker that parses or none) that has a step in flight or a step left to run is refused as `stored-run`, "A run is stored here: reload the page to resume it.": Start releases the lock and writes nothing, so the reload's load applies the stored run as the load verdicts say.
A stored plan at DONE or of another build, and a stored run that cannot be read (a plan or a marker that does not parse, or a plan of another page's kind), are replaced.
Start then makes one plan write holding the `plan` row and, stamped right after it, the `load` row of its own load: the load's facts, verdict `fresh`, the runner lock it holds (`held` with `waitedMs` 0, or `absent`), and the outbox's `outboxDropped`.
It removes any marker, enqueues the rows, and runs the loop, so a run that reaches DONE without a reload posts `plan`, `load`, `step-start`, `step-end`, `row-end`, and `done`, every row in load 1.
Start passes no ascent cap to `createPlan`.
It is ignored while a load is under way and while a run is held: after Stop or a failure, until the step that was in flight has ended, which is at once in its wait and once the runner answers its abort while it executes.

`continue()` runs the step loop of a resumed plan; for each step:
1. It waits until the page is visible, with `waitingForVisible` in the status, and begins no step while it is hidden.
2. Synchronously: `beginStep` and one plan write; the marker in phase `wait`; with the liveness dependency, the app-shaped marker; the heartbeat armed, which rewrites `aliveAtWall` every second while the step is in flight; the `step-start` row enqueued and a flush begun.
3. Phase `wait`: the load's least wait, if one is left, while the flush has at most 2 s to post `step-start`; Stop or a failure ends the wait at once.
4. `runner.execute(step, phase, signal)`: each phase it reports rewrites the marker synchronously, before the callback returns.
   Throughout the step, `visibilitychange` writes `visibility`, `hiddenSinceWall`, `hiddenMs`, and `longestHiddenMs` synchronously, and `pagehide` sets `pagehideAtWall` and leaves the step marker in place; with the liveness dependency it also removes the app-shaped marker (see "The liveness report").
   A wake-lock answer first brings the marker and the app-shaped marker to the page's visibility, if they differ, since the lock's release comes with hiding the page.
   A page frozen and crashed in its hold once recorded the release but left its marker visible, so the next load read a kill where it should read `background`: the wake-lock answer had run and written its row, and the driver's crash, sent before the page had applied the freeze, landed before `visibilitychange` ran.
   `lifecycle('frozen')` now returns only once the page reads `hidden` (see "Browser driver"), and this sync covers the same gap for a kill the driver does not send.
5. When the runner answers, synchronously: `scoreCompleted`, `completeStep`, and one plan write with `inFlight` cleared (holding the `done` row when no step is left); the marker and the app-shaped marker cleared; the rows enqueued.

Every marker write refreshes `aliveAtWall`.
A plan or marker write that throws calls the outbox's `makeRoom()` and is retried once; while a run is under way, a second throw stops the run as Stop does, below, with the status `failed` and the reason, since a harness that cannot write its plan or marker cannot attribute a kill: the plan and the marker are removed, so a later load finds no run and scores no kill.
At a load, the plan write's second throw answers `storage-failed`.
At Start, the plan write's second throw answers `failed` and leaves storage as Start found it: no `stopped` row is posted, and a stored plan Start would have replaced stays; the wake lock is released (see "The wake lock").
Rows are enqueued after the plan write that stamped them, so a page that dies between the two loses them, and their `seq` is the gap the readers flag.
The two seqs right after a `liveness` row's are reserved for its `liveness-late` rows, so a gap there is a late row whose page died or was reloaded before it was due, not a lost row.

DONE: with no step left the engine releases the runner, the lock, and the wake lock and shows `done` with the rows still waiting to post.
Stop, while a run is held: the `stopped` row is enqueued with `loads`, `kills`, and `voids`, the plan, the marker, and the app-shaped marker are removed, the wake lock is released, and the outbox is kept; the step in flight is aborted, and the runner and the lock are released at once, or once the runner answers.
Stop at DONE, or with no run held, does nothing.
After DONE and Stop the outbox goes on flushing every 30 s without the lock.
A load that answers `idle`, `stale`, or `elsewhere`, or `storage-failed` because the stored run cannot be read, writes nothing, the outbox included: rows a stopped run left waiting are posted by the next run's flushes.
A load whose plan write throws has already called `makeRoom()`, which drops the oldest waiting rows, counted in `dropped`, and rewrites the outbox key (or removes it), before the retry whose throw answers `storage-failed`.
`statusText(status)` gives each status's headline.

#### The wake lock

`wake-lock.ts`'s `createWakeLock(api, onAnswer)` holds the screen wake lock for the engine.
`request()` calls `api.request('screen')` before it returns, unless a lock is held, and answers `held`, `refused` with the error's name, or `unsupported` without the API; a lock the browser releases on its own, as Chrome does when the page is hidden, answers `released`.
A request that answers while another's grant is held, a grant (given back at once) or a refusal, changes nothing and answers `held`, so the state is `held` exactly while a lock is held.
`release()` releases the lock and clears the state, answering null; a grant that arrives after the release is released at once.
The engine requests it at every load, in `start` before its first await, in `requestWakeLock()`, and, from a load, Start, or `requestWakeLock()` until DONE, Stop, or a failed run or Start, whenever the page turns visible without a lock held; it releases it at DONE, at Stop, when a run under way fails, and when a Start fails before its run begins (its plan write throwing twice, or Start itself rejecting), and the page's own release posts no row.
Each answer goes to `onWakeLock`, and while the page holds a run's plan (from its load's or Start's plan write until DONE, Stop, or a failure) into a `wake-lock` row; a load's own answer is in its `load` row.

#### The liveness report

`liveness.ts` gives a page the two facts only a killed page can report, read by the page that loads after it: whether a `localStorage` key written before the kill is still stored, and whether the dead page's Web Lock was let go.
The engine uses it only when it is given the liveness dependency; the memory page passes it.
- The tab lock: at the top of every load the engine requests the Web Lock `noisy-tab-<tab>` (`tabLockName`) for this page's tab id, with a callback whose promise never settles, so the page holds it for its life; without Web Locks it requests nothing.
- The app-shaped marker, under `noisy.harness.job.<tab>.heavy` (`appMarkerKey`), never under `noisy.job.`, the prefix the app's own liveness markers and startup sweep are to use (not built yet): `{ scene, op, build, tab, startedAt, hiddenAt }`, where `scene` is the run id written as a UUID v4 (`sceneOf`), the same for every step of the run, `op` is a sequence step's first stage or the step's kind (`ballast`, `untouched`), and `startedAt` and `hiddenAt` are wall times.
  It is written right after the step marker at a step's start, through the same write that makes room in the outbox and retries once (a second throw stops the run as a marker write does); `hiddenAt` is set when the page is hidden and cleared when it is visible again; it is removed when the step's outcome is saved, at Stop and a failure, and on `pagehide`, which a killed page never runs.
- The report: after a verdict `isProcessDeath` names, the load reads the dead tab's marker (the step marker's `tab`, or the plan's `inFlight.tab` when the marker was lost) and `navigator.locks.query()`'s answer for the dead tab's lock, and its plan write holds the `liveness` row with `killIndex`, the plan's `deaths`, and reserves the next two seqs.
  The dead tab's marker is then removed, as is the marker of the tab any other verdict names (`verdictTab`), which posts no liveness row.
  The lock is read when the load finds the death, before it waits for the runner lock, which the dead page held too: a browser that keeps a dead page's locks would keep both, so a reading after the wait would find them let go, and one kept past `LOCK_WAIT_MS` leaves the page "Running in another tab", applying nothing and posting no row.
  A tab still alive also holds both locks while its step is in flight, and its heartbeat rewrites the step marker every second, so when the stored plan or step marker changed while the load waited, the holder was alive after that first reading, and the load reads the lock again once it holds the runner lock and counts from that reading instead; a live holder that wrote nothing during the wait, such as a frozen page, still reads as the first reading found it.
  At 2 s and 10 s after that reading (`LIVENESS_LATE_MS`) the page reads the lock again, and once the load's plan write is made it enqueues each reading as a `liveness-late` row under its reserved seq, with no plan write, no lock, and nothing a step waits for; a page that dies or is reloaded before a reading posts no row for it, and its reserved seq is a gap.
`test/harness-liveness.test.ts` drives each death verdict and each other verdict through the engine's fake world, the dead tab's lock held, pending, and free, and held with the dead page's runner lock, a reload before the late rows, the tab lock, the app-shaped marker's life, an engine without the dependency, and the wake lock's answers.

#### The ballast

`ballast.ts` holds the memory ballast: buffers on the page's main thread, each allocated once and filled in place, never copied.
- `fillChunk(bytes, chunkIndex)` fills a buffer with seeded xorshift32 words: from the seed `chunkSeed(i)`, `0x9E3779B9 ^ (i + 1)` unsigned, each 32-bit word is the next state of `x ^= x << 13; x ^= x >>> 17; x ^= x << 5` (unsigned after each left shift), so the content is incompressible and a pure function of the chunk's index.
  It answers the chunk's checksum and throws a `RangeError` for a buffer that is not whole 32-bit words.
- `pageSum(bytes)` is the checksum: the 32-bit wrapping sum of the first word of every 16 KB page (`PAGE_BYTES`, every 4,096th word).
  Taking it reads one word per 16 KB, which touches every page of a host whose pages are 16 KB (this Mac's `hw.pagesize` is 16384; the phone's is inferred), so a sum that still matches after a run shows every page was touched after the run and still held what was written.
- `leveredAllocator(allocate, throwAtMb)` is the allocator every buffer the runner holds is made through: `allocate(mb, totalMb)` calls the page's `allocate` with `mb` times 10^6 bytes, except that with the `throwAtMb` lever set, the allocation that would bring its ballast's total to the lever or past it throws a `RangeError` first, as an allocation the browser refuses does; either throw answers `{ atMb: totalMb, message }`.
- `createHeap({ allocate, chunkMb, now, onChange })` is the kill-point ladder's ballast.
  `growTo(mb, { onFill, between })` allocates and fills new chunks, each with the next index, until the heap holds `mb`, calling `onFill` with the total before each chunk and awaiting `between` after it (false stops the growth); it answers the chunks added and the time allocating and filling them took, or why it stopped (`throw` with the total and the message, or `stopped`).
  `truncate(mb)` drops the newest chunks until the heap holds at most `mb`; `check()` answers each chunk's `ChecksumPair`, `{ chunk, fill, after }`, its sum taken now beside its sum when filled; `release()` drops every chunk.
- `createStandIn(allocate, mb)` makes the stand-in: one filled chunk of `mb` at index `STAND_IN_CHUNK` (1,000,000, an index no ladder reaches), whose `check()` answers its pair; a holder releases it by dropping it.
  The sequence executor holds it (see "The page").

`test/support/ballast-reference.ts` codes the fill and the checksum a second way, a word at a time through a `DataView`; `test/harness-ballast.test.ts` holds `ballast.ts` to it byte for byte, and the browser scenarios hold the checksums Chrome posts to it.

#### The page

`/dev/harness/memory.html`, from `src/dev/harness/memory.html` and `memory.ts`, is the page the owner runs the memory rows from.
It carries `<meta name="apple-mobile-web-app-capable" content="yes">` and links no manifest, since the app's manifest would open the app.
On each load it parses its levers, then creates the engine over the page's `localStorage`, `navigator.locks` (null without Web Locks), the browser clock, `createVisibilitySource`, an outbox posting through `createPost` with the page's `fetch`, the runner below, the build id, a tab id from `mintTabId`, `navigator.wakeLock` (null without it), the liveness dependency with `navigator.locks`, and the load's facts: the checklist's `EnvironmentRead`, `navigator.standalone` (null in a browser without it), the navigation type, and the build's lock hash and model ids.
The runner's inputs fetch with the page's `fetch` and make bitmaps with `createImageBitmap`, and its services are built as the analysis service page builds one (see "The analysis service page"): on the sequence worker at `NOISY_WORKER_URLS.sequence`, with `ortBase` `NOISY_ORT_DIR`, the build's parsed lock, and one model loader for every service the page builds, opened with the page's `caches`, `fetch`, `crypto.subtle`, and `navigator.locks` when the first service is built; a lock that does not parse, or a browser without Web Locks, makes building a service throw, which stops the run with the reason.
The page defines `window.__noisyHarness` for the browser scenarios, not writable or configurable: `holeDigest(shape, width, height)` answers the SHA-256, in lowercase hex, of the hole the runner's inputs make.
It then calls `load()` once, and `continue()` when that answers `resume`.
Start begins the `full` plan and Short run the `short` plan, each with the page's levers; both are shown while the status is one Start can act on (Ready, stale, a storage failure, a refusal, DONE, stopped, or failed) and hidden while the page loads, waits for the runner lock, or runs.
They are hidden at "Running in another tab" too: while the other page holds the run, Start would answer `elsewhere` again, and once that page has died, Start refuses the unfinished run it left (`stored-run`).
Reloading the page loads that plan instead, which scores the dead step and continues the run.
Stop is shown only while a run is held.

`status-view.ts` renders the status in large text:

- the context, `Home Screen app` when `navigator.standalone` is true or `(display-mode: standalone)` matches, else `Safari tab`;
- the headline: `DONE` at the end, `statusText` for the engine's other statuses, and the page's own: `Starting`, a failure such as a lever's, and `Start refused (no executor): <rows>`;
- the step in flight in the page's words, `U1 untouched: 10 MB, attempt 1` or `U1 survival none: depth then encode, attempt 1`, and its phase, such as `Waiting before the step`, `Setting up the step`, `Running encode`, `After the run`, `Allocating up to 3 MB`, or `Holding 10 MB`, and for a ballast step `Filling up to 8 MB` or `Holding 8 MB, filled and summed`;
- the run's loads, kills, and voids, and each ended row's `verdictText`, such as `U1 untouched: survived`;
- `N rows waiting to post`, or `Every row posted`;
- `Levered: not a phone reading` when the run, or before a run the page's levers, are levered;
- the wake lock's latest answer in words, such as `Screen kept on` or `The screen may sleep: the wake lock was refused (NotAllowedError)`, and, under the headline while the answer is a refusal, a full-width "Tap to keep the screen on" button (`data-testid="wake-tap"`) whose click calls the engine's `requestWakeLock()` inside the tap.

A page passes the view its own `describeStep(step, view)`, so another harness page renders its own steps through it.
The text is plain DOM, and `style.ts` adopts the checklist's stylesheet and a second constructed sheet for the status and the full-width buttons.
`#report` (`data-testid="report"`) holds the page's state as JSON for the browser scenarios, the wake lock's latest answer as `wakeLock` among it, with `data-phase` (the status shown: the engine's status kind, or the page's `starting`, `page-failed`, or `not-executed`), `data-row`, and `data-step` (the phase of the step in flight).

`levers.ts`'s `parseLevers(search)` reads one query parameter per lever of `LEVER_DEFAULTS` and parses it with zod into the plan's `Levers`, over the defaults:

| Lever | Value |
| --- | --- |
| `rows` | row ids joined by commas, none twice |
| `runs`, `chunkMb`, `untouchedMb`, `ceilingMb`, `cycles`, `throwAtMb` | a whole number of at least 1 |
| `startMb` | a whole number of at least 0 |
| `gaps` | 1 to 16 numbers of at least 0, joined by commas |
| `defaultsScale`, `timeoutS` | a number above 0 |

Numbers are plain digits with an optional decimal point.
A parameter the page has no lever for, a lever given twice, or a value that does not parse fails the page at load with `The lever <name> cannot be used: <reason>`, and the page then creates no engine and writes nothing.
A run is levered when its levers differ from the defaults; a `rows` lever counts whenever it is given, since the default is the plan kind's rows.
The runner executes each step with the levers of the plan the engine last reported, so a resumed run keeps its own levers whatever its URL now says.

`runner.ts`'s `createRunner({ clock, levers, allocate, service, inputs, onHolding })` is the memory page's `Runner`, with one executor per step kind.
`service(threads, diag)` builds an analysis service at that thread count that logs to `diag`, and `inputs` is the page's `Inputs` (see "The inputs").
The untouched chunks and the ballast are made through `leveredAllocator(allocate, throwAtMb)` (see "The ballast"), so an allocation that throws, and the one that would bring the step's total to the `throwAtMb` lever or past it, end the step `throw` at that total with the error's message, in both executors; the stand-in is made through `leveredAllocator(allocate, null)`, since it is not the ballast the lever measures.
`onHolding` hears the chunks and megabytes the runner holds, the untouched step's, the ballast's, and the stand-in's together, whenever they change; the page shows them in `#report` as `runner`.

Every executor begins with the wait, `waitOut` in `sequence-run.ts`: it reports `wait` and waits until the step's wait has elapsed from the latest heavy termination of every service the runner built, released ones included.
That termination is the later of each service's `lastHeavyTermination`, which names the largest stage whose inference the worker reported, and the runner's own record, which it takes from the events the services log: at a sequence worker's `worker.terminate`, the largest stage, by cooldown default, whose `stage.start` that worker logged.
The runner's record of a worker is taken after the service's, on the same clock, and names a stage at least as large, so the larger of the two counts, and a worker whose encoder failed before inference is waited out as an encoder's; at the same time, the record with the longer cooldown counts.
An untouched or ballast step's wait is the cooldown default of the stage that termination names times the `defaultsScale` lever; a sequence step waits its own `wait` (see "A sequence run").
With no termination in the page load, the wait ends at once; the engine's own least wait after a load comes before the runner is called.
Stop's abort during the wait answers `blocked` with the reason `aborted by Stop`, as in every phase below.

The setup then reconciles what the runner holds with what the step runs beside.
`RELEASE_ORDER` lists what the runner can hold, in the order a setup releases it: `untouched` (the untouched step's chunks), `ballast` (the filled ballast), `stand-in`, `services` (each built service is dropped, its termination record kept, so every later wait still counts from it), and `inputs` (every master and hole `inputs` keeps).
`keptFor(step)` says what a step keeps: an untouched step nothing, a ballast step the ballast, and a sequence step the services and the inputs, and the stand-in when its condition holds one; the setup releases everything else, in that order.
So a sequence step drops the ballast a kill-point row left before its worker spawns, and the kill-point ladder of `U1.killpoint.after` drops the stand-in, the services, and the inputs the survival rows left.

The untouched executor, after its wait and setup, allocates the step's `mb` in chunks of the `chunkMb` lever, the last one smaller when `chunkMb` does not divide it, each a zeroed `Uint8Array` that nothing writes or reads.
Before each chunk it reports `alloc:<total>`, the total that chunk brings the step to, and it yields a task between chunks, so the heartbeat runs and Stop is heard.
With every chunk allocated it reports `hold:<mb>`, holds for 5 s times the `defaultsScale` lever, drops the chunks, and answers `held` with `mb`, the chunk count, no checksums, and `fillMs` 0.
Stop's abort drops the chunks and answers `blocked`, which the engine, having left the run, does not fold.

The ballast executor runs a kill-point step:
1. It waits, then its setup releases everything but the ballast.
2. It keeps a ballast heap of the `chunkMb` lever's chunks (made anew when the run's chunk or `throwAtMb` differs) and truncates it to the step's size, so the chunks the step below held stay as they were and a larger ballast an earlier row left in the same page load goes, except its chunks up to the step's size, which hold the same words a new fill would write.
   A step run again in the same load (voided `hidden` after it held) holds its size already, so it allocates nothing, reports no `fill:`, and answers a `fillMs` of 0.
   After a reload or `release()` the heap is empty and grows from nothing, its `fill:` phases naming totals below the step's size.
3. It grows the heap to the step's size, reporting `fill:<total>` before each new chunk and yielding a task after it; a ladder step from the step below allocates and fills one chunk.
4. It sums every chunk, reports `hold:<mb>`, and holds for 2 s times the `defaultsScale` lever.
5. It answers `held` with `mb`, the chunk count, every chunk's `ChecksumPair` (its index, its sum when filled, and its sum before the hold), and `fillMs`, the time allocating and filling the new chunks took.

The ballast stays held from one step of the ladder to the next and past the ladder's last step, since the engine scores a step after it answers and may void even the last step and run it again.
A `throw` keeps the chunks below the refused one as they were filled, for the same reason: a throw voided `hidden` and run again allocates only the refused chunk.
Stop's abort in the wait, the fill, or the hold (answering `blocked`) drops it, and so does `release()`, which the engine calls at DONE, at Stop, and when a run fails.
A row that ends at its ceiling, at a throw, or `no-reading` in the same page load leaves the ballast held for the next step's setup: a ballast step truncates it to its size, and the untouched and sequence steps drop it.

The sequence executor runs a sequence step through `runSequenceStep` (see "A sequence run"), with the service of the step's `threads`, built the first time a step asks for it and kept until a setup or `release()` drops it.
Its setup, after the release, holds the stand-in when the step's condition asks for one: one filled chunk of the `chunkMb` lever's size (`createStandIn`), made by the first such step and kept, so it is filled once and held from the row's first run to its last.
It is released by the next step whose setup does not keep it, a kill-point step, an untouched step, or a sequence step without one, and by `release()` at DONE, at Stop, and when a run fails; a row that keeps it, such as the next survival row in the same load, holds the same one.
The setup then gets the step's master from `inputs`, its hole when a stage is `inpaint`, and the models of its stages through the service's `fetchModels`.
A master that does not arrive, a model fetch that fails, or a stand-in allocation that throws answers `blocked` with the reason, with no worker spawned; the engine reruns a blocked step without counting it.
The step's next attempt waits its wait, then reports `setup` and waits there until 30 s (`BLOCKED_RETRY_MS`) times the `defaultsScale` lever have passed since the blocked answer, then runs its setup.
The retry time is not a cooldown, so it is waited in the `setup` phase, not the `wait`: a death in it is scored as a death in `setup` is (see "The step marker and the load verdicts"), the page still holding what the blocked attempt's setup made, and is not folded as `died-after-terminate` into the run before, whose cooldown the wait has already waited out.
The run's condition records no GL (`gl` `none`, no texture bytes, no GL build, no frames, no context loss), the stand-in's `ChecksumPair` taken once the worker has terminated, no ballast, and `checksumsMatch`, whether each pair's sum after the run equals its sum when filled.
Stop's abort anywhere in a sequence step, its wait included, releases everything the runner holds.

`unbuiltCondition(step)` names what a sequence step asks for that no executor builds yet: a GL condition other than `none` or a GL change in `after`, a memory ballast beside the sequence, a resident decoder, a decode, or a decoder opened in `after`, and an `inpaint` stage with no hole; such a step, and a step handed over before any plan was reported, reject, and the engine stops the run with the reason.

`EXECUTED_ROWS` holds the rows whose every step an executor runs: `U1.untouched`, `U1.killpoint`, `U1.killpoint.after`, and `U1.survival.none`, the survival row whose condition holds no GL.
`unexecutedRows(kind, levers)` names the rows of the plan Start or Short run would make that are not in it, and the page refuses that Start itself, `Start refused (no executor): <rows>`, writing and posting nothing.
It names none when the plan's own refusals apply first (a `rows` lever outside the plan kind, or a row with no program), which the engine answers; so Start and Short run with default levers are refused for their rows with no program, and a `rows` lever naming only rows of `EXECUTED_ROWS` that the plan kind holds makes a plan that runs: with Start any of them, and with Short run only `U1.killpoint` and `U1.killpoint.after`, since its plan holds neither `U1.untouched` nor `U1.survival.none`.

#### The inputs

`inputs.ts`'s `createInputs({ fetch, makeBitmap, clock })` gives a sequence its pixels.
`master(size, signal)` answers the synth scene's master at `size`, fetched from `GET /dev/synth/master?width=&height=` (`masterUrl`, see "The synth master route") with `cache: 'no-store'` the first time that size is asked for in the page load and kept until `release()`; its `bitmap()` makes a fresh `ImageBitmap` of it each time it is called, which the page's `makeBitmap` does with `createImageBitmap(new ImageData(rgba, width, height))`.
A fetch that answers other than 2xx, a body of another length than four bytes a pixel, a fetch that rejects, Stop's abort, and no answer within 60 s (`INPUT_TIMEOUT_MS`) each answer the reason, such as `the 2048 x 1536 master could not be fetched: the server answered 503`, and keep nothing, so the next attempt fetches again.
`hole(shape, size)` answers `holePlane(shape, size)` (see "The harness's holes"), made the first time and kept until `release()`.
`bytes` is the size of every master and hole kept.
The guide at long edge 1024, which the exemption row opens a decoder with, is not built yet.

#### A sequence run

`sequence-run.ts`'s `runSequenceStep(deps, run)` runs one sequence step once, through `deps.service`, the part of the analysis service it uses (`runSequence`, `cancelHeavy`, `fetchModels`, `lastHeavyTermination`), hearing the events the service logs through `deps.listen` with their times on the runner's clock, and reading `deps.latest()`, the latest heavy termination of every service the runner built.
`run` carries the step, the timeout (the `timeoutS` lever in ms), `retryAt` (the clock time a blocked attempt before it set, or 0), the runner's setup, the phase callback, Stop's signal, and `facts`, which the engine gives `execute` (see "The engine").

1. `wait`: `waitOut` waits until `waitMsAfter(step.wait, latest)` has elapsed from `latest.atMs`: for `cooldown`, `COOLDOWN_MS` of the stage `latest` names times the wait's `scale` (the `defaultsScale` lever, which the runs program puts in the step), so 20 s at 1 and 200 ms at 0.01 after an encoder; for `gap`, its `ms`; with no termination, nothing.
   It pauses whole milliseconds, and again until the clock has reached the wait's end (`pauseUntil`), since a timer can fire before its delay has elapsed by the clock.
2. `setup`: when `retryAt` is later than now, the step first waits until then (`pauseUntil`); then the runner's setup runs, and its time, from the end of that wait to the setup's answer, is the reading's `setupMs`; a setup that answers why it could not make the run ready ends the step `blocked` with that reason.
3. `run:<stage>`: the sequence runs in a new worker, `runSequence` with the setup's stages and input and Stop's signal, and each `stage.start` the service logs reports `run:<op>`.
   A timer of the timeout calls `cancelHeavy()` when it fires.
4. `after`, reported once the sequence has ended in `onDone` or `onFailed`, which the service calls only after it has terminated the worker; the setup's condition is then read, summing the stand-in.

The score is `survived` when the sequence ended in `onDone`; `timeout` in the phase the timer fired in when it ended `cancelled` after the timer fired; and otherwise `failed` in the phase the run was in, with the `AnalysisError` `onFailed` gave, which for a failed wasm memory growth is the worker's `failed` reply.
A cancel by Stop's signal answers `blocked`, `aborted by Stop`.
The reading, `SequenceReading` in `rows.ts`:

| Field | What the run records |
| --- | --- |
| `stages` | each stage that ended, in order: its `op`, `ms` from its `stage.end`, and the worker's `wasmHighWaterBytes` |
| `wallMs` | the time from the worker's `worker.spawn` to its `worker.terminate`; null when no worker spawned |
| `gapMs` | the time from `deps.latest().atMs`, read at the spawn, to the spawn; null when no worker had terminated in the page load |
| `setupMs` | the setup's time |
| `product` | the depth map's size, least, and largest value; the embeddings' dims; the plate's size; each null for a stage that did not end |
| `condition` | the setup's condition, read in `after` |
| `hiddenMs`, `longestHiddenMs`, `load` | from `facts()` once the run has ended |

Since the setup comes after the wait and the spawn after the setup, a run's `gapMs` is at least its wait plus its `setupMs`.

## Browser driver

`tools/drive-chrome.mjs` runs the browser scenarios under `test/browser/scenarios/` in Chrome over the DevTools Protocol and writes one directory per run under `test-results/`.
`npm run test:browser` builds both modes and then runs every scenario.
The driver is dependency-free: it starts Chrome with `--remote-debugging-pipe` and speaks the protocol over the pipe on Chrome's file descriptors 3 and 4, so it opens no debugging port.
`tools/drive-chrome.mjs` only calls `main` in `test/browser/driver/cli.ts`; the driver's modules and the scenarios are TypeScript under `test/browser/`, which Node runs by type stripping and `tsconfig.test.json` type-checks.

```
test/browser/
  scenario.ts                the scenario API: Scenario, ScenarioContext, MessagePattern
  page-globals.d.ts          the page's window.__noisyTest, as page functions may call it
  driver/
    cli.ts                   flags, selection, the run directory, signals, the summary
    run.ts                   one scenario at a time, the checks every scenario gets, checks.jsonl
    browser.ts               the page operations, apart from any protocol: BrowserPage, DrivenPage, Browser
    chrome.ts                Chrome's launch, and BrowserPage over the DevTools Protocol
    cdp.ts                   the protocol connection over the pipe
    server.ts                targets, starting or attaching to tools/serve.mjs, the levers
    processes.ts             process groups and the run's cleanup
  scenarios/
    index.ts                 SCENARIO_FILES: every scenario file, in run order
    <area>.scenario.ts       each exports `scenarios`
```

### Flags

`node tools/drive-chrome.mjs [scenario ...] [flags]`; `--help` prints the same with examples.

| Argument or flag | Default | Meaning |
| --- | --- | --- |
| `scenario` | every scenario | an exact id, or a prefix ending in `*` (`'shell.*'`); several may be given, and one that matches nothing is a usage error |
| `--list` | | print the selected scenarios (id, target, covers, title) and exit |
| `--target <name>` | | only the scenarios of this target |
| `--base-url <url>` | | attach to a server already running at `<url>` instead of starting one per scenario; needs `--target` naming what that server serves; skips the scenarios that read the sink's files (below) |
| `--headed` | headless, `--headless=new` | show Chrome's window |
| `--chrome <path>` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | the Chrome executable |
| `--dev-root <dir>` | `build/dev` | the dev build the targets serve |
| `--production-root <dir>` | `build/production` | the production build the targets serve |
| `--out <dir>` | `test-results/chrome-<UTC yyyymmddThhmmssZ>-<4 hex>` | the run directory, which must not exist |

| Exit | Meaning |
| --- | --- |
| 0 | every selected scenario passed |
| 1 | a scenario failed |
| 2 | a usage error, a run directory that exists, or a scenario list the driver refuses (a file not in `SCENARIO_FILES`, an id used twice or not of the id form) |
| 3 | Chrome, a build, or a server is missing or broken, Chrome closed its pipe or exited during the run, the driver itself failed, or something the run started could not be stopped; a leftover outranks 0 and 1; a Chrome that stops answering without exiting is not detected and hangs the run |
| 130 | SIGINT, SIGTERM, or SIGHUP, after stopping everything the run started; a second one SIGKILLs what is still running and exits at once |

### Targets

A scenario names the target it runs against: the server mode and the build that server serves at `/`.
`TARGETS` in `test/browser/driver/server.ts` lists them:

| Target | Server | Build |
| --- | --- | --- |
| `dev` | `tools/serve.mjs --mode dev` | `--dev-root` |
| `dev-production-build` | `tools/serve.mjs --mode dev` | `--production-root`, through the server's `--root` |
| `production` | `tools/serve.mjs --mode production`, as `npm start` runs it | `--production-root` |

`startServer` passes a target's `server` to `tools/serve.mjs` as `--mode`.
`SERVER_MODES` in the same file mirrors the server's own `MODES`: each mode says whether it has the dev surfaces (the fault state, the sink, the request log, and the CSP report endpoint).
Only for a mode that has them does the driver pass `--results` and `--request-log`, clear the fault state of an attached server, and read the server's CSP reports; for any other mode every lever throws.
A new server mode is an entry in `SERVER_MODES` and a target in `TARGETS` that names it, and `startServer` holds the mode to what it asks of `tools/serve.mjs` today: it passes `--mode <mode> --port 0 --root <build>` (and, with the dev surfaces, `--results` and `--request-log`), and it takes the server's address from the first output line that matches `serve: <mode> mode on http://127.0.0.1:<port>/`, failing the run with exit 3 when none arrives within 10 seconds.
Before Chrome starts, the driver reads each build root the selected scenarios need and exits 3 when its `build.json` is missing or of the other mode, naming the npm script to run for the default root, or, for a root given with `--dev-root` or `--production-root`, that flag and the `tools/build.mjs` command that writes a build.
After starting a server it reads the served `/build.json`, which scenarios see as `t.build`.

With `--base-url`, the driver starts no server, runs only the scenarios of `--target`, reads `/build.json` from that URL, and, when the target's mode has the dev surfaces, clears the server's fault state (`DELETE /dev/fault`) before and after each scenario.
The sink is read from files, so `t.server.sinkLines()` throws in that mode; a scenario that reads it sets `readsSinkFiles`, and an attached run leaves it out, lists it as skipped on standard output and in `summary.json`, and refuses it with exit 2 when it is named by its exact id.
A scenario that posts to the sink reads its rows back and sets `readsSinkFiles`, so an attached run never writes a scenario's rows into the sink of a server it did not start, such as a phone sitting's.
If such a run is interrupted, the driver clears the fault state of the attached server before it exits.

### A run

Chrome runs once per run, with a fresh profile in a `noisy-chrome-profile-*` directory under the system's temporary directory.
For each selected scenario, in the order of `SCENARIO_FILES` and of each file's array, the driver:

1. starts `tools/serve.mjs` for this scenario alone, on a free port (`--port 0`), with `--root` the target's build and its results directory, request log, and output under the scenario's `server/` directory;
2. opens a page in a new browser context, so no storage is shared with another scenario, at a 1280 x 800 viewport (until the scenario calls `emulate`), and attaches to every worker under the page, the workers those start included, holding each at its start until its console, exceptions, and requests are recorded;
3. runs the scenario, and records a failed `the scenario ran to its end` check when it throws or runs past its timeout (60 seconds unless it sets `timeoutMs`);
4. reads the page's diagnostics once more, giving up after 5 seconds on a page that does not answer, waits 300 ms for late console entries and CSP reports, and records the checks every scenario gets (below);
5. closes the browser context, giving up after 5 seconds, and stops the server.

Once a scenario has timed out, its levers reject without reaching the server, so a scenario still running in the background cannot change the fault state under the next one.
A renderer crash fails the page's pending and later operations at once, a `waitFor` among them, and a `waitFor` gives up at its deadline even on a page that never answers.
A scenario can crash the renderer itself with `crash()` and go on with `reopen(path)` (see "The scenario API").
An error in the driver's own steps after the server started, such as a server that died during the scenario, is recorded as a failed `the runner finished the scenario` check (or in the check that read the server, with the path of the server's `serve.log`), and the run goes on to the next scenario.
When Chrome can no longer be driven after a scenario, because it exited or closed its pipe, the driver reports that scenario's outcome and ends the run with exit 3.

Chrome and each server run in a process group of their own, so a Ctrl-C in the terminal reaches only the driver.
On success, on failure, and on SIGINT, SIGTERM, or SIGHUP, the driver stops everything it started, newest first, each step for at most 20 seconds:

- the open page's browser context, waiting at most 5 seconds;
- each server: SIGTERM to its process group, up to 5 seconds for the leader to exit, then SIGKILL to the group;
- Chrome: `Browser.close`, waiting at most 5 seconds for its reply, then up to 5 seconds for the leader to exit, then SIGKILL to the group, which also ends any helper process left behind;
- the profile, deleted.

A signal that arrives while the run is already stopping changes nothing but a message; a second signal SIGKILLs every process group still registered, deletes the profile, writes the summary if it is not written yet, and exits 130 at once.
An uncaught exception or unhandled rejection in the driver stops everything the same way and exits 3.

### Output

```
test-results/<run>/
  checks.jsonl               one row per check and one per scenario, appended as each is made
  summary.json               the run: browser, servers, selected ids, each scenario's outcome, totals, exit status
  chrome.log                 Chrome's stdout and stderr
  scenarios/<id>/
    <name>.png               the scenario's screenshots, and any file it wrote with t.file
    browser-console.jsonl    every console message, log entry, and uncaught exception, from the page and its workers
    browser-requests.jsonl   every request from the page and its workers, with its status or failure
    server/serve.log         the server's output
    server/requests.jsonl    the server's request log
    server/results/          the server's sink (log.jsonl, captures/) and csp-reports.jsonl
```

A check row:

```json
{"kind": "check", "seq": 82, "at": "2026-10-01T17:01:05.016Z", "scenario": "threads.default", "covers": [],
 "check": "the probe started one pthread worker fewer than its threads", "ok": true, "expected": 3, "actual": 3}
```

`expected` and `actual` are present for `t.equal` checks, and `evidence` when the check was given one.
A scenario row has `"kind": "scenario"`, the scenario's `id`, `title`, `target`, `covers`, `status` (`passed` or `failed`), `ms`, `vendorOrt`, `dir`, and `failedChecks`.
`summary.json` also lists the `skipped` scenarios with the reason, and `inFlight`, the scenario that was running when the run was interrupted or ended early, with the checks it had failed by then; its `totals` count `passed`, `failed`, `interrupted`, `notRun`, and `skipped`.

Standard output starts with one line, `drive-chrome: <Chrome version> headless|headed; <n> scenario(s); <run directory>/`.
Then comes one line per scenario, `PASS` or `FAIL` with its id, covers, and time, followed by a `vendor ORT <level>` line for each distinct message of the vendored runtime (with `x<count>` when it came more than once) and, for each failed check, its name, expected and actual or its evidence, and its `seq` in `checks.jsonl`.
The last line gives the totals and the path of `summary.json`.

### Checks on every scenario

After each scenario the driver records these checks, each row's `covers` naming its verification row:

- `I6 every request is same-origin`: the historical check label now covers the explicit request allowlist: app origin, configured HTTP(S) GPU origin, and admitted Cloudflare analytics origins (`static.cloudflareinsights.com`, `cloudflareinsights.com`). Local `data:`, `blob:`, and `about:` URLs are also allowed. Any other origin fails the check.
- `I6 no CSP violation reported by the browser`: Chrome reported no Content Security Policy issue (the DevTools Protocol's `Audits.issueAdded`), enforced or report-only, for the page or any worker under it, during the scenario; this holds on every page, with or without the test surface and on any server mode, and catches a violation the page swallows, such as an `eval` inside a `try`, which neither logs a console error nor reaches the test surface of a production build.
- `I6 no csp.violation in the page diagnostics`: before each `goto` and `reload` and at the end, the driver reads `window.__noisyTest.diagnostics()` from a page that has the test surface, and none of the events may be a `csp.violation`; `evidence.pagesWithTestSurface` counts the page loads read, so a production page or a dev page, which has no surface, shows as 0.
- `I6 no CSP report at the server`: no report reached the server's `/dev/csp-report` during the scenario; recorded only when the server's mode has the dev surfaces.
- `I7 no console error, warning, or exception from the app`: no console message or browser log entry of level error or warning, and no uncaught exception, from the page or any worker under it.
  Two kinds are listed in the row's evidence and fail nothing by themselves: one whose emitting script, the top stack frame, is under `/vendor/ort/` on the server's origin, in `evidence.vendorOrt` with its text and count, and also printed under the scenario's line on standard output and in its `vendorOrt` in `summary.json`; and one the scenario declared with `t.expectMessage`, or a page operation declared for itself (only `crash` does), in `evidence.provoked` with the declared reason.
  A failed load is the browser's own log entry about the resource (source `network`), not a message of the vendored runtime, so a failed load of a runtime file fails the check unless the scenario declared it.

### The scenario API

```ts
// test/browser/scenarios/example.scenario.ts
import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

function isolationText(): unknown {
  return document.querySelector('[data-testid=isolation]')?.textContent ?? null;
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'example.isolated',
    title: 'the shell reads isolated: yes',
    target: 'dev',
    covers: ['C6'],
    async run(t) {
      await t.page.goto('/');
      const text = await t.page.waitFor('the shell to render', z.string(), isolationText);
      t.equal('the shell reads isolated: yes', text, 'isolated: yes');
      await t.page.screenshot('shell');
    },
  },
];
```

A scenario declares `id` (lowercase words joined by dots or hyphens, unique), `title`, `target`, `covers` (the verification rows it checks, printed with each of its checks), an optional `timeoutMs`, `readsSinkFiles: true` when `run` calls `t.server.sinkLines()`, and `run(t)`.
`t` is a `ScenarioContext`:

| Member | What it does |
| --- | --- |
| `t.page` | the page operations, below |
| `t.server` | the levers: `setFaults(rules)` and `clearFaults()` (`/dev/fault`), `sinkLines()` (the sink's `log.jsonl`, each a `{ at, row }` or `{ at, capture }`), `requestLog()` (`/dev/requests`), `cspReports()` (`/dev/csp-report`); once the scenario has timed out, each rejects without reaching the server |
| `t.build` | the served `build.json`: `mode`, `buildId`, `app`, `workers`, `devPages`, `ort` |
| `t.baseUrl`, `t.dir` | the server's origin with a trailing slash; the scenario's output directory |
| `t.equal(check, actual, expected, evidence?)` | records a check that passes when the two are deeply equal (`isDeepStrictEqual`); returns whether it passed |
| `t.ok(check, condition, evidence?)` | records a check that passes when the condition holds |
| `t.expectMessage({ because, channel?, source?, level?, text?, url? })` | declares a console message, log entry, or exception the scenario provokes on purpose, such as the error the browser logs for a fault's 500 |
| `t.file(name, data)` | writes a file into the scenario's directory and returns its absolute path |

A failed check does not stop the scenario; a thrown error does, and is recorded as a failed check.

| `t.page` operation | What it does |
| --- | --- |
| `goto(path)`, `reload()` | navigate (the path resolved against the server's origin) or reload, and wait for the load event, at most 30 seconds |
| `evaluate(schema, fn, ...args)` | runs `fn(...args)` in the page, awaits it, and parses the result with the zod schema |
| `waitFor(description, schema, fn, { timeoutMs?, intervalMs? })` | runs `fn` every `intervalMs` (100) until it returns something other than `null`, `undefined`, or `false`, and parses that; after `timeoutMs` (10000) it throws naming the description and the last value |
| `click(selector)` | scrolls the first match into view and clicks its centre with `Input.dispatchMouseEvent`; throws if no element matches or another element covers that point |
| `type(selector, text)`, `press(key)` | clicks to focus, then one `Input.dispatchKeyEvent` pair per character; `press` takes `Enter`, `Tab`, `Escape`, or `Backspace` |
| `setFiles(selector, paths)` | sets a file input's files to absolute paths (`DOM.setFileInputFiles`) |
| `emulate({ width, height, deviceScaleFactor, mobile, colorScheme })` | sets the viewport in CSS pixels, its scale factor, and whether a mobile device is emulated (`Emulation.setDeviceMetricsOverride`), and `prefers-color-scheme` (`Emulation.setEmulatedMedia`), for the rest of the scenario |
| `intercept(rules)` | until the next call, answers the page's and its frames' requests (not its workers') whose method and URL (the origin plus `path`, no query) match a rule: `hold` leaves them unanswered, `fail` fails them as a network error, `respond` answers `status` and a text `body` without reaching the server; other requests go on, held ones go on when the rules change, and `[]` stops (`Fetch.enable` patterns, `Fetch.requestPaused`) |
| `lifecycle(state)` | `frozen` freezes the page as Chrome freezes a background tab, hidden first (`visibilitychange` to `hidden`) and then with its tasks stopped, and returns once the page reads `hidden` (`Page.setWebLifecycleState` answers before the renderer applies the state, and a `crash()` sent in between, with the page's main thread busy for a few milliseconds, lands before any `visibilitychange`); `active` resumes it and shows it again, with a `visibilitychange` to `visible`, and returns once the page reads `visible` (`Page.setWebLifecycleState`, then a blank page opened in the scenario's browser context and closed again, which keeps the emulated viewport and shows the page within tens of milliseconds, headless or headed) |
| `clearIndexedDb()` | deletes the IndexedDB databases of the server's origin in the page's browser context, as clearing a site's data does, and Chrome force-closes every open connection to them (`Storage.clearDataForOrigin`) |
| `screenshot(name)` | writes the viewport to `<scenario dir>/<name>.png` |
| `console()`, `requests()` | the scenario's console entries and requests so far, page and workers |
| `workers()` | the worker targets attached under the page now, each `{ type, url, title }`, a worker that another worker started included, in the order they attached; a target leaves the list on its own detach, so one whose detach never reaches the driver stays listed (`Target.attachedToTarget`, `Target.detachedFromTarget`) |
| `crash()` | crashes the page's renderer at once (`Page.crash`), mid-task on a busy page, so the page gets no `pagehide`, and resolves when the browser reports the crash (`Inspector.targetCrashed`), rejecting after 10 seconds; it does not read the page's diagnostics first, since reading waits for the page's current task to end, so `I6 no csp.violation in the page diagnostics` does not cover the crashed page, while the browser's CSP reports from it, recorded as they arrive, still count; the crash's console entry, `the renderer crashed, as the scenario asked`, is declared by the operation, so it fails no check, while any other crash's entry, `the renderer crashed`, still does; until `reopen`, every other operation rejects with a message holding `the page crashed; call reopen`, and `console()`, `requests()`, and `workers()` still answer |
| `reopen(path)` | after a crash, closes the crashed page (`Target.closeTarget`) and opens a new one in the same browser context, so it shares the dead page's storage; repeats the page's setup, the recorded domains, the viewport and color scheme the last `emulate` set (or the default viewport), automatic attachment to workers, and the standing `intercept` rules; and navigates to `path`; the console, request, and CSP records go on in the same lists, so the end-of-scenario checks cover both pages, and `workers()` starts empty; it rejects when the page has not crashed |

A page function is sent to the page as its source text, so it must be a function declaration or an arrow function that uses only its arguments and the page's globals, and its result crosses back as JSON.
Page functions are type-checked against the DOM library; `test/browser/page-globals.d.ts` declares `window.__noisyTest` with the members scenarios call, typed from `src/app/events.ts`, because the test project cannot import `src/app/test-surface.ts`, whose `Root` type reaches `platform/build-id.ts` and its build-time constant.
Protocol replies and page results are parsed with `z` from `src/core/zod.ts`, never cast.

`test/browser/driver/browser.ts` declares the page operations apart from any protocol (`BrowserPage`, and `DrivenPage` and `Browser` for the runner); `chrome.ts` is their only implementation.

### Adding a scenario

1. Add it to the `scenarios` array of the `test/browser/scenarios/<area>.scenario.ts` it belongs to, or create a new file that exports one.
2. Add a new file to `SCENARIO_FILES` in `test/browser/scenarios/index.ts`, where its position sets its place in the run; the driver exits 2 while any `*.scenario.ts` file in that directory is missing from it.
3. Run `npm run typecheck`, then `node tools/drive-chrome.mjs <id>`, then `npm run test:browser`.

### Scenarios

`node tools/drive-chrome.mjs --list` prints them; today's files cover:

| File | Scenarios |
| --- | --- |
| `shell.scenario.ts` | the shell reads `isolated: yes` and the served build id; each worker entry loads as a module worker: the gif stub answers, and the sequence and decode workers each throw the string they are sent as a message they cannot parse, which reaches the page as an `error` event; the `no-isolation` fault and a reload show `isolated: no`, and clearing it restores isolation |
| `boot.scenario.ts` | the dev build's diagnostics hold exactly one `env` event with every snapshot field; the production build has no `__noisyTest` and renders the shell |
| `levers.scenario.ts` | a `/vendor/ort/` fault fails the page's fetch with a 500 that the request log records; a binary capture from the page lands in the sink with one SHA-256 on the page, in the reply, and on disk; `tools/check-headers.mjs` passes for the index, the workers, the runtime's three files, and a model; the page fetches `/dev/synth/master` at 2048 x 1536 as `application/octet-stream` with the fixture's pinned SHA-256, and an odd width answers `400` |
| `threads.scenario.ts` | the thread probe completes at ORT's default thread count, `min(4, ceil(hardwareConcurrency / 2))`, with one pthread worker fewer, and posts one row; under `no-isolation` it completes on one thread with no pthread worker |
| `checklist.scenario.ts` | the phone checklist: the index lists sittings A and C, also for an unknown sitting; sitting A lists H1 and H2, and sitting C lists H8, with their exact actions and same-origin links; the conditions and answers to H1 and H2 each post one row with the page's environment snapshot (build id equal to `build.json`'s, cross-origin isolated) and an empty CSP violation list, a mismatch is marked, and answering again appends a row; under the `no-isolation` fault the snapshot posted says `crossOriginIsolated` false; after two dispatched `securitypolicyviolation` events, a post made between them lists the first and a post made after lists both; with the sink's posts held, the answers waiting behind H1's first when the owner leaves the page reach the sink with the snapshot, and ordered by `answeredAt` they are in the order answered; with the sink's posts held, an answer waiting behind H1's is sent as the page is frozen, and its card shows it recorded once the page resumes; with the sink's requests intercepted, a 500 shows "Not recorded", a failed request and a 10-second stall show "No reply", and neither of the first two reaches the sink; "Clear model cache" deletes two planted model caches and not a third cache, says "Cleared 2 model caches.", and then "No model cache was stored."; at 393 x 852 with `mobile`, in light and dark, nothing is wider than the viewport, no link, button, or field is under 44 x 44, and both answers posted there reach the sink |
| `models.scenario.ts` | the model loader page, on the decode operation with each fault on its graph file, the lock's smallest file, except the truncation: a clean fetch caches both files under the lock hash node computes, and a second fetch requests no model file; `http500` fails as `download` 500 with nothing verified; `truncate=6291456:times=1` on the external data fails as `offline` and keeps segments from byte 0 to some `N` of at least 4 MiB and at most the cut, and the retry's request carries `Range: bytes=N-` and is answered `206`; `corrupt` fails as `integrity` with nothing promoted or kept; `stall` with `?stallMs=1000` fails as `stalled`; a request failed by `intercept` fails as `offline`; each succeeds once its fault is gone; a reload deletes another lock's caches and every planted segment, the depth file's first 1000 bytes among them, and the depth fetch requests the whole file |
| `sequence.scenario.ts` | the sequence worker through its page, on the real models and the synth fixtures, at 2 threads: depth on `synth` gives a 686 x 518 map in 0..1 that parses, passes the depth known-answer check, and reads a high-water mark of 277 to 348 MB with one pthread worker attached, and on `synth-pano` a 1190 x 294 map that passes the check at that size, at 277 to 292 MB; depth then encode in one worker give both products, the embeddings with the table's names and dims, the encoder at 708 to 796 MB; encode alone reads 791 to 796 MB; inpaint gives a 2048 x 1536 plate, which on the fixture's hole passes the inpaint known-answer check and reads 411 to 427 MB and 470 to 478 MB on a central box hole; inpaint on the synth master with the memory harness's `corners` and `full` holes gives a plate of the master's size and reads 672 to 700 MB at 2048 x 1536 and 885 to 921 MB at 2048 x 2048, either hole; under `no-isolation` depth completes with no pthread worker attached and passes its known-answer check; a request the worker cannot parse reaches the page as an `error` event and the run after it is answered; with `/vendor/ort/` or the runtime's wasm answering 500, a file evicted from the verified cache, or a hole of another size, each run is answered `failed` with the cause; a run before `init` and a run behind `end` are answered `failed`, a second `init` naming a runtime that is not there changes nothing, and in every scenario the run the page posts after every answer goes unanswered and no reply comes twice; and depth then encode at ORT's default thread count, recorded |
| `service.scenario.ts` | the analysis service through its page, on the real models and the `synth` fixture, at 2 threads, each scenario listing the attached worker targets while the sequence runs: depth then encode give both products and one `onDone` that reads `alive.heavy` false and the record naming encode, with the events one `worker.spawn`, a `stage.start` and a `stage.end` per stage, one `worker.terminate`, and `fetch.start` then `fetch.end` for each model before the spawn; a closed bitmap for the encoder stage gives the depth product, then `onFailed` for encode with `worker`, and the record naming depth; with `/vendor/ort/` answering 500, the first stage fails with `worker` and the record stays null; `cancelHeavy`, and separately the signal's abort, at the encoder's `infer` phase end in `onFailed` for encode with `cancelled` and the record naming encode; and in every scenario but the 500 one sequence worker and one pthread worker were attached, and every worker is detached within 10 seconds of the report settling |
| `decoder.scenario.ts` | the analysis service's decoder through its page, on the real decode worker and models: on the encoder's embeddings of `synth` at 2 threads and a 1024 x 768 guide, a tap at the center of the sphere's disk and one at the center of the box's face each give three 1024 x 768 candidates in descending score whose best passes `checkMask` against that surface's truth, the first `decoded` reply carrying the session's time and the second none, with one `worker.spawn`, a `stage.start` and a `stage.end` per decode, and `worker.terminate` `released`, the decode worker and its pthread workers attached while it decodes; on stand-in embeddings: a decode aborted before the call and one aborted after it resolve `cancelled`, the second's late answer dropped, and the next resolves ok; `release()` while two decodes are pending, and before any, resolves them `cancelled`; `openDecoder` while one is alive cancels the old one's pending and later decodes, and the new one decodes; a message the worker cannot parse fails both pending decodes with the `error` event's message and terminates the worker as `failed`; and with `/vendor/ort/` answering 500, the decoder's external data evicted, embeddings of the depth model, or a tensor of other dims, the decode resolves `worker` naming why the decoder did not start; in every scenario a decode after the release resolves `cancelled` and every worker is detached within 10 seconds of the report settling |
| `store.scenario.ts` | the store's connection and the scene lock through the store page, on Chrome's IndexedDB and Web Locks; the connection scenarios read the posted writes back from the sink, all of them but `store.newer-version` read the stored record back through a separate connection, `store.write` and `store.browser-close` compare the schema, and `store.write` finds the page's database the only one the origin has; the lock scenarios read only the page's report: two writes on one handle say "second write saved" with no `store.reconnect` and leave the four stores, their keys, and the `updatedAt` index at schema version 1; one injected `InvalidStateError` at the first write and at a later one each land the write on a fresh handle with one `store.reconnect`; two in one write answer `unavailable` naming both, store nothing, and use the injection up, and the next write lands with a second `store.reconnect`; a handle closed behind the connection's back lands the next write after Chrome's own `InvalidStateError`; with the site's IndexedDB cleared while Read many awaits its requests, the read is never answered `io`: one `store.reconnect` names the transaction's `UnknownError`, and the connection reopens once, so the read lands or, when that open meets the deletion still under way, answers `unavailable`, and the next write lands in the database created again at schema version 1; a duplicate add answers `io` with the `ConstraintError`, with no reconnect and the handle kept; an upgrade to version 2 from a second connection while a handle is open closes it, reloads the page, and the next write answers `newer-version` 2 with no writer; with no handle open the upgrade is not blocked, no `versionchange` arrives, and every write answers `newer-version`; a held scene lock is refused `open-elsewhere` from the page and from a same-origin frame in under 500 ms with nothing pending, and both are granted once it is released; it is released when its function rejects and when it throws |
| `driver.scenario.ts` | `lifecycle('frozen')` hides the page and stops its timers, and `lifecycle('active')` makes it visible again with the emulated viewport kept; the driver's typing, Backspace, click (a trusted event), and file input, on controls the scenario adds to the shell page; on the shell page with a `localStorage` key written, a Web Lock held, a worker attached, a mobile viewport in the color scheme the host does not report emulated, and a 4-second block busy on the main thread, `crash()` returns well before the block would end and leaves one declared console entry, and `evaluate`, `waitFor` (at once), `goto`, and `intercept` then reject naming the crash; after `reopen('/')` the key is read back, no `pagehide` ran and the block never ended, the lock is not held and is taken at once, the emulation holds, the rejected `intercept` installed no rule, a new worker is attached and none of the dead page's is listed, and the request list holds both pages' loads of `/` |
| `harness.scenario.ts` | the memory harness page, each scenario but the hole digests' reading its rows back from the sink, deduplicated by `rowId` and in `seq` order: the untouched row at 10 MB in 1 MB chunks reaches DONE with `plan`, `load`, `step-start`, `step-end`, `row-end`, and `done`, the `load` row Start's own (`fresh`, the runner lock held without waiting, the page's environment and this build), holding ten chunks in its hold and none after; a `crash()` in the hold, then `reopen`, posts a `load` that took the runner lock without waiting and a `step-lost` `killed` in `hold:10`, and the row ends `killed at 10 MB` with loads 2 and kills 1; a crash while it allocates ends it killed at the size its `alloc:` phase names; a crash in the wait, with the sink's posts held, voids it `died-idle` and reruns it; reloads while it allocates and while it holds each void it `left`; frozen then crashed in its wait, while it allocates, and in its hold, each voids it `background`; frozen for 1 s, resumed, then crashed is `killed` with about 1 s hidden; frozen for 5 s while the step completes voids it `hidden`; five frozen crashes of one step end the row `no-reading` with five voids; with the sink answering 500 the run reaches DONE with six rows waiting, and a reload at DONE posts each of them once; a stored plan that does not parse and one of another build are shown and left as written, and Start then runs a plan of this build; a bad, unknown, or repeated lever fails the page naming it, and levers at their defaults are not levered; `throwAtMb=4` ends the row `throw at 4 MB`; Start and Short run are refused for rows with no program, rows no executor runs, and a row outside Short run, writing and posting nothing; Stop in the hold posts `stopped` and removes the plan and the marker; a same-origin frame standing in for a second tab, opened on a running plan, says "Waiting for the previous run to let go", then "Running in another tab" after `LOCK_WAIT_MS`, offering no Start and writing nothing to the plan or the outbox (a frame shares the page's storage and Web Locks as a second tab does, but it does not hide the first page, as a second tab opened in front of it would); a page that loaded before a same-origin frame started a run and was removed in its hold is refused at Start with "A run is stored here: reload the page to resume it.", writing nothing to the plan, the marker, or the outbox, and its reload voids the frame's step `left` and resumes the run to DONE; at 393 x 852 with `mobile`, in light and dark, nothing is wider than the viewport, no button is under 44 x 44, and DONE is set at 64 px or more; `U1.killpoint` then `U1.killpoint.after` at `chunkMb=1&ceilingMb=30` each climb from 1 to 30 MB and end `no kill up to 30 MB`, every step's checksums equal to `test/support/ballast-reference.ts`'s recomputation from the chunk seeds, the status saying each fill and hold in words (recorded with a `MutationObserver`, since a 1 MB fill is too brief to poll) with no fill in the second row's first step, which holds the first chunk the first row left, and nothing held at DONE; `throwAtMb=12` ends the ladder `throw at 12 MB` with 11 MB the last held; the page stalled in the 8 MB step's `fill:8` (the scenario wraps `Storage.prototype.setItem` so the page loops once the marker in that phase is stored), then crashed and reopened, posts `step-lost` `killed` in `fill:8` and ends the row with the kill point 8 MB and 7 MB the last held; and a crash in the 5 MB step's hold ends it with the kill point 5 MB in `hold:5`; every crash is read back by the next load's `liveness` row, the dead tab's app-shaped marker surviving as that tab's with its step's op (and, for the 8 MB step's fill, the step's start and this build) and its tab lock free at the load, and every `liveness-late` row the sink holds reads the lock free in a seq reserved by its tab's `liveness` row; the last death of each scenario has both late rows, and where the scenario knew the dead page's tab (the crashes in the hold, while it allocates, in the wait, and in the kill-point fill and hold) its `liveness` row and late rows name it; a page frozen and crashed again within seconds of its load may never post its late rows, leaving their seqs a gap; and at 393 x 852 the wake lock held from the load, released by Chrome while the page is frozen, refused (the scenario wraps `WakeLock.prototype.request`) when it turns visible again, which shows "Tap to keep the screen on" at 44 x 44 or more, and granted to a tap on it, each answer a `wake-lock` row, and released at DONE; `U1.survival.none` at `runs=2&defaultsScale=0.25` runs `[depth, encode]` on the real models to DONE, 2 of 2, each run reporting `wait`, `setup`, `run:depth`, `run:encode`, and `after` in order (recorded with a `MutationObserver` on `#report`'s `data-step`), reading a depth high-water mark of 277 to 348 MB and an encoder's of 708 to 796 MB, the bands `sequence.scenario.ts` asserts, with one sequence worker and one pthread worker attached while its stages run, the 100 MB stand-in's checksums equal to node's recomputation and held alone while the stages run, a 686 x 518 map in 0..1 and the encoder's three embeddings, and run 2's gap at least its 5 s wait plus its setup, with nothing held at DONE; the same row at `defaultsScale=0.01` reaches DONE the same way with run 1 held to the bands and the census, run 2 to its depth band, its phases, and its gap of at least 200 ms plus its setup, and run 2's encoder high-water mark and census recorded in its checks' evidence, not asserted, since run 2 then spawns while Chrome still lists run 1's workers; the renderer crashed while run 1 encodes, and with run 1 stopped dead in its `setup`, its `run:depth`, and its `after` (the marker-write stall above), then reopened, ends the row `0 of 2, then killed in` that phase, the reopened page holding nothing at DONE; crashed in the wait before run 2, it posts `step-lost` `died-after-terminate` attributed to run 1 and ends the row `0 of 2, then died-after-terminate`, holding nothing at DONE; with the master's route answered 503 by `intercept` the run is `blocked` naming it, and runs and survives once the route answers again, every attempt run-1 with no kill or void, the last attempt's `step-end` coming at least the 300 ms retry time plus its setup and its worker's life after the last blocked one; and the holes the page's inputs make, `corners` and `full` at 2048 x 1536 and 2048 x 2048, hash in Chrome to the SHA-256 digests `test/fixtures/hole-digests.ts` pins, which `test/holes.test.ts` holds node's bytes to |
| `production.scenario.ts` | against production mode: the shell loads cross-origin isolated with the build id and no `__noisyTest`; `tools/check-headers.mjs` passes for `/`, `index.html`, the hashed scripts, the runtime's three files, and a model, and `/` has no report-only CSP; every request of `test/support/dev-only-paths.ts`, sent raw, and the fault state, checklist, CSP report, request log, and sink routes fetched from the page answer `404`; a model answers `Range: bytes=N-` with `206` and the file's remaining bytes |
