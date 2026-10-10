# D6: the parallax loop

Effort: xhigh. Sandbox: rw. Review: claude. impeccable: no.

## Mission

Motion on: the scene breathes.
A camera on a small circle displaces the back layer by background depth over the plate-blended source and each object by its own depth, the frame zooms by the loop margin so no edge is ever uncovered, frames are indexed at 30 fps and wrap exactly, and the still export is untouched by any of it.
Motion off: the still.
This is the cut line of the plan; if the full shape does not land, a back-layer-only loop (no per-object meshes) that passes the same edge and wrap checks is the fallback, stated in the Return.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` section 4.2 (plate freshness, labels), section 4.3 (the loop, per-axis frame fractions, the push-pull fill, the wrap), section 5 (the contract: `renderFrame(frame)`, `plate`, `depth`, `masks`), section 6 row D6.
- `plan/evidence/look-rules.md` headings "Parallax loop and plate" and "Pass order and resolutions" (the Geometry pass, the G-buffer, registration: simplification cached in frame space, later passes on the output grid; two simplify caches when a plate exists).
- `src/core/motion.ts` (`frameCount`, `loopPhase`, `cameraOffset`, `parallaxDisplacement`, `parallaxReach`, `effectiveOrbit`, `PARALLAX_MARGIN`, `LOOP_ZOOM`) and `src/core/derive.ts` (`layers`, `anchorDisparity`, `parallaxClamp`, `cameraRadius`, `plateNeeded`): use these, never reimplement the arithmetic.
- `plan/evidence/D2a-return.md`, `plan/evidence/D2b-return.md`, `plan/evidence/D5-return.md`, then `src/render/renderer.ts`, `gl.ts`, `shaders/shared.ts`, `shaders/quantize.ts`: the chain you insert the Geometry pass into (after the simplify cache, before quantize).
- `plan/evidence/D3-return.md` and `src/session/scene.ts`: `setMotion`, `requestPlateIfNeeded`, how products reach `setScene`; `plan/evidence/D4-return.md` if merged: objects and masks.

Decisions already made:

- The Geometry pass: at effective orbit 0 it is skipped and the still chain reads the simplified texture, labels and depth directly, exactly as today. Above 0 it draws meshes into a G-buffer at master size: color (the warped simplified color), id (label), depth, and the texture-edge value; quantize and everything after read the G-buffer instead.
- Meshes: the back layer is a 192 x 144 grid over the frame; each object is a 64 x 64 grid over its bounds dilated by the parallax clamp. A vertex at frame point `p` with disparity `d` moves by `parallaxDisplacement(offset, d, anchor)` in per-axis frame fractions, with `LOOP_ZOOM` about the center applied after. Objects draw far to near in `layers(doc)` order; each object draw writes all attachments in one pass with an alpha test on its mask at 0.5 (the design's separate blended color draw is dropped; a finding). Label ids stay the object's index plus one.
- Depth: the model's inverse depth plane uploaded once with LINEAR filtering (the refined depth, bilinear); background depth is a copy of it with the hole filled by an eight-level push-pull (coverage-weighted downsample, fill-on-upsample) recomputed only when the hole mask changes, at the plane's own size. The back mesh reads background depth; an object mesh reads refined depth. No ring-plane fit (a finding).
- Back-layer source: master outside the hole, plate inside, blended by the hole mask feathered over 2 master px; it gets its own simplify cache (key: master identity, plate identity, hole mask identity, the same look fields as the master cache). With no plate (no objects, or Motion with `plateNeeded` false and nothing to fill) the master is the sole source and there is one cache, as today.
- Anchor: `anchorDisparity(doc)`; when null, the camera still orbits but every point has zero displacement (the frame only zooms), which is the design's "null disparity" case.
- Frames: `frameCount(doc.motion, 30)`; the session steps an integer frame index from elapsed wall time (`floor(elapsedMs / (1000 / 30)) mod frameCount`) under `requestAnimationFrame`, so a slow frame skips rather than slows, and calls `renderFrame(index)`; the grain hold index comes from D2b's `holdIndex` with that frame. `renderFrame(frameCount)` must equal `renderFrame(0)` byte for byte.
- The still: `renderStill` and `exportStill` always use frame 0 with identity camera and no deformation, whatever `motion.enabled` says (the evidence: "still rendering uses identity camera and zero deformation").
- Session and page: the Motion toggle and the `orbit` and `loopSeconds` sliders go through `applyEdit({ kind: 'motion', patch })`; turning Motion on calls `requestPlateIfNeeded()`; the loop starts when `plateNeeded(doc)` is false (a fresh plate exists, or none is needed), and while a plate is pending the still stays on screen with the status `preparing`; turning Motion off stops the loop and renders the still. This session code and the page wiring are the one driver-lane change this package is allowed; keep it to `src/session/loop.ts` plus the smallest edits in `scene.ts` and `app.tsx`.
- Timings: a loop frame at 2048 x 1536 with grain, clipping, crunch and symbols off must render under 33 ms warmed (30 fps), and under 50 ms with them on; record both; if the full shape misses 33 ms, say so and stop rather than loop on performance.
- No new runtime dependency; no `Math.random()`; the only clock is the session's frame stepper.

## Scope

- Create: `src/render/shaders/geometry.ts`, `src/render/shaders/pushpull.ts`, `src/render/shaders/backsource.ts`, `src/render/mesh.ts` (grid geometry, index buffers), `src/render/loop.ts` (pure: frame index from elapsed time, wrap), `src/session/loop.ts` (the rAF stepper), `test/loop.test.ts`, `test/mesh.test.ts`, `test/browser/scenarios/loop.scenario.ts`.
- Change: `src/render/renderer.ts` (the Geometry pass, the G-buffer, the second cache, `renderFrame`), `src/render/gl.ts` (vertex buffers and attributes), `src/render/debug.ts` (frame timings), `src/session/scene.ts` and `src/ui/app.tsx` (the toggle, two sliders, start and stop), `src/session/test-hooks.ts` (`frame(): number`, `renderFrameAt(frame): Promise<void>`, `exportFrame(frame): Promise<Blob>` for the scenario), `test/browser/page-globals.d.ts`, `test/browser/scenarios/index.ts`.
- Do not touch: `src/analysis/`, `src/core/`, `src/photo/`, `src/session/driver.ts`, `products.ts`, `policy.ts`, `src/export/`, `src/store/`, `src/dev/`, `tools/`, `headers.json`, `plan/demo.md`.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
2. Node tests: the frame stepper gives frame 0 at t 0, frame 1 at 34 ms, frame 29 at 999 ms with 30 frames, and wraps to 0 at 1000 ms; a skipped interval advances by more than one; the back grid has `193 * 145` vertices and `192 * 144 * 2` triangles with consistent winding; the push-pull fill on a synthetic plane with a disc hole leaves no unfilled texel and every filled value lies between the ring's minimum and maximum.
3. Browser scenario `render.loop` (target `dev`, timeout 300 s, real models for depth): import the disc fixture, wait for depth, keep no objects; set Motion on with orbit 0.6 and loopSeconds 3: `exportFrame(0)` differs from `exportFrame(frameCount / 4)` (the scene moves); `exportFrame(frameCount)` is byte-identical to `exportFrame(0)` (the wrap); the still export with Motion on is byte-identical to the still export with Motion off (the still is untouched); at frames 0, a quarter, a half and three quarters every pixel on the four frame edges is opaque and none equals the clear color (no uncovered border), checked on the landscape fixture and on a 3024 x 4032 portrait one; the warmed median frame time with grain, clipping, crunch and symbols off is recorded, and with them on.
4. Browser scenario `render.loop-objects` (target `dev`, timeout 300 s; LEAD if D4 is not merged into this tree yet): tap the disc so it is an object; Motion on; `analysis().plate` becomes true and `plateNeeded` false; at frame `frameCount / 4` a sample point just outside the disc's edge on the side the disc moved away from matches the plate's color there, not the disc's.
5. The toggle and the two sliders change the document through `applyEdit`; Motion on while a plate is pending shows `preparing` and the still; Motion off stops the loop (the frame index stops changing).
6. No console errors, no CSP violations, no WebGL app errors.

## Return

Write `plan/evidence/D6-return.md` in the shape `AGENTS.md` gives, with the shape that landed (full, or the back-layer-only fallback), the feather and fill choices as findings, the scenario ids, and the timings the lead supplied.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not start the UI restyle or demo-day work.
