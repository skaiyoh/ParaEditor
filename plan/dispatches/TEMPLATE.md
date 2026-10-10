# <id>: <name>

Effort: <high | xhigh>. Sandbox: workspace-write. Review: <codex | claude>. impeccable: <yes | no>.

## Mission

One paragraph: what exists when this dispatch is done, as the judge or the lead would see it.

## Context

- What already exists that this builds on, with file paths.
- The evidence sections to read (`plan/evidence/*.md` headings, `docs/ARCHITECTURE.md` sections, `plan/reference/design.md` sections), and nothing else.
- Decisions already made that bind this package (values, names, rules), so nothing is reinvented.

## Scope

- Create: <files>
- Change: <files>
- Do not touch: everything else. In particular <files that look tempting>.

## Acceptance

Numbered, each one observable:

1. `npm run typecheck` and `npm test` pass.
2. <the real check: the page at <url> does <behavior>, seen through <driver or script>>.
3. <...>

## Return

Write `plan/evidence/<id>-return.md` in the shape `AGENTS.md` gives, then stop.

## Stop condition

When every acceptance item is PASS or has been attempted twice and is marked FAILED with its output, write the return and stop.
Do not start anything not listed under Scope.
