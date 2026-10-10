// What every later layer derives from a scene document: the draw order of its
// layers, which layer a frame point belongs to, the hole an inpaint fills,
// whether a plate is needed, the anchor disparity, the loop camera's clamp and
// radius, the bound on each object's motion, every asset the document
// references, and reconcile, the plan of analysis the document still needs.
// Pure: no browser global, no Node API, no I/O, no clock, no randomness.

import { sameValue } from './equal.ts';
import type { AssetId, NonEmpty, ObjectId } from './ids.ts';
import { effectiveOrbit, motionBound, parallaxMargin, type Vec2 } from './motion.ts';
import { sortedMasks } from './produce.ts';
import type { ImagePoint, Plane, Rect, Size } from './raster.ts';
import type { SceneDocument, SceneObject } from './types.ts';

// ---------------------------------------------------------------------------
// layers

/** One layer of the scene: the back layer, which the plate fills, or an object. */
export type Layer = { readonly kind: 'plate' } | { readonly kind: 'object'; readonly object: SceneObject };

/** Far to near by depth median, a disparity (0 far, 1 near); an object without depth statistics sorts nearest. */
function farToNear(a: SceneObject, b: SceneObject): number {
  const da = a.produced.depth;
  const db = b.produced.depth;
  if (da === null) return db === null ? 0 : 1;
  if (db === null) return -1;
  return da.median - db.median;
}

