// Seeded random sequences: from every fixture document, 2000 sequences of
// edits and analysis products, with values in range, out of range,
// non-finite, and of the wrong type, with ids known and unknown, and with
// products the document has moved past. After every step the document
// parses, a refused or unchanged step returned the input itself, an applied
// edit's inverse list restores the document before it but updatedAt, and no
// edit changes analysis.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Edit, Produce, StylePatch } from '../src/core/edits.ts';
import { applyProduce, sortedMasks } from '../src/core/produce.ts';
import { applyEdit, applyEdits } from '../src/core/reduce.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { DepthStats, Harmony, ObjectMotion, ObjectProduced, Recolor, SceneDocument } from '../src/core/types.ts';
import { assetId, fiveClusterDocument, validDocuments } from './fixtures/documents.ts';
import { editCases, lightId, newLightAt, objectId, tappedObject } from './fixtures/edits.ts';
import { depthProduct, plateProduct } from './fixtures/products.ts';

const SEQUENCES = 2000;
const STEPS = 12;
const SEED = 0x5eed_2a02;
/** The share of steps that apply a product rather than an edit. */
const PRODUCT_SHARE = 0.25;

type Random = () => number;

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

function chance(random: Random, p: number): boolean {
  return random() < p;
}

/** Mostly near the field's range, sometimes far outside it, rarely not finite. */
function value(random: Random, scale = 1): number {
  const roll = random();
  if (roll < 0.02) return pick(random, [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  if (roll < 0.1) return (random() - 0.5) * 2e6;
  if (roll < 0.25) return Math.round((random() * 1.6 - 0.3) * scale);
  return (random() * 1.6 - 0.3) * scale;
}

function color(random: Random): { readonly l: number; readonly c: number; readonly h: number } {
  return { l: value(random), c: value(random, 0.5), h: value(random, 360) };
}

function harmony(random: Random): Harmony {
  const kind = pick(random, ['off', 'auto', 'analogous', 'complementary', 'split-complementary', 'triadic'] as const);
  return kind === 'off' ? { kind } : { kind, strength: value(random) };
}

function recolor(random: Random): Recolor {
  return chance(random, 0.3) ? { kind: 'none' } : { kind: 'target', color: color(random) };
}

function objectMotion(random: Random): ObjectMotion {
  const kind = pick(random, ['none', 'wobble', 'bob', 'sway'] as const);
  return kind === 'none' ? { kind } : { kind, amount: value(random) };
}

function stylePatch(random: Random): StylePatch {
  const patch: { -readonly [K in keyof StylePatch]: StylePatch[K] } = {};
  if (chance(random, 0.3)) patch.fry = value(random);
  if (chance(random, 0.3)) patch.colors = value(random, 14);
  if (chance(random, 0.3)) patch.saturation = value(random);
  if (chance(random, 0.2)) patch.harmony = harmony(random);
  if (chance(random, 0.3)) patch.bands = value(random, 7);
  if (chance(random, 0.2)) patch.simplify = value(random);
  if (chance(random, 0.2)) patch.outline = value(random);
  if (chance(random, 0.2)) patch.subjectClarity = value(random);
  if (chance(random, 0.2)) patch.grain = value(random);
  if (chance(random, 0.2)) patch.colorNoise = value(random);
  if (chance(random, 0.2)) patch.grainSize = value(random, 5);
  if (chance(random, 0.2)) patch.grainHold = value(random, 4);
  if (chance(random, 0.2)) patch.crunch = value(random);
  if (chance(random, 0.2)) patch.clipping = value(random);
  return patch;
}

function produced(random: Random, base: ObjectProduced): ObjectProduced {
  const candidate = pick(random, [-1, 0, 1, 2, 3, 1.5]);
  return chance(random, 0.5)
    ? { ...base, selection: { kind: 'taps', points: [{ at: { x: value(random), y: value(random) }, label: 'include' }], candidate } }
    : { ...base, selection: { ...base.selection, candidate } };
}

/** An id of an object in `doc`, or of no object. */
function someObjectId(random: Random, doc: SceneDocument) {
  const ids = doc.objects.map((o) => o.id);
  const [first, ...rest] = ids;
  return first === undefined || chance(random, 0.15) ? objectId(Math.floor(random() * 40)) : pick(random, [first, ...rest]);
}

function someLightId(random: Random, doc: SceneDocument) {
  const ids = doc.lights.map((l) => l.id);
  const [first, ...rest] = ids;
  return first === undefined || chance(random, 0.15) ? lightId(Math.floor(random() * 8)) : pick(random, [first, ...rest]);
}

const FIXTURE_EDITS = editCases().map((c) => c.edit);
const [BASE_SUBJECT] = fiveClusterDocument().objects;

function randomEdit(random: Random, doc: SceneDocument): Edit {
  const [fixture, ...fixtures] = FIXTURE_EDITS;
  if (BASE_SUBJECT === undefined || fixture === undefined) throw new Error('the fixtures are empty');
  const kind = pick(random, [
    'fixture',
    'title',
    'style',
    'fry',
    'symbols',
    'motion',
    'lighting',
    'palette.target',
    'object.add',
    'object.add',
    'object.set',
    'object.refine',
    'object.remove',
    'light.add',
    'light.set',
    'light.remove',
  ] as const);
  switch (kind) {
    case 'fixture':
      return pick(random, [fixture, ...fixtures]);
    case 'title':
      return { kind, title: (chance(random, 0.5) ? '\u{1F600}' : 'a').repeat(Math.floor(random() * 86)) };
    case 'style':
      return { kind, patch: stylePatch(random) };
    case 'fry':
      return { kind, fry: value(random) };
    case 'symbols':
      return { kind, patch: { enabled: chance(random, 0.5), cellSize: value(random, 50) } };
    case 'motion':
      return { kind, patch: chance(random, 0.3) ? { focus: null } : { orbit: value(random), loopSeconds: value(random, 7), focus: value(random) } };
    case 'lighting':
      return { kind, patch: { ambient: value(random), relief: value(random, 4.5) } };
    case 'palette.target':
      return { kind, cluster: pick(random, [-1, -0, 0, 1, 2, 3, 4, 5, 6, 2.5, Number.NaN]), color: chance(random, 0.3) ? null : color(random) };
    case 'object.add': {
      const object = { ...tappedObject(objectId(Math.floor(random() * 40))), thickness: value(random, 2), recolor: recolor(random), motion: objectMotion(random) };
      return chance(random, 0.2) ? { kind, object, restore: { index: value(random, 40) } } : { kind, object };
    }
    case 'object.set':
      return {
        kind,
        id: someObjectId(random, doc),
        patch: chance(random, 0.5) ? { motion: objectMotion(random) } : { recolor: recolor(random), thickness: value(random, 2), subject: chance(random, 0.5) },
      };
    case 'object.refine':
      return { kind, id: someObjectId(random, doc), produced: produced(random, BASE_SUBJECT.produced) };
    case 'object.remove':
      return { kind, id: someObjectId(random, doc) };
    case 'light.add': {
      const light = { ...newLightAt(lightId(Math.floor(random() * 8)), value(random), value(random)), color: color(random), radius: value(random, 2) };
      return { kind, light };
    }
    case 'light.set':
      return { kind, id: someLightId(random, doc), patch: { at: { x: value(random), y: value(random) }, intensity: value(random, 2), shadows: chance(random, 0.5) } };
    case 'light.remove':
      return { kind, id: someLightId(random, doc) };
    default: {
      const unhandled: never = kind;
      throw new Error(`no generator for ${String(unhandled)}`);
    }
  }
}

/** Statistics mostly in range, sometimes out of it or not finite, which the reducer refuses. */
function stats(random: Random): DepthStats {
  if (chance(random, 0.85)) {
    const [p10, median, p90] = [random(), random(), random()].sort((a, b) => a - b);
    return { p10: p10 ?? 0, median: median ?? 0, p90: p90 ?? 0 };
  }
  return { p10: value(random), median: value(random), p90: value(random) };
}

function randomProduct(random: Random, doc: SceneDocument): Produce {
  const kind = pick(random, ['depth', 'plate', 'plate', 'object.depth', 'auto-subject'] as const);
  switch (kind) {
    case 'depth':
      return { kind, depth: depthProduct(Math.floor(random() * 4), stats(random)) };
    case 'plate': {
      const current = sortedMasks(doc);
      const roll = random();
      // The current masks, a stale set, or an unsorted one the schema refuses.
      const forMasks = roll < 0.6 ? current : roll < 0.9 ? [...current, assetId(0x99)].sort() : [assetId(0x99), assetId(0x31)];
      return { kind, plate: plateProduct(Math.floor(random() * 4), forMasks) };
    }
    case 'object.depth':
      return { kind, id: someObjectId(random, doc), depth: stats(random) };
    case 'auto-subject':
      return { kind, found: chance(random, 0.3) ? null : tappedObject(objectId(Math.floor(random() * 40))) };
    default: {
      const unhandled: never = kind;
      throw new Error(`no generator for ${String(unhandled)}`);
    }
  }
}

test(`${SEQUENCES} seeded random sequences of edits and products keep every fixture document valid, and every edit undoes exactly`, (t) => {
  const random = seeded(SEED);
  const starts = validDocuments();
  const counts = { applied: 0, unchanged: 0, refused: 0, produced: 0, producedUnchanged: 0, producedRefused: 0 };
  for (let sequence = 0; sequence < SEQUENCES; sequence++) {
    const start = starts[sequence % starts.length];
    assert.ok(start !== undefined);
    let doc = start;
    for (let step = 0; step < STEPS; step++) {
      const now = new Date(Date.UTC(2026, 9, 2, 18, 0, sequence, step)).toISOString();
      if (chance(random, PRODUCT_SHARE)) {
        const product = randomProduct(random, doc);
        const label = `sequence ${sequence}, step ${step}: ${JSON.stringify(product)}`;
        const result = applyProduce(doc, product, now);
        const parsed = parseDocument(result.doc);
        assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
        if (result.kind !== 'applied') {
          assert.equal(result.doc, doc, label);
          if (result.kind === 'unchanged') counts.producedUnchanged++;
          else counts.producedRefused++;
          continue;
        }
        assert.equal(result.doc.updatedAt, now, label);
        doc = result.doc;
        counts.produced++;
        continue;
      }
      const edit = randomEdit(random, doc);
      const label = `sequence ${sequence}, step ${step}: ${JSON.stringify(edit)}`;
      const result = applyEdit(doc, edit, now);
      const parsed = parseDocument(result.doc);
      assert.ok(parsed.ok, `${label}: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
      assert.equal(result.doc.analysis, doc.analysis, label);
      if (result.kind !== 'applied') {
        assert.equal(result.doc, doc, label);
        if (result.kind === 'unchanged') counts.unchanged++;
        else counts.refused++;
        continue;
      }
      const back = applyEdits(result.doc, result.inverse, now);
      assert.equal(back.kind, 'applied', label);
      assert.deepEqual({ ...back.doc, updatedAt: doc.updatedAt }, doc, label);
      doc = result.doc;
      counts.applied++;
    }
  }
  t.diagnostic(`outcomes: ${JSON.stringify(counts)}`);
  // Every outcome is exercised in quantity, so a generator that only ever
  // produces refusals, or only valid steps, fails here.
  const steps = SEQUENCES * STEPS;
  assert.ok(counts.applied > steps * 0.2, JSON.stringify(counts));
  assert.ok(counts.refused > steps * 0.05, JSON.stringify(counts));
  assert.ok(counts.unchanged > 50, JSON.stringify(counts));
  assert.ok(counts.produced > steps * 0.03, JSON.stringify(counts));
  assert.ok(counts.producedUnchanged > steps * 0.03, JSON.stringify(counts));
  assert.ok(counts.producedRefused > 50, JSON.stringify(counts));
});
