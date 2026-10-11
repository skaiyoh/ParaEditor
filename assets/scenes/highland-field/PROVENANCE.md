# Highland field

> Owns: scene authorship, reproduction, local viewing, and delivery limitations.
> Does not own: application behavior or project status; see [direction](DIRECTION.md) and the [dispatch](../../../plan/dispatches/BLD4-highland-field.md).

Original scene authored for Nathan on 2026-10-11 with Blender 5.2.2 LTS.
The meadow, curved grass blades, seed heads, buttercups, irregular stones, cairn, mountain ridges, materials, sky, and lighting are procedural source geometry.
No downloaded game meshes, stock images, texture packs, or image-generation service were used.
The Skyrim reference describes the requested alpine atmosphere; this scene contains no Skyrim assets.
Each delivered PNG embeds its native-render origin without changing its pixels.

From the repository root, reproduce the editable scene, opaque 1920 x 1440 source image, geometry, metadata, and three native reference views with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python assets/scenes/highland-field/build_scene.py -- --views
```

The builder uses Blender's Python API and standard library, seed `411102026`, and a separate seed `411102027` for near-ground coverage visible through the portrait aperture.
It selects Cycles Metal GPU rendering when available and otherwise retains CPU rendering.
The `.blend` has no external texture files and includes an editable, fixed-orientation camera animation on frames 1-120 at 30 fps.
Its four construction walls are hidden in the saved viewport, all renders, and the exported mesh.

Run the standalone viewer locally:

```sh
npm run build
node assets/scenes/highland-field/serve.mjs --port 8794
```

Open <http://127.0.0.1:8794/>.
Move the pointer, drag on touch, or use arrow keys; Home and Recenter reset the viewpoint.
Head tracking asks for camera permission, then briefly calibrates the resting position.
The approved default is 2x gain, adjustable from 1x to 6x.
A critically damped spring interpolates camera samples at the display rate; reduced-motion mode responds immediately.
Tilt requires a deliberate action and sensor permission where the browser requires it.
Camera tracks and the face worker stop on cancellation, backgrounding, page exit, failure, or an explicit stop.

Tracking reuses this repository's existing camera source, locked UltraFace model, face worker, ONNX Runtime Web, cache validation, and protocol parser.
It adds no runtime dependency and makes no tracking requests to a remote service.
After changing `tracking.entry.js`, regenerate its bundle with:

```sh
node assets/scenes/highland-field/build_tracking.mjs
```

`field.mesh` is the authored scene's interleaved `HLF1` mesh, described by `field.json` and the builder.
The dependency-free WebGL2 viewer renders actual depth-tested triangles with an off-axis projection anchored to the monitor plane.
Eye movement changes which foreground stones conceal the field and objects behind them.
The eye's viewing distance is fixed at eight scene units, with exaggerated calibrated relative movement; it is not a physical eye-position measurement.

The source PNG opens in Noisy through its existing still-image workflow.
That workflow infers bounded 2.5D depth and cannot recover the original hidden geometry.
The standalone native-geometry viewer is a separate demonstration, and no application import or renderer integration is included.
Native Blender references use Cycles, physical sky, volumetric haze, and AgX; the browser uses procedural GLSL lighting, a shadow map, and analytic atmosphere, so their lighting differs.

Browser checks and independent review are recorded in the [return](../../../plan/evidence/BLD4-highland-field-return.md).
Desktop Chrome evidence does not establish physical iPad Safari permissions, sensors, memory, or sustained device performance.
