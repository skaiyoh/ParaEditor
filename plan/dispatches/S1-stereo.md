# S1: the stereo pair

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

The page can hand over the current look as a stereoscopic pair: two views rendered from cameras a little left and right of center, saved as an MPO file the Nintendo 3DS camera app opens in glasses-free 3D, with a JPG twin beside it.
This is the shared half of every 3DS path: the file on the SD card tonight, and the homebrew viewer (S2) later, which streams the same pair.

## Context

- `src/render/types.ts` after R1: `renderView(camera, frame?, showSelection?)` and `exportView(camera, frame?): Promise<Blob>` (a PNG at master size without the selection). Cameras are per-axis frame fractions.
- `src/core/derive.ts`: `parallaxClamp(doc)` (the per-axis reach the loop may use) and `anchorDisparity(doc)`; `src/core/motion.ts`: `Vec2`.
- `src/export/png.ts`: `renderPng`, `savePng` (the download pattern); `src/session/scene.ts`: `savePng()` and `renderPng()` as the shape of an export method on the session.
- `PRODUCT.md`, "Technical constraints": the 3DS camera app shows third-party MPO files only at 640 x 480 or smaller, named like `HNI_0005.MPO` with a non-zero number, in the DCIM subfolder the console created, with a JPG twin beside it. Those are community-reported constraints, not Nintendo documentation; the lead and Nathan test on the unit.
- The MPO container is CIPA DC-007 (Multi-Picture Format): the first JPEG carries an APP2 segment tagged `MPF\0` holding the MP Index IFD (version `0100`, number of images 2, one MP Entry per image: attribute with the Multi-Frame Disparity type and the representative flag on the first, image size, image data offset relative to the start of the MP header, 0 for the first); the second JPEG follows byte-contiguous and carries its own APP2 with an MP Attribute IFD or none.

Decisions already made:

- `src/export/mpo.ts` is pure and node-testable: `encodeMpo(left: Uint8Array, right: Uint8Array): Uint8Array` takes two baseline JPEGs and returns the MPO bytes; it inserts the MPF APP2 right after the first JPEG's SOI (and after an APP1 if one exists), computes offsets after insertion, and never re-encodes pixels.
- `src/export/stereo.ts`: `renderStereo(renderer, doc, size)`: cameras `{x: -s, y: 0}` and `{x: +s, y: 0}` with `s = 0.5 * parallaxClamp(doc).x`, each `exportView` decoded, fitted inside `size` (640 x 480 for the 3DS file, letterboxed on black for a portrait master, the aspect kept), encoded as JPEG at quality 0.92 through a canvas; returns `{ left: Blob, right: Blob, mpo: Blob }`.
- Session methods: `exportStereo(size?): Promise<{ left, right, mpo }>` and `saveStereo(): Promise<void>`, which downloads `HNI_0001.MPO` and `HNI_0001.JPG` (the left view). The page gets a `Send to 3DS` button with `data-testid="send-3ds"` in the slot the direction contract names once D7 has landed, otherwise a plain button in the header that D7 restyles; disabled with no scene.
- Determinism: the same scene gives byte-identical MPO bytes apart from the JPEG encoder's own output, which the tests treat as opaque.

## Scope

- Create: `src/export/mpo.ts`, `src/export/stereo.ts`, `test/mpo.test.ts` (node: two tiny synthetic JPEGs in, the result starts with SOI, holds one `MPF\0` APP2 with two entries, the second entry's offset lands on an SOI, and the total length is the sum plus the segment), `test/browser/scenarios/stereo.scenario.ts` (id `export.stereo`).
- Change: `src/session/scene.ts` (the two methods), `src/ui/app.tsx` (the button only), `test/browser/scenarios/index.ts`, `test/browser/page-globals.d.ts`.
- Do not touch: `src/render/`, `src/core/`, `src/analysis/`, `src/photo/`, `plan/`, the other scenarios.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests that do not launch Chrome pass (the command in `AGENTS.md`).
2. LEAD, scenario `export.stereo`: on the sample with depth present, `exportStereo()` returns a left and a right JPEG of 640 x 480 whose pixels differ (an object centroid shifted horizontally, as `render.view` measures) and an MPO whose bytes parse as in the node test; `saveStereo()` triggers two downloads named `HNI_0001.MPO` and `HNI_0001.JPG`.
3. LEAD, on hardware: the files copied into the console's DCIM subfolder show in the 3DS camera app in 3D. Nathan runs this; mark it LEAD.
4. LEAD: every existing scenario still passes.

## Return

Write `plan/evidence/S1-return.md` in the shape `AGENTS.md` gives, then stop.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not stream anything; S2 owns the network.
