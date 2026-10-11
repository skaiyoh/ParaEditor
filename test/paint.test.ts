import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRaster, encodeRaster } from '../src/core/asset-codec.ts';
import { linearToSrgb, srgbToLinear, srgbToOklch } from '../src/core/color.ts';
import { beginPaintStroke, evaluatePaintCoverage, evaluatePaintStroke, snapshotPaintPatch, snapshotPaintRaster,
  type PaintCapture, type PaintDrawBrush, type PaintDrawInput, type PaintEraseInput, type PaintPatch,
  type PaintStrokeInput, type PaintStrokeResult, type StrokeSample } from '../src/core/paint.ts';

const brush: PaintDrawBrush = { operation: 'draw', color: srgbToOklch({ r: 1, g: 0, b: 0 }),
  diameter: 8, opacity: .5, pressure: 'off' };
function capture(overrides: Partial<PaintCapture> = {}): PaintCapture {
  return { owner: 'paint-layer', sceneGeneration: 4, viewGeneration: 2, brushRevision: 'brush@2',
    functionRevision: 'texture@3', seed: 7, start: { x: 8.5, y: 8.5 },
    attachment: { depthSample: { x: 80, y: 100 }, disparity: .4 },
    plane: { origin: { x: .5, y: .5 }, pixelScale: 1 }, ...overrides };
}
function input(overrides: Partial<PaintDrawInput> = {}): PaintDrawInput {
  return { kind: 'draw', id: 'stroke-1', size: { width: 48, height: 48 }, brush,
    capture: capture(), projectPatchCount: 0, ...overrides };
}
function result(options: PaintStrokeInput, batches: readonly (readonly StrokeSample[])[] = []): PaintStrokeResult | null {
  const result = evaluatePaintStroke(options, batches);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}
function stroke(options: PaintDrawInput, batches: readonly (readonly StrokeSample[])[] = []): PaintPatch | null {
  return result(options, batches)?.changes[0]?.after ?? null;
}
function eraser(patches: readonly PaintPatch[], overrides: Partial<PaintEraseInput> = {}): PaintEraseInput {
  return { kind: 'erase', capture: capture(), projectPatchCount: patches.length,
    brush: { operation: 'erase', diameter: 8, opacity: .5, pressure: 'off' },
    targets: patches.map(patch => ({ patch, toPatch: { offset: { x: 0, y: 0 }, scale: 1 } })), ...overrides };
}
function bytes(patch: PaintPatch | null): unknown {
  return patch?.tiles.map(tile => ({ x: tile.x, y: tile.y, size: tile.raster.size, data: tile.raster.copyBytes() })) ?? [];
}
function pixel(patch: PaintPatch | null, x: number, y: number): number[] {
  const tile = patch?.tiles.find(tile => tile.x === Math.floor(x / 256) && tile.y === Math.floor(y / 256));
  assert.ok(tile?.raster);
  const offset = ((y % 256) * tile.raster.size.width + x % 256) * 4;
  return Array.from({ length: 4 }, (_, i) => tile.raster.byteAt(offset + i));
}

test('paint: every batching of a textured pressure path has identical bytes and captured metadata', () => {
  const path = [{ x: 8.5, y: 8.5, pressure: .1 }, { x: 10.2, y: 9.3, pressure: .8 },
    { x: 10.2, y: 9.3, pressure: .8 }, { x: 18.8, y: 11.9 }, { x: 25.3, y: 30.8, pressure: 1 },
    { x: 9.2, y: 28.6, pressure: .2 }, { x: 5.1, y: 7.3, pressure: .7 }];
  const options = input({ brush: { ...brush, pressure: 'size' },
    coverageSource: (x, y, seed) => ((Math.imul(Math.floor(x), 31) ^ Math.imul(Math.floor(y), 17) ^ seed) >>> 0) % 256 / 255 });
  const reference = stroke(options, [path]);
  for (let partition = 0; partition < 2 ** (path.length - 1); partition++) {
    const batches: StrokeSample[][] = [[]];
    path.forEach((sample, i) => {
      batches.at(-1)?.push(sample);
      if ((partition & (1 << i)) !== 0) batches.push([]);
    });
    batches.splice(1, 0, []);
    const actual = stroke(options, batches);
    assert.deepEqual(bytes(actual), bytes(reference), `partition ${partition}`);
    assert.deepEqual(actual?.capture, reference?.capture);
  }
});

