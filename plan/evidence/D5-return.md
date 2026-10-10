# D5 return

## What changed

- `src/render/symbols.ts`: pure eligibility, window-relative glyph bins, adjacent-band decisions, normalized tone, centered grid arithmetic, and procedural SDF atlas generation.
- `src/render/shaders/cells-reduce.ts`: majority-label/entry/band reduction, mean tone, and two RGBA8 cell tables.
- `src/render/shaders/cells-draw.ts`: flat paper cells and five antialiased glyphs from the cell tables, palette row, and atlas.
- `src/render/shaders/quantize.ts`: optional RGBA8 variant output containing entry, band, label, and normalized pre-banding tone.
- `src/render/renderer.ts`: lazy variant/cell targets, per-label symbol modes, cells before the camera stage, complete outline bypass while enabled, and diagnostic pass costs.
- `src/render/gl.ts`: dimension-checked second-color-attachment helper for quantize and reduction MRTs.
- `src/render/debug.ts`: `readCellTable(cx, cy)` with label, entry, band, tone, glyph index, ink/paper band indices, and exact palette RGB bytes.
- `src/ui/app.tsx`: document-backed Symbols toggle, even 6..48 cell-size slider, and 0..1 amount slider through `applyEdit` and the existing session document setter.
- `src/session/test-hooks.ts`: `setSymbols(patch)` through the same core edit and session setter.
- `test/symbols.test.ts`: the experiments' recorded arithmetic fixtures, mode/adjacency boundaries, centered/partial grid coverage, and deterministic SDF geometry checks.
- `test/browser/scenarios/symbols.scenario.ts`: `render.symbols`, shared gradient fixtures, real controls, export/readback assertions, screenshots, and five warmed full-chain timing samples.
- `test/browser/scenarios/index.ts`: registers the symbols scenario.
- `test/browser/page-globals.d.ts`: declares the new symbols hook and cell readback.

Build output was regenerated.
No runtime dependency, branch, commit, later package, docs, ADR, or changelog was added.

## Acceptance

1. **PASS**: `npm run typecheck`, `npm run build`, and the required non-Chrome Node command exited 0.
   The full suite passed all 792 tests, including the import graph and build checks.
   The final source-only import-order cleanup was followed by typecheck, build, and the focused symbols tests again.
2. **PASS**: the five symbols tests reproduce the experiments' own 256-cell ramp fixtures.
   Percentile-normalized ink/paper cases give 82 glyph cells and 0 equal ink/paper at bands 4 / amount 0.3; 256 and 0 at bands 6 / amount 1; and 0 glyph cells at bands 4 / amount 0.
   Seven evenly spaced gray entries give 82 and 0.
   The additional recorded bands 3 / amount 0.3 and bands 2 / amount 0.5 cases give 82 and 132, respectively, with 0 invisible cells.
   The separate raw-tone density ramp gives `. - + * #` counts `16, 16, 14, 16, 16` at 0.3; `30, 32, 30, 30, 32` at 0.6; and `52, 50, 50, 52, 52` at 1.
3. **LEAD**: `render.symbols`, target `dev`, is registered and typechecked but was not run here.
   It uses the existing shared gradient installer and fixture, disables simplify/outline/grain/color noise/crunch/clipping for isolated pixel checks, and captures the off-path PNG before the first cells pass executes.
   It compares that PNG with Symbols off after exercising the pass.
   It checks 20 complete solid cells at size 12, changed export bytes, 20 glyph cells at amount 1, adjacent palette variants from `readCellTable`, and all sampled RGB values lying between ink and paper.
   The glyph sample set explicitly includes a dot if the initial spatial samples contain none, so at least one cell can contain exact ink and exact paper despite antialiasing of narrow strokes.
   It checks rows 12 px apart within size-24 cells match and finds differing rows 24 px apart across neighboring cells.
   Outline 0 and 1 must produce identical PNG bytes while Symbols is enabled.
   It also checks repeated deterministic exports with active camera effects and changed bytes when those effects are enabled after cells.
   At size 12 and 2048x1536 it warms twice, records five renders with grain, color noise, clipping, and crunch nonzero, and checks median render time below 50 ms.
   If the median fails, it profiles once and records quantize, reduction, cell draw, camera passes, and present before reporting the failure.
   **No browser pixels, GPU shader compilation, or timings were observed here.**
   **The actual pre-D5-revision PNG comparison is still LEAD:** no such PNG was supplied or captured in this sandbox.
   The scenario's before/after off-path comparison does not establish byte identity against a previous revision.