function area(rect: Rect): number {
  return rect.width * rect.height;
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * True when `inner` must draw after `outer`: more than half of `inner`'s area
 * lies inside `outer`, and no more than half of `outer`'s area lies inside
 * `inner`. Two boxes that each lie more than half inside the other, whatever
 * their areas, constrain neither way, and their depth order decides. The two
 * conditions make `inner` strictly smaller than `outer`, so the relation has
 * no cycle.
 */
function drawsAfter(inner: Rect, outer: Rect): boolean {
  const twiceOverlap = 2 * overlapArea(inner, outer);
  return twiceOverlap > area(inner) && twiceOverlap <= area(outer);
}

/**
 * The draw order: the plate first, then the objects far to near by
 * `produced.depth.median`, an object with null depth statistics nearest, ties
 * kept in document order; an object whose bounds lie more than half inside
 * another's, when that other does not lie more than half inside it, draws
 * after it, whatever their depths. The objects are placed one at a time: each
 * step places the first object, in that depth order, that no unplaced object
 * contains. An object waiting on its container can therefore draw after a
 * nearer object that neither contains nor is contained by anything.
 */
export function layers(doc: SceneDocument): NonEmpty<Layer> {
  const remaining = doc.objects.filter((object) => !object.hidden).sort(farToNear);
  const placed: Layer[] = [];
  while (remaining.length > 0) {
    const ready = remaining.findIndex((candidate) => !remaining.some((other) => drawsAfter(candidate.produced.bounds, other.produced.bounds)));
    // drawsAfter has no cycle, so some object is always ready; -1 cannot occur, and taking the first keeps the function total.
    const [next] = remaining.splice(Math.max(ready, 0), 1);
    if (next !== undefined) placed.push({ kind: 'object', object: next });
  }
  return [{ kind: 'plate' }, ...placed];
}

// ---------------------------------------------------------------------------
// sampling a mask

/** A texel's sub-position is rounded to 1/SUBTEXEL of a texel, so the weighted sum is a whole number. */
const SUBTEXEL = 65536;
/** 128 of 255, the 0.5 threshold, in the units of the weighted sum (value * SUBTEXEL^2). */
const COVERED_AT = 128 * SUBTEXEL * SUBTEXEL;

/** Where a frame fraction falls on one axis of a mask `texels` long: the two texels and the second one's weight in 1/SUBTEXEL. */
type AxisTap = { readonly lo: number; readonly hi: number; readonly weight: number };

function clampIndex(index: number, texels: number): number {
  return Math.min(Math.max(index, 0), texels - 1);
}

/**
 * The point lies at `fraction * texels - 0.5` in texel coordinates; the two
 * nearest texels are clamped to the edge. Clamping the point to the outer
 * texel centers first reads the same texel as clamping the taps, and keeps a
 * product that overflows to an infinity from making the weight NaN.
 */
function axisTap(fraction: number, texels: number): AxisTap {
  const at = Math.min(Math.max(fraction * texels - 0.5, -0.5), texels - 0.5);
  const lo = Math.floor(at);
  return { lo: clampIndex(lo, texels), hi: clampIndex(lo + 1, texels), weight: Math.round((at - lo) * SUBTEXEL) };
}

/** The bilinear value of the four texels, as a whole number in units of 1/SUBTEXEL^2 of a byte; at most 255 * 2^32, exact in a double. */
function weightedValue(data: Uint8Array, width: number, x: AxisTap, y: AxisTap): number {
  const top = (data[y.lo * width + x.lo] ?? 0) * (SUBTEXEL - x.weight) + (data[y.lo * width + x.hi] ?? 0) * x.weight;
  const bottom = (data[y.hi * width + x.lo] ?? 0) * (SUBTEXEL - x.weight) + (data[y.hi * width + x.hi] ?? 0) * x.weight;
  return top * (SUBTEXEL - y.weight) + bottom * y.weight;
}

/**
 * True when the mask is at least 0.5 at the frame point `at`: for a w x h
 * mask the point lies at (at.x w - 0.5, at.y h - 0.5) in texel coordinates,
 * the four nearest texels, clamped to the edge, are weighted bilinearly, and
 * the value is compared with 128 of 255. A value of exactly 128 is covered.
 * The rule is defined on the quantized point: its fraction of a texel on each
 * axis is rounded to the nearest 1/65536, and the weighted sum of the texels
 * is then a whole number, compared exactly. A point whose fraction is a whole
 * multiple of 1/65536, a point midway between two texel centers among them,
 * reads the exact bilinear value, and floating error in computing it is far
 * smaller than the rounding step, so it cannot change the result. Elsewhere
 * the value read can differ from the exact bilinear value at the unrounded
 * point by up to half a rounding step of weight, and a point whose computed
 * fraction lands within floating error of a half step can round either way.
 * A point with a non-finite coordinate is covered by no mask.
 */
export function maskCovers(mask: Plane<'u8'>, at: ImagePoint): boolean {
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return false;
  const { width, height } = mask.size;
  return weightedValue(mask.data, width, axisTap(at.x, width), axisTap(at.y, height)) >= COVERED_AT;
}

/**
 * The object a frame point belongs to: the last layer of `layers(doc)` whose
 * mask covers the point by maskCovers's rule, or null for the plate when none
 * does. This is the CPU statement of the rule that the renderer's id buffer,
 * the hit test, and label-aware simplification are to follow; GPU filtering
 * need not agree bit for bit within a texel of a 0.5 crossing. An object whose
 * mask `masks` does not hold covers nothing.
 */
export function labelAt(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, at: ImagePoint): ObjectId | null {
  const order = layers(doc);
  for (let i = order.length - 1; i > 0; i--) {
    const layer = order[i];
    if (layer?.kind !== 'object') continue;
    const mask = masks.get(layer.object.id);
    if (mask !== undefined && maskCovers(mask, at)) return layer.object.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the hole mask

/** The taps of every output texel's center on a mask axis `texels` long, for an output axis `count` long, as three columns. */
function axisTaps(count: number, texels: number): { readonly lo: Int32Array; readonly hi: Int32Array; readonly weight: Int32Array } {
  const lo = new Int32Array(count);
  const hi = new Int32Array(count);
  const weight = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const tap = axisTap((i + 0.5) / count, texels);
    lo[i] = tap.lo;
    hi[i] = tap.hi;
    weight[i] = tap.weight;
  }
  return { lo, hi, weight };
}

/**
 * Sets to 255 every texel of `hole` (of `size`) whose center `mask` covers:
 * maskCovers's rule, with the taps of each column and row computed once.
 */
function markCovered(hole: Uint8Array, size: Size, mask: Plane<'u8'>): void {
  const xs = axisTaps(size.width, mask.size.width);
  const ys = axisTaps(size.height, mask.size.height);
  const data = mask.data;
  const stride = mask.size.width;
  for (let y = 0; y < size.height; y++) {
    const top = (ys.lo[y] ?? 0) * stride;
    const bottom = (ys.hi[y] ?? 0) * stride;
    const wy = ys.weight[y] ?? 0;
    const row = y * size.width;
    for (let x = 0; x < size.width; x++) {
      if (hole[row + x] !== 0) continue;
      const left = xs.lo[x] ?? 0;
      const right = xs.hi[x] ?? 0;
      const wx = xs.weight[x] ?? 0;
      const upper = (data[top + left] ?? 0) * (SUBTEXEL - wx) + (data[top + right] ?? 0) * wx;
      const lower = (data[bottom + left] ?? 0) * (SUBTEXEL - wx) + (data[bottom + right] ?? 0) * wx;
      if (upper * (SUBTEXEL - wy) + lower * wy >= COVERED_AT) hole[row + x] = 255;
    }
  }
}

/**
 * Grows the 255 texels of `hole` by a disc of `radius` texels: a texel is set
 * when some set texel lies within Euclidean distance `radius` of it, that is,
 * when its squared distance to the nearest set texel is at most radius
 * squared. The squared distance is the exact two-pass transform of
 * Felzenszwalb and Huttenlocher: a row pass finds each texel's distance along
 * its row to the nearest set texel, capped at radius + 1, which changes no
 * comparison with the radius; a column pass takes, for each texel, the least
 * of that row distance squared plus the row offset squared over its column,
 * through the lower envelope of one parabola per row. Every distance compared
 * is a whole number, so the test is exact.
 */
function dilate(hole: Uint8Array, size: Size, radius: number): Uint8Array {
  const { width, height } = size;
  const cap = radius + 1;
  const along = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let distance = cap;
    for (let x = 0; x < width; x++) {
      distance = hole[row + x] !== 0 ? 0 : Math.min(distance + 1, cap);
      along[row + x] = distance;
    }
    distance = cap;
    for (let x = width - 1; x >= 0; x--) {
      distance = hole[row + x] !== 0 ? 0 : Math.min(distance + 1, cap);
      const nearest = Math.min(distance, along[row + x] ?? cap);
      along[row + x] = nearest * nearest;
    }
  }
  const out = new Uint8Array(width * height);
  const limit = radius * radius;
  const capped = cap * cap;
  // The envelope: parabola k is rooted at row roots[k] and is the lowest from bounds[k] to bounds[k + 1].
  const roots = new Int32Array(height);
  const bounds = new Float64Array(height + 1);
  const f = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    let any = false;
    for (let y = 0; y < height; y++) {
      const value = along[y * width + x] ?? capped;
      f[y] = value;
      if (value <= limit) any = true;
    }
    if (!any) continue;
    let k = 0;
    roots[0] = 0;
    bounds[0] = -Infinity;
    bounds[1] = Infinity;
    for (let q = 1; q < height; q++) {
      const fq = (f[q] ?? capped) + q * q;
      let p = roots[k] ?? 0;
      let s = (fq - ((f[p] ?? capped) + p * p)) / (2 * (q - p));
      while (s <= (bounds[k] ?? -Infinity)) {
        k--;
        p = roots[k] ?? 0;
        s = (fq - ((f[p] ?? capped) + p * p)) / (2 * (q - p));
      }
      k++;
      roots[k] = q;
      bounds[k] = s;
      bounds[k + 1] = Infinity;
    }
    k = 0;
    for (let y = 0; y < height; y++) {
      while ((bounds[k + 1] ?? Infinity) < y) k++;
      const p = roots[k] ?? 0;
      if ((y - p) * (y - p) + (f[p] ?? capped) <= limit) out[y * width + x] = 255;
    }
  }
  return out;
}

