// src/analysis/models.ts, the model loader, against a real HTTP server on
// 127.0.0.1 with Node's own fetch, WebCrypto, and Web Locks (navigator.locks),
// and an in-memory stand-in for Cache Storage, which Node lacks: every outcome
// the loader returns, the segments it keeps for a resume, the startup cleanup,
// and waiting for a file another fetch holds. The browser scenarios in
// test/browser/scenarios/models.scenario.ts drive the same loader against the
// dev server's faults with Chrome's own Cache Storage.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { parseLock, type ParsedLock } from '../src/analysis/lock.ts';
import { clearModelCaches, openModelLoader, SEGMENT_BYTES, webLocks, type ModelCache, type ModelCaches, type ModelLoader } from '../src/analysis/models.ts';
import type { AnalysisError } from '../src/analysis/protocol.ts';
import type { AnalysisOp } from '../src/core/derive.ts';
import type { ModelId } from '../src/core/ids.ts';
import type { Result } from '../src/core/result.ts';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Deterministic bytes, different for each seed. */
function bytesOf(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 0xff;
  return out;
}

type Spec = { readonly name: string; readonly session: string; readonly role: 'graph' | 'external-data'; readonly size: number; readonly ext: string };
const SPECS: readonly Spec[] = [
  // Over two segments, so a download of it is stored in several.
  { name: 'depth', session: 'depth', role: 'graph', size: 2 * SEGMENT_BYTES + 12_345, ext: 'onnx' },
  { name: 'sam', session: 'encoder', role: 'graph', size: 4_000, ext: 'onnx' },
  { name: 'sam', session: 'encoder', role: 'external-data', size: 60_000, ext: 'onnx_data' },
  { name: 'sam', session: 'decoder', role: 'graph', size: 3_000, ext: 'onnx' },
  { name: 'sam', session: 'decoder', role: 'external-data', size: 50_000, ext: 'onnx_data' },
  { name: 'migan', session: 'migan', role: 'graph', size: 20_000, ext: 'onnx' },
  { name: 'face', session: 'face', role: 'graph', size: 1_000, ext: 'onnx' },
];

const BODIES = new Map<string, Buffer>();
let lock: ParsedLock;

