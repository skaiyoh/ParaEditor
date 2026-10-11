import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { encodeRaster, decodeRaster, inspectRaster, inspectPng, MAX_ASSET_BYTES, MAX_ORIGINAL_BYTES, MAX_RASTER_PAYLOAD_BYTES } from '../src/core/asset-codec.ts';
import { hashAsset, validateCompositionAsset, validateGenericAsset, validateCompositionAssets, compositionInventory, readAssetBody } from '../src/projects/assets.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { newComposition, artworkLayer, rasterSource } from './fixtures/composition.ts';
import { DEPTH_MODEL, assetId } from './fixtures/documents.ts';
import { serializeCompositionScene, deserializeProjectEnvelope } from '../src/projects/serialize.ts';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4zwAE/xnqQeR/bh7e/wAuSQWfwB0i9wAAAABJRU5ErkJggg==', 'base64'));

test('NSRA encodes exact view bytes, RGBA straight alpha and soft coverage; owns decoded buffers', async () => {
  const mask = encodeRaster({ format: 'u8', size: { width: 3, height: 2 }, data: new Uint8Array([99, 0, 1, 127, 128, 254, 255, 99]).subarray(1, 7) });
  assert.deepEqual([...mask], [78, 83, 82, 65, 1, 1, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 0, 1, 127, 128, 254, 255]);
  assert.notEqual(await hashAsset(mask), await hashAsset(mask.subarray(16)));
  const rgba = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 2, height: 1 }, data: new Uint8Array([255, 0, 0, 0, 0, 255, 0, 127]) });
  const restored = decodeRaster(rgba, { format: 'rgba8-srgb-straight', size: { width: 2, height: 1 } });
  assert.deepEqual([...restored.data], [255, 0, 0, 0, 0, 255, 0, 127]);
  rgba.fill(0); assert.equal(restored.data[0], 255);
  const backing = new Uint8Array(mask.length + 9); backing.set(mask, 3);
  assert.equal(await hashAsset(backing.subarray(3, 3 + mask.length)), await hashAsset(mask));
});

test('f32 uses explicit little-endian wire values even at unaligned view offsets', () => {
  const bytes = encodeRaster({ format: 'f32', size: { width: 3, height: 1 }, data: new Float32Array([99, 0, .25, 1, 99]).subarray(1, 4) });
  assert.deepEqual([...bytes.subarray(16)], [0, 0, 0, 0, 0, 0, 128, 62, 0, 0, 128, 63]);
  const backing = new Uint8Array(bytes.length + 1); backing.set(bytes, 1);
  assert.deepEqual([...decodeRaster(backing.subarray(1), { format: 'f32', size: { width: 3, height: 1 } }).data], [0, .25, 1]);
  for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1]) {
    assert.throws(() => encodeRaster({ format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([value]) }));
    const corrupt = bytes.slice(); new DataView(corrupt.buffer).setFloat32(16, value, true);
    assert.throws(() => inspectRaster(corrupt));
  }
});

test('raster version, format, reserved bytes, dimensions, payload length and descriptors reject corruption', async () => {
  const bytes = encodeRaster({ format: 'u8', size: { width: 2, height: 2 }, data: new Uint8Array(4) });
  for (const [index, value] of [[0, 0], [4, 2], [5, 4], [6, 1], [7, 1], [8, 0], [11, 1]]) {
    assert.ok(index !== undefined && value !== undefined);
    const invalid = bytes.slice(); invalid[index] = value; assert.throws(() => inspectRaster(invalid));
  }
  assert.throws(() => inspectRaster(bytes.subarray(0, 19)));
  assert.throws(() => inspectRaster(new Uint8Array([...bytes, 0])));
  assert.throws(() => decodeRaster(bytes, { format: 'u8', size: { width: 1, height: 4 } }));
  const asset = await hashAsset(bytes);
  await assert.rejects(validateCompositionAsset(bytes, asset, [{ asset, kind: 'raster', format: 'f32', size: { width: 1, height: 1 }, byteLength: 20 }]));
  await assert.rejects(validateCompositionAsset(bytes, assetId(999), [{ asset: assetId(999), kind: 'raster', format: 'u8', size: { width: 2, height: 2 }, byteLength: 20 }]));
});

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12 + data.length), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(type), 4); bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}
function pngWith(raw: Uint8Array, width = 2, height = 2): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  return new Uint8Array([...png.subarray(0, 8), ...chunk('IHDR', header), ...chunk('IDAT', deflateSync(raw)), ...chunk('IEND', new Uint8Array())]);
}

