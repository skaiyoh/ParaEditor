import { holeMask, repairHole, sourceRemovalUnion } from './derive.ts';
import { sortedMasks } from './produce.ts';
import { createPerspectiveGeometry, lateralEnvelope, type PerspectiveGeometry } from './perspective.ts';
import type { AssetId, ObjectId } from './ids.ts';
import type { Plane } from './raster.ts';
import type { LegacySceneDocument, SceneDocument } from './types.ts';

export type LiveCoverage = Readonly<{ key: string; radius: number; geometry: PerspectiveGeometry }>;

/** A disc contains every near/far relative displacement at the rectangular travel extremes. */
export function liveCoverage(doc: SceneDocument | LegacySceneDocument, input: PerspectiveGeometry): LiveCoverage | null {
  if (doc.analysis.depth === null) return null;
  const geometry = createPerspectiveGeometry(input), envelope = lateralEnvelope(geometry);
  const relative = 1 / geometry.nearFactor - 1 / geometry.farFactor;
  const span = 1 - 2 * geometry.crop, size = doc.frame.master.size;
  const dx = relative * envelope.max.x * span / geometry.aperture.width * size.width;
  const dy = relative * envelope.max.y * span / geometry.aperture.height * size.height;
  const radius = Math.ceil(Math.hypot(dx, dy)) + 2;
  const removalBasis = doc.version === 4 ? { masks: sortedMasks(doc) } : {
    removals: doc.removals.map((removal) => [removal.source, removal.mask.plane, removal.threshold])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  const key = JSON.stringify({ purpose: 'live-perspective-v1', photo: doc.frame.master.asset, size,
    depth: doc.analysis.depth.map.asset, ...removalBasis, geometry, envelope, radius });
  return { key, radius, geometry };
}

/** Reuse the existing mask union and exact Euclidean dilation with an explicit local extent. */
export function liveHoleMask(doc: SceneDocument | LegacySceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>,
  coverage: LiveCoverage, removalMasks?: ReadonlyMap<AssetId, Plane<'u8'>>): Plane<'u8'> {
  const baseRadius = Math.ceil(Math.max(doc.frame.master.size.width, doc.frame.master.size.height) / 100);
  if (doc.version === 5 && removalMasks !== undefined) {
    return repairHole({ ...doc, motion: { ...doc.motion, parallax: coverage.radius / baseRadius } },
      sourceRemovalUnion(doc, removalMasks, doc.frame.master.size));
  }
  return holeMask({ ...doc, motion: { ...doc.motion, parallax: coverage.radius / baseRadius } }, masks, doc.frame.master.size);
}
