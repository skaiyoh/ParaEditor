// Seeded random sessions: from every fixture document, sequences of edits
// (many of them drags that coalesce), products of every kind, undos, and
// redos, run the way a session runs them. After every step the document
// parses; after every undo the document equals, but for what products own,
// the document before the step it undid, and after every redo the document
// after it, so undo and redo stay exact across coalescing, the bound, and
// products applied in between. A drag that returns to its start must leave no
// step, and the document must then equal the one before the drag.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Edit, Produce } from '../src/core/edits.ts';
import { coalesceKey, EMPTY_HISTORY, HISTORY_LIMIT, push, recordEdit, redo, undo, type History, type HistoryStep } from '../src/core/history.ts';
import { createAuthoring } from '../src/session/authoring.ts';
import { applyProduce, sortedMasks } from '../src/core/produce.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { SceneDocument, SceneObject } from '../src/core/types.ts';
import { assetId, SAM_MODEL, validDocuments } from './fixtures/documents.ts';
import { lightId, newLightAt, objectId, tappedObject } from './fixtures/edits.ts';
import { depthProduct, plateProduct } from './fixtures/products.ts';

const SEQUENCES = 200;
const STEPS = 160;
const SEED = 0x5eed_4157;

type Random = () => number;

test('100 seeded gesture sessions preserve separate actions, cancellation and analysis through every undo/redo', () => {
  const random = seeded(SEED + 1);
  for (let sequence = 0; sequence < 100; sequence++) {
    let doc = validDocuments()[sequence % validDocuments().length]; assert.ok(doc);
    let current: SceneDocument = doc, history = EMPTY_HISTORY, at = 0, saves = 0;
    const snapshots: SceneDocument[] = [current];
    const authoring = createAuthoring({ read: () => current, changed: () => {}, record: (edit) => {
      const result = recordEdit({ doc: current, history, edit, at, now: new Date(Date.UTC(2026, 9, 11, 0, 0, 0, at)).toISOString() });
      assert.notEqual(result.kind, 'refused');
      if (result.kind === 'refused') return { kind: 'refused', reason: result.detail };
      if (result.kind === 'applied') { current = result.doc; history = result.history; saves++; snapshots.push(current); }
      return { kind: result.kind };
    } });
    for (let gesture = 0; gesture < 25; gesture++) {
      const before = current, beforeHistory = history, saved = saves;
      const token = authoring.beginGesture({ operation: 'style', target: { kind: 'scene' } }); assert.ok(token);
      const end = Math.floor(random() * 3);
      for (let move = 0; move < 8; move++) {
        at += Math.floor(random() * 2000);
        authoring.updateGesture({ token, value: { kind: 'style', patch: { saturation: random() } } });
        assert.equal(current, before); assert.equal(history, beforeHistory); assert.equal(saves, saved);
      }
      if (end === 0) authoring.cancelGesture(token);
      else {
        if (end === 1) authoring.updateGesture({ token, value: { kind: 'style', patch: { saturation: before.style.saturation } } });
        authoring.commitGesture(token);
      }
      if (end !== 2) { assert.equal(current, before); assert.equal(history, beforeHistory); assert.equal(saves, saved); }
      assert.equal(history.undo.length, saves);
      at += Math.floor(random() * 100);
    }
    const landed = applyProduce(current, { kind: 'depth', depth: depthProduct(3) }, current.updatedAt);
    assert.notEqual(landed.kind, 'refused'); current = landed.doc;
    for (let i = snapshots.length - 2; i >= 0; i--) {
      const step = undo(history); assert.ok(step); assert.equal(step.kind, 'document'); if (step.kind !== 'document') throw new Error('Expected a document history step.');
      const result = applyEdits(current, step.edits, current.updatedAt); assert.notEqual(result.kind, 'refused');
      current = result.doc; history = step.history;
      const expected = snapshots[i]; assert.ok(expected);
      assert.deepEqual(editable(current), editable(expected)); assert.deepEqual(current.analysis.depth, depthProduct(3));
    }
    for (const expected of snapshots.slice(1)) {
      const step = redo(history); assert.ok(step); assert.equal(step.kind, 'document'); if (step.kind !== 'document') throw new Error('Expected a document history step.');
      const result = applyEdits(current, step.edits, current.updatedAt); assert.notEqual(result.kind, 'refused');
      current = result.doc; history = step.history;
      assert.deepEqual(editable(current), editable(expected)); assert.deepEqual(current.analysis.depth, depthProduct(3));
    }
  }
});

