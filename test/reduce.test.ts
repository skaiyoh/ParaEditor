// The reducer: every fixture edit gives its outcome, an applied edit's inverse
// list restores the document but `updatedAt`, an edit that sets every field
// to the value it holds is unchanged, a refused edit changes nothing,
// every number an edit sets is clamped through the ranges table, side effects
// carry trailing inverse edits, and no edit writes to its input or touches
// analysis.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Edit, EditKind, EditResult, RefusalReason, StylePatch } from '../src/core/edits.ts';
import { RANGES, type ClampPath } from '../src/core/ranges.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { SceneDocument, Style } from '../src/core/types.ts';
import { fiveClusterDocument, LIGHT_IDS, minimalDocument, OBJECT_IDS } from './fixtures/documents.ts';
import { editCases, minimalWithObject, newLightAt, objectId, tappedObject, withLights, withObjects } from './fixtures/edits.ts';

const NOW = '2026-10-02T18:00:00.000Z';
const LATER = '2026-10-02T18:00:05.000Z';

/** The document an edit leaves, applied or unchanged; a refusal fails the test. */
function kept(result: EditResult): SceneDocument {
  assert.notEqual(result.kind, 'refused', result.kind === 'refused' ? `${result.reason}: ${result.detail}` : '');
  return result.doc;
}

function applied(result: EditResult): Extract<EditResult, { kind: 'applied' }> {
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? `${result.reason}: ${result.detail}` : '');
  if (result.kind !== 'applied') throw new Error('unreachable');
  return result;
}

function withUpdatedAt(doc: SceneDocument, updatedAt: string): SceneDocument {
  return { ...doc, updatedAt };
}

function assertValid(doc: SceneDocument, label: string): void {
  const parsed = parseDocument(doc);
  assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
}

/** Freezes every object and array reachable from `value`, so a write to it throws in strict code. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// the fixture edits

/** Every edit kind and every refusal reason; `satisfies` fails the type check when either union gains a member this list lacks. */
const EDIT_KINDS = Object.keys({
  title: true, style: true, fry: true, symbols: true, surface: true, motion: true, lighting: true, 'palette.target': true,
  'object.add': true, 'object.set': true, 'object.rename': true, 'object.hide': true, 'object.show': true, 'object.refine': true, 'object.remove': true, 'light.add': true, 'light.set': true, 'light.remove': true,
} satisfies Record<EditKind, true>);
const REASONS = Object.keys({
  invalid: true, 'unknown-key': true, 'non-finite': true, 'unknown-id': true, 'duplicate-id': true, limit: true, 'out-of-range': true,
} satisfies Record<RefusalReason, true>);

test('the fixture edits hold every edit kind applied, an unchanged edit, and every refusal reason', () => {
  const cases = editCases();
  assert.deepEqual(new Set(cases.filter((c) => c.outcome === 'applied').map((c) => c.edit.kind)), new Set(EDIT_KINDS));
  assert.ok(cases.some((c) => c.outcome === 'unchanged'));
  assert.deepEqual(new Set(cases.map((c) => c.outcome).filter((o) => o !== 'applied' && o !== 'unchanged')), new Set(REASONS));
});

test('every fixture edit gives its outcome, and the result parses', () => {
  for (const { name, doc, edit, outcome } of editCases()) {
    const before = doc();
    const result = applyEdit(before, edit, NOW);
    assert.equal(result.kind === 'refused' ? result.reason : result.kind, outcome, `${name}: ${result.kind === 'refused' ? result.detail : ''}`);
    assertValid(result.doc, name);
  }
});

test('an applied fixture edit stamps updatedAt, and its inverse list restores the document but updatedAt', () => {
  for (const { name, doc, edit, outcome } of editCases()) {
    if (outcome !== 'applied') continue;
    const before = doc();
    const forward = applied(applyEdit(before, edit, NOW));
    assert.equal(forward.doc.updatedAt, NOW, name);
    const back = applied(applyEdits(forward.doc, forward.inverse, LATER));
    assert.equal(back.doc.updatedAt, LATER, name);
    assert.deepEqual(withUpdatedAt(back.doc, before.updatedAt), before, name);
    // Redo: the inverse of the inverse brings the edit's result back.
    const again = applied(applyEdits(back.doc, back.inverse, LATER));
    assert.deepEqual(withUpdatedAt(again.doc, NOW), forward.doc, `${name}, redone`);
  }
});

test('a refused or unchanged fixture edit returns the input document itself, unstamped', () => {
  for (const { name, doc, edit, outcome } of editCases()) {
    if (outcome === 'applied') continue;
    const before = doc();
    const result = applyEdit(before, edit, NOW);
    assert.equal(result.doc, before, name);
    assert.deepEqual(result.doc, doc(), name);
    if (outcome === 'unchanged') assert.equal(result.kind, 'unchanged', name);
    else assert.ok(result.kind === 'refused' && result.detail.length > 0, name);
  }
});

