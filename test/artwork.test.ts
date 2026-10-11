import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { decodeRaster, MAX_ORIGINAL_BYTES, RASTER_HEADER_BYTES } from '../src/core/asset-codec.ts';
import { sourceIdSchema } from '../src/core/composition-schema.ts';
import { artworkSize, decodeArtwork, inspectArtwork } from '../src/photo/artwork.ts';
import { HEIC_MESSAGE } from '../src/photo/limits.ts';

const id = sourceIdSchema.parse('00000000-0000-4000-8000-000000000123');
// These are header fixtures, not decodable images. Real codec/color/orientation cases belong to C3i.
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode('IHDR'), 12); view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
function jpeg(width: number, height: number, marker = 0xc0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array([255, 216, 255, 225, 0, 4, 0, 0, 255, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  const view = new DataView(bytes.buffer); view.setUint16(13, height); view.setUint16(15, width); return bytes;
}
function webp(width: number, height: number, chunk: 'VP8X' | 'VP8L' | 'VP8 '): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunk === 'VP8L' ? 26 : 30), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF')); view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode(`WEBP${chunk}`), 8); view.setUint32(16, chunk === 'VP8L' ? 5 : 10, true);
  if (chunk === 'VP8X') {
    view.setUint16(24, (width - 1) & 0xffff, true); view.setUint8(26, (width - 1) >>> 16);
    view.setUint16(27, (height - 1) & 0xffff, true); view.setUint8(29, (height - 1) >>> 16);
  } else if (chunk === 'VP8L') {
    bytes[20] = 0x2f; view.setUint32(21, ((height - 1) << 14) | (width - 1), true);
  } else {
    bytes.set([0x9d, 1, 0x2a], 23); view.setUint16(26, width, true); view.setUint16(28, height, true);
  }
  return bytes;
}

test('small, odd and very thin artwork fits within 2048 without photo minimums or enlargement', () => {
  for (const size of [{ width: 1, height: 1 }, { width: 13, height: 7 }, { width: 511, height: 3 }, { width: 2048, height: 1 }]) {
    assert.deepEqual(artworkSize(size), size);
  }
  assert.deepEqual(artworkSize({ width: 4032, height: 3024 }), { width: 2048, height: 1536 });
  assert.deepEqual(artworkSize({ width: 3024, height: 4032 }), { width: 1536, height: 2048 });
  assert.deepEqual(artworkSize({ width: 64_000_000, height: 1 }), { width: 2048, height: 1 });
  assert.deepEqual(artworkSize({ width: 8000, height: 8000 }), { width: 2048, height: 2048 });
  for (const width of [0, -1, .5, NaN, Infinity, 64_000_001]) assert.throws(() => artworkSize({ width, height: 1 }));
});

test('PNG, baseline/progressive JPEG and all three WebP dimension headers are recognized by content', () => {
  assert.deepEqual(inspectArtwork(png(13, 7)), { mediaType: 'image/png', size: { width: 13, height: 7 } });
  for (const marker of [0xc0, 0xc1, 0xc2]) assert.deepEqual(inspectArtwork(jpeg(13, 7, marker)), { mediaType: 'image/jpeg', size: { width: 13, height: 7 } });
  for (const chunk of ['VP8X', 'VP8L', 'VP8 '] satisfies ('VP8X' | 'VP8L' | 'VP8 ')[]) {
    assert.deepEqual(inspectArtwork(webp(13, 7, chunk)), { mediaType: 'image/webp', size: { width: 13, height: 7 } });
    assert.deepEqual(inspectArtwork(webp(1, 1, chunk)).size, { width: 1, height: 1 });
  }
  assert.deepEqual(inspectArtwork(webp(100_000, 2, 'VP8X')).size, { width: 100_000, height: 2 });
});

test('unsupported, truncated, malformed, oversize and HEIF files refuse before browser allocation', async () => {
  const refused = [new Uint8Array(), new TextEncoder().encode('<svg width="13" height="7"/>'),
    new TextEncoder().encode('GIF89a'), new TextEncoder().encode('BM'), png(9000, 8000), png(0, 1),
    jpeg(13, 7).subarray(0, 14), new Uint8Array(MAX_ORIGINAL_BYTES + 1)];
  for (const valid of [png(13, 7), jpeg(13, 7), webp(13, 7, 'VP8X'), webp(13, 7, 'VP8L'), webp(13, 7, 'VP8 ')]) {
    for (let length = 0; length < valid.length; length++) refused.push(valid.slice(0, length));
  }
  for (const bytes of refused) {
    assert.throws(() => inspectArtwork(bytes));
    await assert.rejects(decodeArtwork({ id, file: new File([bytes], 'misleading.png', { type: 'image/png' }) }));
  }
  for (const brand of ['heic', 'heix', 'mif1', 'msf1']) {
    const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(0, 32);
    bytes.set(new TextEncoder().encode('ftyp'), 4); bytes.set(new TextEncoder().encode(brand), 16);
    await assert.rejects(decodeArtwork({ id, file: new File([bytes], 'fake.jpg') }), { message: HEIC_MESSAGE });
  }
  const ceiling = new Uint8Array(MAX_ORIGINAL_BYTES); ceiling.set(png(1, 1));
  assert.deepEqual(inspectArtwork(ceiling).size, { width: 1, height: 1 });
});

