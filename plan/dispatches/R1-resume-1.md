The lead ran the scenarios against your build (Chrome 155 headless). demo.import, demo.download, objects.tap, render.first-look, render.loop and render.loop-objects PASS. render.view FAILS on two scenario-side checks; the renderer itself was not shown wrong:

1. "without depth, view draws the still including frame-zero grain (R1): evidence undefined" (checks.jsonl seq 139). The check's evidence is undefined, so the no-depth branch of the scenario never produced its boolean. Make the check compute and return real evidence (for example noDepthStill as a boolean plus the sampled values), and make it pass.

2. I7 "no console error, warning, or exception from the app": Chrome logged a rendering warning, "Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true." It comes from the scenario's own 2D canvas readbacks of the PNGs. Create every 2D context the scenario uses for readback with getContext('2d', { willReadFrequently: true }), so nothing is logged.

The lead has already added the accessor your scenario needs: src/app/test-surface.ts now exposes window.__noisyTest.session.renderer(). Do not change that file. After fixing, run the AGENTS.md checks again and update plan/evidence/R1-return.md with the new state; the lead reruns render.view.
