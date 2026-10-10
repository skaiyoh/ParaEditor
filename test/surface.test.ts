import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSurface } from '../src/core/defaults.ts';
import { MIGRATIONS, SCENE_VERSION } from '../src/core/migrate.ts';
import { RANGES } from '../src/core/ranges.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { currentDocumentSchema, parseDocument, surfaceSchema } from '../src/core/schema.ts';
import { minimalDocument, fiveClusterDocument } from './fixtures/documents.ts';

const NOW = '2026-10-10T04:00:00.000Z';

test('surface defaults are stored, disabled, and accept exactly the three patterns', () => {
  const defaults = { enabled: false, pattern: 'bars', relief: 0.5, refraction: 0.5, shine: 0.5, scale: 0.5 };
  assert.deepEqual(defaultSurface(), defaults);
  assert.notEqual(defaultSurface(), defaultSurface());
  for (const pattern of ['bars', 'cracks', 'scales']) assert.ok(surfaceSchema.safeParse({ ...defaults, pattern }).success);
  for (const pattern of ['', 'glass', 'Bars', 0, null]) assert.ok(!surfaceSchema.safeParse({ ...defaults, pattern }).success);
  assert.ok(!surfaceSchema.safeParse({ ...defaults, extra: 1 }).success);
  assert.ok(!surfaceSchema.safeParse({ ...defaults, enabled: 1 }).success);
});

test('every surface dial has the unit range, accepts its endpoints and refuses non-finite or out-of-range values at its path', () => {
  for (const field of ['relief', 'refraction', 'shine', 'scale'] as const) {
    assert.deepEqual(RANGES[`surface.${field}`], { min: 0, max: 1, kind: 'real' });
    for (const value of [0, 0.5, 1]) assert.ok(surfaceSchema.safeParse({ ...defaultSurface(), [field]: value }).success);
    for (const value of [-0.001, 1.001, NaN, Infinity, -Infinity, '0.5']) {
      const parsed = surfaceSchema.safeParse({ ...defaultSurface(), [field]: value });
      assert.ok(!parsed.success);
      assert.deepEqual(parsed.error.issues[0]?.path, [field]);
    }
  }
});

test('surface patches clamp, preserve untouched state, and invert every field together', () => {
  const before = minimalDocument();
  const frozen = structuredClone(before);
  const result = applyEdit(before, { kind: 'surface', patch: { enabled: true, pattern: 'scales', relief: 2, refraction: -1, shine: 0.7, scale: 0.3 } }, NOW);
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') throw new Error('The surface edit did not apply.');
  assert.deepEqual(result.doc.surface, { enabled: true, pattern: 'scales', relief: 1, refraction: 0, shine: 0.7, scale: 0.3 });
  assert.equal(result.doc.seed, before.seed);
  assert.equal(result.doc.style, before.style);
  assert.equal(result.doc.analysis, before.analysis);
  assert.equal(result.doc.updatedAt, NOW);
  assert.ok(currentDocumentSchema.safeParse(result.doc).success);
  const undone = applyEdits(result.doc, result.inverse, before.updatedAt);
  assert.deepEqual(undone.doc, before);
  assert.deepEqual(before, frozen);
  const partial = applyEdit(before, { kind: 'surface', patch: { shine: 0.9 } }, NOW);
  assert.deepEqual(partial.doc.surface, { ...before.surface, shine: 0.9 });
});

test('empty, equal and refused surface patches retain the original document and timestamp', () => {
  const doc = fiveClusterDocument();
  for (const patch of [{}, { ...doc.surface }]) {
    const result = applyEdit(doc, { kind: 'surface', patch }, NOW);
    assert.equal(result.kind, 'unchanged');
    assert.equal(result.doc, doc);
  }
  for (const field of ['relief', 'refraction', 'shine', 'scale'] as const) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const result = applyEdit(doc, { kind: 'surface', patch: { [field]: value } }, NOW);
      assert.equal(result.kind, 'refused');
      assert.ok(result.kind === 'refused' && result.reason === 'non-finite');
      assert.equal(result.doc, doc);
    }
  }
  // Exercise real runtime boundaries with untyped input; the reducer's schema
  // refuses unknown keys and enum values even when a caller bypasses TS.
  for (const patch of [{ unknown: 1 }, { pattern: 'glass' }, { enabled: 'true' }]) {
    // @ts-expect-error intentionally invalid input at the edit boundary
    const result = applyEdit(doc, { kind: 'surface', patch }, NOW);
    assert.equal(result.kind, 'refused');
    assert.equal(result.doc, doc);
  }
});

test('the version-zero migration adds the disabled surface and selection size without changing other fields or its input', () => {
  const { surface: _surface, ...current } = fiveClusterDocument();
  const legacy = { ...current, version: 0, objects: current.objects.map((object) => {
    const { size: _size, ...selection } = object.produced.selection;
    return { ...object, produced: { ...object.produced, selection } };
  }) };
  const before = structuredClone(legacy);
  assert.equal(SCENE_VERSION, 2);
  assert.equal(MIGRATIONS.length, 2);
  const parsed = parseDocument(legacy);
  assert.deepEqual(parsed, { ok: true, value: { ...current, version: 2, surface: defaultSurface() } });
  assert.deepEqual(legacy, before);
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(legacy))), parsed);
  const extra = parseDocument({ ...legacy, unexpected: 1 });
  assert.ok(!extra.ok && extra.error.kind === 'invalid' && extra.error.detail === 'unexpected: unknown key');
});

test('current documents must contain a complete surface and keep their chosen settings when parsed', () => {
  const doc = fiveClusterDocument();
  assert.deepEqual(parseDocument(doc), { ok: true, value: doc });
  const { surface: _surface, ...missing } = doc;
  assert.ok(!parseDocument(missing).ok);
  for (const field of ['enabled', 'pattern', 'relief', 'refraction', 'shine', 'scale']) {
    const surface = Object.fromEntries(Object.entries(doc.surface).filter(([key]) => key !== field));
    assert.ok(!parseDocument({ ...doc, surface }).ok, field);
  }
});
