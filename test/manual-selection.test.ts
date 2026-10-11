import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineMasks, copyMask, emptyMask, featherMask, invertMask, materializeMask, rasterizeMask, sampleMask } from '../src/core/mask-edit.ts';
import type { Plane, Size } from '../src/core/raster.ts';
import { createSelection, type SelectionChange, type SelectionOwner, type SelectionGestureStart } from '../src/session/selection.ts';
import { OBJECT_IDS } from './fixtures/documents.ts';

const size = { width: 4, height: 4 };
const photo = { kind: 'photo' } as const;
function plane(width: number, height: number, data: number[]): Plane<'u8'> {
  return { format: 'u8', size: { width, height }, data: Uint8Array.from(data) };
}
function rectangle(owner: Size, x: number, y: number, width: number, height: number): Plane<'u8'> {
  return rasterizeMask(owner, { kind: 'rectangle', from: { x, y }, to: { x: x + width, y: y + height } });
}
function bytes(value: Plane<'u8'>): number[] { return [...value.data]; }

test('4x4 rectangle rasterization: exact one pixel, partial pixel, reversed, clipped and degenerate', () => {
  assert.deepEqual(bytes(rectangle({ width: 1, height: 1 }, 0, 0, 1, 1)), [255]);
  assert.deepEqual(bytes(rectangle({ width: 1, height: 1 }, .5, 0, .5, 1)), [128]);
  assert.deepEqual(bytes(rectangle({ width: 1, height: 1 }, 0, 0, .25, .25)), [16]);
  assert.deepEqual(rectangle(size, 1, 1, 1, 1), rectangle(size, 2, 2, -1, -1));
  assert.equal(rectangle({ width: 100, height: 100 }, 99, 99, 1, 1).data.filter(Boolean).length, 1, 'no AI 0.1% rejection');
  assert.deepEqual(bytes(rectangle(size, -2, -2, 3, 3)), [255, 0, 0, 0, ...Array<number>(12).fill(0)]);
  assert.deepEqual(bytes(rectangle(size, -1, -1, 6, 6)), Array<number>(16).fill(255));
  for (const mask of [rectangle(size, 1, 1, 0, 2), rectangle(size, 1, 1, 2, 0), rectangle(size, 4, 4, 2, 2)]) {
    assert.deepEqual(bytes(mask), Array<number>(16).fill(0));
  }
});

test('freehand closes on release, is winding independent, and uses even-odd for crossings and holes', () => {
  const points = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  const expected = rectangle(size, 0, 0, 2, 2);
  for (const path of [points, [...points].reverse(), [...points, points[0] ?? { x: 0, y: 0 }]]) {
    assert.deepEqual(rasterizeMask(size, { kind: 'path', points: path }), expected);
  }
  assert.deepEqual(bytes(rasterizeMask({ width: 2, height: 2 }, { kind: 'path', points: [
    { x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 },
  ] })), [159, 96, 159, 96], 'samples on diagonal use the same half-open tie rule');
  assert.deepEqual(bytes(rasterizeMask(size, { kind: 'path', points: [...points, ...points] })), Array<number>(16).fill(0), 'twice around cancels under even-odd');
  for (const points of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]]) {
    assert.ok(rasterizeMask(size, { kind: 'path', points }).data.every(value => value === 0));
  }
});

test('Add is max, Remove is multiplicative, invert is exact, and all roles keep independent bytes', () => {
  const original = plane(4, 1, [0, 64, 128, 255]), brush = plane(4, 1, [255, 128, 128, 0]);
  const visibility = copyMask(original), removal = copyMask(original), scope = copyMask(original);
  assert.deepEqual(bytes(combineMasks(original, brush, 'add')), [255, 128, 128, 255]);
  assert.deepEqual(bytes(combineMasks(original, brush, 'remove')), [0, 32, 64, 255]);
  assert.deepEqual(bytes(combineMasks(original, brush, 'replace')), bytes(brush));
  assert.deepEqual(bytes(invertMask(original)), [255, 191, 127, 0]);
  assert.deepEqual(invertMask(invertMask(original)), original);
  for (const edited of [invertMask(original), featherMask(original, 0), combineMasks(original, brush, 'add'), materializeMask({ plane: original, owner: original.size, sampling: 'coverage' })]) edited.data.fill(23);
  for (const role of [original, visibility, removal, scope]) assert.deepEqual(bytes(role), [0, 64, 128, 255]);
  assert.deepEqual(bytes(invertMask(emptyMask(size))), Array<number>(16).fill(255));
  assert.throws(() => combineMasks(original, emptyMask(size), 'add'), /owner resolution/);
});

