import type { Plane, Rect, Size } from '../core/raster.ts';
import { lateralEnvelope, type PerspectiveGeometry } from '../core/perspective.ts';

export type GridMesh = { readonly vertices: Float32Array; readonly indices: Uint16Array };

/** Frame-space vertices, y down as in every stored texture. Positive winding. */
export function gridMesh(columns: number, rows: number, bounds: Rect = { x: 0, y: 0, width: 1, height: 1 }): GridMesh {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || (columns + 1) * (rows + 1) > 65536) {
    throw new RangeError('The grid must fit unsigned-short indices.');
  }
  const vertices = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const i = (y * (columns + 1) + x) * 2;
    vertices[i] = bounds.x + bounds.width * x / columns;
    vertices[i + 1] = bounds.y + bounds.height * y / rows;
  }
  const indices = new Uint16Array(columns * rows * 6);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const a = y * (columns + 1) + x, b = a + 1, c = a + columns + 1, d = c + 1;
    indices.set([a, b, c, b, d, c], (y * columns + x) * 6);
  }
  return { vertices, indices };
}

export const backGrid = (): GridMesh => gridMesh(192, 144);

export function objectGrid(bounds: Rect, frame: Size, clamp: number): GridMesh {
  const x = Math.max(0, bounds.x / frame.width - clamp), y = Math.max(0, bounds.y / frame.height - clamp);
  const right = Math.min(1, (bounds.x + bounds.width) / frame.width + clamp);
  const bottom = Math.min(1, (bounds.y + bounds.height) / frame.height + clamp);
  return gridMesh(64, 64, { x, y, width: right - x, height: bottom - y });
}

/** Maximum disparity step across a rendered triangle, using the shader's clamped bilinear sampling. */
function sampleMeshDepth(mesh: GridMesh, depth: Plane<'f32'>): Float64Array {
  const { width, height } = depth.size;
  if (width < 1 || height < 1 || depth.data.length !== width * height) throw new RangeError('The depth plane has an invalid size.');
  const sample = (u: number, v: number): number => {
    const x = u * width - .5, y = v * height - .5, lx = Math.floor(x), ly = Math.floor(y);
    const fx = x - lx, fy = y - ly;
    let value = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.max(0, Math.min(width - 1, lx + dx)), sy = Math.max(0, Math.min(height - 1, ly + dy));
      const d = depth.data[sy * width + sx] ?? 0;
      if (!Number.isFinite(d)) throw new RangeError('The depth plane must be finite.');
      value += Math.max(0, Math.min(1, d)) * (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy);
    }
    return value;
  };
  const sampled = new Float64Array(mesh.vertices.length / 2);
  for (let i = 0; i < sampled.length; i++) sampled[i] = sample(mesh.vertices[i * 2] ?? 0, mesh.vertices[i * 2 + 1] ?? 0);
  return sampled;
}

export function meshDepthJump(mesh: GridMesh, depth: Plane<'f32'>): number {
  const sampled = sampleMeshDepth(mesh, depth);
  let largest = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = sampled[mesh.indices[i] ?? 0] ?? 0, b = sampled[mesh.indices[i + 1] ?? 0] ?? 0,
      c = sampled[mesh.indices[i + 2] ?? 0] ?? 0;
    largest = Math.max(largest, Math.max(a, b, c) - Math.min(a, b, c));
  }
  return largest;
}

/**
 * With fixed eye distance, each vertex is uv + k*eye in common scaled axes.
 * Triangle signed area is affine in eye.xy (the quadratic rank-one term cancels),
 * so checking the four envelope corners proves no fold anywhere inside it.
 * Retain 5% of the neutral area to avoid nearly singular triangles and unstable picking.
 */
export function meshProjectionScale(mesh: GridMesh, depth: Plane<'f32'>, geometry: PerspectiveGeometry): number {
  const sampled = sampleMeshDepth(mesh, depth), envelope = lateralEnvelope(geometry);
  const k = Float64Array.from(sampled, (d) => 1 - 1 / (geometry.farFactor * (1 - d) + geometry.nearFactor * d));
  const span = 1 - 2 * geometry.crop;
  let scale = 1;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] ?? 0, b = mesh.indices[i + 1] ?? 0, c = mesh.indices[i + 2] ?? 0;
    const ux = (mesh.vertices[b * 2] ?? 0) - (mesh.vertices[a * 2] ?? 0), uy = (mesh.vertices[b * 2 + 1] ?? 0) - (mesh.vertices[a * 2 + 1] ?? 0);
    const vx = (mesh.vertices[c * 2] ?? 0) - (mesh.vertices[a * 2] ?? 0), vy = (mesh.vertices[c * 2 + 1] ?? 0) - (mesh.vertices[a * 2 + 1] ?? 0);
    const area = ux * vy - uy * vx, ku = (k[b] ?? 0) - (k[a] ?? 0), kv = (k[c] ?? 0) - (k[a] ?? 0);
    if (area <= 0) return 0;
    for (const x of [envelope.min.x, envelope.max.x]) for (const y of [envelope.min.y, envelope.max.y]) {
      const ex = span * x / geometry.aperture.width, ey = -span * y / geometry.aperture.height;
      const change = ex * (ku * vy - uy * kv) + ey * (ux * kv - ku * vx);
      if (!Number.isFinite(change)) return 0;
      // Area(scale) = neutralArea + scale * change.
      // Keep a little additional numerical slack beyond the 5% lower bound.
      if (change < 0) scale = Math.min(scale, .949 * area / -change);
    }
  }
  return scale;
}

export function meshProjectionSafe(mesh: GridMesh, depth: Plane<'f32'>, geometry: PerspectiveGeometry): boolean {
  return meshProjectionScale(mesh, depth, geometry) === 1;
}
