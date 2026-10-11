import { z } from '../core/zod.ts';
import type { Size } from '../core/raster.ts';

export const PAINT_TILE_SIZE = 256;
export const PAINT_PATCH_LIMIT = 64;
export const PAINT_SOURCE_BYTE_LIMIT = 64 * 1024 * 1024;
/** Additional resources only, including transactional replacements and two reserved math targets. */
export const PAINT_GPU_BYTE_LIMIT = 192 * 1024 * 1024;
export const PAINT_UPLOAD_SIDE = PAINT_TILE_SIZE + 2;
export const PAINT_UPLOAD_BYTES = PAINT_UPLOAD_SIDE ** 2 * 4;

const integer = z.number().int().min(0).max(2048);
const side = z.number().int().min(1).max(2048);
const tileSchema = z.strictObject({
  x: integer, y: integer,
  width: z.number().int().min(1).max(PAINT_TILE_SIZE), height: z.number().int().min(1).max(PAINT_TILE_SIZE),
  rgba: z.instanceof(Uint8Array),
});
const planeSchema = z.strictObject({
  id: z.string().min(1).max(128), disparity: z.number().min(0).max(1),
  bounds: z.strictObject({ x: integer, y: integer, width: side, height: side }),
  tiles: z.array(tileSchema).max(64), opacity: z.number().min(0).max(1), visible: z.boolean(),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
/** Tile x/y are indices relative to bounds; edge tiles have clipped dimensions.
 * Bytes are straight-sRGB RGBA8, row zero at the top. Missing tiles are transparent.
 * An admitted snapshot is immutable: replace changed RGBA arrays, never mutate them in place. */
export type PaintTile = z.infer<typeof tileSchema>;
export type PaintPlane = Readonly<Omit<z.infer<typeof planeSchema>, 'tiles'>> & { readonly tiles: readonly PaintTile[] };
/** Disparity is the rendered, interpolated photo coordinate, not an unquantized CPU-map lookup. */
export type PaintDepthCapture = { readonly kind: 'captured'; readonly disparity: number } | { readonly kind: 'refused'; readonly reason: string };
export type PaintAdmission = { readonly kind: 'accepted' } | { readonly kind: 'refused'; readonly reason: string };
export type PaintResources = {
  readonly planes: number; readonly tiles: number; readonly targets: number; readonly depthBuffers: number;
  readonly programs: number; readonly vertexArrays: number; readonly buffers: number;
  readonly tileBytes: number; readonly targetBytes: number; readonly meshBytes: number;
  readonly reservedMathBytes: number; readonly uploadScratchBytes: number; readonly residentBytes: number;
  readonly accountedBytes: number; readonly limitBytes: number;
};

export function validatePaintPlanes(input: readonly PaintPlane[], size: Size): readonly PaintPlane[] {
  const planes = z.array(planeSchema).max(PAINT_PATCH_LIMIT).parse(input);
  const ids = new Set<string>(), orders = new Set<number>();
  const sourceBytes = planes.reduce((sum, plane) => sum + plane.tiles.reduce((sum, tile) => sum + tile.rgba.byteLength, 0), 0);
  if (sourceBytes > PAINT_SOURCE_BYTE_LIMIT) throw new Error('Paint exceeds the 64 MiB active raster budget. Existing paint is unchanged.');
  for (const plane of planes) {
    if (ids.has(plane.id) || orders.has(plane.order)) throw new Error('Paint ids and entry orders must be unique.');
    ids.add(plane.id); orders.add(plane.order);
    const { bounds } = plane;
    if (bounds.x + bounds.width > size.width || bounds.y + bounds.height > size.height) throw new Error('Paint bounds exceed the photo.');
    const keys = new Set<string>();
    for (const tile of plane.tiles) {
      const key = `${tile.x},${tile.y}`;
      if (keys.has(key) || tile.x * PAINT_TILE_SIZE >= bounds.width || tile.y * PAINT_TILE_SIZE >= bounds.height ||
        tile.width !== Math.min(PAINT_TILE_SIZE, bounds.width - tile.x * PAINT_TILE_SIZE) ||
        tile.height !== Math.min(PAINT_TILE_SIZE, bounds.height - tile.y * PAINT_TILE_SIZE) ||
        tile.rgba.byteLength !== tile.width * tile.height * 4) throw new Error('Paint tiles must be unique and match their clipped bounds.');
      keys.add(key);
    }
  }
  // Parallel planes cannot cross. Ascending disparity and then entry order is exact.
  return planes.sort((a, b) => a.disparity - b.disparity || a.order - b.order);
}

export function paintResources(size: Size, planes: number, tiles: number, prepared = false): PaintResources {
  const active = planes > 0 || prepared;
  // R32F resolved depth + DEPTH16, R32F warped depth, RGBA16F linear, RGBA8 encoded.
  const targetBytes = active ? size.width * size.height * 22 : 0;
  const tileBytes = tiles * PAINT_UPLOAD_BYTES, meshBytes = active ? 44 : 0;
  const reservedMathBytes = active ? size.width * size.height * 8 : 0;
  // Reserve the one-tile upload as GPU scratch too, even on unified-memory implementations.
  const uploadScratchBytes = active ? PAINT_UPLOAD_BYTES : 0;
  const residentBytes = targetBytes + tileBytes + meshBytes;
  return { planes, tiles, targets: active ? 4 : 0, depthBuffers: active ? 1 : 0, programs: active ? 7 : 0, vertexArrays: active ? 1 : 0, buffers: active ? 2 : 0, tileBytes, targetBytes, meshBytes,
    reservedMathBytes, uploadScratchBytes, residentBytes,
    accountedBytes: residentBytes + reservedMathBytes + uploadScratchBytes, limitBytes: PAINT_GPU_BYTE_LIMIT };
}

/** Layer opacity/visibility/order updates reuse immutable pixel storage. Gutters depend on the whole sparse neighborhood. */
export function samePaintPixels(a: PaintPlane, b: PaintPlane): boolean {
  if (a.bounds.width !== b.bounds.width || a.bounds.height !== b.bounds.height || a.tiles.length !== b.tiles.length) return false;
  const tiles = new Map(a.tiles.map(tile => [`${tile.x},${tile.y}`, tile]));
  return b.tiles.every(tile => {
    const old = tiles.get(`${tile.x},${tile.y}`);
    return old !== undefined && old.width === tile.width && old.height === tile.height && old.rgba === tile.rgba;
  });
}

/** Peak admission happens before shader, target or tile allocation, preserving the preceding set. */
export function admitPaintResources(next: PaintResources, retainedTileBytes: number): PaintAdmission {
  const peak = next.accountedBytes + retainedTileBytes;
  return peak <= PAINT_GPU_BYTE_LIMIT ? { kind: 'accepted' } : {
    kind: 'refused', reason: `Paint needs ${peak} GPU bytes during replacement; the limit is ${PAINT_GPU_BYTE_LIMIT}. Existing paint is unchanged.`,
  };
}

/** A one-pixel gutter preserves linear-premultiplied filtering across sparse tile seams. */
export function paintTileUpload(plane: PaintPlane, tile: PaintTile): Uint8Array {
  const bytes = new Uint8Array(PAINT_UPLOAD_BYTES);
  const tiles = new Map(plane.tiles.map(value => [`${value.x},${value.y}`, value]));
  for (let y = -1; y <= tile.height; y++) for (let x = -1; x <= tile.width; x++) {
    const px = tile.x * PAINT_TILE_SIZE + x, py = tile.y * PAINT_TILE_SIZE + y;
    if (px < 0 || py < 0 || px >= plane.bounds.width || py >= plane.bounds.height) continue;
    const tx = Math.floor(px / PAINT_TILE_SIZE), ty = Math.floor(py / PAINT_TILE_SIZE);
    const source = tiles.get(`${tx},${ty}`);
    if (source === undefined) continue;
    const from = ((py - ty * PAINT_TILE_SIZE) * source.width + px - tx * PAINT_TILE_SIZE) * 4;
    bytes.set(source.rgba.subarray(from, from + 4), ((y + 1) * PAINT_UPLOAD_SIDE + x + 1) * 4);
  }
  return bytes;
}
