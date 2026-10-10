# noisy demo: instructions for Codex

This is a sandbox clone of a larger project, used to build a 48-hour hackathon demo.
These rules are more specific than `~/.codex/AGENTS.md` and override it where they differ: no Linear posting, no docs or ADR or changelog work, no commits, and a hard stop at the end of each dispatch.

## How work arrives

Every task is one dispatch file under `plan/dispatches/<id>-<name>.md` with these sections: Mission, Context, Scope, Acceptance, Return, Stop condition.
Do exactly the dispatch.
The Acceptance list is the whole job; the Scope section says which files you may create or change; everything else is out of bounds.

## Stopping

- When every Acceptance item passes, write the Return file the dispatch names and stop. Do not continue into the next package, do not refactor beyond Scope, do not fix things you notice outside Scope: list them under "Noticed, not done" in the Return.
- If an Acceptance item still fails after two different attempts, stop, mark it FAILED in the Return with the exact output, and say what you tried. A failed item reported honestly is a good return; an endless loop is not.
- Never commit, never create branches, never touch git history. The lead commits.
- Never modify `plan/reference/`, `plan/evidence/` (except your own Return file), `plan/log.tsv`, `plan/findings.tsv`, `models/`, or any file outside Scope.
- Never add a runtime dependency. If the dispatch's design needs one, stop and say so in the Return.

## Context you may read

- `plan/demo.md`: the plan, the story, the package list.
- `plan/evidence/foundations.md` and `plan/evidence/look-rules.md`: what the foundations offer and the look rules, distilled.
- `docs/ARCHITECTURE.md` and `plan/reference/design.md`: only the sections the dispatch names. The design describes the full product; the demo builds a reduced form, and the dispatch says which.
- The dev pages under `src/dev/` are working examples of driving the analysis service.

## Code rules

- Read `~/.claude/skills/typescript-best-practices/SKILL.md` once per session before writing TypeScript.
- Keep the dependency direction `ui -> session -> {photo, analysis, render, export, platform} -> core`. Composition happens in `src/main.tsx` and `src/app/` as the design has it; `src/session/` is the thin session layer (it may import the leaves, core and platform), `src/ui/` the page (it imports only ui, session and core); `test/import-graph.test.ts` enforces this and must stay green.
- Reuse the foundations (`src/analysis`, `src/core`, `src/platform`, `tools/build.mjs`, `tools/serve.mjs`) and do not modify them unless the dispatch names the file. A needed change there is a finding: report it in the Return.
- WebGL2 with hand-written GLSL, ONNX Runtime Web on plain wasm, Preact. No React, no three.js, no framework.
- Scenario screenshots: `page.screenshot(name)` takes a name of lowercase letters, digits and hyphens with no extension (`loop`, not `loop.png`); the driver throws at the call, which ends the scenario as failed even when every check before it passed.
- You cannot compile shaders here, so write GLSL ES 3.0 defensively: every fragment shader with more than one output declares `layout(location = N)` on each output, every framebuffer with several attachments sets `gl.drawBuffers`, and every new program is created inside the existing error-to-status path so a compile failure reads as a status sentence, not a blank stage.
- Deterministic where the design says so: the grain is a hash of integer coordinates and a seed, never `Math.random()`.
- Load the impeccable skill (`~/.agents/skills/impeccable/SKILL.md`) before editing UI files when the dispatch says `impeccable: yes`, and follow the direction contract it names.

## Verification you owe

- Before you return, these must pass, and you paste the last lines of each into the Return:
  `npm run typecheck`, `npm run build`, and the node tests that do not launch Chrome:
  `node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)`
  (`test/drive-chrome.test.ts` launches Chrome, which cannot start inside your sandbox; the lead runs it.)
- Headless Chrome cannot start inside your sandbox, so you cannot see the page.
  For every acceptance item that needs a browser, write or extend the browser scenario the dispatch names under `test/browser/scenarios/`, register it in `test/browser/scenarios/index.ts`, make it check that item, and list in the Return the exact scenario ids the lead must run.
  The lead runs them and, when they fail, resumes your session with the output and a screenshot.
- You may start the server (`npm run serve`, port 8790) and use `curl` against it for route and header checks. Stop it before you return.
- Report what you ran and what you observed, not what you expect. An acceptance item you could not check yourself is marked `LEAD` in the Return, never PASS.

## Return file shape

```
# <id> return
## What changed  (files, one line each)
## Acceptance    (each item: PASS or FAILED, with evidence)
## Checks run    (commands and their last lines)
## Noticed, not done
## Findings      (anything the foundations or the design got wrong, with VERIFIED or INFERRED)
## Time          (start, end, from `date`)
```
