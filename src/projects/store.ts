import { isAssetId, isSceneId, type AssetId, type SceneId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import type { LegacySceneDocument } from '../core/types.ts';
import { z } from '../core/zod.ts';
import { deserializeMask, deserializeScene, serializeMask, serializeScene, type SavedScene } from './serialize.ts';
import { deserializeProjectEnvelope, serializeCompositionScene, type SavedComposition, type SavedCompositionWire } from './serialize.ts';
import { compositionAssetLimit, compositionAssetPath, compositionInventory, readAssetBody, validateCompositionAsset, validateCompositionAssets } from './assets.ts';
import { COMPOSITION_LIMITS } from '../core/composition-ranges.ts';
import { measureCompositionAssets } from '../core/asset-refs.ts';

const idSchema = z.custom<SceneId>((value) => typeof value === 'string' && isSceneId(value));
const projectSchema = z.strictObject({ id: idSchema, name: z.string(), updatedAt: z.iso.datetime(), thumbnail: z.string() })
  .refine((project) => project.thumbnail === `/api/projects/${project.id}/thumbnail`);
const listSchema = z.strictObject({ projects: z.array(projectSchema) });
export type Project = z.infer<typeof projectSchema>;
export type ProjectStoreProbe = { readonly kind: 'absent' } | { readonly kind: 'available'; readonly projects: readonly Project[] };
const acknowledgement = z.strictObject({ ok: z.literal(true) });

// A receipt retains only an acknowledged digest and length, never asset bytes.
// Eviction safely causes an idempotent PUT on the next session checkpoint.
const compositionReceipts = new Map<SceneId, Map<AssetId, number>>();
const RECEIPT_PROJECT_LIMIT = 64;
const RECEIPT_ASSET_LIMIT = 256;
function acknowledgeAsset(id: SceneId, asset: AssetId, bytes: number): void {
  const receipts = compositionReceipts.get(id) ?? new Map<AssetId, number>();
  compositionReceipts.delete(id); compositionReceipts.set(id, receipts);
  receipts.delete(asset); receipts.set(asset, bytes);
  while (receipts.size > RECEIPT_ASSET_LIMIT) {
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined) receipts.delete(oldest);
  }
  while (compositionReceipts.size > RECEIPT_PROJECT_LIMIT) {
    const oldest = compositionReceipts.keys().next().value;
    if (oldest !== undefined) compositionReceipts.delete(oldest);
  }
}

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

/** Blob capture copies an exact encoded view once; ordinary buffers need no staging copy. */
export function captureEncodedAsset(bytes: Uint8Array, mediaType: string): Blob {
  const part = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return new Blob([part], { type: mediaType });
}

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
/** Compatibility-only writer; editor checkpoints use saveComposition. */
export function saveScene(document: LegacySceneDocument, masks: ReadonlyMap<AssetId, Plane<'u8'>>, revision: number): Promise<void> {
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
/** Start retaining an imported original before thumbnail capture is needed. */
export async function saveCompositionOriginal(id: SceneId, source: { readonly asset: AssetId; readonly mediaType: string; readonly byteLength: number }, bytes: Uint8Array | Blob): Promise<void> {
  const immutable = bytes instanceof Blob ? bytes : captureEncodedAsset(bytes, source.mediaType);
  await validateCompositionAsset(new Uint8Array(await immutable.arrayBuffer()), source.asset, [{ ...source, kind: 'original' }]);
  acknowledgement.parse(await (await request(`${base(id)}/photo`, { method: 'PUT',
    headers: { 'Content-Type': source.mediaType, 'X-Project-Asset': source.asset }, body: immutable,
  })).json());
  acknowledgeAsset(id, source.asset, immutable.size);
}
export async function loadProject(id: SceneId, signal: AbortSignal) {
  const scene = deserializeScene(await (await request(`${base(id)}/scene`, { signal })).json());
  return loadLegacyProject(id, signal, scene);
}
async function loadLegacyProject(id: SceneId, signal: AbortSignal, scene: SavedScene) {
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
    compositionReceipts.delete(id);
    return;
  }
  acknowledgement.parse(await response.json());
  compositionReceipts.delete(id);
}

