import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCompositionAssets } from '../src/core/asset-refs.ts';
import { applyCompositionEdit, applyCompositionEdits, removeLayerEdits } from '../src/core/composition.ts';
import { compositionDocumentSchema, compositionObjectIdSchema } from '../src/core/composition-schema.ts';
import type { NonEmpty } from '../src/core/ids.ts';
import type { CompositionDocument, CompositionEdit, SceneLayer } from '../src/core/types.ts';
import { assetId, uuid } from './fixtures/documents.ts';
import { artworkLayer, fullComposition, legacyComposition, liftRemoval, localEffect, newComposition, rasterSource } from './fixtures/composition.ts';

const stamp = '2026-10-10T23:30:00.000Z';
function roundTrip(doc: CompositionDocument, edits: NonEmpty<CompositionEdit>): CompositionDocument {
  const before = structuredClone(doc), result = applyCompositionEdits(doc, edits, stamp);
  assert.equal(result.kind, 'applied', JSON.stringify(result));
  if (result.kind !== 'applied') throw Error('Expected applied transaction');
  assert.equal(compositionDocumentSchema.safeParse(result.doc).success, true);
  const undone = applyCompositionEdits(result.doc, result.inverse, doc.updatedAt);
  assert.equal(undone.kind, 'applied', JSON.stringify(undone));
  assert.deepEqual(undone.doc, before);
  assert.deepEqual(doc, before);
  const redo = applyCompositionEdits(undone.doc, result.forward, stamp);
  assert.deepEqual(redo.doc, result.doc);
  return result.doc;
}

test('all edit kinds restore exact values and insertion order', () => {
  const doc = fullComposition(), layer = doc.objects[2]; assert.ok(layer);
  const source = rasterSource(2), art = artworkLayer(2), effect = localEffect(2), removal = liftRemoval(2);
  const cases: readonly NonEmpty<CompositionEdit>[] = [
    [{ kind: 'layer.placement', id: layer.id, value: { ...layer.placement, scale: 2.5, rotation: -37, translate: { x: 81, y: -45 } } }],
    [{ kind: 'layer.opacity', id: layer.id, opacity: .12345 }],
    [{ kind: 'layer.depth', id: layer.id, value: { kind: 'plane', disparity: .72 } }],
    [{ kind: 'layer.coverage', id: layer.id, value: { ...layer.produced, mask: { ...layer.produced.mask, asset: assetId(0xf00) }, provenance: { kind: 'manual', operation: 'remove' } } }],
    [{ kind: 'source.add', source, index: 0 }, { kind: 'layer.add', layer: art, index: 1 }],
    [{ kind: 'removal.set', id: removal.id, value: removal, index: 1 }],
    [{ kind: 'effect.set', id: effect.id, value: effect, index: 0 }],
    [{ kind: 'compositing', value: 'scene-depth' }],
    [{ kind: 'source.add', source, index: 0 }],
  ];
  for (const edits of cases) roundTrip(doc, edits);
  assert.deepEqual(roundTrip(doc, cases[0] ?? [{ kind: 'compositing', value: 'scene-depth' }]).objects[2]?.home, layer.home);
});

test('layer deletion cascades only owned effects and linked legacy removals, preserving middle indices', () => {
  const base = fullComposition(), layer = base.objects[0]; assert.ok(layer);
  const doc = compositionDocumentSchema.parse({ ...base, localEffects: [localEffect(1), { ...localEffect(2), owner: { kind: 'layer', id: layer.id } }, localEffect(3), { ...localEffect(4), owner: { kind: 'layer', id: layer.id } }, localEffect(5)] });
  const edits = removeLayerEdits(doc, layer.id); assert.ok(edits.ok);
  const next = roundTrip(doc, edits.value);
  assert.deepEqual(next.localEffects.map((effect) => effect.id), [localEffect(1), localEffect(3), localEffect(5)].map((effect) => effect.id));
  assert.equal(next.removals.some((removal) => removal.ownership.kind === 'legacy-layer' && removal.ownership.layer === layer.id), false);
  assert.equal(next.removals.some((removal) => removal.ownership.kind === 'lift'), true);
  assert.deepEqual(next.sources, doc.sources);
});

