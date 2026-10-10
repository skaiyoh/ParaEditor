import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oklabToOklch, oklchToOklab } from '../src/core/color.ts';
import type { ColorCluster, ObjectColor, Style } from '../src/core/types.ts';
import { bandVariants, mergeEntries, nearestEntry, recolorRow, resolvePalette, saturate, type PaletteObject } from '../src/render/palette.ts';

const colors: ColorCluster[] = Array.from({ length: 12 }, (_, i) => ({
  lab: oklchToOklab({ l: 0.3 + i / 30, c: 0.05 + i / 400, h: i * 30 }), weight: (i + 1) / 78,
}));
const tone = { p01: 0.1, p05: 0.15, p50: 0.5, p95: 0.85, p99: 0.9 };
const DEFAULT_STYLE: Style = {
  fry: 0.6, colors: 7, bands: 4, saturation: 0.62, simplify: 0.52, outline: 0.4, subjectClarity: 0.6,
  grain: 0.52, colorNoise: 0.32, crunch: 0.42, clipping: 0.3, grainSize: 2, grainHold: 2,
  harmony: { kind: 'off' }, paletteTargets: [],
};
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('weighted Ward merges are deterministic and every lower count merges exactly one prior pair', () => {
  for (let count = colors.length; count > 2; count--) {
    const previous = mergeEntries(colors, count);
    const next = mergeEntries(colors, count - 1);
    assert.deepEqual(next, mergeEntries(colors, count - 1));
    assert.equal(previous.length - next.length, 1);
    const remaining = previous.filter((entry) => next.some((candidate) => candidate.clusters.join(',') === entry.clusters.join(',')));
    assert.equal(remaining.length, count - 2);
    const removed = previous.filter((entry) => !remaining.includes(entry));
    const combined = next.find((entry) => !previous.some((candidate) => candidate.clusters.join(',') === entry.clusters.join(',')));
    assert.deepEqual(combined?.clusters, removed.flatMap((entry) => entry.clusters).sort((a, b) => a - b));
    close(next.reduce((weight, entry) => weight + entry.weight, 0), 1);
  }
});

test('saturation zero is identity; chroma at or below 0.01 is identity at every saturation', () => {
  for (const entry of colors) {
    const source = oklabToOklch(entry.lab);
    assert.deepEqual(saturate(source, 0), source);
  }
  for (const c of [0, 0.005, 0.01]) for (const saturation of [0, 0.2, 0.6, 1]) {
    const source = { l: 0.5, c, h: 240 };
    assert.deepEqual(saturate(source, saturation), source);
  }
});

test('band variants follow sliding windows and are separated by 0.45 / bands', () => {
  for (const bands of [2, 3, 4, 5, 6]) for (const l of [0.05, 0.5, 0.95]) {
    const variants = bandVariants({ l, c: 0.1, h: 40 }, bands);
    const first = variants[0];
    assert.ok(first !== undefined);
    close(first.l, Math.min(Math.max(l - 0.25, 0), 0.55) + 0.45 * 0.5 / bands);
    variants.slice(1).forEach((variant, i) => close(variant.l - (variants[i]?.l ?? 0), 0.45 / bands));
  }
});

test('muted-object recolor assigned to a gray entry lands exactly on the target before banding', () => {
  const mean = { L: 0.5, a: 0.05, b: 0 };
  const entries = mergeEntries([{ lab: { L: 0.5, a: 0.01, b: 0 }, weight: 0.6 }, { lab: { L: 0.8, a: 0, b: 0 }, weight: 0.4 }], 2);
  const target = { l: 0.6, c: 0.12, h: 100 };
  const row = recolorRow(entries, mean, target);
  assert.deepEqual(row[nearestEntry(entries, mean)], target);
  close(row[1]?.l ?? 0, 0.9);
});

test('colored-object recolor uses the assigned mean and clamps relative chroma to 0.5..1.5', () => {
  const mean = oklchToOklab({ l: 0.5, c: 0.1, h: 60 });
  const entries = mergeEntries([
    { lab: mean, weight: 0.6 },
    { lab: oklchToOklab({ l: 0.8, c: 0.02, h: 120 }), weight: 0.2 },
    { lab: oklchToOklab({ l: 0.2, c: 0.2, h: 200 }), weight: 0.2 },
  ], 3);
  const target = { l: 0.6, c: 0.08, h: 280 };
  const row = recolorRow(entries, mean, target);
  const assigned = row[nearestEntry(entries, mean)];
  assert.ok(assigned !== undefined);
  close(assigned.l, target.l); close(assigned.c, target.c); close(assigned.h, target.h);
  close(row[1]?.c ?? 0, target.c * 0.5);
  close(row[2]?.c ?? 0, target.c * 1.5);
});

function subject(label: number): PaletteObject {
  const a = colors[(label * 2) % colors.length];
  const b = colors[(label * 2 + 1) % colors.length];
  const c = colors[(label * 2 + 2) % colors.length];
  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  const color: ObjectColor = { mean: a.lab, clusters: [{ ...a, weight: 0.5 }, { ...b, weight: 0.3 }, { ...c, weight: 0.2 }] };
  return { label, subject: true, recolor: { kind: 'none' }, color };
}

