# D2a return

## What changed

- `src/render/types.ts`: binding RenderScene, Renderer, and RendererDebug types, including selected and future motion/depth/plate inputs.
- `src/render/renderer.ts`: master and plate uploads, label derivation, simplify cache, full still chain, PNG export, resource disposal, and future-frame refusal.
- `src/render/gl.ts`: WebGL2 programs, uniform binding, textures, framebuffers, fullscreen triangle, and resource ownership.
- `src/render/palette.ts`: pure deterministic Ward merging, saturation, source assignment, band LUTs, subject pins, tone statistics, and recolor rows.
- `src/render/gamut.ts`: numerical sRGB cusp/max-chroma searches and lightness/hue-preserving chroma clipping.
- `src/render/debug.ts`: dev-only patch readback and timing probes synchronized by 1 x 1 readPixels.
- `src/render/shaders/akf.ts`: ported eight-sector Kuwahara, generalized to per-label clarity.
- `src/render/shaders/blur.ts`: ported sigma-2 separable tensor blur.
- `src/render/shaders/dog.ts`: ported signed difference of Gaussians.
- `src/render/shaders/down.ts`: label-aware divisor-4 averaging and labels in alpha.
- `src/render/shaders/outline.ts`: darkest-variant texture/id outlines and one bounded zero-crossing refinement.
- `src/render/shaders/present.ts`: opaque unscaled blit with the storage-to-canvas vertical flip.
- `src/render/shaders/quantize.ts`: 32 source Oklab distances, committed band windows, per-label band counts, and LUT selection.
- `src/render/shaders/shared.ts`: shared Oklab transfer functions/matrices, fragment header, and integer label lookup.
- `src/render/shaders/tensor.ts`: ported Sobel RGB structure tensor.
- `src/render/shaders/up.ts`: ported label-aware reconstruction, detail injection, and exact zero/full-clarity RGB paths.
- `src/ui/app.tsx`: fresh WebGL canvas handed to the session, seven reachable sliders, and all eight Fry values.
- `src/session/scene.ts`: renderer ownership, applyEdit style/Fry edits, synchronous still updates, and rendered downloads.
- `src/session/test-hooks.ts`: demo.setStyle, demo.setFry, and a live demo.render getter.
- `src/export/png.ts`: type-only Renderer import and rendered PNG delegation; canonical asset encoding retained.
- `test/palette.test.ts`: seven palette tests covering the requested CPU rules and actual ceiling overflow.
- `test/gamut.test.ts`: three gamut tests, including 36 independent linear-RGB boundary checks.
- `test/browser/scenarios/render.scenario.ts`: render.first-look and render.outline, with pixels, export, controls, cache replacement, and warmed timings.
- `test/browser/scenarios/index.ts`: registers render.scenario.ts.
- `test/browser/page-globals.d.ts`: declares the added demo hooks.
- `plan/demo.md`: section 5 only: isolates dev clock access and records crossing refinement.

No runtime dependency, branch, commit, or later render package was added.
`src/app/test-surface.ts` already composes the typed session hooks, so it needed no change.
The ignored build output was regenerated.

## Acceptance

1. **PASS**: final `npm run typecheck`, `npm run build`, and the exact required non-Chrome Node command exited 0.
   All 767 tests passed, including the import graph.
2. **PASS** for the executable palette/gamut requirements, **FAILED** for the literal fifth-subject pin-loss requirement after two probes.
   All ten new tests pass: nested deterministic merges; saturation/neutral identity; band spacing; strict sRGB boundary and clipping; gray/colored recolor; preservation of four subjects' pins; newest-pin removal only at actual overflow; targets, per-label rows, and tone.
   With twelve unpinned entries and clarity 1, four subjects give 24 entries and a fifth gives 27.
   A fifth subject cannot exceed the binding ceiling of 32.
   The implementation retains its three pins; a seventh subject exceeds the ceiling and loses its last, least-weighted pin first, giving 32.
   Attempt 1 evaluated the specified arithmetic; attempt 2 ran the pure resolver with five three-cluster subjects and asserted the literal requested loss.
   Both failed outputs are reproduced under Checks run.
   I asked for clarification and received no answer before this return; I kept the binding ceiling rather than silently lowering it.
