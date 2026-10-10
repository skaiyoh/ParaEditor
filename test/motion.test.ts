// The motion a loop is made of: the loop crop's constants, the effective orbit,
// the frame count, closure of every periodic term, the camera's parallax and
// its clamp, the amplitudes of bob, sway, and wobble, the bound on an object's
// motion, and, on the fixtures and on generated documents with objects at and
// across the frame edge, that motion keeps every object inside the frame and
// moves nothing at a frame edge inward by more than PARALLAX_MARGIN.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorDisparity, cameraRadius, holeRadius, objectMotionBound, parallaxClamp } from '../src/core/derive.ts';
import {
  BOB_AMPLITUDE,
  bobOffset,
  cameraOffset,
  cycleTurn,
  effectiveOrbit,
  frameCount,
  LOOP_ZOOM,
  loopZoom,
  loopPhase,
  motionBound,
  objectDisplacement,
  PARALLAX_MARGIN,
  parallaxMargin,
  parallaxDisplacement,
  parallaxReach,
  SWAY_ANGLE,
  swayAngle,
  swayDisplacement,
  WOBBLE_AMPLITUDE,
  wobbleDisplacement,
  type Vec2,
} from '../src/core/motion.ts';
import type { Rect, Size } from '../src/core/raster.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { Motion, ObjectMotion, SceneDocument, SceneObject } from '../src/core/types.ts';
import { fiveClusterDocument, validDocuments } from './fixtures/documents.ts';
import { objectId, tappedObject } from './fixtures/edits.ts';

const MOVING_KINDS = ['bob', 'sway', 'wobble'] as const;

/** True for 0 and -0. */
const isZero = (value: number): boolean => value === 0;

/** The phases of every frame of a loop of `count` frames, frame `count` (phase 1) among them, and the quarter phases where a one-cycle sine peaks. */
function phasesOf(count: number): readonly number[] {
  return [...Array.from({ length: count + 1 }, (_, frame) => loopPhase(frame, count)), 0.25, 0.75];
}

const PHASES = phasesOf(90);

/** The five-cluster document with `motion` and the given objects, and no plate. */
function withMotion(motion: Partial<Motion>, objects: readonly SceneObject[] = fiveClusterDocument().objects): SceneDocument {
  const doc = fiveClusterDocument();
  return { ...doc, motion: { ...doc.motion, ...motion }, objects: [...objects], analysis: { ...doc.analysis, plate: null } };
}

function objectWith(n: number, motion: ObjectMotion, bounds: Rect, depthMedian = 0.6): SceneObject {
  const base = tappedObject(objectId(n));
  return { ...base, motion, produced: { ...base.produced, bounds, depth: { p10: depthMedian - 0.1, median: depthMedian, p90: depthMedian + 0.1 } } };
}

/** Points on the perimeter of `bounds`, its corners and edge midpoints and quarters among them. */
function perimeter(bounds: Rect): readonly Vec2[] {
  const points: Vec2[] = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const x = bounds.x + t * bounds.width;
    const y = bounds.y + t * bounds.height;
    points.push({ x, y: bounds.y }, { x, y: bounds.y + bounds.height }, { x: bounds.x, y }, { x: bounds.x + bounds.width, y });
  }
  return points;
}

// ---------------------------------------------------------------------------
// the loop crop and the effective orbit

test('effectiveOrbit is 0 with motion off and motion.orbit with it on', () => {
  for (const orbit of [0, 0.25, 0.6, 1]) {
    const motion: Motion = { enabled: false, orbit, parallax: 1, loopSeconds: 3, focus: null };
    assert.equal(effectiveOrbit(motion), 0, `off at orbit ${orbit}`);
    assert.equal(effectiveOrbit({ ...motion, enabled: true }), orbit, `on at orbit ${orbit}`);
  }
});

test('LOOP_ZOOM shows the central 1 - 2 * PARALLAX_MARGIN of each axis', () => {
  assert.equal(PARALLAX_MARGIN, 0.02);
  assert.equal(LOOP_ZOOM, 1 / (1 - 2 * PARALLAX_MARGIN));
  assert.ok(Math.abs(LOOP_ZOOM * (1 - 2 * PARALLAX_MARGIN) - 1) < 1e-15);
});