test('PNG checks complete framing, CRC, decoded row lengths, filters and dimensions, not only signature', async () => {
  const asset = await hashAsset(png);
  await validateGenericAsset(png, asset);
  await validateCompositionAsset(png, asset, [{ asset, kind: 'png', size: { width: 2, height: 2 }, byteLength: null }]);
  await assert.rejects(validateCompositionAsset(png, asset, [{ asset, kind: 'png', size: { width: 1, height: 4 }, byteLength: null }]));
  const corrupt = png.slice(); corrupt[30] = (corrupt[30] ?? 0) ^ 1;
  for (const bytes of [corrupt, png.subarray(0, 50), new Uint8Array([...png, 0]), pngWith(new Uint8Array(17)), pngWith(new Uint8Array(19)), pngWith(new Uint8Array([5, ...new Uint8Array(17)])), pngWith(new Uint8Array(18), 2049)]) {
    await assert.rejects(validateGenericAsset(bytes, await hashAsset(bytes)));
  }
  assert.deepEqual(inspectPng(png).size, { width: 2, height: 2 });
});

test('exact generic/original ceilings, raw 2048-square payload plus header and streaming bounds', async () => {
  assert.equal(MAX_ASSET_BYTES, 20_971_520); assert.equal(MAX_ORIGINAL_BYTES, 25_165_824); assert.equal(MAX_RASTER_PAYLOAD_BYTES, 16_777_216);
  const raw = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 2048, height: 2048 }, data: new Uint8Array(MAX_RASTER_PAYLOAD_BYTES) });
  assert.equal(raw.length, 16_777_232); await validateGenericAsset(raw, await hashAsset(raw));
  assert.throws(() => encodeRaster({ format: 'u8', size: { width: 2049, height: 1 }, data: new Uint8Array(2049) }));
  // A valid ancillary chunk pads an otherwise unchanged PNG to the exact ceiling.
  const padding = chunk('tEXt', new Uint8Array(MAX_ASSET_BYTES - png.length - 12));
  const exact = new Uint8Array(MAX_ASSET_BYTES); exact.set(png.subarray(0, 33)); exact.set(padding, 33); exact.set(png.subarray(33), 33 + padding.length);
  await validateGenericAsset(exact, await hashAsset(exact));
  await assert.rejects(validateGenericAsset(new Uint8Array(MAX_ASSET_BYTES + 1), assetId(1)));
  const original = new Uint8Array(MAX_ORIGINAL_BYTES), asset = await hashAsset(original);
  await validateCompositionAsset(original, asset, [{ asset, kind: 'original', mediaType: 'image/jpeg', byteLength: original.length }]);
  await assert.rejects(validateCompositionAsset(new Uint8Array(MAX_ORIGINAL_BYTES + 1), asset, [{ asset, kind: 'original', mediaType: 'image/jpeg', byteLength: MAX_ORIGINAL_BYTES + 1 }]));
  assert.equal((await readAssetBody(new Blob([new Uint8Array(7)]).stream(), 7)).length, 7);
  await assert.rejects(readAssetBody(new Blob([new Uint8Array(8)]).stream(), 7));
});

