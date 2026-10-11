import { isAssetId, isSceneId, type AssetId, type SceneId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import { z } from '../core/zod.ts';
import { deserializeMask, deserializeScene, serializeMask, serializeScene } from './serialize.ts';
import { deserializeProjectEnvelope, serializeCompositionScene, type SavedComposition } from './serialize.ts';
import { compositionAssetLimit, compositionAssetPath, compositionInventory, readAssetBody, validateCompositionAssets } from './assets.ts';
import { COMPOSITION_LIMITS } from '../core/composition-ranges.ts';
import { measureCompositionAssets } from '../core/asset-refs.ts';

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

export type CompositionSaveInput = {
  readonly document: SavedComposition['document'];
  readonly revision: number;
  /** Encoded stored bytes, not payload-only planes. Only document refs are captured. */
  readonly assets: ReadonlyMap<AssetId, Uint8Array>;
  /** Already captured from this committed document; never a live renderer callback. */
  readonly thumbnail: Blob;
};
type Snapshot = { readonly scene: SavedComposition; readonly assets: ReadonlyMap<AssetId, Blob>; readonly thumbnail: Blob; readonly bytes: number };
export type CompositionSaveResult = { readonly kind: 'saved' | 'superseded'; readonly revision: number };
type SaveJob = { readonly snapshot: Snapshot; readonly resolve: (result: CompositionSaveResult) => void; readonly reject: (error: unknown) => void };
type SaveQueue = { active: SaveJob; pending: SaveJob | null };
const compositionQueues = new Map<SceneId, SaveQueue>();

function captureComposition(input: CompositionSaveInput): Snapshot {
  const scene = serializeCompositionScene(input.document, input.revision);
  if (new TextEncoder().encode(JSON.stringify(scene)).byteLength > 1024 * 1024) throw new Error('The project scene is too large.');
  if (input.thumbnail.size === 0 || input.thumbnail.size > 59_999 || input.thumbnail.type !== 'image/jpeg') throw new Error('The project thumbnail must be a JPEG under 60 KB.');
  const inventory = compositionInventory(scene.document), lengths = new Map<AssetId, number>();
  let additional = 0;
  for (const [asset, refs] of inventory) {
    const bytes = input.assets.get(asset);
    if (bytes === undefined) throw new Error('A committed project asset is missing.');
    if (bytes.byteLength === 0 || bytes.byteLength > compositionAssetLimit(refs)) throw new Error('The project asset is too large or empty.');
    lengths.set(asset, bytes.byteLength);
    if (refs.some((ref) => ref.kind !== 'original')) additional += bytes.byteLength;
  }
  if (additional > COMPOSITION_LIMITS.activeAssetBytes) throw new Error('The composition exceeds its 64 MiB asset budget.');
  const measured = measureCompositionAssets(inventory, lengths);
  if (!measured.ok) throw new Error(measured.error.detail);
  const assets = new Map<AssetId, Blob>();
  for (const [asset, refs] of inventory) {
    const bytes = input.assets.get(asset);
    if (bytes === undefined) throw new Error('A committed project asset is missing.');
    const original = refs.find((ref) => ref.kind === 'original');
    assets.set(asset, new Blob([new Uint8Array(bytes)], { type: original?.mediaType ?? 'application/octet-stream' }));
  }
  return { scene, assets, thumbnail: input.thumbnail, bytes: measured.value.bytes };
}

async function writeComposition(snapshot: Snapshot): Promise<void> {
  const { scene, assets } = snapshot;
  await validateCompositionAssets(scene.document, async (asset) => {
    const blob = assets.get(asset);
    return blob === undefined ? null : new Uint8Array(await blob.arrayBuffer());
  });
  const thumbnail = new Uint8Array(await snapshot.thumbnail.arrayBuffer());
  if (thumbnail[0] !== 255 || thumbnail[1] !== 216 || thumbnail.at(-2) !== 255 || thumbnail.at(-1) !== 217) throw new Error('The project thumbnail must be a JPEG under 60 KB.');
  // Assets are immutable and PUT is idempotent. Probe before uploading so Undo,
  // Redo and metadata-only saves do not send shared bytes again.
  for (const [asset, refs] of compositionInventory(scene.document)) {
    const blob = assets.get(asset);
    if (blob === undefined) throw new Error('A committed project asset is missing.');
    const path = `${base(scene.document.id)}/${compositionAssetPath(asset, refs)}`;
    const existing = await request(path, {}, true);
    if (existing.status === 404) {
      await existing.body?.cancel();
      if (refs.every((ref) => ref.kind === 'original')) {
        // The original upload keeps its existing 24 MiB route limit; the hash
        // opts into immutable storage instead of the legacy mutable photo slot.
        acknowledgement.parse(await (await request(`${base(scene.document.id)}/photo`, {
          method: 'PUT', headers: { 'Content-Type': blob.type, 'X-Project-Asset': asset }, body: blob,
        })).json());
      } else await put(path, blob, 'application/octet-stream');
    } else {
      const bytes = await readAssetBody(existing.body, compositionAssetLimit(refs));
      await verifyAsset(new Uint8Array(bytes).buffer, asset);
    }
  }
  await saveThumbnail(scene.document.id, snapshot.thumbnail);
  await put(`${base(scene.document.id)}/scene`, JSON.stringify(scene), 'application/json');
}

async function drainComposition(id: SceneId, queue: SaveQueue): Promise<void> {
  for (;;) {
    const job = queue.active;
    try {
      await writeComposition(job.snapshot);
      job.resolve({ kind: 'saved', revision: job.snapshot.scene.revision });
    } catch (error) {
      job.reject(error);
      if (error instanceof ProjectRequestError && error.terminal) {
        queue.pending?.reject(error);
        compositionQueues.delete(id);
        return;
      }
    }
    if (queue.pending === null) { compositionQueues.delete(id); return; }
    queue.active = queue.pending;
    queue.pending = null;
  }
}

/** One immutable in-flight snapshot and one replaceable pending snapshot per id.
 * Superseded promises release immediately and must never be displayed as Saved.
 */
export function saveComposition(input: CompositionSaveInput): Promise<CompositionSaveResult> {
  let snapshot: Snapshot;
  try { snapshot = captureComposition(input); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const job = { snapshot, resolve, reject }, id = snapshot.scene.document.id;
    const queue = compositionQueues.get(id);
    if (queue === undefined) {
      const next = { active: job, pending: null };
      compositionQueues.set(id, next);
      void drainComposition(id, next);
    } else {
      const latest = queue.pending ?? queue.active;
      if (snapshot.scene.revision <= latest.snapshot.scene.revision) { reject(new ProjectRequestError(409)); return; }
      queue.pending?.resolve({ kind: 'superseded', revision: queue.pending.snapshot.scene.revision });
      queue.pending = job;
    }
  });
}