// Deliberately slow independent 2D oracle verifies separability, zero exterior and
// single final quantization, including fractional radii and a radius larger than the plane.
function featherOracle(input: Plane<'u8'>, radius: number): number[] {
  const reach = Math.ceil(radius), weights = Array.from({ length: reach * 2 + 1 }, (_, i) => Math.max(0, radius + 1 - Math.abs(i - reach)));
  const denominator = weights.reduce((a, b) => a + b, 0) ** 2;
  return [...input.data].map((_, index) => {
    const x = index % input.size.width, y = Math.floor(index / input.size.width);
    let sum = 0;
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && py >= 0 && px < input.size.width && py < input.size.height) {
        sum += (input.data[py * input.size.width + px] ?? 0) * (weights[dx + reach] ?? 0) * (weights[dy + reach] ?? 0);
      }
    }
    return Math.round(sum / denominator);
  });
}

test('feather matches an independent 2D triangular oracle and never clamps exterior coverage', () => {
  const input = plane(5, 3, [255, 1, 128, 0, 16, 83, 9, 252, 0, 100, 0, 0, 0, 255, 64]);
  for (const radius of [0, .25, .5, 1, 1.75, 2, 7, 64]) assert.deepEqual(bytes(featherMask(input, radius)), featherOracle(input, radius), `radius ${radius}`);
  assert.deepEqual(bytes(featherMask(plane(1, 1, [255]), 1)), [64]);
  assert.deepEqual(bytes(featherMask(plane(3, 3, Array<number>(9).fill(255)), 1)), [143, 191, 143, 191, 255, 191, 143, 191, 143]);
  assert.ok(featherMask(emptyMask(size), 64).data.every(value => value === 0));
  for (const radius of [-1, 65, NaN, Infinity]) assert.throws(() => featherMask(input, radius));
});

test('different plane resolutions span owner extent; owner exterior is always zero', () => {
  const input = plane(2, 1, [0, 255]), owner = { width: 4, height: 1 };
  assert.deepEqual(bytes(materializeMask({ plane: input, owner, sampling: 'coverage' })), [0, 64, 191, 255]);
  assert.deepEqual(bytes(materializeMask({ plane: plane(1, 1, [255]), owner: size, sampling: 'coverage' })), Array<number>(16).fill(255));
  for (const at of [{ x: -0.01, y: .5 }, { x: 4, y: .5 }, { x: 2, y: -1 }, { x: 2, y: 1 }]) {
    for (const sampling of ['coverage', 'legacy-threshold'] as const) assert.equal(sampleMask({ plane: input, owner, at, sampling }), 0);
  }
  assert.deepEqual(bytes(materializeMask({ plane: plane(4, 1, [0, 64, 128, 255]), owner: { width: 2, height: 1 }, sampling: 'coverage' })), [32, 192]);
});

test('legacy initialization materializes only effective visibility, preserving exact threshold and edge rules', () => {
  const input = plane(4, 1, [1, 127, 128, 255]);
  assert.deepEqual(bytes(materializeMask({ plane: input, owner: input.size, sampling: 'legacy-threshold' })), [0, 0, 85, 198]);
  const vertical = plane(7, 7, Array.from({ length: 49 }, (_, i) => i % 7 >= 3 ? 255 : 0));
  const visible = materializeMask({ plane: vertical, owner: vertical.size, sampling: 'legacy-threshold' });
  assert.deepEqual(bytes(visible).slice(21, 28), [0, 0, 0, 85, 198, 255, 255], 'inward kernel, not binary picking support');
  const lowResolution = plane(2, 1, [1, 255]);
  assert.deepEqual(bytes(materializeMask({ plane: lowResolution, owner: { width: 8, height: 1 }, sampling: 'legacy-threshold' })), [0, 0, 0, 0, 85, 198, 255, 255], 'kernel radius stays in source pixels');
  assert.deepEqual(bytes(materializeMask({ plane: plane(2, 1, [127, 128]), owner: { width: 1, height: 1 }, sampling: 'legacy-threshold' })), [85], 'renderer .5 threshold includes interpolated 127.5 before inward feather');
  assert.deepEqual(bytes(materializeMask({ plane: plane(1, 1, [128]), owner: { width: 1, height: 1 }, sampling: 'legacy-threshold' })), [255], 'legacy neighbor clamp preserves full owner-edge visibility');
  assert.ok(materializeMask({ plane: plane(1, 1, [127]), owner: size, sampling: 'legacy-threshold' }).data.every(value => value === 0));
  assert.throws(() => materializeMask({ plane: plane(2, 2, [255]), owner: size, sampling: 'coverage' }));
  assert.throws(() => rectangle({ width: 0, height: 1 }, 0, 0, 1, 1));
  assert.throws(() => rectangle(size, NaN, 0, 1, 1));
});

