import { oklabToOklch, oklchToOklab, oklabToSrgb } from '../core/color.ts';
import type { Oklab, Oklch } from '../core/raster.ts';
import type { ColorCluster, ObjectColor, Recolor, SceneDocument, Style, ToneStats } from '../core/types.ts';
import { clipGamut, Cmax, Lcusp } from './gamut.ts';

export const MAX_ENTRIES = 32;
export const MAX_BANDS = 6;
export type PaletteObject = { readonly label: number; readonly subject: boolean; readonly recolor: Recolor; readonly color: ObjectColor };
export type Entry = { readonly source: Oklab; readonly weight: number; readonly clusters: readonly number[]; readonly pinLabel: number };
export type Palette = {
  readonly entries: readonly Entry[];
  readonly sources: Float32Array;
  readonly resolved: readonly (readonly Oklch[])[];
  readonly variants: readonly (readonly (readonly Oklch[])[])[];
  readonly bandCounts: Float32Array;
  readonly lut: Uint8Array;
  readonly width: number;
  readonly rows: number;
  readonly darkest: readonly [number, number, number];
  readonly tone: ToneStats;
  readonly droppedPinLabels: readonly number[];
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Stable pair traversal supplies the tie breaker and the same merge prefix at every count. */
export function mergeEntries(clusters: readonly ColorCluster[], count: number): readonly Entry[] {
  const entries: Entry[] = clusters.map((cluster, i) => ({ source: cluster.lab, weight: cluster.weight, clusters: [i], pinLabel: 0 }));
  while (entries.length > Math.max(1, count)) {
    let best = Infinity;
    let ai = 0;
    let bi = 1;
    for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
      const x = entries[a];
      const y = entries[b];
      if (x === undefined || y === undefined) continue;
      const total = x.weight + y.weight;
      const cost = (total > 0 ? x.weight * y.weight / total : 0) *
        ((x.source.L - y.source.L) ** 2 + (x.source.a - y.source.a) ** 2 + (x.source.b - y.source.b) ** 2);
      if (cost < best) { best = cost; ai = a; bi = b; }
    }
    const x = entries[ai];
    const y = entries[bi];
    if (x === undefined || y === undefined) throw new Error('No palette merge pair.');
    const weight = x.weight + y.weight;
    const t = weight > 0 ? y.weight / weight : 0.5;
    entries[ai] = {
      source: { L: mix(x.source.L, y.source.L, t), a: mix(x.source.a, y.source.a, t), b: mix(x.source.b, y.source.b, t) },
      weight, clusters: [...x.clusters, ...y.clusters].sort((a, b) => a - b), pinLabel: 0,
    };
    entries.splice(bi, 1);
  }
  return entries;
}

export function nearestEntry(entries: readonly Entry[], lab: Oklab): number {
  let best = Infinity;
  let index = 0;
  entries.forEach((entry, i) => {
    const c = entry.source;
    const distance = 0.5 * (lab.L - c.L) ** 2 + (lab.a - c.a) ** 2 + (lab.b - c.b) ** 2;
    if (distance < best) { best = distance; index = i; }
  });
  return index;
}

export function saturate(source: Oklch, saturation: number): Oklch {
  const w = clamp((source.c - 0.01) / 0.03, 0, 1);
  if (w === 0 || saturation === 0) return source;
  const l = mix(source.l, Lcusp(source.h), 0.6 * saturation * w);
  return { l, c: mix(source.c, Cmax(l, source.h), saturation ** 0.7 * w), h: source.h };
}

export function bandVariants(color: Oklch, bands: number): readonly Oklch[] {
  const window = clamp(color.l - 0.25, 0, 0.55);
  return Array.from({ length: bands }, (_, i) => clipGamut({ ...color, l: window + 0.45 * (i + 0.5) / bands }));
}

/** Recolor uses the assigned source mean, preserving shading relative to that entry. */
export function recolorRow(entries: readonly Entry[], mean: Oklab, target: Oklch): readonly Oklch[] {
  const assigned = entries[nearestEntry(entries, mean)];
  if (assigned === undefined) return [];
  const reference = oklabToOklch(assigned.source);
  const neutral = reference.c < 0.03;
  return entries.map((entry) => {
    const source = oklabToOklch(entry.source);
    return {
      l: clamp(source.l - reference.l + target.l, 0, 1), h: target.h,
      c: target.c * (neutral ? 1 : clamp(source.c / Math.max(reference.c, 0.03), 0.5, 1.5)),
    };
  });
}

