// src/dev/harness/holes.ts: the memory harness's holes, checked pixel by
// pixel against the corner discs' rule written out again here, their areas
// at the two masters the harness probes, and their bytes against the SHA-256
// digests pinned in test/fixtures/hole-digests.ts, which the memory page's
// scenario holds the page's holes to as well.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Size } from '../src/core/raster.ts';
import { cornerRadius, HOLE_SHAPES, holePlane } from '../src/dev/harness/holes.ts';
import { HOLE_MASTERS as MASTERS, PINNED_HOLE_DIGESTS as PINNED } from './fixtures/hole-digests.ts';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Whether pixel (x, y)'s centre lies within r of one of the four corner discs' centres, in doubled integer coordinates. */
function inCorners(x: number, y: number, size: Size, r: number): boolean {
  const centres = [[r, r], [size.width - r, r], [r, size.height - r], [size.width - r, size.height - r]];
  return centres.some(([cx = 0, cy = 0]) => (2 * x + 1 - 2 * cx) ** 2 + (2 * y + 1 - 2 * cy) ** 2 <= (2 * r) ** 2);
}

test('the corner radius is round(0.1 x the shorter side), halves up', () => {
  const cases: readonly [Size, number][] = [
    [{ width: 2048, height: 1536 }, 154],
    [{ width: 2048, height: 2048 }, 205],
    [{ width: 1536, height: 2048 }, 154],
    [{ width: 2048, height: 512 }, 51],
    [{ width: 40, height: 15 }, 2],
    [{ width: 40, height: 14 }, 1],
    [{ width: 25, height: 40 }, 3],
    [{ width: 2, height: 2 }, 0],
  ];
  for (const [size, r] of cases) assert.equal(cornerRadius(size), r, `${size.width} x ${size.height}`);
});

test('full sets every pixel, and corners sets exactly the pixels whose centres lie within r of a corner disc\'s centre', () => {
  for (const size of [...MASTERS, { width: 30, height: 20 }, { width: 7, height: 31 }, { width: 2, height: 2 }]) {
    const full = holePlane('full', size);
    assert.deepEqual([full.format, full.size, full.data.length], ['u8', size, size.width * size.height]);
    assert.ok(full.data.every((b) => b === 255), `full ${size.width} x ${size.height}`);

    const corners = holePlane('corners', size);
    assert.deepEqual([corners.format, corners.size], ['u8', size]);
    const r = cornerRadius(size);
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const want = inCorners(x, y, size, r) ? 255 : 0;
        if (corners.data[y * size.width + x] !== want) assert.fail(`corners ${size.width} x ${size.height}: pixel ${x}, ${y} is not ${want}`);
      }
    }
  }
});

test('the corner discs cover about 9.5% of 2048 x 1536 and 12.6% of 2048 x 2048, and are mirror-symmetric', () => {
  const shares: string[] = [];
  for (const size of MASTERS) {
    const { data } = holePlane('corners', size);
    let inside = 0;
    for (const b of data) if (b === 255) inside += 1;
    shares.push(((100 * inside) / data.length).toFixed(1));
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const at = data[y * size.width + x];
        if (at !== data[y * size.width + (size.width - 1 - x)] || at !== data[(size.height - 1 - y) * size.width + x]) {
          assert.fail(`corners ${size.width} x ${size.height} is not symmetric at ${x}, ${y}`);
        }
      }
    }
  }
  assert.deepEqual(shares, ['9.5', '12.6']);
});

test('each hole\'s bytes at the two masters have their pinned SHA-256', () => {
  const actual: Record<string, string> = {};
  for (const size of MASTERS) {
    for (const shape of HOLE_SHAPES) actual[`${shape} ${size.width}x${size.height}`] = sha256(holePlane(shape, size).data);
  }
  assert.deepEqual(actual, PINNED);
});

test('a side that is not a whole number of at least 1 is a RangeError', () => {
  for (const size of [{ width: 0, height: 2 }, { width: 2, height: -2 }, { width: 2.5, height: 2 }, { width: Number.NaN, height: 2 }]) {
    assert.throws(() => holePlane('corners', size), RangeError, `${size.width} x ${size.height}`);
  }
});
