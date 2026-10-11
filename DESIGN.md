---
name: noisy
description: A touch-first photo editor in a neutral-gray room; the photo carries all the color, and one crunched near-white key carries the identity.
colors:
  ground: "#1A1A1A"
  panel: "#262626"
  raised: "#2E2E2E"
  hairline: "#3A3A3A"
  text: "#E6E6E6"
  secondary: "#A3A3A3"
  key: "#F2F2F2"
  error: "#F85149"
typography:
  type-ui:
    fontFamily: "system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "\"tnum\""
  heading:
    fontFamily: "system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "16px"
  type-label:
    fontFamily: "system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  type-meta:
    fontFamily: "system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  section-label:
    fontFamily: "system-ui, -apple-system, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "12px"
    letterSpacing: "0.08em"
rounded:
  radius: "8px"
  r-float: "12px"
  sheet: "16px"
  pill: "999px"
  circle: "50%"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  target: "44px"
  bar: "52px"
components:
  button-key:
    backgroundColor: "{colors.key}"
    textColor: "{colors.ground}"
    typography: "{typography.heading}"
    rounded: "{rounded.radius}"
    padding: "0 16px"
    height: "{spacing.target}"
  button-key-disabled:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.secondary}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.type-ui}"
    rounded: "{rounded.radius}"
    padding: "0 16px"
    height: "{spacing.target}"
  button-quiet-hover:
    backgroundColor: "{colors.raised}"
  button-quiet-active:
    backgroundColor: "{colors.hairline}"
  button-raised:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    padding: "0 12px"
    height: "{spacing.target}"
  button-raised-hover:
    backgroundColor: "{colors.hairline}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    size: "{spacing.target}"
  top-bar:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.type-label}"
    height: "{spacing.bar}"
  floating-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-float}"
    width: "336px"
  context-bar:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.r-float}"
    padding: "6px"
  mode-pill:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.pill}"
    padding: "4px"
  fry-rail:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.r-float}"
    width: "56px"
  phone-sheet:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.sheet}"
  text-input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    padding: "0 8px"
    height: "{spacing.target}"
  swatch:
    rounded: "{rounded.circle}"
    size: "36px"
---

# Design System: noisy

> **Owns:** the shipped visual system of the editor (full and compact tiers) and the public gallery, derived from `src/assets/app.css` and `src/ui/` as built.
> **Does not own:** requirements and the feature inventory ([plan/handoffs/ui-redesign.md](plan/handoffs/ui-redesign.md)), design decisions ([plan/evidence/RS1-decisions.md](plan/evidence/RS1-decisions.md)), the gallery's product decisions ([plan/evidence/GAL1-design.md](plan/evidence/GAL1-design.md)), or product context ([PRODUCT.md](PRODUCT.md)).
> The sidecar [.impeccable/design.json](.impeccable/design.json) carries motion, breakpoints, ramps and component snippets.

## Overview

**Creative North Star: "The Neutral Room"**

noisy's shell is a colorist's neutral-gray suite.
The chrome holds no color, so the photo's colors read true, and the only fried thing outside the picture is the view's key: Download in the editor, Done while selecting.
The mood is exact, quiet and dense: panels pack their controls tightly, while the canvas runs full-bleed under everything.

The tool grammar is Procreate's own toolbar map at touch scale, with rounder controls: tools in the top corners, Fry as a vertical rail on the left edge, floating panels that open one at a time under their icons, a context bar for the tapped object or the active tool, and a mode pill at the bottom.
Procreate joins Photoshop and Resolve as the reference for the touch tool grammar.
The early-2000s identity lives in the type, the crunched key and the status voice, never in the chrome's color.

The same mounted editor serves two tiers.
The full tier (width at least 744 px and height above 500 px: iPad landscape and portrait, desktop) floats its panels over the picture.
The compact tier (phones) hosts the same panels in one tabbed bottom sheet.
The public gallery lives in the same room: a strip, a masonry grid of posters, then a framed piece on Room Ground.
Further tools join the map as their stages land.

