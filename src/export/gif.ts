import { z } from '../core/zod.ts';

export const GIF_FPS = 15;
export const GIF_LONG_EDGE = 640;

const dimension = z.number().int().min(1).max(GIF_LONG_EDGE);
export const gifRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), width: dimension, height: dimension, frames: z.number().int().min(1).max(90), fps: z.number().min(1).max(50) }),
  z.object({ kind: z.literal('frame'), pixels: z.custom<ImageData>((value) => typeof ImageData !== 'undefined' && value instanceof ImageData) }),
  z.object({ kind: z.literal('finish') }),
]);
export const gifReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('progress'), completed: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('done'), bytes: z.instanceof(Uint8Array) }),
  z.object({ kind: z.literal('failed'), detail: z.string() }),
]);

/** GIF uses hundredths, so cumulative rounding preserves the loop's duration. */
export function gifDelay(frame: number, fps: number): number {
  return Math.round((frame + 1) * 100 / fps) - Math.round(frame * 100 / fps);
}

/** Image-derived palette; retain exact RGB when the image already fits 256 colors. */
export function quantizeGif(rgba: Uint8ClampedArray) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) throw new Error('GIF needs complete RGBA pixels.');
  const exact = new Map<number, number>();
  const rgb = (i: number) => (rgba[i] ?? 0) * 65536 + (rgba[i + 1] ?? 0) * 256 + (rgba[i + 2] ?? 0);
  for (let i = 0; i < rgba.length; i += 4) {
    const color = rgb(i); if (!exact.has(color)) exact.set(color, exact.size);
    if (exact.size > 256) break;
  }
  const palette = new Uint8Array(768), indexed = new Uint8Array(rgba.length / 4);
  if (exact.size <= 256) {
    for (const [color, index] of exact) palette.set([color >>> 16, color >>> 8 & 255, color & 255], index * 3);
    for (let i = 0; i < indexed.length; i++) indexed[i] = exact.get(rgb(i * 4)) ?? 0;
    return { palette, indexed };
  }
  // A bounded histogram keeps worker memory independent of the number of colors.
  const counts = new Uint32Array(32768), sums = new Float64Array(32768 * 3);
  const binAt = (i: number) => ((rgba[i] ?? 0) >> 3) * 1024 + ((rgba[i + 1] ?? 0) >> 3) * 32 + ((rgba[i + 2] ?? 0) >> 3);
  for (let i = 0; i < rgba.length; i += 4) {
    const bin = binAt(i); counts[bin] = (counts[bin] ?? 0) + 1;
    for (let c = 0; c < 3; c++) sums[bin * 3 + c] = (sums[bin * 3 + c] ?? 0) + (rgba[i + c] ?? 0);
  }
  const colors: { bin: number; n: number; rgb: number[] }[] = [];
  for (let bin = 0; bin < counts.length; bin++) {
    const n = counts[bin] ?? 0;
    if (n > 0) colors.push({ bin, n, rgb: [0, 1, 2].map((c) => (sums[bin * 3 + c] ?? 0) / n) });
  }
  const box = (entries: typeof colors) => {
    const ranges = [0, 1, 2].map((c) => {
      let lo = 255, hi = 0;
      for (const color of entries) { lo = Math.min(lo, color.rgb[c] ?? 0); hi = Math.max(hi, color.rgb[c] ?? 0); }
      return hi - lo;
    });
    const axis = ranges.indexOf(Math.max(...ranges));
    return { entries, axis, score: Math.max(...ranges) * Math.sqrt(entries.reduce((n, color) => n + color.n, 0)) };
  };
  const boxes = [box(colors)];
  while (boxes.length < 256) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const candidate = boxes[i];
      if (candidate !== undefined && candidate.entries.length > 1 && (best < 0 || candidate.score > (boxes[best]?.score ?? 0))) best = i;
    }
    const current = boxes[best]; if (current === undefined) break;
    current.entries.sort((a, b) => (a.rgb[current.axis] ?? 0) - (b.rgb[current.axis] ?? 0) || a.bin - b.bin);
    const half = current.entries.reduce((n, color) => n + color.n, 0) / 2;
    let n = 0, cut = 0;
    do { n += current.entries[cut]?.n ?? 0; cut++; } while (n < half && cut < current.entries.length - 1);
    boxes[best] = box(current.entries.slice(0, cut)); boxes.push(box(current.entries.slice(cut)));
  }
  for (const [index, entry] of boxes.entries()) {
    const total = entry.entries.reduce((n, color) => n + color.n, 0);
    for (let c = 0; c < 3; c++) palette[index * 3 + c] = Math.round(entry.entries.reduce((n, color) => n + (color.rgb[c] ?? 0) * color.n, 0) / total);
  }
  const lookup = new Uint8Array(32768);
  for (const color of colors) {
    let best = 0, error = Infinity;
    for (let index = 0; index < boxes.length; index++) {
      let distance = 0;
      for (let c = 0; c < 3; c++) distance += ((color.rgb[c] ?? 0) - (palette[index * 3 + c] ?? 0)) ** 2;
      if (distance < error) { error = distance; best = index; }
    }
    lookup[color.bin] = best;
  }
  for (let i = 0; i < indexed.length; i++) indexed[i] = lookup[binAt(i * 4)] ?? 0;
  return { palette, indexed };
}

function lzw(pixels: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  let bits = 0, held = 0, width = 9, next = 258;
  const dictionary = new Map<number, number>();
  const emit = (code: number) => {
    held |= code << bits; bits += width;
    while (bits >= 8) { bytes.push(held & 255); held >>>= 8; bits -= 8; }
  };
  emit(256);
  let prefix = pixels[0] ?? 0;
  for (let i = 1; i < pixels.length; i++) {
    const value = pixels[i] ?? 0, key = prefix * 256 + value, found = dictionary.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 1 << width && width < 12) width++;
    if (next < 4096) dictionary.set(key, next++);
    else { emit(256); dictionary.clear(); width = 9; next = 258; }
    prefix = value;
  }
  emit(prefix);
  if (next === 1 << width && width < 12) width++;
  emit(257);
  if (bits > 0) bytes.push(held & 255);
  const blocks: number[] = [8];
  for (let i = 0; i < bytes.length; i += 255) blocks.push(Math.min(255, bytes.length - i), ...bytes.slice(i, i + 255));
  blocks.push(0);
  return Uint8Array.from(blocks);
}

export function gifHeader(width: number, height: number): Uint8Array {
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 65535)) throw new Error('Invalid GIF dimensions.');
  return Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([
    width & 255, width >> 8, height & 255, height >> 8, 0x70, 0, 0, 0x21, 0xff, 11,
    ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0,
  ]));
}

export function gifFrame(width: number, height: number, rgba: Uint8ClampedArray, delay: number): Uint8Array {
  if (rgba.length !== width * height * 4 || !Number.isInteger(delay) || delay < 1 || delay > 65535) throw new Error('Invalid GIF frame or delay.');
  const { palette, indexed } = quantizeGif(rgba), compressed = lzw(indexed);
  const prefix = Uint8Array.from([0x21, 0xf9, 4, 4, delay & 255, delay >> 8, 0, 0,
    0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0x87]);
  const bytes = new Uint8Array(prefix.length + palette.length + compressed.length);
  bytes.set(prefix); bytes.set(palette, prefix.length); bytes.set(compressed, prefix.length + palette.length);
  return bytes;
}

export function finishGif(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 1));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  bytes[offset] = 0x3b;
  return bytes;
}
