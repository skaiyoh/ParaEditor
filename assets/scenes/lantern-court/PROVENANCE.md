# Lantern Court

> Owns the original scene's authorship, reproduction, and presentation instructions.
> Does not own application implementation or release status; verification belongs to the [BLD2 return](../../../plan/evidence/BLD2-return.md) and captured [app workflow](app-output/workflow.json).
> The separate fixed-window geometry showcase is verified in the [BLD4 return](../../../plan/evidence/BLD4-return.md).

Author: OpenAI Codex, created for Nathan Davis's direct scene request under [BLD2](../../../plan/dispatches/BLD2-lantern-court.md).
Date: 2026-10-11, America/New_York.
Blender: 5.2.2 LTS, build `d13f752e3b9c`.
License: same as the repository.
This checkout has no root license file or package license declaration; this asset does not grant an independent additional license.

## Original work

All meshes, procedural materials, composition, lighting, and camera movement were authored for this task.
There are no downloaded models, image textures, generated AI assets, external image files, or required Blender addons.
Placement and foliage are seeded with `11102026`.
The broad architectural and garden motifs are original arrangements, without a specific borrowed artwork or model reference.

The scene has 825 objects and 25 materials.
Its layers are a close masonry gate and hanging lanterns, path lights, a lotus pool and curved bridge, a warm pavilion, garden trees, and distant mountains and moon.
The camera is perspective, with a 30 mm lens and a 36 mm sensor.
Its preview translates the viewpoint without rotating the camera, using lens shift to hold the convergence plane steady.
See the [Blender camera manual](https://docs.staging.blender.org/manual/en/latest/render/cameras.html) for perspective and lens-shift controls.

## View the native scene

Open [lantern-court.blend](lantern-court.blend) in Blender.
The viewport is saved in camera view with material shading, scene lights, and scene world enabled.
Press Space to play its four-second native camera loop, frames 1-120 at 30 fps.
The loop moves horizontally by up to 0.55 m and vertically by up to 0.12 m.
Frame 1 is the neutral source viewpoint, frame 31 is one horizontal extreme, and frame 91 is the other.
The headless saved-file check measured about 145 pixels of relative movement between the near lantern and pavilion across those extremes at 1920 pixels wide.
The saved-file check verifies the camera animation and matching loop endpoints; interactive viewport playback speed has not been measured.

[Native Blender preview](native-reference/lantern-court-native.gif) shows the actual Blender camera timeline, sampled at 15 fps.
It is a 768 x 576, 60-frame, four-second preview of genuine scene geometry.
The files in `native-reference/` are Blender references, not Noisy output.

## Rebuild

From the repository root:

```sh
/usr/bin/time -p /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python assets/scenes/lantern-court/build_scene.py -- --views
```

This replaces the saved Blender scene and opaque 1920 x 1440 RGB still and writes projection evidence.
The optional `--views` also writes native left/right reference renders under `/tmp/noisy-bld2/`.
Observed final timing was `real 36.19`, `user 37.44`, `sys 4.94` seconds.
The script reported 35.375 seconds of its own build, render, and save work.
Omit `--views` to build only the saved scene and neutral still.
Use `-- --draft` for a 960 x 720 draft under `/tmp/noisy-bld2/`, without replacing the delivered scene or source still.
Deterministic placement is guaranteed by the script; byte-identical render encoding across GPU runs is not claimed.

To regenerate the native GIF with the installed FFmpeg encoder:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup assets/scenes/lantern-court/lantern-court.blend --python assets/scenes/lantern-court/render_preview.py
```

This reads the saved scene, renders temporary frames, and writes only the GIF under `native-reference/`.
It does not change the saved scene or the full-resolution source still.
The delivered preview was rendered and encoded in separate equivalent stages; this combined wrapper was not rerun over all 60 frames.

## Noisy derivatives and measured limitation

The Noisy app receives only [lantern-court.png](lantern-court.png), an opaque still.
It does not receive the Blender geometry, animation, native depth values, or native reference images.
The app's images and GIF in `app-output/` are actual outputs from the dev editor in headless Chrome `155.0.8059.39`, using device analysis.
The test imported the source through the real file input and waited for depth, embeddings, and the selection decoder.
No depth maps, masks, background plates, or model results were injected.

The first run tapped one near lantern and used a stronger color treatment.
The final run tapped the lantern and one stone on each foreground pier using actual SAM, used Fry 0.12 with reduced finishing, and captured neutral/left/right live perspective views.
The final taps were normalized source coordinates `(0.261223, 0.472335)`, `(0.16, 0.68)`, and `(0.84, 0.67)`.
The two masonry taps selected individual stones, not the complete gate.
Viewer positions were scripted to test the existing live perspective path; physical face tracking and iPad behavior were not verified.

The PNG is the editor's actual still-download result.
The GIF is the actual download blob from its Export GIF control, with side-to-side Drift 0.65, Depth 1.6, and a three-second loop.
The motion in `app-output/` is Noisy's inferred 2.5D motion, not Blender's native camera animation.

Both runs reported `Travel reduced to preserve depth edges`.
Final live travel scale was approximately 0.176, with only four master pixels of relative movement between the near lantern and pavilion across the scripted left/right views.
The final live screenshots also expose cutout/disocclusion artifacts around selected lantern and stone edges.
The functional workflow passed, but this Noisy interpretation is not a convincing substitute for the native 3D camera preview.
Use the native Blender preview when demonstrating this authored scene's actual perspective depth, and identify it as Blender output.
Do not describe it as a capability demonstrated by the current Noisy importer.

## Prepared 3D window showcase

The separate dev page at `http://localhost:8790/dev/showcase.html` renders original triangles continuously in WebGL2.
It is an authored scene showcase, not a photograph-import feature or a prerecorded animation.
The webcam supplies calibrated relative face coordinates; its virtual eye travel is deliberately exaggerated rather than a metric eye measurement.

The screen is a fixed glass plane, following Nathan's `ray-march-test/parallax/main.odin` experiment.
The prepared camera uses the original location and 30 mm lens with a level orientation, a glass distance of 7.1 authored metres, and matching off-axis projection.
A solid frame surrounds five cavity surfaces and physical depth ribs.
The cavity opening is 7.9 by 6.1 metres and extends 25 metres behind the glass.
Virtual eye travel is bounded to ±4.5 metres horizontally and ±3.5 vertically, allowing the right or top wall to leave the opening naturally.
All changes occur in an isolated Blender process; the original saved scene, timeline, and still remain unchanged.

The export contains 92,420 triangles from 798 surface objects.
It omits 38 original objects before or crossing the glass from both the lighting renders and geometry, recording their names in `scene.json`.
The original garden foundation stays below the cavity opening; the volume-only atmosphere is never exported as a surface.
Five 1280 by 960 WebP reference renders supply the courtyard's baked lighting, with matching geometry-derived depth visibility buffers.
The broad new cavity surfaces use continuous world-space lighting to avoid projected lighting seams.
Each reference carries an origin sidecar generated by the exporter.

Reproduce the dev assets from the repository root:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup assets/scenes/lantern-court/lantern-court.blend --python assets/scenes/lantern-court/export_showcase.py
npm run build
npm run serve
```

The exporter uses the already installed `cwebp` encoder and installs no dependency.
It writes the closed prepared scene under `src/dev/assets/lantern-court/`.
The measured delivered export took 16.627 seconds.
The build copies these assets and the showcase only in dev mode; production excludes them.
Start camera, hold still to calibrate, and lean sideways or vertically.
Recenter sets a new rest position; Stop camera or backgrounding releases the video track, and pointer or drag exploration remains available with the camera off.
