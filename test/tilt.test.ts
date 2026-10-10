import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenTilt } from '../src/session/tilt.ts';

// The application build supplies this constant; the pure rotation checks never read it.
declare global { const NOISY_DEV: boolean; }

test('screen tilt rotates device axes with the screen at every quarter turn', () => {
  assert.deepEqual(screenTilt(35, 8, 0), { x: 8, y: 35 });
  assert.deepEqual(screenTilt(35, 8, 90), { x: 35, y: -8 });
  assert.deepEqual(screenTilt(35, 8, 180), { x: -8, y: -35 });
  assert.deepEqual(screenTilt(35, 8, 270), { x: -35, y: 8 });
  assert.deepEqual(screenTilt(35, 8, -90), screenTilt(35, 8, 270));
  assert.deepEqual(screenTilt(35, 8, 360), screenTilt(35, 8, 0));
});

test('screen-axis rest deltas preserve portrait signs and swap landscape axes', () => {
  for (const angle of [0, 90, 180, 270]) {
    const rest = screenTilt(35, 8, angle);
    for (const [beta, gamma] of [[35, 23], [50, 8], [20, -7]]) {
      if (beta === undefined || gamma === undefined) throw new Error('Missing tilt sample.');
      const moved = screenTilt(beta, gamma, angle);
      const delta = screenTilt(beta - 35, gamma - 8, angle);
      assert.ok(moved.x - rest.x === delta.x && moved.y - rest.y === delta.y);
    }
  }
});
