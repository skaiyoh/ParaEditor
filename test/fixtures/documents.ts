// Hand-written scene documents for node tests: a minimal valid document, the
// five-cluster document, and the invalid variants, at least one for each
// invariant of the document's shape and more for its bounds, literals, ids,
// and formats, each naming the path its failure must report.
// Each function returns a fresh value, so a test may change what it gets.

import type { AssetId, BuildId, LightId, ModelId, ObjectId, SceneId } from '../../src/core/ids.ts';
import { isAssetId, isBuildId, isLightId, isModelId, isObjectId, isSceneId } from '../../src/core/ids.ts';
import type { Light, SceneDocument, SceneObject } from '../../src/core/types.ts';
import { SCENE_VERSION } from '../../src/core/migrate.ts';

function brand<T extends string>(check: (text: string) => text is T, text: string): T {
  if (!check(text)) throw new Error(`fixture id ${JSON.stringify(text)} fails its check`);
  return text;
}

/** The n-th of a run of distinct lowercase UUID v4s. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** 64 lowercase hex digits ending in `n`'s hex. */
export function assetId(n: number): AssetId {
  return brand(isAssetId, n.toString(16).padStart(64, '0'));
}

export const SCENE_ID: SceneId = brand(isSceneId, '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b');
export const OBJECT_IDS: readonly [ObjectId, ObjectId] = [brand(isObjectId, uuid(0x101)), brand(isObjectId, uuid(0x102))];
export const LIGHT_IDS: readonly [LightId, LightId] = [brand(isLightId, uuid(0x201)), brand(isLightId, uuid(0x202))];
export const WRITER: BuildId = brand(isBuildId, 'nocommit-20261002');
export const DEPTH_MODEL: ModelId = brand(isModelId, `depth@${'a'.repeat(64)}`);
export const SAM_MODEL: ModelId = brand(isModelId, `sam@${'b'.repeat(64)}`);
export const INPAINT_MODEL: ModelId = brand(isModelId, `migan@${'c'.repeat(64)}`);

/** The smallest valid document: one color cluster, no products, no objects, no lights. */
export function minimalDocument(): SceneDocument {
  return {
    format: 'noisy-scene',
    version: SCENE_VERSION,
    id: SCENE_ID,
    title: 'Minimal',
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:00:00.000Z',
    seed: 1,
    frame: {
      source: null,
      master: { asset: assetId(1), size: { width: 2, height: 2 } },
      original: { name: 'tiny.png', mediaType: 'image/png', size: { width: 2, height: 2 } },
    },
    analysis: {
      colors: [{ lab: { L: 0.5, a: 0, b: 0 }, weight: 1 }],
      tone: { p01: 0.5, p05: 0.5, p50: 0.5, p95: 0.5, p99: 0.5 },
      depth: null,
      plate: null,
      autoSubject: 'pending',
    },
    style: {
      fry: 0,
      colors: 2,
      saturation: 0,
      harmony: { kind: 'off' },
      paletteTargets: [],
      bands: 2,
      simplify: 0,
      outline: 0,
      subjectClarity: 0,
      grain: 0,
      colorNoise: 0,
      grainSize: 1,
      grainHold: 1,
      crunch: 0,
      clipping: 0,
    },
    symbols: { enabled: false, cellSize: 12, amount: 0.3 },
    surface: { enabled: false, pattern: 'bars', relief: 0.5, refraction: 0.5, shine: 0.5, scale: 0.5 },
    motion: { enabled: false, orbit: 0.6, loopSeconds: 3, focus: null },
    lighting: { ambient: 0.7, relief: 1 },
    objects: [],
    lights: [],
    provenance: { writer: WRITER, importedOn: 'node:test' },
  };
}

const subject: SceneObject = {
  id: OBJECT_IDS[0],
  name: 'Object 1',
  subject: true,
  recolor: { kind: 'target', color: { l: 0.79, c: 0.27, h: 142 } },
  symbols: 'slider',
  motion: { kind: 'wobble', amount: 0.5 },
  thickness: 0.3,
  produced: {
    model: SAM_MODEL,
    selection: { kind: 'auto-subject', seed: { at: { x: 0.5, y: 0.5 }, label: 'include' }, candidate: 0 },
    mask: { asset: assetId(0x31), format: 'u8', size: { width: 1024, height: 768 } },
    bounds: { x: 300, y: 200, width: 600, height: 500 },
    depth: { p10: 0.55, median: 0.7, p90: 0.8 },
    color: {
      mean: { L: 0.6, a: 0.05, b: 0.08 },
      clusters: [
        { lab: { L: 0.65, a: 0.06, b: 0.1 }, weight: 0.7 },
        { lab: { L: 0.45, a: 0.02, b: 0.03 }, weight: 0.3 },
      ],
    },
  },
};