test('removing first, middle and last sources, effects and removals restores their precise order', () => {
  const doc = compositionDocumentSchema.parse({ ...newComposition(), sources: [rasterSource(1), rasterSource(2), rasterSource(3)],
    localEffects: [localEffect(1), localEffect(2), localEffect(3)], removals: [liftRemoval(1), liftRemoval(2), liftRemoval(3)] });
  for (const n of [1, 2, 3]) {
    roundTrip(doc, [{ kind: 'source.remove', id: rasterSource(n).id }]);
    roundTrip(doc, [{ kind: 'effect.set', id: localEffect(n).id, value: null, index: n - 1 }]);
    roundTrip(doc, [{ kind: 'removal.set', id: liftRemoval(n).id, value: null, index: n - 1 }]);
  }
  roundTrip(doc, [{ kind: 'effect.set', id: localEffect(2).id, value: { ...localEffect(2), enabled: false }, index: 0 }]);
  roundTrip(doc, [{ kind: 'removal.set', id: liftRemoval(2).id, value: liftRemoval(2), index: 2 }]);
});

test('source deletion refuses dangling refs but succeeds in an atomic list with temporary dangling refs', () => {
  const doc = fullComposition(), source = rasterSource(), art = artworkLayer();
  const refusal = applyCompositionEdit(doc, { kind: 'source.remove', id: source.id }, stamp);
  assert.equal(refusal.kind, 'refused'); assert.strictEqual(refusal.doc, doc);
  if (refusal.kind === 'refused') assert.match(refusal.detail, /source must exist/);
  const next = roundTrip(doc, [{ kind: 'source.remove', id: source.id }, { kind: 'layer.remove', id: art.id }]);
  assert.equal(next.sources.length, 0);
  // The inverse must also work when layer.add precedes restoration of its source.
  const add = roundTrip(newComposition(), [{ kind: 'layer.add', layer: art, index: 0 }, { kind: 'source.add', source, index: 0 }]);
  assert.equal(add.objects.length, 1);
});

test('invalid member, out-of-range index, mismatched ids and unknown input refuse the entire list', () => {
  const doc = fullComposition(), layer = artworkLayer();
  const badEdits: readonly CompositionEdit[] = [
    { kind: 'layer.opacity', id: layer.id, opacity: Infinity },
    { kind: 'layer.remove', id: compositionObjectIdSchema.parse(uuid(0xffff)) },
    { kind: 'source.add', source: rasterSource(), index: 0 },
    { kind: 'source.add', source: rasterSource(2), index: 10 },
    { kind: 'effect.set', id: localEffect(2).id, value: localEffect(3), index: 0 },
    { kind: 'removal.set', id: liftRemoval(2).id, value: liftRemoval(3), index: 0 },
    { kind: 'layer.placement', id: layer.id, value: { ...layer.placement, translate: { x: 1e5, y: 0 } } },
  ];
  for (const edit of badEdits) {
    const result = applyCompositionEdits(doc, [{ kind: 'layer.opacity', id: layer.id, opacity: .1 }, edit], stamp);
    assert.equal(result.kind, 'refused', JSON.stringify(edit)); assert.strictEqual(result.doc, doc);
  }
  // Test the runtime boundary without weakening the public TypeScript contract.
  for (const edits of [[], [{ kind: 'surprise' }], [{ kind: 'compositing', value: 'scene-depth', surprise: true }], null]) {
    const result = Reflect.apply(applyCompositionEdits, undefined, [doc, edits, stamp]);
    assert.equal(result.kind, 'refused'); assert.strictEqual(result.doc, doc);
  }
  const badStamp = applyCompositionEdit(doc, { kind: 'compositing', value: 'scene-depth' }, 'tomorrow');
  assert.equal(badStamp.kind, 'refused'); assert.strictEqual(badStamp.doc, doc);
});

