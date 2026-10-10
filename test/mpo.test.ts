import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeMpo } from '../src/export/mpo.ts';

// Tiny synthetic baseline headers and opaque scan data, never decoded by these container tests.
const jpeg = (value: number): Uint8Array => new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, value, 0xff, 0, 0xff, 0xd9,
]);

/** Independent reader: discover tags and entries through their offsets. */
function readIndex(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: { offset: number; length: number }[] = [];
  for (let p = 2; p < bytes.length;) {
    assert.equal(bytes[p], 0xff);
    const marker = bytes[p + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(p + 2);
    if (marker === 0xe2 && String.fromCharCode(...bytes.subarray(p + 4, p + 8)) === 'MPF\0') segments.push({ offset: p, length: length + 2 });
    p += length + 2;
  }
  assert.equal(segments.length, 1);
  const segment = segments[0]; assert.ok(segment);
  const base = segment.offset + 8;
  assert.equal(view.getUint32(base), 0x4d4d002a);
  const ifd = base + view.getUint32(base + 4);
  const tags = new Map<number, { type: number; count: number; value: number }>();
  const count = view.getUint16(ifd);
  for (let i = 0; i < count; i++) {
    const p = ifd + 2 + i * 12;
    tags.set(view.getUint16(p), { type: view.getUint16(p + 2), count: view.getUint32(p + 4), value: view.getUint32(p + 8) });
  }
  assert.deepEqual(tags.get(0xb000), { type: 7, count: 4, value: 0x30313030 });
  assert.deepEqual(tags.get(0xb001), { type: 4, count: 1, value: 2 });
  const entriesTag = tags.get(0xb002); assert.ok(entriesTag);
  assert.equal(entriesTag.type, 7); assert.equal(entriesTag.count, 32);
  assert.equal(view.getUint32(ifd + 2 + count * 12), 0);
  const entries = [0, 1].map((i) => {
    const p = base + entriesTag.value + i * 16;
    return { attribute: view.getUint32(p), size: view.getUint32(p + 4), offset: view.getUint32(p + 8),
      dependencies: [view.getUint16(p + 12), view.getUint16(p + 14)] };
  });
  return { segment, base, entries };
}

for (const exif of [false, true]) test(`MPO index preserves two JPEGs and resolves the second SOI${exif ? ' after APP0 and APP1' : ''}`, () => {
  let left = jpeg(0x31);
  if (exif) {
    const apps = new Uint8Array([0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    left = new Uint8Array([...left.subarray(0, 2), ...apps, ...left.subarray(2)]);
  }
  const right = jpeg(0x62), beforeLeft = left.slice(), beforeRight = right.slice();
  const encoded = encodeMpo(left, right), { segment, base, entries } = readIndex(encoded);
  assert.deepEqual(encoded.subarray(0, 2), new Uint8Array([0xff, 0xd8]));
  assert.equal(segment.offset, exif ? 18 : 2);
  assert.equal(encoded.length, left.length + right.length + segment.length);
  const first = entries[0], second = entries[1]; assert.ok(first); assert.ok(second);
  assert.deepEqual(first, { attribute: 0x20020002, size: left.length + segment.length, offset: 0, dependencies: [0, 0] });
  assert.deepEqual(second, { attribute: 0x20002, size: right.length, offset: first.size - base, dependencies: [0, 0] });
  assert.equal(base + second.offset, first.size);
  assert.deepEqual(encoded.subarray(base + second.offset, base + second.offset + 2), new Uint8Array([0xff, 0xd8]));
  assert.deepEqual(encoded.subarray(first.size), right);
  assert.deepEqual(new Uint8Array([...encoded.subarray(0, segment.offset), ...encoded.subarray(segment.offset + segment.length, first.size)]), left);
  assert.deepEqual(left, beforeLeft); assert.deepEqual(right, beforeRight);
  assert.deepEqual(encodeMpo(left, right), encoded);
});

test('MPO accepts byte views with a nonzero underlying buffer offset', () => {
  const source = new Uint8Array([12, ...jpeg(1), 13]);
  const slice = source.subarray(1, source.length - 1);
  assert.deepEqual(encodeMpo(slice, slice), encodeMpo(jpeg(1), jpeg(1)));
});

test('MPO rejects truncated JPEGs, broken segment lengths and existing MP indexes', () => {
  const valid = jpeg(1);
  assert.throws(() => encodeMpo(valid.subarray(0, valid.length - 1), valid), /complete JPEG/);
  assert.throws(() => encodeMpo(valid, new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0xff, 0xd9])), /segment length/);
  assert.throws(() => encodeMpo(valid, new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd9])), /truncated/);
  const existing = encodeMpo(valid, valid);
  assert.throws(() => encodeMpo(existing, valid), /existing MP index/);
  assert.throws(() => encodeMpo(valid, existing), /existing MP index/);
});
