import { z } from '../core/zod.ts';
import { landscapeSchema, parseLandscapeMesh, type Landscape } from './showcase/landscape.ts';

export type ImportedScenePackage = Readonly<{ title: string; field: Landscape; mesh: ArrayBuffer; poster: Blob }>;
export const MAX_SCENE_PACKAGE_BYTES = 96 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 65536 * 16;
const MAX_POSTER_BYTES = 8 * 1024 * 1024;
const manifestSchema = z.object({
  format: z.literal('noisy-scene'), version: z.literal(1), title: z.string().min(1).max(80),
  field: landscapeSchema,
  mesh: z.object({ bytes: z.number().int().positive().max(80 * 1024 * 1024), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
  poster: z.object({ mediaType: z.string(), bytes: z.number().int().positive() }),
});

export async function parseScenePackage(bytes: ArrayBuffer): Promise<{ ok: true; value: ImportedScenePackage } | { ok: false; reason: string }> {
  const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (bytes.byteLength > MAX_SCENE_PACKAGE_BYTES) return refuse('The scene package is larger than 96 MiB.');
  if (bytes.byteLength < 8 || new DataView(bytes).getUint32(0, true) !== 0x3143534e) {
    return refuse('This is not a Noisy scene package. Export a .noisyscene file from Blender.');
  }
  const manifestBytes = new DataView(bytes).getUint32(4, true);
  if (manifestBytes < 1 || manifestBytes > MAX_MANIFEST_BYTES || 8 + manifestBytes > bytes.byteLength) {
    return refuse('The scene package has an invalid manifest length.');
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, 8, manifestBytes)));
  } catch {
    return refuse('The scene package manifest is not valid UTF-8 JSON.');
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return refuse('The scene package manifest or landscape information is invalid.');
  const manifest = parsed.data;
  if (manifest.poster.mediaType !== 'image/png' && manifest.poster.mediaType !== 'image/jpeg') {
    return refuse('The scene poster must be a PNG or JPEG image.');
  }
  if (manifest.poster.bytes > MAX_POSTER_BYTES) return refuse('The scene poster is larger than 8 MiB.');
  if (manifest.mesh.bytes !== manifest.field.meshBytes) return refuse('The scene mesh length does not match the landscape information.');
  const meshStart = 8 + manifestBytes, posterStart = meshStart + manifest.mesh.bytes;
  if (posterStart + manifest.poster.bytes !== bytes.byteLength) return refuse('The scene package is truncated or contains unexpected extra bytes.');
  if (!manifest.field.objects.some(object => object.kind === 1) || !manifest.field.objects.some(object => object.kind === 3)) {
    return refuse('The scene needs a kind 1 near landmark and a kind 3 far landmark.');
  }
  const mesh = bytes.slice(meshStart, posterStart);
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest('SHA-256', mesh);
  } catch {
    return refuse('This browser could not check the scene checksum. Open Noisy in a secure browser window.');
  }
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.mesh.sha256.toLowerCase()) return refuse('The scene mesh checksum does not match. Export or download the package again.');
  try {
    parseLandscapeMesh(manifest.field, mesh);
  } catch {
    return refuse('The scene mesh contains invalid geometry. Export the scene again.');
  }
  // The poster must be the image it declares: PNG or JPEG signature, not arbitrary bytes.
  const poster = new Uint8Array(bytes, posterStart), png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg = [0xff, 0xd8, 0xff];
  const signature = manifest.poster.mediaType === 'image/png' ? png : jpeg;
  if (poster.length < signature.length + 8 || !signature.every((value, index) => poster[index] === value)) {
    return refuse('The scene poster is not a valid image. Export the scene again.');
  }
  return { ok: true, value: { title: manifest.title, field: manifest.field, mesh,
    poster: new Blob([bytes.slice(posterStart)], { type: manifest.poster.mediaType }) } };
}
