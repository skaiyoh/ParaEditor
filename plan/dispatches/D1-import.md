# D1: import, document, stage, download

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

A judge drops a JPEG on `/` (or clicks Open and picks one) and within about a second the photo is on screen as the demo's master: oriented, resized to the design's master size, drawn on the stage canvas.
Behind it a `SceneDocument` exists for the photo, with the color clusters and tone statistics the renderer will need.
Download saves that master as a PNG.
A HEIC file gets the design's one sentence.
This is the first and last beat of the story; D2a replaces the plain master on the stage with the rendered look. You may draw the master with a 2D context, but a canvas that has had a 2D context can never give WebGL2, so make the stage component own its canvas node and create it fresh, so D2a can swap in a new node for the renderer without touching the rest of the page.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` sections 1, 2, 5 (the contract D2a will build to: your document is its `doc`), 10.
- `plan/evidence/foundations.md` sections 3 (build entries, `bootRoot`, `installTestSurface`), 4 (serve, CSP), 5 (core document, `newDocument`, ranges, edits), 6 (platform has no photo helpers), 7 (scenario shape and the driver).
- `plan/evidence/look-rules.md` heading "PNG master export" (the master size rule) and the first paragraph of "Palette, saturation, quantization, and tone" (16 Oklab clusters).
- `plan/reference/design.md` section 12 only: the import limits (long edge, master short side, megapixels), the HEIC sentence, the decode path (image element for the oriented size, `createImageBitmap` with resize options and `imageOrientation: 'from-image'`, full decode and `drawImage` as the fallback).
- `src/core/schema.ts`: `frameSchema`, `analysisColorsSchema`, `toneStatsSchema`, `assetIdSchema`, and `sceneDocumentSchema`, for the exact shapes your document must satisfy; `src/core/defaults.ts` for `newDocument`; `src/platform/build-id.ts` for `readBuildId`.
- `src/main.tsx` and `src/app/` as they are: a placeholder shell that boots a root and installs the test surface. You replace the shell, keep the boot.
- `src/dev/decoder.ts` lines 150 to 190: a canvas resize example you may borrow from.

Decisions already made:

- Master: long edge `min(2048, L)` floored to even; short edge `2 * Math.round(S * long / L / 2)`; opaque sRGB; keep the `ImageData` of the master in memory (the analysis workers need a fresh `ImageBitmap` per stage later) and an `ImageBitmap` for drawing.
- Asset ids: the SHA-256 hex of the source file's bytes through `crypto.subtle.digest`; the document never persists in the demo, so no store is involved, but the document must parse under `sceneDocumentSchema(SCENE_VERSION)`.
- Color clusters: k-means in Oklab over a 256 px long-edge thumbnail of the master, k at most 16, deterministic initialization (k-means++ seeded from the document's `seed` through a small integer hash, never `Math.random()`), weights summing to 1, in the exact shape of `analysisColorsSchema`. Tone statistics in the exact shape of `toneStatsSchema`, from the thumbnail's Oklab lightness.
- `src/core/color.ts` holds the sRGB to linear, linear to Oklab, Oklab to Oklch conversions and their inverses, as pure functions, using Björn Ottosson's published matrices; everything else that needs color math imports it from there.
- The seed is a uint32 from `crypto.getRandomValues` at import.
- Status line text: `Drop a photo`, `Importing…`, `Ready`, and the design's HEIC sentence verbatim on refusal; the other refusals use section 12's sentences.
- No new runtime dependency.

## Scope

- Create: `src/core/color.ts`, `src/photo/decode.ts`, `src/photo/limits.ts` (the pure size rules: the master size from an oriented source size, and the three refusals of section 12), `src/photo/stats.ts`, `src/photo/thumbnail.ts` (or fold it into `decode.ts`), `src/demo/app.tsx`, `src/demo/scene.ts`, `src/demo/test-hooks.ts` (the `demo` member of the test surface, so later packages extend this file and not `src/app/test-surface.ts`), `src/export/png.ts`, `test/color.test.ts`, `test/photo-limits.test.ts`, `test/photo-stats.test.ts`, `test/browser/scenarios/demo.scenario.ts`.
- Change: `src/main.tsx` (mount the demo app instead of the shell), `src/app/test-surface.ts` (compose the `demo` member from `src/demo/test-hooks.ts` in dev builds: `importFile(file: File): Promise<void>`, `scene(): { status: string; master: { width: number; height: number } | null; clusters: number; path: 'resize' | 'fallback' | null }`, `downloadPng(): Promise<Blob>`), `test/browser/page-globals.d.ts` (declare the `demo` member there, so scenarios call it typed, no casts), `test/browser/scenarios/index.ts` (register the new file), `src/app-env.d.ts` only if a build constant is needed.
- Do not touch: `src/analysis/`, `src/core/` except the new `color.ts`, `src/store/`, `src/dev/`, `tools/`, `headers.json`, `plan/` except your Return file.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests: sRGB white maps to Oklab `(1, 0, 0)` within 1e-4, sRGB red to `(0.6280, 0.2249, 0.1258)` within 2e-3, and a round trip sRGB to Oklab to sRGB is within 1e-4 for a grid of 125 colors; k-means over a synthetic image of three flat regions (50%, 30%, 20% of the pixels) returns three dominant clusters whose weights match within 0.02 and whose colors match within 0.01 in Oklab, and the same input gives the same output twice; `photo/limits.ts`: 4032 x 3024 gives 2048 x 1536, 3024 x 4032 gives 1536 x 2048, 1500 x 1125 gives 1500 x 1126, 400 x 300 is refused for the long edge, a 20000 x 400 source is refused for the master short side, and a source above section 12's megapixel limit is refused as too large, each with the sentence section 12 gives.
3. Browser scenario `demo.import` (target `dev`): the page at `/` is cross-origin isolated and shows `Drop a photo`; the scenario builds a 4032 x 3024 JPEG in-page (OffscreenCanvas with a gradient, `convertToBlob({ type: 'image/jpeg' })`, wrapped in a `File`) and hands it to `__noisyTest.demo.importFile`; within 3 s the status is `Ready`, the stage canvas's `width` and `height` attributes are 2048 and 1536, `scene().clusters` is between 2 and 16, and `scene().path` is `resize` or `fallback` (record which in the Return as the lead reports it); the same with 3024 x 4032 gives 1536 x 2048; a 400 x 300 JPEG is refused with the long-edge sentence; a `File` whose bytes begin with a 32-byte HEIF header (`ftypheic` brand) is refused with the HEIC sentence verbatim.
4. Browser scenario `demo.download` (target `dev`): after an import, calling the download action through the test surface (add `downloadPng(): Promise<Blob>` to the `demo` member) yields a `image/png` blob that decodes to the master's size and whose pixels equal the master's within 0 of 255 at 32 sampled points.
5. Dropping a file on the stage and the Open button both reach the same import function (the scenario may call the function; the drop and the button are wired and read by the lead in Chrome).
6. The document parses under `sceneDocumentSchema(SCENE_VERSION)` after import (assert it in `scene.ts` in dev builds and surface a failure as a status line error).
7. No console errors or CSP violations on load or import (the driver checks this on every scenario).
8. LEAD, manual at C1: an EXIF-rotated portrait iPhone JPEG imports upright, and the path the real photo took is read from `scene().path`. In the Return, state how the code chooses between the two paths; do not state which path ran, since you cannot observe it.

## Return

Write `plan/evidence/D1-return.md` in the shape `AGENTS.md` gives.
Include the list of scenario ids for the lead to run and the public shape of `src/demo/scene.ts` (the document plus the in-memory master), since D2a and D3 build on it.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start the renderer, sliders, or anything from D2a.
