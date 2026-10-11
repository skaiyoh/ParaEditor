import { z } from '../core/zod.ts';
import { parseSequenceReply, type SamEmbeddings } from '../analysis/protocol.ts';
import { decoderEmbeddings } from '../analysis/stage-math.ts';
import { isAssetId, isModelId, type AssetId, type ModelId } from '../core/ids.ts';
import type { Clock } from '../platform/clock.ts';

export interface EmbeddingCache {
  get(master: AssetId, model: ModelId): Promise<SamEmbeddings | null>;
  put(master: AssetId, embeddings: SamEmbeddings): Promise<void>;
}

/** Optional cache values cross the same boundary as worker-produced tensors. */
export async function readCachedEmbeddings(cache: EmbeddingCache, master: AssetId, model: ModelId): Promise<SamEmbeddings | null> {
  try {
    const embeddings = await cache.get(master, model);
    if (embeddings === null) return null;
    const parsed = parseSequenceReply({ type: 'embeddings', embeddings, timings: { sessionMs: 0, inferMs: 0, wasmHighWaterBytes: 0 } });
    if (!parsed.ok || parsed.value.type !== 'embeddings') return null;
    return decoderEmbeddings(parsed.value.embeddings, model).ok ? parsed.value.embeddings : null;
  } catch { return null; }
}

type Storage = { open(name: string): Promise<Pick<Cache, 'match' | 'put'>> };
type MemoryEntry = { master: AssetId; embeddings: SamEmbeddings };
type Write = MemoryEntry & { finish(): void };
type CacheClock = Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>;
type Deadline<T> = { value: Promise<T>; finish(value: T): void; expired(): boolean; signal: AbortSignal; disableStorage(): void };
type ReadDeadline = Pick<Deadline<unknown>, 'expired' | 'signal' | 'disableStorage'>;

const CACHE_NAME = 'noisy-embeddings-v2';
/** The total caller budget, including waits behind another disk operation. */
export const EMBEDDING_CACHE_IO_MS = 2000;
// SAM Tiny produces 16 MiB. Reject oversized or corrupt entries before making
// tensor views; a cache entry must never choose an arbitrary allocation size.
const TENSOR_BYTES = 16 * 1024 * 1024;
const HEADER_BYTES = 4096;
const DIGEST_BYTES = 32;
const ENTRY_BYTES = 4 + HEADER_BYTES + 3 + TENSOR_BYTES + DIGEST_BYTES;
const tensorHeader = z.strictObject({
  name: z.string().min(1).max(128),
  dims: z.array(z.int().min(1).max(4096)).min(1).max(8),
});
const headerSchema = z.strictObject({
  version: z.literal(2),
  master: z.custom<AssetId>((value) => typeof value === 'string' && isAssetId(value)),
  model: z.custom<ModelId>((value) => typeof value === 'string' && isModelId(value)),
  tensors: z.tuple([tensorHeader, tensorHeader, tensorHeader]),
});

function browserStorage(): CacheStorage | undefined {
  try { return globalThis.caches; } catch { return undefined; }
}

function key(master: AssetId, model: ModelId): string {
  // Only a Cache Storage key. This URL is never fetched.
  return `https://noisy-embeddings.invalid/${encodeURIComponent(model)}/${master}`;
}

async function encode(master: AssetId, embeddings: SamEmbeddings): Promise<Response | null> {
  const header = new TextEncoder().encode(JSON.stringify({
    version: 2,
    master,
    model: embeddings.model,
    tensors: embeddings.tensors.map(({ name, dims }) => ({ name, dims })),
  }));
  const tensorBytes = embeddings.tensors.reduce((total, tensor) => total + tensor.data.byteLength, 0);
  if (header.byteLength > HEADER_BYTES || tensorBytes > TENSOR_BYTES) return null;
  const start = Math.ceil((4 + header.byteLength) / 4) * 4;
  const bytes = new Uint8Array(start + tensorBytes + DIGEST_BYTES);
  new DataView(bytes.buffer).setUint32(0, header.byteLength, true);
  bytes.set(header, 4);
  let offset = start;
  for (const tensor of embeddings.tensors) {
    bytes.set(new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength), offset);
    offset += tensor.data.byteLength;
  }
  // Authenticate the identities, format, tensor names/shapes, and every payload
  // byte together. Old unsigned entries live in v1 and are never cache hits.
  bytes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(0, offset))), offset);
  return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } });
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try { void body?.cancel().catch(() => {}); } catch { /* Optional cleanup cannot delay a miss. */ }
}

