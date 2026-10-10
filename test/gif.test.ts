import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGif, gifDelay, gifFrame, gifHeader, quantizeGif } from '../src/export/gif.ts';

/** Independent GIF reader, including variable-width LZW and local/global tables. */
export function decodeGif(bytes: Uint8Array) {
  let p = 0;
  const byte = () => { const value = bytes[p++]; if (value === undefined) throw new Error('Truncated GIF.'); return value; };
  const word = () => byte() | byte() << 8;
  const text = (n: number) => Array.from({ length: n }, byte).map((v) => String.fromCharCode(v)).join('');
  const signature = text(6); if (signature !== 'GIF89a') throw new Error('No GIF89a header.');
  const width = word(), height = word(), flags = byte(); byte(); byte();
  const table = (flags: number) => Uint8Array.from(Array.from({ length: 3 * (1 << ((flags & 7) + 1)) }, byte));
  const global = flags & 128 ? table(flags) : null;
  const blocks = () => { const result: number[] = []; for (let n = byte(); n !== 0; n = byte()) for (let i = 0; i < n; i++) result.push(byte()); return result; };
  const frames: { width: number; height: number; delay: number; rgba: Uint8ClampedArray }[] = [];
  let delay = 0, loop: number | null = null;
  for (let marker = byte(); marker !== 0x3b; marker = byte()) {
    if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) { assert.equal(byte(), 4); byte(); delay = word(); byte(); assert.equal(byte(), 0); }
      else if (label === 0xff) { const name = text(byte()), data = blocks(); if (name === 'NETSCAPE2.0' && data[0] === 1) loop = (data[1] ?? 0) | (data[2] ?? 0) << 8; }
      else blocks();
      continue;
    }
    assert.equal(marker, 0x2c); assert.equal(word(), 0); assert.equal(word(), 0);
    const w = word(), h = word(), local = byte(), palette = local & 128 ? table(local) : global;
    if (palette === null || local & 64) throw new Error('Missing palette or interlaced frame.');
    const minimum = byte(), packed = blocks(), clear = 1 << minimum, end = clear + 1;
    let bit = 0, widthBits = minimum + 1, next = end + 1, previous: number[] | null = null;
    let dictionary: number[][] = [];
    const reset = () => { dictionary = Array.from({ length: clear }, (_, i) => [i]); widthBits = minimum + 1; next = end + 1; previous = null; };
    const pixels: number[] = []; reset();
    for (;;) {
      if (bit + widthBits > packed.length * 8) throw new Error('Truncated LZW.');
      let code = 0;
      for (let i = 0; i < widthBits; i++, bit++) code |= (((packed[bit >> 3] ?? 0) >> (bit & 7)) & 1) << i;
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      const entry: number[] | undefined = dictionary[code] ?? (code === next && previous !== null ? [...previous, previous[0] ?? 0] : undefined);
      if (entry === undefined) throw new Error(`Invalid LZW code ${code} at ${next}.`);
      pixels.push(...entry);
      if (previous !== null && next < 4096) {
        dictionary[next++] = [...previous, entry[0] ?? 0];
        if (next === 1 << widthBits && widthBits < 12) widthBits++;
      }
      previous = entry;
    }
    assert.equal(pixels.length, w * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (const [i, index] of pixels.entries()) { rgba.set(palette.subarray(index * 3, index * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
    frames.push({ width: w, height: h, delay, rgba });
  }
  assert.equal(p, bytes.length);
  return { signature, width, height, loop, frames };
}

test('three 8 x 8 frames round-trip exact pixels, delays and infinite loop extension', () => {
  const frames = Array.from({ length: 3 }, (_, frame) => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i++) rgba.set([i * 3, frame * 71, 255 - i * 2, 255], i * 4);
    return rgba;
  });
  const decoded = decodeGif(finishGif([gifHeader(8, 8), ...frames.map((rgba, i) => gifFrame(8, 8, rgba, gifDelay(i, 15)))]));
  assert.deepEqual([decoded.width, decoded.height, decoded.loop], [8, 8, 0]);
  assert.deepEqual(decoded.frames.map(({ delay }) => delay), [7, 6, 7]);
  assert.deepEqual(decoded.frames.map(({ rgba }) => rgba), frames);
});

test('LZW grows through 12 bits and resets its dictionary without changing pixels', () => {
  let seed = 17;
  const rgba = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < rgba.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const n = seed >>> 24; rgba.set([n, n ^ 91, 255 - n, 255], i); }
  const decoded = decodeGif(finishGif([gifHeader(256, 256), gifFrame(256, 256, rgba, 4)]));
  assert.deepEqual(decoded.frames[0]?.rgba, rgba);
});

test('image-derived quantization is deterministic, bounded and retains gradient color', () => {
  const rgba = new Uint8ClampedArray(256 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) rgba.set([x, y * 4, (x + y * 3) % 256, 255], (y * 256 + x) * 4);
  const a = quantizeGif(rgba), b = quantizeGif(rgba);
  assert.deepEqual(a, b); assert.equal(a.palette.length, 768);
  let error = 0;
  for (const [i, index] of a.indexed.entries()) for (let c = 0; c < 3; c++) error += Math.abs((a.palette[index * 3 + c] ?? 0) - (rgba[i * 4 + c] ?? 0));
  assert.ok(error / (a.indexed.length * 3) < 8);
  const decoded = decodeGif(finishGif([gifHeader(256, 64), gifFrame(256, 64, rgba, 3)]));
  assert.equal(decoded.frames.length, 1);
});

test('15 fps GIFs preserve every supported loop period with 6 or 7 centisecond delays', () => {
  for (let tenths = 20; tenths <= 60; tenths++) {
    const seconds = tenths / 10, frames = Math.round(seconds * 15);
    const delays = Array.from({ length: frames }, (_, i) => gifDelay(i, frames / seconds));
    assert.ok(delays.every((n) => n === 6 || n === 7));
    assert.equal(delays.reduce((a, b) => a + b, 0), tenths * 10);
  }
});