function buildLock(): ParsedLock {
  const models: Record<string, { modelId: string; repo: string; commit: string; license: string; licenseSource: string; files: Record<string, unknown>[] }> = {};
  SPECS.forEach((spec, index) => {
    const body = bytesOf(spec.size, index + 1);
    const digest = sha256(body);
    const served = `/models/${spec.name}-${digest.slice(0, 8)}.${spec.ext}`;
    BODIES.set(served, body);
    const commit = '0'.repeat(40);
    const model = (models[spec.name] ??= { modelId: '', repo: `test/${spec.name}`, commit, license: 'MIT', licenseSource: 'https://example.com/license', files: [] });
    const source = `https://huggingface.co/test/${spec.name}/resolve/${commit}/${spec.session}.${spec.ext}`;
    model.files.push({ session: spec.session, role: spec.role, source, sha256: digest, bytes: spec.size, served, ...(spec.role === 'external-data' ? { externalDataPath: `${spec.session}.${spec.ext}` } : {}) });
  });
  for (const [name, model] of Object.entries(models)) model.modelId = `${name}@${sha256(model.files.map((f) => `${String(f['sha256'])}\n`).join(''))}`;
  const parsed = parseLock({ lockVersion: 1, models });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const served = (op: AnalysisOp, index = 0): string => lock.ops[op].files[index]?.served ?? assert.fail(`${op} has no file ${index}`);
const modelOf = (op: AnalysisOp): ModelId => lock.ops[op].model;

// ---------------------------------------------------------------------------
// Cache Storage, in memory

class MemoryCache implements ModelCache {
  readonly entries = new Map<string, Uint8Array>();
  refusePut = false;
  async match(url: string): Promise<Response | undefined> {
    const body = this.entries.get(new URL(url).href);
    return body === undefined ? undefined : new Response(body.slice());
  }
  async put(url: string, response: Response): Promise<void> {
    const body = new Uint8Array(await response.arrayBuffer());
    if (this.refusePut) throw new DOMException('the quota is exceeded', 'QuotaExceededError');
    this.entries.set(new URL(url).href, body);
  }
  async delete(url: string): Promise<boolean> {
    return this.entries.delete(new URL(url).href);
  }
  async keys(): Promise<readonly Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  /** Each entry's path and query, sorted. */
  paths(): string[] {
    return [...this.entries.keys()].map((url) => `${new URL(url).pathname}${new URL(url).search}`).sort();
  }
}

class MemoryCaches implements ModelCaches {
  readonly caches = new Map<string, MemoryCache>();
  refuseKeys = false;
  async open(name: string): Promise<MemoryCache> {
    const cache = this.caches.get(name) ?? new MemoryCache();
    this.caches.set(name, cache);
    return cache;
  }
  async keys(): Promise<readonly string[]> {
    if (this.refuseKeys) throw new DOMException('storage is unavailable', 'SecurityError');
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  get(name: string): MemoryCache {
    return this.caches.get(name) ?? assert.fail(`no cache ${name}`);
  }
}

/** Node's own Web Locks, as the page passes the browser's. */
const locks = webLocks(navigator.locks);

/** Holds the Web Lock `name`, as another tab's download does, until the returned function is called. */
async function holdElsewhere(name: string): Promise<() => Promise<void>> {
  const release = Promise.withResolvers<void>();
  const granted = Promise.withResolvers<void>();
  const held = navigator.locks.request(name, () => {
    granted.resolve();
    return release.promise;
  });
  await granted.promise;
  return async () => {
    release.resolve();
    await held;
  };
}

const nodeClock = { setTimeout: (callback: () => void, ms: number): number => Number(setTimeout(callback, ms)), clearTimeout: (handle: number): void => clearTimeout(handle) };

// ---------------------------------------------------------------------------
// The server

type Logged = { readonly path: string; readonly range: string | null };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;

/** Answers a file as the dev server does: whole with 200, or from byte N with 206 for `Range: bytes=N-`. */
const serveFile: Handler = (req, res, body) => {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const start = range === null ? 0 : Number(range[1]);
  if (range === null) res.writeHead(200, { 'content-length': body.length });
  else res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
  res.end(body.subarray(start));
};

let server: http.Server;
let origin = '';
let requests: Logged[] = [];
/** Answers the requests for each path named; every other path is served as a file. */
let handlers = new Map<string, Handler>();

before(async () => {
  lock = buildLock();
  server = http.createServer((req, res) => {
    const path = req.url ?? '';
    requests.push({ path, range: req.headers.range ?? null });
    const body = BODIES.get(path);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    (handlers.get(path) ?? serveFile)(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  assert.ok(address !== null && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  requests = [];
  handlers = new Map();
});

type Opened = { readonly loader: ModelLoader; readonly caches: MemoryCaches; readonly verified: MemoryCache; readonly partial: MemoryCache };

async function open({ caches = new MemoryCaches(), stallMs = 5_000, at = origin } = {}): Promise<Opened> {
  const opened = await openModelLoader({ lock, origin: at, caches, fetch: (url, init) => fetch(url, init), subtle: crypto.subtle, locks, clock: nodeClock, stallMs });
  if (!opened.ok) assert.fail(`the loader did not open: ${JSON.stringify(opened.error)}`);
  const loader = opened.value;
  return { loader, caches, verified: caches.get(loader.cacheName), partial: caches.get(loader.partialCacheName) };
}

type Fetched = { readonly result: Result<void, AnalysisError>; readonly progress: readonly (readonly [ModelId, number])[] };

async function fetchOps(loader: ModelLoader, ops: readonly AnalysisOp[], signal = new AbortController().signal): Promise<Fetched> {
  const progress: [ModelId, number][] = [];
  const result = await loader.fetchModels(ops, signal, (model, fraction) => progress.push([model, fraction]));
  return { result, progress };
}

const segmentsOf = (partial: MemoryCache, path: string): string[] => partial.paths().filter((p) => p.startsWith(`${path}?`));

/** Ends the response after `count` bytes of a body declared whole, as a dropped connection does. */
const cutAfter = (count: number): Handler => (_req, res, body) => {
  res.writeHead(200, { 'content-length': body.length });
  res.write(body.subarray(0, count), () => setTimeout(() => res.socket?.destroy(), 20));
};

// ---------------------------------------------------------------------------

test('a fetch caches every file the operations need, verified and in order, and a second fetch requests nothing', async () => {
  const { loader, verified, partial } = await open();
  const first = await fetchOps(loader, ['encode', 'decode']);
  assert.deepEqual(first.result, { ok: true, value: undefined });
  const files = [served('encode', 0), served('encode', 1), served('decode', 0), served('decode', 1)];
  assert.deepEqual(requests, files.map((path) => ({ path, range: null })));
  assert.deepEqual(verified.paths(), [...files].sort());
  for (const path of files) assert.ok(Buffer.from(verified.entries.get(`${origin}${path}`) ?? []).equals(BODIES.get(path) ?? Buffer.alloc(0)), path);
  assert.deepEqual(partial.paths(), [], 'no segment is left');
  const fractions = first.progress.map(([, f]) => f);
  assert.ok(first.progress.every(([model]) => model === modelOf('encode')), 'the encoder and decoder are one model');
  assert.ok(fractions.every((f, i) => i === 0 || f >= (fractions[i - 1] ?? 0)), 'progress never goes back');
  assert.equal(fractions.at(-1), 1);

  requests = [];
  const second = await fetchOps(loader, ['decode', 'encode']);
  assert.deepEqual(second.result, { ok: true, value: undefined });
  assert.deepEqual(requests, [], 'a verified file is not fetched again');
  assert.deepEqual(second.progress.at(-1), [modelOf('encode'), 1]);
});

test('an error status fails as download with that status and leaves nothing verified for the file', async () => {
  const { loader, verified, partial } = await open();
  for (const status of [500, 404, 403]) {
    handlers.set(served('inpaint'), (_req, res) => res.writeHead(status).end('no'));
    assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: false, error: { kind: 'download', model: modelOf('inpaint'), status } });
    assert.deepEqual([verified.paths(), partial.paths()], [[], []], String(status));
  }
  handlers.clear();
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
});

test('a transfer cut short keeps what arrived as a segment, and the retry asks for the rest with Range and verifies', async () => {
  const { loader, verified, partial } = await open();
  const path = served('inpaint');
  handlers.set(path, cutAfter(7_000));
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: false, error: { kind: 'download', model: modelOf('inpaint'), status: 'offline' } });
  assert.deepEqual(verified.paths(), []);
  assert.deepEqual(segmentsOf(partial, path), [`${path}?noisy-partial=0-7000`]);
  handlers.clear();
  requests = [];
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
  assert.deepEqual(requests, [{ path, range: 'bytes=7000-' }]);
  assert.deepEqual([verified.paths(), partial.paths()], [[path], []]);
  assert.ok(Buffer.from(verified.entries.get(`${origin}${path}`) ?? []).equals(BODIES.get(path) ?? Buffer.alloc(0)));
});

test('a server that answers a Range request with the whole file is read from its first byte, and the file verifies', async () => {
  const { loader, verified, partial } = await open();
  const path = served('inpaint');
  handlers.set(path, cutAfter(5_000));
  await fetchOps(loader, ['inpaint']);
  assert.deepEqual(segmentsOf(partial, path), [`${path}?noisy-partial=0-5000`]);
  handlers.set(path, (_req, res, body) => {
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  requests = [];
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
  assert.deepEqual(requests, [{ path, range: 'bytes=5000-' }]);
  assert.deepEqual([verified.paths(), partial.paths()], [[path], []]);
});

test('a 206 for another range than the one asked for discards the kept bytes and fails as integrity', async () => {
  const { loader, partial } = await open();
  const path = served('inpaint');
  handlers.set(path, cutAfter(5_000));
  await fetchOps(loader, ['inpaint']);
  handlers.set(path, (_req, res, body) => {
    res.writeHead(206, { 'content-length': body.length - 10, 'content-range': `bytes 10-${body.length - 1}/${body.length}` });
    res.end(body.subarray(10));
  });
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: false, error: { kind: 'integrity', model: modelOf('inpaint') } });
  assert.deepEqual(partial.paths(), []);
});

test('a file larger than a segment is stored in segments as it arrives, and a cut past the first resumes after it', async () => {
  const { loader, verified, partial } = await open();
  const path = served('depth');
  const cut = SEGMENT_BYTES + 100_000;
  handlers.set(path, cutAfter(cut));
  assert.deepEqual((await fetchOps(loader, ['depth'])).result, { ok: false, error: { kind: 'download', model: modelOf('depth'), status: 'offline' } });
  const ranges = segmentsOf(partial, path).map((p) => (/=(\d+)-(\d+)$/.exec(p) ?? assert.fail(p)).slice(1, 3).map(Number));
  assert.ok(ranges.length >= 2, `the kept bytes are in ${ranges.length} segments`);
  ranges.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  assert.deepEqual(ranges.flat(), [0, ...ranges.slice(0, -1).flatMap((r) => [r[1], r[1]]), cut], 'the segments run from 0 to the cut without a gap');
  handlers.clear();
  requests = [];
  assert.deepEqual((await fetchOps(loader, ['depth'])).result, { ok: true, value: undefined });
  assert.deepEqual(requests, [{ path, range: `bytes=${cut}-` }]);
  assert.deepEqual([verified.paths(), partial.paths()], [[path], []]);
  assert.equal(sha256(verified.entries.get(`${origin}${path}`) ?? new Uint8Array()), sha256(BODIES.get(path) ?? Buffer.alloc(0)));
});

test('bytes that do not hash to the lock fail as integrity, nothing is promoted or kept, and a clean retry caches the file', async () => {
  const { loader, verified, partial } = await open();
  const path = served('decode', 1);
  handlers.set(path, (_req, res, body) => {
    res.writeHead(200, { 'content-length': body.length });
    res.end(body.map((b) => b ^ 0xff));
  });
  assert.deepEqual((await fetchOps(loader, ['decode'])).result, { ok: false, error: { kind: 'integrity', model: modelOf('decode') } });
  assert.deepEqual(verified.paths(), [served('decode', 0)], 'only the graph, which came whole, is verified');
  assert.deepEqual(partial.paths(), []);
  handlers.clear();
  assert.deepEqual((await fetchOps(loader, ['decode'])).result, { ok: true, value: undefined });
  assert.deepEqual(verified.paths(), [served('decode', 0), path].sort());
});

test('a body longer than the lock\'s file fails as integrity and keeps nothing', async () => {
  const { loader, verified, partial } = await open();
  handlers.set(served('inpaint'), (_req, res, body) => {
    res.writeHead(200, { 'content-length': body.length + 100 });
    res.end(Buffer.concat([body, Buffer.alloc(100)]));
  });
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: false, error: { kind: 'integrity', model: modelOf('inpaint') } });
  assert.deepEqual([verified.paths(), partial.paths()], [[], []]);
});

