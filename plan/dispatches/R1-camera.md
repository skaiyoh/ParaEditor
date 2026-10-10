# R1: a camera the page supplies

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

The renderer can draw the scene from a camera offset the page hands it, not only from the loop's own orbit, and can export that view as a PNG.
Nothing visible changes for the judge: the still, the loop and the PNG download are pixel-identical to today.
This is the one render change that the stereo pair (S1), the head-tracked window (H1) and the 3DS stream (S2) all consume, so it lands first and small.

## Context

- `src/render/renderer.ts`: `geometryInputs(frame)` computes `offset = cameraOffset(cameraRadius(doc), loopPhase(frame, frameCount(...)))` and feeds `parallaxDisplacement` for disparity 0 and 1 plus `LOOP_ZOOM` into the geometry pass; `render(frame, loop, showSelection)` chooses the loop path by `loop`; `exportStill()` and `exportFrame(frame)` render without the selection, read the canvas with `toBlob`, then restore the previous frame.
- `src/render/types.ts`: the contract (`plan/demo.md` section 5). You extend it; both lanes cite it.
- `src/core/motion.ts`: `Vec2`, `cameraOffset`, `parallaxDisplacement`, `LOOP_ZOOM`, `effectiveOrbit`; `src/core/derive.ts`: `anchorDisparity`, `cameraRadius`, `plateNeeded`. Camera offsets are per-axis frame fractions, never pixels; `PARALLAX_MARGIN` is 2% per axis.
- `plan/evidence/look-rules.md`, the loop heading, and `plan/demo.md` section 4.3: the camera and displacement rules. Read nothing else outside Scope.
- The scenarios reach the renderer through `window.__noisyTest.session.renderer()` (`src/session/scene.ts` exposes `renderer: (): Renderer | null`), and `render.loop` in `test/browser/scenarios/loop.scenario.ts` is the model for a scenario that reads pixels back.

Decisions already made:

- Two additions to `Renderer`, nothing else:
  - `renderView(camera: Vec2, frame?: number, showSelection?: boolean): void`. Draws one frame through the loop path with `camera` in place of the orbit offset, with `LOOP_ZOOM` applied about the center whenever a depth plane exists, regardless of `motion.enabled` and of `effectiveOrbit`. `frame` defaults to 0 and only feeds the grain hash and object motion; without depth the call draws the still. `camera` is clamped to the parallax reach the core already computes, never to pixels.
  - `exportView(camera: Vec2, frame?: number): Promise<Blob>`. The same view at master size, `image/png`, without the selection outline, byte-identical to `renderView`'s pixels, restoring the previous frame afterward exactly as `exportStill` does.
- The loop keeps its own camera: `renderFrame` and `renderStill` do not change, and the orbit math stays in `core/motion`; `geometryInputs` takes the offset as a parameter instead of computing it inside.
- Determinism: the same scene, camera and frame give identical pixels. No clock, no `Math.random()`.
- The dev-only debug surface may gain `readPatch` style helpers only if the scenario needs them; production builds expose nothing new.

## Scope

- Create: `test/browser/scenarios/view.scenario.ts` (scenario id `render.view`).
- Change: `src/render/types.ts`, `src/render/renderer.ts`, `test/browser/scenarios/index.ts`, `test/browser/page-globals.d.ts` if a type is needed.
- Do not touch: `src/session/`, `src/ui/`, `src/core/`, `src/analysis/`, `src/export/`, `src/photo/`, `plan/`, `tools/`, the other scenarios.

## Acceptance

1. `npm run typecheck`, `npm run build`, and the node tests that do not launch Chrome pass (the command in `AGENTS.md`).
2. LEAD: every existing scenario in `test/browser/scenarios/index.ts` still passes; in particular `render.loop`, `render.loop-objects` and `story.production` are unchanged in behavior.
3. LEAD, scenario `render.view`: on the sample with one injected object and depth present, `renderView({x: +r, y: 0})` and `renderView({x: -r, y: 0})` (with `r` the scene's `cameraRadius`) move the object's mask centroid, read from the geometry id attachment or the canvas, in opposite horizontal directions by more than two pixels, while the background centroid moves less than the object's; `renderView({x: 0, y: 0})` and `renderFrame(0)` with `motion.enabled` false give identical pixels at four sampled points; `exportView(camera)` decodes to the same size as `exportStill()` and matches `renderView(camera)`'s pixels at the same four points.
4. Scenario `render.view` also checks that after `exportView`, the canvas shows the frame that was showing before the call.
5. No new console errors in the scenario run.

## Return

Write `plan/evidence/R1-return.md` in the shape `AGENTS.md` gives, listing the exact scenario ids the lead must run, then stop.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not change the loop's camera, the still, or the export of the still.
