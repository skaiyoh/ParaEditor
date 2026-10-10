// The analysis service as the memory harness's runner builds it, for node
// tests: the real createAnalysisService over sequence worker ports that answer
// on their own, a stage at a time, the way the sequence worker does (its
// session phase, its infer phase, then its product with a high-water mark),
// or fail, raise an error event, or never answer, as the test scripts each
// stage of each run, and counting each cancel; a model loader whose fetch
// answers as the test says, at once or later;
// and inputs whose fetch the test scripts, with fake bitmaps.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLock, type ParsedLock } from '../../src/analysis/lock.ts';
import type { ModelLoader } from '../../src/analysis/models.ts';
import type { AnalysisError, SequenceReply, SequenceRequest } from '../../src/analysis/protocol.ts';
import { createAnalysisService, type SequenceWorkerPort } from '../../src/analysis/service.ts';
import { ok, type Result } from '../../src/core/result.ts';
import type { Clock } from '../../src/platform/clock.ts';
import { createInputs, type InputResponse, type Inputs } from '../../src/dev/harness/inputs.ts';
import type { RunnerDeps } from '../../src/dev/harness/runner.ts';

export async function readLock(): Promise<ParsedLock> {
  const parsed = parseLock(JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

type Stage = 'depth' | 'encode' | 'inpaint';

/** How a port answers one stage's run: its product, a `failed` reply, an error event, or nothing at all. */
export type Answer = { readonly kind: 'product'; readonly afterMs?: number } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'hang' };

/** The high-water mark each stage's product reports. */
export const HIGH_WATER = { depth: 290_000_000, encode: 722_000_000, inpaint: 419_000_000 } as const;

const timings = (stage: Stage) => ({ sessionMs: 3, inferMs: 7, wasmHighWaterBytes: HIGH_WATER[stage] });

function productOf(stage: Stage, lock: ParsedLock): SequenceReply {
  switch (stage) {
    case 'depth':
      return { type: 'depth', map: { format: 'f32', size: { width: 3, height: 2 }, data: new Float32Array([0.5, 0, 0.25, 1, 0.75, 0.5]) }, stats: { p10: 0, median: 0.5, p90: 1 }, timings: timings(stage) };
    case 'encode': {
      const tensor = (name: string) => ({ name, dims: [1, 2], data: new Float32Array([0.25, -0.25]) });
      return { type: 'embeddings', embeddings: { model: lock.ops.encode.model, tensors: [tensor('image_embeddings.0'), tensor('image_embeddings.1'), tensor('image_embeddings.2')] }, timings: timings(stage) };
    }
    case 'inpaint':
      return { type: 'plate', image: { size: { width: 4, height: 3 }, data: new Uint8Array(36) }, timings: timings(stage) };
  }
}

/** One sequence worker the service spawned: what it was posted and whether it was terminated. */
export type Port = SequenceWorkerPort & { readonly posted: SequenceRequest[]; terminated: boolean; readonly threads: number };

export type ServiceWorld = {
  /** The runner's `service` dependency. */
  readonly service: RunnerDeps['service'];
  /** Every port spawned, in order, across every service built. */
  readonly ports: Port[];
  /** The thread count of each service built, in order. */
  readonly built: number[];
  /** How the port of run `run` (0-based, across services) answers `stage`; every product by default. */
  answer: (stage: Stage, run: number) => Answer;
  /** What the loader's fetch answers, at once or when the promise settles; ok by default. */
  fetchModels: () => Result<void, AnalysisError> | Promise<Result<void, AnalysisError>>;
  /** How many times `cancelHeavy` was called, across every service built. */
  readonly cancels: number;
};

export function serviceWorld(clock: Pick<Clock, 'now'>, lock: ParsedLock): ServiceWorld {
  let cancels = 0;
  const world: ServiceWorld = {
    get cancels() {
      return cancels;
    },
    ports: [],
    built: [],
    answer: () => ({ kind: 'product' }),
    fetchModels: () => ok(undefined),
    service: (threads, diag) => {
      world.built.push(threads);
      const loader: ModelLoader = { lockHash: 'h', cacheName: 'noisy-models-h', partialCacheName: 'noisy-models-h-partial', fetchModels: async () => world.fetchModels() };
      const service = createAnalysisService({
        clock,
        diag,
        spawn: () => spawn(threads),
        spawnDecoder: () => {
          throw new Error('the harness runner opens no decoder');
        },
        ortBase: '/vendor/ort/1.30.0/',
        threads,
        lock,
        loader: Promise.resolve(ok(loader)),
      });
      return {
        runSequence: (...args) => service.runSequence(...args),
        cancelHeavy: () => {
          cancels += 1;
          service.cancelHeavy();
        },
        fetchModels: (...args) => service.fetchModels(...args),
        get lastHeavyTermination() {
          return service.lastHeavyTermination;
        },
      };
    },
  };

  const spawn = (threads: number): Port => {
    const run = world.ports.length;
    const messages: ((event: { readonly data: unknown }) => void)[] = [];
    const errors: ((event: object) => void)[] = [];
    const reply = (data: SequenceReply): void => {
      if (port.terminated) return;
      for (const listener of messages) listener({ data });
    };
    const port: Port = {
      posted: [],
      terminated: false,
      threads,
      postMessage(message) {
        port.posted.push(message);
        if (message.type !== 'run') return;
        const stage = message.stage;
        const answer = world.answer(stage, run);
        setImmediate(() => {
          switch (answer.kind) {
            case 'product':
              reply({ type: 'phase', stage, phase: 'session', fraction: null });
              reply({ type: 'phase', stage, phase: 'infer', fraction: null });
              setTimeout(() => reply(productOf(stage, lock)), answer.afterMs ?? 0);
              return;
            case 'failed':
              reply({ type: 'phase', stage, phase: 'session', fraction: null });
              reply({ type: 'phase', stage, phase: 'infer', fraction: null });
              reply({ type: 'failed', stage, message: answer.message });
              return;
            case 'error':
              reply({ type: 'phase', stage, phase: 'session', fraction: null });
              if (!port.terminated) for (const listener of errors) listener({ message: answer.message });
              return;
            case 'hang':
              reply({ type: 'phase', stage, phase: 'session', fraction: null });
              reply({ type: 'phase', stage, phase: 'infer', fraction: null });
              return;
          }
        });
      },
      terminate() {
        port.terminated = true;
      },
      addEventListener(...args: ['message', (event: { readonly data: unknown }) => void] | ['error', (event: object) => void] | ['messageerror', () => void]) {
        if (args[0] === 'message') messages.push(args[1]);
        else if (args[0] === 'error') errors.push(args[1]);
      },
    };
    world.ports.push(port);
    return port;
  };
  return world;
}

/** A bitmap stand-in for node, which has no ImageBitmap. */
export type FakeBitmap = ImageBitmap & { closed: boolean };

export type InputsWorld = {
  readonly inputs: Inputs;
  /** Every URL fetched, in order. */
  readonly fetched: string[];
  /** The status the next fetch answers, 200 by default, or `hang` for a fetch that never answers. */
  status: number | 'hang';
  /** The bytes a 200 answers for `width` x `height`; the master's length by default. */
  bytes: (width: number, height: number) => number;
};

export function inputsWorld(clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>): InputsWorld {
  const world: InputsWorld = {
    fetched: [],
    status: 200,
    bytes: (width, height) => width * height * 4,
    inputs: createInputs({
      clock,
      fetch: (url, init) => {
        world.fetched.push(url);
        const query = new URL(url, 'http://h').searchParams;
        const size = world.bytes(Number(query.get('width')), Number(query.get('height')));
        const status = world.status;
        if (status === 'hang') {
          return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true }));
        }
        const response: InputResponse = { ok: status >= 200 && status < 300, status, arrayBuffer: async () => new ArrayBuffer(size) };
        return Promise.resolve(response);
      },
      makeBitmap: async (rgba, size) => {
        const bitmap: FakeBitmap = {
          width: size.width,
          height: size.height,
          closed: rgba.byteLength !== size.width * size.height * 4,
          close() {
            bitmap.closed = true;
          },
        };
        return bitmap;
      },
    }),
  };
  return world;
}