**Key Characteristics:**
- Mid-dark neutral grays with no accent; near-white marks focus, selection, thumbs and switches.
- One crunched near-white key per view.
- Flat: floating surfaces get the panel fill and a 1px hairline, never a shadow.
- 8px controls, 12px floating surfaces, pills, round swatches.
- System type at three sizes (13, 12, 11), tabular numerals throughout.
- 44px touch targets in both tiers, with 36px swatches as the one deliberate exception.

## Colors

Achromatic grays stepped a few points of lightness apart, one near-white key, and color only where the user put it.

### Primary
- **Key White** (key): the crunched key's base under its texture, and nothing else.
  It is the one bright fill in any view.

### Neutral
- **Room Ground** (ground): the page and the stage behind the photo, the inside of text inputs and segmented trays, and the key's label color.
- **Panel Gray** (panel): every surface that holds controls: the top bar, floating panels, the Fry rail, the context bar, the mode pill, the phone sheet, the gallery strip and dialogs.
- **Raised Gray** (raised): the hover fill on quiet buttons, the fill of pressed and selected items, and the disabled key.
- **Hairline Gray** (hairline): every 1px divider and floating-surface border, the press fill, the unfilled slider track, and text selection.
- **Near-White Text** (text): body text and every state mark: focus outlines, selection outlines, slider thumbs, the on switch, the pressed swatch ring.
- **Secondary Gray** (secondary): metadata, values, help text, section labels, disabled labels, the filled part of slider tracks, and the off switch.

### State
- **Error Red** (error): the border of an invalid field (a layer name or a hex value).
  State color exists to mean something and never decorates.

### Named Rules
**The Neutral Room Rule.**
The chrome has no accent: focus, selection, slider thumbs and switches are near-white, and a selected item is raised with a 1px near-white outline.

**The User's Color Rule.**
The only chromatic pixels in the chrome are the user's own color: the Color dot, the picker's field and hue strip, and the swatches.

## Typography

**UI Font:** system-ui (with -apple-system, "Helvetica Neue", Arial, sans-serif)

**Character:** One system face at three sizes, set dense and numeric, like a tool panel rather than a page.
Tabular numerals are on at the root, so values never jitter as sliders move.

### Hierarchy
- **Heading** (600, 13px, 16px): panel titles, the scope heading, object names, the gallery's title, and the key's label.
- **UI** (400, 13px, 16px): the base size for controls, notices and the status line.
- **Label** (400, 12px, 1.5 for prose): slider labels, secondary buttons, help text, scene facts, the photo name in the top bar.
- **Meta** (400, 11px): timings, published times, build details, the piece count.
- **Section label** (600, 11px, 0.08em, uppercase, secondary): the heading of a section inside a panel (Photo, Scene, Build, Share, Compare); it is the section's only heading, never a kicker above another one.

### Named Rules
**The Three Sizes Rule.**
Type is 13, 12 or 11 px; hierarchy comes from weight 600 and the secondary gray, never from a bigger size.

## Layout

**Full tier.**
A 52 px top bar (panel fill, hairline below, safe-area aware) holds the left tool cluster (Projects, Actions, Adjustments, Selection), the centered photo name and target with its magnification readout, and the right cluster (Layers, the Color dot, Download), with 1 by 24 px hairline separators between groups.
The readout appends Selection or the selected layer's name to the photo name; its Fit button shows a fit icon and the magnification percentage, with no visible "Fit" prefix.
The stage fills everything below it; the photo is padded 24 px, with the left side clearing the Fry rail and the bottom clearing the pill.
The Fry rail floats 16 px from the left edge, vertically centered in the stage.
Floating panels open 8 px under the bar: left-cluster panels at 88 px from the left so the rail stays usable, right-cluster panels 16 px from the right; 336 px wide (Projects 360 px).
A panel's bottom stays clear of the bottom band, which belongs to the status (bottom left), the mode pill (bottom center, 16 px up) and the context bar (just above the pill).
Notices sit in one centered slot at the top of the stage and recenter in the space an open panel leaves; panels never move for a notice.

