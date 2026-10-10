# D3: the analysis driver

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: no.

## Mission

The models are fetched and verified at boot.
On import, the depth and encoder stages run in the background while the first look is already on screen; depth lands in the document; the decoder opens on the embeddings and is warmed so the first tap is fast; the status line tells the truth at every step; a new import cancels everything cleanly; the plate is produced whenever Motion needs one.
No objects yet (D4) and no motion rendering yet (D6): this package produces the products and owns the worker lifecycle, and the test hooks prove it with the real models.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` sections 2 (the analysis API in one paragraph), 4.2 (plate and objects), 4.4, 5 (`RenderScene`: `masks`, `depth`, `plate` are yours to fill), 6 row D3.
- `plan/evidence/foundations.md` sections 1 (service, listener, stages, decode, ownership and termination, the policies that are the caller's), 2 (models, `fetchModels` before any run, cache names), 3 (test surface, the sink is dev-only), 7.
- `src/dev/service.ts` and `src/dev/decoder.ts`: working examples of construction, `fetchModels` before `runSequence`, a fresh `ImageBitmap` per stage from retained `ImageData`, making the 1024 guide, decoding and releasing.
- `src/core/derive.ts` (`holeMask`, `plateNeeded`, `reconcile`), `src/core/produce.ts` (`applyProduce`), `src/core/schema.ts` (`depthProductSchema`, `plateProductSchema`: the exact shapes `applyProduce` accepts).
- `plan/evidence/D1-return.md` and `src/session/scene.ts` for the scene shape; `plan/evidence/D2a-return.md` and `src/render/types.ts` if D2a has landed, otherwise the contract text in the plan.

Decisions already made:

- Construction at boot: `createAnalysisService` with the browser clock, diagnostics, module workers from `NOISY_WORKER_URLS.sequence` and `.decode`, `ortBase: NOISY_ORT_DIR`, `bundledLock()`, `openModelLoader(...)`, exactly as `src/dev/service.ts` does. `threads`: `navigator.hardwareConcurrency` clamped to 2..8 (a Mac), recorded in the diagnostics.
- `fetchModels` for all four ops starts at boot with a status line `Fetching models 37%`; import is allowed before the models are ready (the first look needs none); analysis starts when both the import and the models are ready.
- Import: bump a generation counter; `cancelHeavy()`; release the decoder; drop every product; then `runSequence(scene, [{ kind: 'depth' }, { kind: 'encode' }], { master: () => createImageBitmap(masterImageData) }, listener, signal)`. A new import within 2 s of the previous start waits for the 2 s to pass before starting its sequence (the first look shows at once regardless); nothing else is debounced or cooled down (deliberate, a Mac; the design's phone cooldowns are not applied, record it as a finding).
- Per-stage timeouts: a timer armed at `onPhase(stage, 'session', ...)` and cleared at the stage's product or failure; depth 60 s, encode 120 s, inpaint 60 s; on expiry `cancelHeavy()`, status `Analysis timed out at <stage>`, the first look stays usable. Every listener callback checks the generation and drops stale ones.
- `onDepth`: `applyProduce({ kind: 'depth', ... })` in the schema's shape, the plane kept in an in-memory products map under its asset id (the SHA-256 of its bytes, or a cheaper deterministic id if hashing a plane costs more than 20 ms; say which).
- `onEmbeddings`: make the guide (master to 1024 long edge, interleaved RGB, as the decoder page does; make it at import time from the `ImageData`), `openDecoder({ scene, embeddings, guide })`, then a warm-up `decode([{ at: { x: 0.5, y: 0.5 }, label: 'include' }], signal)` whose result is discarded; only when it resolves is the status `Ready to tap`, with the warm-up's milliseconds in the diagnostics. A failed warm-up shows `Tapping unavailable: <reason>` and keeps the rest.
- Plate: `requestPlateIfNeeded()`: when `doc.motion.enabled` and `plateNeeded(doc)`, run `[{ kind: 'inpaint', hole: holeMask(doc, masks, masterSize) }]` as its own sequence after the current one finishes (never cancel a running depth/encode for a plate; queue it), status `preparing` meanwhile, `applyProduce({ kind: 'plate', ... })` on `onPlate`, the image kept in the products map. D4 calls it after object edits; D6 wires the toggle; you provide and test the function.
- `reconcile(doc, cache, blocked, intent)` from core: use it to decide the needs if it maps cleanly onto depth, encode and plate within an hour of reading; otherwise hardcode the three decisions above and say so in the Return (either answer is a finding for the source).
- Sink rows (`/api/log`) only under `NOISY_DEV`: `{ event: 'analysis', stage, ms, generation }` per stage and for the warm-up; the status line shows the last timing in dev builds.
- Scene changes go through `scene.ts` so `setScene` on the renderer (when present) receives `depth`, `plate` and `masks` from the products map; nothing in the driver touches WebGL.
- No new runtime dependency.

- Ports: another lane may be serving on 8790 at the same time; for your own curl checks start `tools/serve.mjs` on a different port if it has a port flag (read its usage), and otherwise skip serving. The lead runs the browser scenarios on its own server.

## Scope

- Create: `src/session/driver.ts`, `src/session/products.ts` (the in-memory planes, plates and masks keyed by asset id), `src/session/policy.ts` (the pure lifecycle state machine: generation, debounce, per-stage timeouts, the plate queue; no DOM, no workers), `test/driver-policy.test.ts`, `test/browser/scenarios/driver.scenario.ts`.
- Change: `src/session/scene.ts`, `src/ui/app.tsx` (the status line only), `src/session/test-hooks.ts` (add `analysis(): { status: string; modelsReady: boolean; depth: boolean; embeddings: boolean; decoderReady: boolean; plate: boolean; alive: { heavy: boolean; decoder: boolean }; timings: Record<string, number> }`, `requestPlate(): Promise<void>`, and `injectMask(plane: { width: number; height: number; data: Uint8Array }): void`, the last one dev-only so the plate path can be exercised before D4 exists), `test/browser/page-globals.d.ts`, `test/browser/scenarios/index.ts`.
- Do not touch: `src/analysis/`, `src/core/`, `src/render/`, `src/photo/`, `src/store/`, `src/dev/`, `tools/`, `headers.json`.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests for `policy.ts`: a stale callback is dropped after a new import; the second import within 2 s starts 2 s after the first; a stage past its timeout cancels and reports the stage; a plate request during a running sequence waits and runs after `onDone`; two plate requests coalesce into one.
3. Browser scenario `driver.import` (target `dev`, timeout 300 s, the real models from `/models/`): boot reaches `modelsReady`; after importing the 4032 x 3024 fixture, `depth` is true within 60 s and the document's `analysis.depth` is non-null; `decoderReady` is true within 150 s; the warm-up timing is recorded; `alive.heavy` is false once the sequence is done and `alive.decoder` is true; then a second import of a different fixture immediately followed by a third: at the end exactly one generation's products exist, `alive` shows one decoder and no heavy worker, and no console errors or CSP violations occurred.
4. Browser scenario `driver.plate` (target `dev`, timeout 200 s): after an import completes, `injectMask` with a centered disc of radius 200 at the guide's size, then enable Motion in the document through the test surface's `setMotion({ enabled: true })` (add it to the hooks) and call `requestPlate()`: the status shows `preparing`, `plate` becomes true within 90 s, the plate is master-sized, and `plateNeeded(doc)` is false afterwards.
5. The status line passes through `Fetching models`, `Analyzing: depth`, `Analyzing: encoder`, `Ready to tap` on a normal import, and shows the timeout or failure sentence on the failure paths (one of them exercised by injecting a model fault through `/dev/fault` if the fault grammar allows a quick one; otherwise LEAD).
6. LEAD: the lead reads the timings from the scenario's checks and writes them into the Return and `plan/findings.tsv` (the Mac's end-to-end timeline is one of the findings the demo exists to produce).

## Return

Write `plan/evidence/D3-return.md` in the shape `AGENTS.md` gives.
Include the public shape of `driver.ts` and `products.ts` for D4 and D6, whether `reconcile` was used, and the lifecycle choices that departed from the design.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start objects, tapping in the page, recolor, or motion rendering.
