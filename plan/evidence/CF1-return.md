# CF1 return

## What changed

- `plan/dispatches/CF1-hosting.md`: the approved hosting package, scope, and acceptance.
- `tools/cloudflare/worker.ts`: production route allowlist, same-origin streaming R2 models, HEAD, byte ranges, and safe errors using the existing response headers.
- `tools/cloudflare/prepare.mjs`: validates the production inventory, rejects unexpected files and symlinks, derives headers and models from their existing owners, and builds the Pages worker.
- `tools/cloudflare/wrangler.json`: Pages configuration and the model bucket binding.
- `tools/cloudflare/cli.mjs`: temporary pinned Wrangler 4.149.0, ignored local cache, credential environment handling, and token redaction.
- `tools/cloudflare/deploy.mjs`: local model integrity checks, Standard R2 uploads and inventory checks, verified deployment gates, fail-closed configuration, apex backup and DNS switching, and status checks.
- `tools/cloudflare/cache-rule.json`: applied hostname-specific Browser TTL policy, authorized when Nathan granted the requested token permission.
- `tools/cloudflare/verify.mjs`: real HTTPS asset and model integrity, response headers, download ranges, and route exclusion checks.
- `test/cloudflare-hosting.test.ts`: adapter behavior and storage failure checks.
- `test/browser/scenarios/hosted.scenario.ts`: hosted browser boundary and actual sample import scenario.
- `test/browser/scenarios/index.ts`: hosted scenario registration only.

External state:

- Pages project: `noisy-demo`, production branch `demo`.
- Preview: https://297320a9.noisy-demo.pages.dev/.
- Production deployment: https://a46dec27.noisy-demo.pages.dev/.
- Public editor: https://nathan.fish/.
- Private Standard R2 bucket: `noisy-demo-models`, exactly seven locked objects totaling 118,575,396 bytes.
- Both Pages environments have `fail_open: false` and the `MODELS` binding.
- The custom domain, verification, and validation all report `active`.
- Apex addresses were replaced by a proxied CNAME to `noisy-demo.pages.dev`; the three CAA records were preserved.
- The cache rule matches only `nathan.fish` and respects the editor's browser cache headers.
- No commits, branches, pushes, package manifest changes, lockfile changes, or persistent dependencies.

## Acceptance

1. **PASS** - `prepare.mjs` generated 14 intended public production files plus the worker and all-route configuration from the production build, `headers.json`, and `models.lock.json`.
Both preparation and deployment reject symlinks and unexpected inventory.
The upload contains the bundled sample and excludes source, credentials, dev assets, and other local photographs.

2. **PASS** - Four adapter tests passed, including full streamed GET, HEAD without object-body reads, bounded/open/suffix ranges, clamped ranges, malformed and multiple ranges, 416, If-Range, missing and changing objects, storage exceptions, and safe error headers.
The preview, production, and public apex URLs passed real HTTP checks for HEAD, all seven full model bodies, three range forms per model, 416, and rejected routes.
Direct `/index.html` returns 200 without a redirect.

3. **PASS** - Every local model passed exact byte-length and SHA-256 checks before upload.
R2 metadata confirms Standard storage and exact locked keys and lengths.
Every model's full length and SHA-256 matched through both deployed Pages origins and `https://nathan.fish/`.

4. **PASS** - The preview passed all direct HTTPS checks before any apex changes.
Production passed the same checks before custom-domain association and DNS switching.
After Nathan added `Zone / Cache Rules / Edit` on 2026-10-10, the approved hostname-specific Browser TTL rule was applied.
The rule matches only `(http.host eq "nathan.fish")` and sets `browser_ttl.mode` to `respect_origin`.
The public apex passed full HTTPS verification: all 14 production assets with matching SHA-256 and headers, direct index.html, seven complete model lengths and hashes, HEAD, three range forms per model, 416, rejected dev/source/credential/reserved routes, and unsupported methods.
The CSS now returns `Cache-Control: no-cache`.
The custom domain is active, and `.local/cloudflare/verified-root.json` records the successful verification.

5. **PASS** - Typecheck, dev build, production build, and all 830 non-Chrome Node tests passed.
The initial sandbox test run failed because local listeners were denied; the identical suite passed outside that restriction.

6. **LEAD** - `hosted.production` is registered and listed successfully alongside `story.production`.
Chrome was not launched, screenshots were not captured, and visual or sample-import browser success is not claimed.
The lead must run:

```sh
node tools/drive-chrome.mjs --base-url https://nathan.fish/ --target production hosted.production story.production
```

7. **PASS** - Independent read-only review found and resolved deployment symlink handling, exact If-Range date comparison, remote R2 inventory checking, the scenario's expected 404 message, and preservation of the original cache-rule backup.
The reviewer independently passed the four adapter tests and checked symlink rejection using an isolated fixture.
No reviewer edits or credential reads occurred.

## Checks run

