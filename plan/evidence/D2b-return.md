# D2b return

## What changed

- `src/render/grain.ts`: uint32 MurmurHash3 fmix hash, signed noise mapping, and exported frame-wrap hold arithmetic.
- `src/render/clip.ts`: pure piecewise quadratic clipping knee and shoulder.
- `src/render/crunch.ts`: standard JPEG luminance/chrominance tables, quality mapping, and libjpeg table scaling.
- `src/render/shaders/grain.ts`: Oklab grain, subject amplitude reduction, and dev-only four-cell hash readback shader sharing the same GLSL hash.
- `src/render/shaders/clip.ts`: the CPU knee's GLSL counterpart, with unchanged RGB below the knee.
- `src/render/shaders/crunch.ts`: BT.601 extraction, separable forward/inverse DCT, coefficient quantization, and chroma reconstruction.
- `src/render/renderer.ts`: outline -> grain -> clipping -> crunch -> present, exact zero-pass skips, lazy signed-float crunch buffers, depth upload, profiling, and dev WebGL error checks.
- `src/render/gl.ts`: R16F/RG16F textures and targets, Float32 uploads, optional LINEAR filtering, and uint uniforms.
- `src/render/shaders/outline.ts`: optional depth discontinuities above 5% of the plane's range within half the outline width.
- `src/render/debug.ts`: explicit camera-pass profiling and hash readback beside the unchanged render contract's required methods.
- `src/session/test-hooks.ts`: small dev-only `injectDepth` override that follows subsequent session edits.
- `src/ui/app.tsx`: five document-backed sliders; removed duplicate Fry outputs for those same fields.
- `test/grain.test.ts`: fixed hash vectors, three-channel 10,000-cell distributions, and 69-frame hold/wrap checks.
- `test/clip.test.ts`: identity, unchanged shadows, both joins' value/slope continuity, monotonicity, and endpoints.
- `test/crunch.test.ts`: both tables at qualities 20/50/100 and crunch-to-quality endpoints.
- `test/browser/scenarios/camera-stage.scenario.ts`: camera effects, hash readback, sliders, blocking, warmed timings, and synthetic depth scenarios.
- `test/browser/scenarios/render.scenario.ts`: extracted and exported self-contained browser fixture recipes used by both render packages.
- `test/browser/scenarios/index.ts`: registered the new scenario file.
- `test/browser/page-globals.d.ts`: declared injected depth, debug probes, and scenario-installed fixture recipes.

**Crunch landed.**
No runtime dependency, branch, commit, or later package was added.
Build output was regenerated.
The required Renderer/RenderScene contract and `src/render/types.ts` remain unchanged.

## Acceptance

1. **PASS**: `npm run typecheck`, `npm run build`, and the required non-Chrome Node command exited 0.
   All 773 Node tests passed, including the import graph and production bundle checks.
   Typecheck/build were rerun after the profiling review fix and final dev error checks.
2. **PASS**: all six new Node tests passed.
   The hash's three fixed vectors are 1459986880, 473632032, and 3192946190.
   Each channel was checked over 10,000 cells, with all values in [-1, 1] and absolute mean below 0.02.
   Hold arithmetic checks every frame in the 69-frame loop, its one-frame tail, and wrap to frame zero.
   The clipping checks apply to the piecewise quadratic interpretation explained under Findings.
   Both JPEG tables reproduce quality 50, quality 20's 250% scaling with rounding/clamping, and all ones at quality 100.
3. **LEAD**: `render.camera-stage`, target `dev`, is registered and typechecked but was not run here.
   It captures the skipped-camera D2a PNG before enabling effects and compares zero settings again after enabling/resetting them.
   It checks changed and repeated grain exports, reads four exact GLSL uint hashes including all three Node vectors, and checks four pixels in each of three origin-anchored grain-size-4 cells on a flat fixture.
   It checks below-knee unchanged bytes, near-white increased lightness, the CPU knee's expected output within RGBA8 tolerance, and lightness at or below 1.
   It checks changed crunch exports and mean RGB neighbor difference across 8x8 block boundaries versus within blocks.
   At 2048x1536 it warms twice, records five full-chain samples with all camera effects nonzero, and checks their median against 50 ms.
   `camera-stage.json` is written before assertions and includes per-pass synchronized diagnostic costs.
   **No GPU timings were measured here.**
