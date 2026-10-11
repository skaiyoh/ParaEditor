import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCompositionAssets } from '../src/core/asset-refs.ts';
import { parseCompositionDocument } from '../src/core/composition.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { FRIED_FIELDS, fryCurve } from '../src/core/fry.ts';
import type { Edit } from '../src/core/edits.ts';
import type { NonEmpty } from '../src/core/ids.ts';
import { EMPTY_HISTORY, recordEdit, undo, redo } from '../src/core/history.ts';
import { MIGRATIONS, SCENE_VERSION } from '../src/core/migrate.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { grainBinding, migrateV5ToV6, remixDocumentSchema, serializeRemixDocument, withDerivedGrainStyle,
  type RemixDocument, type RemixReadDocument } from '../src/core/remix-schema.ts';
import { currentDocumentSchema, parseDocument } from '../src/core/schema.ts';
import { assetId, fiveClusterDocument, legacyMinimalDocument, minimalDocument, OBJECT_IDS } from './fixtures/documents.ts';
import { artworkLayer, rasterSource } from './fixtures/composition.ts';

const NOW = '2026-10-11T12:00:00.000Z';
function migrated(): RemixReadDocument {
  const legacy = compositionDocumentSchema.parse(fiveClusterDocument());
  const result = migrateV5ToV6(legacy);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return withDerivedGrainStyle(result.value);
}
function grain(doc: RemixReadDocument) {
  const instance = doc.remix.instances.find(value => value.id === doc.remix.grainInstance);
  assert.ok(instance);
  return instance;
}

test('v6 read/write schemas keep one Grain owner and preserve legacy policy and exact values', () => {
  const before = compositionDocumentSchema.parse(fiveClusterDocument());
  const result = migrateV5ToV6(before);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.version, 6);
  assert.equal(SCENE_VERSION, 6);
  assert.equal(MIGRATIONS.length, 6);
  const view = withDerivedGrainStyle(result.value);
  assert.equal(view.compositing, before.compositing);
  assert.equal(view.policyTransition, null);
  assert.equal(view.remix.instances.length, 1);
  assert.deepEqual(grain(view).parameters, { amount: before.style.grain, colorNoise: before.style.colorNoise,
    grainSize: before.style.grainSize, grainHold: before.style.grainHold });
  assert.deepEqual(view.style, before.style);
  assert.deepEqual(currentDocumentSchema.parse(view), view);
  const serialized = serializeRemixDocument(view);
  for (const key of ['grain', 'colorNoise', 'grainSize', 'grainHold']) assert.equal(Object.hasOwn(serialized.style, key), false);
  assert.deepEqual(remixDocumentSchema.parse(JSON.parse(JSON.stringify(serialized))), result.value);
  const reopened = parseDocument(serialized);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.value, view);
  assert.deepEqual(before, fiveClusterDocument());
});

test('opening v5 and older fixtures retains v5; the frozen old reader refuses v6', () => {
  for (const doc of [minimalDocument(), fiveClusterDocument()]) {
    const opened = parseDocument(doc);
    assert.ok(opened.ok);
    assert.deepEqual(opened.value, doc);
    assert.deepEqual(currentDocumentSchema.parse(doc), doc);
  }
  const opened = parseDocument(legacyMinimalDocument());
  assert.ok(opened.ok);
  assert.deepEqual(opened.value, minimalDocument());
  const refused = parseCompositionDocument(serializeRemixDocument(migrated()));
  assert.ok(!refused.ok && refused.error.kind === 'newer-version');
  assert.equal(refused.error.version, 6);
});

test('legacy Grain style patches update the bound instance, derive controls and preserve parameters on serialization', () => {
  const doc = migrated();
  const result = applyEdit(doc, { kind: 'style', patch: { grain: .23, colorNoise: .41, grainSize: 3, grainHold: 1 } }, NOW);
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.detail : '');
  assert.equal(result.doc.version, 6);
  if (result.kind !== 'applied' || result.doc.version !== 6) return;
  assert.deepEqual(grain(result.doc).parameters, { amount: .23, colorNoise: .41, grainSize: 3, grainHold: 1 });
  assert.deepEqual(result.doc.remix.checkpoint, { appliedRevision: 1, draftRevision: 0, checkpointRevision: 1 });
  assert.equal(result.doc.style.grain, .23);
  assert.equal(result.doc.style.colorNoise, .41);
  assert.deepEqual(result.inverse, [{ kind: 'style', patch: { grain: doc.style.grain, colorNoise: doc.style.colorNoise,
    grainSize: doc.style.grainSize, grainHold: doc.style.grainHold } }]);
  const serialized = serializeRemixDocument(result.doc);
  assert.equal(Object.hasOwn(serialized.style, 'grain'), false);
  const reverse = applyEdits(result.doc, result.inverse, NOW);
  assert.equal(reverse.kind, 'applied');
  assert.deepEqual(reverse.doc.style, doc.style);
  if (reverse.doc.version === 6) assert.deepEqual(grain(reverse.doc).parameters, grain(doc).parameters);
});

