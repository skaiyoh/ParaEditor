---
version: 1
slug: "src-assets-app-css"
primary_target: "src/assets/app.css"
related_targets: ["src/ui/app.tsx","src/index.html"]
---

# Surface: the demo page on the phone (`src/assets/app.css` phone tier, `src/ui/app.tsx` at 402 x 874)

Scope: the same page as `.impeccable/surfaces/src-ui-app-tsx.md`, under the phone tier of the stylesheet: at or under 760 px wide, or at or under 500 px tall. Safari on Nathan's iPhone 16 Pro over the Mac's TLS server; 390 x 844 must also hold. The desktop brief keeps the wide tiers and the world. Visitor mode: Operate.

## Audience and job

A judge holding Nathan's iPhone for about a minute inside the six, and Nathan on the phone before that: take a photo, fry it, tap a person, recolor them, tilt the phone and watch the picture turn. One hand, thumb reach, a bright hall. The picture is the proof.

## Action, proof, constraints

Primary actions in order: Take a photo or Try a sample, Fry, tap, recolor, Motion, Tilt, Window, Download. Essentials only (Nathan, 2026-10-10 10:05): the phone shows Fry, the Object swatches, the four modes, Take a photo, Download and Reset; Try a sample only in the empty state. No Palette, Camera, Surface or Symbols sliders, no Layers list, no Scene facts, no viewer toolbar, no build line on the phone. Constraints: the desktop's tokens and components unchanged; every `data-testid` kept; the session untouched; native range inputs; 44 px targets; `100dvh` with no minimum height; the toolbar above `env(safe-area-inset-bottom)`; `touch-action: none` on the stage and `manipulation` on controls; no hover-only affordance; CSP self-only; no dependency.

## Chosen direction and memorable moment

The full-screen stage with a floating toolbar and a tool sheet, Nathan's pick of five candidates on 2026-10-10 at C2 (the scrolling column, the one-node strip, the two tabbed pages and the layer strip declined). Memorable moment: the judge tilts the phone and the picture turns inside it with nothing in the way.

## Unresolved

The sheet's drag: tap-to-toggle is the floor, a drag that follows the finger is welcome only if it proves solid in Safari. Landscape is not designed, only not broken. The phone-to-Mac handoff (an automatic save) is its own package, not this surface's business.

## Direction contract

THESIS: The picture is the phone. One full-bleed stage, one floating toolbar at the thumb, one sheet holding the two editing controls that matter; it refuses the desktop page scrolled into a column and the tabbed app alike.

OWN-WORLD: The desktop's world verbatim: ground #1A1A1A, panel #262626, raised #2E2E2E, hairline #3A3A3A, text #E6E6E6, secondary #A3A3A3, the one accent #FF3D7F; system stack at 13, 12 and 11 px, tabular numerals; 4 px radius on controls, no shadow, no blur, no gradient, no icon beyond the chevron. The phone adds exactly one piece: the sheet handle, a 36 x 4 px `secondary` bar with a 2 px radius, the mechanical kind of round the world allows. The toolbar and the sheet are `panel` with a 1 px `hairline` edge over the `ground` stage; the tonal step is their only depth.

STORY: The judge takes the phone and sees the fried photograph edge to edge, finds one dial that fries it more, taps a face and recolors it, then tilts the phone and the picture turns inside it; nothing on the screen asks to be read.

FIRST VIEWPORT (402 x 874, Safari's own bars outside it): A 44 px top strip on `panel`: the photo's name left at 13 px, ellipsized; Take a photo and Reset right as default buttons. The stage fills everything from the strip to the toolbar, the canvas contained and centered on `ground` with no margin. Over the bottom of the stage, a sheet on `panel` with a hairline top edge, two positions. Collapsed: one 44 px row, the handle centered in its top 8 px, the status sentence at 13 px `text` left with 16 px padding; it is the page's only voice and never hides. Open: the same row, then the Fry dial row at 48 px (the 20 px thumb, the value at 13 px right), then only with a selection the Object heading at 40 px with the object's name and one row of eight 40 px swatches with 4 px gaps, Original and Deselect in a 44 px row above them. The sheet opens on import and collapses by itself when Tilt or Window turns on; the handle row toggles it on tap. Below the sheet, the floating toolbar: inset 12 px from the sides and 12 px plus the safe-area inset from the bottom, `panel`, hairline edge, 4 px radius, one 44 px row of five equal buttons: Motion, Symbols, Window and Tilt as toggles with `aria-pressed` and 12 px labels, then Download as the accent primary. The toolbar appears only while a photo is open. At 390 x 844 the buttons narrow; nothing else moves. Empty state: the strip reads "No photo open"; the stage area carries "Take a photo" and "Try a sample" centered as the empty-state buttons, and the sheet's row shows the model-fetch percentage.

FORM: the full-screen stage with a sliding sheet, Nathan's pick of five on 2026-10-10; an adaptation of the desktop form d8ad13c2 to the portrait viewport, no new roll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