4. **LEAD**: `render.depth-edge`, target `dev`, is registered and typechecked but was not run here.
   Its single-color fixture injects a master-sized plane split between 0.2 and 0.8.
   At outline 0.4 it checks offsets -1 and 0 against the independently computed darkest variant mixed at alpha 0.4, and checks offsets -12, -2, 1, and 12 remain unchanged.
   It then injects null depth and compares every export pixel at outline 0 and 1.
5. **LEAD**: the five sliders use the existing session style-edit path through `applyEdit`.
   `render.camera-stage` dispatches real range-input events for grain, color noise, grain size, crunch, and clipping, checks the document-backed outputs, and checks changed PNG bytes.
6. **LEAD**: the browser driver's console/CSP/app-error checks must run with both scenarios.
   Dev render and hash readback now also turn WebGL errors into explicit failures.
   No browser console, CSP, shader compilation, or visual result was observed here.

Run these exact scenario IDs on the lead's dev server:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev render.camera-stage render.depth-edge
```

The scenarios produce `camera-stage.json`, `depth-edge.json`, and screenshots on a successful run.
If crunch breaks the timing limit, use the recorded per-pass costs and stop performance work as directed by the dispatch.

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

build: dev e2f95bdde985-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)
```

### `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - PASS, exit 0

```text
ℹ tests 773
ℹ suites 0
ℹ pass 773
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37348.245291
```

### `node --test test/grain.test.ts test/clip.test.ts test/crunch.test.ts` - PASS, exit 0

```text
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 133.436334
```

### Initial scenario type errors - corrected

The synthetic Plane literal initially used the wrong discriminator and then omitted it.
The final literal uses `format: 'f32'` and typechecks.

```text
test/browser/scenarios/camera-stage.scenario.ts(117,22): error TS2353: Object literal may only specify known properties, and 'kind' does not exist in type 'Plane<"f32">'.
test/browser/scenarios/camera-stage.scenario.ts(117,20): error TS2741: Property 'format' is missing in type '{ size: { width: number; height: number; }; data: Float32Array<ArrayBuffer>; }' but required in type 'Plane<"f32">'.
```

### Independent Codex review and whitespace

The independent reviewer read scoped sources without editing the tree.
The first-pass profiling timer included pending quantize/outline work; profiling now finishes that work before starting each pass timer.
The reviewer found no additional concrete defects in texture formats, hash equivalence, DCT normalization/padding, pass order, or depth sampling by static inspection.
The older outline scenario issue below remains outside the permitted fixture-extraction change.
`git diff --check` exited 0 with no output.

Chrome scenarios were skipped because the dispatch states Chrome cannot start in this sandbox.
No server was started, so none required stopping.

## Noticed, not done

- **INFERRED browser regression**: existing `render.outline` leaves the new default camera effects enabled while asserting exact pre-camera palette/ink bytes.
  Its setup needs grain, colorNoise, crunch, and clipping set to 0 for its original isolated assertions.
  `render.first-look` also measures its Bands path after Fry enables camera effects.
  D2b permits changes in that file only to export shared fixture helpers, so those older scenario expectations were not changed.
- Unrelated concurrent changes in `plan/demo.md`, `plan/findings.tsv`, `plan/log.tsv`, dispatches, and `plan/reviews/` were left untouched.
- The TypeScript skill's referenced type-system/boundary principle skill files were absent from the available local skill roots.
  Its inline TypeScript rules were read and followed.

## Findings

- **VERIFIED by source and Node tests; GLSL equivalence LEAD**: the selected published finalizer is MurmurHash3 `fmix32`, using xor shifts 16/13/16 and multipliers `0x85ebca6b` and `0xc2b2ae35`.
  The channel salts are `0x243f6a88`, `0x85a308d3`, and `0x13198a2e` for L/a/b.
  The fold is `fmix(fmix(fmix(fmix(seed xor salt) xor hold) xor cellX) xor cellY)`.
  Noise uses the top 24 bits, divided by `0xffffff`, mapped linearly to [-1, 1].
  This gives equally spaced values including both endpoints and keeps the integer conversion exactly representable in GLSL highp float.
  The design specified none of these finalizer, salt, or distribution choices.