test('no byte for the stall timeout fails as stalled, whether the headers came or not', async () => {
  const { loader, verified } = await open({ stallMs: 300 });
  const hung: http.ServerResponse[] = [];
  for (const [label, handler] of [
    ['after the headers', (_req, res) => { res.writeHead(200, { 'content-length': 20_000 }); res.flushHeaders(); hung.push(res); }],
    ['before the headers', (_req, res) => { hung.push(res); }],
  ] satisfies [string, Handler][]) {
    handlers.set(served('inpaint'), handler);
    const began = performance.now();
    const { result } = await fetchOps(loader, ['inpaint']);
    const ms = performance.now() - began;
    assert.deepEqual(result, { ok: false, error: { kind: 'download', model: modelOf('inpaint'), status: 'stalled' } }, label);
    assert.ok(ms >= 290 && ms < 3_000, `${label}: gave up after ${Math.round(ms)} ms`);
    assert.deepEqual(verified.paths(), [], label);
  }
  for (const res of hung) res.destroy();
});

test('a server that cannot be reached fails as offline', async () => {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = closed.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise((resolve) => closed.close(resolve));
  const { loader } = await open({ at: `http://127.0.0.1:${address.port}` });
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: false, error: { kind: 'download', model: modelOf('inpaint'), status: 'offline' } });
});

