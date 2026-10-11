// Frozen version 4 input contract, including its bounds and refinements.
// Deliberately independent of current schema/ranges/migration activation.
// Validate before discarding old produced/plate fields; never sanitize old data.

import {
  isAssetId,
  isBuildId,
  isLightId,
  isModelId,
  isObjectId,
  isSceneId,
  type AssetId,
  type BuildId,
  type LightId,
  type ModelId,
  type ObjectId,
  type SceneId,
} from './ids.ts';
import type { PlaneFormat } from './raster.ts';
import { z } from './zod.ts';

/** `integer` takes whole numbers only, `even-integer` even whole numbers only. */
type NumberKind = 'real' | 'integer' | 'even-integer';

/**
 * Inclusive at both ends, unless `minExclusive` makes the minimum exclusive:
 * then the field must lie above `min`. For an `even-integer` both ends are even.
 */
type NumberRange = { readonly min: number; readonly max: number; readonly kind: NumberKind; readonly minExclusive?: true };

/** An inclusive lower bound on a measured value with no upper bound, which no slider sets. */
type NumberFloor = { readonly min: number; readonly kind: 'real' | 'integer' };

/**
 * Inclusive bounds on an array's length, or on a string's length in Unicode code
 * points, as zod counts it and `[...text].length` counts it: a character outside
 * the Basic Multilingual Plane, such as an emoji, is one code point and two
 * UTF-16 code units of `text.length`.
 */
type LengthRange = { readonly min: number; readonly max: number };

const unit = { min: 0, max: 1, kind: 'real' } as const satisfies NumberRange;
const hue = { min: 0, max: 360, kind: 'real' } as const satisfies NumberRange;
const lightness = unit;
/** A target color's chroma: up to 0.4, above the largest Oklch chroma of any sRGB color (about 0.32, pure magenta). */
const targetChroma = { min: 0, max: 0.4, kind: 'real' } as const satisfies NumberRange;
const masterSide = { min: 2, max: 2048, kind: 'even-integer' } as const satisfies NumberRange;
const tapCoordinate = unit;
const candidate = { min: 0, max: 2, kind: 'integer' } as const satisfies NumberRange;

/**
 * Every bounded numeric field of the scene document, keyed by its path: object
 * keys joined by dots, and `[]` for every element of an array.
 * A field inside a union arm has one path for every arm that holds it.
 */
const RANGES = {
  seed: { min: 0, max: 0xffff_ffff, kind: 'integer' },
  'frame.master.size.width': masterSide,
  'frame.master.size.height': masterSide,

  'analysis.colors[].weight': { min: 0, max: 1, kind: 'real', minExclusive: true },
  'analysis.depth.stats.p10': unit,
  'analysis.depth.stats.median': unit,
  'analysis.depth.stats.p90': unit,

  'style.fry': unit,
  'style.colors': { min: 2, max: 12, kind: 'integer' },
  'style.saturation': unit,
  'style.harmony.strength': unit,
  'style.paletteTargets[].cluster': { min: 0, max: 15, kind: 'integer' },
  'style.paletteTargets[].color.l': lightness,
  'style.paletteTargets[].color.c': targetChroma,
  'style.paletteTargets[].color.h': hue,
  'style.bands': { min: 2, max: 6, kind: 'integer' },
  'style.simplify': unit,
  'style.outline': unit,
  'style.subjectClarity': unit,
  'style.grain': unit,
  'style.colorNoise': unit,
  'style.grainSize': { min: 1, max: 4, kind: 'integer' },
  'style.grainHold': { min: 1, max: 3, kind: 'integer' },
  'style.crunch': unit,
  'style.clipping': unit,

  'symbols.cellSize': { min: 6, max: 48, kind: 'even-integer' },
  'symbols.amount': unit,

  'surface.relief': unit,
  'surface.refraction': unit,
  'surface.shine': unit,
  'surface.scale': unit,

  'motion.drift.amount': unit,
  'motion.parallax': { min: 0.5, max: 3, kind: 'real' },
  'motion.loopSeconds': { min: 2, max: 6, kind: 'real' },
  'motion.focus': unit,

  'lighting.ambient': unit,
  'lighting.relief': { min: 0.25, max: 4, kind: 'real' },

  'objects[].recolor.color.l': lightness,
  'objects[].recolor.color.c': targetChroma,
  'objects[].recolor.color.h': hue,
  'objects[].motion.amount': unit,
  'objects[].thickness': { min: 0.05, max: 2, kind: 'real' },
  'objects[].produced.selection.points[].at.x': tapCoordinate,
  'objects[].produced.selection.points[].at.y': tapCoordinate,
  'objects[].produced.selection.seed.at.x': tapCoordinate,
  'objects[].produced.selection.seed.at.y': tapCoordinate,
  'objects[].produced.selection.candidate': candidate,
  'objects[].produced.depth.p10': unit,
  'objects[].produced.depth.median': unit,
  'objects[].produced.depth.p90': unit,
  'objects[].produced.color.clusters[].weight': unit,

  'lights[].at.x': { min: -0.5, max: 1.5, kind: 'real' },
  'lights[].at.y': { min: -0.5, max: 1.5, kind: 'real' },
  'lights[].depth': unit,
  'lights[].color.l': lightness,
  'lights[].color.c': { min: 0, max: 0.25, kind: 'real' },
  'lights[].color.h': hue,
  'lights[].intensity': { min: 0, max: 2, kind: 'real' },
  'lights[].radius': { min: 0.05, max: 2, kind: 'real' },
  'lights[].rays': unit,
  'lights[].softness': unit,
} as const satisfies Readonly<Record<string, NumberRange>>;

