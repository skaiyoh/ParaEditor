# R1 return

## What changed

- `src/render/types.ts`: added `renderView(camera, frame?, showSelection?)`, `exportView(camera, frame?)`, and an optional dev-only geometry id patch reader.
- `src/render/renderer.ts`: geometry accepts a supplied offset, view cameras clamp per axis using core reach, depth views use the loop crop even with Motion off, and exports save and restore the camera, frame, loop mode, and selection flag.
- `test/browser/scenarios/view.scenario.ts`: added `render.view`; the resumed fix uploads null depth before clearing selection, returns explicit no-depth pixel evidence, and gives all three 2D contexts `willReadFrequently: true`.
- `test/browser/scenarios/index.ts`: registered `view.scenario.ts`.
- `test/browser/page-globals.d.ts`: declared the optional dev session renderer accessor needed by the scenario.

## Acceptance

1. PASS - `npm run typecheck`, `npm run build`, and the required non-Chrome Node test command passed.
   Node result: 806 passed, 0 failed, 0 skipped.
2. LEAD - the lead reports PASS on Chrome 155 headless for `demo.import`, `demo.download`, `objects.tap`, `render.first-look`, `render.loop`, and `render.loop-objects`.
   The rest of the existing suite, including `story.production`, has not been reported run.
   Existing scenarios were not changed.
3. LEAD - the prior lead run reported only two failures in `render.view`: its additional no-depth check and the console warning invariant.
   The camera centroids, Motion-off sampled pixels, PNG dimensions, export equality, clamping, and determinism checks were not reported failing.
   The resumed scenario fix supplies `noDepthStill`, the four still/view RGBA samples, byte lengths, and the full-image mismatched byte count both in `view.json` and in the check's evidence.
   Clearing selection now occurs after `injectDepth(null)`, ensuring the renderer receives the null override before the no-depth comparison.
   The lead added the dev `session.renderer()` accessor; its earlier blocker is resolved and that file was not changed here.
4. LEAD - the prior lead run did not report export restoration checks failing.
   `render.view` still checks full canvas equality immediately after export invocation and after PNG encoding for still, loop, selected view, and unselected view draws.
5. LEAD - the prior lead run failed I7 on the scenario's Canvas2D readback warning.
   All three scenario 2D contexts now use `getContext('2d', { willReadFrequently: true })`.
   The revised browser scenario and its console invariant still require the lead's rerun.

The immediate rerun scenario id is `render.view`.
No Chrome run was attempted during this resume.

The exact lead scenario ids are listed below.
Run the unfiltered browser suite to cover acceptance 2, including the new `render.view`.

```text
shell.isolated
shell.workers
shell.no-isolation
boot.env-event
boot.production
demo.import
demo.download
levers.vendor-fault
levers.sink-capture
levers.headers
levers.synth-master
threads.default
threads.no-isolation
story.production
story.production-errors
models.clean-fetch
models.http500
models.truncate-resume
models.corrupt
models.stall
models.offline
models.startup-cleanup
objects.tap
objects.two-subjects
sequence.depth
sequence.depth-pano
sequence.depth-encode
sequence.encode
sequence.inpaint
sequence.inpaint-box
sequence.inpaint-corners
sequence.inpaint-full
sequence.inpaint-corners-square
sequence.inpaint-full-square
sequence.no-isolation
sequence.unparseable
sequence.runtime-fails
sequence.wasm-fails
sequence.missing-file
sequence.hole-size
sequence.protocol-order
sequence.default-threads
service.depth-encode
service.closed-bitmap
service.runtime-fails
service.cancel-encode
service.abort-encode
decoder.sphere-box
decoder.abort
decoder.release-during
decoder.release-before
decoder.reopen
decoder.error-event
decoder.runtime-fails
decoder.missing-file
decoder.other-model
decoder.wrong-tensors
store.write
store.inject-one
store.inject-two
store.close-handle
store.browser-close
store.own-error
store.versionchange
store.newer-version
store.lock
store.lock-release
driver.lifecycle
driver.input
driver.crash-reopen
driver.import
driver.plate
driver.failure
harness.untouched-done
harness.crash-hold
harness.crash-alloc
harness.crash-wait
harness.reload-alloc-hold
harness.freeze-crash-each-phase
harness.freeze-brief
harness.freeze-long
harness.void-cap
harness.sink-down
harness.stale-and-unreadable
harness.levers
harness.throw
harness.refusals
harness.stop
harness.second-tab
harness.start-over-stored-run
harness.phone
harness.killpoint-ceiling
harness.killpoint-throw
harness.killpoint-crash-fill
harness.killpoint-crash-hold
harness.wake-lock
harness.survival-none
harness.survival-none-short
harness.survival-crash-encode
harness.survival-crash-setup
harness.survival-crash-run-depth
harness.survival-crash-after
harness.survival-crash-wait
harness.survival-input-recovers
harness.hole-digests
checklist.index
checklist.sitting-a
checklist.sitting-c
checklist.posts
checklist.no-isolation
checklist.csp-violations
checklist.left-mid-post
checklist.frozen-mid-post
checklist.sink-answers
checklist.clear-model-cache
checklist.phone
production.shell
production.headers
production.dev-routes
production.range
render.first-look
render.outline
render.camera-stage
render.depth-edge
render.symbols
render.loop
render.loop-objects
render.view
```

