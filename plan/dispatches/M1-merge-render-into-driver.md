# M1: resolve the merge of the render lane (D2a) into the driver lane (D3)

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

The lead ran `git merge --no-commit demo` in this worktree to bring D2a's renderer into the driver lane.
Four source files have conflict markers because both lanes added behavior to them.
Resolve them so that both behaviors exist, unchanged in intent, and the floor is green.
You cannot run git here (the repository metadata is outside your writable root); edit the files only, and the lead stages and commits.

## Context

- `plan/evidence/D2a-return.md` (the renderer side: the session owns the renderer, the page hands it a fresh canvas through a session method, style and Fry edits through `applyEdit`, `exportStill` behind the download, `demo.setStyle`, `demo.setFry`, the `demo.render` debug getter) and the code it names.
- `plan/evidence/D3-return.md` (the driver side: `createAnalysisDriver`, `Products`, the session's `analysis`, `products`, `setDocument`, `setMotion`, `requestPlateIfNeeded`, `injectMask`, the status line with the analysis status) and the code it names.
- `plan/demo.md` section 5 (the contract: the session feeds the renderer `doc`, `master`, `masks`, `depth`, `plate`, `selected` through `setScene`) and section 3 (lanes).

The conflicted files and what each side wanted:

- `src/session/scene.ts` (2 blocks): D2a added renderer ownership and style edits; D3 added the driver, the products map, and the product-aware scene publication. The merged session does both: every published scene change also reaches the renderer through `setScene` with the products projected by `products.forScene(doc)`, and `exportStill` stays the download path.
- `src/session/test-hooks.ts` (3 blocks): the union of both hook sets, one `demo` object.
- `src/ui/app.tsx` (1 block): D2a's sliders and fresh WebGL canvas plus D3's analysis status line, both present.
- `test/browser/page-globals.d.ts` (2 blocks): the union of both declarations.

## Scope

- Change: only the four files above, plus `test/browser/scenarios/index.ts` if the automatic merge left it inconsistent.
- Do not touch anything else. In particular leave `test/browser/scenarios/demo.scenario.ts` alone: its `demo.download` is known red since D2a (it reads the WebGL stage with a 2D context) and is being fixed on the render lane.

## Acceptance

1. No conflict markers remain (`rg -n '^(<<<<<<<|=======|>>>>>>>)' src test` finds nothing).
2. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
3. Both lanes' behaviors are reachable: the page shows the sliders and the analysis status; the session exposes `attach`-style renderer wiring and the driver methods; the test surface exposes every hook both returns listed.
4. LEAD: the lead runs `demo.import render.first-look render.outline driver.import driver.plate driver.failure` against this worktree's server and reports.

## Return

Write `plan/evidence/M1-return.md`: the resolution of each block in one or two lines, the checks' last lines, and anything you had to decide. Then stop.
