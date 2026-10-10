# noisy v1 specification

> Owns: the Gate 1 problem statement for noisy v1 - outcome, required behavior, constraints, non-goals, and the questions still open.
> Does not own: research findings (`research-*.md` beside this file), decisions and their evidence (`decisions.tsv`), or the design (`design.md`, not yet written).

Written 2026-09-28 from the owner's idea in the daily note of that date and their answers in the first planning session.

## Outcome

A personal tool that takes a photo from the owner's iPhone and fries it into a vivid, cartoon-like scene.
Colors are reduced to a few harmonized, oversaturated ones.
Objects are simplified to their shape and outline but keep their shading.
Everything carries the heavy, raw grain of an early-2000s point-and-shoot camera.
The owner can then recolor objects, mix in keyboard-symbol rendering, animate objects and the camera into a seamless loop, and add lights that throw rays and cast shadows.

## Users and devices

- One user, the owner.
  No accounts, no sharing features, and no hosted service with a recurring bill unless the owner approves that cost.
- A web app used on both the iPhone and the laptop: quick looks on the phone right after shooting, detailed object and lighting work on the laptop.
- The owner asked for the tool to be "fairly basic and simple"; the interface stays small even though the pipeline behind it is not.

## Input

- Still photos from the owner's iPhone, HEIC or JPEG.
- Video input is out of v1 and is a later milestone.
  The core must accept it later without a rewrite: a photo is treated as a clip one frame long.

## Required behavior

### 1. The look

- The photo collapses to a small palette of vivid, harmonized colors, instead of the many colors a real photo has.
- Objects simplify to their basic shape and outline, and their shading stays as tone bands, so the scene keeps texture.
- The subject stays clearly visible even when everything else is fried hard.
  Objects around it are simplified but never disappear.
- Grain and texture imitate an early-2000s point-and-shoot: sensor noise, color noise, compression crunch, clipped highlights.
- Every control updates the image live.

### 2. Objects and recolor

- After the first pass, the owner selects objects by tapping or clicking.
- A selected object can be recolored, and the scene's colors stay in harmony with it.
  The owner's example: a frog on a blue background, where the frog becomes bright green and the background bright blue, and the two harmonize.

### 3. Keyboard symbols

- Symbols such as `+`, `-`, `*`, and `#` stand in for pixels in shadows and highlights.
- The whole frame is not symbols.
  A slider decides how much of the image becomes symbols; the rest stays colored pixels.
- Pixels and symbols share one cell grid that covers the whole image when symbols are on.
  Cell size is a slider: bigger cells mean fewer, larger symbols and chunkier pixels.
  Each cell is either one solid color or one symbol, and grain is applied after the grid so the texture survives.
- The symbol slider works by tone from the extremes inward: low values turn only the deepest shadows and brightest highlights into symbols, and higher values take in the midtones.
- Any object can be set to always be symbols or never be symbols, overriding the slider.

### 4. Motion

- Selected objects move slightly: wobble, bob, or sway.
- A seamless 3D parallax loop: the scene is split into layers by distance from the camera, and a virtual camera moves slightly.
  Pixels revealed behind moved layers are filled in.
  The loop renders about 4% zoomed in so the camera never reaches past the real frame edge; no pixels are generated beyond it.

### 5. Lighting

- The owner adds light sources to the scene.
- Light produces rays, lights up the surfaces that face it, and makes objects cast shadows onto the layers behind them.
- Lighting sits inside the stylized look, in its banded shading, rather than on top of a photoreal render.

### 6. Saving and output

- A scene saves and reopens with its photo, analysis, and every setting intact.
- Loops export as MP4 and GIF, and stills as PNG, in a form the owner can share from the phone.

## Constraints

- Production quality, not a prototype.
- The look is deterministic shader math.
  Models are used only to analyze the photo (what is where, and how far away), once per photo, with the results cached.
- Full-resolution iPhone photos (12 to 48 megapixels) are the input.
  The working resolution for analysis and rendering depends on the runtime research.

## Non-goals for v1

- Video input.
- Accounts, multiple users, sharing, or a cloud gallery.
- Photorealistic relighting.
- Large camera moves or camera tracking.

## Open questions

- Whether the analysis models run reliably in iPhone Safari.
  The owner chose to keep the web app and settle this with an on-device test before design; if it fails, native and cloud analysis go back to the owner.
