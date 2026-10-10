// The synthetic scene: sky, a checkered ground plane, a near red sphere with
// its shadow, and a far grey box, seen by a camera 1 world unit above the
// ground. Every value is pure arithmetic on a sample point, so one function
// decides what is painted at a point, and the truth planes ask that same
// function, which makes each one exactly what was painted.
//
// Points are in master pixels, continuous: pixel (x, y) covers [x, x + 1) x
// [y, y + 1) and is sampled at its center, (x + 0.5, y + 0.5).

import type { Size } from '../../../src/core/raster.ts';

/** The scene in fractions of the frame and world units, as the painter of the model experiments drew it (see docs/ARCHITECTURE.md, "The synth fixtures"). */
export const SCENE = {
  /** The horizon's row, a fraction of the height. */
  horizon: 0.42,
  /** The focal length, a fraction of the height. */
  focal: 0.8,
  /** The sphere: its center's column a fraction of the width, its center's distance and its radius in world units. */
  sphere: { cx: 0.38, z: 2.2, r: 0.55 },
  /** The box: its center's column a fraction of the width, its front's distance, its width and height in world units. */
  box: { cx: 0.72, z: 10, w: 1.5, h: 2.0 },
  /** Fog per world unit of distance. */
  fog: 0.06,
  /** The inpainting hole's dilation of the sphere and its shadow, a fraction of the sphere's radius. */
  holeDilation: 0.04,
} as const;

/** The scene's layout in master pixels for one master size. */
export type SceneGeometry = {
  readonly width: number;
  readonly height: number;
  /** The horizon's row. */
  readonly yh: number;
  /** The focal length. */
  readonly f: number;
  /** The sphere's disk: its center and radius; `ground` is the row where it stands on the ground. */
  readonly sphere: { readonly cx: number; readonly cy: number; readonly r: number; readonly ground: number };
  /** The box's front face: [x0, x1) x [y0, y1). */
  readonly box: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };
  /** The shadow: an ellipse on the ground. */
  readonly shadow: { readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number };
};

export function sceneGeometry(size: Size): SceneGeometry {
  const { width, height } = size;
  const yh = SCENE.horizon * height;
  const f = SCENE.focal * height;
  const s = SCENE.sphere;
  const b = SCENE.box;
  const sr = (f * s.r) / s.z;
  const sGround = yh + f / s.z;
  const sphere = { cx: s.cx * width, cy: sGround - sr, r: sr, ground: sGround };
  const bGround = yh + f / b.z;
  const bw = (f * b.w) / b.z;
  const bh = (f * b.h) / b.z;
  const box = { x0: b.cx * width - bw / 2, x1: b.cx * width + bw / 2, y0: bGround - bh, y1: bGround };
  const shadow = { cx: sphere.cx + 0.25 * sr, cy: sGround, rx: 1.15 * sr, ry: 0.22 * sr };
  return { width, height, yh, f, sphere, box, shadow };
}

/** The master point at the center of texel `i` of `count` along an axis of `extent` master pixels. */
export function sampleAt(i: number, count: number, extent: number): number {
  return ((i + 0.5) * extent) / count;
}

export function inSphere(g: SceneGeometry, x: number, y: number): boolean {
  const dx = x - g.sphere.cx;
  const dy = y - g.sphere.cy;
  return dx * dx + dy * dy <= g.sphere.r * g.sphere.r;
}

export function inBox(g: SceneGeometry, x: number, y: number): boolean {
  return x >= g.box.x0 && x < g.box.x1 && y >= g.box.y0 && y < g.box.y1;
}

export function inShadow(g: SceneGeometry, x: number, y: number): boolean {
  const dx = (x - g.shadow.cx) / g.shadow.rx;
  const dy = (y - g.shadow.cy) / g.shadow.ry;
  return dx * dx + dy * dy <= 1;
}

