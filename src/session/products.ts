import { plateNeeded } from '../core/derive.ts';
import { isAssetId, type AssetId, type ObjectId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import type { RepairProduct } from '../core/types.ts';
import { decodeRaster, encodeRaster, inspectRaster } from '../core/asset-codec.ts';
import { holeRadius } from '../core/derive.ts';
import { effectiveOrbit } from '../core/motion.ts';
import { encodePng } from '../export/png.ts';

export type LivePlateProduct = Readonly<{ key: string; image: Rgb8; hole: Plane<'u8'>; depth: Plane<'f32'> }>;

/** Content ids include the exact bytes. Raster size/format live in the document reference. */
export async function productAsset(data: Uint8Array | Float32Array): Promise<AssetId> {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!isAssetId(id)) throw new Error('Invalid product hash.');
  return id;
}

/** Semantic request identity. Exact union/hole digests are checked before installation. */
export function repairBasis(doc: SceneDocument): string {
  return JSON.stringify([doc.frame.master, doc.analysis.depth?.map ?? null,
    doc.removals.map(removal => [removal.mask.plane, removal.threshold]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    holeRadius(doc, doc.frame.master.size), doc.motion.enabled
      ? { kind: 'loop', parallax: doc.motion.parallax, reach: effectiveOrbit(doc.motion) } : { kind: 'still' }]);
}

/** Browser PNG encoding avoids delaying repair installation with JS deflate/CRC work. */
async function repairPng(image: Rgb8): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height } = image.size;
  if (width < 1 || height < 1 || width > 2048 || height > 2048 || image.data.length !== width * height * 3) throw new Error('The repair image is incomplete.');
  if (typeof OffscreenCanvas !== 'undefined' && typeof ImageData !== 'undefined') {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let source = 0, target = 0; source < image.data.length; source += 3, target += 4) {
      rgba[target] = image.data[source]!; rgba[target + 1] = image.data[source + 1]!; rgba[target + 2] = image.data[source + 2]!; rgba[target + 3] = 255;
    }
    const png = await encodePng(new ImageData(rgba, width, height, { colorSpace: 'srgb' }));
    return new Uint8Array(await png.arrayBuffer());
  }
  // The real node driver tests use the same opaque pixels and exact stored-byte ids.
  const rows = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) rows.set(image.data.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  const stream = new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  function chunk(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, data.length); bytes.set(Array.from(name, character => character.charCodeAt(0)), 4); bytes.set(data, 8);
    let crc = 0xffffffff;
    for (const value of bytes.subarray(4, 8 + data.length)) {
      crc ^= value;
      for (let n = 0; n < 8; n++) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0); return bytes;
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/** One import owns this store. No worker, document or renderer owns its buffers. */
export function createProducts() {
  const depths = new Map<AssetId, Plane<'f32'>>();
  const masks = new Map<AssetId, Plane<'u8'>>();
  const plates = new Map<AssetId, Rgb8>();
  const assets = new Map<AssetId, Uint8Array<ArrayBuffer>>();
  const repairs = new Map<string, RepairProduct>();
  let livePlate: LivePlateProduct | null = null;
  return {
    get depths(): ReadonlyMap<AssetId, Plane<'f32'>> { return depths; },
    get masks(): ReadonlyMap<AssetId, Plane<'u8'>> { return masks; },
    get plates(): ReadonlyMap<AssetId, Rgb8> { return plates; },
    get assets(): ReadonlyMap<AssetId, Uint8Array<ArrayBuffer>> { return assets; },
    get repairs(): ReadonlyMap<string, RepairProduct> { return repairs; },
    async admitBytes(bytes: Uint8Array): Promise<AssetId> {
      const owned = new Uint8Array(bytes), asset = await productAsset(owned);
      assets.set(asset, owned); return asset;
    },
    async admitPlane(plane: Plane<'u8'> | Plane<'f32'>): Promise<AssetId> {
      const encoded = plane.format === 'u8' ? encodeRaster({ ...plane, data: new Uint8Array(plane.data) })
        : encodeRaster({ ...plane, data: new Float32Array(plane.data) });
      const asset = await productAsset(encoded);
      assets.set(asset, encoded);
      const decoded = decodeRaster(encoded, plane);
      if (decoded.format === 'u8') masks.set(asset, { ...decoded, format: 'u8' });
      else if (decoded.format === 'f32') depths.set(asset, { ...decoded, format: 'f32' });
      return asset;
    },
    async admitRgb(image: Rgb8): Promise<AssetId> {
      const owned = { size: { ...image.size }, data: new Uint8Array(image.data) };
      const bytes = await repairPng(owned), asset = await productAsset(bytes);
      assets.set(asset, bytes); plates.set(asset, owned); return asset;
    },
    installEncoded(asset: AssetId, bytes: Uint8Array): void {
      const owned = new Uint8Array(bytes); assets.set(asset, owned);
      if (owned[0] !== 78 || owned[1] !== 83 || owned[2] !== 82 || owned[3] !== 65) return;
      const descriptor = inspectRaster(owned), decoded = decodeRaster(owned, descriptor);
      if (decoded.format === 'u8') masks.set(asset, { ...decoded, format: 'u8' });
      else if (decoded.format === 'f32') depths.set(asset, { ...decoded, format: 'f32' });
    },
    installRgb(asset: AssetId, image: Rgb8): void {
      plates.set(asset, { size: { ...image.size }, data: image.data.slice() });
    },
    rememberRepair(doc: SceneDocument, repair: RepairProduct): void { repairs.set(repairBasis(doc), structuredClone(repair)); },
    forgetRepair(doc: SceneDocument): void { repairs.delete(repairBasis(doc)); },
    cachedRepair(doc: SceneDocument): RepairProduct | null { return repairs.get(repairBasis(doc)) ?? null; },
    retain(roots: ReadonlySet<AssetId>, repairRoots: ReadonlySet<string>): void {
      for (const map of [assets, masks, depths, plates]) for (const asset of map.keys()) if (!roots.has(asset)) map.delete(asset);
      for (const basis of repairs.keys()) if (!repairRoots.has(basis)) repairs.delete(basis);
    },
    get livePlate(): LivePlateProduct | null { return livePlate; },
    putLivePlate(product: LivePlateProduct): void { livePlate = product; },
    clearLivePlate(): void { livePlate = null; },
    putDepth: (asset: AssetId, plane: Plane<'f32'>): void => { depths.set(asset, plane); },
    putMask: (asset: AssetId, plane: Plane<'u8'>): void => { masks.set(asset, plane); },
    dropMask: (asset: AssetId): void => { masks.delete(asset); },
    retainMasks(assets: ReadonlySet<AssetId>): void {
      for (const asset of masks.keys()) if (!assets.has(asset)) masks.delete(asset);
    },
    putPlate: (asset: AssetId, image: Rgb8): void => { plates.clear(); plates.set(asset, image); },
    clear(): void { depths.clear(); masks.clear(); plates.clear(); assets.clear(); repairs.clear(); livePlate = null; },
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
