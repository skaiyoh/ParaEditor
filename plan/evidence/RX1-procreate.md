## 1. Selection in Procreate

**Confidence labels:** VERIFIED means I am sure from remembered Procreate 5.x behavior or the supplied local sources.
It does not mean I tested Procreate during this dispatch.
LIKELY marks recollection or an inference.
UNSURE marks details I cannot establish without checking the app.

**VERIFIED:** Procreate separates three decisions: which layer receives the edit, which area is selected, and which operation acts on it.
A selection limits an operation without requiring the selected pixels to become a new layer.

The four selection modes are:

- **VERIFIED - Automatic:** tap an area to select connected pixels of similar color on the active layer.
  While keeping the finger or Pencil down, slide horizontally to change the selection threshold.
  Right increases tolerance and usually expands the selected area; left decreases it.
  The selection updates while sliding.
- **VERIFIED - Freehand:** trace a boundary, or tap successive points to construct straight segments.
  These approaches can be combined before closing the selection.
- **VERIFIED - Rectangle:** drag out a rectangular selection.
- **VERIFIED - Ellipse:** drag out an elliptical selection.

**VERIFIED:** Add and Remove let successive operations build or subtract from the selection.
Invert exchanges selected and unselected areas.
Feather softens the selection boundary so an edit fades across the edge rather than stopping abruptly.

**VERIFIED:** Copy & Paste copies the selected content from the active layer into a new layer.
It leaves the original content in place.
Color Fill fills the selected area with the current color on the active layer.

**VERIFIED:** An active selection persists across successive edits until it is deactivated.
It acts as a canvas-coordinate stencil through which work on the target layer passes.
**LIKELY:** Switching target layers while retaining the active selection allows that same spatial region to constrain edits on another layer.

**VERIFIED:** This is different from a saved layer mask.
An active selection does not belong permanently to an object, and its existence does not make an adjustment affect every layer.
A layer mask belongs to its layer and controls visibility; an active selection constrains the current operation.

**VERIFIED:** Automatic selection is based on pixel similarity, rather than recognition of a person or object.
**LIKELY:** The useful lesson for noisy is the interaction: establish a region, keep it visible, refine it directly, and perform several edits without repeatedly finding the object.

## 2. Layers

**VERIFIED:** Procreate’s layers make the editing target explicit.
Selecting a layer changes where painting and applicable adjustments act.
Visibility, opacity and blend mode determine how its content contributes to the composite.

| Feature | Procreate behavior |
|---|---|
| Groups | **VERIFIED:** Organize multiple layers into a collapsible container and allow collective operations such as visibility changes. |
| Clipping masks | **VERIFIED:** An upper layer’s contribution is constrained by the transparency of its underlying base layer, while its content remains separate. |
| Alpha lock | **VERIFIED:** Restricts painting and filling to existing opaque pixels on that layer. It preserves the existing transparency boundary. |
| Layer masks | **VERIFIED:** A separate grayscale mask controls visibility. Black conceals, white reveals, and gray gives partial visibility without erasing the original pixels. |
| Blend modes | **VERIFIED:** Change how a layer combines with the layers below it. Normal, Multiply and Screen are examples. |
| Reference | **VERIFIED:** A designated reference layer supplies boundaries for ColorDrop fills performed on other layers, useful for coloring beneath line art. It is not a universal reference for every tool. |
| Opacity | **VERIFIED:** Changes the contribution of the entire layer. It is available with the layer’s blend controls. |

The layer gestures need one correction:

- **VERIFIED:** Swipe right on additional layer rows to select multiple layers.
- **VERIFIED:** Pinch layer rows together to merge them, including intervening layers.
  This collapses their independent raster content.
- **VERIFIED:** A **two-finger swipe right** on a layer toggles alpha lock.
- **VERIFIED:** A **two-finger tap** on a layer invokes opacity adjustment.
  It does not toggle alpha lock.

**VERIFIED:** Ordinary adjustments target the active layer.
An active selection can restrict the affected area for supported operations.
Procreate does not provide Photoshop-style persistent adjustment layers that automatically filter the entire stack below them.

**VERIFIED:** Applying an adjustment to a flattened or merged composite affects the whole image represented by that composite.
Preserving the original stack requires retaining its separate layers, for example beneath an adjusted composite copy.
**LIKELY:** Applying the same settings separately to every original layer can produce a different result from filtering the final composite, particularly for spatial filters and interacting blend modes.

