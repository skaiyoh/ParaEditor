import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCompositionEdit, migrateV4ToV5, parseCompositionDocument } from '../src/core/composition.ts';
import { legacyV4DocumentSchema } from '../src/core/legacy-schema.ts';
import { SCENE_VERSION } from '../src/core/migrate.ts';
import { parseDocument } from '../src/core/schema.ts';
import { legacyFiveClusterDocument as fiveClusterDocument, invalidVariants, minimalDocument, setAt, withValues } from './fixtures/documents.ts';
import { legacyComposition, newComposition } from './fixtures/composition.ts';

const stamp = '2026-10-10T23:00:00.000Z';
test('v4 migration preserves identities, exact user values and frozen legacy ownership', () => {
  const old = fiveClusterDocument(), before = structuredClone(old);
  const result = migrateV4ToV5(old);
  assert.ok(result.ok, JSON.stringify(result));
  const doc = result.value;
  const { version: _v, objects: _o, analysis: _a, ...oldFields } = old;
  const { version: _v2, objects: _o2, analysis: _a2, sources: _s, localEffects: _e, removals: _r, compositing: _c, ...newFields } = doc;
  assert.deepEqual(newFields, oldFields);
  assert.deepEqual(doc.analysis, { ...old.analysis, plate: null });
  assert.deepEqual(doc.sources, []); assert.deepEqual(doc.localEffects, []);
  doc.objects.forEach((layer, index) => {
    const original = old.objects[index]; assert.ok(original);
    const { produced, ...user } = original;
    const { produced: next, content, origin, placement, home, opacity, depthAttachment, ...preserved } = layer;
    assert.deepEqual(preserved, user);
    assert.deepEqual(content, { kind: 'source', source: { kind: 'photo' } });
    assert.deepEqual(origin, { kind: 'photo-region' });
    assert.equal(opacity, 1);
    assert.deepEqual(placement, { translate: { x: 0, y: 0 }, pivot: { x: produced.bounds.x + produced.bounds.width / 2, y: produced.bounds.y + produced.bounds.height / 2 }, scale: 1, rotation: 0 });
    assert.deepEqual(home, placement);
    assert.deepEqual(depthAttachment, { kind: 'source', map: old.analysis.depth?.map, model: old.analysis.depth?.model, offset: 0 });
    const { model, selection, ...coverage } = produced;
    assert.deepEqual(next, { ...coverage, sampling: 'legacy-threshold', provenance: { kind: 'ai', model, selection } });
    assert.deepEqual(doc.removals[index], { id: original.id, source: { kind: 'photo' }, mask: { plane: produced.mask, provenance: next.provenance }, threshold: 128, ownership: { kind: 'legacy-layer', layer: original.id } });
  });
  assert.deepEqual(old, before);
  assert.deepEqual(migrateV4ToV5(old), result);
  assert.deepEqual(parseCompositionDocument(JSON.parse(JSON.stringify(doc))), result);
});

test('missing refinement size, missing depth/plate and hidden objects migrate without invented assets', () => {
  const old = fiveClusterDocument();
  const objects = old.objects.map((layer) => {
    const { size: _size, ...selection } = layer.produced.selection;
    return { ...layer, hidden: true, produced: { ...layer.produced, selection } };
  });
  const result = migrateV4ToV5({ ...old, objects, analysis: { ...old.analysis, depth: null, plate: null } });
  assert.ok(result.ok, JSON.stringify(result));
  result.value.objects.forEach((layer, i) => {
    assert.equal(layer.hidden, true); assert.equal(layer.produced.provenance.kind, 'ai');
    if (layer.produced.provenance.kind === 'ai') assert.equal(layer.produced.provenance.selection.size, .5);
    assert.deepEqual(layer.depthAttachment, { kind: 'plane', disparity: .5 });
    assert.deepEqual(layer.produced.mask, old.objects[i]?.produced.mask);
    assert.deepEqual(layer.produced.depth, old.objects[i]?.produced.depth);
  });
});

test('v4 validation rejects every existing malformed fixture before transformation', () => {
  for (const fixture of invalidVariants()) {
    assert.equal(migrateV4ToV5(fixture.json).ok, false, fixture.name);
  }
});

