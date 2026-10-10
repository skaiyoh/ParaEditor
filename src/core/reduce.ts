// The reducer: applies the owner's edits to a scene document. Every number an
// edit sets is brought into its RANGES entry, every value an edit carries is
// then checked against the document's schema, and an edit that the clamp
// cannot make valid is refused and changes nothing. An edit that leaves every
// field it sets as it was is unchanged, and returns the input unstamped. An
// applied edit stamps `updatedAt` and returns the inverse edit list that
// restores the document, all but `updatedAt`. The input document is never
// written to; the output shares with it every field and list element the
// edit does not set.
// Pure: no browser global, no Node API, no I/O, no clock.

import type { Edit, EditResult, LightPatch, ObjectPatch, Refusal, Restore, StylePatch } from './edits.ts';
import { sameValue } from './equal.ts';
import { FRIED_FIELDS, fryCurve } from './fry.ts';
import type { NonEmpty } from './ids.ts';
import { clampToRange, LENGTHS, type ClampPath } from './ranges.ts';
import { err, ok, type Result } from './result.ts';
import {
  describeIssues,
  lightingSchema,
  lightSchema,
  motionSchema,
  objectProducedSchema,
  paletteTargetSchema,
  sceneObjectSchema,
  styleSchema,
  symbolsSchema,
  surfaceSchema,
  titleSchema,
} from './schema.ts';
import type { Lighting, Motion, SceneDocument, Symbols, Surface } from './types.ts';
import type { z } from './zod.ts';

// ---------------------------------------------------------------------------
// coercing a value an edit carries

/**
 * Brings the numbers inside a value an edit carries into range, before the
 * schema checks the whole value. `at` names the value's place in the
 * document, for a refusal's detail. A coercer passes through what it does
 * not recognize, a string where a number belongs among it, for the schema to
 * refuse.
 */
type Coercer = (value: unknown, at: string) => Result<unknown, Refusal>;

/** One coercer for every key a patch of type `P` may hold, and no other. */
type Coercers<P> = { readonly [K in keyof P]-?: Coercer };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKeyOf<C extends object>(record: C, key: string): key is Extract<keyof C, string> {
  return Object.hasOwn(record, key);
}

const keep: Coercer = (value) => ok(value);

/** A number clamped and rounded by RANGES[path]; NaN and the infinities are refused, never stored. */
function num(path: ClampPath): Coercer {
  return (value, at) => {
    if (typeof value !== 'number') return ok(value);
    if (!Number.isFinite(value)) return err({ reason: 'non-finite', detail: `${at} is ${value}` });
    return ok(clampToRange(path, value));
  };
}

/** An object whose listed keys are coerced; its other keys pass through, for the strict schema to accept or refuse. */
function fields(coercers: Readonly<Record<string, Coercer>>): Coercer {
  return (value, at) => {
    if (!isRecord(value)) return ok(value);
    const entries: [string, unknown][] = [];
    for (const [key, inner] of Object.entries(value)) {
      const coerce = (isKeyOf(coercers, key) ? coercers[key] : undefined) ?? keep;
      const coerced = coerce(inner, `${at}.${key}`);
      if (!coerced.ok) return coerced;
      entries.push([key, coerced.value]);
    }
    return ok(Object.fromEntries(entries));
  };
}

function color(l: ClampPath, c: ClampPath, h: ClampPath): Coercer {
  return fields({ l: num(l), c: num(c), h: num(h) });
}

const STYLE: Coercers<StylePatch> = {
  fry: num('style.fry'),
  colors: num('style.colors'),
  saturation: num('style.saturation'),
  harmony: fields({ strength: num('style.harmony.strength') }),
  bands: num('style.bands'),
  simplify: num('style.simplify'),
  outline: num('style.outline'),
  subjectClarity: num('style.subjectClarity'),
  grain: num('style.grain'),
  colorNoise: num('style.colorNoise'),
  grainSize: num('style.grainSize'),
  grainHold: num('style.grainHold'),
  crunch: num('style.crunch'),
  clipping: num('style.clipping'),
};

const SYMBOLS: Coercers<Partial<Symbols>> = { enabled: keep, cellSize: num('symbols.cellSize'), amount: num('symbols.amount') };