test('legacy mask changes require linked removal update and threshold in the same transaction', () => {
  const doc = legacyComposition(), layer = doc.objects[0], removal = doc.removals[0]; assert.ok(layer && removal);
  const produced = { ...layer.produced, sampling: 'coverage', provenance: { kind: 'manual', operation: 'feather' }, mask: { ...layer.produced.mask, asset: assetId(0xf01) } } satisfies SceneLayer['produced'];
  assert.equal(applyCompositionEdit(doc, { kind: 'layer.coverage', id: layer.id, value: produced }, stamp).kind, 'refused');
  const changed = roundTrip(doc, [
    { kind: 'layer.coverage', id: layer.id, value: produced },
    { kind: 'removal.set', id: removal.id, value: { ...removal, mask: { plane: produced.mask, provenance: produced.provenance }, threshold: 1 }, index: 0 },
  ]);
  assert.deepEqual(changed.objects[0]?.placement, layer.placement);
  assert.deepEqual(changed.objects[0]?.home, layer.home);
});

test('historical parent deletion is valid and deleting an independent cutout leaves Lift removal', () => {
  const base = fullComposition(), parent = base.objects[0], child = base.objects[1]; assert.ok(parent && child);
  const cutout = { ...child, origin: { kind: 'cutout', operation: 'lift', source: { kind: 'photo' }, parent: parent.id, selectedMask: assetId(0xdead) } } satisfies SceneLayer;
  const doc = compositionDocumentSchema.parse({ ...base, objects: [parent, cutout, artworkLayer()], removals: [base.removals[0], liftRemoval()] });
  const deletion = removeLayerEdits(doc, parent.id); assert.ok(deletion.ok);
  const withoutParent = roundTrip(doc, deletion.value);
  assert.equal(withoutParent.objects[0]?.origin.kind, 'cutout');
  const withoutCutout = roundTrip(doc, [{ kind: 'layer.remove', id: child.id }]);
  assert.equal(withoutCutout.removals.some((removal) => removal.id === liftRemoval().id), true);
});

test('no-op transactions preserve identity and timestamp; inverses preserve unrelated analysis arrivals', () => {
  const doc = fullComposition(), art = artworkLayer();
  for (const edits of [
    [{ kind: 'layer.opacity', id: art.id, opacity: art.opacity }],
    [{ kind: 'layer.opacity', id: art.id, opacity: .2 }, { kind: 'layer.opacity', id: art.id, opacity: art.opacity }],
    [{ kind: 'compositing', value: doc.compositing }],
  ] satisfies readonly NonEmpty<CompositionEdit>[]) {
    const result = applyCompositionEdits(doc, edits, stamp); assert.equal(result.kind, 'unchanged'); assert.strictEqual(result.doc, doc);
  }
  const edited = applyCompositionEdit(doc, { kind: 'layer.opacity', id: art.id, opacity: .2 }, stamp);
  assert.equal(edited.kind, 'applied'); if (edited.kind !== 'applied') return;
  const arrival = { ...edited.doc, analysis: { ...edited.doc.analysis, tone: { ...edited.doc.analysis.tone, p50: .51 } } };
  const undone = applyCompositionEdits(arrival, edited.inverse, doc.updatedAt);
  assert.equal(undone.kind, 'applied'); assert.deepEqual(undone.doc.analysis, arrival.analysis);
  assert.strictEqual(edited.doc.analysis, doc.analysis);
});

test('closure walks forward/inverse edits and selection roots, including bytes absent from live document', () => {
  const doc = fullComposition(), art = artworkLayer();
  const deleted = applyCompositionEdits(doc, [{ kind: 'layer.remove', id: art.id }, { kind: 'source.remove', id: rasterSource().id }], stamp);
  assert.equal(deleted.kind, 'applied'); if (deleted.kind !== 'applied') return;
  const effect = localEffect(); assert.equal(effect.scope.kind, 'mask'); if (effect.scope.kind !== 'mask') return;
  const selection = { space: { kind: 'photo' }, mask: { ...effect.scope.mask, plane: { ...effect.scope.mask.plane, asset: assetId(0xf02) } } } as const;
  const retained = collectCompositionAssets([{ kind: 'document', document: deleted.doc }, { kind: 'edits', edits: [...deleted.forward, ...deleted.inverse] }, { kind: 'selection', selection }]);
  assert.ok(retained.ok, JSON.stringify(retained));
  for (const id of [rasterSource().image.asset, art.produced.mask.asset, assetId(0xf02), assetId(0xc01), assetId(0xc02)]) assert.equal(retained.value.has(id), true);
  assert.equal(retained.value.has(rasterSource().provenance.originalDigest), false);
  assert.equal(collectCompositionAssets([{ kind: 'edits', edits: [{ kind: 'layer.add', layer: art, index: 0 }] }]).ok, false);
});

