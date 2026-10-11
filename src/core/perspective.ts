import type { Vec2 } from './motion.ts';
import type { ImagePoint, Rect, Size } from './raster.ts';

/** One common screen unit on both axes; x right, y up, origin at viewport center. */
export type PerspectiveAperture = { readonly center: Vec2; readonly width: number; readonly height: number };
export type PerspectiveEye = { readonly x: number; readonly y: number; readonly z: number };
export type PerspectivePoint = PerspectiveEye;
export type PerspectiveGeometry = {
  readonly aperture: PerspectiveAperture;
  /** Fraction of the original photo hidden on each side at neutral, 0 <= crop < .5. */
  readonly crop: number;
  readonly neutralDistance: number;
  /** Ray scale t: 1 is the screen plane, greater than 1 lies behind it. */
  readonly nearFactor: number;
  readonly farFactor: number;
};
export type PerspectiveEnvelope = { readonly min: Vec2; readonly max: Vec2 };

function finite(...values: readonly number[]): void {
  if (!values.every(Number.isFinite)) throw new RangeError('Perspective coordinates must be finite.');
}

function positive(...values: readonly number[]): void {
  finite(...values);
  if (values.some((value) => value <= 0)) throw new RangeError('Perspective dimensions and eye distance must be positive.');
}

/** Validate once at scene preparation, before handing this pure configuration to the renderer. */
export function createPerspectiveGeometry(input: PerspectiveGeometry): PerspectiveGeometry {
  const { aperture, crop, neutralDistance, nearFactor, farFactor } = input;
  finite(aperture.center.x, aperture.center.y, crop, nearFactor, farFactor);
  positive(aperture.width, aperture.height, neutralDistance);
  if (crop < 0 || crop >= .5) throw new RangeError('Perspective crop must be at least zero and less than one half.');
  if (nearFactor < 1 || farFactor < nearFactor) throw new RangeError('Perspective depth factors must satisfy 1 <= near <= far.');
  // Reject finite inputs whose reconstruction could overflow before any GPU upload.
  finite(aperture.width / (1 - 2 * crop), aperture.height / (1 - 2 * crop),
    (Math.abs(aperture.center.x) + aperture.width / (1 - 2 * crop)) * farFactor,
    (Math.abs(aperture.center.y) + aperture.height / (1 - 2 * crop)) * farFactor,
    neutralDistance * farFactor);
  return { aperture: { center: { ...aperture.center }, width: aperture.width, height: aperture.height },
    crop, neutralDistance, nearFactor, farFactor };
}

/** Actual centered image aperture inside an object-fit: contain element, in CSS pixels. */
export function containedImageRect(box: Rect, image: Size): Rect {
  finite(box.x, box.y); positive(box.width, box.height, image.width, image.height);
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** CSS rectangle relative to the viewport; one unit is the viewport width, independent of DPR. */
export function apertureFromRect(rect: Rect, viewport: Size): PerspectiveAperture {
  finite(rect.x, rect.y);
  positive(rect.width, rect.height, viewport.width, viewport.height);
  const aperture = {
    center: { x: (rect.x + rect.width / 2 - viewport.width / 2) / viewport.width,
      y: (viewport.height / 2 - rect.y - rect.height / 2) / viewport.width },
    width: rect.width / viewport.width,
    height: rect.height / viewport.width,
  };
  finite(aperture.center.x, aperture.center.y, aperture.width, aperture.height);
  return aperture;
}

/** Disparity is relative inverse depth: zero far, one near; a constant map stays constant. */
export function perspectiveFactor(disparity: number, geometry: PerspectiveGeometry): number {
  finite(disparity);
  if (disparity < 0 || disparity > 1) throw new RangeError('Perspective disparity must be in zero to one.');
  return geometry.farFactor * (1 - disparity) + geometry.nearFactor * disparity;
}

/** The original photo overscans the aperture; UV remains y down, without losing crop provenance. */
export function sourceToScreen(uv: ImagePoint, geometry: PerspectiveGeometry): Vec2 {
  finite(uv.x, uv.y);
  if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) throw new RangeError('Perspective source UV must be in zero to one.');
  const { aperture, crop } = geometry;
  const span = 1 - 2 * crop;
  return { x: aperture.center.x + (uv.x - .5) * aperture.width / span,
    y: aperture.center.y + (.5 - uv.y) * aperture.height / span };
}

