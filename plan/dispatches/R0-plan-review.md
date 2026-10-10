# R0: adversarial review of the demo plan (read-only)

Your sandbox is read-only; change nothing.
Your final message is the deliverable (the CLI saves it to `plan/evidence/R0-last.md`), at most 200 lines, then stop.

## Mission

Try to break the plan before anyone builds to it.
You are not asked to praise it or to restate it; you are asked for the places where it will fail, cost more than it says, or produce the wrong thing, each with the evidence that convinced you.

## Read

- `plan/demo.md` (the plan), `CLAUDE.md`, `AGENTS.md` (the rules the lead and you work under).
- `plan/dispatches/D1-import.md` and `plan/dispatches/D2a-render-contract.md` (the first two dispatches).
- `plan/evidence/foundations.md` and `plan/evidence/look-rules.md` (the distilled facts; check the plan against them).
- The code wherever a claim in the plan or a dispatch depends on it: `src/core/` (schema, defaults, edits, reduce, derive, motion, raster), `src/analysis/service.ts`, `src/app/`, `src/main.tsx`, `tools/build.mjs`, `tools/serve.mjs`, `test/browser/scenario.ts`, `test/browser/scenarios/index.ts` and one existing scenario, `plan/reference/simplify-cost/index.html`.
- `plan/reference/design.md` only where a dispatch names a section (12 for D1).

## Look for, in this order

1. Contradictions between the plan or a dispatch and the code or the evidence: a type, signature, field, file, route or rule that does not exist as the plan says, or behaves differently. Quote the code.
2. Acceptance items that cannot be checked as written (no observable, no hook, the scenario API cannot do it, the number is unmeasurable in headless Chrome), or that pass trivially.
3. Scope holes: something the story in section 1 needs that no package builds, or two packages that both think the other builds it, or a lane boundary a package must cross.
4. The contract in section 5: anything the later packages (D3 driver, D4 objects, D5 symbols, D6 loop) will need that it cannot carry without changing, judged against the evidence's "Objects, masks, and recolor", "Parallax loop and plate", and the core exports.
5. Estimates and ordering: packages likely to run far over, dependencies the table misses, and whether the checkpoints at hours 12, 24 and 36 are reachable at 2x the estimates with one implementor per lane.
6. Ways Codex will run off under these dispatches: ambiguous scope, acceptance that invites iteration without end, missing stop conditions, verification it cannot perform.
7. Demo-day risks the checklist misses.

## Output shape

A numbered list, most severe first.
Each item: one-line claim; the evidence (file:line or a quoted sentence); the consequence; the smallest change that fixes it.
End with a section "Not a problem" listing at most five things you checked that hold, so the lead knows what was verified.
No summaries of the plan, no praise, no restating the mission.

## Stop condition

Final message = the review. No edits. Stop.
