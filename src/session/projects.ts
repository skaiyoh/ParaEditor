import type { AssetId, SceneId } from '../core/ids.ts';
import type { SceneDocument } from '../core/types.ts';
import { measureCompositionAssets } from '../core/asset-refs.ts';
import { COMPOSITION_LIMITS } from '../core/composition-ranges.ts';
import { renderingPrerequisites } from '../core/derive.ts';
import { remixDocumentSchema, serializeRemixDocument, type MathCheckpoint } from '../core/remix-schema.ts';
import * as store from '../projects/store.ts';
import type { Project } from '../projects/store.ts';
import { compositionAssetLimit, compositionInventory } from '../projects/assets.ts';

export type SaveState = 'saving' | 'saved' | 'failed';
export const PROJECT_UNDO_MS = 8000;
const MiB = 1024 * 1024;
/** Encoded ownership across the entire session, not one limit per project. */
export const PROJECT_SAVE_BYTE_BUDGET = 176 * MiB;
export const PROJECT_SAVE_METADATA_BUDGET = 8 * MiB;
export const PROJECT_SAVE_JOB_LIMIT = 64;
const PROJECT_DOCUMENT_LIMIT = MiB;
const PROJECT_PREVIEW_LIMIT = 59_999;
const SAVE_MEMORY_REASON = 'Unsaved projects have reached the save memory limit. Retry saving or delete an unsaved project before continuing.';
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
  readonly document: SceneDocument; readonly assets: ReadonlyMap<AssetId, Blob>; readonly revision: number;
  readonly bytes: number; readonly complete: boolean;
  readonly preview: Promise<Blob> | null;
};
export type ProjectCheckpoint =
  | { readonly kind: 'new' }
  | { readonly kind: 'restored'; readonly revision: number }
  | { readonly kind: 'upgrade'; readonly revision: number };
