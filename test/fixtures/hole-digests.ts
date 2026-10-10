// The SHA-256 of each harness hole's bytes at the two masters the harness
// probes, pinned once: test/holes.test.ts holds holes.ts's bytes in node to
// them, and the memory page's scenario holds the bytes the page makes in
// Chrome to them.

import type { Size } from '../../src/core/raster.ts';

/** The masters the harness probes MI-GAN at. */
export const HOLE_MASTERS: readonly Size[] = [
  { width: 2048, height: 1536 },
  { width: 2048, height: 2048 },
];

/** The SHA-256, in lowercase hex, of each hole's bytes, keyed `<shape> <width>x<height>`. */
export const PINNED_HOLE_DIGESTS: Readonly<Record<string, string>> = {
  'corners 2048x1536': '91809213e44404e1d1634dc15f9791c56c67ed5b9237df7530e78d2238e8b1bf',
  'full 2048x1536': '908b6cfc9aef496dd5ab5c5540d80c6383ed6e92f86044574c996315381bc064',
  'corners 2048x2048': '9c6c8637d7735763c16fd907054e93ab17e95d91c0257323f63b574effcffc69',
  'full 2048x2048': 'cd3517473707d59c3d915b52a3e16213cadce80d9ffb2b4371958fb7acb51a08',
};
