import { plateNeeded } from '../core/derive.ts';
import { isAssetId, type AssetId, type ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';

/** Content ids include the exact bytes. Raster size/format live in the document reference. */
export async function productAsset(data: Uint8Array | Float32Array): Promise<AssetId> {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!isAssetId(id)) throw new Error('Invalid product hash.');
  return id;
}

/** One import owns this store. No worker, document or renderer owns its buffers. */
export function createProducts() {
  const depths = new Map<AssetId, Plane<'f32'>>();
  const masks = new Map<AssetId, Plane<'u8'>>();
  const plates = new Map<AssetId, Rgb8>();
  return {
    get depths(): ReadonlyMap<AssetId, Plane<'f32'>> { return depths; },
    get masks(): ReadonlyMap<AssetId, Plane<'u8'>> { return masks; },
    get plates(): ReadonlyMap<AssetId, Rgb8> { return plates; },
    putDepth: (asset: AssetId, plane: Plane<'f32'>): void => { depths.set(asset, plane); },
    putMask: (asset: AssetId, plane: Plane<'u8'>): void => { masks.set(asset, plane); },
    dropMask: (asset: AssetId): void => { masks.delete(asset); },
    retainMasks(assets: ReadonlySet<AssetId>): void {
      for (const asset of masks.keys()) if (!assets.has(asset)) masks.delete(asset);
    },
    putPlate: (asset: AssetId, image: Rgb8): void => { plates.clear(); plates.set(asset, image); },
    clear(): void { depths.clear(); masks.clear(); plates.clear(); },
    forScene(doc: SceneDocument): { masks: ReadonlyMap<ObjectId, Plane<'u8'>>; depth: Plane<'f32'> | null; plate: Rgb8 | null } {
      const byObject = new Map<ObjectId, Plane<'u8'>>();
      for (const object of doc.objects) {
        const mask = masks.get(object.produced.mask.asset);
        if (mask !== undefined) byObject.set(object.id, mask);
      }
      return {
        masks: byObject,
        depth: doc.analysis.depth === null ? null : depths.get(doc.analysis.depth.map.asset) ?? null,
        plate: doc.analysis.plate === null || plateNeeded(doc) ? null : plates.get(doc.analysis.plate.image.asset) ?? null,
      };
    },
  };
}
export type Products = ReturnType<typeof createProducts>;
