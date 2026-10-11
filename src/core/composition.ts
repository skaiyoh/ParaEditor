// Pure staged migration and transactions. C2i binds these to history/session;
// the existing v4 migration table, writer, edits and reducer remain untouched.
import {
  affinePlacementSchema, compositingPolicySchema, compositionDocumentSchema, compositionObjectIdSchema,
  depthAttachmentSchema, effectIdSchema, layerCoverageSchema, localEffectSchema, rasterSourceSchema,
  removalIdSchema, sceneLayerSchema, sourceIdSchema, sourceRemovalSchema,
} from './composition-schema.ts';
import { LEGACY_COMPOSITING_POLICY } from './composition-ranges.ts';
import { sameValue } from './equal.ts';
import type { NonEmpty } from './ids.ts';
import { legacyDocumentSchema, legacyV4DocumentSchema } from './legacy-schema.ts';
import { MIGRATIONS } from './migrate.ts';
import { err, ok, type Result } from './result.ts';
import { describeIssues, peekVersion, type ParseError } from './schema.ts';
import type { CompositionDocument, CompositionEdit, SceneLayer } from './types.ts';
import { z } from './zod.ts';

function parse<T>(schema: z.ZodType<T>, value: unknown): Result<T, ParseError> {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data) : err({ kind: 'invalid', detail: describeIssues(parsed.error.issues) });
  } catch {
    return err({ kind: 'invalid', detail: 'The composition could not be read.' });
  }
}

/** No clock, ids, pixels or inference are manufactured. Old caches are validated before discard. */
export function migrateV4ToV5(json: unknown): Result<CompositionDocument, ParseError> {
  const checked = parse(legacyV4DocumentSchema, json);
  if (!checked.ok) return checked;
  const doc = checked.value;
  const objects = doc.objects.map((object): SceneLayer => {
    const { model, selection, ...coverage } = object.produced;
    const placement = { translate: { x: 0, y: 0 }, pivot: {
      x: coverage.bounds.x + coverage.bounds.width / 2, y: coverage.bounds.y + coverage.bounds.height / 2,
    }, scale: 1, rotation: 0 };
    return {
      ...object, content: { kind: 'source', source: { kind: 'photo' } }, origin: { kind: 'photo-region' },
      produced: { ...coverage, mask: { ...coverage.mask, format: 'u8' }, sampling: 'legacy-threshold', provenance: { kind: 'ai', model, selection: { ...selection, size: selection.size ?? .5 } } },
      placement, home: placement, opacity: 1,
      depthAttachment: doc.analysis.depth === null ? { kind: 'plane', disparity: .5 }
        : { kind: 'source', map: { ...doc.analysis.depth.map, format: 'f32' }, model: doc.analysis.depth.model, offset: 0 },
    };
  });
  return parse(compositionDocumentSchema, {
    ...doc, version: 5, analysis: { ...doc.analysis, plate: null }, objects,
    sources: [], localEffects: [], compositing: LEGACY_COMPOSITING_POLICY,
    removals: objects.map((layer) => ({ id: layer.id, source: { kind: 'photo' },
      mask: { plane: layer.produced.mask, provenance: layer.produced.provenance }, threshold: 128,
      ownership: { kind: 'legacy-layer', layer: layer.id } })),
  });
}

/** Staged 0-to-5 reader; consumers continue using schema.parseDocument (v4). */
export function parseCompositionDocument(json: unknown): Result<CompositionDocument, ParseError> {
  const peek = peekVersion(json);
  if (!peek.ok) return peek;
  const { version, writer } = peek.value;
  if (version > 5) return err({ kind: 'newer-version', version, writer });
  if (version === 5) return parse(compositionDocumentSchema, json);
  if (version === 4) return migrateV4ToV5(json);
  if (version !== 0 && version !== 1 && version !== 2 && version !== 3) return err({ kind: 'not-a-scene' });
  // Validate historical fields before a legacy migration can overwrite them.
  const legacy = parse(legacyDocumentSchema(version), json);
  if (!legacy.ok) return legacy;
  let current: unknown = legacy.value;
  for (let i = version; i < 4; i++) {
    const migration = MIGRATIONS[i];
    if (migration === undefined) return err({ kind: 'invalid', detail: `Missing legacy migration ${i}.` });
    current = migration(current);
  }
  return migrateV4ToV5(current);
}

