import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorInputFromOklch, parseHex, parseSrgbChannels } from '../src/core/color.ts';
import { samplePixel } from '../src/render/compare.ts';

test('opaque hex accepts both lengths and cases and normalizes to lowercase six digits', () => {
  for (const [input, expected] of [['#AbC', '#aabbcc'], ['#aBcDeF', '#abcdef'], ['#000', '#000000'], ['#FFF', '#ffffff']]) {
    const result = parseHex(input ?? '');
    assert.equal(result.kind, 'valid');
    if (result.kind === 'valid') assert.equal(result.color.hex, expected);
  }
});

test('invalid hex returns a reason without accepting CSS names, alpha, whitespace or incomplete input', () => {
  for (const value of [undefined, null, 123, {}, ['#abc'], true, '', '#', '#12', '#1234', '#12345', '#1234567', '#12345678', '123456', 'red', '#ggg',
    ' #abc', '#abc ', '#112233\n', '#112233\r', '#abc\n', 'rgb(1,2,3)', '#１２３', '#12-']) {
    const result = parseHex(value);
    assert.equal(result.kind, 'invalid', JSON.stringify(value));
    if (result.kind === 'invalid') assert.ok(result.reason.length > 0);
  }
});

test('sRGB controls validate the byte range and normalize fractional channels', () => {
  const result = parseSrgbChannels({ r: 1.4, g: 127.5, b: 254.7 });
  assert.equal(result.kind, 'valid');
  if (result.kind === 'valid') {
    assert.equal(result.color.hex, '#0180ff');
    assert.deepEqual(result.color.srgb, { r: 1, g: 128, b: 255 });
  }
  for (const bad of [NaN, Infinity, -Infinity, -0.1, 255.1]) {
    for (const channel of ['r', 'g', 'b']) {
      assert.equal(parseSrgbChannels({ r: 0, g: 0, b: 0, [channel]: bad }).kind, 'invalid');
    }
  }
});

test('non-preset sRGB colors survive saved OKLCH and picker display at byte precision', () => {
  for (const r of [0, 1, 37, 127, 201, 254, 255]) for (const g of [0, 23, 128, 231, 255]) for (const b of [0, 41, 129, 219, 255]) {
    const result = parseSrgbChannels({ r, g, b });
    assert.equal(result.kind, 'valid');
    if (result.kind !== 'valid') continue;
    assert.ok(result.color.oklch.l >= 0 && result.color.oklch.l <= 1);
    assert.ok(result.color.oklch.c >= 0 && result.color.oklch.c <= 0.4);
    assert.ok(result.color.oklch.h >= 0 && result.color.oklch.h < 360);
    const displayed = colorInputFromOklch(JSON.parse(JSON.stringify(result.color.oklch)));
    assert.equal(displayed.kind, 'valid');
    if (displayed.kind === 'valid') assert.deepEqual(displayed.color.srgb, { r, g, b });
  }
});

test('out-of-gamut display clipping leaves the authored OKLCH untouched', () => {
  const color = Object.freeze({ l: 0.7, c: 0.4, h: 145 });
  const result = colorInputFromOklch(color);
  assert.equal(result.kind, 'valid');
  assert.deepEqual(color, { l: 0.7, c: 0.4, h: 145 });
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(colorInputFromOklch({ ...color, h: invalid }).kind, 'invalid');
  }
});

test('sample coordinates use top-left pixels and include the right/bottom image boundary', () => {
  const size = { width: 2048, height: 1536 };
  assert.deepEqual(samplePixel({ x: 0, y: 0 }, size), { x: 0, y: 0 });
  assert.deepEqual(samplePixel({ x: 1, y: 1 }, size), { x: 2047, y: 1535 });
  assert.deepEqual(samplePixel({ x: 0.25, y: 0.75 }, size), { x: 512, y: 1152 });
  for (const invalid of [-0.001, 1.001, Infinity, NaN]) {
    assert.equal(samplePixel({ x: invalid, y: 0.5 }, size), null);
    assert.equal(samplePixel({ x: 0.5, y: invalid }, size), null);
  }
});