test('Parallax preserves the default crop and scales travel while zoom covers every allowed amount', () => {
  assert.equal(parallaxMargin(1), PARALLAX_MARGIN);
  assert.equal(loopZoom(1), LOOP_ZOOM);
  assert.equal(parallaxMargin(2), 2 * PARALLAX_MARGIN);
  assert.equal(loopZoom(2), 1 / (1 - 4 * PARALLAX_MARGIN));
  for (const amount of [.5, 1, 1.7, 2, 3]) {
    const margin = parallaxMargin(amount), zoom = loopZoom(amount);
    for (const disparity of [0, .3, .5, 1]) {
      for (const focus of [0, .2, .5, .9, 1]) {
        for (const phase of PHASES) {
          const displacement = parallaxDisplacement(cameraOffset(margin, phase), disparity, focus);
          for (const delta of [displacement.x, displacement.y]) {
            assert.ok((delta - .5) * zoom + .5 <= 1e-15, `${amount}: the leading edge covers the frame`);
            assert.ok((delta + .5) * zoom + .5 >= 1 - 1e-15, `${amount}: the trailing edge covers the frame`);
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// frames and closure

test('frameCount is round(loopSeconds * fps) with a half rounded up, as decimal arithmetic gives the half, and at least 1', () => {
  const motion = (loopSeconds: number): Motion => ({ enabled: true, orbit: 0.6, parallax: 1, loopSeconds, focus: null });
  assert.equal(frameCount(motion(3), 30), 90);
  assert.equal(frameCount(motion(3), 10), 30);
  assert.equal(frameCount(motion(3), 12.5), 38, '37.5 rounds up');
  assert.equal(frameCount(motion(3), 100 / 8), 38, 'a GIF delay of 8 cs');
  assert.equal(frameCount(motion(2), 12.5), 25);
  assert.equal(frameCount(motion(6), 30), 180);
  assert.equal(frameCount(motion(2.5), 5), 13, '12.5 rounds up');
  assert.equal(frameCount(motion(2.1), 12.5), 26, '26.25 rounds down');
  assert.equal(frameCount(motion(2), 0.1), 1, 'never 0 frames');
  // A decimal loopSeconds is not exact in binary: the product falls just below the half it is in decimal.
  assert.equal(2.3 * 25, 57.49999999999999);
  assert.equal(frameCount(motion(2.3), 25), 58, '57.5 in decimal rounds up');
  assert.equal(frameCount(motion(2.01), 50), 101, '100.5 in decimal rounds up');
  assert.equal(frameCount(motion(2.3), 100 / 4), 58, 'a GIF delay of 4 cs');
  for (const fps of [Number.NaN, Infinity, -Infinity, 0, -5]) assert.throws(() => frameCount(motion(3), fps), RangeError, `fps ${fps}`);
});

test('every periodic term at phase 1 equals its value at phase 0, bit for bit, at every frame count', () => {
  for (const cycles of [1, 2, 3, 4, 7]) assert.equal(cycleTurn(cycles, 1), 0, `${cycles} cycles close`);
  const amounts = [1, 0.5, 0.37];
  const counts = new Set<number>();
  for (const loopSeconds of [2, 2.5, 3, 4.7, 6]) {
    for (const fps of [30, 10, 12.5, 100 / 6, 100 / 7, 25]) {
      const count = frameCount({ enabled: true, orbit: 1, parallax: 1, loopSeconds, focus: null }, fps);
      counts.add(count);
      const last = loopPhase(count, count);
      assert.equal(last, 1, `frame ${count} of ${count} is phase 1`);
      for (const radius of [PARALLAX_MARGIN, 0.013]) assert.deepEqual(cameraOffset(radius, last), cameraOffset(radius, 0), `camera at ${count} frames`);
      for (const amount of amounts) {
        assert.ok(Object.is(bobOffset(amount, 0.8, 500, last), bobOffset(amount, 0.8, 500, 0)), `bob at ${count} frames`);
        assert.ok(Object.is(swayAngle(amount, 0.8, last), swayAngle(amount, 0.8, 0)), `sway at ${count} frames`);
        for (const at of [{ x: -120, y: -500 }, { x: 37.5, y: -3 }]) {
          assert.deepEqual(swayDisplacement(at, swayAngle(amount, 0.8, last)), swayDisplacement(at, swayAngle(amount, 0.8, 0)));
        }
        for (const u of [0, 0.1, 0.5, 0.93, 1]) {
          for (const v of [0, 0.3, 0.77, 1]) {
            assert.deepEqual(wobbleDisplacement(amount, 0.9, 0.6, 500, u, v, last), wobbleDisplacement(amount, 0.9, 0.6, 500, u, v, 0), `wobble at ${count} frames, (${u}, ${v})`);
          }
        }
      }
    }
  }
  assert.ok(counts.size >= 10, `${counts.size} distinct frame counts`);
  // Every kind through objectDisplacement, on the fixture's objects.
  const doc = fiveClusterDocument();
  for (const object of doc.objects) {
    for (const kind of MOVING_KINDS) {
      const motion: ObjectMotion = { kind, amount: 1 };
      const bound = { x: 0.7, y: 0.9 };
      for (const at of perimeter(object.produced.bounds)) {
        assert.deepEqual(objectDisplacement(motion, bound, object.produced.bounds, at, 1), objectDisplacement(motion, bound, object.produced.bounds, at, 0), `${kind} on ${object.name}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// the camera's parallax

test('parallaxClamp never exceeds PARALLAX_MARGIN, and is 0 without a depth map, a focus set or not', () => {
  for (const doc of [...validDocuments(), ...generatedDocuments().map(({ doc }) => doc)]) {
    assert.ok(parallaxClamp(doc) <= PARALLAX_MARGIN);
    assert.ok(cameraRadius(doc) <= PARALLAX_MARGIN);
    assert.equal(parallaxClamp(doc), doc.analysis.depth === null ? 0 : PARALLAX_MARGIN);
    if (doc.analysis.depth !== null) assert.notEqual(anchorDisparity(doc), null, 'a depth map always gives an anchor');
  }
  const [minimal] = validDocuments();
  assert.ok(minimal !== undefined && minimal.analysis.depth === null && anchorDisparity(minimal) === null);
  assert.equal(parallaxClamp(minimal), 0);
  // A focus set before depth exists gives an anchor, but no point has a disparity, so the camera stays still.
  const focused: SceneDocument = { ...minimal, motion: { ...minimal.motion, enabled: true, orbit: 1, focus: 0.4 } };
  assert.ok(parseDocument(focused).ok);
  assert.equal(anchorDisparity(focused), 0.4);
  assert.equal(parallaxClamp(focused), 0);
  assert.equal(cameraRadius(focused), 0);
  assert.equal(cameraRadius(withMotion({ enabled: false, orbit: 1 })), 0, 'motion off: no camera circle');
});

test('Parallax 1 preserves the camera and hole, 2 doubles their travel, and the still has zero offset at every amount', () => {
  const one = withMotion({ enabled: true, orbit: .6, parallax: 1 });
  const two = withMotion({ enabled: true, orbit: .6, parallax: 2 });
  assert.equal(parallaxClamp(one), .02);
  assert.equal(cameraRadius(one), .6 * .02);
  assert.equal(holeRadius(one, { width: 2048, height: 1536 }), 21);
  assert.equal(parallaxClamp(two), 2 * parallaxClamp(one));
  assert.equal(cameraRadius(two), 2 * cameraRadius(one));
  assert.equal(holeRadius(two, { width: 2048, height: 1536 }), 2 * holeRadius(one, { width: 2048, height: 1536 }));
  for (const phase of PHASES) {
    const first = cameraOffset(cameraRadius(one), phase), doubled = cameraOffset(cameraRadius(two), phase);
    assert.deepEqual(doubled, { x: 2 * first.x, y: 2 * first.y });
  }
  for (const parallax of [.5, 1, 1.7, 2, 3]) {
    const still = withMotion({ enabled: false, orbit: 1, parallax });
    assert.equal(cameraRadius(still), 0);
    const offset = cameraOffset(cameraRadius(still), 0);
    assert.deepEqual(offset, { x: 0, y: 0 });
    for (const object of still.objects) assert.deepEqual(objectMotionBound(still, object.id), { x: 0, y: 0 });
    const noDepth = { ...still, analysis: { ...still.analysis, depth: null } };
    assert.equal(parallaxClamp(noDepth), 0);
    assert.equal(cameraRadius({ ...still, motion: { ...still.motion, enabled: true, orbit: 0 } }), 0);
  }
});

test('at orbit 1 the point farthest from the anchor moves by exactly the clamp, and no point farther', () => {
  for (const focus of [0, 0.1, 0.3, 0.5, 0.7, 0.95, 1]) {
    const doc = withMotion({ enabled: true, orbit: 1, focus });
    const anchor = anchorDisparity(doc);
    assert.equal(anchor, focus);
    if (anchor === null) continue;
    const clamp = parallaxClamp(doc);
    assert.equal(cameraRadius(doc), clamp);
    const farthest = anchor >= 0.5 ? 0 : 1;
    const start = parallaxDisplacement(cameraOffset(cameraRadius(doc), 0), farthest, anchor);
    assert.equal(Math.hypot(start.x, start.y), clamp, `focus ${focus}: the farthest point moves by exactly the clamp`);
    for (const phase of PHASES) {
      const moved = parallaxDisplacement(cameraOffset(cameraRadius(doc), phase), farthest, anchor);
      assert.ok(Math.abs(Math.hypot(moved.x, moved.y) - clamp) <= 4 * Number.EPSILON * clamp, `focus ${focus}, phase ${phase}: on the circle of the clamp`);
      for (let d = 0; d <= 1; d += 1 / 32) {
        const point = parallaxDisplacement(cameraOffset(cameraRadius(doc), phase), d, anchor);
        assert.ok(Math.abs(point.x) <= clamp && Math.abs(point.y) <= clamp, `focus ${focus}, phase ${phase}, disparity ${d}: within the clamp on each axis`);
      }
    }
    // At orbit 0.5 the farthest point moves by half the clamp.
    const half = withMotion({ enabled: true, orbit: 0.5, focus });
    const halfMoved = parallaxDisplacement(cameraOffset(cameraRadius(half), 0), farthest, anchor);
    assert.equal(Math.hypot(halfMoved.x, halfMoved.y), clamp / 2);
  }
  assert.equal(parallaxReach(0.5), 0.5);
  assert.equal(parallaxReach(0.2), 0.8);
});

test('setting focus to a disparity makes a point at that disparity move by zero', () => {
  for (const focus of [0, 0.25, 0.42, 0.7, 1]) {
    const doc = withMotion({ enabled: true, orbit: 1, focus });
    for (const phase of PHASES) {
      const moved = parallaxDisplacement(cameraOffset(cameraRadius(doc), phase), focus, focus);
      assert.ok(isZero(moved.x) && isZero(moved.y), `focus ${focus}, phase ${phase}`);
    }
  }
  // Without a focus the anchor is the subject's median, and the subject stays still.
  const doc = withMotion({ enabled: true, orbit: 1, focus: null });
  const subjectMedian = doc.objects.find((object) => object.subject)?.produced.depth?.median;
  assert.equal(anchorDisparity(doc), subjectMedian);
});

// ---------------------------------------------------------------------------
// object motion

test('bob peaks at 0.15 * amount * bound.y * height, and halving the amount halves it', () => {
  assert.equal(BOB_AMPLITUDE, 0.15);
  for (const amount of [1, 0.5, 0.37]) {
    for (const bound of [1, 0.4]) {
      const height = 500;
      const peak = 0.15 * amount * bound * height;
      assert.equal(bobOffset(amount, bound, height, 0.25), peak, 'the peak at a quarter cycle');
      assert.equal(bobOffset(amount, bound, height, 0.75), -peak, 'the other peak at three quarters');
      for (const phase of PHASES) {
        assert.ok(Math.abs(bobOffset(amount, bound, height, phase)) <= peak);
        assert.equal(bobOffset(amount / 2, bound, height, phase), bobOffset(amount, bound, height, phase) / 2, `halved at phase ${phase}`);
      }
    }
  }
});

test('sway keeps the bottom center fixed while the top center arcs 0.10 * amount * bound.x * height, and halving the amount halves it', () => {
  assert.equal(SWAY_ANGLE, 0.1);
  const bounds: Rect = { x: 300, y: 200, width: 600, height: 500 };
  const bottomCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  const topCenter = { x: bottomCenter.x, y: bounds.y };
  for (const amount of [1, 0.5, 0.37]) {
    for (const bound of [1, 0.4]) {
      const motion: ObjectMotion = { kind: 'sway', amount };
      const arcPeak = 0.1 * amount * bound * bounds.height;
      assert.equal(bounds.height * Math.abs(swayAngle(amount, bound, 0.25)), arcPeak, 'the top arc at its peak');
      for (const phase of PHASES) {
        const fixed = objectDisplacement(motion, { x: bound, y: bound }, bounds, bottomCenter, phase);
        assert.ok(isZero(fixed.x) && isZero(fixed.y), `the bottom center at phase ${phase}`);
        const angle = swayAngle(amount, bound, phase);
        assert.ok(bounds.height * Math.abs(angle) <= arcPeak);
        assert.equal(swayAngle(amount / 2, bound, phase), angle / 2, `halved at phase ${phase}`);
        // The top center travels on the circle of the bounds height about the bottom center: the chord of its arc.
        const top = objectDisplacement(motion, { x: bound, y: bound }, bounds, topCenter, phase);
        const chord = 2 * bounds.height * Math.sin(Math.abs(angle) / 2);
        assert.ok(Math.abs(Math.hypot(top.x, top.y) - chord) < 1e-9, `the top center's chord at phase ${phase}`);
      }
    }
  }
});

test('wobble stays within 0.03 * amount * bound * height on each axis and reaches it, and halving the amount halves it', () => {
  assert.equal(WOBBLE_AMPLITUDE, 0.03);
  const height = 500;
  for (const amount of [1, 0.5, 0.37]) {
    const bound = { x: 1, y: 0.4 };
    const peakX = 0.03 * amount * bound.x * height;
    const peakY = 0.03 * amount * bound.y * height;
    let largestX = 0;
    let largestY = 0;
    for (const phase of phasesOf(360)) {
      for (let u = 0; u <= 1; u += 0.125) {
        for (let v = 0; v <= 1; v += 0.125) {
          const moved = wobbleDisplacement(amount, bound.x, bound.y, height, u, v, phase);
          assert.ok(Math.abs(moved.x) <= peakX * (1 + 1e-12) && Math.abs(moved.y) <= peakY * (1 + 1e-12));
          largestX = Math.max(largestX, Math.abs(moved.x));
          largestY = Math.max(largestY, Math.abs(moved.y));
          const halved = wobbleDisplacement(amount / 2, bound.x, bound.y, height, u, v, phase);
          assert.ok(halved.x === moved.x / 2 && halved.y === moved.y / 2, `halved at phase ${phase}, (${u}, ${v})`);
        }
      }
    }
    assert.ok(largestX >= peakX * 0.999 && largestY >= peakY * 0.999, `the peaks are reached: ${largestX} of ${peakX}, ${largestY} of ${peakY}`);
  }
  // Opposite edges move opposite ways, so the outline changes shape: the top and bottom rows move apart, and so do the left and right columns.
  const top = wobbleDisplacement(1, 1, 1, height, 0.5, 0, 0.1);
  const bottom = wobbleDisplacement(1, 1, 1, height, 0.5, 1, 0.1);
  assert.ok(Math.abs(top.x - bottom.x) > 1);
  const left = wobbleDisplacement(1, 1, 1, height, 0, 0.5, 0.1);
  const right = wobbleDisplacement(1, 1, 1, height, 1, 0.5, 0.1);
  assert.ok(Math.abs(left.y - right.y) > 1);
});

test('every object motion is at rest at phase 0, so frame 0 of a loop shows each object where the still does', () => {
  const bounds: Rect = { x: 300, y: 200, width: 600, height: 500 };
  for (const kind of MOVING_KINDS) {
    for (const amount of [1, 0.37]) {
      for (const at of [...perimeter(bounds), { x: 600, y: 450 }, { x: 0, y: 0 }]) {
        const moved = objectDisplacement({ kind, amount }, { x: 1, y: 1 }, bounds, at, 0);
        assert.ok(isZero(moved.x) && isZero(moved.y), `${kind} ${amount} at (${at.x}, ${at.y}): (${moved.x}, ${moved.y})`);
      }
    }
  }
  // Sway at angle 0 moves nothing, however far a point lies from the pivot.
  const far = swayDisplacement({ x: 5, y: -Infinity }, 0);
  assert.ok(isZero(far.x) && isZero(far.y));
});

test('with motion off no object moves, whatever motion it keeps', () => {
  const objects = MOVING_KINDS.map((kind, i) => objectWith(i, { kind, amount: 1 }, { x: 600, y: 400, width: 500, height: 400 }));
  for (const doc of [withMotion({ enabled: false, orbit: 1 }, objects), withMotion({ enabled: false, orbit: 0 }), { ...fiveClusterDocument(), motion: { ...fiveClusterDocument().motion, enabled: false } }]) {
    for (const object of doc.objects) {
      const bound = objectMotionBound(doc, object.id);
      assert.deepEqual(bound, { x: 0, y: 0 }, `${object.name}'s bound`);
      for (const phase of PHASES) {
        for (const at of perimeter(object.produced.bounds)) {
          const moved = objectDisplacement(object.motion, bound, object.produced.bounds, at, phase);
          assert.ok(isZero(moved.x) && isZero(moved.y), `${object.name} (${object.motion.kind}) at phase ${phase}`);
        }
      }
    }
    assert.equal(cameraRadius(doc), 0);
  }
  // The same objects move once motion is on.
  const on = withMotion({ enabled: true, orbit: 0 }, objects);
  for (const object of on.objects) assert.notDeepEqual(objectMotionBound(on, object.id), { x: 0, y: 0 });
  assert.deepEqual(objectMotionBound(on, objectId(99)), { x: 0, y: 0 }, 'an unknown id');
});

test('motionBound is 1 well inside the frame and falls to 0 as the bounds reach the edge', () => {
  const frame: Size = { width: 2048, height: 1536 };
  const size = { width: 400, height: 300 };
  for (const kind of MOVING_KINDS) {
    const motion: ObjectMotion = { kind, amount: 1 };
    assert.deepEqual(motionBound(motion, { x: 800, y: 600, ...size }, frame), { x: 1, y: 1 }, `${kind} well inside`);
    // The axis the motion is bounded on as the bounds approach the left and then the top edge.
    const axes = kind === 'bob' ? (['y'] as const) : (['x', 'y'] as const);
    for (const axis of axes) {
      let previous = Infinity;
      for (let gap = 200; gap >= 0; gap -= 0.5) {
        const bounds = axis === 'x' ? { x: gap, y: 600, ...size } : { x: 800, y: gap, ...size };
        const bound = motionBound(motion, bounds, frame)[axis];
        assert.ok(bound >= 0 && bound <= 1);
        assert.ok(bound <= previous, `${kind} along ${axis}: no larger nearer the edge (gap ${gap})`);
        previous = bound;
      }
      assert.equal(previous, 0, `${kind} along ${axis}: 0 touching the edge`);
      // Touching the opposite edge, and crossing it, is 0 as well.
      const far = axis === 'x' ? { x: frame.width - size.width, y: 600, ...size } : { x: 800, y: frame.height - size.height, ...size };
      assert.equal(motionBound(motion, far, frame)[axis], 0);
      const across = axis === 'x' ? { x: frame.width - 100, y: 600, ...size } : { x: 800, y: frame.height - 100, ...size };
      assert.equal(motionBound(motion, across, frame)[axis], 0);
    }
  }
  // Each kind's bound is the fraction of its reach at amount 1 that fits the gap.
  const { height } = size;
  assert.equal(motionBound({ kind: 'bob', amount: 0.2 }, { x: 800, y: 0.075 * height, ...size }, frame).y, 0.5);
  assert.equal(motionBound({ kind: 'wobble', amount: 0.2 }, { x: 0.015 * height, y: 600, ...size }, frame).x, 0.5);
  assert.equal(motionBound({ kind: 'bob', amount: 1 }, { x: 0, y: 600, ...size }, frame).x, 1, 'bob does not move along x');
  // Sway turns by one angle, bounded by every edge: it stops for bounds on the bottom edge.
  assert.deepEqual(motionBound({ kind: 'sway', amount: 1 }, { x: 800, y: frame.height - size.height, ...size }, frame), { x: 0, y: 0 });
});

test('objectMotionBound is motionBound of the object over the master size while motion is on', () => {
  const placements: readonly Rect[] = [
    { x: 800, y: 600, width: 400, height: 300 },
    { x: 0, y: 600, width: 400, height: 300 },
    { x: 800, y: 30, width: 400, height: 300 },
    { x: 1700, y: 1500, width: 400, height: 300 },
  ];
  for (const frame of FRAMES) {
    for (const [i, bounds] of placements.entries()) {
      for (const kind of [...MOVING_KINDS, 'none'] as const) {
        const motion: ObjectMotion = { kind, amount: 0.6 };
        const object = objectWith(i, motion, bounds);
        const base = withMotion({ enabled: true, orbit: 0.5 }, [object]);
        const doc: SceneDocument = { ...base, frame: { ...base.frame, master: { ...base.frame.master, size: frame } } };
        assert.deepEqual(objectMotionBound(doc, object.id), motionBound(motion, bounds, frame), `${kind} at (${bounds.x}, ${bounds.y}) in ${frame.width}x${frame.height}`);
      }
    }
  }
});

/**
 * How far past the frame, in master pixels, the corners of `bounds` reach when
 * turned about its bottom center by every angle in -angle..angle: an oracle
 * that rotates the corners directly, apart from the closed form under test.
 */
function swayOverflow(bounds: Rect, frame: Size, angle: number): number {
  const pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
  let overflow = -Infinity;
  const steps = 2000;
  for (let step = -steps; step <= steps; step++) {
    const t = (angle * step) / steps;
    for (const corner of corners) {
      const dx = corner.x - pivot.x;
      const dy = corner.y - pivot.y;
      const x = pivot.x + dx * Math.cos(t) - dy * Math.sin(t);
      const y = pivot.y + dx * Math.sin(t) + dy * Math.cos(t);
      overflow = Math.max(overflow, -x, x - frame.width, -y, y - frame.height);
    }
  }
  return overflow;
}

test("sway's bound is the largest that keeps the turned bounds inside the frame", () => {
  const frame: Size = { width: 2048, height: 1536 };
  const cases: readonly Rect[] = [
    { x: 800, y: 326, width: 200, height: 1200 }, // tall, 10 px above the bottom: the full angle fits
    { x: 900, y: 531, width: 100, height: 1000 }, // tall and thin, 5 px above the bottom
    { x: 1000, y: 300, width: 1000, height: 1000 }, // 48 px from the right edge
    { x: 20, y: 400, width: 300, height: 900 }, // 20 px from the left edge
    { x: 900, y: 6, width: 300, height: 600 }, // 6 px below the top edge
    { x: 700, y: 1000, width: 1000, height: 530 }, // wide, 6 px above the bottom
    { x: 400, y: 2, width: 1200, height: 60 }, // flat and wide, 2 px below the top edge
    { x: 10, y: 10, width: 2028, height: 1516 }, // nearly the whole frame
  ];
  const fractions: number[] = [];
  for (const bounds of cases) {
    const bound = motionBound({ kind: 'sway', amount: 1 }, bounds, frame);
    assert.equal(bound.x, bound.y);
    fractions.push(bound.x);
    const label = `bounds (${bounds.x}, ${bounds.y}, ${bounds.width} x ${bounds.height}), bound ${bound.x}`;
    assert.ok(swayOverflow(bounds, frame, bound.x * SWAY_ANGLE) <= 1e-6, `${label}: stays inside`);
    // Below 1, any larger angle takes a corner past the frame.
    if (bound.x < 1) assert.ok(swayOverflow(bounds, frame, bound.x * SWAY_ANGLE * (1 + 1e-4)) > 1e-9, `${label}: is the largest`);
  }
  assert.equal(fractions[0], 1, 'a tall object near the bottom edge sways in full when the full angle fits');
  assert.equal(fractions[1], 1);
  assert.ok(fractions.slice(2).every((fraction) => fraction > 0 && fraction < 1), `${fractions.join(', ')}`);
});

test("sway's bound stays a number from 0 to 1 when the gap is the peak reach to within rounding", () => {
  const frame: Size = { width: 4096, height: 4096 };
  // A flat object turned on its side, its gap to the left edge swept across
  // the point where the peak reach equals it: rounding there once put the
  // solver's arcsine argument above 1.
  const base = 0.04999875006246017;
  for (let k = -400; k <= 400; k++) {
    const bounds: Rect = { x: base * (1 + k * 1e-13), y: 2000, width: 2000, height: 10 };
    const bound = motionBound({ kind: 'sway', amount: 1 }, bounds, frame);
    assert.ok(Number.isFinite(bound.x) && bound.x >= 0 && bound.x <= 1, `x ${bounds.x}: bound ${bound.x}`);
    assert.equal(bound.x, bound.y);
  }
});

// ---------------------------------------------------------------------------
// bounded displacement on fixtures and generated documents

type Generated = { readonly label: string; readonly doc: SceneDocument };

const FRAMES: readonly Size[] = [
  { width: 2048, height: 1536 },
  { width: 1536, height: 2048 },
  { width: 2048, height: 512 },
];

/** Bounds at, near, and across the frame's edges, as functions of the frame. */
const PLACEMENTS: readonly (readonly [string, (frame: Size) => Rect])[] = [
  ['centered', (f) => ({ x: f.width * 0.3, y: f.height * 0.3, width: f.width * 0.4, height: f.height * 0.4 })],
  ['left edge', (f) => ({ x: 0, y: f.height * 0.2, width: f.width * 0.3, height: f.height * 0.5 })],
  ['right edge', (f) => ({ x: f.width * 0.6, y: f.height * 0.2, width: f.width * 0.4, height: f.height * 0.5 })],
  ['top edge', (f) => ({ x: f.width * 0.3, y: 0, width: f.width * 0.3, height: f.height * 0.4 })],
  ['bottom edge', (f) => ({ x: f.width * 0.3, y: f.height * 0.5, width: f.width * 0.3, height: f.height * 0.5 })],
  ['top-left corner', (f) => ({ x: 0, y: 0, width: f.width * 0.25, height: f.height * 0.25 })],
  ['whole frame', (f) => ({ x: 0, y: 0, width: f.width, height: f.height })],
  ['across the right edge', (f) => ({ x: f.width * 0.8, y: f.height * 0.3, width: f.width * 0.4, height: f.height * 0.3 })],
  ['3 px from the bottom', (f) => ({ x: f.width * 0.4, y: f.height * 0.6 - 3, width: f.width * 0.2, height: f.height * 0.4 })],
  ['tall and centered', (f) => ({ x: f.width * 0.45, y: f.height * 0.04, width: f.width * 0.1, height: f.height * 0.92 })],
];

function generatedDocuments(): readonly Generated[] {
  const out: Generated[] = [];
  const base = fiveClusterDocument();
  for (const frame of FRAMES) {
    for (const enabled of [true, false]) {
      for (const orbit of [0, 0.5, 1]) {
        for (const focus of [null, 0, 0.3, 1]) {
          for (const [placement, place] of PLACEMENTS) {
            for (const kind of MOVING_KINDS) {
              for (const amount of [1, 0.37]) {
                const bounds = place(frame);
                const objects = [objectWith(0, { kind, amount }, bounds, 0.35), { ...objectWith(1, { kind: 'wobble', amount: 1 }, { x: frame.width * 0.1, y: frame.height * 0.1, width: 64, height: 48 }, 0.9), subject: true }];
                const doc: SceneDocument = {
                  ...base,
                  frame: { ...base.frame, master: { ...base.frame.master, size: frame } },
                  analysis: { ...base.analysis, plate: null },
                  motion: { enabled, orbit, parallax: 1, loopSeconds: 3, focus },
                  objects,
                };
                out.push({ label: `${frame.width}x${frame.height}, motion ${enabled ? 'on' : 'off'}, orbit ${orbit}, focus ${focus}, ${placement}, ${kind} ${amount}`, doc });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * Checks one document: every point at a frame edge, of the back layer at any
 * disparity or of an object whose bounds touch that edge, moves inward by at
 * most PARALLAX_MARGIN, camera and object motion together, the object motion
 * along that edge's normal being exactly 0; and every object's own motion
 * keeps its bounds inside the frame. Returns how many edge points it checked.
 */
function checkBounded(label: string, doc: SceneDocument): number {
  const { width, height } = doc.frame.master.size;
  const anchor = anchorDisparity(doc);
  const radius = cameraRadius(doc);
  assert.ok(radius <= PARALLAX_MARGIN, label);
  const camera = (phase: number, disparity: number): Vec2 => (anchor === null ? { x: 0, y: 0 } : parallaxDisplacement(cameraOffset(radius, phase), disparity, anchor));
  const phases = phasesOf(frameCount(doc.motion, 30));
  const slack = 1e-6;
  let edgePoints = 0;
  for (const phase of phases) {
    for (const disparity of [0, 0.25, 0.5, 0.9, 1, anchor ?? 0.5]) {
      const moved = camera(phase, disparity);
      if (Math.abs(moved.x) > PARALLAX_MARGIN || Math.abs(moved.y) > PARALLAX_MARGIN) assert.fail(`${label}: the back layer at disparity ${disparity}, phase ${phase} moves by (${moved.x}, ${moved.y})`);
    }
  }
  for (const object of doc.objects) {
    const bounds = object.produced.bounds;
    const bound = objectMotionBound(doc, object.id);
    const depth = object.produced.depth;
    const disparities = depth === null ? [0, 1] : [0, depth.p10, depth.median, depth.p90, 1];
    for (const at of perimeter(bounds)) {
      if (at.x < 0 || at.x > width || at.y < 0 || at.y > height) continue;
      const onX = at.x === 0 || at.x === width;
      const onY = at.y === 0 || at.y === height;
      for (const phase of phases) {
        const own = objectDisplacement(object.motion, bound, bounds, at, phase);
        const x = at.x + own.x;
        const y = at.y + own.y;
        if (x < Math.min(0, at.x) - slack || x > Math.max(width, at.x) + slack || y < Math.min(0, at.y) - slack || y > Math.max(height, at.y) + slack) {
          assert.fail(`${label}: ${object.name}'s point (${at.x}, ${at.y}) leaves the frame at phase ${phase}: (${x}, ${y})`);
        }
        if (!onX && !onY) continue;
        // At a frame edge, the object's motion along the edge's normal is 0, and the total inward is the camera's alone.
        if ((onX && !isZero(own.x)) || (onY && !isZero(own.y))) assert.fail(`${label}: ${object.name}'s edge point (${at.x}, ${at.y}) moves along the edge's normal by (${own.x}, ${own.y}) at phase ${phase}`);
        edgePoints++;
        for (const disparity of disparities) {
          const moved = camera(phase, disparity);
          const total = { x: moved.x + own.x / width, y: moved.y + own.y / height };
          const inward = Math.max(at.x === 0 ? total.x : -Infinity, at.x === width ? -total.x : -Infinity, at.y === 0 ? total.y : -Infinity, at.y === height ? -total.y : -Infinity);
          if (inward > PARALLAX_MARGIN) assert.fail(`${label}: ${object.name}'s edge point (${at.x}, ${at.y}) moves inward by ${inward} at disparity ${disparity}, phase ${phase}`);
        }
      }
    }
  }
  return edgePoints;
}

test('on the fixtures and generated documents no frame-edge point moves inward past PARALLAX_MARGIN, and motion keeps every object inside the frame', () => {
  const docs: Generated[] = [];
  for (const doc of validDocuments()) docs.push({ label: `fixture ${doc.title}`, doc });
  // The five-cluster fixture's box touches the left and bottom edges; give it each motion.
  for (const kind of MOVING_KINDS) {
    const doc = fiveClusterDocument();
    docs.push({ label: `fixture with the box on ${kind}`, doc: { ...doc, objects: doc.objects.map((object) => (object.subject ? object : { ...object, motion: { kind, amount: 1 } })) } });
  }
  const generated = generatedDocuments();
  docs.push(...generated);
  let edgePoints = 0;
  for (const { label, doc } of docs) {
    const parsed = parseDocument(doc);
    assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
    edgePoints += checkBounded(label, doc);
  }
  assert.ok(generated.length > 4000, `${generated.length} generated documents`);
  assert.ok(edgePoints > 100_000, `${edgePoints} edge points checked`);
});