test('Fry updates both Grain parameters and remaining style in one history action, with one inverse', () => {
  const doc = migrated();
  const result = recordEdit({ doc, history: EMPTY_HISTORY, edit: { kind: 'fry', fry: .84 }, now: NOW, at: 1 });
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.detail : '');
  assert.equal(result.doc.version, 6);
  if (result.kind !== 'applied' || result.doc.version !== 6) return;
  const expected = fryCurve(.84);
  for (const key of FRIED_FIELDS) assert.equal(result.doc.style[key], expected[key], key);
  assert.equal(grain(result.doc).parameters['amount'], expected.grain);
  assert.equal(grain(result.doc).parameters['colorNoise'], expected.colorNoise);
  assert.equal(grain(result.doc).parameters['grainSize'], grain(doc).parameters['grainSize']);
  assert.equal(result.history.undo.length, 1);
  assert.equal(result.inverse.length, 1);
  assert.equal(result.doc.remix.checkpoint.appliedRevision, 1);
  const step = undo(result.history);
  assert.ok(step?.kind === 'document');
  const reversed = applyEdits(result.doc, step.edits, NOW);
  assert.equal(reversed.kind, 'applied');
  assert.deepEqual(reversed.doc.style, doc.style);
  const redone = redo(step.history);
  assert.ok(redone?.kind === 'document');
  const reapplied = applyEdits(reversed.doc, redone.edits, NOW);
  assert.deepEqual(reapplied.doc.style, result.doc.style);
});

test('unavailable Grain bindings refuse style and Fry atomically with the original document identity', () => {
  const original = migrated();
  const doc: RemixReadDocument = { ...original, remix: { ...original.remix,
    instances: original.remix.instances.map(instance => ({ ...instance, enabled: false })) } };
  const binding = grainBinding(doc, 'grain');
  assert.equal(binding.kind, 'unavailable');
  if (binding.kind !== 'unavailable') return;
  for (const edit of [{ kind: 'style', patch: { grain: .91, colors: 3 } }, { kind: 'fry', fry: .84 }] as const) {
    const result = recordEdit({ doc, history: EMPTY_HISTORY, edit, now: NOW, at: 1 });
    assert.equal(result.kind, 'refused');
    assert.equal(result.doc, doc);
    assert.equal(result.history, EMPTY_HISTORY);
    if (result.kind === 'refused') assert.ok(result.detail.includes(binding.reason), result.detail);
  }
});

test('composition edits preserve the v6 recipe, paint content, and read style', () => {
  const doc = migrated();
  const result = applyEdit(doc, { kind: 'layer.opacity', id: OBJECT_IDS[0], opacity: .4 }, NOW);
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.detail : '');
  assert.equal(result.doc.version, 6);
  if (result.doc.version !== 6) return;
  assert.equal(result.doc.objects[0]?.opacity, .4);
  assert.equal(result.doc.remix, doc.remix);
  assert.equal(result.doc.paint, doc.paint);
  assert.deepEqual(result.doc.style, doc.style);
});

test('asset inventory retains each paint tile with its actual straight-sRGB descriptor', () => {
  const doc = serializeRemixDocument(migrated());
  const brush = doc.remix.blocks.find(block => block.outputType === 'coverage');
  assert.ok(brush);
  const value: RemixDocument = { ...doc, objects: [], removals: [], compositing: 'scene-depth', paint: { ...doc.paint, layers: [
    { id: OBJECT_IDS[1], name: 'Paint', hidden: false, opacity: 1, patches: [
      { id: 'stroke-one', owner: OBJECT_IDS[1], order: 1, disparity: .32, brush: { id: brush.id, revision: brush.revision },
        seed: 5, size: { width: 256, height: 256 }, tiles: [{ x: 0, y: 0, rgba: { asset: assetId(0x701),
          encoding: 'rgba8-srgb-straight', size: { width: 256, height: 256 } } }] },
    ] },
  ] } };
  assert.equal(remixDocumentSchema.safeParse(value).success, true);
  const result = collectCompositionAssets([{ kind: 'document', document: value }]);
  assert.ok(result.ok, result.ok ? '' : result.error.detail);
  assert.deepEqual(result.value.get(assetId(0x701)), [{ asset: assetId(0x701), kind: 'raster', format: 'rgba8-srgb-straight',
    size: { width: 256, height: 256 }, byteLength: 16 + 256 * 256 * 4 }]);
});

