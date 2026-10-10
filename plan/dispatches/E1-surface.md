# E1: the surface pass

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: yes.


## Mission

A surface in front of the fried picture, chosen from three patterns, that refracts what is behind it and catches a highlight that moves with the camera: oscillating vertical bars that read like a driver glitch, cracked glass whose shards tilt like hills and valleys, and fish scales.
Three sliders shape it, Relief, Refraction and Shine, and a pattern select picks the surface; off, the picture is pixel-identical to today.
Each pattern is a formula the toolbox pitch can point at.

## Context

- `src/render/renderer.ts`: `render(frame, loop, showSelection, camera)` after R1, the pass order quantize, outline or cells, grain, clipping, crunch, present (`plan/demo.md` section 4 and `plan/evidence/look-rules.md`, the camera-stage headings); `cameraDraw` and `gpu.draw`; the grain hash's integer seeding and the frame rule, which this pass copies for its oscillation.
- `src/render/shaders/*.ts`: the shader modules, GLSL ES 3.0 with explicit `layout(location)` on multiple outputs (`AGENTS.md`), the error-to-status path every new program uses.
- `src/core/schema.ts`, `src/core/ranges.ts`, `src/core/defaults.ts`, `src/core/edits.ts`, `src/core/migrate.ts`: how a document field is declared with its range, default, edit kind and migration; the `lighting` field is a model for a sub-object with an `enabled` flag.
- `src/ui/app.tsx`, `src/ui/controls.tsx` and `src/assets/app.css` as D7 left them, and the direction contract at `.impeccable/surfaces/src-ui-app-tsx.md`: the inspector is a stack of collapsible nodes (`Node`, `RangeControl`, `EnableSwitch` in `controls.tsx`); the Surface node joins the stack between Symbols and Palette, collapsed by default, with its enable switch in the heading like Motion's.
- `PRODUCT.md`: "Positioning" (the surface pass), "Planned controls".

Decisions already made:

- Document field `surface: { enabled: boolean; pattern: 'bars' | 'cracks' | 'scales'; relief: 0..1; refraction: 0..1; shine: 0..1; scale: 0..1 }`, default off, pattern `bars`, relief 0.5, refraction 0.5, shine 0.5, scale 0.5; edit kind `surface` with a partial patch; a schema version bump with a migration that adds the default; the same `seed` as the grain.
- One pass, `src/render/shaders/surface.ts`, after outline or cells and before grain, so the surface refracts the cartoon and the grain sits on top like film. Inputs: the quantized color, the depth plane where it exists, the camera the draw used (the loop's or the supplied one), the frame. Outputs: color only. Determinism: the same scene, camera and frame give identical pixels.
- Patterns, each a height field `h(p)` plus its gradient, evaluated in the fragment shader at master resolution:
  - bars: vertical bars across the whole frame with seeded widths and gaps (`scale` sets the mean width from about 1/60 to 1/8 of the frame width), each bar's width oscillating with the loop phase at its own seeded rate and amplitude, the height a half-cylinder across each bar, `relief` scaling it; a still uses frame 0.
  - cracks: a seeded Voronoi over the frame (`scale` sets the cell count from about 12 to 120), each cell a plane with a seeded tilt and a sharp edge at the cell boundary, `relief` scaling the tilt; a thin dark crack line at the boundary, one pixel at master size.
  - scales: overlapping arcs in staggered rows (`scale` sets the row height), each a convex cap, `relief` scaling the cap height; the cap's edge is the highlight's home.
- Refraction: the color is sampled at `p + refraction * k * grad h` with `k` chosen so refraction 1 displaces by about 2% of the long edge at relief 1. Shine: a Blinn-Phong highlight from the normal `(-grad h, 1)`, a light direction at 35 degrees above the camera's own direction that moves with the camera offset (the window and the loop move the glint), intensity `shine`, exponent 24, added in linear light before the pass writes; shine 0 adds nothing and refraction 0 samples in place, so off and all-zero are pixel-identical to today.
- The Surface node: three `aria-pressed` pattern buttons (Bars, Cracks, Scales) in a row under the heading, the enable switch `data-testid="surface-enabled"` in the heading, sliders through `RangeControl` with ids `surface-relief`, `surface-refraction`, `surface-shine`, `surface-scale` (their `value-<field>` outputs follow from the id), styled only through `app.css` with the existing tokens; one wiring change in `app.tsx`.
- Cost: the pass adds at most 2 ms to a full redraw on the demo Mac at master size; report the warmed median of five through the dev probe.

## Scope

- Create: `src/render/shaders/surface.ts`, `test/browser/scenarios/surface.scenario.ts` (id `render.surface`), node tests for the schema, ranges and migration.
- Change: `src/core/schema.ts`, `src/core/types.ts` if not inferred, `src/core/ranges.ts`, `src/core/defaults.ts`, `src/core/edits.ts`, `src/core/reduce.ts`, `src/core/migrate.ts`, `src/render/renderer.ts`, `src/render/types.ts` only if the debug surface needs a reader, `src/session/scene.ts` (a `setSurface` method), `src/ui/app.tsx` (the tab's controls only), `test/browser/scenarios/index.ts`, `test/browser/page-globals.d.ts`, the core tests that enumerate fields.
- Do not touch: `src/analysis/`, `src/photo/`, `src/export/`, `plan/`, the other shaders beyond wiring the pass.

## Acceptance

1. `npm run typecheck`, `npm run build`, `npm run build:production`, and the node tests that do not launch Chrome pass (the command in `AGENTS.md`), including the import-graph and core-module guards.
2. LEAD, scenario `render.surface`: on the sample, with `surface.enabled` false the canvas equals the pre-change render at four sampled points (recorded from a draw before enabling); with bars at relief 1 and refraction 1 a vertical edge in the picture is displaced by at least 1% of the width at a sampled row; with cracks, two sampled points inside different cells show different highlight intensity at shine 1; with scales, the highlight at shine 1 moves between `renderView({x: -r})` and `renderView({x: +r})` at a sampled cap; frame 0 and frame 15 with bars differ, frame 0 twice is identical; the warmed median of five full redraws with the surface on is under the recorded median without it plus 2 ms.
3. LEAD: every existing scenario still passes, `render.camera-stage` and `render.symbols` in particular, and `story.production` finds its controls.
4. The impeccable detector reports no blocking findings on the UI file you changed; paste its last report.

## Return

Write `plan/evidence/E1-return.md` in the shape `AGENTS.md` gives, with the pass cost, then stop.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not change the grain, clipping or crunch passes, the loop, or the export.
If cracks or scales slip, return with bars alone PASS and the other two FAILED with what was tried; bars is the cut rank the plan keeps.