export type ProjectBegin = {
  readonly document: SceneDocument;
  readonly assets: ReadonlyMap<AssetId, Uint8Array>;
  readonly checkpoint: ProjectCheckpoint;
};
export type ProjectAdmission = { readonly kind: 'admitted' } | { readonly kind: 'refused'; readonly reason: string };
export type ProjectSaveUsage = { readonly bytes: number; readonly metadataBytes: number; readonly jobs: number; readonly assets: number };
export type ProjectRetention = {
  readonly id: SceneId; readonly revision: number; readonly kind: 'active' | 'pending';
  readonly assets: readonly AssetId[]; readonly bytes: number; readonly complete: boolean;
};
type PendingDeletion = {
  readonly id: SceneId; readonly name: string;
  phase: ProjectDeletion['phase'];
  timer: ReturnType<typeof setTimeout> | null;
  dispatched: boolean;
};
type SavingProject = {
  document: SceneDocument;
  revision: number;
  lengths: ReadonlyMap<AssetId, number>;
  active: Snapshot | null;
  pending: Snapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
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
  const acknowledged = new Map<SceneId, MathCheckpoint>();
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
  const documentLengths = new WeakMap<SceneDocument, number>();
  function documentLength(document: SceneDocument): number {
    let bytes = documentLengths.get(document);
    if (bytes === undefined) {
      bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
      documentLengths.set(document, bytes);
    }
    if (bytes > PROJECT_DOCUMENT_LIMIT) throw new Error('The project scene is too large.');
    return bytes;
  }
  function reusableAssets(assets: ReadonlyMap<AssetId, Uint8Array>): ReadonlyMap<AssetId, Blob> {
    const reusable = new Map<AssetId, Blob>();
    for (const job of jobs.values()) for (const retained of [job.pending, job.active]) {
      if (retained === null) continue;
      for (const [asset, immutable] of retained.assets) {
        // Session product ids identify checked immutable bytes. Share the
        // captured Blob itself; equal ids must not hide independent copies.
        if (assets.get(asset)?.byteLength === immutable.size && !reusable.has(asset)) reusable.set(asset, immutable);
      }
    }
    return reusable;
  }
  function usage(replacing: SavingProject | null = null, candidate: {
    readonly document: SceneDocument; readonly assets: ReadonlyMap<AssetId, Uint8Array>; readonly reusable: ReadonlyMap<AssetId, Blob>;
    readonly capture: boolean; readonly addsJob: boolean;
  } | null = null): ProjectSaveUsage {
    const owned = new Set<Blob>(), documents = new Set<SceneDocument>(), snapshots = new Set<Snapshot>(), previews = new Set<Promise<Blob>>();
    const previewDocuments = new Set<SceneDocument>(), uncapturedDocuments = new Set<SceneDocument>();
    for (const job of jobs.values()) {
      if (job !== replacing) documents.add(job.document);
      for (const retained of [job.active, job === replacing ? null : job.pending]) {
        if (retained === null || snapshots.has(retained)) continue;
        snapshots.add(retained); documents.add(retained.document);
        for (const immutable of retained.assets.values()) owned.add(immutable);
        if (retained.preview === null) uncapturedDocuments.add(retained.document);
        else { previews.add(retained.preview); previewDocuments.add(retained.document); }
      }
    }
    let bytes = [...owned].reduce((sum, immutable) => sum + immutable.size, 0), assets = owned.size;
    if (candidate !== null) {
      documents.add(candidate.document);
      if (candidate.capture) {
        uncapturedDocuments.add(candidate.document);
        for (const [asset, input] of candidate.assets) {
          const immutable = candidate.reusable.get(asset);
          if (immutable !== undefined) {
            if (!owned.has(immutable)) { owned.add(immutable); bytes += immutable.size; assets++; }
          } else { bytes += input.byteLength; assets++; }
        }
      }
    }
    // An early original upload and its newly captured pending snapshot share
    // one document preview. Capturing it during suspend must not invalidate
    // import admission. Distinct retained preview promises still each count.
    let metadataBytes = previews.size * PROJECT_PREVIEW_LIMIT;
    for (const document of uncapturedDocuments) if (!previewDocuments.has(document)) metadataBytes += PROJECT_PREVIEW_LIMIT;
    for (const document of documents) metadataBytes += documentLength(document);
    return { bytes, metadataBytes, jobs: jobs.size + (candidate?.addsJob ? 1 : 0), assets };
  }
  function admit(replacing: SavingProject | null, document: SceneDocument, available: ReadonlyMap<AssetId, Uint8Array>, capture: boolean, addsJob: boolean): ProjectAdmission {
    try {
      const projected = usage(replacing, { document, assets: available, reusable: reusableAssets(available), capture, addsJob });
      return projected.bytes > PROJECT_SAVE_BYTE_BUDGET || projected.metadataBytes > PROJECT_SAVE_METADATA_BUDGET || projected.jobs > PROJECT_SAVE_JOB_LIMIT
        ? { kind: 'refused', reason: SAVE_MEMORY_REASON } : { kind: 'admitted' };
    } catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'The project could not be prepared.' }; }
  }
  function preflight({ document, assets, checkpoint }: ProjectBegin): ProjectAdmission {
    if (absent) return { kind: 'admitted' };
    const existing = jobs.get(document.id);
    if (existing !== undefined && (existing.active !== null || existing.pending !== null)) return { kind: 'refused', reason: 'This project has unsaved changes. Save or retry them before reopening it.' };
    // Decoding a same-project candidate can overlap a newer repair and save.
    // An empty queue must not admit that candidate and reset the saved revision.
    if (current === document.id && existing !== undefined && checkpoint.kind !== 'new' && checkpoint.revision < existing.revision) {
      return { kind: 'refused', reason: 'This project changed while it was opening, so it has stayed open with your latest changes.' };
    }
    try {
      const available = referenced(document, assets);
      prepareSnapshot(document, available);
      return admit(existing ?? null, document, available, checkpoint.kind !== 'restored', existing === undefined);
    } catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'The project could not be prepared.' }; }
  }
  function preflightObserve(document: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>): ProjectAdmission {
    if (absent) return { kind: 'admitted' };
    const job = jobs.get(document.id);
    if (current !== document.id || job === undefined) return { kind: 'admitted' };
    try {
      const available = referenced(document, assets);
      const nextLengths = lengths(available);
      if (job.document === document && nextLengths.size === job.lengths.size &&
        [...nextLengths].every(([asset, length]) => job.lengths.get(asset) === length)) return { kind: 'admitted' };
      prepareSnapshot(document, available);
      return admit(job, document, available, true, false);
    } catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'The project could not be prepared.' }; }
  }
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
    if (job.running !== null || job.pending === null || job.deleted || absent || !job.pending.complete) return;
    const operation = (async () => {
      if (!await probe) return;
      while (!job.deleted && job.pending !== null && job.pending.complete) {
        const pending = job.pending;
        // A failed old job must never export the next project's renderer.
        if (pending.preview === null && current !== id) { fail(id); break; }
        const saved = capture(pending);
        job.active = saved;
        job.pending = null;
        try {
          if (saved.preview === null) throw new Error('The project preview was not captured.');
          const result = await store.saveComposition({ document: saved.document, assets: saved.assets,
            revision: saved.revision, thumbnail: await saved.preview, probeMissing: false });
          if (result.kind === 'saved') {
            if (saved.document.version === 6) acknowledged.set(id, saved.document.remix.checkpoint);
            thumbnails.add(id);
            record(saved.document, true);
            if (job.revision === result.revision && job.document === saved.document && saved.complete && job.pending === null) states.set(id, 'saved');
            panelError = null;
            publish();
          }
        } catch (error) {
          // Retain only the newest snapshot for edit/flush retry. Rejected
          // previews can be recaptured only while this project's renderer lives.
          const terminal = error instanceof store.ProjectRequestError && error.terminal;
          if (terminal) job.pending = null;
          else if (job.pending === null) {
            let preview = saved.preview;
            try { await preview; } catch { preview = null; }
            job.pending = { ...saved, preview };
          }
          fail(id);
          if (terminal || job.pending?.revision === saved.revision) break;
        } finally { job.active = null; }
      }
    })();
    job.running = operation;
    void operation.finally(() => {
      if (job.running === operation) job.running = null;
      if (current !== id && job.pending === null && jobs.get(id) === job && !job.deleted) jobs.delete(id);
    });
  }

  function begin({ document, assets, checkpoint }: ProjectBegin): ProjectAdmission {
    const admission = preflight({ document, assets, checkpoint });
    if (admission.kind === 'refused') return admission;
    importing = false;
    if (absent) return admission;
    current = document.id;
    const restored = checkpoint.kind === 'restored';
    const revision = checkpoint.kind === 'new' ? 0 : checkpoint.revision + (checkpoint.kind === 'upgrade' ? 1 : 0);
    const available = referenced(document, assets), prepared = prepareSnapshot(document, available);
    const latest = restored ? null : committedSnapshot(document, available, revision, prepared, reusableAssets(available));
    const job: SavingProject = { document, revision, lengths: prepared.lengths, active: null,
      pending: latest, timer: null, running: null, deleted: false };
    jobs.set(document.id, job);
    states.set(document.id, restored ? 'saved' : 'saving');
    if (restored && document.version === 6) acknowledged.set(document.id, document.remix.checkpoint);
    else acknowledged.delete(document.id);
    if (restored) thumbnails.add(document.id);
    record(document); panelError = null;
    if (latest !== null) {
      job.timer = setTimeout(() => enqueue(document.id, job), 1500);
      const source = document.frame.source, original = source === null ? undefined : latest.assets.get(source.asset);
      if (checkpoint.kind === 'new' && latest.complete && source !== null && original !== undefined) {
        // This is the same snapshot already pending, so early original retention
        // creates no third save root and never needs a renderer capture.
        job.active = latest;
        const operation = (async () => {
          if (!await probe) return;
          try { await store.saveCompositionOriginal(document.id, source, original); }
          catch (error) {
            if (error instanceof store.ProjectRequestError && error.terminal) job.pending = null;
            fail(document.id);
          }
        })();
        job.running = operation;
        void operation.finally(() => {
          if (job.running === operation) { job.running = null; job.active = null; }
          if (job.timer === null && job.pending !== null && !job.deleted) enqueue(document.id, job);
        });
      }
    }
    publish();
    return admission;
  }
  function observe(document: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>): ProjectAdmission {
    if (absent) return { kind: 'admitted' };
    const job = jobs.get(document.id);
    if (current !== document.id || job === undefined) return { kind: 'admitted' };
    const available = referenced(document, assets), nextLengths = lengths(available);
    const changed = job.document !== document || nextLengths.size !== job.lengths.size ||
      [...nextLengths].some(([asset, length]) => job.lengths.get(asset) !== length);
    if (!changed) return { kind: 'admitted' };
    const admission = preflightObserve(document, assets);
    if (admission.kind === 'refused') return admission;
    // Preflight before replacing the pending slot, then reuse unchanged hashes
    // and release superseded bytes before allocating this committed snapshot.
    const prepared = prepareSnapshot(document, available), reusable = reusableAssets(available);
    job.pending = null;
    const latest = committedSnapshot(document, available, job.revision + 1, prepared, reusable);
    job.document = document; job.revision = latest.revision; job.lengths = nextLengths;
    // Replacing this single slot releases every superseded snapshot immediately.
    job.pending = latest;
    record(document);
    // A failed project stays Not saved until a whole save succeeds.
    if (states.get(document.id) !== 'failed') states.set(document.id, 'saving');
    if (job.timer !== null) clearTimeout(job.timer);
    // Deletion freezes writes, while retaining edits for a failed DELETE.
    job.timer = job.deleted ? null : setTimeout(() => enqueue(document.id, job), 1500);
    publish();
    return admission;
  }
  function suspend(): void {
    if (current !== null) {
      const id = current, job = jobs.get(id);
      if (job !== undefined) {
        // Capture the latest committed pixels before import changes the renderer,
        // even if an earlier checkpoint is still uploading or deletion froze it.
        if (job.pending !== null && job.pending.complete) job.pending = capture(job.pending);
        enqueue(id, job);
        void (job.running ?? Promise.resolve()).then(() => {
          if (current !== id && job.pending === null && jobs.get(id) === job) jobs.delete(id);
        });
      }
    }
    current = null; importing = true;
    publish();
  }
  function waitingForPreparation(): boolean {
    const pending = current === null ? null : jobs.get(current)?.pending;
    return !absent && pending != null && !pending.complete;
  }
  /** Save before detaching the scene's renderer. New edits made during a save
   * can require another repair, so report that instead of abandoning them. */
  async function flushCurrent(): Promise<{ readonly kind: 'saved' | 'preparing' }> {
    const id = current;
    if (id === null || absent) return { kind: 'saved' };
    const job = jobs.get(id);
    if (job === undefined) return { kind: 'saved' };
    for (;;) {
      if (current !== id || job.deleted) throw new Error('The current project changed before its work could be saved.');
      if (absent) return { kind: 'saved' };
      if (job.pending !== null && !job.pending.complete) return { kind: 'preparing' };
      enqueue(id, job);
      const running = job.running;
      await running;
      // Completing the original upload may immediately start its checkpoint.
      if (job.running !== null && job.running !== running) continue;
      if (states.get(id) === 'failed') throw new Error('Your changes could not be saved, so this project is still open.');
      if (job.pending !== null) {
        if (!job.pending.complete) return { kind: 'preparing' };
        continue;
      }
      return { kind: 'saved' };
    }
  }
  function clearDeletionTimer(deletion: PendingDeletion): void {
    if (deletion.timer !== null) clearTimeout(deletion.timer);
    deletion.timer = null;
  }
  function release(id: SceneId): void {
    ++refreshEpoch;
    listed = listed.filter((project) => project.id !== id);
    locals.delete(id); states.delete(id); acknowledged.delete(id); thumbnails.delete(id); jobs.delete(id);
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
      await job.running;
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
      jobs.clear(); locals.clear(); states.clear(); acknowledged.clear(); thumbnails.clear(); listed = [];
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
    snapshot, refresh, preflight, preflightObserve, begin, observe, suspend, waitingForPreparation, flushCurrent, remove, requestRemove, undoRemove, cancelPendingRemovals,
    checkpointState(document: SceneDocument | null): { readonly state: SaveState | 'absent'; readonly acknowledged: MathCheckpoint | null } {
      return { state: absent || document === null ? 'absent' : states.get(document.id) ?? 'absent',
        acknowledged: document === null ? null : acknowledged.get(document.id) ?? null };
    },
    dismissDeletion(id: SceneId): void {
      const deletion = deletions.get(id);
      if (deletion?.phase === 'deleted' || deletion?.phase === 'restored') { deletions.delete(id); publish(); }
    },
    diagnostics: () => ({ retainedJobs: jobs.size, pendingSaves: [...jobs.values()].filter((job) => job.pending !== null).length }),
    queuedUsage: (): ProjectSaveUsage => usage(),
    queuedBytes: (): number => usage().bytes,
    retention: (): readonly ProjectRetention[] => [...jobs].flatMap(([id, job]) => {
      const retained: ProjectRetention[] = [];
      if (job.active !== null) retained.push({ id, kind: 'active', revision: job.active.revision,
        assets: [...job.active.assets.keys()], bytes: job.active.bytes, complete: job.active.complete });
      if (job.pending !== null) retained.push({ id, kind: 'pending', revision: job.pending.revision,
        assets: [...job.pending.assets.keys()], bytes: job.pending.bytes, complete: job.pending.complete });
      return retained;
    }),
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
          const loaded = await loadReadyProject(id, signal);
          assertOpen();
          return loaded;
        }
        // Undo followed immediately by Open must include the pending debounce.
        enqueue(id, job);
        await job.running;
        signal.throwIfAborted();
        assertOpen();
        if (states.get(id) === 'failed') throw new Error('The latest project changes could not be saved. Try again.');
        if (job.pending !== null && !job.pending.complete) throw new Error('The latest project assets are still being prepared. Try again.');
        if (job.pending !== null) continue;
        const revision = job.revision;
        const loaded = await loadReadyProject(id, signal);
        assertOpen();
        if (job.pending === null && job.revision === revision) return loaded;
      }
    },
    openFailed(): void { importing = false; panelError = 'open'; publish(); },
  };
}

