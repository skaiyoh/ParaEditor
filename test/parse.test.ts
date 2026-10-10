// The parse chain: peekVersion's version rule, the strict parse through the
// bound parseDocument, the synthetic two-migration chain passed to
// parseDocumentWith, migration failures, and a table of values that must each
// get a Result and never a throw.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuildId } from '../src/core/ids.ts';
import * as real from '../src/core/migrate.ts';
import type { Migration } from '../src/core/migrate.ts';
import type { Result } from '../src/core/result.ts';
import { parseDocument, parseDocumentWith, peekVersion, type ParseError } from '../src/core/schema.ts';
import type { SceneDocument, SceneDocumentAt } from '../src/core/types.ts';
import { assetId, fiveClusterDocument, invalidVariants, minimalDocument, setAt, validDocuments, WRITER, type Key } from './fixtures/documents.ts';
import * as synthetic from './fixtures/migrate-synthetic.ts';
import { MIGRATIONS as SYNTHETIC, type Migration as SyntheticMigration } from './fixtures/migrate-synthetic.ts';

/** True only when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function failure<T>(result: Result<T, ParseError>): ParseError {
  assert.ok(!result.ok, `expected a failure, got ${JSON.stringify(result)}`);
  return result.error;
}

function invalidDetail<T>(result: Result<T, ParseError>): string {
  const error = failure(result);
  assert.equal(error.kind, 'invalid', JSON.stringify(error));
  return error.kind === 'invalid' ? error.detail : '';
}

// ---------------------------------------------------------------------------
// peekVersion

test('peekVersion accepts version 0 and any whole number above it, with the writer when the document names one', () => {
  for (const version of [0, 1, 2, 17, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2 ** 60, 1e21, 1e308]) {
    assert.deepEqual(peekVersion(setAt(minimalDocument(), ['version'], version)), { ok: true, value: { version, writer: WRITER } });
  }
  // Only format, version, and provenance.writer are read: the rest may be anything.
  assert.deepEqual(peekVersion({ format: 'noisy-scene', version: 0 }), { ok: true, value: { version: 0, writer: null } });
});

test('peekVersion refuses a negative, fractional, or non-numeric version, and a format other than noisy-scene, as not-a-scene', () => {
  const notAScene = { ok: false, error: { kind: 'not-a-scene' } };
  for (const version of [-1, -0.5, 0.5, 1.5, -1e21, Infinity, -Infinity, NaN, '0', '1', null, true, [0], { v: 0 }]) {
    assert.deepEqual(peekVersion(setAt(minimalDocument(), ['version'], version)), notAScene, String(version));
  }
  for (const format of ['noisy', 'Noisy-Scene', 'noisy-scene ', '', null, 1]) {
    assert.deepEqual(peekVersion(setAt(minimalDocument(), ['format'], format)), notAScene, String(format));
  }
  const { format: _format, ...unformatted } = minimalDocument();
  const { version: _version, ...unversioned } = minimalDocument();
  assert.deepEqual(peekVersion(unformatted), notAScene);
  assert.deepEqual(peekVersion(unversioned), notAScene);
});

test('peekVersion answers a value whose getters or proxy traps throw: not-a-scene, or a null writer', () => {
  const throwingFormat = { version: 0, get format(): string { throw new Error('format'); } };
  assert.deepEqual(peekVersion(throwingFormat), { ok: false, error: { kind: 'not-a-scene' } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(peekVersion(revoked.proxy), { ok: false, error: { kind: 'not-a-scene' } });
  const throwingWriter = { format: 'noisy-scene', version: 0, get provenance(): unknown { throw new Error('provenance'); } };
  assert.deepEqual(peekVersion(throwingWriter), { ok: true, value: { version: 0, writer: null } });
});

test("peekVersion reads the writer best-effort: null when provenance or its writer is absent or not a build id", () => {
  const writerOf = (json: unknown) => {
    const peek = peekVersion(json);
    assert.ok(peek.ok);
    return peek.value.writer;
  };
  assert.equal(writerOf(minimalDocument()), WRITER);
  for (const [path, value] of [
    [['provenance', 'writer'], 'not a build id'],
    [['provenance', 'writer'], 7],
    [['provenance', 'writer'], null],
    [['provenance'], null],
    [['provenance'], 'nocommit-20261002'],
    [['provenance'], []],
  ] as const satisfies readonly (readonly [readonly Key[], unknown])[]) {
    assert.equal(writerOf(setAt(minimalDocument(), path, value)), null, JSON.stringify([path, value]));
  }
  const { provenance: _provenance, ...anonymous } = minimalDocument();
  assert.equal(writerOf(anonymous), null);
});

// ---------------------------------------------------------------------------
// the bound parse at the current version

test('every valid fixture parses through parseDocument to a document equal to it', () => {
  for (const doc of validDocuments()) {
    const result = parseDocument(doc);
    assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
    assert.deepEqual(result.value, doc);
    assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(doc))), { ok: true, value: doc });
  }
});

test('parseDocument leaves its input as it was, unfrozen', () => {
  const doc = fiveClusterDocument();
  const before = JSON.stringify(doc);
  assert.ok(parseDocument(doc).ok);
  assert.equal(JSON.stringify(doc), before);
  assert.ok(!Object.isFrozen(doc) && !Object.isFrozen(doc.objects) && !Object.isFrozen(doc.analysis.colors[0]));
});

test('an unknown key at the current version fails invalid with its key path, at the top level and nested, and nothing is dropped', () => {
  const cases: readonly (readonly [readonly Key[], string])[] = [
    [['extra'], 'extra'],
    [['analysis', 'legacyPlate'], 'analysis.legacyPlate'],
    [['objects', 0, 'produced', 'extra'], 'objects[0].produced.extra'],
    [['lights', 1, 'color', 'extra'], 'lights[1].color.extra'],
    [['style', 'harmony', 'extra'], 'style.harmony.extra'],
    [['frame', 'with space'], 'frame["with space"]'],
  ];
  for (const [path, where] of cases) {
    const json = setAt(fiveClusterDocument(), path, { kept: true });
    assert.equal(invalidDetail(parseDocument(json)), `${where}: unknown key`, where);
  }
  // Two unknown keys are both listed, and a key named __proto__ is a key like any other.
  const both = setAt(setAt(fiveClusterDocument(), ['extra'], 1), ['lights', 0, 'extra'], 2);
  const detail = invalidDetail(parseDocument(both));
  assert.ok(detail.includes('extra: unknown key') && detail.includes('lights[0].extra: unknown key'), detail);
  const proto: unknown = JSON.parse(JSON.stringify(minimalDocument()).replace(/^\{/, '{"__proto__":{"x":1},'));
  assert.equal(invalidDetail(parseDocument(proto)), '__proto__: unknown key');
});

test("a palette target's cluster at or above the document's own analysis.colors.length fails invalid at its path", () => {
  const targeting = (doc: SceneDocument, cluster: number) => setAt(doc, ['style', 'paletteTargets'], [{ cluster, color: { l: 0.5, c: 0.1, h: 10 } }]);
  assert.ok(parseDocument(targeting(fiveClusterDocument(), 4)).ok);
  assert.match(invalidDetail(parseDocument(targeting(fiveClusterDocument(), 5))), /^style\.paletteTargets\[0\]\.cluster: /);
  assert.ok(parseDocument(targeting(minimalDocument(), 0)).ok);
  assert.match(invalidDetail(parseDocument(targeting(minimalDocument(), 1))), /^style\.paletteTargets\[0\]\.cluster: .*\(1\)/);
});

test('an odd master side fails parseDocument as invalid at that side', () => {
  const sized = (width: number, height: number) => setAt(fiveClusterDocument(), ['frame', 'master', 'size'], { width, height });
  assert.match(invalidDetail(parseDocument(sized(2047, 1536))), /^frame\.master\.size\.width: /);
  assert.match(invalidDetail(parseDocument(sized(2048, 1535))), /^frame\.master\.size\.height: /);
  const both = invalidDetail(parseDocument(sized(2047, 1535)));
  assert.ok(both.includes('frame.master.size.width: ') && both.includes('frame.master.size.height: '), both);
  assert.ok(parseDocument(sized(2046, 1534)).ok);
});

test('every invalid fixture variant fails parseDocument as invalid with its path in the detail, but the one at a later version', () => {
  const variants = invalidVariants();
  assert.ok(variants.length > 0);
  // The schema alone refuses a newer version at `version`; the chain peeks first, and a version above its own is newer, not invalid.
  const newer = variants.filter((v) => v.path === 'version');
  assert.deepEqual(newer.map((v) => v.name), ['a version other than the current one']);
  for (const { json } of newer) assert.deepEqual(failure(parseDocument(json)), { kind: 'newer-version', version: real.SCENE_VERSION + 1, writer: WRITER });
  for (const { name, path, json } of variants.filter((v) => v.path !== 'version')) {
    assert.ok(invalidDetail(parseDocument(json)).includes(`${path}: `), name);
  }
});

test('parseDocument answers a document at a version above its own newer-version, with the writer', () => {
  assert.deepEqual(parseDocument(setAt(minimalDocument(), ['version'], real.SCENE_VERSION + 1)), { ok: false, error: { kind: 'newer-version', version: real.SCENE_VERSION + 1, writer: WRITER } });
  // However large the version: past the safe integers is still newer, not not-a-scene.
  assert.deepEqual(parseDocument(setAt(minimalDocument(), ['version'], 1e21)), { ok: false, error: { kind: 'newer-version', version: 1e21, writer: WRITER } });
  // The rest of a newer document is not read: a broken body still answers newer-version.
  const broken = { format: 'noisy-scene', version: 9, title: 5 };
  assert.deepEqual(parseDocument(broken), { ok: false, error: { kind: 'newer-version', version: 9, writer: null } });
});

// ---------------------------------------------------------------------------
// the synthetic chain

/** A version-zero fixture for synthetic migration failure tests; its shape follows the current test schema. */
function versionZeroDocument(): SceneDocumentAt<0> {
  return { ...minimalDocument(), version: 0 };
}