test('no fixture edit writes to its input document', () => {
  for (const { name, doc, edit } of editCases()) {
    const before = deepFreeze(doc());
    assert.doesNotThrow(() => applyEdit(before, edit, NOW), name);
    assert.deepEqual(before, doc(), name);
  }
});

test('no edit changes an analysis field, and only object.refine changes a produced field', () => {
  for (const { name, doc, edit, outcome } of editCases()) {
    if (outcome !== 'applied') continue;
    const before = doc();
    const after = applied(applyEdit(before, edit, NOW)).doc;
    assert.deepEqual(after.analysis, before.analysis, name);
    for (const object of after.objects) {
      const was = before.objects.find((o) => o.id === object.id);
      if (was === undefined) continue;
      if (edit.kind === 'object.refine' && edit.id === object.id) assert.notDeepEqual(object.produced, was.produced, name);
      else assert.deepEqual(object.produced, was.produced, name);
    }
  }
});

test('applyEdits applies a list in order as one step, and refuses the whole list when one edit is refused', () => {
  const before = fiveClusterDocument();
  const edits: readonly [Edit, ...Edit[]] = [
    { kind: 'style', patch: { saturation: 0.1 } },
    { kind: 'style', patch: { saturation: 0.3 } },
    { kind: 'object.remove', id: OBJECT_IDS[1] },
  ];
  const forward = applied(applyEdits(before, edits, NOW));
  assert.equal(forward.doc.style.saturation, 0.3);
  assert.equal(forward.doc.objects.length, 1);
  assert.deepEqual(forward.inverse, [
    { kind: 'object.add', object: before.objects[1], restore: { index: 1 } },
    { kind: 'style', patch: { saturation: 0.1 } },
    { kind: 'style', patch: { saturation: before.style.saturation } },
  ]);
  const back = applied(applyEdits(forward.doc, forward.inverse, LATER));
  assert.deepEqual(withUpdatedAt(back.doc, before.updatedAt), before);

  const refused = applyEdits(before, [{ kind: 'style', patch: { saturation: 0.1 } }, { kind: 'object.remove', id: objectId(7) }], NOW);
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.doc, before);
  assert.match(refused.kind === 'refused' ? refused.detail : '', /^edit 1: /);
});

// ---------------------------------------------------------------------------
// clamping

/** How an edit sets each number it can set, and where the result is read back. */
type Setter = { readonly doc: () => SceneDocument; readonly edit: (value: number) => Edit; readonly read: (doc: SceneDocument) => unknown };

const [SUBJECT, BOX] = OBJECT_IDS;
const [KEY_LIGHT] = LIGHT_IDS;

function styleSetter(patch: (value: number) => StylePatch, read: (style: Style) => number): Setter {
  return { doc: fiveClusterDocument, edit: (value) => ({ kind: 'style', patch: patch(value) }), read: (doc) => read(doc.style) };
}

