// core/percentile.ts under node: nearest-rank percentiles on hand-computed
// arrays, the exact rank, the refusals, and that the input is only read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearestRank, percentile, rank } from '../src/core/percentile.ts';
import type { Result } from '../src/core/result.ts';

function value<T>(result: Result<T, string>): T {
  if (!result.ok) assert.fail(result.error);
  return result.value;
}

test('the value at rank ceil(p n) in ascending order', () => {
  // ascending: 1 2 3 4 5; ceil(0.5 * 5) = 3
  assert.equal(value(percentile([5, 1, 4, 2, 3], 0.5)), 3);
  // ceil(0.1 * 5) = 1, ceil(0.9 * 5) = 5, ceil(0.4 * 5) = 2, ceil(0.41 * 5) = 3
  assert.equal(value(percentile([5, 1, 4, 2, 3], 0.1)), 1);
  assert.equal(value(percentile([5, 1, 4, 2, 3], 0.9)), 5);
  assert.equal(value(percentile([5, 1, 4, 2, 3], 0.4)), 2);
  assert.equal(value(percentile([5, 1, 4, 2, 3], 0.41)), 3);
  // ascending 10 20 ... 100: ceil(0.1 * 10) = 1, ceil(0.9 * 10) = 9
  const tens = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  assert.equal(value(percentile(tens, 0.1)), 10);
  assert.equal(value(percentile(tens, 0.9)), 90);
  // one value is every percentile of itself
  assert.equal(value(percentile([7], 0.01)), 7);
  assert.equal(value(percentile([7], 1)), 7);
});

test('the median of an even count is the lower middle value', () => {
  // ascending 1 2 3 4: ceil(0.5 * 4) = 2
  assert.equal(value(percentile([4, 1, 3, 2], 0.5)), 2);
  // ascending -3 0 8 9 10 12: ceil(0.5 * 6) = 3
  assert.equal(value(percentile(new Float32Array([12, 9, -3, 10, 0, 8]), 0.5)), 8);
});

test('p 1 gives the maximum, and a tiny p the minimum', () => {
  assert.equal(value(percentile([3, -2, 11, 4], 1)), 11);
  assert.equal(value(percentile([3, -2, 11, 4], 1e-300)), -2);
});

test('the rank takes p n as exact, where Math.ceil in doubles would not', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.equal(Math.ceil(0.07 * 100), 8, 'the double product 0.07 * 100 lies just above 7');
  assert.equal(value(percentile(hundred, 0.07)), 7);
  assert.equal(value(percentile(hundred, 0.5)), 50);
  assert.equal(value(percentile(hundred, 0.505)), 51);
});

test('a Float32Array is ranked exactly, and infinities sort to the ends', () => {
  assert.equal(value(percentile(new Float32Array([0.1, 0.7, 0.3]), 0.5)), Math.fround(0.3));
  assert.equal(value(percentile([Infinity, 0, -Infinity], 0.5)), 0);
  assert.equal(value(percentile([Infinity, 0, -Infinity], 1)), Infinity);
});

test('one ranking answers several percentiles', () => {
  const ranked = value(rank([9, 2, 7, 4, 5, 6, 3, 8, 1, 10]));
  assert.deepEqual([0.1, 0.5, 0.9].map((p) => value(nearestRank(ranked, p))), [1, 5, 9]);
});

test('the input is only read', () => {
  const numbers = [5, 1, 4, 2, 3];
  const floats = new Float32Array([0.5, 0.25, 1, 0]);
  value(percentile(numbers, 0.5));
  value(rank(floats));
  assert.deepEqual(numbers, [5, 1, 4, 2, 3]);
  assert.deepEqual(Array.from(floats), [0.5, 0.25, 1, 0]);
});

test('an empty input, a NaN, and a p outside (0, 1] are refused with a reason', () => {
  assert.deepEqual(percentile([], 0.5), { ok: false, error: 'there are no values to rank' });
  assert.deepEqual(percentile([1, NaN, 2], 0.5), { ok: false, error: 'value 1 is not a number' });
  assert.deepEqual(percentile(new Float32Array([1, 2, NaN]), 0.5), { ok: false, error: 'value 2 is not a number' });
  for (const p of [0, -0.1, 1.0000001, NaN, Infinity, -Infinity]) {
    assert.deepEqual(percentile([1, 2, 3], p), { ok: false, error: `p must be in (0, 1], got ${p}` });
  }
});