**Compact tier** (width under 744 px, or height 500 px and under).
A 52 px top strip holds Actions, Adjustments, Selection, Layers and Color as icon-only tools, followed by Download.
The photo sits below it, with the Fry rail at the left edge and, in portrait, the mode pill and a two-row context bar spanning the width above one bottom sheet.
The photo name, target and magnification occupy their own 52 px band above the picture, in a panel-filled float with a hairline and 12 px corners that clears the Fry rail.
The picture clips both zoomed pixels and the selection outline below that band.
On phones Undo and Redo sit in the sheet header beside the grab handle and status.
The sheet collapses to its 44 px heading and expands to about 46% of the height with four tabs: Adjust, Layers, Color, Actions.
Projects is the first row of Actions, above Photo; the UI session moved it there to make room for Selection in the strip.
Choosing a row in Layers keeps the sheet open so its rename, visibility and delete controls stay at hand, a UI-session decision.
Opening Selection collapses the sheet to leave room for the selection gesture and bar.
At widths of at least 600 px and heights of at most 500 px, the expanded sheet shares its heading line with the tabs so 44 px controls still fit.
On landscape phones the context bar is one row of name, swatches, actions and close, and the mode pill sits in the top strip between Color and Download.
At landscape widths of 700 px and under, the pill stays above the sheet when neither context bar is present and hides while the object or Selection bar is shown; Motion, Symbols and Parallax remain available in Adjust.
The Fry rail has half opacity when its input is disabled.

**Gallery.**
A 52 px strip, then a masonry grid with 12 px gutters: two columns, four from 1180 px, five from 1440 px.
The piece page is one safe-area-aware 100dvh screen with three grid rows: the quiet top line, a shrinking stage, and controls centered at the bottom in normal flow.
The picture is centered in the stage with 16 px padding, increasing to 24 px from 744 px wide.
Its aspect follows the document master size once loaded and the poster natural size beforehand, with canvas and poster filling the same clipped box inside a 1 px hairline and 8 px corners.
The piece status notice overlays the stage's top edge, and the document disables scrolling and bounce only while the piece page is mounted.
The timestamp aligns with the adjacent 44 px controls, and quiet piece controls carry the floating surface hairline.
A centered 11 px secondary hint follows a nonempty grid.
On touch devices the hint starts with "Tap a piece to step into it."
It follows with "Tilt to look around."
On pointer devices it reads "Click a piece to step into it."
Pressed grid images dim to 90% brightness.
Preparation and piece status notices use the 12 px floating radius, matching the notice slot.

**Rhythm.**
Spacing steps are 4, 8, 12, 16 and 24 px; panel content is inset 16 px, and rows sit on 44 px minimums.

## Elevation & Depth

The system is flat.
Depth comes from the panel fill against the ground and a 1px hairline border, never from a shadow or blur.
Stacking order alone separates the picture, the floating tools, the open panel and the notice slot.

### Named Rules
**The Flat Float Rule.**
Anything floating over the picture gets the panel fill and a 1px hairline, with no shadow.

## Shapes

Rounded and touch-scale.
Controls round at 8px (radius); floating surfaces (panels, the rail, the context bar, notices, dialogs) at 12px (r-float); the phone sheet's top corners at 16px (sheet).
The mode pill, its buttons, slider tracks and the hue strip are pills; swatches, slider thumbs, the Color dot and the switch knob are circles.
Rows inside a list are square-cornered so they tile, except Layers rows in the full tier, which take the control radius.
Icons are one family: 20px, 1.5px stroke, round caps and joins, drawn in the current text color.

## Components

