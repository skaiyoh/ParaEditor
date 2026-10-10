// The scene document's shape: the one strict schema whose inferred types
// core/types.ts exports. Every object is strict, so an unknown key at any
// depth fails with its path and nothing is dropped; every numeric bound and
// every bound on a string's or an array's length comes from core/ranges.ts;
// and the invariants the types cannot express are refinements here, each
// reported at the path of the field that broke it. The parse chain the store
// and the scene file share wraps it: peek at the version, migrate, then the
// strict parse, returning a Result for any JSON value and never throwing.
// Pure: no browser global, no Node API, no I/O.

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
import { MIGRATIONS, SCENE_VERSION, type Migration } from './migrate.ts';
import { FLOORS, LENGTHS, RANGES, type FloorPath, type LengthPath, type NumberRange, type RangePath } from './ranges.ts';
import type { PlaneFormat } from './raster.ts';
import { err, ok, type Result } from './result.ts';
import type { SceneDocument, SceneDocumentAt } from './types.ts';
import { z } from './zod.ts';

/** How far a set of cluster weights may sum from 1 and still count as summing to 1. */
export const WEIGHT_SUM_TOLERANCE = 1e-4;

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
export const titleSchema = boundedText('title');

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

export const sourceRefSchema = z
  .strictObject({ asset: assetIdSchema, mediaType: z.string(), byteLength: atLeast('frame.source.byteLength') })
  .readonly();

/** The master's sides are even, and at most 2048, so its long edge is at most 2048. */
const masterSchema = z
  .strictObject({
    asset: assetIdSchema,
    size: z.strictObject({ width: inRange('frame.master.size.width'), height: inRange('frame.master.size.height') }).readonly(),
  })
  .readonly();

export const frameSchema = z
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

export const colorClusterSchema = colorCluster('analysis.colors[].weight');

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

export const toneStatsSchema = z
  .strictObject({ p01: z.number(), p05: z.number(), p50: z.number(), p95: z.number(), p99: z.number() })
  .readonly();

export const depthStatsSchema = depthStats('analysis.depth.stats.p10', 'analysis.depth.stats.median', 'analysis.depth.stats.p90');

export const depthProductSchema = z
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

export const plateProductSchema = z
  .strictObject({
    model: modelIdSchema,
    image: z
      .strictObject({ asset: assetIdSchema, size: size('analysis.plate.image.size.width', 'analysis.plate.image.size.height') })
      .readonly(),
    forMasks: forMasksSchema,
  })
  .readonly();

export const analysisSchema = z
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

export const harmonyTemplateSchema = z.enum(['analogous', 'complementary', 'split-complementary', 'triadic']);

export const harmonySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('off') }),
    z.strictObject({ kind: z.literal('auto'), strength: inRange('style.harmony.strength') }),
    z.strictObject({ kind: harmonyTemplateSchema, strength: inRange('style.harmony.strength') }),
  ])
  .readonly();

export const paletteTargetSchema = z
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

export const styleSchema = z
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

export const symbolsSchema = z
  .strictObject({ enabled: z.boolean(), cellSize: inRange('symbols.cellSize'), amount: inRange('symbols.amount') })
  .readonly();

export const surfaceSchema = z
  .strictObject({
    enabled: z.boolean(),
    pattern: z.enum(['bars', 'cracks', 'scales']),
    relief: inRange('surface.relief'),
    refraction: inRange('surface.refraction'),
    shine: inRange('surface.shine'),
    scale: inRange('surface.scale'),
  })
  .readonly();

export const motionSchema = z
  .strictObject({
    enabled: z.boolean(),
    orbit: inRange('motion.orbit'),
    parallax: inRange('motion.parallax'),
    loopSeconds: inRange('motion.loopSeconds'),
    focus: inRange('motion.focus').nullable(),
  })
  .readonly();

export const lightingSchema = z.strictObject({ ambient: inRange('lighting.ambient'), relief: inRange('lighting.relief') }).readonly();

// ---------------------------------------------------------------------------
// objects

function tapPoint(x: RangePath, y: RangePath) {
  return z
    .strictObject({ at: z.strictObject({ x: inRange(x), y: inRange(y) }).readonly(), label: z.enum(['include', 'exclude']) })
    .readonly();
}

export const tapPointSchema = tapPoint('objects[].produced.selection.points[].at.x', 'objects[].produced.selection.points[].at.y');