const box: SceneObject = {
  id: OBJECT_IDS[1],
  name: 'Object 2',
  subject: false,
  recolor: { kind: 'none' },
  symbols: 'never',
  motion: { kind: 'none' },
  thickness: 1.2,
  produced: {
    model: SAM_MODEL,
    selection: {
      kind: 'taps',
      points: [
        { at: { x: 0.1, y: 0.9 }, label: 'include' },
        { at: { x: 0.2, y: 0.8 }, label: 'exclude' },
      ],
      candidate: 1,
    },
    mask: { asset: assetId(0x32), format: 'u8', size: { width: 1024, height: 768 } },
    bounds: { x: 0, y: 1300, width: 400, height: 236 },
    depth: null,
    color: {
      mean: { L: 0.3, a: -0.02, b: 0.01 },
      clusters: [
        { lab: { L: 0.32, a: -0.03, b: 0.01 }, weight: 0.5 },
        { lab: { L: 0.28, a: -0.01, b: 0.02 }, weight: 0.3 },
        { lab: { L: 0.2, a: 0, b: 0 }, weight: 0.2 },
      ],
    },
  },
};

const lights: readonly [Light, Light] = [
  {
    id: LIGHT_IDS[0],
    at: { x: 0.25, y: 0.2 },
    depth: 0.8,
    color: { l: 0.95, c: 0, h: 0 },
    intensity: 1,
    radius: 0.6,
    rays: 0.3,
    shadows: true,
    softness: 0.3,
  },
  {
    id: LIGHT_IDS[1],
    at: { x: 1.4, y: -0.3 },
    depth: 0.2,
    color: { l: 0.7, c: 0.2, h: 40 },
    intensity: 2,
    radius: 1.5,
    rays: 0,
    shadows: false,
    softness: 1,
  },
];

/**
 * A document with five color clusters and every product present: depth, a
 * plate, two objects (an automatic subject and a tapped one), two lights, and
 * palette targets on clusters 1 and 3. Beside the minimal document it holds
 * every arm of every union and nullable field but Harmony's `auto`, which
 * validDocuments adds.
 */
export function fiveClusterDocument(): SceneDocument {
  return {
    format: 'noisy-scene',
    version: SCENE_VERSION,
    id: SCENE_ID,
    title: 'Five colors',
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:30:00.000Z',
    seed: 0xffff_ffff,
    frame: {
      source: { asset: assetId(0x10), mediaType: 'image/jpeg', byteLength: 3_971_900 },
      master: { asset: assetId(0x11), size: { width: 2048, height: 1536 } },
      original: { name: 'IMG_0001.JPG', mediaType: 'image/jpeg', size: { width: 5712, height: 4284 } },
    },
    analysis: {
      colors: [
        { lab: { L: 0.7, a: -0.02, b: -0.1 }, weight: 0.4 },
        { lab: { L: 0.5, a: -0.08, b: 0.06 }, weight: 0.25 },
        { lab: { L: 0.3, a: 0.01, b: 0.02 }, weight: 0.15 },
        { lab: { L: 0.62, a: 0.1, b: 0.12 }, weight: 0.12 },
        { lab: { L: 0.9, a: 0, b: 0.01 }, weight: 0.08 },
      ],
      tone: { p01: 0.08, p05: 0.15, p50: 0.52, p95: 0.88, p99: 0.95 },
      depth: {
        model: DEPTH_MODEL,
        map: { asset: assetId(0x20), format: 'f32', size: { width: 686, height: 518 } },
        stats: { p10: 0.1, median: 0.4, p90: 0.85 },
      },
      plate: {
        model: INPAINT_MODEL,
        image: { asset: assetId(0x21), size: { width: 2048, height: 1536 } },
        forMasks: [assetId(0x31), assetId(0x32)],
      },
      autoSubject: 'done',
    },
    style: {
      fry: 0.6,
      colors: 7,
      saturation: 0.62,
      harmony: { kind: 'triadic', strength: 0.5 },
      paletteTargets: [
        { cluster: 1, color: { l: 0.6, c: 0.2, h: 250 } },
        { cluster: 3, color: { l: 0.7, c: 0.15, h: 30 } },
      ],
      bands: 4,
      simplify: 0.52,
      outline: 0.4,
      subjectClarity: 0.6,
      grain: 0.52,
      colorNoise: 0.32,
      grainSize: 2,
      grainHold: 2,
      crunch: 0.42,
      clipping: 0.3,
    },
    symbols: { enabled: true, cellSize: 48, amount: 1 },
    surface: { enabled: true, pattern: 'cracks', relief: 1, refraction: 1, shine: 1, scale: 1 },
    motion: { enabled: true, orbit: 1, loopSeconds: 6, focus: 0.5 },
    lighting: { ambient: 0, relief: 4 },
    objects: [subject, box],
    lights: [...lights],
    provenance: { writer: WRITER, importedOn: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)' },
  };
}

