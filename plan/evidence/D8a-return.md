# D8a return

## What changed

- `src/assets/sample.jpg`: byte-for-byte copy of the 2048 x 1536 synthetic placeholder from `plan/reference/simplify-cost/master.jpg`.
- `tools/build.mjs`: recursively copies optional `src/assets/` to stable `assets-static/` paths in both modes, including the build inventory.
- `headers.json`: adds `.jpg` as `image/jpeg`; the asset route retains the existing default `no-cache` policy.
- `src/session/scene.ts`: URL and file imports share one import pipeline; same-origin fetch, HTTP errors, cancellation and generation checks protect replacement imports.
- `src/ui/app.tsx`: adds `Try a sample`, importing `/assets-static/sample.jpg` as a File named `sample.jpg`.
- `test/bundle-guard.test.ts`: asserts production sample bytes and tests nested asset copying and inventory in both modes.
- `test/browser/scenarios/story.scenario.ts`: adds the production story and real-file-input error scenarios.
- `test/browser/scenarios/index.ts`: registers the new scenario file.

Nathan must replace the synthetic placeholder with a real photo before the demo.
The inspected subject point is the red sphere's center: frame fractions `{ x: 0.38, y: 0.585 }`, approximately master pixel `(778, 899)`.
Revisit that point when replacing the photo.

## Acceptance

1. **PASS**: final typecheck, dev build, production build and all 794 required non-Chrome Node tests passed, with zero failures or skips.
   The six bundle-guard tests passed, including exact production sample bytes and nested asset copying in both modes.
2. **PASS**: `curl -I` against `node tools/serve.mjs --mode production --port 8792` returned 200, `Content-Type: image/jpeg` and `Cache-Control: no-cache` for `/assets-static/sample.jpg`.
   `/` returned 200 with COOP `same-origin`, COEP `require-corp` and CORP `same-origin`.
   A GET of the served sample matched the source SHA-256.
   The server was stopped.
3. **LEAD**: `story.production` and `story.production-errors` are registered with production targets; no browser was launched here.
   The eleven existing demo dev scenarios were left unchanged and still need the lead's browser run.
4. **LEAD**: dev HTTP delivery passed (200, `image/jpeg`, `no-cache`, matching source SHA-256), but clicking the sample button in the dev page remains the lead's visual check near `demo.import`.
   The dev server was also stopped.

The story waits for exactly `Ready to tap`, without a dev timing suffix.
It changes Grain via the real range input's bubbling `input` event and compares RGB pixels from two browser screenshots cropped to the same visible stage region.
It never reads the WebGL canvas through `toDataURL` or assumes `preserveDrawingBuffer`.
The stage tap dispatches a coordinate-bearing DOM MouseEvent through the stage's UI handler, because the driver's click method only accepts a selector.
Sample, swatch, Download and Reset buttons use the driver's click method.
Both refusal fixtures use the driver's real `setFiles` API.
Neither scenario uses a production test hook.

The driver's public page API has no download event method.
The scenario therefore observes `HTMLAnchorElement.prototype.click`, records the blob URL, PNG filename and one save-anchor call, and forwards the original native click, including for detached anchors.
It asserts zero `beforeunload` events and that the page remains at `/`, then restores the prototype and listener in `finally`.
This proves the download was requested; it does not assert a file arrived in the browser's downloads directory.
The runner's undeclared console-error, exception and CSP invariants apply to both scenarios; their actual results remain LEAD.

Lead production commands, in separate terminals:

```sh
node tools/serve.mjs --mode production
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target production story.production story.production-errors
```

Then stop the production server, start dev and run the eleven existing demo scenarios:

```sh
node tools/serve.mjs --mode dev
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev demo.import demo.download render.first-look render.outline render.camera-stage render.depth-edge driver.import driver.plate driver.failure objects.tap objects.two-subjects
```

For the dev visual check, open `/`, click `Try a sample`, confirm the scene appears and the status reaches `Ready to tap` (with the dev timing suffix allowed).

## Checks run

### `npm run typecheck` - PASS, exit 0

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

### `npm run build` - PASS, exit 0