type RangePath = keyof typeof RANGES;

const pixelCount = { min: 1, kind: 'integer' } as const satisfies NumberFloor;
const masterPixels = { min: 0, kind: 'real' } as const satisfies NumberFloor;

/** Every numeric field of the scene document bounded below only, keyed by path as in RANGES. */
const FLOORS = {
  'frame.source.byteLength': { min: 0, kind: 'integer' },
  'frame.original.size.width': pixelCount,
  'frame.original.size.height': pixelCount,
  'analysis.depth.map.size.width': pixelCount,
  'analysis.depth.map.size.height': pixelCount,
  'analysis.plate.image.size.width': pixelCount,
  'analysis.plate.image.size.height': pixelCount,
  'objects[].produced.mask.size.width': pixelCount,
  'objects[].produced.mask.size.height': pixelCount,
  'objects[].produced.bounds.x': masterPixels,
  'objects[].produced.bounds.y': masterPixels,
  'objects[].produced.bounds.width': masterPixels,
  'objects[].produced.bounds.height': masterPixels,
} as const satisfies Readonly<Record<string, NumberFloor>>;

type FloorPath = keyof typeof FLOORS;

/**
 * Every bounded string and array of the scene document, keyed by path as in
 * RANGES. A non-empty array the type declares as `NonEmpty<T>` has its minimum
 * of one from that type, and is listed here only when it has a maximum too.
 */
const LENGTHS = {
  title: { min: 1, max: 80 },
  'frame.original.name': { min: 0, max: 255 },
  'analysis.colors': { min: 1, max: 16 },
  'style.paletteTargets': { min: 0, max: 16 },
  objects: { min: 0, max: 32 },
  'objects[].name': { min: 1, max: 80 },
  'objects[].produced.color.clusters': { min: 2, max: 3 },
  lights: { min: 0, max: 4 },
} as const satisfies Readonly<Record<string, LengthRange>>;

type LengthPath = keyof typeof LENGTHS;


/** How far a set of cluster weights may sum from 1 and still count as summing to 1. */
const WEIGHT_SUM_TOLERANCE = 1e-4;

