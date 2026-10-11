export type Size = { readonly width: number; readonly height: number };
export const LONG_EDGE_MESSAGE = 'This photo is too small. ParaEditor needs at least 512 pixels on its long side.';
export const SHORT_SIDE_MESSAGE = 'This photo is too narrow. Fitted within 2048 pixels, its short side would be under the 64 pixels ParaEditor needs.';
export const TOO_LARGE_MESSAGE = 'This photo is too large. ParaEditor opens photos of up to 64 megapixels.';
export const HEIC_MESSAGE = "Export HEIC/HEIF as JPEG or PNG. For new photos: Settings > Camera > Formats > Most Compatible.";

export type PhotoLimit =
  | { readonly kind: 'accepted'; readonly size: Size }
  | { readonly kind: 'too-small'; readonly limit: 'long-edge' | 'master-short-side'; readonly original: Size; readonly message: string }
  | { readonly kind: 'too-large'; readonly original: Size; readonly message: string };

export function masterSize({ width, height }: Size): Size {
  const L = Math.max(width, height);
  const S = Math.min(width, height);
  const long = 2 * Math.floor(Math.min(2048, L) / 2);
  const short = 2 * Math.round(S * long / L / 2);
  return width >= height ? { width: long, height: short } : { width: short, height: long };
}

export function checkPhotoSize(original: Size): PhotoLimit {
  if (Math.max(original.width, original.height) < 512) {
    return { kind: 'too-small', limit: 'long-edge', original, message: LONG_EDGE_MESSAGE };
  }
  const size = masterSize(original);
  if (Math.min(size.width, size.height) < 64) {
    return { kind: 'too-small', limit: 'master-short-side', original, message: SHORT_SIDE_MESSAGE };
  }
  if (original.width * original.height > 64_000_000) {
    return { kind: 'too-large', original, message: TOO_LARGE_MESSAGE };
  }
  return { kind: 'accepted', size };
}
