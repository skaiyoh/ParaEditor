# D6 return

## What changed

**Full shape implemented: back-layer mesh plus per-object meshes.**
The back-layer-only fallback was not used.
GPU execution, visual results and the performance cut line remain LEAD.

- `src/render/shaders/geometry.ts`: frame-space depth displacement, center zoom and three explicit G-buffer outputs, with object mask alpha test at 0.5.
- `src/render/shaders/pushpull.ts`: pure cached CPU eight-level coverage-weighted push-pull background depth fill.
- `src/render/shaders/backsource.ts`: master/plate blend through a radius-two-master-pixel triangular feather.
- `src/render/mesh.ts`: indexed 192 x 144 back grid and 64 x 64 object grids over bounds dilated in per-axis frame fractions.
- `src/render/loop.ts`: pure 30 fps elapsed-time indexing and integer frame wrap.
- `src/render/renderer.ts`: fresh-plate gating, second simplify cache, cached background depth and masks, Geometry before quantize, warped label/depth/edge registration through later passes, frame-indexed grain, identity still export and dev frame export/readbacks.
- `src/render/gl.ts`: custom vertex programs, indexed vertex arrays/buffers, LINEAR target filtering and dimension-checked multiple framebuffer attachments.
- `src/render/debug.ts`: frame timing and geometry coverage/color probes, plus dev frame PNG export.
- `src/session/loop.ts`: requestAnimationFrame stepper that skips missed frames, suppresses duplicate indices and cancels on stop/error.
- `src/session/scene.ts`: loop start/stop, plate-pending still, motion edits through applyEdit, pending-mask-aware plate requests and teardown/import cancellation.
- `src/ui/app.tsx`: document-backed Motion toggle, Orbit slider and Loop seconds slider.
- `src/session/test-hooks.ts`: frame, renderFrameAt, exportFrame and plate-pixel hooks.
- `test/loop.test.ts`: frame boundaries, skipped intervals, exact wrap and invalid inputs.
- `test/mesh.test.ts`: grid counts/winding, per-axis dilation and synthetic push-pull disc-hole checks.
- `test/browser/scenarios/loop.scenario.ts`: render.loop and render.loop-objects, real models, actual controls, PNG comparisons, coverage probes and warmed timing records.
- `test/browser/page-globals.d.ts`: typed loop hooks and debug probes.
- `test/browser/scenarios/index.ts`: registers both loop scenarios.

The dev build was regenerated.
No dependency, commit, branch, docs, ADR, changelog or later package was added.

## Acceptance

1. **PASS**: final typecheck, build and required non-Chrome Node suite exited 0.
   All 805 tests passed, including import-graph and production bundle checks.
2. **PASS**: all six focused Node tests passed.
   The stepper returns 0 at 0 ms, 1 at 34 ms, 29 at 999 ms and 0 at 1000 ms with 30 frames.
   A skipped interval advances by several frames.
   Every back-grid triangle has positive winding; counts are 193 * 145 vertices and 192 * 144 * 2 triangles.
   Synthetic disc holes at 129 px and 513 px have no unfilled/nonfinite output texel, filled values stay within the surrounding ring's minimum/maximum, known texels are unchanged and the refined input is unchanged.
3. **LEAD**: render.loop, target dev, timeout 300 s, is registered and typechecked but was not run here.
   It imports landscape and portrait disc fixtures through the actual session and waits for real-model depth, keeping no objects.
   It checks orbit 0.6 and loopSeconds 3, changed frame-zero/quarter PNG bytes, exact wrap, and unchanged still export with camera effects both off and on.
   It also checks identity rendering at orbit zero.
   At frames 0, quarter, half and three quarters it checks every PNG edge pixel is opaque/nonblack, plus actual G-buffer coverage on all four edges of each exported frame.
   The latter prevents quantization from concealing a cleared Geometry pixel.
   Landscape timings are checked at 2048 x 1536; portrait coverage at 1536 x 2048 from a 3024 x 4032 source.
   Two warm-up renders precede each five-sample median.
   Both timing arrays and medians are written to loop.json before assertions, with limits of 33 ms off and 50 ms on.
   **No lead-supplied timings exist for this dispatch yet; neither bound is claimed PASS.**