/** In the sphere's disk or the shadow's ellipse, each grown by `frac` of the sphere's radius. */
export function inHoleGrown(g: SceneGeometry, x: number, y: number, frac: number): boolean {
  const d = frac * g.sphere.r;
  const dx = x - g.sphere.cx;
  const dy = y - g.sphere.cy;
  const rr = g.sphere.r + d;
  if (dx * dx + dy * dy <= rr * rr) return true;
  const ex = (x - g.shadow.cx) / (g.shadow.rx + d);
  const ey = (y - g.shadow.cy) / (g.shadow.ry + d);
  return ex * ex + ey * ey <= 1;
}

/** In the inpainting hole: the sphere's disk and the shadow's ellipse, each grown by SCENE.holeDilation of the sphere's radius. */
export function inHole(g: SceneGeometry, x: number, y: number): boolean {
  return inHoleGrown(g, x, y, SCENE.holeDilation);
}

/** The pixels [x0, x1) x [y0, y1) holding the sphere's disk and the shadow's ellipse grown by `frac` of the sphere's radius, its bounds floored and ceiled to whole pixels and clamped to the master. */
export function holeBounds(g: SceneGeometry, frac: number): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  const d = frac * g.sphere.r;
  const x0 = Math.min(g.sphere.cx - g.sphere.r - d, g.shadow.cx - g.shadow.rx - d);
  const x1 = Math.max(g.sphere.cx + g.sphere.r + d, g.shadow.cx + g.shadow.rx + d);
  const y0 = g.sphere.cy - g.sphere.r - d;
  const y1 = g.shadow.cy + g.shadow.ry + d;
  return { x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)), x1: Math.min(g.width, Math.ceil(x1)), y1: Math.min(g.height, Math.ceil(y1)) };
}

/**
 * The regions the known-answer checks read, as the bench that judged the models drew them: the depth check's near region
 * is the sphere's disk shrunk to `nearShare` of its radius, its far region the box's face inset by `farInset` of its width
 * and height on each side, and the inpaint check's ring the hole's sphere and shadow grown by `ringGrowth` of the sphere's radius.
 */
export const CHECK_REGIONS = { nearShare: 0.8, farInset: 0.1, ringGrowth: 0.3 } as const;

/** In the depth check's near region: strictly inside the sphere's disk shrunk to CHECK_REGIONS.nearShare of its radius. */
export function inDepthNear(g: SceneGeometry, x: number, y: number): boolean {
  const dx = x - g.sphere.cx;
  const dy = y - g.sphere.cy;
  const r = CHECK_REGIONS.nearShare * g.sphere.r;
  return dx * dx + dy * dy < r * r;
}

/** In the depth check's far region: strictly inside the box's face inset by CHECK_REGIONS.farInset of its width and height on each side. */
export function inDepthFar(g: SceneGeometry, x: number, y: number): boolean {
  const ix = CHECK_REGIONS.farInset * (g.box.x1 - g.box.x0);
  const iy = CHECK_REGIONS.farInset * (g.box.y1 - g.box.y0);
  return x > g.box.x0 + ix && x < g.box.x1 - ix && y > g.box.y0 + iy && y < g.box.y1 - iy;
}

/** Whether a point is painted with the sphere and its shadow, as the master is, or without them, as the plate is. */
export type Layers = 'master' | 'plate';
export type Surface = 'sphere' | 'box' | 'ground' | 'sky';

/** The surface painted at a point: the sphere over everything, then the box, then the ground below the horizon, else the sky. */
export function surfaceAt(g: SceneGeometry, x: number, y: number, layers: Layers): Surface {
  if (layers === 'master' && inSphere(g, x, y)) return 'sphere';
  if (inBox(g, x, y)) return 'box';
  return y > g.yh ? 'ground' : 'sky';
}

/** The sphere's unit normal at a point of its disk: x right, y down, z toward the camera. */
function sphereNormal(g: SceneGeometry, x: number, y: number): readonly [number, number, number] {
  const nx = (x - g.sphere.cx) / g.sphere.r;
  const ny = (y - g.sphere.cy) / g.sphere.r;
  return [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))];
}