/** Observable retention accounting for the session's independent save root. */
export function compositionSaveRetention(id: SceneId): readonly { readonly revision: number; readonly bytes: number; readonly assets: readonly AssetId[] }[] {
  const queue = compositionQueues.get(id);
  return queue === undefined ? [] : [queue.active, ...(queue.pending === null ? [] : [queue.pending])].map(({ snapshot }) => ({
    revision: snapshot.scene.revision, bytes: snapshot.bytes, assets: [...snapshot.assets.keys()],
  }));
}

/** Discriminant preserves the only branch allowed to perform legacy hydration.
 * This returns a candidate; the session installs it only after full verification.
 */
export async function loadCompositionProject(id: SceneId, signal: AbortSignal) {
  const response = await request(`${base(id)}/scene`, { signal });
  const envelope = deserializeProjectEnvelope(JSON.parse(new TextDecoder().decode(await readAssetBody(response.body, 1024 * 1024))));
  if (envelope.scene.document.id !== id) throw new Error('The project document belongs to another photo.');
  if (envelope.kind === 'legacy') return { kind: 'legacy' as const, ...await loadProject(id, signal) };
  const assets = new Map<AssetId, Uint8Array<ArrayBuffer>>();
  await validateCompositionAssets(envelope.scene.document, async (asset, refs) => {
    const response = await request(`${base(id)}/${compositionAssetPath(asset, refs)}`, { signal });
    const bytes = await readAssetBody(response.body, compositionAssetLimit(refs));
    assets.set(asset, bytes);
    return bytes;
  });
  signal.throwIfAborted();
  return { kind: 'composition' as const, document: envelope.scene.document, revision: envelope.scene.revision, assets };
}
