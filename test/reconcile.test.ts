// reconcile, the plan of analysis a document still needs: its order, its
// conditions, blocked operations, the owner's first object ending the guess,
// and, on every fixture and on a grid of generated documents, under every
// cache state, set of blocked operations, and intent, that each listed need's
// inputs exist or are listed before it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEED_OPS, plateNeeded, reconcile, type AnalysisOp, type CacheIndex, type Intent, type Need } from '../src/core/derive.ts';
import { applyProduce, sortedMasks } from '../src/core/produce.ts';
import { applyEdit } from '../src/core/reduce.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { ObjectMotion, SceneDocument, SceneObject } from '../src/core/types.ts';
import { assetId, minimalDocument, validDocuments } from './fixtures/documents.ts';
import { objectId, tappedObject } from './fixtures/edits.ts';
import { depthProduct, plateProduct } from './fixtures/products.ts';

const NOW = '2026-10-02T19:00:00.000Z';
const OPS: readonly AnalysisOp[] = ['depth', 'encode', 'decode', 'inpaint'];
const ORDER: readonly Need['kind'][] = ['depth', 'encode', 'auto-subject', 'plate'];
const NONE: ReadonlySet<AnalysisOp> = new Set();
const NO_INTENT: Intent = { objectsActive: false, tapPending: false };
const COLD: CacheIndex = { embeddings: false };
const WARM: CacheIndex = { embeddings: true };

const kinds = (plan: readonly Need[]): readonly Need['kind'][] => plan.map((need) => need.kind);

/** Every subset of the four operations. */
const BLOCKED_SETS: readonly ReadonlySet<AnalysisOp>[] = Array.from({ length: 16 }, (_, bits) => new Set(OPS.filter((_, i) => (bits & (1 << i)) !== 0)));
const INTENTS: readonly Intent[] = [NO_INTENT, { objectsActive: true, tapPending: false }, { objectsActive: false, tapPending: true }, { objectsActive: true, tapPending: true }];
const CACHES: readonly CacheIndex[] = [COLD, WARM];

/**
 * The plan's invariants: needs in dependency order, each kind once; no listed
 * need runs a blocked operation; each listed need's inputs exist or are listed
 * before it; and each need is listed exactly when its conditions hold.
 */
function checkPlan(doc: SceneDocument, cache: CacheIndex, blocked: ReadonlySet<AnalysisOp>, intent: Intent, label: string): void {
  const plan = reconcile(doc, cache, blocked, intent);
  const listed = kinds(plan);
  const at = (kind: Need['kind']): number => listed.indexOf(kind);
  const ranks = listed.map((kind) => ORDER.indexOf(kind));
  assert.ok(ranks.every((rank, i) => i === 0 || rank > (ranks[i - 1] ?? -1)), `${label}: in order, each once: ${listed.join(', ')}`);
  for (const need of plan) {
    assert.ok(!NEED_OPS[need.kind].some((op) => blocked.has(op)), `${label}: ${need.kind} runs no blocked op`);
  }
  const subject = at('auto-subject');
  if (subject !== -1) {
    const depthBefore = doc.analysis.depth !== null || (at('depth') !== -1 && at('depth') < subject);
    const embeddingsBefore = cache.embeddings || (at('encode') !== -1 && at('encode') < subject);
    assert.ok(depthBefore && embeddingsBefore, `${label}: auto-subject's depth and embeddings exist or come before it`);
    assert.ok(doc.objects.length === 0 && doc.analysis.autoSubject === 'pending', `${label}: auto-subject only with no object and the guess pending`);
  }
  const plate = plan.find((need) => need.kind === 'plate');
  if (plate !== undefined) {
    assert.ok(doc.objects.length > 0, `${label}: a plate's masks exist`);
    assert.deepEqual(plate.forMasks, sortedMasks(doc), `${label}: the plate is asked for the current masks`);
  }
  assert.equal(at('depth') !== -1, doc.analysis.depth === null && !blocked.has('depth'), `${label}: depth listed exactly when missing and not blocked`);
  assert.equal(at('plate') !== -1, plateNeeded(doc) && !blocked.has('inpaint'), `${label}: plate listed exactly when needed and not blocked`);
  if (at('encode') !== -1) assert.ok(!cache.embeddings, `${label}: encode only without embeddings`);
  if (intent.objectsActive || intent.tapPending) {
    assert.equal(at('encode') !== -1, !cache.embeddings && !blocked.has('encode'), `${label}: intent lists encode whenever embeddings are missing`);
  }
}

// ---------------------------------------------------------------------------
// the plan's cases