4. **LEAD** for real interaction and renderer propagation; **PASS by source/type inspection** for wiring.
   The checkbox and both range inputs read the latest scene, call `applyEdit(doc, { kind: 'symbols', patch }, timestamp)`, and pass applied documents to `session.setDocument`.
   The renderer reads `doc.symbols`; it keeps no independent symbol settings.
   The scenario clicks the checkbox, dispatches real slider input events, and checks both document values and visible outputs before comparing render results.
5. **LEAD**: the browser driver's console/CSP/app-error checks must accompany `render.symbols`.
   Renderer and cell-readback WebGL errors are explicit failures.
   No browser console or CSP results were observed here.

Run this exact scenario ID on the lead's dev server:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev render.symbols
```

The scenario writes `symbols.json` before assertions and captures `symbols.png`.
The JSON contains the 20 cell decisions and palette colors, all comparison results, five timing samples, the median, and diagnostic per-pass costs if the bound fails.
A comparison against an export from the actual pre-D5 revision remains necessary for the literal prior-revision baseline acceptance.

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

build: dev 1d720ae4af25-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)
```

### `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - PASS, exit 0

```text
ℹ tests 792
ℹ suites 0
ℹ pass 792
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35651.183334
```

### `node --test test/symbols.test.ts` - PASS, exit 0

```text
✔ glyph-rule recorded ink/paper fixture counts, including seven gray entries (2.390167ms)
✔ density fixture uses five equal bins of the slider window (0.18075ms)
✔ always/never modes, tonal boundary and adjacent bands across every band count (0.182125ms)
✔ centered grid covers all pixel centers once, including partial and odd-size edges (1.606875ms)
✔ procedural atlas is deterministic with bounded, symmetric signed distances (5.109834ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 116.590333
```

### Intermediate failures - corrected

The first focused test run had a parser error because a `satisfies` expression was split across lines in a `for ... of` header.
It was moved to a named fixture array, and all five tests then passed.

```text
SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expected ')', got 'satisfies'
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Public interfaces were resolved through compiler checks without opening the three additional source files requested for reading.
Initial integration attempts exposed these corrected API mismatches:

```text
src/session/test-hooks.ts(49,36): error TS2339: Property 'applyEdit' does not exist on type ...
src/session/test-hooks.ts(52,47): error TS2554: Expected 3 arguments, but got 2.
error TS2345: Argument of type 'EditResult' is not assignable to parameter ...
error TS2739: Type ... is missing the following properties from type 'Scenario': title, covers
error TS2555: Expected at least 2 arguments, but got 1.
error TS2345: Argument of type '() => Promise<void>' is not assignable to parameter of type 'ZodType<unknown, unknown, ...>'.
error TS2339: Property 'artifact' does not exist on type 'ScenarioContext'.
error TS2339: Property 'writeJson' does not exist on type 'ScenarioContext'.
error TS2339: Property 'navigate' does not exist on type 'BrowserPage'.
error TS2554: Expected 1 arguments, but got 0.
```

The final code uses the core reducer's three-argument API and applied-result discrimination, the shared zero-argument fixture callback, schema-backed browser evaluation, `page.goto`, `context.file`, and named screenshots.
Temporary compiler probes were removed.
No unresolved type errors remain.

### Independent Codex review and whitespace - PASS by static review

The reviewer did not edit the tree.
It reviewed MRT attachment state, reduction/centering, arithmetic, atlas/draw, resource handling, UI/hook wiring, and the browser scenario.
No concrete renderer or UI defects were reported.
The recorded Present storage-to-canvas flip resolved its conditional PNG/readback-coordinate concern.
Its exact-ink sampling concern was addressed by explicitly including a dot cell.
Browser execution and the literal prior-revision baseline remain unverified.
Scoped `git diff --check` exited 0 with no output.

Chrome was skipped as required by the dispatch's sandbox constraint.
No server was started, so none required stopping.

## Noticed, not done

- Concurrent changes to `plan/demo.md` and the new `plan/dispatches/D8a-production-story.md` were observed in Git status and left untouched.
- The actual pre-D5 export baseline was not available here; the lead must compare it with a matching Symbols-off export.
- GPU execution, visual judgment, console/CSP checks, and timing remain for the lead's `render.symbols` run.

## Findings

- **VERIFIED by Node grid coverage; GPU LEAD**: for each frame extent `N` and cell size `S`, use `anchor = (N-S)/2` and `origin = anchor - ceil(anchor/S)*S`.
  This places a cell's geometric center exactly at `N/2`, with origin in `(-S, 0]` and half-pixel origins for odd frame extents.
  A pixel belongs to `floor((p+0.5-origin)/S)`.
  Reduction begins that cell's integer pixels at `ceil(origin-0.5) + cellIndex*S`, then clips them to the frame.
  Partial edge cells contain only their own frame pixels.
  The two tables have the prescribed `ceil(W/S)+1` by `ceil(H/S)+1` dimensions; unused extra cells write zero.
- **VERIFIED by source and independent review; GPU LEAD**: label, entry, and band histograms resolve equal counts to the lowest index through ascending scans and strict `>` comparisons.
  Entry counts consider only the majority label.
  Band counts and mean tone consider the winning label and entry across all its bands.
  This interpretation of “those same pixels” is recorded explicitly; tone is not restricted to the winning-band subset.
- **VERIFIED by source and Node fixtures; GPU LEAD**: variant RGBA channels are entry, band, label, and clamped pre-banding lightness normalized by p01/p99.
  Without lights, that lightness is the simplified pixel's Oklab L.
  Reduction averages the encoded RGBA8 tones without recomputing quantization.
  Cell table RGBA is label, entry, band, and mean tone; the decision table is glyph index plus one (zero is solid), ink band, paper band, and zero.
  A `1e-6` minimum percentile span avoids division by zero for flat assets.
- **VERIFIED by Node distance/atlas checks; rendered appearance LEAD**: the atlas is a deterministic 320x64 R8 strip, with five 64x64 tiles in `. - + * #` order.
  Distances use cell-fraction coordinates relative to the center.
  Bars have half-length 0.35 and half-stroke 0.042: a 70% box and full stroke 0.084, or 12% of that box.
  The dot is a disc of radius 0.105, giving a fully covered ink interior at the default size 12.
  Dash is one horizontal rectangle; plus is horizontal/vertical rectangles; star is three rectangles at 0, 60, and 120 degrees.
  Hash is two horizontal and two vertical rectangles with axes offset by plus/minus 0.14.
  Rectangle distance uses the exact box SDF; compound glyphs take the minimum constituent distance.
  Atlas zero is byte 128 and distance scale is 508; the draw decodes `(sample*255-128)/508` and uses linear atlas filtering.
  Antialiasing is `1-smoothstep(-0.5/S, 0.5/S, distance)`, spanning one output pixel.