test('the abort signal cancels a download and keeps what arrived for the next one', async () => {
  const { loader, partial } = await open();
  const path = served('inpaint');
  const hung: http.ServerResponse[] = [];
  handlers.set(path, (_req, res, body) => {
    res.writeHead(200, { 'content-length': body.length });
    res.write(body.subarray(0, 6_000));
    hung.push(res);
  });
  const controller = new AbortController();
  const result = await loader.fetchModels(['inpaint'], controller.signal, (_model, fraction) => {
    if (fraction > 0) controller.abort();
  });
  assert.deepEqual(result, { ok: false, error: { kind: 'cancelled' } });
  assert.deepEqual(segmentsOf(partial, path), [`${path}?noisy-partial=0-6000`]);
  for (const res of hung) res.destroy();
  requests = [];
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual((await fetchOps(loader, ['inpaint'], aborted.signal)).result, { ok: false, error: { kind: 'cancelled' } });
  assert.deepEqual(requests, [], 'an aborted signal requests nothing');
});

test('Cache Storage that cannot be listed at startup fails the open as quota', async () => {
  const refusing = new MemoryCaches();
  refusing.refuseKeys = true;
  const opened = await openModelLoader({ lock, origin, caches: refusing, fetch: (url, init) => fetch(url, init), subtle: crypto.subtle, locks, clock: nodeClock });
  assert.deepEqual(opened, { ok: false, error: { kind: 'quota' } });
});

