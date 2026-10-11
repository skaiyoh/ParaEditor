"""Original Highland Field, Blender 5.2.

blender --background --factory-startup --python build_scene.py -- --views
No downloaded assets or third-party Python packages. All geometry has real backs/sides.
The browser export is a small documented interleaved mesh, not a .blend importer.
"""

import argparse
from array import array
import json
import math
from pathlib import Path
import random
import struct
import sys
import time
import zlib

import bpy
from mathutils import Vector, noise
from bpy_extras.object_utils import world_to_camera_view


START = time.perf_counter()
OUT = Path(__file__).resolve().parent
RNG = random.Random(411102026)
parser = argparse.ArgumentParser()
parser.add_argument('--draft', action='store_true')
parser.add_argument('--views', action='store_true')
parser.add_argument('--no-render', action='store_true')
ARGS = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene


def record_png_origin(filename, view):
    """Keep native-render provenance inside the PNG without changing its pixels."""
    filename = Path(filename)
    image = filename.read_bytes()
    if image[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Expected a Blender PNG render')
    text = (f'Origin: Original procedural Blender scene authored for Nathan on 2026-10-11. '
            f'Reproduce with Blender 5.2.2 LTS: --background --factory-startup '
            f'--python assets/scenes/highland-field/build_scene.py -- --views. '
            f'Cycles render, {view}; construction walls hidden. No downloaded meshes or textures.')
    payload = b'impeccable:prompt\0' + text.encode('latin1')
    chunk = b'tEXt' + payload
    encoded = struct.pack('>I', len(payload)) + chunk + struct.pack('>I', zlib.crc32(chunk))
    # A Blender PNG ends with the standard, empty IEND chunk.
    if image[-8:-4] != b'IEND':
        raise ValueError('Expected a complete Blender PNG render')
    filename.write_bytes(image[:-12] + encoded + image[-12:])


def rgb(value):
    values = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values)


def mix(a, b, t):
    return tuple(x * (1 - t) + y * t for x, y in zip(a, b))


def n(x, y, z=0):
    return noise.noise(Vector((x, y, z)), noise_basis='PERLIN_ORIGINAL')


def fbm(x, y, z=0, octaves=4):
    result, amp, total = 0, 1, 0
    for _ in range(octaves):
        result += n(x, y, z) * amp
        total += amp
        x, y, z, amp = x * 2.09 + 7.1, y * 2.09 + 2.7, z * 2.09, amp * .49
    return result / total


