import type { InputColor } from '../core/color.ts';
import type { ImagePoint, Size } from '../core/raster.ts';

export type CompareMode = 'edited' | 'source-photo' | 'treatments-off';
export type SampleSource = 'edited' | 'source';
export type SampleColorRequest = { readonly at: ImagePoint; readonly source: SampleSource };
export type SampleColorResult =
  | { readonly kind: 'sampled'; readonly color: InputColor }
  | { readonly kind: 'refused'; readonly reason: string };

/** Display coordinates are already unletterboxed, top-left/y-down frame fractions. */
export function samplePixel(at: ImagePoint, size: Size): ImagePoint | null {
  if (![at.x, at.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  return { x: Math.min(size.width - 1, Math.floor(at.x * size.width)),
    y: Math.min(size.height - 1, Math.floor(at.y * size.height)) };
}
