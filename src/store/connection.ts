// The store's one database connection. It holds at most one handle, opened on
// the first operation, and runs every store operation through `run`, which
// hands the operation the current handle. An error that means the connection
// is gone drops the handle and runs the operation once more on a fresh one; a
// second such error in that operation answers `unavailable`, and the next
// operation starts again from scratch. Everything it reads of the browser
// comes in through `StoreConnectionDeps`, so node tests drive it with a
// scripted handle; idb.ts binds it to IndexedDB.

import type { BuildId } from '../core/ids.ts';
import { err, type Result } from '../core/result.ts';
import type { DiagnosticSink } from '../platform/diagnostics.ts';

export type StoreError =
  | { readonly kind: 'quota' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'damaged'; readonly detail: string }
  /** A record, or for the database itself its schema version, that this build cannot read; `writer` is null for the database. */
  | { readonly kind: 'newer-version'; readonly version: number; readonly writer: BuildId | null }
  /** The connection was lost twice in one operation. */
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'io'; readonly detail: string };

/** Logged each time the connection opens a fresh handle because the last one was lost; `cause` says how it was lost. */
export type StoreEvent = { readonly event: 'store.reconnect'; readonly cause: string };

/** A handle the opener produced, and the means to close it. */
export type OpenedHandle<D> = { readonly db: D; readonly close: () => void };

/** What the opener calls when the browser acts on a handle it produced. */
export type HandleListeners = {
  /** The browser closed the handle (IndexedDB's `close` event). */
  readonly onClose: () => void;
  /** Another connection asked to upgrade or delete the database (IndexedDB's `versionchange` event). */
  readonly onVersionChange: () => void;
};

export type OpenFailure =
  /** The database is at a higher schema version than this build opens (IndexedDB's `VersionError`). */
  | { readonly kind: 'newer-version'; readonly version: number }
  /** Any other failure to open; `cause` names it. */
  | { readonly kind: 'failed'; readonly cause: string };

/** Opens one fresh handle on the database, at the schema version this build knows. Never rejects. */
export type StoreOpener<D> = (listeners: HandleListeners) => Promise<Result<OpenedHandle<D>, OpenFailure>>;

export type StoreConnectionDeps<D> = {
  readonly open: StoreOpener<D>;
  readonly diag: DiagnosticSink<StoreEvent>;
  /** Called once for each handle another connection's `versionchange` closed; the store page, today its only caller outside the tests, reloads the page in it. */
  readonly onVersionChange: () => void;
};

/**
 * One store operation on a handle. It answers its own expected failures as an
 * `err`; anything it throws or rejects with is classified by `run`. It may run
 * twice, so it must be one transaction, or safe to repeat. On IndexedDB it
 * awaits its requests with idb.ts's `requestDone` and its transaction with
 * `transactionDone`, so that a handle the browser closes under it reaches
 * `run` as the transaction's error (Chrome's is `UnknownError`) rather than a
 * request's `AbortError`.
 */
export type StoreOperation<D, T> = (db: D) => Promise<Result<T, StoreError>>;

export interface StoreConnection<D> {
  /**
   * Runs `op` on the current handle, opening one when none is held. Never
   * rejects. A connection error (see `isConnectionError`, a handle the
   * browser closed, or a failed open) drops the handle and runs `op` once
   * more on a fresh one; a second answers `unavailable`. A database at a
   * higher version answers `newer-version`. Anything else `op` throws is its
   * own error: `QuotaExceededError` answers `quota`, any other `io`, and
   * neither is retried.
   */
  run<T>(op: StoreOperation<D, T>): Promise<Result<T, StoreError>>;
}

/** Error names that mean the handle is gone: the connection was closed under it, or the browser's storage process was lost. */
const CONNECTION_ERROR_NAMES: ReadonlySet<string> = new Set(['InvalidStateError', 'UnknownError']);

function errorName(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string' ? e.name : null;
}

/** True for an error whose name is `InvalidStateError` or `UnknownError`. */
export function isConnectionError(e: unknown): boolean {
  const name = errorName(e);
  return name !== null && CONNECTION_ERROR_NAMES.has(name);
}

/** `<name>: <message>` for an Error or a DOMException, and the value's text otherwise. */
export function describeError(e: unknown): string {
  const name = errorName(e);
  if (name === null) return String(e);
  const message = typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : '';
  return message === '' ? name : `${name}: ${message}`;
}

