# D7 return

D7 resume 2 implements the finish reviewer's requested fix batch.
The reviewer's latest disposition is "fix"; the lead must recapture and obtain the verdict on these changes.
The requested checks pass, including all 806 node tests under the exact AGENTS.md command.
The lead resolved the stylesheet MIME issue; resume 1's production route check confirmed `text/css; charset=utf-8`.
No browser or finish-review verdict is claimed.

## What changed

- `src/ui/app.tsx`: the selected Object heading now contains only its name and full-name title; the scope stays Scene and the Object section keeps its accessible label.
- `src/ui/controls.tsx`: Fry's row label is visually hidden with `.visually-hidden`, retaining the native range's explicit label, id and test id.
- `src/ui/layers.tsx`: the Plate row uses `is-selected` when selection is null; the tap hint appears only with an imported photo and no objects.
- `src/ui/swatches.tsx`: named native swatch buttons in a four-column color grid, Original and Deselect actions, selected and keyboard-focus states.
- `src/assets/app.css`: stronger Fry track/thumb/value and spanning input; 140 ms ease-out transitions only on switch and disclosure state, with zero duration under reduced motion.
- `src/index.html`: links `/assets-static/app.css`.
- `test/browser/scenarios/objects.scenario.ts`: extends `objects.tap` with one combined check for Green's native button and focusability, and Escape deselection through the actual UI listener.

Font decision: `system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`.
No font files, external font requests or dependencies were added.
UI text is 13 px, labels 12 px and metadata 11 px, with tabular numerals inherited and applied explicitly to range outputs.
All contract colors are root custom properties, with one accent token.
The only gradient is the native slider's functional left-fill track, driven by its allowed inline `--fill` variable.
Other inline styles are the existing swatch colors.

The inspector nodes are independent collapsibles with state retained while editing, selecting objects and importing photos.
Fry, Palette and Camera are expanded by default; Motion and Symbols are collapsed by default, with their heading switches and bottom mode buttons retained.
Toggling a disclosure changes only that node, preserving the other nodes' open/closed state and every `aria-expanded` binding.
The node stack scrolls within the inspector when it exceeds the available height; the scope header, stage and bottom status remain outside that scrolling region.
At 1440 x 900 the default unselected stack is expected to fit without scrolling; selected states and 1280 x 800 may scroll below the fold, per the resume instruction.
The actual fit and overflow remain LEAD checks.
The main columns are 272 / remaining space / 360 px at 1440 and 232 / remaining space / 336 px at 1280.
The bottom strip is 44 px to honor the dispatch's minimum control target, rather than the contract's 40 px strip.
The header action rail, viewer toolbar, node stack and bottom mode rail are the structural containers for later controls.
No future action or disabled placeholder was added.
Only today's Fit readout is shown; Before/After has no existing UI handler to preserve.
The scene continues to report "3 models local", matching today's depth, SAM 2.1 and MI-GAN models and the lead's corrected contract.
Encoder readiness is conservative: it uses the exposed decoder-ready flag after encoding and warming.
Observed depth, encode and inpaint timings are cached in the UI per photo; earlier import timings are not reused for a new photo.
The scope header always says "Scene", matching the global sliders' actual behavior.
Selection adds an Object node whose heading contains the object's name only, such as "Object 1".
`section.object-node[aria-label="Object"]` and `data-testid="swatches"` remain intact.
The Plate row receives the existing selected-layer treatment whenever `scene.selected === null`.
"Tap the picture to add a layer" appears only when a photo exists and has no objects.
Fry remains `label[for="style-fry"]` with its native `input[type="range"]`, id and test id intact.
Its visually hidden label keeps the accessible name; the input spans the first two grid columns, with an 8 px track, 20 px thumb and primary 13 px value.
Switch-thumb and disclosure transforms, plus switch background/border color, transition at 140 ms ease-out.
Reduced motion sets those durations to 0 ms; the stage and sliders have no new transition.
Long names truncate visually while the heading's title retains the full name.
Resume 2 changed only `src/ui/app.tsx`, `src/ui/controls.tsx`, `src/ui/layers.tsx`, `src/assets/app.css` and this Return.
The lead's headers, scenario files, registrations and other pre-existing changes were preserved.

