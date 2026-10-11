import { encodeRaster, MAX_ORIGINAL_BYTES } from '../core/asset-codec.ts';
import { COMPOSITION_LIMITS } from '../core/composition-ranges.ts';
import { rasterSourceSchema, sourceIdSchema } from '../core/composition-schema.ts';
import type { SourceId } from '../core/ids.ts';
import type { Size } from '../core/raster.ts';
import type { RasterSource } from '../core/types.ts';
import { hasHeifBrand } from './decode.ts';
import { HEIC_MESSAGE } from './limits.ts';

export type ArtworkMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export type DecodedArtwork = {
  readonly source: RasterSource;
  /** Owned NSRA header + straight sRGB RGBA8 payload; hash covers both. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly path: 'resize' | 'fallback';
};
const INVALID = 'This artwork could not be opened. Try exporting it as PNG, JPEG or WebP.';

/** Unlike photos, artwork permits odd dimensions and a one-pixel short side. */
export function artworkSize(original: Size): Size {
  if (![original.width, original.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('The artwork dimensions are invalid.');
  if (original.width * original.height > 64_000_000) throw new Error('This artwork is too large. noisy opens artwork of up to 64 megapixels.');
  const scale = Math.min(1, COMPOSITION_LIMITS.rasterSide / Math.max(original.width, original.height));
  return { width: Math.max(1, Math.round(original.width * scale)), height: Math.max(1, Math.round(original.height * scale)) };
}

/** Header inspection only, not a decoder. Bound allocation before loading a browser image.
 * MIME and filename are untrusted; the native decoder validates the complete stream.
 * Animated PNG/WebP import their default/first frame, as createImageBitmap specifies.
 */
export function inspectArtwork(bytes: Uint8Array): { readonly mediaType: ArtworkMediaType; readonly size: Size } {
  if (bytes.length === 0 || bytes.length > MAX_ORIGINAL_BYTES) throw new Error('Artwork files must be nonempty and at most 24 MiB.');
  if (hasHeifBrand(bytes.subarray(0, 256))) throw new Error(HEIC_MESSAGE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const result = (mediaType: ArtworkMediaType, width: number, height: number) => {
    const size = { width, height }; artworkSize(size); return { mediaType, size };
  };
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) {
    if (view.getUint32(8) !== 13 || text(12, 4) !== 'IHDR') throw new Error(INVALID);
    return result('image/png', view.getUint32(16), view.getUint32(20));
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      // Native Chrome JPEG decoder supports baseline, extended sequential and progressive DCT.
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (length < 8) break;
        return result('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
    throw new Error(INVALID);
  }
  if (bytes.length >= 25 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error(INVALID);
    const chunk = text(12, 4), length = view.getUint32(16, true);
    if (20 + length + length % 2 > bytes.length) throw new Error(INVALID);
    if (chunk === 'VP8X' && length === 10) {
      const u24 = (offset: number) => view.getUint16(offset, true) + (view.getUint8(offset + 2) << 16);
      return result('image/webp', u24(24) + 1, u24(27) + 1);
    }
    if (chunk === 'VP8L' && length >= 5 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return result('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8 ' && length >= 10 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return result('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
  }
  throw new Error(INVALID);
}

async function orientedSize(file: Blob, encoded: Size): Promise<Size> {
  const image = new Image(), url = URL.createObjectURL(file);
  try {
    const size = await new Promise<Size>((resolve, reject) => {
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(INVALID));
      image.src = url;
    });
    // The browser may swap axes for EXIF; it may not silently downsample the original.
    if (!sameSize(size, encoded) && !sameSize(size, { width: encoded.height, height: encoded.width })) throw new Error('The artwork decoder changed its original dimensions.');
    artworkSize(size);
    return size;
  } finally {
    image.onload = null; image.onerror = null;
    image.removeAttribute('src'); URL.revokeObjectURL(url);
  }
}
function sameSize(a: Size, b: Size): boolean { return a.width === b.width && a.height === b.height; }
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** No session mutation, inference, retained object URL or bitmap ownership escapes. */
export async function decodeArtwork(input: { readonly file: File; readonly id: SourceId }): Promise<DecodedArtwork> {
  const id = sourceIdSchema.parse(input.id), { file } = input;
  if (file.size === 0 || file.size > MAX_ORIGINAL_BYTES) throw new Error('Artwork files must be nonempty and at most 24 MiB.');
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const header = inspectArtwork(originalBytes);
  // Canonical content type also handles a valid image under a misleading MIME/name.
  const blob = new Blob([originalBytes], { type: header.mediaType });
  const original = await orientedSize(blob, header.size), size = artworkSize(original);
  let decoded: ImageBitmap;
  let path: DecodedArtwork['path'];
  try {
    decoded = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default',
      resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
    if (!sameSize(decoded, size)) { decoded.close(); throw new Error('The decoder did not honor the artwork resize.'); }
    path = 'resize';
  } catch {
    decoded = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
    path = 'fallback';
  }
  try {
    if (path === 'fallback' && !sameSize(decoded, original)) throw new Error('The artwork decoder did not honor orientation.');
    const canvas = new OffscreenCanvas(size.width, size.height);
    try {
      const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb', willReadFrequently: true });
      if (context === null) throw new Error('The artwork canvas could not be created.');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(decoded, 0, 0, size.width, size.height);
      const pixels = context.getImageData(0, 0, size.width, size.height, { colorSpace: 'srgb' });
      if (pixels.colorSpace !== 'srgb') throw new Error('The artwork canvas did not provide sRGB pixels.');
      // getImageData is straight RGBA. Do not multiply fractional alpha a second time.
      const data = new Uint8Array(pixels.data);
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data.fill(0, i, i + 3);
      const bytes = encodeRaster({ format: 'rgba8-srgb-straight', size, data });
      const source = rasterSourceSchema.parse({ id,
        image: { asset: await digest(bytes), encoding: 'rgba8-srgb-straight', size },
        provenance: { kind: 'import', name: file.name.slice(0, 255), mediaType: header.mediaType,
          originalSize: original, originalDigest: await digest(originalBytes) },
      });
      return { source, bytes, path };
    } finally { canvas.width = 1; canvas.height = 1; }
  } finally { decoded.close(); }
}