test('unknown fields in discarded or transformed old records are explicit errors, not sanitized', () => {
  for (const path of [[], ['analysis', 'plate'], ['objects', 0], ['objects', 0, 'produced'], ['objects', 0, 'produced', 'selection'], ['objects', 0, 'produced', 'mask']] as const) {
    const result = migrateV4ToV5(setAt(fiveClusterDocument(), [...path, 'surprise'], true));
    assert.ok(!result.ok && result.error.kind === 'invalid');
    assert.match(result.error.detail, /surprise: unknown key/);
  }
  for (const value of [null, -1, '0.5', NaN, Infinity]) {
    assert.equal(migrateV4ToV5(setAt(fiveClusterDocument(), ['objects', 0, 'produced', 'selection', 'size'], value)).ok, false);
  }
});

test('legacy 0, 1, 2, 3 walk existing migrations then strict 4-to-5 with frozen defaults', () => {
  for (const version of [0, 1, 2, 3]) {
    const current = fiveClusterDocument();
    const { drift: _drift, parallax, ...motion } = current.motion;
    const { surface, ...rest } = current;
    const objects = current.objects.map((layer) => {
      const { hidden, ...other } = layer;
      return version < 3 ? other : { ...other, hidden };
    });
    const old = { ...rest, objects, version, ...(version > 0 ? { surface } : {}), motion: { ...motion, orbit: .17, ...(version > 1 ? { parallax } : {}) } };
    const before = structuredClone(old), parsed = parseCompositionDocument(old);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(parsed.value.version, 5); assert.equal(parsed.value.compositing, 'legacy-order');
    assert.deepEqual(parsed.value.motion.drift, { direction: 'circle', amount: .17 });
    assert.deepEqual(old, before);
    assert.equal(parseCompositionDocument(setAt(old, ['motion', 'orbit'], 'bad')).ok, false);
    assert.equal(parseCompositionDocument(setAt(old, ['objects', 0, 'produced', 'surprise'], true)).ok, false);
    if (version < 3) assert.equal(parseCompositionDocument(setAt(old, ['objects', 0, 'hidden'], 'bad')).ok, false);
  }
});

test('migration never implicitly changes overlap; only the explicit reversible edit does', () => {
  assert.equal(SCENE_VERSION, 6);
  assert.equal(parseDocument(minimalDocument()).ok, true);
  assert.equal(parseDocument(newComposition()).ok, true);
  assert.equal(newComposition().compositing, 'scene-depth');
  const doc = legacyComposition(), layer = doc.objects[0]; assert.ok(layer);
  const opacity = applyCompositionEdit(doc, { kind: 'layer.opacity', id: layer.id, opacity: .6 }, stamp);
  assert.equal(opacity.kind, 'applied'); assert.equal(opacity.doc.compositing, 'legacy-order');
  const again = parseCompositionDocument(opacity.doc); assert.ok(again.ok); assert.equal(again.value.compositing, 'legacy-order');
  const switched = applyCompositionEdit(doc, { kind: 'compositing', value: 'scene-depth' }, stamp);
  assert.equal(switched.kind, 'applied');
  if (switched.kind === 'applied') assert.deepEqual(applyCompositionEdit(switched.doc, switched.inverse[0], doc.updatedAt).doc, doc);
  assert.equal(parseCompositionDocument({ ...doc, compositing: 'screen-overlay' }).ok, false);
});

test('current and future versions, hostile boundaries and old optional hidden are explicit', () => {
  const doc = fiveClusterDocument(), object = doc.objects[0]; assert.ok(object);
  const { hidden: _hidden, ...missingHidden } = object;
  assert.equal(legacyV4DocumentSchema.safeParse({ ...doc, objects: [missingHidden] }).success, true);
  assert.equal(migrateV4ToV5(withValues(doc, [[['analysis', 'plate', 'model'], 'fake'], [['objects', 0, 'produced', 'model'], 'fake']])).ok, false);
  const future = parseCompositionDocument({ ...doc, version: 6 });
  assert.ok(!future.ok && future.error.kind === 'newer-version');
  for (const value of [null, [], 1, { format: 'noisy-scene', version: -1 }, { get format() { throw Error('hostile'); } }]) assert.equal(parseCompositionDocument(value).ok, false);
  assert.equal(parseCompositionDocument({ ...doc, get objects() { throw Error('hostile'); } }).ok, false);
});
