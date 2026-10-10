1. **The 16-entry palette ceiling cannot carry the promised subject pins.**
   Evidence: `plan/demo.md:66` limits assignment to 16 entries, while `plan/evidence/look-rules.md:118` says each subject adds pinned entries and `colors` counts only unpinned entries.
   With `colors = 12`, two subjects at clarity 1 require 18 entries; the document permits 32 objects (`src/core/ranges.ts:143`).
   Consequence: D4 forces a shader/LUT redesign or silently drops promised subject colors.
   Smallest fix: settle the maximum candidate count before D2a and test two subjects at maximum colors and clarity.

2. **D4 has no settled producer for the data required to add an object.**
   Evidence: `src/core/schema.ts:330` requires `model`, `selection`, `mask`, master-pixel `bounds`, nullable depth statistics, and `color`; color requires a mean and two or three clusters (`:317`).
   The decoder returns only masks and scores; `plan/demo.md:133` assigns mean computation to the renderer and says “the driver supplies nothing for it.”
   Consequence: the driver cannot construct the promised valid object from the stated decoder output alone, and missing object depth defeats depth ordering and subject anchoring.
   Smallest fix: assign D4 production of the complete `ObjectProduced`; let palette resolution consume its stored mean and clusters.

3. **The lane split does not isolate the work it assigns.**
   Evidence: `plan/demo.md:51` specifies “two git worktrees of branch `demo`”; normal Git worktrees cannot check out the same branch twice.
   D5 and D6 also own toggles/sliders/playback (`:145-146`), which require driver-owned page wiring, while every scenario package shares `src/app/test-surface.ts` and the scenario registry.
   Consequence: the claimed trivial merges become shared-file integration work, and render packages need forbidden lane crossings.
   Smallest fix: use separate lane branches, name the shared-file integrator, and give driver-side wiring its own explicit scope and dependency.

4. **The binding contract imports a type from a module that does not export it.**
   Evidence: `plan/demo.md:107` says `import type { SceneDocument, ObjectId } from '../core/types.ts'`.
   Actual code is `export type ObjectId = Brand<string, 'ObjectId'>` in `src/core/ids.ts:10`; `src/core/types.ts` does not re-export it.
   Consequence: copying the binding contract fails typecheck.
   Smallest fix: import `ObjectId` from `core/ids.ts`; also reconcile D2a’s instruction to edit the plan (`:25`) with its Scope, which does not name `plan/demo.md`.

5. **The scenario extensions omit their shared TypeScript declaration.**
   Evidence: both dispatches add `window.__noisyTest.demo`, but `test/browser/page-globals.d.ts:12` declares only `diagnostics()` and `environment()`.
   That file is outside both scopes, and `tsconfig.test.json:7` typechecks the scenarios.
   Consequence: ordinary typed calls to the required hooks fail, encouraging local casts or duplicate declarations.
   Smallest fix: include `test/browser/page-globals.d.ts` in both scopes and update the hook declaration there.

6. **D1 specifies an invalid JPEG fixture API call.**
   Evidence: D1 acceptance 3 uses `convertToBlob('image/jpeg')`.
   The installed DOM declaration is `convertToBlob(options?: ImageEncodeOptions): Promise<Blob>` (`node_modules/@typescript/typescript-darwin-arm64/lib/lib.dom.d.ts:26760`).
   Consequence: the required fixture does not compile as written.
   Smallest fix: use `convertToBlob({ type: 'image/jpeg' })`.

7. **The renderer contract cannot distinguish the actively selected object.**
   Evidence: `RenderScene` contains only document, master, masks, depth and plate (`plan/demo.md:111`); the strict document has no active selection field.
   `objects[].produced.selection` records SAM prompts, not UI focus, while D4 promises a selection outline (`:144`).
   Consequence: switching between two existing objects leaves identical renderer inputs and therefore identical rendered selection presentation.
   Smallest fix: declare a UI overlay owner or add an ephemeral selected-object input; keep it out of the document and PNG export.

