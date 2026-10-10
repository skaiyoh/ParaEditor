// Fixture edits for node tests: every edit kind at least once, every side
// effect, and every refusal, each on the document it applies to and with the
// outcome the reducer must give. Each `doc` returns a fresh value.
// Edits the types forbid, which the UI could still pass through untyped, are
// written under @ts-expect-error, so a type change that allows one fails the
// type check.

import type { Edit, RefusalReason } from '../../src/core/edits.ts';
import type { LightId, ObjectId } from '../../src/core/ids.ts';
import { isLightId, isObjectId } from '../../src/core/ids.ts';
import type { Light, ObjectProduced, SceneDocument, SceneObject } from '../../src/core/types.ts';
import { fiveClusterDocument, LIGHT_IDS, minimalDocument, OBJECT_IDS, uuid } from './documents.ts';

export type EditCase = {
  readonly name: string;
  readonly doc: () => SceneDocument;
  readonly edit: Edit;
  /** `applied`, `unchanged`, or the reason the reducer refuses the edit with. */
  readonly outcome: 'applied' | 'unchanged' | RefusalReason;
};

export function objectId(n: number): ObjectId {
  const id = uuid(0x1000 + n);
  if (!isObjectId(id)) throw new Error(`fixture object id ${id} fails its check`);
  return id;
}

export function lightId(n: number): LightId {
  const id = uuid(0x2000 + n);
  if (!isLightId(id)) throw new Error(`fixture light id ${id} fails its check`);
  return id;
}

function subjectOf(doc: SceneDocument): SceneObject {
  const [first] = doc.objects;
  if (first === undefined) throw new Error('the fixture document has no objects');
  return first;
}

function firstLight(doc: SceneDocument): Light {
  const [first] = doc.lights;
  if (first === undefined) throw new Error('the fixture document has no lights');
  return first;
}

/** A new object over the five-cluster document's subject's products: not the subject, no motion. */
export function tappedObject(id: ObjectId): SceneObject {
  return { ...subjectOf(fiveClusterDocument()), id, name: 'Tapped', subject: false, motion: { kind: 'none' }, recolor: { kind: 'none' } };
}

export function newLightAt(id: LightId, x: number, y: number): Light {
  return { ...firstLight(fiveClusterDocument()), id, at: { x, y } };
}

/** The five-cluster document with `count` objects, the first its subject. */
export function withObjects(count: number): SceneDocument {
  const doc = fiveClusterDocument();
  const objects = Array.from({ length: count }, (_, i) => ({ ...tappedObject(objectId(i)), subject: i === 0 }));
  return { ...doc, objects };
}

/** The five-cluster document with `count` lights. */
export function withLights(count: number): SceneDocument {
  return { ...fiveClusterDocument(), lights: Array.from({ length: count }, (_, i) => newLightAt(lightId(i), 0.5, 0.5)) };
}

/** The minimal document with one object that is not the subject, and motion off. */
export function minimalWithObject(): SceneDocument {
  return { ...minimalDocument(), objects: [tappedObject(objectId(0))] };
}

function withCandidate(produced: ObjectProduced, candidate: number): ObjectProduced {
  return { ...produced, selection: { ...produced.selection, candidate } };
}

const SUBJECT = OBJECT_IDS[0];
const BOX = OBJECT_IDS[1];
const KEY_LIGHT = LIGHT_IDS[0];

