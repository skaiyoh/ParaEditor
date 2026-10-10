# D1 return

## What changed

- `src/core/color.ts`: pure sRGB/linear RGB/Oklab/Oklch conversions using Ottosson's matrices.
- `src/photo/limits.ts`: prescribed even master sizing, three size refusals, and verbatim HEIC message.
- `src/photo/decode.ts`: HEIF brand detection, oriented image-element sizing, resize bitmap decoding, full-bitmap fallback, and opaque sRGB master pixels/bitmap.
- `src/photo/thumbnail.ts`: 256 px long-edge sRGB analysis thumbnail.
- `src/photo/stats.ts`: document-seeded, deterministic weighted k-means++ with up to 16 clusters and 20 Lloyd iterations, plus lightness percentiles.
- `src/demo/scene.ts`: import/session driver, source/master SHA-256 asset ids, document construction/dev validation, in-memory master, last-import-wins ownership, and cached master PNG.
- `src/demo/app.tsx`: Open/drop import, canvas-owning Stage, status, Download, and retained boot instrumentation.
- `src/demo/test-hooks.ts`: typed demo import, scene summary, and PNG download hooks.
- `src/export/png.ts`: master-size PNG encoding and browser download action.
- `src/main.tsx`: boots the existing root, mounts the demo, and passes its session into dev instrumentation.
- `src/app/test-surface.ts`: composes the demo member in the existing dev-only surface.
- `test/color.test.ts`: white/red reference checks, 125-color round trip, and inverse linear/polar conversions.
- `test/photo-limits.test.ts`: exact sizing, refusal sentences, boundary acceptance, and refusal priority.
- `test/photo-stats.test.ts`: synthetic weighted regions, repeatability, flat color, and cluster cap; schema-access assertions currently fail.
- `test/browser/scenarios/demo.scenario.ts`: `demo.import` and `demo.download` scenario implementations.
- `test/browser/scenarios/index.ts`: registers the new scenario file.
- `test/browser/page-globals.d.ts`: declares the demo hooks without casts or build-only imports.

No runtime dependencies, branches, commits, renderer, sliders, or D2a work were added.
The dev build regenerated its ignored output.

## Acceptance

1. **FAILED** overall on resume: `npm run typecheck` and `npm run build` both passed with exit 0.
   The required Node command exited 1: 753 passed, 3 failed out of 756 tests.
   These current results supersede the earlier run's evidence in Checks run below.
   No failing test outside the requested fixes was changed.

   `npm run typecheck`, last lines:

   ```text
   > noisy@0.0.0 typecheck
   > tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
   ```

   `npm run build`, last lines:

   ```text
   > noisy@0.0.0 build
   > node tools/build.mjs --mode dev
   
   build: dev 4e2ac417d08a-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)
   ```

   `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)`, summary:

   ```text
   ℹ tests 756
   ℹ suites 0
   ℹ pass 753
   ℹ fail 3
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ℹ duration_ms 36103.340333
   ```

   Remaining failures: `test/core.test.ts:57` rejects the added `color.ts` inventory entry; `test/import-graph.test.ts:30` rejects the three demo files as outside its module map; `test/harness-sequence.test.ts:159` failed its cooldown assertion with this exact output:

   ```text
   AssertionError [ERR_ASSERTION]: the setup came 98.28591600000004 ms after the termination, the wait being 100 ms
   ```
2. **PASS** on resume: all 9 D1 color, photo-limit, and photo-statistics tests passed in the required Node suite.
   The statistics tests now parse the whole exported analysis value, including null depth/plate and pending auto-subject, and assert the parsed colors and tone.
   White/red reference values, the 125-color round trip, exact size/refusal rules, three-region weights/colors, deterministic repeatability, flat-color statistics, and the 16-cluster cap all passed.
   Passing rows from that run:

   ```text
   ✔ sRGB white and red match the Oklab reference (4.854333ms)
   ✔ 125 colors round trip through Oklab (1.205042ms)
   ✔ linear RGB and polar Oklch conversions are inverses (0.124334ms)
   ✔ oriented sizes follow both even master rounding rules (1.461666ms)
   ✔ the three import refusals name their exact limits (0.112792ms)
   ✔ limits accept their boundaries and long-edge refusal takes priority (0.098125ms)
   ✔ three flat regions produce their weighted colors deterministically (6.494667ms)
   ✔ one color has one nonzero cluster and constant lightness percentiles (0.185459ms)
   ✔ a varied thumbnail caps clusters at 16 and normalizes weights (1.3625ms)
   ```
