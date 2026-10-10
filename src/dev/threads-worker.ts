// The thread probe's worker: a dedicated module worker that imports the
// vendored ONNX Runtime Web at run time, points wasmPaths at the vendored
// directory, leaves numThreads at ORT's default, and uses the wasm execution
// provider. Before ORT loads it wraps this scope's Worker constructor, so
// every nested worker ORT starts (its pthread workers) is counted and a nested
// worker's error reaches the page.

import type { CspViolation, ProbeMessage } from './threads-protocol.ts';
import { matMulModel } from './tiny-model.ts';

/** Side of the square matrices: large enough that ORT's thread pool takes part. */
const SIZE = 256;

const post = (message: ProbeMessage): void => self.postMessage(message);

let pthreadWorkers = 0;
const NativeWorker = self.Worker;

class CountingWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const name = options?.name ?? '';
    if (name.startsWith('em-pthread')) pthreadWorkers += 1;
    post({ kind: 'nested-worker', name, pthreadWorkers });
    this.addEventListener('error', (event) => {
      const message = event instanceof ErrorEvent && event.message !== '' ? event.message : 'the worker script did not load';
      post({ kind: 'nested-worker-error', name, message, pthreadWorkers });
    });
  }
}
self.Worker = CountingWorker;

self.addEventListener('securitypolicyviolation', (event) => {
  // A browser without the event class in workers still reports to the server.
  if (typeof SecurityPolicyViolationEvent === 'undefined' || !(event instanceof SecurityPolicyViolationEvent)) return;
  const violation: CspViolation = {
    scope: 'worker',
    directive: event.effectiveDirective,
    blockedURI: event.blockedURI,
    disposition: event.disposition,
  };
  post({ kind: 'csp', violation });
});

let numThreads: number | null = null;
try {
  const ort = await import('noisy:vendor-ort');
  ort.env.wasm.wasmPaths = NOISY_ORT_DIR;
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(matMulModel(SIZE), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const sessionMs = performance.now() - t0;
  numThreads = ort.env.wasm.numThreads ?? null;
  const a = new ort.Tensor('float32', new Float32Array(SIZE * SIZE).fill(1), [SIZE, SIZE]);
  const b = new ort.Tensor('float32', new Float32Array(SIZE * SIZE).fill(2), [SIZE, SIZE]);
  const t1 = performance.now();
  const result = await session.run({ a, b });
  const runMs = performance.now() - t1;
  const data = result['c']?.data;
  // Every element of a row of ones times a column of twos is 2 * SIZE.
  const outputOk = data instanceof Float32Array && data.length === SIZE * SIZE && data.every((v) => v === 2 * SIZE);
  await session.release();
  post({ kind: 'completed', numThreads, pthreadWorkers, sessionMs, runMs, outputOk });
} catch (e) {
  post({ kind: 'failed', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), numThreads, pthreadWorkers });
}
