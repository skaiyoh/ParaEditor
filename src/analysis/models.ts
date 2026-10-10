// The model loader: gets every file an analysis operation needs into Cache
// Storage, verified against the lock, from the app's own origin.
//
// Verified files live in the cache `noisy-models-<lock hash>`, each under its
// served URL. A download streams into `noisy-models-<lock hash>-partial` as
// segments, entries keyed `<served URL>?noisy-partial=<start>-<end>`, so a
// retry in the same page resumes with `Range: bytes=<kept>-`. After the last
// byte the segments are read back, the whole file is hashed, and the segments
// are deleted; only a file whose SHA-256 is the lock's is then put in the
// verified cache. docs/ARCHITECTURE.md ("The model loader") states the rules.
//
// Every browser object arrives as a narrow parameter, so node tests drive the
// loader with a real HTTP server and an in-memory Cache Storage.

import type { ModelId } from '../core/ids.ts';
import { err, ok, type Result } from '../core/result.ts';
import type { Clock } from '../platform/clock.ts';
import { hex, lockHash, MODEL_CACHE_PREFIX, modelCacheNames, modelFileUrl, type LockedFile, type ModelOp, type ParsedLock } from './lock.ts';
import type { AnalysisError } from './protocol.ts';

/** How long a download may go without a byte, waiting for the file's lock and for its answer included, before it fails as `stalled`. */
export const FETCH_STALL_MS = 30_000;
/** A download stores what it has read as a segment each time this many bytes are held, and when it fails as `offline`, `stalled`, or `cancelled`. */
export const SEGMENT_BYTES = 4 * 1024 * 1024;
const SEGMENT_PARAM = 'noisy-partial';

/** The part of a Cache the loader uses; the browser's Cache is one. URLs are absolute. */
export interface ModelCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
}

/** The part of CacheStorage the loader uses; the browser's `caches` is one. */
export interface ModelCaches {
  open(name: string): Promise<ModelCache>;
  keys(): Promise<readonly string[]>;
  delete(name: string): Promise<boolean>;
}

/** Exclusive named locks shared by every tab of the origin, so two tabs never write one file's segments at once. */
export interface FileLocks {
  /** Runs `body` holding `name`, waiting for it; rejects with `signal.reason` if `signal` fires while waiting. */
  hold<T>(name: string, signal: AbortSignal, body: () => Promise<T>): Promise<T>;
  /** Runs `body` holding `name` when nobody does; otherwise runs it at once, without the lock, given false. */
  tryHold<T>(name: string, body: (held: boolean) => Promise<T>): Promise<T>;
}

/** FileLocks over the Web Locks API (`navigator.locks`). */
export function webLocks(locks: Pick<LockManager, 'request'>): FileLocks {
  return {
    hold: (name, signal, body) => locks.request(name, { signal }, () => body()),
    tryHold: (name, body) => locks.request(name, { ifAvailable: true }, (lock) => body(lock !== null)),
  };
}

export type ModelLoaderDeps = {
  readonly lock: ParsedLock;
  /** The app's origin; every file is fetched from `<origin><served>` and from nowhere else. */
  readonly origin: string;
  readonly caches: ModelCaches;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly subtle: Pick<SubtleCrypto, 'digest'>;
  readonly locks: FileLocks;
  readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  /** Default FETCH_STALL_MS. */
  readonly stallMs?: number;
};

export type ModelLoader = {
  readonly lockHash: string;
  /** `noisy-models-<lock hash>`: the verified files, each under its served URL. */
  readonly cacheName: string;
  /** `noisy-models-<lock hash>-partial`: the segments of downloads not yet verified. */
  readonly partialCacheName: string;
  /**
   * Gets every file `ops` need into the verified cache, one file at a time in
   * the order of `ops` and of the lock, and reports each model's fraction of
   * the bytes those ops need of it as they arrive. Resolves at the first
   * failure; never rejects for one. A second fetch of a file, in this page or
   * another tab, waits for the first and fails as `stalled` if that wait
   * outlasts the stall timeout, so a caller fetches each file once at a time.
   */
  fetchModels(ops: readonly ModelOp[], signal: AbortSignal, onProgress: (model: ModelId, fraction: number) => void): Promise<Result<void, AnalysisError>>;
};

/** A Cache Storage call failed; the loader reports it as `quota`. */
class StorageRefused extends Error {}

async function storage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new StorageRefused('Cache Storage refused an operation', { cause });
  }
}

type Segment = { readonly key: string; readonly start: number; readonly end: number };

const segmentKey = (url: string, start: number, end: number): string => `${url}?${SEGMENT_PARAM}=${start}-${end}`;

