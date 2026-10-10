# D2b: the rest of the still: grain, clipping, crunch, depth edges

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

The still look is complete: after quantize and outline the camera stage runs grain, then clipping, then crunch, exactly in the design's order, and the outline also draws depth discontinuities once a depth plane exists.
Sliders for grain, color noise, grain size, crunch and clipping reach the page.
Crunch is the last item and may be left out alone if the rest is green and time runs short; say so in the Return if you do.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` section 4 items 4 and 6 (the reduction, including the wrap rule for the grain frame), section 5 (the contract; unchanged by this package), section 6 row D2b.
- `plan/evidence/look-rules.md` headings "Grain, clipping, and crunch" and the depth-discontinuity sentence under "Outline"; "Parameters, defaults, and ranges" for `grain`, `colorNoise`, `grainSize`, `grainHold`, `crunch`, `clipping`.
- `plan/evidence/D2a-return.md`, then `src/render/renderer.ts`, `src/render/gl.ts`, `src/render/shaders/shared.ts`, `src/render/shaders/outline.ts`, `src/render/debug.ts`: the chain you extend. Keep its structure: one file per pass under `src/render/shaders/`, GLSL in template strings, programs and targets owned by `gl.ts` helpers.
- `src/core/motion.ts` (`frameCount`) for the hold arithmetic; a still uses frame 0.
- `src/session/test-hooks.ts` and `test/browser/page-globals.d.ts` for how hooks are declared; `test/browser/scenarios/render.scenario.ts` for the fixture recipes to share.

Decisions already made:

- Grain: one noise value per `grainSize` x `grainSize` cell of the output grid, cells anchored at the master origin; Oklab L offset `0.12 * grain * n_L`, a and b offsets `0.06 * colorNoise * n_a` and `0.06 * colorNoise * n_b`, each `n` uniform in `[-1, 1]` from an integer hash of `(seed, holdIndex, cellX, cellY, channel)`. The hash is a published 32-bit integer finalizer (PCG or a murmur3-style fmix; name it in the Return) written once in GLSL and once in TypeScript (`src/render/grain.ts`), and the TypeScript copy is unit-tested against three fixed vectors that the GLSL copy is checked against in the browser scenario through a 4-cell readback. Inside subject labels the amplitude scales by `1 - 0.5 * subjectClarity`. The hold index is computed on the CPU: `holdIndex(frame, frameCount, grainHold) = floor((frame mod frameCount) / grainHold) mod ceil(frameCount / grainHold)`, a pure exported function, passed as a uniform; a still passes frame 0. The design does not fix the hash, the distribution or the channel salts: record your choices as findings in the Return.
- Clipping: `k = 1 - 0.35 * clipping`; lightness at or below `k - 0.05` is unchanged; above it a quadratic knee of width 0.05 bends the curve so it is continuous with continuous slope at `k - 0.05` and reaches exactly 1 at L = 1, monotonic throughout; `clipping` 0 is the identity. Write the knee as a pure TypeScript function too and unit-test continuity, monotonicity and the endpoints; the GLSL copy uses the same formula. The design does not fix the knee: a finding.
- Crunch: JPEG's YCbCr (BT.601 on sRGB bytes) as the color transform, since the artifact wanted is JPEG's; 8 x 8 DCT on Y at master size and on Cb and Cr subsampled 2 x 2 to half size, blocks anchored at the master origin; the standard JPEG luminance table for Y and the standard chrominance table for Cb and Cr; libjpeg's quality scaling (`scale = q < 50 ? 5000 / q : 200 - 2q`, `t' = clamp(floor((t * scale + 50) / 100), 1, 255)`) with `q = round(mix(100, 20, crunch))`; quantize by rounding to the nearest multiple; four separable passes per plane (row DCT, column DCT with quantization, column IDCT, row IDCT) on R16F targets for Y and RG16F half-size targets for Cb and Cr, as the evidence requires for precision; at `crunch` 0 every crunch pass is skipped and the output is bit-identical to the input. The color transform and the chroma table are findings (the design names only the luma table).
- Order: grain, then clipping, then crunch, after outline (or after the cells pass once D5 exists) and before present. `exportStill` runs the same chain.
- Depth edges: when `RenderScene.depth` is non-null, upload the plane as an R16F texture at its own size with LINEAR filtering (that is the bilinear upsample the plan allows), and the outline also draws where the depth differs by more than 0.05 of the plane's range from a neighbor within half the outline width; null depth skips the term. D3 supplies real depth; here a dev-only hook `demo.injectDepth(plane)` in `src/session/test-hooks.ts` feeds a synthetic plane through the session's scene so the scenario can test it (D3 is adding `injectMask` to the same file in its worktree; keep your addition small and separate so the merge is trivial).
- Timings: the warmed median of five full-chain renders with grain, clipping and crunch all non-zero must stay under 50 ms at 2048 x 1536; the lead records the number. If crunch alone breaks it, report the per-pass cost and stop; do not loop on performance.
- No new runtime dependency; no `Math.random()`, no clock in render inputs.

