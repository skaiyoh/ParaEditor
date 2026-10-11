"""Export the original scene as a closed, genuinely 3D browser showcase.

Run in isolated Blender; never saves or changes the source blend on disk.
Lighting references are still textures; the viewer rasterizes actual geometry.
"""
import array
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

started = time.perf_counter()
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'src/dev/assets/lantern-court'
OUT.mkdir(parents=True, exist_ok=True)
encoder = shutil.which('cwebp')
if encoder is None:
    raise RuntimeError('The installed cwebp encoder is required; no dependency is installed by this script.')
scene = bpy.context.scene
if scene.camera is None or 'Lantern Court' not in scene.camera.name:
    raise RuntimeError('Open lantern-court.blend before running this exporter.')
scene.frame_set(1)
camera = scene.camera
camera.animation_data_clear()
camera.data.animation_data_clear()
# A level, fixed window basis keeps the cavity floor below the authored garden.
# The source camera and its animation on disk are untouched.
camera.rotation_euler = Vector((0, 1, 0)).to_track_quat('-Z', 'Y').to_euler()
base = camera.location.copy()
rotation = camera.rotation_euler.to_quaternion()
right, up = rotation @ Vector((1, 0, 0)), rotation @ Vector((0, 1, 0))
forward = rotation @ Vector((0, 0, -1))
# A physical glass plane, rather than the distant pavilion, anchors projection.
# Every pixel is the ray through one fixed point on this plane, as in Nathan's
# ray-march-test/parallax/main.odin. The cavity is geometry, never a wall-hiding rule.
convergence = 7.1
half_width, half_height, box_depth = 3.95, 3.05, 25.0
camera.data.clip_start = convergence - .02
omitted = []
for obj in list(scene.objects):
    if obj.hide_render or obj.type != 'MESH' or obj.name in {'Garden foundation', 'Path dark grout'}:
        continue
    # Keep the volume for the baked atmosphere, but never export it as a surface.
    if obj.data.materials and all(material and material.use_nodes and not any(node.type == 'BSDF_PRINCIPLED' for node in material.node_tree.nodes) for material in obj.data.materials):
        continue
    minimum = min((obj.matrix_world @ Vector(corner) - base).dot(forward) for corner in obj.bound_box)
    if minimum < convergence:
        obj.hide_render = True
        omitted.append(obj.name)


def room_material(name, color, metallic=0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = .65
    return material


wall = room_material('Showcase / recessed blue stone', (.018, .032, .039))
rim = room_material('Showcase / solid bronze window', (.095, .061, .028), .55)
trim = room_material('Showcase / bronze depth ribs', (.17, .11, .045), .45)


def room_box(name, x, y, depth, dimensions, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=base + right * x + up * y + forward * depth)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = camera.rotation_euler
    obj.scale = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)


for side in (-1, 1):
    room_box('Window side wall', side * (half_width + .1), 0, convergence + box_depth / 2,
             (.2, half_height * 2 + .4, box_depth), wall)
    room_box('Window ceiling or floor', 0, side * (half_height + .1), convergence + box_depth / 2,
             (half_width * 2, .2, box_depth), wall)
    room_box('Window frame vertical', side * (half_width + .35), 0, convergence + .06,
             (.7, half_height * 2 + 1.4, .12), rim)
    room_box('Window frame horizontal', 0, side * (half_height + .35), convergence + .06,
             (half_width * 2, .7, .12), rim)
    for depth in (1.5, 4, 8, 14, 21):
        room_box('Recess vertical depth rib', side * (half_width - .015), 0, convergence + depth,
                 (.035, half_height * 2, .055), trim)
        room_box('Recess horizontal depth rib', 0, side * (half_height - .015), convergence + depth,
                 (half_width * 2, .035, .055), trim)
room_box('Window back wall', 0, 0, convergence + box_depth + .1,
         (half_width * 2, half_height * 2, .2), wall)
scene.render.resolution_x, scene.render.resolution_y = 1280, 960
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.eevee.taa_render_samples = 64


def flat(matrix):
    return [float(matrix[row][column]) for column in range(4) for row in range(4)]


def pose(x, y):
    camera.location = base + right * x + up * y
    camera.data.shift_x = -x * camera.data.lens / (convergence * camera.data.sensor_width)
    camera.data.shift_y = -y * camera.data.lens / (convergence * camera.data.sensor_width)
    bpy.context.view_layer.update()
    projection = camera.calc_matrix_camera(bpy.context.evaluated_depsgraph_get(), x=1280, y=960)
    view = camera.matrix_world.inverted()
    return projection, view


