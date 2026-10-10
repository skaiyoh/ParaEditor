# D2a review (code-reviewer)

Diff: `git diff 8e8a3b0 e2f95bd -- src/render src/session src/ui src/export test/palette.test.ts test/gamut.test.ts test/browser/scenarios/render.scenario.ts`, judged against `plan/dispatches/D2a-render-contract.md`, `plan/demo.md` sections 4, 4.1 and 5, and `plan/evidence/look-rules.md`.
Experiments ran in an APFS clone under the session scratchpad, built and driven with `tools/drive-chrome.mjs` (headless Chrome 155 on this Mac). The clone was restored afterwards.
Nothing in this repository was changed except this file.
While I worked, `plan/findings.tsv` changed (an F5 row) and `plan/dispatches/D4-objects.md` and `D5-symbols.md` appeared. Those edits are not mine.

## Code findings, most severe first

### 1. Outline slope threshold is 4x the written rule. The scenario passes only because of that. CONFIRMED

- Where: `src/render/shaders/outline.ts:26` and `:37` (`gm > 0.04`, `slope > 0.04`, where `gm` is the gradient per master px).
- Rule (look-rules "Outline", and the dispatch): "its slope is at least 0.04 per working texel". At divisor 4, one working texel is 4 master px, so the written threshold is `gm > 0.01` per master px.
- Code: `gm > 0.04` per master px, which is 0.16 per working texel. This matches the experiment's `post` (`gm*div/4. > 0.04`, which is `gm > 0.04` at div 4), not the written rule.
- Neither the Return nor the new sentence in `plan/demo.md` section 5 names this unit choice. The new sentence ("the experiment's ... slope threshold") overrides look-rules without saying so.
- Measured in the clone, with only the threshold changed to the written value (`gm * 4. > 0.04`):
  - `render.outline` FAILS. At outline 1, ghost ink appears at offsets -14, -13, 12 and 13 px from the sharp edge (the DoG side-lobe crossings).
  - On `plan/reference/simplify-cost/master.jpg` at default style, the inked pixels between outline 0 and the given outline are:

    | Outline | As shipped | Written rule |
    | --- | --- | --- |
    | 0.4 | 1,944 | 21,733 |
    | 1 | 5,801 | 61,404 |

    That is out of 3.1 M pixels.
- The shipped threshold leaves almost no outline on a real photo at the defaults (0.06% of pixels). This bears directly on Nathan's C1 judgment.
- Smallest fix: a decision, not code.
  - Check design §10 Outline (ask Codex, or `rg -n "per working texel" plan/reference/design.md`).
  - Then either restate the rule in `plan/demo.md` section 5 as "0.04 per master px at divisor 4 (0.16 per working texel), as the experiment ran it" and log a finding for the source,
  - or switch to the written threshold and handle the side-lobe ghosts.
  - Either way, record it in `plan/findings.tsv`.

### 2. A recolored subject's pinned entries are recolored in row 0 and every other row. CONFIRMED

- Where: `src/render/palette.ts:116-118` (`recolors.get(entry.pinLabel)?.[i]` inside `base`). `test/palette.test.ts:118` locks the behavior in.
- Rule: recolor "creates an object-specific palette LUT row, not a hue-only shift or palette-slot replacement".
  - "Pinned subject swatches use object recolor instead" sits under Palette targets. It says targets skip pins. It does not say the shared row takes the recolor.
- Pins are global entries in the GPU's nearest-entry search (`quantize.ts:16-20`). Any plate or other-object pixel nearest to the recolored subject's pin is drawn in the target color.
- Reproduced in Node: a background with a red cluster, plus a red subject recolored to blue (h 250). `resolved[0]` for the pin is `{l:0.5, c:0.12, h:250}`, the same as row 1. So red background things turn blue.
- D4's planned check will not catch this. Its fixture has a gray background, which never wins the saturated pin.
- Fix:
  - Drop lines 117-118 so `base` uses `saturate(...)` for pins.
  - Keep `resolved[label] = recolorRow(...)` for the object's own row only.
  - Flip the test at line 118.
  - The darkest-variant search (row 0) then also stops picking up recolored pins.

### 3. The neutral recolor branch tests a different chroma than the formula uses. CONFIRMED