const indexSchema = z.number().int().nonnegative();
export const compositionEditSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('layer.add'), layer: sceneLayerSchema, index: indexSchema }),
  z.strictObject({ kind: z.literal('layer.remove'), id: compositionObjectIdSchema }),
  z.strictObject({ kind: z.literal('layer.placement'), id: compositionObjectIdSchema, value: affinePlacementSchema }),
  z.strictObject({ kind: z.literal('layer.opacity'), id: compositionObjectIdSchema, opacity: z.number().min(0).max(1) }),
  z.strictObject({ kind: z.literal('layer.coverage'), id: compositionObjectIdSchema, value: layerCoverageSchema }),
  z.strictObject({ kind: z.literal('layer.depth'), id: compositionObjectIdSchema, value: depthAttachmentSchema }),
  z.strictObject({ kind: z.literal('source.add'), source: rasterSourceSchema, index: indexSchema }),
  z.strictObject({ kind: z.literal('source.remove'), id: sourceIdSchema }),
  z.strictObject({ kind: z.literal('removal.set'), id: removalIdSchema, value: sourceRemovalSchema.nullable(), index: indexSchema }),
  z.strictObject({ kind: z.literal('effect.set'), id: effectIdSchema, value: localEffectSchema.nullable(), index: indexSchema }),
  z.strictObject({ kind: z.literal('compositing'), value: compositingPolicySchema }),
]).readonly();
const editListSchema = z.tuple([compositionEditSchema], compositionEditSchema).readonly();
export type CompositionRefusal = { readonly reason: 'invalid' | 'unknown-id' | 'duplicate-id' | 'out-of-range'; readonly detail: string };
export type CompositionEditResult =
  | { readonly kind: 'applied'; readonly doc: CompositionDocument; readonly forward: NonEmpty<CompositionEdit>; readonly inverse: NonEmpty<CompositionEdit> }
  | { readonly kind: 'unchanged'; readonly doc: CompositionDocument }
  | ({ readonly kind: 'refused'; readonly doc: CompositionDocument } & CompositionRefusal);
type Step = { readonly doc: CompositionDocument; readonly inverse: readonly CompositionEdit[] };
function insert<T>(items: readonly T[], index: number, item: T): readonly T[] { return [...items.slice(0, index), item, ...items.slice(index)]; }
function at<T extends { readonly id: string }>(items: readonly T[], id: string): Result<{ readonly item: T; readonly index: number }, CompositionRefusal> {
  const index = items.findIndex((item) => item.id === id), item = items[index];
  return item === undefined ? err({ reason: 'unknown-id', detail: `No record has id ${id}.` }) : ok({ item, index });
}
function validIndex(index: number, length: number): Result<number, CompositionRefusal> {
  return index <= length ? ok(index) : err({ reason: 'out-of-range', detail: `Insertion index ${index} exceeds ${length}.` });
}

function reduceComposition(doc: CompositionDocument, edit: CompositionEdit): Result<Step, CompositionRefusal> {
  switch (edit.kind) {
    case 'compositing': return ok({ doc: { ...doc, compositing: edit.value }, inverse: [{ kind: 'compositing', value: doc.compositing }] });
    case 'layer.add': {
      if (doc.objects.some((layer) => layer.id === edit.layer.id)) return err({ reason: 'duplicate-id', detail: 'Layer id already exists.' });
      const index = validIndex(edit.index, doc.objects.length);
      if (!index.ok) return index;
      return ok({ doc: { ...doc, objects: insert(doc.objects, index.value, edit.layer) }, inverse: [{ kind: 'layer.remove', id: edit.layer.id }] });
    }
    case 'layer.remove': {
      const found = at(doc.objects, edit.id);
      if (!found.ok) return found;
      return ok({ doc: { ...doc, objects: doc.objects.filter((layer) => layer.id !== edit.id) },
        inverse: [{ kind: 'layer.add', layer: found.value.item, index: found.value.index }] });
    }
    case 'layer.placement':
    case 'layer.opacity':
    case 'layer.coverage':
    case 'layer.depth': {
      const found = at(doc.objects, edit.id);
      if (!found.ok) return found;
      const layer = found.value.item;
      let next: SceneLayer, inverse: CompositionEdit;
      switch (edit.kind) {
        case 'layer.placement': next = { ...layer, placement: edit.value }; inverse = { ...edit, value: layer.placement }; break;
        case 'layer.opacity': next = { ...layer, opacity: edit.opacity }; inverse = { ...edit, opacity: layer.opacity }; break;
        case 'layer.coverage': next = { ...layer, produced: edit.value }; inverse = { ...edit, value: layer.produced }; break;
        case 'layer.depth': next = { ...layer, depthAttachment: edit.value }; inverse = { ...edit, value: layer.depthAttachment }; break;
        default: { const unhandled: never = edit; return unhandled; }
      }
      return ok({ doc: { ...doc, objects: doc.objects.map((item) => item.id === edit.id ? next : item) }, inverse: [inverse] });
    }
    case 'source.add': {
      if (doc.sources.some((source) => source.id === edit.source.id)) return err({ reason: 'duplicate-id', detail: 'Source id already exists.' });
      const index = validIndex(edit.index, doc.sources.length);
      if (!index.ok) return index;
      return ok({ doc: { ...doc, sources: insert(doc.sources, index.value, edit.source) }, inverse: [{ kind: 'source.remove', id: edit.source.id }] });
    }
    case 'source.remove': {
      const found = at(doc.sources, edit.id);
      if (!found.ok) return found;
      return ok({ doc: { ...doc, sources: doc.sources.filter((source) => source.id !== edit.id) },
        inverse: [{ kind: 'source.add', source: found.value.item, index: found.value.index }] });
    }
    case 'removal.set': {
      const index = doc.removals.findIndex((item) => item.id === edit.id), previous = doc.removals[index];
      if (edit.value === null && previous === undefined) return ok({ doc, inverse: [] });
      if (edit.value !== null && edit.value.id !== edit.id) return err({ reason: 'invalid', detail: 'Removal id differs from edit id.' });
      const others = doc.removals.filter((item) => item.id !== edit.id);
      if (edit.value !== null) { const valid = validIndex(edit.index, others.length); if (!valid.ok) return valid; }
      return ok({ doc: { ...doc, removals: edit.value === null ? others : insert(others, edit.index, edit.value) },
        inverse: [{ kind: 'removal.set', id: edit.id, value: previous ?? null, index: previous === undefined ? edit.index : index }] });
    }
    case 'effect.set': {
      const index = doc.localEffects.findIndex((item) => item.id === edit.id), previous = doc.localEffects[index];
      if (edit.value === null && previous === undefined) return ok({ doc, inverse: [] });
      if (edit.value !== null && edit.value.id !== edit.id) return err({ reason: 'invalid', detail: 'Effect id differs from edit id.' });
      const others = doc.localEffects.filter((item) => item.id !== edit.id);
      if (edit.value !== null) { const valid = validIndex(edit.index, others.length); if (!valid.ok) return valid; }
      return ok({ doc: { ...doc, localEffects: edit.value === null ? others : insert(others, edit.index, edit.value) },
        inverse: [{ kind: 'effect.set', id: edit.id, value: previous ?? null, index: previous === undefined ? edit.index : index }] });
    }
    default: { const unhandled: never = edit; return unhandled; }
  }
}