export function editCases(): readonly EditCase[] {
  const five = fiveClusterDocument;
  const minimal = minimalDocument;
  const refinedProduced: ObjectProduced = {
    ...subjectOf(five()).produced,
    selection: { kind: 'taps', points: [{ at: { x: 0.4, y: 0.6 }, label: 'include' }], candidate: 2 },
  };
  return [
    { name: 'title', doc: minimal, edit: { kind: 'title', title: 'Renamed' }, outcome: 'applied' },
    { name: 'title of 80 code points', doc: minimal, edit: { kind: 'title', title: '\u{1F600}'.repeat(80) }, outcome: 'applied' },
    { name: 'title of 81 code points', doc: minimal, edit: { kind: 'title', title: 'x'.repeat(81) }, outcome: 'invalid' },
    { name: 'empty title', doc: minimal, edit: { kind: 'title', title: '' }, outcome: 'invalid' },

    { name: 'style, one field', doc: five, edit: { kind: 'style', patch: { saturation: 0.9 } }, outcome: 'applied' },
    { name: 'style, several fields', doc: minimal, edit: { kind: 'style', patch: { outline: 0.7, grainSize: 3, harmony: { kind: 'auto', strength: 0.8 } } }, outcome: 'applied' },
    { name: 'style, fry alone', doc: five, edit: { kind: 'style', patch: { fry: 0.1 } }, outcome: 'applied' },
    { name: 'style, harmony off', doc: five, edit: { kind: 'style', patch: { harmony: { kind: 'off' } } }, outcome: 'applied' },
    { name: 'style, an empty patch', doc: five, edit: { kind: 'style', patch: {} }, outcome: 'unchanged' },
    // @ts-expect-error a style patch never carries paletteTargets
    { name: 'style, paletteTargets', doc: five, edit: { kind: 'style', patch: { paletteTargets: [] } }, outcome: 'unknown-key' },
    // @ts-expect-error glow is no style field
    { name: 'style, an unknown key', doc: five, edit: { kind: 'style', patch: { glow: 1 } }, outcome: 'unknown-key' },
    // @ts-expect-error saturation is a number
    { name: 'style, a string number', doc: five, edit: { kind: 'style', patch: { saturation: '0.5' } }, outcome: 'invalid' },
    // @ts-expect-error harmony's arms have no hue
    { name: 'style, an unknown key inside harmony', doc: five, edit: { kind: 'style', patch: { harmony: { kind: 'auto', strength: 0.5, hue: 3 } } }, outcome: 'invalid' },
    { name: 'style, NaN', doc: five, edit: { kind: 'style', patch: { saturation: Number.NaN } }, outcome: 'non-finite' },
    { name: 'style, Infinity', doc: five, edit: { kind: 'style', patch: { grain: Number.POSITIVE_INFINITY } }, outcome: 'non-finite' },
    // @ts-expect-error a style patch is an object
    { name: 'style, a patch that is no object', doc: five, edit: { kind: 'style', patch: null }, outcome: 'invalid' },

    { name: 'fry', doc: five, edit: { kind: 'fry', fry: 0.2 }, outcome: 'applied' },
    { name: 'fry above its range', doc: minimal, edit: { kind: 'fry', fry: 3 }, outcome: 'applied' },
    { name: 'fry NaN', doc: minimal, edit: { kind: 'fry', fry: Number.NaN }, outcome: 'non-finite' },

    { name: 'symbols', doc: minimal, edit: { kind: 'symbols', patch: { enabled: true, cellSize: 13, amount: 0.9 } }, outcome: 'applied' },
    { name: 'surface', doc: minimal, edit: { kind: 'surface', patch: { enabled: true, pattern: 'scales', relief: 1, refraction: 0.8, shine: 0.6, scale: 0.2 } }, outcome: 'applied' },
    { name: 'motion, focus null', doc: five, edit: { kind: 'motion', patch: { focus: null, orbit: 0.2 } }, outcome: 'applied' },
    { name: 'motion, focus set', doc: minimal, edit: { kind: 'motion', patch: { focus: 0.3, loopSeconds: 4.5, enabled: true } }, outcome: 'applied' },
    { name: 'lighting', doc: five, edit: { kind: 'lighting', patch: { ambient: 0.5, relief: 0.25 } }, outcome: 'applied' },

    { name: 'palette target, a new cluster', doc: five, edit: { kind: 'palette.target', cluster: 2, color: { l: 0.5, c: 0.1, h: 120 } }, outcome: 'applied' },
    { name: 'palette target, cluster 0 before the others', doc: five, edit: { kind: 'palette.target', cluster: 0, color: { l: 0.5, c: 0.1, h: 120 } }, outcome: 'applied' },
    { name: 'palette target, replacing one', doc: five, edit: { kind: 'palette.target', cluster: 1, color: { l: 0.4, c: 0.05, h: 10 } }, outcome: 'applied' },
    { name: 'palette target, cleared', doc: five, edit: { kind: 'palette.target', cluster: 3, color: null }, outcome: 'applied' },
    { name: 'palette target, clearing a cluster with none', doc: five, edit: { kind: 'palette.target', cluster: 4, color: null }, outcome: 'unchanged' },
    { name: 'palette target, an out-of-range color', doc: five, edit: { kind: 'palette.target', cluster: 2, color: { l: 2, c: 1, h: 400 } }, outcome: 'applied' },
    { name: 'palette target, cluster 5', doc: five, edit: { kind: 'palette.target', cluster: 5, color: { l: 0.5, c: 0.1, h: 120 } }, outcome: 'out-of-range' },
    { name: 'palette target, cluster -1', doc: five, edit: { kind: 'palette.target', cluster: -1, color: { l: 0.5, c: 0.1, h: 120 } }, outcome: 'out-of-range' },
    { name: 'palette target, cluster 2.5', doc: five, edit: { kind: 'palette.target', cluster: 2.5, color: { l: 0.5, c: 0.1, h: 120 } }, outcome: 'out-of-range' },
    { name: 'palette target, cluster 1 of the minimal document', doc: minimal, edit: { kind: 'palette.target', cluster: 1, color: null }, outcome: 'out-of-range' },
    { name: 'palette target, a NaN cluster', doc: five, edit: { kind: 'palette.target', cluster: Number.NaN, color: null }, outcome: 'non-finite' },

    { name: 'object add, the first object', doc: minimal, edit: { kind: 'object.add', object: tappedObject(objectId(0)) }, outcome: 'applied' },
    { name: 'object add, beside a subject', doc: five, edit: { kind: 'object.add', object: tappedObject(objectId(0)) }, outcome: 'applied' },
    { name: 'object add, an out-of-range thickness', doc: five, edit: { kind: 'object.add', object: { ...tappedObject(objectId(0)), thickness: 9 } }, outcome: 'applied' },
    { name: 'object add, restored at an index', doc: five, edit: { kind: 'object.add', object: tappedObject(objectId(0)), restore: { index: 1 } }, outcome: 'applied' },
    { name: 'object add, a 33rd object', doc: () => withObjects(32), edit: { kind: 'object.add', object: tappedObject(objectId(99)) }, outcome: 'limit' },
    { name: 'object add, an id taken', doc: five, edit: { kind: 'object.add', object: tappedObject(SUBJECT) }, outcome: 'duplicate-id' },
    {
      name: 'object add, selection.candidate 3',
      doc: five,
      edit: { kind: 'object.add', object: { ...tappedObject(objectId(0)), produced: withCandidate(refinedProduced, 3) } },
      outcome: 'invalid',
    },

    { name: 'object set, motion turns motion on', doc: minimalWithObject, edit: { kind: 'object.set', id: objectId(0), patch: { motion: { kind: 'bob', amount: 0.4 } } }, outcome: 'applied' },
    { name: 'object set, motion with motion on', doc: five, edit: { kind: 'object.set', id: SUBJECT, patch: { motion: { kind: 'sway', amount: 0.2 } } }, outcome: 'applied' },
    { name: 'object set, motion none', doc: five, edit: { kind: 'object.set', id: SUBJECT, patch: { motion: { kind: 'none' } } }, outcome: 'applied' },
    { name: 'object set, name and subject', doc: five, edit: { kind: 'object.set', id: SUBJECT, patch: { name: 'Frog', subject: false } }, outcome: 'applied' },
    { name: 'object set, recolor', doc: five, edit: { kind: 'object.set', id: BOX, patch: { recolor: { kind: 'target', color: { l: 0.5, c: 0.5, h: 30 } }, thickness: 0 } }, outcome: 'applied' },
    { name: 'object set, a name of 81 code points', doc: five, edit: { kind: 'object.set', id: SUBJECT, patch: { name: 'x'.repeat(81) } }, outcome: 'invalid' },
    // @ts-expect-error object.set never sets an id
    { name: 'object set, id', doc: five, edit: { kind: 'object.set', id: SUBJECT, patch: { id: objectId(5) } }, outcome: 'unknown-key' },
    // @ts-expect-error object.set never sets produced
    { name: 'object set, produced', doc: five, edit: { kind: 'object.set', id: SUBJECT, patch: { produced: refinedProduced } }, outcome: 'unknown-key' },
    { name: 'object set, an unknown id', doc: five, edit: { kind: 'object.set', id: objectId(7), patch: { thickness: 1 } }, outcome: 'unknown-id' },

    { name: 'object refine', doc: five, edit: { kind: 'object.refine', id: SUBJECT, produced: refinedProduced }, outcome: 'applied' },
    {
      name: 'object refine, selection.candidate 3',
      doc: five,
      edit: { kind: 'object.refine', id: SUBJECT, produced: withCandidate(refinedProduced, 3) },
      outcome: 'invalid',
    },
    {
      name: 'object refine, selection.candidate -1',
      doc: five,
      edit: { kind: 'object.refine', id: SUBJECT, produced: withCandidate(refinedProduced, -1) },
      outcome: 'invalid',
    },
    { name: 'object refine, an unknown id', doc: five, edit: { kind: 'object.refine', id: objectId(7), produced: refinedProduced }, outcome: 'unknown-id' },

    { name: 'object remove, the subject', doc: five, edit: { kind: 'object.remove', id: SUBJECT }, outcome: 'applied' },
    { name: 'object remove, the last object', doc: five, edit: { kind: 'object.remove', id: BOX }, outcome: 'applied' },
    { name: 'object remove, the only object, not the subject', doc: minimalWithObject, edit: { kind: 'object.remove', id: objectId(0) }, outcome: 'applied' },
    { name: 'object remove, an unknown id', doc: five, edit: { kind: 'object.remove', id: objectId(7) }, outcome: 'unknown-id' },

    { name: 'light add', doc: five, edit: { kind: 'light.add', light: newLightAt(lightId(0), 0.5, 0.5) }, outcome: 'applied' },
    { name: 'light add, past the frame', doc: minimal, edit: { kind: 'light.add', light: newLightAt(lightId(0), 2, -1) }, outcome: 'applied' },
    { name: 'light add, a 5th light', doc: () => withLights(4), edit: { kind: 'light.add', light: newLightAt(lightId(9), 0.5, 0.5) }, outcome: 'limit' },
    { name: 'light add, an id taken', doc: five, edit: { kind: 'light.add', light: newLightAt(KEY_LIGHT, 0.5, 0.5) }, outcome: 'duplicate-id' },
    // @ts-expect-error a light has no glow
    { name: 'light add, an unknown key', doc: five, edit: { kind: 'light.add', light: { ...newLightAt(lightId(0), 0.5, 0.5), glow: 1 } }, outcome: 'invalid' },
    { name: 'light set', doc: five, edit: { kind: 'light.set', id: KEY_LIGHT, patch: { at: { x: 1.5, y: -0.5 }, color: { l: 0.6, c: 0.4, h: 200 }, shadows: false } }, outcome: 'applied' },
    // @ts-expect-error light.set never sets an id
    { name: 'light set, id', doc: five, edit: { kind: 'light.set', id: KEY_LIGHT, patch: { id: lightId(3) } }, outcome: 'unknown-key' },
    { name: 'light set, an unknown id', doc: five, edit: { kind: 'light.set', id: lightId(7), patch: { depth: 0.1 } }, outcome: 'unknown-id' },
    { name: 'light remove', doc: five, edit: { kind: 'light.remove', id: KEY_LIGHT }, outcome: 'applied' },
    { name: 'light remove, an unknown id', doc: five, edit: { kind: 'light.remove', id: lightId(7) }, outcome: 'unknown-id' },
  ];
}
