import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCompositionAssets, measureCompositionAssets } from '../src/core/asset-refs.ts';
import { compositionDocumentSchema, maskProvenanceSchema, repairRequestKeySchema } from '../src/core/composition-schema.ts';
import { isEffectId, isObjectId, isRemovalId, isSourceId } from '../src/core/ids.ts';
import { activeSelectionSchema, resolveOperationTarget, selectionOwnerSize } from '../src/core/selection.ts';
import { describeIssues } from '../src/core/schema.ts';
import { assetId, setAt, uuid, type Key } from './fixtures/documents.ts';
import { artworkLayer, fullComposition, legacyComposition, localEffect, newComposition, rasterSource, repairProduct } from './fixtures/composition.ts';

function refused(value: unknown, pattern?: RegExp): void {
  const result = compositionDocumentSchema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success && pattern !== undefined) assert.match(describeIssues(result.error.issues), pattern);
}

test('strict readonly v5 has one layer list, source-only content, and validated branded namespaces', () => {
  for (const check of [isSourceId, isRemovalId, isEffectId, isObjectId]) {
    assert.equal(check(uuid(1)), true);
    for (const value of ['x', uuid(1).toUpperCase().replace('4000', '4ABC'), uuid(1).replace('4000', '3000')]) assert.equal(check(value), false);
  }
  const doc = fullComposition(), parsed = compositionDocumentSchema.parse(doc);
  assert.deepEqual(parsed, doc);
  assert.equal(Object.isFrozen(parsed), true); assert.equal(Object.isFrozen(parsed.objects), true);
  assert.equal(Object.isFrozen(parsed.objects[0]), true);
  refused({ ...doc, layers: [] }, /layers: unknown key/);
  refused(setAt(doc, ['objects', 2, 'content'], { kind: 'paint', surface: { size: { width: 13, height: 7 }, tileSize: 256, tiles: [] } }));
  refused(setAt(doc, ['objects', 2, 'origin'], { kind: 'paint' }));
  refused({ ...doc, compositing: 'screen-overlay' });
});

test('all active source, owner, origin and legacy removal cross-references are validated', () => {
  const doc = fullComposition();
  const cases: readonly (readonly [readonly Key[], unknown, RegExp])[] = [
    [['objects', 2, 'content', 'source', 'id'], uuid(999), /raster source must exist/],
    [['objects', 2, 'origin', 'source'], uuid(999), /origin.source/],
    [['objects', 2, 'origin'], { kind: 'photo-region' }, /photo-region requires photo/],
    [['objects', 2, 'origin'], { kind: 'cutout', operation: 'copy', source: { kind: 'photo' }, parent: null, selectedMask: assetId(999) }, /cutout origin must match/],
    [['localEffects', 0, 'owner'], { kind: 'layer', id: uuid(999) }, /effect owner must exist/],
    [['removals', 0, 'ownership', 'layer'], uuid(999), /legacy removal must own/],
    [['removals', 0, 'ownership', 'layer'], artworkLayer().id, /legacy removal must own/],
    [['removals', 0, 'threshold'], 1, /threshold must follow/],
    [['removals', 0, 'mask', 'plane', 'asset'], assetId(999), /linked coverage/],
    [['removals', 2, 'threshold'], 128, /Lift uses nonzero/],
    [['style', 'paletteTargets', 0, 'cluster'], 5, /cluster must exist/],
  ];
  for (const [path, value, pattern] of cases) refused(setAt(doc, path, value), pattern);
  for (const key of ['sources', 'removals', 'localEffects', 'objects', 'lights'] as const) {
    refused({ ...doc, [key]: [...doc[key], doc[key][0]] }, /ids must be unique/);
  }
  const removal = doc.removals[0]; assert.ok(removal);
  refused({ ...doc, removals: [...doc.removals, { ...removal, id: uuid(999) }] }, /only one legacy removal/);
});

test('shape bounds refuse nonfinite/singular placements, bad formats and mismatched source extents', () => {
  const doc = fullComposition();
  for (const [path, value] of [
    [['objects', 2, 'placement', 'scale'], 0], [['objects', 2, 'placement', 'scale'], 65],
    [['objects', 2, 'placement', 'rotation'], 180], [['objects', 2, 'home', 'rotation'], -181],
    [['objects', 2, 'placement', 'translate', 'x'], 8193], [['objects', 2, 'placement', 'pivot', 'x'], 14],
    [['objects', 2, 'opacity'], 1.01], [['objects', 2, 'opacity'], NaN],
    [['objects', 2, 'depthAttachment', 'disparity'], Infinity],
    [['objects', 2, 'produced', 'mask', 'format'], 'f32'], [['analysis', 'depth', 'map', 'format'], 'u8'],
    [['objects', 2, 'produced', 'bounds', 'width'], 14], [['objects', 2, 'produced', 'color'], null],
    [['sources', 0, 'image', 'size', 'width'], 2049], [['sources', 0, 'image', 'size', 'height'], 0],
    [['objects', 2, 'produced', 'sampling'], 'legacy-threshold'],
  ] satisfies readonly (readonly [readonly Key[], unknown])[]) refused(setAt(doc, path, value));
  for (const scale of [1 / 64, 64]) assert.equal(compositionDocumentSchema.safeParse(setAt(doc, ['objects', 2, 'placement', 'scale'], scale)).success, true);
  assert.equal(compositionDocumentSchema.safeParse(setAt(doc, ['objects', 2, 'placement', 'rotation'], -180)).success, true);
  // A 1x1 identity mask and 686x518 primary depth legitimately span larger owners.
  assert.equal(doc.objects[2]?.produced.mask.size.width, 1);
  assert.equal(doc.analysis.depth?.map.size.width, 686);
  assert.equal(doc.frame.master.size.width, 2048);
  const empty = setAt(setAt(doc, ['objects', 2, 'produced', 'bounds', 'width'], 0), ['objects', 2, 'produced', 'color'], null);
  assert.equal(compositionDocumentSchema.safeParse(empty).success, true);
});