3. **LEAD**: `demo.import` checks isolation, initial status, both generated JPEG sizes, Ready and stage attributes within 3 seconds, cluster range, reported path, small-JPEG refusal, and the 32-byte HEIF-header refusal.
   It writes `import-4032x3024.json` and `import-3024x4032.json`, including the observed decode path and timing, and stage screenshots.
   Chrome was not launched, so the actual path and timing are unobserved.
4. **LEAD**: `demo.download` checks PNG MIME type, 2048 x 1536 decode size, and exact RGBA equality at 32 sampled stage/master points.
   It writes `png-samples.json`.
   No browser pixel-equality result is claimed.
   Resume: readback now reads each canvas's full ImageData once and samples the 32 points from those arrays; decode and thumbnail contexts use `willReadFrequently: true`; Chrome rerun remains LEAD.
5. **LEAD**: static wiring uses the same `open(file)` wrapper and `session.importFile(file)` for Open's file-input change and the stage/page drop handler.
   The lead must exercise both in Chrome.
6. **LEAD**: `scene.ts` calls `sceneDocumentSchema(SCENE_VERSION).parse(doc)` under `NOISY_DEV` before publishing Ready.
   Validation exceptions are caught by the import driver and become the status line, with the failed import's bitmap closed.
   Runtime document parsing after a browser import is unobserved; Ready in `demo.import` requires this assertion to have returned.
7. **LEAD**: the driver automatically checks console errors and CSP violations for both registered scenarios.
   Neither scenario has been run here.
8. **LEAD**, manual at C1: import an EXIF-rotated portrait iPhone JPEG and judge whether it is upright; read `__noisyTest.demo.scene().path`.
   The code first reads oriented natural dimensions from an object-URL image element, revoking the URL immediately afterward.
   It tries `createImageBitmap` with `imageOrientation: 'from-image'`, sRGB/default conversion, both exact resize dimensions, and high quality.
   Rejection of that call, or a returned bitmap with the wrong dimensions, selects the full-bitmap `from-image` decode and canvas `drawImage` downscale; the full bitmap is closed after drawing.
   Both paths produce retained opaque sRGB ImageData and a drawing bitmap.
   No claim is made about which path a real photo took.

### Scenarios for the lead

Run exactly these IDs against the dev build after resolving the failing checks:

```sh
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev demo.import demo.download
```

The lead runs the server and later stops it.
No server was started in this session.

### Public scene contract for D2a and D3

```ts
export type DemoScene = {
  readonly doc: SceneDocument;
  readonly master: ImageBitmap;
  readonly masterPixels: ImageData;
  readonly masterPng: Blob;
  readonly path: 'resize' | 'fallback';
};
export type DemoState = {
  readonly status: string;
  readonly scene: DemoScene | null;
};
export type DemoSession = ReturnType<typeof createDemoSession>;
export function createDemoSession(): {
  snapshot(): DemoState;
  subscribe(listener: (state: DemoState) => void): () => void;
  importFile(file: File): Promise<void>;
  downloadPng(): Promise<Blob>;
  reportError(error: unknown): void;
};
```

`doc` is the core document, built through `newDocument` with pending auto-subject and null depth/plate.
`master` is the retained drawing bitmap D2a consumes.
`masterPixels` is canonical opaque sRGB ImageData; D3 should create a fresh bitmap from it for each transferred worker input.
`masterPng` is the cached unrendered PNG whose bytes provide `doc.frame.master.asset`'s SHA-256.
The source asset id is the SHA-256 of the original file bytes.
The session closes the previous drawing bitmap after publishing a replacement, closes obsolete overlapping imports, and retains the previous scene on refusal.
The Stage component owns its canvas; D2a must replace that 2D canvas node with a fresh node before requesting WebGL2.

