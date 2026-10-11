import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginPaintStroke, evaluatePaintStroke, measurePaintPatch, measurePaintStroke, PAINT_LIMITS,
  snapshotPaintPatch, snapshotPaintRaster, type PaintCapture, type PaintDrawInput, type PaintEraseInput,
  type PaintPatch, type PaintTile } from '../src/core/paint.ts';
import type { Size } from '../src/core/raster.ts';

function capture(overrides: Partial<PaintCapture> = {}): PaintCapture {
  return { owner: 'paint-layer', sceneGeneration: 1, viewGeneration: 2, brushRevision: 'brush@1', functionRevision: 'texture@1',
    seed: 0, start: { x: 20, y: 20 }, attachment: { depthSample: { x: 20, y: 20 }, disparity: .25 },
    plane: { origin: { x: .5, y: .5 }, pixelScale: 1 }, ...overrides };
}
function input(overrides: Partial<PaintDrawInput> = {}): PaintDrawInput {
  return { kind: 'draw', id: 'new-patch', projectPatchCount: 0, size: { width: 512, height: 256 },
    brush: { operation: 'draw', color: { l: .5, c: 0, h: 0 }, diameter: 8, opacity: 1, pressure: 'off' },
    capture: capture(), ...overrides };
}
function stored(size: Size, tiles: readonly PaintTile[], metadata = capture(), id = 'stored'): PaintPatch {
  const built = snapshotPaintPatch({ id, size, capture: metadata, tiles, brush: input().brush });
  assert.ok(built.ok, built.ok ? '' : built.error);
  return built.value;
}
function erase(patches: readonly PaintPatch[], overrides: Partial<PaintEraseInput> = {}): PaintEraseInput {
  return { kind: 'erase', projectPatchCount: patches.length, capture: capture(),
    brush: { operation: 'erase', diameter: 8, opacity: .5, pressure: 'off' },
    targets: patches.map(patch => ({ patch, toPatch: { offset: { x: 0, y: 0 }, scale: 1 } })), ...overrides };
}
const fullTileBytes = 256 * 256 * 8;

test('paint budget: exact byte cap passes, one byte less refuses before reserving a tile', () => {
  const accepted = beginPaintStroke(input({ budget: { tiles: 1, bytes: fullTileBytes } }));
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.value.usage(), { dirtyTiles: 1, reservedBytes: fullTileBytes, coverageBytes: fullTileBytes / 2,
    candidateTileBytes: fullTileBytes / 2, peakReservedBytes: fullTileBytes, dabs: 1 });
  const completed = accepted.value.finish();
  assert.ok(completed.ok && completed.value);
  assert.equal(completed.value.memory.afterTileBytes, 256 * 256 * 4);
  assert.equal(accepted.value.usage().reservedBytes, 0);
  const refused = beginPaintStroke(input({ budget: { tiles: 1, bytes: fullTileBytes - 1 } }));
  assert.deepEqual(refused, { ok: false, error: 'The stroke exceeds the dirty byte limit; draw a smaller stroke.' });
});

test('paint budget: tile overflow cancels all earlier transient pixels and prevents late commit', () => {
  const data = new Uint8Array(256 * 256 * 4).fill(100);
  const raster = snapshotPaintRaster({ size: { width: 256, height: 256 }, data });
  const baseline = stored(input().size, [{ x: 0, y: 0, raster }, { x: 1, y: 0, raster }]);
  const begun = beginPaintStroke(erase([baseline], { budget: { tiles: 1, bytes: PAINT_LIMITS.bytes } }));
  assert.ok(begun.ok);
  const overflow = begun.value.extend([{ x: 300, y: 20 }]);
  assert.deepEqual(overflow, { ok: false, error: 'The stroke exceeds the dirty tile limit; draw a smaller stroke.' });
  assert.equal(begun.value.usage().dirtyTiles, 0);
  assert.equal(begun.value.usage().reservedBytes, 0);
  assert.equal(begun.value.usage().peakReservedBytes, fullTileBytes);
  assert.deepEqual(begun.value.finish(), overflow);
  assert.deepEqual(begun.value.extend([{ x: 30, y: 30 }]), overflow);
  assert.deepEqual(raster.copyBytes(), data);
});

