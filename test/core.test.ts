// src/core's primitives under node: every core module loads here, the id
// checks that brand a string, the Result constructors, and the one configured
// zod.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import '../src/core/face-view.ts';
import '../src/core/live-coverage.ts';
import '../src/core/orientation.ts';
import '../src/core/perspective.ts';
import { srgbToOklab } from '../src/core/color.ts';
import { defaultStyle } from '../src/core/defaults.ts';
import { layers, NEED_OPS } from '../src/core/derive.ts';
import type { Edit } from '../src/core/edits.ts';
import { sameValue } from '../src/core/equal.ts';
import { fryCurve } from '../src/core/fry.ts';
import { coalesceKey, EMPTY_HISTORY, push, redo, referencedAssets, undo } from '../src/core/history.ts';
import { isAssetId, isBuildId, isLightId, isModelId, isObjectId, isSceneId, isTabId, type BuildId, type TabId } from '../src/core/ids.ts';
import { MIGRATIONS, SCENE_VERSION } from '../src/core/migrate.ts';
import { effectiveOrbit, LOOP_ZOOM } from '../src/core/motion.ts';
import { percentile } from '../src/core/percentile.ts';
import { applyProduce, dropSource } from '../src/core/produce.ts';
import { clampToRange, LENGTHS, RANGES } from '../src/core/ranges.ts';
import type { Size } from '../src/core/raster.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { err, ok, type Result } from '../src/core/result.ts';
import { currentDocumentSchema, parseDocument } from '../src/core/schema.ts';
import type { SceneDocument } from '../src/core/types.ts';
import { z } from '../src/core/zod.ts';
import { fiveClusterDocument } from './fixtures/documents.ts';
import { REPO } from './support/cli.ts';

/**
 * Every module of src/core, each imported above so the node test project type
 * checks it: a core module that names a NOISY_* constant fails `npm run
 * typecheck`, and one that touches a browser global at load fails the test below.
 */
const CORE_MODULES = [
  'color.ts',
  'defaults.ts',
  'derive.ts',
  'edits.ts',
  'equal.ts',
  'face-view.ts',
  'fry.ts',
  'history.ts',
  'ids.ts',
  'live-coverage.ts',
  'migrate.ts',
  'motion.ts',
  'orientation.ts',
  'percentile.ts',
  'perspective.ts',
  'produce.ts',
  'ranges.ts',
  'raster.ts',
  'reduce.ts',
  'result.ts',
  'schema.ts',
  'types.ts',
  'zod.ts',
];

test('every core module is imported by this test and loads under node', async () => {
  const dir = path.join(REPO, 'src/core');
  const present = (await readdir(dir)).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(present, CORE_MODULES, 'a new core module is added to CORE_MODULES and imported at the top of this file');
  for (const file of present) await import(pathToFileURL(path.join(dir, file)).href);
  const size: Size = { width: 1, height: 1 };
  assert.equal(size.width, 1);
  const version: SceneDocument['version'] = SCENE_VERSION;
  assert.equal(version, MIGRATIONS.length);
  assert.ok(Object.keys(RANGES).length > 0 && Object.keys(LENGTHS).length > 0);
  assert.equal(typeof currentDocumentSchema.safeParse, 'function');
  assert.equal(typeof parseDocument, 'function');
  assert.equal(defaultStyle().fry, 0.6);
  const edit: Edit = { kind: 'fry', fry: 0.6 };
  assert.equal(edit.kind, 'fry');
  assert.equal(fryCurve(0.6).colors, 7);
  assert.equal(clampToRange('style.colors', 13), 12);
  assert.equal(typeof applyEdit, 'function');
  assert.equal(typeof applyEdits, 'function');
  assert.equal(typeof applyProduce, 'function');
  assert.equal(typeof dropSource, 'function');
  assert.ok(sameValue({ a: [1] }, { a: [1] }));
  assert.equal(coalesceKey(edit), 'fry');
  assert.equal(undo(EMPTY_HISTORY), null);
  assert.equal(redo(EMPTY_HISTORY), null);
  assert.equal(push(EMPTY_HISTORY, { key: 'fry', at: 0, forward: [edit], inverse: [edit] }, fiveClusterDocument()).undo.length, 1);
  assert.equal(referencedAssets(EMPTY_HISTORY).size, 0);
  assert.equal(layers(fiveClusterDocument()).length, 3);
  assert.deepEqual(NEED_OPS.depth, ['depth']);
  assert.ok(LOOP_ZOOM > 1);
  assert.equal(effectiveOrbit(fiveClusterDocument().motion), 1);
  assert.deepEqual(percentile([3, 1, 2, 4], 0.5), { ok: true, value: 2 });
});