const SETTERS: Readonly<Partial<Record<ClampPath, Setter>>> = {
  'style.fry': styleSetter((fry) => ({ fry }), (style) => style.fry),
  'style.colors': styleSetter((colors) => ({ colors }), (style) => style.colors),
  'style.saturation': styleSetter((saturation) => ({ saturation }), (style) => style.saturation),
  'style.bands': styleSetter((bands) => ({ bands }), (style) => style.bands),
  'style.simplify': styleSetter((simplify) => ({ simplify }), (style) => style.simplify),
  'style.outline': styleSetter((outline) => ({ outline }), (style) => style.outline),
  'style.subjectClarity': styleSetter((subjectClarity) => ({ subjectClarity }), (style) => style.subjectClarity),
  'style.grain': styleSetter((grain) => ({ grain }), (style) => style.grain),
  'style.colorNoise': styleSetter((colorNoise) => ({ colorNoise }), (style) => style.colorNoise),
  'style.grainSize': styleSetter((grainSize) => ({ grainSize }), (style) => style.grainSize),
  'style.grainHold': styleSetter((grainHold) => ({ grainHold }), (style) => style.grainHold),
  'style.crunch': styleSetter((crunch) => ({ crunch }), (style) => style.crunch),
  'style.clipping': styleSetter((clipping) => ({ clipping }), (style) => style.clipping),
  'style.harmony.strength': {
    doc: fiveClusterDocument,
    edit: (strength) => ({ kind: 'style', patch: { harmony: { kind: 'analogous', strength } } }),
    read: (doc) => (doc.style.harmony.kind === 'off' ? undefined : doc.style.harmony.strength),
  },
  'style.paletteTargets[].color.l': {
    doc: fiveClusterDocument,
    edit: (l) => ({ kind: 'palette.target', cluster: 2, color: { l, c: 0.1, h: 10 } }),
    read: (doc) => doc.style.paletteTargets.find((t) => t.cluster === 2)?.color.l,
  },
  'style.paletteTargets[].color.c': {
    doc: fiveClusterDocument,
    edit: (c) => ({ kind: 'palette.target', cluster: 2, color: { l: 0.5, c, h: 10 } }),
    read: (doc) => doc.style.paletteTargets.find((t) => t.cluster === 2)?.color.c,
  },
  'style.paletteTargets[].color.h': {
    doc: fiveClusterDocument,
    edit: (h) => ({ kind: 'palette.target', cluster: 2, color: { l: 0.5, c: 0.1, h } }),
    read: (doc) => doc.style.paletteTargets.find((t) => t.cluster === 2)?.color.h,
  },
  'symbols.cellSize': { doc: fiveClusterDocument, edit: (cellSize) => ({ kind: 'symbols', patch: { cellSize } }), read: (doc) => doc.symbols.cellSize },
  'symbols.amount': { doc: fiveClusterDocument, edit: (amount) => ({ kind: 'symbols', patch: { amount } }), read: (doc) => doc.symbols.amount },
  'surface.relief': { doc: fiveClusterDocument, edit: (relief) => ({ kind: 'surface', patch: { relief } }), read: (doc) => doc.surface.relief },
  'surface.refraction': { doc: fiveClusterDocument, edit: (refraction) => ({ kind: 'surface', patch: { refraction } }), read: (doc) => doc.surface.refraction },
  'surface.shine': { doc: fiveClusterDocument, edit: (shine) => ({ kind: 'surface', patch: { shine } }), read: (doc) => doc.surface.shine },
  'surface.scale': { doc: fiveClusterDocument, edit: (scale) => ({ kind: 'surface', patch: { scale } }), read: (doc) => doc.surface.scale },
  'motion.orbit': { doc: fiveClusterDocument, edit: (orbit) => ({ kind: 'motion', patch: { orbit } }), read: (doc) => doc.motion.orbit },
  'motion.loopSeconds': { doc: fiveClusterDocument, edit: (loopSeconds) => ({ kind: 'motion', patch: { loopSeconds } }), read: (doc) => doc.motion.loopSeconds },
  'motion.parallax': { doc: fiveClusterDocument, edit: (parallax) => ({ kind: 'motion', patch: { parallax } }), read: (doc) => doc.motion.parallax },
  'motion.focus': { doc: minimalDocument, edit: (focus) => ({ kind: 'motion', patch: { focus } }), read: (doc) => doc.motion.focus },
  'lighting.ambient': { doc: fiveClusterDocument, edit: (ambient) => ({ kind: 'lighting', patch: { ambient } }), read: (doc) => doc.lighting.ambient },
  'lighting.relief': { doc: fiveClusterDocument, edit: (relief) => ({ kind: 'lighting', patch: { relief } }), read: (doc) => doc.lighting.relief },
  'objects[].recolor.color.l': {
    doc: fiveClusterDocument,
    edit: (l) => ({ kind: 'object.set', id: BOX, patch: { recolor: { kind: 'target', color: { l, c: 0.1, h: 10 } } } }),
    read: (doc) => recolorOf(doc)?.l,
  },
  'objects[].recolor.color.c': {
    doc: fiveClusterDocument,
    edit: (c) => ({ kind: 'object.set', id: BOX, patch: { recolor: { kind: 'target', color: { l: 0.5, c, h: 10 } } } }),
    read: (doc) => recolorOf(doc)?.c,
  },
  'objects[].recolor.color.h': {
    doc: fiveClusterDocument,
    edit: (h) => ({ kind: 'object.set', id: BOX, patch: { recolor: { kind: 'target', color: { l: 0.5, c: 0.1, h } } } }),
    read: (doc) => recolorOf(doc)?.h,
  },
  'objects[].motion.amount': {
    doc: fiveClusterDocument,
    edit: (amount) => ({ kind: 'object.set', id: SUBJECT, patch: { motion: { kind: 'bob', amount } } }),
    read: (doc) => {
      const motion = doc.objects[0]?.motion;
      return motion === undefined || motion.kind === 'none' ? undefined : motion.amount;
    },
  },
  'objects[].thickness': { doc: fiveClusterDocument, edit: (thickness) => ({ kind: 'object.set', id: SUBJECT, patch: { thickness } }), read: (doc) => doc.objects[0]?.thickness },
  'lights[].at.x': { doc: fiveClusterDocument, edit: (x) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { at: { x, y: 0.5 } } }), read: (doc) => doc.lights[0]?.at.x },
  'lights[].at.y': { doc: fiveClusterDocument, edit: (y) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { at: { x: 0.5, y } } }), read: (doc) => doc.lights[0]?.at.y },
  'lights[].depth': { doc: fiveClusterDocument, edit: (depth) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { depth } }), read: (doc) => doc.lights[0]?.depth },
  'lights[].color.l': {
    doc: fiveClusterDocument,
    edit: (l) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { color: { l, c: 0.1, h: 10 } } }),
    read: (doc) => doc.lights[0]?.color.l,
  },
  'lights[].color.c': {
    doc: fiveClusterDocument,
    edit: (c) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { color: { l: 0.5, c, h: 10 } } }),
    read: (doc) => doc.lights[0]?.color.c,
  },
  'lights[].color.h': {
    doc: fiveClusterDocument,
    edit: (h) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { color: { l: 0.5, c: 0.1, h } } }),
    read: (doc) => doc.lights[0]?.color.h,
  },
  'lights[].intensity': { doc: fiveClusterDocument, edit: (intensity) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { intensity } }), read: (doc) => doc.lights[0]?.intensity },
  'lights[].radius': { doc: fiveClusterDocument, edit: (radius) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { radius } }), read: (doc) => doc.lights[0]?.radius },
  'lights[].rays': { doc: fiveClusterDocument, edit: (rays) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { rays } }), read: (doc) => doc.lights[0]?.rays },
  'lights[].softness': { doc: fiveClusterDocument, edit: (softness) => ({ kind: 'light.set', id: KEY_LIGHT, patch: { softness } }), read: (doc) => doc.lights[0]?.softness },
};

