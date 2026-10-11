// Analysis products and the dropped source: each product kind applies, a
// product the document has moved past changes nothing, a product the schema
// refuses changes nothing, no product writes to its input, and every result
// parses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Produce, ProduceResult } from '../src/core/edits.ts';
import { applyProduce, dropSource, sortedMasks } from '../src/core/produce.ts';
import { applyEdit } from '../src/core/reduce.ts';
import { parseDocument, parseLegacyDocument } from '../src/core/schema.ts';
import type { SceneDocument } from '../src/core/types.ts';
import { assetId, fiveClusterDocument, legacyFiveClusterDocument, minimalDocument, OBJECT_IDS } from './fixtures/documents.ts';
import { minimalWithObject, objectId, tappedObject } from './fixtures/edits.ts';
import { depthProduct, plateProduct } from './fixtures/products.ts';

const NOW = '2026-10-02T18:00:00.000Z';

function assertValid(doc: SceneDocument, label: string): void {
  const parsed = parseDocument(doc);
  assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
}

function applied(result: ProduceResult, label = ''): SceneDocument {
  assert.equal(result.kind, 'applied', `${label} ${result.kind === 'refused' ? result.detail : ''}`);
  assert.equal(result.doc.updatedAt, NOW, label);
  assertValid(result.doc, label);
  return result.doc;
}

