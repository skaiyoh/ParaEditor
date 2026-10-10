import test from 'node:test';
import assert from 'node:assert/strict';
import { backGrid, objectGrid } from '../src/render/mesh.ts';
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
