// The motion a loop is made of: the loop crop, the effective camera orbit, the
// frame count, the phase, the camera's path and the parallax it gives a point,
// and the three object motions with the bound that keeps a moving object
// inside the frame. The loop crop is written here and nowhere else: every
// module that needs the margin or the zoom imports them from here.
// The functions over plain numbers are the reference the renderer's shaders
// are to evaluate and be tested against.
// Pure: no browser global, no Node API, no I/O, no clock, no randomness.

import type { Rect, Size } from './raster.ts';
import type { Motion, ObjectMotion } from './types.ts';

/** A pair of numbers along x and y; each function names its units. */
export type Vec2 = { readonly x: number; readonly y: number };

// ---------------------------------------------------------------------------
// the loop crop

/** The frame fraction a loop at Parallax 1 hides on each side. */
export const PARALLAX_MARGIN = 0.02;

/** The crop and maximum camera travel on each axis at the given Parallax amount. */
export function parallaxMargin(parallax: number): number {
  return PARALLAX_MARGIN * parallax;
}

/** The zoom that keeps the effective margin covered, about the frame center. */
export function loopZoom(parallax: number): number {
  return 1 / (1 - 2 * parallaxMargin(parallax));
}

/**
 * The loop camera's zoom about the frame center while the effective orbit is
 * above 0: it shows the central `1 - 2 * PARALLAX_MARGIN` of each axis, so a
 * displacement of at most PARALLAX_MARGIN never uncovers the frame's edge.
 */
export const LOOP_ZOOM = loopZoom(1);

/**
 * The camera orbit a loop runs with: `motion.drift.amount` while motion is on, and 0
 * while it is off. The loop camera, which the renderer is to build, is to be
 * the identity at 0, so a loop keeps the still's framing, and to zoom by
 * LOOP_ZOOM above 0.
 */
export function effectiveOrbit(motion: Motion): number {
  return motion.enabled ? motion.drift.amount : 0;
}

// ---------------------------------------------------------------------------
// frames and phase

/**
 * How close to a half a product must lie to count as that half in frameCount:
 * a decimal loopSeconds is not exact in binary, so 2.3 * 25, which is 57.5 in
 * decimal, comes out as 57.49999999999999.
 */
const HALF_TOLERANCE = 1e-9;

/**
 * The number of frames in one loop at `fps` frames per second:
 * `round(loopSeconds * fps)`, a half rounded up (37.5 frames is 38), and at
 * least 1. A product within HALF_TOLERANCE of a half counts as the half, so the
 * count is the one decimal arithmetic gives. Every periodic term runs a whole
 * number of cycles over these frames, so the loop closes at any rate. Throws a
 * RangeError for an fps that is not a finite number above 0, which no output
 * rate is.
 */
export function frameCount(motion: Motion, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError(`frameCount needs a finite fps above 0, not ${fps}`);
  return Math.max(1, Math.floor(motion.loopSeconds * fps + 0.5 + HALF_TOLERANCE));
}

/** The phase of loop frame `frame`: `frame / count`, 0 at frame 0 and 1 at frame `count`, which shows frame 0 again. */
export function loopPhase(frame: number, count: number): number {
  return frame / count;
}

/**
 * Where a term of `cycles` whole cycles per loop is in its cycle at `phase`,
 * in turns from 0 up to 1: the fractional part of `cycles * phase`. With a
 * whole number of cycles, phase 1 gives 0, exactly as phase 0 does, so every
 * term built on it has the same value at both, bit for bit.
 */
export function cycleTurn(cycles: number, phase: number): number {
  const turns = cycles * phase;
  return turns - Math.floor(turns);
}

function sineOfTurn(turn: number): number {
  return Math.sin(2 * Math.PI * turn);
}

// ---------------------------------------------------------------------------
// the camera

/** Cycles per loop of the camera's circle. */
export const CAMERA_CYCLES = 1;

/**
 * The camera's offset at `phase`, in frame fractions: a circle of `radius`
 * about the still's position, `(radius cos 2 pi s, radius sin 2 pi s)` with
 * `s = cycleTurn(CAMERA_CYCLES, phase)`. The radius is the effective orbit
 * times the parallax clamp. The circle is in frame fractions of each axis,
 * so on a frame that is not square it is an ellipse in pixels, and the
 * margin, a fraction of each axis, is used in full on both. Side and vertical
 * retain only their named axis; every path closes exactly at phase 1.
 */
export function cameraOffset(radius: number, phase: number, direction: Motion['drift']['direction'] = 'circle'): Vec2 {
  const angle = 2 * Math.PI * cycleTurn(CAMERA_CYCLES, phase);
  switch (direction) {
    case 'side': return { x: radius * Math.cos(angle), y: 0 };
    case 'vertical': return { x: 0, y: radius * Math.sin(angle) };
    case 'circle': return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    default: { const exhaustive: never = direction; return exhaustive; }
  }
}

