import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskBounds, maskedColor, maskedDepth, objectProduced } from '../src/session/objects.ts';
import { srgbToOklab } from '../src/core/color.ts';
import type { Plane } from '../src/core/raster.ts';
import { newObject } from '../src/core/defaults.ts';
import { applyEdit } from '../src/core/reduce.ts';
import { sceneDocumentSchema } from '../src/core/schema.ts';
import { assetId, minimalDocument, OBJECT_IDS, SAM_MODEL } from './fixtures/documents.ts';

const full: Plane<'u8'> = { format: 'u8', size: { width: 2, height: 2 }, data: new Uint8Array(4).fill(255) };
const twoTone = { width: 2, height: 2, data: new Uint8ClampedArray([
  255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255,
]) };
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('disc guide texel bounds map outward to master pixels, including noninteger ratios', () => {
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 1024, height: 768 }, data: new Uint8Array(1024 * 768) };
  for (let y = 0; y < 768; y++) for (let x = 0; x < 1024; x++) {
    if ((x - 300) ** 2 + (y - 350) ** 2 <= 100 ** 2) mask.data[y * 1024 + x] = 128;
  }
  assert.deepEqual(maskBounds(mask, { width: 2048, height: 1536 }), { x: 400, y: 500, width: 402, height: 402 });
  assert.deepEqual(maskBounds(mask, { width: 2001, height: 1501 }), {
    x: Math.floor(200 * 2001 / 1024), y: Math.floor(250 * 1501 / 768),
    width: Math.ceil(401 * 2001 / 1024) - Math.floor(200 * 2001 / 1024),
    height: Math.ceil(451 * 1501 / 768) - Math.floor(250 * 1501 / 768),
  });
});

test('coverage threshold rejects fewer than 0.1 percent, and accepts exactly the boundary', () => {
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 100, height: 10 }, data: new Uint8Array(1000).fill(127) };
  assert.equal(maskBounds(mask, mask.size), null);
  mask.data[0] = 128;
  assert.deepEqual(maskBounds(mask, mask.size), { x: 0, y: 0, width: 1, height: 1 });
});

test('depth statistics sample only occupied pixels across differing plane resolutions', () => {
  const mask: Plane<'u8'> = { ...full, data: new Uint8Array([255, 0, 255, 0]) };
  const depth: Plane<'f32'> = { format: 'f32', size: { width: 2, height: 5 },
    data: new Float32Array([0, 1, 0.25, 1, 0.5, 1, 0.75, 1, 1, 1]) };
  const stats = maskedDepth(mask, depth);
  assert.ok(stats !== null);
  close(stats.p10, 0.1); close(stats.median, 0.5); close(stats.p90, 0.9);
  assert.equal(maskedDepth({ ...full, data: new Uint8Array(4) }, depth), null);
});

test('masked two-tone mean and weighted clusters exclude outside pixels and are deterministic', () => {
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 4, height: 2 }, data: new Uint8Array([255, 255, 0, 0, 255, 255, 0, 0]) };
  const image = { width: 4, height: 2, data: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255,
    255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  ]) };
  const red = srgbToOklab({ r: 1, g: 0, b: 0 }), blue = srgbToOklab({ r: 0, g: 0, b: 1 });
  const color = maskedColor(mask, image, 42);
  close(color.mean.L, (red.L + blue.L) / 2); close(color.mean.a, (red.a + blue.a) / 2); close(color.mean.b, (red.b + blue.b) / 2);
  assert.equal(color.clusters.length, 2);
  for (const lab of [red, blue]) assert.ok(color.clusters.some((cluster) => {
    close(cluster.weight, 0.5);
    return Math.abs(cluster.lab.L - lab.L) < 1e-7 && Math.abs(cluster.lab.a - lab.a) < 1e-7 && Math.abs(cluster.lab.b - lab.b) < 1e-7;
  }));
  assert.deepEqual(color, maskedColor(mask, image, 42));
  // Resampling the larger guide to the smaller thumbnail preserves membership.
  const guide: Plane<'u8'> = { format: 'u8', size: { width: 8, height: 8 }, data: new Uint8Array(64).fill(255) };
  assert.deepEqual(maskedColor(guide, twoTone, 42), maskedColor(full, twoTone, 42));
});

test('assembled products, flat-color duplicate clusters and nullable depth parse through object.add in a document', () => {
  for (const flat of [false, true]) for (const depth of [null, { format: 'f32', size: full.size, data: new Float32Array([0, 0.25, 0.75, 1]) } satisfies Plane<'f32'>]) {
    const thumbnail = flat ? { ...twoTone, data: new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255, 128, 128, 128, 255]) } : twoTone;
    const produced = objectProduced({ model: SAM_MODEL, at: { x: 0.2, y: 0.7 }, asset: assetId(3), mask: full,
      master: full.size, depth, thumbnail, seed: 1 });
    assert.ok(produced !== null);
    assert.equal(produced.depth === null, depth === null);
    const doc = minimalDocument();
    const object = { ...newObject({ id: OBJECT_IDS[0], produced, existing: doc.objects }), subject: true };
    const result = applyEdit(doc, { kind: 'object.add', object }, '2026-10-09T14:00:00.000Z');
    assert.equal(result.kind, 'applied');
    const parsed = sceneDocumentSchema(doc.version).parse(result.doc);
    assert.deepEqual(parsed.objects[0]?.produced, produced);
    assert.equal(parsed.objects[0]?.subject, true);
  }
  assert.equal(objectProduced({ model: SAM_MODEL, at: { x: 0.5, y: 0.5 }, asset: assetId(3),
    mask: { ...full, data: new Uint8Array(4) }, master: full.size, depth: null, thumbnail: twoTone, seed: 1 }), null);
});


test('accepted thin masks retain color and depth when smaller-plane centers miss the guide region', () => {
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 1024, height: 768 }, data: new Uint8Array(1024 * 768) };
  for (let y = 0; y < 768; y++) { mask.data[y * 1024] = 255; mask.data[y * 1024 + 1] = 255; }
  assert.ok(maskBounds(mask, { width: 2048, height: 1536 }) !== null);
  const image = { width: 256, height: 192, data: new Uint8ClampedArray(256 * 192 * 4).fill(128) };
  const color = maskedColor(mask, image, 1);
  const gray = srgbToOklab({ r: 128 / 255, g: 128 / 255, b: 128 / 255 });
  close(color.mean.L, gray.L); close(color.mean.a, gray.a); close(color.mean.b, gray.b);
  const stats = maskedDepth(mask, { format: 'f32', size: { width: 256, height: 192 }, data: new Float32Array(256 * 192).fill(0.5) });
  assert.deepEqual(stats, { p10: 0.5, median: 0.5, p90: 0.5 });
});