function assertUnchanged(doc: SceneDocument, product: Produce, label: string): void {
  const result = applyProduce(doc, product, NOW);
  assert.equal(result.kind, 'unchanged', label);
  assert.equal(result.doc, doc, label);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const [SUBJECT, BOX] = OBJECT_IDS;

// ---------------------------------------------------------------------------
// auto-subject

test('auto-subject with objects present adds nothing and sets autoSubject to done', () => {
  const before = minimalWithObject();
  assert.equal(before.analysis.autoSubject, 'pending');
  const after = applied(applyProduce(before, { kind: 'auto-subject', found: tappedObject(objectId(9)) }, NOW));
  assert.equal(after.analysis.autoSubject, 'done');
  assert.equal(after.objects, before.objects);
  assert.equal(after.objects.some((o) => o.subject), false);
});

test('auto-subject found: null sets autoSubject to done and adds nothing', () => {
  const before = minimalDocument();
  const after = applied(applyProduce(before, { kind: 'auto-subject', found: null }, NOW));
  assert.equal(after.analysis.autoSubject, 'done');
  assert.deepEqual(after.objects, []);
  assert.deepEqual({ ...after, analysis: before.analysis, updatedAt: before.updatedAt }, before);
});

test('auto-subject on a scene with no object adds the found object as the subject, and sets done', () => {
  const found = tappedObject(objectId(9));
  assert.equal(found.subject, false);
  const after = applied(applyProduce(minimalDocument(), { kind: 'auto-subject', found }, NOW));
  assert.deepEqual(after.objects, [{ ...found, subject: true }]);
  assert.equal(after.analysis.autoSubject, 'done');
});

test('auto-subject when autoSubject is already done is unchanged, with or without objects, found or not', () => {
  const done = applied(applyProduce(minimalDocument(), { kind: 'auto-subject', found: null }, NOW));
  assertUnchanged(done, { kind: 'auto-subject', found: tappedObject(objectId(9)) }, 'no objects, found');
  assertUnchanged(done, { kind: 'auto-subject', found: null }, 'no objects, null');
  assertUnchanged(fiveClusterDocument(), { kind: 'auto-subject', found: tappedObject(objectId(9)) }, 'objects, found');
});

test('auto-subject whose object the schema refuses changes nothing, and autoSubject stays pending', () => {
  const before = minimalDocument();
  const result = applyProduce(before, { kind: 'auto-subject', found: { ...tappedObject(objectId(9)), thickness: 9 } }, NOW);
  assert.equal(result.kind, 'refused');
  assert.equal(result.doc, before);
  assert.match(result.kind === 'refused' ? result.detail : '', /objects\[0\]: thickness/);
});

// ---------------------------------------------------------------------------
// object.depth

test('object.depth for an unknown id changes nothing', () => {
  assertUnchanged(fiveClusterDocument(), { kind: 'object.depth', id: objectId(7), depth: { p10: 0.1, median: 0.2, p90: 0.3 } }, 'unknown id');
});

test('object.depth replaces the statistics of an object that has them, and fills those of one that has none', () => {
  const before = fiveClusterDocument();
  assert.notEqual(before.objects[0]?.produced.depth, null);
  assert.equal(before.objects[1]?.produced.depth, null);
  const [subject] = before.objects;
  assert.ok(subject !== undefined);
  const depth = { p10: 0.05, median: 0.1, p90: 0.2 };
  const replaced = applied(applyProduce(before, { kind: 'object.depth', id: SUBJECT, depth }, NOW));
  assert.deepEqual(replaced.objects[0], { ...subject, produced: { ...subject.produced, depth } });
  assert.equal(replaced.objects[1], before.objects[1]);
  const filled = applied(applyProduce(before, { kind: 'object.depth', id: BOX, depth }, NOW));
  assert.deepEqual(filled.objects[1]?.produced.depth, depth);
  assert.equal(filled.objects[0], before.objects[0]);
});

test('object.depth with the statistics the object holds is unchanged, and one the schema refuses changes nothing', () => {
  const before = fiveClusterDocument();
  const held = before.objects[0]?.produced.depth;
  assert.ok(held !== undefined && held !== null);
  assertUnchanged(before, { kind: 'object.depth', id: SUBJECT, depth: { ...held } }, 'the same statistics');
  for (const median of [1.5, Number.NaN]) {
    const result = applyProduce(before, { kind: 'object.depth', id: SUBJECT, depth: { ...held, median } }, NOW);
    assert.equal(result.kind, 'refused', String(median));
    assert.equal(result.doc, before);
  }
});

// ---------------------------------------------------------------------------
// plate and depth

test('a plate made for the current sorted mask set replaces the plate', () => {
  const before = fiveClusterDocument();
  assert.deepEqual(sortedMasks(before), [assetId(0x31), assetId(0x32)]);
  const plate = plateProduct(1, sortedMasks(before));
  const after = applied(applyProduce(before, { kind: 'plate', plate, required: plate.key }, NOW));
  assert.deepEqual(after.analysis.plate, plate);
  assert.equal(after.analysis.depth, before.analysis.depth);
  assert.equal(after.objects, before.objects);
});

test('a stale plate, made for another mask set, changes nothing', () => {
  const before = fiveClusterDocument();
  for (const [label, forMasks] of [
    ['one mask fewer', [assetId(0x31)]],
    ['one mask more', [assetId(0x31), assetId(0x32), assetId(0x33)]],
    ['none', []],
  ] as const) {
    assertUnchanged(before, { kind: 'plate', plate: plateProduct(1, forMasks), required: plateProduct(0, sortedMasks(before), before).key }, label);
  }
  // An object added while the inpaint ran: the plate made for the masks before it is dropped.
  const asked = sortedMasks(before);
  const added = applyEdit(before, { kind: 'object.add', object: { ...tappedObject(objectId(0)), produced: { ...tappedObject(objectId(0)).produced, mask: { asset: assetId(0x30), format: 'u8', size: { width: 1024, height: 768 } } } } }, NOW);
  assert.equal(added.kind, 'applied');
  assertUnchanged(added.doc, { kind: 'plate', plate: plateProduct(2, asked), required: plateProduct(0, sortedMasks(added.doc), added.doc).key }, 'made before an object was added');
  applied(applyProduce(added.doc, { kind: 'plate', plate: plateProduct(2, sortedMasks(added.doc), added.doc), required: plateProduct(0, sortedMasks(added.doc), added.doc).key }, NOW), 'made after');
});

test('a plate for repeated masks applies, and malformed typed repair keys are refused', () => {
  const twins = { ...minimalWithObject(), objects: [tappedObject(objectId(0)), tappedObject(objectId(1))] };
  assert.deepEqual(sortedMasks(twins), [assetId(0x31), assetId(0x31)]);
  applied(applyProduce(twins, { kind: 'plate', plate: plateProduct(0, [assetId(0x31), assetId(0x31)], twins), required: plateProduct(0, sortedMasks(twins), twins).key }, NOW));
  const five = fiveClusterDocument();
  const legacy = legacyFiveClusterDocument();
  assert.ok(legacy.analysis.plate);
  // The frozen reader keeps the legacy sorted-list guard; v5 uses a typed basis.
  for (const forMasks of [[assetId(0x32), assetId(0x31)], [assetId(0x99), assetId(0x31)]]) {
    const old = parseLegacyDocument({ ...legacy, analysis: { ...legacy.analysis, plate: { ...legacy.analysis.plate, forMasks } } });
    assert.equal(old.ok, false, 'an unsorted legacy mask list is still refused');
    if (!old.ok) { assert.equal(old.error.kind, 'invalid'); assert.ok(old.error.kind === 'invalid' && /analysis.plate.forMasks/.test(old.error.detail)); }
    const candidate = plateProduct(0, forMasks);
    const result = applyProduce(five, { kind: 'plate', plate: { ...candidate, key: { ...candidate.key, radius: -1 } }, required: plateProduct(0, sortedMasks(five), five).key }, NOW);
    assert.equal(result.kind, 'refused');
    assert.equal(result.doc, five);
  }
});

test('a plate equal to the one stored is unchanged', () => {
  const before = fiveClusterDocument();
  assert.ok(before.analysis.plate !== null);
  assertUnchanged(before, { kind: 'plate', plate: { ...before.analysis.plate }, required: before.analysis.plate.key }, 'the stored plate');
});

test('depth replaces the depth product, sets it where there was none, and the same depth again is unchanged', () => {
  const five = fiveClusterDocument();
  const replaced = applied(applyProduce(five, { kind: 'depth', depth: depthProduct(1) }, NOW));
  assert.deepEqual(replaced.analysis.depth, depthProduct(1));
  assert.equal(replaced.analysis.plate, null, 'a changed source depth invalidates the repair basis');
  const set = applied(applyProduce(minimalDocument(), { kind: 'depth', depth: depthProduct(2) }, NOW));
  assert.deepEqual(set.analysis.depth, depthProduct(2));
  assertUnchanged(set, { kind: 'depth', depth: depthProduct(2) }, 'the same depth');
  const refused = applyProduce(five, { kind: 'depth', depth: depthProduct(1, { p10: -1, median: 0.5, p90: 0.9 }) }, NOW);
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.doc, five);
});

