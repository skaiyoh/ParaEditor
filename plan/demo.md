# noisy demo: the plan

> Owns: the hackathon demo built in this sandbox clone: its story, scope, packages, checkpoints, cut line, budget rules, demo-day checklist, and how findings flow back to the source project.
> Does not own: the product's architecture (`plan/reference/design.md`, read by Codex only), the distilled facts (`plan/evidence/`), the time log (`plan/log.tsv`), or the findings (`plan/findings.tsv`).

Written 2026-10-09 by the lead session with Nathan's decisions from the morning's discussion.
Planning started at 08:30 EDT; Nathan allowed it until 22:00 EDT, but the checkpoints below only hold if the build starts by 13:00 EDT (D1 and D2a at twice their estimates take 7.5 hours), so the first dispatch goes out as soon as the plan review is folded in.
The demo window ends 2026-10-11 08:30 EDT (hour 48).
Nathan to confirm the real demo slot; every checkpoint below shifts with it.
The plan was reviewed adversarially by Codex before the first dispatch (`plan/evidence/R0-last.md`, 26 findings, all folded in below).
Progress, 2026-10-09 12:30 EDT: D1 to D6 and D8a are merged on `demo` with both independent reviews folded in (fourteen dev scenarios and two production scenarios pass against the real models); `/impeccable init` ran at 13:20 EDT and wrote `PRODUCT.md`, so D7 is unblocked and waits on the direction; D8b (`plan/rehearsal.md` exists) and D9 are open. `plan/log.tsv` has every run.
Status: Linear project noisy, issue NATE-258 (the demo) and NATE-259 (the actions only Nathan can take).

## 0. Replan, 2026-10-09 22:20 EDT

Supersedes sections 1, 6, 7, 9 and 11 where they differ; the sections below stay as the record of the first plan and of what is built.
Source: the Knight Hacks IX guide (vault note "Hackathon October 2026") and Nathan's decisions at 22:00; `PRODUCT.md` carries the product truth.


### 0.1 Priorities, 2026-10-09 23:45 EDT (Nathan)

Supersedes the package order above where they differ.