groups = {}
materials = {}
depsgraph = bpy.context.evaluated_depsgraph_get()
exported_objects = 0
for obj in scene.objects:
    if obj.hide_render or obj.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT'}:
        continue
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    if mesh is None:
        continue
    try:
        mesh.calc_loop_triangles()
        normal_matrix = obj.matrix_world.to_3x3().inverted().transposed()
        exported = False
        for triangle in mesh.loop_triangles:
            material = mesh.materials[triangle.material_index] if len(mesh.materials) > triangle.material_index else None
            nodes = material.node_tree.nodes if material and material.use_nodes else []
            bsdf = next((node for node in nodes if node.type == 'BSDF_PRINCIPLED'), None)
            # The atmosphere cube has only a volume output, never a surface.
            if material and bsdf is None:
                continue
            name = material.name if material else 'Unassigned surface'
            if name not in groups:
                groups[name] = array.array('f')
                materials[name] = {
                    'name': name,
                    'color': list(bsdf.inputs['Base Color'].default_value[:3]) if bsdf else [.3, .3, .3],
                    'emission': float(bsdf.inputs['Emission Strength'].default_value) if bsdf else 0,
                    'lighting': 'world' if name.startswith('Showcase /') else 'baked',
                }
            values = groups[name]
            for index in triangle.vertices:
                vertex = mesh.vertices[index]
                position = obj.matrix_world @ vertex.co
                normal = (normal_matrix @ (vertex.normal if triangle.use_smooth else triangle.normal)).normalized()
                values.extend((*position, *normal))
            exported = True
        exported_objects += int(exported)
    finally:
        evaluated.to_mesh_clear()

vertices = array.array('f')
batches = []
for name, values in groups.items():
    batches.append({**materials[name], 'first': len(vertices) // 6, 'count': len(values) // 6})
    vertices.extend(values)
if sys.byteorder != 'little':
    vertices.byteswap()
geometry = vertices.tobytes()
(OUT / 'geometry.bin').write_bytes(geometry)

neutral_projection, neutral_view = pose(0, 0)
x_projection, _ = pose(1, 0)
y_projection, _ = pose(0, 1)
manifest = {
    'version': 1, 'title': 'Lantern Court', 'authoredGeometry': True,
    'geometry': 'geometry.bin', 'vertexCount': len(vertices) // 6,
    'geometrySha256': hashlib.sha256(geometry).hexdigest(),
    'objects': exported_objects, 'batches': batches, 'size': [1280, 960],
    'camera': {
        'projection': flat(neutral_projection), 'view': flat(neutral_view),
        'position': list(base), 'right': list(right), 'up': list(up),
        'shift': [x_projection[0][2] - neutral_projection[0][2], y_projection[1][2] - neutral_projection[1][2]],
        'near': camera.data.clip_start, 'far': camera.data.clip_end,
        'travel': [4.5, 3.5], 'convergence': convergence,
        'window': {'halfWidth': half_width, 'halfHeight': half_height, 'depth': box_depth},
    },
    'landmarks': {'lantern': [-2.48, -1.35, 3.22], 'pavilion': [0, 20, 4.3]},
    'references': [],
    'omittedBeforeGlass': omitted,
    'provenance': 'Original Blender triangles and procedural scene. Five static lighting references; continuous WebGL2 geometry rendering, not video or inferred depth.',
}
pose(0, 0)
manifest['neutralProjection'] = {name: list(world_to_camera_view(scene, camera, Vector(point)))[:2] for name, point in manifest['landmarks'].items()}
with tempfile.TemporaryDirectory(prefix='noisy-showcase-') as temporary:
    for name, x, y in [('neutral', 0, 0), ('left', -4.65, 0), ('right', 4.65, 0), ('down', 0, -3.65), ('up', 0, 3.65)]:
        projection, view = pose(x, y)
        scene.render.filepath = str(Path(temporary) / f'{name}.png')
        bpy.ops.render.render(write_still=True)
        target = OUT / f'{name}.webp'
        subprocess.run([encoder, '-quiet', '-q', '94', '-m', '6', scene.render.filepath, '-o', str(target)], check=True)
        manifest['references'].append({'image': target.name, 'matrix': flat(projection @ view), 'eye': [x, y]})
        sidecar = {'origin': 'Original Blender render from assets/scenes/lantern-court/lantern-court.blend',
                   'prompt': f'Origin: original Blender render from assets/scenes/lantern-court/lantern-court.blend, prepared by assets/scenes/lantern-court/export_showcase.py. Lighting reference {name} for a fixed-glass geometry showcase. No AI-generated imagery or downloaded assets.',
                   'script': 'assets/scenes/lantern-court/export_showcase.py', 'view': name, 'eye': [x, y],
                   'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
        (OUT / f'{name}.webp.json').write_text(json.dumps(sidecar, indent=2) + '\n')
manifest['elapsedSeconds'] = time.perf_counter() - started
(OUT / 'scene.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('BLD4_EXPORT_COMPLETE ' + json.dumps({'vertices': manifest['vertexCount'], 'objects': exported_objects,
      'bytes': len(geometry), 'seconds': manifest['elapsedSeconds'], 'output': str(OUT)}))
