import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deserializeDocument, deserializeMask, deserializeScene, serializeDocument, serializeMask, serializeScene } from '../src/projects/serialize.ts';
import type { Plane } from '../src/core/raster.ts';
import { assetId, fiveClusterDocument, invalidVariants, minimalDocument, validDocuments } from './fixtures/documents.ts';

test('every full document fixture round-trips through JSON and the versioned parser', () => {
  for (const document of validDocuments()) {
    const wire: unknown = JSON.parse(JSON.stringify(serializeDocument(document)));
    assert.deepEqual(deserializeDocument(wire), document);
    assert.notEqual(deserializeDocument(wire), document);
  }
});

test('invalid documents and future versions fail at the transport boundary', () => {
  for (const fixture of invalidVariants()) assert.throws(() => deserializeDocument(fixture.json), fixture.name);
  assert.throws(() => deserializeDocument({ ...minimalDocument(), version: 999 }));
  assert.throws(() => deserializeDocument(null));
});

test('u8 masks preserve soft bytes, row order and a view offset, with owned buffers', () => {
  const backing = new Uint8Array([99, 0, 1, 127, 128, 254, 255, 99]);
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 3, height: 2 }, data: backing.subarray(1, 7) };
  const wire = serializeMask(mask);
  assert.deepEqual([...wire], [0, 1, 127, 128, 254, 255]);
  const restored = deserializeMask(wire, mask.size);
  assert.deepEqual([...restored.data], [0, 1, 127, 128, 254, 255]);
  backing.fill(42); wire.fill(11);
  assert.deepEqual([...restored.data], [0, 1, 127, 128, 254, 255]);
  assert.equal(restored.format, 'u8');
});

test('mask byte lengths, dimensions and allocation bounds are checked before restoring', () => {
  for (const size of [{ width: 0, height: 1 }, { width: 1.5, height: 2 }, { width: 4097, height: 1 }, { width: Infinity, height: 1 }]) {
    assert.throws(() => deserializeMask(new Uint8Array(1), size));
  }
  assert.throws(() => deserializeMask(new Uint8Array(5), { width: 3, height: 2 }));
  assert.throws(() => serializeMask({ format: 'u8', size: { width: 3, height: 2 }, data: new Uint8Array(5) }));
});

test('scene transport includes exactly the distinct object masks at their referenced sizes', () => {
  const document = fiveClusterDocument();
  const masks = new Map(document.objects.map((object) => [object.produced.mask.asset, {
    format: 'u8', size: object.produced.mask.size, data: new Uint8Array(object.produced.mask.size.width * object.produced.mask.size.height),
  } satisfies Plane<'u8'>]));
  masks.set(assetId(999), { format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array(1) });
  const wire = serializeScene(document, masks, 12);
  assert.equal(Object.keys(wire.masks).length, document.objects.length);
  assert.deepEqual(deserializeScene(JSON.parse(JSON.stringify(wire))).document, document);
  assert.equal(deserializeScene(wire).revision, 12);
  const first = document.objects[0];
  assert.ok(first !== undefined);
  assert.throws(() => deserializeScene({ ...wire, masks: {} }));
  assert.throws(() => deserializeScene({ ...wire, masks: { ...wire.masks, [assetId(999)]: { width: 1, height: 1 } } }));
  assert.throws(() => deserializeScene({ ...wire, masks: { ...wire.masks, [first.produced.mask.asset]: { width: 1, height: 1 } } }));
  assert.throws(() => deserializeScene({ ...wire, masks: { '../escape': { width: 1, height: 1 } } }));
  assert.throws(() => serializeScene(document, new Map(), 0));
  assert.deepEqual(serializeScene(minimalDocument(), new Map(), 0).masks, {});
});

test('scene revisions are required, nonnegative safe integers and survive transport', () => {
  const wire = serializeScene(minimalDocument(), new Map(), 0);
  assert.equal(deserializeScene(wire).revision, 0);
  assert.throws(() => deserializeScene({ document: wire.document, masks: wire.masks }));
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1']) {
    assert.throws(() => deserializeScene({ ...wire, revision }));
  }
  assert.throws(() => serializeScene(minimalDocument(), new Map(), -1));
  assert.equal(deserializeScene(serializeScene(minimalDocument(), new Map(), 13)).revision, 13);
});
