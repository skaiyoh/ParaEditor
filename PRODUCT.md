# Product

<!-- impeccable:product-schema 1 -->

> Owns: the durable product truth impeccable reads before any design work in this clone: who uses the page, what it does, what must be preserved, and which product facts are still open.
> Does not own: the demo plan and its packages (`plan/demo.md`), the rehearsal (`plan/rehearsal.md`), the look rules (`plan/evidence/look-rules.md`), or any visual decision (a direction contract or `DESIGN.md` written later).

Interviewed 2026-10-09 with Nathan (13:20 and 22:00 EDT); repository facts are from the clone at that date.
Facts marked "planned" are decided but not built; the Capabilities section says what exists today.

## Platform

web

## Users

- During the demo: a Knight Hacks IX judge beside Nathan's MacBook for six minutes including questions, in one general room and one room per sponsor track.
  They have never seen the app.
  Nathan builds a look live in front of them; they lean and the picture turns; they try it on the phone if that lands; his finished pieces close the pitch.
- The operator: Nathan.
  He imports the photo (AirDrop from his iPhone, then a drag onto the page), drives the live creation, flips Window, Motion, Symbols and effects, sends the result to the 3DS, downloads or publishes the PNG, and recovers from failures with Reset or a second drop.
- After the demo: Nathan as the product's own user, and people he shares with, who open the hosted gallery and download published photos (planned).
  The demo UI's direction is meant to be one the product keeps (confirmed 2026-10-09: "demo first, direction worth keeping").

Viewing situation, confirmed 2026-10-09: the MacBook screen at arm's length on a table in a bright hall with overhead light and glare; no projector, no mirroring.

## Product Purpose

noisy is a math toolbox for photos that know their depth.
Open models give a photo its depth, its objects and its background, and every effect is a formula over those layers: a fried point-and-shoot look, glyph cells, a parallax loop, refracting surfaces.
It runs in the browser with nothing leaving the machine.

The hackathon framing (Nathan, 2026-10-09 22:00 and 22:50): a tool that lets us use math to create models or filters that make cool visuals, demonstrated by one live creation that shows how easy the toolbox is, then the pieces Nathan made with it beforehand, which show what it is capable of.

Success at Knight Hacks IX: the six minutes run end to end in every room; the Devpost submission (public repository, video, write-up) is in by Sunday 2026-10-11 10:00 EDT; the general tracks Best Overall, Best AI and Best Embedded and the sponsor tracks Adobe Prettiest, Figma Best Design, Full Sail Pathways and Perception, Databricks and Neon are all served by the same build.

## Positioning

- Everything runs in the browser on the laptop; nothing leaves the machine.
  Depth Anything V2 Small, SAM 2.1 Hiera Tiny and MI-GAN run through ONNX Runtime Web on plain WebAssembly, about 117 MB fetched once and cached, all pulled from the Hugging Face Hub.
  A fourth model, UltraFace (version-RFB-320, 1.2 MB), is planned for the webcam.
- The look is a hand-written WebGL2 pipeline, not a filter: label-aware simplification, a merged palette with band windows, outlines from texture edges and depth, grain from an integer hash, JPEG-style crunch, procedural glyph cells, a parallax loop over the depth map with an inpainted plate behind, and (planned) a surface pass of refracting bars, cracked glass with relief and fish scales lit by the moving camera.
- The first look is on screen before any model runs; analysis changes what the person can do, never what they already see.
- Editing is per object: a tap selects a person or thing, and recolor applies to that object only.
- Perception (planned): the laptop's webcam finds the viewer's face and the picture turns as they lean, a window rather than a screen.
- The phone (planned, second priority after the desktop; Nathan 2026-10-09 23:45): the same web app on an iPhone, self-contained: take a photo with the phone, it opens in the app, edit there, parallax from the phone's gyroscope, face detection from the phone's camera. Needs a hosted HTTPS site.
- The 3DS (later companion, not part of the main application): its own fried camera as an input and its gyroscope as a controller; the console cannot run the models. A stereo MPO export exists in the session; the 3DS camera app refuses the current file (finding F11).

## Operating Context

- The event: Knight Hacks IX at UCF, 2026-10-09 to 2026-10-11.
  Devpost hard deadline Sunday 10:00 AM (public GitHub repository, demo video, track selection); final code push Sunday 11:00 AM; judging Sunday 12:00 to 16:00 with two minutes to set up, six minutes to judge and ask, two minutes to tear down; sponsor tracks are judged in their own rooms.
