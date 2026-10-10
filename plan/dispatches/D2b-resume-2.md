# D2b resume 2: render.outline is stale since the camera stage exists

The lead ran `render.camera-stage` PASS (full chain median 5.8 ms at 2048 x 1536), `render.depth-edge` PASS, `render.first-look` PASS, and `render.outline` FAIL:

```
outline zero at edge offset 14 is side quantization: expected [200,200,200,255], got [192,187,189,255]
outline zero at edge offset 15 is side quantization: expected [200,200,200,255], got [184,180,181,255]
outline zero at edge offset 16 is side quantization: expected [200,200,200,255], got [206,199,193,255]
```

The imported document carries the default style (fry 0.6: grain 0.52, colorNoise 0.32, crunch 0.42, clipping 0.30), so the outline scenario's flat sides now carry grain and crunch.
The scenario predates the camera stage.
Fix: at the start of `render.outline` (and in any other scenario of `render.scenario.ts` whose checks assume a clean chain) set `grain`, `colorNoise`, `crunch` and `clipping` to 0 through `demo.setStyle` before any export, and say so in a comment.
Change nothing else.
Run `npm run typecheck` and the node-test command from `AGENTS.md`, add a "Resume 2" line to the Return, and stop.