test('each mask provenance variant is strict; AI recipe size is required only after migration', () => {
  const ai = legacyComposition().objects[0]?.produced.provenance; assert.ok(ai);
  for (const value of [ai, { ...ai, kind: 'ai-edited', operation: 'feather' }, { kind: 'manual', operation: 'rectangle' }, { kind: 'full' }]) {
    assert.equal(maskProvenanceSchema.safeParse(value).success, true);
    assert.equal(maskProvenanceSchema.safeParse({ ...value, surprise: true }).success, false);
  }
  if (ai.kind !== 'ai') return;
  const { size: _size, ...selection } = ai.selection;
  assert.equal(maskProvenanceSchema.safeParse({ ...ai, selection }).success, false);
  assert.equal(maskProvenanceSchema.safeParse({ kind: 'manual', operation: 'rectangle', model: ai.model }).success, false);
});

test('repair keys validate real descriptors and durable purpose; live keys remain separately usable', () => {
  const doc = fullComposition();
  refused(setAt(doc, ['analysis', 'plate', 'key', 'source'], assetId(999)), /primary master/);
  refused(setAt(doc, ['analysis', 'plate', 'key', 'depth'], assetId(999)), /existing f32 descriptor/);
  refused(setAt(doc, ['analysis', 'plate', 'key', 'depth'], doc.frame.master.asset), /existing f32 descriptor/);
  refused(setAt(doc, ['analysis', 'plate', 'key', 'depth'], assetId(0xc04)), /not a repair output/);
  for (const key of ['key', 'image']) refused(setAt(doc, ['analysis', 'plate', key, 'size', 'width'], 2), /master extent/);
  assert.equal(compositionDocumentSchema.safeParse(setAt(doc, ['analysis', 'plate', 'backgroundDepth', 'size'], { width: 686, height: 518 })).success, true);
  refused(setAt(doc, ['analysis', 'plate', 'key', 'radius'], 1.5));
  const key = repairProduct().key;
  const live = { ...key, purpose: { kind: 'live', geometry: { aperture: { center: { x: 0, y: 0 }, width: 1, height: .75 }, crop: .1, neutralDistance: 1, nearFactor: 1, farFactor: 2 }, envelope: { min: { x: -.1, y: -.1 }, max: { x: .1, y: .1 } } } };
  assert.equal(repairRequestKeySchema.safeParse(live).success, true);
  refused(setAt(doc, ['analysis', 'plate', 'key'], live), /live repair remains transient/);
  assert.equal(repairRequestKeySchema.safeParse(setAt(live, ['purpose', 'geometry', 'farFactor'], .5)).success, false);
  assert.equal(repairRequestKeySchema.safeParse(setAt(live, ['purpose', 'envelope', 'min', 'x'], 2)).success, false);
});

test('asset closure includes every actual plane/image and excludes historical digests', () => {
  const doc = fullComposition(), art = doc.objects[2]; assert.ok(art);
  const cutout = { ...art, origin: { kind: 'cutout', operation: 'copy', source: art.content.source, parent: null, selectedMask: assetId(0xdead) } };
  const parsed = compositionDocumentSchema.parse({ ...doc, objects: [...doc.objects.slice(0, 2), cutout] });
  const closure = collectCompositionAssets([{ kind: 'document', document: parsed }]); assert.ok(closure.ok, JSON.stringify(closure));
  const ids = [...closure.value.keys()].sort();
  assert.deepEqual(ids, [0x10, 0x11, 0x20, 0x31, 0x32, 0x501, 0x700, 0xa01, 0xb01, 0xc01, 0xc02, 0xc03, 0xc04].map(assetId).sort());
  assert.equal(closure.value.has(assetId(0xdead)), false); assert.equal(closure.value.has(rasterSource().provenance.originalDigest), false);
  assert.deepEqual(closure.value.get(assetId(0xc01)), [{ asset: assetId(0xc01), kind: 'raster', format: 'u8', size: doc.frame.master.size, byteLength: 16 + 2048 * 1536 }]);
  assert.deepEqual(closure.value.get(assetId(0x20)), [{ asset: assetId(0x20), kind: 'raster', format: 'f32', size: { width: 686, height: 518 }, byteLength: 16 + 686 * 518 * 4 }]);
});

