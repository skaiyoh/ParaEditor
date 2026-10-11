# Export a scene from Blender

> This guide owns installation and use of [the Noisy exporter](noisy_scene_export.py).
> The package format and browser APIs are owned by [SCN2 contract C2](../../.codex/work/SCN2/contract.md).

1. In Blender 4.2 or newer, open **Edit > Preferences > Add-ons > Install**.
   In newer Blender versions, **Install from Disk** is in the Add-ons dropdown menu at the top right.
   Choose `tools/blender/noisy_scene_export.py`, then enable **Noisy scene exporter**.
2. Open or build your scene.
   The exporter includes mesh objects visible in the current view layer and enabled for rendering, with their evaluated modifiers and world transforms.
   Hidden objects and objects with no faces are omitted.
3. Select a near landmark and open **Object Properties > Custom Properties > New**.
   Edit the property name to `noisy_kind`, set its type to **Integer**, and set its value to **1**.
   Give a far landmark the same property with value **3**.
   Both objects must remain visible and have faces.
   Other meshes default to kind **2**; explicit kinds are 0 ground, 1 near stone, 2 grass, 3 distant mountain, 4 flower, and 5 wall.
4. Set the active camera to **Perspective**.
   Position it at a negative world Y coordinate, with Euler rotation **X 90°, Y 0°, Z 0°**.
   World +Y points into the landscape and +Z points up.
   The viewer uses a fixed off-axis window on the world Y=0 plane, so a tilted or orthographic camera is refused.
   The camera lens, render aspect ratio, and lens shift determine the window dimensions.
   The exporter stores a canonical 4:3 window so the viewer reproduces the authored framing at the same wide or portrait aspect ratio.
   A horizontal shift recenters the exported geometry and eye together without changing their relative positions.
5. Add a visible **Sun** light and rotate it to set the sunlight direction.
   When several Sun lights exist, the exporter uses the first by object name.
   Give meshes an `Albedo` color attribute (Point or Face Corner, linear RGB), or another active color attribute.
   Otherwise the exporter uses the material's Principled Base Color, or material diffuse color.
   Procedural node graphs and image textures are not baked; use a color attribute for their browser appearance.
6. Choose **File > Export > Noisy scene (.noisyscene)**.
   Enter a title, filename, and positive horizontal/vertical head travel distances in scene units.
   Keep scene geometry large enough to cover those camera movements.
   Optionally select an existing PNG or JPEG under **Existing poster**.
   Leaving it empty renders the active camera with the current render engine, at the selected longest edge (960 pixels by default), and restores the render output settings afterward.
7. Click **Export Noisy scene**.
   The export needs a kind 1 and kind 3 landmark, at most 4096 objects, at most two million vertices/triangles, an 80 MiB mesh, an 8 MiB poster, and a 96 MiB package.
   Face corners preserve split normals and corner colors, so exported vertex counts can exceed Blender's shared vertex count.
8. In Noisy's scene gallery, choose **Upload** and select the `.noisyscene` file.
   Imported scenes stay in this browser's local IndexedDB across reloads.
   Clearing site data removes them; another device or browser needs its own upload.

Noisy imports `.noisyscene` packages exported from Blender.
It does not import raw `.blend` files.

An existing Highland-format export can also be packed without Blender:

```sh
node tools/make-scene-package.mjs field.json field.mesh poster.png scene.noisyscene 'Scene title'
```
