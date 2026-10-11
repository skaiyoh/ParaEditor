import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseScenePackage } from '../src/app/scene-package.ts';
import { importSceneFile } from '../src/app/scene-store.ts';
import { landscapeSchema, parseLandscapeMesh, landscapeMatrix } from '../src/app/showcase/landscape.ts';
import { project } from '../src/app/showcase/scene.ts';

const assets = new URL('../assets/scenes/highland-field/', import.meta.url);
const field = landscapeSchema.parse(JSON.parse(await readFile(new URL('field.json', assets), 'utf8')));
const mesh = await readFile(new URL('field.mesh', assets));
const poster = await readFile(new URL('highland-field.png', assets));
const manifest = {
  format: 'noisy-scene', version: 1, title: 'Highland round trip', field,
  mesh: { bytes: mesh.byteLength, sha256: createHash('sha256').update(mesh).digest('hex') },
  poster: { mediaType: 'image/png', bytes: poster.byteLength },
};
function pack(json: unknown = manifest, geometry = mesh, image = poster): ArrayBuffer {
  const encoded = Buffer.from(JSON.stringify(json));
  const header = Buffer.alloc(8); header.write('NSC1'); header.writeUInt32LE(encoded.length, 4);
  return new Uint8Array(Buffer.concat([header, encoded, geometry, image])).buffer;
}
async function refusal(bytes: ArrayBuffer, reason: RegExp): Promise<void> {
  const result = await parseScenePackage(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, reason);
}
function alteredGeometry(change: (bytes: Buffer) => void): ArrayBuffer {
  const changed = Buffer.from(mesh); change(changed);
  return pack({ ...manifest, mesh: { ...manifest.mesh, sha256: createHash('sha256').update(changed).digest('hex') } }, changed);
}

test('the real Highland package round trips through C2 with unchanged HLF1 bytes and PNG', async () => {
  const result = await parseScenePackage(pack());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.title, manifest.title);
  assert.deepEqual(result.value.field, field);
  assert.deepEqual(Buffer.from(result.value.mesh), mesh);
  assert.deepEqual(Buffer.from(await result.value.poster.arrayBuffer()), poster);
  assert.equal(result.value.poster.type, 'image/png');
  assert.equal(parseLandscapeMesh(result.value.field, result.value.mesh).indices.length, field.triangleCount * 3);
});

test('refuses raw blend, wrong magic, empty and short files', async () => {
  await refusal(new ArrayBuffer(0), /not a Noisy scene package/);
  await refusal(new Uint8Array(Buffer.from('BLENDER-v500')).buffer, /not a Noisy scene package/);
  const bytes = pack(); new DataView(bytes).setUint32(0, 0, true);
  await refusal(bytes, /not a Noisy scene package/);
});

test('refuses manifest lengths outside 1..1048576 and truncated manifests', async () => {
  for (const length of [0, 1048577, 900]) {
    const bytes = new ArrayBuffer(8); const header = new DataView(bytes);
    header.setUint32(0, 0x3143534e, true); header.setUint32(4, length, true);
    await refusal(bytes, /invalid manifest length/);
  }
});

test('refuses malformed UTF-8 and JSON', async () => {
  for (const data of [Buffer.from('{'), Buffer.from([0xff])]) {
    const header = Buffer.alloc(8); header.write('NSC1'); header.writeUInt32LE(data.length, 4);
    await refusal(new Uint8Array(Buffer.concat([header, data])).buffer, /not valid UTF-8 JSON/);
  }
});

test('refuses invalid manifest format, version, title, hash, integer lengths and field schema', async () => {
  const invalid = [null, {}, { ...manifest, format: 'other' }, { ...manifest, version: 2 },
    { ...manifest, title: '' }, { ...manifest, title: 'x'.repeat(81) },
    { ...manifest, mesh: { ...manifest.mesh, sha256: 'oops' } },
    { ...manifest, mesh: { ...manifest.mesh, bytes: 1.5 } },
    { ...manifest, poster: { ...manifest.poster, bytes: -1 } },
    { ...manifest, field: { ...field, eye: [0, 2, 3] } },
    { ...manifest, field: { ...field, meshBytes: 80 * 1024 * 1024 + 1 } },
    { ...manifest, field: { ...field, objects: field.objects.map(object => ({ ...object, firstIndex: 9 })) } }];
  for (const value of invalid) await refusal(pack(value), /manifest or landscape information is invalid/);
});

test('refuses whole-file and poster limits, mismatch, truncation and trailing data', async () => {
  await refusal(new ArrayBuffer(96 * 1024 * 1024 + 1), /larger than 96 MiB/);
  await refusal(pack({ ...manifest, poster: { ...manifest.poster, bytes: 8 * 1024 * 1024 + 1 } }), /larger than 8 MiB/);
  await refusal(pack({ ...manifest, mesh: { ...manifest.mesh, bytes: mesh.length - 4 } }), /length does not match/);
  await refusal(pack().slice(0, -1), /truncated or contains unexpected extra bytes/);
  const valid = new Uint8Array(pack()), extra = new Uint8Array(valid.length + 1); extra.set(valid);
  await refusal(extra.buffer, /truncated or contains unexpected extra bytes/);
});

