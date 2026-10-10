import test from 'node:test';
import assert from 'node:assert/strict';
import { grainHash, grainNoise, holdIndex } from '../src/render/grain.ts';

test('Murmur fmix grain hash fixed uint32 vectors', () => {
  assert.equal(grainHash(0, 0, 0, 0, 0), 1459986880);
  assert.equal(grainHash(123456789, 7, 123, 456, 1), 473632032);
  assert.equal(grainHash(0xffffffff, 34, 2047, 1535, 2), 3192946190);
});

test('grain is centered and bounded across 10,000 cells in each channel', () => {
  for (let channel = 0; channel < 3; channel++) {
    let sum = 0;
    for (let i = 0; i < 10000; i++) {
      const n = grainNoise(123456789, 7, i % 100, Math.floor(i / 100), channel);
      assert.ok(n >= -1 && n <= 1); sum += n;
    }
    assert.ok(Math.abs(sum / 10000) < 0.02, `channel ${channel}: mean ${sum / 10000}`);
  }
});

test('69 frames hold two frames, retain a one-frame tail and wrap to frame zero', () => {
  for (let f = 0; f < 69; f++) assert.equal(holdIndex(f, 69, 2), Math.floor(f / 2));
  assert.equal(holdIndex(0, 69, 2), holdIndex(69, 69, 2));
  assert.equal(holdIndex(68, 69, 2), 34);
  assert.equal(holdIndex(70, 69, 2), 0);
  assert.equal(holdIndex(-1, 69, 2), 34);
  assert.throws(() => holdIndex(0, 0, 2), RangeError);
});
