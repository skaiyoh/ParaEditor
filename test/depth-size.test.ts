// analysis/depth-size.ts under node: fixed expected depth input sizes, and the
// bound over every master import can make.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEPTH_MAX_TOKENS, DEPTH_PATCH, DEPTH_SHORT_SIDE, depthInputSize } from '../src/analysis/depth-size.ts';

test('the constants: 14 px patches, a 518 px short side, and 37 x 49 patches at most', () => {
  assert.equal(DEPTH_PATCH, 14);
  assert.equal(DEPTH_SHORT_SIDE, 518);
  assert.equal(DEPTH_MAX_TOKENS, 1813);
  assert.equal(DEPTH_MAX_TOKENS, 37 * 49);
});

test('the input sizes of six landscape masters down to the narrowest, and a portrait master', () => {
  const cases: readonly (readonly [number, number, number, number])[] = [
    [2048, 1536, 686, 518],
    [2048, 1366, 714, 476],
    [2048, 1152, 784, 434],
    [2048, 773, 966, 364],
    [2048, 512, 1190, 294],
    [2048, 64, 3360, 98],
    [1536, 2048, 518, 686],
  ];
  for (const [width, height, w, h] of cases) {
    assert.deepEqual(depthInputSize({ width, height }), { width: w, height: h }, `${width} x ${height}`);
  }
  assert.equal((3360 / 14) * (98 / 14), 1680);
});

test('every even master from 512 to 2048 px long and from 64 px short, either way up, is bounded', () => {
  let masters = 0;
  let mostPatches = 0;
  for (let long = 512; long <= 2048; long += 2) {
    for (let short = 64; short <= long; short += 2) {
      for (const master of [
        { width: long, height: short },
        { width: short, height: long },
      ]) {
        const size = depthInputSize(master);
        if (size.width % DEPTH_PATCH !== 0 || size.height % DEPTH_PATCH !== 0 || size.width < DEPTH_PATCH || size.height < DEPTH_PATCH) {
          assert.fail(`${master.width} x ${master.height} gives ${size.width} x ${size.height}, not whole patches`);
        }
        const patches = (size.width / DEPTH_PATCH) * (size.height / DEPTH_PATCH);
        if (patches > DEPTH_MAX_TOKENS) assert.fail(`${master.width} x ${master.height} gives ${patches} patches`);
        mostPatches = Math.max(mostPatches, patches);
        masters += 1;
      }
    }
  }
  console.log(`depthInputSize: ${masters} masters checked, at most ${mostPatches} patches`);
  assert.ok(masters > 900_000);
  assert.equal(mostPatches, DEPTH_MAX_TOKENS);
});