/** A number inside RANGES[path], whole or even when the entry says so. */
function inRange(path: RangePath): z.ZodNumber {
  const range: NumberRange = RANGES[path];
  const { min, max, kind } = range;
  const bounded = (range.minExclusive === true ? z.number().gt(min) : z.number().min(min)).max(max);
  switch (kind) {
    case 'real':
      return bounded;
    case 'integer':
      return bounded.int();
    case 'even-integer':
      return bounded.int().multipleOf(2);
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** A number at or above FLOORS[path], whole when the entry says so. */
function atLeast(path: FloorPath): z.ZodNumber {
  const { min, kind } = FLOORS[path];
  return kind === 'integer' ? z.number().int().min(min) : z.number().min(min);
}

/** A string whose length in code points lies in LENGTHS[path]. */
function boundedText(path: LengthPath): z.ZodString {
  const { min, max } = LENGTHS[path];
  return z.string().min(min).max(max);
}

/** A string that `check` brands; the brand is earned by the check, never cast. */
function brandedText<T extends string>(check: (text: string) => text is T, what: string) {
  return z.custom<T>((value) => typeof value === 'string' && check(value), { message: `expected ${what}` });
}

const sceneIdSchema = brandedText<SceneId>(isSceneId, 'a lowercase UUID v4');
const objectIdSchema = brandedText<ObjectId>(isObjectId, 'a lowercase UUID v4');
const lightIdSchema = brandedText<LightId>(isLightId, 'a lowercase UUID v4');
const assetIdSchema = brandedText<AssetId>(isAssetId, '64 lowercase hex digits');
const modelIdSchema = brandedText<ModelId>(isModelId, "'<model name>@<64 lowercase hex digits>'");
const buildIdSchema = brandedText<BuildId>(isBuildId, "a build id, '<commit>-<yyyymmdd>'");

const timestampSchema = z.iso.datetime();

/** The scene's title: 1 to 80 code points (LENGTHS). */
const titleSchema = boundedText('title');

/** A size in pixels, both sides whole and at least 1 (FLOORS). */
function size(width: FloorPath, height: FloorPath) {
  return z.strictObject({ width: atLeast(width), height: atLeast(height) }).readonly();
}

const oklabSchema = z.strictObject({ L: z.number(), a: z.number(), b: z.number() }).readonly();

function oklch(l: RangePath, c: RangePath, h: RangePath) {
  return z.strictObject({ l: inRange(l), c: inRange(c), h: inRange(h) }).readonly();
}

/**
 * A PlaneRef whose format must be `format`: the type stays PlaneRef, with every
 * PlaneFormat, and the field's one format is a check.
 */
function planeRef(format: PlaneFormat, width: FloorPath, height: FloorPath) {
  return z
    .strictObject({
      asset: assetIdSchema,
      format: z.enum(['u8', 'f32']).refine((value) => value === format, { message: `expected '${format}'` }),
      size: size(width, height),
    })
    .readonly();
}

function colorCluster(weight: RangePath) {
  return z.strictObject({ lab: oklabSchema, weight: inRange(weight) }).readonly();
}

function depthStats(p10: RangePath, median: RangePath, p90: RangePath) {
  return z.strictObject({ p10: inRange(p10), median: inRange(median), p90: inRange(p90) }).readonly();
}

function sumsToOne(clusters: readonly { readonly weight: number }[]): boolean {
  const sum = clusters.reduce((total, cluster) => total + cluster.weight, 0);
  return Math.abs(sum - 1) <= WEIGHT_SUM_TOLERANCE;
}

// ---------------------------------------------------------------------------
// frame

const sourceRefSchema = z
  .strictObject({ asset: assetIdSchema, mediaType: z.string(), byteLength: atLeast('frame.source.byteLength') })
  .readonly();

/** The master's sides are even, and at most 2048, so its long edge is at most 2048. */
const masterSchema = z
  .strictObject({
    asset: assetIdSchema,
    size: z.strictObject({ width: inRange('frame.master.size.width'), height: inRange('frame.master.size.height') }).readonly(),
  })
  .readonly();

const frameSchema = z
  .strictObject({
    source: sourceRefSchema.nullable(),
    master: masterSchema,
    original: z
      .strictObject({
        name: boundedText('frame.original.name'),
        mediaType: z.string(),
        size: size('frame.original.size.width', 'frame.original.size.height'),
      })
      .readonly(),
  })
  .readonly();

// ---------------------------------------------------------------------------
// analysis

const colorClusterSchema = colorCluster('analysis.colors[].weight');

/** 1 to 16 clusters, weight-descending, the weights summing to 1; RANGES holds every weight above 0. */
const analysisColorsSchema = z
  .tuple([colorClusterSchema], colorClusterSchema)
  .check(z.minLength(LENGTHS['analysis.colors'].min), z.maxLength(LENGTHS['analysis.colors'].max))
  .readonly()
  .superRefine((colors, ctx) => {
    colors.forEach((cluster, i) => {
      const previous = colors[i - 1];
      if (previous !== undefined && cluster.weight > previous.weight) {
        ctx.addIssue({ code: 'custom', path: [i, 'weight'], message: 'clusters must be in descending order of weight' });
      }
    });
    if (!sumsToOne(colors)) ctx.addIssue({ code: 'custom', path: [], message: `cluster weights must sum to 1 within ${WEIGHT_SUM_TOLERANCE}` });
  });

const toneStatsSchema = z
  .strictObject({ p01: z.number(), p05: z.number(), p50: z.number(), p95: z.number(), p99: z.number() })
  .readonly();

const depthStatsSchema = depthStats('analysis.depth.stats.p10', 'analysis.depth.stats.median', 'analysis.depth.stats.p90');

const depthProductSchema = z
  .strictObject({
    model: modelIdSchema,
    map: planeRef('f32', 'analysis.depth.map.size.width', 'analysis.depth.map.size.height'),
    stats: depthStatsSchema,
  })
  .readonly();

/** Sorted, so that a fill computed for the same masks compares equal; equal ids may repeat. */
const forMasksSchema = z
  .array(assetIdSchema)
  .readonly()
  .superRefine((masks, ctx) => {
    masks.forEach((mask, i) => {
      const previous = masks[i - 1];
      if (previous !== undefined && mask < previous) ctx.addIssue({ code: 'custom', path: [i], message: 'mask ids must be sorted' });
    });
  });

const plateProductSchema = z
  .strictObject({
    model: modelIdSchema,
    image: z
      .strictObject({ asset: assetIdSchema, size: size('analysis.plate.image.size.width', 'analysis.plate.image.size.height') })
      .readonly(),
    forMasks: forMasksSchema,
  })
  .readonly();

const analysisSchema = z
  .strictObject({
    colors: analysisColorsSchema,
    tone: toneStatsSchema,
    depth: depthProductSchema.nullable(),
    plate: plateProductSchema.nullable(),
    autoSubject: z.enum(['pending', 'done']),
  })
  .readonly();

// ---------------------------------------------------------------------------
// style

const harmonyTemplateSchema = z.enum(['analogous', 'complementary', 'split-complementary', 'triadic']);

const harmonySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('off') }),
    z.strictObject({ kind: z.literal('auto'), strength: inRange('style.harmony.strength') }),
    z.strictObject({ kind: harmonyTemplateSchema, strength: inRange('style.harmony.strength') }),
  ])
  .readonly();

