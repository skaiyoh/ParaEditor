import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPhotoSize, HEIC_MESSAGE, masterSize } from '../src/photo/limits.ts';
import { decodePhoto, hasHeifBrand } from '../src/photo/decode.ts';

test('raw HEIC/HEIF is refused by content with actionable recovery, even under a JPEG name', async () => {
  assert.equal(HEIC_MESSAGE, "Export HEIC/HEIF as JPEG or PNG. For new photos: Settings > Camera > Formats > Most Compatible.");
  for (const brand of ['heic', 'heix', 'mif1', 'msf1']) {
    for (const offset of [8, 16]) {
      const header = new Uint8Array(32);
      new DataView(header.buffer).setUint32(0, header.length);
      header.set(new TextEncoder().encode('ftyp'), 4);
      header.set(new TextEncoder().encode(brand), offset);
      assert.equal(hasHeifBrand(header), true);
      await assert.rejects(decodePhoto(new File([header], 'photo.jpg', { type: 'image/jpeg' })), { message: HEIC_MESSAGE });
    }
  }
  assert.equal(hasHeifBrand(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(hasHeifBrand(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
});

test('oriented sizes follow both even master rounding rules', () => {
  assert.deepEqual(masterSize({ width: 4032, height: 3024 }), { width: 2048, height: 1536 });
  assert.deepEqual(masterSize({ width: 3024, height: 4032 }), { width: 1536, height: 2048 });
  assert.deepEqual(masterSize({ width: 1500, height: 1125 }), { width: 1500, height: 1126 });
});
test('the three import refusals name their exact limits', () => {
  assert.deepEqual(checkPhotoSize({ width: 400, height: 300 }), {
    kind: 'too-small', limit: 'long-edge', original: { width: 400, height: 300 },
    message: 'This photo is too small. ParaEditor needs at least 512 pixels on its long side.',
  });
  assert.deepEqual(checkPhotoSize({ width: 20000, height: 400 }), {
    kind: 'too-small', limit: 'master-short-side', original: { width: 20000, height: 400 },
    message: 'This photo is too narrow. Fitted within 2048 pixels, its short side would be under the 64 pixels ParaEditor needs.',
  });
  assert.deepEqual(checkPhotoSize({ width: 9000, height: 8000 }), {
    kind: 'too-large', original: { width: 9000, height: 8000 },
    message: 'This photo is too large. ParaEditor opens photos of up to 64 megapixels.',
  });
});
test('limits accept their boundaries and long-edge refusal takes priority', () => {
  assert.equal(checkPhotoSize({ width: 8000, height: 8000 }).kind, 'accepted');
  assert.equal(checkPhotoSize({ width: 2048, height: 64 }).kind, 'accepted');
  assert.equal(checkPhotoSize({ width: 512, height: 512 }).kind, 'accepted');
  const refused = checkPhotoSize({ width: 511, height: 30 });
  assert.ok(refused.kind === 'too-small' && refused.limit === 'long-edge');
});
