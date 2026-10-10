// analysis/checks.ts under node: each check on hand-computed planes, with a
// case on each side of every threshold and of the bench's rounding where it
// decides a verdict, the median rule, the region threshold, and every refusal;
// then each check on the synth fixtures at their real sizes, passing on the
// fixtures' own truth and failing on a wrong product.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_THRESHOLDS, checkDepth, checkInpaint, checkMask, REGION_THRESHOLD, type InpaintCheck } from '../src/analysis/checks.ts';
import type { Plane, Rgb8, Size } from '../src/core/raster.ts';
import type { Result } from '../src/core/result.ts';
import { SYNTH_FIXTURES, synthScene } from './fixtures/synth/synth.ts';

function value<T>(result: Result<T, string>): T {
  if (!result.ok) assert.fail(result.error);
  return result.value;
}

function refused<T>(result: Result<T, string>, error: string): void {
  assert.deepEqual(result, { ok: false, error });
}

function f32(values: readonly number[], size: Size = { width: values.length, height: 1 }): Plane<'f32'> {
  return { format: 'f32', size, data: new Float32Array(values) };
}

/** A region of `length` texels in one row, 255 at `inside`, else 0. */
function region(length: number, inside: Iterable<number>): Plane<'u8'> {
  const data = new Uint8Array(length);
  for (const i of inside) data[i] = 255;
  return { format: 'u8', size: { width: length, height: 1 }, data };
}

/** The whole numbers from `from` up to but not including `to`. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

test('the thresholds are the bench\'s', () => {
  assert.equal(REGION_THRESHOLD, 128);
  assert.deepEqual(CHECK_THRESHOLDS, {
    depth: { minRange: 1e-4, minGapShare: 0.1 },
    mask: { minIou: 0.85, maxBackgroundFalsePositive: 0.02 },
    inpaint: {
      maxOutsideMeanDifference: 1.0,
      changedDifference: 16,
      maxOutsideChangedShare: 0.001,
      maxHoleToRingShare: 0.25,
      maxHoleToRing: 40,
      redMargin: 60,
      maxRedShare: 0.05,
    },
  });
});

// ---------------------------------------------------------------------------
// depth

/** A row of six texels: the least and largest values, then two near texels, then two far ones. */
function depthRow(min: number, max: number, near: readonly [number, number], far: readonly [number, number]) {
  return { depth: f32([min, max, ...near, ...far]), near: region(6, [2, 3]), far: region(6, [4, 5]) };
}

test('depth: a gap of exactly 0.1 of the range fails and one two float32 steps above it passes, each with its numbers', () => {
  // range 10, so the threshold is 0.1 x 10 = 1 exactly in doubles
  assert.equal(0.1 * 10, 1);
  assert.deepEqual(value(checkDepth(depthRow(0, 10, [3, 3], [2, 2]))), {
    pass: false,
    nearCount: 2,
    farCount: 2,
    min: 0,
    max: 10,
    range: 10,
    nearMedian: 3,
    farMedian: 2,
    gapShare: 0.1,
  });
  const above = Math.fround(3 + 2 ** -21);
  assert.equal(above, 3.000000476837158);
  const passed = value(checkDepth(depthRow(0, 10, [above, above], [2, 2])));
  assert.equal(passed.pass, true);
  assert.equal(passed.nearMedian, above);
  assert.equal(passed.gapShare, (above - 2) / 10);
});

test('depth: the medians are nearest rank, the lower middle of an even count, where the bench took the upper middle', () => {
  // near [3, 5]: the nearest-rank median is 3, a gap of 1, not above 1, so it fails;
  // the bench's upper middle, 5, would have given a gap of 3 and passed
  const lower = value(checkDepth(depthRow(0, 10, [5, 3], [2, 2])));
  assert.equal(lower.nearMedian, 3);
  assert.equal(lower.pass, false);
  // three values: the middle one
  const odd = value(checkDepth({ depth: f32([0, 10, 9, 1, 4, 2, 2, 2]), near: region(8, [2, 3, 4]), far: region(8, [5, 6, 7]) }));
  assert.equal(odd.nearMedian, 4);
  assert.equal(odd.pass, true);
});