test('paint: residual distance survives short batches; neither batches nor pause insert dabs', () => {
  const options = input({ brush: { ...brush, diameter: 8 } });
  const begun = beginPaintStroke(options);
  assert.ok(begun.ok);
  assert.equal(begun.value.usage().dabs, 1);
  for (const x of [8.75, 9, 9.5, 10]) assert.ok(begun.value.extend([{ x, y: 8.5 }]).ok);
  assert.equal(begun.value.usage().dabs, 1);
  assert.ok(begun.value.extend([]).ok);
  assert.ok(begun.value.extend([{ x: 10.5, y: 8.5 }]).ok);
  assert.equal(begun.value.usage().dabs, 2);
  assert.ok(begun.value.extend([{ x: 12.25, y: 8.5 }]).ok);
  assert.equal(begun.value.usage().dabs, 2);
  const done = begun.value.finish();
  assert.ok(done.ok);
  assert.deepEqual(bytes(done.value?.changes[0]?.after ?? null), bytes(stroke(options, [[{ x: 12.25, y: 8.5 }]])));
  assert.equal(begun.value.usage().dabs, 3, 'release includes off-grid final endpoint');
});

test('paint: a tap has a round, one-pixel antialiased edge and applies opacity once', () => {
  const begun = beginPaintStroke(input()); assert.ok(begun.ok);
  assert.ok(begun.value.finish().ok);
  assert.equal(begun.value.usage().dabs, 1, 'a tap emits exactly one dab');
  const tap = stroke(input());
  assert.deepEqual(pixel(tap, 8, 8), [255, 0, 0, 128]);
  assert.equal(pixel(tap, 12, 8)[3], 64, 'half-covered edge at radius 4');
  assert.equal(pixel(tap, 13, 8)[3], 0);
  assert.equal(pixel(tap, 12, 12)[3], 0, 'round tip excludes box corners');
  const repeat = Array.from({ length: 100 }, () => ({ x: 8.5, y: 8.5 }));
  assert.deepEqual(bytes(stroke(input(), [repeat])), bytes(tap));
});

test('paint: retracing a path uses max coverage, while separate strokes accumulate', () => {
  const end = { x: 24.5, y: 8.5 }, start = { x: 8.5, y: 8.5 };
  const once = stroke(input(), [[end]]);
  const retraced = stroke(input(), [[end], [start], [end]]);
  assert.deepEqual(bytes(retraced), bytes(once));
  const twice = stroke(input({ id: 'stroke-2', projectPatchCount: 1,
    capture: capture({ attachment: { depthSample: { x: 80, y: 100 }, disparity: .8 } }) }), [[end]]);
  assert.equal(pixel(twice, 16, 8)[3], 128, 'a separate patch starts empty');
  assert.equal(pixel(once, 16, 8)[3], 128);
  assert.equal(Math.round((128 / 255 + 128 / 255 * (1 - 128 / 255)) * 255), 192, 'the compositor accumulates separate patches');
  assert.equal(once?.capture.attachment.disparity, .4);
  assert.equal(twice?.capture.attachment.disparity, .8);
});

test('paint: a pause between grid dabs cannot add coverage, but stationary pressure changes still draw', () => {
  const path = [{ x: 9.5, y: 8.5 }, { x: 12.5, y: 8.5 }];
  const paused = [{ x: 9.5, y: 8.5 }, { x: 9.5, y: 8.5 }, { x: 12.5, y: 8.5 }];
  const moving = stroke(input(), [path]), repeated = stroke(input(), [paused]);
  assert.deepEqual(bytes(repeated), bytes(moving));
  assert.equal(pixel(repeated, 9, 4)[3], 48);
  const pressure = input({ brush: { ...brush, pressure: 'size', diameter: 20 },
    capture: capture({ start: { x: 24.5, y: 24.5, pressure: 0 } }) });
  const expanded = stroke(pressure, [[{ x: 24.5, y: 24.5, pressure: 1 }]]);
  assert.deepEqual(bytes(expanded), bytes(stroke({ ...pressure, capture: capture({ start: { x: 24.5, y: 24.5, pressure: 1 } }) })));
});

