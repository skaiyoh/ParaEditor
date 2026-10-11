// The real worker entry and request parser, with ORT replaced at its boundary.
// This exercises serialized scene replacement without allocating a wasm heap.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { parseLock, type ParsedLock } from '../src/analysis/lock.ts';
import { parseDecodeLifecycleReply, parseDecodeReply, type DecodeLifecycleReply, type DecodeReply, type DecodeRequest, type SamEmbeddings } from '../src/analysis/protocol.ts';
import { SAM_EMBEDDING_TENSORS } from '../src/analysis/stage-math.ts';
import { err, ok } from '../src/core/result.ts';

let script: string;
let lock: ParsedLock;
before(async () => {
  const root = path.join(import.meta.dirname, '..');
  const lockText = await readFile(path.join(root, 'models.lock.json'), 'utf8');
  const parsed = parseLock(JSON.parse(lockText));
  if (!parsed.ok) throw new Error(parsed.error);
  lock = parsed.value;
  const bundled = await build({
    entryPoints: [path.join(root, 'src/analysis/decode-worker.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    define: { NOISY_MODEL_LOCK: lockText },
    plugins: [{
      name: 'test-ort-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/ort-runtime\.ts$/ }, () => ({ path: 'ort-runtime', namespace: 'test-ort' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-ort' }, () => ({ contents: `
          export const { createSession, describeThrown, loadOrt, modelStore, releaseSession, runSession } = globalThis.testOrt;
        ` }));
      },
    }],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) throw new Error('the decoder worker test bundle has no output');
  script = output.text;
});

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function embeddings(marker = 0): SamEmbeddings {
  const tensor = (spec: typeof SAM_EMBEDDING_TENSORS[number]) => {
    const data = new Float32Array(spec.dims.reduce<number>((count, dim) => count * dim, 1));
    data[0] = marker;
    return { name: spec.name, dims: spec.dims, data };
  };
  return { model: lock.ops.decode.model, tensors: [tensor(SAM_EMBEDDING_TENSORS[0]), tensor(SAM_EMBEDDING_TENSORS[1]), tensor(SAM_EMBEDDING_TENSORS[2])] };
}

function harness() {
  const replies: DecodeReply[] = [];
  const errors: (() => void)[] = [];
  const order: string[] = [];
  const sceneMarkers: number[] = [];
  let loads = 0, stores = 0, creates = 0, live = 0, peak = 0;
  let releaseFailure = false, tensorFailure = false, runtimeFailure = false, sessionFailure = false;
  let releaseGate: Promise<void> = Promise.resolve();
  let createGate: Promise<void> = Promise.resolve();
  const self: { onmessage: ((event: { data: unknown }) => void) | null; onmessageerror: (() => void) | null; location: { origin: string }; postMessage(reply: unknown): void } = {
    onmessage: null,
    onmessageerror: null,
    location: { origin: 'https://demo.test' },
    postMessage(reply) {
      const parsed = parseDecodeReply(reply);
      if (!parsed.ok) throw new Error(parsed.error.detail);
      replies.push(parsed.value);
    },
  };
  class Tensor {
    readonly data: Float32Array | BigInt64Array;
    readonly dims: readonly number[];
    constructor(_kind: string, data: Float32Array | BigInt64Array, dims: readonly number[]) {
      if (tensorFailure) throw new Error('tensor failed');
      this.data = data;
      this.dims = dims;
      if (data instanceof Float32Array && dims.length === 4 && dims[1] === 32) sceneMarkers.push(data[0] ?? -1);
    }
  }
  const testOrt = {
    async loadOrt() { loads++; return runtimeFailure ? err('runtime failed') : ok({ ort: { Tensor }, wasmHighWaterBytes: () => 76_808_192 }); },
    async modelStore() { stores++; return {}; },
    async createSession() {
      if (sessionFailure) return err('session create failed');
      creates++; live++; peak = Math.max(peak, live); order.push(`open ${creates}`);
      await createGate;
      return ok({ session: { id: creates }, sessionMs: 4 });
    },
    async releaseSession(session: { id: number }) {
      order.push(`release ${session.id}`);
      await releaseGate;
      if (releaseFailure) return err('session release failed');
      live--; return ok(undefined);
    },
    async runSession() {
      return ok({ outputs: {
        iou_scores: { dims: [1, 1, 3], data: new Float32Array([0.9, 0.5, 0.1]) },
        pred_masks: { dims: [1, 1, 3, 256, 256], data: new Float32Array(3 * 256 * 256) },
      }, inferMs: 3 });
    },
    describeThrown: (thrown: unknown) => thrown instanceof Error ? thrown.message : String(thrown),
  };
  runInNewContext(script, {
    self, testOrt, crypto: { subtle: {} }, caches: {},
    ArrayBuffer, Float32Array, Uint8Array, BigInt64Array, Error, URL, MessagePort,
    setTimeout: (task: () => void) => { errors.push(task); },
  });
  return {
    replies, errors, order, sceneMarkers,
    send(request: DecodeRequest) { self.onmessage?.({ data: request }); },
    counts: () => ({ loads, stores, creates, live, peak }),
    failRelease: () => { releaseFailure = true; },
    failTensor: () => { tensorFailure = true; },
    failRuntime: () => { runtimeFailure = true; },
    failSession: () => { sessionFailure = true; },
    waitRelease: (gate: Promise<void>) => { releaseGate = gate; },
    waitCreate: (gate: Promise<void>) => { createGate = gate; },
  };
}