export type CompositionSaveInput = {
  readonly document: SavedComposition['document'];
  readonly revision: number;
  /** Encoded bytes, not payload-only planes. Immutable Blobs share save ownership. */
  readonly assets: ReadonlyMap<AssetId, Uint8Array | Blob>;
  /** Already captured from this committed document; never a live renderer callback. */
  readonly thumbnail: Blob;
  /** Session saves use acknowledged immutable hashes; direct callers retain GET probing. */
  readonly probeMissing?: boolean;
};
type Snapshot = { readonly scene: SavedCompositionWire; readonly assets: ReadonlyMap<AssetId, Blob>; readonly thumbnail: Blob; readonly bytes: number; readonly probeMissing: boolean };
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
    const length = bytes instanceof Blob ? bytes.size : bytes.byteLength;
    if (length === 0 || length > compositionAssetLimit(refs)) throw new Error('The project asset is too large or empty.');
    lengths.set(asset, length);
    if (refs.some((ref) => ref.kind !== 'original')) additional += length;
  }
  if (additional > COMPOSITION_LIMITS.activeAssetBytes) throw new Error('The composition exceeds its 64 MiB asset budget.');
  const measured = measureCompositionAssets(inventory, lengths);
  if (!measured.ok) throw new Error(measured.error.detail);
  const assets = new Map<AssetId, Blob>();
  for (const [asset, refs] of inventory) {
    const bytes = input.assets.get(asset);
    if (bytes === undefined) throw new Error('A committed project asset is missing.');
    const original = refs.find((ref) => ref.kind === 'original');
    // A Blob already owns immutable bytes. Sharing it avoids a third physical
    // snapshot while the session retains an active checkpoint for retries.
    assets.set(asset, bytes instanceof Blob ? bytes : captureEncodedAsset(bytes, original?.mediaType ?? 'application/octet-stream'));
  }
  return { scene, assets, thumbnail: input.thumbnail, bytes: measured.value.bytes, probeMissing: input.probeMissing ?? true };
}

async function writeComposition(snapshot: Snapshot): Promise<void> {
  const { scene, assets } = snapshot;
  await validateCompositionAssets(scene.document, async (asset) => {
    const blob = assets.get(asset);
    return blob === undefined ? null : new Uint8Array(await blob.arrayBuffer());
  });
  const thumbnail = new Uint8Array(await snapshot.thumbnail.arrayBuffer());
  if (thumbnail[0] !== 255 || thumbnail[1] !== 216 || thumbnail.at(-2) !== 255 || thumbnail.at(-1) !== 217) throw new Error('The project thumbnail must be a JPEG under 60 KB.');
  // Session saves can upload an unknown digest directly, avoiding expected 404
  // console noise. A complete acknowledgment or strict load is its only receipt.
  // Direct store callers retain their original GET/probe compatibility contract.
  for (const [asset, refs] of compositionInventory(scene.document)) {
    const blob = assets.get(asset);
    if (blob === undefined) throw new Error('A committed project asset is missing.');
    const path = `${base(scene.document.id)}/${compositionAssetPath(asset, refs)}`;
    if (!snapshot.probeMissing && compositionReceipts.get(scene.document.id)?.get(asset) === blob.size) continue;
    const existing = snapshot.probeMissing ? await request(path, {}, true) : null;
    if (existing === null || existing.status === 404) {
      await existing?.body?.cancel();
      if (refs.every((ref) => ref.kind === 'original')) {
        // The original upload keeps its existing 24 MiB route limit; the hash
        // opts into immutable storage instead of the legacy mutable photo slot.
        acknowledgement.parse(await (await request(`${base(scene.document.id)}/photo`, {
          method: 'PUT', headers: { 'Content-Type': refs[0]?.kind === 'original' ? refs[0].mediaType : blob.type, 'X-Project-Asset': asset }, body: blob,
        })).json());
      } else await put(path, blob, 'application/octet-stream');
    } else {
      const bytes = await readAssetBody(existing.body, compositionAssetLimit(refs));
      await verifyAsset(new Uint8Array(bytes).buffer, asset);
    }
    acknowledgeAsset(scene.document.id, asset, blob.size);
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
        compositionReceipts.delete(id);
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
  if (envelope.kind === 'legacy') return { kind: 'legacy' as const, ...await loadLegacyProject(id, signal, envelope.scene) };
  const assets = new Map<AssetId, Uint8Array<ArrayBuffer>>();
  await validateCompositionAssets(envelope.scene.document, async (asset, refs) => {
    const response = await request(`${base(id)}/${compositionAssetPath(asset, refs)}`, { signal });
    const bytes = await readAssetBody(response.body, compositionAssetLimit(refs));
    assets.set(asset, bytes);
    return bytes;
  });
  signal.throwIfAborted();
  for (const [asset, bytes] of assets) acknowledgeAsset(id, asset, bytes.byteLength);
  return { kind: 'composition' as const, document: envelope.scene.document, revision: envelope.scene.revision, assets };
}
