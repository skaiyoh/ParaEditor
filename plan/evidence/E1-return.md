# E1 return

## What changed

- `src/core/schema.ts` - Strict Surface sub-object and document field with the three patterns.
- `src/core/types.ts` - Schema-inferred Surface type.
- `src/core/ranges.ts` - Relief, Refraction, Shine and Scale ranges of 0 to 1.
- `src/core/defaults.ts` - Disabled bars with all four amounts at 0.5 in every new document.
- `src/core/edits.ts` - Partial `surface` patch edit.
- `src/core/reduce.ts` - Validated, clamped, invertible Surface patches with unchanged and refusal behavior.
- `src/core/history.ts` - The authorized single `surface` case uses the existing parameter-patch coalescing and inverse behavior.
- `src/core/migrate.ts` - Version 0 to 1 migration with frozen Surface defaults.
- `src/render/shaders/surface.ts` - Seeded oscillating cylindrical bars, tilted Voronoi shards with master-pixel cracks, staggered convex scales, bounded refraction and camera-relative Blinn-Phong highlights in linear light.
- `src/render/renderer.ts` - One color pass after Outline or Cells and before Grain, using existing targets, actual draw camera, wrapped frame and seed, existing program error handling and dev timing probe.
- `src/session/scene.ts` - `setSurface` through the existing edit path.
- `src/ui/app.tsx` - Collapsed Surface node between Symbols and Palette with its heading switch, three pressed-state pattern buttons and four RangeControls, using existing CSS classes and tokens.
- `test/fixtures/documents.ts` - Complete current-version core document fixtures with Surface and a future-version invalid fixture.
- `test/fixtures/edits.ts` - Surface in the exhaustive core edit fixtures.
- `test/defaults.test.ts` - Surface default and fresh-value checks.
- `test/schema.test.ts` - Version 1 literal and updated invalid-version checks.
- `test/parse.test.ts` - Current-version parsing and explicit version-zero fixtures for synthetic migration tests.
- `test/reduce.test.ts` - Exhaustive edit-kind and numeric Surface setters.
- `test/surface.test.ts` - Pattern validation, range bounds, partial patches, clamping, inverses, refusal, input preservation and real migration checks.
- `test/browser/scenarios/surface.scenario.ts` - Registered sample-based pixel, control, frame, glint and timing checks, plus production controls without dev hooks.
- `test/browser/scenarios/index.ts` - Both new scenarios registered through the Surface scenario module.

## Acceptance

1. **PASS - full typecheck, both builds and all 816 node tests that do not launch Chrome.**
   The approved scope extension adds only `case 'surface':` beside the existing patch cases in `src/core/history.ts`.
   The Edit union and exhaustiveness check remain intact.
   The complete `npm run typecheck` exited 0 after compiling all three projects; its last nonempty output line was:

   ```text
   > tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
   ```

   Both builds and the complete required node suite were rerun after that change.
   The core-module and import-graph guards passed under node.

2. **LEAD - `render.surface`.**
   Chrome cannot start in this sandbox, so shader compilation, rendered appearance, displacement, highlight behavior and GPU cost have not been observed.
   The scenario records a Surface-off render before enabling, compares four recorded points and every canvas byte after disabling each pattern, and checks all-zero bypass for every pattern.
   It exercises the real Surface controls and checks their document values and `value-surface-<field>` outputs.
   It finds a strong vertical color transition on the actual sample and records its matched displacement with bars at Relief 1 and Refraction 1.
   It compares frames 0, 15, 0 again and the wrapping frame count with grain disabled to isolate bar oscillation.
   Crack samples lie at grid centers in different Voronoi cells, and compare Shine 1 against Shine 0 in linear light.
   The scale test retains the sample color and uses a constant depth plane with matching focus to isolate the highlight from parallax, comparing `renderView({x: -0.02, y: 0})` and `renderView({x: 0.02, y: 0})` on one cap.
   It records both peaks, weighted highlight positions and intensity at the same sampled point.
   **Pass cost: LEAD, unmeasured.**
   `surface.json` records `offSamples` and `offMedian`, then five warmed full redraws and five individually fenced dev-probe pass costs for each pattern in `timings`.
   Each pattern must have its redraw median below `offMedian + 2` milliseconds.
   No numeric GPU median is claimed without a browser run.

3. **LEAD - all existing scenarios, particularly `render.camera-stage`, `render.symbols` and `story.production`.**
   Run `render.surface-controls-production` as well to check the new heading switch, four sliders and their outputs, pattern states, visible effect and exact disabled bypass through the production editor.
   The existing production story file was not changed because it is outside Scope.
   Both new scenario ids pass the driver's registry loading and listing check.
   Exact focused command for the lead:

   ```sh
   node tools/drive-chrome.mjs render.surface render.surface-controls-production render.camera-stage render.symbols story.production
   ```

   Then run every existing scenario:

   ```sh
   node tools/drive-chrome.mjs
   ```