test('a fresh document yields depth, encode, and auto-subject, in that order', () => {
  const doc = minimalDocument();
  assert.equal(doc.analysis.depth, null);
  assert.equal(doc.analysis.autoSubject, 'pending');
  assert.deepEqual(reconcile(doc, COLD, NONE, NO_INTENT), [{ kind: 'depth' }, { kind: 'encode' }, { kind: 'auto-subject' }]);
});

test('with depth blocked a fresh document yields nothing until intent, and encode with it', () => {
  const doc = minimalDocument();
  const depthBlocked = new Set<AnalysisOp>(['depth']);
  assert.deepEqual(reconcile(doc, COLD, depthBlocked, NO_INTENT), []);
  assert.deepEqual(reconcile(doc, WARM, depthBlocked, NO_INTENT), []);
  assert.deepEqual(reconcile(doc, COLD, depthBlocked, { objectsActive: true, tapPending: false }), [{ kind: 'encode' }]);
  assert.deepEqual(reconcile(doc, COLD, depthBlocked, { objectsActive: false, tapPending: true }), [{ kind: 'encode' }]);
});

test('once depth exists the guess waits only on embeddings', () => {
  const doc: SceneDocument = { ...minimalDocument(), analysis: { ...minimalDocument().analysis, depth: depthProduct(0) } };
  assert.deepEqual(kinds(reconcile(doc, COLD, NONE, NO_INTENT)), ['encode', 'auto-subject']);
  assert.deepEqual(kinds(reconcile(doc, WARM, NONE, NO_INTENT)), ['auto-subject']);
  assert.deepEqual(kinds(reconcile(doc, WARM, new Set(['encode']), NO_INTENT)), [], 'auto-subject runs encode too, so a blocked encode omits it');
  // The wish for a guess lists the encoder even while decode is blocked, as the plan's conditions state.
  assert.deepEqual(kinds(reconcile(doc, COLD, new Set(['decode']), NO_INTENT)), ['encode']);
});

test('a document whose guess is done lists no auto-subject and no encode without intent', () => {
  const doc: SceneDocument = { ...minimalDocument(), analysis: { ...minimalDocument().analysis, autoSubject: 'done' } };
  assert.deepEqual(kinds(reconcile(doc, COLD, NONE, NO_INTENT)), ['depth']);
  assert.deepEqual(kinds(reconcile(doc, COLD, NONE, { objectsActive: true, tapPending: false })), ['depth', 'encode']);
});

test('reconcile never lists auto-subject while objects exist', () => {
  const added = applyEdit(minimalDocument(), { kind: 'object.add', object: tappedObject(objectId(0)) }, NOW);
  assert.equal(added.kind, 'applied');
  const doc = added.doc;
  assert.equal(doc.analysis.autoSubject, 'pending', "the owner's tap beat the guess");
  for (const cache of CACHES) {
    for (const intent of INTENTS) {
      assert.ok(!kinds(reconcile(doc, cache, NONE, intent)).includes('auto-subject'));
      assert.ok(!kinds(reconcile({ ...doc, analysis: { ...doc.analysis, depth: depthProduct(0) } }, cache, NONE, intent)).includes('auto-subject'));
    }
  }
});

test("after the first object's found: null product, removing that object lists no auto-subject", () => {
  const added = applyEdit(minimalDocument(), { kind: 'object.add', object: tappedObject(objectId(0)) }, NOW);
  assert.equal(added.kind, 'applied');
  const closed = applyProduce(added.doc, { kind: 'auto-subject', found: null }, NOW);
  assert.equal(closed.kind, 'applied');
  assert.equal(closed.doc.analysis.autoSubject, 'done');
  const removed = applyEdit(closed.doc, { kind: 'object.remove', id: objectId(0) }, NOW);
  assert.equal(removed.kind, 'applied');
  assert.equal(removed.doc.objects.length, 0);
  for (const depth of [null, depthProduct(0)]) {
    const doc = { ...removed.doc, analysis: { ...removed.doc.analysis, depth } };
    for (const cache of CACHES) for (const intent of INTENTS) assert.ok(!kinds(reconcile(doc, cache, NONE, intent)).includes('auto-subject'));
  }
  // Undoing the add instead of removing the object is the same document as far as the plan is concerned.
  const undone = applyAll(closed.doc, added.inverse);
  for (const cache of CACHES) assert.ok(!kinds(reconcile(undone, cache, NONE, NO_INTENT)).includes('auto-subject'));
  // Without that product, the same removal would list a guess no tap made.
  const unclosed = applyEdit(added.doc, { kind: 'object.remove', id: objectId(0) }, NOW);
  assert.equal(unclosed.kind, 'applied');
  assert.ok(kinds(reconcile(unclosed.doc, COLD, NONE, NO_INTENT)).includes('auto-subject'));
});