function recolorOf(doc: SceneDocument): { readonly l: number; readonly c: number; readonly h: number } | undefined {
  const recolor = doc.objects[1]?.recolor;
  return recolor === undefined || recolor.kind === 'none' ? undefined : recolor.color;
}

/**
 * The RANGES paths no edit sets: analysis's measurements, the frame, the
 * seed, what analysis produced for an object (which object.refine replaces
 * whole and never clamps), and a palette target's cluster, which is refused
 * out of range rather than clamped.
 */
function editable(path: string): boolean {
  return !/^(analysis\.|frame\.|seed$|objects\[\]\.produced\.)/.test(path) && path !== 'style.paletteTargets[].cluster';
}

test('the clamp table covers every RANGES path an edit sets', () => {
  assert.deepEqual(Object.keys(SETTERS).sort(), Object.keys(RANGES).filter(editable).sort());
});

test('every number an edit sets clamps at both ends of its RANGES entry', () => {
  for (const [path, setter] of Object.entries(SETTERS)) {
    if (setter === undefined) continue;
    const range = Object.entries(RANGES).find(([key]) => key === path)?.[1];
    assert.ok(range !== undefined, path);
    const span = range.max - range.min;
    for (const [value, expected] of [
      [range.max + span + 0.3, range.max],
      [range.min - span - 0.3, range.min],
      [range.max, range.max],
      [range.min, range.min],
    ] as const) {
      const doc = kept(applyEdit(setter.doc(), setter.edit(value), NOW));
      assert.equal(setter.read(doc), expected, `${path} set to ${value}`);
      assertValid(doc, `${path} set to ${value}`);
    }
  }
});

test('colors, bands, grainSize, and grainHold round to whole numbers, and cellSize to an even one', () => {
  const style = (patch: Edit & { kind: 'style' }): SceneDocument['style'] => kept(applyEdit(fiveClusterDocument(), patch, NOW)).style;
  assert.equal(style({ kind: 'style', patch: { colors: 7.4 } }).colors, 7);
  assert.equal(style({ kind: 'style', patch: { colors: 7.6 } }).colors, 8);
  assert.equal(style({ kind: 'style', patch: { bands: 2.5 } }).bands, 3);
  assert.equal(style({ kind: 'style', patch: { grainSize: 3.49 } }).grainSize, 3);
  assert.equal(style({ kind: 'style', patch: { grainHold: 1.51 } }).grainHold, 2);
  const cellSize = (value: number): number => kept(applyEdit(fiveClusterDocument(), { kind: 'symbols', patch: { cellSize: value } }, NOW)).symbols.cellSize;
  assert.equal(cellSize(13), 14);
  assert.equal(cellSize(12.9), 12);
  assert.equal(cellSize(15.2), 16);
  assert.equal(cellSize(7), 8);
  assert.equal(cellSize(5), 6);
  assert.equal(cellSize(49), 48);
});

