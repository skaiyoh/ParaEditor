Fixed the injection defect: `thickness: 0` violated the schema’s `0.05` minimum at [scene.ts:150](/Users/nathandavis/dev/sandbox/noisy-demo-driver/src/session/scene.ts:150). Injection rejected before the driver ran; the probe ignored that error and returned `null`.

The scenario now saves evidence before every wait and accepts fresh completion between polls. Typecheck, build and all 769 Node tests pass.

[Return updated](/Users/nathandavis/dev/sandbox/noisy-demo-driver/plan/evidence/D3-return.md). The `driver.plate` browser rerun remains LEAD.