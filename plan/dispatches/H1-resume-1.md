Scope extension granted for exactly the integration you named, nothing else:

- tools/build.mjs: add `face: 'analysis/face-worker.ts'` to the WORKERS map so the build bundles and publishes the face worker beside sequence, decode and gif, in both modes.
- src/app-env.d.ts: add `readonly face: string` to the worker URL declaration.
- src/session/driver.ts: wire the face factory, `spawnFaceTracker: () => new Worker(NOISY_WORKER_URLS.face, { type: 'module', name: 'face' })`, so the service starts with it.
- test/browser/driver/chrome.ts: add `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream` to the Chrome argument list (leave tools/drive-chrome.mjs alone).
- The build fixtures and the tests that enumerate workers or bundles: extend them for the fourth worker so the bundle guard and the build tests stay green.

Then: `npm run typecheck`, `npm run build`, `npm run build:production`, the node tests that do not launch Chrome, and the production bundle guard must all pass; confirm the production worker map now lists `face`. Update plan/evidence/H1-return.md so item 3 reads PASS for the integration (the browser assertions stay LEAD), and stop. The lead runs window.track, driver.import, story.production and the full suite right after.
