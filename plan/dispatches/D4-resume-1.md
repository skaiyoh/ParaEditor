# D4 resume: one strict check in objects.tap

The lead ran both scenarios in headless Chrome 155 with the real models: `objects.two-subjects` PASS; `objects.tap` FAIL on exactly one check, `bounds contain radius-500 master disc: expected true, got false`, with every other check passing (first object selected in 154 ms, mean within 0.05 Oklab, screen-only overlay with 11,336 edge differences, recolor inside and unchanged background, retap, the cap at 8, Reset byte-identical).

The decoder's soft mask thresholded at 128 sits a few master pixels inside the fixture's antialiased disc edge, so strict containment of the full radius is the wrong expectation.
Change that one check to: the bounds contain the disc shrunk by 3% of its radius (15 master px), and the bounds do not exceed the disc grown by 3%; record the actual bounds and the disc's expected box in `objects-tap.json` so the lead can see the margin.
Change nothing else.
Run `npm run typecheck` and the node-test command from `AGENTS.md`, add a "Resume 1" line to the Return under Acceptance 3, and stop.