test('depth: a range of at most 1e-4 fails whatever the gap, and one above it passes', () => {
  const small = Math.fround(1e-4);
  assert.ok(small < 1e-4);
  const at = value(checkDepth({ depth: f32([0, small]), near: region(2, [1]), far: region(2, [0]) }));
  assert.deepEqual(at, { pass: false, nearCount: 1, farCount: 1, min: 0, max: small, range: small, nearMedian: small, farMedian: 0, gapShare: 1 });
  const big = Math.fround(1.5e-4);
  assert.equal(value(checkDepth({ depth: f32([0, big]), near: region(2, [1]), far: region(2, [0]) })).pass, true);
  // a flat map has range 0: it fails, with a gap share of 0
  const flat = value(checkDepth({ depth: f32([0.5, 0.5]), near: region(2, [1]), far: region(2, [0]) }));
  assert.deepEqual(flat, { pass: false, nearCount: 1, farCount: 1, min: 0.5, max: 0.5, range: 0, nearMedian: 0.5, farMedian: 0.5, gapShare: 0 });
});

test('depth: the map is read on a 2-D plane row-major, a texel in both regions is near only, and a region byte of 128 is in and 127 out', () => {
  // 3 x 2: values row-major; texel 1 is in both regions, texel 4 is 127 in the far plane
  const depth = f32([0, 0.9, 0.2, 0.8, 0.1, 1], { width: 3, height: 2 });
  const near = { format: 'u8' as const, size: { width: 3, height: 2 }, data: new Uint8Array([0, 255, 0, 128, 127, 0]) };
  const far = { format: 'u8' as const, size: { width: 3, height: 2 }, data: new Uint8Array([0, 200, 128, 0, 127, 0]) };
  const check = value(checkDepth({ depth, near, far }));
  // near: texels 1 and 3, values 0.9 and 0.8 (median 0.8); far: texel 2 only, 0.2
  assert.equal(check.nearCount, 2);
  assert.equal(check.farCount, 1);
  assert.equal(check.nearMedian, Math.fround(0.8));
  assert.equal(check.farMedian, Math.fround(0.2));
  assert.equal(check.range, 1);
  assert.equal(check.pass, true);
});

test('depth: refuses planes of different sizes, a malformed plane, an empty region, and a value that is not finite', () => {
  const ok3 = { depth: f32([0, 1, 0.5]), near: region(3, [1]), far: region(3, [0]) };
  refused(checkDepth({ ...ok3, near: region(4, [1]) }), "near: expected the depth's size 3 x 1, got 4 x 1");
  refused(checkDepth({ ...ok3, far: { format: 'u8', size: { width: 3, height: 2 }, data: new Uint8Array(6) } }), "far: expected the depth's size 3 x 1, got 3 x 2");
  refused(checkDepth({ ...ok3, depth: f32([0, 1], { width: 3, height: 1 }) }), 'depth: expected 3 elements for 3 x 1, got 2');
  refused(checkDepth({ ...ok3, near: { format: 'u8', size: { width: 3, height: 1 }, data: new Uint8Array(2) } }), 'near: expected 3 elements for 3 x 1, got 2');
  refused(checkDepth({ ...ok3, depth: f32([], { width: 0, height: 1 }) }), 'depth: expected whole sides of at least 1, got 0 x 1');
  refused(checkDepth({ ...ok3, near: region(3, []) }), 'near: the region is empty');
  refused(checkDepth({ ...ok3, far: region(3, []) }), 'far: the region holds no texel outside the near region');
  refused(checkDepth({ ...ok3, far: region(3, [1]) }), 'far: the region holds no texel outside the near region');
  refused(checkDepth({ ...ok3, depth: f32([0, NaN, 0.5]) }), 'depth: texel 1 is NaN, not a finite number');
  refused(checkDepth({ ...ok3, depth: f32([0, 1, -Infinity]) }), 'depth: texel 2 is -Infinity, not a finite number');
  // a size far larger than the data is refused before anything is allocated
  refused(checkDepth({ ...ok3, depth: f32([0, 1, 0.5], { width: 2 ** 26, height: 2 ** 26 }) }), `depth: expected ${2 ** 52} elements for ${2 ** 26} x ${2 ** 26}, got 3`);
});

