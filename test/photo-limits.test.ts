import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPhotoSize, masterSize } from '../src/photo/limits.ts';

test('oriented sizes follow both even master rounding rules', () => {
  assert.deepEqual(masterSize({ width: 4032, height: 3024 }), { width: 2048, height: 1536 });
  assert.deepEqual(masterSize({ width: 3024, height: 4032 }), { width: 1536, height: 2048 });
  assert.deepEqual(masterSize({ width: 1500, height: 1125 }), { width: 1500, height: 1126 });
});
test('the three import refusals name their exact limits', () => {
  assert.deepEqual(checkPhotoSize({ width: 400, height: 300 }), {
    kind: 'too-small', limit: 'long-edge', original: { width: 400, height: 300 },
    message: 'This photo is too small. noisy needs at least 512 pixels on its long side.',
  });
  assert.deepEqual(checkPhotoSize({ width: 20000, height: 400 }), {
    kind: 'too-small', limit: 'master-short-side', original: { width: 20000, height: 400 },
    message: 'This photo is too narrow. Fitted within 2048 pixels, its short side would be under the 64 pixels noisy needs.',
  });
  assert.deepEqual(checkPhotoSize({ width: 9000, height: 8000 }), {
    kind: 'too-large', original: { width: 9000, height: 8000 },
    message: 'This photo is too large. noisy opens photos of up to 64 megapixels.',
  });
});
test('limits accept their boundaries and long-edge refusal takes priority', () => {
  assert.equal(checkPhotoSize({ width: 8000, height: 8000 }).kind, 'accepted');
  assert.equal(checkPhotoSize({ width: 2048, height: 64 }).kind, 'accepted');
  assert.equal(checkPhotoSize({ width: 512, height: 512 }).kind, 'accepted');
  const refused = checkPhotoSize({ width: 511, height: 30 });
  assert.ok(refused.kind === 'too-small' && refused.limit === 'long-edge');
});