test('paint budget: byte overflow on extension never exceeds the admitted high-water mark', () => {
  const begun = beginPaintStroke(input({ budget: { tiles: 2, bytes: fullTileBytes * 2 - 1 } }));
  assert.ok(begun.ok);
  const result = begun.value.extend([{ x: 300, y: 20 }]);
  assert.deepEqual(result, { ok: false, error: 'The stroke exceeds the dirty byte limit; draw a smaller stroke.' });
  assert.equal(begun.value.usage().peakReservedBytes, fullTileBytes);
  assert.equal(begun.value.usage().reservedBytes, 0);
  assert.equal(begun.value.finish().ok, false);
});

test('paint budget: clipped edge accounting separates dirty capacity from retained before/after assets', () => {
  const baseline = stored({ width: 259, height: 258 }, [{ x: 1, y: 1,
    raster: snapshotPaintRaster({ size: { width: 3, height: 2 }, data: new Uint8Array(24).fill(255) }) }]);
  const begun = beginPaintStroke(erase([baseline], { capture: capture({ start: { x: 258.5, y: 257.5 } }),
    brush: { operation: 'erase', diameter: 1, opacity: .5, pressure: 'off' },
    budget: { tiles: 1, bytes: 48 } }));
  assert.ok(begun.ok);
  assert.equal(begun.value.usage().reservedBytes, 48);
  const result = begun.value.finish();
  assert.ok(result.ok && result.value);
  assert.equal(result.value.memory.retainedTileBytes, 48);
  assert.equal(result.value.memory.beforeTileBytes, 24);
  assert.equal(result.value.memory.afterTileBytes, 24);
  assert.equal(result.value.memory.coverageBytes, 24);
  assert.equal(result.value.memory.candidateTileBytes, 24);
  assert.equal(begun.value.usage().reservedBytes, 0);
});

test('paint budget: cancel releases all transient storage and finish/late input produce no patch', () => {
  const begun = beginPaintStroke(input());
  assert.ok(begun.ok);
  assert.ok(begun.value.extend([{ x: 300, y: 20 }]).ok);
  assert.equal(begun.value.usage().dirtyTiles, 2);
  begun.value.cancel(); begun.value.cancel();
  assert.equal(begun.value.usage().dirtyTiles, 0);
  assert.equal(begun.value.usage().reservedBytes, 0);
  assert.deepEqual(begun.value.finish(), { ok: false, error: 'The stroke was cancelled.' });
  assert.deepEqual(begun.value.extend([]), { ok: false, error: 'The stroke was cancelled.' });
});

test('paint budget: zero caps admit no-op strokes but refuse any dirty allocation', () => {
  const budget = { tiles: 0, bytes: 0 };
  const transparent = beginPaintStroke(input({ budget, coverageSource: () => 0 }));
  assert.ok(transparent.ok);
  assert.deepEqual(transparent.value.finish(), { ok: true, value: null });
  const eraseEmpty = beginPaintStroke(erase([], { budget }));
  assert.ok(eraseEmpty.ok);
  assert.deepEqual(eraseEmpty.value.finish(), { ok: true, value: null });
  assert.equal(beginPaintStroke(input({ budget })).ok, false);
});

