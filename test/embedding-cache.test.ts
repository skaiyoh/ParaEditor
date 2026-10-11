import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAssetId, isModelId, type AssetId, type ModelId } from '../src/core/ids.ts';
import type { SamEmbeddings } from '../src/analysis/protocol.ts';
import { SAM_EMBEDDING_TENSORS } from '../src/analysis/stage-math.ts';
import { createEmbeddingCache } from '../src/session/embedding-cache.ts';

class CacheClock {
  private at = 0;
  private next = 0;
  private readonly timers = new Map<number, { at: number; callback(): void }>();
  now(): number { return this.at; }
  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.at + ms, callback });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  advance(ms: number): void {
    this.at += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.at) { this.timers.delete(id); timer.callback(); }
    }
  }
  get pending(): number { return this.timers.size; }
}

function observe<T>(promise: Promise<T>): { done: boolean; value: T | undefined } {
  const result: { done: boolean; value: T | undefined } = { done: false, value: undefined };
  void promise.then((value) => { result.done = true; result.value = value; });
  return result;
}

async function microtasks(count = 40): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function asset(char: string): AssetId {
  const value = char.repeat(64);
  if (!isAssetId(value)) throw new Error('invalid asset fixture');
  return value;
}

function model(char: string): ModelId {
  const value = `sam@${char.repeat(64)}`;
  if (!isModelId(value)) throw new Error('invalid model fixture');
  return value;
}

function embeddings(seed: number, id = model('a')): SamEmbeddings {
  const tensor = (spec: (typeof SAM_EMBEDDING_TENSORS)[number], index: number) => {
    const data = new Float32Array(spec.dims.reduce<number>((total, dim) => total * dim, 1));
    data[0] = seed + index;
    data[data.length - 1] = seed + index + 0.75;
    return { ...spec, data };
  };
  const [first, second, third] = SAM_EMBEDDING_TENSORS;
  return { model: id, tensors: [tensor(first, 0), tensor(second, 1), tensor(third, 2)] };
}

function requestUrl(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

class MemoryCache {
  readonly entries = new Map<string, Uint8Array<ArrayBuffer>>();
  writes = 0;
  reads = 0;
  refusePut = false;
  firstWrite: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | null = null;
  response: (() => Response) | null = null;
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.reads += 1;
    if (this.response !== null) return this.response();
    const bytes = this.entries.get(requestUrl(request));
    return bytes === undefined ? undefined : new Response(bytes.slice());
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.writes += 1;
    if (this.writes === 1 && this.firstWrite !== null) {
      this.firstWrite.started.resolve();
      await this.firstWrite.release.promise;
    }
    if (this.refusePut) throw new DOMException('storage quota', 'QuotaExceededError');
    this.entries.set(requestUrl(request), new Uint8Array(await response.arrayBuffer()));
  }
}

class MemoryStorage {
  readonly cache = new MemoryCache();
  readonly names: string[] = [];
  refuseOpen = false;
  async open(name: string): Promise<MemoryCache> {
    this.names.push(name);
    if (this.refuseOpen) throw new DOMException('storage blocked', 'SecurityError');
    return this.cache;
  }
}

test('embedding cache keeps only the current memory entry when storage is disabled', async () => {
  const cache = createEmbeddingCache(undefined);
  const first = embeddings(1);
  const second = embeddings(2);
  assert.equal(await cache.get(asset('1'), first.model), null);
  await cache.put(asset('1'), first);
  assert.equal(await cache.get(asset('1'), first.model), first);
  assert.equal(await cache.get(asset('1'), model('b')), null);
  await cache.put(asset('2'), second);
  assert.equal(await cache.get(asset('1'), first.model), null);
  assert.equal(await cache.get(asset('2'), second.model), second);
});

test('evicted embeddings roundtrip all tensors and survive a fresh cache owner', async () => {
  const storage = new MemoryStorage();
  const cache = createEmbeddingCache(storage);
  const first = embeddings(0.125);
  const second = embeddings(2);
  await cache.put(asset('1'), first);
  await cache.put(asset('2'), second);
  const restored = await cache.get(asset('1'), first.model);
  assert.deepEqual(restored, first);
  assert.notEqual(restored, first);
  assert.equal(storage.cache.reads, 1);
  assert.deepEqual(await createEmbeddingCache(storage).get(asset('2'), second.model), second);
  assert.deepEqual(storage.names, ['noisy-embeddings-v2', 'noisy-embeddings-v2']);
});

