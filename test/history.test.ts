// The undo history: coalescing keys, the bound, redo cleared by a new edit,
// coalescing into one step within the window and not across keys nor across
// an undo or a redo, a drag back to its start leaving no step, undo and redo
// through applyEdits, the assets the history references, and products applied
// between an edit and its undo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Edit } from '../src/core/edits.ts';
import { COALESCE_WINDOW_MS, coalesceKey, EMPTY_HISTORY, HISTORY_LIMIT, push, redo, referencedAssets, undo, type History, type HistoryEntry } from '../src/core/history.ts';
import type { AssetId } from '../src/core/ids.ts';
import { applyProduce } from '../src/core/produce.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import type { SceneDocument, SceneObject } from '../src/core/types.ts';
import { assetId, fiveClusterDocument, LIGHT_IDS, OBJECT_IDS } from './fixtures/documents.ts';
import { newLightAt, objectId, tappedObject } from './fixtures/edits.ts';
import { depthProduct } from './fixtures/products.ts';

const [SUBJECT, BOX] = OBJECT_IDS;
const [KEY_LIGHT] = LIGHT_IDS;

function stamp(ms: number): string {
  return new Date(Date.UTC(2026, 9, 2, 18, 0, 0, ms)).toISOString();
}

/** What a session holds while a scene is open, and the one way it takes a step: the edit applied and, when applied, pushed. */
type Session = { readonly doc: SceneDocument; readonly history: History };

function edit(session: Session, change: Edit, at: number): Session {
  const result = applyEdit(session.doc, change, stamp(at));
  assert.notEqual(result.kind, 'refused', JSON.stringify(change));
  if (result.kind !== 'applied') return session;
  return { doc: result.doc, history: push(session.history, { key: coalesceKey(change), at, forward: [change], inverse: result.inverse }, result.doc) };
}

function stepBack(session: Session, at: number): Session {
  const step = undo(session.history);
  assert.ok(step !== null, 'nothing to undo');
  const result = applyEdits(session.doc, step.edits, stamp(at));
  assert.notEqual(result.kind, 'refused');
  return { doc: result.doc, history: step.history };
}

function stepForward(session: Session, at: number): Session {
  const step = redo(session.history);
  assert.ok(step !== null, 'nothing to redo');
  const result = applyEdits(session.doc, step.edits, stamp(at));
  assert.notEqual(result.kind, 'refused');
  return { doc: result.doc, history: step.history };
}

function open(doc: SceneDocument): Session {
  return { doc, history: EMPTY_HISTORY };
}

/** The document but `updatedAt`, which every step stamps. */
function content(doc: SceneDocument): Omit<SceneDocument, 'updatedAt'> {
  const { updatedAt: _, ...rest } = doc;
  return rest;
}

/** A document whose saturation is not 0, so no `entry` below undoes as unchanged on it. */
const DOC = fiveClusterDocument();

function entry(key: string | null, at: number, n = 0): HistoryEntry {
  return { key, at, forward: [{ kind: 'style', patch: { saturation: n / 100 } }], inverse: [{ kind: 'style', patch: { saturation: 0 } }] };
}

// ---------------------------------------------------------------------------
// keys