export function resolvePalette({ colors, style, tone, objects = [] }: {
  readonly colors: readonly ColorCluster[]; readonly style: Style; readonly tone: ToneStats; readonly objects?: readonly PaletteObject[];
}): Palette {
  const entries = [...mergeEntries(colors, style.colors)];
  const pinCount = Math.round(1 + 2 * style.subjectClarity);
  const pins = objects.filter((object) => object.subject).map((object) => ({
    label: object.label,
    entries: [...object.color.clusters].map((cluster, index) => ({ cluster, index }))
      .sort((a, b) => b.cluster.weight - a.cluster.weight || a.index - b.index).slice(0, pinCount)
      .map(({ cluster }): Entry => ({ source: cluster.lab, weight: cluster.weight, clusters: [], pinLabel: object.label })),
  }));
  let total = entries.length + pins.reduce((n, pin) => n + pin.entries.length, 0);
  const droppedPinLabels: number[] = [];
  for (let i = pins.length - 1; i >= 0 && total > MAX_ENTRIES; i--) {
    const pin = pins[i];
    if (pin === undefined) continue;
    droppedPinLabels.push(pin.label);
    while (total > MAX_ENTRIES && pin.entries.length > 0) { pin.entries.pop(); total--; }
  }
  for (const pin of pins) entries.push(...pin.entries);
  const recolors = new Map<number, readonly Oklch[]>();
  for (const object of objects) if (object.recolor.kind === 'target') recolors.set(object.label, recolorRow(entries, object.color.mean, object.recolor.color));
  const base = entries.map((entry) => {
    const target = style.paletteTargets.find((target) => entry.clusters.includes(target.cluster));
    return target?.color ?? saturate(oklabToOklch(entry.source), style.saturation);
  });
  const rows = Math.max(1, ...objects.map((object) => object.label + 1));
  const resolved: Oklch[][] = Array.from({ length: rows }, () => [...base]);
  for (const [label, row] of recolors) resolved[label] = [...row];
  // Integers 2..6 remain exact in the float uniform table. Resolve the .5
  // ties once here, rather than repeating Math.round in GLSL float32.
  const subjectBands = Math.round(mix(style.bands, MAX_BANDS, style.subjectClarity));
  const bandCounts = new Float32Array(256).fill(style.bands);
  for (const object of objects) if (object.subject) bandCounts[object.label] = subjectBands;
  const sources = new Float32Array(MAX_ENTRIES * 3);
  // Duplicate the first source into unused slots: the GPU exercises all 32
  // distances, and strict tie breaking always selects a populated LUT entry.
  const first = entries[0];
  if (first !== undefined) for (let i = 0; i < MAX_ENTRIES; i++) sources.set([first.source.L, first.source.a, first.source.b], i * 3);
  entries.forEach((entry, i) => sources.set([entry.source.L, entry.source.a, entry.source.b], i * 3));
  const width = MAX_ENTRIES * MAX_BANDS;
  const lut = new Uint8Array(width * rows * 4);
  let darkestL = Infinity;
  let darkest: readonly [number, number, number] = [0, 0, 0];
  const variants = resolved.map((row, label) => {
    const bands = bandCounts[label] ?? style.bands;
    return row.map((color, entry) => {
      const swatches = bandVariants(color, bands);
      swatches.forEach((variant, band) => {
        const rgb = oklabToSrgb(oklchToOklab(variant));
        const bytes = [rgb.r, rgb.g, rgb.b].map((c) => Math.round(255 * clamp(c, 0, 1)));
        lut.set([...bytes, 255], (label * width + entry * MAX_BANDS + band) * 4);
        if (label === 0 && variant.l < darkestL) {
          darkestL = variant.l;
          darkest = [(bytes[0] ?? 0) / 255, (bytes[1] ?? 0) / 255, (bytes[2] ?? 0) / 255];
        }
      });
      return swatches;
    });
  });
  return { entries, sources, resolved, variants, bandCounts, lut, width, rows, darkest, tone, droppedPinLabels };
}

export function documentPalette(doc: SceneDocument): Palette {
  return resolvePalette({ colors: doc.analysis.colors, style: doc.style, tone: doc.analysis.tone,
    objects: doc.objects.map((object, i) => ({ label: i + 1, subject: object.subject, recolor: object.recolor, color: object.produced.color })) });
}
