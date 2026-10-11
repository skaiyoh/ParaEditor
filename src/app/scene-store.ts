import { z } from '../core/zod.ts';
import { landscapeSchema } from './showcase/landscape.ts';
import { MAX_SCENE_PACKAGE_BYTES, parseScenePackage, type ImportedScenePackage } from './scene-package.ts';

export type ImportedSceneSummary = Readonly<{ id: string; title: string; createdAt: string; bytes: number; poster: Blob }>;
const summarySchema = z.object({ id: z.string(), title: z.string(), createdAt: z.string(), bytes: z.number(), poster: z.instanceof(Blob) });
const geometrySchema = z.object({ field: landscapeSchema, mesh: z.instanceof(ArrayBuffer) });
const SUMMARIES = 'summaries', GEOMETRY = 'geometry';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('noisy-scenes', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SUMMARIES, { keyPath: 'id' });
      request.result.createObjectStore(GEOMETRY, { keyPath: 'id' });
    };
    request.onblocked = () => { blocked = true; reject(new Error('Close other Noisy tabs and try again.')); };
    request.onerror = () => reject(request.error ?? new Error('Scene storage could not open.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close(); else resolve(db);
    };
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Scene storage could not read the scene.'));
  });
}

async function withTransaction<T>(mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction([SUMMARIES, GEOMETRY], mode);
    const complete = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Scene storage could not finish the change.'));
      transaction.onerror = () => { /* An unhandled request error aborts this transaction. */ };
    });
    const result = Promise.resolve().then(() => operation(transaction)).catch(error => {
      try { transaction.abort(); } catch { /* The transaction already ended. */ }
      throw error;
    });
    const [value] = await Promise.all([result, complete]);
    return value;
  } finally { db.close(); }
}

export async function importSceneFile(file: Blob): Promise<{ ok: true; value: ImportedSceneSummary } | { ok: false; reason: string }> {
  if (file.size > MAX_SCENE_PACKAGE_BYTES) return { ok: false, reason: 'The scene package is larger than 96 MiB.' };
  let parsed: Awaited<ReturnType<typeof parseScenePackage>>;
  try { parsed = await parseScenePackage(await file.arrayBuffer()); }
  catch { return { ok: false, reason: 'The scene file could not be read. Choose the file again.' }; }
  if (!parsed.ok) return parsed;
  const pkg = parsed.value;
  try {
    const summary: ImportedSceneSummary = { id: crypto.randomUUID(), title: pkg.title,
      createdAt: new Date().toISOString(), bytes: file.size, poster: pkg.poster };
    await withTransaction('readwrite', async transaction => {
      transaction.objectStore(SUMMARIES).add(summary);
      transaction.objectStore(GEOMETRY).add({ id: summary.id, field: pkg.field, mesh: pkg.mesh });
    });
    return { ok: true, value: summary };
  } catch (error) {
    const reason = error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'There is not enough space on this device. Delete an imported scene and try again.'
      : 'The scene could not be saved on this device. Check browser storage permissions and try again.';
    return { ok: false, reason };
  }
}

export async function listImportedScenes(): Promise<readonly ImportedSceneSummary[]> {
  return withTransaction('readonly', async transaction => {
    const value = await requestValue(transaction.objectStore(SUMMARIES).getAll());
    return z.array(summarySchema).parse(value).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  });
}

export async function loadImportedScene(id: string): Promise<ImportedScenePackage | null> {
  return withTransaction('readonly', async transaction => {
    const [summaryValue, geometryValue] = await Promise.all([
      requestValue(transaction.objectStore(SUMMARIES).get(id)), requestValue(transaction.objectStore(GEOMETRY).get(id)),
    ]);
    if (summaryValue === undefined || geometryValue === undefined) return null;
    const summary = summarySchema.parse(summaryValue), geometry = geometrySchema.parse(geometryValue);
    return { title: summary.title, poster: summary.poster, field: geometry.field, mesh: geometry.mesh };
  });
}

export async function deleteImportedScene(id: string): Promise<void> {
  await withTransaction('readwrite', async transaction => {
    transaction.objectStore(SUMMARIES).delete(id);
    transaction.objectStore(GEOMETRY).delete(id);
  });
}
