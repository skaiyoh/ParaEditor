// src/dev/harness/outbox.ts, over a fake storage with an origin quota and a
// fake fetch: a row is stored before it is posted and leaves on the sink's
// `{ "ok": true }` or a 4xx; posts go one at a time, oldest first; a 500, a
// network failure, and a timeout keep the row, a 400 drops it counted
// `refused`; bodies just under and over the keepalive bound; a backlog past
// the cap and a write past the quota drop the oldest rows, counted; nothing
// throws; makeRoom lets a plan or marker write that threw fit; and a flush
// keeps the rows another page of the same storage stored during its post.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEPALIVE_MAX_BYTES, OUTBOX_CAP_UNITS, PLAN_MAX_UNITS, POST_TIMEOUT_MS } from '../src/dev/harness/lines.ts';
import { createOutbox, createPost, type OutboxStorage, type Post, type PostResult } from '../src/dev/harness/outbox.ts';
import { harnessKeys } from '../src/dev/harness/catalog.ts';
import { stampRows } from '../src/dev/harness/plan.ts';
import type { HarnessRow } from '../src/dev/harness/rows.ts';
import { planOf, T0 } from './fixtures/harness.ts';

const { plan: PLAN_KEY, step: STEP_KEY, outbox: OUTBOX_KEY } = harnessKeys('memory');

/** localStorage's surface over a Map, throwing QuotaExceededError when the keys and values together would pass `quota` UTF-16 code units. */
class FakeStorage implements OutboxStorage {
  readonly items = new Map<string, string>();
  readonly quota: number;
  constructor(quota = Number.POSITIVE_INFINITY) {
    this.quota = quota;
  }
  used(except: string | null = null): number {
    let n = 0;
    for (const [k, v] of this.items) if (k !== except) n += k.length + v.length;
    return n;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.used(key) + key.length + value.length > this.quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** Rows of the plan's run, each about `size` characters, `count` of them, with seq from `from`. */
function rowsOf(count: number, size = 200, from = 0): readonly HarnessRow[] {
  const plan = { ...planOf(['U1.survival.full']), seq: from };
  const reason = 'x'.repeat(Math.max(0, size - 230));
  return stampRows(plan, Array.from({ length: count }, () => ({ type: 'step-end', row: 'U1.survival.full', stepKey: 'run-1', outcome: { kind: 'blocked', reason } }) as const), T0).rows;
}

const stored = (storage: FakeStorage): { dropped: number; refused: number; rows: { seq: number }[] } => JSON.parse(storage.getItem(OUTBOX_KEY) ?? 'null');
const seqs = (storage: FakeStorage): number[] => stored(storage).rows.map((r) => r.seq);

/** A post that answers each call from `answers` in turn and records each body; past the list it answers recorded. */
function scriptedPost(answers: readonly PostResult[]): { readonly post: Post; readonly bodies: string[] } {
  const bodies: string[] = [];
  let i = 0;
  const post: Post = async (body) => {
    bodies.push(body);
    const answer = answers[i] ?? { kind: 'recorded' };
    i += 1;
    return answer;
  };
  return { post, bodies };
}

const seqOf = (body: string): number => JSON.parse(body).seq;

// ---------------------------------------------------------------------------
// the post

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('the post sends JSON to /api/log with a 10 s timeout and answers recorded only for { ok: true }', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const timeouts: number[] = [];
  const answers = [response(200, { ok: true }), response(200, { ok: false }), response(200, 'ok')];
  const post = createPost({
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (next === undefined) throw new Error('no answer left');
      return next;
    },
    timeout: (ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    },
  });
  assert.deepEqual(await post('{"a":1}'), { kind: 'recorded' });
  assert.deepEqual(await post('{"a":2}'), { kind: 'failed', reason: 'the sink answered without ok: true' });
  assert.deepEqual(await post('{"a":3}'), { kind: 'failed', reason: 'the sink answered without ok: true' });
  assert.deepEqual(timeouts, [POST_TIMEOUT_MS, POST_TIMEOUT_MS, POST_TIMEOUT_MS]);
  assert.equal(POST_TIMEOUT_MS, 10_000);
  const first = calls[0];
  assert.deepEqual([first?.url, first?.init.method, first?.init.headers, first?.init.body], ['/api/log', 'POST', { 'content-type': 'application/json' }, '{"a":1}']);
});