// ---------------------------------------------------------------------------
// mask

test('mask: an IoU of exactly 0.85 passes and 0.84 fails, each with its numbers', () => {
  // 100 texels, the truth the first 20; the mask 17 of them, then 16 of them
  const truth = region(100, range(0, 20));
  assert.deepEqual(value(checkMask({ mask: region(100, range(0, 17)), truth })), {
    pass: true,
    maskCount: 17,
    truthCount: 20,
    intersection: 17,
    union: 20,
    backgroundCount: 80,
    falsePositiveCount: 0,
    iou: 0.85,
    backgroundFalsePositive: 0,
  });
  const below = value(checkMask({ mask: region(100, range(0, 16)), truth }));
  assert.equal(below.iou, 0.8);
  assert.equal(below.pass, false);
});

test('mask: the IoU is compared at 4 decimals, as the bench compared it: 0.84996 passes and 0.84994 fails', () => {
  const truth = region(200_000, range(0, 100_000));
  const up = value(checkMask({ mask: region(200_000, range(0, 84_996)), truth }));
  assert.equal(up.iou, 0.84996);
  assert.equal(up.pass, true);
  const down = value(checkMask({ mask: region(200_000, range(0, 84_994)), truth }));
  assert.equal(down.iou, 0.84994);
  assert.equal(down.pass, false);
});

test('mask: a background false-positive rate of exactly 0.02 passes and 0.03 fails, compared at 5 decimals', () => {
  // 150 texels, the truth the first 50, so the background is 100
  const truth = region(150, range(0, 50));
  const at = value(checkMask({ mask: region(150, range(0, 52)), truth }));
  assert.deepEqual([at.falsePositiveCount, at.backgroundCount, at.backgroundFalsePositive, at.union, at.pass], [2, 100, 0.02, 52, true]);
  const over = value(checkMask({ mask: region(150, range(0, 53)), truth }));
  assert.deepEqual([over.backgroundFalsePositive, over.pass], [0.03, false]);
  // 5001 of 250000 is 0.020004, 0.02000 at 5 decimals, and passes; 5003 is 0.020012, 0.02001, and fails
  const big = region(550_000, range(0, 300_000));
  const rounded = value(checkMask({ mask: region(550_000, range(0, 305_001)), truth: big }));
  assert.deepEqual([rounded.backgroundFalsePositive, rounded.pass], [0.020004, true]);
  const notRounded = value(checkMask({ mask: region(550_000, range(0, 305_003)), truth: big }));
  assert.deepEqual([notRounded.backgroundFalsePositive, notRounded.pass], [0.020012, false]);
});

test('mask: a byte of 128 is in and 127 out, in the mask and in the truth', () => {
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 4, height: 1 }, data: new Uint8Array([128, 127, 255, 0]) };
  const truth: Plane<'u8'> = { format: 'u8', size: { width: 4, height: 1 }, data: new Uint8Array([200, 128, 127, 0]) };
  // mask {0, 2}, truth {0, 1}: intersection 1, union 3, background {2, 3} with one false positive
  const check = value(checkMask({ mask, truth }));
  assert.deepEqual([check.intersection, check.union, check.backgroundCount, check.falsePositiveCount], [1, 3, 2, 1]);
});

test('mask: refuses planes of different sizes, a malformed plane, an empty truth, and a truth with no background', () => {
  refused(checkMask({ mask: region(3, [0]), truth: region(4, [0]) }), "truth: expected the mask's size 3 x 1, got 4 x 1");
  refused(checkMask({ mask: { format: 'u8', size: { width: 3, height: 1 }, data: new Uint8Array(4) }, truth: region(3, [0]) }), 'mask: expected 3 elements for 3 x 1, got 4');
  refused(checkMask({ mask: region(3, [0]), truth: region(3, []) }), 'truth: the region is empty');
  refused(checkMask({ mask: region(3, [0]), truth: region(3, [0, 1, 2]) }), 'truth: the region covers every texel, so there is no background');
});

