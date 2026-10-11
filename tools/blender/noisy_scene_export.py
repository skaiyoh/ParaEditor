"""Export the active Blender scene to Noisy's NSC1 landscape package."""
bl_info = {
    'name': 'Noisy scene exporter', 'author': 'Noisy', 'version': (1, 0, 0),
    'blender': (4, 2, 0), 'location': 'File > Export > Noisy scene (.noisyscene)',
    'description': 'Export visible landscape meshes, camera, sun and poster',
    'category': 'Import-Export',
}

from array import array
import hashlib
import json
import math
from pathlib import Path
import os
import struct
import sys
import tempfile

import bpy
from bpy.props import FloatProperty, IntProperty, StringProperty
from bpy_extras.io_utils import ExportHelper
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

MAX_MESH = 80 * 1024 * 1024
MAX_POSTER = 8 * 1024 * 1024
MAX_PACKAGE = 96 * 1024 * 1024


def positive(value, label):
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'{label} must be a positive finite number.')
    return value


def camera_window(scene):
    camera = scene.camera
    if camera is None or camera.type != 'CAMERA' or camera.data.type != 'PERSP':
        raise ValueError('Set an active perspective camera before exporting.')
    # Blender's camera projection ignores object scale, as does
    # world_to_camera_view. Use the same normalized frame for the window.
    camera_matrix = camera.matrix_world.normalized()
    rotation = camera_matrix.to_quaternion()
    forward, up = rotation @ Vector((0, 0, -1)), rotation @ Vector((0, 1, 0))
    if forward.dot(Vector((0, 1, 0))) < .999999 or up.dot(Vector((0, 0, 1))) < .999999:
        raise ValueError('The camera must face world +Y with world +Z up (rotation X=90, Y=0, Z=0 degrees).')
    eye = camera.matrix_world.translation.copy()
    if eye.y >= 0:
        raise ValueError('Place the camera at a negative world Y coordinate; the window plane is Y=0.')
    corners = []
    for local in camera.data.view_frame(scene=scene):
        ray = camera_matrix @ local - eye
        if ray.y <= 0:
            raise ValueError('The camera window does not face the scene.')
        corners.append(eye + ray * (-eye.y / ray.y))
    x0, x1 = min(p.x for p in corners), max(p.x for p in corners)
    z0, z1 = min(p.z for p in corners), max(p.z for p in corners)
    # The viewer's physical window is centered on X=0. Recenter the whole
    # export rather than losing a camera's horizontal lens shift.
    center_x = (x0 + x1) / 2
    eye.x -= center_x
    # landscapeAperture expands a canonical 4:3 window to the display
    # aspect. Undo that expansion here so a wide/portrait authored camera
    # reproduces its original framing at the same display aspect.
    width = min(x1 - x0, (z1 - z0) * 4 / 3)
    return camera, list(eye), center_x, {
        'width': positive(width, 'Window width'),
        'height': positive(width * 3 / 4, 'Window height'), 'centerZ': (z0 + z1) / 2,
    }