test("the post calls fetch unbound, as the browser's fetch requires of anything but the window", async () => {
  // The browser's fetch throws "Illegal invocation" when called as a method of another object; node's does not check, so this fake does.
  function browserFetch(this: unknown, _url: string, _init: RequestInit): Promise<Response> {
    if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
    return Promise.resolve(response(200, { ok: true }));
  }
  const post = createPost({ fetch: browserFetch, timeout: () => new AbortController().signal });
  assert.deepEqual(await post('{"a":1}'), { kind: 'recorded' });
});

test('the post answers a 4xx refused and a 500, a network failure, and an unreadable body failed, and never rejects', async () => {
  const cases: readonly [() => Promise<Response>, PostResult][] = [
    [async () => response(400, { error: 'bad' }), { kind: 'refused', status: 400 }],
    [async () => response(413, { error: 'too large' }), { kind: 'refused', status: 413 }],
    [async () => response(500, { error: 'down' }), { kind: 'failed', reason: 'the sink answered 500' }],
    [async () => Promise.reject(new TypeError('Failed to fetch')), { kind: 'failed', reason: 'Failed to fetch' }],
  ];
  for (const [answer, expected] of cases) assert.deepEqual(await createPost({ fetch: answer })('{}'), expected);
  const unreadable = await createPost({ fetch: async () => new Response('not json', { status: 200 }) })('{}');
  assert.equal(unreadable.kind, 'failed');
  const thrown = await createPost({
    fetch: () => {
      throw new Error('fetch threw');
    },
  })('{}');
  assert.deepEqual(thrown, { kind: 'failed', reason: 'fetch threw' });
});

test('a post with no answer fails at its timeout', async () => {
  const controller = new AbortController();
  const post = createPost({
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    timeout: () => controller.signal,
  });
  const pending = post('{}');
  controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  assert.deepEqual(await pending, { kind: 'failed', reason: 'The operation timed out.' });
});

test('a body of at most 60,000 bytes goes with keepalive and one byte over goes without, counting UTF-8 bytes', async () => {
  const keepalive: (boolean | undefined)[] = [];
  const post = createPost({
    fetch: async (_url, init) => {
      keepalive.push(init.keepalive);
      return response(200, { ok: true });
    },
  });
  const under = `"${'a'.repeat(KEEPALIVE_MAX_BYTES - 2)}"`;
  const over = `"${'a'.repeat(KEEPALIVE_MAX_BYTES - 1)}"`;
  // 'é' is two bytes in UTF-8: 29,999 of them and the quotes are 60,000 bytes in 30,001 characters.
  const wide = `"${'é'.repeat((KEEPALIVE_MAX_BYTES - 2) / 2)}"`;
  for (const body of [under, over, wide, `${wide.slice(0, -1)}a"`]) await post(body);
  assert.deepEqual([under.length, over.length], [KEEPALIVE_MAX_BYTES, KEEPALIVE_MAX_BYTES + 1]);
  assert.deepEqual(keepalive, [true, false, true, false]);
});

// ---------------------------------------------------------------------------
// the outbox

test('a row is stored before it is posted, stays through a failed post, and leaves once the sink answers ok', async () => {
  const storage = new FakeStorage();
  const { post, bodies } = scriptedPost([{ kind: 'failed', reason: 'the sink answered without ok: true' }]);
  const outbox = createOutbox({ page: 'memory', storage, post });
  const [row] = rowsOf(1);
  assert.ok(row !== undefined);
  outbox.enqueue(row);
  assert.deepEqual([seqs(storage), bodies.length, outbox.pending], [[0], 0, 1]);
  assert.deepEqual(stored(storage).rows, [JSON.parse(JSON.stringify(row))]);
  assert.deepEqual(await outbox.flush(), { kind: 'stopped', reason: 'the sink answered without ok: true' });
  assert.deepEqual([seqs(storage), outbox.pending], [[0], 1]);
  assert.deepEqual(await outbox.flush(), { kind: 'drained' });
  assert.deepEqual([seqs(storage), outbox.pending, bodies], [[], 0, [JSON.stringify(row), JSON.stringify(row)]]);
});

