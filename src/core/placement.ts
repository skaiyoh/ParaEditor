import { affinePlacementSchema, compositionSizeSchema } from './composition-schema.ts';
import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import type { Rect, Size } from './raster.ts';
import type { AffinePlacement, DepthAttachment } from './types.ts';
import { z } from './zod.ts';

/** Pixel edges, top-left origin, y down; texel centers are (x + .5, y + .5). */
export type PlacementPoint = AffinePlacement['pivot'];
export type PlacementSpace = { readonly source: Size; readonly master: Size };
const pointSchema = z.strictObject({ x: z.number(), y: z.number() }).readonly();

/** Finite angles wrap; scale, pivot and translation never clamp. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new Error('Rotation must be finite.');
  const remainder = degrees % 360;
  const result = remainder >= 180 ? remainder - 360 : remainder < -180 ? remainder + 360 : remainder;
  return result === 0 ? 0 : result;
}

export function validatePlacement(input: { readonly placement: AffinePlacement; readonly space: PlacementSpace }): AffinePlacement {
  const source = compositionSizeSchema.parse(input.space.source);
  const master = compositionSizeSchema.parse(input.space.master);
  const p = affinePlacementSchema.parse(input.placement);
  if (p.pivot.x < 0 || p.pivot.y < 0 || p.pivot.x > source.width || p.pivot.y > source.height) {
    throw new Error('The placement pivot must lie within its source extent.');
  }
  if (Math.abs(p.translate.x) > COMPOSITION_LIMITS.translationDimensions * master.width ||
      Math.abs(p.translate.y) > COMPOSITION_LIMITS.translationDimensions * master.height) {
    throw new Error('Placement translation exceeds four master dimensions.');
  }
  return p;
}

export function createPlacement(input: { readonly placement: AffinePlacement; readonly space: PlacementSpace }): AffinePlacement {
  return validatePlacement({ ...input, placement: { ...input.placement, rotation: normalizeRotation(input.placement.rotation) } });
}

/** Compile once per placement, then share this mapping for color, alpha, masks and depth. */
export function placementMapping(input: { readonly placement: AffinePlacement; readonly space: PlacementSpace }): {
  readonly sourceToScene: (point: PlacementPoint) => PlacementPoint;
  readonly sceneToSource: (point: PlacementPoint) => PlacementPoint;
} {
  const p = validatePlacement(input), angle = p.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const x0 = p.translate.x + p.pivot.x, y0 = p.translate.y + p.pivot.y;
  return {
    sourceToScene(point) {
      pointSchema.parse(point);
      const x = (point.x - p.pivot.x) * p.scale, y = (point.y - p.pivot.y) * p.scale;
      return pointSchema.parse({ x: x0 + c * x - s * y, y: y0 + s * x + c * y });
    },
    sceneToSource(point) {
      pointSchema.parse(point);
      const x = point.x - x0, y = point.y - y0;
      return pointSchema.parse({ x: p.pivot.x + (c * x + s * y) / p.scale,
        y: p.pivot.y + (-s * x + c * y) / p.scale });
    },
  };
}

/** No enlargement of small graphics; larger sources fit the master on both axes.
 * Prefer the source center pivot. On extreme aspect ratios, choose the nearest
 * admissible pivot so the centered fit still obeys master-relative translation bounds.
 */
export function artworkHome(space: PlacementSpace): AffinePlacement {
  const source = compositionSizeSchema.parse(space.source), master = compositionSizeSchema.parse(space.master);
  const scale = Math.min(1, master.width / source.width, master.height / source.height);
  const axis = (extent: number, frame: number) => {
    const pivot = extent / 2, translate = (frame - extent) / 2;
    const limit = COMPOSITION_LIMITS.translationDimensions * frame;
    if (translate >= -limit) return { pivot, translate };
    const offset = (frame - scale * extent) / 2;
    return { pivot: (offset + limit) / (1 - scale), translate: -limit };
  };
  const x = axis(source.width, master.width), y = axis(source.height, master.height);
  return createPlacement({ space, placement: {
    pivot: { x: x.pivot, y: y.pivot }, translate: { x: x.translate, y: y.translate }, scale, rotation: 0,
  } });
}

/** Photo-sized cutouts keep their extraction footprint, without cropping or rebasing. */
export function identityPlacement(input: { readonly space: PlacementSpace; readonly pivot: PlacementPoint }): AffinePlacement {
  return createPlacement({ space: input.space,
    placement: { pivot: input.pivot, translate: { x: 0, y: 0 }, scale: 1, rotation: 0 } });
}

/** The caller records a single placement edit; no bounds/viewport-derived recomputation. */
export function resetPlacement(input: { readonly home: AffinePlacement; readonly space: PlacementSpace }): AffinePlacement {
  return validatePlacement({ placement: input.home, space: input.space });
}

export function placementBounds(input: { readonly placement: AffinePlacement; readonly space: PlacementSpace }): Rect {
  const { sourceToScene } = placementMapping(input), { width, height } = input.space.source;
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }].map(sourceToScene);
  const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function artworkDepth(input: { readonly selectedLayerDepth: number | null; readonly sceneAnchor: number | null }): Extract<DepthAttachment, { kind: 'plane' }> {
  const unit = z.number().min(0).max(1).nullable();
  const selected = unit.parse(input.selectedLayerDepth), anchor = unit.parse(input.sceneAnchor);
  return { kind: 'plane', disparity: selected ?? anchor ?? 0.5 };
}