function aiSelection(produced: SceneDocument['objects'][number]['produced']) {
  assert.ok(produced.provenance.kind === 'ai');
  return produced.provenance.selection;
}

/** mulberry32: a small seeded generator of uniform numbers in [0, 1). */
function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: Random, items: readonly [T, ...T[]]): T {
  return items[Math.floor(random() * items.length)] ?? items[0];
}

function someOf<T>(random: Random, items: readonly T[]): T | undefined {
  return items[Math.floor(random() * items.length)];
}

/** Gaps between steps around the coalescing window, in milliseconds. */
const GAPS = [0, 30, 200, 599, 600, 601, 2000] as const;

const EDIT_KINDS = [
  'saturation', 'saturation', 'grain', 'fry', 'target', 'target', 'target', 'drift', 'title',
  'thickness', 'motion', 'light.at', 'light.intensity',
  'object.add', 'object.remove', 'object.refine', 'light.add', 'light.remove',
] as const;

type EditKind = (typeof EDIT_KINDS)[number];

/** An edit of `kind` as a session would see one; null when the document has nothing for that kind to act on. */
function randomEdit(random: Random, doc: SceneDocument, fresh: () => number, kind: EditKind): Edit | null {
  const object = someOf(random, doc.objects);
  const light = someOf(random, doc.lights);
  switch (kind) {
    case 'saturation':
      return { kind: 'style', patch: { saturation: Math.round(random() * 4) / 4 } };
    case 'grain':
      return { kind: 'style', patch: { grain: Math.round(random() * 4) / 4 } };
    case 'fry':
      return { kind: 'fry', fry: Math.round(random() * 10) / 10 };
    case 'target': {
      const index = Math.min(Math.floor(random() * 3), doc.analysis.colors.length - 1);
      // -0 names cluster 0 too, and a target stores the zero it is given.
      const cluster = index === 0 && random() < 0.5 ? -0 : index;
      return { kind: 'palette.target', cluster, color: random() < 0.2 ? null : { l: 0.5, c: 0.1, h: Math.floor(random() * 4) * 90 } };
    }
    case 'drift':
      return { kind: 'motion', patch: { drift: { direction: 'circle', amount: Math.round(random() * 4) / 4 } } };
    case 'title':
      return { kind: 'title', title: `Title ${Math.floor(random() * 3)}` };
    case 'thickness':
      return object === undefined ? null : { kind: 'object.set', id: object.id, patch: { thickness: Math.round(random() * 4) / 2 } };
    case 'motion':
      return object === undefined
        ? null
        : { kind: 'object.set', id: object.id, patch: { motion: random() < 0.3 ? { kind: 'none' } : { kind: 'bob', amount: Math.round(random() * 4) / 4 } } };
    case 'light.at':
      return light === undefined ? null : { kind: 'light.set', id: light.id, patch: { at: { x: Math.round(random() * 4) / 4, y: 0.5 } } };
    case 'light.intensity':
      return light === undefined ? null : { kind: 'light.set', id: light.id, patch: { intensity: Math.round(random() * 4) / 2 } };
    case 'object.add':
      return { kind: 'object.add', object: freshObject(fresh) };
    case 'object.remove':
      return object === undefined ? null : { kind: 'object.remove', id: object.id };
    case 'object.refine':
      return object === undefined
        ? null
        : { kind: 'object.refine', id: object.id, produced: { ...object.produced, provenance: { kind: 'ai', model: SAM_MODEL, selection: { ...aiSelection(object.produced), candidate: Math.floor(random() * 3) } } } };
    case 'light.add':
      return { kind: 'light.add', light: newLightAt(lightId(fresh()), 0.5, 0.5) };
    case 'light.remove':
      return light === undefined ? null : { kind: 'light.remove', id: light.id };
    default: {
      const unhandled: never = kind;
      throw new Error(`no generator for ${String(unhandled)}`);
    }
  }
}