test('posts go one at a time, oldest first, and a second flush joins the first', async () => {
  let inFlight = 0;
  let most = 0;
  const order: number[] = [];
  const release: (() => void)[] = [];
  const post: Post = (body) =>
    new Promise((resolve) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      order.push(seqOf(body));
      release.push(() => {
        inFlight -= 1;
        resolve({ kind: 'recorded' });
      });
    });
  const outbox = createOutbox({ page: 'memory', storage: new FakeStorage(), post });
  for (const row of rowsOf(3)) outbox.enqueue(row);
  const first = outbox.flush();
  assert.equal(outbox.flush(), first);
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setImmediate(r));
    assert.equal(release.length, i + 1, 'the next post waits for the answer before it');
    release[i]?.();
  }
  assert.deepEqual(await first, { kind: 'drained' });
  assert.deepEqual([order, most, outbox.pending], [[0, 1, 2], 1, 0]);
});

test('a post answering 500, then ok, then 400: the rows wait, the first is recorded, the second is dropped as refused', async () => {
  const storage = new FakeStorage();
  const { post, bodies } = scriptedPost([{ kind: 'failed', reason: 'the sink answered 500' }, { kind: 'recorded' }, { kind: 'refused', status: 400 }, { kind: 'failed', reason: 'Failed to fetch' }]);
  const outbox = createOutbox({ page: 'memory', storage, post });
  for (const row of rowsOf(3)) outbox.enqueue(row);
  assert.deepEqual(await outbox.flush(), { kind: 'stopped', reason: 'the sink answered 500' });
  assert.deepEqual([seqs(storage), outbox.refused], [[0, 1, 2], 0]);
  assert.deepEqual(await outbox.flush(), { kind: 'stopped', reason: 'Failed to fetch' });
  assert.deepEqual(bodies.map(seqOf), [0, 0, 1, 2]);
  assert.deepEqual([seqs(storage), outbox.refused, outbox.dropped, stored(storage).refused], [[2], 1, 0, 1]);
  // A later page reads what is waiting and the counts.
  const reloaded = createOutbox({ page: 'memory', storage, post: scriptedPost([]).post });
  assert.deepEqual([reloaded.pending, reloaded.refused, reloaded.dropped], [1, 1, 0]);
  assert.deepEqual(await reloaded.flush(), { kind: 'drained' });
  assert.deepEqual([seqs(storage), reloaded.refused], [[], 1]);
});

test('a row dropped while its post is in flight is not counted dropped once the sink records or refuses it, and stays counted when the post fails', async () => {
  for (const [answer, dropped, refused] of [
    [{ kind: 'recorded' }, 0, 0],
    [{ kind: 'refused', status: 400 }, 0, 1],
    [{ kind: 'failed', reason: 'Failed to fetch' }, 1, 0],
  ] as const) {
    const storage = new FakeStorage();
    let release: (result: PostResult) => void = () => assert.fail('no post in flight');
    const outbox = createOutbox({ page: 'memory', storage, post: () => new Promise((resolve) => (release = resolve)) });
    outbox.enqueue(rowsOf(1)[0] ?? assert.fail());
    const flushed = outbox.flush();
    outbox.makeRoom();
    assert.deepEqual([outbox.pending, outbox.dropped], [0, 1], answer.kind);
    release(answer);
    await flushed;
    assert.deepEqual([outbox.dropped, outbox.refused, stored(storage).dropped], [dropped, refused, dropped], answer.kind);
  }
});