test('isBuildId accepts the two forms the build writes and nothing else', () => {
  for (const id of ['f9ae016df39e-20261001', 'f9ae016df39e0a-20261001', 'nocommit-20261001']) assert.ok(isBuildId(id), id);
  for (const id of ['f9ae016df39-20261001', 'F9AE016DF39E-20261001', 'f9ae016df39e-2026101', 'f9ae016df39e_20261001', 'nocommit-20261001 ', '']) {
    assert.ok(!isBuildId(id), id);
  }
  const text: string = 'nocommit-20261001';
  if (isBuildId(text)) {
    const id: BuildId = text;
    assert.equal(id, 'nocommit-20261001');
  }
});

test('isTabId accepts a lowercase UUID v4, the form randomUUID returns', () => {
  const minted = crypto.randomUUID();
  assert.ok(isTabId(minted), minted);
  for (const id of ['9b2e7c1a-3f4d-4a8b-9c0d-1e2f3a4b5c6d', '00000000-0000-4000-8000-000000000000']) assert.ok(isTabId(id), id);
  for (const id of [
    '9B2E7C1A-3F4D-4A8B-9C0D-1E2F3A4B5C6D', // uppercase
    '9b2e7c1a-3f4d-1a8b-9c0d-1e2f3a4b5c6d', // version 1
    '9b2e7c1a-3f4d-4a8b-7c0d-1e2f3a4b5c6d', // not the RFC variant
    '9b2e7c1a3f4d4a8b9c0d1e2f3a4b5c6d',
    '',
  ]) {
    assert.ok(!isTabId(id), id);
  }
  const text: string = minted;
  if (isTabId(text)) {
    const id: TabId = text;
    assert.equal(id, minted);
  }
});

test('the document id checks accept their forms and nothing else', () => {
  const uuid = '9b2e7c1a-3f4d-4a8b-9c0d-1e2f3a4b5c6d';
  const hex = '0123456789abcdef'.repeat(4);
  for (const check of [isSceneId, isObjectId, isLightId]) {
    assert.ok(check(uuid));
    for (const id of [uuid.toUpperCase(), uuid.replace('-4a8b-', '-1a8b-'), hex, '']) assert.ok(!check(id), id);
  }
  assert.ok(isAssetId(hex));
  for (const id of [hex.toUpperCase(), hex.slice(1), `${hex}0`, uuid, '']) assert.ok(!isAssetId(id), id);
  for (const id of [`depth@${hex}`, `sam@${hex}`, `mi-gan2@${hex}`]) assert.ok(isModelId(id), id);
  for (const id of [`Depth@${hex}`, `2depth@${hex}`, `@${hex}`, `depth@${hex.slice(1)}`, `depth-${hex}`, hex, '']) assert.ok(!isModelId(id), id);
});

test('ok and err build the two arms of Result', () => {
  const parse = (text: string): Result<number, 'not-a-number'> => {
    const n = Number(text);
    return Number.isNaN(n) ? err('not-a-number') : ok(n);
  };
  assert.deepEqual(parse('42'), { ok: true, value: 42 });
  assert.deepEqual(parse('x'), { ok: false, error: 'not-a-number' });
  const result = parse('7');
  assert.equal(result.ok ? result.value + 1 : result.error, 8);
});

test('core/zod.ts configures zod as jitless before any importer creates a schema', () => {
  assert.equal(z.config().jitless, true);
  assert.deepEqual(z.object({ a: z.number() }).parse({ a: 1 }), { a: 1 });
});

test('core/color.ts loads and maps white to L 1', () => {
  assert.ok(Math.abs(srgbToOklab({ r: 1, g: 1, b: 1 }).L - 1) < 1e-3);
});
