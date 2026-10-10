# S1 return

## What changed

- `src/export/mpo.ts`: pure, deterministic two-image MP Index writer; preserves both JPEGs, inserts APP2 after APP1 when present, and computes offsets from the MP endian field.
- `src/export/stereo.ts`: snapshots left/right cameras at half the horizontal reach, fits each view on black with its aspect preserved, and encodes quality-0.92 JPEGs and an MPO.
- `src/session/scene.ts`: adds `exportStereo(size?)` and `saveStereo()`, defaulting to 640 x 480 and downloading `HNI_0001.MPO` plus its left-view `HNI_0001.JPG` twin.
- `src/ui/app.tsx`: adds the header `Send to 3DS` button, disabled without a scene or during import, with failures routed to the existing status path.
- `test/mpo.test.ts`: four container tests independently read tags, attributes, sizes and offsets, verify preservation/determinism, exercise APP0/APP1 and sliced byte buffers, and reject truncated/existing-MPF inputs.
- `test/browser/scenarios/stereo.scenario.ts`: adds `export.stereo`, driving the real sample and Send button, decoding both downloaded views, measuring a controlled foreground centroid shift, checking portrait letterboxing, and saving hardware-test files in the scenario output directory.
- `test/browser/scenarios/index.ts`: registers `export.stereo`.
- `test/browser/page-globals.d.ts`: declares the scenario's temporary download capture, restored after each export.

## Acceptance

1. **PASS** - `npm run typecheck` and `npm run build` exited 0.
   The required non-Chrome node command passed all 810 tests with 0 failures, including the import graph and four new MPO tests.
2. **LEAD** - Run the exact scenario id `export.stereo`.
   It clicks the sample button, waits for depth, clicks `send-3ds` with real mouse input, captures the two download intents, parses MPF fields, decodes both JPEGs at 640 x 480, checks differing pixels and a controlled foreground centroid's horizontal displacement, and checks the download names and byte-exact JPG twin.
   It also checks black side letterboxing and centered 3:4 content for a portrait master.
   The scenario exercises `saveStereo()` and its call to `exportStereo()` through the page; it needs no additional app test-surface methods.
   Download capture temporarily intercepts anchor clicks to retain blobs, so browser file-save permission behavior remains a manual check.
   Chrome could not be launched here, and no screenshot was captured or inspected.
   Lead command: `node tools/drive-chrome.mjs --target dev export.stereo`.
   The scenario writes `HNI_0001.MPO` and `HNI_0001.JPG` into its run output directory for the hardware check.
3. **LEAD** - Nathan must copy the matching files into the console-created DCIM subfolder and confirm that the 3DS camera app shows the pair in glasses-free 3D.
   Hardware compatibility was not tested.
4. **LEAD** - Run the complete existing browser suite: `npm run test:browser`.
   No existing scenario was edited; every existing scenario remains registered.
   Browser regressions were not exercised here.

## Checks run

`npm run typecheck` - final exit 0; last lines:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build` - final exit 0; last lines:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev

build: dev e208b48c7a3f-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-render/build/dev (42 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - final exit 0; last lines:

```text
ℹ tests 810
ℹ suites 0
ℹ pass 810
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36383.298
```

`node --test --test-timeout=60000 test/mpo.test.ts` - exit 0, four tests passed.
`git diff --check` - exit 0, no output.
Independent Codex review found no remaining production or scenario defects after the corrections below.
No server was started, and no Chrome or hardware check was run.

Earlier typecheck failures were corrected before the final checks:

```text
src/export/stereo.ts(38,25): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'.
```

The pure encoder now declares the ArrayBuffer-backed return type it actually allocates.

A temporary `DemoSession` import in the test declarations pulled build-only globals into the test compilation.
Representative exact errors:

```text
src/analysis/bundled-lock.ts(13,20): error TS2304: Cannot find name 'NOISY_MODEL_LOCK'.
src/platform/build-id.ts(8,18): error TS2304: Cannot find name 'NOISY_BUILD_ID'.
src/render/renderer.ts(58,13): error TS2304: Cannot find name 'NOISY_DEV'.
```

That import and the proposed session test bindings were removed.
The final scenario uses actual button downloads within the authorized scope.
Review also caught a landscape-to-portrait test that checked side bars instead of top/bottom bars.
The final test imports a portrait master and checks side bars in the standard 3DS target.

## Noticed, not done

- D7 has not landed in this checkout; the plain header button follows S1's fallback placement.
- `exportStereo(size?)` supports custom sizes, but the browser scenario tests the actual page's fixed 640 x 480 export.
- No runtime dependency, network streaming, branch, commit, documentation package, or change outside dispatch scope was added.
- Browser and hardware checks remain with the lead and Nathan.

## Findings

- **VERIFIED** - `parallaxClamp(doc)` returns a scalar number, not a Vec2 with `.x`.
  Its documentation defines that number as the largest camera offset in frame fractions.
  S1 uses `s = 0.5 * parallaxClamp(doc)` for the horizontal cameras without changing core.
- **VERIFIED** - The existing dev surface exposes only `session.renderer()`, not the export methods.
  The new scenario avoids extending that out-of-scope surface by exercising both methods through the real button.
- **VERIFIED** - MP data offsets start at the endian field after `MPF\0`, and the disparity type is `0x020002`, per CIPA DC-007 §§5.2.3.3 and Table 4.
  The implemented minimal index follows the dispatch's settled container design.
  The full disparity profile additionally specifies MP Attribute tags, including viewpoint and base-viewpoint numbers, in §§5.2.4.5 and 6.2.2.2; those are absent from the settled minimal design.
  Full profile conformance is therefore not claimed, and device acceptance remains LEAD.
  Source: [CIPA DC-007-Translation-2009, mirrored original PDF](https://seos.fr/blog/doc/DC-007_E.pdf).

## Time

- Start: `Fri Oct  9 22:46:22 EDT 2026` (from `date`).
- End: `Fri Oct  9 22:55:34 EDT 2026` (from `date`).