**LIKELY:** What feels right is target continuity.
The highlighted row, the visible content and the operation agree about what is being edited.
The user does not have to infer scope from whichever control happened to appear.

## 3. Adjustments

**VERIFIED:** Procreate uses several adjustment interactions, rather than one universal slide gesture.

- **VERIFIED - Blur:** Gaussian Blur supports horizontal dragging across the canvas to change its strength.
  The percentage and image update during the drag.
- **VERIFIED - Noise and Sharpen:** Use the same broad canvas-slide pattern for adjustment strength.
  Some filters also expose additional controls.
- **VERIFIED - Hue, Saturation, Brightness:** Uses dedicated sliders for its three values.
  It should not be described as a single horizontal canvas gesture that controls all three.
- **VERIFIED - Liquify:** Dragging on the image performs the chosen deformation, such as pushing pixels.
  Controls such as brush size and pressure shape that operation.
  The drag has a spatial meaning, rather than simply increasing a percentage.

**VERIFIED:** Supported adjustments offer Layer and Pencil modes.
Layer applies the adjustment across the target layer, subject to applicable selection constraints.
Pencil lets the user brush the adjustment into particular areas.
Brush properties influence that local application.
**UNSURE:** I cannot give a reliable feature-by-feature matrix of Pencil support across all Procreate 5.x releases.
Liquify should be treated as its own deformation interface rather than assumed to offer the same Layer/Pencil behavior.

**VERIFIED:** Preview occurs while the value changes or the stroke is made.
Releasing the finger ends that drag, but the adjustment session can remain open for further changes.
Leaving the adjustment through its normal tool control accepts the current result.

**LIKELY:** In the remembered 5.x interface, a single-finger canvas tap opens adjustment actions including Apply, Undo, Reset and Cancel.
Apply accepts the current adjustment; Cancel discards that adjustment session.
**UNSURE:** The exact availability and placement of this popover across individual filters and 5.x releases needs checking before describing a universal commit/cancel gesture.

**VERIFIED:** Two-finger tap is undo.
**UNSURE:** One undo should not be assumed to cancel an entire active adjustment session in every mode; a session can contain several operations.

**LIKELY:** The immediacy comes from a stable target and continuous feedback.
The user sees the consequence while choosing the value, and can accept or abandon it without rebuilding the selection.

## 4. Tools that read as primitive

**VERIFIED:** Procreate’s Transform tool operates on selected content, or the active layer’s content when there is no spatial selection.
It provides movement, scaling and rotation, with modes for nonuniform transformation, Distort and Warp.

**VERIFIED:** A bounding box makes the transformable content visible.
Dragging the content moves it; dragging handles changes its geometry.
Distort changes the quadrilateral, while Warp provides more local deformation.

**VERIFIED:** Smudge redistributes and blends existing color using a brush.
Eraser removes content from the active layer using brush behavior.
Both offer a spatial action with a visible footprint.

**VERIFIED:** QuickShape turns a drawn stroke into a recognized geometric shape when the user pauses while holding at its end.
After recognition, the shape can be adjusted.
An additional finger can constrain supported shapes, such as making an ellipse circular.

**VERIFIED:** QuickMenu gives quick access to a configurable set of actions through a configured gesture.
**UNSURE:** I would not claim a universal default trigger across installations.
Its value is avoiding a trip through menus for repeatedly used commands.

**VERIFIED:** Two-finger tap undoes the previous action; three-finger tap redoes.
Holding the undo gesture can step backward through history.

Their contact cycles explain much of the feel:

| Tool | Finger-down | During drag or hold | Release |
|---|---|---|---|
| Automatic selection | **VERIFIED:** Establishes a seed region. | **VERIFIED:** Horizontal movement changes tolerance and previews the boundary. | **VERIFIED:** Leaves the resulting selection active. |
| Transform | **VERIFIED:** Acquires the content or handle being manipulated. | **VERIFIED:** Previews movement or deformation. | **VERIFIED:** Ends that manipulation; the transform tool can remain active. |
| Smudge / Eraser | **VERIFIED:** Begins a local brush operation. | **VERIFIED:** Continually changes pixels along the stroke. | **VERIFIED:** Ends the stroke. |
| QuickShape | **VERIFIED:** Begins an ordinary drawing stroke. | **VERIFIED:** Drawing produces marks; holding at the end invokes recognition. | **VERIFIED:** Leaves the recognized shape available for the ensuing editing workflow. |