test('32 readable layers remain restorable and 33 layers refuse atomically', () => {
  const doc = compositionDocumentSchema.parse({ ...newComposition(), sources: [rasterSource()], objects: Array.from({ length: 32 }, (_, i) => ({ ...artworkLayer(), id: uuid(0x1000 + i) })) });
  const layer = doc.objects[16]; assert.ok(layer);
  roundTrip(doc, [{ kind: 'layer.remove', id: layer.id }]);
  const refusal = applyCompositionEdit(doc, { kind: 'layer.add', layer: artworkLayer(2), index: 0 }, stamp);
  assert.equal(refusal.kind, 'refused'); assert.strictEqual(refusal.doc, doc);
});

test('owner insertion after its effect/removal still has a valid inverse', () => {
  const doc = newComposition(), art = artworkLayer(), effect = { ...localEffect(), owner: { kind: 'layer', id: art.id } } as const;
  roundTrip(doc, [{ kind: 'effect.set', id: effect.id, value: effect, index: 0 },
    { kind: 'layer.add', layer: art, index: 0 }, { kind: 'source.add', source: rasterSource(), index: 0 }]);
  const legacy = legacyComposition(), layer = legacy.objects[0], removal = legacy.removals[0]; assert.ok(layer && removal);
  const empty = { ...legacy, objects: [], removals: [] };
  roundTrip(empty, [{ kind: 'removal.set', id: removal.id, value: removal, index: 0 }, { kind: 'layer.add', layer, index: 0 }]);
});

test('reparenting effects before adding their owner reverses exact order without cascading side effects', () => {
  const doc = compositionDocumentSchema.parse({ ...newComposition(), sources: [rasterSource()], localEffects: [localEffect(1), localEffect(2), localEffect(3)] });
  const art = artworkLayer();
  const next = roundTrip(doc, [
    { kind: 'effect.set', id: localEffect(1).id, value: { ...localEffect(1), owner: { kind: 'layer', id: art.id } }, index: 0 },
    { kind: 'effect.set', id: localEffect(2).id, value: { ...localEffect(2), owner: { kind: 'layer', id: art.id } }, index: 1 },
    { kind: 'layer.add', layer: art, index: 0 },
  ]);
  const dangling = applyCompositionEdit(next, { kind: 'layer.remove', id: art.id }, stamp);
  assert.equal(dangling.kind, 'refused'); assert.strictEqual(dangling.doc, next);
  const deletion = removeLayerEdits(next, art.id); assert.ok(deletion.ok);
  roundTrip(next, deletion.value);
});

test('all asset-bearing edit variants pin replacement coverage, depth, removal and effect bytes', () => {
  const doc = fullComposition(), layer = doc.objects[0], removal = liftRemoval(2), effect = localEffect(2);
  assert.ok(layer && layer.depthAttachment.kind === 'source');
  const closure = collectCompositionAssets([{ kind: 'edits', edits: [
    { kind: 'layer.coverage', id: layer.id, value: { ...layer.produced, mask: { ...layer.produced.mask, asset: assetId(0xf10) } } },
    { kind: 'layer.depth', id: layer.id, value: { ...layer.depthAttachment, map: { ...layer.depthAttachment.map, asset: assetId(0xf11) } } },
    { kind: 'removal.set', id: removal.id, value: removal, index: 0 },
    { kind: 'effect.set', id: effect.id, value: effect, index: 0 },
  ] }]);
  assert.ok(closure.ok);
  assert.deepEqual([...closure.value.keys()].sort(), [0xf10, 0xf11, 0xb02, 0xa02].map(assetId).sort());
});
