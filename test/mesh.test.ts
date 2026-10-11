import test from 'node:test';
import assert from 'node:assert/strict';
import { backGrid, objectGrid, gridMesh, meshDepthJump, meshProjectionSafe, meshProjectionScale } from '../src/render/mesh.ts';
import { createPerspectiveGeometry, lateralEnvelope, projectSource } from '../src/core/perspective.ts';
import { fillBackgroundDepth } from '../src/render/shaders/pushpull.ts';

test('back grid dimensions, coverage and every triangle winding', () => {
  const { vertices, indices } = backGrid();
  assert.equal(vertices.length / 2, 193 * 145);
  assert.equal(indices.length / 3, 192 * 144 * 2);
  assert.deepEqual(Array.from(vertices.slice(0, 2)), [0, 0]);
  assert.deepEqual(Array.from(vertices.slice(-2)), [1, 1]);
  for (let i = 0; i < indices.length; i += 3) {
    const a = (indices[i] ?? 0) * 2, b = (indices[i + 1] ?? 0) * 2, c = (indices[i + 2] ?? 0) * 2;
    const cross = ((vertices[b] ?? 0) - (vertices[a] ?? 0)) * ((vertices[c + 1] ?? 0) - (vertices[a + 1] ?? 0)) -
      ((vertices[b + 1] ?? 0) - (vertices[a + 1] ?? 0)) * ((vertices[c] ?? 0) - (vertices[a] ?? 0));
    assert.ok(cross > 0, `triangle ${i / 3} is consistently wound`);
  }
});

test('object grid dilates each axis in frame fractions and clamps to frame', () => {
  const { vertices, indices } = objectGrid({ x: 0, y: 500, width: 400, height: 600 }, { width: 2048, height: 1536 }, .02);
  assert.equal(vertices.length / 2, 65 * 65);
  assert.equal(indices.length / 3, 64 * 64 * 2);
  assert.equal(vertices[0], 0);
  assert.ok(Math.abs((vertices[1] ?? 0) - (500 / 1536 - .02)) < 1e-7);
  assert.ok(Math.abs((vertices[vertices.length - 2] ?? 0) - (400 / 2048 + .02)) < 1e-7);
});

for (const size of [129, 513]) test(`eight-level push-pull fills a disc at ${size}px without leaving the ring range`, () => {
  const data = new Float32Array(size * size), hole = new Uint8Array(data.length);
  const center = (size - 1) / 2, radius = size * .28;
  let ringMin = Infinity, ringMax = -Infinity;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot(x - center, y - center), i = y * size + x;
    // Same angular field on and outside the surrounding ring. The poisoned
    // hole must contribute no value to the weighted downsample.
    data[i] = distance < radius ? -999 : .5 + .2 * Math.cos(Math.atan2(y - center, x - center));
    if (distance < radius) hole[i] = 255;
    if (distance >= radius && distance < radius + 2) { ringMin = Math.min(ringMin, data[i] ?? 0); ringMax = Math.max(ringMax, data[i] ?? 0); }
  }
  const filled = fillBackgroundDepth({ format: 'f32', size: { width: size, height: size }, data },
    { format: 'u8', size: { width: size, height: size }, data: hole });
  for (let i = 0; i < data.length; i++) {
    const value = filled.data[i] ?? NaN;
    assert.ok(Number.isFinite(value));
    if (hole[i] === 255) assert.ok(value >= ringMin && value <= ringMax, `filled texel ${i}: ${value} outside [${ringMin}, ${ringMax}]`);
    else assert.equal(value, data[i]);
  }
  assert.equal(data[center * size + center], -999, 'the refined plane stays untouched');
});

test('push-pull preserves a no-hole plane and fills an entirely unknown plane neutrally', () => {
  const size = { width: 3, height: 5 }, data = new Float32Array(15).fill(.25);
  const plane = { format: 'f32', size, data } satisfies Parameters<typeof fillBackgroundDepth>[0];
  assert.deepEqual(fillBackgroundDepth(plane, { format: 'u8', size, data: new Uint8Array(15) }).data, data);
  assert.ok(fillBackgroundDepth(plane, { format: 'u8', size, data: new Uint8Array(15).fill(255) }).data.every((value) => value === .5));
});

