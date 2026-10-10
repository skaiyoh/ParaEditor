# D0b - Shader look rules

Source: `plan/reference/design.md`; section numbers below refer to that document.
Implementation references name shader passes in `plan/reference/simplify-cost/index.html`.
Numerical glyph evidence comes from `plan/reference/glyph-rule/`.

## Pass order and resolutions - §8, §9.2, §9.3

**Demo keeps:** cached simplification, Geometry, Quantize, Outline, Cells and symbols, Camera stage, Present.
**Demo omits:** Lights and video export.
Outline is skipped while symbols are enabled.
The parallax camera operates in Geometry; the pass named Camera stage applies grain, clipping, and crunch.

| Order | Pass | Consumes | Produces | Resolution | Demo |
| --- | --- | --- | --- | --- | --- |
| Before 1 | Cached simplification (§9.2) | Master or back-layer source, labels, `simplify`, subject flags, `subjectClarity` | Simplified color RGB and texture-edge value A | Master → working grid → master | Keep |
| 1 | Geometry (§9.3) | Ordered `layers`, simplified sources, mask array, refined/background depth, normals, motion at `frame`, camera | G-buffer: color RGBA8; depth R16F; surface RGBA8 containing id, normal x/y, texture-edge value; frame RGBA8 containing frame UV | Master | Keep |
| 2 | Lights (§9.3) | G depth, surface, frame; lights; per-id table | Contribution and weighted color sums in lit RGBA16F and ray RGBA16F | Half master; rays quarter master | Omit |
| 3 | Quantize (§9.3) | G color/id, palette LUT, per-id table, tone statistics; lit/ray sums when present | Color; with symbols enabled, variant RGBA8 containing entry index, band index, tone | Master | Keep; no light contribution |
| 4 | Outline (§9.3) | G depth, surface id/normal/texture-edge value, quantized color | Outlined color | Master | Keep when symbols are off |
| 5 | Cells and symbols (§9.3) | Variant, G id, per-id table, symbols settings, palette LUT, glyph atlas | Two RGBA8 cell tables, then color | Cell resolution reduction; master resolution draw | Keep when enabled; otherwise passthrough |
| 6 | Camera stage (§9.3) | Color, G id, per-id table, frame index, seed, grain settings | Grain → clipping → crunch color | Master; crunch chroma half master | Keep |
| 7 | Present (§9.3) | Final color | Canvas | Master, CSS-scaled for display | Keep as plain blit |

**Working grid (§9.2):** `ceil(W / 4) x ceil(H / 4)`; `SIMPLIFY_DIVISOR` = 4.
A 2048 x 1536 master gives 512 x 384 working texels.
This divisor is independent of the preview divisor.

**Registration (§9.3):** stored textures live in frame space; Geometry maps them into the output/view grid.
Later passes read the G-buffer and earlier outputs, so color, id, depth, normal, and texture edge describe the same displaced surface point.
Cells, grain, and crunch blocks are formed on that output grid.
Present performs no camera crop or resampling at divisor 1.
The G-buffer frame UV attachment serves lighting and is unnecessary to the demo’s later passes.

## Parameters, defaults, and ranges - §5.2, §10, §11

Numeric bounds belong to `core/ranges.ts` (§5); §5.2 states the relevant ranges.
Defaults are stored at scene creation (§11).

| Parameter | Default | Range |
| --- | --- | --- |
| `style.fry` | 0.6 | 0..1 |
| `style.colors` | 7 | integer 2..12 |
| `style.saturation` | 0.62 | 0..1 |
| `style.simplify` | 0.52 | 0..1 |
| `style.bands` | 4 | integer 2..6 |
| `style.grain` | 0.52 | 0..1 |
| `style.colorNoise` | 0.32 | 0..1 |
| `style.crunch` | 0.42 | 0..1 |
| `style.clipping` | 0.30 | 0..1 |
| `style.outline` | 0.4 | 0..1 |
| `style.subjectClarity` | 0.6 | 0..1 |
| `style.grainSize` | 2 | integer 1..4 master px |
| `style.grainHold` | 2 | integer 1..3 loop frames |
| `style.harmony` | `{ kind: 'auto', strength: 0.5 }` | `off`, `auto`, or a named template; `strength` 0..1 |
| `style.paletteTargets` | `[]` | Unique cluster indices into `analysis.colors`, at most 16 |
| `symbols.enabled` | off | boolean |
| `symbols.cellSize` | 12 | even integer 6..48 master px |
| `symbols.amount` | 0.3 | 0..1 |
| `motion.enabled` | off | boolean |
| `motion.orbit` | 0.6 | 0..1 of `parallaxClamp` |
| `motion.loopSeconds` | 3 | 2..6 |
| `motion.focus` | null | null or disparity 0..1 |
| Object `recolor` | none | `{ kind: 'none' }` or `{ kind: 'target'; color: Oklch }` |
| Object `symbols` | slider | `slider`, `always`, `never` |
| `seed` | random uint32 at import | uint32, fixed thereafter |