/**
 * How far, in disparity, the farthest possible point lies from the anchor:
 * `max(anchor, 1 - anchor)`. The depth map is normalized to 0..1, so its
 * farthest point from the anchor lies at 0 or at 1. The parallax gain is
 * `1 / parallaxReach(anchor)`, at most 2 (an anchor of 0.5) and at least 1
 * (an anchor of 0 or 1).
 */
export function parallaxReach(anchor: number): number {
  return Math.max(anchor, 1 - anchor);
}

/**
 * The displacement of a point at `disparity`, in frame fractions, for a camera
 * at `offset`: `offset * (disparity - anchor) * gain`, computed as a division
 * by parallaxReach, so a point at 0 or 1 that is the farthest from the anchor
 * moves by exactly `offset`, and a point at the anchor by exactly 0. For a
 * disparity in 0..1 no point moves farther than `offset`.
 */
export function parallaxDisplacement(offset: Vec2, disparity: number, anchor: number): Vec2 {
  const scale = (disparity - anchor) / parallaxReach(anchor);
  return { x: offset.x * scale, y: offset.y * scale };
}

// ---------------------------------------------------------------------------
// object motion

/** Bob's peak, in object heights, at amount 1 and bound 1. */
export const BOB_AMPLITUDE = 0.15;
/** Cycles per loop of bob. */
export const BOB_CYCLES = 1;
/** Sway's peak angle in radians at amount 1 and bound 1: the top center's arc of 0.10 object heights, divided by the height, its distance from the pivot. */
export const SWAY_ANGLE = 0.1;
/** Cycles per loop of sway. */
export const SWAY_CYCLES = 1;
/** Wobble's peak on each axis, in object heights, at amount 1 and bound 1. */
export const WOBBLE_AMPLITUDE = 0.03;
/** Cycles per loop of wobble's sine along x. */
export const WOBBLE_X_CYCLES = 2;
/** Cycles per loop of wobble's sine along y. */
export const WOBBLE_Y_CYCLES = 3;

/** No displacement, and the bound of an object that does not move. */
const STILL: Vec2 = { x: 0, y: 0 };

/**
 * Bob's vertical displacement in master pixels, positive downward:
 * `BOB_AMPLITUDE * amount * boundY * height * sin(2 pi s)` with
 * `s = cycleTurn(BOB_CYCLES, phase)`, `height` the object's bounds height in
 * master pixels. Every point of the object moves by the same amount.
 */
export function bobOffset(amount: number, boundY: number, height: number, phase: number): number {
  return BOB_AMPLITUDE * amount * boundY * height * sineOfTurn(cycleTurn(BOB_CYCLES, phase));
}

/**
 * Sway's angle in radians at `phase`, about the bottom center of the object's
 * bounds: `SWAY_ANGLE * amount * boundX * sin(2 pi s)` with
 * `s = cycleTurn(SWAY_CYCLES, phase)`. The top center lies the bounds height
 * from the pivot, so its arc is that height times the angle, peaking at
 * `0.10 * amount * boundX * height`.
 */
export function swayAngle(amount: number, boundX: number, phase: number): number {
  return SWAY_ANGLE * amount * boundX * sineOfTurn(cycleTurn(SWAY_CYCLES, phase));
}

/**
 * The displacement, in master pixels, of a point `at` the given offset from
 * the pivot (master pixels, y downward) when the object turns by `angle`
 * radians about the pivot. The pivot itself moves by exactly 0, and at an
 * angle of 0 every point does, however far from the pivot.
 */
export function swayDisplacement(at: Vec2, angle: number): Vec2 {
  if (angle === 0) return STILL;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: at.x * (cos - 1) - at.y * sin, y: at.x * sin + at.y * (cos - 1) };
}

/**
 * Wobble's displacement in master pixels of the point at `(u, v)` across the
 * object's bounds (each 0 at the left or top edge and 1 at the right or
 * bottom): along x, `WOBBLE_AMPLITUDE * amount * boundX * height *
 * sin(2 pi cycleTurn(WOBBLE_X_CYCLES, phase)) * cos(pi v)`, and along y the
 * same with `boundY`, WOBBLE_Y_CYCLES, and `cos(pi u)`. The weight runs from
 * 1 at one edge of the bounds to -1 at the other, so opposite edges move
 * opposite ways and the outline bends rather than only moving; each axis
 * stays within `0.03 * amount * bound * height`, and every point is at rest
 * at phase 0, as bob's and sway's are.
 */
export function wobbleDisplacement(amount: number, boundX: number, boundY: number, height: number, u: number, v: number, phase: number): Vec2 {
  const peak = WOBBLE_AMPLITUDE * amount * height;
  return {
    x: peak * boundX * sineOfTurn(cycleTurn(WOBBLE_X_CYCLES, phase)) * Math.cos(Math.PI * v),
    y: peak * boundY * sineOfTurn(cycleTurn(WOBBLE_Y_CYCLES, phase)) * Math.cos(Math.PI * u),
  };
}

/**
 * The displacement, in master pixels, that an object's own motion gives its
 * point `at` (master pixels) at `phase`, for an object with `bounds` and
 * the bound `bound` that objectMotionBound gives it: 0 for `none`, bob's
 * offset along y, sway's turn about the bottom center of `bounds`, or wobble
 * at the point's position across `bounds`.
 */