test('mesh depth-jump inspection detects a silhouette and accepts its separately extended layer', () => {
  const size = { width: 32, height: 32 }, data = new Float32Array(1024).fill(.2), outside = new Uint8Array(1024).fill(255);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) { data[y * 32 + x] = .9; outside[y * 32 + x] = 0; }
  const plane = { format: 'f32', size, data } satisfies Parameters<typeof fillBackgroundDepth>[0];
  const mesh = gridMesh(16, 16);
  assert.ok(meshDepthJump(mesh, plane) > .35, 'original foreground/background discontinuity is unsafe');
  const own = fillBackgroundDepth(plane, { format: 'u8', size, data: outside });
  assert.ok(meshDepthJump(mesh, own) < 1e-6, 'object depth extension removes the artificial silhouette bridge');
});

test('mesh depth sampling covers edges, bilinear texel centers, and invalid plane data', () => {
  const mesh = gridMesh(1, 1), size = { width: 2, height: 2 };
  assert.equal(meshDepthJump(mesh, { format: 'f32', size, data: new Float32Array([0, 1, 0, 1]) }), 1);
  assert.equal(meshDepthJump(mesh, { format: 'f32', size, data: new Float32Array(4).fill(.5) }), 0);
  assert.throws(() => meshDepthJump(mesh, { format: 'f32', size, data: new Float32Array(3) }), RangeError);
  assert.throws(() => meshDepthJump(mesh, { format: 'f32', size, data: new Float32Array([NaN, 1, 0, 1]) }), RangeError);
});

test('projection safety rejects a moderate disparity edge that folds below the old jump threshold', () => {
  const size = { width: 384, height: 288 }, data = new Float32Array(size.width * size.height);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) data[y * size.width + x] = x < 191 ? .3 : .6;
  const plane = { format: 'f32', size, data } satisfies Parameters<typeof fillBackgroundDepth>[0];
  const geometry = createPerspectiveGeometry({ aperture: { center: { x: 0, y: 0 }, width: 1, height: .75 },
    crop: .04, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 });
  assert.ok(meshDepthJump(backGrid(), plane) < .35);
  assert.equal(meshProjectionSafe(backGrid(), plane, geometry), false, 'a sign-changing triangle invalidates the full envelope');
  assert.equal(meshProjectionSafe(backGrid(), { ...plane, data: new Float32Array(data.length).fill(.5) }, geometry), true);
  assert.equal(meshProjectionSafe(backGrid(), plane, { ...geometry, crop: 0 }), true, 'zero exterior travel has no fold');
  const mesh = backGrid(), scale = meshProjectionScale(mesh, plane, geometry), envelope = lateralEnvelope(geometry);
  assert.ok(scale > 0 && scale < 1, `unsafe full envelope retains nonzero bounded travel: ${scale}`);
  const sample = (u: number) => {
    const position = u * size.width - .5, lo = Math.floor(position), f = position - lo;
    return (data[Math.max(0, Math.min(size.width - 1, lo))] ?? 0) * (1 - f) +
      (data[Math.max(0, Math.min(size.width - 1, lo + 1))] ?? 0) * f;
  };
  const neutral = { x: 0, y: 0, z: 1 };
  for (const x of [envelope.min.x, envelope.max.x]) for (const y of [envelope.min.y, envelope.max.y]) {
    const eye = { x: x * scale, y: y * scale, z: 1 };
    const points = Array.from({ length: mesh.vertices.length / 2 }, (_, i) => {
      const uv = { x: mesh.vertices[i * 2] ?? 0, y: mesh.vertices[i * 2 + 1] ?? 0 }, d = sample(uv.x);
      return { at: projectSource(uv, d, geometry, eye), neutral: projectSource(uv, d, geometry, neutral) };
    });
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = points[mesh.indices[i] ?? 0], b = points[mesh.indices[i + 1] ?? 0], c = points[mesh.indices[i + 2] ?? 0];
      if (a === undefined || b === undefined || c === undefined) throw new Error('Missing fixture vertex.');
      const area = (b.at.x - a.at.x) * (c.at.y - a.at.y) - (b.at.y - a.at.y) * (c.at.x - a.at.x);
      const base = (b.neutral.x - a.neutral.x) * (c.neutral.y - a.neutral.y) - (b.neutral.y - a.neutral.y) * (c.neutral.x - a.neutral.x);
      assert.ok(area / base >= .05, `triangle ${i / 3} preserves signed area at scaled corner`);
    }
  }
});