## Scope

- Create: `src/render/shaders/grain.ts`, `src/render/shaders/clip.ts`, `src/render/shaders/crunch.ts`, `src/render/grain.ts` (hash, hold index), `src/render/clip.ts` (the knee), `src/render/crunch.ts` (tables and quality scaling), `test/grain.test.ts`, `test/clip.test.ts`, `test/crunch.test.ts`, `test/browser/scenarios/camera-stage.scenario.ts`.
- Change: `src/render/renderer.ts`, `src/render/gl.ts` (only if a helper is missing), `src/render/shaders/outline.ts` (the depth term), `src/render/debug.ts` (per-pass timings if cheap), `src/session/test-hooks.ts` (`injectDepth` only), `src/ui/app.tsx` (five sliders, the one wiring change this package is allowed), `test/browser/page-globals.d.ts`, `test/browser/scenarios/index.ts`, `test/browser/scenarios/render.scenario.ts` only to export its fixture helpers.
- Do not touch: `src/analysis/`, `src/core/`, `src/photo/`, `src/session/scene.ts`, `src/export/`, `src/store/`, `src/dev/`, `tools/`, `headers.json`, `plan/demo.md`.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests: the hash matches its three fixed vectors and its values over 10,000 cells have mean within 0.02 of 0 and all lie in `[-1, 1]`; `holdIndex` with 69 frames and hold 2 gives the same index for frames 0 and 69 and increments every two frames; the knee is the identity at `clipping` 0, unchanged at or below `k - 0.05`, continuous in value and slope there, monotonic, and 1 at 1; the quality scaling reproduces libjpeg's table at q 50 (identity) and q 20 (250%) and `q = 100` gives all ones.
3. Browser scenario `render.camera-stage` (target `dev`): on the shared gradient fixture, with grain, color noise, crunch and clipping all 0 the export is byte-identical to the export from the D2a chain (take it before enabling any of them); with grain 0.5 the export differs, two exports are byte-identical, and the GLSL hash matches the TypeScript hash on four read-back cells; with grain size 4 the four pixels of a cell carry the same offset (sample three cells); with clipping 1 on a near-white flat fixture no output lightness exceeds 1 and the result is lighter than the input only where the knee says; with crunch 1 the export differs and the mean absolute difference across 8 x 8 block boundaries exceeds the mean within blocks (the blocking is real); the warmed median of five full-chain renders is recorded.
4. Browser scenario `render.depth-edge` (target `dev`): on the flat single-color fixture with an injected depth plane whose left half is 0.2 and right half 0.8, at outline 0.4 the pixels within the half width of the center column are darkened toward the darkest variant and pixels 12 px away are not; with `injectDepth(null)` no pixel changes between outline 0 and 1.
5. The five sliders in the page change the document through `applyEdit` and the renderer follows.
6. No console errors, no CSP violations, no WebGL app errors.

## Return

Write `plan/evidence/D2b-return.md` in the shape `AGENTS.md` gives, with the hash, knee, color transform and table choices listed as findings, the scenario ids for the lead, and whether crunch landed.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start symbols, objects, or motion.