`npm run typecheck`, exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build`, exit 0:

```text
build: dev c82d7fdc241a-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (45 files)
```

`npm run build:production`, exit 0:

```text
build: production c82d7fdc241a-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/production (14 files)
```

`node --test --test-timeout=60000 <all test/*.test.ts except drive-chrome.test.ts>`, exit 0:

```text
ℹ tests 830
ℹ suites 0
ℹ pass 830
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 40940.361625
```

Full output: `.local/cloudflare/node-tests.log`.
Initial restricted output: `.local/cloudflare/node-tests-sandbox.log`.
Its actual local-server failure was:

```text
serve: cannot listen on 127.0.0.1:0: listen EPERM: operation not permitted 127.0.0.1
```

`node tools/cloudflare/prepare.mjs`, exit 0:

```text
Prepared 14 public files and the routing worker for c82d7fdc241a-20261010.
```

`node tools/cloudflare/deploy.mjs preview`, exit 0 after correcting the working directory:

```text
preview: https://297320a9.noisy-demo.pages.dev
```

`node tools/cloudflare/verify.mjs https://297320a9.noisy-demo.pages.dev/`, exit 0:

```text
PASS dev, source, credential, unknown-model and reserved routes: 404; unsupported method: 405; error headers preserved.
PASS verification recorded in .local/cloudflare/verified-preview.json.
```

`node tools/cloudflare/deploy.mjs production`, exit 0:

```text
production: https://a46dec27.noisy-demo.pages.dev
```

`node tools/cloudflare/verify.mjs https://a46dec27.noisy-demo.pages.dev/`, exit 0:

```text
PASS dev, source, credential, unknown-model and reserved routes: 404; unsupported method: 405; error headers preserved.
PASS verification recorded in .local/cloudflare/verified-production.json.
```

`node tools/cloudflare/deploy.mjs connect`, exit 0:

```text
nathan.fish points to noisy-demo.pages.dev; other apex records preserved.
```

`node tools/cloudflare/deploy.mjs status`, exit 0: custom domain, verification and validation `active`; preview and production `fail_open: false`.

`curl --head https://nathan.fish/`, exit 0:

```text
HTTP/2 200
cache-control: no-cache
cross-origin-embedder-policy: require-corp
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```

Initial `node tools/cloudflare/verify.mjs https://nathan.fish/`, exit 1 before the cache rule:

```text
AssertionError [ERR_ASSERTION]: /assets-static/app.css: Cache-Control
+ actual - expected
+ 'max-age=14400'
- 'no-cache'
```

Initial `node tools/cloudflare/deploy.mjs cache-status`, exit 1 before Nathan added permission:

```text
GET /zones/[zone]/rulesets/phases/http_request_cache_settings/entrypoint:
HTTP 403: [{"code":10000,"message":"Authentication error"}]
```

`node tools/cloudflare/deploy.mjs cache-rule`, exit 0 after permission was granted:

```text
nathan.fish browser cache now respects origin headers; other hostnames and rules preserved.
```

Final `node tools/cloudflare/verify.mjs https://nathan.fish/`, exit 0:

```text
PASS https://nathan.fish: all 14 production assets, direct index.html, SHA-256 and header contract.
PASS /models/face-34cd7e60.onnx: 1270727 bytes, SHA-256 34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017, HEAD and three resumed ranges, 416.
PASS dev, source, credential, unknown-model and reserved routes: 404; unsupported method: 405; error headers preserved.
PASS verification recorded in .local/cloudflare/verified-root.json.
```

The same full-byte and SHA-256 verification passed for the other six locked models in that run.

`node --check tools/cloudflare/deploy.mjs` and `git diff --check`, exit 0.

## Noticed, not done

- The GitHub repository remains private and empty; source publication was not requested.
- The unrelated `PRODUCT.md` edit present earlier disappeared through external work during this dispatch; this package did not edit, commit, or absorb it.
- No gallery, naming, docs, changelog, Linear, or next-package work.
- Browser verification remains LEAD as stated above.

## Findings

- **VERIFIED** - Pages rejects `--config` with a custom path: `Pages does not support custom paths for the Wrangler configuration file`.
Running pinned Wrangler from `tools/cloudflare/`, where its configuration lives, succeeded.
- **VERIFIED** - The new preview initially failed TLS negotiation, then became ready automatically about a minute later.
No TLS checks were bypassed and no production-first workaround was needed.
- **VERIFIED** - The original custom-domain Browser Cache TTL changed the CSS cache header to four hours despite the worker's `no-cache` header.
[Cloudflare documents this override and the Respect Existing Headers setting](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/).
The applied exact-host Browser TTL rule uses [the documented `respect_origin` mode](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/), and the real CSS response now matches the contract.
- **VERIFIED** - The original token returned 403 for the cache-rule endpoint.
Nathan granted the requested permission, after which the cache-rule API and full live-site verification succeeded.

Rollback evidence is saved before association in `.local/cloudflare/dns-before.json` and after switching in `.local/cloudflare/dns-after.json`, mode 600.
To restore the prior origin, remove the `nathan.fish` custom-domain association from the Pages project, remove the new apex CNAME, and recreate the two saved proxied apex A records at `216.150.1.193` and `216.150.1.129`, using their saved TTL and properties.
Leave CAA, other record types, and other hostnames unchanged.
No rollback has been performed; the editor remains publicly served at `nathan.fish`.

Cache rollback evidence is `.local/cloudflare/cache-rules-before.json` and `.local/cloudflare/cache-rules-after.json`, mode 600.
To undo only this cache change, remove the rule named `Respect nathan.fish editor cache headers`; preserve all other rules and settings.
The cache helper preserves the original raw ruleset once, appends only its rule, and refuses a differing existing editor rule.
No remaining hosting implementation or HTTP verification work; stop here with the browser workflows delegated to the lead.

## Time

- Start: `Sat Oct 10 09:56:37 EDT 2026`.
- Permission-resume start: `Sat Oct 10 10:42:35 EDT 2026`.
- End: `Sat Oct 10 10:44:04 EDT 2026`.