const SURFACE: Coercers<Partial<Surface>> = {
  enabled: keep, pattern: keep, relief: num('surface.relief'), refraction: num('surface.refraction'),
  shine: num('surface.shine'), scale: num('surface.scale'),
};

/** `focus` may be null, which passes through. */
const MOTION: Coercers<Partial<Motion>> = {
  enabled: keep,
  drift: fields({ amount: num('motion.drift.amount') }),
  parallax: num('motion.parallax'),
  loopSeconds: num('motion.loopSeconds'),
  focus: num('motion.focus'),
};

const LIGHTING: Coercers<Partial<Lighting>> = { ambient: num('lighting.ambient'), relief: num('lighting.relief') };

const TARGET_COLOR = color('style.paletteTargets[].color.l', 'style.paletteTargets[].color.c', 'style.paletteTargets[].color.h');

const OBJECT: Coercers<ObjectPatch> = {
  name: keep,
  hidden: keep,
  subject: keep,
  recolor: fields({ color: color('objects[].recolor.color.l', 'objects[].recolor.color.c', 'objects[].recolor.color.h') }),
  symbols: keep,
  motion: fields({ amount: num('objects[].motion.amount') }),
  thickness: num('objects[].thickness'),
};

const LIGHT: Coercers<LightPatch> = {
  at: fields({ x: num('lights[].at.x'), y: num('lights[].at.y') }),
  depth: num('lights[].depth'),
  color: color('lights[].color.l', 'lights[].color.c', 'lights[].color.h'),
  intensity: num('lights[].intensity'),
  radius: num('lights[].radius'),
  rays: num('lights[].rays'),
  shadows: keep,
  softness: num('lights[].softness'),
};

function parseWith<T>(schema: z.ZodType<T>, value: unknown, at: string): Result<T, Refusal> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err({ reason: 'invalid', detail: `${at}: ${describeIssues(parsed.error.issues)}` });
}

/** The values `source` holds at `keys`; of the document before an edit, a patch that sets them back. */
function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) picked[key] = source[key];
  return picked;
}

/** `changed` is false when every key the patch set holds the value it held before. */
type Patched<T, K extends keyof T> = {
  readonly next: T;
  readonly keys: readonly K[];
  readonly previous: Partial<Pick<T, K>>;
  readonly changed: boolean;
};

/**
 * `current` with `patch` laid over it. Every key of the patch must be one of
 * `coercers`' keys, else the patch is refused as `unknown-key`; each value is
 * coerced, and the result must pass `schema`, else it is refused as `invalid`.
 * Returns the new value, the keys the patch set, their previous values, and
 * whether any of them changed.
 * The new value takes the patched keys from the schema's parse, a copy the
 * caller's patch cannot reach, and every other key from `current` itself, so
 * that what the patch leaves alone stays shared with the input. The schemas
 * have no transforms or defaults, so the parse of an unpatched key would give
 * back an equal value.
 */
function applyPatch<T extends object, K extends keyof T & string>(input: {
  readonly current: T;
  readonly patch: unknown;
  readonly coercers: { readonly [P in K]: Coercer };
  readonly schema: z.ZodType<T>;
  readonly at: string;
}): Result<Patched<T, K>, Refusal> {
  const { current, patch, coercers, schema, at } = input;
  if (!isRecord(patch)) return err({ reason: 'invalid', detail: `the patch of ${at} is not an object` });
  const keys: K[] = [];
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isKeyOf(coercers, key)) return err({ reason: 'unknown-key', detail: `${at}.${key} is not a field this patch may set` });
    const coerced = coercers[key](value, `${at}.${key}`);
    if (!coerced.ok) return coerced;
    keys.push(key);
    entries.push([key, coerced.value]);
  }
  const parsed = parseWith(schema, { ...current, ...Object.fromEntries(entries) }, at);
  if (!parsed.ok) return parsed;
  const changed = keys.some((key) => !sameValue(parsed.value[key], current[key]));
  return ok({ next: { ...current, ...pick(parsed.value, keys) }, keys, previous: pick(current, keys), changed });
}

