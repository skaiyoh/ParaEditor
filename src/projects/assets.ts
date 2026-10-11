import { collectCompositionAssets, measureCompositionAssets, type CompositionAssetInventory, type CompositionAssetRef } from '../core/asset-refs.ts';
import { inspectPng, inspectRaster, MAX_ASSET_BYTES, MAX_ORIGINAL_BYTES } from '../core/asset-codec.ts';
import { COMPOSITION_LIMITS } from '../core/composition-ranges.ts';
import { isAssetId, type AssetId } from '../core/ids.ts';
import type { CompositionDocument } from '../core/types.ts';

export { MAX_ASSET_BYTES, MAX_ORIGINAL_BYTES } from '../core/asset-codec.ts';

export async function hashAsset(bytes: Uint8Array): Promise<AssetId> {
  // Copy the exact view, never the potentially larger backing buffer.
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  const id = [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (!isAssetId(id)) throw new Error('The asset hash is invalid.');
  return id;
}

export function compositionInventory(document: CompositionDocument): CompositionAssetInventory {
  const result = collectCompositionAssets([{ kind: 'document', document }]);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

/** Every v2 reference is immutable, including retained original files. */
export function compositionAssetPath(asset: AssetId, _refs: readonly CompositionAssetRef[]): string {
  return `assets/${asset}`;
}
export function compositionAssetLimit(refs: readonly CompositionAssetRef[]): number {
  return refs.every((ref) => ref.kind === 'original') ? MAX_ORIGINAL_BYTES : MAX_ASSET_BYTES;
}

/** Stream inflation into a row counter, avoiding decompression-bomb allocations. */
async function validatePng(bytes: Uint8Array): Promise<ReturnType<typeof inspectPng>> {
  const png = inspectPng(bytes);
  const stream = new Blob(png.compressed.map((part) => new Uint8Array(part))).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  let row = 0, remaining = 0, filter = 0, position = 0;
  let current = new Uint8Array(0), previous = new Uint8Array(0);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      for (const byte of next.value) {
        if (remaining === 0) {
          const descriptor = png.rows[row++];
          if (descriptor === undefined || byte > 4) throw new Error('The PNG decoded rows are invalid.');
          remaining = descriptor.bytes; filter = byte; position = 0;
          if (png.indexed !== null) {
            previous = descriptor.first ? new Uint8Array(descriptor.bytes) : current;
            current = new Uint8Array(descriptor.bytes);
          }
        } else {
          if (png.indexed !== null) {
            const left = current[position - 1] ?? 0, up = previous[position] ?? 0, corner = previous[position - 1] ?? 0;
            const estimate = left + up - corner;
            const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
            const paeth = a <= b && a <= c ? left : b <= c ? up : corner;
            const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth;
            const decoded = (byte + predicted) & 255;
            current[position] = decoded;
            const pixels = png.rows[row - 1]?.pixels ?? 0, depth = png.indexed.depth;
            for (let sample = 0; sample < 8 / depth && position * (8 / depth) + sample < pixels; sample++) {
              const index = (decoded >>> (8 - depth * (sample + 1))) & ((1 << depth) - 1);
              if (index >= png.indexed.entries) throw new Error('The PNG palette index is invalid.');
            }
          }
          position++; remaining--;
        }
      }
    }
    if (remaining !== 0 || row !== png.rows.length) throw new Error('The PNG decoded size is incomplete.');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return png;
}

/** Generic uploads are self-describing PNG/NSRA only. No paint or opaque kind. */
export async function validateGenericAsset(bytes: Uint8Array, asset: AssetId): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error('The project asset is too large or empty.');
  if (await hashAsset(bytes) !== asset) throw new Error('The project asset bytes are invalid.');
  if (bytes[0] === 137) await validatePng(bytes);
  else inspectRaster(bytes);
}

export async function validateCompositionAsset(bytes: Uint8Array, asset: AssetId, refs: readonly CompositionAssetRef[]): Promise<void> {
  if (refs.length === 0 || bytes.byteLength === 0 || bytes.byteLength > compositionAssetLimit(refs)) throw new Error('The project asset is too large or unreferenced.');
  if (await hashAsset(bytes) !== asset) throw new Error('The project asset bytes are invalid.');
  let png: Awaited<ReturnType<typeof validatePng>> | undefined;
  for (const ref of refs) {
    if (ref.asset !== asset || (ref.byteLength !== null && ref.byteLength !== bytes.byteLength)) throw new Error('The asset byte length conflicts with its descriptor.');
    if (ref.kind === 'raster') {
      const actual = inspectRaster(bytes);
      if (actual.format !== ref.format || actual.size.width !== ref.size.width || actual.size.height !== ref.size.height) throw new Error('The raster header conflicts with its descriptor.');
    } else if (ref.kind === 'png') {
      png ??= await validatePng(bytes);
      if (png.size.width !== ref.size.width || png.size.height !== ref.size.height) throw new Error('The PNG dimensions conflict with its descriptor.');
    }
  }
}

/** Validate complete checkpoints sequentially, including actual depth + offset. */
export async function validateCompositionAssets(document: CompositionDocument,
  read: (asset: AssetId, refs: readonly CompositionAssetRef[]) => Promise<Uint8Array | null>,
): Promise<{ readonly bytes: number; readonly assets: number }> {
  const inventory = compositionInventory(document), lengths = new Map<AssetId, number>();
  let additional = 0;
  for (const [asset, refs] of inventory) {
    const bytes = await read(asset, refs);
    if (bytes === null) throw new Error('A committed project asset is missing.');
    await validateCompositionAsset(bytes, asset, refs);
    lengths.set(asset, bytes.byteLength);
    if (refs.some((ref) => ref.kind !== 'original')) additional += bytes.byteLength;
    if (additional > COMPOSITION_LIMITS.activeAssetBytes) throw new Error('The composition exceeds its 64 MiB asset budget.');
    for (const layer of document.objects) {
      const depth = layer.depthAttachment;
      if (depth.kind !== 'source' || depth.map.asset !== asset) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 16; i < bytes.byteLength; i += 4) {
        const value = view.getFloat32(i, true) + depth.offset;
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('The layer depth offset places samples outside zero to one.');
      }
    }
  }
  const measured = measureCompositionAssets(inventory, lengths);
  if (!measured.ok) throw new Error(measured.error.detail);
  return measured.value;
}

/** Bound a network/storage body before allocation, including absent Content-Length. */
export async function readAssetBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (body === null) throw new Error('The project asset body is missing.');
  const reader = body.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error('The project asset body is too large.');
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