export function objectDisplacement(motion: ObjectMotion, bound: Vec2, bounds: Rect, at: Vec2, phase: number): Vec2 {
  switch (motion.kind) {
    case 'none':
      return STILL;
    case 'bob':
      return { x: 0, y: bobOffset(motion.amount, bound.y, bounds.height, phase) };
    case 'sway': {
      const pivot = { x: at.x - (bounds.x + bounds.width / 2), y: at.y - (bounds.y + bounds.height) };
      return swayDisplacement(pivot, swayAngle(motion.amount, bound.x, phase));
    }
    case 'wobble': {
      const u = bounds.width > 0 ? (at.x - bounds.x) / bounds.width : 0;
      const v = bounds.height > 0 ? (at.y - bounds.y) / bounds.height : 0;
      return wobbleDisplacement(motion.amount, bound.x, bound.y, bounds.height, u, v, phase);
    }
    default: {
      const exhaustive: never = motion;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// the bound on object motion

/** The fraction of `reach` that fits in `gap`, at most 1; 1 when nothing moves along the axis. */
function fit(gap: number, reach: number): number {
  return reach > 0 ? Math.min(1, gap / reach) : 1;
}

/**
 * The largest angle in 0..SWAY_ANGLE at which a turn about the pivot, either
 * way, moves no point of the bounds out past an edge `gap` away, where the
 * bounds' outward reach toward that edge at angle `t` is
 * `along * sin t - across * (1 - cos t)`, with `along` and `across` the
 * bounds' extents from the pivot that make it up. The reach grows up to
 * `t = atan2(along, across)` and falls after it, so when the full angle does
 * not fit, the answer solves `reach = gap` on the rising part: with
 * `R = hypot(along, across)`, `t = asin((gap + across) / R) - atan2(across, along)`.
 * A gap of 0, bounds that touch or cross the edge, gives 0, since any turn
 * moves some point of the bounds along that edge's normal.
 */
function swayFit(along: number, across: number, gap: number): number {
  if (gap <= 0) return 0;
  const reach = (angle: number): number => along * Math.sin(angle) - across * (1 - Math.cos(angle));
  if (reach(Math.min(SWAY_ANGLE, Math.atan2(along, across))) <= gap) return SWAY_ANGLE;
  // Rounding can put the ratio a hair above 1 when the gap is the peak reach to
  // within an ulp; asin would then give NaN, so the ratio is held at 1.
  const angle = Math.asin(Math.min(1, (gap + across) / Math.hypot(along, across))) - Math.atan2(across, along);
  return Math.min(Math.max(angle, 0), SWAY_ANGLE);
}

/**
 * The bound on an object's motion along each axis, 0..1: the largest fraction
 * of the motion at amount 1 that moves no point of `bounds` (master pixels)
 * out of a frame of `frame`, and 0 on an axis whose edge the bounds touch or
 * cross, so a cut edge does not move toward or away from its frame edge. An
 * object at least its motion's reach from every edge gets 1.
 * Bob and wobble move each axis the same distance both ways, so each axis's
 * bound is the fraction of that distance that fits the gap to the nearer edge
 * on it; an axis they do not move along gets 1. Sway turns by one angle, so it
 * gets one bound on both axes: the fraction of SWAY_ANGLE at which the turned
 * bounds stay inside the left, right, top, and bottom edges, each with its own
 * reach, and 0 when the bounds touch or cross any edge. The bound does not
 * depend on the amount, so halving the amount halves the motion, and every
 * amount up to 1 stays inside the frame. `none` gets 0.
 */
export function motionBound(motion: ObjectMotion, bounds: Rect, frame: Size): Vec2 {
  const left = bounds.x;
  const right = frame.width - (bounds.x + bounds.width);
  const top = bounds.y;
  const bottom = frame.height - (bounds.y + bounds.height);
  const gapX = Math.max(0, Math.min(left, right));
  const gapY = Math.max(0, Math.min(top, bottom));
  switch (motion.kind) {
    case 'none':
      return STILL;
    case 'bob':
      return { x: 1, y: fit(gapY, BOB_AMPLITUDE * bounds.height) };
    case 'wobble':
      return { x: fit(gapX, WOBBLE_AMPLITUDE * bounds.height), y: fit(gapY, WOBBLE_AMPLITUDE * bounds.height) };
    case 'sway': {
      // The pivot is the bottom center: a point of the bounds lies up to half
      // the width to either side of it and up to the height above it.
      const half = bounds.width / 2;
      const angle = Math.min(
        swayFit(bounds.height, half, gapX), // sideways: the top corners swing out, the bottom ones in
        swayFit(half, bounds.height, top), // up: a top corner rises, its height pulling it back down
        swayFit(half, 0, bottom), // down: a bottom corner dips
      );
      const bound = angle / SWAY_ANGLE;
      return { x: bound, y: bound };
    }
    default: {
      const exhaustive: never = motion;
      return exhaustive;
    }
  }
}
