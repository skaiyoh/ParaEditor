---
name: noisy
description: A working photo editor at the Photoshop and Resolve craft bar; mid-dark grays, hairlines, one hot-pink accent, nothing that asks for attention.
colors:
  ground: "#1A1A1A"
  panel: "#262626"
  raised: "#2E2E2E"
  hairline: "#3A3A3A"
  text: "#E6E6E6"
  secondary: "#A3A3A3"
  accent: "#FF3D7F"
  success: "#3FB950"
  warning: "#D29922"
  error: "#F85149"
typography:
  title:
    fontFamily: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "16px"
  body:
    fontFamily: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "16px"
  label:
    fontFamily: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.25
  meta:
    fontFamily: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  panel-heading:
    fontFamily: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "12px"
    letterSpacing: "0.08em"
rounded:
  control: "4px"
  track: "3px"
  switch: "10px"
  round: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  bar: "44px"
  thumb: "48px"
  row: "64px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-hover:
    backgroundColor: "{colors.raised}"
  button-active:
    backgroundColor: "{colors.hairline}"
  button-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ground}"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-primary-disabled:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.secondary}"
  button-empty:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-empty-hover:
    backgroundColor: "{colors.hairline}"
  toggle-pressed:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  layer-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "0"
    padding: "8px 16px"
    height: "64px"
  layer-row-selected:
    backgroundColor: "{colors.raised}"
  layer-thumbnail:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.control}"
    size: "48px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
  panel-heading:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.secondary}"
    typography: "{typography.panel-heading}"
    padding: "16px"
    height: "44px"
  scope-heading:
    textColor: "{colors.text}"
    typography: "{typography.title}"
    padding: "14px 16px"
    height: "44px"
  node-disclosure:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.title}"
    rounded: "0"
    height: "44px"
  range-row:
    typography: "{typography.label}"
    padding: "0 16px"
    height: "44px"
  range-row-fry:
    typography: "{typography.body}"
    padding: "0 16px"
    height: "48px"
  range-value:
    textColor: "{colors.secondary}"
    width: "48px"
  range-thumb:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.round}"
    size: "16px"
  range-thumb-fry:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.round}"
    size: "20px"
  enable-switch:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.switch}"
    width: "36px"
    height: "20px"
  enable-switch-on:
    backgroundColor: "{colors.accent}"
  swatch:
    rounded: "{rounded.control}"
    padding: "0"
    height: "40px"
  status-line:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "0 0 0 16px"
  build-meta:
    textColor: "{colors.secondary}"
    typography: "{typography.meta}"
    padding: "0 16px 0 0"
---

# Design System: noisy

> Owns: the pre-RS1 implemented visual system recorded below.
> Does not own: current feature requirements ([PRODUCT.md](PRODUCT.md) and the [UI handoff](plan/handoffs/ui-redesign.md)), demo priorities ([revision.md](plan/revision.md)), or redesign decisions still being settled in [RS1](plan/evidence/RS1-decisions.md).

## Current redesign status: 2026-10-10

The pink-accent desktop system below is the earlier implementation record, not the direction for the coming redesign.
Nathan's settled RS1 direction is neutral gray, near-white interaction emphasis, touch-scale rounded controls, vertical edge Fry, and floating tool panels/icon toolbar.
The [RS1 record](plan/evidence/RS1-decisions.md) names remaining composition/key-treatment choices; its sketch has not been approved wholesale.
The [UI handoff](plan/handoffs/ui-redesign.md) adds the current inventory and creative-tool requirements.
Per Nathan's RS1 decision, the design session rewrites this document from the built redesign once it lands.
This review preserves old tokens/layout rather than pretending a new visual system has shipped.

## Overview

**Creative North Star: "The Working Editor"**

noisy's shell is the category standard executed straight: layers on the left, the picture in the center, the node stack on the right, the modes along the bottom.
It sits beside Photoshop and DaVinci Resolve and borrows their discipline, not their chrome: three mid-dark grays, one-pixel hairlines, the system font at 13 px, and one hot-pink accent that marks exactly the things a hand is about to touch.
The early-2000s point-and-shoot identity lives in the rendered picture and the status voice; the shell never performs it.

Density is editing-suite density.
Every bar is 44 px, every control row is 44 px, every button is a 44 px target, and the stage is the largest thing on the page, sitting on the ground with 16 px margins.
Nothing on the shell asks for attention, so the fried photograph does.

