import test from 'node:test';
import assert from 'node:assert/strict';
import { clipLightness } from '../src/render/clip.ts';

test('clipping zero is exact identity, including values outside the output gamut', () => {
  for (const L of [-0.1, 0, 0.7, 0.95, 1, 1.1]) assert.equal(clipLightness(L, 0), L);
});

test('clipping preserves shadows, is C1 at both quadratic joins, monotonic and ends at white', () => {
  for (const clipping of [0.01, 0.3, 0.5, 1]) {
    const start = 1 - 0.35 * clipping - 0.05;
    assert.equal(clipLightness(0, clipping), 0);
    assert.equal(clipLightness(start, clipping), start);
    assert.equal(clipLightness(start - 0.1, clipping), start - 0.1);
    for (const join of [start, start + 0.05]) {
      const e = 1e-7, center = clipLightness(join, clipping);
      const left = (center - clipLightness(join - e, clipping)) / e;
      const right = (clipLightness(join + e, clipping) - center) / e;
      assert.ok(Math.abs(left - right) < 1e-4, `slope at ${join}: ${left}, ${right}`);
      assert.ok(Math.abs(clipLightness(join + e, clipping) - center) < 2e-7);
      if (join === start) assert.ok(Math.abs(right - 1) < 1e-4);
    }
    let previous = 0;
    for (let i = 0; i <= 10000; i++) {
      const L = i / 10000, output = clipLightness(L, clipping);
      assert.ok(output >= previous && output <= 1);
      assert.ok(output + 1e-14 >= L);
      previous = output;
    }
    assert.equal(clipLightness(1, clipping), 1);
    assert.ok(clipLightness((start + 1) / 2, clipping) > (start + 1) / 2);
  }
});