test('coalesceKey gives one key per field or swatch, and null for every edit that is its own step', () => {
  const object: SceneObject = tappedObject(objectId(0));
  const cases: readonly [Edit, string | null][] = [
    [{ kind: 'title', title: 'x' }, 'title'],
    [{ kind: 'style', patch: { saturation: 0.5 } }, 'style:saturation'],
    [{ kind: 'style', patch: { grain: 0.5 } }, 'style:grain'],
    [{ kind: 'style', patch: { saturation: 0.5, grain: 0.5 } }, null],
    [{ kind: 'style', patch: {} }, null],
    [{ kind: 'fry', fry: 0.4 }, 'fry'],
    [{ kind: 'symbols', patch: { amount: 0.5 } }, 'symbols:amount'],
    [{ kind: 'motion', patch: { orbit: 0.5 } }, 'motion:orbit'],
    [{ kind: 'lighting', patch: { relief: 2 } }, 'lighting:relief'],
    [{ kind: 'palette.target', cluster: 2, color: { l: 0.5, c: 0.1, h: 3 } }, 'palette.target:2'],
    [{ kind: 'palette.target', cluster: 2, color: null }, 'palette.target:2'],
    [{ kind: 'palette.target', cluster: 0, color: null }, 'palette.target:0'],
    [{ kind: 'palette.target', cluster: -0, color: null }, 'palette.target:0'],
    [{ kind: 'object.set', id: SUBJECT, patch: { thickness: 1 } }, `object.set:${SUBJECT}:thickness`],
    [{ kind: 'object.set', id: SUBJECT, patch: { recolor: { kind: 'none' } } }, `object.set:${SUBJECT}:recolor`],
    [{ kind: 'object.set', id: SUBJECT, patch: { motion: { kind: 'bob', amount: 0.2 } } }, `object.set:${SUBJECT}:motion`],
    [{ kind: 'object.set', id: SUBJECT, patch: { motion: { kind: 'none' } } }, null],
    [{ kind: 'object.set', id: SUBJECT, patch: { thickness: 1, name: 'x' } }, null],
    [{ kind: 'light.set', id: KEY_LIGHT, patch: { at: { x: 0, y: 0 } } }, `light.set:${KEY_LIGHT}:at`],
    [{ kind: 'light.set', id: KEY_LIGHT, patch: { intensity: 1 } }, `light.set:${KEY_LIGHT}:intensity`],
    [{ kind: 'light.set', id: KEY_LIGHT, patch: { intensity: 1, rays: 0 } }, null],
    [{ kind: 'object.add', object }, null],
    [{ kind: 'object.refine', id: SUBJECT, produced: object.produced }, null],
    [{ kind: 'object.remove', id: SUBJECT }, null],
    [{ kind: 'light.add', light: newLightAt(LIGHT_IDS[1], 0.5, 0.5) }, null],
    [{ kind: 'light.remove', id: KEY_LIGHT }, null],
  ];
  for (const [change, key] of cases) assert.equal(coalesceKey(change), key, JSON.stringify(change));
});

// ---------------------------------------------------------------------------
// push

test(`the undo stack holds ${HISTORY_LIMIT} entries and drops the oldest`, () => {
  let history = EMPTY_HISTORY;
  for (let n = 0; n < HISTORY_LIMIT + 1; n++) history = push(history, entry(null, n * 10, n), DOC);
  assert.equal(history.undo.length, HISTORY_LIMIT);
  assert.deepEqual(history.undo[0], entry(null, 10, 1));
  assert.deepEqual(history.undo.at(-1), entry(null, HISTORY_LIMIT * 10, HISTORY_LIMIT));
});

test('a new edit clears the redo stack', () => {
  let session = open(fiveClusterDocument());
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 0);
  session = edit(session, { kind: 'title', title: 'Two' }, 5000);
  session = stepBack(session, 6000);
  assert.equal(session.history.redo.length, 1);
  session = edit(session, { kind: 'style', patch: { grain: 0.1 } }, 7000);
  assert.deepEqual(session.history.redo, []);
  assert.equal(redo(session.history), null);
  assert.equal(session.history.undo.length, 2);
});

test('a drag on one swatch is one undo step, and undoing it clears a cluster that had no target', () => {
  const before = fiveClusterDocument();
  assert.equal(before.style.paletteTargets.some((t) => t.cluster === 2), false);
  let session = open(before);
  // Each move is within the window of the one before, though the drag lasts longer than the window.
  for (let n = 0; n < 10; n++) session = edit(session, { kind: 'palette.target', cluster: 2, color: { l: 0.5, c: 0.1, h: n * 30 } }, n * 200);
  assert.equal(session.history.undo.length, 1);
  const [step] = session.history.undo;
  assert.deepEqual(step?.forward, [{ kind: 'palette.target', cluster: 2, color: { l: 0.5, c: 0.1, h: 270 } }]);
  assert.deepEqual(step?.inverse, [{ kind: 'palette.target', cluster: 2, color: null }]);
  assert.equal(step?.at, 1800);
  const dragged = session.doc;
  session = stepBack(session, 5000);
  assert.deepEqual(content(session.doc), content(before));
  session = stepForward(session, 6000);
  assert.deepEqual(content(session.doc), content(dragged));
});