**Key Characteristics:**
- Four grays stepped 8 units apart (ground, panel, raised, hairline); never pure black.
- One accent for the primary action, focus, selection, slider thumbs, switches on, and text selection; nowhere else.
- System font stack, three sizes (13, 12, 11), tabular numerals on every value.
- Flat: no shadows, no glass, no decorative gradients, 4 px radius on controls, 0 on rows.
- One motion duration, 140 ms ease-out, on switches and disclosure chevrons only.

## Colors

A four-step gray ramp carries all structure; one accent and three state colors carry all meaning.

### Primary
- **Hot Pink** (`accent`): the Download button, every focus ring, the selected layer row's outline, range thumbs, switches when on, and text selection.
  It is the only saturated color in the shell.

### Neutral
- **Ground** (`ground`): the page, the stage area behind the photo, the layer thumbnail well, and the switch track when off.
- **Panel** (`panel`): the top bar, the bottom bar, the left sidebar, and the inspector.
- **Raised** (`raised`): a hovered button, a pressed toggle, the selected layer row, the disabled primary action, and the empty-state buttons at rest.
- **Hairline** (`hairline`): every 1 px divider, the unfilled part of a range track, a button's active press, and the scrollbar thumb.
- **Text** (`text`): primary text, the pressed-swatch border, and the hover ring on a range thumb.
- **Secondary** (`secondary`): panel headings, scene-fact terms, range values, timings, the build line, the disclosure chevron, the switch when off, the filled part of a range track, and disabled button text.

### State
- **Success Green** (`success`): the 6 px dot before a scene fact that reads Ready.
- **Warning Amber** (`warning`) and **Error Red** (`error`): defined on `:root`; no shell element uses them yet.
  They are reserved for the status line and scene facts, not for decoration.

### Named Rules
**The One Accent Rule.** The accent marks what a hand is about to touch or has just chosen: the primary action, focus, selection, a thumb, a switch that is on.
It never fills a panel, a heading, a divider, or a label.

**The No-Black Rule.** The darkest surface is `ground`.
Pure black appears nowhere in the shell; the icon's near-black is an open product question, not a shell token.

**The Gray Fill Rule.** A range track fills with `secondary`, not the accent; the accent is the thumb alone.

## Typography

**Display Font:** none.
**Body Font:** system-ui (with -apple-system, Helvetica Neue, Arial, sans-serif).
**Label/Mono Font:** none; numerals are tabular on every element via `font-variant-numeric` on `:root`.

**Character:** the platform's own face at tool sizes, set so a photographer reads the shell the way they read their camera's menu: plainly, without noticing it.

### Hierarchy
- **Title** (600, 13 px, 16 px line): the inspector scope heading "Scene", the Object node's name, each node's disclosure label, and the primary action.
- **Body** (400, 13 px, 16 px line): the photo name, button labels, the status line, the Fry value, and the empty-state prompt.
- **Label** (400, 12 px): range row labels and values, scene facts, the viewer toolbar, mode-rail buttons, and the layer hint at 1.5 line height.
- **Meta** (400, 11 px): timings beside scene facts, the observed analysis backend/local-model count, and the build line.
  11 px is the floor; nothing is set smaller.
- **Panel heading** (600, 11 px, 0.08 em tracking, uppercase, `secondary`): LAYERS and SCENE in the left column only.
  The inspector's headings are title case, not caps.

### Named Rules
**The Three Sizes Rule.** 13, 12, 11.
A new element takes one of these; it does not introduce a fourth.

**The Tabular Rule.** Every number on the page sits in tabular figures so values do not jitter while a slider moves.

## Layout

The page is a 100dvh grid with a 600 px minimum height: a 44 px top bar, the workspace, a 44 px bottom bar.
The workspace is three columns: a 272 px sidebar, the stage at `minmax(0, 1fr)`, a 360 px inspector.
At or under 1350 px wide the columns are 232 and 336 px; at or under 1100 px they are 180 and 312 px, range rows tighten to an 88 px label column with 12 px side padding, and the isolation note leaves the build line.
The stage shrinks; nothing else moves.

Vertical rhythm inside the columns: 44 px for every bar, heading, node header, range row, and switch cell; 64 px for a layer row (48 px thumbnail plus 8 px padding above and below); 48 px for the Fry dial row; 40 px for the Object heading and each swatch; 32 px for the viewer toolbar; 28 px for a scene-fact row.
The sidebar is a flex column: the layer list scrolls, the scene facts pin to the bottom.
The inspector is a flex column: the scope heading is fixed, the node stack scrolls.

Horizontal rhythm: 16 px side padding everywhere, 12 px between a thumbnail and its name, 8 px inside a range row and between empty-state buttons, 4 px between buttons in the action rail, mode rail, and swatch grid.
The action rail ends 8 px from the right edge so the primary action's edge does not touch the viewport.