test('paint budget: hard caps cannot be raised, and invalid inputs fail before texture evaluation', () => {
  let calls = 0;
  const texture = () => { calls++; return 1; };
  const bad: Partial<PaintDrawInput>[] = [
    { budget: { tiles: 65, bytes: PAINT_LIMITS.bytes } }, { budget: { tiles: 64, bytes: PAINT_LIMITS.bytes + 1 } },
    { budget: { tiles: 1, bytes: -1 } }, { size: { width: 2049, height: 2 } }, { size: { width: 0, height: 2 } },
    { capture: capture({ start: { x: NaN, y: 1 } }) }, { capture: capture({ start: { x: Infinity, y: 1 } }) },
    { capture: capture({ attachment: { depthSample: { x: 1, y: 1 }, disparity: NaN } }) },
    { capture: capture({ attachment: { depthSample: { x: 1, y: 1 }, disparity: 2 } }) }, { capture: capture({ seed: 2 ** 32 }) },
    { projectPatchCount: 65 }, { capture: capture({ brushRevision: '' }) }, { capture: capture({ functionRevision: '' }) },
    { capture: capture({ plane: { origin: { x: 0, y: 0 }, pixelScale: 0 } }) },
  ];
  for (const overrides of bad) assert.equal(beginPaintStroke(input({ ...overrides, coverageSource: texture })).ok, false);
  assert.equal(calls, 0);
});

test('paint budget: invalid texture or sample cancels the whole candidate with a sentence', () => {
  for (const value of [NaN, Infinity, -1, 1.01]) {
    const begun = beginPaintStroke(input({ coverageSource: x => x < 40 ? 1 : value }));
    assert.ok(begun.ok);
    const result = begun.value.extend([{ x: 100, y: 20 }]);
    assert.deepEqual(result, { ok: false, error: 'The brush texture must return finite coverage between zero and one.' });
    assert.equal(begun.value.usage().reservedBytes, 0);
    assert.equal(begun.value.finish().ok, false);
  }
  const thrown = beginPaintStroke(input({ coverageSource: () => { throw new Error('bad adapter'); } }));
  assert.deepEqual(thrown, { ok: false, error: 'The brush texture failed; the stroke was cancelled.' });
  const begun = beginPaintStroke(input()); assert.ok(begun.ok);
  assert.equal(begun.value.extend([{ x: 30, y: 20 }, { x: NaN, y: 1 }]).ok, false);
  assert.equal(begun.value.usage().reservedBytes, 0);
  assert.equal(begun.value.finish().ok, false);
});

test('paint budget: huge finite paths refuse work before an unbounded resampling loop', () => {
  const begun = beginPaintStroke(input()); assert.ok(begun.ok);
  assert.deepEqual(begun.value.extend([{ x: 1e300, y: 1e300 }]),
    { ok: false, error: 'The stroke exceeds the dab limit; draw a shorter stroke.' });
  assert.equal(begun.value.usage().dabs, 1);
  assert.equal(begun.value.usage().reservedBytes, 0);
});

test('paint budget: the real 16 MiB default admits 32 full dirty tiles and refuses tile 33', () => {
  const begun = beginPaintStroke(input({ size: { width: 2048, height: 2048 }, capture: capture({ start: { x: 128.5, y: 128.5 } }),
    brush: { operation: 'draw', color: { l: .5, c: 0, h: 0 }, diameter: 1, opacity: 1, pressure: 'off' } }));
  assert.ok(begun.ok);
  assert.ok(begun.value.extend([{ x: 1920.5, y: 128.5 }, { x: 1920.5, y: 384.5 },
    { x: 128.5, y: 384.5 }, { x: 128.5, y: 640.5 }, { x: 1920.5, y: 640.5 },
    { x: 1920.5, y: 896.5 }, { x: 128.5, y: 896.5 }]).ok);
  assert.equal(begun.value.usage().dirtyTiles, 32);
  assert.equal(begun.value.usage().reservedBytes, 32 * fullTileBytes);
  const result = begun.value.extend([{ x: 128.5, y: 1152.5 }]);
  assert.deepEqual(result, { ok: false, error: 'The stroke exceeds the dirty byte limit; draw a smaller stroke.' });
  assert.equal(begun.value.usage().peakReservedBytes, 16_777_216);
  assert.equal(begun.value.finish().ok, false);
});