// ---------------------------------------------------------------------------
// inpaint

type Pixel = readonly [number, number, number];

/**
 * A row of `outside + hole` pixels: the first `outside` outside the hole, the first `ring` of them the ring, the rest the hole.
 * The original paints the outside `around` and the hole `inside`; the plate is the original outside and `around` in the hole,
 * so before a test changes it every rule passes.
 */
function inpaintRow(counts: { readonly outside: number; readonly hole: number; readonly ring: number }, around: Pixel, inside: Pixel) {
  const n = counts.outside + counts.hole;
  const size = { width: n, height: 1 };
  const original = new Uint8Array(3 * n);
  const plate = new Uint8Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    original.set(i < counts.outside ? around : inside, 3 * i);
    plate.set(around, 3 * i);
  }
  return {
    images: {
      original: { size, data: original } satisfies Rgb8,
      plate: { size, data: plate } satisfies Rgb8,
      hole: region(n, range(counts.outside, n)),
      ring: region(n, range(0, counts.ring)),
    },
    /** Paints the plate's pixel `i`. */
    paint: (i: number, pixel: Pixel): void => plate.set(pixel, 3 * i),
    /** Paints the original's pixel `i`. */
    paintOriginal: (i: number, pixel: Pixel): void => original.set(pixel, 3 * i),
  };
}

const GREY: Pixel = [100, 100, 100];

test('inpaint: every number on a hand-computed row', () => {
  // 4 outside (2 of them the ring), 2 in the hole
  const { images, paint } = inpaintRow({ outside: 4, hole: 2, ring: 2 }, GREY, [200, 100, 100]);
  paint(0, [103, 99, 100]); // largest channel difference 3
  paint(3, [100, 120, 100]); // 20, changed
  paint(4, [110, 100, 100]);
  paint(5, [130, 104, 100]);
  const check: InpaintCheck = value(checkInpaint(images));
  assert.deepEqual(check, {
    pass: false,
    outsideCount: 4,
    holeCount: 2,
    ringCount: 2,
    outsideMeanDifference: 23 / 4,
    outsideChangedShare: 0.25,
    holeMean: [120, 102, 100],
    ringMean: [100, 100, 100],
    originalHoleMean: [200, 100, 100],
    holeToRing: Math.hypot(20, 2, 0),
    originalToRing: 100,
    holeChange: Math.hypot(80, 2, 0),
    redShare: 0,
  });
});

test('inpaint: an outside mean difference of exactly 1.0 passes and 1.01 fails, the largest channel counting once', () => {
  const { images, paint } = inpaintRow({ outside: 100, hole: 10, ring: 10 }, GREY, [200, 100, 100]);
  // every outside pixel differs by 1 in one or more channels: its largest difference is 1
  for (let i = 0; i < 100; i += 1) paint(i, i % 2 === 0 ? [101, 100, 100] : [99, 101, 99]);
  const at = value(checkInpaint(images));
  assert.deepEqual([at.outsideMeanDifference, at.outsideChangedShare, at.pass], [1, 0, true]);
  paint(0, [102, 100, 100]);
  const over = value(checkInpaint(images));
  assert.deepEqual([over.outsideMeanDifference, over.pass], [1.01, false]);
});

test('inpaint: the outside mean is compared at 4 decimals: 1.00004 passes and 1.00006 fails', () => {
  const { images, paint } = inpaintRow({ outside: 100_000, hole: 10, ring: 10 }, GREY, [200, 100, 100]);
  for (let i = 0; i < 100_000; i += 1) paint(i, i < 4 ? [102, 100, 100] : [101, 100, 100]);
  const up = value(checkInpaint(images));
  assert.deepEqual([up.outsideMeanDifference, up.pass], [1.00004, true]);
  paint(4, [102, 100, 100]);
  paint(5, [102, 100, 100]);
  const down = value(checkInpaint(images));
  assert.deepEqual([down.outsideMeanDifference, down.pass], [1.00006, false]);
});