**Fry (§10):** `fryCurve(f)` linearly interpolates the following tuples, rounding integers:
- f = 0: `colors 12, saturation 0.2, simplify 0.1, bands 6, grain 0.1, colorNoise 0.05, crunch 0, clipping 0`.
- f = 1: `colors 4, saturation 0.9, simplify 0.8, bands 3, grain 0.8, colorNoise 0.5, crunch 0.7, clipping 0.5`.

The renderer consumes the resulting absolute settings; it never reads `fry`.

**Taste boundary (§23 Q12):** the final design settles Q12 as “section 11’s table ships as written.”
The owner’s judgment of simplification and subject detail on real photos remains a taste judgment; no alternative preset or adjusted value is specified.

## Simplification - §9.2, §10 Simplify and Subject clarity

**Radius:** `r = 24 * simplify` master px.
Working radius is `r / 4`, equivalently `6 * simplify`.
`SIMPLIFY_ITERATIONS` = 3.
Inside subject labels, radius scales by `1 - subjectClarity`.

**Downsample:** working texel `(x, y)` covers master texels `(4x, 4y)` through `(min(4x + 3, W - 1), min(4y + 3, H - 1))`.
Its label is that of master texel `(min(4x + 2, W - 1), min(4y + 2, H - 1))`.
Average only existing texels of that label and carry the label in alpha.
Implemented by `down`.

**Integer label sampling:** master texel `m` reads label texel `floor((2m + 1) * labelSize / (2 * masterSize))` per axis using integer arithmetic and `texelFetch`.
At 2048 over 1024 this is `floor(m / 2)`.
Implemented by `LABEL_OF`, used by `down` and `up`.

**Structure tensor:** Sobel RGB gradients produce `(dot(sx,sx), dot(sx,sy), dot(sy,sy))`.
Smooth with a separable Gaussian, sigma 2 working texels.
Implemented by `tensor`, then `blur` horizontally and vertically; `blur` uses taps -4..4 and `exp(-float(i*i)/8.)`.

**Filter:** eight-sector anisotropic Kuwahara with polynomial weights, rejecting taps whose label differs from the center.
Weights taper to zero at the kernel edge.
Implemented by three `akf` draws.
The experiment caps anisotropy at 0.5, uses ellipse axes `rad*(1.+A)` and `rad/(1.+A)`, and combines sector means with `1./(1. + pow(8000.*s2, 4.))`.
Its `akf` returns the source texel when `rad < 1.0`.

**Detail:** outside subjects, `d = max(0, 1 - r / 8)`; inside subjects, `d = max(d, subjectClarity)`.
At master texel `m`, use working coordinate `(m + 0.5) / 4 - 0.5`.
Bilinearly reconstruct both filtered color `S` and unfiltered low-grid color `Lo`, accepting and renormalizing only taps carrying the master texel’s label.
Output `S + d * (M - Lo)`, clamped to 0..1; with no accepted neighbor, output master color `M`.
Implemented by `up`, with uniforms `dBg`, `dSubj`, `subj`.

**Zero rules:** `simplify` 0 returns the master exactly; `subjectClarity` 1 leaves subject color unfiltered at any `simplify`.
The experiment records maximum difference 0 of 255 for its identity patch.

**Cache:** simplify master and back-layer source separately when a plate exists; otherwise master is the sole source.
Rebuild on source, labels/order, subject flags, `simplify`, or `subjectClarity` changes, before Geometry.
It does not rerun per animation frame.