- Where: `src/render/palette.ts:84` (`neutral = oklabToOklch(mean).c < 0.03`, the raw object mean) against `:89` (`max(reference.c, 0.03)`, the assigned entry).
- Rule: "`mean` is the object's `produced.color.mean` run through palette assignment". Section 4.1's branch is "scale 1 when `C_mean < 0.03`". Both are C of the assigned entry.
- Reproduced in Node: a muted object (mean C 0.05) assigned to a near-gray entry (C 0.01), target C 0.12. The mean entry lands at C 0.06, which is the half-chroma failure F1 exists to remove.
- The reverse case, a gray mean on a colored entry, flattens every entry to `T.c` and loses relative chroma.
- Fix: `const neutral = reference.c < 0.03;`. Add a unit case where the mean and its assigned entry fall on opposite sides of 0.03.

### 4. `demo.download` is red after D2a. CONFIRMED

- Where: `test/browser/scenarios/demo.scenario.ts` (outside D2a's scope). It calls `stage.getContext('2d')` on the canvas that now holds a WebGL2 context. It also asserts master pixels, but the download is now the rendered look.
- Ran `node tools/drive-chrome.mjs 'demo.*' --target dev` at e2f95bd: `FAIL demo.download ... Error: No master context.` `demo.import` passes.
- The Return lists this under "Noticed, not done". The lead's verification (the two `render.*` scenarios) did not include it, so `npm run test:browser` is red as committed.
- Fix: a small dispatch that retires `demo.download`'s master-pixel check (`render.first-look` now covers stage against export) or rewrites it to capture through a 2D canvas.

### 5. A lost context reports "The photo exceeds this WebGL2 device's texture limit." CONFIRMED

- Where: `src/render/renderer.ts:122-123`. `getParameter` returns `null` on a lost context, and the `typeof maxSize !== 'number'` branch then throws the texture-limit sentence.
- `session.edit` calls `setScene` before `renderStill`, so `renderStill`'s context-lost message (`:190`) is never reached on that path.
- Reproduced in Chrome: `WEBGL_lose_context.loseContext()` on the stage's context, then `setStyle({ bands: 3 })`. The status reads "The photo exceeds this WebGL2 device's texture limit."
- On demo day, a GPU reset would tell the presenter the photo is too big.
- Fix: in `setScene`, `if (gl.isContextLost()) throw new Error('The WebGL2 context was lost. Reload to restore the renderer.')` before the limit check.

### 6. The subject band count is computed twice, in float64 and float32. PLAUSIBLE, not run on the GPU

- Where: `palette.ts:136-137` uses `Math.round(mix(bands, 6, clarity))` in float64 to size the LUT row. `quantize.ts:25` uses `floor(mix(...) + 0.5)` in float32 to pick the band.
- At an exact .5 tie with a non-dyadic clarity they can disagree. Example: bands 3 and clarity 5/6 give CPU 6 and GPU 5, because float32(5/6) < 5/6. The GPU then indexes 5 of the 6 variants and never reaches the top one.
- The 0.01-step slider cannot produce such a value. Only `setStyle` can, so this is low.
- Fix: compute the per-label band count once on the CPU and pass it, either as a `uniform int` array or in the LUT's unused alpha.

## Readiness notes (brief)

- **D2b:** grain, clipping and crunch slot in between `outline` (writes `buffers.final`) and `present` without restructuring.
  - `gl.ts` `texture()` knows only `rgba8 | rgba16f | r8`. Crunch's R16F and RG16F targets need two more formats, a few lines.
  - The probe's completion read (`complete(buffers.final)`) must move to the last target.
- **D2b/D3 depth:** `setScene` ignores `depth` today. There is no texture and no key, so the depth edge needs an upload and a key on plane identity.
- **D4, label ids:** label ids are `doc.objects` index + 1, used consistently by the label texture, the clarity table and the LUT rows.
  - That convention is written nowhere in `types.ts` or section 5.
  - look-rules says Geometry uses indices into `layers`. D6 must use the same convention or remap.
- **D4, mask identity:** the label key includes each mask `Plane`'s object identity (a WeakMap). A driver that builds a new `Plane` per `setScene` forces a CPU label rebuild (786k `maskCovers` calls per object) and a simplify rerun on every slider move. D4 should keep mask planes stable, or the key should drop plane identity and rely on the mask asset id it already includes.
- **D4, selection overlay:** `exportStill` renders through the visible canvas and calls `toBlob`. The D4 dispatch already requires the overlay to stay out of the export. The working pattern is: render without the overlay, call `toBlob` (it snapshots synchronously, verified below), then re-render with the overlay in the same task.

## Claim findings

1. `src/render/shaders/outline.ts:9`: "Depth is accepted by RenderScene; its discontinuity test lands with D4." `plan/demo.md` section 6 row D2b owns "the depth-discontinuity outline source once depth exists". Verified by reading the package table. Fix: say D2b.
2. `plan/findings.tsv` F4: "3.2 ms per slider change (quantize+outline+present)".
   - The probe times `renderStill` only (`debug.ts`, `renderer.ts:192-209`).
   - Every colors, bands or saturation move also re-runs `resolvePalette` inside `setScene`. Timed in Node, that is about 2.1 ms per resolve (16 clusters, 12 colors, 6 bands), so a slider change costs about 5 ms end to end.
   - The timing also ends at a 1 x 1 read of `final`, before `present` is forced.
   - Not wrong as a GPU number. Wrong as "per slider change".
3. `plan/demo.md` section 5, the new outline sentence: "The local estimate alone thins a width-6 sharp edge to two pixels per side." VERIFIED in Chrome: with the refinement disabled in the clone, `render.outline` fails because offsets -3 and +2 are uninked (two per side). The same sentence's "experiment's slope threshold" is accurate about the experiment, but see finding 1.

## Holds (verified correct)

- **Port of the reference shaders:**
  - `down`, `tensor`, `blur` and `dog` are character-for-character equal to `plan/reference/simplify-cost/index.html`.
  - `akf` and `up` differ only by the clarity table: `rad = R*(1-clarity[l])` and `d = max(dBg, clarity[l])`.
  - `R = 6*simplify`, `dBg = max(0, 1-3*simplify)`, divisor 4.
- **Label lookup:** `labelOf` is the reference's integer `texelFetch` formula, plus an index clamp. The working texel's label is taken at `(min(4x+2,W-1), min(4y+2,H-1))`. R8 ids are recovered exactly with `round(255*r)`.
- **Zero rules:**
  - `simplify` 0 and clarity 1 copy the master's RGB.
  - The portrait 1000 x 1500 import gives identity 0.
- **Quantize:**
  - Distance `0.5dL^2+da^2+db^2`.
  - `W`, `s`, `t` and the index exactly as written, classified on the source entry's L.
  - Variants at `W(L') + 0.45(i+0.5)/bands`.
  - First-minimum ties. Padding slots (copies of entry 0) never win.
- **Palette:**
  - The saturation formula and its weight are as written.
  - The Ward merge is weighted, deterministic and nested.
  - Palette targets: the lowest cluster wins, because core keeps `paletteTargets` sorted.
  - The ceiling drops the latest subjects' pins first. The dispatch's fifth-subject expectation was arithmetic error (12 + 15 = 27 <= 32), and the implementor was right to report it FAILED.
  - Oklab GLSL constants are identical to `core/color.ts`.
- **Gamut:** `Lcusp` and `Cmax` reproduce the red, yellow and cyan primaries exactly.
  - Blue resolves to L 0.490 and C 0.282 rather than the primary's 0.452 and 0.313.
  - At the primary's exact hue, the in-gamut chroma set is [0, 0.266] plus the isolated primary point (r dips to -0.0006 between them). A 2-degree hue scan found no in-gamut chroma beyond `Cmax` anywhere, so the contiguous boundary is the right reading.
- **Cache keys:**
  - Master identity, plate identity, the label signature (ids, document index, mask asset, mask identity, master size), the subject table with `subjectClarity`, and `simplify`.
  - A second import at the same size and one at a different size both rebuild, and the canvas, export and buffers resize: probe at 2048 x 1536 then 1000 x 1500, stage against export difference 0.
- **Resources:** every texture, framebuffer, LUT and label replaced in `setScene` is released, and `dispose` frees all of them. No leak found by reading.
- **Export:**
  - Present flips storage rows to the bottom-up framebuffer.
  - The export is opaque, at master size, and equals the stage.
  - `toBlob` snapshots at invocation: an edit fired right after `downloadPng()` left that blob byte-equal to the pre-edit export.
- **Determinism:** no `Math.random`. The clock appears only in the dev probe.
- **Lane contract:**
  - `src/render` imports only `core` and itself.
  - `src/ui/app.tsx` imports session and core types.
  - `src/export/png.ts` takes only `import type { Renderer }`.
  - The session owns the renderer, and the page hands it the canvas.
- **Uniform budget:** `MAX_FRAGMENT_UNIFORM_VECTORS` is 1024 on this Mac's Chrome. `quantize` needs about 289 vectors (`float[256]` + `vec3[32]`), above WebGL2's guaranteed 224, so a minimum-spec device would fail to link. The phone was not checked.
