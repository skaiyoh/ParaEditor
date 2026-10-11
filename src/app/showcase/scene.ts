import { z } from '../../core/zod.ts';

const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const matrix = z.array(finite).length(16);
const file = z.string().regex(/^[a-z0-9-]+\.(bin|webp)$/);
export const sceneSchema = z.object({
  version: z.literal(1), title: z.string().min(1).max(80), authoredGeometry: z.literal(true),
  geometry: file, geometrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  vertexCount: z.number().int().positive().max(2_000_000).refine(n => n % 3 === 0),
  objects: z.number().int().positive(), size: z.tuple([z.number().int().min(1).max(2048), z.number().int().min(1).max(2048)]),
  batches: z.array(z.object({ name: z.string(), color: vector, emission: finite.min(0), lighting: z.enum(['baked', 'world']),
    first: z.number().int().nonnegative(), count: z.number().int().positive().refine(n => n % 3 === 0) })).min(1).max(64),
  camera: z.object({ projection: matrix, view: matrix, position: vector, right: vector, up: vector,
    shift: z.tuple([finite, finite]), near: finite.positive(), far: finite.positive(),
    travel: z.tuple([finite.positive(), finite.positive()]), convergence: finite.positive(),
    window: z.object({ halfWidth: finite.positive(), halfHeight: finite.positive(), depth: finite.positive() }) }),
  landmarks: z.object({ lantern: vector, pavilion: vector }),
  neutralProjection: z.object({ lantern: z.tuple([finite, finite]), pavilion: z.tuple([finite, finite]) }),
  references: z.array(z.object({ image: file, matrix, eye: z.tuple([finite, finite]) })).length(5),
}).superRefine((scene, context) => {
  let next = 0;
  for (const batch of scene.batches) {
    if (batch.first !== next) context.addIssue({ code: 'custom', message: 'Material ranges must be contiguous.' });
    next += batch.count;
  }
  if (next !== scene.vertexCount) context.addIssue({ code: 'custom', message: 'Material ranges must cover every triangle.' });
  if (scene.camera.near >= scene.camera.far) context.addIssue({ code: 'custom', message: 'Invalid camera clipping range.' });
});
export type ShowcaseScene = z.infer<typeof sceneSchema>;
export type Eye = Readonly<{ x: number; y: number }>;
export type Matrix = Float32Array<ArrayBuffer>;

export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Matrix {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += (a[i * 4 + row] ?? 0) * (b[column * 4 + i] ?? 0);
    result[column * 4 + row] = sum;
  }
  return result;
}

/** Fixed camera orientation; projection shift holds the authored convergence plane. */
export function viewMatrix(scene: ShowcaseScene, eye: Eye): Matrix {
  const view = new Float32Array(scene.camera.view), projection = new Float32Array(scene.camera.projection);
  view[12] = (view[12] ?? 0) - eye.x;
  view[13] = (view[13] ?? 0) - eye.y;
  projection[8] = (projection[8] ?? 0) + scene.camera.shift[0] * eye.x;
  projection[9] = (projection[9] ?? 0) + scene.camera.shift[1] * eye.y;
  return multiply(projection, view);
}

export function project(matrix: ArrayLike<number>, point: readonly number[]): { x: number; y: number; z: number } {
  const values = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) values[row] = (matrix[row] ?? 0) * (point[0] ?? 0)
    + (matrix[4 + row] ?? 0) * (point[1] ?? 0) + (matrix[8 + row] ?? 0) * (point[2] ?? 0) + (matrix[12 + row] ?? 0);
  const w = values[3] ?? 0;
  if (!Number.isFinite(w) || w <= 0) throw new Error('The landmark is behind the camera.');
  return { x: .5 + (values[0] ?? 0) / w / 2, y: .5 - (values[1] ?? 0) / w / 2, z: (values[2] ?? 0) / w };
}

/** A point in the cavity basis; the glass lies at camera.convergence. */
export function cavityPoint(scene: ShowcaseScene, x: number, y: number, depth: number): readonly [number, number, number] {
  const c = scene.camera;
  const coordinate = (axis: 0 | 1 | 2): number => c.position[axis] + c.right[axis] * x + c.up[axis] * y - (c.view[axis * 4 + 2] ?? 0) * depth;
  return [coordinate(0), coordinate(1), coordinate(2)];
}

export function windowProjection(scene: ShowcaseScene, eye: Eye) {
  const matrix = viewMatrix(scene, eye), c = scene.camera, room = c.window;
  const point = (x: number, y: number, depth: number) => project(matrix, cavityPoint(scene, x, y, depth));
  return { corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x = 0, y = 0]) => point(x * room.halfWidth, y * room.halfHeight, c.convergence)),
    rightBack: point(room.halfWidth, 0, c.convergence + room.depth), leftBack: point(-room.halfWidth, 0, c.convergence + room.depth),
    topBack: point(0, room.halfHeight, c.convergence + room.depth), bottomBack: point(0, -room.halfHeight, c.convergence + room.depth) };
}

export async function loadScene(base: URL, signal: AbortSignal): Promise<{ scene: ShowcaseScene; vertices: Float32Array<ArrayBuffer> }> {
  const response = await fetch(new URL('scene.json', base), { signal });
  if (!response.ok) throw new Error(`The 3D scene could not load (${response.status}).`);
  const data: unknown = await response.json();
  const scene = sceneSchema.parse(data);
  const geometry = await fetch(new URL(scene.geometry, base), { signal });
  if (!geometry.ok) throw new Error(`The scene geometry could not load (${geometry.status}).`);
  const bytes = await geometry.arrayBuffer();
  if (bytes.byteLength !== scene.vertexCount * 24) throw new Error('The scene geometry has the wrong length.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== scene.geometrySha256) throw new Error('The scene geometry failed its integrity check.');
  const vertices = new Float32Array(bytes);
  if (!vertices.every(Number.isFinite)) throw new Error('The scene geometry contains invalid coordinates.');
  return { scene, vertices };
}