test('a light may sit at -0.5 and 1.5 of the frame and no further, and its chroma clamps at 0.25', () => {
  const at = (x: number, y: number) => applied(applyEdit(fiveClusterDocument(), { kind: 'light.set', id: KEY_LIGHT, patch: { at: { x, y } } }, NOW)).doc.lights[0]?.at;
  assert.deepEqual(at(-0.5, 1.5), { x: -0.5, y: 1.5 });
  assert.deepEqual(at(-0.6, 1.6), { x: -0.5, y: 1.5 });
  const chroma = applied(applyEdit(fiveClusterDocument(), { kind: 'light.set', id: KEY_LIGHT, patch: { color: { l: 0.5, c: 0.3, h: 0 } } }, NOW));
  assert.equal(chroma.doc.lights[0]?.color.c, 0.25);
  const added = applied(applyEdit(minimalDocument(), { kind: 'light.add', light: { ...newLightAt(LIGHT_IDS[1], 2, -1), color: { l: 1, c: 1, h: 0 } } }, NOW));
  assert.deepEqual(added.doc.lights[0]?.at, { x: 1.5, y: -0.5 });
  assert.equal(added.doc.lights[0]?.color.c, 0.25);
});

test('NaN and the infinities are refused as non-finite wherever the reducer clamps a number, and as invalid inside produced', () => {
  for (const [path, setter] of Object.entries(SETTERS)) {
    if (setter === undefined) continue;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const doc = setter.doc();
      const result = applyEdit(doc, setter.edit(value), NOW);
      assert.equal(result.kind === 'refused' ? result.reason : result.kind, 'non-finite', `${path} set to ${value}`);
      assert.equal(result.doc, doc);
    }
  }
  const restored = applyEdit(fiveClusterDocument(), { kind: 'object.add', object: tappedObject(objectId(0)), restore: { index: Number.NaN } }, NOW);
  assert.equal(restored.kind === 'refused' ? restored.reason : restored.kind, 'non-finite');
  const cluster = applyEdit(fiveClusterDocument(), { kind: 'palette.target', cluster: Number.NaN, color: null }, NOW);
  assert.equal(cluster.kind === 'refused' ? cluster.reason : cluster.kind, 'non-finite');
  // What analysis produced is not clamped: the schema refuses a NaN in it.
  const [subject] = fiveClusterDocument().objects;
  assert.ok(subject !== undefined);
  const produced = { ...subject.produced, bounds: { ...subject.produced.bounds, x: Number.NaN } };
  for (const edit of [
    { kind: 'object.refine', id: subject.id, produced },
    { kind: 'object.add', object: { ...tappedObject(objectId(0)), produced } },
  ] satisfies Edit[]) {
    const doc = fiveClusterDocument();
    const result = applyEdit(doc, edit, NOW);
    assert.equal(result.kind === 'refused' ? result.reason : result.kind, 'invalid', edit.kind);
    assert.equal(result.doc, doc);
  }
});

test('a 33rd object and a 5th light are refused, and the 32nd and the 4th are kept', () => {
  const object = tappedObject(objectId(99));
  assert.equal(applied(applyEdit(withObjects(31), { kind: 'object.add', object }, NOW)).doc.objects.length, 32);
  const full = withObjects(32);
  assert.equal(applyEdit(full, { kind: 'object.add', object }, NOW).doc, full);
  const light = newLightAt(LIGHT_IDS[1], 0.5, 0.5);
  assert.equal(applied(applyEdit(withLights(3), { kind: 'light.add', light }, NOW)).doc.lights.length, 4);
  const lit = withLights(4);
  assert.equal(applyEdit(lit, { kind: 'light.add', light }, NOW).doc, lit);
});

test('a title of 80 code points is kept and one of 81 is not, counted as the schema counts', () => {
  const emoji = '\u{1F600}';
  assert.equal(applied(applyEdit(minimalDocument(), { kind: 'title', title: emoji.repeat(80) }, NOW)).doc.title, emoji.repeat(80));
  assert.equal(applied(applyEdit(minimalDocument(), { kind: 'title', title: 'x'.repeat(80) }, NOW)).doc.title, 'x'.repeat(80));
  for (const title of [emoji.repeat(81), 'x'.repeat(81)]) {
    const doc = minimalDocument();
    assert.equal(applyEdit(doc, { kind: 'title', title }, NOW).doc, doc);
  }
});

// ---------------------------------------------------------------------------
// palette targets and refine

test('on the five-cluster document, a palette target outside the clusters changes nothing, and one inside clamps its color', () => {
  for (const cluster of [5, -1, 2.5]) {
    const doc = fiveClusterDocument();
    const result = applyEdit(doc, { kind: 'palette.target', cluster, color: { l: 0.5, c: 0.1, h: 10 } }, NOW);
    assert.equal(result.kind === 'refused' ? result.reason : result.kind, 'out-of-range', String(cluster));
    assert.equal(result.doc, doc);
  }
  const clamped = applied(applyEdit(fiveClusterDocument(), { kind: 'palette.target', cluster: 4, color: { l: 1.5, c: 0.9, h: -20 } }, NOW));
  assert.deepEqual(clamped.doc.style.paletteTargets.map((t) => t.cluster), [1, 3, 4]);
  assert.deepEqual(clamped.doc.style.paletteTargets[2]?.color, { l: 1, c: 0.4, h: 0 });
  assert.deepEqual(clamped.inverse, [{ kind: 'palette.target', cluster: 4, color: null }]);
});

