// The scene document's shape: the strict schema against the ranges table, the
// invariants the types cannot express, unknown keys at every depth, the round
// trip that drops nothing, and the version's type-level guard.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NonEmpty, SceneId } from '../src/core/ids.ts';
import { MIGRATIONS, SCENE_VERSION, type Migration } from '../src/core/migrate.ts';
import { FLOORS, LENGTHS, RANGES, type FloorPath, type LengthPath, type NumberRange, type RangePath } from '../src/core/ranges.ts';
import type { ImagePoint, ImageRef, Oklab, Oklch, PlaneRef, Rect, Size } from '../src/core/raster.ts';
import { currentDocumentSchema as activeDocumentSchema, describeIssues, formatPath, parseDocument as parseActiveDocument, parseLegacyDocument as parseDocument, sceneDocumentSchema, selectionSchema } from '../src/core/schema.ts';
import { legacyV4DocumentSchema as currentDocumentSchema } from '../src/core/legacy-schema.ts';
import type {
  LegacyAnalysis as Analysis,
  LegacySceneDocument,
  SceneDocument as ActiveSceneDocument,
  Frame,
  Light,
  LegacyObjectProduced as ObjectProduced,
  PaletteTarget,
  LegacyPlateProduct as PlateProduct,
  Recolor,
  LegacySceneDocument as SceneDocument,
  SceneDocumentAt,
  TapPoint,
} from '../src/core/types.ts';
import { z } from '../src/core/zod.ts';
import { assetId, legacyFiveClusterDocument as fiveClusterDocument, getAt, invalidVariants, legacyMinimalDocument as minimalDocument, minimalDocument as activeMinimalDocument, setAt, type Key } from './fixtures/documents.ts';

type DepthProduct = NonNullable<LegacySceneDocument['analysis']['depth']>;
function validDocuments(): readonly SceneDocument[] {
  const doc = fiveClusterDocument();
  return [minimalDocument(), doc, { ...doc, style: { ...doc.style, harmony: { kind: 'auto', strength: .35 } } }];
}

/** The paths of every issue a parse of `json` reports, unknown keys at their own paths; empty when it parses. */
function failingPaths(json: unknown): readonly string[] {
  const result = currentDocumentSchema.safeParse(json);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys.map((key) => formatPath([...issue.path, key])) : [formatPath(issue.path)],
  );
}

function detailOf(json: unknown): string {
  const result = currentDocumentSchema.safeParse(json);
  assert.ok(!result.success, 'expected the parse to fail');
  return describeIssues(result.error.issues);
}

// ---------------------------------------------------------------------------
// the ranges table against the schema

type Leaf = { readonly path: string; readonly node: Readonly<Record<string, unknown>> };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every node of a JSON Schema with the document path it describes: object keys joined by dots, `[]` for array elements. */
function walkJsonSchema(node: unknown, path: string, out: Leaf[]): void {
  if (!isRecord(node)) return;
  out.push({ path, node });
  const { properties, items, prefixItems, anyOf, oneOf, allOf } = node;
  if (isRecord(properties)) {
    for (const [key, child] of Object.entries(properties)) walkJsonSchema(child, path === '' ? key : `${path}.${key}`, out);
  }
  walkJsonSchema(items, `${path}[]`, out);
  for (const list of [prefixItems, anyOf, oneOf, allOf]) {
    if (Array.isArray(list)) for (const child of list) walkJsonSchema(child, list === prefixItems ? `${path}[]` : path, out);
  }
}

function typesOf(node: Readonly<Record<string, unknown>>): readonly unknown[] {
  return Array.isArray(node['type']) ? node['type'] : [node['type']];
}

const isRangePath = (path: string): path is RangePath => Object.hasOwn(RANGES, path);
const isFloorPath = (path: string): path is FloorPath => Object.hasOwn(FLOORS, path);
const isLengthPath = (path: string): path is LengthPath => Object.hasOwn(LENGTHS, path);

const documentNodes = (): readonly Leaf[] => {
  const out: Leaf[] = [];
  walkJsonSchema(z.toJSONSchema(currentDocumentSchema, { unrepresentable: 'any' }), '', out);
  return out;
};