## Palette, saturation, quantization, and tone - §10

**Palette candidates:** `analysis.colors` contains up to 16 Oklab clusters.
Each subject additionally pins its top `round(1 + 2 * subjectClarity)` object color clusters.
Pinned entries never merge; `colors` counts unpinned entries.

**Merging:** deterministic, nested, weighted Ward merging in Oklab.
Lowering `colors` by one merges exactly one pair.

**Assignment:** nearest candidate by source Oklab distance `0.5 dL^2 + da^2 + db^2`.
There is no special neutral-pixel assignment rule.
Assignment remains based on source colors after targets, saturation, harmony, or recolor.

**Saturation:** for source entry `(L, C, h)`, with `s = saturation`:
```text
w = clamp((C - 0.01) / 0.03, 0, 1)
L' = mix(L, Lcusp(h), 0.6 s w)
C' = mix(C, Cmax(L', h), s^0.7 w)
```
`Lcusp(h)` and `Cmax(L', h)` are evaluated on the CPU for sRGB.
At `s` 0, source lightness and chroma remain.
Entries with source chroma 0.01 or less remain unchanged at every `s`; weight reaches 1 at chroma 0.04.
Gamut clipping preserves lightness and hue, reducing chroma to `Cmax(L, h)`.

**Palette targets:** replace a merged entry’s `(L, C, h)` exactly before Bands; Saturation and Harmony leave it alone.
When multiple targeted clusters merge, the lowest-numbered cluster’s target wins.
Targets do not change assignment.
Pinned subject swatches use object recolor instead.

**Harmony:** anchors are recolored-object targets in document order, then palette targets in effect in cluster order.
Without those, anchor the unpinned entry maximizing `weight * w`; ties use the lowest-numbered source cluster.
If every product is 0, leave the grayscale palette alone.
Rotate sectors to minimize the sum of anchor distances; anchors stay fixed.
Move other hues toward the nearest sector edge by `strength * w` of the shortest arc; hues already inside a sector stay.

| Template (§10 Harmony) | Sector centers before rotation | Half-width |
| --- | --- | --- |
| `analogous` | 0 | 45 |
| `complementary` | 0, 180 | 22.5 |
| `split-complementary` | 0, 150, 210 | 15 |
| `triadic` | 0, 120, 240 | 15 |

All angles are degrees.
Fit candidates are `theta = h - f`, using anchor hues and template centers, edges, and gap midpoints; take the first minimum in specified order.
`auto` chooses minimum anchor fit cost, then minimum `sum(weight * w * distance)` over unpinned, untargeted entries at strength 1, then table order.
`off` preserves hues.

**Bands:**
```text
W(L) = min(max(L - 0.25, 0), 0.55)
s(L) = (L - 0.25) - W(L)
t = clamp((L_pixel - L_entry + s(L_entry)) / 0.45 + 0.55, 0, 1)
index = clamp(floor(t * bands), 0, bands - 1)
variant lightness = W(L') + 0.45 * (index + 0.5) / bands
```
Classification uses source entry lightness `L_entry`; variant placement uses resolved lightness `L'`.
Both windows slide near black and white.
Variants are separated by `0.45 / bands`; gamut clipping keeps their lightness.
Inside subject ids, use `round(mix(bands, 6, subjectClarity))` bands.
With no lights, the pre-quantization lighting term is unchanged: `t' = t`.

**Experiment boundary:** `post` implements only a luminance-band proxy, `(floor(L*float(bands))+.5)/float(bands)`, scaling RGB by the quantized luminance.
It does not implement palette assignment, saturation, harmony, recolor, or the committed band-window rule.

## Outline - §9.2, §9.3 pass 4, §10 Outline

**Width and ink:** `round(6 * outline)` master px; draw the palette’s darkest variant at alpha `outline`.
`outline` 0 draws none.
The default 0.4 therefore gives width 2 master px.
Sources are id edges, depth discontinuities above 5% of the depth range, normal creases above 30 degrees, and texture edges.