test('two swatches within the window are two steps, and undoing one restores that cluster\'s previous color', () => {
  const before = fiveClusterDocument();
  const [one, three] = before.style.paletteTargets;
  assert.ok(one?.cluster === 1 && three?.cluster === 3);
  let session = open(before);
  session = edit(session, { kind: 'palette.target', cluster: 1, color: { l: 0.1, c: 0.1, h: 1 } }, 0);
  session = edit(session, { kind: 'palette.target', cluster: 3, color: { l: 0.2, c: 0.2, h: 2 } }, 100);
  assert.equal(session.history.undo.length, 2);
  session = stepBack(session, 200);
  assert.deepEqual(session.doc.style.paletteTargets, [{ cluster: 1, color: { l: 0.1, c: 0.1, h: 1 } }, three]);
  session = stepBack(session, 300);
  assert.deepEqual(content(session.doc), content(before));
});

test('two style fields within the window are two steps', () => {
  const before = fiveClusterDocument();
  let session = open(before);
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 0);
  session = edit(session, { kind: 'style', patch: { grain: 0.1 } }, 50);
  session = edit(session, { kind: 'style', patch: { saturation: 0.2 } }, 100);
  assert.deepEqual(session.history.undo.map((e) => e.key), ['style:saturation', 'style:grain', 'style:saturation']);
  session = stepBack(session, 200);
  assert.equal(session.doc.style.saturation, 0.1);
  assert.equal(session.doc.style.grain, 0.1);
});

test(`one key coalesces at ${COALESCE_WINDOW_MS} ms apart and not at one more, nor when time runs backwards, nor under a null key`, () => {
  assert.equal(push(push(EMPTY_HISTORY, entry('k', 1000, 1), DOC), entry('k', 1000 + COALESCE_WINDOW_MS, 2), DOC).undo.length, 1);
  assert.equal(push(push(EMPTY_HISTORY, entry('k', 1000, 1), DOC), entry('k', 1001 + COALESCE_WINDOW_MS, 2), DOC).undo.length, 2);
  assert.equal(push(push(EMPTY_HISTORY, entry('k', 1000, 1), DOC), entry('k', 999, 2), DOC).undo.length, 2);
  assert.equal(push(push(EMPTY_HISTORY, entry(null, 1000, 1), DOC), entry(null, 1000, 2), DOC).undo.length, 2);
  const merged = push(push(EMPTY_HISTORY, entry('k', 1000, 1), DOC), entry('k', 1100, 2), DOC).undo;
  assert.deepEqual(merged, [{ key: 'k', at: 1100, forward: entry('k', 0, 2).forward, inverse: entry('k', 0, 1).inverse }]);
});

test('a coalesced object motion step undoes and redoes exactly, and setting motion to none starts a step of its own', () => {
  const base = fiveClusterDocument();
  const before = { ...base, motion: { ...base.motion, enabled: false } };
  let session = open(before);
  session = edit(session, { kind: 'object.set', id: BOX, patch: { motion: { kind: 'bob', amount: 0.2 } } }, 0);
  session = edit(session, { kind: 'object.set', id: BOX, patch: { motion: { kind: 'bob', amount: 0.6 } } }, 100);
  assert.equal(session.history.undo.length, 1);
  assert.equal(session.doc.motion.enabled, true);
  session = edit(session, { kind: 'object.set', id: BOX, patch: { motion: { kind: 'none' } } }, 200);
  assert.equal(session.history.undo.length, 2);
  const after = session.doc;
  session = stepBack(stepBack(session, 300), 400);
  assert.deepEqual(content(session.doc), content(before));
  session = stepForward(stepForward(session, 500), 600);
  assert.deepEqual(content(session.doc), content(after));
});