- The room: Nathan photographs the judges on his iPhone, AirDrops the JPEG to the Mac, drags it onto the page, and performs the live creation.
  At the end he downloads or AirDrops the PNG, or hands over the 3DS.
- The six minutes, in order (Nathan, 2026-10-09 22:00, revised 23:45): the live creation first (import, sliders, tap, recolor, Motion), the window (the judge leans), the phone if it lands, the finished pieces to close.
- Demo day runs with internet off for the core and Wi-Fi and Bluetooth on for AirDrop; the 3DS needs a network it can join with the Mac (an iPhone hotspot or a Mac-hosted network, to be tested Saturday); the gallery's Publish needs internet when it is shown.
  The production build is served locally at `127.0.0.1:8790`, one Chrome tab, zoom 100%, Do Not Disturb on.
- The status line is the narration's anchor.
  Its sentences are owned by `src/session/driver.ts` and `src/session/scene.ts` and include `Fetching models N%`, `Models ready - drop a photo`, `Analyzing: depth`, `Analyzing: encoder`, `Warming decoder`, `Ready to tap`, `preparing` while Motion waits on the plate, `Nothing there`, `That is enough objects for one photo`, `Analysis timed out`, `Analysis failed`, and `Reset`.
- Recovery moves (`plan/rehearsal.md`): a HEIC is converted with `sips`; a tap that finds nothing is retried nearer the center; an analysis failure is answered with Reset or a second drop; a stuck page is reloaded and is usable in two seconds; a dead machine falls back to the rehearsal recording.
- `Try a sample` loads a bundled photo with no file dialog.
- The finished pieces Nathan makes with the tool beforehand are PNG files and screen recordings in a folder, opened from Finder in Quick Look during the six minutes (confirmed 2026-10-09 22:55); the page has no showcase and no presets.

## Capabilities and Constraints

### What the page does today

Every control below is wired in `src/ui/app.tsx` and `src/ui/swatches.tsx`.
The browser scenarios find controls by `data-testid`, so each test id must survive any rebuild.

