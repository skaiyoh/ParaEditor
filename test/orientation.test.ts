import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrientationTracker, orientationPose, relativeRotation, resolveDisplayBasis, rotateTilt, type OrientationSample } from '../src/core/orientation.ts';

const near = (actual: number, expected: number, tolerance = 1e-8): void => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const pose = (sample: OrientationSample) => { const value = orientationPose(sample); assert.ok(value); return value; };

test('the recorded Euler branch transition is 9.15 degrees of gravity motion, without saturated tilt', () => {
  const a = { beta: 1.04, gamma: -86.02 }, b = { beta: 179.49, gamma: 84.84 };
  near(Math.hypot(...relativeRotation(pose(a), pose(b))), 9.15448, .00001);
  const tracker = createOrientationTracker();
  tracker.observe(a, 90, 1);
  const result = tracker.observe(b, 90, 17);
  assert.equal(result.pose, 'gravity'); assert.equal(result.yawLimited, true);
  assert.ok(Math.abs(result.delta.x) < 10 && Math.abs(result.delta.y) < 10);
  assert.equal(result.state, 'tracking');
});

test('full Z-X-Y quaternion preserves equivalent upright Euler representations and quaternion signs', () => {
  const a = pose({ alpha: 0, beta: 89, gamma: 0 });
  near(Math.hypot(...relativeRotation(a, pose({ alpha: 180, beta: 91, gamma: 180 }))), 0);
  near(Math.hypot(...relativeRotation(a, pose({ alpha: 360, beta: 89, gamma: 0 }))), 0);
  const tracker = createOrientationTracker();
  tracker.observe({ alpha: 0, beta: 89, gamma: 0 }, 0, 0);
  const branch = tracker.observe({ alpha: 180, beta: 90.5, gamma: 180 }, 0, 20);
  near(branch.delta.y, .5); near(branch.delta.x, 0);
});

test('upright yaw is observable with valid alpha and explicitly absent from gravity fallback', () => {
  const full = relativeRotation(pose({ alpha: 0, beta: 90, gamma: 0 }), pose({ alpha: 15, beta: 90, gamma: 0 }));
  near(full[1], 15);
  const gravity = createOrientationTracker();
  gravity.observe({ alpha: null, beta: 90, gamma: 0 }, 0, 1);
  const held = gravity.observe({ alpha: null, beta: 90, gamma: 0 }, 0, 2);
  assert.deepEqual(held.delta, { x: 0, y: 0 }); assert.equal(held.yawLimited, true);
  assert.equal(pose({ alpha: NaN, beta: 0, gamma: 0 }).kind, 'gravity');
});

test('natural-landscape metadata resolves portrait-relative basis without universally preferring legacy', () => {
  assert.deepEqual(resolveDisplayBasis(0, 'landscape-primary', 90), { angle: 90, provenance: 'legacy-aligned-native' });
  assert.deepEqual(resolveDisplayBasis(0, 'landscape-secondary', -90), { angle: 270, provenance: 'legacy-aligned-native' });
  assert.deepEqual(resolveDisplayBasis(0, 'portrait-primary', 90), { angle: 0, provenance: 'native' });
  assert.deepEqual(resolveDisplayBasis(90, 'landscape-primary', 0), { angle: 90, provenance: 'native' });
  assert.deepEqual(resolveDisplayBasis(0, 'landscape-primary', null), { angle: 90, provenance: 'type-aligned-native' });
  assert.deepEqual(resolveDisplayBasis(null, null, -90), { angle: 270, provenance: 'legacy' });
  assert.deepEqual(resolveDisplayBasis(NaN, 'portrait-secondary', Infinity), { angle: 180, provenance: 'type' });
  for (const [angle, type] of [[0, 'portrait-primary'], [90, 'landscape-primary'], [180, 'portrait-secondary'], [270, 'landscape-secondary']] satisfies readonly (readonly [number, OrientationType])[]) {
    assert.equal(resolveDisplayBasis(angle, type, null).angle, angle);
  }
});

test('relative physical tilt maps into all four display bases', () => {
  const expected = [{ x: 8, y: 35 }, { x: 35, y: -8 }, { x: -8, y: -35 }, { x: -35, y: 8 }];
  [0, 90, 180, 270].forEach((angle, i) => assert.deepEqual(rotateTilt(35, 8, angle), expected[i]));
});

test('neutral, return, heading reset, mode change and display rotation remain continuous', () => {
  const tracker = createOrientationTracker();
  const neutral = { alpha: 0, beta: 90, gamma: 0 };
  assert.equal(tracker.observe(neutral, 0, 1).state, 'calibrating');
  const moved = tracker.observe({ ...neutral, alpha: 10 }, 0, 17); near(moved.delta.x, 10);
  const reset = tracker.observe({ ...neutral, alpha: 130 }, 0, 33);
  assert.equal(reset.reason, 'heading-reset'); near(reset.delta.x, 10);
  const later = tracker.observe({ ...neutral, alpha: 131 }, 0, 49); near(later.delta.x, 11);
  const rotated = tracker.observe({ ...neutral, alpha: 131 }, 90, 65);
  assert.equal(rotated.reason, 'basis-change'); assert.deepEqual(rotated.delta, later.delta);
  const limited = tracker.observe({ beta: 90, gamma: 0 }, 90, 81);
  assert.equal(limited.reason, 'pose-change'); assert.deepEqual(limited.delta, later.delta);
  tracker.recenter();
  assert.deepEqual(tracker.observe(neutral, 0, 100).delta, { x: 0, y: 0 });
  tracker.observe({ ...neutral, alpha: 10 }, 0, 116);
  const returned = tracker.observe(neutral, 0, 132); near(returned.delta.x, 0); near(returned.delta.y, 0);
});

test('invalid, stale and gravity-antipodal observations cannot produce NaN or a fabricated rotation', () => {
  const tracker = createOrientationTracker();
  tracker.observe({ beta: 0, gamma: 0 }, 0, 10);
  for (const sample of [{ beta: null, gamma: 0 }, { beta: NaN, gamma: 0 }, { beta: 0, gamma: Infinity }]) {
    assert.equal(tracker.observe(sample, 0, 11).reason, 'invalid');
  }
  assert.equal(tracker.observe({ beta: 10, gamma: 0 }, 0, 9).reason, 'stale');
  assert.equal(tracker.observe({ beta: 0, gamma: 0 }, 0, Infinity).reason, 'invalid');
  const antipodal = tracker.observe({ beta: 180, gamma: 0 }, 0, 30);
  assert.equal(antipodal.reason, 'antipodal'); assert.deepEqual(antipodal.delta, { x: 0, y: 0 });
});


test('display-basis changes preserve a saturated held pose before further relative movement', () => {
  const tracker = createOrientationTracker();
  const rest = { alpha: 0, beta: 0, gamma: 0 };
  tracker.observe(rest, 0, 0);
  tracker.observe({ ...rest, gamma: 20 }, 0, 1000);
  const before = tracker.observe({ ...rest, gamma: 60 }, 0, 2000);
  const changed = tracker.observe(rest, 90, 3000);
  assert.equal(changed.reason, 'basis-change');
  assert.deepEqual(changed.delta, before.delta);
  const held = tracker.observe(rest, 90, 3050);
  assert.equal(held.state, 'tracking'); assert.deepEqual(held.delta, before.delta);
  const returnedBasis = tracker.observe(rest, 0, 4000);
  assert.deepEqual(returnedBasis.delta, before.delta);
});