1. The desktop web app is the full suite and must work on its own: D7 (the page; committed 04a88bc, finish review scored resolved, DESIGN.md written), E1 (the surface effects; merged 5006af8), H1 (the window; merged b0499b5), S1 (the stereo export; merged 3bcfa62). Full verification of the merged state ran at 01:45 (see NATE-258).
2. The phone, if it can be reached: the same web app on Nathan's iPhone 16 Pro, self-contained: take a photo with the phone, it opens in the app, edit there, parallax from the phone's gyroscope, face detection from the phone's camera. iOS grants the gyroscope and the camera only to secure pages, so the Mac serves HTTPS on the LAN with a certificate the phone trusts (hosting on Cloudflare remains the gallery's and the later public home). Split, 2026-10-10 01:50: PH1 `plan/dispatches/PH1-phone.md` (the ids M1 and M2 belong to the planning session's merge dispatches) (the TLS server, Tilt from the gyroscope, Take a photo, the Window on the front camera; est. 180, cut 3, dispatched after the night verification) and PH2 (the portrait layout as its own surface under `DESIGN.md`, with Nathan's choice of structure at C2; est. 150, cut 3). The phone has 8 GB and threaded WebAssembly, so the models are expected to fit; the first import on the phone is the test.
3. The 3DS is a later companion, not part of the main application (Nathan, 23:45): its own fried camera as an input and its gyroscope as a controller are the ideas worth keeping; the console cannot run the models. S2 is parked; `Send to 3DS` leaves the desktop page when S1 merges (the session's stereo export and its tests stay as `exportStereo`, an MPO export any 3D viewer can read). The 3DS camera app lists the first MPO but refuses to open it (F11): parked, not chased.
4. The gallery with Neon (G1) stays as decided; it shares the hosted site with M1. Databricks still has no identified use.

The rules that moved the plan:

- Devpost hard deadline Sunday 2026-10-11 10:00 AM: a public GitHub repository (private or missing disqualifies), a demo video, the track opt-ins. Final code push 11:00 AM. Judging 12:00 to 16:00: two minutes to set up, six minutes to judge and ask, two minutes to tear down; one general room plus one room per opted sponsor. Closing ceremony 18:00.
- Tracks (Nathan): general Best Overall, Best AI and Best Embedded, automatic; sponsor Adobe Prettiest, Figma Best Design, Full Sail Pathways and Perception, Databricks, Neon. Not Hugging Face. Full Sail is Nathan's call against its serious-game wording; Databricks has no identified use yet and stays open.
- The six minutes: the live creation first (import, sliders, tap, recolor, Motion), the window (the judge leans and the picture turns), the 3DS in the judge's hands, the finished pieces to close.

The packages from here, with lane, estimate in minutes, and cut rank (0 is mandatory, 1 is cut last):

| id | package | lane | est. | cut |
| --- | --- | --- | --- | --- |
| D7 | the page under impeccable, now with Look, Effects, Motion and Symbols as panel tabs, Window and 3DS stream toggles, Send to 3DS and Publish actions; `plan/dispatches/D7-ui.md` | driver | 150 | 1 |
| W1 | the pieces: Nathan makes finished works with the tool on Saturday (PNG stills through Download, loops and the window as screen recordings); they open from Finder in Quick Look during the six minutes (Nathan, 22:55); no code; the folder joins the demo-day checklist. Presets as a tool feature are out of scope (Nathan, 22:50) | Nathan | 0 | 0 |
| S1 | stereo pair: left and right renders at a disparity in frame fractions, at 400 x 240 and at master size; MPO encoding; Send to 3DS as a file first; tested on the 3DS camera app via SD (640 x 480 max, `HNI_000N.MPO` with a JPG twin, in the console's DCIM folder) | export | 75 | 2 |
| E1 | the surface pass: bars (widths and gaps seeded, oscillating with the loop frame, refracting), cracked glass (seeded Voronoi cells with a tilt each, refraction plus a highlight that moves with the loop camera), fish scales; a pattern select and Relief, Refraction, Shine sliders; still frames use frame 0 | render | 150 | bars 2, cracks 3, scales 4 |
| H1 | the window: webcam through `getUserMedia`, UltraFace version-RFB-320 from the Hub through ORT wasm (1.2 MB, 320 x 240 input, mean 127, scale 1/128), face center smoothed into the parallax camera offset; the Window toggle; Chrome's fake media device for the scenario | analysis + session | 120 | 2 |
| S2 | the 3DS homebrew viewer: a libctru app that connects to the Mac over TCP, receives stereo frames (a JPEG per eye at 400 x 240), shows them with `gfxSet3D`, and streams the gyroscope back over UDP; a Node bridge in `tools/` speaking WebSocket to the page; the loop streamed at whatever rate 802.11g allows, with a still-pair mode as the fallback; AtticPad is prior art for the gyro half | hardware | 240 | 4 |
| G1 | the gallery: the page hosted (Cloudflare Pages and Workers, the models in R2), Neon Postgres as the store for published PNGs, a Publish action, a gallery page with download; Databricks has no role until Nathan names one | web | 240 | 5 |
| V1 | the Devpost video (the C3 rehearsal recording), the write-up, the public repository, the Figma board of the flow and the panel map (Nathan) | lead + Nathan | 120 | 0 |
| D8b | demo day as section 10, plus the 3DS network (an iPhone hotspot or a Mac-hosted network, tested Saturday) | lead | 60 | 0 |

Lanes: driver (D7), export and render (S1 then E1), analysis (H1), hardware (S2, needs Nathan and the unit), web (G1, needs Nathan's Cloudflare and Neon accounts).
Hardware and web start only after C2 unless the core lands early.
The night runs: while Nathan sleeps, the lead dispatches E1 and H1, merges, runs the floor and the scenarios, and parks anything that needs his hands.

Checkpoints (EDT):

| checkpoint | clock | must be true |
| --- | --- | --- |
| C2 | Sat 08:30 | D7 and S1 merged; E1 bars and H1 if the night runs land; Nathan judges the look and the window on real photos and starts making the pieces; one MPO shown on the 3DS |
| C3 | Sat 20:30 | the cut line: anything not green is out; the full six minutes rehearsed and screen-recorded as the Devpost video |
| C4 | Sun 06:00 | freeze buffer; the write-up and the public repository pushed by Saturday midnight |
| submit | Sun 10:00 | Devpost in; 11:00 code freeze; 12:00 to 16:00 the rooms |

Open with Nathan tonight: the public repository's history (an orphan commit, or the source history), devkitPro installed, the SD card's DCIM folder name, the 3DS charged, Cloudflare and Neon accounts if G1 is to run, and a Databricks use or its removal.

## 1. The story (what a judge experiences, 90 seconds)

1. The page is open in Chrome on Nathan's MacBook, showing a fried scene already.
2. Nathan photographs the judges on his iPhone and AirDrops the JPEG to the Mac.
3. He drops the file onto the page. Within about a second the photo is on screen fried: simplified, quantized, outlined, grainy, crunched. The analysis runs in the background for about ten seconds and the status line says when tapping is ready; the picture itself does not change when it finishes.
4. A judge drags the sliders (bands, grain, crunch, simplification, saturation) and the look follows under 50 ms. Nathan flips Symbols on and the frame fills with glyph cells; off again, or leave it.
5. A judge taps a person or object. The object is outlined within 200 ms after the first tap (the decoder is warmed before the status says ready) and a swatch row appears; tapping a swatch recolors only that object. A second tap selects a second object.
6. Nathan toggles Motion: the status says `preparing` while the plate is inpainted, then the scene breathes with a parallax loop, the plate filling what moves out from behind the subjects. Toggle off.
7. Download saves a PNG of the current look at master size. Nathan AirDrops it to whoever wants it.
8. New photo, or Reset: Reset restores the import's untouched look explicitly (objects, selection, symbols and motion cleared, the style defaults back), keeping the analysis products.

In scope: steps 1 to 8.
Out of scope unless hour 36 arrives with everything green: lights, video or GIF export, the phone, Safari, saving scenes, undo beyond Reset, hosting on nathan.fish (section 9).

## 2. What the demo is built from

Reused unchanged from the source at `177d329` (`plan/evidence/foundations.md` has the signatures):

- `src/analysis`: `createAnalysisService` with `runSequence` (stages depth, encode, inpaint with a master-size hole, one worker heap, terminated before `onDone`), `openDecoder` (resident, point prompts in frame fractions, three soft u8 candidates at the guide's size, 128 means inside), `fetchModels` (must complete before any run; workers read Cache Storage only), the loader and lock. Every stage takes a fresh `ImageBitmap` because it is transferred.
- `src/core`: the whole state model. `newDocument` with `analysis.colors` and `analysis.tone`; `applyEdit` with `fry`, `style`, `symbols`, `motion`, `object.add`, `object.set`, `object.remove`; `applyProduce` for depth and plate; undo in `history.ts`; `fryCurve`; `derive.ts` with `layers` (plate then objects far to near), `labelAt` (hit test against the masks), `holeMask` (union dilated by 1% of the long edge, 255 inside), `anchorDisparity`, `parallaxClamp`, `cameraRadius`, `reconcile`; `motion.ts` with `frameCount`, `loopPhase`, `cameraOffset`, `parallaxDisplacement`, `PARALLAX_MARGIN`, `LOOP_ZOOM`. The demo invents no state of its own: the document is the state, and the design's `session` layer is the thin driver in `src/session/`.
- `src/platform`: clock, diagnostics, visibility, capabilities, build id. No photo or PNG helpers exist; D1 writes them.
- `tools/build.mjs` (`main.tsx` is the production entry; workers already wired), `tools/serve.mjs` (dev on `127.0.0.1:8790`, production mode for demo day), `headers.json` (isolation and CSP: `img-src 'self' blob: data:`, fonts from `'self'` only), `src/app/test-surface.ts` (`window.__noisyTest`, extended per package for the scenarios), `tools/drive-chrome.mjs` with `--base-url` against the running server.

New in the clone (the demo's own layers, under the same dependency rule, `ui -> session -> {photo, analysis, render, export, platform} -> core`, with composition in `main.tsx` and `app/` as the design has it, `src/session/` as the thin session layer, and `src/ui/` as the page; the source's import-graph test enforces the direction):

- `src/core/color.ts`: sRGB, Oklab and Oklch conversions, pure (the source planned it under P2d.1).
- `src/photo/`: decode with resize and EXIF orientation to the master, HEIC detection with the design's sentence, the thumbnail, k-means color clusters and tone statistics in the document's own shapes.
- `src/render/`: the WebGL2 renderer in its reduced form (section 4), the CPU palette resolution, and the contract (section 5).
- `src/session/`: `scene.ts` (the document plus the in-memory master and products), `app.tsx` (the page), `driver.ts` (D3: models at boot, sequence on import, decoder on embeddings, plate on demand, cancel on new import).
- `src/ui/`: Preact components under impeccable's direction (D7): stage, slider panel, swatches, buttons, status line.
- `src/export/png.ts`: the still at master size as a PNG download.

`src/main.tsx` becomes the demo's entry so the demo is `/`; the placeholder shell goes.

## 3. Process

Roles, budget rules and the floor are in `CLAUDE.md` and `AGENTS.md`; this section is what they do not say.

- One dispatch per package, written from `plan/dispatches/TEMPLATE.md`, run by `plan/codex.sh`. The dispatch names the sections of the evidence and the design it may read, the exact files it may touch, and observable acceptance. Codex tends to keep going; the Scope and Stop condition are the fence.
- Codex runs inside its own writable sandbox with loopback networking (`rw` in the runner), which runs typecheck, build and the node tests, but headless Chrome aborts inside it (probe D0f) and running Codex unsandboxed from Claude's shell is refused by Claude's permission classifier (probe D0e). So the browser scenarios are the lead's: after each return the lead runs `node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev <ids>` against `npm run serve`, reads the summary, and on a failure resumes the Codex session with the output and a screenshot through `plan/codex-resume.sh`, which keeps Codex's context and costs a fraction of a fresh dispatch. Every dispatch therefore makes Codex write the scenario that checks its browser-side acceptance, so the lead's run is one command.
- Investigations and reviews run read-only (`ro`), with Codex's final message as the deliverable.
- Two lanes after D2a, because wall clock is the constraint: the render lane (`src/render/`, `src/export/`) and the driver lane (`src/photo/`, `src/session/`, `src/ui/`). Each lane is a branch off `demo` (`demo-render`, `demo-driver`) checked out in its own worktree (`git worktree add ../noisy-demo-render demo-render`, with `node_modules` and `models` symlinked from the main clone); a worktree cannot check out `demo` itself twice. They meet only through the contract in section 5, which D2a lands first. The lead is the integrator: it merges each lane into `demo` after every package, not only at checkpoints, and resolves the three shared files the lanes both touch, `src/app/test-surface.ts` (which only composes `src/session/test-hooks.ts` and `src/render/debug.ts`, one per lane), `test/browser/page-globals.d.ts`, and `test/browser/scenarios/index.ts`. A render package that needs a control in the page (the Symbols toggle, the Motion toggle, their sliders) gets that one wiring change in `src/ui/app.tsx` named in its Scope; everything else in `src/session/` stays the driver lane's.
- Every package ends with the lead's judgment of the diff against the dispatch, the floor, a local working commit on `demo` (squashed into the one big commit Nathan asked for at the end; see `CLAUDE.md`), a row in `plan/log.tsv`, and any findings in `plan/findings.tsv`.
- Checkpoints are demo runs, not meetings: the demo must run end to end in its current state. Nathan judges the look at C1 and C2 with real photos; those two sittings are the only human time the plan needs before rehearsal.
- Hackathon rule: code may not officially start before 22:00 EDT on 2026-10-09 and nothing leaves this machine before then; no remote exists, commits stay local, and at 22:00 Nathan decides how the work done before then is presented (keep as is, or redo the dispatches from the plan, which is cheap).
- Cut rule: at hour 36 anything not running is out. The Mac demo with whatever is green stands.

## 4. The reduced look (what the renderer does)

`plan/evidence/look-rules.md` holds the design's rules with their formulas, defaults and ranges; every render dispatch cites its headings.
This section is the reduction: what the demo keeps as written, what it replaces with something cheaper, and what it drops.
Every replacement is a finding for the source project (section 8), not a proposal to change the design.

Pass chain for a still, all at master size except the working grid:

1. Simplify (cached): the `simplify-cost` pipeline as written, `down`, `tensor`, `blur` twice, `akf` three times, `dog`, `up`, on the quarter working grid, label-aware; output RGB simplified color and A texture edge. The cache key is the source identity (the master, and the back-layer source once a plate exists: two caches, as the design says), the label texture identity (objects, masks and their order), the per-label subject table, `simplify` and `subjectClarity`; anything else leaves it alone. The experiment's shaders test one hardcoded subject label; the port generalizes that to a per-label table (256 entries of clarity, 0 for non-subjects) so every tapped object keeps its detail. Kept as written otherwise.
2. Warp (motion only, D6): see the loop below. A still skips it; the simplified texture, the label texture and the depth texture are read directly.
3. Quantize: nearest palette entry by the design's Oklab distance over the resolved entries, at most 32 (section 4.1), the band window rule as written, the variant color from the LUT row of the pixel's label; writes color and, when symbols are on, the variant attachment (entry, band, tone). Kept as written, except the palette comes from section 4.1 below.
4. Outline (symbols off): id edges from the label texture, depth discontinuities above 5% of the range where depth exists, texture edges from the DoG crossing test the experiment's `post` demonstrates; width `round(6 * outline)`, ink the darkest variant at alpha `outline`. Replaced: no crease normals, so no plane-fit normals and no crease test. Finding: how much the creases add on real photos is for the source's P3b.
5. Cells and symbols (symbols on): the reduction fragment per cell, majority label, most frequent entry then band, mean pre-banding lightness normalized by the thumbnail's p01 and p99 into tone; eligibility, the five-bin density, the adjacent-band ink and paper rule, all as written. The glyph atlas: five procedural SDF glyphs `. - + * #` at 64 px, geometry chosen by the implementor since the design gives none. Finding: the chosen geometry. Outline is skipped when symbols are on, as the design says.
6. Camera stage: grain (Oklab L amplitude `0.12 * grain`, ab amplitude `0.06 * colorNoise`, one value per `grainSize` cell, integer hash of `(seed, floor(f / grainHold) mod ceil(frameCount / grainHold), cell)` with `f = frame mod frameCount` so the player's wrap lands on frame 0's grain; still frames use frame 0), then clipping (knee at `1 - 0.35 * clipping`, width 0.05, a quadratic knee since the design names none), then crunch (8 x 8 DCT on luma and 2 x 2 subsampled chroma, JPEG luma table scaled from quality 100 to 20, four separable passes on R16F and half-size RG16F targets, exact passthrough at 0). Kept as written, with the hash finalizer and the knee as findings. Crunch is the last item of D2b and may be cut alone if D2b slips.
7. Present: a plain blit, CSS-scaled.

### 4.1 Palette resolution (CPU, `src/render/palette.ts`)

The design's palette candidates come from the photo's color statistics, which the source has not built (part P2d.1).
The demo computes them itself: k-means in Oklab over a 256 px thumbnail of the master into at most 16 clusters with weights, then the design's deterministic nested Ward merging down to `colors`, the saturation rule per entry with `Lcusp` and `Cmax` for sRGB, the band windows per entry, the darkest variant, the tone percentiles p01 and p99 from the thumbnail's pre-banding lightness, and one LUT row per label: row 0 the plate, one row per object, a recolored object's row by the recolor formula with the object's stored mean color (`produced.color.mean`, which the driver computes when it adds the object, section 4.2) run through assignment.
Harmony is off in the demo; `auto` and the templates are a stretch inside D2b only if its other items land early.
Subjects pin `round(1 + 2 * subjectClarity)` of their own clusters as written, taken from the object's stored `produced.color.clusters`.
Ceiling: the resolved entries are the merged unpinned entries plus every pin, at most 32 in all (the GPU loop and the LUT are sized for 32); when pins would exceed it, the subjects added last lose their pins first, never the unpinned entries. Twelve colors plus four subjects at full clarity fit.
Recolor of a neutral object: the design's chroma scale `clamp(C_entry / max(C_mean, 0.03), 0.5, 1.5)` halves the target chroma for a gray object, against the design's own intent that the mean land on the target; the demo uses scale 1 when `C_mean < 0.03` and the formula otherwise, and the contradiction is a finding for the source (`plan/findings.tsv`).
The result is a small texture (entries by bands by rows) plus the entries' Oklab values as uniforms.
All of this is pure TypeScript with node tests; the GPU reads the result.

### 4.2 Objects, labels, depth, plate

- Masks: the decoder's soft mask bilinearly upsampled to a 1024 long edge, kept as u8; the label texture at 1024 takes the last layer in order with mask at or above 0.5, plate otherwise; order is plate, then objects far to near by depth median. Replaced: no refinement against the master. Finding for the source.
- Depth: the model's inverse depth normalized 0..1, bilinearly upsampled to master size as R16F. Replaced: no joint bilateral upsample. Finding for the source.
- Plate: MI-GAN's output for the hole that `holeMask` builds from the objects' masks (union at or above 128, dilated by 1% of the long edge); back-layer source is master outside the hole and plate inside, blended by the hole mask. The plate is tied to a mask set: `plateNeeded(doc)` says when the current one is stale and `applyProduce` refuses a plate for another set. The driver requests a plate when Motion is on and `plateNeeded` is true, after every object add, remove or refine, and the renderer uses a plate only while it matches; while Motion waits for a plate the status says `preparing` and the still stays on screen.
- Objects: the driver produces the complete `ObjectProduced` the schema requires when it adds an object: the decoder's model id, the tap as `selection`, the mask (kept in the masks map under an asset id), `bounds` as the master-pixel box of mask at or above 128, depth statistics over the mask from the depth plane (null until depth lands, then `object.depth` through `applyProduce`), and `color` as the mean and two or three k-means clusters of the thumbnail's pixels under the mask. Nothing else computes these.
- Selection: which object the judge last tapped is page state, not document state; it rides in `RenderScene.selected` and draws as an on-screen outline only, never in the export.
- Subjects: every tapped object is a subject with the default `subjectClarity`. The design's own subject detection is not built in the source either.

### 4.3 The loop (D6)

- One displaced mesh for the back layer (192 x 144 as written) over the back-layer source, displaced by background depth; one 64 x 64 mesh per object displaced by its own depth, drawn far to near with alpha test 0.5 for id and depth and a blended color draw.
- Background depth inside the hole: an eight-level push-pull fill of the depth outside the hole. Replaced: no ring-plane fit first. Finding for the source.
- Camera and displacement exactly as `core/motion` and `core/derive` compute them: `cameraRadius(doc)`, `cameraOffset(radius, phase)`, `parallaxDisplacement(offset, disparity, anchorDisparity(doc))`, all in per-axis frame fractions (so the margin is 2% of each axis, an ellipse in pixels on a rectangular frame), never converted to long-edge units; `LOOP_ZOOM` applied about the center while `effectiveOrbit` is above 0; `frameCount(doc.motion, 30)` frames indexed 0 to `frameCount - 1`, the player stepping by index and wrapping with `frame mod frameCount`, never wall time. Portrait and landscape border coverage are both checked.
- The still export is unchanged by motion: identity camera, frame 0, no deformation.

### 4.4 First look and full look

The first look needs the master and the palette only: simplify with every texel labeled plate, quantize, outline from texture edges, cells, grain, clipping, crunch.
It is on screen about a second after the drop, before any model runs.
The full look adds depth edges when depth lands, and objects when the judge taps; nothing else changes, so the status line, not the picture, says when tapping is ready.
Symbols default off in the document, so the glyph cells appear when the presenter flips the toggle, not by themselves.

### 4.5 Assets

The build copies only the manifest and the icon, links no stylesheet, and has no image or font loader.
Settled now so D7 and D8 do not discover it: D7 may change `tools/build.mjs` and `src/index.html` to copy `src/assets/` into the build as static files and to link one stylesheet; fonts are a self-hosted woff2 under `src/assets/` if the direction wants one and the system stack otherwise; the sample photo is a JPEG under `src/assets/`, fetched same-origin (the CSP allows it).
Anything the page logs to the sink is guarded by `NOISY_DEV`, because production serves no `/api/log` and the bundle guard rejects it.

## 5. The contract between lanes

D2a lands `src/render/types.ts` and `createRenderer`; both lanes and every later dispatch cite this section and that file, and nothing else crosses the lane boundary.
The document is the look: style, symbols, motion, objects with their subject flag and recolor, and the seed all live in `SceneDocument`, so the renderer reads the document and the products that live beside it, and never a settings object of its own.

```ts
import type { SceneDocument } from '../core/types.ts';
import type { ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';

// What the renderer reads. The driver lane produces it; the render lane consumes it.
export type RenderScene = {
  readonly doc: SceneDocument;        // style, symbols, motion, objects (subject, recolor, produced.color, produced.depth), seed, analysis
  readonly master: ImageBitmap;       // the master, uploaded once per import; the driver keeps the ImageData for the workers
  readonly masks: ReadonlyMap<ObjectId, Plane<'u8'>>;  // the decoder's soft masks at the guide's size, one per object
  readonly depth: Plane<'f32'> | null;   // onDepth's plane, inverse depth 0..1, larger nearer; null until it lands
  readonly plate: Rgb8 | null;           // onPlate's image at master size, only while plateNeeded(doc) is false; null otherwise
  readonly selected: ObjectId | null;    // page state: the object the judge last tapped; drawn on screen only, never exported
};

export type RendererDebug = {               // dev builds only; the scenarios' channel
  readSimplifiedPatch(x: number, y: number, w: number, h: number): Uint8Array;  // RGBA of the cached simplified texture, master coordinates, A = texture edge
  timings(): { readonly lastMs: number; readonly simplifyMs: number };        // from render start to the completion of a 1 x 1 readPixels on the final target
};

export type Renderer = {
  setScene(scene: RenderScene): void;          // uploads what changed; rebuilds the simplify cache by the key in section 4 item 1
  renderStill(): void;                          // to the canvas: frame 0, identity camera, no deformation
  renderFrame(frame: number): void;             // one loop frame to the canvas; frame counts from core/motion
  exportStill(): Promise<Blob>;                 // master size, image/png, byte-identical to renderStill's pixels, without the selection outline
  dispose(): void;
  readonly debug: RendererDebug | null;         // null in production builds
};
export function createRenderer(canvas: HTMLCanvasElement): Renderer;   // the canvas must have no context yet; the stage component hands over a fresh one
```

- The renderer derives the label texture (1024 long edge, R8) from `doc.objects`, `masks` and `layers(doc)`; the label id of an object is its index in `doc.objects` plus one (0 is the plate), the same number in the label texture, the clarity table and the LUT rows, and D6's geometry uses it too; the layer order, the anchor, the parallax clamp and the camera radius come from `core/derive` and `core/motion`, never recomputed in the renderer.
- The renderer never reads a `File`, a worker, or the service; the driver never touches WebGL.
- Determinism: same scene and frame give identical pixels; no `Math.random()` and no clock in render inputs.
  The dev-only timing probe in `src/render/debug.ts` reads the clock only to measure GPU completion; production has no probe.
- Palette resolution (section 4.1) is a pure function in `src/render/palette.ts` the renderer calls inside `setScene` when `analysis.colors`, `colors`, `saturation`, `bands`, `subjectClarity`, the objects' recolors, subjects or `produced.color` changed; the driver does not call it. It consumes each object's stored `produced.color` (section 4.2) and computes nothing from masks itself.
- Timings are measured warmed (after two prior renders of the same scene) and the scenarios report the median of five.
- Outline uses the experiment's `abs(D) / length(grad D)` crossing estimate and slope threshold, with one bounded refinement toward the zero before testing the distance from the output pixel.
  The local estimate alone thins a width-6 sharp edge to two pixels per side on the quarter grid; the refinement preserves the required three pixels per side.

## 6. Packages

| id | package | lane | effort | review | est. | watchdog | depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D0 | setup: clone, docs, logs, evidence (D0a, D0b), runner and probes (D0c to D0f), plan review (R0), Linear issues | lead | n/a | n/a | planning | n/a | none |
| D1 | import, document, stage, download: `core/color.ts`, `photo/` decode with orientation, the master rule and all three section 12 limits, thumbnail, k-means clusters and tone in the document's shapes, `newDocument`, the stage canvas (D2a replaces the node), PNG download of the master, the HEIC sentence, `src/session/test-hooks.ts`; scenarios `demo.import`, `demo.download` | driver | high | codex | 75 min | 120 | D0 |
| D2a | the render contract and the first look: `render/types.ts` as section 5, WebGL2 scaffold, the simplification port with the per-label subject table and the section 4 cache key, palette resolution (Ward merge, saturation, bands, the 32-entry ceiling, LUT rows, the neutral recolor branch), quantize, texture-edge and id-edge outline, sliders through `applyEdit`, `exportStill`, `src/render/debug.ts`; scenarios `render.first-look`, `render.outline` | both | xhigh | claude | 150 min | 240 | D1 |
| D2b | the rest of the still: grain by integer hash with the wrap rule, clipping knee, crunch DCT on R16F targets (last, cuttable alone), the depth-discontinuity outline source once depth exists; scenario `render.camera-stage` | render | high | codex | 90 min | 150 | D2a |
| D3 | the driver: `fetchModels` for all four ops at boot with progress; on import a `[depth, encode]` sequence from retained `ImageData` while the first look shows; `applyProduce` for depth; `openDecoder` with a 1024 guide on embeddings, warmed by a discarded center decode before the status says ready; an `[inpaint]` sequence with `holeMask` whenever Motion is on and `plateNeeded` is true, `preparing` meanwhile; lifecycle policy: per-stage timeouts through `AbortSignal` and `cancelHeavy` (depth 60 s, encode 120 s, inpaint 60 s), cancel and release on replacement, a scene generation checked in every callback, a 2 s debounce on the next start only, no cooldown (deliberate, a Mac); timings in the status line and, under `NOISY_DEV`, the sink; scenario `driver.import` with the real models | driver | xhigh | claude | 120 min | 200 | D2a |
| D4 | objects and recolor: tap maps to `labelAt` or a decode of the best candidate; the complete `ObjectProduced` of section 4.2; `object.add` with the mask kept in the masks map and the object made a subject; `selected` and its on-screen outline; the swatch row through `object.set` recolor; the palette's recolor rows live; `object.depth` when depth lands later; Reset as the explicit baseline restore; fixture with two subjects both keeping detail; scenario `objects.tap` | driver | high | codex | 90 min | 150 | D3 |
| D5 | symbols: the cell reduction, eligibility, density bins, adjacent-band ink and paper, the five SDF glyphs, the Symbols toggle and sliders (one wiring change in `app.tsx`); outline skipped while on; scenario `render.symbols` | render | xhigh | codex | 90 min | 150 | D2b |
| D6 | the loop: back-layer and object meshes, push-pull background depth fill, the plate blend gated on freshness, core's camera and displacement in frame fractions, `LOOP_ZOOM`, `requestAnimationFrame` stepping frames at 30 fps by index with wrap, the Motion toggle (one wiring change in `app.tsx`); still export unchanged; portrait and landscape border checks; scenario `render.loop`, with real objects once D4 is merged | render | xhigh | claude | 150 min | 240 | D3, D2b; D4 for the real-object check |
| D7 | UI under impeccable: `/impeccable init` by Nathan, direction from Claude, Codex builds `src/ui/` to it with the Codex hook on, the asset route of section 4.5, finish review by the impeccable reviewer | driver | high | impeccable | 120 min | 180 | D4 |
| D8a | the asset route, the bundled sample photo with a `Try a sample` button, and the story driven through the real interface against the production build (`story.production`, `story.production-errors`); runs on the driver lane while D7 waits on impeccable init | driver | high | codex | 60 min | 90 | D4 |
| D8b | demo day: model precache, the run-through with internet off and AirDrop on, the real sample photo, the rehearsal script and recording, the checklist of section 10 | lead | n/a | n/a | 60 min | n/a | all |
| D9 | stretch: nathan.fish | lead + codex | high | codex | 240 min | 240 | D8 and hour 36 |

Estimates are package wall-clock including the lead's judgment; the source project's parts ran 1.7 to 3.3 times their estimates, so the checkpoints assume 2x.
The watchdog column is the fifth argument to `plan/codex.sh`, in minutes; the runner's default of 90 is too short for most packages, so always pass it. Resumes get 60 unless the message says otherwise.
`plan/log.tsv` records the actuals; by C1 the ratio is known and the rest of the table is re-estimated from it.
Dispatches D1 and D2a are written; each later dispatch is written by the lead when its predecessor returns, from that return and this table.

## 7. Checkpoints

| checkpoint | clock (EDT) | hour | must be true |
| --- | --- | --- | --- |
| C0 | 2026-10-09 by 13:00 | 4.5 | plan reviewed and folded, evidence, runner, Linear issues, D1 dispatched. Every later checkpoint assumes this; a later start shifts them all by the same amount. impeccable init by Nathan is needed only before D7 |
| C1 | 2026-10-09 20:30 | 12 | D1 and D2a: a dropped JPEG fries at first look, sliders move it, Download saves the PNG. Nathan judges the look on three real photos |
| C2 | 2026-10-10 08:30 | 24 | D2b, D3, D4: full still look after analysis, tap to recolor. Nathan's second look sitting |
| C3 | 2026-10-10 20:30 | 36 | D5, D7, and D6 if it runs: the cut line. First full rehearsal, screen-recorded as the fallback video |
| C4 | 2026-10-11 06:30 | 46 | D8: hardened, precached, rehearsed offline. Freeze. D9 only if C3 was fully green |

Each checkpoint row in `plan/log.tsv` records Claude usage from `/usage`, Codex usage, and the estimate ratio so far.

C1 sitting, what Nathan judges on three real photos: the simplification at the defaults and at the ends of the slider; the merged palette and the band windows; the outline density (the shipped slope threshold is four times stricter than the design's written rule, finding F6; `OUTLINE_SLOPE_PER_WORKING_TEXEL` is the knob); grain, clipping and crunch at the defaults once D2b is merged; and whether an EXIF-rotated portrait imports upright.

## 8. Findings and the way back

Nothing here merges into the source.
Every finding goes into `plan/findings.tsv` the moment it is seen: what, the evidence, VERIFIED or INFERRED, and what it touches in the design (a section, an unknown U, a sheet J, a question Q).
After the hackathon, one replan session in the source reads the file and asks per row whether the plan would have been materially different had we known; keepers go to `decisions.tsv` and ADRs, the design is revised where it was wrong, and shader math comes across as reference with its evidence, re-derived under its part.
Findings the demo is expected to produce: the look on real photos (J sheets, Q12), the pass costs on the Mac (U5b), the end-to-end timeline on the Mac, and whatever the foundations got wrong when driven by a second caller.

## 9. Stretch: nathan.fish

Only after C4, and only because Nathan wants it.
The domain is on Cloudflare DNS with no origin today (HTTP 525).
Shape when it happens: the built page as Cloudflare static assets, the model files in an R2 bucket because the encoder weights exceed the 25 MB per-file cap, the isolation headers and a cross-origin resource policy on the bucket, and the loader pointed at the bucket.
It does not change the live demo, which runs from the Mac; it lets people open it later on a laptop.
Needs: a GitHub repo for the clone or a direct upload, and Nathan's Cloudflare account.

## 10. Demo day

Before leaving:

- iPhone Camera > Formats > Most Compatible, so AirDrop sends JPEG. Fallback on the Mac: `sips -s format jpeg in.heic --out out.jpg`.
- Production build served locally (`node tools/serve.mjs --mode production` after `npm run build:production`, or the command D8 settles), the page opened once so the models are in Cache Storage for that origin, then a full run with internet access off but Wi-Fi and Bluetooth left on, because AirDrop needs both: photograph, AirDrop in, import, tap, Motion, Download, AirDrop out.
- The sample photo loads from the page itself, no file dialog. Replace `src/assets/sample.jpg` (today the synthetic bench scene) with a real photo, a JPEG at or under 2048 px on the long edge, and rebuild; `story.production` taps a fixed point on it, so update that point in `test/browser/scenarios/story.scenario.ts` or accept that one check moving to LEAD.
- Fonts and every asset local; no CDN, no Google Fonts.
- Mac on power, display sleep off, Do Not Disturb on, notifications off, Chrome zoom at 100%, one tab.
- The rehearsal video from C3 on the desktop as the fallback.
- A one-line card for judges: drop a photo, drag a slider, tap a face, pick a color, download.

## 11. Open items for Nathan

Superseded by section 0 on 2026-10-09 22:20; kept for the record.

- The demo slot is now known: judging Sunday 2026-10-11 12:00 to 16:00, appointments assigned on the dashboard after Devpost.
- Done 2026-10-09 13:20 EDT: the hooks are installed (`.claude/settings.local.json`, `.codex/hooks.json`) and `/impeccable init` wrote `PRODUCT.md`. Still Nathan's if not yet done: approve the Codex hook in Codex's `/hooks` before D7 is dispatched.
- Codex and Chrome: the default arrangement in section 3 (Codex sandboxed, the lead runs the browser scenarios) stands. If Nathan would rather let Codex see the browser, the alternative is to run the render-lane dispatches himself in a tmux pane with `codex exec --dangerously-bypass-approvals-and-sandbox -C ~/dev/sandbox/noisy-demo - < plan/dispatches/<id>.md`; the lead cannot do that from its shell.
- GitHub is no longer optional: Devpost requires a public repository by Sunday 10:00. The history question (orphan commit or the source history) is Nathan's, tonight.
- Demo-day photo format: Camera > Formats > Most Compatible on the iPhone before the event.
- Tonight: install devkitPro (`dkp-pacman -S 3ds-dev`), prepare the SD card and note its DCIM folder name, charge the 3DS, create Cloudflare and Neon accounts if the gallery is to run, and name a Databricks use or drop the track.
- Saturday: the Figma board (the user flow and the panel map) for the Figma track.