4. **LEAD**: D4 is present and render.loop-objects, target dev, timeout 300 s, exercises its real tap/decode path.
   It waits for real depth/decoder, taps the disc, enables Motion and waits for analysis().plate and plateNeeded false.
   Focus 0 and orbit 1 deliberately give the disc a visible displacement while still using anchorDisparity and the core camera arithmetic.
   At a quarter loop it scans the upper silhouette for a point labeled object in frame zero and back layer afterward.
   With simplify and camera effects zero, the exposed G-buffer RGB must be within 8 byte levels of the plate pixel and more than 40 levels from the former disc color.
   The coordinate, colors and errors are recorded in loop-objects.json.
   Browser plate production and pixels are unobserved here.
5. **LEAD** for real interaction; **PASS by source/type inspection** for wiring.
   The toggle and both sliders call session.setMotion, which uses applyEdit({ kind: 'motion', patch }).
   Motion on requests a plate after pending mask work; the loop starts only while plateNeeded is false.
   The object scenario checks the displayed preparing sentence, captures the actual stage before/during preparation and checks its pixels remain the still and its frame index stays fixed.
   The loop scenario changes both sliders away from defaults before restoring 0.6/3, checks the document values and checks Motion off stops frame advancement.
6. **LEAD**: the browser runner must apply its console-error/CSP/app-error invariants to both scenarios.
   New programs use the existing shader-error-to-status path, MRT outputs have explicit locations, attachments call drawBuffers, and dev render/readback paths surface WebGL errors.
   No browser console, CSP, shader compilation or visual results were observed here.

Exact scenario ids for the lead:

```text
render.loop
render.loop-objects
```

Read loop.json and loop-objects.json and inspect loop.png and loop-objects.png.
If the full shape exceeds the warmed 33 ms bound, report the measured result and stop performance work as dispatched.

## Checks run

### npm run typecheck - PASS, exit 0

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