/** The index a restoring add puts its object or light back at, clamped to the list; null for an ordinary add, which appends. */
function restoreIndex(restore: Restore | undefined, length: number): Result<number | null, Refusal> {
  if (restore === undefined) return ok(null);
  const index: unknown = isRecord(restore) ? restore['index'] : undefined;
  if (typeof index !== 'number') return err({ reason: 'invalid', detail: 'restore.index is not a number' });
  if (!Number.isFinite(index)) return err({ reason: 'non-finite', detail: `restore.index is ${index}` });
  return ok(Math.min(length, Math.max(0, Math.round(index))));
}

function insertAt<T>(items: readonly T[], index: number | null, item: T): readonly T[] {
  const at = index ?? items.length;
  return [...items.slice(0, at), item, ...items.slice(at)];
}

function replaceAt<T>(items: readonly T[], index: number, item: T): readonly T[] {
  return items.map((existing, i) => (i === index ? item : existing));
}

function removeAt<T>(items: readonly T[], index: number): readonly T[] {
  return items.filter((_, i) => i !== index);
}

// ---------------------------------------------------------------------------
// the edits

/** What an edit did to the document, before `updatedAt` is stamped: changed it, with the inverse list, or left it as it was. */
type Reduced = { readonly kind: 'changed'; readonly doc: SceneDocument; readonly inverse: NonEmpty<Edit> } | { readonly kind: 'unchanged' };

function reduced(doc: SceneDocument, inverse: NonEmpty<Edit>): Result<Reduced, Refusal> {
  return ok({ kind: 'changed', doc, inverse });
}

const UNCHANGED: Result<Reduced, Refusal> = ok({ kind: 'unchanged' });

function findIndexById<T extends { readonly id: string }>(items: readonly T[], id: unknown, what: string): Result<{ readonly index: number; readonly item: T }, Refusal> {
  const index = items.findIndex((item) => item.id === id);
  const item = items[index];
  return item === undefined ? err({ reason: 'unknown-id', detail: `no ${what} has the id ${String(id)}` }) : ok({ index, item });
}

/** The keys of the style a `fry` edit rewrites: `fry` and the eight fried fields. */
const FRY_KEYS = ['fry', ...FRIED_FIELDS] as const;