test('a palette target with color null clears the entry, and its inverse sets the previous color back', () => {
  const before = fiveClusterDocument();
  const cleared = applied(applyEdit(before, { kind: 'palette.target', cluster: 3, color: null }, NOW));
  assert.deepEqual(cleared.doc.style.paletteTargets.map((t) => t.cluster), [1]);
  assert.deepEqual(cleared.inverse, [{ kind: 'palette.target', cluster: 3, color: before.style.paletteTargets[1]?.color }]);
  const zero = applied(applyEdit(before, { kind: 'palette.target', cluster: 0, color: { l: 0.2, c: 0.2, h: 20 } }, NOW));
  assert.deepEqual(zero.doc.style.paletteTargets.map((t) => t.cluster), [0, 1, 3]);
});

test('a palette target on cluster -0 or 0 stores the zero it was given, and its undo restores the stored entry\'s zero exactly', () => {
  const color = { l: 0.5, c: 0.1, h: 20 };
  for (const [stored, given] of [[0, -0], [-0, 0], [0, 0], [-0, -0]] as const) {
    const base = fiveClusterDocument();
    const before = { ...base, style: { ...base.style, paletteTargets: [{ cluster: stored, color }, ...base.style.paletteTargets] } };
    for (const next of [{ l: 0.4, c: 0.1, h: 20 }, null]) {
      const label = `stored ${Object.is(stored, -0) ? '-0' : '0'}, given ${Object.is(given, -0) ? '-0' : '0'}, color ${next === null ? 'null' : 'set'}`;
      const forward = applied(applyEdit(before, { kind: 'palette.target', cluster: given, color: next }, NOW));
      if (next !== null) assert.ok(Object.is(forward.doc.style.paletteTargets[0]?.cluster, given), label);
      const back = applied(applyEdits(forward.doc, forward.inverse, LATER));
      assert.deepEqual(withUpdatedAt(back.doc, before.updatedAt), before, label);
    }
    // The stored color under the other zero is a change, like any -0 where 0 is stored.
    const same = applyEdit(before, { kind: 'palette.target', cluster: given, color }, NOW);
    assert.equal(same.kind, Object.is(stored, given) ? 'unchanged' : 'applied');
  }
});

test('an edit that sets every field to the value it holds is unchanged: the input itself, unstamped, with no inverse', () => {
  const before = fiveClusterDocument();
  const [subject, box] = before.objects;
  const [key] = before.lights;
  const [target] = before.style.paletteTargets;
  assert.ok(subject !== undefined && box !== undefined && key !== undefined && target !== undefined);
  assert.equal(before.motion.enabled, true);
  const cases: readonly [string, Edit][] = [
    ['an empty style patch', { kind: 'style', patch: {} }],
    ['a style field set to its value', { kind: 'style', patch: { saturation: before.style.saturation } }],
    ['a style field that clamps to its value', { kind: 'style', patch: { colors: before.style.colors + 0.3 } }],
    ['harmony set to an equal value', { kind: 'style', patch: { harmony: { ...before.style.harmony } } }],
    ['the same title', { kind: 'title', title: before.title }],
    ['fry at its stored position, whose curve values the style holds', { kind: 'fry', fry: before.style.fry }],
    ['symbols set to their values', { kind: 'symbols', patch: { ...before.symbols } }],
    ['motion focus set to its value', { kind: 'motion', patch: { focus: before.motion.focus } }],
    ['lighting set to its values', { kind: 'lighting', patch: { ...before.lighting } }],
    ['clearing a cluster with no target', { kind: 'palette.target', cluster: 4, color: null }],
    ['a target set to its color', { kind: 'palette.target', cluster: target.cluster, color: { ...target.color } }],
    ['an object set to its values', { kind: 'object.set', id: box.id, patch: { thickness: box.thickness, recolor: box.recolor } }],
    ["an object's motion set to its value while the scene's motion is on", { kind: 'object.set', id: subject.id, patch: { motion: subject.motion } }],
    ['a refine to the same produced', { kind: 'object.refine', id: subject.id, produced: subject.produced }],
    ['a light set to its values', { kind: 'light.set', id: key.id, patch: { at: { ...key.at }, shadows: key.shadows } }],
  ];
  for (const [label, edit] of cases) {
    const result = applyEdit(before, edit, NOW);
    assert.equal(result.kind, 'unchanged', label);
    assert.equal(result.doc, before, label);
    assert.equal('inverse' in result, false, label);
  }
});

