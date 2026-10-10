import test from 'node:test';
import assert from 'node:assert/strict';
import { loopTapPoint } from '../src/session/loop.ts';
import { LOOP_ZOOM, PARALLAX_MARGIN } from '../src/core/motion.ts';
import { frameAtElapsed, wrapFrame } from '../src/render/loop.ts';

test('30 fps frame stepper boundaries, skipped callbacks and exact wrap', () => {
  assert.equal(frameAtElapsed(0, 30), 0);
  assert.equal(frameAtElapsed(34, 30), 1);
  assert.equal(frameAtElapsed(999, 30), 29);
  assert.equal(frameAtElapsed(1000, 30), 0);
  assert.ok(frameAtElapsed(240, 30) - frameAtElapsed(34, 30) > 1);
  assert.equal(frameAtElapsed(3000, 90), 0);
  assert.equal(wrapFrame(90, 90), 0);
  assert.equal(wrapFrame(-1, 90), 89);
  assert.throws(() => frameAtElapsed(-1, 30), RangeError);
  assert.throws(() => wrapFrame(1, 0), RangeError);
});

test('loop taps undo center zoom for the center and both corners', () => {
  assert.deepEqual(loopTapPoint({ x: .5, y: .5 }), { x: .5, y: .5 });
  const near = loopTapPoint({ x: 0, y: 0 }), far = loopTapPoint({ x: 1, y: 1 });
  for (const value of [near.x, near.y]) assert.ok(Math.abs(value - PARALLAX_MARGIN) < 1e-12);
  for (const value of [far.x, far.y]) assert.ok(Math.abs(value - (1 - PARALLAX_MARGIN)) < 1e-12);
  // A stored corner projects outward by LOOP_ZOOM; its inverse lands back
  // on the corner. A screen corner instead samples the cropped frame inset.
  const projectedCorner = .5 - .5 * LOOP_ZOOM;
  assert.deepEqual(loopTapPoint({ x: projectedCorner, y: projectedCorner }), { x: 0, y: 0 });
});
