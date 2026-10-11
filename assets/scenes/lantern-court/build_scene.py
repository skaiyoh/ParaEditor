"""Original Lantern Court. Run with Blender --background --factory-startup --python.

Everything is authored here: meshes, materials, light, and perspective camera.
No downloaded models, image textures, generators, or Python dependencies.
Optional arguments after --: --draft (960 x 720) and --views (native 3D reference views).
The native reference views are NOT output from Noisy.
The saved Blender file includes a four-second native camera preview; press Space.
"""

import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


START = time.perf_counter()
OUT = Path(__file__).resolve().parent
RNG = random.Random(11102026)
parser = argparse.ArgumentParser()
parser.add_argument('--draft', action='store_true')
parser.add_argument('--views', action='store_true')
ARGS = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0


def linear(hex_color):
    values = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v < .04045 else ((v + .055) / 1.055) ** 2.4 for v in values)


def material(name, color, roughness=.6, metallic=0, glow=0, texture=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    rgb = linear(color)
    mat.diffuse_color = (*rgb, 1)
    nodes = mat.node_tree.nodes
    shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*rgb, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    if glow:
        shader.inputs['Emission Color'].default_value = (*rgb, 1)
        shader.inputs['Emission Strength'].default_value = glow
    if texture:
        coords = nodes.new('ShaderNodeTexCoord')
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = texture
        noise.inputs['Detail'].default_value = 3.5
        noise.inputs['Roughness'].default_value = .75
        mat.node_tree.links.new(coords.outputs['Generated'], noise.inputs['Vector'])
        ramp = nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = .15
        ramp.color_ramp.elements[0].color = (*(v * .72 for v in rgb), 1)
        ramp.color_ramp.elements[1].position = .87
        ramp.color_ramp.elements[1].color = (*(min(1, v * 1.2) for v in rgb), 1)
        mat.node_tree.links.new(noise.outputs['Fac'], ramp.inputs[0])
        mat.node_tree.links.new(ramp.outputs[0], shader.inputs['Base Color'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .28
        bump.inputs['Distance'].default_value = .06
        mat.node_tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
        mat.node_tree.links.new(bump.outputs[0], shader.inputs['Normal'])
    return mat


stone = material('01 / weathered blue limestone', '85959c', texture=7)
stone_light = material('02 / silver limestone edges', 'a0b0ad', texture=11)
stone_dark = material('03 / deep slate joints', '394953', texture=8)
earth = material('04 / garden earth', '27352f', texture=6)
moss = material('05 / velvet moss', '4c6e42', texture=12)
wood = material('06 / old red cedar', '663b2c', texture=9)
roof = material('07 / peacock glazed roof', '3a7473', roughness=.3, metallic=.25, texture=13)
roof_dark = material('08 / roof underside', '213c42', texture=5)
brass = material('09 / aged warm brass', 'b79861', roughness=.3, metallic=.65, texture=8)
iron = material('10 / blackened bronze', '3d453e', roughness=.38, metallic=.5)
paper = material('11 / amber silk lantern', 'ffbf71', roughness=.75, glow=1.8, texture=16)
window = material('12 / pavilion rice paper', 'ffbd70', roughness=.75, glow=1.35)
leaves = [material(f'13 / maple leaf {i}', color) for i, color in enumerate(['c25b36', 'db8145', 'a94232', 'e8a75c'])]
evergreen = [material(f'14 / garden foliage {i}', color) for i, color in enumerate(['315f51', '497861', '678c62'])]
petal = material('15 / pale lotus petals', 'f3b5b0', roughness=.45)
lotus_center = material('16 / lotus heart', 'efc165')
water = material('17 / quiet jade water', '295250', roughness=.23, metallic=.28)
moon_mat = material('18 / distant moon', 'b5d9d5', glow=1.4, texture=4)
star_mat = material('19 / faint distant stars', 'b7d5d9', glow=1.5)


def finish(obj, name, mat):
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    return obj


def box(name, at, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    obj = finish(bpy.context.object, name, mat)
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Small worn edges', 'BEVEL')
        mod.width, mod.segments = bevel, 2
        obj.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    return obj


def cylinder(name, at, radius, depth, mat, vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=at)
    return finish(bpy.context.object, name, mat)


def beam(name, a, b, radius, mat, vertices=10):
    delta = Vector(b) - Vector(a)
    obj = cylinder(name, (Vector(a) + Vector(b)) / 2, radius, delta.length, mat, vertices)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj


def mesh_object(name, verts, faces, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if mat:
        mesh.materials.append(mat)
    return obj


def curve(name, points, radius, mat):
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions, data.bevel_depth, data.bevel_resolution = '3D', radius, 2
    spline = data.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for point, value in zip(spline.points, points):
        point.co = (*value, 1)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    return obj


def light(name, at, watts, color, radius=.5, target=None, size=6):
    data = bpy.data.lights.new(name, 'AREA' if target is not None else 'POINT')
    data.energy, data.color = watts, linear(color)
    # Small path practicals illuminate the deck; the moon and close lanterns
    # own cast shadows. This avoids allocating ten full cube shadow maps.
    data.use_shadow = not name.startswith('Path lantern')
    if target is None:
        data.shadow_soft_size = radius
    else:
        data.shape, data.size = 'DISK', size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = at
    if target is not None:
        obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    return obj


def rock(name, at, scale, mat=stone_dark):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1, location=at)
    obj = finish(bpy.context.object, name, mat)
    obj.scale = scale
    obj.rotation_euler = (RNG.uniform(-.2, .2), RNG.uniform(-.2, .2), RNG.uniform(0, math.tau))
    return obj


def lantern(name, x, y, z, scale=1, hanging=0):
    # Opaque silk: crisp silhouette for inferred depth; ribs remain genuine geometry.
    r, h = .34 * scale, .85 * scale
    cylinder(name + ' luminous silk', (x, y, z), r, h, paper, 12)
    for dz in [-h / 2, h / 2]:
        cylinder(name + ' brass rim', (x, y, z + dz), r * 1.1, .055 * scale, brass)
    for i in range(8):
        a = i * math.tau / 8
        beam(name + ' vertical rib', (x + r * math.cos(a), y + r * math.sin(a), z - h / 2),
             (x + r * math.cos(a), y + r * math.sin(a), z + h / 2), .018 * scale, iron, 6)
    # A sloping hip roof, with a little finial.
    verts = [(x + dx * r * 1.5, y + dy * r * 1.5, z + h * .6) for dx, dy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]]
    verts.append((x, y, z + h * .9))
    mesh_object(name + ' bronze roof', verts, [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], roof)
    cylinder(name + ' roof finial', (x, y, z + h), .04 * scale, .18 * scale, brass)
    if hanging:
        beam(name + ' suspension', (x, y, z + h), (x, y, z + h + hanging), .025 * scale, iron)
        beam(name + ' tassel', (x, y, z - h * .55), (x, y, z - h * .98), .028 * scale, brass)
    else:
        cylinder(name + ' stone foot', (x, y, .16), .36 * scale, .28, stone)
        cylinder(name + ' cedar post', (x, y, (z - h / 2) / 2), .08 * scale, z - h / 2, wood)
    light(name + ' practical', (x, y - .15, z), 115 * scale, 'ffbd73', radius=.55 * scale)


# Ground, dark stone perimeter, and individually laid flagstones.
box('Garden foundation', (0, 17, -.35), (42, 70, .6), earth)
box('Path dark grout', (0, 11, -.015), (3.9, 43, .14), stone_dark)
for row in range(28):
    y = -9 + row * 1.35
    if 4.6 < y < 12.3:
        continue
    for col in range(3):
        slab = box(f'Path flagstone {row:02}-{col}', ((col - 1) * 1.26 + RNG.uniform(-.025, .025), y, .07 + RNG.uniform(-.015, .015)),
                   (1.2, 1.29, .16), RNG.choice([stone, stone, stone_light]), .045)
        slab.rotation_euler[2] = RNG.uniform(-.015, .015)
for side in [-1, 1]:
    for i in range(19):
        y = -5 + i * 1.75
        box('Low courtyard border', (side * 6.9, y, .43), (.42, 1.7, .85), stone_dark, .05)
        box('Courtyard coping', (side * 6.9, y, .9), (.62, 1.73, .14), stone, .035)

# Foreground gate: a true masonry arch, with discrete wedge-shaped voussoirs.
for side in [-1, 1]:
    for course in range(6):
        box('Gate pier masonry', (side * 3.5, -1.8, .25 + course * .48), (.92, 1.05, .46),
            stone if course % 3 else stone_light, .045)
    box('Gate square plinth', (side * 3.5, -1.8, .13), (1.24, 1.42, .26), stone_light, .055)
    box('Gate impost capital', (side * 3.5, -1.8, 2.94), (1.24, 1.4, .22), stone_light, .04)
    # Weathered inset panels give the close surfaces scale.
    box('Gate inset bronze plaque', (side * 3.5, -2.345, 1.66), (.42, .025, .86), iron, .03)
    for z in [1.32, 2]:
        cylinder_obj = cylinder('Gate plaque round stud', (side * 3.5, -2.37, z), .047, .045, brass)
        cylinder_obj.rotation_euler[0] = math.pi / 2

for i in range(19):
    a, b = i * math.pi / 19 + .005, (i + 1) * math.pi / 19 - .005
    verts = [(r * math.cos(t), y, 2.98 + r * math.sin(t)) for y in [-2.32, -1.28] for r, t in [(3.04, a), (3.04, b), (3.91, b), (3.91, a)]]
    obj = mesh_object(f'Arch voussoir {i:02}', verts,
                      [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
                      stone_light if i == 9 else stone)
    bevel = obj.modifiers.new('Rounded limestone corners', 'BEVEL')
    bevel.width, bevel.segments = .025, 2
    obj.modifiers.new('Arch weighted normals', 'WEIGHTED_NORMAL')

# Close asymmetric lanterns carry the largest useful parallax signal.
lantern('Foreground left hanging lantern', -2.48, -1.35, 3.22, 1.48, 1.18)
lantern('Foreground right hanging lantern', 2.71, -.85, 3.64, 1.06, .96)
for side in [-1, 1]:
    for index, y in enumerate([2.1, 7.3, 13.9, 20.1]):
        lantern(f'Path lantern {side}-{index}', side * (2.28 if index < 2 else 2.7), y, 1.55, .7)

# The middle pool has a real bridge, rather than transparent foreground glass.
box('Still garden pool', (0, 8.5, -.025), (12.3, 8.8, .055), water)
for side in [-1, 1]:
    for i in range(10):
        y = 4.05 + i * .92
        rock('Pool rim rock', (side * (5.6 + RNG.uniform(-.2, .3)), y, .08),
             (RNG.uniform(.4, .75), RNG.uniform(.35, .65), RNG.uniform(.22, .45)), stone)


def bridge_height(y):
    return .18 + .56 * max(0, 1 - ((y - 8.5) / 4.2) ** 2)


for i in range(28):
    y = 4.45 + i * .3
    obj = box('Bridge cross plank', (0, y, bridge_height(y)), (3.1, .285, .14), wood, .018)
    obj.rotation_euler[0] = math.atan(-1.12 * (y - 8.5) / (4.2 ** 2))
for side in [-1, 1]:
    for y in [4.6, 6.45, 8.5, 10.55, 12.4]:
        z = bridge_height(y)
        box('Bridge rail upright', (side * 1.52, y, z + .52), (.15, .15, 1.07), wood, .015)
        cylinder('Bridge post brass cap', (side * 1.52, y, z + 1.08), .12, .07, brass)
    for h in [.45, .95]:
        curve('Bridge curved rail', [(side * 1.52, 4.4 + i * .21, bridge_height(4.4 + i * .21) + h) for i in range(40)], .055, wood)

# Lily pads and modeled blossoms are grouped away from the path silhouette.
for i in range(27):
    x, y = RNG.choice([-1, 1]) * RNG.uniform(2.2, 5), RNG.uniform(5, 12)
    pad = cylinder('Floating lotus pad', (x, y, .025), RNG.uniform(.17, .32), .012, RNG.choice(evergreen), 14)
    pad.scale.y = RNG.uniform(.65, .9)
    if i % 5 == 0:
        for p in range(7):
            a = p * math.tau / 7
            flower = rock('Lotus petal', (x + math.cos(a) * .10, y + math.sin(a) * .10, .10), (.14, .07, .055), petal)
            flower.rotation_euler[2] = a
        cylinder('Lotus golden heart', (x, y, .13), .055, .05, lotus_center)


def swept_roof(name, cy, z, width, depth, height):
    # Ruled hipped roof: all four corners turn up; its silhouette survives reduction.
    rings = [(.06, height), (.36, height * .75), (.7, height * .24), (.9, .05), (1, .21)]
    verts = []
    for scale, dz in rings:
        for x, y in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
            verts.append((x * width * scale / 2, cy + y * depth * scale / 2, z + dz))
    faces = []
    for r in range(len(rings) - 1):
        for side in range(4):
            faces.append((r * 4 + side, r * 4 + (side + 1) % 4, (r + 1) * 4 + (side + 1) % 4, (r + 1) * 4 + side))
    mesh_object(name, verts, faces, roof)
    for side in range(4):
        curve(name + ' brass hip seam', [verts[r * 4 + side] for r in range(len(rings))], .035, brass)
    # Readable tile rows follow the slope instead of a flat noisy texture.
    for r in [.45, .58, .71, .83, .95]:
        for j in range(len(rings) - 1):
            low, high = rings[j], rings[j + 1]
            if low[0] <= r <= high[0]:
                t = (r - low[0]) / (high[0] - low[0])
                dz = low[1] * (1 - t) + high[1] * t + .015
                pts = [(x * width * r / 2, cy + y * depth * r / 2, z + dz) for x, y in [(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]]
                curve(name + ' raised tile row', pts, .023, roof_dark)
                break


# Destination pavilion: warm paper panels framed by cedar, behind every near layer.
for level in range(3):
    box('Pavilion stone step', (0, 20, .13 + level * .21), (8.3 - level * .5, 7.2 - level * .5, .26), stone, .05)
for x in [-2.9, -1.45, 1.45, 2.9]:
    for y in [17.5, 22.5]:
        box('Pavilion cedar column', (x, y, 2.45), (.22, .24, 3.6), wood, .025)
        box('Column brass shoe', (x, y, .85), (.32, .34, .28), brass, .025)
box('Pavilion inner paper wall', (0, 21.8, 2.45), (5.65, .10, 3.2), window)
for x in [-2.8, -2.1, -1.4, -.7, 0, .7, 1.4, 2.1, 2.8]:
    box('Pavilion screen vertical', (x, 21.72, 2.45), (.055, .10, 3.2), wood)
for z in [1.05, 1.7, 2.4, 3.1, 3.85]:
    box('Pavilion screen horizontal', (0, 21.70, z), (5.7, .10, .06), wood)
box('Pavilion upper tie beam', (0, 20, 4.25), (6.7, 5.8, .28), wood, .025)
swept_roof('Pavilion broad swept eaves', 20, 4.3, 9.4, 7.8, 1.6)
box('Upper lantern chamber', (0, 20, 5.9), (2.7, 2.6, .9), window)
for x in [-1.3, -.65, 0, .65, 1.3]:
    box('Upper chamber frame', (x, 18.64, 5.88), (.07, .10, .95), wood)
swept_roof('Pavilion upper swept eaves', 20, 6.32, 4.9, 4.4, 1.3)
cylinder('Pavilion finial', (0, 20, 7.94), .11, .7, brass)
rock('Pavilion finial pearl', (0, 20, 8.36), (.19, .19, .19), brass)
light('Pavilion warm wash', (0, 19, 3), 720, 'ffd29c', target=(0, 17, .2), size=5)
light('Pavilion facade fill', (0, 15.5, 5.4), 900, 'a3d7df', target=(0, 20, 3), size=5)


def tree(name, x, y, height, palette, spread=1):
    # A seeded branching skeleton and a single batched leaf mesh per tree.
    beam(name + ' trunk', (x, y, 0), (x + .23, y, height * .7), height * .045, wood)
    tips = []
    for i in range(10):
        a = i * 2.39996 + RNG.uniform(-.3, .3)
        r = RNG.uniform(.8, 1.8) * spread
        tip = (x + math.cos(a) * r, y + math.sin(a) * r, height * RNG.uniform(.68, 1.04))
        beam(name + ' branch', (x + .1, y, height * RNG.uniform(.4, .6)), tip, .065, wood)
        tips.append(tip)
    verts, faces, indices = [], [], []
    for tip in tips:
        for i in range(128):
            p = Vector(tip) + Vector((RNG.gauss(0, .56 * spread), RNG.gauss(0, .48 * spread), RNG.gauss(0, .37)))
            a, length = RNG.uniform(0, math.tau), RNG.uniform(.15, .30)
            u = Vector((math.cos(a), math.sin(a), RNG.uniform(-.35, .35))) * length
            v = Vector((-math.sin(a), math.cos(a), .2)) * length * .48
            n = len(verts)
            verts.extend([p - u, p + v, p + u, p - v, p + Vector((0, 0, .035))])
            faces.extend([(n, n + 1, n + 4), (n + 1, n + 2, n + 4), (n + 2, n + 3, n + 4), (n + 3, n, n + 4)])
            indices.extend([RNG.randrange(len(palette))] * 4)
    obj = mesh_object(name + ' individually folded foliage', verts, faces, None)
    for mat in palette:
        obj.data.materials.append(mat)
    for poly, index in zip(obj.data.polygons, indices):
        poly.material_index = index


for name, x, y, height, palette, spread in [
    ('Left copper maple', -4.8, 2.2, 6.8, leaves, 1.2),
    ('Right old maple', 4.7, 11.7, 8.2, leaves, 1.6),
    ('Left garden maple', -5.0, 15.3, 7.3, leaves, 1.5),
    ('Right dark cedar', 8.7, 19, 10.5, evergreen, 1.25),
    ('Left dark cedar', -8.8, 23, 12, evergreen, 1.5),
    ('Far left grove', -5.5, 30, 10, evergreen, 1.5),
    ('Far right grove', 5, 32, 12, evergreen, 1.7),
    ('Far cedar silhouette', -11, 36, 14, evergreen, 2),
    ('Far copper silhouette', 11, 38, 11, leaves, 2),
]:
    tree(name, x, y, height, palette, spread)

# Low garden planting uses real blades and broad leaves, never alpha cards.
for side in [-1, 1]:
    for i in range(24):
        y = RNG.uniform(-4, 29)
        x = side * RNG.uniform(3.0, 6.2)
        if 4 < y < 13:
            continue
        rock('Moss-covered garden boulder', (x, y, RNG.uniform(.06, .15)),
             (RNG.uniform(.35, .85), RNG.uniform(.25, .65), RNG.uniform(.2, .5)), moss if i % 3 else stone)
        verts, faces = [], []
        for blade in range(16):
            a, length = RNG.uniform(0, math.tau), RNG.uniform(.25, .7)
            n = len(verts)
            verts.extend([(x, y, .1), (x + math.cos(a) * length * .6, y + math.sin(a) * length * .6, length),
                          (x + math.cos(a) * length, y + math.sin(a) * length, length * .4),
                          (x + math.cos(a + .3) * length * .6, y + math.sin(a + .3) * length * .6, length * .7)])
            faces.append((n, n + 1, n + 2, n + 3))
        mesh_object('Garden fern rosette', verts, faces, RNG.choice(evergreen))

# A few close, readable fallen leaves connect the eye to the path.
for i in range(57):
    x, y = RNG.uniform(-3.2, 3.2), RNG.uniform(-8, 17)
    if 4.4 < y < 12.8:
        continue
    length, a = RNG.uniform(.07, .16), RNG.uniform(0, math.tau)
    u, v = Vector((math.cos(a), math.sin(a), 0)) * length, Vector((-math.sin(a), math.cos(a), 0)) * length * .6
    p = Vector((x, y, .17 if abs(x) < 1.9 else .02))
    mesh_object('Single fallen maple leaf', [p - u, p + v, p + u, p - v, p + Vector((0, 0, .04))],
                [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], RNG.choice(leaves))

# Distant geometry never shifts like the close arch. Avoid a flat image backdrop.
for x, y, height, width in [(-36, 79, 15, 29), (-19, 88, 22, 34), (12, 95, 25, 34), (36, 84, 18, 29)]:
    mesh_object('Distant mountain silhouette', [(x - width / 2, y, -.3), (x - width * .1, y, height),
                (x + width * .19, y, height * .72), (x + width / 2, y, -.3)], [(0, 1, 2, 3)], roof_dark)
moon = rock('Moon beyond the courtyard', (-10.5, 78, 28.5), (3.4, .35, 3.4), moon_mat)
moon.rotation_euler = (0, 0, 0)
for i in range(48):
    x, z = RNG.uniform(-60, 60), RNG.uniform(18, 49)
    radius = RNG.uniform(.025, .07)
    mesh_object('Distant pinpoint star', [(x - radius, 115, z), (x + radius, 115, z), (x, 115, z + radius * 2)], [(0, 1, 2)], star_mat)

# Cool broad light with warm practicals. Keep the near masonry readable for depth inference.
light('Moon key', (-7, 3, 19), 3700, 'a5c9f6', target=(0, 7, 0), size=12)
light('Gate soft bounce', (0, -9, 8), 700, '86afce', target=(0, -1, 3), size=9)
light('Warm maple rim', (5, 9, 13), 2200, 'ffd29b', target=(4, 10, 5), size=8)
light('Far garden moon fill', (-6, 23, 15), 2200, '89b2c2', target=(0, 21, 1), size=12)

scene = bpy.context.scene
scene.world = bpy.data.worlds.new('Deep petrol night')
scene.world.use_nodes = True
background = next(n for n in scene.world.node_tree.nodes if n.type == 'BACKGROUND')
background.inputs['Color'].default_value = (*linear('182c3a'), 1)
background.inputs['Strength'].default_value = .35

# Light atmospheric density, restricted to the garden so the foreground stays crisp.
fog = bpy.data.materials.new('Thin garden atmosphere')
fog.use_nodes = True
fog.node_tree.nodes.clear()
volume = fog.node_tree.nodes.new('ShaderNodeVolumePrincipled')
volume.inputs['Density'].default_value = .004
volume.inputs['Color'].default_value = (*linear('829da4'), 1)
volume.inputs['Anisotropy'].default_value = .25
volume_out = fog.node_tree.nodes.new('ShaderNodeOutputMaterial')
fog.node_tree.links.new(volume.outputs['Volume'], volume_out.inputs['Volume'])
box('Atmosphere behind the entrance', (0, 30, 8), (50, 65, 17), fog)

bpy.ops.object.camera_add(location=(0, -10, 2.85))
camera = bpy.context.object
camera.name = 'Lantern Court / perspective window'
focus = Vector((0, 18, 3.35))
camera.rotation_euler = (focus - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type, camera.data.lens = 'PERSP', 30
camera.data.sensor_width, camera.data.clip_start, camera.data.clip_end = 36, .1, 250
camera.data.dof.use_dof = False
scene.camera = camera
scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 48 if ARGS.draft else 96
scene.eevee.use_fast_gi = True
scene.eevee.shadow_resolution_scale = .5
scene.eevee.volumetric_samples = 48
scene.render.resolution_x, scene.render.resolution_y = (960, 720) if ARGS.draft else (1920, 1440)
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.image_settings.color_depth = '8'
scene.render.film_transparent = False
scene.render.fps = 30
scene.frame_start = scene.frame_end = 1
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.view_settings.exposure = .25

# Blender 5's compositor lives in a node group. A restrained optical glow
# supports the practical lamps without washing out their silhouette.
compositor = bpy.data.node_groups.new('Lantern Court / restrained lamp glow', 'CompositorNodeTree')
compositor.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
render_layers = compositor.nodes.new('CompositorNodeRLayers')
glare = compositor.nodes.new('CompositorNodeGlare')
glare.inputs['Type'].default_value = 'Fog Glow'
glare.inputs['Quality'].default_value = 'High'
glare.inputs['Threshold'].default_value = 1.5
glare.inputs['Strength'].default_value = .16
group_output = compositor.nodes.new('NodeGroupOutput')
compositor.links.new(render_layers.outputs['Image'], glare.inputs['Image'])
compositor.links.new(glare.outputs['Image'], group_output.inputs['Image'])
scene.compositing_node_group = compositor

scene['title'] = 'Lantern Court'
scene['seed'] = 11102026
scene['provenance'] = 'Original geometry and procedural materials. Noisy receives only the opaque still; native Blender views are separate reference evidence.'
scene['depth_layers'] = 'close gate and hanging lanterns / path lights and pool / curved bridge / pavilion / grove / moon and mountains'
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.shading.type = 'MATERIAL'
            area.spaces.active.shading.use_scene_lights = True
            area.spaces.active.shading.use_scene_world = True
            area.spaces.active.overlay.show_overlays = False

draft_dir = Path('/tmp/noisy-bld2')
draft_dir.mkdir(parents=True, exist_ok=True)
scene.render.filepath = str(draft_dir / 'lantern-court-draft.png') if ARGS.draft else str(OUT / 'lantern-court.png')
if not ARGS.draft:
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'lantern-court.blend'))
bpy.ops.render.render(write_still=True)

# Measure actual projection of landmarks at different distances.
# Native reference cameras translate without toe-in. Lens shift keeps the
# convergence plane steady; foreground and background move different amounts.
base = camera.location.copy()
right = camera.rotation_euler.to_quaternion() @ Vector((1, 0, 0))
landmarks = {
    'near_lantern': Vector((-2.48, -1.35, 3.22)),
    'bridge_rail': Vector((1.52, 8.5, bridge_height(8.5) + .95)),
    'pavilion': Vector((0, 20, 4.3)),
    'moon': Vector((-10.5, 78, 28.5)),
}
views = {}
for name, eye in [('neutral', 0), ('left', -.55), ('right', .55)]:
    camera.location = base + right * eye
    camera.data.shift_x = -eye * camera.data.lens / ((focus - base).length * camera.data.sensor_width)
    bpy.context.view_layer.update()
    views[name] = {key: [round(value, 6) for value in world_to_camera_view(scene, camera, point)] for key, point in landmarks.items()}
    if ARGS.views and name != 'neutral':
        scene.render.filepath = str(draft_dir / f'native-{name}.png')
        bpy.ops.render.render(write_still=True)
camera.location = base
camera.data.shift_x = 0
bpy.context.view_layer.update()
scene.render.filepath = str(OUT / 'lantern-court.png')

if not ARGS.draft:
    # A playable native 3D preview, clearly named so it cannot be mistaken for
    # the app's inferred-depth effect. Camera rotation stays fixed throughout.
    # Keyframed eye position and lens shift preserve the convergence plane.
    camera.animation_data_clear()
    camera.data.animation_data_clear()
    up = camera.rotation_euler.to_quaternion() @ Vector((0, 1, 0))
    distance = (focus - base).length
    for i in range(9):
        angle = i * math.tau / 8
        frame = 1 + i * 15
        eye_x, eye_y = .55 * math.sin(angle), .12 * math.sin(2 * angle)
        camera.location = base + right * eye_x + up * eye_y
        camera.data.shift_x = -eye_x * camera.data.lens / (distance * camera.data.sensor_width)
        camera.data.shift_y = -eye_y * camera.data.lens / (distance * camera.data.sensor_width)
        camera.keyframe_insert(data_path='location', frame=frame, group='Native 3D parallax reference')
        camera.data.keyframe_insert(data_path='shift_x', frame=frame, group='Fixed convergence plane')
        camera.data.keyframe_insert(data_path='shift_y', frame=frame, group='Fixed convergence plane')
    scene.frame_end = 120
    scene.frame_set(1)
    scene['native_preview'] = 'Press Space in the camera viewport: four-second true 3D camera loop, NOT Noisy output. Static scene geometry; fixed camera rotation; off-axis lens shift.'
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'lantern-court.blend'))

metadata = {
    'title': 'Lantern Court', 'blender': bpy.app.version_string, 'seed': 11102026,
    'camera': 'perspective, 30 mm, fixed rotation, native reference eye offsets +/-0.55 m',
    'resolution': [scene.render.resolution_x, scene.render.resolution_y],
    'objects': len(scene.objects), 'materials': len(bpy.data.materials),
    'external_images': [image.filepath for image in bpy.data.images if image.source == 'FILE' and image.filepath],
    'landmark_normalized_projection': views,
    'elapsed_seconds': round(time.perf_counter() - START, 3),
    'native_views_are_app_output': False,
    'native_preview': 'Saved Blender timeline, frames 1-120 at 30 fps; true 3D reference, not app output',
}
(draft_dir / 'native-evidence.json' if ARGS.draft else OUT / 'native-evidence.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('BLD2_COMPLETE ' + json.dumps(metadata))