**Texture edge:** signed difference of Gaussians of simplified luminance at sigma 1.0 and 1.6 working texels.
Compute once per simplify rerun, carry through simplified alpha into G surface.
Implemented by `dog`; it uses a 9 x 9 window, normalized Gaussian sums, RGB luminance weights `(.2126,.7152,.0722)`, and alpha `clamp(0.5 + 4.*(a1/n1 - a2/n2), 0., 1.)`.
`up` reconstructs this edge value to master size.

A texture edge draws where its zero crossing lies within half the outline width, estimated by `abs(D) / length(grad D)` in master px, and its slope is at least 0.04 per working texel.
These are texture edges, independent of quantized band boundaries.
`post` demonstrates the crossing-distance and slope tests, but uses proxy ink `vec3(0.05)`, alpha 0.85, and `lineW`; those are not the design’s outline ink or strength.

**Crease normals (§9.2):** half-size RGBA8 stores surface and background normal x/y pairs.
Encode a component `v` as byte `round(127 v) + 127`; decode z as `sqrt(1 - x^2 - y^2)`.
Use `N = normalize(-relief * sx, -relief * sy, 1)`, with slopes in disparity per master long edge.
`lighting.relief` has default 1 and range 0.25..4, even though lighting itself is omitted.

Slopes come from a weighted plane fit over 7 x 7 f32 depth texels, restricted to the output label.
For distance `r < 3.5`, spatial weight is `(1 - r^2 / 12.25)^2`; for depth difference `dd < 0.05`, range weight is `(1 - (dd / 0.05)^2)^2`.
Place depth texel centers in long-edge units and solve from centered sums in f32.
Use a flat normal with fewer than three weighted texels or determinant at/below `0.05 (S p^2)^2`.
The background pair uses filled background depth without label restrictions.
Do not derive slopes from the R16F refined copy.

**Crease test (§10 Outline):**
1. Find direction `g` of greatest normal change from central differences two pixels each way.
2. Use span `s = c (4 d + 2) + h`: `d` is pass pixels per depth texel along the long edge, `c` is camera scale, and `h` is half outline width.
3. Require the angle between `N(p - s g)` and `N(p + s g)` to exceed 30 degrees.
4. Require each outside interval, from ±s to ±2s, to turn by less than a quarter of that angle.
5. Require the zero of `dot(N(x), N(p + s g) - N(p - s g))` to lie within `h` of `p`.
6. Every sampled point must carry `p`’s id.

This excludes steady curvature and prevents a second crease line beside an object silhouette.
With symbols enabled, skip the entire outline pass.

## Cells and symbols - §9.2, §9.3 pass 5, §10 Symbols

**Formation:** one `cellSize` grid covers the frame and is centered on it.
Size is an even 6..48 master px, default 12.
Form cells in the output grid after Geometry; do not warp a prebuilt glyph grid with the camera.
The design does not specify a centering formula, cell-count rounding, partial-edge-cell convention, or histogram tie-break.

**Reduction:** one fragment per cell examines its pixels, at most 48 x 48:
- Choose majority label.
- Among pixels of that label, choose the most frequent palette entry, then the most frequent band of that entry.
- Over those same pixels, average pre-banding lightness `L_entry - s(L_entry) + 0.45 * (t' - 0.55)`, with `t'` before clamping.
- Normalize that mean by the asset’s `p01`..`p99` and clamp to 0..1 to obtain `tone`.

Without lights, this pre-banding lightness is the simplified pixel’s own lightness.
A solid cell is a flat block of its majority variant.
Grain runs afterward.

**Glyph eligibility:** glyph when label mode is `always`, or when mode is not `never`, `amount > 0`, and `abs(tone - 0.5) >= 0.5 (1 - amount)`.
At `amount` 0, only `always` cells draw glyphs.
At `amount` 1, every cell except `never` draws one.

**Density and choice:**
```text
e = abs(tone - 0.5)
u = (e - 0.5 (1 - amount)) / (0.5 amount)
glyph index = min(4, floor(5 u))
glyph order = . - + * #
```
Use five equal bins over the slider’s window, from sparse at its inner edge to dense at either tonal extreme.
An `always` cell below the window, and every `always` cell at `amount` 0, uses `.`.
Glyph selection is tonal, not random.

**Ink and paper:** use adjacent bands of the cell’s entry in its label’s LUT row.
Ink is nearer the dark extreme when `tone < 0.5`, otherwise nearer the light extreme.
If the cell band has a neighbor toward that extreme, paper is the cell band and ink is the neighbor.
At an extreme band, ink is the cell band and paper is its neighbor toward midtones.
At least two strictly ordered bands ensure different ink and paper.