test("an object's motion other than none set to its value turns the scene's motion on when it is off, so it is applied; none set to none is unchanged", () => {
  const base = fiveClusterDocument();
  const before = { ...base, motion: { ...base.motion, enabled: false } };
  const [subject] = before.objects;
  assert.ok(subject !== undefined && subject.motion.kind !== 'none');
  const forward = applied(applyEdit(before, { kind: 'object.set', id: subject.id, patch: { motion: subject.motion } }, NOW));
  assert.equal(forward.doc.motion.enabled, true);
  const back = applied(applyEdits(forward.doc, forward.inverse, LATER));
  assert.deepEqual(withUpdatedAt(back.doc, before.updatedAt), before);
  const still = { ...before, objects: before.objects.map((object) => ({ ...object, motion: { kind: 'none' as const } })) };
  const none = applyEdit(still, { kind: 'object.set', id: subject.id, patch: { motion: { kind: 'none' } } }, NOW);
  assert.equal(none.kind, 'unchanged');
  assert.equal(none.doc, still);
});

test('a -0 where 0 is stored is a change, so the round trip stays exact', () => {
  const before = minimalDocument();
  assert.ok(Object.is(before.style.saturation, 0));
  const forward = applied(applyEdit(before, { kind: 'style', patch: { saturation: -0 } }, NOW));
  assert.ok(Object.is(forward.doc.style.saturation, -0));
  const back = applied(applyEdits(forward.doc, forward.inverse, LATER));
  assert.deepEqual(withUpdatedAt(back.doc, before.updatedAt), before);
});

test('applyEdits is unchanged when every edit is, and otherwise holds only the inverses of the edits that changed the document', () => {
  const before = fiveClusterDocument();
  const same = applyEdits(before, [{ kind: 'style', patch: {} }, { kind: 'title', title: before.title }], NOW);
  assert.equal(same.kind, 'unchanged');
  assert.equal(same.doc, before);
  const mixed = applied(applyEdits(before, [{ kind: 'title', title: before.title }, { kind: 'style', patch: { saturation: 0.1 } }, { kind: 'style', patch: {} }], NOW));
  assert.deepEqual(mixed.inverse, [{ kind: 'style', patch: { saturation: before.style.saturation } }]);
  assert.equal(mixed.doc.updatedAt, NOW);
});

test('object.refine with selection.candidate 3 or -1 changes nothing', () => {
  const [subject] = fiveClusterDocument().objects;
  assert.ok(subject !== undefined);
  for (const candidate of [3, -1]) {
    const doc = fiveClusterDocument();
    const produced = { ...subject.produced, selection: { ...subject.produced.selection, candidate } };
    const result = applyEdit(doc, { kind: 'object.refine', id: subject.id, produced }, NOW);
    assert.equal(result.kind === 'refused' ? result.reason : result.kind, 'invalid', String(candidate));
    assert.equal(result.doc, doc);
  }
});

// ---------------------------------------------------------------------------
// side effects and their inverses

test("giving an object a motion turns the scene's motion on, and an object.set of motion has the inverse [object.set { motion }, motion { enabled }]", () => {
  const before = minimalWithObject();
  assert.equal(before.motion.enabled, false);
  const forward = applied(applyEdit(before, { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'wobble', amount: 0.5 } } }, NOW));
  assert.equal(forward.doc.motion.enabled, true);
  assert.deepEqual(forward.inverse, [
    { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'none' } } },
    { kind: 'motion', patch: { enabled: false } },
  ]);
  // From one motion to another: the primary inverse turns motion on again, and the trailing edit sets it back.
  const moving = applied(applyEdit(before, { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'bob', amount: 0.2 } } }, NOW)).doc;
  const off = applied(applyEdit(moving, { kind: 'motion', patch: { enabled: false } }, NOW)).doc;
  const swayed = applied(applyEdit(off, { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'sway', amount: 0.3 } } }, NOW));
  const back = applied(applyEdits(swayed.doc, swayed.inverse, LATER));
  assert.deepEqual(withUpdatedAt(back.doc, off.updatedAt), off);
  // Setting motion none turns nothing on, but its primary inverse would, so it carries the trailing edit too.
  const stopped = applied(applyEdit(off, { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'none' } } }, NOW));
  assert.equal(stopped.doc.motion.enabled, false);
  assert.deepEqual(stopped.inverse, [
    { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'bob', amount: 0.2 } } },
    { kind: 'motion', patch: { enabled: false } },
  ]);
  const restarted = applied(applyEdits(stopped.doc, stopped.inverse, LATER));
  assert.deepEqual(withUpdatedAt(restarted.doc, off.updatedAt), off);
  // A patch without motion has no trailing edit.
  const thick = applied(applyEdit(off, { kind: 'object.set', id: objectId(0), patch: { thickness: 1 } }, NOW));
  assert.equal(thick.inverse.length, 1);
});

