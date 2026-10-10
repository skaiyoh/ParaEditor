import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linearToOklab, oklabToLinear, oklabToOklch, oklabToSrgb, oklchToOklab, srgbToOklab } from '../src/core/color.ts';

const near = (actual: number, expected: number, tolerance: number): void => { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`); };
test('sRGB white and red match the Oklab reference', () => {
  const white = srgbToOklab({ r: 1, g: 1, b: 1 });
  near(white.L, 1, 1e-4); near(white.a, 0, 1e-4); near(white.b, 0, 1e-4);
  const red = srgbToOklab({ r: 1, g: 0, b: 0 });
  near(red.L, 0.6280, 2e-3); near(red.a, 0.2249, 2e-3); near(red.b, 0.1258, 2e-3);
});
test('125 colors round trip through Oklab', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) for (const g of [0, 0.25, 0.5, 0.75, 1]) for (const b of [0, 0.25, 0.5, 0.75, 1]) {
    const rgb = oklabToSrgb(srgbToOklab({ r, g, b }));
    near(rgb.r, r, 1e-4); near(rgb.g, g, 1e-4); near(rgb.b, b, 1e-4);
  }
});
test('linear RGB and polar Oklch conversions are inverses', () => {
  const rgb = { r: 0.3, g: 0.7, b: 0.1 };
  const lab = linearToOklab(rgb);
  const inverse = oklabToLinear(lab);
  near(inverse.r, rgb.r, 1e-6); near(inverse.g, rgb.g, 1e-6); near(inverse.b, rgb.b, 1e-6);
  const cartesian = oklchToOklab(oklabToOklch(lab));
  near(cartesian.L, lab.L, 1e-12); near(cartesian.a, lab.a, 1e-12); near(cartesian.b, lab.b, 1e-12);
  assert.equal(oklabToOklch({ L: 0.5, a: 0, b: 0 }).h, 0);
});