**Atlas:** five procedural signed-distance-field glyphs, each 64 x 64, in one R8 texture.
No font; identical geometry across devices.
The design does not provide the glyph distance functions or exact stroke dimensions.

**Arithmetic settled by `glyph-rule` (§10 Symbols):**

| Recorded case | Previous rule | Committed adjacent-band rule |
| --- | --- | --- |
| `bands` 4, `amount` 0.3 | 82 glyph cells; all 82 invisible because ink equals paper | 82 glyph cells; 0 with equal ink/paper |
| `bands` 6, `amount` 1 | 256 glyph cells; 179 with equal ink/paper | 256 glyph cells; 0 with equal ink/paper |
| `bands` 4, `amount` 0 | Still draws 6 glyph cells | Draws 0 glyph cells |
| Seven gray entries, `bands` 4, `amount` 0.3 | — | 82 glyph cells; 0 with equal ink/paper |

The separate density fixture uses raw `tone = i / 255`, whereas the ink/paper fixture uses percentile normalization.
Its window-relative counts in glyph order `. - + * #` are:
- `amount` 0.3: `16, 16, 14, 16, 16`; absolute bins would give `0, 0, 0, 26, 52`.
- `amount` 0.6: `30, 32, 30, 30, 32`.
- `amount` 1: `52, 50, 50, 52, 52`.

These recorded arithmetic checks settle visible adjacent-band ink/paper, the zero guard, and window-relative density.

## Objects, masks, and recolor - §5.2, §5.4, §9.2, §9.3, §10 Recolor

**SAM product:** an object stores a u8 soft mask at 1024 long edge, refined against the master.
Upload masks as an R8 texture array, one layer per object.
Bounds are the master-pixel bbox of mask >= 128.

**Layer order:** plate first, then objects far to near by `produced.depth.median`; null depth sorts nearest.
An object whose bounds lie inside another’s by more than half its area draws afterward (§5.4).

**Labels:** R8 texture at 1024 long edge.
At each texel, take the last layer in that order whose mask >= 0.5, otherwise plate.
Key the texture by the ordered `(object id, mask asset id)` list, including order changes without asset changes.
Id 0 is the back layer; Geometry uses object indices in `RenderScene.layers`.

**Mask sampling:** at frame point `(u, v)`, use mask coordinate `(u w - 0.5, v h - 0.5)`, bilinear weights, and clamped edge texels.
Geometry uses a LINEAR sampler with `CLAMP_TO_EDGE`.
Write depth/id/normal/edge/frame UV with alpha test 0.5 and no blending, then draw color separately blended by soft mask coverage.
The back layer writes all attachments in one unblended draw.

**Sharp simplification boundary:** reject other labels during downsample, every Kuwahara tap, and upsample.
Use the integer label lookup above.
The experiment’s white-object/black-background fixture records zero color movement on either side at radii 8, 12.5, and 24 with label-aware downsampling.

**Recolor:** object target `T` is Oklch; it creates an object-specific palette LUT row, not a hue-only shift or palette-slot replacement:
```text
h := T.h
C := T.c * clamp(C_entry / max(C_mean, 0.03), 0.5, 1.5)
L := L_entry + (T.l - L_mean)
```
`mean` is the object’s `produced.color.mean` run through palette assignment on the CPU.
The mean lands on the target, including for gray objects, while relative shading survives.
Apply Bands and gamut bounds to that row.
Per-id lookup selects the row in Quantize and Cells.

## Grain, clipping, and crunch - §9.3 pass 6, §10

**Order:** grain, then clipping, then crunch.

**Grain:** luma amplitude `0.12 * grain` in Oklab L; chroma amplitude `0.06 * colorNoise` in `(a, b)`.
Use one noise value per `grainSize` px output-grid cell.
Inside subject ids, grain amplitude scales by `1 - 0.5 subjectClarity`.

