import { checkPhotoSize, HEIC_MESSAGE, type Size } from './limits.ts';

export type DecodedPhoto = {
  readonly original: Size;
  readonly pixels: ImageData;
  readonly bitmap: ImageBitmap;
  readonly path: 'resize' | 'fallback';
};

/** HEIF's major or compatible brands in its leading ftyp box, not a filename guess. */
export function hasHeifBrand(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const end = Math.min(length, bytes.length);
  for (let i = 8; i + 4 <= end; i += 4) {
    if (i === 12) continue; // minor version
    if (['heic', 'heix', 'mif1', 'msf1'].includes(String.fromCharCode(...bytes.subarray(i, i + 4)))) return true;
  }
  return false;
}

async function orientedSize(file: File): Promise<Size> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    return await new Promise<Size>((resolve, reject) => {
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('This photo could not be opened. Try exporting it as JPEG.'));
      image.src = url;
    });
  } finally {
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
    image.removeAttribute('src');
  }
}

export async function decodePhoto(file: File): Promise<DecodedPhoto> {
  // This demo targets Chrome, which has no HEIF decoder. Refuse before loading
  // an unsupported image URL so the refusal produces no browser console error.
  if (hasHeifBrand(new Uint8Array(await file.slice(0, 256).arrayBuffer()))) throw new Error(HEIC_MESSAGE);
  const original = await orientedSize(file);
  const limit = checkPhotoSize(original);
  if (limit.kind !== 'accepted') throw new Error(limit.message);
  const { width, height } = limit.size;
  let decoded: ImageBitmap;
  let path: DecodedPhoto['path'];
  try {
    decoded = await createImageBitmap(file, {
      imageOrientation: 'from-image', colorSpaceConversion: 'default',
      resizeWidth: width, resizeHeight: height, resizeQuality: 'high',
    });
    if (decoded.width !== width || decoded.height !== height) {
      decoded.close();
      throw new Error('The decoder did not honor the resize options.');
    }
    path = 'resize';
  } catch {
    decoded = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
    path = 'fallback';
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb', willReadFrequently: true });
  try {
    if (context === null) throw new Error('The photo canvas could not be created.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    return { original, pixels, bitmap: await createImageBitmap(pixels), path };
  } finally {
    decoded.close();
  }
}