test('no product writes to its input document', () => {
  const products: readonly Produce[] = [
    { kind: 'depth', depth: depthProduct(1) },
    { kind: 'plate', plate: plateProduct(1, [assetId(0x31), assetId(0x32)]), required: plateProduct(0, [assetId(0x31), assetId(0x32)]).key },
    { kind: 'object.depth', id: SUBJECT, depth: { p10: 0.1, median: 0.2, p90: 0.3 } },
    { kind: 'auto-subject', found: tappedObject(objectId(9)) },
  ];
  for (const doc of [fiveClusterDocument, minimalDocument]) {
    for (const product of products) {
      const before = deepFreeze(doc());
      assert.doesNotThrow(() => applyProduce(before, product, NOW), product.kind);
      assert.deepEqual(before, doc(), product.kind);
    }
  }
});

// ---------------------------------------------------------------------------
// dropSource

test('dropSource sets frame.source to null and stamps updatedAt, and the result parses', () => {
  const before = deepFreeze(fiveClusterDocument());
  assert.notEqual(before.frame.source, null);
  const after = dropSource(before, NOW);
  assert.equal(after.frame.source, null);
  assert.equal(after.updatedAt, NOW);
  assert.equal(after.frame.master, before.frame.master);
  assert.equal(after.analysis, before.analysis);
  assertValid(after, 'dropped');
  assert.deepEqual({ ...after, frame: before.frame, updatedAt: before.updatedAt }, before);
});