3. **LEAD**: `render.first-look` imports the same 4032 x 3024 gradient JPEG recipe as `demo.import`, independently decodes the master, checks exact RGB equality of the specified zero-simplify patch, and checks all stage/export RGBA pixels.
   It checks PNG master dimensions, two byte-identical exports, a changed Bands export, and a second different JPEG rebuilding the cache.
   Patch alpha is the contract's texture-edge value, so identity compares RGB, not master alpha.
   It warms with two changed renders and reports the median of five for both Bands and Simplify.
   The shader evaluates all 32 distances even with fewer entries.
   No browser timings were obtained here; the lead must record the measured medians and investigate/report an exceeded bound after at most the dispatch's permitted performance attempt.
4. **LEAD**: `render.outline` imports an exact PNG sharp-edge fixture generated from neutral Oklab L 0.3/0.8, simplify 0.
   It independently computes the expected side quantization and darkest variant, checks every sample from offsets -16 through 16 at outline 0, 0.4, and 1, and checks all pixels of a flat-image negative control.
   Widths are inferred from a numerical port, not observed in Chrome.
5. **LEAD**: actual range-input events in `render.first-look` exercise all seven sliders.
   It reads document-backed outputs, checks all eight Fry fields at Fry 1, and checks out-of-range test-hook edits clamp Colors/Bands to 12/2.
   Static wiring calls `applyEdit` for both style and Fry edits; renderer settings come from the resulting document.
6. **LEAD**: the browser driver supplies console/CSP/WebGL app-error checks for both scenarios.
   Neither scenario ran here.
   Curl observed the isolation/CSP headers and successful root/script routes; this does not establish browser console cleanliness.
7. **LEAD**, C1: Nathan judges three real photos with the reachable sliders.

Run these exact scenario IDs on the lead's dev server:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev render.first-look render.outline
```

The scenarios write `first-look.json` (including the two five-sample timing arrays and medians) and `outline.json`, plus screenshots.

### Final render contract

Final text of `src/render/types.ts`:

```ts
import type { SceneDocument } from '../core/types.ts';
import type { ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';

export type RenderScene = {
  readonly doc: SceneDocument;
  readonly master: ImageBitmap;
  readonly masks: ReadonlyMap<ObjectId, Plane<'u8'>>;
  readonly depth: Plane<'f32'> | null;
  readonly plate: Rgb8 | null;
  readonly selected: ObjectId | null;
};

export type RendererDebug = {
  readSimplifiedPatch(x: number, y: number, w: number, h: number): Uint8Array;
  timings(): { readonly lastMs: number; readonly simplifyMs: number };
};

export type Renderer = {
  setScene(scene: RenderScene): void;
  renderStill(): void;
  renderFrame(frame: number): void;
  exportStill(): Promise<Blob>;
  dispose(): void;
  readonly debug: RendererDebug | null;
};
```

## Checks run

### `npm run typecheck` - PASS, exit 0

```text

> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json

```

### `npm run build` - PASS, exit 0

```text

> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev 8e8a3b058ae4-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)
```

### `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - PASS, exit 0

```text
ℹ tests 767
ℹ suites 0
ℹ pass 767
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37537.814709
```

### `node --test test/palette.test.ts test/gamut.test.ts` - PASS, exit 0

```text
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 167.185542
```

### Fifth-subject requirement probes - FAILED, exit 1 each

Arithmetic probe, exact output:

```text
{ unpinned: 12, pinsPerSubject: 3, four: 24, five: 27, ceiling: 32 }
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: The fifth subject exceeds the 32-entry ceiling
    at file:///Users/nathandavis/dev/sandbox/noisy-demo/[eval1]:7:8
    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:262:26)
    at async ModuleLoader.executeModuleJob (node:internal/modules/esm/loader:259:20)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v25.4.0
```

Resolver probe, exact output:

```text
{ entries: 27, fifthPins: 3, dropped: [] }
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: The fifth subject loses its pins first
+ actual - expected

+ []
- [
-   5
- ]

    at file:///Users/nathandavis/dev/sandbox/noisy-demo/[eval1]:9:8
    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:262:26)
    at async ModuleLoader.executeModuleJob (node:internal/modules/esm/loader:259:20)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: [],
  expected: [ 5 ],
  operator: 'deepStrictEqual',
  diff: 'simple'
}

Node.js v25.4.0
```

### Numerical outline check - PASS as a numerical calculation, browser result LEAD

A temporary Python calculation reproduced the experiment's 9-tap separable Gaussian sums, RGBA8 quantization, quarter-grid reconstruction, and local derivative at the fixture edge.
Before refinement, width 6 predicted offsets [-2, -1, 0, 1], missing one pixel on each side.
After one bounded refinement, its exact output was:

