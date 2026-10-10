# The rehearsal script

> Owns: the 90-second demo as Nathan performs it, the operator steps around it, and the recovery moves.
> Does not own: the checklist before leaving (`plan/demo.md` section 10) or the plan.

## Before the judges arrive (five minutes)

1. In a terminal in `~/dev/sandbox/noisy-demo`: `npm run build:production && node tools/serve.mjs --mode production`. Leave it running.
2. Chrome, one window, one tab, zoom 100%: `http://127.0.0.1:8790/`. Wait for the status line to pass `Fetching models` and reach `Drop a photo` (the models are in Cache Storage after the first load; a reload later is instant).
3. Click `Try a sample` once, watch it reach `Ready to tap`, tap something, press `Reset`. The pipeline is warm.
4. iPhone: Camera > Formats > Most Compatible is set; AirDrop is on; the Mac's Finder Downloads folder is open in the Dock so the AirDropped JPEG is one drag away.

## The 90 seconds

| beat | Nathan says | Nathan does | what the judges see |
| --- | --- | --- | --- |
| 0 s | "Let me take your picture." | photographs the judges; AirDrop to the Mac | the JPEG lands in Downloads |
| 10 s | "This runs entirely in the browser. Nothing leaves this laptop." | drags the JPEG onto the page | within a second the photo is fried: quantized, outlined, grainy |
| 20 s | "Three neural nets are running in WebAssembly right now: depth, a segmenter, an inpainter." | points at the status line | `Analyzing: depth`, `Analyzing: encoder`, `Ready to tap` in about five seconds |
| 30 s | "You can push the look around." | hands a judge the trackpad; `Fry`, then `Bands`, `Crunch` | the picture follows every drag instantly |
| 45 s | "Tap yourself." | the judge taps a face | the person outlines within a blink; swatches appear |
| 55 s | "Pick a color." | the judge picks a swatch | only that person recolors; the judge taps another |
| 65 s | "And it breathes." | flips `Symbols` on and off, then `Motion` on | glyph cells fill the frame; then the parallax loop, the background filled in behind them |
| 80 s | "Yours to keep." | `Download`, AirDrops the PNG to the judge | the PNG arrives on their phone |

## Recovery moves

- The photo arrives as HEIC: on the Mac, `sips -s format jpeg in.heic --out out.jpg`, ten seconds. Better: the camera is set to Most Compatible before the event.
- The tap finds nothing (`Nothing there`): tap closer to the center of the person.
- The status shows `Analysis timed out` or a failure sentence: press `Reset`, or drop the photo again; the first look is already on screen either way, keep talking about the sliders.
- The page looks stuck: reload; the models are cached and the page is usable in two seconds. Then `Try a sample` while the judge's photo is dragged in again.
- Everything is down: the rehearsal recording from C3 plays from the desktop.

## What to say if asked

- Models: Depth Anything V2 Small, SAM 2.1 Hiera Tiny, MI-GAN, all through ONNX Runtime Web on plain WebAssembly, about 117 MB fetched once and cached.
- Speed on this Mac: depth about 2 s, the segmenter about 2.4 s, a tap about 0.15 s, the inpaint about 0.8 s, a full redraw about 6 ms.
- Why it looks like this: a hand-written WebGL2 pipeline, label-aware simplification, a merged palette with band windows, outlines from texture edges and depth, grain from an integer hash, JPEG-style crunch, procedural glyph cells, a parallax loop over the depth map with the inpainted plate behind.