8. **The contract omits the debugging channel D2a’s acceptance requires.**
   Evidence: `Renderer` exposes five lifecycle/render methods (`plan/demo.md:119`), while D2a requires simplified-target readback and separate timings (`D2a-render-contract.md:39`).
   Timing definitions are absent; the reference forces GPU completion with `gl.readPixels(...)` (`simplify-cost/index.html:180`) before recording elapsed time (`:201`).
   Consequence: the hooks require an undeclared lane crossing, and CPU submission time can satisfy the thresholds without measuring completed GPU work.
   Smallest fix: specify a dev-only readback/instrumentation channel, RGB channel semantics, GPU completion boundary, and cold versus warmed timing conditions.

9. **The gray recolor formula cannot pass D2a’s target test.**
   Evidence: the formula is `C := T.c * clamp(C_entry / max(C_mean, 0.03), 0.5, 1.5)` (`look-rules.md:304`), but D2a acceptance 2 requires a gray mean to land on the target.
   A read-only arithmetic check with both source chromas 0 and target chroma 0.2 produced 0.1.
   Consequence: literal implementation fails acceptance, or the implementor changes the formula without a settled rule.
   Smallest fix: define the neutral-color branch explicitly and distinguish the pre-banding target from the final quantized color.

10. **The outline acceptance rejects the specified alpha blending.**
    Evidence: D2a specifies darkest-variant ink at alpha `outline` (`:31`), then requires strictly more pixels equal to that exact ink at outline 0.4 (`:47`).
    Blending another color toward ink at alpha 0.4 generally produces an intermediate color, not the ink itself.
    Consequence: a correct outline can fail, while arbitrary darkening can manipulate the count.
    Smallest fix: use a known edge fixture and compare expected blended pixels and coverage at declared widths; include a flat-image negative control.

11. **D1’s initialized canvas cannot simply become D2a’s WebGL canvas.**
    Evidence: D1 says to draw the master and “keep the stage a single canvas element the renderer can take over” (`:7-11`).
    Once that element has a 2D or bitmap-renderer context, requesting WebGL2 on it returns null; resizing does not change its context mode.
    Consequence: the natural D1 implementation makes D2a’s renderer creation fail.
    Smallest fix: explicitly permit D2a to replace the canvas node, or settle a WebGL-based initial stage in D1.

12. **The stated simplification cache rules omit source changes.**
    Evidence: `plan/demo.md:64` and D2a `:33` say it reruns only for simplify, clarity, labels or subjects.
    The evidence explicitly includes source changes and separate master/back-layer caches (`look-rules.md:112-114`).
    Consequence: literal caching can reuse the previous photo or retain an unfilled background after a plate arrives.
    Smallest fix: include master identity, plate identity and label order in the cache keys, with replacement-photo and late-plate checks.

13. **The ported simplification spike supports one subject label, not every tapped subject.**
    Evidence: `simplify-cost/index.html:73` uses `abs(l0 - subj) < 0.002`; `:167` hardcodes `LABEL1 = 1 / 255`.
    Its reconstruction repeats the single-label test (`:123`), while `plan/demo.md:86` makes every tapped object a subject.
    Consequence: an unchanged port spares only one object, and D4 cannot repair render-lane shaders.
    Smallest fix: require a per-label subject table in D2a and a fixture proving clarity applies to two distinct subject labels.

14. **“Plate on first Motion” is insufficient after the object set changes.**
    Evidence: `plan/demo.md:85` requests a plate when Motion is first enabled.
    Actual freshness is mask-set based: `plateNeeded` compares current masks against `analysis.plate.forMasks` (`src/core/derive.ts:295`), and `applyProduce` rejects a plate for another mask set (`src/core/produce.ts:82`).
    Consequence: adding another object during Motion exposes an unfilled subject or leaves playback waiting without requesting a replacement.
    Smallest fix: assign D3 plate reconciliation after every relevant edit/product; ignore stale plate pixels and gate playback until the current plate arrives.