test("a page's flush keeps the rows another page of the same storage stored while its post was in flight", async () => {
  const storage = new FakeStorage();
  let release: (result: PostResult) => void = () => assert.fail('no post in flight');
  const flushing = createOutbox({ page: 'memory', storage, post: () => new Promise((resolve) => (release = resolve)) });
  const [mine, theirs] = rowsOf(2);
  flushing.enqueue(mine ?? assert.fail());
  const flushed = flushing.flush();
  await new Promise((r) => setImmediate(r));
  createOutbox({ page: 'memory', storage, post: () => new Promise(() => {}) }).enqueue(theirs ?? assert.fail());
  assert.deepEqual(seqs(storage), [0, 1]);
  release({ kind: 'recorded' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seqs(storage), [1], 'only the answered row leaves');
  release({ kind: 'failed', reason: 'Failed to fetch' });
  assert.deepEqual(await flushed, { kind: 'stopped', reason: 'Failed to fetch' });
  assert.deepEqual(seqs(storage), [1]);
});

test('a backlog past the cap drops the oldest rows, counted, and keeps the newest', () => {
  const storage = new FakeStorage();
  const outbox = createOutbox({ page: 'memory', storage, post: scriptedPost([]).post });
  const rows = rowsOf(260, 2_000);
  for (const row of rows) outbox.enqueue(row);
  const text = storage.getItem(OUTBOX_KEY) ?? '';
  assert.ok(text.length <= OUTBOX_CAP_UNITS, `${text.length}`);
  assert.ok(outbox.dropped > 0);
  assert.equal(outbox.pending + outbox.dropped, 260);
  assert.deepEqual(seqs(storage), rows.slice(outbox.dropped).map((r) => r.seq));
  assert.equal(stored(storage).dropped, outbox.dropped);
  // One more row past the cap drops exactly as many as it needs.
  const before = outbox.dropped;
  outbox.enqueue(rowsOf(1, 2_000, 260)[0] ?? assert.fail());
  assert.equal(outbox.dropped, before + 1);
});

test('an outbox write that throws at the quota drops the oldest rows until it fits, counted, and never throws', () => {
  const storage = new FakeStorage(60_000);
  storage.setItem(PLAN_KEY, 'p'.repeat(10_000));
  const outbox = createOutbox({ page: 'memory', storage, post: scriptedPost([]).post });
  const rows = rowsOf(40, 2_000);
  for (const row of rows) assert.doesNotThrow(() => outbox.enqueue(row));
  assert.ok(outbox.dropped > 0, 'rows were dropped');
  assert.equal(outbox.pending + outbox.dropped, 40);
  assert.deepEqual(seqs(storage), rows.slice(outbox.dropped).map((r) => r.seq));
  assert.ok(storage.used() <= 60_000);
  assert.equal(storage.getItem(PLAN_KEY)?.length, 10_000, 'the plan is untouched');
});

test('makeRoom lets a plan or marker write that threw at the quota fit', () => {
  const storage = new FakeStorage(80_000);
  const outbox = createOutbox({ page: 'memory', storage, post: scriptedPost([]).post });
  for (const row of rowsOf(60, 2_000)) outbox.enqueue(row);
  const plan = 'p'.repeat(PLAN_MAX_UNITS - 1);
  assert.throws(() => storage.setItem(PLAN_KEY, plan), { name: 'QuotaExceededError' });
  const before = outbox.dropped;
  outbox.makeRoom();
  assert.ok(outbox.dropped > before);
  assert.doesNotThrow(() => storage.setItem(PLAN_KEY, plan));
  // The engine makes room again for each write that throws.
  const marker = 'm'.repeat(2_000);
  assert.throws(() => storage.setItem(STEP_KEY, marker), { name: 'QuotaExceededError' });
  outbox.makeRoom();
  assert.doesNotThrow(() => storage.setItem(STEP_KEY, marker));
  assert.equal(stored(storage).dropped, outbox.dropped);
  assert.ok(outbox.pending > 0, 'only the oldest rows were dropped');
});

test('nothing the outbox does throws, over a storage whose every call throws, a corrupt stored outbox, or a post that throws', async () => {
  const broken: OutboxStorage = {
    getItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError');
    },
    removeItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
  };
  const outbox = createOutbox({ page: 'memory', storage: broken, post: scriptedPost([]).post });
  assert.doesNotThrow(() => outbox.enqueue(rowsOf(1)[0] ?? assert.fail()));
  assert.doesNotThrow(() => outbox.makeRoom());
  // No write fits, so the row is dropped and counted.
  assert.deepEqual([outbox.pending, outbox.dropped], [0, 1]);
  assert.deepEqual(await outbox.flush(), { kind: 'drained' });

  const corrupt = new FakeStorage();
  corrupt.setItem(OUTBOX_KEY, '{not json');
  const fresh = createOutbox({ page: 'memory', storage: corrupt, post: scriptedPost([]).post });
  assert.equal(fresh.pending, 0);
  fresh.enqueue(rowsOf(1)[0] ?? assert.fail());
  assert.deepEqual(seqs(corrupt), [0]);

  const throwing = createOutbox({
    page: 'memory',
    storage: new FakeStorage(),
    post: () => {
      throw new Error('post threw');
    },
  });
  throwing.enqueue(rowsOf(1)[0] ?? assert.fail());
  assert.deepEqual(await throwing.flush(), { kind: 'stopped', reason: 'post threw' });
  assert.equal(throwing.pending, 1);
});
