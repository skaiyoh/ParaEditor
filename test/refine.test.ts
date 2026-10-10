import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plane } from '../src/core/raster.ts';
import { anchoredSize, candidateSize, draggedSize, maskArea, rankCandidates, refinementChoice, thresholdMask } from '../src/session/refine.ts';

const plane = (data: readonly number[]): Plane<'u8'> => ({ format: 'u8', size: { width: data.length, height: 1 }, data: new Uint8Array(data) });

test('area ordering preserves decoder indices, with stable ties and the original choice anchored at 128', () => {
  const candidates = rankCandidates([
    { mask: plane([128, 255, 0]), score: 0.9 },
    { mask: plane([128, 0, 0]), score: 0.8 },
    { mask: plane([128, 255, 255]), score: 0.7 },
  ]);
  assert.deepEqual(candidates.map(({ candidate, area }) => ({ candidate, area })), [
    { candidate: 1, area: 1 }, { candidate: 0, area: 2 }, { candidate: 2, area: 3 },
  ]);
  assert.equal(candidateSize(candidates, 0), 0.5);
  candidates.forEach((entry, rank) => {
    const choice = refinementChoice(candidateSize(candidates, entry.candidate));
    assert.equal(choice.rank, rank); assert.equal(choice.threshold, 128);
    assert.deepEqual(thresholdMask(entry.mask, choice.threshold).data, entry.mask.data);
  });
  assert.deepEqual(rankCandidates([
    { mask: plane([255]), score: 0.1 }, { mask: plane([255]), score: 0.9 }, { mask: plane([255]), score: 0.5 },
  ]).map(({ candidate }) => candidate), [0, 1, 2]);
});

test('three size intervals tighten and loosen each candidate through 192, 128, 96', () => {
  assert.deepEqual(refinementChoice(-1), { rank: 0, threshold: 192 });
  assert.deepEqual(refinementChoice(0), { rank: 0, threshold: 192 });
  assert.deepEqual(refinementChoice(1 / 6), { rank: 0, threshold: 128 });
  assert.deepEqual(refinementChoice(1 / 3), { rank: 1, threshold: 192 });
  assert.deepEqual(refinementChoice(0.5), { rank: 1, threshold: 128 });
  assert.deepEqual(refinementChoice(2 / 3), { rank: 2, threshold: 192 });
  assert.deepEqual(refinementChoice(5 / 6), { rank: 2, threshold: 128 });
  assert.deepEqual(refinementChoice(1), { rank: 2, threshold: 96 });
  assert.deepEqual(refinementChoice(2), { rank: 2, threshold: 96 });
  for (const start of [0, 1 / 3, 2 / 3]) {
    let previous = Infinity;
    for (let i = 0; i < 100; i++) {
      const { threshold } = refinementChoice(start + i / 300);
      assert.ok(threshold <= previous); previous = threshold;
    }
  }
});

test('soft-value remapping preserves exactly the threshold crossing and never mutates the candidate', () => {
  const source = plane(Array.from({ length: 256 }, (_, i) => i));
  for (const threshold of [96, 110.7, 127.9, 128, 128.1, 160, 191.9, 192]) {
    const mapped = thresholdMask(source, threshold);
    for (let i = 0; i < 256; i++) assert.equal((mapped.data[i] ?? 0) >= 128, i >= threshold, `${i} at ${threshold}`);
    assert.equal(mapped.data[0], 0); assert.equal(mapped.data[255], 255);
    assert.equal(maskArea(mapped), 256 - Math.ceil(threshold));
  }
  assert.deepEqual([...source.data], Array.from({ length: 256 }, (_, i) => i));
});

test('120 px reaches maximum grow or shrink from every starting size, and returning restores that size', () => {
  for (const start of [0, 1 / 6, 0.5, 5 / 6, 1]) {
    assert.equal(draggedSize(start, 0), start);
    assert.equal(draggedSize(start, -120), 0); assert.equal(draggedSize(start, -500), 0);
    assert.equal(draggedSize(start, 120), 1); assert.equal(draggedSize(start, 500), 1);
    assert.ok(draggedSize(start, -60) <= start); assert.ok(draggedSize(start, 60) >= start);
  }
});

test('legacy .5 retains any original candidate without losing the grow or shrink endpoints', () => {
  for (const anchor of [1 / 6, 0.5, 5 / 6]) {
    assert.equal(anchoredSize(0.5, 0.5, anchor), anchor);
    assert.equal(anchoredSize(0, 0.5, anchor), 0);
    assert.equal(anchoredSize(1, 0.5, anchor), 1);
    assert.ok(anchoredSize(0.4, 0.5, anchor) < anchor);
    assert.ok(anchoredSize(0.6, 0.5, anchor) > anchor);
  }
});
