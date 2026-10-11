import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { project, sceneSchema, viewMatrix, windowProjection } from '../src/app/showcase/scene.ts';

const json: unknown = JSON.parse(await readFile(new URL('../src/dev/assets/lantern-court/scene.json', import.meta.url), 'utf8'));
const scene = sceneSchema.parse(json);
test('prepared scene geometry matches its declared triangle layout and integrity hash', async () => {
  const geometry = await readFile(new URL('../src/dev/assets/lantern-court/geometry.bin', import.meta.url));
  assert.equal(geometry.length, scene.vertexCount * 24);
  assert.equal(createHash('sha256').update(geometry).digest('hex'), scene.geometrySha256);
  const floats = new Float32Array(geometry.buffer.slice(geometry.byteOffset, geometry.byteOffset + geometry.byteLength));
  assert.ok(floats.every(Number.isFinite));
  assert.ok(scene.objects > 700 && scene.objects < 836);
  assert.ok(scene.vertexCount / 3 > 90_000);
});
test('browser camera reproduces independently measured Blender landmark projections', () => {
  for (const name of ['lantern', 'pavilion'] as const) {
    const actual = project(viewMatrix(scene, { x: 0, y: 0 }), scene.landmarks[name]);
    assert.ok(Math.abs(actual.x - scene.neutralProjection[name][0]) < 1e-6);
    assert.ok(Math.abs(actual.y - (1 - scene.neutralProjection[name][1])) < 1e-6);
  }
});
test('continuous off-axis camera agrees with all five exported Blender reference matrices', () => {
  for (const reference of scene.references) for (const landmark of Object.values(scene.landmarks)) {
    const expected = project(reference.matrix, landmark);
    const actual = project(viewMatrix(scene, { x: reference.eye[0], y: reference.eye[1] }), landmark);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-6);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6);
    assert.ok(Math.abs(actual.z - expected.z) < 1e-6);
  }
});
test('all four physical glass corners stay fixed across extreme and diagonal viewpoints', () => {
  const neutral = windowProjection(scene, { x: 0, y: 0 });
  for (const eye of [{ x: 4.5, y: 0 }, { x: -4.5, y: 0 }, { x: 0, y: 3.5 }, { x: 0, y: -3.5 }, { x: 3.7, y: 2.9 }]) {
    const projection = windowProjection(scene, eye);
    projection.corners.forEach((corner, i) => {
      assert.ok(Math.abs(corner.x - (neutral.corners[i]?.x ?? NaN)) < 1e-6);
      assert.ok(Math.abs(corner.y - (neutral.corners[i]?.y ?? NaN)) < 1e-6);
    });
  }
  assert.ok(scene.camera.near > 7 && scene.camera.near < scene.camera.convergence);
});
test('cavity walls leave the opening naturally when the eye crosses their plane', () => {
  const width = scene.camera.window.halfWidth, height = scene.camera.window.halfHeight;
  const below = windowProjection(scene, { x: width - .05, y: 0 });
  const at = windowProjection(scene, { x: width, y: 0 });
  const above = windowProjection(scene, { x: width + .05, y: 0 });
  const edge = below.corners[1]?.x ?? NaN;
  assert.ok(below.rightBack.x < edge);
  assert.ok(Math.abs(at.rightBack.x - edge) < 1e-6);
  assert.ok(above.rightBack.x > edge);
  const diagonal = windowProjection(scene, { x: 4.5, y: 3.5 });
  assert.ok(diagonal.rightBack.x > (diagonal.corners[1]?.x ?? NaN));
  assert.ok(diagonal.topBack.y < (diagonal.corners[2]?.y ?? NaN));
  const left = windowProjection(scene, { x: -4.5, y: -3.5 });
  assert.ok(left.leftBack.x < (left.corners[0]?.x ?? NaN));
  assert.ok(left.bottomBack.y > (left.corners[0]?.y ?? NaN));
  assert.ok(scene.camera.travel[0] > width && scene.camera.travel[1] > height);
  const walls = scene.batches.find(batch => batch.name === 'Showcase / recessed blue stone');
  assert.equal(walls?.count, 5 * 36);
  assert.equal(walls?.lighting, 'world');
  assert.ok(scene.batches.filter(batch => !batch.name.startsWith('Showcase /')).every(batch => batch.lighting === 'baked'));
});
test('window and objects at different depths separate strongly under lateral head travel', () => {
  const delta = (x: number) => {
    const matrix = viewMatrix(scene, { x, y: 0 });
    return project(matrix, scene.landmarks.lantern).x - project(matrix, scene.landmarks.pavilion).x;
  };
  assert.ok(Math.abs(delta(.3) - delta(-.3)) * 1920 > 78);
  assert.ok(Math.abs(delta(1) - delta(-1)) * 1920 > 260);
  const neutral = project(viewMatrix(scene, { x: 0, y: 0 }), scene.landmarks.lantern);
  const up = project(viewMatrix(scene, { x: 0, y: .3 }), scene.landmarks.lantern);
  assert.ok(up.y < neutral.y);
});
test('prepared scene boundary rejects external files, invalid matrices and malformed material ranges', () => {
  assert.equal(sceneSchema.safeParse({ ...scene, geometry: 'https://example.com/mesh.bin' }).success, false);
  assert.equal(sceneSchema.safeParse({ ...scene, camera: { ...scene.camera, near: 300 } }).success, false);
  assert.equal(sceneSchema.safeParse({ ...scene, camera: { ...scene.camera, view: Array(16).fill(NaN) } }).success, false);
  assert.equal(sceneSchema.safeParse({ ...scene, vertexCount: scene.vertexCount - 3 }).success, false);
  assert.equal(sceneSchema.safeParse({ ...scene, batches: scene.batches.map((b, i) => i === 0 ? { ...b, first: 3 } : b) }).success, false);
});