function reduce(doc: SceneDocument, edit: Edit): Result<Reduced, Refusal> {
  switch (edit.kind) {
    case 'title': {
      const title = parseWith(titleSchema, edit.title, 'title');
      if (!title.ok) return title;
      if (title.value === doc.title) return UNCHANGED;
      return reduced({ ...doc, title: title.value }, [{ kind: 'title', title: doc.title }]);
    }
    case 'style': {
      const patched = applyPatch({ current: doc.style, patch: edit.patch, coercers: STYLE, schema: styleSchema, at: 'style' });
      if (!patched.ok) return patched;
      if (!patched.value.changed) return UNCHANGED;
      return reduced({ ...doc, style: patched.value.next }, [{ kind: 'style', patch: patched.value.previous }]);
    }
    case 'fry': {
      const coerced = num('style.fry')(edit.fry, 'fry');
      if (!coerced.ok) return coerced;
      if (typeof coerced.value !== 'number') return err({ reason: 'invalid', detail: 'fry is not a number' });
      const fry = coerced.value;
      const fried = fryCurve(fry);
      if (Object.is(doc.style.fry, fry) && FRIED_FIELDS.every((field) => Object.is(doc.style[field], fried[field]))) return UNCHANGED;
      const style = { ...doc.style, fry, ...fried };
      return reduced({ ...doc, style }, [{ kind: 'style', patch: pick(doc.style, FRY_KEYS) }]);
    }
    case 'symbols': {
      const patched = applyPatch({ current: doc.symbols, patch: edit.patch, coercers: SYMBOLS, schema: symbolsSchema, at: 'symbols' });
      if (!patched.ok) return patched;
      if (!patched.value.changed) return UNCHANGED;
      return reduced({ ...doc, symbols: patched.value.next }, [{ kind: 'symbols', patch: patched.value.previous }]);
    }
    case 'surface': {
      const patched = applyPatch({ current: doc.surface, patch: edit.patch, coercers: SURFACE, schema: surfaceSchema, at: 'surface' });
      if (!patched.ok) return patched;
      if (!patched.value.changed) return ok({ kind: 'unchanged' });
      return reduced({ ...doc, surface: patched.value.next }, [{ kind: 'surface', patch: patched.value.previous }]);
    }
    case 'motion': {
      const patched = applyPatch({ current: doc.motion, patch: edit.patch, coercers: MOTION, schema: motionSchema, at: 'motion' });
      if (!patched.ok) return patched;
      if (!patched.value.changed) return UNCHANGED;
      return reduced({ ...doc, motion: patched.value.next }, [{ kind: 'motion', patch: patched.value.previous }]);
    }
    case 'lighting': {
      const patched = applyPatch({ current: doc.lighting, patch: edit.patch, coercers: LIGHTING, schema: lightingSchema, at: 'lighting' });
      if (!patched.ok) return patched;
      if (!patched.value.changed) return UNCHANGED;
      return reduced({ ...doc, lighting: patched.value.next }, [{ kind: 'lighting', patch: patched.value.previous }]);
    }
    case 'palette.target':
      return reducePaletteTarget(doc, edit);
    case 'object.add':
      return reduceObjectAdd(doc, edit);
    case 'object.rename': {
      const found = findIndexById(doc.objects, edit.id, 'object');
      if (!found.ok) return found;
      const { index, item } = found.value;
      if (typeof edit.name !== 'string' || edit.name.trim().length === 0) return err({ reason: 'invalid', detail: 'Enter a layer name.' });
      const checked = parseWith(sceneObjectSchema, { ...item, name: edit.name }, `objects[${index}]`);
      if (!checked.ok) return checked;
      if (checked.value.name === item.name) return UNCHANGED;
      return reduced({ ...doc, objects: replaceAt(doc.objects, index, { ...item, name: checked.value.name }) }, [{ kind: 'object.set', id: item.id, patch: { name: item.name } }]);
    }
    case 'object.hide':
    case 'object.show': {
      const found = findIndexById(doc.objects, edit.id, 'object');
      if (!found.ok) return found;
      const { index, item } = found.value;
      const hidden = edit.kind === 'object.hide';
      if (item.hidden === hidden) return UNCHANGED;
      return reduced({ ...doc, objects: replaceAt(doc.objects, index, { ...item, hidden }) }, [{ kind: hidden ? 'object.show' : 'object.hide', id: item.id }]);
    }
    case 'object.set': {
      const found = findIndexById(doc.objects, edit.id, 'object');
      if (!found.ok) return found;
      const { index, item } = found.value;
      const patched = applyPatch({ current: item, patch: edit.patch, coercers: OBJECT, schema: sceneObjectSchema, at: `objects[${index}]` });
      if (!patched.ok) return patched;
      const { next, keys, previous, changed } = patched.value;
      const objects = replaceAt(doc.objects, index, next);
      const primary: Edit = { kind: 'object.set', id: item.id, patch: previous };
      // Giving an object a motion other than none turns the scene's motion
      // on. Either this edit or its primary inverse may do that, so a patch
      // that sets motion carries a trailing inverse edit that sets
      // motion.enabled back, applied after the primary inverse.
      if (keys.includes('motion')) {
        const enables = next.motion.kind !== 'none' && !doc.motion.enabled;
        if (!changed && !enables) return UNCHANGED;
        const motion = enables ? { ...doc.motion, enabled: true } : doc.motion;
        return reduced({ ...doc, objects, motion }, [primary, { kind: 'motion', patch: { enabled: doc.motion.enabled } }]);
      }
      if (!changed) return UNCHANGED;
      return reduced({ ...doc, objects }, [primary]);
    }
    case 'object.refine': {
      const found = findIndexById(doc.objects, edit.id, 'object');
      if (!found.ok) return found;
      const { index, item } = found.value;
      const produced = parseWith(objectProducedSchema, edit.produced, `objects[${index}].produced`);
      if (!produced.ok) return produced;
      if (sameValue(produced.value, item.produced)) return UNCHANGED;
      const objects = replaceAt(doc.objects, index, { ...item, produced: produced.value });
      return reduced({ ...doc, objects }, [{ kind: 'object.refine', id: item.id, produced: item.produced }]);
    }
    case 'object.remove': {
      const found = findIndexById(doc.objects, edit.id, 'object');
      if (!found.ok) return found;
      const { index, item } = found.value;
      return reduced({ ...doc, objects: removeAt(doc.objects, index) }, [{ kind: 'object.add', object: item, restore: { index } }]);
    }
    case 'light.add':
      return reduceLightAdd(doc, edit);
    case 'light.set': {
      const found = findIndexById(doc.lights, edit.id, 'light');
      if (!found.ok) return found;
      const { index, item } = found.value;
      const patched = applyPatch({ current: item, patch: edit.patch, coercers: LIGHT, schema: lightSchema, at: `lights[${index}]` });
      if (!patched.ok) return patched;
      if (!patched.value.changed) return UNCHANGED;
      const lights = replaceAt(doc.lights, index, patched.value.next);
      return reduced({ ...doc, lights }, [{ kind: 'light.set', id: item.id, patch: patched.value.previous }]);
    }
    case 'light.remove': {
      const found = findIndexById(doc.lights, edit.id, 'light');
      if (!found.ok) return found;
      const { index, item } = found.value;
      return reduced({ ...doc, lights: removeAt(doc.lights, index) }, [{ kind: 'light.add', light: item, restore: { index } }]);
    }
    default: {
      const unhandled: never = edit;
      const kind: unknown = isRecord(unhandled) ? unhandled['kind'] : unhandled;
      return err({ reason: 'invalid', detail: `no edit has the kind ${JSON.stringify(kind) ?? String(kind)}` });
    }
  }
}

