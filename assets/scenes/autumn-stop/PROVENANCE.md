# Last Light / autumn stop

Author: OpenAI Codex, created for Nathan Davis under dispatch BLD1.
Date: 2026-10-10 (America/New_York).
Blender: 5.2.2 LTS, build `d13f752e3b9c`, Darwin, released build dated 2026-09-15.
License: same as the repository.
This checkout has no root license file or package license declaration; this asset grants no additional license independently of the repository.

## Original work and reference

The Python scene builder, layout, geometry, folded leaves, materials, lighting, camera composition, and fictional “LAST LIGHT / ROUTE 08” station identity were authored for this dispatch.
Everything is built from Blender primitives, original mesh vertices, and Blender's built-in text font.
There are no downloaded assets, third-party models, image textures, or external scene files.
The script uses a local seeded random generator (`8102026`) for repeatable leaf placement and angular crown rotations.

The inspiration is [ember.lite's autumn gas-station reel](https://www.instagram.com/p/Dd9rXjShUGp/), as described in [RX2 section 4](../../../plan/evidence/RX2-reels.md#4-emberlite-autumn-gas-station).
The reference contributed the general idea of a low-poly autumn roadside scene, angular trees, and warm pools of light against a cool night.
This scene uses its own station name, single-pump layout, pylon sign, shop, road markings, tree arrangement, camera, and lighting.
No frames, models, textures, or geometry were extracted from the reference.
The supplied RX2 analysis was read; the original reel was not independently inspected during BLD1.

## Rebuild the Blender source

Run from the repository root:

```sh
/usr/bin/time -p /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python assets/scenes/autumn-stop/build_scene.py
```

The script resets to an empty scene, saves `autumn-stop.blend`, and renders `autumn-stop.png` with Eevee.
It resolves its output directory from its own path, uses no input blend file, and does not touch `app-output/`.
Factory startup prevents the user's saved startup scene and addons from participating.
The still is 1600 × 1000, 8-bit RGB PNG, opaque, landscape, with no alpha channel.
Only frame 1 exists in the scene's render range.
Blender does not render animation for this asset.

The final script was run after deleting both generated files.
Observed timing: `real 3.96`, `user 1.47`, `sys 0.59` seconds; the script's own build-and-render timer reported 2.79 seconds.
Placement is reproducible; byte-identical PNG encoding across Blender/GPU runs is not claimed.

## App derivatives

Both files in `app-output/` were produced by the actual Noisy dev editor in headless Chrome `155.0.8059.39`, using device analysis on 2026-10-10.
The source scene, script, and still were unchanged during the successful BLD1 resume.

| File | Dimensions | Bytes | Content |
| --- | --- | ---: | --- |
| `autumn-stop-noisy.png` | 1600 × 1000 | 2,819,698 | PNG Download after pump-body recolor and Fry change; fully opaque. |
| `autumn-stop-noisy-loop.gif` | 640 × 400 | 7,840,073 | GIF Export: 45 frames over exactly 3 seconds, 15 fps, infinite looping. |

The temporary `bld1.autumn-stop` scenario imported the source through the editor's file input and observed “Ready to tap”.
It used the same test-hook path as `objects.tap`: master pixel coordinates divided by the actual master width and height before calling `demo.tap`.
It tested pump `(740, 590)`, canopy `(850, 360)`, sign `(460, 390)`, and red tree `(1230, 330)` independently, resetting between probes.
All four points selected an object.
The scenario observed the real decoder worker's messages without modifying prompts, masks, scores, or candidate ranking.
All three candidate scores for every probe and the final export tap, actual normalized worker prompts, mask areas, selection bounds, document seed, and edit settings are retained in [workflow.json](app-output/workflow.json).

For the outputs, the scenario reset to zero objects and made one fresh pump-body tap at `(740 / 1600, 590 / 1000)`.
The app selected the pump's lower body, with master bounds `(704, 576, 71, 73)` and top candidate score `0.9593358039855957`.
The scenario clicked the Green swatch, changed Fry through its input from 0.60 to 0.72, and clicked Download.
It then enabled Motion, set side-to-side Drift Amount to 0.30, Depth to 1, and Loop seconds to 3, waited for the app's background preparation, and clicked Export GIF.
The files preserve the actual blobs supplied to the app's download anchors, following the repository's `export.loop` capture pattern.
No masks were injected, no alternative model was used, and neither derivative was synthesized independently of the app renderer.
The temporary scenario and registration were removed after verification.

The motion output is the app's, not Blender's.
The GIF animates Noisy's inferred depth, prepared background, and image treatment from a single opaque still.
Blender rendered only the still; the source leaves and scene geometry have no animation.

The PNG was opened and shows a bright green pump base in a coarse, grainy purple-orange night scene, with an ivory canopy and amber forecourt.
The GIF was opened and inspected at frames 0, 11, 22, 33, and 44; the same treatment and green pump remain visible through gentle depth-based drift.
Decoding confirmed 45 distinct frames and an infinite-loop extension.
See the [BLD1 return](../../../plan/evidence/BLD1-return.md) for acceptance evidence and verification details.