15. **A returned decoder handle is not evidence that tapping is ready.**
    Evidence: `openDecoder` posts `init` and immediately returns (`src/analysis/service.ts:489-493`).
    The worker asynchronously creates its session, sends no ready reply, and reports initialization failure only on a later decode (`decode-worker.ts:59-97`, `:133-134`).
    Consequence: the status can announce readiness before initialization succeeds, and the first tap includes startup cost despite the 200 ms story.
    Smallest fix: warm and validate the decoder through a discarded decode before announcing readiness; measure first and subsequent tap-to-outline latency.

16. **D3 leaves consequential worker lifecycle policy unspecified.**
    Evidence: the service says “watchdogs, cooldowns, retries, and when a decoder lives are the caller’s” (`service.ts:9-10`).
    Foundations records a 20-second encoder cooldown and no service watchdog (`foundations.md:210-221`); the package table supplies only a 2-second debounce.
    Consequence, INFERRED: rapid imports or stalled inference can retain large heaps or leave analysis indefinitely busy.
    Smallest fix: specify bounded timeouts, immediate cancellation/release on replacement, scene-generation checks on callbacks, and a measured policy for repeated imports; debounce only the next start.

17. **The advertised loop endpoint equality fails for grain.**
    Evidence: `plan/demo.md:69` hashes `floor(frame / grainHold) mod ceil(frameCount / grainHold)`, while `:92` promises frame `frameCount` equals frame 0.
    Using the actual `frameCount` export, 2.3 seconds at 30 fps gives 69 frames; with hold 2, the hash indices at frames 0 and 69 are 0 and 34.
    Consequence: the camera closes but the complete rendered frame does not.
    Smallest fix: normalize the frame modulo `frameCount` before computing the grain hold index; test non-divisible counts.

18. **The plan describes parallax units differently from core.**
    Evidence: `plan/demo.md:92` describes the margin as a fraction of the long edge.
    `src/core/motion.ts:93-95` explicitly uses frame fractions of each axis, producing an ellipse in pixels on a rectangular frame; displacement returns those fractions (`:120-122`).
    Consequence: interpreting displacement in long-edge units changes motion and can uncover borders on the short axis.
    Smallest fix: state per-axis frame fractions and test portrait and landscape border coverage.

19. **Reset through undo does not guarantee the untouched look.**
    Evidence: the story promises Reset to the untouched look (`plan/demo.md:19`), but D4 says “Reset through undo” (`:144`).
    `undo()` removes one entry (`src/core/history.ts:145`), and history is capped at 50 (`:130`).
    Consequence: one undo resets too little; draining history cannot recover edits already dropped from it.
    Smallest fix: retain the import’s editable baseline and restore it explicitly, including selection, objects, symbols and motion; preserve valid analysis products.

20. **The story promises an automatic visual transition the packages do not build.**
    Evidence: section 1 says analysis brings “simplification, outlines, symbols” (`plan/demo.md:14`).
    Section 4.4 puts simplification in the first look and says only the status announces tapping readiness (`:97-99`); symbols default off (`src/core/defaults.ts:38`).
    Consequence: following the script produces no automatic glyph reveal and much less visual change than promised.
    Smallest fix: revise the script to announce readiness and explicitly toggle Symbols, or assign an intentional reveal behavior to a package.

21. **The allowed planning finish makes C1 and C2 unreachable at the stated 2x estimates.**
    Evidence: C0 may finish at 22:00 (`plan/demo.md:159`), after C1’s 20:30 deadline.
    D1 plus D2a require 7.5 hours at 2x; D3 plus D4 add seven hours.
    Consequence: a 22:00 build start reaches C1’s content at hour 21 and C2’s content at hour 28; C3 can still fit nominally, but the first two look sittings cannot.
    Smallest fix: make 13:00 the latest build start for the existing checkpoints, or shift them.
    At that start, C1 has zero slack; explicitly add D4 to D6’s real-object verification dependencies.