```text
> node tools/build.mjs --mode dev
build: dev 43d113203341-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo-driver/build/dev (42 files)
```

### `npm run build:production` - PASS, exit 0

```text
> node tools/build.mjs --mode production
build: production 43d113203341-20261009 -> /Users/nathandavis/dev/sandbox/noisy-demo-driver/build/production (12 files)
```

### Required Node suite - PASS, exit 0

```sh
node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)
```

```text
✔ matMulModel loads in ONNX Runtime and multiplies (170.687917ms)
ℹ tests 794
ℹ suites 0
ℹ pass 794
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35398.950541
```

The import-graph checks are included in the passing suite.
The earlier full suite passed all 793 tests before adding the nested-copy regression.

### Focused bundle guard - PASS, exit 0

```sh
node --test --test-timeout=60000 test/bundle-guard.test.ts
```

```text
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1063.151
```

### HTTP checks - PASS

```sh
curl -I http://127.0.0.1:8792/assets-static/sample.jpg
curl -I http://127.0.0.1:8792/
```

Production sample response, relevant lines:

```text
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-cache
Content-Type: image/jpeg
Content-Length: 326084
```

Production root response, relevant lines:

```text
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Content-Type: text/html; charset=utf-8
```

Dev sample response also returned 200 with `image/jpeg`, `no-cache` and 326084 bytes.
Both served samples and `src/assets/sample.jpg` hashed to:

```text
cee5c9827b7cffe90dcbc81ebdba0ad601fc2f95811df013efa66f88ec5e367a
```

After stopping both servers, the stop check returned the expected connection failure:

```text
curl: (7) Failed to connect to 127.0.0.1 port 8792 after 0 ms: Couldn't connect to server
```

### Registration, diff and review

- Node import of the scenario registry confirmed `story.production`, production, 300000 ms, and `story.production-errors`, production, 60000 ms.
- `git diff --check` passed.
- Independent read-only Codex review covered import races, asset/header behavior, bundle tests and production scenarios, and reported no actionable findings.
- Temporary compiler probes deliberately produced missing-property/argument diagnostics to inspect the exported driver API without reading its source; all probes were removed before the final passing typecheck.
- Logs: `/tmp/noisy-D8a-typecheck.log`, `/tmp/noisy-D8a-build.log`, `/tmp/noisy-D8a-production-build.log`, `/tmp/noisy-D8a-tests.log`, `/tmp/noisy-D8a-guard.log`, `/tmp/noisy-D8a-production-sample-headers.log`, `/tmp/noisy-D8a-production-root-headers.log`, `/tmp/noisy-D8a-dev-sample-headers.log`.

## Noticed, not done

- Chrome scenarios, browser console/CSP results, actual screenshot differences, decoder response at the chosen sample point and the dev button's visual behavior remain LEAD.
- The placeholder still needs Nathan's replacement photo and a revised subject point if necessary.
- Context reading exceeded the permitted list: the existing `demo.scenario.ts` was read, and `objects.scenario.ts` and `levers.scenario.ts` were searched for interface examples before recognizing the restriction.
  No files outside writable Scope were edited.
- A reading-scope question about two driver API files was sent, but no answer was required after compiler-based API inspection supplied enough information; those files were not read.
- The required TypeScript skill was read and followed; its referenced discipline skill was not found in the searched local skill roots.
- Pre-existing untracked `plan/dispatches/D8a-production-story.md` was preserved.
- No dependency, branch, commit, Linear posting, documentation package or renderer change was made.

## Findings

- **VERIFIED**: the header contract lacked a JPEG content type, so the scoped `.jpg` entry was necessary for the sample's HTTP acceptance.
- **VERIFIED**: `/assets-static/` is outside the existing `/assets/*` immutable rule and uses the default `no-cache`, as the settled route decision permits.
- **VERIFIED**: the exported driver page API has no download event method; the implemented assertion is the permitted forwarded native save-anchor click fallback.
- **INFERRED**: the visually chosen red-sphere point should produce a useful subject mask; real-model decoder acceptance at that point remains LEAD.

## Time

- Start, from `date`: 2026-10-09 11:05:52 EDT.
- End, from `date`: 2026-10-09 11:18:06 EDT.
