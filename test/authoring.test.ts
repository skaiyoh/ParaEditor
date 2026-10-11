import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureCommitted, createAuthoring, type CommandResult, type GestureValue, type OperationTarget } from '../src/session/authoring.ts';
import { EMPTY_HISTORY, recordEdit, undo, redo, type History } from '../src/core/history.ts';
import { applyEdits } from '../src/core/reduce.ts';
import { applyProduce } from '../src/core/produce.ts';
import type { Edit } from '../src/core/edits.ts';
import type { SceneDocument } from '../src/core/types.ts';
import { fiveClusterDocument, OBJECT_IDS } from './fixtures/documents.ts';
import { depthProduct } from './fixtures/products.ts';

const sceneTarget = { kind: 'scene' } satisfies OperationTarget;
const layerTarget = { kind: 'layer', id: OBJECT_IDS[0] } satisfies OperationTarget;

function rig() {
  let doc: SceneDocument | null = fiveClusterDocument();
  let history: History = EMPTY_HISTORY;
  let at = 0, saves = 0, notifications = 0;
  const record = (edit: Edit): CommandResult => {
    authoring.cancel();
    assert.ok(doc);
    const result = recordEdit({ doc, history, edit, at, now: new Date(Date.UTC(2026, 9, 11, 0, 0, 0, at)).toISOString() });
    if (result.kind === 'refused') return { kind: 'refused', reason: result.detail };
    if (result.kind === 'applied') { doc = result.doc; history = result.history; saves++; authoring.reconcile(doc, authoring.snapshot().activeLayer); }
    return { kind: result.kind };
  };
  const authoring = createAuthoring({ read: () => doc, record, changed: () => { notifications++; } });
  return {
    authoring, record,
    doc: () => { assert.ok(doc); return doc; }, history: () => history,
    saves: () => saves, notifications: () => notifications,
    advance(ms: number) { at += ms; },
    install(next: SceneDocument | null) { authoring.reset(); doc = next; history = EMPTY_HISTORY; },
    arrive() {
      assert.ok(doc);
      const result = applyProduce(doc, { kind: 'depth', depth: depthProduct(3) }, '2026-10-11T00:00:30.000Z');
      assert.equal(result.kind, 'applied'); doc = result.doc;
      authoring.reconcile(doc, authoring.snapshot().activeLayer);
    },
    step(direction: 'undo' | 'redo') {
      authoring.cancel(); assert.ok(doc);
      const step = direction === 'undo' ? undo(history) : redo(history);
      assert.ok(step);
      // This harness records only document edits; a selection step here would be a defect.
      assert.equal(step.kind, 'document');
      if (step.kind !== 'document') return;
      const result = applyEdits(doc, step.edits, '2026-10-11T00:01:00.000Z');
      assert.notEqual(result.kind, 'refused'); doc = result.doc; history = step.history;
    },
  };
}

test('C1 capability matrix is explicit, defaults to Edited, and transient controls never record/save', () => {
  const r = rig(), a = r.authoring, before = r.doc();
  assert.equal(a.snapshot().sampleMode, 'edited');
  assert.equal(a.snapshot().compare, 'edited');
  for (const operation of ['style', 'fry', 'surface', 'motion', 'symbols']) {
    assert.equal(a.capability({ operation, target: sceneTarget }).kind, 'available');
    for (const target of [layerTarget, { kind: 'background' }, { kind: 'selection' }] satisfies OperationTarget[]) {
      assert.deepEqual(a.capability({ operation, target }), { kind: 'unavailable', reason: 'This effect is Scene-only.' });
    }
  }
  assert.equal(a.capability({ operation: 'color', target: layerTarget }).kind, 'available');
  for (const target of [sceneTarget, { kind: 'background' }, { kind: 'selection' }] satisfies OperationTarget[]) {
    assert.equal(a.capability({ operation: 'color', target }).kind, 'unavailable');
    assert.equal(a.setColor({ target, color: { l: .5, c: .2, h: 30 } }).kind, 'refused');
    assert.equal(a.beginGesture({ operation: 'color', target }), null);
  }
  a.setSampleMode('source'); assert.equal(a.snapshot().sampleMode, 'source'); a.setSampleMode('edited');
  a.setCompare('source-photo'); a.setCompare('treatments-off'); a.setCompare('edited');
  a.setTool('sample'); a.setTarget(layerTarget);
  a.reconcile(before, OBJECT_IDS[1]);
  assert.deepEqual(a.snapshot().target, layerTarget, 'active layer does not rewrite operation target');
  assert.equal(a.setTarget({ kind: 'selection' }).kind, 'refused');
  assert.equal(r.doc(), before); assert.equal(r.history(), EMPTY_HISTORY); assert.equal(r.saves(), 0);
  r.install(null);
  assert.equal(a.capability({ operation: 'style', target: sceneTarget }).kind, 'unavailable');
  assert.equal(a.beginGesture({ operation: 'style', target: sceneTarget }), null);
});

