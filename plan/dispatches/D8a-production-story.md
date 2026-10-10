# D8a: the sample photo, the asset route, and the story against the production build

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

The page can load a bundled sample photo with one click, so the demo never depends on a file dialog; the build has a route for static assets (the sample now, fonts and a stylesheet in D7); and the judge's story runs against the production build, driven only through the real interface, because production has no test hooks.

## Context

Read these and nothing else outside the files in Scope:

- `plan/demo.md` section 1 (the story), section 4.5 (the asset route decision), section 6 row D8, section 10 (demo day).
- `plan/evidence/foundations.md` section 3 (what the build copies today, how entries are discovered, dev versus production) and section 4 (production serves no `/dev` or `/api`; the CSP: `img-src 'self' blob: data:`, `connect-src 'self'`), section 7 (the driver: `--target production` scenarios run against `tools/serve.mjs --mode production`; the page API offers real clicks, typing and file input).
- `tools/build.mjs` (the copy step for the manifest and icon), `test/bundle-guard.test.ts` (what production output may not contain), an existing `production` scenario under `test/browser/scenarios/` for the shape.
- `src/ui/app.tsx`, `src/session/scene.ts` from this tree (D1 to D4 merged), `plan/evidence/D4-return.md` for the tap and swatch row.

Decisions already made:

- Asset route: the build copies every file under `src/assets/` to `<outdir>/assets-static/<same path>` in both modes, with no hashing (the files are referenced by stable paths from the page) and served by the existing static route with the long-lived immutable cache header only if the header contract already covers that path, else the default. Add a bundle-guard test that the sample exists in the production output.
- The sample photo: copy `plan/reference/simplify-cost/master.jpg` to `src/assets/sample.jpg` as the placeholder (a 2048 px synthetic bench scene; Nathan replaces it with a real photo before the demo and the Return says so). A `Try a sample` button fetches `/assets-static/sample.jpg` same-origin, wraps it as a `File` named `sample.jpg`, and runs the same import path as a drop.
- Production story scenario `story.production` (target `production`, timeout 300 s, real models): open `/`; click `Try a sample`; wait for the visible status to reach `Ready to tap` (production shows the status line without the dev timing suffix); move a slider through a real input event and see the stage's pixels change (read them through a screenshot diff or `toDataURL` is not available on the WebGL canvas without preserveDrawingBuffer, so compare two screenshots of the stage region); click the stage at the sample's subject (choose the point once by inspecting the sample and record it in the scenario); wait for the swatch row to appear; click a swatch; click `Download` and assert no console error and that a download was requested (use whatever the driver's page API exposes for downloads; if it exposes nothing, assert the anchor click fired through a `beforeunload`-free path and say so); click `Reset`; see the swatch row disappear. Every check through the real interface, no `__noisyTest`.
- Production error path: `story.production-errors` (target `production`): the HEIC header stub through the real file input shows the HEIC sentence; a 400 x 300 JPEG shows the long-edge sentence.
- Also run the dev scenarios unchanged; nothing in them may depend on the sample.
- No new runtime dependency.

## Scope

- Create: `src/assets/sample.jpg`, `test/browser/scenarios/story.scenario.ts`.
- Change: `tools/build.mjs` (the assets copy), `test/bundle-guard.test.ts` (the sample's presence), `src/ui/app.tsx` (the button), `src/session/scene.ts` (import from a URL through the existing import), `test/browser/scenarios/index.ts`, `headers.json` only if the asset path needs a content type it lacks.
- Do not touch: `src/analysis/`, `src/core/`, `src/render/`, `src/photo/`, `src/store/`, `src/dev/`, `plan/demo.md`.

## Acceptance

1. `npm run typecheck`, `npm run build`, `npm run build:production`, and the node tests pass (the command in `AGENTS.md`), including the bundle guard.
2. `curl -I` against `tools/serve.mjs --mode production --port 8792` shows `/assets-static/sample.jpg` served with an image content type and `/` with the isolation headers (you may run that server on 8792 and must stop it).
3. LEAD: `story.production` and `story.production-errors` against `node tools/serve.mjs --mode production` on the lead's machine; and the eleven dev scenarios still pass.
4. The dev build also serves the sample and the button works there (the lead checks in `demo.import`'s neighborhood by eye once).

## Return

Write `plan/evidence/D8a-return.md` in the shape `AGENTS.md` gives, with the subject point you chose for the sample, how downloads were asserted, the scenario ids and the production server command for the lead.

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not restyle the page, add fonts, or touch the renderer.