/**
 * The hole an inpaint fills, at `size`: 255 at every texel whose center some
 * object's mask covers by maskCovers's rule, the union over every object
 * `masks` holds a mask for, then grown by a disc whose radius is 1% of the
 * long edge of `size`, rounded up to whole texels (21 at 2048), scaled by
 * Parallax and rounded up again; 0 elsewhere.
 */
export function holeMask(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, size: Size): Plane<'u8'> {
  const hole = new Uint8Array(size.width * size.height);
  for (const object of doc.objects) {
    const mask = masks.get(object.id);
    if (mask !== undefined) markCovered(hole, size, mask);
  }
  const radius = holeRadius(doc, size);
  return { format: 'u8', size: { width: size.width, height: size.height }, data: dilate(hole, size, radius) };
}

/** Scale today's rounded dilation radius so Parallax 1 preserves it and 2 doubles it exactly. */
export function holeRadius(doc: SceneDocument, size: Size): number {
  return Math.ceil(Math.ceil(Math.max(size.width, size.height) / 100) * doc.motion.parallax);
}

// ---------------------------------------------------------------------------
// the plate, the anchor, and the assets

/**
 * True when hidden layers or motion expose the background, and the stored
 * plate was not made for the current masks. Hidden layers need a plate even
 * with Motion off; every mask remains in its inpaint/freshness input.
 */