/** The file URL and byte range a partial cache entry holds, or null for an entry that is not a segment. */
function segmentOf(key: string): { readonly url: string; readonly start: number; readonly end: number } | null {
  const parsed = new URL(key);
  const range = /^(\d+)-(\d+)$/.exec(parsed.searchParams.get(SEGMENT_PARAM) ?? '');
  // Counted through keys(), since URLSearchParams.size is newer than the rest of the API.
  if (range === null || [...parsed.searchParams.keys()].length !== 1) return null;
  const [, start = '', end = ''] = range;
  return { url: `${parsed.origin}${parsed.pathname}`, start: Number(start), end: Number(end) };
}

/**
 * The segments of `url` that form a run from byte 0 within the file's
 * `bytes`, and its length; every other segment of `url` is deleted.
 */
async function keptSegments(partial: ModelCache, url: string, bytes: number): Promise<{ readonly segments: readonly Segment[]; readonly length: number }> {
  const found = (await storage(() => partial.keys()))
    .flatMap((request): Segment[] => {
      const segment = segmentOf(request.url);
      return segment !== null && segment.url === url ? [{ key: request.url, start: segment.start, end: segment.end }] : [];
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: Segment[] = [];
  let length = 0;
  for (const segment of found) {
    if (segment.start === length && segment.end > segment.start && segment.end <= bytes) {
      segments.push(segment);
      length = segment.end;
    } else {
      await storage(() => partial.delete(segment.key));
    }
  }
  return { segments, length };
}

async function clearSegments(partial: ModelCache, url: string): Promise<void> {
  for (const request of await storage(() => partial.keys())) {
    if (segmentOf(request.url)?.url === url) await storage(() => partial.delete(request.url));
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** `<start>` and `<size>` of a `Content-Range: bytes <start>-<end>/<size>` header, or null. */
function contentRange(response: Response): { readonly start: number; readonly size: number } | null {
  const match = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (match === null) return null;
  const [, start = '', size = ''] = match;
  return { start: Number(start), size: Number(size) };
}

type Job = { readonly model: ModelId; readonly file: LockedFile; readonly url: string; readonly lockName: string };

type Run = {
  readonly deps: ModelLoaderDeps;
  readonly verified: ModelCache;
  readonly partial: ModelCache;
  readonly stallMs: number;
  readonly signal: AbortSignal;
};

/**
 * Streams the file from byte `from` into segments, resuming with a Range
 * request when `from` is above 0. Resolves ok once segments hold every byte.
 * When the transfer fails as `offline`, `stalled`, or `cancelled` it first
 * stores what it read, so a retry resumes from there. However it ends, the
 * request is aborted, so no connection is left open with its body unread.
 */
async function download(run: Run, job: Job, from: number, progress: (have: number) => void): Promise<Result<void, AnalysisError>> {
  const { deps, partial, signal, stallMs } = run;
  const { model, file, url } = job;
  const controller = new AbortController();
  let stopped: 'stalled' | 'cancelled' | null = null;
  const stop = (why: 'stalled' | 'cancelled'): void => {
    stopped ??= why;
    controller.abort();
  };
  const onAbort = (): void => stop('cancelled');
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: number | null = null;
  const disarm = (): void => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    disarm();
    timer = deps.clock.setTimeout(() => stop('stalled'), stallMs);
  };
  /** Why the transfer ended early: the caller's cancel, the stall timer, or else the network. */
  const lost = (): AnalysisError => (stopped === 'cancelled' ? { kind: 'cancelled' } : { kind: 'download', model, status: stopped ?? 'offline' });

  let stored = from;
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const body = concat(pending, pendingBytes);
    await storage(() => partial.put(segmentKey(url, stored, stored + pendingBytes), new Response(body)));
    stored += pendingBytes;
    pending.length = 0;
    pendingBytes = 0;
  };
  /** Stores what has arrived and returns `error`; a refused store leaves the earlier segments and still returns `error`, the cause the owner can act on. */
  const keepAndFail = async (error: AnalysisError): Promise<Result<void, AnalysisError>> => {
    disarm();
    try {
      await flush();
    } catch (e) {
      if (!(e instanceof StorageRefused)) throw e;
    }
    return err(error);
  };

  try {
    if (signal.aborted) return err({ kind: 'cancelled' });
    arm();
    let response: Response;
    try {
      response = await deps.fetch(url, {
        headers: from > 0 ? { range: `bytes=${from}-` } : {},
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
      });
    } catch {
      disarm();
      return err(lost());
    }
    if (from > 0 && response.status === 200) {
      // The server ignored the range and sent the whole file: start over from its first byte.
      await clearSegments(partial, url);
      stored = 0;
      progress(0);
    } else if (from > 0 && response.status === 206) {
      const range = contentRange(response);
      if (range === null || range.start !== from || range.size !== file.bytes) {
        controller.abort();
        disarm();
        await clearSegments(partial, url);
        return err({ kind: 'integrity', model });
      }
    } else if (from > 0 || response.status !== 200) {
      controller.abort();
      disarm();
      if (response.status === 416) await clearSegments(partial, url);
      return err({ kind: 'download', model, status: response.status });
    }
    if (response.body === null) return await keepAndFail({ kind: 'download', model, status: 'offline' });
    const reader = response.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return await keepAndFail(lost());
      }
      if (chunk.done) break;
      const bytes = chunk.value;
      if (bytes.byteLength === 0) continue;
      arm();
      if (stored + pendingBytes + bytes.byteLength > file.bytes) {
        // Longer than the lock's file: these are not its bytes.
        controller.abort();
        disarm();
        await clearSegments(partial, url);
        return err({ kind: 'integrity', model });
      }
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      progress(stored + pendingBytes);
      if (pendingBytes >= SEGMENT_BYTES) {
        disarm();
        await flush();
        arm();
      }
    }
    disarm();
    await flush();
    // A body that ended cleanly but short of the file failed on the way like any other transfer.
    return stored < file.bytes ? err({ kind: 'download', model, status: 'offline' }) : ok(undefined);
  } finally {
    disarm();
    signal.removeEventListener('abort', onAbort);
    // A no-op once the body has been read to its end; otherwise, as when a
    // Cache Storage call throws midway, it releases the connection.
    controller.abort();
  }
}

