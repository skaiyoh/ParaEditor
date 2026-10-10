// The Fry curve: its two ends, its default position, which the default style
// stores, and the fry edit, which writes absolute values and whose inverse is
// one style patch.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultStyle } from '../src/core/defaults.ts';
import { FRIED_FIELDS, fryCurve } from '../src/core/fry.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { Style } from '../src/core/types.ts';
import { fiveClusterDocument, minimalDocument } from './fixtures/documents.ts';

const NOW = '2026-10-02T18:00:00.000Z';

function fried(style: Style): Pick<Style, (typeof FRIED_FIELDS)[number]> {
  const { colors, saturation, simplify, bands, grain, colorNoise, crunch, clipping } = style;
  return { colors, saturation, simplify, bands, grain, colorNoise, crunch, clipping };
}

test('fryCurve at 0 and at 1 gives the two ends of the curve', () => {
  assert.deepEqual(fryCurve(0), { colors: 12, saturation: 0.2, simplify: 0.1, bands: 6, grain: 0.1, colorNoise: 0.05, crunch: 0, clipping: 0 });
  assert.deepEqual(fryCurve(1), { colors: 4, saturation: 0.9, simplify: 0.8, bands: 3, grain: 0.8, colorNoise: 0.5, crunch: 0.7, clipping: 0.5 });
});

test('fryCurve at 0.6 gives the default row, and the default style stores exactly it', () => {
  const row = { colors: 7, saturation: 0.62, simplify: 0.52, bands: 4, grain: 0.52, colorNoise: 0.32, crunch: 0.42, clipping: 0.3 };
  assert.deepEqual(fryCurve(0.6), row);
  const style = defaultStyle();
  assert.equal(style.fry, 0.6);
  assert.deepEqual(fried(style), fryCurve(style.fry));
});

test('fryCurve is linear between its ends, with colors and bands rounded to whole numbers', () => {
  for (let i = 0; i <= 100; i++) {
    const f = i / 100;
    const curve = fryCurve(f);
    assert.equal(curve.colors, Math.round(12 - 8 * f), `colors at ${f}`);
    assert.equal(curve.bands, Math.round(6 - 3 * f), `bands at ${f}`);
    for (const [field, from, to] of [
      ['saturation', 0.2, 0.9],
      ['simplify', 0.1, 0.8],
      ['grain', 0.1, 0.8],
      ['colorNoise', 0.05, 0.5],
      ['crunch', 0, 0.7],
      ['clipping', 0, 0.5],
    ] as const) {
      assert.ok(Math.abs(curve[field] - (from + (to - from) * f)) <= 5e-7, `${field} at ${f}: ${curve[field]}`);
    }
  }
  assert.deepEqual(fryCurve(-1), fryCurve(0));
  assert.deepEqual(fryCurve(2), fryCurve(1));
});

test('a fry edit writes the curve as absolute values and stores fry, and its inverse is one style patch of the nine previous values', () => {
  const before = fiveClusterDocument();
  const result = applyEdit(before, { kind: 'fry', fry: 0.25 }, NOW);
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.doc.style.fry, 0.25);
  assert.deepEqual(fried(result.doc.style), fryCurve(0.25));
  assert.equal(result.doc.style.harmony, before.style.harmony);
  assert.equal(result.doc.style.outline, before.style.outline);
  assert.ok(parseDocument(result.doc).ok);
  assert.equal(result.inverse.length, 1);
  const [inverse] = result.inverse;
  assert.equal(inverse.kind, 'style');
  assert.deepEqual(inverse.kind === 'style' ? inverse.patch : null, { fry: before.style.fry, ...fried(before.style) });
  const back = applyEdits(result.doc, result.inverse, NOW);
  assert.deepEqual(back.doc, { ...before, updatedAt: NOW });
});

test('a style patch carrying fry alone stores it and changes no fried field', () => {
  const before = minimalDocument();
  const result = applyEdit(before, { kind: 'style', patch: { fry: 0.9 } }, NOW);
  assert.equal(result.doc.style.fry, 0.9);
  assert.deepEqual(fried(result.doc.style), fried(before.style));
});