/** Back-project the source along neutral rays: P = E0 + t * (S - E0). */
export function reconstructPoint(uv: ImagePoint, disparity: number, geometry: PerspectiveGeometry): PerspectivePoint {
  const screen = sourceToScreen(uv, geometry), t = perspectiveFactor(disparity, geometry);
  return { x: t * screen.x, y: t * screen.y, z: geometry.neutralDistance * (1 - t) };
}

function checkEye(eye: PerspectiveEye): void {
  finite(eye.x, eye.y);
  positive(eye.z);
}

/** Ray intersection with the fixed screen plane. Supports z variation as a reference, not tracking. */
export function projectPoint(point: PerspectivePoint, eye: PerspectiveEye): Vec2 {
  checkEye(eye);
  finite(point.x, point.y, point.z);
  if (point.z > 0) throw new RangeError('Perspective scene points must lie on or behind the screen.');
  const denominator = eye.z - point.z;
  finite(denominator);
  // Weighted form avoids intermediate D*point overflow in the equivalent quotient.
  const a = eye.z / denominator, b = -point.z / denominator;
  const result = { x: a * point.x + b * eye.x, y: a * point.y + b * eye.y };
  finite(result.x, result.y);
  return result;
}

export function projectSource(uv: ImagePoint, disparity: number, geometry: PerspectiveGeometry, eye: PerspectiveEye): Vec2 {
  return projectPoint(reconstructPoint(uv, disparity, geometry), eye);
}

/** Analytical inverse at known original disparity. May return UV outside [0,1]; never clamps a miss to an edge. */
export function inverseSource(screen: Vec2, disparity: number, geometry: PerspectiveGeometry, eye: PerspectiveEye): ImagePoint {
  checkEye(eye);
  finite(screen.x, screen.y);
  const t = perspectiveFactor(disparity, geometry), z = geometry.neutralDistance * (1 - t);
  const denominator = eye.z - z;
  finite(denominator);
  const a = eye.z / denominator, b = -z / denominator;
  const sx = (screen.x - b * eye.x) / a / t, sy = (screen.y - b * eye.y) / a / t;
  const { aperture, crop } = geometry;
  const result = { x: .5 + (sx - aperture.center.x) * (1 - 2 * crop) / aperture.width,
    y: .5 - (sy - aperture.center.y) * (1 - 2 * crop) / aperture.height };
  finite(result.x, result.y);
  return result;
}

/**
 * Fixed-distance outer-border guarantee only; interior occlusion holes require prepared scene coverage.
 * At eye.z=D0, S'=S+k*eye.xy with k=(t-1)/t. Its greatest value is at farFactor.
 * Each edge has crop*apertureSpan/(1-2*crop) slack, so |eye| <= slack/k is sufficient.
 * maxTravel is an additional finite interaction budget; default is one aperture span on each axis.
 * A screen-plane-only scene has k=0 and needs no coverage limit, but retains that interaction budget.
 */
export function lateralEnvelope(geometry: PerspectiveGeometry,
  maxTravel: Vec2 = { x: geometry.aperture.width, y: geometry.aperture.height }): PerspectiveEnvelope {
  finite(maxTravel.x, maxTravel.y);
  if (maxTravel.x < 0 || maxTravel.y < 0) throw new RangeError('Perspective travel budget must not be negative.');
  const k = 1 - 1 / geometry.farFactor;
  const margin = geometry.crop / (1 - 2 * geometry.crop);
  const x = k === 0 ? maxTravel.x : Math.min(maxTravel.x, margin * geometry.aperture.width / k);
  const y = k === 0 ? maxTravel.y : Math.min(maxTravel.y, margin * geometry.aperture.height / k);
  return { min: { x: x === 0 ? 0 : -x, y: y === 0 ? 0 : -y }, max: { x, y } };
}

/** Clamp lateral intent to outer coverage at the fixed neutral distance; further scene limits still apply. */
export function constrainEye(target: Vec2, geometry: PerspectiveGeometry,
  maxTravel?: Vec2): PerspectiveEye {
  finite(target.x, target.y);
  const envelope = lateralEnvelope(geometry, maxTravel);
  return { x: Math.max(envelope.min.x, Math.min(envelope.max.x, target.x)),
    y: Math.max(envelope.min.y, Math.min(envelope.max.y, target.y)), z: geometry.neutralDistance };
}
