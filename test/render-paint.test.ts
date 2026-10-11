import assert from 'node:assert/strict';
import test from 'node:test';
import { admitPaintResources, paintResources, validatePaintPlanes, paintTileUpload, PAINT_UPLOAD_SIDE,
  PAINT_UPLOAD_BYTES, PAINT_GPU_BYTE_LIMIT, samePaintPixels, type PaintPlane } from '../src/render/paint.ts';

function plane(patch: Partial<PaintPlane> = {}): PaintPlane {
  return { id: 'one', disparity: .5, bounds: { x: 0, y: 0, width: 256, height: 256 },
    tiles: [{ x: 0, y: 0, width: 256, height: 256, rgba: new Uint8Array(256 * 256 * 4) }], visible: true, opacity: 1, order: 1, ...patch };
}
const size = { width: 2048, height: 2048 };
test('paint order is depth then unique entry order, independent of caller array order', () => {
  const input = [plane({ id: 'front', disparity: .75, order: 0 }), plane({ id: 'later', order: 3 }), plane({ id: 'earlier', order: 2 })];
  assert.deepEqual(validatePaintPlanes(input, size).map(value => value.id), ['earlier', 'later', 'front']);
  assert.equal(input[0]?.id, 'front');
  assert.throws(() => validatePaintPlanes([plane(), plane({ id: 'duplicate-order' })], size), /unique/);
  assert.throws(() => validatePaintPlanes([plane({ disparity: NaN })], size));
});
test('tile admission rejects duplicate, truncated, off-grid and out-of-image data', () => {
  const original = plane(), tile = original.tiles[0]; assert.ok(tile);
  for (const tiles of [[tile, tile], [{ ...tile, rgba: new Uint8Array(4) }], [{ ...tile, x: 1 }], [{ ...tile, width: 255 }]]) {
    assert.throws(() => validatePaintPlanes([{ ...original, tiles }], size), /tiles/);
  }
  assert.throws(() => validatePaintPlanes([plane({ bounds: { x: 2000, y: 0, width: 256, height: 256 } })], size), /bounds/);
  assert.throws(() => validatePaintPlanes(Array.from({ length: 65 }, (_, order) => plane({ id: String(order), order })), size));
});
test('gutter comes from adjacent tiles, with transparent missing neighbors and exact clipped row strides', () => {
  const left = { x: 0, y: 0, width: 256, height: 2, rgba: new Uint8Array(256 * 2 * 4).fill(23) };
  const right = { x: 1, y: 0, width: 2, height: 2, rgba: new Uint8Array(2 * 2 * 4).fill(181) };
  const input = plane({ bounds: { x: 10, y: 0, width: 258, height: 2 }, tiles: [left, right] });
  validatePaintPlanes([input], size);
  const upload = paintTileUpload(input, left);
  const pixel = (x: number, y: number) => Array.from(upload.subarray((y * PAINT_UPLOAD_SIDE + x) * 4, (y * PAINT_UPLOAD_SIDE + x) * 4 + 4));
  assert.deepEqual(pixel(257, 1), [181, 181, 181, 181]);
  assert.deepEqual(pixel(256, 2), [23, 23, 23, 23]);
  assert.deepEqual(pixel(0, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(1, 3), [0, 0, 0, 0]);
});
test('aggregate cap includes targets, reserved math, scratch and old/new upload overlap at 64 patches', () => {
  const usage = paintResources(size, 64, 256);
  assert.equal(usage.targetBytes, 2048 * 2048 * 22);
  assert.equal(usage.accountedBytes, 2048 * 2048 * 30 + 257 * PAINT_UPLOAD_BYTES + 44);
  assert.equal(admitPaintResources(usage, 0).kind, 'accepted');
  assert.equal(admitPaintResources(usage, usage.tileBytes).kind, 'refused');
  const boundary = PAINT_GPU_BYTE_LIMIT - usage.accountedBytes;
  assert.equal(admitPaintResources(usage, boundary).kind, 'accepted');
  assert.equal(admitPaintResources(usage, boundary + 1).kind, 'refused');
  assert.equal(paintResources(size, 0, 0).accountedBytes, 0);
  const prepared = paintResources(size, 0, 0, true);
  assert.equal(prepared.planes, 0);
  assert.equal(prepared.targets, 4);
  assert.equal(prepared.programs, 7);
  assert.equal(prepared.accountedBytes, 2048 * 2048 * 30 + PAINT_UPLOAD_BYTES + 44);
});

test('display metadata reuses storage; raster or sparse-neighborhood changes invalidate it', () => {
  const first = plane(), tile = first.tiles[0]; assert.ok(tile);
  assert.ok(samePaintPixels(first, { ...first, opacity: .1, visible: false, order: 22 }));
  assert.ok(!samePaintPixels(first, { ...first, tiles: [{ ...tile, rgba: tile.rgba.slice() }] }));
  assert.ok(!samePaintPixels(first, { ...first, tiles: [] }));
});

test('the decoded active raster budget is checked independently of GPU replacement peak', () => {
  const rgba = new Uint8Array(256 * 256 * 4);
  const planes = Array.from({ length: 64 }, (_, order) => plane({ id: String(order), order,
    bounds: { x: 0, y: 0, width: 1280, height: 256 },
    tiles: Array.from({ length: 5 }, (_, x) => ({ x, y: 0, width: 256, height: 256, rgba })) }));
  assert.throws(() => validatePaintPlanes(planes, size), /64 MiB active raster budget/);
});