test('each parameter/color gesture is one action regardless of duration; two fast gestures stay separate', () => {
  const values: readonly GestureValue[] = [
    { kind: 'style', patch: { saturation: .2 } }, { kind: 'fry', fry: .9 },
    { kind: 'surface', patch: { enabled: true, relief: .6 } },
    { kind: 'motion', patch: { enabled: true, parallax: .7 } },
    { kind: 'symbols', patch: { enabled: true, amount: .9 } },
    { kind: 'color', color: { l: .42, c: .13, h: 123 } },
  ];
  for (const value of values) {
    const r = rig(), a = r.authoring, before = r.doc();
    const target = value.kind === 'color' ? layerTarget : sceneTarget;
    const token = a.beginGesture({ operation: value.kind, target }); assert.ok(token);
    for (let i = 0; i < 20; i++) {
      r.advance(1000); assert.equal(a.updateGesture({ token, value }).kind, 'applied');
      assert.equal(r.doc(), before); assert.equal(r.saves(), 0); assert.equal(r.history(), EMPTY_HISTORY);
      assert.equal(a.previewDocument(before).updatedAt, before.updatedAt);
    }
    assert.equal(a.commitGesture(token).kind, 'applied');
    assert.equal(r.history().undo.length, 1); assert.equal(r.history().undo[0]?.key, null); assert.equal(r.saves(), 1);
    assert.equal(a.commitGesture(token).kind, 'cancelled');
    const after = r.doc(); r.step('undo');
    assert.deepEqual({ ...r.doc(), updatedAt: before.updatedAt }, before);
    r.step('redo'); assert.deepEqual({ ...r.doc(), updatedAt: after.updatedAt }, after);
  }
  const r = rig(), a = r.authoring;
  for (const saturation of [.1, .2]) {
    const token = a.beginGesture({ operation: 'style', target: sceneTarget }); assert.ok(token);
    a.updateGesture({ token, value: { kind: 'style', patch: { saturation } } });
    a.commitGesture(token); r.advance(100);
  }
  assert.equal(r.history().undo.length, 2);
  r.step('undo'); assert.equal(r.doc().style.saturation, .1);
});

test('cancel, no update, returned-to-start, invalid input and stale tokens preserve timestamp, redo and autosave', () => {
  const r = rig(), a = r.authoring;
  r.record({ kind: 'symbols', patch: { amount: .123 } }); r.step('undo');
  const before = r.doc(), history = r.history(), saves = r.saves();
  for (const ending of ['cancel', 'empty', 'returned', 'invalid']) {
    const token = a.beginGesture({ operation: 'style', target: sceneTarget }); assert.ok(token);
    if (ending === 'invalid') assert.equal(a.updateGesture({ token, value: { kind: 'style', patch: { saturation: NaN } } }).kind, 'refused');
    if (ending === 'cancel' || ending === 'returned') a.updateGesture({ token, value: { kind: 'style', patch: { saturation: .123 } } });
    if (ending === 'returned') a.updateGesture({ token, value: { kind: 'style', patch: { saturation: before.style.saturation } } });
    if (ending === 'cancel') a.cancelGesture(token); else assert.equal(a.commitGesture(token).kind, 'unchanged');
    assert.equal(a.commitGesture(token).kind, 'cancelled');
    assert.equal(a.updateGesture({ token, value: { kind: 'fry', fry: .5 } }).kind, 'cancelled');
    assert.equal(r.doc(), before); assert.equal(r.history(), history); assert.equal(r.saves(), saves);
  }
});