test('inpaint: a changed share of exactly 0.001 passes and 0.002 fails, and a difference of 16 is not a change', () => {
  const { images, paint } = inpaintRow({ outside: 1000, hole: 10, ring: 10 }, GREY, [200, 100, 100]);
  paint(10, [116, 100, 100]);
  paint(11, [100, 84, 100]);
  const sixteen = value(checkInpaint(images));
  assert.deepEqual([sixteen.outsideChangedShare, sixteen.pass], [0, true]);
  paint(12, [117, 100, 100]);
  const at = value(checkInpaint(images));
  assert.deepEqual([at.outsideChangedShare, at.outsideMeanDifference, at.pass], [0.001, 49 / 1000, true]);
  paint(13, [100, 100, 83]);
  const over = value(checkInpaint(images));
  assert.deepEqual([over.outsideChangedShare, over.pass], [0.002, false]);
});

test('inpaint: the changed share is compared at 6 decimals: 0.0010005 passes and 0.0010010 fails', () => {
  const outside = 2_001_000;
  const { images, paint } = inpaintRow({ outside, hole: 10, ring: 10 }, GREY, [200, 100, 100]);
  for (let i = 0; i < 2002; i += 1) paint(i, [117, 100, 100]);
  // 2002 of 2001000 is 0.00100049..., 0.001000 at 6 decimals
  const up = value(checkInpaint(images));
  assert.deepEqual([up.outsideChangedShare, up.pass], [2002 / outside, true]);
  assert.ok(up.outsideChangedShare > CHECK_THRESHOLDS.inpaint.maxOutsideChangedShare);
  // 2003 of 2001000 is 0.00100099..., 0.001001
  paint(2002, [117, 100, 100]);
  const down = value(checkInpaint(images));
  assert.deepEqual([down.outsideChangedShare, down.pass], [2003 / outside, false]);
});

test('inpaint: a hole 0.25 of the original\'s distance from the ring passes and one further fails', () => {
  // the ring is grey and the original hole (200, 100, 100), 100 away, so the limit is 25
  const { images, paint } = inpaintRow({ outside: 20, hole: 10, ring: 10 }, GREY, [200, 100, 100]);
  for (let i = 20; i < 30; i += 1) paint(i, [125, 100, 100]);
  const at = value(checkInpaint(images));
  assert.deepEqual([at.holeToRing, at.originalToRing, at.redShare, at.pass], [25, 100, 0, true]);
  for (let i = 20; i < 30; i += 1) paint(i, [126, 100, 100]);
  const over = value(checkInpaint(images));
  assert.deepEqual([over.holeToRing, over.pass], [26, false]);
});

test('inpaint: the share rule compares each distance at 1 decimal', () => {
  // the hole 25.04 from the ring, 25.0 at 1 decimal, passes against an original 100 away; 25.06, 25.1, fails
  const near = inpaintRow({ outside: 20, hole: 100, ring: 10 }, GREY, [200, 100, 100]);
  for (let i = 20; i < 120; i += 1) near.paint(i, i < 24 ? [126, 100, 100] : [125, 100, 100]);
  const up = value(checkInpaint(near.images));
  assert.ok(Math.abs(up.holeToRing - 25.04) < 1e-9, String(up.holeToRing));
  assert.deepEqual([up.originalToRing, up.pass], [100, true]);
  for (let i = 24; i < 26; i += 1) near.paint(i, [126, 100, 100]);
  const down = value(checkInpaint(near.images));
  assert.ok(Math.abs(down.holeToRing - 25.06) < 1e-9, String(down.holeToRing));
  assert.equal(down.pass, false);
  // the hole 25 from the ring passes against an original 99.96 away, 100.0 at 1 decimal; against 99.94, 99.9, it fails
  const far = inpaintRow({ outside: 20, hole: 100, ring: 10 }, GREY, [200, 100, 100]);
  for (let i = 20; i < 120; i += 1) far.paint(i, [125, 100, 100]);
  for (let i = 20; i < 24; i += 1) far.paintOriginal(i, [199, 100, 100]);
  const within = value(checkInpaint(far.images));
  assert.ok(Math.abs(within.originalToRing - 99.96) < 1e-9, String(within.originalToRing));
  assert.deepEqual([within.holeToRing, within.pass], [25, true]);
  for (let i = 24; i < 26; i += 1) far.paintOriginal(i, [199, 100, 100]);
  const beyond = value(checkInpaint(far.images));
  assert.ok(Math.abs(beyond.originalToRing - 99.94) < 1e-9, String(beyond.originalToRing));
  assert.equal(beyond.pass, false);
});

