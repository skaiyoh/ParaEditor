# ParaEditor

> Owns: the repository entry point and quick start.
> Does not own: product scope ([PRODUCT.md](PRODUCT.md)), current priorities ([plan/revision.md](plan/revision.md)), or implementation ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

An iPad-first photo-to-motion editor built for a 48-hour hackathon.
Import a photograph, select and recolor objects, apply mathematical image treatments, and create a depth-based loop or a viewer-responsive perspective effect.
The current app includes Fry, Palette/Camera treatments, Symbols, Surface, Motion, Parallax, PNG/GIF/movie export, and shared Projects.
Hybrid Radeon integration prepares depth and background plates remotely when configured and healthy; selection, rendering, and viewing stay on the device.

The approved revision expands creative control through arbitrary colors, human-directed selection, layer placement, and drawing, with implementation staged through reviewed dispatches.
These additions are requirements, not a claim that they have shipped.
PX10 perspective work merged during this review; actual-iPad verification and hosted GPU activation remain release gates.
The effect is bounded depth-based viewing, not complete 3D reconstruction.

With the existing npm dependencies and locked model assets available:

```sh
npm run build
npm run serve
```

Open `http://127.0.0.1:8790/` on the Mac.
For the judge's iPad, use hosted HTTPS or the [local TLS instructions](plan/phone.md).

Start with the [current revision](plan/revision.md), [feature review](plan/feature-review.md), and [pickup notes](plan/resume.md).
The two session briefs are the [main Claude handoff](plan/handoffs/claude-orchestrator.md) and [complete UI handoff](plan/handoffs/ui-redesign.md).
Execution evidence stays in `plan/evidence/` and `plan/log.tsv`; this sandbox does not post status to Linear.