export const selectionSchema = z
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
export const objectColorSchema = z
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

export const objectProducedSchema = z
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

export const recolorSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('target'),
      color: oklch('objects[].recolor.color.l', 'objects[].recolor.color.c', 'objects[].recolor.color.h'),
    }),
  ])
  .readonly();

export const objectMotionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.enum(['wobble', 'bob', 'sway']), amount: inRange('objects[].motion.amount') }),
  ])
  .readonly();

export const sceneObjectSchema = z
  .strictObject({
    id: objectIdSchema,
    name: boundedText('objects[].name'),
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

export const lightSchema = z
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
export function sceneDocumentSchema<const V extends number>(version: V) {
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

/** The schema of the current version, SCENE_VERSION. */
export const currentDocumentSchema = sceneDocumentSchema(SCENE_VERSION);

// ---------------------------------------------------------------------------
// issues as text

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A key path as text: `objects[0].produced.mask`, with a key that is not an identifier quoted, and `(document)` for the root. */
export function formatPath(path: readonly PropertyKey[]): string {
  let text = '';
  for (const key of path) {
    if (typeof key === 'number') text += `[${key}]`;
    else if (typeof key === 'symbol') text += `[${String(key)}]`;
    else if (IDENTIFIER.test(key)) text += text === '' ? key : `.${key}`;
    else text += `[${JSON.stringify(key)}]`;
  }
  return text === '' ? '(document)' : text;
}

/**
 * One line of text listing the path of every issue of a parse, `; `-separated, in
 * the order zod reports them; an unknown key is listed at its own path.
 */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const lines = issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => `${formatPath([...issue.path, key])}: unknown key`)
      : [`${formatPath(issue.path)}: ${issue.message}`],
  );
  return lines.join('; ');
}

// ---------------------------------------------------------------------------
// the parse chain

/** Why a value did not parse as a scene document. */
export type ParseError =
  | { readonly kind: 'not-a-scene' }
  | { readonly kind: 'newer-version'; readonly version: number; readonly writer: BuildId | null }
  /** A migration that threw or returned no object, or a strict-parse failure listing every failing path. */
  | { readonly kind: 'invalid'; readonly detail: string };

/** What `peekVersion` reads before anything else: the version, and the build that wrote the document when it says so. */
export type VersionPeek = { readonly version: number; readonly writer: BuildId | null };

/**
 * The two fields that make a value a scene at all. The version is any whole
 * number of at least 0, with no upper bound (`z.int()` would stop at
 * Number.MAX_SAFE_INTEGER), so every larger one is newer, not a non-scene.
 * Not strict: the peek ignores every other key.
 */
const versionHeaderSchema = z.object({
  format: z.literal('noisy-scene'),
  version: z
    .number()
    .nonnegative()
    .refine((version) => Number.isInteger(version)),
});
const writerSchema = z.object({ provenance: z.object({ writer: buildIdSchema }) });

/**
 * Reads `format`, `version`, and `provenance.writer`, and nothing else:
 * `format` must be 'noisy-scene' and `version` a whole number of at least 0,
 * else the value is not a scene. The writer's build id is read best-effort,
 * null when it is absent or not a build id. A value whose getters or proxy
 * traps throw while these are read is not a scene, and its writer is null.
 */
export function peekVersion(json: unknown): Result<VersionPeek, { readonly kind: 'not-a-scene' }> {
  let version: number;
  try {
    const header = versionHeaderSchema.safeParse(json);
    if (!header.success) return err({ kind: 'not-a-scene' });
    version = header.data.version;
  } catch {
    return err({ kind: 'not-a-scene' });
  }
  let writer: BuildId | null;
  try {
    const parsed = writerSchema.safeParse(json);
    writer = parsed.success ? parsed.data.provenance.writer : null;
  } catch {
    writer = null;
  }
  return ok({ version, writer });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A thrown value as text, without letting a hostile value throw again. */
function describeThrown(thrown: unknown): string {
  try {
    return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : `a thrown ${thrown === null ? 'null' : typeof thrown}`;
  } catch {
    return 'a value that could not be described';
  }
}

/**
 * A deep copy of a JSON value: arrays and objects are copied, and every other
 * value is kept as it is. It reads each property once, so a getter that throws,
 * a proxy trap that throws, or a cycle (which overflows the stack) throws here.
 */
function copyJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, copyJson(inner)]));
  }
  return value;
}