test('different masters and model versions have independent durable entries', async () => {
  const storage = new MemoryStorage();
  const cache = createEmbeddingCache(storage);
  const first = embeddings(1);
  const newer = embeddings(3, model('b'));
  await cache.put(asset('1'), first);
  await cache.put(asset('1'), newer);
  await cache.put(asset('2'), embeddings(2));
  const fresh = createEmbeddingCache(storage);
  assert.deepEqual(await fresh.get(asset('1'), first.model), first);
  assert.deepEqual(await fresh.get(asset('1'), newer.model), newer);
  assert.equal(await fresh.get(asset('3'), first.model), null);
  assert.equal(storage.cache.entries.size, 3);
});

test('all 16 MiB of SAM Tiny embeddings roundtrip at the payload limit', async () => {
  const storage = new MemoryStorage();
  const original: SamEmbeddings = { model: model('a'), tensors: [
    { name: 'image_embeddings.0', dims: [1, 32, 256, 256], data: new Float32Array(32 * 256 * 256) },
    { name: 'image_embeddings.1', dims: [1, 64, 128, 128], data: new Float32Array(64 * 128 * 128) },
    { name: 'image_embeddings.2', dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64) },
  ] };
  original.tensors.forEach((tensor, index) => { tensor.data[0] = index + 0.25; tensor.data[tensor.data.length - 1] = index + 0.75; });
  await createEmbeddingCache(storage).put(asset('1'), original);
  const restored = await createEmbeddingCache(storage).get(asset('1'), original.model);
  assert.ok(restored !== null);
  assert.equal(restored.tensors.reduce((total, tensor) => total + tensor.data.byteLength, 0), 16 * 1024 * 1024);
  restored.tensors.forEach((tensor, index) => {
    assert.deepEqual(tensor.dims, original.tensors[index]?.dims);
    assert.equal(tensor.data[0], index + 0.25);
    assert.equal(tensor.data[tensor.data.length - 1], index + 0.75);
  });
});

test('quota and unavailable storage retain the current embeddings without failing analysis', async () => {
  for (const failure of ['open', 'put']) {
    const storage = new MemoryStorage();
    storage.refuseOpen = failure === 'open';
    storage.cache.refusePut = failure === 'put';
    const cache = createEmbeddingCache(storage);
    const first = embeddings(1);
    const second = embeddings(2);
    await cache.put(asset('1'), first);
    assert.equal(await cache.get(asset('1'), first.model), first);
    await cache.put(asset('2'), second);
    assert.equal(await cache.get(asset('1'), first.model), null);
    assert.equal(await cache.get(asset('2'), second.model), second);
  }
});

test('at most one disk write and one latest pending write retain embeddings', async () => {
  const storage = new MemoryStorage();
  const blocked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  storage.cache.firstWrite = blocked;
  const cache = createEmbeddingCache(storage);
  const first = cache.put(asset('1'), embeddings(1));
  await blocked.started.promise;
  const superseded = cache.put(asset('2'), embeddings(2));
  const latestEmbeddings = embeddings(3);
  const latest = cache.put(asset('3'), latestEmbeddings);
  await superseded;
  assert.equal(storage.cache.writes, 1);
  assert.equal(await cache.get(asset('3'), latestEmbeddings.model), latestEmbeddings);
  blocked.release.resolve();
  await Promise.all([first, latest]);
  assert.equal(storage.cache.writes, 2);
  assert.equal(storage.cache.entries.size, 2);
  assert.equal(await cache.get(asset('2'), latestEmbeddings.model), null);
  assert.deepEqual(await createEmbeddingCache(storage).get(asset('1'), latestEmbeddings.model), embeddings(1));
});

test('a durable get waits for the in-flight write of an evicted photo', async () => {
  const storage = new MemoryStorage();
  const blocked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  storage.cache.firstWrite = blocked;
  const cache = createEmbeddingCache(storage);
  const firstEmbeddings = embeddings(1);
  const first = cache.put(asset('1'), firstEmbeddings);
  await blocked.started.promise;
  const second = cache.put(asset('2'), embeddings(2));
  const restored = cache.get(asset('1'), firstEmbeddings.model);
  assert.equal(storage.cache.reads, 0);
  blocked.release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(await restored, firstEmbeddings);
});

