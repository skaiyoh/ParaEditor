Fixed the shared output to `layout(location = 0)`. Cell reduction already has explicit locations, and draw-buffer order matches both outputs.

Typecheck, build, and all 792 node tests pass. [Resume 1 recorded](/Users/nathandavis/dev/sandbox/noisy-demo/plan/evidence/D5-return.md). Chrome rerun remains LEAD.