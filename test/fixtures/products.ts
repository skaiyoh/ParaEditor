// Fixture analysis products for node tests, built over the fixture
// documents' models and asset ids. Each function returns a fresh value.

import { compositionAssetIdSchema } from '../../src/core/composition-schema.ts';
import { holeRadius } from '../../src/core/derive.ts';
import { effectiveOrbit } from '../../src/core/motion.ts';
import type { AssetId } from '../../src/core/ids.ts';
import type { DepthProduct, DepthStats, PlateProduct, SceneDocument } from '../../src/core/types.ts';
import { assetId, DEPTH_MODEL, INPAINT_MODEL, fiveClusterDocument } from './documents.ts';

/** A depth product whose map is the asset `0x40 + n`. */
export function depthProduct(n: number, stats: DepthStats = { p10: 0.2, median: 0.5, p90: 0.9 }): DepthProduct {
  return { model: DEPTH_MODEL, map: { asset: assetId(0x40 + n), format: 'f32', size: { width: 686, height: 518 } }, stats };
}

/** A repair made for the fixture's exact typed basis; alternate masks give a different union digest. */
export function plateProduct(n: number, forMasks: readonly AssetId[], doc: SceneDocument = fiveClusterDocument()): PlateProduct {
  const matches = forMasks.length === doc.objects.length && [...forMasks].sort().every((asset, index) => asset === doc.objects.map((layer) => layer.produced.mask.asset).sort()[index]);
  const key = doc.analysis.plate?.key ?? { algorithm: 'photo-repair-v2', source: doc.frame.master.asset, size: doc.frame.master.size,
    removalUnion: assetId(0x23), hole: assetId(0x24), depth: doc.analysis.depth?.map.asset ?? null,
    radius: holeRadius(doc, doc.frame.master.size), purpose: { kind: 'still' }, model: INPAINT_MODEL } satisfies PlateProduct['key'];
  return { key: { ...key, removalUnion: fixtureRemovalDigest(forMasks), source: doc.frame.master.asset,
      size: doc.frame.master.size, depth: doc.analysis.depth?.map.asset ?? null,
      radius: holeRadius(doc, doc.frame.master.size) + (matches ? 0 : 1),
      purpose: doc.motion.enabled ? { kind: 'loop', parallax: doc.motion.parallax, reach: effectiveOrbit(doc.motion) } : { kind: 'still' } },
    image: { asset: assetId(0x60 + n), size: doc.frame.master.size },
    backgroundDepth: { asset: assetId(0x80 + n), format: 'f32', size: doc.analysis.depth?.map.size ?? doc.frame.master.size } };
}

/** Deterministic fixture identity, not a production pixel digest. */
function fixtureRemovalDigest(masks: readonly AssetId[]): AssetId {
  const bits = [...masks].sort().reduce((current, mask) => (current * 31n + BigInt(`0x${mask}`)) % (1n << 256n), 0x1000n);
  return compositionAssetIdSchema.parse(bits.toString(16).padStart(64, '0'));
}