test('malformed, wrong-model and nonfinite disk tensors are cache misses', async (t) => {
  const storage = new MemoryStorage();
  await createEmbeddingCache(storage).put(asset('1'), embeddings(1));
  const stored = storage.cache.entries.values().next().value;
  assert.ok(stored !== undefined);
  const headerLength = new DataView(stored.buffer).getUint32(0, true);
  const headerText = new TextDecoder().decode(stored.subarray(4, 4 + headerLength));
  const tensorStart = Math.ceil((4 + headerLength) / 4) * 4;
  const cases = new Map<string, () => Uint8Array<ArrayBuffer>>([
    ['truncated', () => stored.slice(0, stored.length - 1)],
    ['invalid JSON', () => { const bytes = stored.slice(); bytes[4] = 0; return bytes; }],
    ['oversized header', () => { const bytes = stored.slice(); new DataView(bytes.buffer).setUint32(0, 0xffffffff, true); return bytes; }],
    ['wrong model', () => { const bytes = stored.slice(); const offset = new TextDecoder().decode(stored.subarray(4, 4 + headerLength)).indexOf('sam@'); bytes[4 + offset] = 'x'.charCodeAt(0); return bytes; }],
    ['extra trailing bytes', () => { const bytes = new Uint8Array(stored.length + 4); bytes.set(stored); return bytes; }],
    ['nonfinite tensor', () => { const bytes = stored.slice(); new DataView(bytes.buffer).setFloat32(tensorStart, Number.NaN, true); return bytes; }],
    ['dimensions exceed the payload', () => { const bytes = stored.slice(); bytes.set(new TextEncoder().encode(headerText.replace('[1,32,256,256]', '[9,32,256,256]')), 4); return bytes; }],
    ['wrong SAM dimensions with the same element count', () => { const bytes = stored.slice(); bytes.set(new TextEncoder().encode(headerText.replace('[1,32,256,256]', '[1,32,128,512]')), 4); return bytes; }],
    ['wrong SAM tensor name', () => { const bytes = stored.slice(); bytes.set(new TextEncoder().encode(headerText.replace('image_embeddings.0', 'other_embeddings.0')), 4); return bytes; }],
    ['duplicate tensor names', () => { const bytes = stored.slice(); bytes.set(new TextEncoder().encode(headerText.replace('image_embeddings.2', 'image_embeddings.1')), 4); return bytes; }],
  ]);
  for (const [name, makeBytes] of cases) {
    await t.test(name, async () => {
      storage.cache.response = () => new Response(makeBytes());
      assert.equal(await createEmbeddingCache(storage).get(asset('1'), model('a')), null);
    });
  }
});

test('an oversized body is cancelled even if its content length is absent or false', async () => {
  for (const declared of [null, '1', String(64 * 1024 * 1024)]) {
    let chunks = 0;
    let cancelled = false;
    const storage = new MemoryStorage();
    storage.cache.response = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    }), declared === null ? undefined : { headers: { 'Content-Length': declared } });
    assert.equal(await createEmbeddingCache(storage).get(asset('1'), model('a')), null);
    assert.equal(cancelled, true);
    assert.ok(chunks <= 258, `read ${chunks} chunks from an oversized entry`);
  }
});

test('a pending cache open is a bounded miss and late completion cannot restart disk work', async () => {
  const clock = new CacheClock();
  const opened = Promise.withResolvers<MemoryCache>();
  const disk = new MemoryCache();
  let opens = 0;
  const cache = createEmbeddingCache({ open() { opens += 1; return opened.promise; } }, clock);
  const result = observe(cache.get(asset('1'), model('a')));
  await microtasks();
  clock.advance(2000);
  await microtasks();
  assert.equal(result.done, true, 'an unresolved CacheStorage.open must not block a photo');
  assert.equal(result.value, null);
  opened.resolve(disk);
  await microtasks();
  assert.equal(disk.reads, 0, 'a late open must not start a match after its deadline');
  assert.equal(await cache.get(asset('2'), model('a')), null);
  assert.equal(opens, 1, 'a stalled backend is not retried by this cache owner');
  assert.equal(clock.pending, 0);
});