test('v6 photo creation shares the eight-layer budget with paint for single edits and atomic batches', () => {
  const original = migrated();
  const source = rasterSource();
  const doc: RemixReadDocument = { ...original, objects: [], removals: [], sources: [source], paint: { ...original.paint,
    layers: Array.from({ length: 8 }, (_, index) => ({ id: artworkLayer(index + 10).id, name: `Paint ${index + 1}`,
      hidden: false, opacity: 1, patches: [] })) } };
  assert.equal(remixDocumentSchema.safeParse(serializeRemixDocument(doc)).success, true);
  const layer = artworkLayer();
  const added = { kind: 'layer.add', layer, index: 0 } as const;
  for (const result of [applyEdit(doc, added, NOW), applyEdit(doc, { kind: 'object.add', object: layer }, NOW),
    applyEdits(doc, [{ kind: 'title', title: 'Must roll back' }, added], NOW)]) {
    assert.equal(result.kind, 'refused');
    assert.equal(result.doc, doc);
    if (result.kind === 'refused') assert.match(result.detail, /eight top-level layers/);
  }
  const room = { ...doc, paint: { ...doc.paint, layers: doc.paint.layers.slice(0, 7) } };
  for (const result of [applyEdit(room, added, NOW), applyEdit(room, { kind: 'object.add', object: layer }, NOW)]) {
    assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.detail : '');
    assert.equal(result.doc.objects.length, 1);
  }
  const extra = artworkLayer(2);
  const batch = applyEdits(room, [added, { kind: 'source.add', source: rasterSource(2), index: 1 },
    { kind: 'layer.add', layer: extra, index: 1 }], NOW);
  assert.equal(batch.kind, 'refused');
  assert.equal(batch.doc, room);
});

test('v6 layer deletion undo restores loaded mixed documents above eight layers without creating a removal', () => {
  const original = migrated(), photo = original.objects[0];
  assert.ok(photo);
  const doc: RemixReadDocument = { ...original, objects: [{ ...photo, subject: false }], removals: [], paint: { ...original.paint,
    layers: Array.from({ length: 8 }, (_, index) => ({ id: artworkLayer(index + 10).id, name: `Paint ${index + 1}`,
      hidden: false, opacity: 1, patches: [] })) } };
  assert.equal(remixDocumentSchema.safeParse(serializeRemixDocument(doc)).success, true);
  const cases: readonly NonEmpty<Edit>[] = [
    [{ kind: 'layer.remove', id: photo.id }],
    [{ kind: 'title', title: 'A mixed action' }, { kind: 'layer.remove', id: photo.id }],
  ];
  for (const edits of cases) {
    const removed = applyEdits(doc, edits, NOW);
    assert.equal(removed.kind, 'applied', removed.kind === 'refused' ? removed.detail : '');
    if (removed.kind !== 'applied') continue;
    assert.deepEqual(removed.inverse[0], { kind: 'object.add', object: doc.objects[0], restore: { index: 0 } });
    const restored = applyEdits(removed.doc, removed.inverse, NOW);
    assert.equal(restored.kind, 'applied', restored.kind === 'refused' ? restored.detail : '');
    if (restored.kind !== 'applied') continue;
    assert.deepEqual({ ...restored.doc, updatedAt: doc.updatedAt }, doc);
    assert.deepEqual(restored.doc.removals, []);
    const redone = applyEdits(restored.doc, restored.inverse, NOW);
    assert.equal(redone.kind, 'applied', redone.kind === 'refused' ? redone.detail : '');
    assert.deepEqual(redone.doc, removed.doc);
  }
});

test('analysis products apply to a v6 document and keep its version', async () => {
  const { minimalDocument } = await import('./fixtures/documents.ts');
  const { applyProduce } = await import('../src/core/produce.ts');
  const { migrateV5ToV6, withDerivedGrainStyle } = await import('../src/core/remix-schema.ts');
  const legacy = minimalDocument();
  const migrated = migrateV5ToV6(legacy);
  assert.ok(migrated.ok);
  const result = applyProduce(withDerivedGrainStyle(migrated.value), { kind: 'auto-subject', found: null }, '2026-10-11T12:00:00.000Z');
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.detail : '');
  assert.equal(result.doc.version, 6);
  // The session holds read documents with derived legacy Grain fields; they validate in serialized form.
  const read = applyProduce(withDerivedGrainStyle(migrated.value), { kind: 'auto-subject', found: null }, '2026-10-11T12:00:00.000Z');
  assert.equal(read.kind, 'applied', read.kind === 'refused' ? read.detail : '');
  assert.equal(read.doc.version, 6);
  assert.equal(applyProduce(legacy, { kind: 'auto-subject', found: null }, '2026-10-11T12:00:00.000Z').doc.version, 5);
});