Spacing steps as used: 4, 8, 12, 16; then the component sizes 44, 48, 64.

## Elevation & Depth

Flat.
No `box-shadow`, no blur, no glass.
Depth is tonal: ground under panel under raised, with 1 px hairlines where two panels meet (a right border on the sidebar, a left border on the inspector, a pseudo-element line under the top bar and over the bottom bar, a bottom border on every node).
Hover lifts a control one tonal step (transparent to raised); press lifts it two (to hairline).
The one gradient in the stylesheet is the range track's two-stop hard fill from `secondary` to `hairline` at the thumb; it is a fill mechanism with no visible ramp, not decoration.

### Named Rules
**The Tonal Step Rule.** A state change moves a surface exactly one step up the gray ramp.
Nothing floats.

## Shapes

Rectangles with 4 px corners on controls (buttons, range inputs, layer thumbnails, swatches) and square corners on rows that span their column (layer rows, node disclosures).
Round shapes are reserved for the mechanical: range thumbs (16 px, 20 px on Fry), the switch knob (14 px), the Ready dot (6 px).
The enable switch is a 36 x 20 px pill with a 10 px radius.
Outlines, not borders, mark selection and focus, and they are inset (`outline-offset` -1 px for selection, -2 px for focus) so a highlighted element never grows.
The only inline icon is a 16 px chevron drawn as a 1.5-stroke SVG path; there is no icon font and no glyph set.

## Components

### Buttons
- **Shape:** 4 px radius, 44 px minimum height, 16 px side padding, no border, text at 13 px.
- **Default (top-bar actions, Deselect, Original, mode rail):** transparent on the panel; hover `raised`, active `hairline`, disabled text in `secondary` with no hover.
- **Primary (Download):** `accent` fill, `ground` text at weight 600; hover brightens 10%, active darkens 10%; disabled falls to `raised` fill with `secondary` text.
  Its focus ring is `text`, inset 4 px, because an accent ring on an accent fill would vanish.
- **Empty-state (Open, Try a sample on the stage):** `raised` at rest, `hairline` on hover, so they read as buttons on the ground where the panel hover step is invisible.
- **Toggle (mode rail, Original):** carries `aria-pressed`; pressed is `raised` with `text`, and the mode rail adds a 1 px inset `accent` outline.
  Mode-rail labels are 12 px.

### Layer rows
- A full-width button, 64 px tall, square-cornered, 8 px vertical and 16 px side padding, 12 px gap.
- A 48 px square thumbnail (2D canvas, 4 px radius, `ground` well) and a single-line name that ellipsizes.
- Selected: `raised` fill, a 1 px inset `accent` outline on the row and on the thumbnail.
  The Plate row is selected when nothing else is.
- Empty: the hint "Tap the picture to add a layer" at 12 px `secondary`, 12 px above and 20 px below, shown only while the plate is the only layer.

### Panel headings and scene facts
- **Panel heading:** 44 px, 11 px caps tracked 0.08 em in `secondary`, 16 px padding; used for LAYERS and SCENE.
- **Scene facts:** a definition list at 12 px, each row 28 px, term in `secondary` left, value right-aligned.
  A ready value carries a 6 px `success` dot; its timing follows at 11 px `secondary` with 8 px before it.
- **Local models:** one 11 px `secondary` line, 16 px above, no divider.

### Viewer toolbar and stage
- **Toolbar:** 32 px, 12 px `secondary` text, a hairline below; today it holds the fit percentage.
- **Stage area:** 16 px padding on `ground`, the canvas centered and contained, crosshair cursor over the picture.
- **Empty stage:** "Drop a photo" at 13 px `secondary`, then the two empty-state buttons 8 px apart, stacked with 16 px gap; the whole area is the drop target.
- **Busy:** the stage area carries `aria-busy` while importing; Reset and Download disable; nothing else changes.

### Inspector nodes
- **Scope heading:** 44 px, 13 px at 600, 14 px vertical padding, hairline below, ellipsizes.
- **Node:** a section with a hairline below; its header is a 44 px row holding a disclosure button and an optional enable switch.
- **Disclosure:** full-width, square-cornered, 13 px at 600, 8 px gap to a 16 px chevron in `secondary`; the chevron rotates 90 degrees when expanded over 140 ms ease-out.
  Expanded state is `aria-expanded`; collapsed controls are `hidden`.
- **Object node:** appears above Fry only with a selection; its heading is the object's name at 40 px, 13 px at 600, with the swatches beneath.
- **Default expansion:** Fry, Palette, and Camera open; Motion and Symbols closed.

