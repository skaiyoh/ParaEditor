# M2 return

## What changed

- `src/render/renderer.ts`: resolved all three blocks, keeping the camera/depth chain and adding selection after crunch with safe target swapping.
- `src/session/test-hooks.ts`: resolved its import block with both object selection/recolor and depth injection types.
- `test/browser/page-globals.d.ts`: resolved its import block with both hook declarations' required types.

### Resolution of each block

1. Renderer shader imports: retained `select` together with grain/hash, clipping and all crunch shaders.
2. Renderer shader programs: retained the selection program together with every camera program and the dev-only hash program.
3. Renderer still chain: kept CPU band counts, the outline slope constant and depth uniforms, then grain -> clipping -> crunch -> optional selection -> present.
   Selection uses `other(output)` to avoid reading its destination for either camera-pass parity; `finalTarget` tracks the presented target, and context-loss/WebGL guards remain.
4. Session hook imports: retained `isObjectId` and merged `Oklch`/`Plane` imports.
   The automatic merge already retained all members in one surface, including `tap`, `select`, `setRecolor`, `reset`, `objects` and `injectDepth`.
5. Page global imports: merged `Oklch`/`Plane`, preserving both hook sets and the camera debug/fixture declarations.

### Decisions

The selection pass must consume the actual completed camera output and draw into the other existing target; always drawing into `quantized` would cause a texture/framebuffer feedback loop when an odd number of camera stages runs.
No retained framebuffer was added.
The existing export dance stays intact: `checkLive`, `renderStill(false)`, synchronous `toBlob` invocation, then `renderStill()` in `finally` before the encoding callback.
`test/browser/scenarios/index.ts` was already consistent and was left unchanged.

## Acceptance

1. **PASS**: marker scan of `src` and `test` found no conflict markers.
2. **PASS**: typecheck and dev build exited 0; the required non-Chrome suite passed all 793 tests, with no failures or skips.
3. **LEAD**: source integration and independent read-only review confirm both paths are wired.
   All five camera sliders remain document-backed; depth upload/edge uniforms, context-loss guards, CPU band counts, selection after the camera chain and both complete hook sets remain reachable in source.
   Shader execution, slider effects, screen overlay and PNG behavior require the lead's browser run and are not claimed as observed here.
4. **LEAD**: all eleven requested scenarios were imported from the actual registry and verified present exactly once with target `dev`.
   No browser, screenshot or real-model scenario was run in this sandbox.

The lead must run these exact scenario IDs:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev demo.import demo.download render.first-look render.outline render.camera-stage render.depth-edge driver.import driver.plate driver.failure objects.tap objects.two-subjects
```

## Checks run

### Conflict marker scan - PASS

`rg -n '<<<<<<<|>>>>>>>|^=======$' src test` returned no matches, exit 1.
The surrounding check treated that result as success:

```text
PASS: no conflict markers in src or test
```

### `npm run typecheck` - PASS, exit 0

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

### `npm run build` - PASS, exit 0

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev de8b361c24af-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo-driver/build/dev (41 files)
```

### `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - PASS, exit 0

```text
✔ matMulModel loads in ONNX Runtime and multiplies (162.640417ms)
ℹ tests 793
ℹ suites 0
ℹ pass 793
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35313.984334
```

Logs: `/tmp/noisy-M2-typecheck.log`, `/tmp/noisy-M2-build.log`, `/tmp/noisy-M2-tests.log`.
The required build regenerated dev output; no generated files were hand-edited.

### Registry and independent Codex review

A Node import of `SCENARIO_FILES` asserted exactly one dev registration for each ID in the command above:

```text
objects.tap dev
objects.two-subjects dev
Registered: 11 required scenarios
```

Independent read-only Codex review found no concrete merge defects in stage order, target swapping, selection/export, guards/uniforms or the combined hooks.
The reviewer independently confirmed the eleven registrations and absence of conflict markers.

## Noticed, not done

- Browser results and screenshots remain for the lead, including the corrected `render.outline` and revised `objects.tap` checks from the prior returns.
- The TypeScript best-practices skill was read and its inline rules applied; its referenced type-system/boundary principle skills were absent from the searched local skill roots.
- No server was started, no runtime dependency was added, and no Git command was issued directly to stage, commit or change history.

## Findings

- **VERIFIED by source and independent review**: camera stages can leave their output in either existing master-sized target; selection must use the opposite target as its destination.
  The merged chain does so for zero, odd and even enabled camera-stage counts.
- No new foundation or design defect was identified.

## Time

- Start, from `date`: Fri Oct 9 10:56:42 EDT 2026.
- End, from `date`: Fri Oct 9 10:59:04 EDT 2026.
