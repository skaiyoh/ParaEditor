import { holeMask } from './derive.ts';
import { sortedMasks } from './produce.ts';
import { createPerspectiveGeometry, lateralEnvelope, type PerspectiveGeometry } from './perspective.ts';
import type { ObjectId } from './ids.ts';
import type { Plane } from './raster.ts';
import type { SceneDocument } from './types.ts';

export type LiveCoverage = Readonly<{ key: string; radius: number; geometry: PerspectiveGeometry }>;

/** A disc contains every near/far relative displacement at the rectangular travel extremes. */
export function liveCoverage(doc: SceneDocument, input: PerspectiveGeometry): LiveCoverage | null {
  if (doc.analysis.depth === null) return null;
  const geometry = createPerspectiveGeometry(input), envelope = lateralEnvelope(geometry);
  const relative = 1 / geometry.nearFactor - 1 / geometry.farFactor;
  const span = 1 - 2 * geometry.crop, size = doc.frame.master.size;
  const dx = relative * envelope.max.x * span / geometry.aperture.width * size.width;
  const dy = relative * envelope.max.y * span / geometry.aperture.height * size.height;
  const radius = Math.ceil(Math.hypot(dx, dy)) + 2;
  const key = JSON.stringify({ purpose: 'live-perspective-v1', photo: doc.frame.master.asset, size,
    depth: doc.analysis.depth.map.asset, masks: sortedMasks(doc), geometry, envelope, radius });
  return { key, radius, geometry };
}

/** Reuse the existing mask union and exact Euclidean dilation with an explicit local extent. */
export function liveHoleMask(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, coverage: LiveCoverage): Plane<'u8'> {
  const baseRadius = Math.ceil(Math.max(doc.frame.master.size.width, doc.frame.master.size.height) / 100);
  return holeMask({ ...doc, motion: { ...doc.motion, parallax: coverage.radius / baseRadius } }, masks, doc.frame.master.size);
}