test('paint budget: malformed, duplicate and unclipped hydrated patch tiles are refused', () => {
  const raster = snapshotPaintRaster({ size: { width: 256, height: 256 }, data: new Uint8Array(256 * 256 * 4) });
  for (const tiles of [[{ x: 2, y: 0, raster }], [{ x: 0, y: 0, raster }, { x: 0, y: 0, raster }],
    [{ x: .5, y: 0, raster }]]) assert.equal(snapshotPaintPatch({ id: 'bad', size: input().size, brush: input().brush, capture: capture(), tiles }).ok, false);
  assert.equal(snapshotPaintPatch({ id: 'bad', size: { width: 259, height: 256 }, brush: input().brush, capture: capture(), tiles: [{ x: 1, y: 0, raster }] }).ok, false);
  assert.throws(() => snapshotPaintRaster({ size: { width: 2, height: 2 }, data: new Uint8Array(15) }));
  assert.throws(() => snapshotPaintRaster({ size: { width: 257, height: 2 }, data: new Uint8Array(2056) }));
});

test('paint budget: draw refuses at 64 project patches before evaluating texture; erasure at 64 stays allowed', () => {
  let calls = 0;
  assert.deepEqual(beginPaintStroke(input({ projectPatchCount: 64, coverageSource: () => { calls++; return 1; } })),
    { ok: false, error: 'The project already has 64 paint patches; erase or remove a patch before drawing.' });
  assert.equal(calls, 0);
  const size = { width: 2, height: 2 }, raster = snapshotPaintRaster({ size, data: new Uint8Array(16).fill(255) });
  const patches = Array.from({ length: 64 }, (_, i) => stored(size, [{ x: 0, y: 0, raster }],
    capture({ attachment: { depthSample: { x: 1, y: 1 }, disparity: i / 64 } }), `patch-${i}`));
  const erased = evaluatePaintStroke(erase(patches, { capture: capture({ start: { x: 1, y: 1 } }) }), []);
  assert.ok(erased.ok && erased.value);
  assert.equal(erased.value.changes.length, 64);
  assert.equal(erased.value.memory.peakDirtyBytes, 2048);
  assert.equal(erased.value.memory.beforeSparseGpuBytes, 1024);
  assert.equal(erased.value.memory.afterSparseGpuBytes, 1024);
  assert.equal(erased.value.memory.beforeCroppedGpuBytes, 1024);
  assert.equal(erased.value.memory.afterCroppedGpuBytes, 1024);
  assert.equal(erased.value.memory.retainedTileBytes, 1040, 'one shared before raster plus 64 independent after rasters');
  for (const change of erased.value.changes) {
    assert.ok(change.before && change.after);
    assert.equal(change.after.capture, change.before.capture);
    assert.equal(change.before.tiles[0]?.raster.byteAt(3), 255);
    assert.equal(change.after.tiles[0]?.raster.byteAt(3), 128);
  }
  const sixtyFourth = evaluatePaintStroke(input({ projectPatchCount: 63 }), []);
  assert.ok(sixtyFourth.ok && sixtyFourth.value);
});

test('paint budget: multi-patch erasure shares one dirty cap and preserves all old patches on refusal', () => {
  const size = { width: 256, height: 256 }, raster = snapshotPaintRaster({ size, data: new Uint8Array(256 * 256 * 4).fill(255) });
  const patches = ['a', 'b'].map(id => stored(size, [{ x: 0, y: 0, raster }], capture(), id));
  const overflow = beginPaintStroke(erase(patches, { budget: { tiles: 2, bytes: fullTileBytes } }));
  assert.deepEqual(overflow, { ok: false, error: 'The stroke exceeds the dirty byte limit; draw a smaller stroke.' });
  for (const patch of patches) assert.equal(patch.tiles[0]?.raster.byteAt(3), 255);
  assert.equal(beginPaintStroke(erase(patches, { budget: { tiles: 1, bytes: PAINT_LIMITS.bytes } })).ok, false);
});

