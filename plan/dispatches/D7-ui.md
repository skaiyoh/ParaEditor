# D7: the page under impeccable's direction

Effort: high. Sandbox: rw. Review: impeccable finish reviewer (Claude), then codex. impeccable: yes.

Filled by the lead on 2026-10-09 23:20 from impeccable's output: the contract path, the fonts, the stylesheet.

## Mission

The page the judges touch looks and feels designed: the stage first, the controls legible at arm's length, the status line honest, the swatch row obvious when something is selected, Motion and Symbols as toggles a stranger finds without being told, Download and Reset where a hand expects them.
Behavior does not change: every scenario that passes today passes after, and the production story still finds its controls.
Build only the controls that exist today. The direction contract's first viewport also shows the slots later packages fill (the Effects tab, the Window and 3DS stream toggles, Send to 3DS, Publish): build their containers only where the contract makes them structural (a tab strip, a rail), never an empty or disabled placeholder control; each later package adds its control in its slot with one wiring change.

## Context

Read these and nothing else outside the files in Scope:

- `PRODUCT.md` (written by `/impeccable init`) and the direction contract at `.impeccable/surfaces/src-ui-app-tsx.md` (its `## Direction contract` section, six blocks): the direction is binding; this dispatch does not restate it.
- `plan/demo.md` section 1 (the story: what each control is for), section 4.5 (the asset route: `src/assets/` is copied to `assets-static/`; fonts are self-hosted woff2 there or the system stack; the CSP allows `'self'` only), section 10 (demo day: one window, trackpad, judges' hands).
- `src/ui/app.tsx` and `src/ui/swatches.tsx` as they are: the working controls and their handlers; `src/session/scene.ts` only for the session methods the page calls (do not change the session).
- `test/browser/scenarios/story.scenario.ts`, `objects.scenario.ts`, `render.scenario.ts`, `camera-stage.scenario.ts`, `symbols.scenario.ts`, `loop.scenario.ts`, `demo.scenario.ts`: how the scenarios find controls (labels, roles, ids). Keep every selector working, or update the scenario in the same change and say so.
- `~/.agents/skills/impeccable/SKILL.md`: load it before editing UI files; the Codex hook in this project runs its detector on your edits and its findings bind you.

Decisions already made:

- Layout: the stage is the largest thing on screen at the MacBook's resolution with the panel beside or below it as the direction says; nothing scrolls during the story; the status line stays visible at all times.
- Controls keep their current semantics and their test ids or labels; sliders stay native `input[type=range]` (the scenarios dispatch real input events on them) styled through CSS; toggles stay checkboxes or buttons with `aria-pressed`; every control is reachable by keyboard and has a visible focus ring.
- Touch targets at least 44 px on the trackpad-driven page; the swatches at least 40 px.
- Fonts: the system stack (`system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`), with `font-variant-numeric: tabular-nums` on every value; no font files, no network fonts.
- Colors and type scale: exactly as the direction contract's OWN-WORLD block gives them, as CSS custom properties on `:root`; the accent is one token.
- The build's asset route already exists; the stylesheet is one file, `src/assets/app.css`, linked from `src/index.html` at `/assets-static/app.css`; no inline style attributes beyond the swatch colors and the slider fill variables.
- No new runtime dependency; no CSS framework; no icon font (inline SVG if icons are needed).

## Scope

- Create: `src/ui/*.tsx` components as needed, `src/assets/fonts/*` and `src/assets/app.css` if the direction uses them.
- Change: `src/ui/app.tsx`, `src/ui/swatches.tsx`, `src/index.html` (only to link the stylesheet), `tools/build.mjs` only if the asset route needs a content type it lacks, the scenario files only where a selector had to change.
- Do not touch: `src/session/`, `src/render/`, `src/photo/`, `src/analysis/`, `src/core/`, `src/export/`, `plan/`.

## Acceptance

1. `npm run typecheck`, `npm run build`, `npm run build:production`, and the node tests pass (the command in `AGENTS.md`).
2. The impeccable detector (the hook) reports no blocking findings on the files you changed; paste its last report.
3. LEAD: all fourteen dev scenarios and both production scenarios pass unchanged in behavior; the lead runs them.
4. LEAD: the impeccable finish reviewer judges the page against the direction contract and the story at 1440 x 900 and 1280 x 800; its material fixes come back to this session as a resume.
5. Keyboard: Tab reaches every control in reading order; Escape deselects; Enter on a swatch applies it (the scenario `objects.tap` may gain one check for this).
6. No console errors, no CSP violations (fonts and styles are same-origin).

## Return

Write `plan/evidence/D7-return.md` in the shape `AGENTS.md` gives, with the font and stylesheet decisions, every selector you changed, and screenshots the lead should take (list the viewport sizes and the states: empty, importing, ready, selected, motion).

## Stop condition

When every acceptance item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not change behavior, the session, or the renderer.