/** The minimal document at version 1 of the synthetic chain, its legacy plate naming an asset. */
function versionOneDocument(): unknown {
  const doc = versionZeroDocument();
  return { ...doc, version: 1, analysis: { ...doc.analysis, legacyPlate: { asset: assetId(0x99), size: { width: 2, height: 2 } } } };
}

test('parseDocumentWith(SYNTHETIC) walks a version-0 and a version-1 document to version 2 and drops legacyPlate', () => {
  const parse = parseDocumentWith(SYNTHETIC);
  const expected = { ...versionZeroDocument(), version: 2 };
  const fromZero = parse(versionZeroDocument());
  assert.deepEqual(fromZero, { ok: true, value: expected });
  const one = versionOneDocument();
  const before = JSON.stringify(one);
  const fromOne = parse(one);
  assert.deepEqual(fromOne, { ok: true, value: expected });
  assert.ok(fromOne.ok && !('legacyPlate' in fromOne.value.analysis));
  assert.equal(JSON.stringify(one), before, 'the migrations write nothing into their input');
  // A document already at version 2 runs no migration, and one above it is newer.
  assert.deepEqual(parse(expected), { ok: true, value: expected });
  assert.deepEqual(parse({ ...expected, version: 3 }), { ok: false, error: { kind: 'newer-version', version: 3, writer: WRITER } });
});

