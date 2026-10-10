// The store's IndexedDB binding: the database's name, schema version, and
// object stores, the opener the connection takes, and a request's and a
// transaction's completion as promises. It reads IndexedDB only through the
// factory it is given.

import { err, ok, type Result } from '../core/result.ts';
import { describeError, type HandleListeners, type OpenedHandle, type OpenFailure, type StoreOpener } from './connection.ts';

export const DB_NAME = 'noisy';
/** The schema version. It changes only when an object store or an index changes, never for a change to the scene document. */
export const DB_VERSION = 1;

/** The object stores of schema version 1. */
export const STORE_NAMES = { scenes: 'scenes', assets: 'assets', caches: 'caches', device: 'device' } as const;
/** The `scenes` index on `updatedAt`. */
export const SCENES_BY_UPDATED_AT = 'updatedAt';

/**
 * Creates schema version 1 on an empty database: `scenes` keyed by `id` with
 * the `updatedAt` index, `assets` keyed by `[sceneId, assetId]`, and `caches`
 * and `device`, whose keys are given with each value (their writers, not
 * built yet, are to use `[sceneId, key]` and `'state'`).
 */
export function createSchema(db: IDBDatabase): void {
  const scenes = db.createObjectStore(STORE_NAMES.scenes, { keyPath: 'id' });
  scenes.createIndex(SCENES_BY_UPDATED_AT, 'updatedAt');
  db.createObjectStore(STORE_NAMES.assets, { keyPath: ['sceneId', 'assetId'] });
  db.createObjectStore(STORE_NAMES.caches);
  db.createObjectStore(STORE_NAMES.device);
}

type Factory = Pick<IDBFactory, 'open'>;

/** Opens the database `name` at whatever version it has, reads that version, and closes it. */
function readVersion(factory: Factory, name: string): Promise<Result<number, string>> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name);
    } catch (e) {
      resolve(err(describeError(e)));
      return;
    }
    request.onsuccess = () => {
      const db = request.result;
      const version = db.version;
      db.close();
      resolve(ok(version));
    };
    request.onerror = () => resolve(err(describeError(request.error)));
  });
}

/**
 * The opener over an IndexedDB factory: opens the database `name`, `DB_NAME`
 * for the app, at `DB_VERSION`, creating the schema when the database is new,
 * and wires the handle's `close` and `versionchange` events to the listeners.
 * A `VersionError` answers `newer-version` with the version the database has;
 * any other failure answers `failed` naming it.
 */
export function idbOpener(factory: Factory, name: string): StoreOpener<IDBDatabase> {
  return (listeners: HandleListeners) =>
    new Promise<Result<OpenedHandle<IDBDatabase>, OpenFailure>>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, DB_VERSION);
      } catch (e) {
        resolve(err({ kind: 'failed', cause: describeError(e) }));
        return;
      }
      request.onupgradeneeded = (event) => {
        // Version 1 is the first: the only upgrade is from an empty database.
        // A throw here aborts the upgrade, and the open fails with AbortError.
        if (event.oldVersion < 1) createSchema(request.result);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => listeners.onClose();
        db.onversionchange = () => listeners.onVersionChange();
        resolve(ok({ db, close: () => db.close() }));
      };
      request.onerror = () => {
        const error = request.error;
        if (error?.name !== 'VersionError') {
          resolve(err({ kind: 'failed', cause: describeError(error) }));
          return;
        }
        void readVersion(factory, name).then((version) =>
          resolve(version.ok ? err({ kind: 'newer-version', version: version.value }) : err({ kind: 'failed', cause: `VersionError, then reading the version: ${version.error}` })),
        );
      };
    });
}

/**
 * Resolves with `request`'s result when it succeeds. When it fails, waits for
 * its transaction to end and rejects with the transaction's error if the
 * transaction aborted with one, and with the request's own error otherwise.
 * When the browser closes the handle, Chrome fails each pending request with
 * an `AbortError` before it aborts the transaction with an `UnknownError` and
 * fires `close`; waiting for the transaction is what lets `run` see the
 * `UnknownError` and retry, where the request's `AbortError` alone would be
 * answered as the operation's own `io`.
 */
export function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const own = request.error;
      const tx = request.transaction;
      if (tx === null) {
        reject(own);
        return;
      }
      tx.addEventListener('abort', () => reject(tx.error ?? own), { once: true });
      tx.addEventListener('complete', () => reject(own), { once: true });
    };
  });
}

/**
 * Resolves when `tx` commits. Rejects with the transaction's error when it
 * aborts, or with an `AbortError` when it was aborted without one.
 */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
  });
}
