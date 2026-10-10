// The ONNX Runtime plumbing for the analysis workers: loading the vendored
// runtime once, with the WebAssembly.Memory wrapper that reads the wasm heap's
// high-water mark installed before it; reading a session's model files from
// the verified model cache; and creating, running, and releasing a session
// with the options every analysis session takes. The sequence worker and the
// decode worker are its callers; docs/ARCHITECTURE.md ("The ONNX Runtime
// module") documents how they use it.
//
// Worker-safe: it makes no worker-global call (those stay in the *-worker.ts
// entries) and reads no compile-time constant; every browser object it needs
// arrives as a parameter or is a global both a page and a worker have.

import type { InferenceSession } from 'noisy:vendor-ort';
import { err, ok, type Result } from '../core/result.ts';
import { lockHash, modelCacheNames, modelFileUrl, type OpFiles, type ParsedLock } from './lock.ts';
import { oneLine } from './protocol.ts';
import type { TensorMap } from './stage-math.ts';

/** The vendored runtime's module, as `import('noisy:vendor-ort')` resolves it. */
export type Ort = typeof import('noisy:vendor-ort');

/** The loaded runtime, and the high-water mark of the wasm memory it created. */
export type OrtRuntime = {
  readonly ort: Ort;
  /**
   * The largest byte length any WebAssembly.Memory created in this scope since
   * the runtime loaded has reached, or null before the runtime has created one,
   * which it does when its first session is created. A wasm memory never
   * shrinks, so this is the heap's running maximum: in a scope that runs
   * several sessions one after another it is the largest of them so far, not
   * the last one's own peak.
   */
  readonly wasmHighWaterBytes: () => number | null;
};

/** One line describing a thrown value: an Error's name and message, anything else as text. */
export function describeThrown(thrown: unknown): string {
  return oneLine(thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown));
}

/**
 * Replaces this scope's WebAssembly.Memory constructor with a subclass that
 * records every memory it creates, and returns a reader of their largest byte
 * length. Only memories created after the call are seen, so it runs before
 * the runtime's glue is imported.
 */
function trackWasmMemory(): () => number | null {
  const memories: WebAssembly.Memory[] = [];
  const NativeMemory = WebAssembly.Memory;
  class TrackedMemory extends NativeMemory {
    constructor(descriptor: WebAssembly.MemoryDescriptor) {
      super(descriptor);
      memories.push(this);
    }
  }
  WebAssembly.Memory = TrackedMemory;
  return () => (memories.length === 0 ? null : Math.max(...memories.map((memory) => memory.buffer.byteLength)));
}

/**
 * Loads the vendored runtime: installs the memory wrapper, imports the
 * runtime, points `wasmPaths` at `ortBase`, and sets `numThreads` when
 * `threads` is a number; `'default'` leaves ORT's own default, which is one
 * thread when the scope is not cross-origin isolated. Call it once per
 * worker. An error names what failed, the import's own message included.
 */
export async function loadOrt(settings: { readonly ortBase: string; readonly threads: number | 'default' }): Promise<Result<OrtRuntime, string>> {
  const wasmHighWaterBytes = trackWasmMemory();
  let ort: Ort;
  try {
    ort = await import('noisy:vendor-ort');
  } catch (thrown) {
    return err(`ONNX Runtime did not load: ${describeThrown(thrown)}`);
  }
  ort.env.wasm.wasmPaths = settings.ortBase;
  if (settings.threads !== 'default') ort.env.wasm.numThreads = settings.threads;
  return ok({ ort, wasmHighWaterBytes });
}

/** Where a worker reads the verified model files: the verified cache of the build's lock, and the origin their keys are built on. */
export type ModelStore = {
  readonly cacheName: string;
  readonly origin: string;
  readonly caches: Pick<CacheStorage, 'match'>;
};

/**
 * The model store for `lock`: the verified cache the model loader fills,
 * named from the lock hash. Nothing is opened, so no cache is created; a file
 * is looked up in that cache by name when a session needs it.
 */
export async function modelStore(deps: {
  readonly lock: ParsedLock;
  readonly subtle: Pick<SubtleCrypto, 'digest'>;
  readonly caches: Pick<CacheStorage, 'match'>;
  readonly origin: string;
}): Promise<ModelStore> {
  const hash = await lockHash(deps.lock.lock, deps.subtle);
  return { cacheName: modelCacheNames(hash).verified, origin: deps.origin, caches: deps.caches };
}

/**
 * Reads one file of the store. The loader verified the bytes against the lock
 * before it put them there, so they are not hashed again; a file the cache
 * does not hold, as after the browser evicted it, is an error naming it.
 */
async function readModelFile(store: ModelStore, served: string): Promise<Result<Uint8Array<ArrayBuffer>, string>> {
  const response = await store.caches.match(modelFileUrl({ served }, store.origin), { cacheName: store.cacheName });
  if (response === undefined) return err(`the verified model cache ${store.cacheName} holds no ${served}; fetch the models again`);
  return ok(new Uint8Array(await response.arrayBuffer()));
}

/** A created session and how long reading its files and creating it took, in milliseconds. */
export type OpenSession = { readonly session: InferenceSession; readonly sessionMs: number };

/**
 * Creates the session of `files`: reads each of its files from the store,
 * then creates the session from the graph file with every external-data file
 * under its `externalDataPath`, the `wasm` execution provider only, and
 * `graphOptimizationLevel: 'all'`. The file bytes are held only until the
 * session exists. `sessionMs` runs from the first read to the session's
 * creation. An error names the file that is missing or what creation threw.
 */
export async function createSession(runtime: OrtRuntime, store: ModelStore, files: OpFiles): Promise<Result<OpenSession, string>> {
  const started = performance.now();
  let graph: Uint8Array<ArrayBuffer> | null = null;
  const externalData: { readonly path: string; readonly data: Uint8Array<ArrayBuffer> }[] = [];
  for (const file of files.files) {
    const bytes = await readModelFile(store, file.served);
    if (!bytes.ok) return bytes;
    if (file.role === 'graph') graph = bytes.value;
    else externalData.push({ path: file.externalDataPath, data: bytes.value });
  }
  if (graph === null) return err(`the ${files.session} session has no graph file`);
  const options: InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    ...(externalData.length > 0 ? { externalData } : {}),
  };
  try {
    const session = await runtime.ort.InferenceSession.create(graph, options);
    return ok({ session, sessionMs: performance.now() - started });
  } catch (thrown) {
    return err(`the ${files.session} session could not be created: ${describeThrown(thrown)}`);
  }
}

/** Runs `session` on `feeds`; resolves with its outputs and the run's milliseconds, or what the run threw. */
export async function runSession(session: InferenceSession, feeds: InferenceSession.FeedsType): Promise<Result<{ readonly outputs: TensorMap; readonly inferMs: number }, string>> {
  const started = performance.now();
  try {
    const outputs = await session.run(feeds);
    return ok({ outputs, inferMs: performance.now() - started });
  } catch (thrown) {
    return err(`the run threw ${describeThrown(thrown)}`);
  }
}

/** Releases `session`'s memory in the runtime; resolves with what the release threw, if it did. */
export async function releaseSession(session: InferenceSession): Promise<Result<void, string>> {
  try {
    await session.release();
    return ok(undefined);
  } catch (thrown) {
    return err(`the session's release threw ${describeThrown(thrown)}`);
  }
}