test('a drag that returns a field to where it started leaves no step, and Cmd-Z reaches the step before it', () => {
  const before = fiveClusterDocument();
  let session = open(before);
  session = edit(session, { kind: 'style', patch: { grain: 0.1 } }, 0);
  const graining = session.history.undo;
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 5000);
  session = edit(session, { kind: 'style', patch: { saturation: 0.3 } }, 5100);
  assert.equal(session.history.undo.length, 2);
  session = edit(session, { kind: 'style', patch: { saturation: before.style.saturation } }, 5200);
  assert.deepEqual(session.history.undo, graining.map((e) => ({ ...e, key: null })));
  session = stepBack(session, 6000);
  assert.deepEqual(content(session.doc), content(before));
  // A drag back to the start of a fry drag, whose inverse is a nine-field patch, leaves no step either.
  session = edit(session, { kind: 'fry', fry: 0.9 }, 7000);
  session = edit(session, { kind: 'fry', fry: before.style.fry }, 7100);
  assert.deepEqual(session.history.undo, []);
  assert.deepEqual(content(session.doc), content(before));
});

test('an edit after a dropped drag starts a step of its own, though its key and time would join the step below', () => {
  const before = fiveClusterDocument();
  let session = open(before);
  session = edit(session, { kind: 'style', patch: { grain: 0.1 } }, 0);
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 100);
  session = edit(session, { kind: 'style', patch: { saturation: before.style.saturation } }, 200);
  assert.equal(session.history.undo.length, 1);
  session = edit(session, { kind: 'style', patch: { grain: 0.4 } }, 300);
  assert.equal(session.history.undo.length, 2);
  session = stepBack(session, 400);
  assert.equal(session.doc.style.grain, 0.1);
});

test('an edit after an undo or a redo starts a step of its own, though its key and time would coalesce', () => {
  let session = open(fiveClusterDocument());
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 0);
  session = edit(session, { kind: 'style', patch: { grain: 0.1 } }, 100);
  session = stepBack(session, 200);
  session = edit(session, { kind: 'style', patch: { saturation: 0.2 } }, 300);
  assert.deepEqual(session.history.undo.map((e) => e.inverse), [[{ kind: 'style', patch: { saturation: 0.62 } }], [{ kind: 'style', patch: { saturation: 0.1 } }]]);
  session = stepBack(session, 400);
  assert.equal(session.doc.style.saturation, 0.1);

  session = open(fiveClusterDocument());
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 0);
  session = stepForward(stepBack(session, 100), 200);
  session = edit(session, { kind: 'style', patch: { saturation: 0.2 } }, 300);
  assert.equal(session.history.undo.length, 2);
  session = stepBack(session, 400);
  assert.equal(session.doc.style.saturation, 0.1);
});

test('a swatch dragged with a cluster of -0 and then 0 is one step that undoes and redoes exactly', () => {
  const base = fiveClusterDocument();
  const before = { ...base, style: { ...base.style, paletteTargets: [] } };
  let session = open(before);
  session = edit(session, { kind: 'palette.target', cluster: -0, color: { l: 0.5, c: 0.1, h: 10 } }, 0);
  session = edit(session, { kind: 'palette.target', cluster: 0, color: { l: 0.5, c: 0.1, h: 20 } }, 100);
  assert.equal(session.history.undo.length, 1);
  const dragged = session.doc;
  assert.ok(Object.is(dragged.style.paletteTargets[0]?.cluster, 0));
  session = stepBack(session, 200);
  assert.deepEqual(content(session.doc), content(before));
  session = stepForward(session, 300);
  assert.deepEqual(content(session.doc), content(dragged));
});

test('clearing a target and setting it back under the other zero is a step, and undoing it restores the stored zero', () => {
  const base = fiveClusterDocument();
  const color = { l: 0.5, c: 0.1, h: 10 };
  const before = { ...base, style: { ...base.style, paletteTargets: [{ cluster: 0, color }] } };
  let session = open(before);
  session = edit(session, { kind: 'palette.target', cluster: -0, color: null }, 0);
  session = edit(session, { kind: 'palette.target', cluster: -0, color }, 100);
  assert.equal(session.history.undo.length, 1);
  assert.ok(Object.is(session.doc.style.paletteTargets[0]?.cluster, -0));
  session = stepBack(session, 200);
  assert.deepEqual(content(session.doc), content(before));
  assert.ok(Object.is(session.doc.style.paletteTargets[0]?.cluster, 0));
});

