import { isAssetId, isSceneId, type AssetId, type SceneId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import { z } from '../core/zod.ts';
import { deserializeMask, deserializeScene, serializeMask, serializeScene } from './serialize.ts';

const idSchema = z.custom<SceneId>((value) => typeof value === 'string' && isSceneId(value));
const projectSchema = z.strictObject({ id: idSchema, name: z.string(), updatedAt: z.iso.datetime(), thumbnail: z.string() })
  .refine((project) => project.thumbnail === `/api/projects/${project.id}/thumbnail`);
const listSchema = z.strictObject({ projects: z.array(projectSchema) });
export type Project = z.infer<typeof projectSchema>;
export type ProjectStoreProbe = { readonly kind: 'absent' } | { readonly kind: 'available'; readonly projects: readonly Project[] };
const acknowledgement = z.strictObject({ ok: z.literal(true) });

export class ProjectRequestError extends Error {
  readonly status: number;
  readonly terminal: boolean;
  constructor(status: number) {
    super(`The project request failed (HTTP ${status}).`);
    this.name = 'ProjectRequestError';
    this.status = status;
    this.terminal = status === 409 || status === 410;
  }
}

async function request(path: string, init: RequestInit = {}, allowMissing = false): Promise<Response> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = init.signal == null ? timeout : AbortSignal.any([timeout, init.signal]);
  const response = await fetch(path, { ...init, signal, cache: 'no-store' });
  if (!response.ok && !(allowMissing && response.status === 404)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProjectRequestError(response.status);
  }
  return response;
}

const base = (id: SceneId): string => `/api/projects/${id}`;
async function verifyAsset(bytes: ArrayBuffer, asset: AssetId): Promise<void> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if ([...hash].map((value) => value.toString(16).padStart(2, '0')).join('') !== asset) throw new Error('The project asset bytes are invalid.');
}
const put = async (path: string, body: BodyInit, contentType: string): Promise<void> => {
  acknowledgement.parse(await (await request(path, { method: 'PUT', headers: { 'Content-Type': contentType }, body })).json());
};

export async function listProjects(signal?: AbortSignal): Promise<readonly Project[]> {
  return listSchema.parse(await (await request('/api/projects', signal === undefined ? {} : { signal })).json()).projects;
}
/** The session owns the once-per-page probe and gates all subsequent requests. */
export async function probeProjects(): Promise<ProjectStoreProbe> {
  const response = await request('/api/projects', {}, true);
  if (response.status === 204 || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'absent' };
  }
  return { kind: 'available', projects: listSchema.parse(await response.json()).projects };
}
export function saveScene(document: SceneDocument, masks: ReadonlyMap<AssetId, Plane<'u8'>>, revision: number): Promise<void> {
  return put(`${base(document.id)}/scene`, JSON.stringify(serializeScene(document, masks, revision)), 'application/json');
}
export function savePhoto(id: SceneId, photo: File): Promise<void> {
  return put(`${base(id)}/photo`, photo, photo.type || 'application/octet-stream');
}
export function saveMask(id: SceneId, asset: AssetId, mask: Plane<'u8'>): Promise<void> {
  return put(`${base(id)}/masks/${asset}`, new Blob([serializeMask(mask)]), 'application/octet-stream');
}
export function saveThumbnail(id: SceneId, thumbnail: Blob): Promise<void> {
  return put(`${base(id)}/thumbnail`, thumbnail, 'image/jpeg');
}
export async function loadProject(id: SceneId, signal: AbortSignal) {
  const scene = deserializeScene(await (await request(`${base(id)}/scene`, { signal })).json());
  if (scene.document.id !== id) throw new Error('The project document belongs to another photo.');
  const [response, entries] = await Promise.all([
    request(`${base(id)}/photo`, { signal }),
    Promise.all(Object.entries(scene.masks).map(async ([asset, size]) => {
      if (!isAssetId(asset)) throw new Error('The project mask id is invalid.');
      const bytes = new Uint8Array(await (await request(`${base(id)}/masks/${asset}`, { signal })).arrayBuffer());
      await verifyAsset(bytes.buffer, asset);
      return [asset, deserializeMask(bytes, size)] satisfies [AssetId, Plane<'u8'>];
    })),
  ]);
  const photoBytes = await response.arrayBuffer();
  if (scene.document.frame.source !== null) {
    if (photoBytes.byteLength !== scene.document.frame.source.byteLength) throw new Error('The project photo is incomplete.');
    await verifyAsset(photoBytes, scene.document.frame.source.asset);
  }
  signal.throwIfAborted();
  const photo = new File([photoBytes], scene.document.frame.original.name, { type: response.headers.get('Content-Type') ?? scene.document.frame.original.mediaType });
  return { document: scene.document, masks: new Map(entries), photo, revision: scene.revision };
}
export async function deleteProject(id: SceneId): Promise<void> {
  const response = await request(base(id), { method: 'DELETE' }, true);
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  acknowledgement.parse(await response.json());
}