/**
 * Hashes the file the segments hold and deletes the segments; then, when the
 * file is the lock's, puts it in the verified cache from memory, so Cache
 * Storage never holds the file twice.
 */
async function promote(run: Run, job: Job): Promise<Result<void, AnalysisError>> {
  const { partial, verified, deps } = run;
  const { model, file, url } = job;
  const { segments, length } = await keptSegments(partial, url, file.bytes);
  const whole = new Uint8Array(file.bytes);
  let intact = length === file.bytes;
  for (const segment of intact ? segments : []) {
    const response = await storage(() => partial.match(segment.key));
    const bytes = response === undefined ? null : new Uint8Array(await storage(() => response.arrayBuffer()));
    if (bytes === null || bytes.byteLength !== segment.end - segment.start) {
      intact = false;
      break;
    }
    whole.set(bytes, segment.start);
  }
  const matches = intact && hex(await deps.subtle.digest('SHA-256', whole)) === file.sha256;
  await clearSegments(partial, url);
  if (!matches) return err({ kind: 'integrity', model });
  await storage(() => verified.put(url, new Response(whole, { headers: { 'content-type': 'application/octet-stream' } })));
  return ok(undefined);
}

/**
 * Makes one file verified, holding its lock so no other fetch, in this page
 * or another tab, writes its segments meanwhile. Waiting for the lock counts
 * toward the stall timeout: a holder that keeps it past the timeout, such as
 * a tab the browser froze mid-download, fails this fetch as `stalled`.
 */
async function ensureFile(run: Run, job: Job, progress: (have: number) => void): Promise<Result<void, AnalysisError>> {
  const { deps, signal } = run;
  const waiting = new AbortController();
  let gaveUp: 'stalled' | 'cancelled' | null = null;
  const giveUp = (why: 'stalled' | 'cancelled'): void => {
    gaveUp ??= why;
    waiting.abort();
  };
  const onAbort = (): void => giveUp('cancelled');
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = deps.clock.setTimeout(() => giveUp('stalled'), run.stallMs);
  let granted = false;
  const stopWaiting = (): void => {
    deps.clock.clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  };
  try {
    return await deps.locks.hold(job.lockName, waiting.signal, async () => {
      granted = true;
      stopWaiting();
      if ((await storage(() => run.verified.match(job.url))) !== undefined) {
        progress(job.file.bytes);
        return ok(undefined);
      }
      const { length } = await keptSegments(run.partial, job.url, job.file.bytes);
      progress(length);
      if (length < job.file.bytes) {
        const downloaded = await download(run, job, length, progress);
        if (!downloaded.ok) return downloaded;
      }
      return promote(run, job);
    });
  } catch (e) {
    // Gave up while waiting: the lock manager rejects the request, with the abort's reason or its own error.
    if (!granted && gaveUp === 'stalled') return err({ kind: 'download', model: job.model, status: 'stalled' });
    if (!granted && gaveUp === 'cancelled') return err({ kind: 'cancelled' });
    throw e;
  } finally {
    stopWaiting();
  }
}

