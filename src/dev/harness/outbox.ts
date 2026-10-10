// The harness's write-ahead outbox. Every row is stored before it is posted,
// and leaves when the sink answers `{ "ok": true }` or refuses it with a 4xx
// (counted as refused), so a row survives a kill, a reload, and a sink or
// tailnet outage; posts go one at a time, oldest first. The outbox never
// stops the run: past its size cap, or when a write throws (a full origin
// quota), it drops its oldest rows and counts them, and nothing it does
// throws. A row may reach the sink twice (posted, then the
// page died before removing it, or two pages of one storage both posted it),
// which readers dedupe by `rowId`. Storage is the record: every change starts
// by reading the stored outbox again, so a page's change starts from what is
// stored, not from the copy it read when it was created.

import { KEEPALIVE_MAX_BYTES, OUTBOX_CAP_UNITS, PLAN_MAX_UNITS, POST_TIMEOUT_MS } from './lines.ts';
import { harnessKeys, type HarnessPage } from './catalog.ts';
import type { HarnessRow } from './rows.ts';

export type OutboxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * `recorded`: the sink answered `{ "ok": true }`. `refused`: it answered 4xx,
 * which a resend would get again. `failed`: anything else (a 5xx, another
 * status, a body without `ok: true`, a network error, the timeout); the row
 * stays and is sent again.
 */
export type PostResult = { readonly kind: 'recorded' } | { readonly kind: 'refused'; readonly status: number } | { readonly kind: 'failed'; readonly reason: string };

/** Sends one row's body to the sink; never rejects. */
export type Post = (body: string) => Promise<PostResult>;

export type PostDeps = {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The signal that ends a post with no answer after `ms`; AbortSignal.timeout by default. */
  readonly timeout?: (ms: number) => AbortSignal;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Posts to `/api/log` as JSON, with keepalive when the body is at most 60,000 bytes, and a 10 s timeout. */
export function createPost(deps: PostDeps): Post {
  // Called unbound: the browser's fetch throws when called as a method of anything but the window.
  const { fetch } = deps;
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  return async (body) => {
    try {
      const res = await fetch('/api/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BYTES,
        signal: timeout(POST_TIMEOUT_MS),
      });
      if (res.status >= 400 && res.status < 500) return { kind: 'refused', status: res.status };
      if (res.status < 200 || res.status >= 300) return { kind: 'failed', reason: `the sink answered ${res.status}` };
      const answer: unknown = await res.json();
      const recorded = typeof answer === 'object' && answer !== null && 'ok' in answer && answer.ok === true;
      return recorded ? { kind: 'recorded' } : { kind: 'failed', reason: 'the sink answered without ok: true' };
    } catch (e) {
      return { kind: 'failed', reason: errorText(e) };
    }
  };
}

export type FlushResult = { readonly kind: 'drained' } | { readonly kind: 'stopped'; readonly reason: string };

export interface Outbox {
  /** Stores `row` behind every row waiting; drops the oldest past the cap or while the write throws, counted. Never throws. */
  enqueue(row: HarnessRow): void;
  /** Posts the waiting rows one at a time until none waits or a post fails; a flush already running is joined. Never rejects. */
  flush(): Promise<FlushResult>;
  /** Drops the oldest rows, counted, until at least the plan's size budget is freed, so a plan or marker write that threw can fit. */
  makeRoom(): void;
  /** Rows waiting. */
  readonly pending: number;
  /** Rows dropped since the outbox was first stored: past the cap, on a write that threw, or to make room. */
  readonly dropped: number;
  /** Rows the sink refused with a 4xx, since the outbox was first stored. */
  readonly refused: number;
}

/** One waiting row and its serialized body, which is what is stored and posted. */
type Entry = { readonly body: string };

/** The stored value: `{"v":1,"dropped":D,"refused":R,"rows":[<body>,...]}`, its rows the bodies as they are posted. */
function serialize(dropped: number, refused: number, entries: readonly Entry[]): string {
  return `{"v":1,"dropped":${dropped},"refused":${refused},"rows":[${entries.map((e) => e.body).join(',')}]}`;
}

type State = { dropped: number; refused: number; entries: Entry[] };