test('conflicting digest descriptors fail before deduplication; original PNG reuse is valid', () => {
  const doc = fullComposition();
  for (const [path, value] of [
    [['sources', 0, 'image', 'asset'], doc.frame.master.asset],
    [['localEffects', 0, 'scope', 'mask', 'plane', 'asset'], assetId(0x31)],
    [['objects', 2, 'produced', 'mask', 'asset'], assetId(0x20)],
  ] satisfies readonly (readonly [readonly Key[], unknown])[]) refused(setAt(doc, path, value), /Conflicting asset descriptors/);
  const minimal = newComposition();
  assert.equal(compositionDocumentSchema.safeParse({ ...minimal, frame: { ...minimal.frame, source: { asset: minimal.frame.master.asset, mediaType: 'image/png', byteLength: 300 } } }).success, true);
});

test('selection owner resolution preserves independent stencil ownership and never falls back to Scene', () => {
  const doc = fullComposition(), layer = artworkLayer(), effect = localEffect();
  assert.equal(effect.scope.kind, 'mask'); if (effect.scope.kind !== 'mask') return;
  const selection = activeSelectionSchema.parse({ space: { kind: 'layer', id: layer.id }, mask: effect.scope.mask });
  const resolved = resolveOperationTarget({ document: doc, target: { kind: 'selection' }, selection }); assert.ok(resolved.ok);
  assert.deepEqual(resolved.value, { kind: 'local', owner: { kind: 'layer', id: layer.id }, scope: effect.scope });
  assert.deepEqual(selectionOwnerSize(doc, { kind: 'layer', id: layer.id }), { ok: true, value: { width: 13, height: 7 } });
  assert.equal(resolveOperationTarget({ document: doc, target: { kind: 'selection' }, selection: null }).ok, false);
  assert.equal(resolveOperationTarget({ document: { ...doc, objects: [] }, target: { kind: 'selection' }, selection }).ok, false);
  assert.equal(resolveOperationTarget({ document: { ...doc, objects: [] }, target: { kind: 'layer', id: layer.id }, selection }).ok, false);
  assert.deepEqual(resolveOperationTarget({ document: doc, target: { kind: 'scene' }, selection }), { ok: true, value: { kind: 'scene' } });
});

test('byte accounting includes raw headers, counts sharing once, and refuses unresolved or inconsistent lengths', () => {
  const source = rasterSource(), layer = artworkLayer(), empty = newComposition();
  const doc = compositionDocumentSchema.parse({ ...empty, sources: [source], objects: [layer], frame: { ...empty.frame,
    source: { asset: empty.frame.master.asset, mediaType: 'image/png', byteLength: 301 } } });
  const inventory = collectCompositionAssets([{ kind: 'document', document: doc }, { kind: 'document', document: doc },
    { kind: 'edits', edits: [{ kind: 'source.add', source, index: 0 }, { kind: 'layer.add', layer, index: 0 }] }]);
  assert.ok(inventory.ok);
  assert.deepEqual(measureCompositionAssets(inventory.value, new Map()), { ok: true, value: { assets: 3, bytes: 301 + 16 + 13 * 7 * 4 + 16 + 1 } });
  assert.equal(measureCompositionAssets(inventory.value, new Map([[doc.frame.master.asset, 302]])).ok, false);
  assert.equal(measureCompositionAssets(inventory.value, new Map([[source.image.asset, 13 * 7 * 4]])).ok, false);
  const missing = collectCompositionAssets([{ kind: 'document', document: empty }]); assert.ok(missing.ok);
  assert.equal(measureCompositionAssets(missing.value, new Map()).ok, false);
  assert.deepEqual(measureCompositionAssets(missing.value, new Map([[empty.frame.master.asset, 301]])), { ok: true, value: { assets: 1, bytes: 301 } });
  for (const length of [NaN, Infinity, -1, .5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(measureCompositionAssets(missing.value, new Map([[empty.frame.master.asset, length]])).ok, false);
});

test('transient repair roots retain exact planes and require their actual frozen source-depth descriptor', () => {
  const repair = repairProduct(), doc = legacyComposition(), depth = doc.objects[0]?.depthAttachment;
  assert.ok(depth?.kind === 'source');
  assert.equal(collectCompositionAssets([{ kind: 'repair', repair }]).ok, false);
  const closure = collectCompositionAssets([{ kind: 'repair', repair }, { kind: 'depth', depth }]);
  assert.ok(closure.ok, JSON.stringify(closure));
  assert.deepEqual([...closure.value.keys()].sort(), [0x11, 0x20, 0xc01, 0xc02, 0xc03, 0xc04].map(assetId).sort());
});