/** Numeric fields with no bound at all: the Oklab values and tone percentiles that analysis measures. */
const UNBOUNDED_NUMBERS = new Set([
  'analysis.colors[].lab.L',
  'analysis.colors[].lab.a',
  'analysis.colors[].lab.b',
  'analysis.tone.p01',
  'analysis.tone.p05',
  'analysis.tone.p50',
  'analysis.tone.p95',
  'analysis.tone.p99',
  'objects[].produced.color.mean.L',
  'objects[].produced.color.mean.a',
  'objects[].produced.color.mean.b',
  'objects[].produced.color.clusters[].lab.L',
  'objects[].produced.color.clusters[].lab.a',
  'objects[].produced.color.clusters[].lab.b',
]);

/** The bounds a JSON Schema number node must carry for a field of this entry; an integer with no maximum gets zod's safe-integer one. */
function expectedBounds(entry: NumberRange | (typeof FLOORS)[FloorPath] | undefined): Readonly<Record<string, unknown>> {
  if (entry === undefined) return { minimum: undefined, exclusiveMinimum: undefined, maximum: undefined, multipleOf: undefined, integer: false };
  if (!('max' in entry)) {
    const integer = entry.kind === 'integer';
    return { minimum: entry.min, exclusiveMinimum: undefined, maximum: integer ? Number.MAX_SAFE_INTEGER : undefined, multipleOf: undefined, integer };
  }
  const exclusive = entry.minExclusive === true;
  return {
    minimum: exclusive ? undefined : entry.min,
    exclusiveMinimum: exclusive ? entry.min : undefined,
    maximum: entry.max,
    multipleOf: entry.kind === 'even-integer' ? 2 : undefined,
    integer: entry.kind !== 'real',
  };
}

test('every numeric bound of the schema equals its RANGES or FLOORS entry, and every entry is used', () => {
  const used = new Set<string>();
  const numeric = documentNodes().filter(({ node }) => typesOf(node).some((t) => t === 'number' || t === 'integer') && !('const' in node));
  assert.ok(numeric.length > 0);
  for (const { path, node } of numeric) {
    // SEL1 owns this additive field without changing the foundation's range table.
    const selectionSize = path === 'objects[].produced.selection.size';
    const entry = selectionSize ? { min: 0, max: 1, kind: 'real' } satisfies NumberRange
      : isRangePath(path) ? RANGES[path] : isFloorPath(path) ? FLOORS[path] : undefined;
    if (entry === undefined) assert.ok(UNBOUNDED_NUMBERS.has(path), `${path} has no RANGES or FLOORS entry and is not listed as unbounded`);
    else if (!selectionSize) used.add(path);
    const actual = {
      minimum: node['minimum'],
      exclusiveMinimum: node['exclusiveMinimum'],
      maximum: node['maximum'],
      multipleOf: node['multipleOf'],
      integer: typesOf(node).includes('integer'),
    };
    assert.deepEqual(actual, expectedBounds(entry), path);
    assert.equal(node['exclusiveMaximum'], undefined, `${path} exclusiveMaximum`);
  }
  assert.deepEqual([...used].sort(), [...Object.keys(RANGES), ...Object.keys(FLOORS)].sort(), 'every RANGES and FLOORS entry bounds a field of the schema');
  for (const path of UNBOUNDED_NUMBERS) assert.ok(numeric.some((leaf) => leaf.path === path), `${path} is a numeric field of the schema`);
});

test('every RANGES entry is well formed', () => {
  for (const [path, range] of Object.entries(RANGES)) {
    assert.ok(range.min < range.max, path);
    if (range.kind !== 'real') assert.ok(Number.isInteger(range.min) && Number.isInteger(range.max), path);
    if (range.kind === 'even-integer') assert.ok(range.min % 2 === 0 && range.max % 2 === 0, path);
  }
  for (const [path, range] of Object.entries(LENGTHS)) assert.ok(Number.isInteger(range.min) && range.min >= 0 && range.min < range.max, path);
  for (const path of Object.keys(FLOORS)) assert.ok(!isRangePath(path), `${path} is in RANGES and FLOORS`);
});