/** An object with a fresh id and mask, as a tap or a subject guess would bring one. */
function freshObject(fresh: () => number): SceneObject {
  const object = tappedObject(objectId(fresh()));
  return { ...object, produced: { ...object.produced, mask: { ...object.produced.mask, asset: assetId(0x100 + fresh()) } } };
}

/** A product of any kind, current or one the document has moved past. */
function randomProduct(random: Random, doc: SceneDocument, fresh: () => number): Produce {
  const roll = random();
  if (roll < 0.25) return { kind: 'depth', depth: depthProduct(fresh()) };
  if (roll < 0.5) {
    const forMasks = random() < 0.7 ? sortedMasks(doc) : [assetId(0x99)];
    const plate = plateProduct(fresh(), forMasks, doc);
    return { kind: 'plate', plate, required: plateProduct(0, sortedMasks(doc), doc).key };
  }
  if (roll < 0.8) {
    const id = random() < 0.8 ? (someOf(random, doc.objects)?.id ?? objectId(0)) : objectId(fresh());
    const p10 = Math.round(random() * 4) / 10;
    return { kind: 'object.depth', id, depth: { p10, median: p10 + 0.2, p90: p10 + 0.5 } };
  }
  return { kind: 'auto-subject', found: random() < 0.25 ? null : freshObject(fresh) };
}

/**
 * What undo restores: the document but what products own, which undo never
 * touches, and updatedAt, which every step stamps. Products own `analysis` and
 * each object's depth statistics; the statistics a removed object comes back
 * with are the ones its remove captured, which a later `object.depth` may have
 * replaced on the live object.
 */
type Editable = Omit<SceneDocument, 'analysis' | 'updatedAt'>;

function editable(doc: SceneDocument): Editable {
  const { analysis: _a, updatedAt: _u, ...rest } = doc;
  return { ...rest, objects: doc.objects.map(withoutDepth) };
}

function withoutDepth(object: SceneObject): SceneObject {
  return { ...object, produced: { ...object.produced, depth: null } };
}

type Snapshot = { before: Editable; after: Editable };