test('a pending cache match times out and its late result cannot replace the current memory entry', async () => {
  const storage = new MemoryStorage();
  await createEmbeddingCache(storage).put(asset('1'), embeddings(1));
  const stored = storage.cache.entries.values().next().value;
  assert.ok(stored !== undefined);
  const matched = Promise.withResolvers<Response | undefined>();
  storage.cache.match = async () => { storage.cache.reads += 1; return matched.promise; };
  const clock = new CacheClock();
  const cache = createEmbeddingCache(storage, clock);
  const old = observe(cache.get(asset('1'), model('a')));
  await microtasks();
  const newest = embeddings(2);
  const written = observe(cache.put(asset('2'), newest));
  clock.advance(2000);
  await microtasks();
  assert.equal(old.done, true, 'an unresolved Cache.match must not block a photo');
  assert.equal(old.value, null);
  assert.equal(written.done, true, 'a write waiting behind stalled I/O is optional');
  matched.resolve(new Response(stored.slice()));
  await microtasks();
  assert.equal(await cache.get(asset('2'), newest.model), newest);
  assert.equal(storage.cache.writes, 1, 'timeout drops queued disk work rather than overlapping it');
  assert.equal(clock.pending, 0);
});

test('a stalled streamed cache body is a bounded miss even when cancellation never settles', async () => {
  const storage = new MemoryStorage();
  let cancelled = 0;
  storage.cache.response = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 0, 0, 0])); },
    cancel() { cancelled += 1; return new Promise<void>(() => {}); },
  }));
  const clock = new CacheClock();
  const result = observe(createEmbeddingCache(storage, clock).get(asset('1'), model('a')));
  await microtasks();
  clock.advance(2000);
  await microtasks();
  assert.equal(result.done, true, 'a stalled body or cancel cannot block a photo');
  assert.equal(result.value, null);
  assert.equal(cancelled, 1);
  assert.equal(clock.pending, 0);
});

test('an oversized cache body with stalled cancellation does not restart raw disk I/O', async () => {
  for (const declared of [false, true]) {
    const storage = new MemoryStorage();
    let cancelled = 0;
    storage.cache.response = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled += 1; return new Promise<void>(() => {}); },
    }), declared ? { headers: { 'Content-Length': String(64 * 1024 * 1024) } } : undefined);
    const clock = new CacheClock();
    const cache = createEmbeddingCache(storage, clock);
    const miss = observe(cache.get(asset('1'), model('a')));
    await microtasks(2000);
    clock.advance(2000);
    await microtasks();
    assert.equal(miss.done, true, 'native cancellation cannot delay an oversized-entry miss');
    assert.equal(miss.value, null);
    assert.equal(cancelled, 1);
    assert.equal(await cache.get(asset('2'), model('a')), null);
    assert.equal(storage.cache.reads, 1, 'a corrupt body awaiting native cleanup disables later disk work');
    const current = embeddings(3);
    await cache.put(asset('3'), current);
    assert.equal(await cache.get(asset('3'), current.model), current);
    assert.equal(storage.cache.writes, 0);
    assert.equal(clock.pending, 0);
  }
});

test('the cache read budget includes time waiting behind writes', async () => {
  const storage = new MemoryStorage();
  const blocked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  storage.cache.firstWrite = blocked;
  const matched = Promise.withResolvers<Response | undefined>();
  storage.cache.match = async () => { storage.cache.reads += 1; return matched.promise; };
  const clock = new CacheClock();
  const cache = createEmbeddingCache(storage, clock);
  const first = cache.put(asset('1'), embeddings(1));
  await blocked.started.promise;
  const second = cache.put(asset('2'), embeddings(2));
  const result = observe(cache.get(asset('1'), model('a')));
  clock.advance(1500);
  blocked.release.resolve();
  await Promise.all([first, second]);
  await microtasks();
  assert.equal(storage.cache.reads, 1);
  clock.advance(499);
  await microtasks();
  assert.equal(result.done, false);
  clock.advance(1);
  await microtasks();
  assert.equal(result.done, true, 'waiting for writes cannot reset the read deadline');
  assert.equal(result.value, null);
  matched.resolve(undefined);
  await microtasks();
  assert.equal(clock.pending, 0);
});