export function plateNeeded(doc: SceneDocument): boolean {
  if (doc.objects.length === 0) return false;
  const hidden = doc.objects.some((object) => object.hidden);
  const moves = doc.motion.enabled && (effectiveOrbit(doc.motion) > 0 || doc.objects.some((object) => object.motion.kind !== 'none'));
  if (!hidden && !moves) return false;
  return !sameValue(sortedMasks(doc), doc.analysis.plate?.forMasks ?? null);
}

/**
 * The disparity the loop camera keeps still: `motion.focus` when set, else the
 * depth median of the first object marked the subject, when it has depth
 * statistics, else the frame's depth median, else null.
 */
export function anchorDisparity(doc: SceneDocument): number | null {
  if (doc.motion.focus !== null) return doc.motion.focus;
  const subjectDepth = doc.objects.find((object) => object.subject)?.produced.depth ?? null;
  if (subjectDepth !== null) return subjectDepth.median;
  return doc.analysis.depth?.stats.median ?? null;
}

// ---------------------------------------------------------------------------
// the loop's motion

/**
 * The largest camera offset, in frame fractions, at which no point moves
 * farther than the effective parallax margin, since the parallax gain
 * scales the farthest point from the anchor to move by exactly the offset;
 * 0 when the document has no depth map, even with a focus set, since then no
 * point has a disparity to move by. With a depth map, anchorDisparity is
 * never null.
 */
export function parallaxClamp(doc: SceneDocument): number {
  return doc.analysis.depth === null ? 0 : parallaxMargin(doc.motion.parallax);
}

/** The loop camera's path amplitude, in frame fractions: effective Drift times the parallax clamp, 0 while motion is off. */
export function cameraRadius(doc: SceneDocument): number {
  return effectiveOrbit(doc.motion) * parallaxClamp(doc);
}

/**
 * The bound on the motion of the object `id`, along each axis, 0..1:
 * motionBound of its motion, its bounds, and the master's size while motion
 * is on, and 0 on both axes while motion is off or when no object has the id,
 * so an object moves only while `motion.enabled` is on.
 */
export function objectMotionBound(doc: SceneDocument, id: ObjectId): Vec2 {
  const object = doc.objects.find((candidate) => candidate.id === id);
  if (object === undefined || !doc.motion.enabled) return { x: 0, y: 0 };
  return motionBound(object.motion, object.produced.bounds, doc.frame.master.size);
}