/** Sets or clears one cluster's palette target, keeping the list sorted by cluster. */
function reducePaletteTarget(doc: SceneDocument, edit: Extract<Edit, { kind: 'palette.target' }>): Result<Reduced, Refusal> {
  const { cluster } = edit;
  const clusters = doc.analysis.colors.length;
  if (typeof cluster === 'number' && !Number.isFinite(cluster)) return err({ reason: 'non-finite', detail: `the palette target's cluster is ${cluster}` });
  if (typeof cluster !== 'number' || !Number.isInteger(cluster) || cluster < 0 || cluster >= clusters) {
    return err({ reason: 'out-of-range', detail: `the palette target's cluster ${String(cluster)} is not a whole number in 0 to ${clusters - 1}` });
  }
  const targets = doc.style.paletteTargets;
  // -0 and 0 name the same cluster, and === matches them. A target is set
  // outright, its cluster number as given, so a -0 where 0 is stored is a
  // change, as it is for any other number; the inverse carries the stored
  // entry's own number, so an undo never swaps one zero for the other.
  const existing = targets.find((target) => target.cluster === cluster);
  const others = targets.filter((target) => target.cluster !== cluster);
  let paletteTargets = others;
  if (edit.color === null) {
    if (existing === undefined) return UNCHANGED;
  } else {
    const coerced = TARGET_COLOR(edit.color, 'color');
    if (!coerced.ok) return coerced;
    const target = parseWith(paletteTargetSchema, { cluster, color: coerced.value }, 'the palette target');
    if (!target.ok) return target;
    if (existing !== undefined && sameValue(target.value, existing)) return UNCHANGED;
    paletteTargets = [...others, target.value].sort((a, b) => a.cluster - b.cluster);
  }
  return reduced({ ...doc, style: { ...doc.style, paletteTargets } }, [{ kind: 'palette.target', cluster: existing?.cluster ?? cluster, color: existing?.color ?? null }]);
}

/**
 * Adds an object. An ordinary add appends it, and when no object in the scene
 * is the subject, makes it the subject; a restoring add puts it back at its
 * index exactly as it was.
 */