const init = (value: SamEmbeddings): Extract<DecodeRequest, { type: 'init' }> => ({ type: 'init', ortBase: '/ort/', embeddings: value, guide: { size: { width: 2, height: 1 }, data: new Uint8Array(6) } });

test('five scenes use one decoder runtime and never overlap sessions; release leaves no scene session', async () => {
  const h = harness();
  const value = embeddings();
  for (let index = 0; index < 5; index++) {
    h.send(init(value));
    h.send({ type: 'decode', jobId: index, points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }] });
    await tick();
    assert.equal(h.replies[index]?.type, 'decoded', JSON.stringify(h.replies[index]));
    assert.deepEqual(h.counts(), { loads: 1, stores: 1, creates: index + 1, live: 1, peak: 1 });
  }
  h.send({ type: 'release' });
  await tick();
  assert.deepEqual(h.counts(), { loads: 1, stores: 1, creates: 5, live: 0, peak: 1 });
  assert.equal(h.errors.length, 0);
});

test('replacement waits for session release and decodes after release require a fresh init', async () => {
  const h = harness();
  const value = embeddings();
  h.send(init(value));
  await tick();
  let resume: () => void = () => assert.fail('no release gate');
  h.waitRelease(new Promise<void>((resolve) => { resume = resolve; }));
  h.send(init(value));
  await tick();
  assert.deepEqual(h.order, ['open 1', 'release 1']);
  assert.equal(h.counts().creates, 1);
  resume();
  await tick();
  assert.deepEqual(h.order, ['open 1', 'release 1', 'open 2']);
  h.send({ type: 'release' });
  h.send({ type: 'decode', jobId: 6, points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }] });
  await tick();
  assert.deepEqual(h.replies.at(-1), { type: 'failed', jobId: 6, message: 'no init request came before this decode' });
  assert.equal(h.counts().live, 0);
});

test('failed release raises a fatal worker error and never opens another session', async () => {
  const h = harness();
  const value = embeddings();
  h.send(init(value));
  await tick();
  h.failRelease();
  h.send(init(value));
  await tick();
  assert.equal(h.counts().creates, 1);
  assert.equal(h.errors.length, 1);
  const [fatal] = h.errors;
  if (fatal === undefined) assert.fail('no worker error task');
  assert.throws(fatal, /the decoder could not release its session: session release failed/);
  h.send(init(value));
  await tick();
  assert.equal(h.counts().creates, 1);
});

test('failed tensor creation releases the session and raises a fatal error before any later scene can open', async () => {
  const h = harness();
  h.failTensor();
  h.send(init(embeddings()));
  await tick();
  assert.deepEqual(h.counts(), { loads: 1, stores: 1, creates: 1, live: 0, peak: 1 });
  assert.deepEqual(h.order, ['open 1', 'release 1']);
  assert.equal(h.errors.length, 1);
  const [fatal] = h.errors;
  if (fatal === undefined) assert.fail('no worker error task');
  assert.throws(fatal, /the decoder worker failed: tensor failed/);
  h.send(init(embeddings()));
  await tick();
  assert.equal(h.counts().creates, 1);
});