test('analysis arrival survives preview, commit, undo and redo without an old-document overwrite', () => {
  const r = rig(), a = r.authoring;
  const token = a.beginGesture({ operation: 'color', target: layerTarget }); assert.ok(token);
  a.updateGesture({ token, value: { kind: 'color', color: { l: .61, c: .11, h: 24 } } });
  r.arrive();
  assert.deepEqual(a.previewDocument(r.doc()).analysis.depth, depthProduct(3));
  assert.equal(a.commitGesture(token).kind, 'applied');
  r.step('undo'); assert.deepEqual(r.doc().analysis.depth, depthProduct(3));
  r.step('redo'); assert.deepEqual(r.doc().analysis.depth, depthProduct(3));
});

test('owner/tool/target/comparison changes, deletion, import/reset, undo and superseding edits cancel previews', () => {
  for (const event of ['owner', 'tool', 'target', 'compare', 'delete', 'reset', 'undo', 'edit']) {
    const r = rig(), a = r.authoring;
    r.record({ kind: 'symbols', patch: { amount: .123 } });
    a.setTarget(layerTarget);
    const token = a.beginGesture({ operation: 'color', target: layerTarget }); assert.ok(token);
    a.updateGesture({ token, value: { kind: 'color', color: { l: .3, c: .1, h: 15 } } });
    const saves = r.saves();
    switch (event) {
      case 'owner': a.reconcile(r.doc(), OBJECT_IDS[1]); break;
      case 'tool': a.setTool('sample'); break;
      case 'target': a.setTarget(sceneTarget); break;
      case 'compare': a.setCompare('source-photo'); break;
      case 'delete': r.record({ kind: 'object.remove', id: layerTarget.id }); assert.deepEqual(a.snapshot().target, sceneTarget); break;
      case 'reset': r.install(fiveClusterDocument()); break;
      case 'undo': r.step('undo'); break;
      case 'edit': r.record({ kind: 'style', patch: { grain: .9 } }); break;
    }
    assert.equal(a.commitGesture(token).kind, 'cancelled', event);
    assert.equal(a.previewDocument(r.doc()), r.doc(), event);
    assert.equal(r.saves(), saves + (event === 'edit' || event === 'delete' ? 1 : 0), event);
  }
});

test('gesture identity rejects old callbacks and mismatched operations; caller mutation cannot change preview', () => {
  const r = rig(), a = r.authoring;
  const old = a.beginGesture({ operation: 'fry', target: sceneTarget }); assert.ok(old);
  const token = a.beginGesture({ operation: 'style', target: sceneTarget }); assert.ok(token);
  a.cancelGesture(old); assert.equal(a.commitGesture(old).kind, 'cancelled');
  assert.equal(a.updateGesture({ token, value: { kind: 'fry', fry: .5 } }).kind, 'refused');
  const patch = { saturation: .2 };
  a.updateGesture({ token, value: { kind: 'style', patch } }); patch.saturation = .8;
  assert.equal(a.previewDocument(r.doc()).style.saturation, .2);
  assert.equal(a.commitGesture(token).kind, 'applied'); assert.equal(r.doc().style.saturation, .2);
});

test('output captures committed state and restores a live preview on success and synchronous/asynchronous failure', async () => {
  const r = rig(), a = r.authoring, committed = r.doc();
  const token = a.beginGesture({ operation: 'color', target: layerTarget }); assert.ok(token);
  a.updateGesture({ token, value: { kind: 'color', color: { l: .3, c: .1, h: 15 } } });
  const preview = a.previewDocument(committed);
  let rendered = preview;
  const render = (doc: SceneDocument): void => { rendered = doc; };
  const restore = (): void => { rendered = preview; };
  const output = captureCommitted({ document: committed, render, restore,
    capture: () => Promise.resolve(rendered) });
  assert.equal(rendered, preview); assert.equal(await output, committed);
  assert.throws(() => captureCommitted({ document: committed, render, restore, capture: () => { throw new Error('capture failed'); } }), /capture failed/);
  assert.equal(rendered, preview);
  await assert.rejects(captureCommitted({ document: committed, render, restore, capture: () => Promise.reject(new Error('encoding failed')) }), /encoding failed/);
  assert.equal(rendered, preview); assert.equal(r.history(), EMPTY_HISTORY); assert.equal(r.saves(), 0);
  a.cancelGesture(token); assert.equal(r.doc(), committed);
});
