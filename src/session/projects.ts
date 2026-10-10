import type { AssetId, SceneId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import * as store from '../projects/store.ts';
import type { Project } from '../projects/store.ts';

export type SaveState = 'saving' | 'saved' | 'failed';
export type ProjectsState = {
  readonly projects: readonly Project[];
  readonly current: SceneId | null;
  readonly state: SaveState | 'absent';
  readonly states: ReadonlyMap<SceneId, SaveState>;
  readonly thumbnails: ReadonlySet<SceneId>;
};
type Snapshot = { readonly document: SceneDocument; readonly masks: ReadonlyMap<AssetId, Plane<'u8'>>; readonly revision: number };
type SavingProject = {
  readonly photo: File;
  readonly uploaded: Set<AssetId>;
  photoSaved: boolean;
  latest: Snapshot;
  pending: Snapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  deleted: boolean;
};

/** The still exporter renders frame zero without the selection outline. */
async function thumbnail(still: Promise<Blob>): Promise<Blob> {
  const bitmap = await createImageBitmap(await still);
  try {
    const scale = 256 / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (context === null) throw new Error('The project thumbnail canvas is unavailable.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4, 0.2]) {
      const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob === null) reject(new Error('The project thumbnail could not be encoded.'));
        else resolve(blob);
      }, 'image/jpeg', quality));
      if (jpeg.type === 'image/jpeg' && jpeg.size < 60_000) return jpeg;
    }
    throw new Error('The project thumbnail is too large.');
  } finally { bitmap.close(); }
}