### npm run build - PASS, exit 0

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev
build: dev edeb9eed1f0b-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (42 files)
```

### node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome) - PASS, exit 0

```text
ℹ tests 805
ℹ suites 0
ℹ pass 805
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35171.662125
```

### node --test test/loop.test.ts test/mesh.test.ts - PASS, exit 0

```text
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 136.145125
```

### Scenario registration import - PASS, exit 0

```text
{"id":"render.loop","target":"dev","timeoutMs":300000}
{"id":"render.loop-objects","target":"dev","timeoutMs":300000}
```

A scoped search found no Math.random, performance.now or Date.now in the new render inputs, shaders, meshes, frame arithmetic or session stepper.
The stepper uses only requestAnimationFrame timestamps; the existing dev probe measures GPU completion separately.
Scoped whitespace inspection passed with no output.
Chrome, manual visual checks and browser timing were skipped because this dispatch assigns them to the lead.
No server was started.

### Requested Claude review - FAILED after two attempts; LEAD review outstanding

Both attempts supplied a scoped source bundle, disabled tools and requested no session persistence.
Attempt 1 used bare mode and exited 1:

```text
Not logged in · Please run /login
```

Attempt 2 allowed existing user authentication, ran from /private/tmp with MCP disabled, and returned no review after several minutes.
It was interrupted; its output was:

```text
Execution error
```

No independent Claude findings or approval were obtained.
Local logs are /tmp/noisy-D6-typecheck.log, /tmp/noisy-D6-build.log, /tmp/noisy-D6-tests-final.log, /tmp/noisy-D6-review-bare.log and /tmp/noisy-D6-review.log.

## Noticed, not done

- Independent Claude review remains outstanding after the two failed local attempts.
- GPU execution, visual judgment, real-model plate exposure, console/CSP checks and both warmed frame medians remain for the lead.
- No changes were made outside the dispatch's source/test Scope and its Return, apart from required generated build output and temporary verification material.

## Findings

- **VERIFIED by source; GPU LEAD**: objects write color/texture edge, id and depth in one unblended draw with a 0.5 mask alpha test.
  The full design's separate soft-mask blended color draw is dropped as dispatched.
- **VERIFIED by Node/source; GPU LEAD**: the eight-level push-pull runs once on the CPU at depth-plane size, then uploads an R16F LINEAR background texture.
  Downsampling averages values weighted by known coverage; upsampling fills only unknown texels using bilinear coarse values.
  Empty coarsest texels use the known samples' coverage-weighted mean so large holes still fill within the known range.
  An entirely covered plane has no known ring and uses neutral disparity 0.5.
  No ring-plane fit is performed.
- **VERIFIED by source; GPU LEAD**: the master-resolution hole comes from core.holeMask and is sampled at depth-plane texel centers for the fill.
  The back-source feather uses a normalized 5 x 5 triangular kernel with radius two master pixels per axis.
  These feather and coarse-seed choices are explicit demo implementation choices.
- **VERIFIED by source; browser LEAD**: stale plates are refused by comparing their forMasks with core.sortedMasks independently of Motion being off.
  Without a fresh plate there is one simplify cache; with one, the master/plate-blended back source has a separate cache.
  Masks/hole, master/plate identity, labels/order, simplify and the subject table invalidate the relevant caches; loop frames do not rebuild them.
- **VERIFIED by Node/source; browser LEAD**: frame indexing multiplies elapsed milliseconds by 30 before dividing by 1000.
  This is the dispatched floor arithmetic with operation order that avoids 1000 / (1000 / 30) rounding below 30 and missing the exact one-second wrap.
- **VERIFIED by source; GPU LEAD**: parallaxDisplacement supplies depth-zero/depth-one endpoints to the vertex shader, which interpolates them by sampled disparity.
  Camera radius, phase, offset, anchor, clamp and zoom come from core helpers/constants; null anchor supplies zero endpoints.
  Geometry's color alpha carries texture edge, while separate label/depth attachments keep all later passes on the same output grid.
- **VERIFIED by source; browser LEAD**: still export always renders frame zero with Geometry skipped and synchronously restores the previous preview after the PNG snapshot.
  Dev frame export excludes selection and likewise restores the previous preview.

## Time

Start from date: 2026-10-09 11:24:47 EDT.
End from date: 2026-10-09 11:44:33 EDT.

## Resume 1

Read `plan/reviews/D6-review.md` before changing sources.
All five requested implementation items are **DONE**, with the full D6 shape and existing checks retained.
The lead's browser rerun remains **LEAD**; Chrome and GPU shader compilation were not attempted here.

1. **DONE** - `src/render/renderer.ts:101`, `:428`, `:462` allocate a dedicated 1 x 1 zero label and all-zero clarity table and pass them through every back-source simplify stage.
   Master simplification still uses object labels and subject clarity; the second cache's invalidation key is unchanged.
   `test/browser/scenarios/loop.scenario.ts:264`, `:275`, `:294` extend render.loop-objects with the imported document's default simplify, the previously exposed quarter-loop region, and a still reference exported after reset with the same look.
   Every sampled final RGB channel must match the flat background reference within 2 byte levels, and an empty exposed region fails.
   The original simplify-zero plate comparison and screenshot remain.
2. **DONE** - `src/render/gl.ts:163` attaches a DEPTH_COMPONENT16 renderbuffer to the G-buffer and owns its release/disposal.
   `src/render/shaders/geometry.ts:15` writes clip-space z as `1 - 2 * disparity`.
   `src/render/renderer.ts:389`, `:402`, `:407`, `:417` attach it, use LESS, and clear depth for the back mesh and each ordered object mesh.
   Clearing between objects preserves layers(doc) order and alpha testing while resolving each mesh's own folds by disparity.
   The depth test is disabled and the depth range restored before later passes.
   One 16-bit depth value is reserved for clear, so disparity-zero fragments at the far clipping plane still pass LESS.
   `test/browser/scenarios/loop.scenario.ts:126`, `:174`, `:175` inject the requested left-0.2/right-0.8 plane with orbit 1 and check quarter/three-quarter near-edge cut widths within 4 px.
   A second injection bounds the near region to the painted rectangle, creating actual folds perpendicular to the vertical camera offsets at these phases and checking the same symmetry bound.
   Both measured cut pairs are recorded in loop.json; loop-folds.png captures the latter.
3. **DONE** - `src/session/loop.ts:6` supplies the inverse center-zoom mapping; `src/session/scene.ts:195` applies it at tap time while a zoomed loop is running, before labelAt, decoding and storing the selection point.
   The comment states that parallax displacement is not undone and its residual is at most 2% of each frame axis.
   The page continues to supply normalized screen coordinates; session owns the correction.
   `test/loop.test.ts:20` passes: center remains center, screen corners map to the cropped frame's 0.02/0.98 inset, and the stored corner projected outward by LOOP_ZOOM maps back to the stored corner under the inverse.
4. **DONE** - `src/session/scene.ts:83`, `:161`, `:233`, `:249` track the accepted scene's generation/id, invalidate readiness on replacement import, and allow looping only for the current accepted scene with Motion enabled and plateNeeded false.
   No status string gates the loop.
   Motion edits preserve the existing status at `src/session/scene.ts:176`, including import/error sentences.
   Plate requests also reject stale/not-ready generations at `:181`.
5. **DONE** - `src/session/scene.ts:310` requests a plate only for an explicit enabled Motion toggle, rather than orbit/loop-seconds inputs.
   `src/session/scene.ts:121` centralizes object add/remove/refine requests on changed mask sets while Motion is enabled, after pending mask work.
   The former duplicate tap request is removed.
   Slider inputs retain a failed inpaint sentence and do not create another explicit request that clears the driver's failure.

### Checks run

`npm run typecheck` - **PASS**, exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build` - **PASS**, exit 0:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev
build: dev 0ca5eadf29e9-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (42 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - **PASS**, exit 0:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35502.459917
```

`node --test test/loop.test.ts` - **PASS**, exit 0:

```text
✔ 30 fps frame stepper boundaries, skipped callbacks and exact wrap (0.68275ms)
✔ loop taps undo center zoom for the center and both corners (0.606375ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 90.016625
```

`git diff --check` - **PASS**, no output.
Logs: `/tmp/noisy-D6-resume1-typecheck.log`, `/tmp/noisy-D6-resume1-build.log`, `/tmp/noisy-D6-resume1-tests.log`.

### Noticed, not done

The independent review reports pre-fix medians of 3.775 ms without effects and 9.375 ms with effects/symbols on in the no-object fixture, and 7.2 ms with an object, a fresh plate and the default look.
These are earlier lead/reviewer measurements, not measurements of the resumed code.
New GPU timing, plate-reference pixels, cut-width symmetry and real interaction results remain LEAD.
Existing unrelated changes to AGENTS.md, plan/findings.tsv, plan/log.tsv and the untracked dispatch/review files were preserved.
No commit, branch, dependency, later package or server was created.

The lead reruns these exact ids:

```text
render.loop
render.loop-objects
objects.tap
objects.two-subjects
driver.plate
```

### Time

Start from date: 2026-10-09 12:04:04 EDT.
End from date: 2026-10-09 12:17:51 EDT.

Resume 2 - **DONE**: `test/browser/scenarios/loop.scenario.ts:150` measures near-region extents at frame zero, quarter and three quarters, `:177` requires both moving extents to be at least the frame-zero extent minus 1 px, `:163` logs the quarter-frame far-side cut without asserting its width, and `:275` samples the flat background from the same quarter-loop PNG with the object and its palette pins present for the existing 2-level comparison; typecheck and all 806 non-Chrome node tests **PASS**, while the corrected `render.loop` and `render.loop-objects` browser checks remain **LEAD**; start from date 2026-10-09 12:20:55 EDT, end from date 2026-10-09 12:24:23 EDT.

`npm run typecheck` - **PASS**, exit 0, last lines:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - **PASS**, exit 0, last lines:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36842.627834
```

Logs: `/tmp/noisy-D6-resume2-typecheck.log`, `/tmp/noisy-D6-resume2-tests.log`.
