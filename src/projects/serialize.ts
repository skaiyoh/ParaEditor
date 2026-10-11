import { isAssetId } from '../core/ids.ts';
import type { AssetId } from '../core/ids.ts';
import type { Plane, Size } from '../core/raster.ts';
import { parseDocument, parseLegacyDocument } from '../core/schema.ts';
import type { LegacySceneDocument, SceneDocument } from '../core/types.ts';
import { z } from '../core/zod.ts';
import { compositionDocumentSchema } from '../core/composition-schema.ts';
import { remixDocumentSchema, serializeRemixDocument, withDerivedGrainStyle, type RemixDocument } from '../core/remix-schema.ts';

export const MAX_MASK_BYTES = 16 * 1024 * 1024;
const sizeSchema = z.strictObject({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) });
const assetSchema = z.custom<AssetId>((value) => typeof value === 'string' && isAssetId(value));
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sceneSchema = z.strictObject({ document: z.unknown(), masks: z.record(assetSchema, sizeSchema), revision: revisionSchema });

export function deserializeDocument(json: unknown): SceneDocument {
  const parsed = parseDocument(json);
  if (!parsed.ok) throw new Error('The project document is invalid or uses an unsupported version.');
  return parsed.value;
}

/** JSON transport always re-enters through the versioned document parser. */
export function serializeDocument(document: SceneDocument | RemixDocument): unknown {
  const json: unknown = JSON.parse(JSON.stringify(document.version === 6 ? serializeRemixDocument(document) : document));
  deserializeDocument(json);
  return json;
}

/** Frozen v4 transport for old Projects and gallery manifests. */
export function deserializeLegacyDocument(json: unknown): LegacySceneDocument {
  const parsed = parseLegacyDocument(json);
  if (!parsed.ok) throw new Error('The legacy project document is invalid or uses an unsupported version.');
  return parsed.value;
}
export function serializeLegacyDocument(document: LegacySceneDocument): unknown {
  const json: unknown = JSON.parse(JSON.stringify(document));
  deserializeLegacyDocument(json);
  return json;
}

function maskLength(size: Size): number {
  const parsed = sizeSchema.parse(size);
  const length = parsed.width * parsed.height;
  if (length > MAX_MASK_BYTES) throw new Error('The project mask is too large.');
  return length;
}

export function serializeMask(mask: Plane<'u8'>): Uint8Array<ArrayBuffer> {
  if (mask.format !== 'u8' || mask.data.byteLength !== maskLength(mask.size)) throw new Error('The project mask size does not match its bytes.');
  return new Uint8Array(mask.data);
}

export function deserializeMask(bytes: Uint8Array, size: Size): Plane<'u8'> {
  if (bytes.byteLength !== maskLength(size)) throw new Error('The project mask size does not match its bytes.');
  return { format: 'u8', size: { ...size }, data: new Uint8Array(bytes) };
}

export type SavedScene = { readonly document: LegacySceneDocument; readonly masks: Readonly<Record<string, Size>>; readonly revision: number };

export function deserializeScene(json: unknown): SavedScene {
  const parsed = sceneSchema.parse(json);
  const document = deserializeLegacyDocument(parsed.document);
  const refs = new Map(document.objects.map((object) => [object.produced.mask.asset, object.produced.mask.size]));
  if (refs.size !== Object.keys(parsed.masks).length) throw new Error('The project masks do not match its objects.');
  for (const object of document.objects) {
    const ref = object.produced.mask, size = parsed.masks[ref.asset];
    if (size === undefined || size.width !== ref.size.width || size.height !== ref.size.height) throw new Error('The project masks do not match its objects.');
    maskLength(size);
  }
  return { document, masks: parsed.masks, revision: parsed.revision };
}

export function serializeScene(document: LegacySceneDocument, planes: ReadonlyMap<AssetId, Plane<'u8'>>, revision: number) {
  const masks: Record<string, Size> = {};
  for (const object of document.objects) {
    const ref = object.produced.mask, plane = planes.get(ref.asset);
    if (plane === undefined || plane.size.width !== ref.size.width || plane.size.height !== ref.size.height) throw new Error('A project mask is missing.');
    serializeMask(plane);
    masks[ref.asset] = { ...plane.size };
  }
  const payload = { document: serializeLegacyDocument(document), masks, revision };
  deserializeScene(payload);
  return payload;
}

export const PROJECTS_TRANSPORT_VERSION = 2;
const compositionSceneSchema = z.strictObject({ transportVersion: z.literal(PROJECTS_TRANSPORT_VERSION),
  document: z.discriminatedUnion('version', [compositionDocumentSchema, remixDocumentSchema]), revision: revisionSchema }).readonly();
export type SavedCompositionWire = z.infer<typeof compositionSceneSchema>;
export type SavedComposition = Omit<SavedCompositionWire, 'document'> & { readonly document: SceneDocument };

/** Active v2 boundary. Never migrate an old envelope into a complete checkpoint. */
export function deserializeCompositionScene(json: unknown): SavedComposition {
  const scene = compositionSceneSchema.parse(json);
  return { ...scene, document: withDerivedGrainStyle(scene.document) };
}
export function serializeCompositionScene(document: SceneDocument | RemixDocument, revision: number): SavedCompositionWire {
  return compositionSceneSchema.parse({ transportVersion: PROJECTS_TRANSPORT_VERSION,
    document: document.version === 6 ? serializeRemixDocument(document) : document, revision });
}
export type ProjectEnvelope =
  | { readonly kind: 'legacy'; readonly scene: SavedScene }
  | { readonly kind: 'composition'; readonly scene: SavedComposition };
export function deserializeProjectEnvelope(json: unknown): ProjectEnvelope {
  if (typeof json === 'object' && json !== null && 'transportVersion' in json) return { kind: 'composition', scene: deserializeCompositionScene(json) };
  return { kind: 'legacy', scene: deserializeScene(json) };
}
