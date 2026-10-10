import test from 'node:test';
import assert from 'node:assert/strict';
import { LUMA_TABLE, CHROMA_TABLE, qualityTable, crunchQuality } from '../src/render/crunch.ts';

test('libjpeg quality scaling: identity at 50, 250 percent at 20, all ones at 100', () => {
  for (const table of [LUMA_TABLE, CHROMA_TABLE]) {
    assert.equal(table.length, 64);
    assert.deepEqual([...qualityTable(table, 50)], [...table]);
    assert.deepEqual([...qualityTable(table, 20)], table.map((t) => Math.min(255, Math.floor((250 * t + 50) / 100))));
    assert.deepEqual([...qualityTable(table, 100)], Array.from({ length: 64 }, () => 1));
  }
  assert.equal(qualityTable(LUMA_TABLE, 20)[0], 40);
  assert.equal(qualityTable(CHROMA_TABLE, 20)[0], 43);
  assert.equal(crunchQuality(0), 100);
  assert.equal(crunchQuality(0.5), 60);
  assert.equal(crunchQuality(1), 20);
  assert.throws(() => qualityTable(LUMA_TABLE, 0), RangeError);
});