- **VERIFIED mathematically and by Node tests; browser LEAD**: one global quadratic matching identity value/slope at the threshold and reaching exactly 1 at L=1 can only be identity.
  Writing it as `a + t + c*t*t`, its endpoint forces `c=0`.
  The implementation therefore uses two quadratics: a knee of width 0.05 and a remaining highlight shoulder, with continuous value/slope at both joins.
  This interpretation was raised for optional clarification; no answer arrived before proceeding with the communicated recommendation.
  For `a = k - w`, `w = 0.05`, `d = 1-a`, and `r = d-w`, the knee coefficient is `A = clipping*r/(2*w*d)`.
  For `t = L-a <= w`, output is `a+t+A*t*t`.
  Otherwise, with `u=t-w` and `B=-A*w*(2*d-w)/(r*r)`, output is `a+w+A*w*w+(1+2*A*w)*u+B*u*u`.
  Shadows are unchanged, highlights increase, output reaches exactly 1, and its endpoint slope is `1-clipping`, keeping the curve monotonic.
  Clipping 0 skips the pass entirely.
- **VERIFIED by source/table tests; rendered artifacts LEAD**: crunch uses JPEG's BT.601 transform on sRGB bytes, represented in normalized byte units.
  Y is centered by 128/255; Cb/Cr use the conventional centered BT.601 coefficients and a 2x2 box subsample.
  Both standard JPEG Annex K tables are used in natural row-major coefficient order, luminance for Y and chrominance for Cb/Cr.
  Quality is `round(100-80*crunch)` with the specified libjpeg scaling and [1,255] table clamp.
  Coefficients round to the nearest table multiple, with exact half ties explicitly away from zero.
  Chroma reconstruction repeats each sample over its 2x2 master cell.
  The design did not fix the transform, chroma table, tie handling, or chroma reconstruction filter.
- **VERIFIED by source; odd-size GPU result LEAD**: complete DCT blocks need all eight coefficients even at partial image edges.
  Crunch buffers therefore pad each plane's dimensions to multiples of 8, edge-replicate extraction, and crop only when combining into the master-sized output.
  Padding is at most seven texels per plane axis; the required 2048x1536 timing fixture needs none.
  Y remains R16F and Cb/Cr RG16F, with only two working targets per plane.
- **VERIFIED by source**: `injectDepth` overrides renderer scenes only after an explicit test call and follows subsequent session edits without modifying the production driver or session scene module.
  The per-pass profiler is explicit and separately synchronized; its costs include draw submission and completion overhead and are diagnostic timings, not pure GPU timer queries.
  Normal full-chain measurements do not run those per-pass finishes.

## Time

- Start, from `date`: 2026-10-09 10:16:58 EDT.
- End, from `date`: 2026-10-09 10:36:16 EDT.

## Resume 1

Read the independent review's six code findings before changing sources.
All seven requested items are **DONE**, with the existing D2b camera chain, crunch, depth term, sliders, tests, and scenarios retained.

1. **DONE** - `src/render/palette.ts:117` keeps shared entries at their resolved colors; `src/render/palette.ts:123` applies recolor only to the object's own row.
   `test/palette.test.ts:126` constructs a gray background pixel whose nearest entry is the recolored subject pin, checks row 0's resolved colors and LUT bytes against the unrecolored palette, checks another object's row, and checks the subject's own target color.
   The earlier pinned-entry expectation is corrected at `test/palette.test.ts:119`.
2. **DONE** - `src/render/palette.ts:85` tests `reference.c < 0.03` using the assigned entry.
   `test/palette.test.ts:54` now covers a muted mean with chroma 0.05 assigned to a gray entry with chroma 0.01, landing exactly on the target's chroma 0.12.
3. **DONE** - `src/render/shaders/outline.ts:5` owns the single `OUTLINE_SLOPE_PER_WORKING_TEXEL = 0.16` constant.
   Its preceding comment states the written 0.04-per-working-texel rule and the roughly 13-master-pixel DoG side-lobe ghosts that justify retaining the stricter value until C1.
   `src/render/renderer.ts:278` converts it through DIVISOR for one uniform used by both slope comparisons at `src/render/shaders/outline.ts:34` and `:45`.
   Effective behavior remains 0.04 per master pixel.
   The depth comment at `src/render/shaders/outline.ts:14` correctly names D2b.
4. **DONE** - `src/render/renderer.ts:35` tracks loss and attaches `webglcontextlost`; `src/render/renderer.ts:73` checks both the persistent flag and `gl.isContextLost()`.
   `setScene` at `:175`, `renderStill` at `:259`, and `exportStill` at `:329` all use this guard and fail with the exact message `The graphics context was lost; reload the page`.
   The guard runs before the texture-limit query, with another check if that query returns a non-number.
   Listener removal occurs on shader initialization failure at `:49` and disposal at `:342`.
   Context-loss browser behavior remains **LEAD**; no browser was run here.
