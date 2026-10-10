import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cmax, Lcusp, clipGamut, inGamut } from '../src/render/gamut.ts';
import { oklabToLinear, oklchToOklab } from '../src/core/color.ts';

test('Cmax brackets the sRGB boundary for twelve hues at three lightnesses', () => {
  for (const l of [0.2, 0.5, 0.8]) for (let h = 0; h < 360; h += 30) {
    const c = Cmax(l, h);
    assert.ok(inGamut({ l, c, h }), `inside ${l},${h},${c}`);
    const rgb = oklabToLinear(oklchToOklab({ l, c, h }));
    assert.ok([rgb.r, rgb.g, rgb.b].every((v) => v >= 0 && v <= 1), `linear RGB ${l},${h}`);
    assert.ok(!inGamut({ l, c: c + 0.002, h }), `outside ${l},${h},${c}`);
  }
});

test('gamut clipping preserves lightness and hue and only reduces chroma', () => {
  for (let h = 0; h < 360; h += 30) {
    const source = { l: 0.6, c: 0.5, h };
    const clipped = clipGamut(source);
    assert.equal(clipped.l, source.l);
    assert.equal(clipped.h, source.h);
    assert.ok(clipped.c < source.c);
    assert.ok(inGamut(clipped));
    assert.deepEqual(clipGamut(clipped), clipped);
  }
});

test('numerical cusps maximize chroma on each tested hue', () => {
  for (let h = 0; h < 360; h += 30) {
    const l = Lcusp(h);
    const c = Cmax(l, h);
    for (let sample = 1; sample < 100; sample++) assert.ok(Cmax(sample / 100, h) <= c + 1e-5, `cusp ${h}`);
  }
});
