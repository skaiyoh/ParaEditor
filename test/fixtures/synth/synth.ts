// The synth fixtures: the synthetic scene of scene.ts painted at a master
// size, with its exact truth. `synth` is the scene at 2048 x 1536 and
// 512 x 384, and `synth-pano` the same scene at 2048 x 512.
//
// Every output samples the scene at texel centers: texel (u, v) of a plane of
// w x h reads the master point ((u + 0.5) W / w, (v + 0.5) H / h) of a W x H
// master, which at the master's own size is the center of pixel (u, v), the
// point the painter painted. So each truth plane at the master size is exactly
// what was painted, and at another size it is what the painter would paint at
// that plane's texel centers.
//
// The generator is pure arithmetic with no randomness and no clock, so
// regenerating any output gives the same bytes in one JavaScript engine;
// Math.exp, Math.pow, and Math.hypot may differ in their low bits between
// engines, so bytes are not promised to match across engines.

import { depthInputSize } from '../../../src/analysis/depth-size.ts';
import type { Plane, Rgb8, Size } from '../../../src/core/raster.ts';
import {
  CHECK_REGIONS,
  colorAt,
  holeBounds,
  inDepthFar,
  inDepthNear,
  inHole,
  inHoleGrown,
  inverseDistanceAt,
  sampleAt,
  sceneGeometry,
  surfaceAt,
  type Layers,
  type SceneGeometry,
  type Surface,
} from './scene.ts';

/** The fixtures and their master sizes. */
export const SYNTH_FIXTURES = [
  { name: 'synth', size: { width: 2048, height: 1536 } },
  { name: 'synth', size: { width: 512, height: 384 } },
  { name: 'synth-pano', size: { width: 2048, height: 512 } },
] as const satisfies readonly { readonly name: string; readonly size: Size }[];

/** A mask's default size: long edge 1024, the short side the master's aspect rounded to the nearest pixel. */
export function maskSize(master: Size): Size {
  const long = Math.max(master.width, master.height);
  const side = (extent: number): number => Math.max(1, Math.round((extent * 1024) / long));
  return { width: side(master.width), height: side(master.height) };
}

/** The scene painted at one master size, with its truth. */
export type SynthScene = {
  readonly size: Size;
  readonly geometry: SceneGeometry;
  /** The master as RGBA bytes, alpha 255, the form `new ImageData(data, width, height)` takes. */
  readonly masterRgba: () => Uint8ClampedArray<ArrayBuffer>;
  /** The master as Rgb8. */
  readonly master: () => Rgb8;
  /** The plate: the scene painted without the sphere and its shadow, at the master size. */
  readonly plate: () => Rgb8;
  /** Inverse distance at each texel, normalized so the plane's nearest texel is 1 and the sky 0; default size depthInputSize(master). */
  readonly depth: (size?: Size) => Plane<'f32'>;
  /** 255 where the sphere is painted, else 0; default size long edge 1024. */
  readonly sphereMask: (size?: Size) => Plane<'u8'>;
  /** 255 where the box is painted, else 0; default size long edge 1024. */
  readonly boxMask: (size?: Size) => Plane<'u8'>;
  /** The inpainting hole at the master size: 255 inside the sphere and its shadow grown by 0.04 of the sphere's radius, else 0, as holeMask writes a hole. */
  readonly hole: () => Plane<'u8'>;
  /** The depth check's near region: 255 strictly inside the sphere's disk shrunk to 0.8 of its radius, else 0; default size depthInputSize(master). */
  readonly depthNear: (size?: Size) => Plane<'u8'>;
  /** The depth check's far region: 255 strictly inside the box's face inset by 0.1 of its width and height on each side, else 0; default size depthInputSize(master). */
  readonly depthFar: (size?: Size) => Plane<'u8'>;
  /**
   * The inpaint check's ring at the master size: 255 at the pixels outside the hole and inside the sphere and its shadow
   * grown by 0.3 of the sphere's radius that the bench sampled, every second pixel along each axis from the corner of
   * holeBounds(0.3); else 0.
   */
  readonly ring: () => Plane<'u8'>;
};

function assertPlaneSize(size: Size, what: string): void {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1) {
    throw new Error(`${what}: expected whole sides of at least 1, got ${size.width} x ${size.height}`);
  }
}

/** Calls `each` with the master point at every texel center of a plane of `size`, in row-major order. */
function forEachSample(g: SceneGeometry, size: Size, each: (x: number, y: number, i: number) => void): void {
  for (let v = 0; v < size.height; v += 1) {
    const y = sampleAt(v, size.height, g.height);
    for (let u = 0; u < size.width; u += 1) each(sampleAt(u, size.width, g.width), y, v * size.width + u);
  }
}