- Header actions: Open (file picker, `image/*`, `.heic`, `.heif`), Try a sample, Download (a PNG at master size, the still without the selection outline), Reset (restores the import's untouched look, clears objects, selection, symbols and motion, keeps the analysis products).
- Drop target: the whole page accepts a dropped file.
- Look sliders: Fry (0 to 1, the macro dial: it writes eight other fields, colors, saturation, simplify, bands, grain, color noise, crunch and clipping, so those sliders move when Fry moves), Colors (2 to 12), Bands (2 to 6), Saturation, Simplify, Outline, Subject clarity, Grain, Color noise, Grain size (1 to 4), Crunch, Clipping.
  Unlabeled ranges are 0 to 1.
  Defaults: fry 0.6, colors 7, bands 4, saturation 0.62, simplify 0.52, outline 0.4, subject clarity 0.6, grain 0.52, color noise 0.32, grain size 2, crunch 0.42, clipping 0.3.
- Symbols: an enabled toggle (default off), Cell size (6 to 48, step 2), Amount (0 to 1).
  Outline is skipped while symbols are on.
- Motion: an enabled toggle (default off), Orbit (0 to 1), Loop seconds (2 to 6).
  Turning Motion on may wait on an inpainted plate; the status says `preparing` and the still stays on screen.
  The still export is unchanged by motion.
- Objects: a tap on the stage selects or adds an object, at most 8 per photo; Escape deselects.
  The selection outline is on screen only, never exported.
  The swatch row for the selected object offers Original, Coral, Orange, Gold, Green, Turquoise, Blue, Violet, Pink, and Deselect.
- A status line with `role="status"`; dev builds append the stage timing.
- A footer with the isolation flag and the build id (dev diagnostics).

### Planned controls (decided 2026-10-09 22:00, not built)

- Effects: a surface pass with a pattern (bars, cracked glass, fish scales) and sliders for relief, refraction and shine.
- Window: a toggle that turns on the webcam face tracker and drives the parallax camera from the viewer's head (desktop); on the phone the gyroscope drives the same camera.
- Publish: uploads the current PNG to the hosted gallery (planned with Neon as the store).

### How the controls are organized

Confirmed 2026-10-09: every control stays reachable, separated into groups by its nature the way Photoshop and DaVinci Resolve organize their tools.
Nothing is demoted to a hidden "secondary" set.
Recorded as given; the grouping itself is a design decision made later.
Revised 2026-10-10 10:05 (Nathan, at C2): the phone surface shows the essentials only: Fry, tap to select and recolor, Motion, Symbols, Window, Tilt, Take a photo and Download, with Try a sample and Reset for recovery; the desktop keeps every control.
Nathan also wants work done on the phone, and photos taken there, to reach the desktop page without a hand step (an automatic save to the Mac); scoped as its own package, not decided in the design.

### Photo limits

Owned by `src/photo/limits.ts` with their sentences: at least 512 px on the long edge; fitted within 2048 px, the short side must be at least 64 px; at most 64 megapixels; HEIC cannot be opened in Chrome ("Open noisy in Safari, or export the photo as JPEG.").
The master is at most 2048 px on the long edge, EXIF orientation honored.

### Technical constraints

- Preact, hand-written WebGL2, ONNX Runtime Web on wasm, esbuild.
  No new runtime dependency; no React, three.js, or UI framework.
- Content Security Policy: everything from `'self'`.
  Fonts are a self-hosted woff2 under `src/assets/` or the system stack; no CDN, no Google Fonts.
  Images from self, blob, and data.
  `headers.json` is a tested contract; a gallery backend or a 3DS bridge must be same-origin or extend it deliberately.
- The build copies `src/assets/` as static files served under `/assets-static/` (the sample photo lives there) and may link one stylesheet; D7 may change `tools/build.mjs` and `src/index.html` for that (`plan/demo.md` section 4.5).
- Dependency direction `ui -> session -> leaves -> core`, enforced by a test; `src/ui/` imports only ui, session, and core.
- Responsiveness: a slider moves the image under 50 ms; a full redraw is about 6 ms on the demo Mac; a tap outlines within 200 ms once the decoder is warm.
- Chrome on macOS is the first target; Safari on Nathan's iPhone 16 Pro is the second (Nathan, 2026-10-09 23:45 and 23:58), which needs HTTPS for the gyroscope and the camera. The phone has 8 GB of memory, WebGL2 and threaded WebAssembly, so the models are expected to fit; the first import on the phone is the test.
- Determinism: the same scene and frame give identical pixels.
- The 3DS is an original Nintendo 3DS (CTR-001) with custom firmware: 802.11g Wi-Fi, a full-size SD card, a 400 x 240 stereoscopic top screen, a gyroscope and an accelerometer.
  Its camera app shows third-party MPO files only at 640 x 480 or smaller, named like `HNI_0005.MPO` with a non-zero number, in the DCIM subfolder the console created, with a JPG twin beside it.

### Timings observed on the demo Mac

From `plan/rehearsal.md`: depth about 2 s, the segmenter about 2.4 s, a tap about 0.15 s, the inpaint about 0.8 s, a full redraw about 6 ms.

### Where the tool goes (vision, Nathan 2026-10-09 23:00; not built, shapes the shell)

Nathan's ask: a tool where you can make a near infinite number of changes to a photo or video, like Photoshop and Resolve, with the features chosen so far as its first contents.
What such a tool needs, and what the demo's shell must therefore leave room for:

- An effect stack, not a slider list: every look is a stack of nodes (Fry, Palette, Outline, Symbols, Surface, Camera grain and crunch, Motion), each with an enable switch, its own parameters, and a place in an order; new nodes are new formulas. The document already holds the parameters; the stack is the shell's reading of them.
- Scope: every node applies to the whole scene or to one layer (the plate or an object); the document already carries per-object recolor, symbols mode, motion and subject flags, so the inspector shows the selected layer's own values.
- Layers: the plate and the objects as a list with visibility, selection, order and a thumbnail; masks refined by brush later; a tap adds a layer, as today.
- Primitives beside the signature looks: exposure, contrast, curves, hue and saturation, color balance, levels, blur and sharpen, as plain nodes in the same stack.
- Time: the loop is the tool's video; parameters keyframed over the loop, a scrubber, frame-accurate preview; later, video input frame by frame.
- Non-destructive history: undo and redo already exist in `src/core/history.ts`; the shell shows the history and snapshots of named states.
- Files: open, save and reopen a scene with its products (the store under `src/store/` exists for this), export as PNG, JPEG, a stereo pair, a GIF or video of the loop, and publish to the gallery.
- Viewing: zoom and pan at 1:1, fit, a before-and-after toggle, a pixel readout, the stage as the biggest thing on screen.
- Input beyond files: the webcam as a source, a phone's camera, the 3DS's cameras.
- The formula editor, the literal toolbox: a node whose expression over depth, labels, palette and position the user writes, compiled to the shader; the thing a competitor could not copy.

The demo builds the shell for all of this with today's contents only (`plan/demo.md` section 0); every item above is a later package, not a promise for Sunday.

### Undecided product facts

- The name.
  "noisy" is the working name and does not appear on the page (confirmed 2026-10-09: no wordmark; the name lives in the tab title and the icon).
  Nathan does not like the all-lowercase treatment and is considering a playful name that works as a nathan.fish subdomain (his example: `fry-me-a.nathan.fish`).
- The mark.
  The current icon (`src/icon.svg`: a near-black rounded square with a hot pink dot; manifest theme `#000000`) is not confirmed as the product's mark.
- Databricks: opted in by Nathan, no honest use identified yet; the plan records it as open until he names one.
- Full Sail's track wants a serious game or training simulation; Nathan opts in on the strength of face detection for the window, knowing the wording.
- The public repository's history (orphan commit or the source history), decided tonight.
- Hosting after the demo: the gallery implies a hosted site; the domain is nathan.fish.

## Brand Commitments

- The shell's standing direction (Nathan, 2026-10-09 23:00, taking impeccable's standing exit): the page sits alongside Photoshop and DaVinci Resolve and is built straight at their craft level, as a real tool with utility, never a themed or retro costume.
  The early-2000s identity lives in the output and in precise details of the shell (type, one accent, the status voice), not in its organization or materials.
  The decision-page worlds of 2026-10-09 (DVD menu, digicam display, manual, index print, contact sheet) were declined as gimmicky and are not to return reworded.

