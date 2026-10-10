# noisy demo (sandbox clone)

A sandbox clone of `~/dev/skaiyoh/noisy` taken 2026-10-09 at `177d329` (branch `feat/noisy-v1`), made for a hackathon demo due 2026-10-11 (the exact slot is in `plan/demo.md`).
The source project is untouched and nothing here flows back as code; findings flow back through `plan/findings.tsv`.
This clone takes a lower bar on purpose (sandbox rule): it is stated here and in `plan/demo.md`, not repeated per change.

## Read first

`plan/resume.md` first: it is the pickup point for any session leading this clone, written when the planning session closed on 2026-10-09 at 13:50 EDT.
`plan/demo.md` is the whole plan: the story, the packages, the checkpoints, the cut line, the budget rules, the demo-day checklist.
It is the only context a session needs.
Never open `plan/reference/design.md` in a Claude session; it is 2,300 lines and Codex reads the sections a dispatch names.
`plan/evidence/foundations.md` and `plan/evidence/look-rules.md` are the distilled facts; read those instead.

## Roles

- Codex implements. Every package is one dispatch file under `plan/dispatches/`, run with `plan/codex.sh <id> [effort] [ro|rw]`; it returns `plan/evidence/<id>-return.md` and a diff in the working tree. Codex cannot start Chrome inside its sandbox, so the lead runs the browser scenarios the return names and feeds failures back with `plan/codex-resume.sh <id> <message> [screenshot]` (`plan/demo.md` section 3).
- Claude leads: writes the dispatch, judges the returned diff against the dispatch (the return is a claim about the diff, not the diff), runs the floor, commits on `demo`, logs the row in `plan/log.tsv`, and briefs Linear at checkpoints.
- Claude writes no code except a fix it finds while judging that is smaller than a dispatch.
- impeccable in Claude owns the UI direction (`/impeccable init`, the direction contract) and the finish review; Codex implements the UI to that direction with the Codex hook on.
- Reviews: Codex self-reviews every package before returning. An independent `code-reviewer` runs only on the packages `plan/demo.md` marks `review: claude`; everything else is Claude's read of the diff.
- No workflows, no `architect` or `adversarial-reviewer` dispatches, no subagent fan-outs. Codex in read-only mode is the adversarial reader when one is needed.

## Budget rules

- Claude: weekly usage was about 50% left at 2026-10-09 08:30 EDT. Record the figure from `/usage` in every checkpoint row of `plan/log.tsv`. If it drops under 25% before hour 24, reviews move to Codex entirely and Claude only dispatches, judges, and commits.
- Keep this context small: never read a Codex log (`plan/logs/*.jsonl`); read the return file, then `git diff --stat`, then targeted hunks. Prefer `rg -n` to whole-file reads. Screenshots only at checkpoints.
- Codex: two usage resets are available over the window. `plan/codex.sh` logs model, effort, and tokens per run into `plan/log.tsv`. Default effort is `high`; `xhigh` is for the packages `plan/demo.md` marks so.
- Models in use: Claude Fable 5.1 for the lead; Codex gpt-6.1-sol for implementation. Write any change of either into `plan/log.tsv`.
- $250 of Claude cloud credits exist but need the repo on GitHub; `plan/demo.md` says when that is worth it.

## Verification floor (the lower bar)

- `npm run typecheck` and `npm test` stay green: they guard the foundations the demo stands on (baseline 2026-10-09: 753 tests pass).
- The demo runs end to end in Chrome at every checkpoint, and after every package that touches the demo page: `npm run serve`, then the page `plan/demo.md` names, driven by hand or by `node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ <scenario>` once the demo has scenarios.
- Not required: `npm run test:browser`, docs, ADRs, the changelog, Safari, the phone. A dispatch may add a browser scenario when the package is worth it; `plan/demo.md` says which.

## Git

- Hackathon rule (Nathan, 2026-10-09 09:30): code may not officially start before 22:00 EDT on 2026-10-09, and nothing leaves this machine before then. There is no remote and none is added before 22:00; commits stay local. At 22:00 Nathan decides how the work done before then is presented.
- Nathan wants the whole demo as one big commit, made later (after 22:00 on 2026-10-09, when he says). Per-package commits on `demo` are a working mechanism only, so the lanes have a base to branch from; they are squashed into that one commit at the end (`git reset --soft 177d329`, one commit), and are never shown, pushed, or treated as history. Conventional lowercase subject on the final commit, no attribution trailers.
- This clone has no remote on purpose (`git remote remove origin` was run) so nothing can reach the source by accident. Add one only when Nathan asks for GitHub (cloud credits or hosting).
- `models/` is an APFS clone of the source's model files, made so nothing in this clone points into the source; `tools/fetch-models.mjs` verifies it like any other.

## Demo day

`plan/demo.md` section "Demo day" is the checklist.
Nothing touches the network: fonts are local, the models are cached, a known-good sample photo is one click away.

## Status

Linear project noisy, issue NATE-258 (the demo); NATE-259 holds the actions waiting on Nathan.
Checkpoint briefings go there as comments and as project updates; chat is not a status surface.