test('the bound parseDocument refuses the synthetic legacy field at the current version', () => {
  assert.equal(invalidDetail(parseDocument(versionOneDocument())), 'analysis.legacyPlate: unknown key');
});

test('a migrated document is parsed strictly: an unknown key the migrations do not touch fails invalid at its path', () => {
  const parse = parseDocumentWith(SYNTHETIC);
  assert.equal(invalidDetail(parse(setAt(versionZeroDocument(), ['lighting', 'extra'], 1))), 'lighting.extra: unknown key');
  // A version-0 document whose analysis is not an object keeps it through both migrations and fails the strict parse there.
  assert.match(invalidDetail(parse(setAt(versionZeroDocument(), ['analysis'], []))), /^analysis: /);
});

test('a migration that throws, or returns no object, fails invalid naming its index, and no later migration runs', () => {
  const ran: number[] = [];
  const step = (index: number): Migration => (json) => {
    ran.push(index);
    return { ...Object(json), version: index + 1 };
  };
  const throwing: Migration = () => {
    throw new RangeError('bad plate');
  };
  const detail = invalidDetail(parseDocumentWith([step(0), throwing, step(2)])(versionZeroDocument()));
  assert.equal(detail, 'migration 1 (version 1 to 2) threw RangeError: bad plate');
  assert.deepEqual(ran, [0]);
  const throwsNull: Migration = () => {
    throw null;
  };
  assert.equal(invalidDetail(parseDocumentWith([throwsNull])(versionZeroDocument())), 'migration 0 (version 0 to 1) threw a thrown null');
  for (const returned of [null, undefined, 7, 'doc', [versionZeroDocument()]]) {
    const detail = invalidDetail(parseDocumentWith([step(0), () => returned])(versionZeroDocument()));
    assert.equal(detail, 'migration 1 (version 1 to 2) returned no object', String(returned));
  }
});