test('refuses unsupported poster types and accepts a JPEG poster', async () => {
  await refusal(pack({ ...manifest, poster: { ...manifest.poster, mediaType: 'image/webp' } }), /PNG or JPEG/);
  const jpeg = await readFile(new URL('../src/assets/sample.jpg', import.meta.url));
  const result = await parseScenePackage(pack({ ...manifest, poster: { mediaType: 'image/jpeg', bytes: jpeg.length } }, mesh, jpeg));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.poster.type, 'image/jpeg');
});

test('refuses each missing landmark kind', async () => {
  for (const kind of [1, 3]) await refusal(pack({ ...manifest, field: { ...field,
    objects: field.objects.map(object => ({ ...object, kind: object.kind === kind ? 2 : object.kind })) } }), /kind 1 near landmark and a kind 3 far landmark/);
});

test('refuses changed mesh bytes and accepts uppercase SHA hex', async () => {
  await refusal(pack({ ...manifest, mesh: { ...manifest.mesh, sha256: '0'.repeat(64) } }), /checksum does not match/);
  const changed = Buffer.from(mesh); changed[16] = (changed[16] ?? 0) ^ 1;
  await refusal(pack(manifest, changed), /checksum does not match/);
  assert.equal((await parseScenePackage(pack({ ...manifest, mesh: { ...manifest.mesh, sha256: manifest.mesh.sha256.toUpperCase() } }))).ok, true);
});

test('refuses invalid HLF1 headers, nonfinite coordinates and out-of-range indices even with correct SHA', async () => {
  for (const offset of [0, 4, 8, 12]) await refusal(alteredGeometry(bytes => bytes.writeUInt32LE(0, offset)), /invalid geometry/);
  await refusal(alteredGeometry(bytes => bytes.writeFloatLE(NaN, 16)), /invalid geometry/);
  await refusal(alteredGeometry(bytes => bytes.writeFloatLE(Infinity, 20)), /invalid geometry/);
  await refusal(alteredGeometry(bytes => bytes.writeUInt32LE(field.vertexCount, 16 + field.vertexCount * 44)), /invalid geometry/);
});

test('invalid imports refuse before requiring IndexedDB; oversized Blobs refuse before reading', async () => {
  const result = await importSceneFile(new Blob(['BLENDER-v500']));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not a Noisy scene package/);
  class OversizedBlob extends Blob {
    override get size(): number { return 96 * 1024 * 1024 + 1; }
    override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('An oversized file must not be read.'); }
  }
  assert.deepEqual(await importSceneFile(new OversizedBlob()), { ok: false, reason: 'The scene package is larger than 96 MiB.' });
});

// Export an actual Blender scene through the installed operator, including
// poster rendering, split normals, defaults, transformed meshes and refusals.
export function blenderTestScript(exporter: string, destination: string): string {
  return `import bpy, importlib.util, math, json, pathlib, sys
from mathutils import Vector
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('noisy_scene_export', ${JSON.stringify(exporter)})
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
addon.register()
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 8
scene.cycles.device = 'CPU'
scene.render.resolution_x, scene.render.resolution_y = 320, 240
scene.render.resolution_percentage = 100
scene.world = bpy.data.worlds.new('Copper sky')
scene.world.color = (.06, .09, .16)
def object_color(name, color, location, scale, kind=None):
    bpy.ops.mesh.primitive_cube_add(size=2, location=location)
    obj = bpy.context.object
    obj.name, obj.scale = name, scale
    if kind is not None: obj['noisy_kind'] = kind
    material = bpy.data.materials.new(name + ' color')
    material.diffuse_color = (*color, 1)
    material.use_nodes = True
    shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*color, 1)
    obj.data.materials.append(material)
    return obj
near = object_color('Copper near monolith', (.65, .14, .035), (2, 2, 2), (.8, .8, 2), 1)
far = object_color('Jade far tower', (.06, .5, .34), (-3, 16, 5), (2, 2, 5), 3)
far.scale.x *= -1
floor = object_color('Blue slate floor', (.05, .13, .25), (0, 12, -.35), (22, 30, .25))
attr = near.data.color_attributes.new(name='Albedo', type='FLOAT_COLOR', domain='CORNER')
for value in attr.data: value.color = (.65, .14, .035, 1)
hidden = object_color('Hidden object', (1, 0, 0), (0, 3, 3), (1, 1, 1), 4)
hidden.hide_set(True)
bpy.ops.object.camera_add(location=(0, -8, 3), rotation=(math.pi / 2, 0, 0))
scene.camera = bpy.context.object
scene.camera.scale = (2, 1, 1)
scene.camera.data.lens = 30
scene.camera.data.shift_y = .06
scene.camera.data.shift_x = .04
bpy.ops.object.light_add(type='SUN', location=(0, -2, 7))
sun = bpy.context.object
sun.rotation_euler = (-Vector((-.5, -.3, .8))).to_track_quat('-Z', 'Y').to_euler()
sun.data.energy = 3
bpy.context.view_layer.update()
before = (scene.render.filepath, scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage)
result = bpy.ops.export_scene.noisy(filepath=${JSON.stringify(destination)}, title='Copper observatory', poster_size=320)
assert result == {'FINISHED'}, result
assert hidden.hide_render is False
assert before == (scene.render.filepath, scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage)
manifest = json.loads(pathlib.Path(${JSON.stringify(destination)}).read_bytes()[8:8 + int.from_bytes(pathlib.Path(${JSON.stringify(destination)}).read_bytes()[4:8], 'little')])
assert len(manifest['field']['objects']) == 3
assert floor.get('noisy_kind') is None
for suffix, width, height in [('.wide', 1920, 1080), ('.portrait', 1080, 1920)]:
    scene.render.resolution_x, scene.render.resolution_y = width, height
    variant, geometry = addon.export_geometry(bpy.context, 3.6, 1.4)
    pathlib.Path(${JSON.stringify(destination)} + suffix + '.json').write_text(json.dumps(variant))
scene.render.resolution_x, scene.render.resolution_y = 320, 240
try:
    addon.export_scene(bpy.context, ${JSON.stringify(destination + '.invalid')}, '😀' * 41)
    raise AssertionError('A title exceeding 80 browser characters should be refused')
except ValueError as error:
    assert 'title must contain' in str(error), str(error)
near['noisy_kind'] = 2
try:
    addon.export_scene(bpy.context, ${JSON.stringify(destination + '.invalid')}, 'Invalid')
    raise AssertionError('Missing landmark should be refused')
except ValueError as error:
    assert 'kind=1' in str(error), str(error)
assert not pathlib.Path(${JSON.stringify(destination + '.invalid')}).exists()
near['noisy_kind'] = 1
scene.camera.rotation_euler.x = 0
bpy.context.view_layer.update()
try:
    addon.export_scene(bpy.context, ${JSON.stringify(destination + '.invalid')}, 'Invalid')
    raise AssertionError('Tilted camera should be refused')
except ValueError as error:
    assert 'camera must face' in str(error), str(error)
addon.unregister()
print('NOISY_BLENDER_EXPORT_PASS')
`;
}

