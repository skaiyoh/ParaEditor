# CF1: nathan.fish hosting

Effort: high. Sandbox: workspace-write. Review: codex. impeccable: no.

## Mission

Publish the existing production editor directly at https://nathan.fish/ using Cloudflare Pages and R2.
Keep the project name provisional and preserve the local demo and editor behavior.

## Context

- Nathan requested a private GitHub repository and the editor at the root of nathan.fish, then explicitly approved the hosting scope and a pinned temporary Wrangler CLI on 2026-10-10.
- The private repository is skaiyoh/noisy-demo; origin is configured, but GitHub pushes and git-history changes are not authorized.
- R2 activation is complete and its API responds 200.
- The token and account ID are in the ignored, mode-600 .local/cloudflare.env; never print credentials or bundle them.
- Read plan/demo.md section 9, headers.json, models.lock.json, tools/headers.mjs, and the existing production browser scenarios.
- Preserve the model loader's same-origin /models/ paths and the existing response-header contract.
- Use Cloudflare Pages advanced mode with an R2 binding, not another origin or changes to analysis, render, session, or UI.
- Use Wrangler 4.149.0 temporarily through npm; no package.json, lockfile, or runtime dependency changes.
- The existing PRODUCT.md modification is unrelated and must remain untouched.
- Nathan granted the requested Cache Rules token permission on 2026-10-10, authorizing the prepared hostname-specific Browser TTL rule needed to finish verification.

## Scope

- Create: tools/cloudflare/**, test/cloudflare-hosting.test.ts, test/browser/scenarios/hosted.scenario.ts, plan/evidence/CF1-return.md, and this dispatch.
- Change: test/browser/scenarios/index.ts only to register the new scenario.
- Local generated output: build/cloudflare/, the normal existing build outputs, and ignored .local/cloudflare/ deployment state, tool cache, and DNS rollback evidence.
- Read the existing credential file; do not change its values.
- External changes: one Pages project, one Standard R2 bucket containing only the lock's model files, deployment versions, the nathan.fish Pages custom-domain association, and the apex DNS records required for that association.
- External scope extension: one cache rule matching only nathan.fish with Browser TTL respect_origin; preserve existing cache rules and save the original raw ruleset before mutation.
- Preserve other DNS records and save the apex records before switching the origin.
- Do not modify any other repository file, commit, branch, push, add a gallery, or add a dependency to the project.

## Acceptance

1. A reproducible hosting preparation/deployment path uses the existing production build, headers.json, and models.lock.json as its sources, and never includes local credentials, source files, dev routes, or owner photos in the deployment.
2. The hosting adapter serves only the production assets and locked model files, supports model GET, HEAD, resumed byte ranges and 416 responses, streams R2 bodies, and preserves the response-header contract on successful and error responses.
3. The seven model files are checked against the lock before upload, uploaded to Standard R2 storage, and verified through the deployed same-origin URLs by byte length and SHA-256.
4. A Pages preview deployment passes direct HTTP checks before apex DNS changes; https://nathan.fish/ then serves the production editor with its assets, runtime files, isolation headers, model routes, and no dev endpoints.
5. npm run typecheck, npm run build, npm run build:production, and the node tests excluding drive-chrome pass; include their last lines in the Return.
6. Add and register hosted.production to cover the hosted browser boundary and actual sample import; name that scenario and the existing story.production workflow for the lead to run against the hosted URL.
Browser execution and visual judgment are LEAD because this sandbox cannot start Chrome.
7. Obtain an independent, read-only review of the hosting package, resolve actionable in-scope findings, and record the result without changing unrelated work.

## Return

Write plan/evidence/CF1-return.md in the shape AGENTS.md specifies, including deployed URLs, exact checks and observed results, rollback evidence location, browser items marked LEAD, and any incomplete acceptance.

## Stop condition

Stop after the hosting acceptance is PASS, LEAD for the explicitly delegated browser checks, or FAILED after two different attempts.
Do not continue into the gallery, naming, GitHub publishing, or another package.