test('a string length bound counts Unicode code points, so an emoji counts once', () => {
  const emoji = '\u{1F600}';
  assert.equal(emoji.length, 2);
  const titled = (title: string) => setAt(fiveClusterDocument(), ['title'], title);
  assert.deepEqual(failingPaths(titled(emoji.repeat(LENGTHS.title.max))), []);
  assert.deepEqual(failingPaths(titled(emoji.repeat(LENGTHS.title.max + 1))), ['title']);
  assert.deepEqual(failingPaths(titled(emoji)), []);
  const named = (name: string) => setAt(fiveClusterDocument(), ['objects', 0, 'name'], name);
  assert.deepEqual(failingPaths(named(emoji.repeat(LENGTHS['objects[].name'].max))), []);
  assert.deepEqual(failingPaths(named(emoji.repeat(LENGTHS['objects[].name'].max + 1))), ['objects[0].name']);
});

test("a light color's chroma is bounded at 0.25", () => {
  assert.deepEqual(RANGES['lights[].color.c'], { min: 0, max: 0.25, kind: 'real' });
  const at = (c: number) => setAt(fiveClusterDocument(), ['lights', 1, 'color', 'c'], c);
  assert.deepEqual(failingPaths(at(0.25)), []);
  assert.deepEqual(failingPaths(at(0.2500001)), ['lights[1].color.c']);
});

test('every bounded string and array of the schema equals its LENGTHS entry, and every entry is used', () => {
  const used = new Set<string>();
  for (const { path, node } of documentNodes()) {
    const kind = typesOf(node).includes('string') ? 'Length' : typesOf(node).includes('array') ? 'Items' : undefined;
    if (kind === undefined) continue;
    const max = node[`max${kind}`];
    const range = isLengthPath(path) ? LENGTHS[path] : undefined;
    if (range === undefined) {
      assert.equal(max, undefined, `${path} has a maximum length but no LENGTHS entry`);
      // Only a NonEmpty tuple, one fixed element and then any number, may have a minimum without an entry, and that minimum is 1.
      const nonEmpty = Array.isArray(node['prefixItems']) && node['prefixItems'].length === 1 && isRecord(node['items']);
      assert.equal(node[`min${kind}`], nonEmpty ? 1 : undefined, `${path} min${kind} without a LENGTHS entry`);
      continue;
    }
    used.add(path);
    assert.equal(max, range.max, `${path} max${kind}`);
    assert.equal(node[`min${kind}`] ?? 0, range.min, `${path} min${kind}`);
  }
  assert.deepEqual([...used].sort(), Object.keys(LENGTHS).sort(), 'every LENGTHS entry bounds a field of the schema');
});

/** The concrete paths of a table path in `doc`: each `[]` expanded over the elements present. */
function concretePaths(doc: unknown, tablePath: string): readonly (readonly Key[])[] {
  let paths: (readonly Key[])[] = [[]];
  for (const part of tablePath.split('.')) {
    const name = part.replace(/\[\]/g, '');
    const arrays = (part.match(/\[\]/g) ?? []).length;
    paths = paths.map((p): readonly Key[] => [...p, name]);
    for (let i = 0; i < arrays; i++) {
      paths = paths.flatMap((p) => {
        const value = getAt(doc, p);
        return Array.isArray(value) ? value.map((_, index): readonly Key[] => [...p, index]) : [];
      });
    }
    paths = paths.filter((p) => getAt(doc, p) !== undefined);
  }
  return paths.filter((p) => getAt(doc, p) !== null);
}

test('every RANGES field fails outside its range and off its grid, at its own path', () => {
  const doc = fiveClusterDocument();
  for (const [tablePath, range] of Object.entries(RANGES)) {
    const paths = concretePaths(doc, tablePath);
    assert.ok(paths.length > 0, `the five-cluster document holds ${tablePath}`);
    for (const path of paths) {
      const where = formatPath(path);
      const entry: NumberRange = range;
      const off = [
        range.min - 1,
        range.max + 1,
        ...(entry.minExclusive === true ? [range.min] : []),
        ...(range.kind === 'integer' ? [range.min + 0.5] : []),
        ...(range.kind === 'even-integer' ? [range.min + 1] : []),
      ];
      for (const value of off) assert.ok(failingPaths(setAt(doc, path, value)).includes(where), `${where} = ${value}`);
    }
  }
});

