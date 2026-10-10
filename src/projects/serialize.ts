import { isAssetId } from '../core/ids.ts';
import type { AssetId } from '../core/ids.ts';
import type { Plane, Size } from '../core/raster.ts';
import { parseDocument } from '../core/schema.ts';
import type { SceneDocument } from '../core/types.ts';
import { z } from '../core/zod.ts';

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
export function serializeDocument(document: SceneDocument): unknown {
  const json: unknown = JSON.parse(JSON.stringify(document));
  deserializeDocument(json);
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

export type SavedScene = { readonly document: SceneDocument; readonly masks: Readonly<Record<string, Size>>; readonly revision: number };

export function deserializeScene(json: unknown): SavedScene {
  const parsed = sceneSchema.parse(json);
  const document = deserializeDocument(parsed.document);
  const refs = new Map(document.objects.map((object) => [object.produced.mask.asset, object.produced.mask.size]));
  if (refs.size !== Object.keys(parsed.masks).length) throw new Error('The project masks do not match its objects.');
  for (const object of document.objects) {
    const ref = object.produced.mask, size = parsed.masks[ref.asset];
    if (size === undefined || size.width !== ref.size.width || size.height !== ref.size.height) throw new Error('The project masks do not match its objects.');
    maskLength(size);
  }
  return { document, masks: parsed.masks, revision: parsed.revision };
}

export function serializeScene(document: SceneDocument, planes: ReadonlyMap<AssetId, Plane<'u8'>>, revision: number) {
  const masks: Record<string, Size> = {};
  for (const object of document.objects) {
    const ref = object.produced.mask, plane = planes.get(ref.asset);
    if (plane === undefined || plane.size.width !== ref.size.width || plane.size.height !== ref.size.height) throw new Error('A project mask is missing.');
    serializeMask(plane);
    masks[ref.asset] = { ...plane.size };
  }
  const payload = { document: serializeDocument(document), masks, revision };
  deserializeScene(payload);
  return payload;
}