def material_color(mesh, polygon_index):
    slot = mesh.polygons[polygon_index].material_index
    material = mesh.materials[slot] if slot < len(mesh.materials) else None
    if material is None:
        return (.5, .5, .5)
    if material.use_nodes:
        shader = next((node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
        if shader is not None:
            return tuple(shader.inputs['Base Color'].default_value[:3])
    return tuple(material.diffuse_color[:3])


def export_geometry(context, travel_x, travel_z):
    scene = context.scene
    camera, eye, center_x, window = camera_window(scene)
    visible = sorted((obj for obj in scene.objects
                      if obj.type == 'MESH' and obj.visible_get(view_layer=context.view_layer)
                      and not obj.hide_render), key=lambda obj: obj.name)
    if not visible:
        raise ValueError('The scene has no visible mesh objects to export.')
    if len(visible) > 4096:
        raise ValueError('The scene has more than 4096 visible mesh objects.')
    suns = sorted((obj for obj in scene.objects if obj.type == 'LIGHT' and obj.data.type == 'SUN'
                   and obj.visible_get(view_layer=context.view_layer) and not obj.hide_render), key=lambda obj: obj.name)
    if not suns:
        raise ValueError('Add a visible Sun light before exporting.')
    sun = (suns[0].matrix_world.to_quaternion() @ Vector((0, 0, 1))).normalized()
    vertices, indices, objects = array('f'), array('I'), []
    depsgraph = context.evaluated_depsgraph_get()
    for obj in visible:
        kind = obj.get('noisy_kind', 2)
        if isinstance(kind, bool) or not isinstance(kind, int) or kind < 0 or kind > 5:
            raise ValueError(f'{obj.name}: noisy_kind must be an integer from 0 to 5.')
        if not 1 <= len(obj.name) <= 120:
            raise ValueError('Object names must contain 1 to 120 characters.')
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        try:
            mesh.calc_loop_triangles()
            if not mesh.loop_triangles:
                continue
            matrix = evaluated.matrix_world
            if abs(matrix.to_3x3().determinant()) < 1e-12:
                raise ValueError(f'{obj.name}: apply a nonzero scale before exporting.')
            normal_matrix = matrix.to_3x3().inverted().transposed()
            attr = mesh.color_attributes.get('Albedo') or mesh.color_attributes.active_color
            object_id, first_index = len(objects) + 1, len(indices)
            loop_vertices = {}
            for triangle in mesh.loop_triangles:
                triangle_indices = []
                for loop_index in triangle.loops:
                    if loop_index not in loop_vertices:
                        loop = mesh.loops[loop_index]
                        position = matrix @ mesh.vertices[loop.vertex_index].co
                        position.x -= center_x
                        normal = (normal_matrix @ mesh.corner_normals[loop_index].vector).normalized()
                        if attr is not None and attr.domain in {'POINT', 'CORNER'}:
                            color = attr.data[loop.vertex_index if attr.domain == 'POINT' else loop_index].color[:3]
                        else:
                            color = material_color(mesh, triangle.polygon_index)
                        values = (*position, *normal, *color, float(kind), float(object_id))
                        if not all(math.isfinite(value) for value in values):
                            raise ValueError(f'{obj.name}: geometry or colors contain nonfinite numbers.')
                        loop_vertices[loop_index] = len(vertices) // 11
                        vertices.extend(values)
                    triangle_indices.append(loop_vertices[loop_index])
                if matrix.to_3x3().determinant() < 0:
                    triangle_indices.reverse()
                indices.extend(triangle_indices)
                if len(vertices) // 11 > 2_000_000 or len(indices) // 3 > 2_000_000:
                    raise ValueError('The scene exceeds two million vertices or triangles. Simplify the meshes.')
                if 16 + len(vertices) * 4 + len(indices) * 4 > MAX_MESH:
                    raise ValueError('The scene mesh is larger than 80 MiB. Simplify the meshes.')
            center = sum((matrix @ Vector(corner) for corner in evaluated.bound_box), Vector()) / 8
            projection = list(world_to_camera_view(scene, camera, center))
            center.x -= center_x
            objects.append({'id': object_id, 'name': obj.name, 'firstIndex': first_index,
                            'indexCount': len(indices) - first_index, 'kind': kind,
                            'center': list(center), 'neutralProjection': projection})
        finally:
            evaluated.to_mesh_clear()
    kinds = {obj['kind'] for obj in objects}
    if 1 not in kinds or 3 not in kinds:
        raise ValueError('Set noisy_kind=1 on a near landmark and noisy_kind=3 on a far landmark; both must be visible meshes with faces.')
    if sys.byteorder != 'little':
        vertices.byteswap()
        indices.byteswap()
    mesh_bytes = struct.pack('<4sIII', b'HLF1', len(vertices) // 11, len(indices), 44) + vertices.tobytes() + indices.tobytes()
    field = {'version': 1, 'vertexCount': len(vertices) // 11, 'triangleCount': len(indices) // 3,
             'strideBytes': 44, 'meshBytes': len(mesh_bytes), 'sunDirection': list(sun),
             'eye': eye, 'window': window, 'travel': {'x': positive(travel_x, 'Horizontal travel'),
                                                   'z': positive(travel_z, 'Vertical travel')}, 'objects': objects}
    return field, mesh_bytes


def read_poster(path):
    path = Path(bpy.path.abspath(path))
    if path.stat().st_size > MAX_POSTER:
        raise ValueError('The poster is larger than 8 MiB. Choose a smaller PNG or JPEG.')
    data = path.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return data, 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return data, 'image/jpeg'
    raise ValueError('The poster must be a PNG or JPEG image.')


def render_poster(context, size):
    scene = context.scene
    render = scene.render
    previous = (render.filepath, render.image_settings.file_format, render.image_settings.color_mode,
                render.resolution_x, render.resolution_y, render.resolution_percentage)
    aspect = render.resolution_x / render.resolution_y
    hidden_meshes = [obj for obj in scene.objects if obj.type == 'MESH' and not obj.hide_render
                     and not obj.visible_get(view_layer=context.view_layer)]
    try:
        for obj in hidden_meshes:
            obj.hide_render = True
        with tempfile.TemporaryDirectory(prefix='noisy-poster-') as directory:
            render.filepath = str(Path(directory) / 'poster.png')
            render.image_settings.file_format, render.image_settings.color_mode = 'PNG', 'RGB'
            render.resolution_x = max(1, round(size if aspect >= 1 else size * aspect))
            render.resolution_y = max(1, round(size / aspect if aspect >= 1 else size))
            render.resolution_percentage = 100
            bpy.ops.render.render(write_still=True)
            return read_poster(render.filepath)
    finally:
        for obj in hidden_meshes:
            obj.hide_render = False
        (render.filepath, render.image_settings.file_format, render.image_settings.color_mode,
         render.resolution_x, render.resolution_y, render.resolution_percentage) = previous


def export_scene(context, filepath, title, travel_x=3.6, travel_z=1.4, poster_path='', poster_size=960):
    """Public entry for the GUI operator and headless verification."""
    if not 1 <= len(title.encode('utf-16-le')) // 2 <= 80:
        raise ValueError('The scene title must contain 1 to 80 characters; emoji can count as two.')
    field, mesh = export_geometry(context, travel_x, travel_z)
    poster, media_type = read_poster(poster_path) if poster_path else render_poster(context, poster_size)
    manifest = {'format': 'noisy-scene', 'version': 1, 'title': title, 'field': field,
                'mesh': {'bytes': len(mesh), 'sha256': hashlib.sha256(mesh).hexdigest()},
                'poster': {'mediaType': media_type, 'bytes': len(poster)}}
    encoded = json.dumps(manifest, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if not 1 <= len(encoded) <= 65536 * 16:
        raise ValueError('The scene manifest is larger than 1 MiB.')
    if 8 + len(encoded) + len(mesh) + len(poster) > MAX_PACKAGE:
        raise ValueError('The scene package is larger than 96 MiB.')
    destination = Path(filepath)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.noisy-', delete=False) as output:
            temporary = output.name
            output.write(struct.pack('<4sI', b'NSC1', len(encoded)))
            output.write(encoded)
            output.write(mesh)
            output.write(poster)
        os.replace(temporary, destination)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)
    return manifest


class EXPORT_SCENE_OT_noisy(bpy.types.Operator, ExportHelper):
    bl_idname = 'export_scene.noisy'
    bl_label = 'Export Noisy scene'
    bl_options = {'PRESET'}
    filename_ext = '.noisyscene'
    filter_glob: StringProperty(default='*.noisyscene', options={'HIDDEN'})
    title: StringProperty(name='Scene title', default='My Noisy scene', maxlen=80)
    travel_x: FloatProperty(name='Horizontal travel', default=3.6, min=.001)
    travel_z: FloatProperty(name='Vertical travel', default=1.4, min=.001)
    poster_path: StringProperty(name='Existing poster (optional)', subtype='FILE_PATH', default='')
    poster_size: IntProperty(name='Rendered poster longest edge', default=960, min=64, max=2048)

    def execute(self, context):
        try:
            export_scene(context, self.filepath, self.title, self.travel_x, self.travel_z, self.poster_path, self.poster_size)
        except (ValueError, OSError, RuntimeError, OverflowError) as error:
            self.report({'ERROR'}, f'Noisy export: {error}')
            return {'CANCELLED'}
        self.report({'INFO'}, 'Noisy scene exported. Upload the .noisyscene file in Noisy.')
        return {'FINISHED'}


def menu_export(self, context):
    self.layout.operator(EXPORT_SCENE_OT_noisy.bl_idname, text='Noisy scene (.noisyscene)')


def register():
    bpy.utils.register_class(EXPORT_SCENE_OT_noisy)
    bpy.types.TOPBAR_MT_file_export.append(menu_export)


def unregister():
    bpy.types.TOPBAR_MT_file_export.remove(menu_export)
    bpy.utils.unregister_class(EXPORT_SCENE_OT_noisy)


if __name__ == '__main__':
    register()