test('Blender GUI operator exports a rendered tiny scene that the real landscape parser accepts', { timeout: 60000 }, async context => {
  const blender = '/Applications/Blender.app/Contents/MacOS/Blender';
  try { await access(blender); } catch { context.skip('Blender is not installed at the expected macOS path.'); return; }
  const directory = await mkdtemp(path.join(tmpdir(), 'noisy-scene-export-'));
  try {
    const destination = path.join(directory, 'tiny.noisyscene'), script = path.join(directory, 'export.py');
    await writeFile(script, blenderTestScript(fileURLToPath(new URL('../tools/blender/noisy_scene_export.py', import.meta.url)), destination));
    const output = await promisify(execFile)(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script], { timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
    assert.match(output.stdout, /NOISY_BLENDER_EXPORT_PASS/);
    const bytes = new Uint8Array(await readFile(destination)).buffer;
    const result = await parseScenePackage(bytes);
    assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result));
    if (!result.ok) return;
    assert.equal(result.value.title, 'Copper observatory');
    assert.equal(result.value.field.objects.length, 3);
    assert.ok(result.value.poster.size > 100);
    const geometry = parseLandscapeMesh(result.value.field, result.value.mesh);
    assert.ok(geometry.vertices.length > 0);
    const matrix = landscapeMatrix(result.value.field, { x: 0, y: 0 }, 4 / 3);
    for (const object of result.value.field.objects) {
      const actual = project(matrix, object.center);
      assert.ok(Math.abs(actual.x - object.neutralProjection[0]) < 1e-5);
      assert.ok(Math.abs(actual.y - (1 - object.neutralProjection[1])) < 1e-5);
    }
    for (const [suffix, aspect] of [['.wide', 16 / 9], ['.portrait', 9 / 16]] satisfies [string, number][]) {
      const variant = landscapeSchema.parse(JSON.parse(await readFile(destination + suffix + '.json', 'utf8')));
      const variantMatrix = landscapeMatrix(variant, { x: 0, y: 0 }, aspect);
      for (const object of variant.objects) {
        const actual = project(variantMatrix, object.center);
        assert.ok(Math.abs(actual.x - object.neutralProjection[0]) < 1e-5, suffix + ' horizontal framing');
        assert.ok(Math.abs(actual.y - (1 - object.neutralProjection[1])) < 1e-5, suffix + ' vertical framing');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses a poster whose bytes are not the image it declares, before persistence', async () => {
  const fake = Buffer.from('not an image');
  await refusal(pack({ ...manifest, poster: { mediaType: 'image/png', bytes: fake.byteLength } }, mesh, fake), /poster is not a valid image/);
  const png = Buffer.from(poster);
  await refusal(pack({ ...manifest, poster: { mediaType: 'image/jpeg', bytes: png.byteLength } }, mesh, png), /poster is not a valid image/);
});