- Identity: the early-2000s point-and-shoot camera era is part of what noisy is, not only a description of its output.
  Nathan's words, 2026-10-09, recorded without expansion: "modern in a way but it should capture that 2000s feel, just not overdone."
- Voice as the product speaks today: short declarative sentences, no exclamation marks, the product named in the third person ("noisy needs at least 512 pixels on its long side").
  Its verbs are fry, drop, tap, pick, download.
- Terminology: fry, bands, grain, crunch, clipping, simplify, outline, subject clarity, symbols, motion and loop, plate (the inpainted background), object, swatch, master, piece (a finished work shown in the showcase), window (the head-tracked view), surface (the effects pass).
- Name and mark: open (see the undecided facts above).

## Evidence on Hand

- Sample photo: `src/assets/sample.jpg`, today a synthetic bench scene, to be replaced by a real JPEG at or under 2048 px on the long edge before demo day.
- Real-model timings on the demo Mac, listed above.
- The rehearsal script, `plan/rehearsal.md`, with the beat-by-beat demo and the lines Nathan says; to be rewritten for the six-minute shape.
- The event guide in the vault ("Hackathon October 2026"), with the tracks, the rubric link, and the deadlines.
- Absent, never to be fabricated: testimonials, customers, press, benchmarks beyond the timings above, pricing, a hosting URL, a logo beyond the placeholder icon.

## Product Principles

1. The picture leads.
   The first look is on screen within a second, and the status line, not the image, says when more is possible.
2. Nothing leaves the laptop unless the person publishes.
   Every model and every byte is local; sharing is an explicit act, never a default.
3. Every control is live and direct.
   A slider moves the image under 50 ms, a tap selects the thing under the finger, a swatch recolors that thing only.
4. Tools are grouped by their nature, editing-suite style, and all of them stay reachable.
5. The direction survives the demo.
   No trick noisy would not ship, and no wordmark or mark the product cannot cheaply swap.

## Accessibility & Inclusion

No named standard (confirmed 2026-10-09).
Baseline to keep: every control reachable by keyboard and trackpad, named swatches with `aria-label` and `aria-pressed`, the status line as `role="status"`, Escape deselects, visible focus, and a status that stays readable over the fried image.