### Buttons
Quiet until touched, with a single bright exception.
- **Shape:** 8px corners, 44px minimum height, 16px side padding (12px in tool clusters).
- **The crunched key:** Key White carrying noisy's crunch texture, a 64px tile of 8px blocks at full strength (Fry 1.00), upscaled pixel-sharp to the device ratio and independent of the scene's Fry; a Room Ground label at 600 beside its icon.
  Hover brightens it 5%, press darkens it to 90%, focus draws a ground-colored ring inset 4px, and disabled drops to Raised Gray with a secondary label and no texture.
- **One key per view:** Download in the editor; Take a photo (touch) or Open on the empty stage, where touch devices also offer Open as a raised button; Make one in the gallery; Publish or Unpublish inside the share confirmation; Tilt to look on a touch piece page.
  While Selection is active, Done becomes the view's crunched key and Download becomes quiet in both tiers.
- **Quiet:** transparent with text color; Raised Gray on hover, Hairline Gray on press, a secondary label when disabled.
- **Raised:** a Raised Gray fill for secondary choices beside the key (the empty-stage actions, loop export, Apply), Hairline Gray on hover.
- **Icon button:** a 44px square with the 20px icon centered.
- **Pressed or open:** Raised Gray with a 1px near-white outline inset 1px; focus thickens the outline to 2px.

### Floating panels
- **Corner Style:** 12px.
- **Background:** Panel Gray with a 1px hairline and no shadow.
- **Behavior:** one open at a time, toggled by its opener, never closed by a canvas tap; fades in over 140ms and scrolls inside.
- **Inside:** a 44px title row (heading left, secondary scope right) over a hairline, then sections led by a section label, inset 16px.

### Context bar
The tapped object's bar holds a 32px thumbnail, the name (tap to rename), round 36px swatches, object actions and a close button, in a 12px floating bar with 6px padding.
On portrait phones it becomes two rows: name, actions and close over a scrolling swatch row, with the thumbnail hidden.

### Selection bar
Selection replaces the object's context bar with two ground-filled segments: Rectangle / Freehand for shape, Replace / Add / Remove for mode.
The options follow in order: the Invert icon, Feather, Clear, Clip, the space chip and Done.
Feather and Clip keep visible text labels above their 44 px range inputs, with secondary numeric values: 0-64 px for Feather and 0.00-1.00 for Clip.
Invert, Feather, Clear and Clip are disabled without a selection mask or while selection work is pending.
Clip applies a local clipping treatment to the selection.
The secondary 11 px pill says `on Photo` or `on <layer name>`, with a hairline, ellipsis for long names and the full space in its title.
The "on " prefix is hidden on phones in either orientation; the chip can shrink between Clip and Done.
The full-tier bar wraps when needed; portrait phones put the shape and mode segments above the options, while landscape phones keep one row.
Done returns to object selection without clearing the mask; Clear removes the selection.
The screen-only outline lays a 1.5 px dashed ground-colored stroke over a near-white base, marching through 4 px dashes and gaps in a one-second linear loop.
The outside of the selected region dims; reduced motion stops the marching outline.

### Mode pill
A pill of Motion, Symbols and Parallax (plus Recenter while Parallax is on), each a pill button with icon and label; on is Raised Gray with a 1px near-white outline.

### Fry rail
A 56px floating column in the full tier: the 11px secondary "Fry" label, a vertical native range with a 6px track and a 28px near-white thumb, the value in text color, a 32px hairline rule, then Undo, Redo and Hold to compare source photo.
The phone rail is 52 px wide and ends at the value; Undo and Redo live in the sheet heading.
The track fills from the bottom in secondary over hairline.

### Inputs / Fields
- **Sliders:** native ranges with a 44px hit area, a 6px pill track (secondary fill over hairline) and a near-white circular thumb (16px; 20px in the full tier); hover rings the thumb 2px in near-white.
  A slider row is a 96px label, the slider, and a 44px right-aligned secondary value.
- **Switches:** a 36 by 20 pill; off is a ground fill with a secondary border and knob, on is a near-white fill with a ground knob; 140ms.
- **Text fields:** Room Ground fill, 1px border, 8px corners, 44px tall; layer rename uses a secondary border and turns Error Red when invalid.
- **Segmented controls:** a ground-filled 8px tray with 4px padding; the chosen segment is raised with a 1px near-white outline.