function norm3(v: readonly [number, number, number]): readonly [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The light, from the upper left and toward the camera, and the half vector of its specular highlight. */
const LIGHT = norm3([-0.5, -0.6, 0.62]);
const HALF = norm3([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

/** The sky's color at `t`, 0 at the top and 1 at the horizon. */
function skyColor(t: number): readonly [number, number, number] {
  return [90 + 100 * t, 140 + 70 * t, 210 + 20 * t];
}

const HORIZON_SKY = skyColor(1);

/** Mixes `color` toward the horizon's sky by `fog`. */
function fogged(color: readonly [number, number, number], fog: number): readonly [number, number, number] {
  return [
    color[0] * (1 - fog) + HORIZON_SKY[0] * fog,
    color[1] * (1 - fog) + HORIZON_SKY[1] * fog,
    color[2] * (1 - fog) + HORIZON_SKY[2] * fog,
  ];
}

/** The ground's distance along the view axis at row `y`, below the horizon. */
function groundDistance(g: SceneGeometry, y: number): number {
  return g.f / (y - g.yh);
}

/** The color painted at a point, R, G, and B, before rounding to bytes. */
export function colorAt(g: SceneGeometry, x: number, y: number, layers: Layers): readonly [number, number, number] {
  const surface = surfaceAt(g, x, y, layers);
  switch (surface) {
    case 'sphere': {
      const [nx, ny, nz] = sphereNormal(g, x, y);
      const lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const spec = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 40);
      const k = 0.18 + 0.82 * lambert;
      return [215 * k + 255 * spec * 0.6, 40 * k + 255 * spec * 0.6, 35 * k + 255 * spec * 0.6];
    }
    case 'box': {
      const u = (x - g.box.x0) / (g.box.x1 - g.box.x0);
      const face = u < 0.62 ? 1.0 : 0.62;
      const v = (y - g.box.y0) / (g.box.y1 - g.box.y0);
      const k = face * (0.85 + 0.15 * (1 - v));
      return fogged([120 * k, 128 * k, 150 * k], 1 - Math.exp(-SCENE.box.z * SCENE.fog));
    }
    case 'ground': {
      const z = groundDistance(g, y);
      const xw = ((x - g.width / 2) / g.f) * z;
      const light = ((Math.floor(xw * 1.2) + Math.floor(z * 1.2)) & 1) === 0;
      let color: readonly [number, number, number] = light ? [110, 150, 80] : [185, 168, 122];
      if (layers === 'master' && inShadow(g, x, y)) {
        const dx = (x - g.shadow.cx) / g.shadow.rx;
        const dy = (y - g.shadow.cy) / g.shadow.ry;
        const s = 0.45 + 0.35 * Math.sqrt(dx * dx + dy * dy);
        color = [color[0] * s, color[1] * s, color[2] * s];
      }
      return fogged(color, 1 - Math.exp(-z * SCENE.fog));
    }
    case 'sky':
      return skyColor(Math.min(1, y / g.yh));
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

/**
 * The inverse of the distance along the view axis of the surface the master paints at a point:
 * the ground plane's, the box's front at SCENE.box.z, the sky's 0 at infinite distance, and on the sphere's disk
 * the front of a world sphere of radius SCENE.sphere.r centered at SCENE.sphere.z, at the depth its shading normal gives,
 * z - r nz, so the disk's rim meets the ground at the sphere's own distance.
 */
export function inverseDistanceAt(g: SceneGeometry, x: number, y: number): number {
  const surface = surfaceAt(g, x, y, 'master');
  switch (surface) {
    case 'sphere':
      return 1 / (SCENE.sphere.z - SCENE.sphere.r * sphereNormal(g, x, y)[2]);
    case 'box':
      return 1 / SCENE.box.z;
    case 'ground':
      return 1 / groundDistance(g, y);
    case 'sky':
      return 0;
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}