/**
 * Opens the loader for `deps.lock`: computes the lock hash, deletes every
 * model cache of another lock, and in the current lock's partial cache keeps
 * only the segments of a file another tab is downloading now and, for a file
 * no tab is downloading and not yet verified, its segments that run from byte
 * 0, so the next fetch resumes what a closed or reloaded page left.
 */
export async function openModelLoader(deps: ModelLoaderDeps): Promise<Result<ModelLoader, AnalysisError>> {
  const hash = await lockHash(deps.lock.lock, deps.subtle);
  const names = modelCacheNames(hash);
  const urlOf = (file: LockedFile): string => modelFileUrl(file, deps.origin);
  const lockNameOf = (file: LockedFile): string => `${names.verified}:${file.served}`;
  const files = Object.values(deps.lock.lock.models).flatMap((model) => model.files);
  try {
    for (const name of await storage(() => deps.caches.keys())) {
      if (name.startsWith(MODEL_CACHE_PREFIX) && name !== names.verified && name !== names.partial) await storage(() => deps.caches.delete(name));
    }
    const verified = await storage(() => deps.caches.open(names.verified));
    const partial = await storage(() => deps.caches.open(names.partial));
    const lockUrls = new Set(files.map(urlOf));
    for (const request of await storage(() => partial.keys())) {
      const segment = segmentOf(request.url);
      if (segment === null || !lockUrls.has(segment.url)) await storage(() => partial.delete(request.url));
    }
    for (const file of files) {
      await deps.locks.tryHold(lockNameOf(file), async (held) => {
        // Held means no download in any tab owns the file's segments: a closed
        // or reloaded page left them. A verified file's are spent; an unverified
        // file keeps its run from byte 0 for the next fetch to resume, which the
        // SHA-256 check at the end still guards, and loses every other segment.
        if (!held) return;
        const url = urlOf(file);
        if ((await storage(() => verified.match(url))) !== undefined) await clearSegments(partial, url);
        else await keptSegments(partial, url, file.bytes);
      });
    }
  } catch (e) {
    if (e instanceof StorageRefused) return err({ kind: 'quota' });
    throw e;
  }

  const stallMs = deps.stallMs ?? FETCH_STALL_MS;
  return ok({
    lockHash: hash,
    cacheName: names.verified,
    partialCacheName: names.partial,
    async fetchModels(ops, signal, onProgress) {
      const jobs: Job[] = [];
      const totals = new Map<ModelId, number>();
      for (const op of ops) {
        const { model, files: opFiles } = deps.lock.ops[op];
        for (const file of opFiles) {
          const url = urlOf(file);
          if (jobs.some((j) => j.url === url)) continue;
          jobs.push({ model, file, url, lockName: lockNameOf(file) });
          totals.set(model, (totals.get(model) ?? 0) + file.bytes);
        }
      }
      const done = new Map<ModelId, number>();
      try {
        if (signal.aborted) return err({ kind: 'cancelled' });
        // Opened by name on every fetch: a page of another lock may have deleted
        // the caches since this one opened, and a deleted Cache object writes
        // into nothing that a later open by name finds.
        const run: Run = {
          deps,
          verified: await storage(() => deps.caches.open(names.verified)),
          partial: await storage(() => deps.caches.open(names.partial)),
          stallMs,
          signal,
        };
        for (const job of jobs) {
          if (signal.aborted) return err({ kind: 'cancelled' });
          const before = done.get(job.model) ?? 0;
          const total = totals.get(job.model) ?? job.file.bytes;
          const result = await ensureFile(run, job, (have) => onProgress(job.model, (before + have) / total));
          if (!result.ok) return result;
          done.set(job.model, before + job.file.bytes);
        }
        return ok(undefined);
      } catch (e) {
        if (e instanceof StorageRefused) return err({ kind: 'quota' });
        throw e;
      }
    },
  });
}

/**
 * Deletes every model cache, of any lock, and returns the names it deleted;
 * the phone checklist's "Clear model cache" calls it. A download running in
 * another page meanwhile writes into caches that are gone: its fetch can
 * return ok with the file in no cache a later open finds, and its next fetch
 * there downloads the file again.
 */
export async function clearModelCaches(caches: ModelCaches): Promise<Result<readonly string[], AnalysisError>> {
  try {
    const deleted: string[] = [];
    for (const name of await storage(() => caches.keys())) {
      if (name.startsWith(MODEL_CACHE_PREFIX) && (await storage(() => caches.delete(name)))) deleted.push(name);
    }
    return ok(deleted);
  } catch (e) {
    if (e instanceof StorageRefused) return err({ kind: 'quota' });
    throw e;
  }
}
