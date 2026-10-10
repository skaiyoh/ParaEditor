# The Figma board: flow and panel map

> Owns: the UX planning material for the Figma Best Design track, derived from the direction contract (`.impeccable/surfaces/src-ui-app-tsx.md`) and the six minutes (`plan/demo.md` section 0). Nathan lays it out in Figma; this file is the source.
> Does not own: the visual decisions (the contract) or the product truth (`PRODUCT.md`).

## 1. The user flow (one frame, left to right)

Draw each beat as a box with the control the person touches under it; arrows left to right; the status sentence the page shows at that beat in a small label above the box.

| beat | who | touches | the page says | what changes |
| --- | --- | --- | --- | --- |
| 1 | Nathan | drops the JPEG, or Open, or Try a sample | `Importing…` then `Analyzing: depth` | the first look is on the stage within a second |
| 2 | Nathan | Fry (the dial), then Bands, Crunch | `Ready to tap` after about five seconds | the look follows every drag |
| 3 | judge | taps a person on the stage | `Ready to tap` | the Object node appears with the swatches; the layer row is selected |
| 4 | judge | picks a swatch | `Ready` | only that person recolors |
| 5 | Nathan | Motion in the bottom strip | `preparing` then `Ready` | the scene breathes; the plate fills the background |
| 6 | judge | Window in the bottom strip, then leans | `Ready` | the picture turns with their head |
| 7 | Nathan | Send to 3DS, hands over the console | `Ready` | the pair shows in 3D on the handheld |
| 8 | Nathan | Download | `Ready` | the PNG saves; AirDrop to the judge |
| 9 | Nathan | Finder, Quick Look | (outside the page) | the finished pieces, one by one |

Error paths as dashed arrows back into the flow: HEIC refused (`Chrome can't open HEIC photos…`), tap finds nothing (`Nothing there`), analysis timed out (Reset or drop again), camera denied (`Camera unavailable`, Window stays off), 3DS bridge not running.

## 2. The panel map (one frame, the 1440 x 900 shell)

Draw the shell as five regions with their contents listed inside; the measurements are the contract's.

- Top bar, 44 px: photo name (left); Open, Try a sample, Send to 3DS, Publish, Reset, Download as the primary (right).
- Left column, 272 px: LAYERS (plate, objects with thumbnails; selection scopes the inspector; "Tap the picture to add a layer"), SCENE (master size, depth, encoder and plate with timings, "4 models local").
- Center: viewer toolbar, 32 px (fit percentage, Before/After); the stage, the largest element, 16 px margins.
- Right inspector, 360 px: scope header ("Scene" or the object's name); nodes in order: Object (swatches, with a selection), Fry, Motion, Symbols, Palette, Camera, later Effects. Each node: header with its enable switch where one exists, sliders with a value field.
- Bottom strip, 40 px: status sentence (left); modes as toggles (Motion, Symbols, later Window and 3DS stream) (center); build id (right).

## 3. States (one frame, six thumbnails)

Boot (`Fetching models 37%`, the stage as a drop target), empty (`Models ready - drop a photo`), importing, ready (`Ready to tap`, one layer), selected (the Object node and the selected layer row), motion (the strip's Motion toggle pressed, `preparing` then the loop).

## 4. Principles to write on the board

1. The picture leads; the status line, not the picture, says when more is possible.
2. Nothing leaves the laptop unless the person publishes.
3. Every control is live and direct.
4. Tools are grouped by their nature, editing-suite style, and all stay reachable.
5. Keyboard: Tab in reading order, Escape deselects, visible focus; targets 44 px; the swatches named.