test('paint: pressure changes size only, clamps reports, and absent/null/disabled pressure use full size', () => {
  const sizeBrush: PaintDrawBrush = { ...brush, diameter: 20, pressure: 'size' };
  const at = (pressure: number | null | undefined) => input({ brush: sizeBrush,
    capture: capture({ start: pressure === undefined ? { x: 24.5, y: 24.5 } : { x: 24.5, y: 24.5, pressure } }) });
  const full = stroke(at(1)), low = stroke(at(0));
  for (const pressure of [null, undefined, 2]) assert.deepEqual(bytes(stroke(at(pressure))), bytes(full));
  assert.deepEqual(bytes(stroke(at(-5))), bytes(low));
  assert.equal(pixel(low, 24, 24)[3], pixel(full, 24, 24)[3]);
  assert.equal(pixel(low, 26, 24)[3], 0);
  assert.equal(pixel(full, 26, 24)[3], 128);
  assert.deepEqual(bytes(stroke(input({ ...at(0), brush: { ...sizeBrush, pressure: 'off' } }))), bytes(full));
});

test('paint: shrinking pressure maintains spacing no larger than a quarter of the smallest tip', () => {
  const begun = beginPaintStroke(input({ brush: { ...brush, diameter: 20, pressure: 'size' },
    capture: capture({ start: { x: 8.5, y: 8.5, pressure: 1 } }) }));
  assert.ok(begun.ok);
  assert.ok(begun.value.extend([{ x: 18.5, y: 8.5, pressure: 0 }]).ok);
  assert.equal(begun.value.usage().dabs, 21, '0.5-pixel spacing through the pressure transition');
  const done = begun.value.finish();
  assert.ok(done.ok);
  for (let x = 8; x <= 18; x++) assert.equal(pixel(done.value?.changes[0]?.after ?? null, x, 8)[3], 128);
});

test('paint: texture is anchored at plane pixel centers and seed, never dab-relative', () => {
  const options = input({ size: { width: 260, height: 4 }, capture: capture({ start: { x: 254.5, y: 1.5 }, seed: 13 }),
    brush: { ...brush, opacity: 1 }, coverageSource: (x, y, seed) => {
      assert.equal(seed, 13); assert.equal(x % 1, .5); assert.equal(y % 1, .5);
      return Math.floor(x) % 2 === 0 ? .25 : 0;
    } });
  const patch = stroke(options, [[{ x: 259.5, y: 1.5 }], [{ x: 254.5, y: 1.5 }]]);
  for (const x of [254, 256, 258]) assert.equal(pixel(patch, x, 1)[3], 64);
  for (const x of [255, 257, 259]) assert.equal(pixel(patch, x, 1)[3], 0);
});

test('paint: sparse tiles are row-major and right/bottom edges use exact clipped dimensions', () => {
  const patch = stroke(input({ size: { width: 259, height: 258 }, capture: capture({ start: { x: 256, y: 256 } }) }));
  assert.ok(patch);
  assert.deepEqual(patch.tiles.map(tile => [tile.x, tile.y, tile.raster.size.width, tile.raster.size.height]),
    [[0, 0, 256, 256], [1, 0, 3, 256], [0, 1, 256, 2], [1, 1, 3, 2]]);
  for (const tile of patch.tiles) assert.equal(tile.raster.byteLength, tile.raster.size.width * tile.raster.size.height * 4);
  const outside = stroke(input({ capture: capture({ start: { x: -100, y: -100 } }) }));
  assert.equal(outside, null);
  const crossing = stroke(input({ size: { width: 8, height: 8 }, capture: capture({ start: { x: -5, y: 3.5 } }) }), [[{ x: 12, y: 3.5 }]]);
  for (let x = 0; x < 8; x++) assert.equal(pixel(crossing, x, 3)[3], 128);
});