4. **PASS - impeccable detector has no blocking findings on the changed UI file.**
   Final command: `/Users/nathandavis/.agents/skills/impeccable/scripts/impeccable detect --json src/ui/app.tsx`.
   Exit status 0; last report:

   ```json
   []
   ```

   The edit hook also reported:

   > [impeccable@1] Design hook scanned src/ui/app.tsx. No deterministic design-quality issues found. That does not mean the design is good: keep following the project design system and the impeccable skill guidance.

## Checks run

`npm run typecheck` - PASS, exit 0, last lines:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

The initial E1 typecheck failed with TS2322 at the history exhaustiveness check.
The authorized one-case extension resolves that diagnostic; the complete rerun includes the test project and reports no diagnostics.

`npm run build` - PASS, exit 0, last lines:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev 3bcfa627b157-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-render/build/dev (43 files)
```

`npm run build:production` - PASS, exit 0, last lines:

```text
> noisy@0.0.0 build:production
> node tools/build.mjs --mode production

build: production 3bcfa627b157-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-render/build/production (13 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - PASS, exit 0, last lines:

```text
ℹ tests 816
ℹ suites 0
ℹ pass 816
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36266.583708
```

Guard evidence in that run:

```text
✔ every core module is imported by this test and loads under node (7.73725ms)
✔ src/ follows the dependency direction (265.678166ms)
```

Focused Surface history runtime check with `node --input-type=module` - PASS, exit 0, last line:

```text
PASS: surface:relief key; empty/multiple-field patches separate; one coalesced step; undo 0.5; redo 1; drag back removes step.
```

`git diff -- src/core/history.ts` confirms that file has exactly one added line, `case 'surface':`, with no other change.

Focused core checks during the initial dispatch - PASS, 81 tests, 81 pass, 0 fail.
An earlier focused run passed 80 of 81 and failed the old `version: 1` invalid-literal assertion, which now uses the future version.

`node tools/drive-chrome.mjs --list 'render.surface*'` - PASS, exit 0:

```text
render.surface                      dev         E1        Refracting formulas, camera glints, exact bypass, live Surface controls and warmed cost
render.surface-controls-production  production  E1        Surface controls and pixel bypass in the production editor
```

`git diff --check -- src test` - PASS after the resume, exit 0, no output.

The initial dispatch's full `git diff --check` passed.
The resume's full check exits 2 because an unrelated, pre-existing lead change is outside E1 Scope:

```text
plan/log.tsv:38: trailing whitespace.
```

That file was left untouched.

During the initial E1 dispatch, served the dev build with `npm run serve` and exercised its real HTTP routes:

```text
GET /: 200
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'
GET /assets-static/app.css: 200
GET /assets/main-CCB2GEYG.js: 200
Surface heading switch in served bundle: True
Surface fragment in served bundle: True
GET /assets-static/sample.jpg: 200 image/jpeg
```

Stopped that server before returning; a subsequent curl connection exited 7.
No browser scenario or GLSL compilation was run.

Requested Claude review - **not completed**.
Two read-only print-mode attempts supplied the dispatch and implementation, with all tools disabled and session persistence disabled.
The first returned no stdout or stderr and was interrupted.
The second used user settings with hooks disabled and a 120-second timeout; exit 124, exact output:

```text
CLAUDE REVIEW TIMEOUT after 120 s; no completed review.
```

Independent Claude review remains for the lead.

## Noticed, not done

- The lead's existing `plan/log.tsv` entry has trailing whitespace at line 38.
  It is outside Scope and was not changed.
- `EnableSwitch` accepts only Motion and Symbols, and `RangeControl` strips only their prefixes and `style-` from its output id.
  Those files are outside Scope.
  The Surface switch reuses their existing CSS markup in `app.tsx`, and outputs retain the existing derivation as `value-surface-relief`, `value-surface-refraction`, `value-surface-shine` and `value-surface-scale`.
- Impeccable context reported an unset `buildPath` in `.impeccable/config.json`.
  This task extends an existing Operate surface; config and visual-direction documentation were left unchanged as required by Scope.
- No runtime dependency, commit, branch, export change, loop change, or change to Grain, Clipping or Crunch was made.

## Findings

- **VERIFIED, RESOLVED - the original dispatch omitted the history consumer of Edit.**
  The approved extension adds the one case required by that consumer.
  A node runtime check now returns `surface:relief`, preserves separate steps for empty or multiple-field patches, coalesces consecutive Relief changes, undoes to the original 0.5, redoes to 1, and removes a drag that returns to its starting value.
  The existing history branch handles these edits without any other change to that file.
- **INFERRED - rendering and cost require the demo Mac's GPU.**
  The formulas use finite circular-arc end slopes to keep full-strength refraction within about 2% of the long edge, with seeded integer hashing and whole loop cycle rates.
  Their visual quality and the 2 ms budget remain unverified until the lead runs the registered scenarios.

## Time

- Start, from `date`: `2026-10-09 23:41:44 EDT`.
- Initial dispatch stop, from `date`: `2026-10-10 00:09:02 EDT`.
- Resume start, from `date`: `2026-10-10 00:10:25 EDT`.
- Resume end, from `date`: `2026-10-10 00:13:23 EDT`.
