# PH2: the phone layout

Effort: high. Sandbox: rw. Review: codex. impeccable: yes.

Written by the lead on 2026-10-10 10:20 after Nathan picked the structure at C2 (full-screen stage, floating toolbar, tool sheet; essentials only).

## Mission

On Nathan's iPhone (Safari, 402 x 874, and at 390 x 844) the page is the phone build of the same editor: the fried picture edge to edge; a floating toolbar at the thumb with Motion, Symbols, Window, Tilt and Download; a sheet over the bottom of the picture holding the Fry dial and, with a selection, the object's swatches; the status sentence always visible in the sheet's handle row; Take a photo and Reset in the top strip; Try a sample in the empty state.
The desktop at 1440 x 900 and 1280 x 800 does not change.
The direction contract is binding; this dispatch does not restate it.

## Context

Read these and nothing else outside the files in Scope:

- `.impeccable/surfaces/src-assets-app-css.md`: the phone contract, six blocks, binding. `.impeccable/surfaces/src-ui-app-tsx.md`: the desktop contract, which stays true. `DESIGN.md`: the tokens and components; the phone uses them unchanged.
- `PRODUCT.md`, "How the controls are organized" (the essentials, revised 2026-10-10) and "Technical constraints".
- `src/ui/app.tsx`, `src/ui/controls.tsx`, `src/ui/swatches.tsx`, `src/ui/layers.tsx`, `src/assets/app.css`, `src/index.html` as they are.
- `test/browser/scenarios/phone.scenario.ts`: how the phone scenario stubs touch (`navigator.maxTouchPoints` defined to 1) and the orientation permission; `test/browser/driver/browser.ts` for `page.emulate` with `mobile: true`; `story.scenario.ts` and `objects.scenario.ts` for the desktop selectors that must keep working.
- `~/.agents/skills/impeccable/SKILL.md`: load it before editing UI files; the Codex hook runs its detector on your edits and its findings bind you.

Decisions already made:

- The structure, sizes, tokens and copy are the contract's FIRST VIEWPORT block; do not redesign them.
- The phone tier is a CSS media tier in `src/assets/app.css`, `@media (max-width: 760px), (max-height: 500px)`, placed after the desktop tiers so nothing above 760 px changes; plus one `matchMedia` of the same query in `app.tsx` (a hook that follows `change` events) that renders the phone frame (strip, stage, sheet, toolbar) instead of the desktop frame. The two frames never render together. Shared: `Stage`, the Fry range row, `Swatches`, the mode handlers; no new session method and no change under `src/session/`.
- Touch gating stays as it is: Take a photo and Tilt render only when `navigator.maxTouchPoints > 0`. The tier is viewport-keyed, so a narrowed desktop window gets the phone frame without those two; that is correct.
- The sheet has two positions. Its handle row is a button carrying `aria-expanded`; a tap toggles it. It opens on import and collapses by itself when Tilt or Window turns on; turning them off does not reopen it. A pointer drag is optional and must not break the tap.
- Safari: `height: 100dvh` and no `min-height` on the phone tier; the toolbar sits `calc(12px + env(safe-area-inset-bottom))` from the bottom; `touch-action: none` on the stage canvas, `touch-action: manipulation` on buttons and range inputs. `src/index.html` already carries `viewport-fit=cover`.
- Test ids keep their meaning in the phone frame: `stage`, `status`, `swatches`, `take-photo`, `window-enabled`, `tilt-enabled`; the toolbar's Motion and Symbols toggles carry `motion-enabled` and `symbols-enabled` (the desktop node switches' ids), so a scenario finds the Motion control in either frame.
- Download, Reset, Take a photo and Try a sample call the handlers the desktop frame already has.
- No new dependency, no CSS framework, no inline styles beyond the swatch colors and the slider fill variables.

## Scope

- Create: `src/ui/phone.tsx` for the phone frame if it reads better than growing `app.tsx`.
- Change: `src/ui/app.tsx`, `src/ui/controls.tsx` (only to export what the phone frame reuses), `src/assets/app.css`, `test/browser/scenarios/phone.scenario.ts` (add `phone.layout`), `test/browser/page-globals.d.ts` only if the dev surface grows.
- Do not touch: `src/session/`, `src/render/`, `src/core/`, `src/photo/`, `src/analysis/`, `src/export/`, `tools/`, `plan/`, `DESIGN.md`, the desktop brief, `src/index.html`.

## Acceptance

1. `npm run typecheck`, `npm run build` and `npm run build:production` pass; the node suite passes with `test/serve.test.ts` and `test/serve-production.test.ts` left out (F13 in `plan/findings.tsv`: they can hang the runner, and this package does not touch their files). Paste the counts.
2. The impeccable hook reports no blocking findings on the files you changed; paste its last report.
3. `phone.layout` in `phone.scenario.ts`, target dev, covers PH2. It calls `page.emulate({ width: 402, height: 874, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' })`, stubs `navigator.maxTouchPoints` to 1 before importing the sample, and checks: no horizontal overflow (`document.documentElement.scrollWidth === window.innerWidth`) and no page scroll; the stage canvas's box spans the viewport width and is at least half its height; the toolbar lies fully inside the viewport with five buttons each at least 44 px tall, Download last and accent-filled; the sheet is open after import with the Fry range inside it, its handle button toggles `aria-expanded`, and turning Tilt on (the permission stub from `phone.tilt`) collapses it; after `demo.tap` the swatches render inside the sheet as one row of eight; the status element stays inside the viewport in both sheet positions; `.scene-sidebar`, `.inspector` and `.viewer-toolbar` are absent; then at 390 x 844 the overflow, stage, toolbar and status checks hold again. Screenshots: `phone-402-empty` (before the import), `phone-402-ready`, `phone-402-selected`, `phone-402-collapsed`, `phone-390-ready`. LEAD runs it.
4. LEAD: at the desktop viewport `story.production`, `objects.tap`, `render.view`, `window.track` and `phone.tilt` pass unchanged.
5. LEAD: the impeccable finish reviewer judges the phone frame against the contract from the screenshots; its material fixes come back as a resume.

## Return

Write `plan/evidence/PH2-return.md` in the shape `AGENTS.md` gives: the files, the media query, the hook report, every selector you changed, the counts from item 1, and the exact `drive-chrome` command for the lead.

## Stop condition

When every item is PASS, LEAD, or FAILED after two attempts with its output, write the Return and stop.
Do not change the session, the renderer, the desktop frame's layout, or DESIGN.md.
