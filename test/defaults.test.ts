// core/defaults.ts: a new scene built from the defaults parses, its stored
// style holds the fried values of the macro dial at 0.6, and new objects and
// lights take their defaults; nothing in the module mints an id or reads a clock.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { defaultLighting, defaultMotion, defaultStyle, defaultSymbols, defaultSurface, newDocument, newLight, newObject, nextObjectName } from '../src/core/defaults.ts';
import { SCENE_VERSION } from '../src/core/migrate.ts';
import { parseDocument } from '../src/core/schema.ts';
import type { SceneDocument } from '../src/core/types.ts';
import { fiveClusterDocument, LIGHT_IDS, minimalDocument, OBJECT_IDS, SCENE_ID, WRITER } from './fixtures/documents.ts';
import { REPO } from './support/cli.ts';

function newScene(): SceneDocument {
  const { frame, analysis } = minimalDocument();
  return newDocument({ id: SCENE_ID, title: 'IMG_0001', now: '2026-10-02T12:00:00.000Z', seed: 0xdead_beef, frame, analysis, writer: WRITER, importedOn: 'node:test' });
}

test('a document built from the defaults and the minimal analysis parses, unchanged', () => {
  const doc = newScene();
  const result = parseDocument(doc);
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
  assert.deepEqual(result.value, doc);
  assert.equal(doc.version, SCENE_VERSION);
  assert.equal(doc.createdAt, doc.updatedAt);
  assert.deepEqual([doc.objects, doc.lights], [[], []]);
  assert.equal(doc.seed, 0xdead_beef);
  assert.equal(doc.analysis.autoSubject, 'pending');
});

test('the default style stores the macro dial at 0.6 and the eight fields it sets there', () => {
  const { style } = newScene();
  assert.equal(style.fry, 0.6);
  assert.deepEqual(
    { colors: style.colors, saturation: style.saturation, simplify: style.simplify, bands: style.bands, grain: style.grain, colorNoise: style.colorNoise, crunch: style.crunch, clipping: style.clipping },
    { colors: 7, saturation: 0.62, simplify: 0.52, bands: 4, grain: 0.52, colorNoise: 0.32, crunch: 0.42, clipping: 0.3 },
  );
  assert.deepEqual(style.harmony, { kind: 'auto', strength: 0.5 });
  assert.deepEqual(style.paletteTargets, []);
  assert.deepEqual(
    { outline: style.outline, subjectClarity: style.subjectClarity, grainSize: style.grainSize, grainHold: style.grainHold },
    { outline: 0.4, subjectClarity: 0.6, grainSize: 2, grainHold: 2 },
  );
});

test('symbols and motion start off, and lighting starts bright', () => {
  const doc = newScene();
  assert.deepEqual(doc.symbols, { enabled: false, cellSize: 12, amount: 0.3 });
  assert.deepEqual(doc.surface, { enabled: false, pattern: 'bars', relief: 0.5, refraction: 0.5, shine: 0.5, scale: 0.5 });
  assert.deepEqual(doc.motion, { enabled: false, drift: { direction: 'side', amount: 0.6 }, parallax: 2, loopSeconds: 3, focus: null });
  assert.deepEqual(doc.lighting, { ambient: 0.7, relief: 1 });
});

test("each default*() call returns fresh values, so changing one scene's defaults changes no other's", () => {
  assert.notEqual(defaultStyle(), defaultStyle());
  assert.notEqual(defaultStyle().harmony, defaultStyle().harmony);
  assert.notEqual(defaultSymbols(), defaultSymbols());
  assert.notEqual(defaultSurface(), defaultSurface());
  assert.notEqual(defaultMotion(), defaultMotion());
  assert.notEqual(defaultMotion().drift, defaultMotion().drift);
  assert.notEqual(defaultLighting(), defaultLighting());
  assert.notEqual(newScene().style, newScene().style);
});

test('a new object takes its defaults and the first free name, and a scene holding it and a new light parses', () => {
  const base = fiveClusterDocument();
  const [first] = base.objects;
  assert.ok(first !== undefined);
  const object = newObject({ id: OBJECT_IDS[1], produced: first.produced, existing: [] });
  assert.deepEqual(object, {
    id: OBJECT_IDS[1],
    name: 'Object 1',
    hidden: false,
    subject: false,
    recolor: { kind: 'none' },
    symbols: 'slider',
    motion: { kind: 'none' },
    thickness: 0.3,
    produced: first.produced,
  });
  const light = newLight({ id: LIGHT_IDS[0], at: { x: 0.5, y: 0.25 } });
  assert.deepEqual(light, {
    id: LIGHT_IDS[0],
    at: { x: 0.5, y: 0.25 },
    depth: 0.8,
    color: { l: 0.95, c: 0, h: 0 },
    intensity: 1,
    radius: 0.6,
    rays: 0.3,
    shadows: true,
    softness: 0.3,
  });
  const scene = { ...newScene(), frame: base.frame, analysis: base.analysis, objects: [object], lights: [light] };
  const result = parseDocument(scene);
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
});

test('nextObjectName takes the smallest N whose "Object N" is free', () => {
  assert.equal(nextObjectName([]), 'Object 1');
  assert.equal(nextObjectName([{ name: 'Object 1' }, { name: 'Object 2' }]), 'Object 3');
  assert.equal(nextObjectName([{ name: 'Object 2' }]), 'Object 1');
  assert.equal(nextObjectName([{ name: 'Object 1' }, { name: 'Frog' }, { name: 'Object 3' }]), 'Object 2');
});

test('core/defaults.ts names no clock, random source, or id minting', async () => {
  const source = await readFile(path.join(REPO, 'src/core/defaults.ts'), 'utf8');
  for (const pattern of [/\bDate\b/, /\bMath\.random\b/, /\bcrypto\b/, /\brandomUUID\b/, /\bperformance\b/]) assert.doesNotMatch(source, pattern);
});

test('Parallax amount 2 belongs to new documents; saved amounts and legacy amount 1 survive loading', () => {
  assert.equal(newScene().motion.parallax, 2);
  for (const parallax of [1, 1.7, 3]) {
    const doc = newScene();
    const result = parseDocument({ ...doc, motion: { ...doc.motion, parallax } });
    assert.ok(result.ok);
    assert.equal(result.value.motion.parallax, parallax);
  }
  const doc = newScene();
  const { parallax: _parallax, ...motion } = doc.motion;
  const legacy = parseDocument({ ...doc, version: 1, motion });
  assert.ok(legacy.ok);
  assert.equal(legacy.value.motion.parallax, 1);
});