```text
width 2: dark pixel offsets [-1, 0]
width 6: dark pixel offsets [-3, -2, -1, 0, 1, 2]
```

This is a numerical prediction; it does not claim the GLSL has executed.

### Serving and headers - PASS

Ran `node tools/serve.mjs --mode dev --port 8791 --results /tmp/noisy-D2a-serve-results --request-log /tmp/noisy-D2a-requests.jsonl`.
`curl -I` observed 200 for `/` and the actual hashed main script, with COOP same-origin, COEP require-corp, CORP same-origin, CSP, and appropriate HTML/script content types.
An initial `/main.js` probe returned 404; the root names `/assets/main-SEC2LCG6.js`, whose subsequent request returned 200.
Stopped the owned server before returning; the confirming curl reported:

```text
curl: (7) Failed to connect to 127.0.0.1 port 8791 after 0 ms: Couldn't connect to server
```

### Diff whitespace - PASS

`git diff --check` exited 0 with no output.

### Requested Claude review - FAILED here after two attempts; LEAD review still needed

The review bundle contained only scoped sources, dispatch, and permitted look/contract excerpts; tools were disabled and no session persistence requested.
Attempt 1, `claude -p --bare --tools '' --no-session-persistence`, exited 1 with:

```text
Not logged in · Please run /login
```

Attempt 2 omitted `--bare` to allow existing authentication.
It returned no review after several minutes and was interrupted; its final output was:

```text
Execution error
```

No independent Claude findings or approval were obtained.
Headless Chrome, manual photo judgment, and publication were not run.

## Noticed, not done

- `test/browser/scenarios/demo.scenario.ts` is outside Scope and its existing `demo.download` helper requests `stage.getContext('2d')`.
  That is incompatible with the new WebGL-owned stage.
  `render.first-look` supplies full-pixel stage/export comparison through a separate 2D capture canvas; the lead should update the older scenario in an authorized dispatch.
- `demo.import`'s JPEG helper is private and that file is outside Scope, so it could not be exported/shared here.
- Unrelated changes in `.gitignore`, `plan/codex.sh`, and the D2a/D3 dispatch files were observed and left untouched.
- Independent Claude review remains outstanding because the local attempts produced no review.

## Findings

- **VERIFIED**: the literal fifth-subject loss assertion contradicts the prescribed pin formula and 32-entry ceiling.
  Twelve plus four times three is 24; twelve plus five times three is 27.
  The Node resolver agrees; actual overflow at the seventh subject drops the newest pin first.
- **VERIFIED numerically; INFERRED for the browser**: the original point-local DoG estimator thins the specified width-6 vertical fixture to two pixels per side after quarter-grid reconstruction.
  A bounded refinement toward the zero predicts three per side and keeps width 2 at one per side.
- **VERIFIED by source/static checks**: `src/ui/` imports only ui/session/core and `src/export/png.ts` imports only the Renderer type from render; the import-graph suite passed.

### Departures from the evidence, with reasons

1. `plan/demo.md` section 5's absolute clock ban now excludes the dev-only measurement probe.
   Timings require a clock, but none of its values enters a pixel, cache key, or production renderer.
2. Outline refines the crossing estimate once toward the zero, with the original crossing-distance formula and 0.04 slope test evaluated there.
   This addresses the numerical width-6 discrepancy above.
   Section 5 records the refinement for the lead's judgment.
3. `up` explicitly copies the master's RGB at simplify 0 and at subject clarity 1, while retaining the DoG edge alpha.
   This makes both exact identity rules independent of filter quantization and cancellation rounding.
4. The GPU always evaluates 32 source distances, padding unused sources with the first source.
   Strict first-minimum tie breaking keeps those padded slots from winning over their populated source.
   This exercises the full loop in the required timing scenario with today's object-free scene.
5. The new scenario repeats `demo.import`'s private JPEG recipe rather than modifying its out-of-scope file to share the helper.
   This is an explicit scope limitation, not a new photo-generation design.
6. The unit suite tests real ceiling overflow with a seventh subject; the literal fifth-subject requirement is marked FAILED above and not claimed as passed.
7. GLSL subject-band rounding uses `floor(value + 0.5)` to match positive CPU `Math.round` ties; GLSL `round` permits implementation-dependent tie direction.

All remaining reduction choices (Harmony off, no crease normals, no later camera/symbol/depth/motion passes, selected accepted but ignored) are the dispatch's settled choices.

## Time

- Start, from `date`: Fri Oct 9 09:40:00 EDT 2026.
- End, from `date`: Fri Oct  9 10:06:28 EDT 2026.