/** Every valid fixture document; together they hold every arm of every union and nullable field. */
export function validDocuments(): readonly SceneDocument[] {
  const autoHarmony: SceneDocument = { ...fiveClusterDocument(), style: { ...fiveClusterDocument().style, harmony: { kind: 'auto', strength: 0.35 } } };
  return [minimalDocument(), fiveClusterDocument(), autoHarmony];
}

// ---------------------------------------------------------------------------
// changing a document as JSON

export type Key = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `path`, or undefined when any step is missing. */
export function getAt(json: unknown, path: readonly Key[]): unknown {
  let node = json;
  for (const key of path) {
    if (Array.isArray(node) && typeof key === 'number') node = node[key];
    else if (isRecord(node) && typeof key === 'string') node = node[key];
    else return undefined;
  }
  return node;
}

/** A deep copy of `json` with the value at `path` replaced; the parent must exist. */
export function setAt(json: unknown, path: readonly Key[], value: unknown): unknown {
  const copy: unknown = structuredClone(json);
  const parent = getAt(copy, path.slice(0, -1));
  const key = path.at(-1);
  if (Array.isArray(parent) && typeof key === 'number') parent[key] = value;
  else if (isRecord(parent) && typeof key === 'string') parent[key] = value;
  else throw new Error(`no parent at ${JSON.stringify(path)}`);
  return copy;
}

/** A deep copy of `json` with each [path, value] pair applied in order. */
export function withValues(json: unknown, changes: readonly (readonly [readonly Key[], unknown])[]): unknown {
  return changes.reduce<unknown>((doc, [path, value]) => setAt(doc, path, value), json);
}

// ---------------------------------------------------------------------------
// invalid variants

/** A document that breaks one invariant, and the path its failure must name, as core/schema.ts's formatPath writes it. */
export type InvalidVariant = { readonly name: string; readonly path: string; readonly json: unknown };

function objectsWithIds(count: number): readonly unknown[] {
  const [first] = fiveClusterDocument().objects;
  return Array.from({ length: count }, (_, i) => ({ ...first, id: uuid(0x1000 + i) }));
}

function lightsWithIds(count: number): readonly unknown[] {
  const [first] = lights;
  return Array.from({ length: count }, (_, i) => ({ ...first, id: uuid(0x2000 + i) }));
}

function clustersOfWeights(weights: readonly number[]): readonly unknown[] {
  return weights.map((weight, i) => ({ lab: { L: i / 20, a: 0, b: 0 }, weight }));
}