function applyAll(doc: SceneDocument, edits: readonly Parameters<typeof applyEdit>[1][]): SceneDocument {
  return edits.reduce((current, edit) => {
    const result = applyEdit(current, edit, NOW);
    assert.equal(result.kind, 'applied');
    return result.doc;
  }, doc);
}

test('a missing or stale plate is listed last, for the current sorted masks, unless inpaint is blocked', () => {
  const [, five] = validDocuments();
  assert.ok(five !== undefined);
  assert.deepEqual(reconcile(five, COLD, NONE, NO_INTENT), [], 'the five-cluster fixture holds every product, its plate current');
  const [first] = five.objects;
  assert.ok(first !== undefined);
  const oneMask = { ...five, objects: [first] };
  assert.deepEqual(reconcile(oneMask, COLD, NONE, NO_INTENT), [{ kind: 'plate', forMasks: [first.produced.mask.asset] }]);
  assert.deepEqual(reconcile(oneMask, COLD, new Set(['inpaint']), NO_INTENT), []);
  const fresh = { ...oneMask, analysis: { ...oneMask.analysis, depth: null } };
  assert.deepEqual(kinds(reconcile(fresh, COLD, NONE, { objectsActive: true, tapPending: false })), ['depth', 'encode', 'plate']);
});

// ---------------------------------------------------------------------------
// the plan's invariants on every fixture and on a grid of generated documents

test('on every fixture document each listed need has its inputs or follows them', () => {
  for (const [d, doc] of validDocuments().entries()) {
    for (const cache of CACHES) {
      for (const blocked of BLOCKED_SETS) {
        for (const intent of INTENTS) checkPlan(doc, cache, blocked, intent, `fixture ${d}, ${JSON.stringify({ cache, blocked: [...blocked], intent })}`);
      }
    }
  }
});

/**
 * A grid over the document fields reconcile reads, with chosen values of each:
 * depth absent or present, the
 * guess pending or done, 0 to 2 objects with the first one's motion none or
 * bob, motion off or on, orbit 0 or 0.6, and no plate, a current one, or a
 * stale one made for two masks no object has.
 */
function generatedDocuments(): readonly { readonly label: string; readonly doc: SceneDocument }[] {
  const out: { label: string; doc: SceneDocument }[] = [];
  const motions: readonly ObjectMotion[] = [{ kind: 'none' }, { kind: 'bob', amount: 0.4 }];
  for (const depth of [null, depthProduct(0)]) {
    for (const autoSubject of ['pending', 'done'] as const) {
      for (const count of [0, 1, 2]) {
        for (const objectMotion of motions) {
          for (const enabled of [false, true]) {
            for (const orbit of [0, 0.6]) {
              for (const plate of ['none', 'current', 'stale'] as const) {
                const objects: SceneObject[] = Array.from({ length: count }, (_, n) => {
                  const base = tappedObject(objectId(n));
                  return { ...base, subject: n === 0, motion: n === 0 ? objectMotion : { kind: 'none' }, produced: { ...base.produced, mask: { ...base.produced.mask, asset: assetId(0x400 - n) } } };
                });
                const base = minimalDocument();
                const draft: SceneDocument = { ...base, objects, motion: { ...base.motion, enabled, orbit } };
                const forMasks = plate === 'current' ? sortedMasks(draft) : [assetId(0x3ff), assetId(0x3ff)];
                const doc: SceneDocument = {
                  ...draft,
                  analysis: { ...base.analysis, depth, autoSubject, plate: plate === 'none' ? null : plateProduct(0, forMasks) },
                };
                out.push({ label: JSON.stringify({ depth: depth !== null, autoSubject, count, objectMotion: objectMotion.kind, enabled, orbit, plate }), doc });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

test('on every generated document each listed need has its inputs or follows them', () => {
  const docs = generatedDocuments();
  let plans = 0;
  const seen = new Set<string>();
  for (const { label, doc } of docs) {
    const parsed = parseDocument(doc);
    assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
    for (const cache of CACHES) {
      for (const blocked of BLOCKED_SETS) {
        for (const intent of INTENTS) {
          checkPlan(doc, cache, blocked, intent, `${label}, ${JSON.stringify({ cache, blocked: [...blocked], intent })}`);
          seen.add(kinds(reconcile(doc, cache, blocked, intent)).join(','));
          plans++;
        }
      }
    }
  }
  console.log(`reconcile: ${docs.length} generated documents, ${plans} plans, ${seen.size} distinct plans`);
  // Every subsequence of the four kinds that the conditions allow appears, the full plan among them.
  assert.ok(seen.has('depth,encode,auto-subject') && seen.has('depth,encode,plate') && seen.has('') && seen.has('auto-subject'));
});