### Range rows
- A label element laid out as a 44 px grid: 96 px label, the input, a 48 px right-aligned value; 8 px gap, 16 px side padding, 12 px type.
- The input is a native range restyled: a 6 px track with 3 px radius, filled `secondary` to the left of the thumb and `hairline` to the right, driven by a `--fill` percentage the component writes; a 16 px round `accent` thumb.
  Hover rings the thumb in `text`, 2 px, offset 2 px.
- The value is an `output` in `secondary`, tabular, 48 px wide.
- **Fry dial:** the row grows to 48 px, the label is visually hidden, the input spans the label and input columns, the track is 8 px and the thumb 20 px, and the value is 13 px in `text`.

### Enable switches
- A 52 x 44 px label cell holding a 36 x 20 px pill: 1 px `secondary` border on `ground`, a 14 px `secondary` knob with 2 px margin.
- On: `accent` fill and border, the knob turns `ground` and slides 16 px.
- Hover: border turns `text`.
  Focus: a 2 px `accent` outline on the cell, inset 2 px.
- Background, border, and knob position transition over 140 ms ease-out; reduced motion sets the duration to 0.
- The switch and its mode-rail button share one state; flipping either moves both.

### Swatches
- A fieldset with 16 px side padding and 4 px below; a 44 px action row (Original as a toggle, Deselect) with 8 px button padding; then a four-column grid of 40 px swatches with 4 px gaps.
- Each swatch is its OKLCH color as background, 4 px radius, a 2 px transparent border, an `aria-label` and a hidden name.
  Hover brightens 10%; pressed turns the border `text`; focus turns the border `accent` and adds a 2 px `ground` outline inset 5 px so the ring reads on every hue.
- The eight swatch colors (Coral, Orange, Gold, Green, Turquoise, Blue, Violet, Pink) live in `swatches.tsx` as OKLCH and are content, not shell tokens.

### Mode rail
- Centered in the bottom bar, 4 px gaps, 16 px side padding, 12 px labels.
- Each mode is a toggle button with `aria-pressed`; pressed is `raised` with `text` and a 1 px inset `accent` outline.
  The rail is empty until a photo is open.

### Status line
- The left cell of the bottom bar, 16 px from the edge, 13 px `text` at a 16 px line, `role="status"`, wrapping anywhere.
- It speaks in the product's voice: short declarative sentences, the product in the third person, no exclamation marks.
- The right cell is the build line: 11 px `secondary`, 12 px gaps (8 px under 1350 px), never wrapping.

### Focus
- Global: a 2 px `accent` outline inset 2 px on any `:focus-visible`.
- Exceptions, each because the accent would vanish: the primary action (`text` ring, inset 4 px) and swatches (`ground` ring inset 5 px plus an `accent` border).

## Do's and Don'ts

### Do:
- **Do** make every new bar, heading, node header, range row, and button 44 px; a layer row is 64 px and the Fry dial row is 48 px.
- **Do** add a node as a `Node` with a title-case name, a hairline below, the chevron disclosure, and range rows at 12 px with a 48 px value field; put an enable switch in the header only if the node can be turned off.
- **Do** add a mode as a toggle button in the mode rail with `aria-pressed`, 12 px label, sharing state with the node's enable switch so both flip together.
- **Do** take colors from the ten `:root` tokens and sizes from 13, 12, 11; take spacing from 4, 8, 12, 16.
- **Do** mark hover with one tonal step up and press with two; mark selection with a 1 px inset `accent` outline on a `raised` fill.
- **Do** keep the accent on the Download button, focus, selection, thumbs, and switches that are on, and nowhere else.
- **Do** keep the status line as the page's only voice, at 13 px in `text`, readable over the fried image.
- **Do** honor `prefers-reduced-motion` by zeroing the 140 ms transition, as the switches and chevrons already do.

### Don't:
- **Don't** use pure black, a shadow, a blur, glass, or a decorative gradient; the range track's hard two-stop fill is the only gradient allowed.
- **Don't** introduce an icon font, a glyph set, or a second inline icon style; the 16 px 1.5-stroke chevron is the only icon.
- **Don't** add a display face, a wordmark, a kicker, an eyebrow, or an uppercase heading outside the two sidebar panel headings.
- **Don't** set text below 11 px or add a fourth type size.
- **Don't** render an accent-colored focus ring on an accent-colored surface; use the `text` or `ground` ring the primary action and swatches use.
- **Don't** animate anything but switch fill, switch knob, and disclosure chevron, and never at a duration other than 140 ms ease-out.
- **Don't** give a row a radius; 4 px belongs to controls, 0 to rows that span their column.
- **Don't** fill a range track with the accent; the fill is `secondary`, the thumb is the accent.
