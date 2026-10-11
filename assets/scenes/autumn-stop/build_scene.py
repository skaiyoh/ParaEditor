"""Build Last Light, an original still-life diorama. Run with Blender --background --python.

No external assets, textures, addons, or input .blend are needed.
Only the two named outputs beside this script are written; app-output is untouched.
"""
from pathlib import Path
from math import radians, sin, cos, pi
import random
import time

import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view


START = time.perf_counter()
OUT = Path(__file__).resolve().parent
RNG = random.Random(8102026)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0


def material(name, color, emission=0, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = .8
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Emission Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Strength'].default_value = emission
    return mat


def finish(obj, name, mat):
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def box(name, loc, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = finish(bpy.context.object, name, mat)
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Small manufactured edge', 'BEVEL')
        mod.width, mod.segments = bevel, 1
        obj.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    return obj


def cylinder(name, loc, radius, depth, mat, vertices=8):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    return finish(bpy.context.object, name, mat)


def beam(name, start, end, radius, mat):
    a, b = Vector(start), Vector(end)
    obj = cylinder(name, (a+b)/2, radius, (b-a).length, mat)
    obj.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    return obj


def text(name, words, loc, size, mat):
    curve = bpy.data.curves.new(name, 'FONT')
    curve.body, curve.align_x, curve.align_y = words, 'CENTER', 'CENTER'
    curve.size, curve.extrude = size, .001
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.location, obj.rotation_euler = loc, (radians(90), 0, 0)
    obj.data.materials.append(mat)
    return obj


def area(name, loc, target, power, color, size):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.color, data.shape, data.size = power, color, 'DISK', size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z', 'Y').to_euler()


night = material('Night ink', (.018, .027, .065))
soil = material('Cut earth / plum', (.075, .047, .079))
grass = material('Midnight grass', (.045, .085, .09))
road = material('Blue asphalt', (.052, .079, .13))
concrete = material('Warm concrete', (.25, .25, .23))
cream = material('Ivory enamel', (.78, .70, .48))
red = material('Oxide red enamel', (.54, .073, .035))
teal = material('Petrol blue trim', (.035, .15, .16))
black = material('Hoses and bezel', (.012, .019, .028))
wood = material('Tree bark', (.11, .065, .052))
ochre = material('Ochre leaves', (.58, .24, .035))
orange = material('Copper leaves', (.76, .12, .022))
gold = material('Gold leaves', (.8, .42, .05))
purple = material('Distant plum leaves', (.15, .09, .19))
lamp = material('Warm light panel', (1, .48, .12), 3)
window = material('Shop window amber', (1, .35, .055), .7)
mint = material('Pump display mint', (.25, .78, .6), .8)

# A cut slab and two-lane ribbon make the roadside legible without a huge world.
box('Diorama cut earth', (0, .5, -.4), (15, 11.8, .8), soil, .22)
box('Ground cap', (0, .5, .025), (14.8, 11.6, .1), grass, .1)
box('Road', (0, -3.9, .105), (14.7, 2.8, .055), road)
for x in range(-6, 8, 2):
    box('Road center dash', (x, -4.15, .138), (.85, .065, .01), cream)
box('Road far edge', (0, -2.62, .14), (14.5, .04, .01), cream)
box('Forecourt pad', (.7, .4, .13), (7.6, 4.7, .2), concrete, .08)

# Canopy in the middle distance, with fascia and practical light sources.
for x in [-1.9, 3.3]:
    box('Canopy upright', (x, 1.1, 1.92), (.19, .19, 3.5), teal, .015)
    box('Column foot', (x, 1.1, .35), (.36, .36, .3), cream)
box('Canopy shadow underside', (.7, .5, 3.62), (7.0, 3.8, .16), teal, .04)
box('Canopy red fascia', (.7, .5, 3.84), (7.15, 3.95, .3), red, .05)
box('Canopy ivory top lip', (.7, .5, 4.02), (7.3, 4.06, .08), cream, .02)
box('Fascia thin cream stripe', (.7, -1.49, 3.83), (6.98, .012, .065), cream)
text('Canopy station lettering', 'LAST LIGHT', (.7, -1.509, 3.9), .13, cream)
for x in [-1.2, 2.4]:
    box('Canopy luminous panel', (x, .35, 3.51), (1.15, .75, .025), lamp)
    area('Canopy amber pool', (x, .15, 3.46), (x, -.4, 0), 190, (1, .49, .17), 1.8)

# One generous foreground pump is a deliberate clean segmentation target.
px, py = .0, -1.2
box('Pump island', (px, py, .29), (2.25, 1.4, .28), cream, .14)
box('Pump red pedestal', (px, py, .93), (.95, .7, 1.1), red, .07)
box('Pump cream head', (px, py, 1.85), (1.15, .8, .94), cream, .085)
box('Pump display black bezel', (px, py-.409, 2.00), (.87, .02, .33), black, .015)
text('Pump price', '08.10', (px, py-.426, 2.00), .19, mint)
text('Pump label', 'REGULAR', (px, py-.424, 1.68), .10, teal)
cylinder('Pump crown', (px, py, 2.42), .22, .12, red, 12)
for x in [-.7, .7]:
    cylinder('Protective bollard', (x, py-.4, .66), .055, .62, teal)
# The hose is a polygonal pipe, not a downloaded curve or texture.
hose = [(.53, py, 2.03), (.87, py, 1.83), (1.01, py, .8), (.86, py-.06, .62), (.66, py-.16, .83), (.66, py-.19, 1.55)]
for a, b in zip(hose, hose[1:]):
    beam('Fuel hose segment', a, b, .043, black)
beam('Fuel nozzle', (.66, py-.19, 1.55), (.52, py-.23, 1.81), .058, teal)

# Foreground pylon, readable custom lettering with Blender's built-in font.
for x in [-4.8, -4.0]:
    box('Sign pole', (x, -1.45, 1.5), (.12, .12, 2.9), teal)
box('Sign enamel frame', (-4.4, -1.45, 3.18), (2.0, .25, 1.62), red, .06)
box('Sign ivory face', (-4.4, -1.588, 3.18), (1.8, .035, 1.42), cream, .015)
text('Sign LAST', 'LAST', (-4.4, -1.614, 3.62), .30, red)
text('Sign LIGHT', 'LIGHT', (-4.4, -1.614, 3.25), .30, red)
text('Sign road number', 'R O U T E   0 8', (-4.4, -1.614, 2.80), .115, teal)
box('Sign lamp bar', (-4.4, -1.68, 4.02), (1.48, .19, .08), teal)
area('Pylon downlight', (-4.4, -2.0, 4.1), (-4.4, -1.6, 3.0), 38, (1, .56, .23), 1.2)

# A small closed shop behind the shelter, amber windows and slatted siding.
box('Shop building', (1.0, 3.7, 1.23), (4.3, 2.2, 2.4), teal, .025)
for z in [.35, .65, .95, 1.25, 1.55, 1.85, 2.15]:
    box('Shop siding batten', (1.0, 2.585, z), (4.22, .045, .035), night)
box('Shop roof', (1.0, 3.7, 2.52), (4.65, 2.55, .18), red, .045)
for x in [-.25, 2.25]:
    box('Window frame', (x, 2.54, 1.55), (1.2, .07, 1.15), cream)
    box('Amber shop glass', (x, 2.49, 1.55), (1.03, .025, .99), window)
    box('Window mullion', (x, 2.463, 1.55), (.045, .025, 1.0), teal)
box('Shop door', (1.0, 2.54, 1.15), (.64, .085, 1.93), wood)
box('Shop door upper glass', (1.0, 2.485, 1.56), (.47, .035, .81), window)
text('Door closed sign', 'BACK AT DAWN', (1.0, 2.456, 1.44), .052, cream)


def tree(x, y, height, leafmat, index):
    beam(f'Tree {index} trunk', (x, y, .06), (x+.1, y, height*.7), .13, wood)
    for i, (dx, dy, dz, scale) in enumerate([(-.55, 0, .71, .7), (.57, .18, .78, .8), (0, -.15, .96, .87)]):
        end = (x+dx, y+dy, height*dz)
        beam(f'Tree {index} branch {i}', (x, y, height*.45), end, .075, wood)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1, location=end)
        obj = finish(bpy.context.object, f'Tree {index} angular crown {i}', leafmat)
        obj.scale = (height*.31*scale, height*.27*scale, height*.35*scale)
        obj.rotation_euler[2] = RNG.uniform(0, pi)


for i, (x, y, h, mat) in enumerate([
    (-5.5, 3.5, 4.5, ochre), (-3.5, 4.7, 3.8, gold), (-6.5, 5.0, 4.4, purple),
    (-.8, 5.1, 4.4, purple), (3.7, 5.2, 4.6, purple), (5.6, 3.1, 5.2, orange),
    (6.3, 5.2, 4.4, ochre), (5.5, .6, 3.9, ochre),
]):
    tree(x, y, h, mat, i)

# A short fence and timber wheel stops give the middle ground scale.
for x in [-6, -5, -4, -3]:
    box('Fence post', (x, 2.3, .65), (.1, .1, 1.2), wood)
for z in [.5, .95]:
    box('Fence rail', (-4.5, 2.3, z), (3.2, .065, .095), cream)
for x in [-1.8, 2.7]:
    box('Timber wheel stop', (x, -1.7, .31), (.8, .15, .17), wood, .025)

# Hand-shaped five-point leaf cards. Seeded placement is identical on every run.
leafmesh = bpy.data.meshes.new('Original folded leaf')
leafmesh.from_pydata([(0, -.85, 0), (-.48, -.2, 0), (-.35, .37, 0), (0, .85, .05),
                     (.35, .37, 0), (.48, -.2, 0), (0, 0, .18)], [],
                    [(6, i, (i+1) % 6) for i in range(6)])
for i in range(42):
    mesh = leafmesh.copy()
    obj = bpy.data.objects.new(f'Fallen leaf {i:02}', mesh)
    bpy.context.collection.objects.link(obj)
    x, y = RNG.uniform(-6.6, 6.6), RNG.uniform(-5.0, 4.5)
    z = .25 if -3.1 < x < 4.5 and -1.95 < y < 2.75 else .15
    obj.location = (x, y, z)
    obj.scale = (.09, .14, .1)
    obj.rotation_euler[2] = RNG.uniform(-pi, pi)
    mesh.materials.append(RNG.choice([orange, ochre, gold]))
for i, (x, y, z) in enumerate([(-3.0, -.9, 1.3), (3.8, -.6, 2.1), (5.2, 1.3, 3.4)]):
    obj = bpy.data.objects.new(f'Suspended leaf {i}', leafmesh.copy())
    bpy.context.collection.objects.link(obj)
    obj.location, obj.scale = (x, y, z), (.12, .19, .13)
    obj.rotation_euler = (radians(65), radians(25), i*1.8)
    obj.data.materials.append(gold)

# Studio-like cool night surround retains readable silhouettes and slab edges.
box('Infinite night floor', (0, 0, -.94), (200, 200, .1), night)
area('Blue moon key', (-4, 0, 12), (0, 1, 0), 1500, (.32, .49, 1), 9)
area('Copper treetop rim', (1, 8, 9), (0, 2, 2), 1900, (1, .35, .12), 7)
area('Soft frontal fill', (3, -10, 7), (0, 0, 1), 600, (.5, .62, 1), 8)

scene = bpy.context.scene
scene.world = bpy.data.worlds.new('Cool night world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.055, .08, .16, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .3
bpy.ops.object.camera_add(location=(11, -19, 12))
camera = bpy.context.object
camera.name = 'Last Light / only still camera'
camera.rotation_euler = (Vector((0, .4, 1.9))-camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type, camera.data.ortho_scale = 'ORTHO', 22.5
scene.camera = camera
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.image_settings.color_depth = '8'
scene.render.film_transparent = False
scene.render.filepath = str(OUT / 'autumn-stop.png')
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.fps = 30
scene.frame_start = scene.frame_end = 1
scene['provenance'] = 'Original Last Light diorama for BLD1; no external assets; app owns all motion output.'
scene['seed'] = 8102026
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'autumn-stop.blend'))
bpy.ops.render.render(write_still=True)
tap = world_to_camera_view(scene, camera, Vector((px, py-.42, 1.85)))
print(f'Pump tap in normalized image coordinates: ({tap.x:.4f}, {1-tap.y:.4f})')
print(f'BLD1 complete: Blender {bpy.app.version_string}; 1600x1000 RGB; {time.perf_counter()-START:.2f} seconds')