test('a migration writes the version it yields: one that leaves it, or writes another, fails invalid naming its index', () => {
  const bump: Migration = (json) => ({ ...Object(json), version: 1 });
  assert.deepEqual(parseDocumentWith([bump])(versionZeroDocument()), { ok: true, value: { ...versionZeroDocument(), version: 1 } });
  const identity: Migration = (json) => json;
  assert.equal(invalidDetail(parseDocumentWith([identity])(versionZeroDocument())), 'migration 0 (version 0 to 1) returned a document whose version is not 1');
  const skipping: Migration = (json) => ({ ...Object(json), version: 3 });
  assert.equal(invalidDetail(parseDocumentWith([bump, skipping, skipping])(versionZeroDocument())), 'migration 1 (version 1 to 2) returned a document whose version is not 2');
});

test("a migration that writes to its argument never reaches the caller's value", () => {
  const inPlace: Migration = (json) => {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
    Reflect.set(json, 'title', 'MUTATED');
    Reflect.deleteProperty(json, 'analysis');
    Reflect.set(json, 'version', 1);
    return json;
  };
  const doc = versionZeroDocument();
  const before = JSON.stringify(doc);
  assert.match(invalidDetail(parseDocumentWith([inPlace])(doc)), /^analysis: /);
  assert.equal(JSON.stringify(doc), before);
  // The copy keeps every key, so the strict parse still sees one named __proto__.
  const proto: unknown = JSON.parse(JSON.stringify(versionZeroDocument()).replace(/^\{/, '{"__proto__":{"x":1},'));
  assert.equal(invalidDetail(parseDocumentWith(SYNTHETIC)(proto)), '__proto__: unknown key');
});

test('a value whose getters or proxy traps throw, before or after a migration, fails invalid and does not throw', () => {
  const throwingTitle = { ...minimalDocument(), get title(): string { throw new Error('title'); } };
  assert.equal(invalidDetail(parseDocument(throwingTitle)), 'the strict parse threw Error: title');
  assert.equal(invalidDetail(parseDocumentWith(SYNTHETIC)(throwingTitle)), 'the document could not be copied for its migrations: Error: title');
  const returnsGetter: Migration = () => ({ ...versionZeroDocument(), version: 1, get title(): never { throw new Error('boom'); } });
  assert.equal(invalidDetail(parseDocumentWith([returnsGetter])(versionZeroDocument())), 'the strict parse threw Error: boom');
  const throwingVersion: Migration = () => ({ get version(): never { throw new Error('version'); } });
  assert.equal(invalidDetail(parseDocumentWith([throwingVersion])(versionZeroDocument())), 'migration 0 (version 0 to 1) threw Error: version');
  const proxyReturn: Migration = () => new Proxy({ version: 1 }, { ownKeys: () => { throw new Error('ownKeys'); } });
  assert.equal(invalidDetail(parseDocumentWith([proxyReturn])(versionZeroDocument())), 'the strict parse threw Error: ownKeys');
});

// ---------------------------------------------------------------------------
// hostile values

/** An array nested `depth` deep, built without recursion. */
function nested(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

/** An object nested `depth` deep under the key `k`. */
function nestedObject(depth: number): unknown {
  let value: unknown = {};
  for (let i = 0; i < depth; i++) value = { k: value };
  return value;
}

test('no JSON value makes the parse throw: every hostile input gets a Result', () => {
  const deep = nested(100_000);
  const deepObject = nestedObject(100_000);
  const header = { format: 'noisy-scene', version: 0 };
  const inputs: readonly (readonly [string, unknown, ParseError['kind']])[] = [
    ['null', null, 'not-a-scene'],
    ['undefined', undefined, 'not-a-scene'],
    ['true', true, 'not-a-scene'],
    ['0', 0, 'not-a-scene'],
    ['a huge number', 1e308, 'not-a-scene'],
    ['NaN', NaN, 'not-a-scene'],
    ['a string', 'noisy-scene', 'not-a-scene'],
    ['the JSON of a document, unparsed', JSON.stringify(versionZeroDocument()), 'not-a-scene'],
    ['an empty array', [], 'not-a-scene'],
    ['an array holding a document', [versionZeroDocument()], 'not-a-scene'],
    ['an empty object', {}, 'not-a-scene'],
    ['an object missing format', { version: 0 }, 'not-a-scene'],
    ['a version that is a string', { format: 'noisy-scene', version: '0' }, 'not-a-scene'],
    ['a version past the safe integers', { format: 'noisy-scene', version: 2 ** 60 }, 'newer-version'],
    ['a huge version', { format: 'noisy-scene', version: 1e300 }, 'newer-version'],
    ['a negative huge version', { format: 'noisy-scene', version: -1e300 }, 'not-a-scene'],
    ['a deeply nested array', deep, 'not-a-scene'],
    ['a deeply nested object', deepObject, 'not-a-scene'],
    ['the header alone', header, 'invalid'],
    ['the header with a deeply nested array for every field', { ...header, title: deep, frame: deep, analysis: deep, objects: deep }, 'invalid'],
    ['the header with a deeply nested object under an unknown key', { ...versionZeroDocument(), junk: deepObject }, 'invalid'],
    ['a deeply nested array as the objects', setAt(versionZeroDocument(), ['objects'], [deep, deepObject]), 'invalid'],
    ['10,000 junk objects', setAt(versionZeroDocument(), ['objects'], Array.from({ length: 10_000 }, () => ({ junk: deep }))), 'invalid'],
    // Each pushes more of zod's issues into one call's arguments than the engine allows.
    ['100,000 empty objects as the objects', setAt(versionZeroDocument(), ['objects'], Array.from({ length: 100_000 }, () => ({}))), 'invalid'],
    ['200,000 zeros as the lights', setAt(versionZeroDocument(), ['lights'], Array.from({ length: 200_000 }, () => 0)), 'invalid'],
    ['200,000 zeros as the palette targets', setAt(versionZeroDocument(), ['style', 'paletteTargets'], Array.from({ length: 200_000 }, () => 0)), 'invalid'],
    ['a newer version with a deeply nested writer', { format: 'noisy-scene', version: 5, provenance: { writer: deep } }, 'newer-version'],
    ['every field null', Object.fromEntries(Object.keys(versionZeroDocument()).map((key) => [key, null])), 'not-a-scene'],
    ['every field null but the header', { ...Object.fromEntries(Object.keys(versionZeroDocument()).map((key) => [key, null])), ...header }, 'invalid'],
    ['a valid document but for its analysis, an array', setAt(versionZeroDocument(), ['analysis'], [1, 2]), 'invalid'],
  ];
  for (const parse of [parseDocument, parseDocumentWith(SYNTHETIC)]) {
    for (const [name, json, kind] of inputs) {
      let result: Result<unknown, ParseError> | undefined;
      assert.doesNotThrow(() => {
        result = parse(json);
      }, name);
      assert.ok(result !== undefined && !result.ok, name);
      assert.equal(result.error.kind, kind, `${name}: ${JSON.stringify(result.error).slice(0, 200)}`);
      if (result.error.kind === 'invalid') assert.ok(result.error.detail.length > 0, name);
    }
  }
});

// ---------------------------------------------------------------------------
// types

test('the synthetic module has the shape of core/migrate.ts, so the build can load it in that module\'s place', () => {
  // The same runtime exports, and the same Migration type.
  assert.deepEqual(Object.keys(synthetic).sort(), Object.keys(real).sort());
  const sameNames = true satisfies Equal<keyof typeof synthetic, keyof typeof real>;
  const sameMigration = true satisfies Equal<SyntheticMigration, Migration>;
  // What every importer of core/migrate.ts reads from it: a table of migrations and a version that is its literal length.
  type MigrateModule<M extends readonly Migration[]> = { readonly MIGRATIONS: M; readonly SCENE_VERSION: M['length'] };
  const realShape: MigrateModule<typeof real.MIGRATIONS> = real;
  const syntheticShape: MigrateModule<typeof SYNTHETIC> = synthetic;
  const two = true satisfies Equal<typeof synthetic.SCENE_VERSION, 2>;
  assert.ok(sameNames && sameMigration && two);
  assert.equal(syntheticShape.SCENE_VERSION, syntheticShape.MIGRATIONS.length);
  assert.equal(syntheticShape.SCENE_VERSION, 2);
  assert.equal(realShape.SCENE_VERSION, realShape.MIGRATIONS.length);
});

test('parseDocumentWith types its documents at its table\'s length, and parseDocument at SCENE_VERSION', () => {
  const parse = parseDocumentWith(SYNTHETIC);
  type Parsed = Extract<ReturnType<typeof parse>, { ok: true }>['value'];
  const atTwo = true satisfies Equal<Parsed, SceneDocumentAt<2>>;
  const versionTwo = true satisfies Equal<Parsed['version'], 2>;
  type Bound = Extract<ReturnType<typeof parseDocument>, { ok: true }>['value'];
  const bound = true satisfies Equal<Bound, SceneDocument>;
  const writer = true satisfies Equal<Extract<ParseError, { kind: 'newer-version' }>['writer'], BuildId | null>;
  assert.ok(atTwo && versionTwo && bound && writer);
  const result = parse(versionZeroDocument());
  assert.ok(result.ok);
  const version: 2 = result.value.version;
  assert.equal(version, 2);
  // @ts-expect-error a document of the two-migration chain is not a document of the one-entry table
  const current: SceneDocument = result.value;
  assert.equal(current.version, 2);
});