5. **DONE** - `src/render/palette.ts:126` rounds the subject band count once on the CPU.
   The exact small integers populate the 256-label float uniform table at `:127` and size LUT variants at `:140`.
   `src/render/renderer.ts:275` uploads the same table; `src/render/shaders/quantize.ts:8` and `:24` read it without repeating rounding or interpolation.
   `test/palette.test.ts:142` checks bands 3 with clarity 5/6, giving 6 subject bands at the exact half tie, and checks every LUT row agrees with its uniform count.
6. **DONE** - `test/browser/scenarios/demo.scenario.ts:54` no longer asks the WebGL stage for a 2D context.
   It independently decodes the same gradient JPEG to a separate master canvas, obtains two downloads, and compares them and the master PNG.
   Assertions at `test/browser/scenarios/demo.scenario.ts:135` check PNG type/master dimensions, repeated byte identity, and changed master PNG bytes.
   An additional decoded RGB comparison at `:138` establishes that the look changed pixels rather than merely using a different PNG encoder.
   The scenario writes `download.json`; browser results remain **LEAD**.
7. **DONE** - `test/browser/scenarios/demo.scenario.ts:92` accepts the scene's text or the exact requested analysis status prefixes and `Ready to tap`.
   Initial checks at `:104` read `scene().status` as `Drop a photo`; landscape/portrait checks at `:109` read it as `Ready`, with separate visible-status assertions.
   All other import checks are retained, including isolation, import timing, sizes, clusters, decode path, small JPEG refusal, and HEIF wording.

### Resume 1 checks

`npm run typecheck` - **PASS**, exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build` - **PASS**, exit 0:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev e2f95bdde985-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)
```

`node --test test/palette.test.ts test/grain.test.ts test/clip.test.ts test/crunch.test.ts` - **PASS**, 15 tests:

```text
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 159.346125
```

The required `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` had one cooldown timing failure on the first run:

```text
ℹ tests 775
ℹ suites 0
ℹ pass 774
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35640.551334

test at test/harness-sequence.test.ts:180:1
✖ the kill-point ballast is gone before a sequence runs, the stand-in at 100 MB beside it; the ballast and untouched steps after a run wait the cooldown and release the stand-in (693.166125ms)
  AssertionError [ERR_ASSERTION]: the untouched step waited the encoder's cooldown
      at TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/harness-sequence.test.ts:195:10)
      at async Test.run (node:internal/test_runner/test:1102:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:777:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

The same required command was rerun once, without a concurrent build, and **PASSED**, exit 0:

```text
ℹ tests 775
ℹ suites 0
ℹ pass 775
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36899.878292
```

No harness source or test was changed.
The independent Codex reviewer checked the resume changes without editing and found no additional concrete defects after the PNG assertion gained its decoded-pixel check.
Scoped diff whitespace checks passed.
An unrestricted whitespace check reported an unrelated trailing tab in `plan/log.tsv:14`, which was left untouched.
Browser checks remain for the lead: `demo.import`, `demo.download`, `render.first-look`, `render.outline`, `render.camera-stage`, and `render.depth-edge`.
The older render scenario's active-camera warning in the original Return remains outside these seven fixes.
No server, branch, commit, dependency, or later package was added.

### Resume 1 time

- Start, from `date`: 2026-10-09 10:37:40 EDT.
- End, from `date`: 2026-10-09 10:44:18 EDT.

Resume 2 - **DONE**: `test/browser/scenarios/render.scenario.ts:70`, `:120`, and `:160` disable grain, colorNoise, crunch, and clipping through `demo.setStyle` after each fixture import and again after Fry before D2a timings, with comments explaining the clean-chain assumption; no other scenario behavior changed; `npm run typecheck` PASS (exit 0), required non-Chrome Node command PASS (exit 0, 775 tests, 775 pass, 0 fail, duration_ms 36286.043167), scoped whitespace check PASS; lead-reported `render.camera-stage` PASS (2048x1536 median 5.8 ms), `render.depth-edge` PASS, and `render.first-look` PASS; corrected `render.outline` still awaits the lead rerun; time from `date`: 2026-10-09 10:46:08 EDT to 2026-10-09 10:47:10 EDT.