/**
 * Every asset the document references: the source when it is kept, the
 * master, the depth map, the plate's image, and every object's mask. A
 * plate's `forMasks` is not a reference: it names the mask set the plate was
 * made for, for comparison, and each of those masks still in use is an
 * object's mask.
 */
export function assetRefs(doc: SceneDocument): ReadonlySet<AssetId> {
  const refs = new Set<AssetId>();
  if (doc.frame.source !== null) refs.add(doc.frame.source.asset);
  refs.add(doc.frame.master.asset);
  if (doc.analysis.depth !== null) refs.add(doc.analysis.depth.map.asset);
  if (doc.analysis.plate !== null) refs.add(doc.analysis.plate.image.asset);
  for (const object of doc.objects) refs.add(object.produced.mask.asset);
  return refs;
}

// ---------------------------------------------------------------------------
// reconcile

/** The analysis operations a need runs, each of which the driver can block after repeated failures. */
export type AnalysisOp = 'depth' | 'encode' | 'decode' | 'inpaint';

/**
 * What the session wants beside the document: `objectsActive`, set by the UI,
 * is true while the Objects tab is open; `tapPending`, the driver's own, is
 * true while a tap waits on embeddings that do not exist yet.
 */
export type Intent = { readonly objectsActive: boolean; readonly tapPending: boolean };

/** Whether the driver holds embeddings for `frame.master.asset`, in memory or in this device's cache. */
export type CacheIndex = { readonly embeddings: boolean };

/** One step of analysis the document still needs. `encode` fills the driver's embeddings cache, not the document. */
export type Need =
  | { readonly kind: 'depth' }
  | { readonly kind: 'encode' }
  | { readonly kind: 'auto-subject' }
  | { readonly kind: 'plate'; readonly forMasks: readonly AssetId[] };

/** The operations each need runs; a need is omitted when any of its operations is blocked. */
export const NEED_OPS: Readonly<Record<Need['kind'], readonly AnalysisOp[]>> = {
  depth: ['depth'],
  encode: ['encode'],
  'auto-subject': ['encode', 'decode'],
  plate: ['inpaint'],
};

/**
 * What the document is missing or holds stale, in dependency order, `depth`,
 * `encode`, `auto-subject`, `plate`, each listed need's inputs existing
 * already or listed before it:
 * - `depth` when `analysis.depth` is null.
 * - `encode` when the cache lacks embeddings and the subject is wanted, or
 *   `intent.objectsActive`, or `intent.tapPending`.
 * - `auto-subject` when the subject is wanted and embeddings exist or
 *   `encode` is listed.
 * - `plate`, for the current sorted masks, when `plateNeeded(doc)`.
 * The subject is wanted when `analysis.autoSubject` is `pending`, the scene
 * has no object, and depth exists or is listed. A need any of whose
 * operations is in `blocked` is omitted, and "listed" means listed after that
 * omission, so a blocked `depth` also unlists the guess and the encoder run
 * that existed only for it. Timing (debounce, cooldown, visibility) is the
 * driver's.
 */
export function reconcile(doc: SceneDocument, cache: CacheIndex, blocked: ReadonlySet<AnalysisOp>, intent: Intent): readonly Need[] {
  const plan: Need[] = [];
  const list = (need: Need): boolean => {
    if (NEED_OPS[need.kind].some((op) => blocked.has(op))) return false;
    plan.push(need);
    return true;
  };
  const depthListed = doc.analysis.depth === null && list({ kind: 'depth' });
  const subjectWanted = doc.analysis.autoSubject === 'pending' && doc.objects.length === 0 && (doc.analysis.depth !== null || depthListed);
  const encodeListed = !cache.embeddings && (subjectWanted || intent.objectsActive || intent.tapPending) && list({ kind: 'encode' });
  if (subjectWanted && (cache.embeddings || encodeListed)) list({ kind: 'auto-subject' });
  if (plateNeeded(doc)) list({ kind: 'plate', forMasks: sortedMasks(doc) });
  return plan;
}