## Checks run

`npm run typecheck` - final exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

The first typecheck caught a fixture-local variable shadowing the DOM `document`.
Renaming it to `sceneDoc` fixed the error; subsequent typechecks passed.

`npm run build` - exit 0:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev 609ae1f26e3c-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-render/build/dev (42 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - Node completed successfully:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37249.529375
```

`git diff --check -- src/render/renderer.ts src/render/types.ts test/browser/page-globals.d.ts test/browser/scenarios/index.ts test/browser/scenarios/view.scenario.ts` - exit 0, no output.
The unfiltered diff check reported pre-existing trailing whitespace in `plan/log.tsv:31`; that file is outside Scope and was left untouched.
Typecheck, build, and all 806 Node tests above were rerun after the scenario fix and passed.
The original implementation received independent Codex review; this resume changes only scenario code and this Return.
Chrome was not run here because this dispatch assigns browser verification to the lead.
No server was started.

The lead's prior failures, quoted from the resume dispatch:

```text
without depth, view draws the still including frame-zero grain (R1): evidence undefined
I7 no console error, warning, or exception from the app
Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true.
```

The diagnostic `evidence undefined` came from the missing third argument to `context.ok`; the boolean was already computed and required by the result schema.
The no-depth setup kept the previous depth texture because the hook's empty style patch does not publish an unchanged document.
The resumed fix changes that setup and adds actual diagnostics; it does not alter renderer behavior.

## Noticed, not done

- The lead's changes to `src/app/test-surface.ts` and `plan/log.tsv`, and its dispatch/evidence files, were left untouched.
- No renderer, core, session, UI, export, or other scenario file was changed during this resume.
- No branch, commit, dependency, documentation, ADR, or changelog change was made.

## Findings

- VERIFIED - the initial missing `session.renderer()` accessor was resolved by the lead, according to the resume dispatch and the lead's successful scenario execution.
- VERIFIED - `injectDepth(null)` changes the hook's override, then calls `session.setStyle({})`.
  An unchanged style edit returns without publishing, while `select(null)` publishes a scene and calls `renderer.setScene`.
  The scenario must clear selection after changing the depth override so the renderer receives the null depth before drawing.
- VERIFIED - the scenario omitted `context.ok`'s optional evidence argument on its no-depth check.
  The scenario now returns explicit pixel diagnostics and passes them to that check.
- VERIFIED - the zero-camera depth view still uses `LOOP_ZOOM`, whereas Motion-off `renderFrame(0)` retains still framing.
  The required four sampled points are placed in flat background regions where those views can match exactly; this is sampled equality, not a claim of identical framing or complete images.

## Time

- Start: `Fri Oct  9 22:27:39 EDT 2026`.
- Initial end: `Fri Oct  9 22:34:05 EDT 2026`.
- Resume start: `Fri Oct  9 22:40:15 EDT 2026`.
- Resume end: `Fri Oct  9 22:42:36 EDT 2026`.