test('paint budget: active owner, unique erase IDs, and an empty new-draw baseline are enforced', () => {
  const size = { width: 2, height: 2 }, raster = snapshotPaintRaster({ size, data: new Uint8Array(16).fill(255) });
  const foreign = stored(size, [{ x: 0, y: 0, raster }], capture({ owner: 'another-layer' }));
  assert.deepEqual(beginPaintStroke(erase([foreign])), { ok: false, error: 'Erasure targets must belong to the active paint layer.' });
  const patch = stored(size, [{ x: 0, y: 0, raster }]);
  assert.equal(beginPaintStroke(erase([patch, patch])).ok, false);
  const legacyBaseline = { ...input(), tiles: patch.tiles };
  assert.equal(beginPaintStroke(legacyBaseline).ok, false, 'legacy draw baseline is rejected, not silently flattened');
});

test('paint budget: sparse/cropped estimates use actual alpha bounds and account for exact changed refs', () => {
  const draw = evaluatePaintStroke(input({ size: { width: 512, height: 2 }, capture: capture({ start: { x: .5, y: .5 } }),
    brush: { ...input().brush, diameter: 1 } }), []);
  assert.ok(draw.ok && draw.value);
  const patch = draw.value.changes[0]?.after; assert.ok(patch);
  assert.deepEqual(measurePaintPatch(patch), { tileBytes: 2048, bounds: { x: 0, y: 0, width: 1, height: 1 },
    sparseGpuBytes: 2048, croppedGpuBytes: 4 });
  assert.deepEqual(patch.memory, measurePaintPatch(patch));
  assert.equal(draw.value.memory.peakDirtyBytes, 4096);
  assert.equal(draw.value.memory.beforeTileBytes, 0);
  assert.equal(draw.value.memory.afterTileBytes, 2048);
  assert.equal(draw.value.memory.afterCroppedGpuBytes, 4);
  assert.deepEqual(draw.value.memory, measurePaintStroke({ changes: draw.value.changes, peakDirtyBytes: 4096 }));
  const spaced = evaluatePaintStroke(input({ size: { width: 2048, height: 1 }, capture: capture({ start: { x: .5, y: .5 } }),
    brush: { ...input().brush, diameter: 1 } }), [[{ x: 2047.5, y: .5 }]]);
  assert.ok(spaced.ok && spaced.value);
  const wide = spaced.value.changes[0]?.after; assert.ok(wide);
  assert.equal(wide.memory.sparseGpuBytes, 8192);
  assert.equal(wide.memory.croppedGpuBytes, 8192);
});

test('paint budget: sparse upload avoids a full-master allocation for distant marks and erasure shrinks the crop', () => {
  const size = { width: 256, height: 256 }, first = new Uint8Array(256 * 256 * 4), last = first.slice();
  first.set([255, 0, 0, 255], 0); last.set([255, 0, 0, 255], last.length - 4);
  const patch = stored({ width: 2048, height: 2048 }, [
    { x: 0, y: 0, raster: snapshotPaintRaster({ size, data: first }) },
    { x: 7, y: 7, raster: snapshotPaintRaster({ size, data: last }) },
  ]);
  assert.equal(patch.memory.sparseGpuBytes, 524288);
  assert.equal(patch.memory.croppedGpuBytes, 16777216);
  const erased = evaluatePaintStroke(erase([patch], { capture: capture({ start: { x: .5, y: .5 } }),
    brush: { operation: 'erase', diameter: 1, opacity: 1, pressure: 'off' } }), []);
  assert.ok(erased.ok && erased.value);
  const changed = erased.value.changes[0]; assert.ok(changed?.after);
  assert.equal(changed.tiles[0]?.after, null);
  assert.equal(changed.after.tiles[0]?.raster, patch.tiles[1]?.raster);
  assert.deepEqual(changed.after.memory.bounds, { x: 2047, y: 2047, width: 1, height: 1 });
  assert.equal(changed.after.memory.sparseGpuBytes, 262144);
  assert.equal(changed.after.memory.croppedGpuBytes, 4);
  assert.equal(erased.value.memory.afterTileBytes, 0);
});
