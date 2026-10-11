import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { landscapeAperture, landscapeMatrix, landscapeSchema, parseLandscapeMesh } from '../src/app/showcase/landscape.ts';
import { advanceSpring, headTarget, type Spring } from '../src/app/showcase/motion.ts';
import { project } from '../src/app/showcase/scene.ts';

const scene = landscapeSchema.parse(JSON.parse(await readFile(new URL('../assets/scenes/highland-field/field.json', import.meta.url), 'utf8')));
const source = new Uint8Array(await readFile(new URL('../assets/scenes/highland-field/field.mesh', import.meta.url)));

test('the approved Highland export validates as actual indexed geometry', () => {
  const mesh = parseLandscapeMesh(scene, source.slice().buffer);
  assert.equal(source.byteLength, scene.meshBytes);
  assert.equal(mesh.vertices.length, scene.vertexCount * (scene.strideBytes / 4));
  assert.equal(mesh.indices.length, scene.triangleCount * 3);
  assert.equal(scene.objects.some(object => object.kind === 5), false, 'construction box stays absent');
});

test('landscape horizontal projection agrees with the authored neutral landmarks', () => {
  const matrix = landscapeMatrix(scene, { x: 0, y: 0 }, 4 / 3);
  for (const object of scene.objects) {
    const value = project(matrix, object.center);
    assert.ok(Math.abs(value.x - object.neutralProjection[0]) < 1e-5, object.name);
  }
});

test('all four screen corners remain fixed at extreme eyes and responsive aspects', () => {
  for (const aspect of [4 / 3, 1180 / 640, 390 / 530]) {
    const [w, h, z] = landscapeAperture(scene, aspect);
    for (const eye of [{ x: 0, y: 0 }, { x: -3.6, y: -1.4 }, { x: 3.6, y: 1.4 }]) {
      const matrix = landscapeMatrix(scene, eye, aspect);
      for (const [x, y] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] satisfies readonly (readonly [number, number])[]) {
        const point = project(matrix, [x * w / 2, 0, z + y * h / 2]);
        assert.ok(Math.abs(point.x - (x + 1) / 2) < 1e-6);
        assert.ok(Math.abs(point.y - (1 - y) / 2) < 1e-6);
      }
    }
  }
});

test('malformed landscape counts, object ranges, indices and coordinates are rejected', () => {
  assert.equal(landscapeSchema.safeParse({ ...scene, eye: [0, 1, 2] }).success, false);
  assert.equal(landscapeSchema.safeParse({ ...scene, meshBytes: 1 }).success, false);
  assert.equal(landscapeSchema.safeParse({ ...scene, objects: [...scene.objects, scene.objects[0]] }).success, false);
  assert.throws(() => parseLandscapeMesh(scene, source.slice(0, 40).buffer), /length/);
  const coordinates = source.slice(); new DataView(coordinates.buffer).setFloat32(16, NaN, true);
  assert.throws(() => parseLandscapeMesh(scene, coordinates.buffer), /coordinates/);
  const indices = source.slice(); new DataView(indices.buffer).setUint32(16 + scene.vertexCount * 44, scene.vertexCount, true);
  assert.throws(() => parseLandscapeMesh(scene, indices.buffer), /indices/);
});

test('approved head gain is applied once with the calibrated source axes', () => {
  assert.deepEqual(headTarget({ x: .625, y: .375 }, 2), { x: .5, y: .5 });
  assert.deepEqual(headTarget({ x: .625, y: .375 }, 1), { x: .25, y: .25 });
  assert.deepEqual(headTarget({ x: 2, y: -1 }, 6), { x: 1, y: 1 });
});

test('the camera spring converges smoothly across display rates without overshooting a stationary target', () => {
  const initial: Spring = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
  const target = { x: 1, y: -.5 };
  const run = (rate: number) => {
    let value = initial;
    for (let i = 0; i < rate; i++) {
      const previous = value.position.x; value = advanceSpring(value, target, 1000 / rate, true, false);
      assert.ok(value.position.x >= previous && value.position.x <= 1);
    }
    return value;
  };
  const sixty = run(60), thirty = run(30);
  assert.ok(Math.abs(sixty.position.x - thirty.position.x) < 1e-6);
  assert.ok(Math.abs(sixty.position.x - 1) < .001);
  assert.deepEqual(advanceSpring(initial, target, 16, true, true), { position: target, velocity: { x: 0, y: 0 } });
});
