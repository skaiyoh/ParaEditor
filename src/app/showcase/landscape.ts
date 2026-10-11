import { z } from '../../core/zod.ts';
import { multiply, project, type Eye, type Matrix } from './scene.ts';

const finite = z.number().finite(), vector = z.tuple([finite, finite, finite]);
export const landscapeSchema = z.object({
  version: z.literal(1), vertexCount: z.number().int().positive().max(2_000_000),
  triangleCount: z.number().int().positive().max(2_000_000), strideBytes: z.literal(44), meshBytes: z.number().int().positive().max(80 * 1024 * 1024),
  sunDirection: vector, eye: vector,
  window: z.object({ width: finite.positive(), height: finite.positive(), centerZ: finite }),
  travel: z.object({ x: finite.positive(), z: finite.positive() }),
  objects: z.array(z.object({ id: z.number().int().min(1).max(16_777_215), name: z.string().min(1).max(120),
    firstIndex: z.number().int().nonnegative(), indexCount: z.number().int().positive(), kind: z.number().int().min(0).max(5),
    center: vector, neutralProjection: vector })).min(1).max(4096),
}).superRefine((scene, context) => {
  if (scene.eye[1] >= 0 || Math.hypot(...scene.sunDirection) < .5) context.addIssue({ code: 'custom', message: 'Invalid scene camera or sun.' });
  let next = 0;
  const ids = new Set<number>();
  for (const object of scene.objects) {
    if (ids.has(object.id) || object.firstIndex !== next || object.indexCount % 3 !== 0) context.addIssue({ code: 'custom', message: 'Invalid object ranges.' });
    ids.add(object.id); next += object.indexCount;
  }
  if (next !== scene.triangleCount * 3 || scene.meshBytes !== 16 + scene.vertexCount * 44 + next * 4) context.addIssue({ code: 'custom', message: 'Invalid mesh dimensions.' });
});
export type Landscape = z.infer<typeof landscapeSchema>;
export type LandscapeMesh = Readonly<{ scene: Landscape; vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }>;
const chunkBytes = 16_777_216;
const chunksSchema = z.object({
  version: z.literal(1), bytes: z.number().int().positive().max(80 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parts: z.array(z.string().regex(/^field\.mesh\.[0-9]+$/)).min(1).max(5),
}).superRefine((manifest, context) => {
  if (manifest.parts.length !== Math.ceil(manifest.bytes / chunkBytes)
    || manifest.parts.some((part, index) => part !== `field.mesh.${index}`)) {
    context.addIssue({ code: 'custom', message: 'The landscape chunk sequence is invalid.' });
  }
});

/** Preserve Highland's responsive screen aperture instead of imposing a courtyard box. */
export function landscapeAperture(scene: Landscape, aspect: number): readonly [number, number, number] {
  const width = scene.window.width;
  return [Math.max(width, width * aspect / (4 / 3)), Math.max(scene.window.height, width / aspect), scene.window.centerZ];
}
export function landscapeEye(scene: Landscape, eye: Eye): readonly [number, number, number] {
  return [scene.eye[0] + eye.x, scene.eye[1], scene.eye[2] + eye.y];
}
export function landscapeMatrix(scene: Landscape, eye: Eye, aspect: number): Matrix {
  const [x, y, z] = landscapeEye(scene, eye), [w, h, center] = landscapeAperture(scene, aspect), near = .1, far = 4000, distance = -y;
  const l = (-w / 2 - x) * near / distance, r = (w / 2 - x) * near / distance;
  const b = (center - h / 2 - z) * near / distance, t = (center + h / 2 - z) * near / distance;
  const p = new Float32Array([2 * near / (r - l), 0, 0, 0, 0, 2 * near / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0]);
  return multiply(p, new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -x, -z, y, 1]));
}
export function landscapeWindow(scene: Landscape, eye: Eye, aspect: number) {
  const [w, h, c] = landscapeAperture(scene, aspect), matrix = landscapeMatrix(scene, eye, aspect);
  const point = (x: number, y: number, depth: number) => project(matrix, [x, depth, y + c]);
  return { corners: [point(-w / 2, -h / 2, 0), point(w / 2, -h / 2, 0), point(w / 2, h / 2, 0), point(-w / 2, h / 2, 0)],
    rightBack: point(w / 2, 0, 25), leftBack: point(-w / 2, 0, 25), topBack: point(0, h / 2, 25), bottomBack: point(0, -h / 2, 25) };
}

export function parseLandscapeMesh(scene: Landscape, bytes: ArrayBuffer): LandscapeMesh {
  if (bytes.byteLength !== scene.meshBytes) throw new Error('The landscape mesh has the wrong length.');
  const header = new DataView(bytes), count = header.getUint32(4, true), indices = header.getUint32(8, true);
  if (header.getUint32(0, true) !== 0x31464c48 || header.getUint32(12, true) !== 44 || count !== scene.vertexCount || indices !== scene.triangleCount * 3) throw new Error('The landscape mesh format is invalid.');
  const vertices = new Float32Array(bytes, 16, count * 11), elements = new Uint32Array(bytes, 16 + count * 44, indices);
  if (!vertices.every(Number.isFinite) || !elements.every(index => index < count)) throw new Error('The landscape mesh contains invalid coordinates or indices.');
  return { scene, vertices, indices: elements };
}

export async function loadLandscape(base: URL, signal: AbortSignal): Promise<LandscapeMesh> {
  const information = await fetch(new URL('field.json', base), { signal });
  if (!information.ok) throw new Error(`The landscape could not load (${information.status}).`);
  const data: unknown = await information.json(), scene = landscapeSchema.parse(data);
  const response = await fetch(new URL('field.chunks.json', base), { signal });
  if (!response.ok) throw new Error(`The landscape chunk manifest could not load (${response.status}).`);
  const manifestData: unknown = await response.json(), manifest = chunksSchema.parse(manifestData);
  if (manifest.bytes !== scene.meshBytes) throw new Error('The landscape chunk manifest has the wrong total size.');
  const parts = await Promise.all(manifest.parts.map(async (part, index) => {
    const response = await fetch(new URL(part, base), { signal });
    if (!response.ok) throw new Error(`Landscape geometry part ${index + 1} could not load (${response.status}).`);
    const bytes = await response.arrayBuffer();
    const expected = Math.min(chunkBytes, manifest.bytes - index * chunkBytes);
    if (bytes.byteLength !== expected) throw new Error(`Landscape geometry part ${index + 1} has the wrong size.`);
    return new Uint8Array(bytes);
  }));
  signal.throwIfAborted();
  const bytes = new ArrayBuffer(manifest.bytes), joined = new Uint8Array(bytes);
  parts.forEach((part, index) => joined.set(part, index * chunkBytes));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  signal.throwIfAborted();
  const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.sha256) throw new Error('The landscape geometry checksum does not match. Retry to download it again.');
  return parseLandscapeMesh(scene, bytes);
}