test('twelve colors plus four subjects keep every pin; only actual overflow drops newest pins first', () => {
  const style = { ...DEFAULT_STYLE, colors: 12, subjectClarity: 1 };
  const four = [1, 2, 3, 4].map(subject);
  const palette = resolvePalette({ colors, tone, style, objects: four });
  assert.equal(palette.entries.length, 24);
  for (const label of [1, 2, 3, 4]) assert.equal(palette.entries.filter((entry) => entry.pinLabel === label).length, 3);
  const fifth = resolvePalette({ colors, tone, style, objects: [...four, subject(5)] });
  assert.equal(fifth.entries.length, 27);
  assert.deepEqual(fifth.droppedPinLabels, []);
  const overflow = resolvePalette({ colors, tone, style, objects: [...four, subject(5), subject(6), subject(7)] });
  assert.equal(overflow.entries.length, 32);
  assert.deepEqual(overflow.droppedPinLabels, [7]);
  for (let label = 1; label <= 6; label++) assert.equal(overflow.entries.filter((entry) => entry.pinLabel === label).length, 3);
  assert.equal(overflow.entries.filter((entry) => entry.pinLabel === 7).length, 2);
  assert.deepEqual(overflow.lut, resolvePalette({ colors, tone, style, objects: [...four, subject(5), subject(6), subject(7)] }).lut);
});

test('palette LUT rows use source assignment, subject band counts, target precedence, and supplied tone', () => {
  const object = { ...subject(1), recolor: { kind: 'target', color: { l: 0.5, c: 0.08, h: 210 } } } satisfies PaletteObject;
  const style = { ...DEFAULT_STYLE, colors: 2, bands: 2, subjectClarity: 1,
    paletteTargets: [{ cluster: 0, color: { l: 0.45, c: 0.04, h: 120 } }, { cluster: 1, color: { l: 0.7, c: 0.02, h: 40 } }] };
  const palette = resolvePalette({ colors, tone, style, objects: [object] });
  assert.equal(palette.width, 32 * 6);
  assert.equal(palette.rows, 2);
  assert.deepEqual(palette.tone, tone);
  assert.equal(palette.variants[0]?.[0]?.length, 2);
  assert.equal(palette.variants[1]?.[0]?.length, 6);
  const targeted = palette.entries.findIndex((entry) => entry.clusters.includes(0));
  assert.deepEqual(palette.resolved[0]?.[targeted], style.paletteTargets[0]?.color);
  palette.entries.forEach((entry, i) => {
    if (entry.pinLabel === object.label) {
      assert.deepEqual(palette.resolved[0]?.[i], saturate(oklabToOklch(entry.source), style.saturation), 'shared pin retains its resolved color');
      assert.deepEqual(palette.resolved[1]?.[i], recolorRow(palette.entries, object.color.mean, object.recolor.color)[i], 'own row recolors the pin');
    }
  });
  for (const row of palette.variants) for (const entry of row) for (const variant of entry) assert.ok(variant.l >= 0 && variant.l <= 1);
});

test('recolored subject pin nearest a gray background pixel leaves row zero and other objects unchanged', () => {
  const background = { lab: { L: 0.7, a: 0, b: 0 }, weight: 1 };
  const pin = { lab: { L: 0.5, a: 0, b: 0 }, weight: 1 };
  const object: PaletteObject = { label: 1, subject: true, recolor: { kind: 'none' }, color: { mean: pin.lab, clusters: [pin] } };
  const other: PaletteObject = { label: 2, subject: false, recolor: { kind: 'none' }, color: { mean: background.lab, clusters: [background] } };
  const target = { l: 0.6, c: 0.12, h: 250 };
  const before = resolvePalette({ colors: [background], tone, style: DEFAULT_STYLE, objects: [object, other] });
  const after = resolvePalette({ colors: [background], tone, style: DEFAULT_STYLE, objects: [{ ...object, recolor: { kind: 'target', color: target } }, other] });
  const nearest = nearestEntry(after.entries, { L: 0.51, a: 0, b: 0 });
  assert.equal(after.entries[nearest]?.pinLabel, object.label, 'a shaded background pixel selects the subject pin');
  assert.deepEqual(after.resolved[0], before.resolved[0]);
  assert.deepEqual(after.resolved[2], before.resolved[2]);
  assert.deepEqual(after.lut.subarray(0, after.width*4), before.lut.subarray(0, before.width*4));
  assert.deepEqual(after.resolved[1]?.[nearest], target);
});

test('CPU subject band counts resolve non-dyadic half ties and size every LUT row', () => {
  const palette = resolvePalette({ colors, tone, style: { ...DEFAULT_STYLE, bands: 3, subjectClarity: 5/6 },
    objects: [subject(1), { ...subject(2), subject: false }] });
  assert.equal(palette.bandCounts[0], 3);
  assert.equal(palette.bandCounts[1], 6);
  assert.equal(palette.bandCounts[2], 3);
  for (const [label, row] of palette.variants.entries()) for (const variants of row) assert.equal(variants.length, palette.bandCounts[label]);
});
