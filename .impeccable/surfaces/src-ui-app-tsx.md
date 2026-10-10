---
version: 1
slug: "src-ui-app-tsx"
primary_target: "src/ui/app.tsx"
related_targets: ["src/index.html"]
---

# Surface: the demo page (`src/ui/app.tsx`, served at `/`)

Scope: the whole page, the only surface. Visitor mode: Operate.

## Audience and job

A Knight Hacks judge beside Nathan's MacBook on a table in a bright hall, six minutes including questions. Nathan drives the live creation; the judge leans into the window, taps a person, picks a color, holds the 3DS. The page must read as a working editor before its look is noticed.

## Action, proof, constraints

Primary actions in story order: Open or Try a sample, Fry, tap, recolor, Motion, Window, Download. The picture is the proof; the only sentence on the page is the status line. Constraints: CSP self-only, the system font stack, no dependencies, every `data-testid` kept, native range inputs, 44 px targets, keyboard order left to right, Escape deselects, Chrome on macOS at 1440 x 900 and 1280 x 800, nothing scrolls during the story.

## Chosen direction and memorable moment

The category standard executed straight, with Photoshop and DaVinci Resolve as the craft bar (Nathan, 2026-10-09 23:00, the standing exit taken after a safer hand; the themed worlds of that night are declined and do not return). Memorable moment: the judge leans and the picture turns inside a tool that looks like it has always existed.

## Unresolved

The accent is the icon's pink as one token, pending the mark decision. The Effects node, the Window mode, the per-object symbols and motion fields, the history panel, zoom and editable number fields arrive with later packages in the slots the contract names; D7 builds only what exists.

## Direction contract

THESIS: A working editor first: layers on the left, the picture in the center, the node stack on the right, the modes along the bottom. It refuses the themed shell and the slider-list page alike; the point-and-shoot identity lives only in the picture, the status voice and one accent.

OWN-WORLD: Mid-dark grays, never black: ground #1A1A1A, panels #262626, raised rows #2E2E2E, hairlines #3A3A3A; text #E6E6E6 primary and #A3A3A3 secondary; one accent #FF3D7F for the primary action, focus rings, the selected layer and slider thumbs; states green #3FB950, amber #D29922, red #F85149. The system font stack at 13 px for UI text, 12 px labels, an 11 px floor for meta, tabular numerals on every value. 4 px radius on controls, no gradient, no shadow, no glass, no icon font. Sliders are native range inputs restyled: 6 px track filled to the left of a 16 px thumb; values in a 48 px right-aligned field. Panel headers in 11 px caps tracked 0.08 em in the secondary text color.

STORY: The visitor sees a photo editor they already understand, finds the dial that fries the picture, taps a person and recolors them, flips Motion, leans into the window, and believes the tool is real because nothing on it asks for attention.

FIRST VIEWPORT (1440 x 900): a 44 px top bar with the photo's name on the left and Open, Try a sample, Publish, Reset and the primary Download on the right. A 272 px left column: LAYERS on top (the plate and each object as a row with a 48 px thumbnail and name, the selected row carrying the accent, "Tap the picture to add a layer" when only the plate exists), SCENE below (master size, depth, encoder and plate as checks with their timings, the number of models in the lock as "N models local", three today and four once the face model lands). The center: a 32 px viewer toolbar (fit percentage, Before/After) above the stage, which is the largest element on the page, on the ground with 16 px margins. A 360 px right inspector: the scope header "Scene" (the object's name heads the Object node when one is selected; the controls edit the whole scene until a later package scopes them to a layer), then the nodes as collapsible sections: Object (the swatch row, present only with a selection), Fry (a 48 px dial row), Motion (its enable switch in the header, Orbit, Loop seconds), Symbols (enable, Cell size, Amount), Palette (Colors, Bands, Saturation, Simplify, Outline, Subject clarity), Camera (Grain, Color noise, Grain size, Crunch, Clipping); only the part below Camera may scroll. A 40 px bottom strip: the status sentence left at 13 px, the modes centered as toggle buttons with `aria-pressed` (Motion, Symbols today; Window joins later) sharing state with the node switches, the build id right. At 1280 x 800 the columns are 232 and 336 px and the stage shrinks; nothing else moves. The empty state keeps the frame: the stage area is the drop target with "Drop a photo" and the Open and Try a sample buttons centered, the model-fetch percentage in the status.

FORM: the category standard, the standing exit taken in the user's words; not on the grounded list; seed key d8ad13c2.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Revised 2026-10-09 23:45: the 3DS actions left the desktop page (Nathan); the phone is a later surface of its own under the same world, adapted to a portrait viewport.
Revised 2026-10-10 00:05 after the finish review: the scope header stays "Scene" until controls are scoped to a layer; the model count follows the lock.