export function createProjectSession(exportStill: () => Promise<Blob>) {
  const jobs = new Map<SceneId, SavingProject>();
  const locals = new Map<SceneId, Project>();
  const states = new Map<SceneId, SaveState>();
  const thumbnails = new Set<SceneId>();
  const listeners = new Set<(state: ProjectsState) => void>();
  let listed: readonly Project[] = [];
  let current: SceneId | null = null;
  let importing = false;
  let panelFailed = false;
  let refreshEpoch = 0;
  let absent = false;
  let probing = true;
  const snapshot = (): ProjectsState => {
    if (absent) return { projects: [], current: null, state: 'absent', states: new Map(), thumbnails: new Set() };
    const merged = new Map(listed.map((project) => [project.id, project]));
    for (const [id, project] of locals) merged.set(id, project);
    return { projects: [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
      current, state: panelFailed ? 'failed' : importing ? 'saving' : current === null ? 'saved' : states.get(current) ?? 'saved', states: new Map(states),
      thumbnails: new Set([...listed.map((project) => project.id), ...thumbnails]) };
  };
  const publish = (): void => { for (const listener of listeners) listener(snapshot()); };
  const record = (doc: SceneDocument): void => {
    locals.set(doc.id, { id: doc.id, name: doc.title, updatedAt: new Date().toISOString(), thumbnail: `/api/projects/${doc.id}/thumbnail` });
  };
  async function refresh(): Promise<void> {
    const initial = probing;
    if (!await probe || initial) return;
    const epoch = ++refreshEpoch;
    try {
      const projects = await store.listProjects();
      if (epoch !== refreshEpoch) return;
      listed = projects;
      for (const project of projects) if (states.get(project.id) === 'saved') locals.delete(project.id);
      panelFailed = false;
    } catch { if (epoch === refreshEpoch) panelFailed = true; }
    if (epoch === refreshEpoch) publish();
  }
  const fail = (id: SceneId): void => { states.set(id, 'failed'); publish(); };

  function enqueue(id: SceneId, job: SavingProject): void {
    if (job.timer !== null) clearTimeout(job.timer);
    job.timer = null;
    const saved = job.pending;
    if (saved === null || job.deleted || absent) return;
    job.pending = null;
    // Invoke the exporter before importSource can replace the renderer's scene.
    // Encoding can finish later: the PNG pixels already belong to this snapshot.
    let preview: Promise<Blob>;
    try { preview = thumbnail(exportStill()); }
    catch (error) { preview = Promise.reject(error); }
    void preview.catch(() => undefined);
    job.chain = job.chain.then(async () => {
      if (!await probe) return;
      try {
        if (!job.photoSaved) { await store.savePhoto(id, job.photo); job.photoSaved = true; }
        for (const [asset, mask] of saved.masks) {
          if (job.uploaded.has(asset)) continue;
          await store.saveMask(id, asset, mask); job.uploaded.add(asset);
        }
        await store.saveThumbnail(id, await preview);
        thumbnails.add(id);
        await store.saveScene(saved.document, saved.masks, saved.revision);
        record(saved.document);
        if (job.latest.revision === saved.revision) states.set(id, 'saved');
        panelFailed = false;
        publish();
      } catch (error) {
        // Retain the latest snapshot for the next edit, flush or retry.
        if (!(error instanceof store.ProjectRequestError && error.terminal)) job.pending ??= job.latest;
        fail(id);
      }
    });
  }

  function begin(photo: File, document: SceneDocument, masks: ReadonlyMap<AssetId, Plane<'u8'>>, restoredRevision: number | null): void {
    importing = false;
    if (absent) return;
    const restored = restoredRevision !== null;
    current = document.id;
    const latest = { document, masks: referenced(document, masks), revision: restoredRevision ?? 0 };
    const job: SavingProject = { photo, photoSaved: restored, uploaded: new Set(restored ? latest.masks.keys() : []), latest,
      pending: restored ? null : latest, timer: null, chain: Promise.resolve(), deleted: false };
    jobs.set(document.id, job);
    states.set(document.id, restored ? 'saved' : 'saving');
    if (restored) thumbnails.add(document.id);
    record(document); panelFailed = false;
    if (!restored) {
      job.chain = (async () => {
        if (!await probe) return;
        await store.savePhoto(document.id, photo); job.photoSaved = true;
      })().catch((error: unknown) => {
        if (error instanceof store.ProjectRequestError && error.terminal && job.pending?.revision === latest.revision) job.pending = null;
        fail(document.id);
      });
      job.timer = setTimeout(() => enqueue(document.id, job), 1500);
    }
    publish();
  }
  function observe(document: SceneDocument, masks: ReadonlyMap<AssetId, Plane<'u8'>>): void {
    if (absent) return;
    const job = jobs.get(document.id);
    if (current !== document.id || job === undefined || job.deleted) return;
    const planes = referenced(document, masks);
    const changed = job.latest.document !== document || planes.size !== job.latest.masks.size || [...planes].some(([asset, mask]) => job.latest.masks.get(asset) !== mask);
    if (!changed) return;
    job.latest = { document, masks: planes, revision: job.latest.revision + 1 };
    job.pending = job.latest;
    record(document);
    // A failed project stays Not saved until a whole save succeeds.
    if (states.get(document.id) !== 'failed') states.set(document.id, 'saving');
    if (job.timer !== null) clearTimeout(job.timer);
    job.timer = setTimeout(() => enqueue(document.id, job), 1500);
    publish();
  }
  function suspend(): void {
    if (current !== null) {
      const id = current, job = jobs.get(id);
      if (job !== undefined) {
        enqueue(id, job);
        void job.chain.then(() => {
          if (current !== id && job.pending === null && jobs.get(id) === job) jobs.delete(id);
        });
      }
    }
    current = null; importing = true;
    publish();
  }
  async function remove(id: SceneId): Promise<boolean> {
    if (!await probe) return false;
    const job = jobs.get(id);
    if (job !== undefined) {
      job.deleted = true; job.pending = null;
      if (job.timer !== null) clearTimeout(job.timer);
      job.timer = null;
      await job.chain;
    }
    try {
      await store.deleteProject(id);
      ++refreshEpoch;
      listed = listed.filter((project) => project.id !== id);
      locals.delete(id); states.delete(id); thumbnails.delete(id);
      jobs.delete(id);
      if (current === id) current = null;
      panelFailed = false; publish(); return true;
    } catch {
      if (job !== undefined) job.deleted = false;
      panelFailed = true; fail(id); return false;
    }
  }
  // Boot and every operation share this one probe. A 204 or 404 disables the store.
  const probe = store.probeProjects().then((result) => {
    probing = false;
    if (result.kind === 'absent') {
      absent = true; current = null;
      for (const job of jobs.values()) {
        if (job.timer !== null) clearTimeout(job.timer);
        job.pending = null; job.deleted = true;
      }
      jobs.clear(); locals.clear(); states.clear(); thumbnails.clear(); listed = [];
    } else listed = result.projects;
    publish();
    return result.kind !== 'absent';
  }, () => {
    probing = false; panelFailed = true; publish();
    return true;
  });
  return {
    snapshot, refresh, begin, observe, suspend, remove,
    diagnostics: () => ({ retainedJobs: jobs.size, pendingSaves: [...jobs.values()].filter((job) => job.pending !== null).length }),
    subscribe(listener: (state: ProjectsState) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    async load(id: SceneId, signal: AbortSignal) {
      if (!await probe) throw new Error('No project store on this server');
      const job = jobs.get(id);
      if (job !== undefined) await job.chain;
      signal.throwIfAborted();
      return store.loadProject(id, signal);
    },
    openFailed(): void { importing = false; panelFailed = true; publish(); },
  };
}

function referenced(document: SceneDocument, masks: ReadonlyMap<AssetId, Plane<'u8'>>): ReadonlyMap<AssetId, Plane<'u8'>> {
  const planes = new Map<AssetId, Plane<'u8'>>();
  for (const object of document.objects) {
    const mask = masks.get(object.produced.mask.asset);
    if (mask !== undefined) planes.set(object.produced.mask.asset, mask);
  }
  return planes;
}