const paletteTargetSchema = z
  .strictObject({
    cluster: inRange('style.paletteTargets[].cluster'),
    color: oklch('style.paletteTargets[].color.l', 'style.paletteTargets[].color.c', 'style.paletteTargets[].color.h'),
  })
  .readonly();

/** Sorted by cluster with no cluster twice; the bound by analysis.colors.length is checked on the document. */
const paletteTargetsSchema = z
  .array(paletteTargetSchema)
  .min(LENGTHS['style.paletteTargets'].min)
  .max(LENGTHS['style.paletteTargets'].max)
  .readonly()
  .superRefine((targets, ctx) => {
    targets.forEach((target, i) => {
      const previous = targets[i - 1];
      if (previous !== undefined && target.cluster <= previous.cluster) {
        ctx.addIssue({ code: 'custom', path: [i, 'cluster'], message: 'palette targets must be sorted by cluster, each cluster once' });
      }
    });
  });

const styleSchema = z
  .strictObject({
    fry: inRange('style.fry'),
    colors: inRange('style.colors'),
    saturation: inRange('style.saturation'),
    harmony: harmonySchema,
    paletteTargets: paletteTargetsSchema,
    bands: inRange('style.bands'),
    simplify: inRange('style.simplify'),
    outline: inRange('style.outline'),
    subjectClarity: inRange('style.subjectClarity'),
    grain: inRange('style.grain'),
    colorNoise: inRange('style.colorNoise'),
    grainSize: inRange('style.grainSize'),
    grainHold: inRange('style.grainHold'),
    crunch: inRange('style.crunch'),
    clipping: inRange('style.clipping'),
  })
  .readonly();

// ---------------------------------------------------------------------------
// symbols, surface, motion, lighting

const symbolsSchema = z
  .strictObject({ enabled: z.boolean(), cellSize: inRange('symbols.cellSize'), amount: inRange('symbols.amount') })
  .readonly();