/** An operation's own error as a StoreError. */
function ownError(e: unknown): StoreError {
  return errorName(e) === 'QuotaExceededError' ? { kind: 'quota' } : { kind: 'io', detail: describeError(e) };
}

/** What the connection knows of one handle, from the open that produces it until it is dropped. */
type SlotState<D> = {
  /** The handle is no longer the connection's: lost, closed for a versionchange, or never opened at a newer version. */
  dropped: boolean;
  /** The browser fired `close` on the handle. */
  closedByBrowser: boolean;
  /** Set once the open resolves with a handle. */
  handle: OpenedHandle<D> | null;
};
/** One handle's life: its state, and the open that produces it. */
type Slot<D> = SlotState<D> & { readonly ready: Promise<Result<OpenedHandle<D>, OpenFailure>> };

type Attempt<T> = { readonly kind: 'done'; readonly result: Result<T, StoreError> } | { readonly kind: 'lost'; readonly cause: string };

export function createStoreConnection<D>(deps: StoreConnectionDeps<D>): StoreConnection<D> {
  let current: Slot<D> | null = null;
  /** Why the last handle was lost, until a fresh handle's open logs it. */
  let lostCause: string | null = null;

  const closeQuietly = (slot: SlotState<D>): void => {
    try {
      slot.handle?.close();
    } catch {
      // A handle that cannot be closed is already unusable; it is dropped either way.
    }
  };

  /** Drops a handle for a connection cause; the next open logs `store.reconnect` with it. Later calls for the same handle do nothing. */
  const lose = (slot: SlotState<D>, cause: string): void => {
    if (slot.dropped) return;
    slot.dropped = true;
    if (current === slot) current = null;
    lostCause = cause;
    closeQuietly(slot);
  };

  const openSlot = (): Slot<D> => {
    if (lostCause !== null) {
      deps.diag.log({ event: 'store.reconnect', cause: lostCause });
      lostCause = null;
    }
    // The listeners close over the state, which exists before the opener is called.
    const state: SlotState<D> = { dropped: false, closedByBrowser: false, handle: null };
    const listeners: HandleListeners = {
      onClose: () => {
        state.closedByBrowser = true;
        lose(state, 'close');
      },
      onVersionChange: () => {
        if (state.dropped) return;
        state.dropped = true;
        if (current === state) current = null;
        closeQuietly(state);
        deps.onVersionChange();
      },
    };
    // Called from an executor, so an opener that throws instead of answering fails the open.
    const ready = new Promise<Result<OpenedHandle<D>, OpenFailure>>((resolve) => resolve(deps.open(listeners))).then(
      (result) => {
        if (result.ok) state.handle = result.value;
        return result;
      },
      (e: unknown): Result<OpenedHandle<D>, OpenFailure> => err({ kind: 'failed', cause: describeError(e) }),
    );
    // The same object as `state`, so `current === state` holds for the slot.
    return Object.assign(state, { ready });
  };

  const attempt = async <T>(op: StoreOperation<D, T>): Promise<Attempt<T>> => {
    const slot = current ?? (current = openSlot());
    const opened = await slot.ready;
    if (!opened.ok) {
      const failure = opened.error;
      if (failure.kind === 'newer-version') {
        slot.dropped = true;
        if (current === slot) current = null;
        return { kind: 'done', result: err({ kind: 'newer-version', version: failure.version, writer: null }) };
      }
      const cause = `open: ${failure.cause}`;
      lose(slot, cause);
      return { kind: 'lost', cause };
    }
    // A handle dropped while its open was settling, or by an earlier event, is
    // still handed to the operation, which then fails as a connection error.
    try {
      return { kind: 'done', result: await op(opened.value.db) };
    } catch (e) {
      if (isConnectionError(e)) {
        const cause = describeError(e);
        lose(slot, cause);
        return { kind: 'lost', cause };
      }
      // The close event already dropped the handle and left the cause `close`
      // to be logged; this cause only names the attempt in an `unavailable`.
      if (slot.closedByBrowser) return { kind: 'lost', cause: `close: ${describeError(e)}` };
      return { kind: 'done', result: err(ownError(e)) };
    }
  };

  return {
    async run(op) {
      const first = await attempt(op);
      if (first.kind === 'done') return first.result;
      const second = await attempt(op);
      if (second.kind === 'done') return second.result;
      return err({ kind: 'unavailable', detail: `connection lost twice: ${first.cause}; then ${second.cause}` });
    },
  };
}