test('every LENGTHS field fails past either bound, at its own path', () => {
  const doc = fiveClusterDocument();
  for (const [tablePath, range] of Object.entries(LENGTHS)) {
    const paths = concretePaths(doc, tablePath);
    assert.ok(paths.length > 0, `the five-cluster document holds ${tablePath}`);
    for (const path of paths) {
      const where = formatPath(path);
      const current = getAt(doc, path);
      const sized = (n: number): unknown =>
        typeof current === 'string' ? 'x'.repeat(n) : Array.from({ length: n }, () => (Array.isArray(current) ? current[0] : undefined));
      assert.ok(failingPaths(setAt(doc, path, sized(range.max + 1))).includes(where), `${where} at ${range.max + 1}`);
      if (range.min > 0) {
        // A non-empty tuple reports a missing first element at that element's path.
        const short = failingPaths(setAt(doc, path, sized(range.min - 1)));
        assert.ok(short.includes(where) || short.includes(`${where}[${range.min - 1}]`), `${where} at ${range.min - 1}: ${JSON.stringify(short)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// valid documents, unknown keys, invariants

test('every FLOORS field fails below its floor and, for an integer, off its grid, at its own path', () => {
  const doc = fiveClusterDocument();
  for (const [tablePath, floor] of Object.entries(FLOORS)) {
    const paths = concretePaths(doc, tablePath);
    assert.ok(paths.length > 0, `the five-cluster document holds ${tablePath}`);
    for (const path of paths) {
      const where = formatPath(path);
      assert.deepEqual(failingPaths(setAt(doc, path, floor.min)), [], `${where} = ${floor.min}`);
      const off = [floor.min - 1, ...(floor.kind === 'integer' ? [floor.min + 0.5] : [])];
      for (const value of off) assert.ok(failingPaths(setAt(doc, path, value)).includes(where), `${where} = ${value}`);
    }
  }
});

test('the fixture documents parse, and a parse drops nothing', () => {
  const docs = validDocuments();
  const harmonies = new Set(docs.map((doc) => doc.style.harmony.kind));
  assert.ok(harmonies.has('off') && harmonies.has('auto') && harmonies.has('triadic'), 'the fixtures hold every arm of Harmony');
  for (const doc of docs) {
    const result = currentDocumentSchema.safeParse(doc);
    assert.ok(result.success, result.success ? '' : describeIssues(result.error.issues));
    assert.deepEqual(result.data, doc);
    // A JSON round trip, as a scene file or a record makes, parses to the same document.
    assert.deepEqual(currentDocumentSchema.parse(JSON.parse(JSON.stringify(doc))), doc);
  }
});

test('legacy tapped and automatic selections migrate additively to size .5 and keep explicit refinements', () => {
  const current = fiveClusterDocument();
  const old = { ...current, objects: current.objects.map((object) => {
    const { size: _size, ...selection } = object.produced.selection;
    return { ...object, produced: { ...object.produced, selection } };
  }) };
  const migrated = parseDocument(JSON.parse(JSON.stringify(old)));
  assert.ok(migrated.ok);
  assert.ok(migrated.value.objects.length > 0);
  assert.deepEqual(migrated.value, current);
  for (const object of migrated.value.objects) assert.equal(object.produced.selection.size, 0.5);
  const points = [{ at: { x: 0.5, y: 0.5 }, label: 'include' }];
  for (const size of [0, 0.2, 0.5, 1]) {
    assert.equal(selectionSchema.parse({ kind: 'taps', points, candidate: 0, size }).size, size);
  }
  for (const size of [-0.1, 1.1, NaN, Infinity, '0.5', null]) {
    assert.equal(selectionSchema.safeParse({ kind: 'taps', points, candidate: 0, size }).success, false);
  }
});

test('an unknown key fails with its key path, at the top level and nested', () => {
  const cases: readonly (readonly [readonly Key[], string])[] = [
    [['extra'], 'extra'],
    [['objects', 0, 'extra'], 'objects[0].extra'],
    [['objects', 1, 'produced', 'selection', 'extra'], 'objects[1].produced.selection.extra'],
    [['lights', 1, 'extra'], 'lights[1].extra'],
    [['lights', 0, 'color', 'extra'], 'lights[0].color.extra'],
    [['analysis', 'depth', 'stats', 'extra'], 'analysis.depth.stats.extra'],
    [['style', 'harmony', 'extra'], 'style.harmony.extra'],
    [['analysis', 'colors', 0, 'lab', 'extra'], 'analysis.colors[0].lab.extra'],
    [['frame', 'with.dot'], 'frame["with.dot"]'],
  ];
  for (const [path, where] of cases) {
    const json = setAt(fiveClusterDocument(), path, 1);
    assert.deepEqual(failingPaths(json), [where], where);
    assert.equal(detailOf(json), `${where}: unknown key`);
  }
  // A key in an arm that does not hold it is unknown too: a tapped selection has no seed.
  assert.deepEqual(failingPaths(setAt(fiveClusterDocument(), ['objects', 1, 'produced', 'selection', 'seed'], { at: { x: 0, y: 0 }, label: 'include' })), [
    'objects[1].produced.selection.seed',
  ]);
});

test('an odd master width or height fails, and the same document with both sides even parses', () => {
  const sized = (width: number, height: number) => setAt(fiveClusterDocument(), ['frame', 'master', 'size'], { width, height });
  assert.deepEqual(failingPaths(sized(2047, 1536)), ['frame.master.size.width']);
  assert.deepEqual(failingPaths(sized(2048, 1535)), ['frame.master.size.height']);
  assert.deepEqual(failingPaths(sized(2048, 1536)), []);
  assert.deepEqual(failingPaths(sized(2046, 1534)), []);
});

test("a palette target whose cluster is at or above the document's own analysis.colors.length fails", () => {
  const targeting = (cluster: number) => setAt(fiveClusterDocument(), ['style', 'paletteTargets'], [{ cluster, color: { l: 0.5, c: 0.1, h: 10 } }]);
  assert.equal(fiveClusterDocument().analysis.colors.length, 5);
  assert.deepEqual(failingPaths(targeting(4)), []);
  assert.deepEqual(failingPaths(targeting(5)), ['style.paletteTargets[0].cluster']);
  assert.deepEqual(failingPaths(targeting(15)), ['style.paletteTargets[0].cluster']);
  // The bound is the document's own: one cluster admits only cluster 0.
  const single = setAt(minimalDocument(), ['style', 'paletteTargets'], [{ cluster: 1, color: { l: 0.5, c: 0.1, h: 10 } }]);
  assert.deepEqual(failingPaths(single), ['style.paletteTargets[0].cluster']);
  assert.match(detailOf(single), /^style\.paletteTargets\[0\]\.cluster: .*below analysis\.colors\.length \(1\)/);
});

test('each invariant fails with its path when broken', () => {
  const variants = invalidVariants();
  assert.equal(new Set(variants.map((v) => v.name)).size, variants.length, 'variant names are unique');
  for (const { name, path, json } of variants) {
    const paths = failingPaths(json);
    assert.ok(paths.includes(path), `${name}: expected ${path} among ${JSON.stringify(paths)}`);
    assert.ok(detailOf(json).includes(`${path}: `), `${name}: the detail names ${path}`);
  }
});

test('the detail lists every failing path of a document broken in several places', () => {
  let json: unknown = fiveClusterDocument();
  json = setAt(json, ['title'], '');
  json = setAt(json, ['frame', 'master', 'size', 'width'], 2047);
  json = setAt(json, ['lights', 0, 'extra'], true);
  json = setAt(json, ['objects', 1, 'thickness'], 9);
  json = setAt(json, ['style', 'paletteTargets', 1, 'cluster'], 7);
  const detail = detailOf(json);
  const paths = ['title', 'frame.master.size.width', 'lights[0].extra', 'objects[1].thickness', 'style.paletteTargets[1].cluster'];
  for (const path of paths) assert.ok(detail.includes(`${path}: `), detail);
  assert.equal(detail.split('; ').length, paths.length, detail);
});

test('the check that reads two subtrees is skipped behind an issue that stops zod at its field, and runs beside any other', () => {
  const broken = setAt(fiveClusterDocument(), ['style', 'paletteTargets', 1, 'cluster'], 7);
  const cluster = 'style.paletteTargets[1].cluster';
  const stopping: readonly (readonly [string, readonly Key[], unknown])[] = [
    ['a field of the wrong type', ['title'], 5],
    ['a missing field', ['lighting', 'ambient'], undefined],
    ['a wrong literal', ['version'], SCENE_VERSION + 1],
    ['a value outside its enum', ['analysis', 'autoSubject'], 'later'],
    ["a union's unknown kind", ['style', 'harmony', 'kind'], 'tetradic'],
    ['an id its check refuses', ['id'], 'scene-1'],
  ];
  for (const [name, path, value] of stopping) {
    const paths = failingPaths(setAt(broken, path, value));
    assert.deepEqual(paths, [formatPath(path)], name);
  }
  const continuing: readonly (readonly [string, readonly Key[], unknown])[] = [
    ['a failed bound', ['objects', 1, 'thickness'], 9],
    ['a failed length', ['title'], ''],
    ['a malformed timestamp', ['createdAt'], 'today'],
    ['a failed refinement', ['analysis', 'plate', 'forMasks'], [assetId(0x32), assetId(0x31)]],
    ['a plane of the wrong format', ['analysis', 'depth', 'map', 'format'], 'u8'],
    ['an unknown key', ['extra'], 1],
  ];
  for (const [name, path, value] of continuing) {
    const paths = failingPaths(setAt(broken, path, value));
    assert.ok(paths.includes(cluster), `${name}: ${JSON.stringify(paths)}`);
  }
});

test('values that are not a document fail without throwing', () => {
  for (const json of [null, 0, 'noisy-scene', [], {}, { format: 'noisy-scene' }, { ...minimalDocument(), objects: null }]) {
    const result = currentDocumentSchema.safeParse(json);
    assert.ok(!result.success);
    assert.ok(describeIssues(result.error.issues).length > 0);
  }
});

test('formatPath writes identifiers with dots, indices in brackets, other keys quoted, and the root by name', () => {
  assert.equal(formatPath([]), '(document)');
  assert.equal(formatPath(['objects', 3, 'produced', 'mask']), 'objects[3].produced.mask');
  assert.equal(formatPath(['frame', 'a b', '']), 'frame["a b"][""]');
  assert.equal(formatPath([5]), '[5]');
});

test('a parsed document is frozen at every level', () => {
  const doc = currentDocumentSchema.parse(fiveClusterDocument());
  assert.ok(Object.isFrozen(doc));
  assert.ok(Object.isFrozen(doc.objects));
  assert.ok(Object.isFrozen(doc.objects[0]?.produced.selection));
  assert.ok(Object.isFrozen(doc.analysis.colors[0]?.lab));
});

// ---------------------------------------------------------------------------
// types

/** True only when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

test("the document's primitives are core/raster.ts's types, and its ids and arrays are the declared ones", () => {
  const checks = [
    true satisfies Equal<Frame['original']['size'], Size>,
    true satisfies Equal<ObjectProduced['bounds'], Rect>,
    true satisfies Equal<Analysis['colors'][number]['lab'], Oklab>,
    true satisfies Equal<Frame['master'], ImageRef>,
    true satisfies Equal<PlateProduct['image'], ImageRef>,
    true satisfies Equal<DepthProduct['map'], PlaneRef>,
    true satisfies Equal<ObjectProduced['mask'], PlaneRef>,
    true satisfies Equal<Light['color'], Oklch>,
    true satisfies Equal<PaletteTarget['color'], Oklch>,
    true satisfies Equal<Extract<Recolor, { kind: 'target' }>['color'], Oklch>,
    true satisfies Equal<Light['at'], ImagePoint>,
    true satisfies Equal<TapPoint['at'], ImagePoint>,
    true satisfies Equal<SceneDocument['id'], SceneId>,
    true satisfies Equal<Analysis['colors'], NonEmpty<Analysis['colors'][number]>>,
    true satisfies Equal<SceneDocument['objects'][number]['produced']['color']['clusters'], NonEmpty<Analysis['colors'][number]>>,
    true satisfies Equal<SceneDocument['motion']['focus'], number | null>,
    true satisfies Equal<SceneDocument['motion']['parallax'], number>,
    true satisfies Equal<Extract<ObjectProduced['selection'], { kind: 'taps' }>['points'], NonEmpty<Extract<ObjectProduced['selection'], { kind: 'auto-subject' }>['seed']>>,
  ];
  assert.deepEqual(checks, checks.map(() => true));
});

test('the active version is the migration table length and a literal type', () => {
  assert.equal(SCENE_VERSION, MIGRATIONS.length);
  const literal = true satisfies Equal<ActiveSceneDocument['version'], 5 | 6>;
  // @ts-expect-error version 7 is newer than the current migration table
  const newer: ActiveSceneDocument = { ...activeMinimalDocument(), version: 7 };
  assert.ok(literal);
  assert.equal(activeMinimalDocument().version, 5);
  const parsed = parseActiveDocument(newer);
  assert.ok(!parsed.ok && parsed.error.kind === 'newer-version');
  assert.equal(parsed.error.version, 7);
});

test('a five-entry migration table makes a schema and a type of version 5', () => {
  const add: Migration = (json) => json;
  const chain = [add, add, add, add, add] as const satisfies readonly Migration[];
  const schema = sceneDocumentSchema(chain.length);
  const literal = true satisfies Equal<SceneDocumentAt<typeof chain.length>['version'], 5>;
  const inferred = true satisfies Equal<z.infer<typeof schema>['version'], 5>;
  const atFive: SceneDocumentAt<5> = { ...minimalDocument(), version: 5 };
  // @ts-expect-error frozen version 4 is not version 5
  const atCurrent: SceneDocumentAt<5> = minimalDocument();
  assert.ok(literal && inferred);
  assert.ok(schema.safeParse(atFive).success);
  assert.ok(!schema.safeParse(atCurrent).success);
});

test('legacy objects retain names and gain visible defaults; current hidden layers round trip', () => {
  const current = fiveClusterDocument();
  const { drift: _drift, ...oldMotion } = current.motion;
  const old = { ...current, version: 2, motion: { ...oldMotion, orbit: current.motion.drift.amount }, objects: current.objects.map(({ hidden: _hidden, ...object }) => object) };
  const before = structuredClone(old);
  const parsed = parseDocument(old);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.objects.map(({ name, hidden }) => ({ name, hidden })), current.objects.map(({ name }) => ({ name, hidden: false })));
  assert.deepEqual(old, before);
  const hidden = { ...current, objects: current.objects.map((object) => ({ ...object, name: 'My layer', hidden: true })) };
  const restored = parseDocument(JSON.parse(JSON.stringify(hidden)));
  assert.ok(restored.ok);
  assert.deepEqual(restored.value, hidden);
});

test('version 1 scenes migrate Parallax to 1 without changing their existing fields or input', () => {
  const current = minimalDocument();
  const { parallax: _parallax, drift, ...motionFields } = current.motion;
  const motion = { ...motionFields, orbit: drift.amount };
  const old = { ...current, version: 1, motion };
  const before = structuredClone(old);
  const parsed = parseDocument(old);
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.error));
  assert.equal(parsed.value.motion.parallax, 1);
  assert.deepEqual(parsed.value, { ...current, version: 4, motion: { ...current.motion, parallax: 1 } });
  assert.deepEqual(old, before);
});

test('version 0 scenes run the surface and Parallax migrations in order', () => {
  const { surface: _surface, ...current } = minimalDocument();
  const { parallax: _parallax, drift, ...motionFields } = current.motion;
  const motion = { ...motionFields, orbit: drift.amount };
  const parsed = parseDocument({ ...current, version: 0, motion });
  assert.ok(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.error));
  assert.equal(parsed.value.version, 4);
  assert.equal(parsed.value.motion.parallax, 1);
  assert.equal(parsed.value.surface.enabled, false);
});

test('current scenes require Parallax, retain chosen values, and reject malformed legacy motion', () => {
  const current = minimalDocument();
  const { parallax: _parallax, ...motion } = current.motion;
  assert.deepEqual(failingPaths({ ...current, motion }), ['motion.parallax']);
  const chosen = { ...current, motion: { ...current.motion, parallax: 2.7 } };
  const parsed = parseDocument(chosen);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, chosen);
  for (const motion of [null, [], 'bad', { unexpected: true }]) {
    const old = { ...current, version: 1, motion };
    const rejected = parseDocument(old);
    assert.ok(!rejected.ok && rejected.error.kind === 'invalid');
  }
});


test('active v5 keeps strict composition refs, exact coverage formats and typed provenance', () => {
  const current = activeMinimalDocument();
  const parsed = parseActiveDocument(current);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, current);
  assert.equal(parsed.value.compositing, 'legacy-order');
  assert.deepEqual([parsed.value.sources, parsed.value.removals, parsed.value.localEffects], [[], [], []]);
  assert.equal(activeDocumentSchema.safeParse({ ...current, unexpected: true }).success, false);
  const formats = [true satisfies Equal<ActiveSceneDocument['objects'][number]['produced']['mask']['format'], 'u8'>,
    true satisfies Equal<NonNullable<ActiveSceneDocument['analysis']['depth']>['map']['format'], 'f32'>];
  assert.deepEqual(formats, [true, true]);
});