test('inpaint: a hole 40 from the ring passes and one further fails, compared at 1 decimal, where the share alone would pass', () => {
  // a black ring and a white original hole, about 441.7 apart, so the share's limit is about 110.4
  const { images, paint } = inpaintRow({ outside: 20, hole: 100, ring: 10 }, [0, 0, 0], [255, 255, 255]);
  for (let i = 20; i < 120; i += 1) paint(i, [0, 40, 0]);
  const at = value(checkInpaint(images));
  assert.deepEqual([at.holeToRing, at.pass], [40, true]);
  // 96 pixels at 40 and 4 at 41: 40.04, 40.0 at 1 decimal
  for (let i = 20; i < 24; i += 1) paint(i, [0, 41, 0]);
  const rounded = value(checkInpaint(images));
  assert.ok(Math.abs(rounded.holeToRing - 40.04) < 1e-9, String(rounded.holeToRing));
  assert.equal(rounded.pass, true);
  // 94 at 40 and 6 at 41: 40.06, 40.1
  for (let i = 24; i < 26; i += 1) paint(i, [0, 41, 0]);
  const over = value(checkInpaint(images));
  assert.ok(Math.abs(over.holeToRing - 40.06) < 1e-9, String(over.holeToRing));
  assert.equal(over.pass, false);
});

test('inpaint: a red share of exactly 0.05 passes and 0.06 fails, red being R above G and B each by more than 60', () => {
  // a grey ring and a white original hole, about 268.5 apart, so a hole near grey is within both distance limits
  const { images, paint } = inpaintRow({ outside: 20, hole: 100, ring: 10 }, GREY, [255, 255, 255]);
  for (let i = 20; i < 25; i += 1) paint(i, [161, 100, 100]); // red
  paint(25, [160, 100, 100]); // R 60 above G and B: not red
  paint(26, [161, 100, 101]); // R 60 above B: not red
  paint(27, [161, 101, 100]); // R 60 above G: not red
  const at = value(checkInpaint(images));
  assert.deepEqual([at.redShare, at.pass], [0.05, true]);
  paint(28, [200, 0, 139]);
  const over = value(checkInpaint(images));
  assert.deepEqual([over.redShare, over.pass], [0.06, false]);
});

test('inpaint: the red share is compared at 4 decimals: 0.05004 passes and 0.05008 fails', () => {
  const { images, paint } = inpaintRow({ outside: 20, hole: 25_000, ring: 10 }, GREY, [255, 255, 255]);
  for (let i = 20; i < 20 + 1251; i += 1) paint(i, [161, 100, 100]);
  const up = value(checkInpaint(images));
  assert.deepEqual([up.redShare, up.pass], [0.05004, true]);
  paint(20 + 1251, [161, 100, 100]);
  const down = value(checkInpaint(images));
  assert.deepEqual([down.redShare, down.pass], [0.05008, false]);
});

