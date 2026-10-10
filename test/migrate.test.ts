import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument } from '../src/core/schema.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { minimalDocument } from './fixtures/documents.ts';

test('legacy orbit migrates to Circle at its exact amount through every old version', () => {
  const current = minimalDocument();
  for (const version of [0, 1, 2, 3]) for (const amount of [0, .17, .6, 1]) {
    const { drift: _drift, parallax, ...motion } = current.motion;
    const { surface, ...rest } = current;
    const old = { ...rest, version, ...(version > 0 ? { surface } : {}),
      motion: { ...motion, ...(version > 1 ? { parallax } : {}), orbit: amount } };
    const before = structuredClone(old);
    const parsed = parseDocument(old);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.motion.drift, { direction: 'circle', amount });
    assert.equal('orbit' in parsed.value.motion, false);
    assert.deepEqual(old, before);
    assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(parsed.value))), parsed);
  }
});

test('malformed legacy or current drift is refused, never silently defaulted', () => {
  const current = minimalDocument();
  const { drift: _drift, ...motion } = current.motion;
  for (const orbit of [-.01, 1.01, NaN, Infinity, '0.6', null, undefined]) {
    const parsed = parseDocument({ ...current, version: 3, motion: { ...motion, orbit } });
    assert.ok(!parsed.ok && parsed.error.kind === 'invalid', JSON.stringify(parsed));
  }
  for (const drift of [null, {}, { direction: 'diagonal', amount: .6 }, { direction: 'side', amount: 2 }]) {
    const parsed = parseDocument({ ...current, motion: { ...motion, drift } });
    assert.ok(!parsed.ok && parsed.error.kind === 'invalid', JSON.stringify(parsed));
  }
});

test('Drift edits clamp amount and undo both direction and amount', () => {
  const doc = minimalDocument();
  const changed = applyEdit(doc, { kind: 'motion', patch: { drift: { direction: 'vertical', amount: 2 } } }, doc.updatedAt);
  assert.equal(changed.kind, 'applied');
  if (changed.kind !== 'applied') return;
  assert.deepEqual(changed.doc.motion.drift, { direction: 'vertical', amount: 1 });
  const undone = applyEdits(changed.doc, changed.inverse, doc.updatedAt);
  assert.equal(undone.kind, 'applied');
  assert.deepEqual(undone.doc, doc);
});
