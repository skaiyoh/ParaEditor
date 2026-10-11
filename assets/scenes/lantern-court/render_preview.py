"""Render the saved native Blender camera loop, never the Noisy app output.

Blender --background --factory-startup lantern-court.blend --python render_preview.py
Requires the already-installed ffmpeg CLI for GIF encoding; no Blender addon.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

import bpy


OUT = Path(__file__).resolve().parent / 'native-reference'
encoder = shutil.which('ffmpeg')
if encoder is None:
    raise RuntimeError('The native GIF preview needs the ffmpeg command-line encoder on PATH.')
scene = bpy.context.scene
if scene.get('title') != 'Lantern Court' or scene.camera is None:
    raise RuntimeError('Open lantern-court.blend before running render_preview.py.')
OUT.mkdir(parents=True, exist_ok=True)
scene.render.resolution_x, scene.render.resolution_y = 768, 576
scene.eevee.taa_render_samples = 32
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.resolution_percentage = 100
with tempfile.TemporaryDirectory(prefix='lantern-court-native-') as work:
    frames = Path(work)
    for i, frame in enumerate(range(1, 121, 2)):
        scene.frame_set(frame)
        scene.render.filepath = str(frames / f'{i:04d}.png')
        bpy.ops.render.render(write_still=True)
    subprocess.run([
        encoder, '-v', 'error', '-y', '-framerate', '15', '-i', str(frames / '%04d.png'),
        '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a',
        '-loop', '0', str(OUT / 'lantern-court-native.gif'),
    ], check=True)
print('Native Blender preview complete: 768x576, 60 frames, 4 seconds. NOT Noisy output.')