/** The invalid variants, each on the five-cluster document. */
export function invalidVariants(): readonly InvalidVariant[] {
  const base = fiveClusterDocument();
  const v = (name: string, path: string, changes: readonly (readonly [readonly Key[], unknown])[]): InvalidVariant => ({
    name,
    path,
    json: withValues(base, changes),
  });
  const target = (cluster: number) => ({ cluster, color: { l: 0.5, c: 0.1, h: 10 } });
  return [
    v('an odd master width', 'frame.master.size.width', [[['frame', 'master', 'size', 'width'], 2047]]),
    v('an odd master height', 'frame.master.size.height', [[['frame', 'master', 'size', 'height'], 1535]]),
    v('a master side above 2048', 'frame.master.size.width', [[['frame', 'master', 'size', 'width'], 2050]]),
    v('two objects with one id', 'objects[1].id', [[['objects', 1, 'id'], OBJECT_IDS[0]]]),
    v('two lights with one id', 'lights[1].id', [[['lights', 1, 'id'], LIGHT_IDS[0]]]),
    v('forMasks out of order', 'analysis.plate.forMasks[1]', [[['analysis', 'plate', 'forMasks'], [assetId(0x32), assetId(0x31)]]]),
    v('focus above its range', 'motion.focus', [[['motion', 'focus'], 1.5]]),
    v('focus below its range', 'motion.focus', [[['motion', 'focus'], -0.1]]),
    v('33 objects', 'objects', [[['objects'], objectsWithIds(33)]]),
    v('5 lights', 'lights', [[['lights'], lightsWithIds(5)]]),
    v('palette targets out of cluster order', 'style.paletteTargets[1].cluster', [[['style', 'paletteTargets'], [target(3), target(1)]]]),
    v('two palette targets on one cluster', 'style.paletteTargets[1].cluster', [[['style', 'paletteTargets'], [target(2), target(2)]]]),
    v('a fractional palette target cluster', 'style.paletteTargets[0].cluster', [[['style', 'paletteTargets'], [target(2.5)]]]),
    v('a negative palette target cluster', 'style.paletteTargets[0].cluster', [[['style', 'paletteTargets'], [target(-1)]]]),
    v(
      'a palette target cluster at analysis.colors.length',
      'style.paletteTargets[1].cluster',
      [[['style', 'paletteTargets'], [target(1), target(5)]]],
    ),
    v('17 palette targets', 'style.paletteTargets', [[['style', 'paletteTargets'], Array.from({ length: 17 }, (_, i) => target(i))]]),
    v('selection.candidate 3', 'objects[0].produced.selection.candidate', [[['objects', 0, 'produced', 'selection', 'candidate'], 3]]),
    v('selection.candidate -1', 'objects[1].produced.selection.candidate', [[['objects', 1, 'produced', 'selection', 'candidate'], -1]]),
    v('a fractional selection.candidate', 'objects[1].produced.selection.candidate', [[['objects', 1, 'produced', 'selection', 'candidate'], 1.5]]),
    v('no color clusters', 'analysis.colors[0]', [[['analysis', 'colors'], []]]),
    v('17 color clusters', 'analysis.colors', [[['analysis', 'colors'], clustersOfWeights(Array.from({ length: 17 }, () => 1 / 17))]]),
    v('clusters not weight-descending', 'analysis.colors[2].weight', [[['analysis', 'colors'], clustersOfWeights([0.4, 0.2, 0.25, 0.1, 0.05])]]),
    v('a cluster of weight 0', 'analysis.colors[4].weight', [[['analysis', 'colors'], clustersOfWeights([0.4, 0.3, 0.15, 0.15, 0])]]),
    v('cluster weights summing to 0.9', 'analysis.colors', [[['analysis', 'colors'], clustersOfWeights([0.4, 0.25, 0.15, 0.05, 0.05])]]),
    v('an object with one color cluster', 'objects[0].produced.color.clusters', [[['objects', 0, 'produced', 'color', 'clusters'], clustersOfWeights([1])]]),
    v(
      'an object with four color clusters',
      'objects[0].produced.color.clusters',
      [[['objects', 0, 'produced', 'color', 'clusters'], clustersOfWeights([0.25, 0.25, 0.25, 0.25])]],
    ),
    v(
      "an object's cluster weights summing to 1.1",
      'objects[1].produced.color.clusters',
      [[['objects', 1, 'produced', 'color', 'clusters'], clustersOfWeights([0.6, 0.5])]],
    ),
    v('an empty title', 'title', [[['title'], '']]),
    v('a title of 81 characters', 'title', [[['title'], 'x'.repeat(81)]]),
    v('a negative seed', 'seed', [[['seed'], -1]]),
    v('a seed of 2^32', 'seed', [[['seed'], 2 ** 32]]),
    v('a fractional seed', 'seed', [[['seed'], 1.5]]),
    v('a fractional colors', 'style.colors', [[['style', 'colors'], 7.5]]),
    v('an odd cellSize', 'symbols.cellSize', [[['symbols', 'cellSize'], 13]]),
    v("a light's chroma above 0.25", 'lights[1].color.c', [[['lights', 1, 'color', 'c'], 0.26]]),
    v('a light past 1.5 of the frame', 'lights[0].at.x', [[['lights', 0, 'at', 'x'], 1.6]]),
    v('a version other than the current one', 'version', [[['version'], SCENE_VERSION + 1]]),
    v('a scene id that is not a UUID v4', 'id', [[['id'], 'scene-1']]),
    v('an uppercase asset id', 'frame.master.asset', [[['frame', 'master', 'asset'], 'A'.repeat(64)]]),
    v('a depth map stored as u8', 'analysis.depth.map.format', [[['analysis', 'depth', 'map', 'format'], 'u8']]),
    v('a mask stored as f32', 'objects[0].produced.mask.format', [[['objects', 0, 'produced', 'mask', 'format'], 'f32']]),
    v('a plane of a format no plane has', 'analysis.depth.map.format', [[['analysis', 'depth', 'map', 'format'], 'f16']]),
    v('a timestamp with an offset', 'createdAt', [[['createdAt'], '2026-10-02T12:00:00+02:00']]),
  ];
}
