// Applies analysis products to a scene document, and drops a scene's source.
// Neither is an edit: neither has an inverse, and neither enters the undo
// history. A product the document has moved past changes nothing, so a result
// that lands late can never undo what the owner did since it was asked for.
// Every value a product writes is checked against the document's schema
// first, so a product applied to a valid document leaves it valid.
// Pure: no browser global, no Node API, no I/O, no clock.

import type { Produce, ProduceResult } from './edits.ts';
import { sameValue } from './equal.ts';
import type { AssetId } from './ids.ts';
import { compositionAnalysisSchema, compositionDocumentSchema, layerCoverageSchema, repairProductSchema, repairRequestKeySchema, sceneLayerSchema } from './composition-schema.ts';
import { linkedRemoval } from './reduce.ts';
import { remixDocumentSchema, serializeRemixDocument } from './remix-schema.ts';
import { describeIssues } from './schema.ts';
import type { Analysis, LegacySceneDocument, SceneDocument } from './types.ts';
import type { z } from './zod.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function check<T>(schema: z.ZodType<T>, value: unknown, at: string): Checked<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, detail: `${at}: ${describeIssues(parsed.error.issues)}` };
}

/** The mask asset of every object, sorted as a plate's `forMasks` is. */
export function sortedMasks(doc: SceneDocument | LegacySceneDocument): readonly AssetId[] {
  return doc.objects.map((object) => object.produced.mask.asset).sort();
}

/**
 * Applies one analysis product. `now` is the time as ISO 8601 in UTC, as
 * `applyEdit` takes it.
 * - `depth` replaces `analysis.depth`, whatever it held.
 * - `plate` replaces `analysis.plate` only for the exact required repair key,
 *   current source extent, and depth map; a late repair for another basis is
 *   unchanged.
 * - `object.depth` replaces the depth statistics of the object with its id,
 *   whatever they held; for an id no object has it is unchanged.
 * - `auto-subject` sets `analysis.autoSubject` to `done`, and when the scene
 *   has no object, adds `found` as the subject. When any object exists or
 *   `autoSubject` is already `done`, `found` is dropped; `found: null` adds
 *   nothing.
 * A product that would leave the document as it is, the same depth again
 * among them, is unchanged too.
 */
export function applyProduce(doc: SceneDocument, product: Produce, now: string): ProduceResult {
  const next = produce(doc, product);
  switch (next.kind) {
    case 'changed': {
      // Validate against the document's own version; a v6 read document is checked in its serialized form.
      const checked = next.doc.version === 6 ? check(remixDocumentSchema, serializeRemixDocument(next.doc), 'document') : check(compositionDocumentSchema, next.doc, 'document');
      if (!checked.ok) return { kind: 'refused', doc, detail: checked.detail };
      return { kind: 'applied', doc: { ...next.doc, updatedAt: now } };
    }
    case 'unchanged':
      return { kind: 'unchanged', doc };
    case 'refused':
      return { kind: 'refused', doc, detail: next.detail };
    default: {
      const unhandled: never = next;
      return unhandled;
    }
  }
}

type Produced =
  | { readonly kind: 'changed'; readonly doc: SceneDocument }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly detail: string };

const UNCHANGED: Produced = { kind: 'unchanged' };

function produce(doc: SceneDocument, product: Produce): Produced {
  switch (product.kind) {
    case 'depth': {
      const depth = check(compositionAnalysisSchema.unwrap().shape.depth.unwrap(), product.depth, 'analysis.depth');
      if (!depth.ok) return { kind: 'refused', detail: depth.detail };
      if (sameValue(depth.value, doc.analysis.depth)) return UNCHANGED;
      return { kind: 'changed', doc: { ...doc, analysis: { ...doc.analysis, depth: depth.value,
        plate: doc.analysis.plate?.key.depth === depth.value.map.asset ? doc.analysis.plate : null } } };
    }
    case 'plate': {
      const plate = check(repairProductSchema, product.plate, 'analysis.plate');
      if (!plate.ok) return { kind: 'refused', detail: plate.detail };
      const required = check(repairRequestKeySchema, product.required, 'required');
      if (!required.ok) return { kind: 'refused', detail: required.detail };
      if (!sameValue(plate.value.key, required.value) || plate.value.key.source !== doc.frame.master.asset
        || !sameValue(plate.value.key.size, doc.frame.master.size) || !sameValue(plate.value.image.size, doc.frame.master.size)
        || !sameValue(plate.value.backgroundDepth.size, doc.analysis.depth?.map.size ?? doc.frame.master.size)
        || plate.value.key.depth !== (doc.analysis.depth?.map.asset ?? null)) return UNCHANGED;
      if (sameValue(plate.value, doc.analysis.plate)) return UNCHANGED;
      return { kind: 'changed', doc: { ...doc, analysis: { ...doc.analysis, plate: plate.value } } };
    }
    case 'object.depth': {
      const index = doc.objects.findIndex((object) => object.id === product.id);
      const object = doc.objects[index];
      if (object === undefined) return UNCHANGED;
      const produced = check(layerCoverageSchema, { ...object.produced, depth: product.depth }, `objects[${index}].produced`);
      if (!produced.ok) return { kind: 'refused', detail: produced.detail };
      if (sameValue(produced.value.depth, object.produced.depth)) return UNCHANGED;
      const objects = doc.objects.map((existing, i) => (i === index ? { ...object, produced: { ...object.produced, depth: produced.value.depth } } : existing));
      return { kind: 'changed', doc: { ...doc, objects } };
    }
    case 'auto-subject': {
      if (doc.analysis.autoSubject === 'done') return UNCHANGED;
      const analysis: Analysis = { ...doc.analysis, autoSubject: 'done' };
      if (product.found === null || doc.objects.length > 0) return { kind: 'changed', doc: { ...doc, analysis } };
      const found = check(sceneLayerSchema, { ...product.found, subject: true }, 'objects[0]');
      if (!found.ok) return { kind: 'refused', detail: found.detail };
      return { kind: 'changed', doc: { ...doc, analysis, objects: [found.value],
        removals: found.value.origin.kind === 'photo-region' ? [...doc.removals, linkedRemoval(found.value)] : doc.removals } };
    }
    default: {
      const unhandled: never = product;
      const kind: unknown = isRecord(unhandled) ? unhandled['kind'] : unhandled;
      return { kind: 'refused', detail: `no product has the kind ${JSON.stringify(kind) ?? String(kind)}` };
    }
  }
}

/**
 * The owner's "Drop original": `frame.source` becomes null and `updatedAt` is
 * stamped with `now`. It is not an edit, so it has no inverse and enters no
 * undo history; the Library applies it to a closed scene.
 */
export function dropSource(doc: SceneDocument, now: string): SceneDocument {
  return { ...doc, frame: { ...doc.frame, source: null }, updatedAt: now };
}
