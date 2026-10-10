# D4: objects and recolor

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

A judge taps a person or object on the stage.
If the tap lands on an existing object it becomes the selection; otherwise the warmed decoder runs at that point and the best candidate becomes a new object, a subject, with the complete record the document schema requires.
The selected object shows an on-screen outline and a swatch row; a swatch recolors only that object through the palette's recolor row; a second tap elsewhere selects or creates a second object.
Reset restores the import's untouched look.
Nothing here renders motion; the plate request after object changes is wired so D6 finds it done.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` section 1 steps 5 and 8, section 4.1 (recolor rows, the neutral branch, the ceiling), section 4.2 (objects, selection, plate freshness), section 5 (`RenderScene.selected`, `masks`), section 6 row D4.
- `plan/evidence/look-rules.md` heading "Objects, masks, and recolor".
- `plan/evidence/foundations.md` section 1 "Decode prompts and results" (points in frame fractions, three soft candidates at the guide's size, 128 means inside).
- `plan/evidence/D3-return.md` "Public contract for D4 and D6" and the code it names (`src/session/scene.ts`, `driver.ts`, `products.ts`): the decoder handle, `productAsset`, `putMask`, `setDocument`, `requestPlateIfNeeded`.
- `plan/evidence/D2a-return.md` and `src/render/palette.ts` (`PaletteObject`, `recolorRow`, how `documentPalette` reads `produced.color`), `src/render/renderer.ts` (how `setScene` derives labels from `doc.objects` and `masks`; `selected` is accepted and ignored today).
- `src/core/schema.ts`: `objectProducedSchema` and what it nests (`selection`, `mask`, `bounds`, `depth`, `color` with a mean and two or three clusters); `src/core/defaults.ts` `newObject`; `src/core/edits.ts` `object.add`, `object.set`; `src/core/derive.ts` `labelAt`, `layers`, `plateNeeded`; `src/core/ids.ts` for minting an `ObjectId`; `src/photo/stats.ts` for the k-means you reuse on masked pixels.

Decisions already made:

- A tap arrives as frame fractions from the stage's CSS box; the page calls `session.tap({ x, y })` and nothing else.
- Before the decoder is warmed the status says `Still analyzing…` and the tap is ignored. If `labelAt(doc, masks, point)` hits an object, it becomes `selected` and no decode runs.
- Otherwise one decode with the single include point; take `candidates[0]`; a candidate with fewer than 0.1% of the guide's texels at or above 128 gives the status `Nothing there` and no object.
- The complete `ObjectProduced`: the decoder's model id; `selection` as the tap in the schema's shape; `mask` as the asset id from `productAsset(mask.data)` with the plane stored through `putMask`; `bounds` as the master-pixel box of mask at or above 128; `depth` as p10, median and p90 of the depth plane under the mask when depth exists, else null with `object.depth` applied through `applyProduce` when it lands; `color` as the Oklab mean and two or three k-means clusters of the thumbnail's pixels under the mask (resample the mask to the thumbnail). Build it in `src/session/objects.ts` as pure functions over planes so node tests cover them.
- `newObject` with `subject: true` (every tapped object is a subject, plan 4.2), added through `applyEdit({ kind: 'object.add', ... })` via `setDocument`; then `selected` = its id; then `requestPlateIfNeeded()` (a no-op unless Motion is on).
- At most 8 objects in the demo; the ninth tap says `That is enough objects for one photo`.
- Swatches: a fixed row of eight Oklch targets chosen by you (vivid, distinct hues, L between 0.55 and 0.75, C between 0.12 and 0.2) plus `Original` (recolor `none`); applied through `applyEdit({ kind: 'object.set', id, patch: { recolor: { kind: 'target', color } } })`. The row shows only while something is selected. Record the eight values in the Return; the choice is Nathan's taste to revise.
- Deselect: an `Escape` key or a `Deselect` button clears `selected`; a tap on an existing object never creates a new one.
- Selection outline: the renderer draws a 2 px white line at the selected label's edge on screen only; `exportStill` never includes it. This is the one render-lane change in this package: a new `src/render/shaders/select.ts` and the smallest change to `src/render/renderer.ts` that draws it after the chain and before present when `selected` is non-null.
- Reset: the session keeps the baseline document from import (before any edit) and `reset()` restores it, re-applies the depth product if one exists, drops objects, masks, plate and selection; the status says `Reset`.
- Masks stay at the guide's size; the renderer already samples them as the evidence says.
- Three facts from the independent review of D2a (`plan/reviews/D2a-review.md`, readiness notes): label ids are the object's index in `doc.objects` plus one, used by the label texture, the clarity table and the LUT rows, so never assume another numbering; the renderer's label cache key includes each mask `Plane`'s object identity, so hand the renderer the same `Plane` objects on every `setScene` (the products map already keeps them; do not copy or rebuild planes per update) or every slider move pays a 786k-call label rebuild; and `exportStill` snapshots the visible canvas, so the working overlay pattern is: render without the overlay, `toBlob`, then re-render with the overlay in the same task.
- No new runtime dependency; no `Math.random()` outside the swatch-free paths; ids come from `crypto.randomUUID` through core's minting.

## Scope

- Create: `src/session/objects.ts`, `src/ui/swatches.tsx`, `src/render/shaders/select.ts`, `test/objects.test.ts`, `test/browser/scenarios/objects.scenario.ts`.
- Change: `src/session/scene.ts` (tap, select, recolor, reset, the baseline), `src/session/test-hooks.ts` (`tap(x, y)`, `select(id | null)`, `setRecolor(color | null)`, `reset()`, `objects(): { id, subject, recolor, bounds, depth, selected }[]`), `src/ui/app.tsx` (the tap handler, the swatch row, Reset and Deselect), `src/render/renderer.ts` (the selection overlay only), `src/photo/stats.ts` (only to export a k-means helper over an explicit pixel list if none is exported), `test/browser/page-globals.d.ts`, `test/browser/scenarios/index.ts`.
- Do not touch: `src/analysis/`, `src/core/`, `src/render/` beyond the two files named, `src/export/`, `src/store/`, `src/dev/`, `tools/`, `headers.json`, `plan/demo.md`.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests for `objects.ts`: bounds of a synthetic disc mask at the guide's size map to the right master pixels; depth statistics over a synthetic plane under the mask; color mean and clusters of a two-tone region under the mask; the assembled `ObjectProduced` parses under the schema inside a document (add it to a fixture document through `applyEdit` and parse).
3. Browser scenario `objects.tap` (target `dev`, timeout 300 s, real models): import an in-page 4032 x 3024 fixture with a flat mid-gray background and one solid saturated disc (radius 500 master px, off center); wait for `Ready to tap`; `tap` at the disc's center: within 1 s `objects()` has one entry, selected, whose bounds contain the disc and whose color mean is within 0.05 Oklab of the disc's color; the on-screen pixels along the disc's edge differ from `downloadPng`'s pixels there (the overlay) while pixels well inside do not; after `select(null)` an export equals the export taken while selected (the overlay never exports); `setRecolor(<a swatch>)` on the object changes the export inside the disc at three sampled points and leaves three background points unchanged; `tap` at the disc center again adds no object; `reset()` leaves zero objects and an export byte-identical to the export taken right after import.
4. Browser scenario `objects.two-subjects` (target `dev`, timeout 300 s, real models): the same background with two discs; tap each; with `simplify` 1 and `subjectClarity` 1 the simplified patch (`render.readSimplifiedPatch`) inside each disc equals the master there and a background patch differs from the master: the per-label clarity table holds for two subjects.
5. The status sentences `Still analyzing…`, `Nothing there`, `That is enough objects for one photo`, `Reset` appear on their paths (the first two exercised in the scenario where cheap, else LEAD).
6. No console errors, no CSP violations.

## Return

Write `plan/evidence/D4-return.md` in the shape `AGENTS.md` gives, with the eight swatch values, the public shape of `objects.ts`, the scenario ids, and how the overlay is kept out of the export.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start motion rendering, symbols, or the UI restyle.
