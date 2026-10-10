# D0a: what the foundations offer a demo (read-only investigation)

You are investigating this repository.
Your sandbox is read-only: do not modify any file and do not try to.
Your final message IS the deliverable; the CLI saves it to `plan/evidence/foundations.md`.
Write it as one Markdown document of at most 350 lines, then stop.
Do not propose follow-up work, do not start a second pass, do not summarize what you did.

## Mission

A 48-hour demo will be built on this repository's existing foundations: the analysis service and its workers (`src/analysis`), the core document (`src/core`), the build and dev server (`tools/`), and the platform helpers (`src/platform`).
Produce the evidence a planner needs to scope packages that reuse those foundations, so the planner never has to read the whole tree.

## Context

- `docs/ARCHITECTURE.md` documents most of it. Prefer the code when they differ, and say when they do.
- The demo runs on a Mac in Chrome only. Phone and Safari paths are out of scope; do not describe them.
- The dev pages under `src/dev/` (`sequence.html`, `decoder.html`, `service.html`, `models.html` and their scripts) are working examples of driving the service. They are the best source for "how do I call this".
- `node_modules` is installed. You may run `npm run typecheck` and `npm test`; both are read-only.

## Questions to answer

For each, quote the exact exported signatures from the code with a `file:line` reference.

1. Analysis service: how to create it; how to run the sequence (depth, encoder, inpaint) on a photo; what inputs it needs (image format, size, planes, the hole mask for inpaint); what it returns (depth plane type and size, embedding type and size, inpaint output type and size); and how to run a decode (prompt format: points and boxes, and what it returns: mask format, size, scores). Include the lifecycle rules: what must be terminated, what stays resident, and the cooldowns, watchdogs, liveness and hidden-tab handling a demo driver would have to satisfy or may skip.
2. Models: how model bytes get from `models.lock.json` to a worker session (loader API, cache name, what a page must call before the first run), and what the dev server serves at `/models` and `/vendor`.
3. Build: how `tools/build.mjs` defines entries (pages, workers), how to add a new page entry and a new worker, how dev and production modes differ, and how the test surface and the `/api/log` sink are installed in a page.
4. Serving: `tools/serve.mjs` routes and headers (`headers.json`), and whether a page is cross-origin isolated in dev mode.
5. Core document: the `SceneDocument` settings relevant to the look (fields, types, the ranges table), the reducer and edit API, undo, and whether anything in `core` already computes cells, symbols, or render parameters.
6. Platform: what `src/platform` exports, and anything reusable for photo import (decode, resize, EXIF orientation) or PNG export.
7. Verification: how `tools/drive-chrome.mjs` runs one scenario against a running server, and the minimal shape of a scenario file under `test/browser/scenarios/`.

## Also

- A final section "Risks for a demo built on these", at most 10 bullets: anything in the foundations that would surprise a driver written in a hurry (ordering requirements, memory rules, worker termination, isolation requirements, build quirks, test-surface requirements).
- Label each claim VERIFIED (you read the code or ran it) or INFERRED (you reasoned from docs or names).

## Stop condition

Write the document as your final message and stop.
No file edits, no commands that change state, no suggestions beyond the risks section.