test('complete inventory requires every byte, rejects offset overflow and conflicting descriptors, and excludes paint', async () => {
  const original = newComposition(), master = await hashAsset(png);
  const doc = compositionDocumentSchema.parse({ ...original, frame: { ...original.frame, master: { ...original.frame.master, asset: master } } });
  assert.deepEqual(await validateCompositionAssets(doc, async () => png), { bytes: png.length, assets: 1 });
  await assert.rejects(validateCompositionAssets(doc, async () => null), /missing/);
  const depth = encodeRaster({ format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([1]) }), depthId = await hashAsset(depth);
  const rgba = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 13, height: 7 }, data: new Uint8Array(13 * 7 * 4) }), rgbaId = await hashAsset(rgba);
  const mask = encodeRaster({ format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array([127]) }), maskId = await hashAsset(mask);
  const layer = artworkLayer(), source = rasterSource();
  const full = compositionDocumentSchema.parse({ ...doc, sources: [{ ...source, image: { ...source.image, asset: rgbaId } }], objects: [{ ...layer,
    produced: { ...layer.produced, mask: { ...layer.produced.mask, asset: maskId } },
    depthAttachment: { kind: 'source', model: DEPTH_MODEL, offset: .1, map: { asset: depthId, format: 'f32', size: { width: 1, height: 1 } } } }] });
  const assets = new Map([[master, png], [depthId, depth], [rgbaId, rgba], [maskId, mask]]);
  await assert.rejects(validateCompositionAssets(full, async (id) => assets.get(id) ?? null), /offset/);
  assert.equal(compositionInventory(full).size, 4);
  assert.throws(() => deserializeProjectEnvelope({ transportVersion: 2, document: { ...full, objects: [{ ...layer, content: { kind: 'paint' } }] }, revision: 1 }));
  assert.throws(() => deserializeProjectEnvelope({ transportVersion: 2, document: { ...doc, version: 6 }, revision: 1 }));
  assert.throws(() => deserializeProjectEnvelope({ transportVersion: 3, document: doc, revision: 1 }));
});

test('indexed PNG validates reconstructed palette indices, including filtered rows', async () => {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, 1); view.setUint32(4, 2); header[8] = 8; header[9] = 3;
  for (const filter of [0, 1, 2, 3, 4]) {
    for (const index of [0, 255]) {
      const bytes = new Uint8Array([...png.subarray(0, 8), ...chunk('IHDR', header), ...chunk('PLTE', new Uint8Array([255, 0, 0])),
        ...chunk('IDAT', deflateSync(new Uint8Array([0, 0, filter, index]))), ...chunk('IEND', new Uint8Array())]);
      if (index === 0) await validateGenericAsset(bytes, await hashAsset(bytes));
      else await assert.rejects(validateGenericAsset(bytes, await hashAsset(bytes)), /palette index/);
    }
  }
});

test('packed indexed Adam7 PNG resets each pass and ignores unused padding bits', async () => {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, 1); view.setUint32(4, 2); header[8] = 4; header[9] = 3; header[12] = 1;
  // Two nonempty one-pixel passes. Low nibble is padding, not a palette index.
  const bytes = new Uint8Array([...png.subarray(0, 8), ...chunk('IHDR', header), ...chunk('PLTE', new Uint8Array([255, 0, 0])),
    ...chunk('IDAT', deflateSync(new Uint8Array([4, 15, 4, 15]))), ...chunk('IEND', new Uint8Array())]);
  await validateGenericAsset(bytes, await hashAsset(bytes));
});

test('shared descriptors count once and aggregate 64 MiB rejects before any save request', async () => {
  const { saveComposition, compositionSaveRetention } = await import('../src/projects/store.ts');
  const original = newComposition(), master = await hashAsset(png);
  const doc = compositionDocumentSchema.parse({ ...original, frame: { ...original.frame, master: { ...original.frame.master, asset: master }, source: { asset: master, mediaType: 'image/png', byteLength: png.length } } });
  assert.deepEqual(await validateCompositionAssets(doc, async () => png), { bytes: 79, assets: 1 });
  const sources = Array.from({ length: 4 }, (_, i) => {
    const source = rasterSource(i + 1);
    return { ...source, image: { ...source.image, size: { width: 2048, height: 2048 } } };
  });
  const excessive = compositionDocumentSchema.parse({ ...doc, sources });
  const assets = new Map([[master, png]]);
  for (const source of sources) assets.set(source.image.asset, new Uint8Array(16 + 2048 * 2048 * 4));
  await assert.rejects(saveComposition({ document: excessive, revision: 0, assets, thumbnail: new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }) }), /64 MiB/);
  assert.deepEqual(compositionSaveRetention(doc.id), []);
});