test('a verified cache that refuses the file fails as quota and keeps no segment, and a retry with room downloads and caches it', async () => {
  const { loader, verified, partial } = await open();
  verified.refusePut = true;
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: false, error: { kind: 'quota' } });
  assert.deepEqual([verified.paths(), partial.paths()], [[], []], 'the segments were deleted before the put, so the file was never stored twice');
  verified.refusePut = false;
  requests = [];
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
  assert.deepEqual(requests, [{ path: served('inpaint'), range: null }]);
  assert.deepEqual(verified.paths(), [served('inpaint')]);
});

test('a segment that does not fit fails as quota and closes the connection, and the server can still be reached', async () => {
  const { loader, partial } = await open();
  const path = served('depth');
  const closed = Promise.withResolvers<void>();
  handlers.set(path, (req, res, body) => {
    // The socket, not the response: a response closes once its bytes are written, read or not.
    req.socket.once('close', () => closed.resolve());
    serveFile(req, res, body);
  });
  partial.refusePut = true;
  assert.deepEqual((await fetchOps(loader, ['depth'])).result, { ok: false, error: { kind: 'quota' } });
  const timeout = Promise.withResolvers<'open'>();
  const timer = setTimeout(() => timeout.resolve('open'), 2_000);
  assert.equal(await Promise.race([closed.promise.then(() => 'closed' as const), timeout.promise]), 'closed', 'the response the loader stopped reading was closed');
  clearTimeout(timer);
  partial.refusePut = false;
  handlers.clear();
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
});

test('startup deletes other locks\' caches and stray segments, keeps a dead page\'s run from byte 0 for a resume, and keeps the segments of a file another tab is downloading', async () => {
  const caches = new MemoryCaches();
  const first = await open({ caches });
  assert.deepEqual((await fetchOps(first.loader, ['decode'])).result, { ok: true, value: undefined });
  const verifiedPath = served('decode');
  const inpaint = served('inpaint');
  const encoderData = served('encode', 1);
  const stale = await caches.open('noisy-models-0000000000000000000000000000000000000000000000000000000000000000');
  await stale.put(`${origin}/models/stale.onnx`, new Response('stale'));
  await caches.open('noisy-models-0000000000000000000000000000000000000000000000000000000000000000-partial');
  await caches.open('other-app-cache');
  const put = (path: string, size: number): Promise<void> => first.partial.put(`${origin}${path}`, new Response(new Uint8Array(size)));
  // A page that died mid-download left the first 1000 bytes of the inpaint model.
  await first.partial.put(`${origin}${inpaint}?noisy-partial=0-1000`, new Response(new Uint8Array((BODIES.get(inpaint) ?? assert.fail()).subarray(0, 1000))));
  await put(`${inpaint}?noisy-partial=5000-6000`, 1000);
  await put(`${verifiedPath}?noisy-partial=0-10`, 10);
  await put(`${inpaint}`, 3);
  await put('/models/unknown-00000000.onnx?noisy-partial=0-4', 4);
  await put(`${inpaint}?noisy-partial=0-1000&x=1`, 1000);
  // Another tab is downloading the encoder's data: its segments are that download's.
  await put(`${encoderData}?noisy-partial=0-9`, 9);
  const release = await holdElsewhere(`${first.loader.cacheName}:${encoderData}`);

  const second = await open({ caches });
  await release();
  assert.deepEqual([...caches.caches.keys()].sort(), ['other-app-cache', second.loader.cacheName, second.loader.partialCacheName].sort());
  assert.deepEqual(second.partial.paths(), [`${encoderData}?noisy-partial=0-9`, `${inpaint}?noisy-partial=0-1000`].sort());
  assert.deepEqual(second.verified.paths(), [served('decode', 0), served('decode', 1)].sort());
  requests = [];
  assert.deepEqual((await fetchOps(second.loader, ['inpaint'])).result, { ok: true, value: undefined });
  assert.deepEqual(requests, [{ path: inpaint, range: 'bytes=1000-' }], 'the dead page\'s first 1000 bytes were kept, so the fetch resumes from them');
});