test('paint: tiles store straight sRGB; only the compositor samples in linear premultiplied light', () => {
  const red = stroke(input({ brush: { ...brush, opacity: 1 } }));
  const blue = stroke(input({ id: 'blue', projectPatchCount: 1, brush: { ...brush, color: srgbToOklch({ r: 0, g: 0, b: 1 }) } }));
  assert.deepEqual(pixel(blue, 8, 8), [0, 0, 255, 128]);
  const back = pixel(red, 8, 8), front = pixel(blue, 8, 8), a = (front[3] ?? 0) / 255;
  const composed = [0, 1, 2].map(c => Math.round(linearToSrgb(srgbToLinear((front[c] ?? 0) / 255) * a +
    srgbToLinear((back[c] ?? 0) / 255) * (1 - a)) * 255));
  assert.deepEqual(composed, [187, 0, 188], 'reference compositor converts encoded RGB before premultiplication/blending');
  const after = blue?.tiles[0]?.raster;
  assert.ok(after);
  const encoded = encodeRaster({ format: after.format, size: after.size, data: after.copyBytes() });
  const decoded = decodeRaster(encoded, after);
  assert.deepEqual(decoded.data, after.copyBytes());
});

test('paint: erasure uses the pre-stroke alpha, preserves straight RGB, and drops empty tiles', () => {
  const base = stroke(input({ size: { width: 2, height: 2 }, capture: capture({ start: { x: 1, y: 1 } }), brush: { ...brush, opacity: 1 } }));
  assert.ok(base);
  const options = eraser([base], { capture: capture({ start: { x: 1, y: 1 } }) });
  const erasedResult = result(options, [[{ x: 1, y: 1 }, { x: 1, y: 1 }]]);
  const erased = erasedResult?.changes[0]?.after ?? null;
  assert.deepEqual(pixel(erased, 0, 0), [255, 0, 0, 128]);
  assert.deepEqual(bytes(erased), bytes(result(options)?.changes[0]?.after ?? null));
  const cleared = result({ ...options, brush: { ...options.brush, opacity: 1 } });
  assert.ok(cleared);
  assert.equal(cleared.changes.length, 1);
  assert.equal(cleared.changes[0]?.after, null);
  assert.equal(cleared.changes[0]?.tiles[0]?.after, null);
  assert.deepEqual(cleared.changes[0]?.tiles[0]?.before?.copyBytes(), base.tiles[0]?.raster.copyBytes());
  assert.equal(result({ ...options, targets: [] }), null);
});

test('paint: inputs, exact before bytes, patch data and returned copies cannot mutate committed pixels', () => {
  const data = Uint8Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? 255 : 40);
  const original = data.slice(), raster = snapshotPaintRaster({ size: { width: 2, height: 2 }, data });
  data.fill(0);
  const attachment = { depthSample: { x: 120, y: 80 }, disparity: .7 };
  const start = { x: 1, y: 1, pressure: .3 }, mutableBrush = { ...brush, color: { ...brush.color } };
  const tiles = [{ x: 0, y: 0, raster }];
  const metadata = capture({ attachment, start });
  const hydrated = snapshotPaintPatch({ id: 'hydrated', size: { width: 2, height: 2 }, tiles, capture: metadata, brush: mutableBrush });
  assert.ok(hydrated.ok);
  const begun = beginPaintStroke(eraser([hydrated.value], { capture: metadata }));
  assert.ok(begun.ok);
  start.x = 42; attachment.disparity = .1; attachment.depthSample.x = 42;
  mutableBrush.opacity = 0; mutableBrush.color.l = 0; tiles.length = 0;
  const done = begun.value.finish();
  assert.ok(done.ok && done.value);
  const change = done.value.changes[0]; assert.ok(change?.after);
  const patch = change.after, tile = change.tiles[0];
  assert.ok(tile?.after);
  const after = tile.after;
  assert.deepEqual(patch.capture.start, { x: 1, y: 1, pressure: .3 });
  assert.deepEqual(patch.capture.attachment, { depthSample: { x: 120, y: 80 }, disparity: .7 });
  assert.equal(patch.brush.opacity, .5);
  assert.equal(tile.before, raster, 'immutable before allocation is shared');
  assert.deepEqual(tile.before.copyBytes(), original);
  const output = tile.after.copyBytes(), retained = output.slice(); output.fill(0);
  assert.deepEqual(tile.after.copyBytes(), retained);
  for (const value of [patch, patch.capture, patch.capture.start, patch.size, patch.capture.attachment, patch.capture.attachment.depthSample,
    patch.brush, patch.tiles, tile, tile.size, tile.before, tile.after, tile.after.size]) assert.ok(Object.isFrozen(value));
  assert.throws(() => Object.assign(after, { byteLength: 0 }), TypeError);
  assert.throws(() => Object.assign(patch.capture.start, { x: 0 }), TypeError);
  assert.equal(begun.value.finish().ok, false, 'completion cannot be committed twice');
  begun.value.cancel();
  assert.deepEqual(tile.after.copyBytes(), retained);
});

