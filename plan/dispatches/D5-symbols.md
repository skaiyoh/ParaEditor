# D5: cells and symbols

Effort: xhigh. Sandbox: rw. Review: codex. impeccable: no.

## Mission

With Symbols on, the frame becomes a grid of cells: each cell is a flat block of its majority variant, and the cells the density rule selects carry one of five procedural glyphs in the adjacent-band ink and paper of their palette entry.
The Symbols toggle and its two sliders reach the page, the outline pass is skipped while Symbols is on, and the camera stage runs after the cells as the design orders.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` section 4 item 5 and section 4.4 (symbols default off; the presenter flips them), section 5, section 6 row D5.
- `plan/evidence/look-rules.md` heading "Cells and symbols" in full, including the arithmetic the `glyph-rule` experiment settled; "Pass order and resolutions" for where the pass sits and what the variant attachment carries.
- `plan/reference/glyph-rule/README.md`, `glyph.mjs`, `density.mjs`, `results.txt`, `density.txt`: the fixtures and the recorded counts you must reproduce.
- `plan/evidence/D2a-return.md`, `plan/evidence/D2b-return.md`, then `src/render/renderer.ts`, `src/render/gl.ts`, `src/render/shaders/quantize.ts`, `src/render/palette.ts` (entries, bands, LUT rows, the darkest variant, tone percentiles), `src/render/debug.ts`.

Decisions already made:

- The variant attachment: quantize writes, when symbols are on, an RGBA8 target with the entry index, the band index, the label, and the pre-banding tone as the design defines it (pre-banding lightness normalized by the asset's p01 and p99, clamped), so the reduction never recomputes quantization. Add it to `quantize.ts` if D2a left it out.
- Cells: one grid of `cellSize` master pixels covering the frame, placed so a cell is centered on the frame's center (the design gives no centering rule; record the choice); partial edge cells are real cells over their own pixels. The two cell tables are RGBA8 textures of `ceil(W / cellSize) + 1` by `ceil(H / cellSize) + 1`.
- Reduction: one fragment per cell loops over its pixels (at most 48 x 48), takes the majority label, then among that label's pixels the most frequent entry, then that entry's most frequent band, then the mean tone over those pixels; ties go to the lowest index (the design names no tie-break; record it). Local integer arrays sized by the ceilings (33 labels, 32 entries, 6 bands) are fine in GLSL ES 3.0.
- Eligibility, density window, the five equal bins, glyph order `. - + * #`, the `always` and `never` modes (objects' `symbols` field) and the adjacent-band ink and paper rule exactly as written. The pure TypeScript twin of this arithmetic lives in `src/render/symbols.ts` and is what the node tests exercise against the experiment's fixtures; the GLSL copy follows the same formulas.
- Atlas: five signed-distance glyphs at 64 x 64 each in one R8 strip, generated procedurally at renderer creation (dot: a disc; dash: a horizontal bar; plus: two bars; star: three bars at 60 degrees; hash: two horizontal and two vertical bars), stroke width about 12% of the glyph, glyph box about 70% of the cell; anti-aliased over one output pixel with `smoothstep`. The geometry is yours; record it as a finding.
- Draw: one full-frame pass reads the pixel's cell from the tables; a solid cell is the paper color; a glyph cell is paper with ink where the distance is inside. Camera stage (grain, clipping, crunch) runs after this pass; outline is skipped entirely while symbols are on.
- Toggle and sliders: `symbols.enabled`, `symbols.cellSize` (even integers 6..48), `symbols.amount` through `applyEdit({ kind: 'symbols', patch })`; the one wiring change in `src/ui/app.tsx`.
- Determinism and timings as before; the full chain with symbols on at cell size 12 and 2048 x 1536 must stay under 50 ms warmed; report the per-pass cost if not, once, and stop.
- No new runtime dependency.

## Scope

- Create: `src/render/symbols.ts` (the pure arithmetic and the atlas generator's distance functions), `src/render/shaders/cells-reduce.ts`, `src/render/shaders/cells-draw.ts`, `test/symbols.test.ts`, `test/browser/scenarios/symbols.scenario.ts`.
- Change: `src/render/renderer.ts`, `src/render/shaders/quantize.ts` (the variant attachment), `src/render/gl.ts` (only if a helper is missing), `src/render/debug.ts` (`readCellTable(cx, cy)` returning the cell's label, entry, band, tone, glyph index and ink/paper decision), `src/ui/app.tsx` (toggle and two sliders), `src/session/test-hooks.ts` (`setSymbols(patch)` only), `test/browser/page-globals.d.ts`, `test/browser/scenarios/index.ts`.
- Do not touch: `src/analysis/`, `src/core/`, `src/photo/`, `src/session/scene.ts`, `src/export/`, `src/store/`, `src/dev/`, `tools/`, `headers.json`, `plan/demo.md`.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests for `symbols.ts` reproduce the experiment's recorded results on its own fixtures: `bands` 4 and `amount` 0.3 give 82 glyph cells with 0 equal ink and paper; `bands` 6 and `amount` 1 give 256 with 0; `bands` 4 and `amount` 0 give 0 glyph cells; the seven-gray-entries case gives 82 with 0; the density fixture gives the window-relative counts `16, 16, 14, 16, 16` at 0.3, `30, 32, 30, 30, 32` at 0.6 and `52, 50, 50, 52, 52` at 1 in glyph order.
3. Browser scenario `render.symbols` (target `dev`): on the shared gradient fixture with grain, color noise, crunch and clipping at 0: symbols off gives an export byte-identical to the export before this package's pass existed (take it with symbols off); symbols on with `amount` 0 makes every sampled cell (20 cells) a single flat color and the export differ from off; `amount` 1 makes at least one sampled cell two-toned with the two colors being adjacent band variants of the cell's entry per `readCellTable`; `cellSize` 24 changes the block period (two sampled rows 24 px apart differ, rows 12 px apart within a cell do not); with symbols on, `outline` 0 and 1 give byte-identical exports; the warmed median of five full-chain renders with symbols on is recorded.
4. The toggle and the two sliders change the document through `applyEdit` and the renderer follows.
5. No console errors, no CSP violations, no WebGL app errors.

## Return

Write `plan/evidence/D5-return.md` in the shape `AGENTS.md` gives, with the centering rule, tie-breaks and glyph geometry as findings, the scenario ids, and the timing if the lead supplied it.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start motion or the UI restyle.
