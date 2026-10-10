// Fixture analysis products for node tests, built over the fixture
// documents' models and asset ids. Each function returns a fresh value.

import type { AssetId } from '../../src/core/ids.ts';
import type { DepthProduct, DepthStats, PlateProduct } from '../../src/core/types.ts';
import { assetId, DEPTH_MODEL, INPAINT_MODEL } from './documents.ts';

/** A depth product whose map is the asset `0x40 + n`. */
export function depthProduct(n: number, stats: DepthStats = { p10: 0.2, median: 0.5, p90: 0.9 }): DepthProduct {
  return { model: DEPTH_MODEL, map: { asset: assetId(0x40 + n), format: 'f32', size: { width: 686, height: 518 } }, stats };
}

/** A plate made for `forMasks`, whose image is the asset `0x60 + n`. */
export function plateProduct(n: number, forMasks: readonly AssetId[]): PlateProduct {
  return { model: INPAINT_MODEL, image: { asset: assetId(0x60 + n), size: { width: 2048, height: 1536 } }, forMasks };
}
