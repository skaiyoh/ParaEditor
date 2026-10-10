# GH1: private source publication and automatic deployment

Effort: high. Sandbox: workspace-write. Review: independent, read-only. impeccable: no.

## Mission

Publish the current editor source to the existing private skaiyoh/noisy-demo repository as one fresh initial commit with its actual creation timestamp.
Deploy verified pushes to main automatically to the existing Cloudflare Pages project and https://nathan.fish/.

## Context

- Nathan explicitly requested GitHub source publication and automatic deployment, then requested one initial commit dated today.
- This request authorizes the initial commit, push, encrypted Actions secrets, and its deployment, overriding the project's usual no-commit rule only for this publication.
- Bootstrap corrections may amend that isolated root commit and replace only its exact published predecessor with force-with-lease, keeping main at one commit.
Stop rather than overwrite any other remote work.
- Preserve the original checkout's branches, commits, and unrelated changes by constructing an isolated publication repository.
- GitHub currently has no commits, is private, and permits Actions.
- Cloudflare Pages noisy-demo is a direct-upload project with production branch demo and private R2 bucket noisy-demo-models.
- Keep this existing Pages project, domain, DNS, cache rule, R2 objects, and production branch configuration.
- Map GitHub main to the existing production deployment phase.
- Credentials live in ignored .local/cloudflare.env; read them only programmatically and never publish or print them.
- The existing pinned temporary Wrangler CLI is sufficient; add no project dependency.
- Read package.json, tools/cloudflare/, tools/fetch-models.mjs, and the affected tests.

## Scope

- Create: .github/workflows/deploy.yml, tools/cloudflare/ci.mjs, test/cloudflare-credentials.test.mjs, plan/evidence/GH1-return.md, and this dispatch.
- Change: tools/cloudflare/cli.mjs for environment credentials and tools/cloudflare/deploy.mjs only for an accurate usage comment and GitHub commit metadata.
- Change: test/serve-production.test.ts only to plant the uppercase fixture on case-sensitive Linux as well as macOS.
Independent review found its existing dev-server control assumes a case-insensitive filesystem, which blocks the required Linux CI run.
- Generated local state: ignored .local/cloudflare/github-publish/, .local/cloudflare/ verification logs and publication inventory, and existing build outputs.
- Source snapshot: copy existing tracked source plus the explicitly scoped CF1 and GH1 files into the isolated publication repository; exclude local credentials, models, dependencies, generated output, and existing Git history.
- External changes: encrypted GitHub Actions secrets in skaiyoh/noisy-demo, one initial main commit, Actions runs, and preview/production Pages deployments through the existing adapter.
- Do not edit UI, application behavior, model locks, DNS, cache rules, repository documentation, other dispatch evidence, or the original checkout's Git history.

## Acceptance

1. The private GitHub repository contains the current editor source and hosting adapter in exactly one root commit with the actual current timestamp; original local history is preserved.
2. No credential, ignored local photo/input, model binary, node_modules, generated build output, or inherited Git history enters the snapshot.
3. A workflow checks pull requests and main pushes using npm ci, locked-model verification, typecheck, dev and production builds, and all non-Chrome node tests.
It uses pinned official actions and read-only GitHub permissions.
4. Only main pushes or manual runs on main deploy, with serialized production jobs and credentials available only to the deployment step.
Skip superseded commits before deploying and check main again before production promotion.
Environment credentials work without a local file, partial environment credentials fail, and the local-file fallback remains functional.
5. The pipeline prepares the allowlisted build, verifies a Pages preview before production, then verifies the production deployment and nathan.fish over HTTP including asset/model hashes and the response-header contract.
Allow bounded retries of the unchanged HTTP checks for observed Pages propagation delay; fail if the checks never pass.
It uses the existing R2 objects and does not change DNS or cache rules.
6. Local npm run typecheck, npm run build, npm run build:production, all non-Chrome node tests, and focused credential tests pass.
A published workflow run succeeds and nathan.fish serves the published GitHub commit's build ID.
Record bootstrap failures and their exact output honestly.
7. Obtain independent read-only review before publication, resolve actionable in-scope findings, and record evidence.
No new browser/UI behavior is introduced; CF1's browser scenarios remain LEAD.

## Return

Write plan/evidence/GH1-return.md using AGENTS.md's Return shape.
Include repository, root commit, actual date, Actions run, live URL/build ID, verification results, preserved local history, and any limitations.

## Stop condition

Stop after acceptance passes or an item fails after two different attempts with the exact output recorded.
Do not start another package, rename the project, or rewrite the original checkout's history.