Hash key is `(seed, floor(frame / grainHold) mod ceil(frameCount / grainHold), cell)`, using integer hashing.
Still rendering uses hash frame 0.
`grainHold` 1 changes grain every loop frame; higher values hold it for that many frames, default 2.
A final incomplete hold lasts only the remainder before playback wraps.
The design specifies the hash inputs and integer requirement, but no hash finalizer, channel salts, or noise distribution.

**Clipping:** lightness above `k = 1 - 0.35 * clipping` compresses to 1 through a knee of width 0.05.
`clipping` 0 is none.
The exact knee function is unspecified.

**Crunch:** 8 x 8 block DCT on luma and 2 x 2-subsampled chroma; blocks anchored at the master origin.
Quantize with the JPEG luma table scaled from quality 100 at `crunch` 0 to quality 20 at `crunch` 1, then inverse DCT.
At 0, skip all crunch passes for exact passthrough.
The design does not state the intermediate quality mapping, table coefficients, color transform, or quantizer rounding.

**Precision:** signed DCT coefficients reach about 8 for input 0..1.
Use four separable passes each for luma on two master-size R16F targets and chroma on two half-size RG16F targets.
Eight-bit intermediates cannot preserve the required coefficient precision.
Crunch follows grain so noise is distorted into blocks.

## Parallax loop and plate - §5.4, §8, §9.2, §9.3, §10 Motion

**Depth:** inverse depth normalized 0..1; larger means nearer (§5.2).
Refined depth is jointly bilaterally upsampled to master R16F, guided by the master; radius 4, sigma derived from the depth histogram (§9.2).
Geometry displaces the back layer’s 192 x 144 grid using background depth and each object’s 64 x 64 grid using refined depth.

**Anchor:** `motion.focus`, else subject depth median, else frame depth median, else null.
`effectiveOrbit(motion)` is `motion.enabled ? motion.orbit : 0`.

**Loop:** `frameCount(motion, fps) = round(loopSeconds * fps)`; preview is 30 fps.
Use phase `frame / frameCount`.
With orbit, the camera translates on a circle of radius `orbit * parallaxClamp`, keeping `anchorDisparity` fixed.
Point displacement is `offset * (d - anchor) * gain`.
The design says gain makes the farthest point from the anchor move by exactly the clamp; it does not supply closed-form `gain` or `parallaxClamp` formulas.
No displacement may exceed `PARALLAX_MARGIN` = 0.02 per side.

**Framing:** `LOOP_ZOOM = 1 / (1 - 2 * PARALLAX_MARGIN)`, about 1.0417.
Apply this scale about frame center in Geometry only when effective orbit exceeds 0.
Still rendering uses identity camera and zero deformation.
A loop at effective orbit 0 also uses identity camera, so a grain-only loop retains the still’s framing.

**Easing:** phase advances by frame index; all periodic terms have integer cycles per loop.
A circular trajectory follows that phase.
No additional easing curve or initial orbit angle is specified.
Motion at frame `frameCount` equals motion at frame 0.

**Plate:** fill the union of object masks at >= 0.5, dilated by 1% of the long edge.
The master-size inpainted PNG supplies pixels exposed behind displaced objects.
Back-layer source is master outside the hole and plate inside, blended by the hole mask.
Background depth fills that hole separately and drives the back mesh; do not move exposed background using the foreground object’s depth.
§9.2 specifies a ring-plane fit plus eight-level push-pull of the residual for the background depth fill.

**Determinism:** frame indices drive motion and grain, not wall time.
Keep seed, scene inputs, palette resolution, quality constants, glyph geometry, and label sampling stable across frames.
Only intended motion and held grain change during playback.
Simplification remains cached in frame space; later effects remain registered on the output grid.

## PNG master export - §5.1, §8, §9.3, §12, §14

For oriented source long edge `L` and short edge `S`, master long edge is `min(2048, L)` floored to even.
Master short edge is `S` times that long edge over `L`, rounded by `2 * Math.round(x / 2)`.
Both sides are even; export preserves this master size.

Master and output are opaque sRGB.
Render the complete applicable still chain at divisor 1 with identity camera, then `canvas.toBlob('image/png')`, producing `File("<title>.png")`.
Present is a plain blit; CSS preview scaling does not affect exported pixels.
Use the scene’s stored `seed` and grain hash frame 0, without reseeding.
Repeated exports of unchanged inputs therefore retain the same grain pattern.