## Checks run

### `npm run typecheck` - FAILED, exit 1

The first application compile exposed an empty-array/nonempty-cluster-tuple mismatch; that was corrected by constructing the final tuple from a checked dominant cluster.
Test-project compilation subsequently exposed the private cluster-schema export.
Attempt 1 used the dispatch-named export and produced:

```text
test/photo-stats.test.ts(4,10): error TS2724: '"../src/core/schema.ts"' has no exported member named 'analysisColorsSchema'. Did you mean 'analysisSchema'?
```

Attempt 2 used the exported analysis schema's direct shape; its final output was:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json

test/photo-stats.test.ts(31,18): error TS2339: Property 'shape' does not exist on type 'ZodReadonly<ZodObject<{ colors: ZodReadonly<ZodTuple<[ZodReadonly<ZodObject<{ lab: ZodReadonly<ZodObject<{ L: ZodNumber; a: ZodNumber; b: ZodNumber; }, $strict>>; weight: ZodNumber; }, $strict>>], ZodReadonly<...>>>; tone: ZodReadonly<...>; depth: ZodNullable<...>; plate: ZodNullable<...>; autoSubject: ZodEnum<...>;...'.
test/photo-stats.test.ts(40,18): error TS2339: Property 'shape' does not exist on type 'ZodReadonly<ZodObject<{ colors: ZodReadonly<ZodTuple<[ZodReadonly<ZodObject<{ lab: ZodReadonly<ZodObject<{ L: ZodNumber; a: ZodNumber; b: ZodNumber; }, $strict>>; weight: ZodNumber; }, $strict>>], ZodReadonly<...>>>; tone: ZodReadonly<...>; depth: ZodNullable<...>; plate: ZodNullable<...>; autoSubject: ZodEnum<...>;...'.
test/photo-stats.test.ts(46,18): error TS2339: Property 'shape' does not exist on type 'ZodReadonly<ZodObject<{ colors: ZodReadonly<ZodTuple<[ZodReadonly<ZodObject<{ lab: ZodReadonly<ZodObject<{ L: ZodNumber; a: ZodNumber; b: ZodNumber; }, $strict>>; weight: ZodNumber; }, $strict>>], ZodReadonly<...>>>; tone: ZodReadonly<...>; depth: ZodNullable<...>; plate: ZodNullable<...>; autoSubject: ZodEnum<...>;...'.
```

### `npm run build` - PASS, exit 0

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev 4e2ac417d08a-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (41 files)
```

### `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - FAILED, exit 1

Summary:

```text
ℹ tests 756
ℹ suites 0
ℹ pass 751
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36066.948125
```

Five failures:

```text
test at test/core.test.ts:57:1
✖ every core module is imported by this test and loads under node
AssertionError [ERR_ASSERTION]: a new core module is added to CORE_MODULES and imported at the top of this file
+ actual - expected
+ 'color.ts'

test at test/import-graph.test.ts:30:1
✖ src/ follows the dependency direction
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
+ [
+   'demo/app.tsx:0 -: the file is outside the module map',
+   'demo/scene.ts:0 -: the file is outside the module map',
+   'demo/test-hooks.ts:0 -: the file is outside the module map'
+ ]
- []

test at test/photo-stats.test.ts:18:1
✖ three flat regions produce their weighted colors deterministically
TypeError: Cannot read properties of undefined (reading 'colors')
at TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/photo-stats.test.ts:31:24)

test at test/photo-stats.test.ts:35:1
✖ one color has one nonzero cluster and constant lightness percentiles
TypeError: Cannot read properties of undefined (reading 'colors')
at TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/photo-stats.test.ts:40:24)

test at test/photo-stats.test.ts:42:1
✖ a varied thumbnail caps clusters at 16 and normalizes weights
TypeError: Cannot read properties of undefined (reading 'colors')
at TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/photo-stats.test.ts:46:24)
```

