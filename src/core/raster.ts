// Sizes, points, colors, and pixel planes shared by every module.
// Pure: no browser global, no Node API, no I/O.

import type { AssetId } from './ids.ts';

/** Integers, each at least 1. */
export type Size = { readonly width: number; readonly height: number };
/** In master pixels. */
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
/** Frame fractions, (0, 0) at the top left. */
export type ImagePoint = { readonly x: number; readonly y: number };
export type Oklab = { readonly L: number; readonly a: number; readonly b: number };
/** h in degrees. */
export type Oklch = { readonly l: number; readonly c: number; readonly h: number };

export type PlaneFormat = 'u8' | 'f32';
/** An asset holding a plane: raw little-endian, row-major, no header; the format and size live here. */
export type PlaneRef = { readonly asset: AssetId; readonly format: PlaneFormat; readonly size: Size };
/** An asset holding a PNG: sRGB, opaque. */
export type ImageRef = { readonly asset: AssetId; readonly size: Size };
export type Plane<F extends PlaneFormat> = {
  readonly format: F;
  readonly size: Size;
  readonly data: F extends 'f32' ? Float32Array : Uint8Array;
};
/** 3 bytes per pixel. */
export type Rgb8 = { readonly size: Size; readonly data: Uint8Array };