type HarnessOptions = {
  readonly original: { readonly width: number; readonly height: number };
  readonly data: Uint8ClampedArray;
  readonly resize: 'honored' | 'throws' | 'ignored';
  readonly canvas: 'ok' | 'null' | 'throws' | 'wrong-color';
  readonly image: 'ok' | 'error';
};
function browserHarness(t: TestContext, overrides: Partial<HarnessOptions> = {}) {
  const options: HarnessOptions = { original: { width: 2, height: 1 },
    data: new Uint8ClampedArray([200, 100, 50, 128, 20, 30, 40, 0]),
    resize: 'honored', canvas: 'ok', image: 'ok', ...overrides };
  const requests: ImageBitmapOptions[] = [], closed: number[] = [], revoked: string[] = [];
  let removed = false;
  function global(name: string, value: unknown): void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  global('Image', class {
    naturalWidth = options.original.width; naturalHeight = options.original.height;
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => options.image === 'ok' ? this.onload?.() : this.onerror?.()); }
    removeAttribute(name: string) { assert.equal(name, 'src'); removed = true; }
  });
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { assert.ok(['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)); return 'blob:artwork-test'; });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  global('createImageBitmap', async (_blob: Blob, request: ImageBitmapOptions) => {
    const index = requests.push(request);
    assert.equal(request.imageOrientation, 'from-image'); assert.equal(request.colorSpaceConversion, 'default');
    if (request.resizeWidth !== undefined && options.resize === 'throws') throw new Error('Resize unsupported');
    const size = request.resizeWidth !== undefined && options.resize === 'honored'
      ? { width: request.resizeWidth, height: request.resizeHeight }
      : options.original;
    return { ...size, close: () => { closed.push(index); } };
  });
  global('OffscreenCanvas', class {
    width: number; height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext(kind: string, settings: unknown) {
      assert.equal(kind, '2d'); assert.deepEqual(settings, { alpha: true, colorSpace: 'srgb', willReadFrequently: true });
      if (options.canvas === 'null') return null;
      return { imageSmoothingEnabled: false, imageSmoothingQuality: 'low',
        drawImage: (_bitmap: unknown, x: number, y: number, width: number, height: number) => {
          assert.deepEqual([x, y, width, height], [0, 0, this.width, this.height]);
          if (options.canvas === 'throws') throw new Error('Drawing failed');
        },
        getImageData: (_x: number, _y: number, width: number, height: number, settings: unknown) => {
          assert.deepEqual(settings, { colorSpace: 'srgb' });
          return { width, height, colorSpace: options.canvas === 'wrong-color' ? 'display-p3' : 'srgb', data: options.data };
        },
      };
    }
  });
  return { requests, closed, revoked, removed: () => removed, data: options.data };
}

test('native API orchestration emits straight alpha NSRA and exact provenance/hash without mutating pixels', async t => {
  const h = browserHarness(t), original = png(2, 1), before = h.data.slice();
  const result = await decodeArtwork({ id, file: new File([original], 'icon.fake', { type: 'text/plain' }) });
  assert.equal(result.path, 'resize'); assert.equal(result.bytes.length, RASTER_HEADER_BYTES + 8);
  assert.deepEqual(result.source.provenance, { kind: 'import', name: 'icon.fake', mediaType: 'image/png',
    originalSize: { width: 2, height: 1 }, originalDigest: createHash('sha256').update(original).digest('hex') });
  assert.equal(result.source.image.asset, createHash('sha256').update(result.bytes).digest('hex'));
  assert.equal(result.source.id, id);
  const decoded = decodeRaster(result.bytes, { format: 'rgba8-srgb-straight', size: { width: 2, height: 1 } });
  assert.deepEqual([...decoded.data], [200, 100, 50, 128, 0, 0, 0, 0]);
  assert.deepEqual(h.data, before); assert.deepEqual(h.closed, [1]);
  assert.deepEqual(h.revoked, ['blob:artwork-test']); assert.ok(h.removed());
});

for (const resize of ['honored', 'throws', 'ignored'] satisfies HarnessOptions['resize'][]) {
  test(`oriented downsize and resource cleanup with ${resize} resize options (browser API stub)`, async t => {
    const h = browserHarness(t, { original: { width: 1, height: 4096 }, resize, data: new Uint8ClampedArray(2048 * 4) });
    const result = await decodeArtwork({ id, file: new File([png(4096, 1)], 'rotated.png') });
    assert.deepEqual(result.source.provenance.originalSize, { width: 1, height: 4096 });
    assert.deepEqual(result.source.image.size, { width: 1, height: 2048 });
    assert.equal(result.path, resize === 'honored' ? 'resize' : 'fallback');
    assert.deepEqual(h.closed, resize === 'ignored' ? [1, 2] : resize === 'throws' ? [2] : [1]);
    assert.deepEqual(h.revoked, ['blob:artwork-test']); assert.ok(h.removed());
  });
}

for (const canvas of ['null', 'throws', 'wrong-color'] satisfies HarnessOptions['canvas'][]) {
  test(`failed ${canvas} canvas releases the decoded bitmap and URL (browser API stub)`, async t => {
    const h = browserHarness(t, { canvas });
    await assert.rejects(decodeArtwork({ id, file: new File([png(2, 1)], 'icon.png') }));
    assert.deepEqual(h.closed, [1]); assert.deepEqual(h.revoked, ['blob:artwork-test']);
  });
}

test('native image refusal releases URL and never starts bitmap decode (browser API stub)', async t => {
  const h = browserHarness(t, { image: 'error' });
  await assert.rejects(decodeArtwork({ id, file: new File([png(2, 1)], 'bad.png') }));
  assert.deepEqual(h.requests, []); assert.deepEqual(h.revoked, ['blob:artwork-test']); assert.ok(h.removed());
});

test('decoded dimensions must match encoded axes before raster allocation (browser API stub)', async t => {
  const h = browserHarness(t, { original: { width: 3, height: 1 } });
  await assert.rejects(decodeArtwork({ id, file: new File([png(2, 1)], 'bad.png') }), /changed its original dimensions/);
  assert.deepEqual(h.requests, []); assert.deepEqual(h.revoked, ['blob:artwork-test']);
});
