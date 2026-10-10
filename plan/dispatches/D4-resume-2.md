# D4 resume 2: the Reset baseline check after the merge

With D2b merged into this tree, `objects.tap` fails on exactly one check in the lead's run (everything else passes, ten other scenarios pass):

```
Reset PNG byte-identical to immediately after import: expected true, got false
```

Cause: the baseline export is taken right after import, before the depth plane lands, and since D2b the outline draws depth discontinuities once `depth` exists, so the post-Reset still (depth re-applied, as the plan requires) legitimately differs from that early export.
Fix the scenario, not the product: take the baseline export after `Ready to tap` (depth and the decoder present) and before any tap or edit, and compare Reset's export with that; also assert that Reset keeps `analysis().depth` true (the plan says Reset keeps the analysis products).
Change nothing else.
Run `npm run typecheck` and the node-test command from `AGENTS.md`, add a "Resume 2" line to the Return, and stop.
