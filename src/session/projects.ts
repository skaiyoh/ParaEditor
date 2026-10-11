import type { AssetId, SceneId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import * as store from '../projects/store.ts';
import type { Project } from '../projects/store.ts';

export type SaveState = 'saving' | 'saved' | 'failed';
export const PROJECT_UNDO_MS = 8000;
export type ProjectDeletion = {
  readonly id: SceneId;
  readonly name: string;
  readonly phase: 'undoable' | 'deleting' | 'deleted' | 'restored' | 'failed' | 'unconfirmed';
};
export type ProjectsState = {
  readonly projects: readonly Project[];
  readonly current: SceneId | null;
  readonly state: SaveState | 'absent';
  readonly states: ReadonlyMap<SceneId, SaveState>;
  readonly thumbnails: ReadonlySet<SceneId>;
  readonly deletions: readonly ProjectDeletion[];
  readonly error: 'list' | 'open' | null;
};
type Snapshot = {
  readonly document: SceneDocument; readonly masks: ReadonlyMap<AssetId, Plane<'u8'>>; readonly revision: number;
  readonly preview: Promise<Blob> | null;
};
type PendingDeletion = {
  readonly id: SceneId; readonly name: string;
  phase: ProjectDeletion['phase'];
  timer: ReturnType<typeof setTimeout> | null;
  dispatched: boolean;
};
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

export function createProjectSession(exportStill: (document: SceneDocument) => Promise<Blob>) {
  const jobs = new Map<SceneId, SavingProject>();
  const locals = new Map<SceneId, Project>();
  const states = new Map<SceneId, SaveState>();
  const thumbnails = new Set<SceneId>();
  const listeners = new Set<(state: ProjectsState) => void>();
  const deletions = new Map<SceneId, PendingDeletion>();
  const removing = new Map<SceneId, Promise<boolean>>();
  let listed: readonly Project[] = [];
  let current: SceneId | null = null;
  let importing = false;
  let panelError: ProjectsState['error'] = null;
  let refreshEpoch = 0;
  let absent = false;
  let probing = true;
  const snapshot = (): ProjectsState => {
    if (absent) return { projects: [], current: null, state: 'absent', states: new Map(), thumbnails: new Set(), deletions: [], error: null };
    const merged = new Map(listed.map((project) => [project.id, project]));
    for (const [id, project] of locals) merged.set(id, project);
    for (const [id, deletion] of deletions) if (deletion.phase === 'undoable' || deletion.phase === 'deleting') merged.delete(id);
    return { projects: [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
      current, state: panelError !== null ? 'failed' : importing ? 'saving' : current === null ? 'saved' : states.get(current) ?? 'saved', states: new Map(states),
      thumbnails: new Set([...listed.map((project) => project.id), ...thumbnails]),
      deletions: [...deletions.values()].map(({ id, name, phase }) => ({ id, name, phase })), error: panelError };
  };
  const publish = (): void => { for (const listener of listeners) listener(snapshot()); };
  const record = (doc: SceneDocument, saved = false): void => {
    const updatedAt = saved ? new Date().toISOString()
      : locals.get(doc.id)?.updatedAt ?? listed.find((project) => project.id === doc.id)?.updatedAt ?? doc.updatedAt;
    locals.set(doc.id, { id: doc.id, name: doc.title, updatedAt, thumbnail: `/api/projects/${doc.id}/thumbnail` });
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
      panelError = null;
    } catch { if (epoch === refreshEpoch) panelError = 'list'; }
    if (epoch === refreshEpoch) publish();
  }
  const fail = (id: SceneId): void => { states.set(id, 'failed'); publish(); };

  function capture(saved: Snapshot): Snapshot {
    if (saved.preview !== null) return saved;
    let preview: Promise<Blob>;
    try { preview = thumbnail(exportStill(saved.document)); }
    catch (error) { preview = Promise.reject(error); }
    void preview.catch(() => undefined);
    return { ...saved, preview };
  }

  function enqueue(id: SceneId, job: SavingProject): void {
    if (job.timer !== null) clearTimeout(job.timer);
    job.timer = null;
    const pending = job.pending;
    if (pending === null || job.deleted || absent) return;
    // A failed old job must never export the next project's renderer.
    if (pending.preview === null && current !== id) { fail(id); return; }
    const saved = capture(pending);
    if (job.latest === pending) job.latest = saved;
    job.pending = null;
    void saved.preview?.catch(() => {
      // A current project can recapture a transiently failed thumbnail on
      // retry. A non-current project still cannot use another renderer.
      if (job.latest.preview === saved.preview) job.latest = { ...job.latest, preview: null };
      if (job.pending?.preview === saved.preview) job.pending = { ...job.pending, preview: null };
    });
    // Invoke the exporter before importSource can replace the renderer's scene.
    // Encoding can finish later: the PNG pixels already belong to this snapshot.
    job.chain = job.chain.then(async () => {
      if (!await probe) return;
      try {
        if (!job.photoSaved) { await store.savePhoto(id, job.photo); job.photoSaved = true; }
        for (const [asset, mask] of saved.masks) {
          if (job.uploaded.has(asset)) continue;
          await store.saveMask(id, asset, mask); job.uploaded.add(asset);
        }
        if (saved.preview === null) throw new Error('The project preview was not captured.');
        await store.saveThumbnail(id, await saved.preview);
        thumbnails.add(id);
        await store.saveScene(saved.document, saved.masks, saved.revision);
        record(saved.document, true);
        if (job.latest.revision === saved.revision) states.set(id, 'saved');
        if (job.pending !== null && job.pending.revision <= saved.revision) job.pending = null;
        panelError = null;
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
    const latest: Snapshot = { document, masks: referenced(document, masks), revision: restoredRevision ?? 0, preview: null };
    const job: SavingProject = { photo, photoSaved: restored, uploaded: new Set(restored ? latest.masks.keys() : []), latest,
      pending: restored ? null : latest, timer: null, chain: Promise.resolve(), deleted: false };
    jobs.set(document.id, job);
    states.set(document.id, restored ? 'saved' : 'saving');
    if (restored) thumbnails.add(document.id);
    record(document); panelError = null;
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
    if (current !== document.id || job === undefined) return;
    const planes = referenced(document, masks);
    const changed = job.latest.document !== document || planes.size !== job.latest.masks.size || [...planes].some(([asset, mask]) => job.latest.masks.get(asset) !== mask);
    if (!changed) return;
    job.latest = { document, masks: planes, revision: job.latest.revision + 1, preview: null };
    job.pending = job.latest;
    record(document);
    // A failed project stays Not saved until a whole save succeeds.
    if (states.get(document.id) !== 'failed') states.set(document.id, 'saving');
    if (job.timer !== null) clearTimeout(job.timer);
    // Deletion freezes writes, while retaining edits for a failed DELETE.
    job.timer = job.deleted ? null : setTimeout(() => enqueue(document.id, job), 1500);
    publish();
  }
  function suspend(): void {
    if (current !== null) {
      const id = current, job = jobs.get(id);
      if (job !== undefined) {
        if (job.deleted && job.pending !== null) {
          const saved = capture(job.pending);
          if (job.latest === job.pending) job.latest = saved;
          job.pending = saved;
        }
        enqueue(id, job);
        void job.chain.then(() => {
          if (current !== id && job.pending === null && jobs.get(id) === job) jobs.delete(id);
        });
      }
    }
    current = null; importing = true;
    publish();
  }
  function clearDeletionTimer(deletion: PendingDeletion): void {
    if (deletion.timer !== null) clearTimeout(deletion.timer);
    deletion.timer = null;
  }
  function release(id: SceneId): void {
    ++refreshEpoch;
    listed = listed.filter((project) => project.id !== id);
    locals.delete(id); states.delete(id); thumbnails.delete(id); jobs.delete(id);
    if (current === id) current = null;
  }
  async function commitRemoval(id: SceneId, deletion: PendingDeletion | undefined): Promise<boolean> {
    const active = (): boolean => deletion === undefined || (deletions.get(id) === deletion && deletion.phase === 'deleting');
    if (!await probe || !active()) return false;
    const job = jobs.get(id);
    if (job !== undefined) {
      job.deleted = true;
      if (job.timer !== null) clearTimeout(job.timer);
      job.timer = null;
      await job.chain;
    }
    if (!active()) {
      if (job !== undefined) job.deleted = false;
      return false;
    }
    try {
      if (deletion !== undefined) deletion.dispatched = true;
      await store.deleteProject(id);
      release(id);
      if (deletion !== undefined) deletion.phase = 'deleted';
      publish(); return true;
    } catch (error) {
      // An HTTP refusal is recoverable. A missing/corrupt acknowledgement may
      // already have tombstoned the id: retain data without resuming writes.
      const recoverable = error instanceof store.ProjectRequestError;
      if (job !== undefined) job.deleted = !recoverable;
      if (deletion !== undefined) deletion.phase = recoverable ? 'failed' : 'unconfirmed';
      else {
        const project = locals.get(id) ?? listed.find((project) => project.id === id);
        if (project !== undefined) deletions.set(id, { id, name: project.name, phase: recoverable ? 'failed' : 'unconfirmed', timer: null, dispatched: true });
      }
      publish(); return false;
    }
  }
  function remove(id: SceneId): Promise<boolean> {
    const running = removing.get(id);
    if (running !== undefined) return running;
    const deletion = deletions.get(id);
    if (deletion !== undefined) { clearDeletionTimer(deletion); deletion.phase = 'deleting'; }
    const operation = commitRemoval(id, deletion).finally(() => removing.delete(id));
    removing.set(id, operation);
    return operation;
  }
  function requestRemove(id: SceneId): boolean {
    if (absent || removing.has(id)) return false;
    const previous = deletions.get(id);
    if (previous?.phase === 'undoable') return false;
    if (previous?.phase === 'unconfirmed') { void remove(id); publish(); return true; }
    const project = locals.get(id) ?? listed.find((project) => project.id === id);
    if (project === undefined) return false;
    const deletion: PendingDeletion = { id, name: project.name, phase: 'undoable', timer: null, dispatched: false };
    deletion.timer = setTimeout(() => {
      if (deletions.get(id) !== deletion || deletion.phase !== 'undoable') return;
      void remove(id); publish();
    }, PROJECT_UNDO_MS);
    deletions.set(id, deletion); publish(); return true;
  }
  function undoRemove(id: SceneId): boolean {
    const deletion = deletions.get(id);
    if (deletion?.phase !== 'undoable') return false;
    clearDeletionTimer(deletion); deletion.phase = 'restored'; publish(); return true;
  }
  function cancelPendingRemovals(): void {
    for (const deletion of deletions.values()) {
      if (deletion.dispatched || (deletion.phase !== 'undoable' && deletion.phase !== 'deleting')) continue;
      clearDeletionTimer(deletion); deletion.phase = 'restored';
      const job = jobs.get(deletion.id);
      if (job !== undefined) {
        job.deleted = false;
        if (job.pending !== null && job.timer === null) job.timer = setTimeout(() => enqueue(deletion.id, job), 1500);
      }
    }
    publish();
  }
  // Panel unmounts do not own these timers. Navigation cancels undispatched
  // deletion, and a BFCache return can continue using this same session.
  if (typeof window !== 'undefined') window.addEventListener('pagehide', cancelPendingRemovals);
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
      for (const deletion of deletions.values()) clearDeletionTimer(deletion);
      deletions.clear();
    } else listed = result.projects;
    publish();
    return result.kind !== 'absent';
  }, () => {
    probing = false; panelError = 'list'; publish();
    return true;
  });
  return {
    snapshot, refresh, begin, observe, suspend, remove, requestRemove, undoRemove, cancelPendingRemovals,
    dismissDeletion(id: SceneId): void {
      const deletion = deletions.get(id);
      if (deletion?.phase === 'deleted' || deletion?.phase === 'restored') { deletions.delete(id); publish(); }
    },
    diagnostics: () => ({ retainedJobs: jobs.size, pendingSaves: [...jobs.values()].filter((job) => job.pending !== null).length }),
    subscribe(listener: (state: ProjectsState) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    async load(id: SceneId, signal: AbortSignal) {
      if (!await probe) throw new Error('No project store on this server');
      const assertOpen = (): void => {
        const deletion = deletions.get(id);
        if (deletion?.phase === 'undoable' || deletion?.phase === 'deleting' || deletion?.phase === 'unconfirmed' || jobs.get(id)?.deleted) throw new Error('This project is being deleted.');
      };
      for (;;) {
        signal.throwIfAborted();
        assertOpen();
        const job = jobs.get(id);
        if (job === undefined) {
          const loaded = await store.loadProject(id, signal);
          assertOpen();
          return loaded;
        }
        // Undo followed immediately by Open must include the pending debounce.
        enqueue(id, job);
        await job.chain;
        signal.throwIfAborted();
        assertOpen();
        if (states.get(id) === 'failed') throw new Error('The latest project changes could not be saved. Try again.');
        if (job.pending !== null) continue;
        const revision = job.latest.revision;
        const loaded = await store.loadProject(id, signal);
        assertOpen();
        if (job.pending === null && job.latest.revision === revision) return loaded;
      }
    },
    openFailed(): void { importing = false; panelError = 'open'; publish(); },
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
