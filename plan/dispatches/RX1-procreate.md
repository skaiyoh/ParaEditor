# RX1: how Procreate makes selection, layers and adjustments feel right, mapped to noisy

Effort: high. Sandbox: ro. Review: none. impeccable: no.

Written by the lead on 2026-10-10 12:05. Nathan, after editing on the iPad: "it feels bare bones; I wanted to select an object and adjust that object's settings, move it, refine the selection by dragging like Procreate; we need primitive tools and a layering system the presets apply to." This is research for the source project's replan after the hackathon and for the Devpost write-up; it changes no code.

## Mission

Your final message is the deliverable, in full, under these headings. Write from what you know of Procreate (version 5.x on iPad); you have no network, so label every claim VERIFIED (you are sure), LIKELY, or UNSURE, and never invent a feature.

1. Selection in Procreate: the four modes (automatic, freehand, rectangle, ellipse), the automatic mode's threshold adjusted by sliding a finger left or right while the selection is held, feather, invert, copy and paste, color fill, the selection as a persistent mask over the layer stack, and how the selection interacts with layers and adjustments.
2. Layers: groups, clipping masks, alpha lock, layer masks, blend modes, reference, opacity, the layer menu's gestures (swipe for multi-select, pinch to merge, two-finger tap for alpha lock), and how an adjustment or a filter applies to one layer versus the whole image.
3. Adjustments: the slide-to-adjust gesture (hue, saturation, blur, noise, sharpen, liquify), layer versus Pencil modes, the preview-while-sliding immediacy, and the commit and cancel gestures.
4. Tools that read as primitive: transform (move, scale, rotate, distort, warp), the smudge and the eraser, QuickShape, QuickMenu, the two-finger undo; why they feel immediate (what happens on finger-down, during the drag, on release).
5. The mapping to noisy, concretely: noisy's objects as layers (the plate plus one layer per tapped object, far to near), the decoder's three candidate masks and the soft mask as the automatic selection with a threshold, per-layer settings (symbols, motion, clarity, recolor) as per-layer adjustments, the presets as adjustments applied to a layer or to the scene, a transform for an object over the inpainted plate, and the gestures to borrow on a touch screen (hold and drag to refine, slide to adjust a value, two-finger undo). For each, name what noisy already has, what it lacks, and the smallest version that would feel right.
6. The three changes you would make first, in order, with why, and the one Procreate idea that does not transfer to a depth-aware photo tool.

## Context

Read `PRODUCT.md`, `plan/demo.md` sections 1, 2 and 4.2, `plan/findings.tsv`, `src/core/types.ts` (the document: objects, selection with candidate, recolor, subject), and `DESIGN.md` "Components"; nothing else.

## Scope

Read-only. Change no file; your final message is the deliverable.

## Stop condition

Write the six sections and stop.