for (const failure of ['runtime', 'session'] as const) {
  test(`failed ${failure} initialization is fatal so a retry cannot reuse a poisoned backend`, async () => {
    const h = harness();
    if (failure === 'runtime') h.failRuntime();
    else h.failSession();
    const value = embeddings();
    h.send(init(value));
    await tick();
    assert.equal(h.errors.length, 1);
    const [fatal] = h.errors;
    if (fatal === undefined) assert.fail('no worker error task');
    assert.throws(fatal, failure === 'runtime' ? /the decoder worker failed: runtime failed/ : /the decoder worker failed: session create failed/);
    h.send(init(value));
    await tick();
    assert.deepEqual(h.counts(), { loads: 1, stores: 1, creates: 0, live: 0, peak: 0 });
  });
}

for (const awaiting of ['create', 'release'] as const) {
  test(`scene replacements while ${awaiting} awaits keep only the newest queued init and fail obsolete decodes once`, async () => {
    const h = harness();
    let resume: () => void = () => assert.fail('no runtime gate');
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    if (awaiting === 'create') h.waitCreate(gate);
    h.send(init(embeddings(1)));
    await tick();
    if (awaiting === 'release') {
      h.waitRelease(gate);
      h.send({ type: 'release' });
      await tick();
    }
    for (let marker = 2; marker <= 4; marker++) {
      h.send(init(embeddings(marker)));
      h.send({ type: 'decode', jobId: marker, points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }] });
      if (marker === 3) h.send({ type: 'release' });
    }
    h.send({ ...init(embeddings(5)), guide: { size: { width: 3, height: 2 }, data: new Uint8Array(18) } });
    h.send({ type: 'decode', jobId: 5, points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }] });
    assert.equal(h.counts().creates, 1, 'no queued obsolete scene can start while ORT awaits');
    assert.deepEqual(h.replies.map((reply) => [reply.type, reply.jobId]), [['failed', 2], ['failed', 3], ['failed', 4]]);
    resume();
    await tick();
    assert.deepEqual(h.counts(), { loads: 1, stores: 1, creates: 2, live: 1, peak: 1 });
    assert.deepEqual(h.sceneMarkers, [1, 5], 'obsolete scene tensors were never installed');
    assert.deepEqual(h.replies.map((reply) => [reply.type, reply.jobId]), [['failed', 2], ['failed', 3], ['failed', 4], ['decoded', 5]]);
    const newest = h.replies.at(-1);
    assert.ok(newest?.type === 'decoded');
    assert.deepEqual(newest.result.candidates[0].mask.size, { width: 3, height: 2 }, 'only the newest guide is used');
    assert.equal(h.errors.length, 0);
    h.send({ type: 'release' });
    await tick();
    assert.equal(h.counts().live, 0);
  });
}

test('the worker acknowledges initialization and release only after ORT completes, on its lifetime control channel', async () => {
  const h = harness();
  const lifecycle: DecodeLifecycleReply[] = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
    const parsed = parseDecodeLifecycleReply(data);
    if (!parsed.ok) throw new Error(parsed.error.detail);
    lifecycle.push(parsed.value);
  };
  try {
    h.send({ type: 'control', port: channel.port2 });
    let resumeCreate: () => void = () => assert.fail('no create gate');
    h.waitCreate(new Promise<void>((resolve) => { resumeCreate = resolve; }));
    h.send({ ...init(embeddings()), type: 'initialize', requestId: 17 });
    await tick();
    assert.deepEqual(lifecycle, []);
    assert.deepEqual(h.replies, [], 'lifecycle traffic never reaches Worker result observers');
    resumeCreate();
    await tick();
    await tick();
    assert.deepEqual(lifecycle, [{ type: 'initialized', requestId: 17, message: null }]);
    let resumeRelease: () => void = () => assert.fail('no release gate');
    h.waitRelease(new Promise<void>((resolve) => { resumeRelease = resolve; }));
    h.send({ type: 'dispose', requestId: 18 });
    await tick();
    assert.equal(lifecycle.length, 1, 'release is not acknowledged before the session is released');
    resumeRelease();
    await tick();
    await tick();
    assert.deepEqual(lifecycle, [
      { type: 'initialized', requestId: 17, message: null },
      { type: 'disposed', requestId: 18 },
    ]);
    assert.deepEqual(h.replies, []);
    assert.deepEqual(h.counts(), { loads: 1, stores: 1, creates: 1, live: 0, peak: 1 });
  } finally { channel.port1.close(); channel.port2.close(); }
});
