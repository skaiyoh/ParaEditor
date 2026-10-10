# D6 review: the parallax loop

> Owns: the independent code review of `git diff edeb9ee f2a1063` against `plan/dispatches/D6-loop.md`.
> Does not own: the decisions it raises (the lead's), the design (`plan/reference/design.md`), or the findings ledger (`plan/findings.tsv`).

Reviewer: code-reviewer, 2026-10-09.
Experiments ran in an APFS copy of the tree pinned at `f2a1063`, headless Chrome 155 through `tools/drive-chrome.mjs` with the real models, using temporary dev-only readbacks and throwaway scenarios.
The copy was restored to `f2a1063` with a clean status afterwards; nothing in the reviewed repository was changed.

## Code findings, most severe first

### 1. CONFIRMED - the back-layer source is simplified with the objects' labels and subject clarity

- Where: `src/render/renderer.ts:443` calls `simplify(backSource, plateSimplified, ...)`, and `simplify` (`:410-421`) always passes the object label texture (`label: tex(label)`) and the subject `clarity` table to `down`, `akf` and `up`.
- What is wrong: inside the old silhouette, the plate's pixels are filtered as object k, a subject: label-aware averaging stops at the old outline, the akf radius shrinks by `1 - subjectClarity`, and `up` restores 60% of the source detail (`d = max(dBg, clarity[k])`).
  Geometry then writes label 0 for those same pixels (`geometry.ts:32`, back mesh `objectId 0`).
  The color and the id in the G-buffer therefore describe different surfaces, against the registration rule in look-rules "Pass order and resolutions": color, id, depth and texture edge "describe the same displaced surface point".
- Failing scenario, measured: a textured background with a disc fixture, tap the disc, Motion on, default style (simplify 0.52, subjectClarity 0.6).
  I compared `plateSimplified` with the same back source simplified against an all-plate label on row 768.
  The mean per-pixel difference was 10.9 levels inside the old silhouette (229 px) and 0.0 outside the hole.
  The plate inside the silhouette stays 6.8 levels from raw, against 16.2 when simplified as background.
  Over a 640 x 640 patch, the texture-edge test (`|D|/|grad D| < 1`, slope above 0.04) fires on 1,332 px inside the old silhouette, against 258 for the same plate simplified as background.
  So the vacated region that the loop exposes is sharper and carries about five times the outline ink of the background around it: a visible patch the shape of the subject, in the region the demo's motion is designed to show.
- Why the scenario passed: `render.loop-objects` sets `simplify: 0` (where `up` returns the source unchanged) and uses a flat gray plate, so it cannot see this.
- Smallest fix: give `simplify` a label parameter and pass a 1 x 1 zero label for the back source (`clarity[0]` is 0).
  Outside the hole the label is already 0, because every object's mask at or above 128 lies inside the dilated hole, so only the hole region changes.

### 2. CONFIRMED (behavior); design intent unverified - the displaced back mesh has no depth test, so folded cells resolve by index order, not by depth

- Where: `src/render/shaders/geometry.ts:15` writes `z = 0`; `src/render/gl.ts:13` creates the context with `depth: false`; the G-buffer (`renderer.ts:388-390`) has no depth attachment; the back mesh is one indexed grid drawn row-major (`mesh.ts:17-20`).
- What is wrong: wherever adjacent vertices differ in displacement by more than a cell (1/192 of the width), the cell flips and overlaps its neighbor.
  Without a depth test, the later-indexed cell wins, so the result depends on direction.
  A near region keeps its leading edge when it moves left or up, toward earlier rows and columns.
  When it moves right or down, the farther background drawn later paints over that edge.
- Failing scenario, measured: a red rectangle on gray, with an injected depth of 1 inside the rectangle and 0 outside (`injectDepth`), focus 0, orbit 1, and no objects.
  The expected edge positions come from core's displacement and `LOOP_ZOOM`.
  At frame 0 (moving right), the rectangle's right edge ended 39 px short.
  At frame 45 (moving left), its left edge was 9 px short.
  At frame 22 (moving down), the bottom edge was 29 px short.
  At frame 67 (moving up), the top edge was 7 px short.
  Real depth is smoother, but at the default orbit 0.6 with an anchor near 0.5, a disparity step of 0.5 still moves about 25 px against a 10.7 px cell.
  So untapped foreground edges (people, furniture) in the back layer shrink on one side for half of each loop.
  Tapped objects are unaffected, because they draw later in `layers` order.
- Smallest fix: attach a `DEPTH_COMPONENT16` renderbuffer to the G-buffer framebuffer, set `gl_Position.z = 1. - 2. * d` in `geometryVertex`, and enable `DEPTH_TEST` (LEQUAL) in `geometryInputs`.
  Clear depth before the back mesh and before each object mesh, so objects still paint in layer order but self-occlude correctly; then disable the test.
  Whether the design expects a z-test is for the lead, since I was not permitted to read `design.md`.

### 3. CONFIRMED by code and arithmetic - taps during the loop hit the wrong frame point

- Where: `src/ui/app.tsx:16` maps the click to a fraction of the canvas box; `src/session/scene.ts:179-193` passes that point unchanged to `labelAt` and the decoder.
- What is wrong: while the loop runs with effective orbit above 0, the canvas shows the frame zoomed by `LOOP_ZOOM` about the center and displaced.
  So screen point p shows frame point `(p - 0.5) / LOOP_ZOOM + 0.5 - disp`.
  The miss is `(p - 0.5) * 0.04 + disp` per axis.
  At p = 0.9 with the default orbit 0.6, that is up to 0.028 of the axis: about 57 px on a 2048 master.
- Failing scenario: a judge taps a small object, or the edge of one, near the frame's border while the loop plays.
  The decode lands beside it (`Nothing there`, or a neighbor), or `labelAt` selects the wrong object.
  This is a state the dispatch made reachable (taps during the loop) that nothing migrated.
- Smallest fix: in `session.tap`, when `loop.running()` and `effectiveOrbit(doc.motion) > 0`, map `at` to `0.5 + (at - 0.5) / LOOP_ZOOM` per axis.
  The residual error is the parallax, at most `0.02 * orbit`.
  Alternatively, stop the loop on pointer-down and show the still.

### 4. CONFIRMED by code (low) - `setMotion` now publishes `Ready`, which re-enables the loop during an import and hides errors

- Where: `src/session/scene.ts:294` routes through `edit`, which publishes `status: 'Ready'` (`:167`); `draw` gates the loop on the string `next.status !== 'Importing…'` (`:106`).
- Failing scenario: toggling Motion during the second or so of an import restarts the loop on the retained first look (the old master, with objects and depth stripped).
  The stage then zooms the previous photo until the new scene lands.
  A slider move after an inpaint failure also replaces the failure sentence with `Ready`.
  The import-failure path (`publish({ status: error, scene: state.scene })`) likewise restarts a zoom-only loop on the stripped first look when Motion was on.
- Smallest fix: gate the loop on a session flag set by `importSource`, not on the status text, and have `edit` keep `state.status` for motion patches.

### 5. CONFIRMED by code (low) - every slider `input` while Motion is on requests a plate

- Where: `src/session/scene.ts:296`.
- What is wrong: the dispatch asks for `requestPlateIfNeeded()` when Motion turns on; this code calls it on every orbit or loop-seconds input while Motion is enabled.
  Each call adds a waiter in the driver and clears `sequenceFailure`, so dragging a slider after a failed inpaint silently retries it (the driver's comment calls that "an explicit new request").
- Smallest fix: call it only when `patch.enabled === true`.

### Informational

- The dispatch names three replacements as findings for the source: the dropped blended color draw, no ring-plane fit, and the feather and fill choices.
  They appear in `plan/evidence/D6-return.md`, but `plan/findings.tsv` gained only F9.
- The `render.loop` wrap check (`exportFrame(count)` against `exportFrame(0)`) passes by construction, because `wrapFrame` maps `count` to 0 before any arithmetic.
  The real closure guarantee lives in core's `cycleTurn`, which is fine, but the check proves nothing beyond `wrapFrame`.
- No loop scenario renders with the outline on, the demo's default look.
  I measured it: with an object, a fresh plate and the default style (outline 0.4, grain, clipping and crunch on, symbols off), the warmed median of five was 7.2 ms at 2048 x 1536.
  The stepper showed 62 distinct frames in 2 s.

## Claim findings

1. Low - `plan/findings.tsv` F9: "one loop frame through the geometry pass (back-layer 192 x 144 mesh, per-object 64 x 64 meshes, push-pull background depth, plate blend) and the still chain: warmed median 3.8 ms with camera effects off, 9.4 ms with grain, clipping and crunch on".
   Evidence: the cited `test-results/chrome-20261009T154525Z-149a/scenarios/render.loop/loop.json` records `"noObjects": true`.
   The timed frames had no object meshes, no hole, no push-pull fill and no plate blend.
   Push-pull is a CPU step in `setScene`, never per frame.
   The "on" run also had symbols on (outline skipped), which the line omits.
   Verified by reading the file: medians 3.775 and 9.375 ms, as stated.
   The conclusion survives, given my 7.2 ms measurement with an object, a plate and the default look.
2. Low - the line `AGENTS.md` added: "the driver rejects anything else at the end of an otherwise passing run".
   Evidence: `test/browser/driver/chrome.ts:561` throws at the `screenshot()` call itself (`/^[a-z0-9][a-z0-9-]*$/`), not at the end of the run.
   Verified by reading the driver.
3. Unverified - F9's pointer "design §7.3" was not checked, because this session may not open `design.md`.

Prose verified true: the D6 return's arithmetic claim that `1000 / (1000 / 30)` is `29.999999999999996` (floor 29), which the `elapsed * 30 / 1000` order avoids.
Checked in node: the two orders disagree at 596 millisecond values below 200,000, including 1000.
Also true: the geometry comment that the shader uses core's endpoints (`parallaxDisplacement` is linear in disparity, so `mix(lo, hi, d)` equals it), the feather (weights `(3-|x|)(3-|y|)`, sum 81), the push-pull description, and "the sole playback clock".

## Holds

- Arithmetic from core, not reimplemented: `cameraRadius`, `cameraOffset(…, loopPhase(index, frameCount(motion, 30)))`, and `parallaxDisplacement` at d = 0 and d = 1, interpolated in the vertex shader, which is exact because the function is linear.
  Displacement is in per-axis frame fractions; `LOOP_ZOOM` is applied about 0.5 after displacement, only when `effectiveOrbit > 0`; a null anchor gives zero displacement and zoom only.
- Frames: `wrapFrame` and `frameAtElapsed` give 0..count-1 with exact wrap; the grain hold uses `holdIndex(index, …)`; the still uses frame 0, identity camera and no Geometry pass, whatever `motion.enabled` says.
  `exportStill` and `exportFrame` restore the preview.
- Layers come from `layers(doc)`, and label ids are the `doc.objects` index plus one in the G-buffer, label texture, clarity and LUT.
  `quantize`, `outline`, `grain` and `select` read the G-buffer label and depth.
  `cells` reads the variant attachment.
- The plate is used only when its `forMasks` equals `sortedMasks(doc)`, and the loop moves only while `!plateNeeded(doc)`.
  The second cache invalidates on master, plate identity, hole key (ids, mask assets, mask identities), labels, simplify and the subject table.
- Push-pull: coverage-weighted, finite everywhere, fills only hole texels, ring range kept; the hole is dilated well past the depth-texel footprint.
- Resources: no GL object is created inside a frame; meshes and mask textures are keyed and released; the G-buffer is released with the buffers and cleared every frame.
  Formats: R16F depth with LINEAR filtering, R16F renderable via the required `EXT_color_buffer_float`, and `drawBuffers` set for three attachments.
  `texelFetch` consumers are unaffected by the new LINEAR filtering on `simplified`.
- Stepper: one rAF chain; `start` cancels before rescheduling; it stops on Motion off, `plateNeeded`, import, `attachCanvas`, unmount and errors.
  No clock in `src/render` outside the dev probe, and the lane imports are clean.
- Real flows, exercised in Chrome:
  - Motion on before depth loops (zoom only), then parallax starts when depth lands.
  - A tap while looping shows the still and `preparing`, and the loop resumes when the plate lands.
  - Reset turns Motion off and stops the loop.
  - A new import stops it, and the new photo starts with Motion off.
  - A lost context stops the frame index, and the status reads "The graphics context was lost; reload the page" with no console noise.