async function readBounded(response: Response, deadline: ReadDeadline): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = response.headers.get('Content-Length');
  if (deadline.expired()) {
    cancelBody(response.body);
    return null;
  }
  if (declared !== null && Number(declared) > ENTRY_BYTES) {
    deadline.disableStorage();
    cancelBody(response.body);
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancelled = Promise.withResolvers<null>();
  const onAbort = (): void => { cancelled.resolve(null); };
  deadline.signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (deadline.expired()) return null;
      const next = await Promise.race([reader.read(), cancelled.promise]);
      if (next === null || deadline.expired()) return null;
      if (next.done) break;
      if (next.value.byteLength > ENTRY_BYTES - length) {
        // Oversized entries are exceptional corruption. Do not reopen native
        // disk resources while their noncancelable cleanup may still be pending.
        deadline.disableStorage();
        return null;
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
    // A stream's underlying cancel callback can itself never settle.
    try { void reader.cancel().catch(() => deadline.disableStorage()); } catch { deadline.disableStorage(); }
    try { reader.releaseLock(); } catch { /* A pending native read may still own the lock. */ }
  }
}

async function decode(response: Response, master: AssetId, model: ModelId, deadline: ReadDeadline): Promise<SamEmbeddings | null> {
  const bytes = await readBounded(response, deadline);
  if (bytes === null || bytes.byteLength < 4 + DIGEST_BYTES || deadline.expired()) return null;
  const headerLength = new DataView(bytes.buffer).getUint32(0, true);
  if (headerLength > HEADER_BYTES || 4 + headerLength > bytes.byteLength) return null;
  const header = headerSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))));
  if (!header.success || header.data.master !== master || header.data.model !== model) return null;
  const lengths = header.data.tensors.map(({ dims }) => dims.reduce((total, dim) => total * dim, 1));
  const tensorBytes = lengths.reduce((total, length) => total + length * 4, 0);
  const start = Math.ceil((4 + headerLength) / 4) * 4;
  const payloadEnd = start + tensorBytes;
  if (tensorBytes > TENSOR_BYTES || payloadEnd + DIGEST_BYTES !== bytes.byteLength) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(0, payloadEnd)));
  if (deadline.expired() || digest.some((value, index) => value !== bytes[payloadEnd + index])) return null;
  let offset = start;
  const tensors = header.data.tensors.map((tensor, index) => {
    const length = lengths[index] ?? 0;
    const data = new Float32Array(bytes.buffer, offset, length);
    offset += length * 4;
    return { ...tensor, data };
  });
  const parsed = parseSequenceReply({ type: 'embeddings', embeddings: { model, tensors }, timings: { sessionMs: 0, inferMs: 0, wasmHighWaterBytes: 0 } });
  if (!parsed.ok || parsed.value.type !== 'embeddings') return null;
  return decoderEmbeddings(parsed.value.embeddings, model).ok ? parsed.value.embeddings : null;
}