test('two fetches of one file at once download it once', async () => {
  const caches = new MemoryCaches();
  const [a, b] = [await open({ caches }), await open({ caches })];
  const results = await Promise.all([fetchOps(a.loader, ['decode']), fetchOps(b.loader, ['decode'])]);
  assert.deepEqual(results.map((r) => r.result), [{ ok: true, value: undefined }, { ok: true, value: undefined }]);
  assert.deepEqual(requests.map((r) => r.path), [served('decode', 0), served('decode', 1)]);
});

test('a file another tab holds past the stall timeout fails as stalled, and a cancel while waiting as cancelled, with no request', async () => {
  const { loader } = await open({ stallMs: 300 });
  const release = await holdElsewhere(`${loader.cacheName}:${served('inpaint')}`);
  try {
    const began = performance.now();
    const { result } = await fetchOps(loader, ['inpaint']);
    const ms = performance.now() - began;
    assert.deepEqual(result, { ok: false, error: { kind: 'download', model: modelOf('inpaint'), status: 'stalled' } });
    assert.ok(ms >= 290 && ms < 3_000, `gave up after ${Math.round(ms)} ms`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    assert.deepEqual((await fetchOps(loader, ['inpaint'], controller.signal)).result, { ok: false, error: { kind: 'cancelled' } });
    assert.deepEqual(requests, []);
  } finally {
    await release();
  }
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined }, 'once the other tab lets go the file is fetched');
});

test('a fetch after a page of another lock deleted this lock\'s caches stores its files where a later open by name finds them', async () => {
  const { loader, caches } = await open();
  await caches.delete(loader.cacheName);
  await caches.delete(loader.partialCacheName);
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
  assert.deepEqual((await caches.open(loader.cacheName)).paths(), [served('inpaint')]);
});

test('clearing the model caches deletes every lock\'s and leaves other caches, and the next fetch downloads again', async () => {
  const { loader, caches } = await open();
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
  await caches.open('noisy-models-old');
  await caches.open('other-app-cache');
  const cleared = await clearModelCaches(caches);
  assert.ok(cleared.ok);
  assert.deepEqual([...cleared.value].sort(), [loader.cacheName, loader.partialCacheName, 'noisy-models-old'].sort());
  assert.deepEqual([...caches.caches.keys()], ['other-app-cache']);
  requests = [];
  assert.deepEqual((await fetchOps(loader, ['inpaint'])).result, { ok: true, value: undefined });
  assert.deepEqual(requests, [{ path: served('inpaint'), range: null }]);
  const refusing = new MemoryCaches();
  refusing.refuseKeys = true;
  assert.deepEqual(await clearModelCaches(refusing), { ok: false, error: { kind: 'quota' } });
});

test('webLocks over navigator.locks: tryHold runs without the lock while another holds it, and an abort while waiting rejects with its reason', async () => {
  const release = await holdElsewhere('noisy-test-lock');
  try {
    assert.equal(await locks.tryHold('noisy-test-lock', async (held) => held), false);
    const controller = new AbortController();
    const waiting = locks.hold('noisy-test-lock', controller.signal, async () => 'ran');
    const reason = new Error('stop waiting');
    controller.abort(reason);
    await assert.rejects(waiting, (e) => e === reason);
  } finally {
    await release();
  }
  assert.equal(await locks.tryHold('noisy-test-lock', async (held) => held), true);
});