test('the first object added to a scene with no subject becomes the subject, and its inverse is object.remove alone', () => {
  const forward = applied(applyEdit(minimalDocument(), { kind: 'object.add', object: tappedObject(objectId(0)) }, NOW));
  assert.equal(forward.doc.objects[0]?.subject, true);
  assert.deepEqual(forward.inverse, [{ kind: 'object.remove', id: objectId(0) }]);
  const beside = applied(applyEdit(fiveClusterDocument(), { kind: 'object.add', object: tappedObject(objectId(0)) }, NOW));
  assert.equal(beside.doc.objects[2]?.subject, false);
  assert.equal(beside.doc.objects[2]?.id, objectId(0));
});

test("object.remove's inverse is object.add alone, and motion.focus is unchanged by the remove and by its undo", () => {
  const before = fiveClusterDocument();
  const [subject] = before.objects;
  assert.ok(subject !== undefined && subject.subject);
  assert.equal(before.motion.focus, 0.5);
  const removed = applied(applyEdit(before, { kind: 'object.remove', id: subject.id }, NOW));
  assert.deepEqual(removed.inverse, [{ kind: 'object.add', object: subject, restore: { index: 0 } }]);
  assert.equal(removed.doc.motion.focus, 0.5);
  assert.equal(removed.doc.objects.some((o) => o.subject), false);
  const undone = applied(applyEdits(removed.doc, removed.inverse, LATER));
  assert.equal(undone.doc.motion.focus, 0.5);
  assert.deepEqual(withUpdatedAt(undone.doc, before.updatedAt), before);
  // A restoring add makes no subject: the only object, not the subject, comes back as it was.
  const lone = minimalWithObject();
  const loneRemoved = applied(applyEdit(lone, { kind: 'object.remove', id: objectId(0) }, NOW));
  const loneBack = applied(applyEdits(loneRemoved.doc, loneRemoved.inverse, LATER));
  assert.equal(loneBack.doc.objects[0]?.subject, false);
});

test('the output shares with the input every field and list element the edit does not set, at every depth', () => {
  const before = fiveClusterDocument();
  const styled = applied(applyEdit(before, { kind: 'style', patch: { saturation: 0.1 } }, NOW)).doc;
  assert.equal(styled.analysis, before.analysis);
  assert.equal(styled.objects, before.objects);
  assert.equal(styled.lights, before.lights);
  assert.notEqual(styled.style, before.style);
  assert.equal(styled.style.harmony, before.style.harmony);
  assert.equal(styled.style.paletteTargets, before.style.paletteTargets);

  const [subject, other] = before.objects;
  assert.ok(subject !== undefined && other !== undefined);
  const thick = applied(applyEdit(before, { kind: 'object.set', id: subject.id, patch: { thickness: 0.1 } }, NOW)).doc;
  assert.equal(thick.objects[0]?.produced, subject.produced);
  assert.equal(thick.objects[0]?.recolor, subject.recolor);
  assert.equal(thick.objects[0]?.motion, subject.motion);
  assert.equal(thick.objects[1], other);
  assert.equal(thick.style, before.style);

  const [key, fill] = before.lights;
  assert.ok(key !== undefined && fill !== undefined);
  const at = { x: 0.2, y: 0.3 };
  const moved = applied(applyEdit(before, { kind: 'light.set', id: key.id, patch: { at } }, NOW)).doc;
  assert.equal(moved.lights[0]?.color, key.color);
  assert.equal(moved.lights[1], fill);
  // What the edit sets is the reducer's copy: the caller's patch can change without reaching the document.
  at.x = 0.9;
  assert.deepEqual(moved.lights[0]?.at, { x: 0.2, y: 0.3 });

  const fried = applied(applyEdit(before, { kind: 'fry', fry: 0.3 }, NOW)).doc;
  assert.equal(fried.style.harmony, before.style.harmony);
  assert.equal(fried.style.paletteTargets, before.style.paletteTargets);
});

test('renaming validates the name and shares untouched object products and settings', () => {
  const before = fiveClusterDocument(), object = before.objects[0];
  assert.ok(object);
  const result = applied(applyEdit(before, { kind: 'object.rename', id: object.id, name: 'Named layer' }, NOW));
  const renamed = result.doc.objects[0];
  assert.ok(renamed);
  assert.equal(renamed.produced, object.produced);
  assert.equal(renamed.recolor, object.recolor);
  assert.equal(renamed.motion, object.motion);
  assert.equal(renamed.hidden, object.hidden);
});