// ---------------------------------------------------------------------------
// referenced assets

function maskedObject(n: number, mask: AssetId): SceneObject {
  const object = tappedObject(objectId(n));
  return { ...object, produced: { ...object.produced, mask: { ...object.produced.mask, asset: mask } } };
}

test('referencedAssets lists the masks of object.add, of object.remove inverses, and of object.refine, on both stacks', () => {
  const before = fiveClusterDocument();
  const [subject] = before.objects;
  assert.ok(subject !== undefined);
  let session = open(before);
  session = edit(session, { kind: 'object.add', object: maskedObject(0, assetId(0x70)) }, 0);
  session = edit(session, { kind: 'object.remove', id: BOX }, 1000);
  session = edit(session, { kind: 'object.refine', id: SUBJECT, produced: { ...subject.produced, mask: { ...subject.produced.mask, asset: assetId(0x71) } } }, 2000);
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 3000);
  const all = new Set([assetId(0x70), assetId(0x32), assetId(0x31), assetId(0x71)]);
  assert.deepEqual(referencedAssets(session.history), all);
  // Undone, the add, the remove, and the refine sit on the redo stack, and still count.
  for (let n = 0; n < 4; n++) session = stepBack(session, 4000 + n);
  assert.deepEqual(session.history.undo, []);
  assert.deepEqual(referencedAssets(session.history), all);
});

test(`an asset referenced only by an entry that fell off past ${HISTORY_LIMIT} entries is no longer listed`, () => {
  let session = open(fiveClusterDocument());
  session = edit(session, { kind: 'object.add', object: maskedObject(0, assetId(0x70)) }, 0);
  session = edit(session, { kind: 'object.add', object: maskedObject(1, assetId(0x72)) }, 1000);
  for (let n = 0; n < HISTORY_LIMIT - 2; n++) session = edit(session, { kind: 'title', title: `Title ${n}` }, 2000 + n * 1000);
  assert.ok(referencedAssets(session.history).has(assetId(0x70)));
  session = edit(session, { kind: 'title', title: 'One more' }, 100_000);
  assert.equal(session.history.undo.length, HISTORY_LIMIT);
  assert.equal(referencedAssets(session.history).has(assetId(0x70)), false);
  assert.ok(referencedAssets(session.history).has(assetId(0x72)));
});

// ---------------------------------------------------------------------------
// products and the history

test('undo after a depth product lands keeps the depth, and a product never enters the history', () => {
  const before = fiveClusterDocument();
  let session = open(before);
  session = edit(session, { kind: 'style', patch: { saturation: 0.1 } }, 0);
  session = edit(session, { kind: 'object.remove', id: BOX }, 1000);
  const history = session.history;
  const landed = applyProduce(session.doc, { kind: 'depth', depth: depthProduct(3) }, stamp(1500));
  assert.equal(landed.kind, 'applied');
  session = { ...session, doc: landed.doc };
  assert.equal(session.history, history);
  session = stepBack(stepBack(session, 2000), 2100);
  assert.deepEqual(session.doc.analysis.depth, depthProduct(3));
  assert.deepEqual(content(session.doc), content({ ...before, analysis: { ...before.analysis, depth: depthProduct(3) } }));
  session = stepForward(stepForward(session, 2200), 2300);
  assert.deepEqual(session.doc.analysis.depth, depthProduct(3));
  assert.equal(session.doc.objects.length, 1);
  // At the type level, an entry holds edits only.
  // @ts-expect-error a product is not an edit
  const _product: HistoryEntry = { key: null, at: 0, forward: [{ kind: 'depth', depth: depthProduct(3) }], inverse: [{ kind: 'style', patch: {} }] };
});