/** Semantic layer deletion, including exactly its owned effects and legacy removal.
 * The primitive layer.remove does not cascade: otherwise reversing layer.add
 * could also erase records changed earlier in the same transaction.
 */
export function removeLayerEdits(doc: CompositionDocument, id: SceneLayer['id']): Result<NonEmpty<CompositionEdit>, CompositionRefusal> {
  const found = at(doc.objects, id);
  if (!found.ok) return found;
  const effects = doc.localEffects.flatMap((effect, index): CompositionEdit[] => effect.owner.kind === 'layer' && effect.owner.id === id
    ? [{ kind: 'effect.set', id: effect.id, value: null, index }] : []);
  const removals = doc.removals.flatMap((removal, index): CompositionEdit[] => removal.ownership.kind === 'legacy-layer' && removal.ownership.layer === id
    ? [{ kind: 'removal.set', id: removal.id, value: null, index }] : []);
  return ok([{ kind: 'layer.remove', id }, ...effects, ...removals]);
}

/**
 * Shape-check once, apply privately, then check final references. Temporary
 * dangling refs inside a transaction are allowed; none escape the boundary.
 * No-op/refusal returns the input identity unstamped. Inverses set only edited
 * fields, preserving unrelated analysis arriving before Undo. Indices never clamp.
 * This is the 32-readable-layer primitive; session creation enforces the cap of 8.
 */
export function applyCompositionEdits(doc: CompositionDocument, edits: NonEmpty<CompositionEdit>, now: string): CompositionEditResult {
  const checked = parse(editListSchema, edits);
  if (!checked.ok) return { kind: 'refused', doc, reason: 'invalid', detail: checked.error.kind === 'invalid' ? checked.error.detail : 'Invalid edit list.' };
  let current = doc;
  let inverse: readonly CompositionEdit[] = [];
  const forward: CompositionEdit[] = [];
  for (const [index, edit] of checked.value.entries()) {
    const reduced = reduceComposition(current, edit);
    if (!reduced.ok) return { kind: 'refused', doc, ...reduced.error, detail: `edit ${index}: ${reduced.error.detail}` };
    if (!sameValue(current, reduced.value.doc)) {
      current = reduced.value.doc;
      inverse = [...reduced.value.inverse, ...inverse];
      forward.push(edit);
    }
  }
  if (sameValue(doc, current)) return { kind: 'unchanged', doc };
  const final = parse(compositionDocumentSchema, { ...current, updatedAt: now });
  if (!final.ok) return { kind: 'refused', doc, reason: 'invalid', detail: final.error.kind === 'invalid' ? final.error.detail : 'Invalid transaction.' };
  const [firstInverse, ...restInverse] = inverse, [firstForward, ...restForward] = forward;
  if (firstInverse === undefined || firstForward === undefined) return { kind: 'unchanged', doc };
  // Edits were parsed into frozen copies; preserve untouched subtrees of doc.
  return { kind: 'applied', doc: { ...current, updatedAt: now }, forward: [firstForward, ...restForward], inverse: [firstInverse, ...restInverse] };
}
export function applyCompositionEdit(doc: CompositionDocument, edit: CompositionEdit, now: string): CompositionEditResult {
  return applyCompositionEdits(doc, [edit], now);
}