22. **The runner’s default watchdog is shorter than the planned packages.**
    Evidence: `plan/codex.sh:26` defaults to 90 minutes and kills the process at the limit (`:48-50`).
    D2a and D6 each have 150-minute estimates before applying 2x; the advertised invocation omits the fifth watchdog argument.
    Consequence: authorized work can be killed before verification and its Return are written; resumes have no corresponding watchdog.
    Smallest fix: record explicit package watchdog arguments and bound resumes, preserving time to return failures.

23. **D1’s acceptance leaves import limits and EXIF evidence unchecked.**
    Evidence: design section 12 rejects master short sides under 64 and sources above 64 MP (`design.md:1514`).
    D1 acceptance 3 checks only the long-edge limit and HEIC; acceptance 8 asks Codex to report the fixture’s actual decode path although Chrome is unavailable.
    Consequence: a package can pass while accepting dangerous sizes or reporting an expected decode path as observed.
    Smallest fix: add both missing limit checks and expose `resize | fallback` through a dev hook; mark the rotated fixture and its observed path LEAD until exercised.

24. **Production verification arrives after a dev-only logging path is introduced.**
    Evidence: D3 requires timings “in the status line and the sink” (`plan/demo.md:143`).
    The server uses no dev endpoints in production (`tools/serve.mjs:612-614`), and the bundle guard rejects `/api/log` in production output (`test/bundle-guard.test.ts:105`).
    Consequence: an unguarded sink call can break the verification floor or produce production 404 errors; dev scenarios cannot establish the production workflow.
    Smallest fix: explicitly guard sink code with `NOISY_DEV` and exercise import, taps, Motion and the actual Download button against production before D8.

25. **Local fonts, CSS and the sample photo need an asset-delivery decision.**
    Evidence: the unchanged builder copies only `manifest.webmanifest` and `icon.svg` (`tools/build.mjs:28`, `:341`).
    It supplies no image/font file loaders, and `src/index.html` links no stylesheet; emitted CSS is not automatically linked by the current HTML generation.
    Consequence: ordinary D7/D8 asset imports require unplanned foundation changes or embedding work.
    Smallest fix: settle the asset route now; authorize the necessary build/template changes or explicitly choose system fonts and embedded sample bytes.

26. **The offline rehearsal disables the transport used by the live story.**
    Evidence: the story requires JPEG and PNG AirDrop transfers (`plan/demo.md:13`, `:18`), while the checklist specifies a full run “with wifi off” (`:187`).
    AirDrop requires Wi-Fi and Bluetooth.
    Consequence: the rehearsal cannot exercise the complete promised acquisition and delivery path.
    Smallest fix: disconnect internet access while leaving Wi-Fi and Bluetooth enabled, and rehearse both AirDrop transfers.

## Not a problem

- The current tree passes `npm run typecheck`, exit 0.
  Builds, file-writing tests and Chrome were not run in this read-only review.
- The service supports separate `[depth, encode]` and `[inpaint]` sequences, transfers fresh bitmaps, and terminates heavy work before terminal callbacks (`src/analysis/service.ts:249`, `:283`, `:313`).
- Raster shapes and polarity match the plan: soft guide-size u8 masks, threshold 128, and master-size inpaint holes converted to MI-GAN’s opposite polarity (`src/analysis/stage-math.ts:271-281`, `:433`).
- Core already supplies ordering, hit testing, hole dilation, anchor, clamp and camera radius.
  `layers(doc)` also preserves the documented containment override (`src/core/derive.ts:63-72`).
- Headless Chrome performance measurement is feasible here.
  The reference measured the Apple M3 through ANGLE Metal with GPU completion forced by readback; the lead-run arrangement avoids requiring Chrome inside Codex’s sandbox (`simplify-cost/README.md:6`, `:28`).