// The known-answer checks: whether a stage's product on a scene with known
// truth is right. Each takes the product and truth planes, regions as
// Plane<'u8'> with a byte of REGION_THRESHOLD (128) or more inside, so it
// serves any fixture and any harness; none knows a scene's geometry.
//
// The rules and thresholds are those the iPhone bench used to judge the
// models before this code was written: the depth gap between the near and far
// regions, the mask's IoU and background false positives, and the inpainted
// plate's change outside the hole and its color inside it. They differ from
// the bench in three ways: a median is core/percentile.ts's nearest rank, the
// lower middle value of an even count, where the bench took the upper middle;
// the depth check reads the stage's normalized map and the mask check a mask
// read at 128, where the bench read the model's raw output and its logits
// above 0; and an empty region, a truth or a hole that covers everything, or
// a depth texel that is not finite, which the bench's arithmetic turned into
// a failing verdict, is refused here with an error. Each value the bench
// rounded before comparing it with its threshold is rounded the same way here
// before the comparison, so on the same values a verdict is the bench's; the
// numbers returned are unrounded.
//
// Pure: no browser global, no Node API, no I/O, so a page, a worker, or the
// node tests can call it alike. Every function checks its planes' sizes
// before it allocates, returns a Result whose error is one line naming the plane and
// what was wrong, never throws, and makes at most two passes over its planes,
// so its cost is in proportion to them; a median also sorts its region's
// values.