/** The scene painted at the master size, with or without the sphere and its shadow; each channel is rounded to a byte as a Uint8ClampedArray rounds. */
function paint(g: SceneGeometry, layers: Layers): Uint8ClampedArray<ArrayBuffer> {
  const size = { width: g.width, height: g.height };
  const rgba = new Uint8ClampedArray(g.width * g.height * 4);
  forEachSample(g, size, (x, y, i) => {
    const [r, gr, b] = colorAt(g, x, y, layers);
    rgba[4 * i] = r;
    rgba[4 * i + 1] = gr;
    rgba[4 * i + 2] = b;
    rgba[4 * i + 3] = 255;
  });
  return rgba;
}

function toRgb8(rgba: Uint8ClampedArray, size: Size): Rgb8 {
  const n = size.width * size.height;
  const data = new Uint8Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    data[3 * i] = rgba[4 * i] ?? 0;
    data[3 * i + 1] = rgba[4 * i + 1] ?? 0;
    data[3 * i + 2] = rgba[4 * i + 2] ?? 0;
  }
  return { size: { width: size.width, height: size.height }, data };
}

/** 255 at each texel of a plane of `size` whose sample point `inside` holds, else 0. */
function regionPlane(g: SceneGeometry, size: Size, what: string, inside: (x: number, y: number) => boolean): Plane<'u8'> {
  assertPlaneSize(size, what);
  const data = new Uint8Array(size.width * size.height);
  forEachSample(g, size, (x, y, i) => {
    data[i] = inside(x, y) ? 255 : 0;
  });
  return { format: 'u8', size: { width: size.width, height: size.height }, data };
}

/** The inpaint check's ring, as the bench sampled it: see SynthScene.ring. */
function ringPlane(g: SceneGeometry): Plane<'u8'> {
  const { width, height } = g;
  const data = new Uint8Array(width * height);
  const b = holeBounds(g, CHECK_REGIONS.ringGrowth);
  for (let y = b.y0; y < b.y1; y += 2) {
    for (let x = b.x0; x < b.x1; x += 2) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inHole(g, px, py) && inHoleGrown(g, px, py, CHECK_REGIONS.ringGrowth)) data[y * width + x] = 255;
    }
  }
  return { format: 'u8', size: { width, height }, data };
}

function surfaceMask(g: SceneGeometry, size: Size, surface: Surface): Plane<'u8'> {
  assertPlaneSize(size, `${surface} mask`);
  const data = new Uint8Array(size.width * size.height);
  forEachSample(g, size, (x, y, i) => {
    data[i] = surfaceAt(g, x, y, 'master') === surface ? 255 : 0;
  });
  return { format: 'u8', size: { width: size.width, height: size.height }, data };
}

/**
 * The scene at a master of `size`.
 * Throws when a side is not a whole number of at least 2 or is odd, since import makes every master's sides even.
 */
export function synthScene(size: Size): SynthScene {
  assertPlaneSize(size, 'master');
  if (size.width % 2 !== 0 || size.height % 2 !== 0) {
    throw new Error(`master: expected even sides, as import makes them, got ${size.width} x ${size.height}`);
  }
  const g = sceneGeometry(size);
  const master = { width: size.width, height: size.height };
  return {
    size: master,
    geometry: g,
    masterRgba: () => paint(g, 'master'),
    master: () => toRgb8(paint(g, 'master'), master),
    plate: () => toRgb8(paint(g, 'plate'), master),
    depth: (at = depthInputSize(master)) => {
      assertPlaneSize(at, 'depth');
      const inverse = new Float64Array(at.width * at.height);
      let nearest = 0;
      forEachSample(g, at, (x, y, i) => {
        const value = inverseDistanceAt(g, x, y);
        inverse[i] = value;
        if (value > nearest) nearest = value;
      });
      const data = new Float32Array(inverse.length);
      if (nearest > 0) for (let i = 0; i < inverse.length; i += 1) data[i] = (inverse[i] ?? 0) / nearest;
      return { format: 'f32', size: { width: at.width, height: at.height }, data };
    },
    sphereMask: (at = maskSize(master)) => surfaceMask(g, at, 'sphere'),
    boxMask: (at = maskSize(master)) => surfaceMask(g, at, 'box'),
    hole: () => {
      const data = new Uint8Array(master.width * master.height);
      forEachSample(g, master, (x, y, i) => {
        data[i] = inHole(g, x, y) ? 255 : 0;
      });
      return { format: 'u8', size: { width: master.width, height: master.height }, data };
    },
    depthNear: (at = depthInputSize(master)) => regionPlane(g, at, 'depth near', (x, y) => inDepthNear(g, x, y)),
    depthFar: (at = depthInputSize(master)) => regionPlane(g, at, 'depth far', (x, y) => inDepthFar(g, x, y)),
    ring: () => ringPlane(g),
  };
}
