import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import type { Size } from './raster.ts';

export const RASTER_HEADER_BYTES = 16;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_ORIGINAL_BYTES = 24 * 1024 * 1024;
export const MAX_RASTER_PAYLOAD_BYTES = 16 * 1024 * 1024;
export type RasterFormat = 'u8' | 'f32' | 'rgba8-srgb-straight';
export type RasterInput =
  | { readonly format: 'f32'; readonly size: Size; readonly data: Float32Array }
  | { readonly format: 'u8' | 'rgba8-srgb-straight'; readonly size: Size; readonly data: Uint8Array };

function payloadLength(format: RasterFormat, size: Size): number {
  if (![size.width, size.height].every((n) => Number.isInteger(n) && n > 0 && n <= COMPOSITION_LIMITS.rasterSide)) throw new Error('The asset dimensions are invalid.');
  return size.width * size.height * (format === 'u8' ? 1 : 4);
}
function depthSample(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('The depth asset must contain finite samples from zero to one.');
}

/** Payload-only session data becomes an owned, explicitly little-endian wire view. */
export function encodeRaster(input: RasterInput): Uint8Array<ArrayBuffer> {
  const length = payloadLength(input.format, input.size);
  if (input.data.byteLength !== length) throw new Error('The raster size does not match its bytes.');
  const bytes = new Uint8Array(RASTER_HEADER_BYTES + length), view = new DataView(bytes.buffer);
  bytes.set([78, 83, 82, 65, 1, input.format === 'u8' ? 1 : input.format === 'f32' ? 2 : 3, 0, 0]);
  view.setUint32(8, input.size.width, true); view.setUint32(12, input.size.height, true);
  if (input.format === 'f32') {
    input.data.forEach((value, i) => { depthSample(value); view.setFloat32(RASTER_HEADER_BYTES + i * 4, value, true); });
  } else bytes.set(input.data, RASTER_HEADER_BYTES);
  return bytes;
}

/** No allocation until the entire header, length and all depth samples pass. */
export function inspectRaster(bytes: Uint8Array): { readonly format: RasterFormat; readonly size: Size } {
  if (bytes.byteLength < RASTER_HEADER_BYTES || bytes.byteLength > RASTER_HEADER_BYTES + MAX_RASTER_PAYLOAD_BYTES ||
      bytes[0] !== 78 || bytes[1] !== 83 || bytes[2] !== 82 || bytes[3] !== 65 || bytes[4] !== 1 || bytes[6] !== 0 || bytes[7] !== 0) throw new Error('The raster header is invalid.');
  const format = bytes[5] === 1 ? 'u8' : bytes[5] === 2 ? 'f32' : bytes[5] === 3 ? 'rgba8-srgb-straight' : null;
  if (format === null) throw new Error('The raster format is unsupported.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = { width: view.getUint32(8, true), height: view.getUint32(12, true) };
  if (bytes.byteLength !== RASTER_HEADER_BYTES + payloadLength(format, size)) throw new Error('The raster size does not match its bytes.');
  if (format === 'f32') for (let offset = RASTER_HEADER_BYTES; offset < bytes.byteLength; offset += 4) depthSample(view.getFloat32(offset, true));
  return { format, size };
}

export function decodeRaster(bytes: Uint8Array, expected: { readonly format: RasterFormat; readonly size: Size }): RasterInput {
  const actual = inspectRaster(bytes);
  if (actual.format !== expected.format || actual.size.width !== expected.size.width || actual.size.height !== expected.size.height) throw new Error('The raster header conflicts with its descriptor.');
  if (actual.format !== 'f32') return { ...actual, format: actual.format, data: new Uint8Array(bytes.subarray(RASTER_HEADER_BYTES)) };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(actual.size.width * actual.size.height);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(RASTER_HEADER_BYTES + i * 4, true);
  return { ...actual, format: 'f32', data };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1) === 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Validate PNG framing/CRC/dimensions before decode. Returns bounded IDAT views. */
export function inspectPng(bytes: Uint8Array): { readonly size: Size; readonly rows: readonly { readonly bytes: number; readonly pixels: number; readonly first: boolean }[]; readonly indexed: { readonly depth: number; readonly entries: number } | null; readonly compressed: readonly Uint8Array[] } {
  if (bytes.length > MAX_ASSET_BYTES || bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) throw new Error('The PNG signature or length is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size: Size | null = null, bits = 0, interlace = 0, palette = false, dataEnded = false, ended = false;
  let color = 0, bitDepth = 0, paletteEntries = 0;
  const compressed: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('The PNG chunk is incomplete.');
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length || crc(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('The PNG chunk checksum is invalid.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2]?.toUpperCase()) throw new Error('The PNG chunk type is invalid.');
    const start = offset + 8;
    if (size === null && type !== 'IHDR') throw new Error('The PNG header is missing.');
    if (type === 'IHDR') {
      if (size !== null || length !== 13) throw new Error('The PNG header is invalid.');
      size = { width: view.getUint32(start), height: view.getUint32(start + 4) };
      payloadLength('rgba8-srgb-straight', size);
      const depth = bytes[start + 8]; color = bytes[start + 9] ?? -1;
      const channels = color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
      const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
      if (depth === undefined || channels === 0 || !depths.includes(depth) || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || (bytes[start + 12] !== 0 && bytes[start + 12] !== 1)) throw new Error('The PNG encoding is invalid.');
      bitDepth = depth; bits = channels * depth; interlace = bytes[start + 12] ?? 0;
    } else if (type === 'PLTE') {
      if (palette || compressed.length > 0 || length === 0 || length % 3 !== 0 || length > 768 || color === 0 || color === 4) throw new Error('The PNG palette is invalid.');
      paletteEntries = length / 3;
      if (color === 3 && paletteEntries > 2 ** bitDepth) throw new Error('The PNG palette is too large.');
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) throw new Error('The PNG image data is invalid.');
      compressed.push(bytes.subarray(start, start + length));
    } else if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || compressed.length === 0) throw new Error('The PNG ending is invalid.');
      ended = true;
    } else if (type[0] === type[0]?.toUpperCase()) throw new Error('The PNG has an unsupported critical chunk.');
    if (type !== 'IDAT' && compressed.length > 0) dataEnded = true;
    offset = end;
  }
  if (size === null || !ended) throw new Error('The PNG is incomplete.');
  const rows: { bytes: number; pixels: number; first: boolean }[] = [];
  const passes = interlace === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  for (const [x = 0, y = 0, dx = 1, dy = 1] of passes) {
    const width = Math.ceil((size.width - x) / dx), height = Math.ceil((size.height - y) / dy);
    if (width > 0 && height > 0) for (let row = 0; row < height; row++) rows.push({ bytes: Math.ceil(width * bits / 8), pixels: width, first: row === 0 });
  }
  return { size, rows, indexed: color === 3 ? { depth: bitDepth, entries: paletteEntries } : null, compressed };
}