function rig() {
  let owner: SelectionOwner | null = { sceneGeneration: 1, editEpoch: 1, ownerGeneration: 1, size };
  const changes: SelectionChange[] = [];
  const controller = createSelection({ readOwner: () => owner,
    record(change) { changes.push(change); return { kind: 'applied' }; }, changed() {} },
  { source: size, viewport: { x: 10, y: 20, width: 400, height: 400 }, dpr: 2 });
  return { controller, changes, owner: () => owner,
    setOwner(value: SelectionOwner | null) { owner = value; } };
}
function start(controller: ReturnType<typeof createSelection>, input: SelectionGestureStart): symbol {
  const result = controller.begin(input); assert.ok(result.ok, result.ok ? '' : result.error); return result.value;
}
const shapeStart = { kind: 'shape', tool: 'rectangle', mode: 'replace', at: { x: 0, y: 0 }, space: photo, pointerId: 7 } satisfies SelectionGestureStart;

test('rectangle preview and feather slider derive from frozen baseline; one action per completed gesture', () => {
  const { controller: c, changes } = rig();
  c.initialize({ space: photo, plane: rectangle(size, 0, 0, 3, 3), sampling: 'coverage' });
  const baseline = c.snapshot(); assert.ok(baseline);
  const token = start(c, { ...shapeStart, mode: 'remove' });
  c.extend({ token, pointerId: 7, kind: 'shape', at: { x: 3, y: 3 } });
  assert.ok(c.preview()?.plane.data.every(value => value === 0));
  c.extend({ token, pointerId: 7, kind: 'shape', at: { x: 1, y: 1 } });
  assert.deepEqual(c.preview()?.plane, combineMasks(baseline.plane, rectangle(size, 0, 0, 1, 1), 'remove'));
  assert.deepEqual(c.snapshot(), baseline); assert.equal(changes.length, 1);
  assert.equal(c.end({ token, pointerId: 7 }).kind, 'applied'); assert.equal(changes.length, 2);
  const featherBase = c.snapshot(); assert.ok(featherBase);
  const feather = start(c, { kind: 'feather', space: photo, pointerId: 9 });
  for (const radius of [1, 2, 3, 1, .5]) {
    c.extend({ token: feather, pointerId: 9, kind: 'feather', radius });
    assert.deepEqual(c.preview()?.plane, featherMask(featherBase.plane, radius));
  }
  c.extend({ token: feather, pointerId: 9, kind: 'feather', radius: 0 });
  assert.equal(c.end({ token: feather, pointerId: 9 }).kind, 'unchanged'); assert.equal(changes.length, 2);
  c.restore(changes[1]?.before ?? null); assert.deepEqual(c.snapshot(), baseline); assert.equal(changes.length, 2, 'undo restore never records itself');
});