Selectors changed: **none**.
Every existing test id, range value format, checkbox type, file input, action label, swatch accessible name and status sentence is preserved.
The existing scenario registration needs no change.
`rg -n -F 'Object ·' test/browser/scenarios` returned no matches, exit 1 as expected for an empty search result.

## Acceptance

1. **PASS**: the resume's `npm run typecheck`, `npm run build`, `npm run build:production` and exact AGENTS.md node command all exit 0; 806/806 tests pass.
   The initial dispatch's intermittent model-loader test failure and successful serial rerun remain in the historical evidence below.
2. **PASS**: the design hook reports no deterministic findings on `src/ui/controls.tsx`; the direct detector on all four resume-modified UI/CSS files exits 0 with `[]`.
   Both last reports are pasted below.
3. **LEAD**: rerun the registered dev scenarios and both production scenarios.
   No scenario selectors or registrations changed during this resume.
4. **LEAD**: recapture 1440 x 900 and 1280 x 800 and send them back to the finish reviewer for a verdict on the listed material fixes, then Codex review.
   The source changes below implement every requested fix; no resolved/ship verdict is claimed here.
5. **LEAD**: run `objects.tap`, then drive real Tab and Enter input manually.
   Verify that each disclosure changes only its own node and remembers its state after selection, slider edits and deselection.
   Fry, Palette and Camera should start open; Motion and Symbols should start closed, with their heading switches visible.
   Verify focus reaches below-fold controls by scrolling the inspector, without moving the stage or status.
   Focus a swatch and press Enter to apply it; Escape removes selection and swatches.
6. **LEAD for browser console/CSP**: resume 1's production stylesheet route check passed with 200, `text/css; charset=utf-8`, and bytes identical to the source.
   Runtime console errors and CSP violations still require the lead's browser run.

Material fixes, source verification:

1. **PASS**: Object heading and title use only `selected.name`; the scope remains Scene, the Object section and swatches selectors remain, and no scenario contains the former "Object ·" text.
2. **PASS**: the native Fry row has the requested track, thumb, primary value and input span, with its text label visually hidden but associated through `for="style-fry"`.
3. **PASS**: Plate uses `is-selected` when selection is null, sharing the existing object's selected-layer CSS.
4. **PASS**: the hint condition is `scene !== null && scene.doc.objects.length === 0`.
5. **PASS**: "3 models local" remains unchanged.
6. **PASS**: 140 ms ease-out transitions are restricted to the three requested selectors/properties, and reduced motion overrides their durations to 0 ms.

The visual quality, accessible-name browser check, Plate highlight and transition behavior are **LEAD** for recapture and reviewer scoring.

Exact affected scenario ids for the lead:

- `demo.import`
- `demo.download`
- `render.first-look`
- `render.outline`
- `render.camera-stage`
- `render.depth-edge`
- `render.symbols`
- `render.loop`
- `render.loop-objects`
- `objects.tap`
- `objects.two-subjects`
- `story.production`
- `story.production-errors`

Run the other registered dev scenarios as part of the full dev suite, including the lead's capture scenario.

Screenshots for the lead to take:

| Viewport | States | Capture names |
| --- | --- | --- |
| 1440 x 900 | empty, importing, ready, selected, motion | `d7-empty-1440`, `d7-importing-1440`, `d7-ready-1440`, `d7-selected-1440`, `d7-motion-1440` |
| 1280 x 800 | empty, importing, ready, selected, motion | `d7-empty-1280`, `d7-importing-1280`, `d7-ready-1280`, `d7-selected-1280`, `d7-motion-1280` |

For ready, leave Fry, Palette and Camera expanded and Motion/Symbols collapsed; verify all default controls fit at 1440 x 900 without scrolling.
For selected, include the selected layer, object-name-only heading and swatches, with the scope header still saying "Scene".
For empty, verify the tap-to-add-layer hint is absent.
For ready, verify Plate is highlighted and the Fry range is visibly stronger than the other native ranges.
At both sizes, inspect the lower Camera controls after scrolling the node stack; the stage and bottom status must stay in place.
At 1280 x 800, verify the default stack is scrollable and every control remains reachable.
For motion, include an object and a completed plate; verify both Motion switches reflect the same state.
Also independently expand Motion and Symbols without collapsing Fry, Palette or Camera, check focus rings, and inspect the importing/preparing status sentences.
Let switch/disclosure transitions settle for at least 160 ms before state screenshots.
Also check the same controls with `prefers-reduced-motion: reduce`, where their durations should be 0 ms.
Screenshot names have no extension when passed to `page.screenshot`.