const surfaceSchema = z
  .strictObject({
    enabled: z.boolean(),
    pattern: z.enum(['bars', 'cracks', 'scales']),
    relief: inRange('surface.relief'),
    refraction: inRange('surface.refraction'),
    shine: inRange('surface.shine'),
    scale: inRange('surface.scale'),
  })
  .readonly();

const motionSchema = z
  .strictObject({
    enabled: z.boolean(),
    drift: z.strictObject({ direction: z.enum(['side', 'vertical', 'circle']), amount: inRange('motion.drift.amount') }).readonly(),
    parallax: inRange('motion.parallax'),
    loopSeconds: inRange('motion.loopSeconds'),
    focus: inRange('motion.focus').nullable(),
  })
  .readonly();

const lightingSchema = z.strictObject({ ambient: inRange('lighting.ambient'), relief: inRange('lighting.relief') }).readonly();

// ---------------------------------------------------------------------------
// objects

function tapPoint(x: RangePath, y: RangePath) {
  return z
    .strictObject({ at: z.strictObject({ x: inRange(x), y: inRange(y) }).readonly(), label: z.enum(['include', 'exclude']) })
    .readonly();
}

const tapPointSchema = tapPoint('objects[].produced.selection.points[].at.x', 'objects[].produced.selection.points[].at.y');

const selectionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('taps'),
      points: z.tuple([tapPointSchema], tapPointSchema).readonly(),
      candidate: inRange('objects[].produced.selection.candidate'),
      size: z.number().min(0).max(1).optional(),
    }),
    z.strictObject({
      kind: z.literal('auto-subject'),
      seed: tapPoint('objects[].produced.selection.seed.at.x', 'objects[].produced.selection.seed.at.y'),
      candidate: inRange('objects[].produced.selection.candidate'),
      size: z.number().min(0).max(1).optional(),
    }),
  ])
  .readonly();

const objectClusterSchema = colorCluster('objects[].produced.color.clusters[].weight');

/** 2 or 3 clusters whose weights sum to 1. */
const objectColorSchema = z
  .strictObject({
    mean: oklabSchema,
    clusters: z
      .tuple([objectClusterSchema], objectClusterSchema)
      .check(z.minLength(LENGTHS['objects[].produced.color.clusters'].min), z.maxLength(LENGTHS['objects[].produced.color.clusters'].max))
      .readonly()
      .superRefine((clusters, ctx) => {
        if (!sumsToOne(clusters)) ctx.addIssue({ code: 'custom', path: [], message: `cluster weights must sum to 1 within ${WEIGHT_SUM_TOLERANCE}` });
      }),
  })
  .readonly();

const objectProducedSchema = z
  .strictObject({
    model: modelIdSchema,
    selection: selectionSchema,
    mask: planeRef('u8', 'objects[].produced.mask.size.width', 'objects[].produced.mask.size.height'),
    bounds: z
      .strictObject({
        x: atLeast('objects[].produced.bounds.x'),
        y: atLeast('objects[].produced.bounds.y'),
        width: atLeast('objects[].produced.bounds.width'),
        height: atLeast('objects[].produced.bounds.height'),
      })
      .readonly(),
    depth: depthStats('objects[].produced.depth.p10', 'objects[].produced.depth.median', 'objects[].produced.depth.p90').nullable(),
    color: objectColorSchema,
  })
  .readonly();

const recolorSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('target'),
      color: oklch('objects[].recolor.color.l', 'objects[].recolor.color.c', 'objects[].recolor.color.h'),
    }),
  ])
  .readonly();

const objectMotionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.enum(['wobble', 'bob', 'sway']), amount: inRange('objects[].motion.amount') }),
  ])
  .readonly();

const sceneObjectSchema = z
  .strictObject({
    id: objectIdSchema,
    name: boundedText('objects[].name'),
    hidden: z.boolean().default(false),
    subject: z.boolean(),
    recolor: recolorSchema,
    symbols: z.enum(['slider', 'always', 'never']),
    motion: objectMotionSchema,
    thickness: inRange('objects[].thickness'),
    produced: objectProducedSchema,
  })
  .readonly();

// ---------------------------------------------------------------------------
// lights

const lightSchema = z
  .strictObject({
    id: lightIdSchema,
    at: z.strictObject({ x: inRange('lights[].at.x'), y: inRange('lights[].at.y') }).readonly(),
    depth: inRange('lights[].depth'),
    color: oklch('lights[].color.l', 'lights[].color.c', 'lights[].color.h'),
    intensity: inRange('lights[].intensity'),
    radius: inRange('lights[].radius'),
    rays: inRange('lights[].rays'),
    shadows: z.boolean(),
    softness: inRange('lights[].softness'),
  })
  .readonly();