/** One memory entry, one active disk operation, and at most one newest pending write. */
export function createEmbeddingCache(storage?: Storage, clock?: CacheClock): EmbeddingCache {
  const persistent = arguments.length === 0 ? browserStorage() : storage;
  let memory: MemoryEntry | null = null;
  let revision = 0;
  let opened: Promise<Pick<Cache, 'match' | 'put'>> | null = null;
  let pending: Write | null = null;
  let active: Promise<void> | null = null;
  let reading: { key: string; value: Promise<SamEmbeddings | null> } | null = null;
  let disabled = false;

  function disable(): void {
    // Cache Storage promises cannot be cancelled. Keep the raw active slot
    // until it settles and disable later disk work, instead of overlapping more
    // retained 16 MiB responses after every timeout.
    disabled = true;
    pending?.finish();
    pending = null;
  }

  function bounded<T>(fallback: T): Deadline<T> {
    const done = Promise.withResolvers<T>();
    const controller = new AbortController();
    const now = (): number => clock?.now() ?? performance.now();
    const expiresAt = now() + EMBEDDING_CACHE_IO_MS;
    let settled = false;
    let clearTimer = (): void => {};
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      done.resolve(value);
    };
    const expire = (): void => {
      if (settled) return;
      disable();
      controller.abort();
      finish(fallback);
    };
    if (clock === undefined) {
      const handle = setTimeout(expire, EMBEDDING_CACHE_IO_MS);
      clearTimer = () => clearTimeout(handle);
    } else {
      const handle = clock.setTimeout(expire, EMBEDDING_CACHE_IO_MS);
      clearTimer = () => clock.clearTimeout(handle);
    }
    return {
      value: done.promise, finish, signal: controller.signal, disableStorage: disable,
      expired() { if (!settled && now() >= expiresAt) expire(); return controller.signal.aborted; },
    };
  }

  function open(): Promise<Pick<Cache, 'match' | 'put'>> | null {
    if (persistent === undefined) return null;
    opened ??= persistent.open(CACHE_NAME);
    return opened;
  }

  function own<T>(value: Promise<T>): Promise<T> {
    const done = value.then(() => {}, () => {}).then(() => {
      if (active === done) active = null;
      startWrite();
    });
    active = done;
    return value;
  }

  function startWrite(): void {
    if (active !== null || pending === null || disabled) return;
    const write = pending;
    pending = null;
    void own((async () => {
      try {
        const cache = await open();
        if (disabled || cache === null) return;
        const response = await encode(write.master, write.embeddings);
        if (disabled || response === null) { cancelBody(response?.body ?? null); return; }
        await cache.put(key(write.master, write.embeddings.model), response);
      } catch {
        // Quota, private browsing, and unavailable storage are cache misses.
        opened = null;
      } finally { write.finish(); }
    })());
  }

  return {
    async get(master, model) {
      if (memory?.master === master && memory.embeddings.model === model) return memory.embeddings;
      if (disabled || persistent === undefined) return null;
      const url = key(master, model);
      if (reading?.key === url) return reading.value;
      const current = ++revision;
      const deadline = bounded<SamEmbeddings | null>(null);
      const value = (async (): Promise<SamEmbeddings | null> => {
        try {
          while (active !== null) {
            await active;
            if (disabled || deadline.expired() || current !== revision) return null;
          }
          if (disabled || deadline.expired() || current !== revision) return null;
          return await own((async () => {
            const cache = await open();
            if (disabled || deadline.expired() || current !== revision || cache === null) return null;
            const response = await cache.match(url);
            if (response === undefined) return null;
            if (disabled || deadline.expired() || current !== revision) { cancelBody(response.body); return null; }
            return decode(response, master, model, deadline);
          })());
        } catch { return null; }
      })();
      void value.then((embeddings) => {
        if (!disabled && !deadline.expired() && current === revision && embeddings !== null) {
          memory = { master, embeddings };
          deadline.finish(embeddings);
        } else deadline.finish(null);
      });
      reading = { key: url, value: deadline.value };
      try {
        return await deadline.value;
      } finally {
        if (reading?.value === deadline.value) reading = null;
      }
    },
    put(master, embeddings) {
      memory = { master, embeddings };
      revision += 1;
      if (persistent === undefined || disabled) return Promise.resolve();
      const deadline = bounded<void>(undefined);
      pending?.finish();
      pending = { master, embeddings, finish: () => deadline.finish(undefined) };
      startWrite();
      return deadline.value;
    },
  };
}