/** The stored outbox, or null when nothing readable is stored. */
function read(storage: OutboxStorage, key: string): State | null {
  try {
    const text = storage.getItem(key);
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return null;
    const count = (key: string): number => {
      const n: unknown = key in value ? Reflect.get(value, key) : 0;
      return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
    };
    const rows: readonly unknown[] = value.rows;
    return { dropped: count('dropped'), refused: count('refused'), entries: rows.map((row) => ({ body: JSON.stringify(row) })) };
  } catch {
    return null;
  }
}

/** The outbox of `page`'s run, stored under its key. */
export function createOutbox(deps: { readonly page: HarnessPage; readonly storage: OutboxStorage; readonly post: Post }): Outbox {
  const { storage, post } = deps;
  const key = harnessKeys(deps.page).outbox;
  const state: State = read(storage, key) ?? { dropped: 0, refused: 0, entries: [] };
  let flushing: Promise<FlushResult> | null = null;
  /** The body of the row being posted, and whether this page dropped it, counted, while the post was in flight. */
  let inFlight: { readonly body: string; dropped: boolean } | null = null;

  /**
   * Takes up the stored outbox, which another page of the same storage may
   * have changed. With nothing readable stored, the page keeps its own
   * state: the key was removed to free space, and the counts it kept are
   * stored by the next write that fits.
   */
  const sync = (): void => {
    const stored = read(storage, key);
    if (stored === null) return;
    state.dropped = stored.dropped;
    state.refused = stored.refused;
    state.entries = stored.entries;
  };

  const size = (): number => serialize(state.dropped, state.refused, []).length + state.entries.reduce((n, e) => n + e.body.length, 0) + Math.max(0, state.entries.length - 1);

  const dropOldest = (): void => {
    const oldest = state.entries.shift();
    state.dropped += 1;
    if (oldest !== undefined && inFlight !== null && oldest.body === inFlight.body) inFlight.dropped = true;
  };

  /**
   * Stores the outbox, dropping the oldest rows while the write throws; with
   * no row left it stores the counts alone, or, when even they do not fit,
   * removes the key to free its space for the plan and marker writes.
   */
  const persist = (): void => {
    for (;;) {
      try {
        storage.setItem(key, serialize(state.dropped, state.refused, state.entries));
        return;
      } catch {
        if (state.entries.length === 0) break;
        dropOldest();
      }
    }
    // The counts stay in memory and are stored by the next write that fits; a page that loads before then finds no key and reads them as 0.
    try {
      storage.removeItem(key);
    } catch {
      // Nothing more can be done, and the outbox never throws.
    }
  };

  const run = async (): Promise<FlushResult> => {
    for (;;) {
      sync();
      const head = state.entries[0];
      if (head === undefined) return { kind: 'drained' };
      const posting = { body: head.body, dropped: false };
      inFlight = posting;
      let result: PostResult;
      try {
        result = await post(head.body);
      } catch (e) {
        result = { kind: 'failed', reason: errorText(e) };
      } finally {
        inFlight = null;
      }
      if (result.kind === 'failed') return { kind: 'stopped', reason: result.reason };
      sync();
      // The head may have been dropped, and counted, while its post was in flight; it was answered after all, so it counts as recorded or refused, not dropped.
      // A head another page removed was posted by that page too.
      const at = state.entries.findIndex((e) => e.body === head.body);
      if (at >= 0) state.entries.splice(at, 1);
      else if (posting.dropped) state.dropped -= 1;
      if (result.kind === 'refused') state.refused += 1;
      persist();
    }
  };

  return {
    enqueue(row) {
      let body: string;
      try {
        body = JSON.stringify(row);
      } catch {
        state.dropped += 1;
        return;
      }
      sync();
      state.entries.push({ body });
      while (state.entries.length > 0 && size() > OUTBOX_CAP_UNITS) dropOldest();
      persist();
    },
    flush() {
      flushing ??= run().finally(() => {
        flushing = null;
      });
      return flushing;
    },
    makeRoom() {
      sync();
      let freed = 0;
      while (state.entries.length > 0 && freed < PLAN_MAX_UNITS) {
        freed += (state.entries[0]?.body.length ?? 0) + 1;
        dropOldest();
      }
      persist();
    },
    get pending() {
      return state.entries.length;
    },
    get dropped() {
      return state.dropped;
    },
    get refused() {
      return state.refused;
    },
  };
}