**LIKELY:** These tools feel primitive because a small vocabulary of actions has predictable consequences.
The selected tool establishes what a drag means before contact.
Feedback begins at contact and continues through movement.
Release completes a coherent manipulation without forcing the user to start again.

## 5. The mapping to noisy, concretely

**VERIFIED:** The existing behavior below is documented in the permitted sources, rather than verified through a running page.
[PRODUCT.md](/Users/nathandavis/dev/sandbox/noisy-demo-research/PRODUCT.md) distinguishes delivered capabilities from the vision.
[The demo plan](/Users/nathandavis/dev/sandbox/noisy-demo-research/plan/demo.md:78) describes the foundations and reduced renderer.
[DESIGN.md’s Components](/Users/nathandavis/dev/sandbox/noisy-demo-research/DESIGN.md:273) specifies layer rows and inspector nodes, but that specification alone does not establish their shipped behavior.

**VERIFIED:** [types.ts](/Users/nathandavis/dev/sandbox/noisy-demo-research/src/core/types.ts) exports document, object, selection, recolor and motion types through schema inference.
It does not display their field definitions.
Precise field shapes, defaults and persistence guarantees cannot be established from that file alone.

### Objects as layers

**VERIFIED - Already:** The foundations derive a plate followed by objects ordered far to near using depth.
A tap adds or selects an object.
The design specifies thumbnail layer rows, a selected state and an empty-state instruction.
The documented demo allows eight objects.

**VERIFIED - Gap in the supplied evidence:** A layer-row specification does not establish a complete layer editing workflow.
The documented capability list exposes object recolor, while the product describes broader layer controls as its direction.

**LIKELY - Smallest version that feels right:** Show Plate and every tapped object as persistent rows.
Selecting a row or tapping its object selects the same editing target.
Give each object visibility, a readable name and its local inspector.
Keep Scene as a separate, explicit scope.
Plate must not silently mean Scene: editing the background is different from editing the composite.

### Automatic selection, candidates and refinement

**VERIFIED - Already:** The decoder returns three soft u8 candidate masks.
The reduced renderer uses a fixed cutoff near 0.5, keeps the soft mask, and derives a label texture from thresholded membership.
The stored selection recipe and the object currently outlined on screen are different concepts; the latter is page state.

**VERIFIED - Gap in the supplied evidence:** No delivered candidate chooser, adjustable threshold or manual mask correction is documented.
The plan explicitly omits master-image mask refinement.
Keeping soft values does not establish feathered rendering, because the documented label assignment uses a hard cutoff.

**LIKELY - Smallest version that feels right:** After a tap, retain the selected object and offer three compact candidate previews.
In an explicit Refine tool, hold on the selected region and drag horizontally to expand or contract the boundary, with its outline updating continuously.
Release retains the mask and creates one undoable edit.

**VERIFIED:** A segmentation cutoff differs from Procreate’s color-tolerance threshold.
Lowering noisy’s cutoff admits more pixels; raising it admits fewer.
**LIKELY:** Present the gesture as “expand” and “contract,” with right expanding, rather than exposing that numerical inversion.

**LIKELY:** Candidate choice handles alternative object interpretations; threshold handles the boundary within a candidate.
Neither guarantees correction of a semantically wrong mask.
The next primitive should therefore be Add/Remove mask strokes.
Feather should be a separate edge control, with actual soft compositing behind it.

**VERIFIED:** The plan ties plate validity to the object masks.
**LIKELY:** Refinement must consequently reconcile bounds, depth statistics, color statistics and plate validity.
The boundary can preview immediately while the inpainted plate is refreshed separately.

### Per-layer settings as adjustments

**VERIFIED - Already:** Object recolor is an exposed local operation.
PRODUCT documents per-object recolor, symbols mode, motion and subject flags in the model, and a subject-clarity control.
The demo makes every tapped object a subject.
[Finding F2](/Users/nathandavis/dev/sandbox/noisy-demo-research/plan/findings.tsv) identifies the need for per-label clarity handling.