/** Reports every element after the first whose id an earlier element already has. */
function uniqueIds(items: readonly { readonly id: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'ids must be unique' });
    seen.add(item.id);
  });
}

// ---------------------------------------------------------------------------
// the document

/**
 * The strict schema of the scene document at `version`.
 * The version is a literal, so a document at any other version fails; the
 * parse chain builds this with its migration table's length.
 * The check that reads two subtrees, a palette target's cluster below
 * analysis.colors.length, runs only when zod reached the end of the document
 * without an issue that stops it: a field missing, of the wrong type, or not an
 * allowed value (a literal, an enum member, a union's kind, an id its check
 * accepts), a fraction where a whole number is required, or an array shorter
 * than its minimum skips it, so a document broken in several places may report
 * that problem only once the others are fixed.
 */
function sceneDocumentSchema<const V extends number>(version: V) {
  return z
    .strictObject({
      format: z.literal('noisy-scene'),
      version: z.literal(version),
      id: sceneIdSchema,
      title: titleSchema,
      createdAt: timestampSchema,
      updatedAt: timestampSchema,
      seed: inRange('seed'),
      frame: frameSchema,
      analysis: analysisSchema,
      style: styleSchema,
      symbols: symbolsSchema,
      surface: surfaceSchema,
      motion: motionSchema,
      lighting: lightingSchema,
      objects: z
        .array(sceneObjectSchema)
        .min(LENGTHS.objects.min)
        .max(LENGTHS.objects.max)
        .readonly()
        .superRefine((objects, ctx) => uniqueIds(objects, ctx)),
      lights: z
        .array(lightSchema)
        .min(LENGTHS.lights.min)
        .max(LENGTHS.lights.max)
        .readonly()
        .superRefine((lights, ctx) => uniqueIds(lights, ctx)),
      provenance: z.strictObject({ writer: buildIdSchema, importedOn: z.string() }).readonly(),
    })
    .readonly()
    .superRefine((document, ctx) => {
      const clusters = document.analysis.colors.length;
      document.style.paletteTargets.forEach((target, i) => {
        if (target.cluster >= clusters) {
          ctx.addIssue({
            code: 'custom',
            path: ['style', 'paletteTargets', i, 'cluster'],
            message: `a palette target's cluster must be below analysis.colors.length (${clusters})`,
          });
        }
      });
    });
}


/** Frozen pre-transform validator. Optional legacy size/hidden stay as v4 accepted them. */
export const legacyV4DocumentSchema = sceneDocumentSchema(4);

/** Strict historical shapes before running even the old 0-to-4 steps. */
export function legacyDocumentSchema(version: 0 | 1 | 2 | 3 | 4): z.ZodType<unknown> {
  const current = sceneDocumentSchema(version).unwrap();
  if (version === 4) return current.readonly();
  const motion = motionSchema.unwrap().omit({ drift: true });
  const oldMotion = version < 2
    ? motion.omit({ parallax: true }).extend({ orbit: z.number().min(0).max(1) }).readonly()
    : motion.extend({ orbit: z.number().min(0).max(1) }).readonly();
  const oldObject = sceneObjectSchema.unwrap().omit({ hidden: true }).extend({ name: boundedText('objects[].name').optional() }).readonly();
  const oldObjects = version < 3
    ? z.array(oldObject).max(LENGTHS.objects.max).readonly().superRefine(uniqueIds)
    : current.shape.objects;
  const old = { ...current.shape, motion: oldMotion, objects: oldObjects };
  // omit() cannot drop fields from an object with refinements. Rebuild the
  // strict shape and keep the palette cross-reference check explicitly.
  const { surface: _surface, ...withoutSurface } = old;
  return z.strictObject(version === 0 ? withoutSurface : old).readonly().superRefine((doc, ctx) => {
    doc.style.paletteTargets.forEach((target, i) => {
      if (target.cluster >= doc.analysis.colors.length) ctx.addIssue({ code: 'custom', path: ['style', 'paletteTargets', i, 'cluster'], message: 'cluster must exist in analysis.colors' });
    });
  });
}
