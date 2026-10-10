# D2a: the render contract and the first look

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: no.

## Mission

`src/render/` exists: the contract of `plan/demo.md` section 5 as code, a WebGL2 renderer that turns the imported master into the first look, and the CPU palette resolution it needs.
On the stage the photo is simplified on the quarter working grid, quantized to a merged, saturated palette with the design's band windows, and outlined from its texture edges.
Sliders for fry, colors, bands, saturation, simplify, outline, and subject clarity drive it through the document's edits, and Download now saves the rendered still at master size.
Grain, clipping, crunch, symbols, objects, depth and motion are later packages; the contract already carries their inputs so they plug in without changing it.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` sections 4 (the reduction; 4.1 palette; 4.4 first look), 5 (the contract: binding), 3 (lanes: after you, `src/render/` is the render lane's and `src/session/` the driver lane's; this is the one package that touches both).
- `plan/evidence/look-rules.md` headings: "Pass order and resolutions", "Parameters, defaults, and ranges", "Simplification", "Palette, saturation, quantization, and tone", "Outline" (only the texture-edge and id-edge parts; no crease normals), "PNG master export".
- `plan/reference/simplify-cost/README.md` and `index.html`: the shaders to port (`LABEL_OF`, `down`, `tensor`, `blur`, `akf`, `dog`, `up`; `post` is a proxy, port only its crossing-distance and slope tests). They ran on this Mac in headless Chrome 154; keep their math, restructure the code.
- `plan/evidence/D1-return.md` and `src/session/scene.ts`: the document and the in-memory master you render.
- `plan/evidence/foundations.md` section 5: `applyEdit`, `StylePatch`, the `fry` edit, `clampToRange`, `fryCurve`; the sliders go through `applyEdit` so values clamp and `fry` rewrites its eight fields.
- `src/core/color.ts` from D1: the CPU color conversions; write the GLSL equivalents once in a shared chunk.

Decisions already made:

- The contract in `plan/demo.md` section 5 is binding, including `RenderScene.selected` (unused until D4: accept it, ignore it) and `Renderer.debug` (`src/render/debug.ts`, present under `NOISY_DEV`, `null` in production). If an item must change, change the plan text in the same diff (the plan is in your Scope for that purpose only) and say why in the Return; the lead judges it.
- Resolutions: master size for every pass except the simplification's working grid at divisor 4; the canvas's backing store is the master size, CSS scales it; `exportStill` renders the same chain to a master-size target and returns `canvas.toBlob('image/png')`.
- The canvas: D1's stage draws with a 2D context, which can never give WebGL2; the stage component creates a fresh canvas node for the renderer and drops the old one. The page (`src/ui/`) may import only ui, session and core, so it cannot call `createRenderer` itself: the session owns the renderer, the page hands it the fresh canvas through a session method, and `src/export/png.ts` may import from render only `import type { Renderer }`; `test/import-graph.test.ts` enforces all of this and must stay green.
- Simplify cache key: the master's identity, the plate's identity (none yet), the label texture's identity (objects, masks and their order; none yet), the per-label subject table, `simplify`, `subjectClarity`; a new photo through `setScene` must rebuild it (the scenario imports twice).
- Subjects per label: the experiment's shaders compare against one hardcoded subject label (`abs(l0 - subj) < 0.002`, `LABEL1`); replace that with a 256-entry table of clarity per label (a 256 x 1 R8 texture or a uniform array), 0 for non-subjects, so any number of tapped objects keep detail. No objects exist yet; D4's fixture proves it with two.
- Palette ceiling: the merged unpinned entries plus the pins, at most 32; size the LUT and the GPU loop for 32 and drop the latest subjects' pins first when over. Timings must hold with 32 entries, so test the loop at 32.
- Recolor row for a neutral object: scale 1 when the object's mean chroma is under 0.03, the design's clamp formula otherwise (`plan/demo.md` section 4.1); the row is computed from `produced.color.mean` and `produced.color.clusters` that D4 will store on the object, so `palette.ts` takes those as inputs now and the unit test feeds them directly.
- Timings (`debug.timings()`): from the start of a render to the completion of a 1 x 1 `readPixels` on the final target (the experiment's method); the scenario warms with two renders and takes the median of five.
- Label texture: R8 at 1024 long edge, derived inside the renderer from `doc.objects`, `masks` and `layers(doc)` as the evidence's "Labels" paragraph says; with no objects (the case until D4) it is a 1 x 1 zero texture, so every texel is the plate and the shaders are label-aware from day one. Integer `texelFetch` label lookup as the evidence states.
- The scene the renderer reads is `RenderScene` from `plan/demo.md` section 5: the document, the master bitmap, the masks map, depth and plate. Implement `setScene`, `renderStill`, `exportStill` and `dispose` now; `renderFrame(frame)` may throw `not yet` until D6 but must exist in the type.
- Palette resolution (`src/render/palette.ts`, pure TypeScript, no WebGL): from `doc.analysis.colors` and `doc.style`: nested deterministic weighted Ward merging in Oklab down to `colors` (lowering `colors` by one merges exactly one pair), the saturation rule with `Lcusp(h)` and `Cmax(L, h)` for sRGB found numerically, the band windows per entry, the darkest variant, the tone percentiles, one LUT row per label (row 0 now; the recolor-row formula is implemented and unit-tested but unused until D4). Harmony `off`. Output: a small `Uint8Array` RGBA LUT (entries by bands by rows) plus the entries' source Oklab values for the GPU's nearest-entry search.
- Quantize: nearest entry by `0.5 dL^2 + da^2 + db^2` over at most 16 entries from the simplified color in Oklab; the band window rule exactly as written; subjects use `round(mix(bands, 6, subjectClarity))` bands (no subjects exist yet; implement the branch).
- Outline: width `round(6 * outline)` master px, ink the palette's darkest variant at alpha `outline`, from (a) texture edges: the DoG crossing within half the width by `abs(D) / length(grad D)` and slope at least 0.04 per working texel, and (b) id edges: a label differing from the pixel's within half the width. Depth discontinuities are a hook taking `RenderScene.depth` (null now: skip).
- Determinism: no `Math.random()`, no time; same scene and look give the same bytes.
- Caching: the simplification reruns only when `simplify`, `subjectClarity`, the labels, or the subject set change; every other slider reruns from quantize on.
- No new runtime dependency. WebGL2 only; request `EXT_color_buffer_float` once and fail with a clear status message if absent.

- Ports: another lane may be serving on 8790 at the same time; for your own curl checks start `tools/serve.mjs` on a different port if it has a port flag (read its usage), and otherwise skip serving. The lead runs the browser scenarios on its own server.

## Scope

- Create: `src/render/types.ts`, `src/render/renderer.ts`, `src/render/gl.ts` (programs, framebuffers, textures, a fullscreen draw helper), `src/render/shaders/*.ts` (GLSL in template strings, one file per pass, plus a shared chunk for Oklab and the label lookup), `src/render/palette.ts`, `src/render/gamut.ts` (cusp and max-chroma search), `src/render/debug.ts`, `test/palette.test.ts`, `test/gamut.test.ts`, `test/browser/scenarios/render.scenario.ts`.
- Change: `src/ui/app.tsx` (the slider panel, the fresh canvas node, the renderer wiring; keep the layout plain, impeccable restyles it in D7), `src/session/scene.ts` (edits through `applyEdit`), `src/session/test-hooks.ts` (add to the `demo` member: `setStyle(patch)`, `setFry(f)`, and expose `renderer.debug` as `render`), `src/export/png.ts` (delegate to `exportStill`), `src/app/test-surface.ts` (only to compose), `test/browser/page-globals.d.ts` (the declarations), `test/browser/scenarios/index.ts`, `plan/demo.md` section 5 only when the contract must change.
- Do not touch: `src/analysis/`, `src/core/`, `src/photo/`, `src/store/`, `src/dev/`, `tools/`, `headers.json`.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests for `palette.ts` and `gamut.ts`: the merge is deterministic and lowering `colors` by one merges exactly one pair; at `saturation` 0 every entry keeps its source L and C; an entry with source chroma 0.01 or less is unchanged at every saturation; variant lightnesses within an entry are separated by `0.45 / bands`; gamut clipping keeps L and h and reduces C; `Cmax(L, h)` is in gamut and `Cmax + 0.002` is out, for 12 hues at 3 lightnesses; the recolor row for a gray object (mean chroma 0) lands its mean entry on the target's L, C and h before banding, and for a colored object the mean entry lands on the target's L and h with C by the clamp formula; twelve colors plus four subjects at clarity 1 resolve to at most 32 entries with every pin kept, and a fifth subject loses its pins first.
3. Browser scenario `render.first-look` (target `dev`): after importing the in-page 4032 x 3024 JPEG from `demo.import`'s helper (share it), the stage shows a rendered still; with `simplify` 0 the simplified patch read through `render.readSimplifiedPatch` at (512, 512, 64, 64) equals the master's pixels there within 0 of 255; two `downloadPng` calls with the same settings give byte-identical blobs; changing `bands` gives a different blob; importing a second, different JPEG changes the simplified patch (the cache rebuilt); `render.timings().lastMs` after a `bands` change, warmed and median of five, is under 50 ms and `simplifyMs` after a `simplify` change is under 60 ms on this Mac (the lead records the numbers in the Return; if they exceed the bounds, that is a finding to report, not a reason to loop on performance beyond one honest attempt).
4. Browser scenario `render.outline` (target `dev`): on an in-page fixture with a sharp vertical edge (left half Oklab L 0.3, right half L 0.8, both neutral) imported as a photo, with `simplify` 0: at `outline` 0 the pixels within 6 px of the edge equal the quantized colors of their side; at `outline` 0.4 the pixels within `round(6 * 0.4) / 2` px of the edge equal `mix(side color, darkest variant, 0.4)` within 2 of 255 and pixels 12 px away are unchanged from `outline` 0; at `outline` 1 the darkened band is 3 px each side; a flat single-color fixture shows no pixel change between `outline` 0 and 1 (the negative control).
5. The sliders in the page change the document through `applyEdit` and the renderer follows; `fry` moves the eight fields (visible in the panel's values).
6. No console errors, no CSP violations, no WebGL warnings declared as app errors by the driver.
7. LEAD at C1: Nathan judges the first look on three real photos; nothing for you to do except make the sliders reachable.

## Return

Write `plan/evidence/D2a-return.md` in the shape `AGENTS.md` gives.
Include the final text of `src/render/types.ts`, the measured timings if you obtained any through the lead, the list of scenario ids to run, and every place you departed from the evidence with its reason.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start grain, clipping, crunch, symbols, depth, objects, or motion.