import { percentile } from '../core/percentile.ts';
import type { Plane, Rgb8, Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';

/** A region byte at or above this is inside the region: 0.5 of 255, as a mask is read everywhere else. */
export const REGION_THRESHOLD = 128;

/** The thresholds each check's verdict compares with. */
export const CHECK_THRESHOLDS = {
  depth: {
    /** The map's largest value less its least must be more than this. */
    minRange: 1e-4,
    /** The near median less the far median must be more than this share of the map's range. */
    minGapShare: 0.1,
  },
  mask: {
    /** The mask's intersection over union with the truth must be at least this, compared at 4 decimals. */
    minIou: 0.85,
    /** The share of the truth's background the mask covers must be at most this, compared at 5 decimals. */
    maxBackgroundFalsePositive: 0.02,
  },
  inpaint: {
    /** Outside the hole, the mean of each pixel's largest channel difference must be at most this, compared at 4 decimals. */
    maxOutsideMeanDifference: 1.0,
    /** A pixel outside the hole whose largest channel difference is more than this counts as changed. */
    changedDifference: 16,
    /** The share of pixels outside the hole that changed must be at most this, compared at 6 decimals. */
    maxOutsideChangedShare: 0.001,
    /** The hole's mean color's distance to the ring's must be at most this share of the original hole's distance to it, each at 1 decimal. */
    maxHoleToRingShare: 0.25,
    /** The hole's mean color's distance to the ring's must be at most this, at 1 decimal. */
    maxHoleToRing: 40,
    /** A pixel of the hole is red when its R is more than its G and its B each by more than this. */
    redMargin: 60,
    /** The share of red pixels in the hole must be at most this, compared at 4 decimals. */
    maxRedShare: 0.05,
  },
} as const;

/** R, G, B, each 0..255. */
export type Rgb = readonly [number, number, number];

/** The depth check's numbers and verdict. */
export type DepthCheck = {
  readonly pass: boolean;
  /** Texels in the near region, and in the far region but not the near one. */
  readonly nearCount: number;
  readonly farCount: number;
  /** The map's least and largest values, and the largest less the least. */
  readonly min: number;
  readonly max: number;
  readonly range: number;
  /** The nearest-rank medians of the map over the near and the far region. */
  readonly nearMedian: number;
  readonly farMedian: number;
  /** (nearMedian - farMedian) / range, or 0 when the range is 0. */
  readonly gapShare: number;
};

/** The mask check's numbers and verdict. */
export type MaskCheck = {
  readonly pass: boolean;
  /** Texels in the mask, in the truth, in both, and in either. */
  readonly maskCount: number;
  readonly truthCount: number;
  readonly intersection: number;
  readonly union: number;
  /** Texels outside the truth, and those of them in the mask. */
  readonly backgroundCount: number;
  readonly falsePositiveCount: number;
  /** intersection / union. */
  readonly iou: number;
  /** falsePositiveCount / backgroundCount. */
  readonly backgroundFalsePositive: number;
};

/** The inpaint check's numbers and verdict. */
export type InpaintCheck = {
  readonly pass: boolean;
  /** Pixels outside the hole, in it, and in the ring and outside the hole. */
  readonly outsideCount: number;
  readonly holeCount: number;
  readonly ringCount: number;
  /** Outside the hole, the mean over pixels of the largest of the three channels' absolute differences between original and plate. */
  readonly outsideMeanDifference: number;
  /** Outside the hole, the share of pixels whose largest channel difference is more than `changedDifference`. */
  readonly outsideChangedShare: number;
  /** The plate's mean color in the hole, the original's mean color in the ring, and the original's in the hole. */
  readonly holeMean: Rgb;
  readonly ringMean: Rgb;
  readonly originalHoleMean: Rgb;
  /** Euclidean RGB distances: plate hole to ring, original hole to ring, and plate hole to original hole. */
  readonly holeToRing: number;
  readonly originalToRing: number;
  readonly holeChange: number;
  /** The share of the hole's pixels the plate paints red. */
  readonly redShare: number;
};

// ---------------------------------------------------------------------------
// sizes

function isWhole(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/** The pixel count of a plane of `size` whose data holds `channels` elements a pixel, or the reason it is not one. */
function elementCount(size: Size, length: number, channels: number, what: string): Result<number, string> {
  if (!isWhole(size.width) || !isWhole(size.height)) return err(`${what}: expected whole sides of at least 1, got ${size.width} x ${size.height}`);
  const n = size.width * size.height;
  if (length !== n * channels) return err(`${what}: expected ${n * channels} elements for ${size.width} x ${size.height}, got ${length}`);
  return ok(n);
}

function sameSize(size: Size, expected: Size, what: string, of: string): Result<void, string> {
  if (size.width === expected.width && size.height === expected.height) return ok(undefined);
  return err(`${what}: expected ${of}'s size ${expected.width} x ${expected.height}, got ${size.width} x ${size.height}`);
}

/** The pixel count shared by `first` and every plane of `others`, each of its own channel count, or the first reason one does not fit. */
function sharedCount(
  first: { readonly size: Size; readonly length: number; readonly channels: number; readonly what: string },
  others: readonly { readonly size: Size; readonly length: number; readonly channels: number; readonly what: string }[],
): Result<number, string> {
  const count = elementCount(first.size, first.length, first.channels, first.what);
  if (!count.ok) return count;
  for (const other of others) {
    const same = sameSize(other.size, first.size, other.what, `the ${first.what}`);
    if (!same.ok) return same;
    const length = elementCount(other.size, other.length, other.channels, other.what);
    if (!length.ok) return length;
  }
  return count;
}

const planeOf = (plane: Plane<'u8'> | Plane<'f32'>, what: string) => ({ size: plane.size, length: plane.data.length, channels: 1, what });
const imageOf = (image: Rgb8, what: string) => ({ size: image.size, length: image.data.length, channels: 3, what });

// ---------------------------------------------------------------------------
// the bench's rounding

/** As the bench reported a value to 4 decimals: Number(value.toFixed(4)). */
const at4 = (value: number): number => Number(value.toFixed(4));
const at5 = (value: number): number => Number(value.toFixed(5));
const at6 = (value: number): number => Number(value.toFixed(6));
/** As the bench reported a value to 1 decimal: Math.round(value * 10) / 10. */
const at1 = (value: number): number => Math.round(value * 10) / 10;

// ---------------------------------------------------------------------------
// depth

/**
 * The depth check: `depth` is a depth map, larger nearer, such as the depth stage's normalized map; `near` and `far`
 * are regions of its size, where the scene's near and far surfaces are. A texel in both counts as near only.
 * Passes when the map's range is more than `minRange` and the near median less the far median is more than
 * `minGapShare` of the range; the medians are nearest rank. The range and the gap are compared unrounded, as the bench compared them.
 * Refuses planes of different sizes, an empty near or far region, and a texel of the map that is NaN or an infinity.
 */
export function checkDepth(planes: { readonly depth: Plane<'f32'>; readonly near: Plane<'u8'>; readonly far: Plane<'u8'> }): Result<DepthCheck, string> {
  const { depth, near, far } = planes;
  const count = sharedCount(planeOf(depth, 'depth'), [planeOf(near, 'near'), planeOf(far, 'far')]);
  if (!count.ok) return count;
  const n = count.value;
  let min = Infinity;
  let max = -Infinity;
  let nearCount = 0;
  let farCount = 0;
  for (let i = 0; i < n; i += 1) {
    const value = depth.data[i] ?? NaN;
    if (!Number.isFinite(value)) return err(`depth: texel ${i} is ${value}, not a finite number`);
    if (value < min) min = value;
    if (value > max) max = value;
    if ((near.data[i] ?? 0) >= REGION_THRESHOLD) nearCount += 1;
    else if ((far.data[i] ?? 0) >= REGION_THRESHOLD) farCount += 1;
  }
  if (nearCount === 0) return err('near: the region is empty');
  if (farCount === 0) return err('far: the region holds no texel outside the near region');
  const nearValues = new Float32Array(nearCount);
  const farValues = new Float32Array(farCount);
  for (let i = 0, a = 0, b = 0; i < n; i += 1) {
    const value = depth.data[i] ?? 0;
    if ((near.data[i] ?? 0) >= REGION_THRESHOLD) nearValues[a++] = value;
    else if ((far.data[i] ?? 0) >= REGION_THRESHOLD) farValues[b++] = value;
  }
  const nearMedian = percentile(nearValues, 0.5);
  if (!nearMedian.ok) return err(`near: ${nearMedian.error}`);
  const farMedian = percentile(farValues, 0.5);
  if (!farMedian.ok) return err(`far: ${farMedian.error}`);
  const range = max - min;
  const gap = nearMedian.value - farMedian.value;
  const { minRange, minGapShare } = CHECK_THRESHOLDS.depth;
  return ok({
    pass: range > minRange && gap > minGapShare * range,
    nearCount,
    farCount,
    min,
    max,
    range,
    nearMedian: nearMedian.value,
    farMedian: farMedian.value,
    gapShare: range > 0 ? gap / range : 0,
  });
}

// ---------------------------------------------------------------------------
// mask

/**
 * The mask check: `mask` is a stage's mask and `truth` the region it should cover, both regions of one size.
 * Passes when the IoU, at 4 decimals, is at least `minIou` and the share of the background the mask covers,
 * at 5 decimals, is at most `maxBackgroundFalsePositive`.
 * Refuses planes of different sizes, an empty truth, and a truth that covers every texel, which leaves no background.
 */
export function checkMask(planes: { readonly mask: Plane<'u8'>; readonly truth: Plane<'u8'> }): Result<MaskCheck, string> {
  const { mask, truth } = planes;
  const count = sharedCount(planeOf(mask, 'mask'), [planeOf(truth, 'truth')]);
  if (!count.ok) return count;
  const n = count.value;
  let maskCount = 0;
  let truthCount = 0;
  let intersection = 0;
  let falsePositiveCount = 0;
  for (let i = 0; i < n; i += 1) {
    const inMask = (mask.data[i] ?? 0) >= REGION_THRESHOLD;
    const inTruth = (truth.data[i] ?? 0) >= REGION_THRESHOLD;
    if (inMask) maskCount += 1;
    if (inTruth) truthCount += 1;
    if (inMask && inTruth) intersection += 1;
    if (inMask && !inTruth) falsePositiveCount += 1;
  }
  if (truthCount === 0) return err('truth: the region is empty');
  const backgroundCount = n - truthCount;
  if (backgroundCount === 0) return err('truth: the region covers every texel, so there is no background');
  const union = maskCount + truthCount - intersection;
  const iou = intersection / union;
  const backgroundFalsePositive = falsePositiveCount / backgroundCount;
  const { minIou, maxBackgroundFalsePositive } = CHECK_THRESHOLDS.mask;
  return ok({
    pass: at4(iou) >= minIou && at5(backgroundFalsePositive) <= maxBackgroundFalsePositive,
    maskCount,
    truthCount,
    intersection,
    union,
    backgroundCount,
    falsePositiveCount,
    iou,
    backgroundFalsePositive,
  });
}

// ---------------------------------------------------------------------------
// inpaint

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mean(sum: readonly [number, number, number], count: number): Rgb {
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

/**
 * The inpaint check: `original` is the image the stage was given, `plate` what it returned, `hole` the region it filled,
 * and `ring` a region of the original's surroundings of the hole whose color the fill should take; a ring pixel inside the hole is ignored.
 * Passes when, outside the hole, the mean largest channel difference is at most `maxOutsideMeanDifference` and the share
 * of pixels changed by more than `changedDifference` at most `maxOutsideChangedShare`; and, in the hole, the plate's mean
 * color lies within `maxHoleToRingShare` of the original hole's distance to the ring's mean color and within
 * `maxHoleToRing` of it, and at most `maxRedShare` of its pixels are red; each compared at the bench's precision.
 * Refuses images or regions of different sizes, an empty hole, a hole that covers every pixel, and a ring with no pixel outside the hole.
 */
export function checkInpaint(images: {
  readonly original: Rgb8;
  readonly plate: Rgb8;
  readonly hole: Plane<'u8'>;
  readonly ring: Plane<'u8'>;
}): Result<InpaintCheck, string> {
  const { original, plate, hole, ring } = images;
  const count = sharedCount(imageOf(original, 'original'), [imageOf(plate, 'plate'), planeOf(hole, 'hole'), planeOf(ring, 'ring')]);
  if (!count.ok) return count;
  const n = count.value;
  const { changedDifference, redMargin } = CHECK_THRESHOLDS.inpaint;
  const a = original.data;
  const b = plate.data;
  let outsideCount = 0;
  let outsideSum = 0;
  let changed = 0;
  let holeCount = 0;
  let ringCount = 0;
  let red = 0;
  const holeSum: [number, number, number] = [0, 0, 0];
  const originalHoleSum: [number, number, number] = [0, 0, 0];
  const ringSum: [number, number, number] = [0, 0, 0];
  for (let i = 0, j = 0; i < n; i += 1, j += 3) {
    const ar = a[j] ?? 0;
    const ag = a[j + 1] ?? 0;
    const ab = a[j + 2] ?? 0;
    const br = b[j] ?? 0;
    const bg = b[j + 1] ?? 0;
    const bb = b[j + 2] ?? 0;
    if ((hole.data[i] ?? 0) < REGION_THRESHOLD) {
      const d = Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
      outsideSum += d;
      outsideCount += 1;
      if (d > changedDifference) changed += 1;
      if ((ring.data[i] ?? 0) >= REGION_THRESHOLD) {
        ringSum[0] += ar;
        ringSum[1] += ag;
        ringSum[2] += ab;
        ringCount += 1;
      }
    } else {
      holeSum[0] += br;
      holeSum[1] += bg;
      holeSum[2] += bb;
      originalHoleSum[0] += ar;
      originalHoleSum[1] += ag;
      originalHoleSum[2] += ab;
      holeCount += 1;
      if (br > bg + redMargin && br > bb + redMargin) red += 1;
    }
  }
  if (holeCount === 0) return err('hole: the region is empty');
  if (outsideCount === 0) return err('hole: the region covers every pixel, so nothing lies outside it');
  if (ringCount === 0) return err('ring: the region holds no pixel outside the hole');
  const holeMean = mean(holeSum, holeCount);
  const originalHoleMean = mean(originalHoleSum, holeCount);
  const ringMean = mean(ringSum, ringCount);
  const outsideMeanDifference = outsideSum / outsideCount;
  const outsideChangedShare = changed / outsideCount;
  const holeToRing = distance(holeMean, ringMean);
  const originalToRing = distance(originalHoleMean, ringMean);
  const redShare = red / holeCount;
  const t = CHECK_THRESHOLDS.inpaint;
  const pass =
    at4(outsideMeanDifference) <= t.maxOutsideMeanDifference &&
    at6(outsideChangedShare) <= t.maxOutsideChangedShare &&
    at1(holeToRing) <= t.maxHoleToRingShare * at1(originalToRing) &&
    at1(holeToRing) <= t.maxHoleToRing &&
    at4(redShare) <= t.maxRedShare;
  return ok({
    pass,
    outsideCount,
    holeCount,
    ringCount,
    outsideMeanDifference,
    outsideChangedShare,
    holeMean,
    ringMean,
    originalHoleMean,
    holeToRing,
    originalToRing,
    holeChange: distance(holeMean, originalHoleMean),
    redShare,
  });
}