test('a pending cache write returns by its deadline without retaining additional disk jobs', async () => {
  const storage = new MemoryStorage();
  const blocked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  storage.cache.firstWrite = blocked;
  const clock = new CacheClock();
  const cache = createEmbeddingCache(storage, clock);
  const first = observe(cache.put(asset('1'), embeddings(1)));
  await blocked.started.promise;
  clock.advance(2000);
  await microtasks();
  assert.equal(first.done, true, 'a pending Cache.put cannot gate editor readiness');
  let current = embeddings(1);
  for (let index = 2; index <= 5; index += 1) {
    current = embeddings(index);
    await cache.put(asset(String(index)), current);
  }
  assert.equal(storage.cache.writes, 1, 'a deadline does not free a noncancelable disk operation to overlap another');
  assert.equal(await cache.get(asset('5'), current.model), current);
  assert.equal(await cache.get(asset('1'), current.model), null);
  blocked.release.resolve();
  await microtasks();
  assert.equal(storage.cache.writes, 1);
  assert.equal(clock.pending, 0);
});

test('the cache read budget includes a previous stalled read', async () => {
  const storage = new MemoryStorage();
  const matched = Promise.withResolvers<Response | undefined>();
  storage.cache.match = async () => { storage.cache.reads += 1; return matched.promise; };
  const clock = new CacheClock();
  const cache = createEmbeddingCache(storage, clock);
  const old = observe(cache.get(asset('1'), model('a')));
  await microtasks();
  clock.advance(1500);
  const newest = observe(cache.get(asset('2'), model('a')));
  await microtasks();
  clock.advance(2000);
  await microtasks();
  assert.equal(old.done, true);
  assert.equal(newest.done, true, 'a get waiting behind another read still has its own total deadline');
  assert.equal(old.value, null);
  assert.equal(newest.value, null);
  assert.equal(storage.cache.reads, 1, 'a timeout cannot start another raw match concurrently');
  matched.resolve(undefined);
  await microtasks();
  assert.equal(clock.pending, 0);
});

test('finite tensor corruption is rejected by the cache digest', async () => {
  const storage = new MemoryStorage();
  await createEmbeddingCache(storage).put(asset('1'), embeddings(1));
  const stored = storage.cache.entries.values().next().value;
  assert.ok(stored !== undefined);
  const headerLength = new DataView(stored.buffer).getUint32(0, true);
  const tensorStart = Math.ceil((4 + headerLength) / 4) * 4;
  const corrupt = stored.slice();
  new DataView(corrupt.buffer).setFloat32(tensorStart, 1.5, true);
  storage.cache.response = () => new Response(corrupt.slice());
  assert.equal((await createEmbeddingCache(storage).get(asset('1'), model('a'))) === null, true, 'finite corruption must be a miss');
});

test('the cache digest rejects data copied to another master identity', async () => {
  const storage = new MemoryStorage();
  await createEmbeddingCache(storage).put(asset('1'), embeddings(1));
  const stored = storage.cache.entries.values().next().value;
  assert.ok(stored !== undefined);
  storage.cache.response = () => new Response(stored.slice());
  assert.equal((await createEmbeddingCache(storage).get(asset('2'), model('a'))) === null, true, 'different master identity must be a miss');
});

test('the cache digest rejects a valid model identity substituted into the header', async () => {
  const storage = new MemoryStorage();
  await createEmbeddingCache(storage).put(asset('1'), embeddings(1));
  const stored = storage.cache.entries.values().next().value;
  assert.ok(stored !== undefined);
  const headerLength = new DataView(stored.buffer).getUint32(0, true);
  const originalHeader = new TextDecoder().decode(stored.subarray(4, 4 + headerLength));
  const corrupt = stored.slice();
  corrupt.set(new TextEncoder().encode(originalHeader.replace(model('a'), model('b'))), 4);
  storage.cache.response = () => new Response(corrupt.slice());
  assert.equal((await createEmbeddingCache(storage).get(asset('1'), model('b'))) === null, true, 'substituted model identity must be a miss');
});