function reduceObjectAdd(doc: SceneDocument, edit: Extract<Edit, { kind: 'object.add' }>): Result<Reduced, Refusal> {
  if (doc.objects.length >= LENGTHS.objects.max) return err({ reason: 'limit', detail: `the scene already has ${LENGTHS.objects.max} objects` });
  const index = restoreIndex(edit.restore, doc.objects.length);
  if (!index.ok) return index;
  const coerced = fields(OBJECT)(edit.object, 'object');
  if (!coerced.ok) return coerced;
  const object = parseWith(sceneObjectSchema, coerced.value, 'object');
  if (!object.ok) return object;
  const added = object.value;
  if (doc.objects.some((existing) => existing.id === added.id)) return err({ reason: 'duplicate-id', detail: `an object has the id ${added.id}` });
  const first = index.value === null && !added.subject && !doc.objects.some((existing) => existing.subject);
  const objects = insertAt(doc.objects, index.value, first ? { ...added, subject: true } : added);
  return reduced({ ...doc, objects }, [{ kind: 'object.remove', id: added.id }]);
}

/** Adds a light: appended, or put back at its index by a restoring add. */
function reduceLightAdd(doc: SceneDocument, edit: Extract<Edit, { kind: 'light.add' }>): Result<Reduced, Refusal> {
  if (doc.lights.length >= LENGTHS.lights.max) return err({ reason: 'limit', detail: `the scene already has ${LENGTHS.lights.max} lights` });
  const index = restoreIndex(edit.restore, doc.lights.length);
  if (!index.ok) return index;
  const coerced = fields(LIGHT)(edit.light, 'light');
  if (!coerced.ok) return coerced;
  const light = parseWith(lightSchema, coerced.value, 'light');
  if (!light.ok) return light;
  const added = light.value;
  if (doc.lights.some((existing) => existing.id === added.id)) return err({ reason: 'duplicate-id', detail: `a light has the id ${added.id}` });
  return reduced({ ...doc, lights: insertAt(doc.lights, index.value, added) }, [{ kind: 'light.remove', id: added.id }]);
}

// ---------------------------------------------------------------------------
// applying

/**
 * Applies one edit. Applied, the result holds the new document with
 * `updatedAt` set to `now` and the inverse list: applied in order to the
 * result, with applyEdits, it restores `doc` in every field but `updatedAt`.
 * Unchanged, every field the edit sets already held the value it sets and no
 * side effect fired: the result holds `doc` itself, unstamped, and no inverse.
 * Refused, the result holds `doc` itself and why. `now` is the time as ISO
 * 8601 in UTC, the form `Date.prototype.toISOString` writes, which the
 * document's schema requires; it is not checked here.
 */
export function applyEdit(doc: SceneDocument, edit: Edit, now: string): EditResult {
  const result = reduce(doc, edit);
  if (!result.ok) return { kind: 'refused', doc, ...result.error };
  const value = result.value;
  if (value.kind === 'unchanged') return { kind: 'unchanged', doc };
  return { kind: 'applied', doc: { ...value.doc, updatedAt: now }, inverse: value.inverse };
}

/**
 * Applies a list of edits in order, as one step: an undo or redo entry. The
 * inverse undoes the last edit first, and holds the inverses of the edits
 * that changed the document only. When every edit of the list is unchanged,
 * so is the list, and the result holds `doc` itself. If any edit is refused,
 * the whole list is: the result holds `doc` itself, and the refusal's detail
 * names the edit's index; an empty list, which the type forbids, is refused
 * as `invalid`.
 */
export function applyEdits(doc: SceneDocument, edits: NonEmpty<Edit>, now: string): EditResult {
  if (edits.length === 0) return { kind: 'refused', doc, reason: 'invalid', detail: 'the list of edits is empty' };
  let current = doc;
  let inverse: NonEmpty<Edit> | null = null;
  for (const [i, edit] of edits.entries()) {
    const result = applyEdit(current, edit, now);
    switch (result.kind) {
      case 'refused':
        return { kind: 'refused', doc, reason: result.reason, detail: `edit ${i}: ${result.detail}` };
      case 'unchanged':
        break;
      case 'applied':
        current = result.doc;
        inverse = inverse === null ? result.inverse : [...result.inverse, ...inverse];
        break;
      default: {
        const unhandled: never = result;
        return unhandled;
      }
    }
  }
  if (inverse === null) return { kind: 'unchanged', doc };
  return { kind: 'applied', doc: current, inverse };
}