### Color
- **Color dot:** a 26px circle with a 2px panel-colored ring and a 1px near-white outline, showing the selected object's recolor, its Original mark, or the last palette color when no object is selected.
- **Target:** the secondary label beside Color reads Selection when a mask exists, otherwise the layer's name or "Select an object".
  This target readout is text in the title row, without a separate pill border.
- **Treatment:** a Recolor / Fill segment appears below the title only when a selection exists, using the ground tray and raised, outlined active segment.
  The picker applies the chosen treatment locally to that selection.
- **Picker:** a 168px-high saturation-value field and a pill hue strip with near-white cursors, a split chip of current and previous color, hex and RGB fields, Edited / Source sampling with a sampler button, and Recent and Presets groups of 36px circular swatches.
- **Swatch states:** a pressed swatch takes a 2px near-white border; hover brightens it 10%.
- **Swatch size:** the object's bar uses 36px circles with 4px gaps in both tiers, so eight fit one row with Original; the Color panel distributes its 36px swatches across wrapping rows.
  The UI session kept the swatches at 36px so the shortcut row fits, the one deliberate exception to the 44px target.

### Layers
Plate and object rows use 48px square photo thumbnails with ground-filled wells and 8px corners; the selected thumbnail gets a near-white outline.
Object thumbnails crop a square around the object's bounds, clipped to the source photo.
A secondary 12px line below the rows reads "Layers overlap in saved order" or "Layers overlap by scene depth", following the session's overlap policy.

### Navigation
- **Top bar and strip:** Panel Gray, 52px plus the safe-area inset, hairline below.
- **Phone tabs:** equal-width tabs over a hairline; the selected tab is raised with a 2px near-white underline.
- **Precision view:** two-finger gestures pan and pinch the authoring view; + or = zooms in, - zooms out, and 0 or the Fit button returns to fit.

### Status line
The status voice: one plain sentence in UI type, bottom left in the full tier and in the sheet heading on phones, announced as a live status.
When Selection is active and the photo is ready, the prompt follows the mode: "Drag to select", "Drag to add" or "Drag to remove"; pending selection work reads "Selecting…".
With an object tapped and nothing else in progress, the ready prompt becomes "Hold, then drag sideways to refine".
In the full-tier Actions panel, Share follows the Photo and Compare sections, ahead of the Scene and Build diagnostics.
Over a zoomed authoring picture, the full-tier status gains panel fill, a hairline, 12px corners and 6px by 8px padding so it stays legible.

## Do's and Don'ts

### Do:
- **Do** keep every chrome mark achromatic: state is Raised Gray plus a 1px near-white outline, and focus is a 2px near-white outline.
- **Do** give each view exactly one crunched key, with its texture at the fixed full-strength tile whatever the scene's Fry.
- **Do** float tools over the full-bleed picture with the panel fill, a 1px hairline and a 12px corner.
- **Do** keep one panel open at a time, opened under its own icon, and put object options in the context bar.
- **Do** hold touch targets at 44px in both tiers, except the 36px swatches.
- **Do** draw every icon from the 20px, 1.5-stroke family.
- **Do** keep interface transitions to a 140ms ease-out fade or turn; the selection outline uses a one-second linear march, and both stop under reduced motion.
- **Do** host the full tier's panels in the compact tier's sheet rather than inventing a second layout.

### Don't:
- **Don't** add an accent color to the chrome; the only chromatic pixels are the user's color and Error Red on an invalid field.
- **Don't** put a shadow, glow or blur under anything; depth is fill and hairline.
- **Don't** apply the crunch texture to anything but the key, or put two keys in one view.
- **Don't** set type above 13px or add a display face; hierarchy is weight and gray.
- **Don't** show a tool whose stage has not landed, disabled or otherwise.
- **Don't** let a notice push a panel; the notice recenters in the space the panel leaves.