def material(name, kind, roughness=.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = roughness
    attr = nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Albedo'
    links.new(attr.outputs['Color'], shader.inputs['Base Color'])
    if kind == 2:
        shader.inputs['Subsurface Weight'].default_value = .06
        shader.inputs['Roughness'].default_value = .73
        # Broad sky transmission keeps the fine blades luminous, not plastic.
        translucent = nodes.new('ShaderNodeBsdfTranslucent')
        links.new(attr.outputs['Color'], translucent.inputs['Color'])
        blend = nodes.new('ShaderNodeMixShader')
        blend.inputs[0].default_value = .22
        links.new(shader.outputs[0], blend.inputs[1])
        links.new(translucent.outputs[0], blend.inputs[2])
        output = next(node for node in nodes if node.type == 'OUTPUT_MATERIAL')
        links.new(blend.outputs[0], output.inputs['Surface'])
    else:
        geom = nodes.new('ShaderNodeNewGeometry')
        tex = nodes.new('ShaderNodeTexNoise')
        tex.inputs['Scale'].default_value = 6 if kind == 1 else 1.1
        tex.inputs['Detail'].default_value = 4
        tex.inputs['Roughness'].default_value = .78
        links.new(geom.outputs['Position'], tex.inputs['Vector'])
        modulation = nodes.new('ShaderNodeMixRGB')
        modulation.blend_type = 'MULTIPLY'
        modulation.inputs[0].default_value = .25 if kind != 1 else .45
        links.new(attr.outputs['Color'], modulation.inputs[1])
        links.new(tex.outputs['Color'], modulation.inputs[2])
        links.new(modulation.outputs[0], shader.inputs['Base Color'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .38 if kind == 1 else .22
        bump.inputs['Distance'].default_value = .09 if kind == 1 else .035
        links.new(tex.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs[0], shader.inputs['Normal'])
    return mat


earth_mat = material('Meadow soil and distant sward', 0)
rock_mat = material('Weathered granite, mineral veins and lichen', 1)
grass_mat = material('Living meadow grass with pale dry tips', 2)
mountain_mat = material('Alpine bedrock, snow and scree', 3)
flower_mat = material('Wildflower petals', 4)
wall_mat = material('Matte charcoal stone window reveal', 5)
MATERIALS = [earth_mat, rock_mat, grass_mat, mountain_mat, flower_mat, wall_mat]
collections = {}
for title in ['01 Meadow', '02 Foreground stones', '03 Peripheral discoveries', '04 Mountain ranges', '05 Wild grass', '06 Light and window']:
    coll = bpy.data.collections.new(title)
    scene.collection.children.link(coll)
    collections[title] = coll


def mesh_object(name, verts, faces, colors, kind, collection, smooth=True):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.materials.append(MATERIALS[kind])
    attr = mesh.color_attributes.new(name='Albedo', type='FLOAT_COLOR', domain='POINT')
    attr.data.foreach_set('color', [c for value in colors for c in (*value, 1)])
    if smooth:
        mesh.polygons.foreach_set('use_smooth', [True] * len(mesh.polygons))
    obj = bpy.data.objects.new(name, mesh)
    collections[collection].objects.link(obj)
    obj['material_kind'] = kind
    return obj


def ground(x, y):
    value = .16 * math.sin(x * .13 + y * .065) + .19 * math.sin(y * .088)
    value += .29 * math.sin(x * .033 + y * .032)
    value += .07 * fbm(x * .8, y * .8)
    value += 4.8 * math.exp(-((x + 66) / 46) ** 2 - ((y - 112) / 65) ** 2)
    value += 3.9 * math.exp(-((x - 81) / 55) ** 2 - ((y - 165) / 78) ** 2)
    return value


# The land continues well outside every allowed camera view.
verts, faces, colors = [], [], []
nx, ny = 218, 234
for j in range(ny + 1):
    y = -18 + 440 * (j / ny) ** 1.85
    for i in range(nx + 1):
        x = -195 + 390 * i / nx
        z = ground(x, y)
        verts.append((x, y, z))
        variation = max(0, min(1, .48 + .6 * fbm(x * .14, y * .14)))
        c = mix(rgb('414c29'), rgb('919263'), variation)
        path_x = 1.2 + 2.2 * math.sin(y * .025)
        # A nearly lost animal track gives scale without filling the field.
        path = math.exp(-((x - path_x) / (.28 + max(y, 0) * .007)) ** 2) * .22
        colors.append(mix(c, rgb('969076'), path))
for j in range(ny):
    for i in range(nx):
        a = j * (nx + 1) + i
        faces.append((a, a + 1, a + nx + 2, a + nx + 1))
mesh_object('Unbroken rolling meadow', verts, faces, colors, 0, '01 Meadow')


def mountains(name, x_span, y_start, y_depth, peaks, grid, tint):
    verts, faces, colors = [], [], []
    nx, ny = grid
    for j in range(ny + 1):
        y = y_start + y_depth * j / ny
        for i in range(nx + 1):
            x = -x_span + 2 * x_span * i / nx
            masses = [h * math.exp(-abs((x - cx) / w) ** 1.5 - abs((y - cy) / d) ** 1.7)
                      for cx, cy, h, w, d in peaks]
            envelope = max(masses)
            coarse = fbm(x * .024, y * .024, 4, 5)
            ridges = abs(n(x * .061, y * .045, 1.8))
            fine = fbm(x * .16, y * .16, 1, 3)
            z = envelope * (.90 + .33 * coarse + .21 * ridges) + envelope ** .6 * fine * .6 - 3
            verts.append((x, y, z))
            rock_color = mix(rgb('626b68'), rgb('a2a395'), max(0, min(1, .48 + coarse + ridges * .3)))
            rock_color = mix(rock_color, rgb(tint), .12)
            snow_line = 80 + 24 * fbm(x * .07, y * .07, 9)
            snow = max(0, min(1, (z - snow_line) / 32))
            # Broken snow bands persist in crevices, rather than icing every face.
            snow *= max(.08, min(1, .5 + 1.4 * n(x * .13, y * .1, z * .035)))
            colors.append(mix(rock_color, rgb('e4e6db'), snow * .94))
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.extend([(a, a + 1, a + nx + 2), (a, a + nx + 2, a + nx + 1)])
    return mesh_object(name, verts, faces, colors, 3, '04 Mountain ranges', smooth=True)


mountains('Distant pale northern summits', 1250, 620, 650,
          [(-690, 920, 225, 225, 210), (-370, 880, 268, 180, 225), (15, 940, 306, 210, 230),
           (390, 900, 275, 185, 190), (760, 980, 268, 250, 245)], (242, 106), 'abbab8')
mountains('Great craggy central massif', 790, 306, 490,
          [(-520, 520, 137, 151, 130), (-285, 492, 159, 111, 142), (-88, 510, 195, 109, 151),
           (84, 498, 166, 92, 127), (260, 510, 209, 110, 143), (480, 555, 178, 142, 155)],
          (480, 220), '999c88')
mountains('Lower heather and scree foothills', 470, 145, 270,
          [(-270, 280, 48, 134, 90), (-150, 267, 40, 87, 76), (150, 302, 39, 107, 90),
           (310, 290, 58, 126, 90)], (162, 79), '637055')


def rock(name, x, y, size, lift=0, seed=None, collection='02 Foreground stones'):
    y += 3  # Every stone sits beyond the deep near-wall opening.
    local = random.Random(seed if seed is not None else RNG.randrange(10000000))
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
    src = bpy.context.object
    matrix = src.rotation_euler.to_matrix()
    verts, colors = [], []
    phase = local.random() * 50
    for v in src.data.vertices:
        p = v.co
        displacement = 1 + .32 * n(p.x * 1.8 + phase, p.y * 1.8, p.z * 1.8) + .12 * fbm(p.x * 7, p.y * 7, p.z * 7)
        px, py = p.x * size[0] * displacement, p.y * size[1] * displacement
        pz = p.z * size[2] * displacement
        # The flattened foot seats the rock in the ground rather than balancing on a point.
        pz = max(pz, -size[2] * .72)
        verts.append((x + px, y + py, ground(x, y) + lift + size[2] * .72 + pz))
        variation = max(0, min(1, .52 + fbm(p.x * 8 + phase, p.y * 8, p.z * 8) * .8))
        color = mix(rgb('434b42'), rgb('999b87'), variation)
        vein = abs(n(p.x * 17 + p.z * 6, p.y * 11, phase))
        if vein < .042:
            color = mix(color, rgb('d1cdb8'), .45)
        lichen = n(p.x * 4 + phase, p.y * 4, p.z * 4)
        if p.z > -.2 and lichen > .23:
            color = mix(color, rgb('7a824a'), min(.65, (lichen - .23) * 2))
        colors.append(color)
    faces = [tuple(p.vertices) for p in src.data.polygons]
    bpy.data.objects.remove(src, do_unlink=True)
    return mesh_object(name, verts, faces, colors, 1, collection)


# A squat, asymmetrical cairn and a close boulder define the aperture.
cairn_base = (-2.52, 2.1)
stack = [(1.02, .74, .36), (.78, .59, .31), (.55, .48, .28), (.42, .36, .22), (.27, .25, .18)]
z = 0
for i, size in enumerate(stack):
    rock(f'Foreground cairn / stone {i + 1}', cairn_base[0] + [.0, .06, -.07, .03, -.02][i],
         cairn_base[1] + [.0, .03, -.04, .02, -.01][i], size, lift=z, seed=141 + i)
    z += size[2] * 1.33
hero = rock('Near lichen boulder', 3.55, 1.3, (1.65, 1.25, 1.12), seed=7451)
rock('Grounded left companion', -4.5, 3.6, (.65, .49, .35), seed=212)
rock('Split slab at the near edge', 1.2, -.8, (.55, .36, .17), seed=133)
rock('Reveal stone behind the boulder', 4.45, 7.2, (.51, .49, .71), seed=886,
     collection='03 Peripheral discoveries')
rock('Beyond the right window edge', 10.2, 10.5, (.89, .67, .62), seed=472,
     collection='03 Peripheral discoveries')
rock('Beyond the left window edge', -9.4, 8.5, (1.02, .71, .82), seed=194,
     collection='03 Peripheral discoveries')
for i in range(83):
    y = RNG.uniform(11, 119)
    x = RNG.uniform(-36 - y * .22, 36 + y * .22)
    if abs(x) < 8 and y > 20 and RNG.random() < .8:
        continue
    s = RNG.uniform(.11, .48)
    rock(f'Meadow erratic {i:02}', x, y, (s * RNG.uniform(1, 1.9), s, s * .7))


# Batched curved tapered blades: fine real silhouettes, not flat image cards.
verts, faces, colors = [], [], []
palette = [rgb(c) for c in ['475c25', '607735', '7c9242', '89934f', '596b32', '818947']]


def add_blade(x, y, rng):
    z = ground(x, y) - .015
    h = rng.uniform(.18, .48) * (.7 + .5 * (n(x * .24, y * .24) + .5))
    width = rng.uniform(.009, .025)
    angle = rng.random() * math.tau
    dx, dy = math.cos(angle) * width, math.sin(angle) * width
    leanx, leany = rng.uniform(-.13, .13), rng.uniform(-.1, .1)
    a = len(verts)
    verts.extend([(x - dx, y - dy, z), (x + dx, y + dy, z),
                  (x - dx * .58 + leanx * .35, y - dy * .58 + leany * .35, z + h * .58),
                  (x + dx * .58 + leanx * .35, y + dy * .58 + leany * .35, z + h * .58),
                  (x + leanx, y + leany, z + h)])
    c = rng.choice(palette)
    root = tuple(v * .48 for v in c)
    tip = mix(c, rgb('c4b886'), rng.uniform(.08, .5))
    colors.extend([root, root, c, c, tip])
    faces.extend([(a, a + 1, a + 3), (a, a + 3, a + 2), (a + 2, a + 3, a + 4)])


for i in range(51000):
    y = -4 + 117 * RNG.random() ** 2.7
    x = RNG.uniform(-1, 1) * (8 + max(y, 0) * .67)
    # Keep rock bases natural, without blades passing through stone surfaces.
    if ((x - 3.55) / 1.65) ** 2 + ((y - 4.3) / 1.3) ** 2 < 1.07:
        continue
    if ((x + 2.52) / 1.05) ** 2 + ((y - 5.1) / .78) ** 2 < 1:
        continue
    track = abs(x - (1.2 + 2.2 * math.sin(y * .025)))
    if track < .28 + max(y, 0) * .007 and RNG.random() < .6:
        continue
    add_blade(x, y, RNG)

# Portrait and low-eye rays reach nearer ground. Preserve the approved meadow's
# random sequence and add coverage only in front of its existing blade envelope.
near_rng = random.Random(411102027)
for i in range(10000):
    add_blade(near_rng.uniform(-10, 10), near_rng.uniform(-7.9, -3.8), near_rng)
mesh_object('Individual curved meadow blades', verts, faces, colors, 2, '05 Wild grass')


# Sparse seed heads and small buttercups supply near scale, never a flower carpet.
verts, faces, colors = [], [], []
for i in range(340):
    x, y = RNG.uniform(-13, 13), RNG.uniform(-1, 23)
    z = ground(x, y)
    h = RNG.uniform(.32, .64)
    a = len(verts)
    verts.extend([(x - .006, y, z), (x + .006, y, z), (x + .03, y, z + h)])
    colors.extend([rgb('595f34')] * 3)
    faces.append((a, a + 1, a + 2))
    for k in range(4):
        angle = RNG.random() * math.tau
        r = RNG.uniform(.014, .027)
        cx, cy, cz = x + .03, y, z + h - k * .025
        a = len(verts)
        verts.extend([(cx - r, cy, cz), (cx + r, cy, cz), (cx, cy + .015, cz + .03)])
        colors.extend([rgb('b5a77e')] * 3)
        faces.append((a, a + 1, a + 2))
for i in range(110):
    x, y = RNG.uniform(-10, 10), RNG.uniform(-.5, 15)
    z = ground(x, y) + RNG.uniform(.15, .3)
    for k in range(5):
        t = k * math.tau / 5
        a = len(verts)
        dx, dy = math.cos(t) * .027, math.sin(t) * .027
        verts.extend([(x, y, z), (x + dx - dy * .6, y + dy + dx * .6, z + .012),
                      (x + dx + dy * .6, y + dy - dx * .6, z + .012)])
        colors.extend([rgb('d6bf6c')] * 3)
        faces.append((a, a + 1, a + 2))
mesh_object('Sparse meadow seed heads and buttercups', verts, faces, colors, 4, '05 Wild grass')


# Physically lit native source. The browser uses the same geometry with an analytic sky.
world = bpy.data.worlds.new('Clear alpine air')
world.use_nodes = True
scene.world = world
nodes, links = world.node_tree.nodes, world.node_tree.links
background = next(node for node in nodes if node.type == 'BACKGROUND')
sky = nodes.new('ShaderNodeTexSky')
sky_types = {entry.identifier for entry in sky.bl_rna.properties['sky_type'].enum_items}
sky.sky_type = 'MULTIPLE_SCATTERING' if 'MULTIPLE_SCATTERING' in sky_types else 'NISHITA'
sky.sun_elevation, sky.sun_rotation = math.radians(32), math.radians(220)
sky.sun_disc = False
sky.altitude, sky.air_density = 900, 1.1
if hasattr(sky, 'aerosol_density'):
    sky.aerosol_density = 2.2
else:
    sky.dust_density = 2.2
links.new(sky.outputs['Color'], background.inputs['Color'])
background.inputs['Strength'].default_value = .08
sun = bpy.data.lights.new('Soft late-afternoon sun', 'SUN')
sun.energy, sun.angle = 4.0, math.radians(5)
sun.color = (1, .91, .76)
sun_obj = bpy.data.objects.new('Soft late-afternoon sun', sun)
collections['06 Light and window'].objects.link(sun_obj)
SUN = Vector((-.57, -.34, .75)).normalized()
sun_obj.rotation_euler = (-SUN).to_track_quat('-Z', 'Y').to_euler()


# Subtle distance haze is actual world-space volume in the native render.
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 560, 180))
haze = bpy.context.object
haze.name = 'Thin alpine distance haze / native only'
haze.scale = (2600, 1700, 900)
volume = bpy.data.materials.new('Alpine aerosol')
volume.use_nodes = True
nodes, links = volume.node_tree.nodes, volume.node_tree.links
nodes.clear()
output = nodes.new('ShaderNodeOutputMaterial')
scatter = nodes.new('ShaderNodeVolumeScatter')
scatter.inputs['Color'].default_value = (.72, .82, .9, 1)
scatter.inputs['Density'].default_value = .00018
scatter.inputs['Anisotropy'].default_value = .18
links.new(scatter.outputs[0], output.inputs['Volume'])
haze.data.materials.append(volume)
haze['native_only'] = True
haze.display_type = 'WIRE'


cam_data = bpy.data.cameras.new('Fixed perspective window')
cam = bpy.data.objects.new('Fixed perspective window', cam_data)
collections['06 Light and window'].objects.link(cam)
scene.camera = cam
W, H, EYE_Y, EYE_Z, CENTER_Z = 26 / 3, 6.5, -8, 2.4, 2.8


def wall_box(name, bounds):
    x0, x1, y0, y1, z0, z1 = bounds
    verts = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    colors = [mix(rgb('40473f'), rgb('62685b'), (p[1] - y0) / (y1 - y0) * .3) for p in verts]
    return mesh_object(name, verts, faces, colors, 5, '06 Light and window', smooth=False)


walls = [wall_box('Near wall / left deep reveal', (-30, -W / 2, 0, 2.8, -22, 25)),
         wall_box('Near wall / right deep reveal', (W / 2, 30, 0, 2.8, -22, 25)),
         wall_box('Near wall / lower sill', (-W / 2, W / 2, 0, 2.8, -22, CENTER_Z - H / 2)),
         wall_box('Near wall / upper reveal', (-W / 2, W / 2, 0, 2.8, CENTER_Z + H / 2, 25))]
for wall in walls:
    wall['native_only'] = True  # Construction reference, never a box around the delivered view.
cam_data.type = 'PERSP'
cam_data.sensor_width, cam_data.sensor_fit = 36, 'HORIZONTAL'
cam_data.lens = 36 * -EYE_Y / W
cam_data.clip_start, cam_data.clip_end = .1, 4000
cam.rotation_euler = (math.pi / 2, 0, 0)


def eye(x=0, dy=0, dz=0):
    cam.location = (x, EYE_Y + dy, EYE_Z + dz)
    cam_data.lens = 36 * (-EYE_Y - dy) / W
    cam_data.shift_x = -x / W
    cam_data.shift_y = (CENTER_Z - EYE_Z - dz) / W
    bpy.context.view_layer.update()


for frame, pos in [(1, (0, 0, 0)), (31, (-3.6, 0, .65)), (61, (0, 0, 0)),
                   (91, (3.6, 0, -.65)), (121, (0, 0, 0))]:
    eye(*pos)
    cam.keyframe_insert('location', frame=frame)
    cam_data.keyframe_insert('shift_x', frame=frame)
    cam_data.keyframe_insert('shift_y', frame=frame)
scene.frame_start, scene.frame_end = 1, 120
scene.render.fps = 30
scene.frame_set(1)
eye()


def export_mesh():
    vertices, indices, objects = array('f'), array('I'), []
    for obj in scene.objects:
        if obj.type != 'MESH' or obj.get('native_only'):
            continue
        obj_id = len(objects) + 1
        mesh = obj.data
        mesh.calc_loop_triangles()
        start_vertex, start_index = len(vertices) // 11, len(indices)
        attr = mesh.color_attributes['Albedo']
        matrix, normals = obj.matrix_world, obj.matrix_world.to_3x3().inverted().transposed()
        for v in mesh.vertices:
            p = matrix @ v.co
            normal = (normals @ v.normal).normalized()
            c = attr.data[v.index].color
            vertices.extend((*p, *normal, c[0], c[1], c[2], float(obj['material_kind']), float(obj_id)))
        for triangle in mesh.loop_triangles:
            indices.extend(start_vertex + i for i in triangle.vertices)
        points = [matrix @ Vector(corner) for corner in obj.bound_box]
        center = sum(points, Vector()) / 8
        projection = world_to_camera_view(scene, cam, center)
        objects.append({'id': obj_id, 'name': obj.name, 'firstIndex': start_index,
                        'indexCount': len(indices) - start_index, 'kind': obj['material_kind'],
                        'center': list(center), 'neutralProjection': list(projection)})
    if sys.byteorder != 'little':
        vertices.byteswap()
        indices.byteswap()
    with (OUT / 'field.mesh').open('wb') as f:
        f.write(struct.pack('<4sIII', b'HLF1', len(vertices) // 11, len(indices), 44))
        vertices.tofile(f)
        indices.tofile(f)
    data = {'version': 1, 'generator': 'build_scene.py', 'blender': bpy.app.version_string,
            'seed': 411102026, 'vertexCount': len(vertices) // 11, 'triangleCount': len(indices) // 3,
            'strideBytes': 44, 'meshBytes': (OUT / 'field.mesh').stat().st_size,
            'attributes': ['position:3xf32', 'normal:3xf32', 'linearColor:3xf32', 'materialKind:f32', 'objectId:f32'],
            'sunDirection': list(SUN), 'eye': [0, EYE_Y, EYE_Z], 'window': {'width': W, 'height': H, 'centerZ': CENTER_Z},
            'travel': {'x': 3.6, 'z': 1.4}, 'nearWallDepth': 2.8, 'objects': objects}
    (OUT / 'field.json').write_text(json.dumps(data, indent=2) + '\n')
    return data


metadata = export_mesh()
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48 if ARGS.draft else 96
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 5
scene.cycles.transparent_max_bounces = 4
scene.cycles.volume_bounces = 1
scene.cycles.volume_step_rate = 2
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for device in prefs.devices:
        device.use = device.type == 'METAL'
    if any(device.type == 'METAL' for device in prefs.devices):
        scene.cycles.device = 'GPU'
except (TypeError, RuntimeError):
    pass
scene.render.resolution_x, scene.render.resolution_y = 1920, 1440
scene.render.resolution_percentage = 50 if ARGS.draft else 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = 0
scene.render.filepath = str(OUT / 'highland-field.png')
for wall in walls:
    wall.hide_render = True  # Construction reference stays absent from all delivered views.
if not ARGS.no_render:
    bpy.ops.render.render(write_still=True)
    record_png_origin(scene.render.filepath, 'neutral opaque RGB still at 1920x1440')
if ARGS.views and not ARGS.no_render:
    ref = OUT / 'native-reference'
    ref.mkdir(exist_ok=True)
    scene.render.resolution_percentage = 50
    scene.cycles.samples = 40
    # Frame 31/91 matches the fixed-plane trajectory stored in the saved file.
    for title, frame in [('neutral', 1), ('left', 31), ('right', 91)]:
        scene.frame_set(frame)
        scene.render.filepath = str(ref / f'{title}.png')
        bpy.ops.render.render(write_still=True)
        record_png_origin(scene.render.filepath, f'{title} native reference, frame {frame}, 960x720')
    scene.render.resolution_percentage = 100
    scene.cycles.samples = 96
scene.frame_set(1)
eye()
scene.render.filepath = str(OUT / 'highland-field.png')
for wall in walls:
    wall.hide_render = True
    wall.hide_set(True)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.clip_end = 4000
            area.spaces.active.shading.type = 'MATERIAL'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'highland-field.blend'))
evidence = {'elapsedSeconds': time.perf_counter() - START, 'blender': bpy.app.version_string,
            'vertices': metadata['vertexCount'], 'triangles': metadata['triangleCount'],
            'meshBytes': metadata['meshBytes'],
            'externalImages': sum(1 for image in bpy.data.images if image.source == 'FILE' and image.filepath and not image.packed_file),
            'engine': scene.render.engine, 'device': scene.cycles.device, 'draft': ARGS.draft,
            'sourceSize': [scene.render.resolution_x, scene.render.resolution_y],
            'cameraRotationFixed': list(cam.rotation_euler), 'offAxis': True}
(OUT / 'native-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
print('BLD4_COMPLETE', json.dumps(evidence))