- **VERIFIED by source; browser LEAD**: outline is bypassed entirely while Symbols is on, then grain, clipping, crunch, and present run in their existing order.
  Symbols off uses the original color/outline/camera path, with no variant attachment allocation on an initially disabled scene.
  The optional second quantize attachment is detached before camera passes reuse the quantized target.
  Cell targets are rebuilt when size changes and released on frame resize/disposal.
- **VERIFIED by source; timings LEAD**: ordinary rendering performs no per-pass finishes.
  Explicit failure profiling includes quantize, cells reduction/draw, each enabled camera pass, and present, excluding pending upstream draws from each measured pass.
  These synchronized submission/completion costs are diagnostic measurements, not GPU timer queries.

## Time

- Start, from `date`: 2026-10-09 10:50:42 EDT.
- End, from `date`: 2026-10-09 11:15:05 EDT.

## Resume 1

**DONE**: `src/render/shaders/shared.ts` now declares `layout(location = 0) out vec4 o;`, fixing the missing explicit primary output in quantize while retaining its variant at location 1.
Cell reduction already explicitly declares cell/decision at locations 0/1; cell draw has only one output.
The existing attachment helper sets `gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])` when attaching the variant or decision table and restores `[gl.COLOR_ATTACHMENT0]` when detaching the variant.
Only that shared-header line and this Return were changed in the resume; build output was regenerated.

The lead's pre-fix Chrome result was:

```text
The render shader failed: ERROR: 0:4: 'o' : when EXT_blend_func_extended extension is not enabled, must explicitly specify all locations when using multiple fragment outputs
```

Required checks all **PASS**, exit 0:

```text
npm run typecheck
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json

npm run build
> noisy@0.0.0 build
> node tools/build.mjs --mode dev
build: dev 1d720ae4af25-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)

node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)
ℹ tests 792
ℹ suites 0
ℹ pass 792
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52277.339042
```

A temporary Node assertion against the composed shader strings also passed:

```text
quantize: o=0, variant=1
cells.reduce: cell=0, decision=1
cells.draw: one output; explicit-location MRT rule does not apply
```

Chrome compilation and `render.symbols` remain **LEAD** reruns because Chrome cannot run in this sandbox.
No server, dependency, commit, or additional behavior change was added.
Resume time from `date`: 2026-10-09 11:18:24 EDT to 2026-10-09 11:21:00 EDT.