/**
 * Runs migrations[from], migrations[from + 1], ... in order, on a copy of the
 * input, so a migration that writes to its argument never reaches the caller's
 * value. migrations[v] must return the document at version v + 1, its
 * `version` field included. A migration that throws, returns null, an array,
 * or a primitive, or returns an object whose `version` is not v + 1, fails the
 * walk as `invalid`, naming its index.
 */
function migrate(migrations: readonly Migration[], from: number, json: unknown): Result<unknown, ParseError> {
  if (from >= migrations.length) return ok(json);
  let current: unknown;
  try {
    current = copyJson(json);
  } catch (thrown) {
    return err({ kind: 'invalid', detail: `the document could not be copied for its migrations: ${describeThrown(thrown)}` });
  }
  for (let v = from; v < migrations.length; v++) {
    const migration = migrations[v];
    const step = `migration ${v} (version ${v} to ${v + 1})`;
    if (migration === undefined) return err({ kind: 'invalid', detail: `migration ${v} is missing` });
    try {
      const next = migration(current);
      if (!isRecord(next)) return err({ kind: 'invalid', detail: `${step} returned no object` });
      if (next['version'] !== v + 1) return err({ kind: 'invalid', detail: `${step} returned a document whose version is not ${v + 1}` });
      current = next;
    } catch (thrown) {
      return err({ kind: 'invalid', detail: `${step} threw ${describeThrown(thrown)}` });
    }
  }
  return ok(current);
}

/**
 * The strict parse, its issues as one `invalid` detail. A throw from inside
 * the parse becomes `invalid` too: zod copies a field's issues into its parent
 * with one spread call, so an array holding enough malformed elements (about
 * 15,500 empty objects as `objects`, under node 25) overflows the engine's limit
 * on a call's arguments, and a getter or proxy trap may throw while it reads.
 */
function parseStrict<T>(schema: z.ZodType<T>, json: unknown): Result<T, ParseError> {
  try {
    const parsed = schema.safeParse(json);
    return parsed.success ? ok(parsed.data) : err({ kind: 'invalid', detail: describeIssues(parsed.error.issues) });
  } catch (thrown) {
    return err({ kind: 'invalid', detail: `the strict parse threw ${describeThrown(thrown)}` });
  }
}

/**
 * The parse chain for a migration table, whose length is the version it parses
 * to. A value that is not a scene is `not-a-scene`; a version above the table's
 * length is `newer-version`, with the writer; an older document runs every
 * migration from its version up; then the strict schema of the table's version
 * parses the result, and its issues become one `invalid` detail listing every
 * failing path. An unknown key fails the parse and nothing is dropped.
 * Never throws, for any JSON value; a value whose getters or proxy traps throw
 * is answered as well. Production code imports only the bound
 * `parseDocument`; a test passes another table here.
 */
export function parseDocumentWith<const M extends readonly Migration[]>(
  migrations: M,
): (json: unknown) => Result<SceneDocumentAt<M['length']>, ParseError> {
  const schema = sceneDocumentSchema(migrations.length);
  return (json) => {
    const peek = peekVersion(json);
    if (!peek.ok) return err(peek.error);
    const { version, writer } = peek.value;
    if (version > migrations.length) return err({ kind: 'newer-version', version, writer });
    const migrated = migrate(migrations, version, json);
    if (!migrated.ok) return err(migrated.error);
    return parseStrict(schema, migrated.value);
  };
}

/** The parse chain of `core/migrate.ts`'s table: what the store and the scene file call. */
const parseVersionedDocument = parseDocumentWith(MIGRATIONS);
export const parseDocument: (json: unknown) => Result<SceneDocument, ParseError> = (json) => {
  const result = parseVersionedDocument(json);
  if (!result.ok || result.value.objects.every((object) => object.produced.selection.size !== undefined)) return result;
  // Additive migration at the persisted-document boundary, never in reducer products.
  // The existing version stays readable; a future versioned migration can absorb this default.
  return parseVersionedDocument({ ...result.value, objects: result.value.objects.map((object) => ({
    ...object, produced: { ...object.produced, selection: { ...object.produced.selection, size: object.produced.selection.size ?? 0.5 } },
  })) });
};
