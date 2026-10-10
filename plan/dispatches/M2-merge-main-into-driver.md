# M2: resolve the merge of `demo` (D2b, the D2a review fixes, D3) into the driver lane (D4)

Effort: high. Sandbox: rw. Review: codex. impeccable: no.

## Mission

The lead ran `git merge --no-commit demo` in this worktree.
Three source files have conflict markers because the render lane (D2b and the review fixes) and the driver lane (D4) both changed them.
Resolve them so both behaviors exist unchanged in intent and the floor is green.
You cannot run git here; edit the files only, and the lead stages and commits.

## Context

- `plan/evidence/D2b-return.md` (including its "Resume 1" and "Resume 2" sections: grain, clipping, crunch, the depth-edge term, the context-loss guard, the CPU subject band count, the outline constant, the `injectDepth` hook) and `plan/evidence/D4-return.md` (the selection overlay drawn after the chain and before present when `selected` is non-null, kept out of `exportStill` by rendering without it, `toBlob`, then re-rendering with it; the `tap`, `select`, `setRecolor`, `reset`, `objects` hooks).
- `plan/demo.md` section 5 (the contract) and section 4 item 6 (the camera stage order: grain, clipping, crunch after outline or cells, before present).

The conflicted files and what each side wanted:

- `src/render/renderer.ts` (3 blocks): D2b inserted the camera stage passes, the depth texture and edge term, the context-loss guard and the CPU band-count uniform; D4 added the selection overlay pass and its export dance. Merged: the chain runs simplify, quantize, outline (with the depth term), grain, clipping, crunch, then the selection overlay only for the on-screen render, then present; `exportStill` renders the chain without the overlay, snapshots, and re-renders with it; both guards and uniforms stay.
- `src/session/test-hooks.ts` (1 block): the union of both hook sets, one `demo` object.
- `test/browser/page-globals.d.ts` (1 block): the union of both declarations.

## Scope

- Change: only the three files above, plus `test/browser/scenarios/index.ts` if the automatic merge left it inconsistent.
- Do not touch anything else.

## Acceptance

1. No conflict markers remain in `src` or `test`.
2. `npm run typecheck`, `npm run build`, and the node tests pass (the command in `AGENTS.md`).
3. Both behaviors are reachable: the camera-stage sliders, the depth-edge term, the selection overlay, every hook both returns listed.
4. LEAD: the lead runs all eleven scenarios against this worktree and reports.

## Return

Write `plan/evidence/M2-return.md`: the resolution of each block in one or two lines, the checks' last lines, and anything you had to decide. Then stop.