test('inpaint: a ring pixel inside the hole is ignored, and region bytes are read at 128', () => {
  const { images } = inpaintRow({ outside: 4, hole: 2, ring: 2 }, GREY, [200, 100, 100]);
  const ring = new Uint8Array(images.ring.data);
  ring[4] = 255; // inside the hole
  ring[1] = 127; // out
  ring[2] = 128; // in
  const hole = new Uint8Array(images.hole.data);
  hole[4] = 128;
  hole[5] = 127;
  const check = value(checkInpaint({ ...images, ring: { ...images.ring, data: ring }, hole: { ...images.hole, data: hole } }));
  // the hole is pixel 4 only; the ring is pixels 0 and 2
  assert.deepEqual([check.holeCount, check.outsideCount, check.ringCount], [1, 5, 2]);
});

test('inpaint: refuses images or regions of different sizes, a malformed image, an empty hole, a hole over everything, and an empty ring', () => {
  const { images } = inpaintRow({ outside: 4, hole: 2, ring: 2 }, GREY, [200, 100, 100]);
  refused(checkInpaint({ ...images, plate: { size: { width: 5, height: 1 }, data: new Uint8Array(15) } }), "plate: expected the original's size 6 x 1, got 5 x 1");
  refused(checkInpaint({ ...images, hole: region(5, [4]) }), "hole: expected the original's size 6 x 1, got 5 x 1");
  refused(checkInpaint({ ...images, ring: region(7, [0]) }), "ring: expected the original's size 6 x 1, got 7 x 1");
  refused(checkInpaint({ ...images, original: { size: { width: 6, height: 1 }, data: new Uint8Array(17) } }), 'original: expected 18 elements for 6 x 1, got 17');
  refused(checkInpaint({ ...images, plate: { size: { width: 6, height: 1 }, data: new Uint8Array(24) } }), 'plate: expected 18 elements for 6 x 1, got 24');
  refused(checkInpaint({ ...images, hole: region(6, []) }), 'hole: the region is empty');
  refused(checkInpaint({ ...images, hole: region(6, range(0, 6)) }), 'hole: the region covers every pixel, so nothing lies outside it');
  refused(checkInpaint({ ...images, ring: region(6, []) }), 'ring: the region holds no pixel outside the hole');
  refused(checkInpaint({ ...images, ring: region(6, [4, 5]) }), 'ring: the region holds no pixel outside the hole');
});

// ---------------------------------------------------------------------------
// the synth fixtures at their real sizes

test('on every synth fixture, each check passes on the fixture\'s own truth and fails on a wrong product', () => {
  for (const fixture of SYNTH_FIXTURES) {
    const key = `${fixture.name} ${fixture.size.width}x${fixture.size.height}`;
    const scene = synthScene(fixture.size);
    const near = scene.depthNear();
    const far = scene.depthFar();
    const depth = scene.depth();
    const right = value(checkDepth({ depth, near, far }));
    assert.equal(right.pass, true, key);
    // the map turned around, far nearer than near
    const inverted = f32(Array.from(depth.data, (v) => 1 - v), depth.size);
    assert.equal(value(checkDepth({ depth: inverted, near, far })).pass, false, key);

    const truth = scene.sphereMask();
    assert.equal(value(checkMask({ mask: truth, truth })).iou, 1, key);
    assert.equal(value(checkMask({ mask: truth, truth })).pass, true, key);
    assert.equal(value(checkMask({ mask: scene.boxMask(), truth })).pass, false, key);

    const original = scene.master();
    const images = { original, hole: scene.hole(), ring: scene.ring() };
    const plate = value(checkInpaint({ ...images, plate: scene.plate() }));
    assert.deepEqual([plate.outsideMeanDifference, plate.outsideChangedShare, plate.redShare, plate.pass], [0, 0, 0, true], key);
    // the master returned unchanged keeps the red sphere in the hole
    const unchanged = value(checkInpaint({ ...images, plate: original }));
    assert.equal(unchanged.pass, false, key);
    assert.ok(unchanged.redShare > 0.05, key);
    console.log(
      `${key}: depth gap share ${right.gapShare.toFixed(4)} (near ${right.nearCount}, far ${right.farCount}); ` +
        `the plate's hole ${plate.holeToRing.toFixed(1)} from the ring, the master's ${plate.originalToRing.toFixed(1)} (hole ${plate.holeCount}, ring ${plate.ringCount})`,
    );
  }
});