test('closed freehand, Add/Remove, clear, invert, no-op and cancellation are pointer-type agnostic', () => {
  const { controller: c, changes } = rig();
  const token = start(c, { ...shapeStart, tool: 'freehand' });
  for (const at of [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) c.extend({ token, pointerId: 7, kind: 'shape', at });
  assert.equal(c.end({ token, pointerId: 7 }).kind, 'applied');
  assert.deepEqual(c.snapshot()?.plane, rectangle(size, 0, 0, 1, 1));
  const add = start(c, { ...shapeStart, mode: 'add' });
  c.extend({ token: add, pointerId: 7, kind: 'shape', at: { x: 1, y: 1 } });
  assert.equal(c.end({ token: add, pointerId: 7 }).kind, 'unchanged');
  const cancelled = start(c, shapeStart);
  c.extend({ token: cancelled, pointerId: 7, kind: 'shape', at: { x: 4, y: 4 } });
  c.cancel(cancelled); assert.equal(c.end({ token: cancelled, pointerId: 7 }).kind, 'cancelled');
  assert.equal(changes.length, 1);
  assert.equal(c.invert().kind, 'applied'); assert.equal(c.clear().kind, 'applied');
  assert.equal(c.clear().kind, 'unchanged'); assert.equal(c.snapshot(), null);
  const empty = start(c, shapeStart);
  c.extend({ token: empty, pointerId: 7, kind: 'shape', at: { x: 0, y: 0 } });
  assert.equal(c.end({ token: empty, pointerId: 7 }).kind, 'unchanged'); assert.equal(changes.length, 3);
});

test('stale generations, epoch, owner deletion, resized source and every navigation change cancel a gesture', () => {
  for (const cause of ['scene', 'epoch', 'owner', 'delete', 'resize', 'pan', 'zoom', 'pinch', 'fit', 'layout']) {
    const r = rig(), c = r.controller;
    if (cause === 'fit') c.navigation.zoom({ zoom: 2, anchor: { kind: 'css', x: 210, y: 220 } });
    const token = start(c, shapeStart);
    c.extend({ token, pointerId: 7, kind: 'shape', at: { x: 2, y: 2 } });
    const owner = r.owner(); assert.ok(owner);
    switch (cause) {
      case 'scene': r.setOwner({ ...owner, sceneGeneration: 2 }); break;
      case 'epoch': r.setOwner({ ...owner, editEpoch: 2 }); break;
      case 'owner': r.setOwner({ ...owner, ownerGeneration: 2 }); break;
      case 'delete': r.setOwner(null); break;
      case 'resize': r.setOwner({ ...owner, size: { width: 8, height: 8 } }); break;
      case 'pan': c.navigation.pan({ x: 1, y: 2 }); break;
      case 'zoom': c.navigation.zoom({ zoom: 2, anchor: { kind: 'device', x: 200, y: 200 } }); break;
      case 'pinch': c.navigation.pinch({ factor: 2, from: { kind: 'css', x: 100, y: 100 }, to: { kind: 'css', x: 120, y: 130 } }); break;
      case 'fit': c.navigation.fit(); break;
      case 'layout': c.navigation.layout({ source: size, viewport: { x: 0, y: 0, width: 300, height: 600 }, dpr: 3 }); break;
    }
    assert.equal(c.end({ token, pointerId: 7 }).kind, 'cancelled', cause);
    assert.equal(c.preview(), null, cause); assert.equal(r.changes.length, 0, cause);
  }
});

test('wrong pointer, old token, invalid radius/point and foreign owner cannot publish; snapshots do not alias', () => {
  const { controller: c, changes } = rig();
  const input = rectangle(size, 1, 1, 1, 1);
  c.initialize({ space: photo, plane: input, sampling: 'coverage' }); input.data.fill(0);
  const saved = c.snapshot(); assert.ok(saved); saved.plane.data.fill(99);
  assert.deepEqual(c.snapshot()?.plane, rectangle(size, 1, 1, 1, 1));
  changes[0]?.after?.plane.data.fill(100);
  assert.deepEqual(c.snapshot()?.plane, rectangle(size, 1, 1, 1, 1));
  assert.equal(c.begin({ ...shapeStart, space: { kind: 'layer', id: OBJECT_IDS[0] } }).ok, false);
  const old = start(c, shapeStart), token = start(c, shapeStart);
  c.cancel(old);
  assert.equal(c.extend({ token: old, pointerId: 7, kind: 'shape', at: { x: 4, y: 4 } }).kind, 'cancelled');
  assert.equal(c.extend({ token, pointerId: 8, kind: 'shape', at: { x: 4, y: 4 } }).kind, 'cancelled');
  assert.equal(c.extend({ token, pointerId: 7, kind: 'shape', at: { x: NaN, y: 1 } }).kind, 'refused');
  assert.equal(c.extend({ token, pointerId: 7, kind: 'feather', radius: 1 }).kind, 'refused');
  assert.equal(c.end({ token, pointerId: 8 }).kind, 'cancelled');
  assert.equal(c.end({ token, pointerId: 7 }).kind, 'unchanged');
  assert.equal(changes.length, 1);
  const feather = start(c, { kind: 'feather', space: photo, pointerId: 7 });
  assert.equal(c.extend({ token: feather, pointerId: 7, kind: 'feather', radius: NaN }).kind, 'refused');
  assert.equal(c.end({ token: feather, pointerId: 7 }).kind, 'unchanged');
});