Actual last lines:

```text
      at Test.run (node:internal/test_runner/test:1152:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3)

test at test/photo-stats.test.ts:42:1
✖ a varied thumbnail caps clusters at 16 and normalizes weights (0.758959ms)
  TypeError: Cannot read properties of undefined (reading 'colors')
      at TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/photo-stats.test.ts:46:24)
      at Test.runInAsyncScope (node:async_hooks:213:14)
      at Test.run (node:internal/test_runner/test:1095:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:777:18)
      at Test.postRun (node:internal/test_runner/test:1224:19)
      at Test.run (node:internal/test_runner/test:1152:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:777:7)
```

The compiler/build/test logs were captured in `/tmp/noisy-D1-typecheck.log`, `/tmp/noisy-D1-build.log`, and `/tmp/noisy-D1-tests.log`.
Browser, manual EXIF orientation, route/header curl checks, and publication were not run.
A read-only independent review inspected the scoped implementation and reported the inferred edge findings below without editing files.

## Noticed, not done

- The core inventory test must recognize the dispatch-required `src/core/color.ts`; its file is outside Scope.
- The import-graph module map must recognize the dispatch-required demo composition root; its owner is outside Scope.
- Existing shell scenarios still look for the isolation/build text; those test IDs/text were retained, but their browser runs are unobserved.
- An unrelated untracked `plan/dispatches/D3-driver.md` appeared during the session; it was not read, changed, or absorbed.
- No correction was made to the known statistics-test schema-access error after the stop rule triggered.

## Findings

- **VERIFIED**: the dispatch describes `analysisColorsSchema` and `assetIdSchema` by name, but they are private declarations in the foundation schema module.
  The cluster tests cannot import the former directly; the exported analysis schema is a readonly wrapper, so accessing its direct `.shape` also fails.
  A resumed dispatch can test the whole exported `analysisSchema` using a complete analysis fixture rather than relying on private schemas.
- **VERIFIED**: adding the specifically authorized new core module makes the existing core inventory test fail.
  Adding the specifically authorized demo composition root makes the existing import-graph test fail as outside the module map.
  Both required guard updates lie outside this dispatch's allowed files.
- **INFERRED**, independent review: `decode.ts` creates its OffscreenCanvas and calls `getContext` before the decoded-bitmap `try/finally`.
  A throw during either operation could leave that decoded bitmap unclosed.
- **INFERRED**, independent review: scene title/name truncation counts Unicode code points, whereas the schema's ordinary string maxima may count UTF-16 units.
  Emoji-heavy filenames could therefore fail dev document validation despite truncation.
- **VERIFIED** by static inspection only: the demo proactively refuses detected HEIF brands before loading an image URL, consistent with its Chrome target and required HEIC refusal.
  It does not attempt Safari's native HEIF decode, which is outside the demo target.

## Time

- Start, from `date`: Fri Oct 9 09:17:58 EDT 2026.
- End: Fri Oct 09 09:28:39 EDT 2026.
- A final `date` was read immediately before generating this Return.

## Lead's changes after the return (2026-10-09 09:40 EDT)

- `src/demo/` did not exist in the design's module map and the source's `test/import-graph.test.ts` rejected it; the files moved to the design's layers: `src/session/scene.ts`, `src/session/test-hooks.ts`, `src/ui/app.tsx`. The page may import only ui, session and core, so the PNG save moved behind `session.savePng()`.
- `test/core.test.ts`: `color.ts` registered in `CORE_MODULES` with an import and a one-line test, as that guard requires.
- Observed in headless Chrome 155 on this Mac: `demo.import` PASS (4032 x 3024 to 2048 x 1536 in 201 ms, path `resize`, 16 clusters; portrait likewise), `demo.download` PASS after the readback fix. Floor after the moves: typecheck clean, 757 node tests pass, build clean.
- Acceptance 1 and 2 are therefore PASS as of this state; item 8 stays LEAD for C1.
