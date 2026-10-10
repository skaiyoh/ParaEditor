# D1 resume: two small fixes from the lead's run

The lead ran both scenarios in headless Chrome: `demo.import` PASS (both sizes, path `resize`, 201 ms for the 4032 x 3024 fixture), `demo.download` FAIL only on the driver's console check, which rejects this Chrome warning:
`Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true.`

Make exactly these changes:

1. `test/photo-stats.test.ts`: do not reach into `analysisSchema`'s shape. Validate the whole value with `analysisSchema.parse({ colors, tone, depth: null, plate: null, autoSubject: 'pending' })` (`analysisSchema` is exported from `src/core/schema.ts`) and assert the parsed `colors` and `tone` as before.
2. The readback warning: in `test/browser/scenarios/demo.scenario.ts` read each canvas's full `ImageData` once and sample the 32 points from those two arrays instead of 64 one-pixel `getImageData` calls; and in `src/photo/decode.ts` and `src/photo/thumbnail.ts` create the 2D context with `{ willReadFrequently: true }`, since both read back once per import.

Then run `npm run typecheck`, `npm run build`, and the node-test command from `AGENTS.md`; update Acceptance items 1 and 2 of `plan/evidence/D1-return.md` to what you now observe (PASS only if green, with the summary lines) and add one line under item 4 saying the readback was changed; then stop.
Do nothing else.