test('paint: no-op opacity and transparent texture return no patch', () => {
  assert.equal(stroke(input({ brush: { ...brush, opacity: 0 } })), null);
  assert.equal(stroke(input({ coverageSource: () => 0 })), null);
});

test('paint: scalar CPU evaluator and rasterizer multiply texture, tip and opacity exactly once', () => {
  const scalar = evaluatePaintCoverage({ source: () => .5, at: { x: 12.5, y: 8.5 }, seed: 7, roundTip: .5, opacity: .5 });
  assert.deepEqual(scalar, { ok: true, value: .125 });
  const patch = stroke(input({ coverageSource: () => .5 }));
  assert.deepEqual(pixel(patch, 12, 8), [255, 0, 0, 32], 'RGB is straight ink and alpha includes all coverage exactly once');
  assert.equal(evaluatePaintCoverage({ source: () => 1.01, at: { x: 0, y: 0 }, seed: 0, roundTip: 1, opacity: 1 }).ok, false);
});

test('paint: first-texel-center origin and scale match MRX1 coordinates across translated tile seams', () => {
  const observed = new Set<string>();
  const patch = stroke(input({ size: { width: 260, height: 2 }, brush: { ...brush, opacity: 1 },
    capture: capture({ start: { x: .5, y: .5 }, plane: { origin: { x: 17, y: -3 }, pixelScale: 2 } }),
    coverageSource: (x, y) => { observed.add(`${x},${y}`); return 1; } }), [[{ x: 256.5, y: .5 }]]);
  assert.ok(patch);
  assert.ok(observed.has('17,-3'), 'pixel 0 center is origin');
  assert.ok(observed.has('529,-3'), 'pixel 256 shares the global plane origin');
  assert.deepEqual(patch.capture.plane, { origin: { x: 17, y: -3 }, pixelScale: 2 });
});

test('paint: one erase result preserves every affected patch depth and provenance, plus untouched tile sharing', () => {
  const first = stroke(input({ id: 'near', size: { width: 512, height: 48 }, brush: { ...brush, opacity: 1 } }), [[{ x: 300.5, y: 8.5 }]]);
  const second = stroke(input({ id: 'far', size: { width: 512, height: 48 }, brush: { ...brush, opacity: 1 },
    capture: capture({ brushRevision: 'brush@9', functionRevision: 'texture@10',
      attachment: { depthSample: { x: 12, y: 15 }, disparity: .9 } }) }));
  assert.ok(first && second);
  const erased = result(eraser([first, second])); assert.ok(erased);
  assert.equal(erased.kind, 'erase'); assert.equal(erased.changes.length, 2);
  for (const change of erased.changes) {
    assert.ok(change.before && change.after);
    assert.equal(change.after.id, change.before.id);
    assert.equal(change.after.capture, change.before.capture);
    assert.equal(change.after.brush, change.before.brush);
    assert.equal(pixel(change.after, 8, 8)[3], 128);
    assert.equal(pixel(change.before, 8, 8)[3], 255);
  }
  assert.equal(erased.changes[0]?.after?.tiles[1]?.raster, first.tiles[1]?.raster, 'unaffected tile bytes are shared');
});