async function loadReadyProject(id: SceneId, signal: AbortSignal) {
  const loaded = await store.loadCompositionProject(id, signal);
  if (loaded.kind === 'composition') {
    const ready = renderingPrerequisites(loaded.document, loaded.assets);
    if (ready.kind === 'preparing') throw new Error(`This saved composition is incomplete: ${ready.reason}`);
  }
  return loaded;
}

function referenced(document: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>): ReadonlyMap<AssetId, Uint8Array> {
  const captured = new Map<AssetId, Uint8Array>();
  for (const asset of compositionInventory(document).keys()) {
    const bytes = assets.get(asset);
    if (bytes !== undefined) captured.set(asset, bytes);
  }
  return captured;
}
function lengths(assets: ReadonlyMap<AssetId, Uint8Array>): ReadonlyMap<AssetId, number> {
  return new Map([...assets].map(([asset, bytes]) => [asset, bytes.byteLength]));
}
function prepareSnapshot(document: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>) {
  // Definitions and recoverable drafts are checkpoint metadata, admitted with
  // the last-valid executable closure before a snapshot can become complete.
  if (document.version === 6) {
    const closure = remixDocumentSchema.safeParse(serializeRemixDocument(document));
    if (!closure.success) throw new Error(`The project recipe checkpoint is incomplete: ${closure.error.issues[0]?.message ?? 'invalid definition closure'}`);
  }
  const inventory = compositionInventory(document), availableLengths = new Map<AssetId, number>();
  let bytes = 0, additional = 0;
  for (const [asset, refs] of inventory) {
    const input = assets.get(asset);
    if (input === undefined) continue;
    if (input.byteLength === 0 || input.byteLength > compositionAssetLimit(refs)) throw new Error('The project asset is too large or empty.');
    bytes += input.byteLength;
    if (refs.some((ref) => ref.kind !== 'original')) additional += input.byteLength;
    availableLengths.set(asset, input.byteLength);
  }
  if (additional > COMPOSITION_LIMITS.activeAssetBytes) throw new Error('The composition exceeds its 64 MiB asset budget.');
  const referencedComplete = availableLengths.size === inventory.size;
  if (referencedComplete) {
    const measured = measureCompositionAssets(inventory, availableLengths);
    if (!measured.ok) throw new Error(measured.error.detail);
    bytes = measured.value.bytes;
  }
  const complete = referencedComplete && renderingPrerequisites(document, assets).kind === 'ready';
  return { inventory, lengths: availableLengths, bytes, complete };
}
function committedSnapshot(document: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>, revision: number,
  prepared: ReturnType<typeof prepareSnapshot>, reusable: ReadonlyMap<AssetId, Blob>): Snapshot {
  const captured = new Map<AssetId, Blob>();
  for (const [asset, refs] of prepared.inventory) {
    const input = assets.get(asset);
    if (input === undefined) continue;
    const original = refs.find((ref) => ref.kind === 'original');
    captured.set(asset, reusable.get(asset) ?? store.captureEncodedAsset(input, original?.mediaType ?? 'application/octet-stream'));
  }
  return { document, assets: captured, revision, bytes: prepared.bytes, complete: prepared.complete, preview: null };
}