test(`${SEQUENCES} seeded random sessions of edits, products, undos, and redos stay valid, and every undo and redo is exact`, (t) => {
  const random = seeded(SEED);
  const starts = validDocuments();
  const counts = { pushed: 0, coalesced: 0, returned: 0, dropped: 0, unchangedEdits: 0, undone: 0, redone: 0, produced: 0, objectDepths: 0 };
  let guessed = 0;
  for (let sequence = 0; sequence < SEQUENCES; sequence++) {
    const start = starts[sequence % starts.length];
    assert.ok(start !== undefined);
    let doc = start;
    let history: History = EMPTY_HISTORY;
    // One snapshot per entry of each stack, in the same order.
    let undoSnaps: Snapshot[] = [];
    let redoSnaps: Snapshot[] = [];
    let at = 0;
    let counter = 0;
    let dragging: EditKind | null = null;
    const fresh = (): number => ++counter;
    for (let step = 0; step < STEPS; step++) {
      at += pick(random, GAPS);
      const now = new Date(Date.UTC(2026, 9, 2, 18, 0, 0, at)).toISOString();
      const label = `sequence ${sequence}, step ${step}`;
      const roll = random();
      if (roll < 0.15) {
        const product = randomProduct(random, doc, fresh);
        const result = applyProduce(doc, product, now);
        assert.notEqual(result.kind, 'refused', label);
        if (result.kind === 'applied') {
          counts.produced++;
          if (product.kind === 'object.depth') counts.objectDepths++;
          const [guess] = result.doc.objects;
          if (product.kind === 'auto-subject' && doc.objects.length === 0 && guess !== undefined) {
            // A guessed subject is a product: no undo removes it, so every
            // state the stacks lead back to now holds it. Such a state had no
            // object, since the owner's first object closes the question.
            guessed++;
            for (const snap of [...undoSnaps, ...redoSnaps]) {
              assert.deepEqual([snap.before.objects, snap.after.objects], [[], []], label);
              snap.before = { ...snap.before, objects: [withoutDepth(guess)], removals: result.doc.removals };
              snap.after = { ...snap.after, objects: [withoutDepth(guess)], removals: result.doc.removals };
            }
          }
        }
        doc = result.doc;
      } else if (roll < 0.3) {
        const taken: HistoryStep | null = undo(history);
        if (taken === null) continue;
        assert.equal(taken.kind, 'document');
        if (taken.kind !== 'document') throw new Error('Expected a document history step.');
        const result = applyEdits(doc, taken.edits, now);
        assert.notEqual(result.kind, 'refused', `${label}: undo ${JSON.stringify(taken.edits)}`);
        doc = result.doc;
        history = taken.history;
        const snap = undoSnaps.pop();
        assert.ok(snap !== undefined, label);
        assert.deepEqual(editable(doc), snap.before, `${label}: undo`);
        redoSnaps.push(snap);
        counts.undone++;
      } else if (roll < 0.4) {
        const taken = redo(history);
        if (taken === null) continue;
        assert.equal(taken.kind, 'document');
        if (taken.kind !== 'document') throw new Error('Expected a document history step.');
        const result = applyEdits(doc, taken.edits, now);
        assert.notEqual(result.kind, 'refused', `${label}: redo ${JSON.stringify(taken.edits)}`);
        doc = result.doc;
        history = taken.history;
        const snap = redoSnaps.pop();
        assert.ok(snap !== undefined, label);
        assert.deepEqual(editable(doc), snap.after, `${label}: redo`);
        undoSnaps.push(snap);
        counts.redone++;
      } else {
        // Half the time the owner keeps dragging what they dragged last.
        const kind: EditKind = dragging !== null && random() < 0.5 ? dragging : pick(random, EDIT_KINDS);
        dragging = kind;
        const change = randomEdit(random, doc, fresh, kind);
        if (change === null) continue;
        const result = applyEdit(doc, change, now);
        if (result.kind !== 'applied') {
          if (result.kind === 'unchanged') counts.unchangedEdits++;
          continue;
        }
        const before = editable(doc);
        doc = result.doc;
        const last = history.undo.at(-1);
        const depth = history.undo.length;
        history = push(history, { key: coalesceKey(change), at, forward: [change], inverse: result.inverse }, doc);
        redoSnaps = [];
        const top = history.undo.at(-1);
        if (history.undo.length < depth) {
          // The edit took the step it joined back to where it started.
          const snap = undoSnaps.pop();
          assert.ok(snap !== undefined, label);
          assert.deepEqual(editable(doc), snap.before, `${label}: returned`);
          counts.returned++;
        } else if (last !== undefined && top !== undefined && !('kind' in last) && !('kind' in top) && top.inverse === last.inverse) {
          const snap = undoSnaps.at(-1);
          assert.ok(snap !== undefined, label);
          snap.after = editable(doc);
          counts.coalesced++;
        } else {
          undoSnaps.push({ before, after: editable(doc) });
          if (undoSnaps.length > HISTORY_LIMIT) {
            undoSnaps = undoSnaps.slice(1);
            counts.dropped++;
          }
          counts.pushed++;
        }
        if (change.kind === 'object.add' && doc.analysis.autoSubject === 'pending') {
          // The driver closes the subject question once the owner's first object lands.
          const closed = applyProduce(doc, { kind: 'auto-subject', found: null }, now);
          assert.equal(closed.kind, 'applied', label);
          doc = closed.doc;
        }
      }
      const parsed = parseDocument(doc);
      assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
      assert.equal(history.undo.length, undoSnaps.length, label);
      assert.equal(history.redo.length, redoSnaps.length, label);
      assert.ok(history.undo.length + history.redo.length <= HISTORY_LIMIT, label);
    }
  }
  t.diagnostic(`outcomes: ${JSON.stringify({ ...counts, guessed })}`);
  // Every path is exercised in quantity, so a generator that never coalesces,
  // never reaches the bound, or never undoes fails here.
  for (const [name, count] of Object.entries(counts)) assert.ok(count > 100, `${name}: ${JSON.stringify(counts)}`);
  // At most one guess lands per session that starts with the question open.
  assert.ok(guessed > 10, `guessed: ${guessed}`);
});