## Checks run

### Resume 2 - current verification

`npm run typecheck`, exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build`, exit 0:

```text
build: dev 8bf75deca5cc-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (43 files)
```

`npm run build:production`, exit 0:

```text
build: production 8bf75deca5cc-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/production (13 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)`, exit 0:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36746.588584
```

The design hook's last report:

```text
[impeccable@1] Design hook scanned src/ui/controls.tsx. No deterministic design-quality issues found. That does not mean the design is good: keep following the project design system and the impeccable skill guidance.
```

`/Users/nathandavis/.agents/skills/impeccable/scripts/impeccable detect --json src/ui/app.tsx src/ui/controls.tsx src/ui/layers.tsx src/assets/app.css`, exit 0, last report:

```text
[]
```

`rg -n -F 'Object ·' test/browser/scenarios`, exit 1, no output: no scenario matches the removed heading text.
`git diff --check -- src/ui/app.tsx src/ui/controls.tsx src/ui/layers.tsx src/assets/app.css`, exit 0, no output.
No server was started during this resume.
Browser scenarios, screenshots, real keyboard/accessible-name checks, visual transition verification and the finish reviewer's verdict remain LEAD.

### Resume 1 - historical verification

`npm run typecheck`, exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build`, exit 0:

```text
build: dev 8bf75deca5cc-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (43 files)
```

`npm run build:production`, exit 0:

```text
build: production 8bf75deca5cc-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/production (13 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)`, exit 0:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37289.267667
```

The design hook's last report:

```text
[impeccable@1] Design hook scanned src/ui/app.tsx. No deterministic design-quality issues found. That does not mean the design is good: keep following the project design system and the impeccable skill guidance.
```

`/Users/nathandavis/.agents/skills/impeccable/scripts/impeccable detect --json src/ui/app.tsx src/assets/app.css`, exit 0, last report:

```text
[]
```

`git diff --check -- src/ui/app.tsx src/assets/app.css`, exit 0, no output.
The full-tree `git diff --check` additionally reported pre-existing, out-of-scope whitespace in the lead's modified log:

```text
plan/log.tsv:34: trailing whitespace.
+D7	dispatch	2026-10-09T22:56	2026-10-09T23:13	codex	gpt-6.1-sol	high	150	17	2580724	2455552	31012		exit-0	
```

`npm run serve -- --mode production` started the real production server.
`curl -sS -D - -o /private/tmp/noisy-d7-resume-1-served.css http://127.0.0.1:8790/assets-static/app.css` returned:

```text
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'
X-Content-Type-Options: nosniff
Content-Type: text/css; charset=utf-8
Content-Length: 10496
```

`cmp src/assets/app.css /private/tmp/noisy-d7-resume-1-served.css`, exit 0, no output.
The server was stopped before return.
Browser scenarios, screenshots, real keyboard input and finish review remain LEAD and were not run here.

### Initial dispatch - historical evidence

The following results predate resume 1; its MIME blocker was subsequently resolved by the lead and checked above.

`npm run typecheck`, exit 0:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build`, exit 0:

```text
build: dev 8bf75deca5cc-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/dev (43 files)
```

`npm run build:production`, exit 0:

```text
build: production 8bf75deca5cc-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo/build/production (13 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)`:

Earlier full run, exit 0:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35624.512958
```

Final default-concurrency run, exit 1:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 805
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35582.38375

✖ failing tests:

test at test/model-loader.test.ts:395:1
✖ a segment that does not fit fails as quota and closes the connection, and the server can still be reached (2029.201833ms)
  AssertionError [ERR_ASSERTION]: the response the loader stopped reading was closed

  'open' !== 'closed'

      at TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/model-loader.test.ts:408:10)
      at async Test.run (node:internal/test_runner/test:1102:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:777:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'open',
    expected: 'closed',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

Different verification attempt, changing test execution concurrency without editing tests:
`node --test --test-concurrency=1 --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)`, exit 0:

```text
ℹ tests 806
ℹ suites 0
ℹ pass 806
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 73317.894917
```

Final detector command, exit 0:
`/Users/nathandavis/.agents/skills/impeccable/scripts/impeccable detect --json src/ui/app.tsx src/ui/controls.tsx src/ui/layers.tsx src/ui/swatches.tsx src/assets/app.css src/index.html test/browser/scenarios/objects.scenario.ts`

Last report:

```text
impeccable detect: could not read linked stylesheet /assets-static/app.css (resolved to /Users/nathandavis/dev/sandbox/noisy-demo/src/assets-static/app.css); color and custom-property rules will be incomplete
[]
```

`git diff --check`, exit 0, no output.

Route checks through the real production and dev servers:

```text
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'
X-Content-Type-Options: nosniff
Content-Type: application/octet-stream
```

Production: `npm run serve -- --mode production`, followed by `curl -sS -D - -o /private/tmp/noisy-d7-served.css http://127.0.0.1:8790/assets-static/app.css`.
Dev: `npm run serve -- --request-log /private/tmp/noisy-d7-requests.jsonl --results /private/tmp/noisy-d7-results`, followed by `curl -sS -D - -H 'Accept: text/css' -o /private/tmp/noisy-d7-served-dev.css http://127.0.0.1:8790/assets-static/app.css`.
Both returned 200 with the same wrong MIME type; explicit `Accept: text/css` did not change it.
`cmp src/assets/app.css /private/tmp/noisy-d7-served-dev.css` exited 0 with no output.
Both HTML routes contained the expected same-origin stylesheet link.
Both servers were stopped before return.

An initial production serve command incorrectly included the dev-only request-log flag and exited 1:

```text
serve: --results and --request-log place the dev surfaces' files, and production mode has no dev surfaces.
```

The corrected production invocation above started successfully.
Chrome scenarios, runtime console/CSP inspection, actual keyboard input and screenshots were skipped under the sandbox's stated browser constraint.

## Noticed, not done

- `plan/log.tsv:34` has trailing whitespace in the lead's pre-existing changes; it is outside the resume's Scope and was not edited.
- The initial dispatch had an intermittent model-loader connection-close test failure.
  The exact requested node command passes 806/806 in this resume; no model-loader implementation or test was changed.
- Browser scenarios, recaptures, viewport fit/overflow, native keyboard behavior and the finish reviewer's verdict on this fix batch remain for the lead.
- Later controls and unrelated product changes remain outside this resume.

## Findings

- **VERIFIED**: the lead's MIME correction is effective in the real production route; it returns `text/css; charset=utf-8` and source-identical stylesheet bytes.
- **VERIFIED FROM SOURCE**: disclosure state is one boolean per node and updates only the named node.
  The Inspector remains mounted across session updates, so these choices persist through edits and selection changes.
- **INFERRED FROM CSS**: the default unselected stack fits at 1440 x 900, while the selected stack and 1280 x 800 can scroll within the inspector.
  No browser fit measurement or screenshot is claimed.
- **VERIFIED**: resume 2's default-concurrency node suite passes all 806 tests.
  The initial dispatch's failure evidence is retained above, without claiming its cause was established.
- **VERIFIED BY SEARCH**: no browser scenario contains the old "Object ·" heading text.
- **VERIFIED FROM SOURCE**: all six reviewer items are implemented or, for the model-count item, preserved as requested.
  Their visible result and the review disposition remain for the lead and finish reviewer.

## Time

Initial dispatch start: 2026-10-10 02:56:18 UTC, from `date`.
Initial dispatch end: 2026-10-10 03:12:46 UTC, from `date`.
Resume 1 start: 2026-10-10 03:18:31 UTC, from `date`.
Resume 1 end: 2026-10-10 03:21:59 UTC, from `date`.

Resume 2 start: 2026-10-10 03:29:56 UTC, from `date`.
Resume 2 end: 2026-10-10 03:33:46 UTC, from `date`.