test('paint: mapped erasure preserves captured-plane antialiasing and texture units', () => {
  const data = new Uint8Array(20 * 20 * 4).fill(255);
  const base = snapshotPaintPatch({ id: 'scaled', size: { width: 20, height: 20 }, brush,
    capture: capture({ attachment: { depthSample: { x: 1, y: 1 }, disparity: .9 } }),
    tiles: [{ x: 0, y: 0, raster: snapshotPaintRaster({ size: { width: 20, height: 20 }, data }) }] });
  assert.ok(base.ok);
  const options = eraser([base.value], { capture: capture({ start: { x: 4.5, y: 4.5 } }),
    targets: [{ patch: base.value, toPatch: { offset: { x: .5, y: .5 }, scale: 2 } }],
    brush: { operation: 'erase', diameter: 4, opacity: 1, pressure: 'off' },
    coverageSource: (x, y) => { assert.ok(Number.isFinite(x + y)); return .5; } });
  const erased = result(options)?.changes[0]?.after ?? null;
  assert.equal(pixel(erased, 9, 9)[3], 128, 'target center maps to captured dab center');
  assert.equal(pixel(erased, 13, 9)[3], 191, 'scaled AA edge has 0.5 tip times 0.5 texture');
  assert.equal(pixel(erased, 14, 9)[3], 255);
  assert.equal(erased?.capture.attachment.disparity, .9);
});

test('paint: a draw freezes its own identity, revisions, generations, coordinates and seed at begin', () => {
  const metadata = { ...capture(), start: { x: 8.5, y: 8.5 },
    attachment: { depthSample: { x: 80, y: 100 }, disparity: .4 },
    plane: { origin: { x: .5, y: .5 }, pixelScale: 1 } };
  const settings = { ...brush, color: { ...brush.color } };
  const begun = beginPaintStroke(input({ capture: metadata, brush: settings })); assert.ok(begun.ok);
  metadata.start.x = 30; metadata.attachment.disparity = .9; metadata.attachment.depthSample.x = 1;
  metadata.owner = 'other'; metadata.sceneGeneration = 99; metadata.viewGeneration = 99;
  metadata.brushRevision = 'changed'; metadata.functionRevision = 'changed'; metadata.seed = 99;
  metadata.plane.origin.x = 99; metadata.plane.pixelScale = 2;
  settings.opacity = 0; settings.color.l = 0;
  const finished = begun.value.finish(); assert.ok(finished.ok && finished.value);
  const change = finished.value.changes[0]; assert.ok(change?.after);
  assert.equal(change.before, null);
  assert.equal(change.patchId, 'stroke-1');
  assert.deepEqual(change.after.capture, capture());
  assert.deepEqual(pixel(change.after, 8, 8), [255, 0, 0, 128]);
  assert.ok(change.tiles.every(tile => tile.before === null));
  for (const value of [finished.value, finished.value.changes, change, change.after,
    change.after.capture, change.after.capture.plane, change.after.capture.plane.origin,
    change.after.brush, change.after.brush.color, change.after.tiles, change.after.memory]) assert.ok(Object.isFrozen(value));
});

test('paint: mapped multi-patch erasure returns byte-identical combined changes across batchings', () => {
  const size = { width: 48, height: 48 }, raster = snapshotPaintRaster({ size, data: new Uint8Array(48 * 48 * 4).fill(255) });
  const patches = ['first', 'second'].map((id, i) => {
    const patch = snapshotPaintPatch({ id, size, brush,
      capture: capture({ attachment: { depthSample: { x: 1, y: 1 }, disparity: .2 + i * .6 } }),
      tiles: [{ x: 0, y: 0, raster }] });
    assert.ok(patch.ok); return patch.value;
  });
  const options = eraser(patches, { coverageSource: (x, y, seed) => ((Math.floor(x) ^ Math.floor(y) ^ seed) & 7) / 7,
    targets: patches.map((patch, i) => ({ patch, toPatch: { offset: { x: i * .5, y: i * .5 }, scale: 1 + i } })) });
  const path = [{ x: 12.3, y: 8.8 }, { x: 15.1, y: 20.9 }, { x: 12.3, y: 8.8 }];
  const changedBytes = (value: PaintStrokeResult | null) => value?.changes.map(change => ({
    id: change.patchId, capture: change.after?.capture, tiles: change.tiles.map(tile => ({
      x: tile.x, y: tile.y, before: tile.before?.copyBytes(), after: tile.after?.copyBytes() })) }));
  const reference = result(options, [path]); assert.ok(reference);
  assert.deepEqual(changedBytes(result(options, path.map(sample => [sample]))), changedBytes(reference));
  assert.deepEqual(changedBytes(result(options, [[], path.slice(0, 2), [], path.slice(2)])), changedBytes(reference));
});