**VERIFIED - Gap in the supplied evidence:** Those model capabilities do not establish that Symbols, Motion and Clarity are all delivered as independent object controls.
The documented object inspector exposes swatches.

**LIKELY - Smallest version that feels right:** Selecting an object reveals its Recolor, Symbols, Motion participation and Clarity settings.
Controls read back that object’s values and preview on that object.
Switching layers preserves previous edits.
Scene controls remain explicitly accessible.
Use the existing parameters before adding a generalized effect-stack editor.

### Presets as layer or scene adjustments

**VERIFIED - Already:** Fry is a macro that writes several look parameters.
PRODUCT explicitly says the documented page has no presets.

**VERIFIED - Gap in the supplied evidence:** There is no documented preset application with an explicit layer/scene target.

**LIKELY - Smallest version that feels right:** A preset applies an ordinary bundle of editable parameter values to the displayed scope and creates one undo step.
For an object, apply supported local settings.
For Scene, apply scene settings.
Expose scope before application and avoid silently broadening an object preset into a scene edit.
The inspector should show the resulting values immediately.

### Transform over the inpainted plate

**VERIFIED - Already:** Noisy has object masks, bounds, depth statistics, depth ordering and an inpainted background used for parallax.
The plan describes stale-plate rejection and preparation status.

**VERIFIED - Gap in the supplied evidence:** No user-controlled object translation, scale or rotation is documented.
Parallax motion does not supply direct placement.

**LIKELY - Smallest version that feels right:** Add an explicit Move tool.
Finger-down on the selected object acquires it; dragging previews translation; release records one edit.
Prepare the plate before movement can expose the original footprint, and communicate preparation while it is unavailable.

**LIKELY:** Keep the object’s source extraction mask separate from its transformed placement.
The plate must remove the object from its original location.
Its visible pixels, mask and associated depth must move together.
Initially preserve its depth and far-to-near ordering; scale and rotate can follow once movement handles occlusion correctly.

### Touch gestures and history

**VERIFIED - Already:** Noisy documents live sliders, tap selection and core undo/redo support.
The supplied demo plan excludes exposed undo beyond Reset.
Mac findings record roughly 5.8 ms for the full still chain and 13.3 ms with Symbols; these are Mac measurements, not phone guarantees.

**VERIFIED - Gap in the supplied evidence:** No delivered two-finger undo or transaction boundary for a continuous adjustment is documented.

**LIKELY - Smallest version that feels right:** Borrow three gestures with explicit tool meanings:

- **LIKELY:** Hold and drag in Refine to change the selection boundary.
- **LIKELY:** Slide a slider, or the canvas in a named adjustment mode, to change one value with continuous preview.
- **LIKELY:** Two-finger tap to undo, backed by visible Undo/Redo controls.

**LIKELY:** Each completed drag should create one history entry rather than an entry for every intermediate frame.
A cancelled interaction restores its starting state.
Tool-specific drags should remain distinguishable from viewport pan and zoom.

## 6. The three changes I would make first, in order, and one idea that does not transfer

1. **LIKELY - Make layer selection control the inspector, with explicit Scene scope and undo.**
   Reuse the plate/object model and expose the object settings already supported.
   This addresses the central complaint: selecting a thing should make that thing’s settings available.
   It also gives presets and subsequent tools an unambiguous target.

2. **LIKELY - Make selection correctable.**
   Expose the three candidates and live expand/contract refinement, then Add/Remove strokes.
   A persistent object layer is useful only when its boundary is trustworthy.
   Group each refinement gesture into one undo step and keep plate invalidation correct.

3. **LIKELY - Add direct object movement over a valid plate.**
   Start with translation, retaining depth order and moving pixels, mask and depth together.
   This turns segmentation into a tangible editing primitive.
   Presets can then reuse the scope and history established in the first change.

**LIKELY:** Presets should follow these foundations.
More looks alone would leave the targeting, correction and movement gaps intact.

**VERIFIED:** Procreate’s pinch-to-merge collapses separate raster layers.
**LIKELY:** That idea does not transfer directly to noisy’s depth-aware objects.
A flat merge would discard independently editable masks, depth relationships, motion settings and the connection between objects and their inpainted plate.
Flattening is appropriate for a still export; casual merging inside the editable depth document would undermine the model that makes noisy useful.