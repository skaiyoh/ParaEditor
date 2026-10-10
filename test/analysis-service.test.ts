// src/analysis/service.ts, the analysis service, driven with a scripted
// worker port, a clock the test sets, and a stand-in for the model loader:
// the full [depth, encode] sequence, each failure at each point of a
// sequence, cancels and aborts before, during, and after a stage, a sequence
// started while another is alive, the termination record's three cases, the
// events and their fields, and fetchModels against each outcome of the
// loader. The browser scenarios in test/browser/scenarios/service.scenario.ts
// drive the same service on the real worker.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { parseLock, type ModelOp, type ParsedLock } from '../src/analysis/lock.ts';
import type { ModelLoader } from '../src/analysis/models.ts';
import type { SequenceReply, SequenceRequest } from '../src/analysis/protocol.ts';
import {
  createAnalysisService,
  type AnalysisError,
  type AnalysisEvent,
  type AnalysisService,
  type HeavyStage,
  type HeavyTermination,
  type SequenceListener,
  type SequenceWorkerPort,
} from '../src/analysis/service.ts';
import { isSceneId, type ModelId, type NonEmpty, type SceneId } from '../src/core/ids.ts';
import { err, ok, type Result } from '../src/core/result.ts';

type StageKind = HeavyStage['kind'];

let lock: ParsedLock;
before(async () => {
  const parsed = parseLock(JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  lock = parsed.value;
});

const SCENE: SceneId = (() => {
  const id = '00000000-0000-4000-8000-000000000000';
  if (!isSceneId(id)) throw new Error('not a scene id');
  return id;
})();

// ---------------------------------------------------------------- the port

/** A worker port the test scripts: it records what is posted and fires the events the test asks for. */
type ScriptedPort = SequenceWorkerPort & {
  readonly posted: SequenceRequest[];
  readonly transfers: Transferable[][];
  terminated: boolean;
  /** When set, postMessage throws this for a message it returns true for. */
  throwOn: ((message: SequenceRequest) => boolean) | null;
  reply(data: unknown): void;
  error(message: string | null): void;
  messageError(): void;
};

function scriptedPort(): ScriptedPort {
  const messages: ((event: { readonly data: unknown }) => void)[] = [];
  const errors: ((event: object) => void)[] = [];
  const messageErrors: (() => void)[] = [];
  const port: ScriptedPort = {
    posted: [],
    transfers: [],
    terminated: false,
    throwOn: null,
    postMessage(message, transfer) {
      if (port.throwOn?.(message) === true) throw new Error('DataCloneError: An ImageBitmap is detached and could not be cloned.');
      port.posted.push(message);
      port.transfers.push(transfer);
    },
    terminate() {
      port.terminated = true;
    },
    addEventListener(...args: ['message', (event: { readonly data: unknown }) => void] | ['error', (event: object) => void] | ['messageerror', () => void]) {
      if (args[0] === 'message') messages.push(args[1]);
      else if (args[0] === 'error') errors.push(args[1]);
      else messageErrors.push(args[1]);
    },
    reply(data) {
      for (const listener of messages) listener({ data });
    },
    error(message) {
      for (const listener of errors) listener(message === null ? {} : { message });
    },
    messageError() {
      for (const listener of messageErrors) listener();
    },
  };
  return port;
}

// ---------------------------------------------------------------- replies

const TIMINGS = { sessionMs: 10, inferMs: 20, wasmHighWaterBytes: 290_000_000 };

const phase = (stage: StageKind, which: 'session' | 'infer'): SequenceReply => ({ type: 'phase', stage, phase: which, fraction: null });

function depthReply(wasm = 290_000_000): SequenceReply {
  return { type: 'depth', map: { format: 'f32', size: { width: 2, height: 2 }, data: new Float32Array([0, 0.5, 0.75, 1]) }, stats: { p10: 0, median: 0.5, p90: 1 }, timings: { ...TIMINGS, wasmHighWaterBytes: wasm } };
}

function embeddingsReply(): SequenceReply {
  const tensor = (name: string): { name: string; dims: number[]; data: Float32Array } => ({ name, dims: [1, 2], data: new Float32Array([0.25, -0.25]) });
  return {
    type: 'embeddings',
    embeddings: { model: lock.ops.encode.model, tensors: [tensor('image_embeddings.0'), tensor('image_embeddings.1'), tensor('image_embeddings.2')] },
    timings: { ...TIMINGS, wasmHighWaterBytes: 794_000_000 },
  };
}

function plateReply(): SequenceReply {
  return { type: 'plate', image: { size: { width: 2, height: 1 }, data: new Uint8Array(6) }, timings: { ...TIMINGS, wasmHighWaterBytes: 474_000_000 } };
}

const productOf = (stage: StageKind): SequenceReply => (stage === 'depth' ? depthReply() : stage === 'encode' ? embeddingsReply() : plateReply());

// ---------------------------------------------------------------- the harness

/** A bitmap stand-in that records whether it was closed. */
type FakeBitmap = ImageBitmap & { readonly id: number; closed: boolean };

/** Each callback a listener received, in order, with what the service reported at that moment. */
type Call =
  | { readonly kind: 'phase'; readonly stage: StageKind; readonly phase: 'session' | 'infer' }
  | { readonly kind: 'depth' | 'embeddings' | 'plate' }
  | {
      readonly kind: 'failed';
      readonly stage: StageKind;
      readonly error: AnalysisError;
      readonly heavy: boolean;
      readonly terminated: boolean;
      readonly record: HeavyTermination | null;
    }
  | { readonly kind: 'done'; readonly heavy: boolean; readonly terminated: boolean; readonly record: HeavyTermination | null };

type Harness = {
  readonly service: AnalysisService;
  readonly ports: ScriptedPort[];
  readonly events: AnalysisEvent[];
  /** Every bitmap master() gave, in order. */
  readonly bitmaps: FakeBitmap[];
  setNow(ms: number): void;
  /** Makes every later spawn throw `e`, or spawn again when null. */
  failSpawn(e: Error | null): void;
  /** Starts a sequence, its listener recording into the returned calls; `master` may hold or fail a call. */
  run(stages: NonEmpty<HeavyStage>, options?: RunOptions): Started;
  /** Lets every pending promise settle. */
  settle(): Promise<void>;
};

type RunOptions = {
  readonly signal?: AbortSignal;
  /** The master for the nth call (0-based): `hold` waits until released, `reject` rejects, otherwise a fresh bitmap. */
  readonly master?: (call: number) => 'open' | 'hold' | 'reject';
  /** Called inside each callback, after it is recorded. */
  readonly inside?: (call: Call) => void;
};

type Started = {
  readonly calls: Call[];
  readonly port: ScriptedPort | undefined;
  /** Releases the held master calls, in order. */
  release(): void;
};

function harness(loader: Promise<Result<ModelLoader, AnalysisError>> = Promise.resolve(err({ kind: 'quota' }))): Harness {
  let now = 0;
  let spawnError: Error | null = null;
  const ports: ScriptedPort[] = [];
  const events: AnalysisEvent[] = [];
  const bitmaps: FakeBitmap[] = [];
  const service = createAnalysisService({
    clock: { now: () => now },
    diag: { log: (e) => events.push(e) },
    spawn: () => {
      if (spawnError !== null) throw spawnError;
      const port = scriptedPort();
      ports.push(port);
      return port;
    },
    spawnDecoder: () => {
      throw new Error('the sequence tests open no decoder; test/analysis-decoder.test.ts drives it');
    },
    ortBase: '/vendor/ort/1.30.0/',
    threads: 2,
    lock,
    loader,
  });
  const bitmap = (): FakeBitmap => {
    const b: FakeBitmap = {
      id: bitmaps.length,
      width: 4,
      height: 3,
      closed: false,
      close() {
        b.closed = true;
      },
    };
    bitmaps.push(b);
    return b;
  };
  const h: Harness = {
    service,
    ports,
    events,
    bitmaps,
    setNow: (ms) => {
      now = ms;
    },
    failSpawn: (e) => {
      spawnError = e;
    },
    run(stages, options = {}) {
      const calls: Call[] = [];
      const held: (() => void)[] = [];
      let masterCalls = 0;
      const record = (call: Call): void => {
        calls.push(call);
        options.inside?.(call);
      };
      const before = ports.length;
      const listener: SequenceListener = {
        onPhase: (stage, which) => record({ kind: 'phase', stage, phase: which }),
        onDepth: () => record({ kind: 'depth' }),
        onEmbeddings: () => record({ kind: 'embeddings' }),
        onPlate: () => record({ kind: 'plate' }),
        onFailed: (stage, error) =>
          record({ kind: 'failed', stage, error, heavy: service.alive.heavy, terminated: ports.at(-1)?.terminated ?? false, record: service.lastHeavyTermination }),
        onDone: () => record({ kind: 'done', heavy: service.alive.heavy, terminated: ports.at(-1)?.terminated ?? false, record: service.lastHeavyTermination }),
      };
      const master = (): Promise<ImageBitmap> => {
        const which = options.master?.(masterCalls) ?? 'open';
        masterCalls += 1;
        if (which === 'reject') return Promise.reject(new Error('createImageBitmap failed'));
        if (which === 'hold') return new Promise((resolve) => held.push(() => resolve(bitmap())));
        return Promise.resolve(bitmap());
      };
      service.runSequence(SCENE, stages, { master }, listener, options.signal ?? new AbortController().signal);
      return {
        calls,
        port: ports.length > before ? ports.at(-1) : undefined,
        release: () => {
          for (const resolve of held.splice(0)) resolve();
        },
      };
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
  return h;
}

/** The kinds of the posted requests, a run as `run <stage>`. */
const postedKinds = (port: ScriptedPort | undefined): string[] => (port?.posted ?? []).map((m) => (m.type === 'run' ? `run ${m.stage}` : m.type));

/** Answers the current run of `stage` with its two phases and its product. */
function answer(port: ScriptedPort | undefined, stage: StageKind): void {
  port?.reply(phase(stage, 'session'));
  port?.reply(phase(stage, 'infer'));
  port?.reply(productOf(stage));
}

/** Whether `b` went to a worker in a transfer list. */
const transferred = (h: Harness, b: FakeBitmap): boolean => h.ports.some((p) => p.transfers.some((t) => t.includes(b)));

const terminals = (calls: readonly Call[]): Call[] => calls.filter((c) => c.kind === 'failed' || c.kind === 'done');

const DEPTH: HeavyStage = { kind: 'depth' };
const ENCODE: HeavyStage = { kind: 'encode' };
const hole = (): HeavyStage => ({ kind: 'inpaint', hole: { format: 'u8', size: { width: 4, height: 3 }, data: new Uint8Array(12).fill(255) } });

// ---------------------------------------------------------------- the full sequence

test('[depth, encode]: one worker, one bitmap at a time, both products, end, terminate, the record, then onDone', async () => {
  const h = harness();
  h.setNow(1_000);
  const started = h.run([DEPTH, ENCODE]);
  const { port, calls } = started;
  assert.ok(port !== undefined);
  assert.equal(h.service.alive.heavy, true);
  assert.deepEqual(h.service.alive, { heavy: true, decoder: false });
  await h.settle();
  assert.deepEqual(postedKinds(port), ['init', 'run depth']);
  assert.deepEqual(port.posted[0], { type: 'init', ortBase: '/vendor/ort/1.30.0/', threads: 2 });
  assert.equal(h.bitmaps.length, 1, 'master() is called for the depth stage only, until its product');
  assert.deepEqual(port.transfers[1], [h.bitmaps[0]], 'the bitmap is transferred');

  h.setNow(1_250);
  answer(port, 'depth');
  await h.settle();
  assert.equal(h.bitmaps.length, 2);
  assert.deepEqual(postedKinds(port), ['init', 'run depth', 'run encode']);

  h.setNow(4_000);
  port.reply(phase('encode', 'session'));
  port.reply(phase('encode', 'infer'));
  h.setNow(6_500);
  port.reply(embeddingsReply());
  assert.deepEqual(postedKinds(port), ['init', 'run depth', 'run encode', 'end']);
  assert.equal(port.terminated, true);
  assert.deepEqual(calls, [
    { kind: 'phase', stage: 'depth', phase: 'session' },
    { kind: 'phase', stage: 'depth', phase: 'infer' },
    { kind: 'depth' },
    { kind: 'phase', stage: 'encode', phase: 'session' },
    { kind: 'phase', stage: 'encode', phase: 'infer' },
    { kind: 'embeddings' },
    { kind: 'done', heavy: false, terminated: true, record: { atMs: 6_500, largest: 'encode' } },
  ]);
  assert.deepEqual(h.service.lastHeavyTermination, { atMs: 6_500, largest: 'encode' });
  assert.equal(h.service.alive.heavy, false);
  assert.deepEqual(h.events, [
    { event: 'worker.spawn', worker: 'sequence', reason: 'depth,encode' },
    { event: 'stage.start', op: 'depth', ms: 0, wasmHighWaterBytes: null },
    { event: 'stage.end', op: 'depth', ms: 250, wasmHighWaterBytes: 290_000_000 },
    { event: 'stage.start', op: 'encode', ms: 0, wasmHighWaterBytes: null },
    { event: 'stage.end', op: 'encode', ms: 5_250, wasmHighWaterBytes: 794_000_000 },
    { event: 'worker.terminate', worker: 'sequence', reason: 'done' },
  ]);

  // A late reply, error, or abort after the end changes nothing.
  port.reply(depthReply());
  port.error('late');
  port.messageError();
  h.service.cancelHeavy();
  assert.equal(calls.length, 7);
  assert.equal(h.events.length, 6);
});

test('inpaint: the hole is cloned with the run, not transferred, and the plate is handed on', async () => {
  const h = harness();
  const stage = hole();
  const { port, calls } = h.run([stage]);
  await h.settle();
  const run = port?.posted[1];
  assert.ok(run?.type === 'run' && run.stage === 'inpaint');
  assert.equal(run.hole, stage.kind === 'inpaint' ? stage.hole : null);
  assert.deepEqual(port?.transfers[1], [h.bitmaps[0]], 'only the bitmap is in the transfer list');
  answer(port, 'inpaint');
  assert.deepEqual(calls.map((c) => c.kind), ['phase', 'phase', 'plate', 'done']);
  assert.deepEqual(h.service.lastHeavyTermination?.largest, 'inpaint');
});

// ---------------------------------------------------------------- failures

/** Where in a [depth, encode] sequence a failure lands. */
type Point = 'before-run' | 'depth-session' | 'depth-infer' | 'between' | 'encode-infer';

/** Drives a [depth, encode] sequence to `point`; the second master call is held at `between`. */
async function driveTo(h: Harness, point: Point, options: RunOptions = {}): Promise<Started> {
  const started = h.run([DEPTH, ENCODE], {
    ...options,
    master: options.master ?? ((call) => (point === 'before-run' && call === 0) || (point === 'between' && call === 1) ? 'hold' : 'open'),
  });
  const { port } = started;
  await h.settle();
  if (point === 'before-run') return started;
  port?.reply(phase('depth', 'session'));
  if (point === 'depth-session') return started;
  port?.reply(phase('depth', 'infer'));
  if (point === 'depth-infer') return started;
  port?.reply(depthReply());
  await h.settle();
  if (point === 'between') return started;
  port?.reply(phase('encode', 'session'));
  port?.reply(phase('encode', 'infer'));
  return started;
}

/** The stage a failure at `point` is attributed to, and the largest stage that had reported its infer phase. */
const AT: Record<Point, { readonly stage: StageKind; readonly ran: StageKind | null; readonly products: readonly Call['kind'][] }> = {
  'before-run': { stage: 'depth', ran: null, products: [] },
  'depth-session': { stage: 'depth', ran: null, products: [] },
  'depth-infer': { stage: 'depth', ran: 'depth', products: [] },
  between: { stage: 'encode', ran: 'depth', products: ['depth'] },
  'encode-infer': { stage: 'encode', ran: 'encode', products: ['depth'] },
};
const POINTS = Object.keys(AT).filter((p): p is Point => p in AT);

type Failure = { readonly name: string; readonly fire: (port: ScriptedPort) => void; readonly message: RegExp };
const FAILURES: readonly Failure[] = [
  { name: 'a failed reply', fire: (port) => port.reply({ type: 'failed', stage: 'depth', message: 'the run threw RangeError: out of memory' }), message: /^the run threw RangeError: out of memory$/ },
  { name: 'an error event', fire: (port) => port.error('Uncaught Error: boom'), message: /^the worker raised an error: Uncaught Error: boom$/ },
  { name: 'an error event without a message', fire: (port) => port.error(null), message: /^the worker raised an error: an error event without a message$/ },
  { name: 'a messageerror event', fire: (port) => port.messageError(), message: /^a reply from the worker could not be deserialized$/ },
  { name: 'a reply that does not parse', fire: (port) => port.reply({ type: 'depth', map: 'nope' }), message: /^a reply from the worker did not parse: / },
];

/** A record made before the sequence under test, so "unchanged" is visible as this object. */
async function priorRecord(h: Harness): Promise<HeavyTermination | null> {
  h.setNow(100);
  const { port } = h.run([hole()]);
  await h.settle();
  answer(port, 'inpaint');
  h.setNow(5_000);
  return h.service.lastHeavyTermination;
}

for (const failure of FAILURES) {
  for (const point of POINTS) {
    test(`${failure.name} at ${point}: one onFailed with worker for its stage, after the products that landed, the worker terminated, the record ${AT[point].ran === null ? 'unchanged' : `naming ${AT[point].ran}`}`, async () => {
      const h = harness();
      const prior = await priorRecord(h);
      assert.deepEqual(prior, { atMs: 100, largest: 'inpaint' });
      const started = await driveTo(h, point);
      const { port, calls } = started;
      assert.ok(port !== undefined);
      const eventsBefore = h.events.length;
      h.setNow(7_000);
      failure.fire(port);
      const expected = AT[point];
      const ended = terminals(calls);
      assert.equal(ended.length, 1);
      const [end] = ended;
      assert.ok(end?.kind === 'failed');
      assert.equal(end.stage, expected.stage);
      assert.ok(end.error.kind === 'worker' && end.error.op === expected.stage && expected.stage === end.stage);
      assert.match(end.error.message, failure.message);
      assert.deepEqual(calls.filter((c) => c.kind === 'depth' || c.kind === 'embeddings' || c.kind === 'plate').map((c) => c.kind), expected.products);
      assert.equal(port.terminated, true);
      assert.equal(end.terminated, true, 'terminated before onFailed');
      assert.equal(end.heavy, false);
      const record = expected.ran === null ? prior : { atMs: 7_000, largest: expected.ran };
      assert.deepEqual(end.record, record, 'the record is set before onFailed');
      if (expected.ran === null) assert.equal(h.service.lastHeavyTermination, prior, 'unchanged: the same object');
      assert.ok(!postedKinds(port).includes('end'));
      assert.deepEqual(h.events.slice(eventsBefore), [
        { event: 'stage.failed', op: expected.stage, error: end.error },
        { event: 'worker.terminate', worker: 'sequence', reason: 'failed' },
      ]);
      // A held master resolving after the end gives a bitmap that is closed and never posted.
      started.release();
      await h.settle();
      assert.ok(h.bitmaps.every((b) => b.closed || transferred(h, b)), 'every bitmap was transferred or closed');
      assert.equal(port.posted.filter((m) => m.type === 'run').length, point === 'before-run' ? 0 : point === 'depth-session' || point === 'depth-infer' ? 1 : point === 'between' ? 1 : 2);
      // Nothing after the end reaches the listener.
      const callsAtEnd = calls.length;
      port.reply(embeddingsReply());
      port.error('again');
      assert.equal(calls.length, callsAtEnd);
      assert.equal(terminals(calls).length, 1);
    });
  }
}

test('master() rejecting, for the first stage and between stages, fails that stage with worker', async () => {
  for (const [call, stage, products] of [[0, 'depth', []], [1, 'encode', ['depth']]] as const) {
    const h = harness();
    const { port, calls } = h.run([DEPTH, ENCODE], { master: (n) => (n === call ? 'reject' : 'open') });
    await h.settle();
    if (call === 1) {
      answer(port, 'depth');
      await h.settle();
    }
    const [end] = terminals(calls);
    assert.ok(end?.kind === 'failed' && end.error.kind === 'worker');
    assert.equal(end.stage, stage);
    assert.match(end.error.message, new RegExp(`^the master bitmap for the ${stage} stage could not be made: Error: createImageBitmap failed$`));
    assert.deepEqual(calls.filter((c) => c.kind === 'depth').map((c) => c.kind), products);
    assert.equal(port?.terminated, true);
    assert.equal(h.service.lastHeavyTermination?.largest ?? null, call === 1 ? 'depth' : null);
    assert.deepEqual(h.events.filter((e) => e.event === 'stage.failed').map((e) => e.event === 'stage.failed' && e.op), [stage]);
  }
});

test('a postMessage that throws, as a closed bitmap\'s does, fails the stage with worker and closes the bitmap', async () => {
  const h = harness();
  const { port, calls } = h.run([DEPTH, ENCODE]);
  assert.ok(port !== undefined);
  port.throwOn = (m) => m.type === 'run' && m.stage === 'encode';
  await h.settle();
  h.setNow(50);
  answer(port, 'depth');
  await h.settle();
  const [end] = terminals(calls);
  assert.ok(end?.kind === 'failed' && end.error.kind === 'worker');
  assert.equal(end.stage, 'encode');
  assert.equal(end.error.message, 'the encode run could not be posted: Error: DataCloneError: An ImageBitmap is detached and could not be cloned.');
  assert.deepEqual(calls.map((c) => c.kind), ['phase', 'phase', 'depth', 'failed']);
  assert.equal(h.bitmaps[1]?.closed, true);
  assert.equal(port.terminated, true);
  assert.deepEqual(h.service.lastHeavyTermination, { atMs: 50, largest: 'depth' });
  assert.deepEqual(
    h.events.map((e) => `${e.event}${'op' in e ? ` ${e.op}` : ''}`),
    ['worker.spawn', 'stage.start depth', 'stage.end depth', 'stage.start encode', 'stage.failed encode', 'worker.terminate'],
  );
});

test('an init that cannot be posted fails the first stage with worker, before any master', async () => {
  const h = harness();
  const calls: string[] = [];
  const port = scriptedPort();
  port.throwOn = (m) => m.type === 'init';
  const service = createAnalysisService({ clock: { now: () => 0 }, diag: { log: () => undefined }, spawn: () => port, spawnDecoder: () => assert.fail('no decoder here'), ortBase: '/o/', threads: 'default', lock, loader: Promise.resolve(err({ kind: 'quota' })) });
  let masters = 0;
  service.runSequence(SCENE, [ENCODE], { master: () => ((masters += 1), Promise.reject(new Error('unused'))) }, {
    onPhase: () => calls.push('phase'),
    onDepth: () => calls.push('depth'),
    onEmbeddings: () => calls.push('embeddings'),
    onPlate: () => calls.push('plate'),
    onFailed: (stage, error) => calls.push(`failed ${stage} ${error.kind === 'worker' ? error.message : error.kind}`),
    onDone: () => calls.push('done'),
  }, new AbortController().signal);
  await h.settle();
  assert.deepEqual(calls, ['failed encode init could not be posted: Error: DataCloneError: An ImageBitmap is detached and could not be cloned.']);
  assert.equal(masters, 0);
  assert.equal(port.terminated, true);
  assert.equal(service.alive.heavy, false);
});

test('a spawn that throws fails the first stage with worker, with no worker alive and no spawn event', () => {
  const h = harness();
  h.failSpawn(new Error('SecurityError: the script URL is not same-origin'));
  const { calls, port } = h.run([DEPTH, ENCODE]);
  assert.equal(port, undefined);
  assert.equal(h.service.alive.heavy, false);
  const [end] = terminals(calls);
  assert.ok(end?.kind === 'failed' && end.error.kind === 'worker');
  assert.equal(end.error.message, 'the sequence worker could not be started: Error: SecurityError: the script URL is not same-origin');
  assert.deepEqual(h.events, [{ event: 'stage.failed', op: 'depth', error: end.error }]);
});

test('an unexpected reply fails the stage with worker: a product of another stage, a phase of another stage, a reply while no run is posted', async () => {
  const cases: readonly { readonly name: string; readonly at: Point; readonly reply: SequenceReply; readonly stage: StageKind; readonly message: string }[] = [
    { name: 'embeddings to depth', at: 'depth-infer', reply: embeddingsReply(), stage: 'depth', message: 'the worker answered embeddings to the depth run' },
    { name: 'an encode phase during depth', at: 'depth-session', reply: phase('encode', 'infer'), stage: 'depth', message: 'the worker reported the encode stage\'s infer phase while depth was running' },
    { name: 'a depth product while encode\'s master is pending', at: 'between', reply: depthReply(), stage: 'encode', message: 'the worker sent a depth reply while no run was posted' },
    { name: 'a phase before any run', at: 'before-run', reply: phase('depth', 'session'), stage: 'depth', message: 'the worker sent a phase reply while no run was posted' },
  ];
  for (const c of cases) {
    const h = harness();
    const { port, calls } = await driveTo(h, c.at);
    port?.reply(c.reply);
    const [end] = terminals(calls);
    assert.ok(end?.kind === 'failed' && end.error.kind === 'worker', c.name);
    assert.equal(end.stage, c.stage, c.name);
    assert.equal(end.error.message, c.message, c.name);
    assert.equal(port?.terminated, true, c.name);
    assert.equal(h.service.lastHeavyTermination?.largest ?? null, AT[c.at].ran, `${c.name}: the infer of another stage is not counted`);
  }
});

// ---------------------------------------------------------------- cancels

for (const how of ['cancelHeavy', 'abort'] as const) {
  for (const point of POINTS) {
    test(`${how} at ${point}: one onFailed with cancelled for its stage, the worker terminated at once, the record ${AT[point].ran === null ? 'unchanged' : `naming ${AT[point].ran}`}`, async () => {
      const h = harness();
      const prior = await priorRecord(h);
      const controller = new AbortController();
      const started = await driveTo(h, point, { signal: controller.signal });
      const { port, calls } = started;
      assert.ok(port !== undefined);
      const eventsBefore = h.events.length;
      h.setNow(9_000);
      if (how === 'cancelHeavy') h.service.cancelHeavy();
      else controller.abort();
      const expected = AT[point];
      assert.deepEqual(terminals(calls), [
        { kind: 'failed', stage: expected.stage, error: { kind: 'cancelled' }, heavy: false, terminated: true, record: expected.ran === null ? prior : { atMs: 9_000, largest: expected.ran } },
      ]);
      assert.equal(port.terminated, true);
      assert.deepEqual(h.events.slice(eventsBefore), [
        { event: 'stage.failed', op: expected.stage, error: { kind: 'cancelled' } },
        { event: 'worker.terminate', worker: 'sequence', reason: 'cancelled' },
      ]);
      // The other way to cancel, a late reply, and a held master all change nothing more.
      const callsAtEnd = calls.length;
      controller.abort();
      h.service.cancelHeavy();
      port.reply(embeddingsReply());
      started.release();
      await h.settle();
      assert.equal(calls.length, callsAtEnd);
      assert.ok(h.bitmaps.every((b) => b.closed || transferred(h, b)), 'every bitmap was transferred or closed');
    });
  }
}

test('a cancel or an abort after the sequence ended does nothing; cancelHeavy with nothing alive does nothing', async () => {
  const h = harness();
  h.service.cancelHeavy();
  const controller = new AbortController();
  const { port, calls } = h.run([DEPTH], { signal: controller.signal });
  await h.settle();
  answer(port, 'depth');
  const events = h.events.length;
  controller.abort();
  h.service.cancelHeavy();
  assert.deepEqual(calls.map((c) => c.kind), ['phase', 'phase', 'depth', 'done']);
  assert.equal(h.events.length, events);
});

test('a signal already aborted ends the sequence in cancelled at once, with no worker started', () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  const { port, calls } = h.run([ENCODE, DEPTH], { signal: controller.signal });
  assert.equal(port, undefined);
  assert.equal(h.bitmaps.length, 0);
  assert.deepEqual(calls, [{ kind: 'failed', stage: 'encode', error: { kind: 'cancelled' }, heavy: false, terminated: false, record: null }]);
  assert.deepEqual(h.events, [{ event: 'stage.failed', op: 'encode', error: { kind: 'cancelled' } }]);
});

test('runSequence while a sequence is alive cancels it first: one terminal callback each, at most one worker alive', async () => {
  const h = harness();
  const first = await driveTo(h, 'depth-infer');
  h.setNow(3_000);
  const second = h.run([ENCODE]);
  assert.deepEqual(terminals(first.calls), [{ kind: 'failed', stage: 'depth', error: { kind: 'cancelled' }, heavy: false, terminated: true, record: { atMs: 3_000, largest: 'depth' } }]);
  assert.equal(first.port?.terminated, true);
  assert.notEqual(second.port, first.port);
  assert.equal(second.port?.terminated, false);
  assert.equal(h.service.alive.heavy, true);
  assert.equal(h.ports.filter((p) => !p.terminated).length, 1);
  assert.deepEqual(
    h.events.map((e) => (e.event === 'worker.spawn' || e.event === 'worker.terminate' ? `${e.event} ${e.reason}` : e.event)),
    ['worker.spawn depth,encode', 'stage.start', 'stage.failed', 'worker.terminate cancelled', 'worker.spawn encode'],
  );
  // A reply to the cancelled worker does not reach either listener.
  first.port?.reply(depthReply());
  await h.settle();
  answer(second.port, 'encode');
  assert.equal(terminals(first.calls).length, 1);
  assert.deepEqual(terminals(second.calls).map((c) => c.kind), ['done']);
});

test('a sequence started from the cancelled one\'s onFailed stands, and the outer start ends at once in cancelled without a worker', async () => {
  const h = harness();
  let inner: Started | null = null;
  const first = h.run([DEPTH], {
    inside: (call) => {
      if (call.kind === 'failed') inner = h.run([DEPTH]);
    },
  });
  await h.settle();
  const outer = h.run([ENCODE]);
  assert.ok(inner !== null);
  const innerStarted: Started = inner;
  assert.deepEqual(terminals(first.calls).map((c) => c.kind), ['failed']);
  assert.deepEqual(innerStarted.calls, []);
  assert.deepEqual(outer.calls, [{ kind: 'failed', stage: 'encode', error: { kind: 'cancelled' }, heavy: true, terminated: false, record: null }]);
  assert.equal(h.ports.length, 2, 'the outer start spawned no worker');
  assert.equal(h.ports.filter((p) => !p.terminated).length, 1);
  assert.equal(innerStarted.port?.terminated, false);
  assert.equal(h.service.alive.heavy, true);
  await h.settle();
  answer(innerStarted.port, 'depth');
  assert.deepEqual(terminals(innerStarted.calls).map((c) => c.kind), ['done']);
});

test('a listener that restarts on every cancel cannot keep a start from returning', async () => {
  const h = harness();
  let restarts = 0;
  const restart = (call: Call): void => {
    if (call.kind === 'failed' && restarts < 50) {
      restarts += 1;
      h.run([DEPTH], { inside: restart });
    }
  };
  h.run([DEPTH], { inside: restart });
  await h.settle();
  const outer = h.run([ENCODE]);
  assert.equal(restarts, 1, 'the outer start cancelled one sequence');
  assert.deepEqual(terminals(outer.calls).map((c) => (c.kind === 'failed' ? c.error.kind : c.kind)), ['cancelled']);
  assert.equal(h.ports.filter((p) => !p.terminated).length, 1);
});

test('a listener that cancels inside a product callback ends the sequence at the next stage, with no later stage posted', async () => {
  for (const how of ['cancelHeavy', 'runSequence'] as const) {
    const h = harness();
    const { port, calls } = h.run([DEPTH, ENCODE], {
      inside: (call) => {
        if (call.kind !== 'depth') return;
        if (how === 'cancelHeavy') h.service.cancelHeavy();
        else h.run([DEPTH]);
      },
    });
    await h.settle();
    answer(port, 'depth');
    await h.settle();
    assert.deepEqual(calls.map((c) => (c.kind === 'failed' ? `failed ${c.stage} ${c.error.kind}` : c.kind)), ['phase', 'phase', 'depth', 'failed encode cancelled'], how);
    assert.deepEqual(postedKinds(port), ['init', 'run depth'], how);
    assert.equal(h.bitmaps.length, how === 'cancelHeavy' ? 1 : 2, how);
    assert.deepEqual(
      h.events.slice(0, 5).map((e) => `${e.event}${'op' in e ? ` ${e.op}` : ''}`),
      ['worker.spawn', 'stage.start depth', 'stage.end depth', 'stage.failed encode', 'worker.terminate'],
      `${how}: depth ends once and is not failed`,
    );
  }
});

test('a cancel or a new sequence inside the last product\'s callback leaves the sequence done: the worker is already terminated', async () => {
  for (const how of ['cancelHeavy', 'runSequence'] as const) {
    const h = harness();
    h.setNow(70);
    const { port, calls } = h.run([DEPTH], {
      inside: (call) => {
        if (call.kind !== 'depth') return;
        assert.equal(port?.terminated, true, `${how}: terminated before the last product is handed on`);
        assert.deepEqual(h.service.lastHeavyTermination, { atMs: 70, largest: 'depth' });
        if (how === 'cancelHeavy') h.service.cancelHeavy();
        else h.run([ENCODE]);
      },
    });
    await h.settle();
    answer(port, 'depth');
    assert.deepEqual(calls.map((c) => c.kind), ['phase', 'phase', 'depth', 'done'], how);
    assert.deepEqual(
      h.events.slice(0, 4).map((e) => `${e.event}${'op' in e ? ` ${e.op}` : ''}`),
      ['worker.spawn', 'stage.start depth', 'stage.end depth', 'worker.terminate'],
      how,
    );
    assert.equal(h.service.alive.heavy, how === 'runSequence', how);
  }
});

// ---------------------------------------------------------------- the termination record

test('the record: unchanged by a worker that ran no stage, set at a terminate after an infer phase, before the terminal callback', async () => {
  const h = harness();
  // A worker that reported only its session phase.
  const a = await driveTo(h, 'depth-session');
  h.setNow(10);
  a.port?.reply({ type: 'failed', stage: 'depth', message: 'the depth session could not be created: no wasm' });
  assert.equal(h.service.lastHeavyTermination, null);
  // A worker that ran depth and then inpaint: inpaint is the larger.
  const b = h.run([DEPTH, hole()]);
  await h.settle();
  answer(b.port, 'depth');
  await h.settle();
  h.setNow(20);
  answer(b.port, 'inpaint');
  assert.deepEqual(h.service.lastHeavyTermination, { atMs: 20, largest: 'inpaint' });
  // A worker that ran encode, then failed inpaint's session: encode is the larger.
  const c = h.run([ENCODE, hole()]);
  await h.settle();
  answer(c.port, 'encode');
  await h.settle();
  c.port?.reply(phase('inpaint', 'session'));
  h.setNow(30);
  c.port?.error('out of memory');
  assert.deepEqual(h.service.lastHeavyTermination, { atMs: 30, largest: 'encode' });
  // A worker that ran depth and was cancelled during inpaint's session phase, before its infer: depth.
  const d = h.run([DEPTH, hole()]);
  await h.settle();
  answer(d.port, 'depth');
  await h.settle();
  d.port?.reply(phase('inpaint', 'session'));
  h.setNow(40);
  h.service.cancelHeavy();
  assert.deepEqual(h.service.lastHeavyTermination, { atMs: 40, largest: 'depth' });
  // A worker that ran encode and then inpaint, each past its infer phase: encode is the larger.
  const e = h.run([ENCODE, hole()]);
  await h.settle();
  answer(e.port, 'encode');
  await h.settle();
  h.setNow(50);
  answer(e.port, 'inpaint');
  assert.deepEqual(h.service.lastHeavyTermination, { atMs: 50, largest: 'encode' });
  // The callback of each saw its own record already set.
  assert.deepEqual(terminals(b.calls).map((x) => (x.kind === 'done' ? x.record : null)), [{ atMs: 20, largest: 'inpaint' }]);
  assert.deepEqual(terminals(d.calls).map((x) => (x.kind === 'failed' ? x.record : null)), [{ atMs: 40, largest: 'depth' }]);
});

// ---------------------------------------------------------------- fetchModels

function loaderOf(fetchModels: ModelLoader['fetchModels']): Promise<Result<ModelLoader, AnalysisError>> {
  return Promise.resolve(ok({ lockHash: 'h', cacheName: 'noisy-models-h', partialCacheName: 'noisy-models-h-partial', fetchModels }));
}

const fetchEvents = (events: readonly AnalysisEvent[]): string[] =>
  events.map((e) => (e.event === 'fetch.start' || e.event === 'fetch.end' ? `${e.event} ${e.model.split('@')[0] ?? ''}` : e.event));

test('fetchModels with a loader that failed to open resolves with its error, bracketed per model', async () => {
  const h = harness(Promise.resolve(err({ kind: 'quota' })));
  const result = await h.service.fetchModels(['depth', 'encode'], new AbortController().signal, () => undefined);
  assert.deepEqual(result, err({ kind: 'quota' }));
  assert.deepEqual(fetchEvents(h.events), ['fetch.start depth', 'fetch.start sam', 'fetch.end depth', 'fetch.end sam']);
});

test('fetchModels resolves with a failing fetch\'s error and passes progress through, bracketed per model', async () => {
  const seen: { ops: readonly ModelOp[]; signal: AbortSignal }[] = [];
  const progress: [ModelId, number][] = [];
  const failure: AnalysisError = { kind: 'download', model: lockModel('migan'), status: 500 };
  const h = harness(
    loaderOf(async (ops, signal, onProgress) => {
      seen.push({ ops, signal });
      onProgress(lockModel('migan'), 0.5);
      return err(failure);
    }),
  );
  const signal = new AbortController().signal;
  const result = await h.service.fetchModels(['inpaint'], signal, (model, fraction) => progress.push([model, fraction]));
  assert.deepEqual(result, err(failure));
  assert.deepEqual(seen, [{ ops: ['inpaint'], signal }]);
  assert.deepEqual(progress, [[lockModel('migan'), 0.5]]);
  assert.deepEqual(fetchEvents(h.events), ['fetch.start migan', 'fetch.end migan']);
});

test('fetchModels resolves ok on success; operations of one model bracket it once', async () => {
  const order: string[] = [];
  const h = harness(
    loaderOf(async () => {
      order.push('fetch');
      return ok(undefined);
    }),
  );
  const pending = h.service.fetchModels(['encode', 'decode'], new AbortController().signal, () => undefined);
  order.push(...fetchEvents(h.events));
  assert.deepEqual(await pending, ok(undefined));
  assert.deepEqual(order, ['fetch.start sam', 'fetch']);
  assert.deepEqual(fetchEvents(h.events), ['fetch.start sam', 'fetch.end sam']);
});

test('fetchModels rejects when the loader\'s fetch throws, and still logs fetch.end', async () => {
  const h = harness(loaderOf(() => Promise.reject(new Error('lock refused'))));
  await assert.rejects(h.service.fetchModels(['depth'], new AbortController().signal, () => undefined), /lock refused/);
  assert.deepEqual(fetchEvents(h.events), ['fetch.start depth', 'fetch.end depth']);
});

function lockModel(name: 'depth' | 'sam' | 'migan'): ModelId {
  const model = lock.lock.models[name];
  if (model === undefined) throw new Error(`the lock has no ${name}`);
  return model.modelId;
}

test('face handle consumes one frame, closes dropped frames, cancels on release and ignores stale replies', async () => {
  const posted: import('../src/analysis/protocol.ts').FaceRequest[] = [];
  const listeners: ((event: { data: unknown }) => void)[] = [];
  let terminated = 0;
  const events: AnalysisEvent[] = [];
  const port: import('../src/analysis/service.ts').FaceWorkerPort = {
    postMessage(message, transfer) { posted.push(message); if (message.type === 'track') assert.deepEqual(transfer, [message.frame]); },
    terminate() { terminated++; },
    addEventListener(...args: ['message', (event: { data: unknown }) => void] | ['error', (event: object) => void] | ['messageerror', () => void]) {
      if (args[0] === 'message') listeners.push(args[1]);
    },
  };
  const service = createAnalysisService({
    clock: { now: () => 0 }, diag: { log: (event) => events.push(event) },
    spawn: () => { throw new Error('No heavy worker expected.'); }, spawnDecoder: () => { throw new Error('No decoder expected.'); },
    spawnFaceTracker: () => port, ortBase: '/vendor/ort/1.30.0/', threads: 2, lock, loader: Promise.resolve(err({ kind: 'quota' })),
  });
  const tracker = service.openFaceTracker();
  assert.deepEqual(posted, [{ type: 'init', ortBase: '/vendor/ort/1.30.0/' }]);
  const reply = (data: unknown) => listeners.forEach((listener) => listener({ data }));
  reply({ type: 'ready' }); await tracker.ready;
  let closed = 0;
  const bitmap = (): ImageBitmap => ({ width: 320, height: 240, close() { closed++; } });
  const first = tracker.track(bitmap());
  assert.equal(await tracker.track(bitmap()), null);
  assert.equal(closed, 1, 'the dropped frame is closed');
  assert.equal(posted.length, 2, 'only one track posted');
  const request = posted[1]; assert.ok(request?.type === 'track');
  reply({ type: 'tracked', jobId: request.jobId, face: { center: { x: .7, y: .5 }, size: .3 } });
  assert.deepEqual(await first, { center: { x: .7, y: .5 }, size: .3 });
  const pending = tracker.track(bitmap()); const cancelled = assert.rejects(pending, /released/);
  tracker.release(); tracker.release(); await cancelled;
  assert.equal(terminated, 1);
  reply({ type: 'tracked', jobId: request.jobId, face: null });
  await assert.rejects(tracker.track(bitmap()), /released/);
  assert.equal(closed, 2, 'the frame offered after release is closed');
  assert.deepEqual(events.filter((event) => event.event === 'worker.terminate'), [{ event: 'worker.terminate', worker: 'face', reason: 'released' }]);
});

test('face init failure and malformed detection stop the worker and settle startup/tracking', async () => {
  for (const malformed of [false, true]) {
    let listener: (event: { data: unknown }) => void = () => undefined;
    let terminated = false;
    const port: import('../src/analysis/service.ts').FaceWorkerPort = {
      postMessage() {}, terminate() { terminated = true; },
      addEventListener(...args: ['message', (event: { data: unknown }) => void] | ['error', (event: object) => void] | ['messageerror', () => void]) {
        if (args[0] === 'message') listener = args[1];
      },
    };
    const service = createAnalysisService({ clock: { now: () => 0 }, diag: { log() {} },
      spawn: () => { throw new Error('No sequence.'); }, spawnDecoder: () => { throw new Error('No decode.'); }, spawnFaceTracker: () => port,
      ortBase: '/vendor/ort/1.30.0/', threads: 2, lock, loader: Promise.resolve(err({ kind: 'quota' })),
    });
    const tracker = service.openFaceTracker();
    if (malformed) {
      listener({ data: { type: 'ready' } }); await tracker.ready;
      const pending = tracker.track({ width: 320, height: 240, close() {} });
      const rejected = assert.rejects(pending, /center/);
      listener({ data: { type: 'tracked', jobId: 0, face: { center: { x: NaN, y: .5 }, size: .2 } } }); await rejected;
    } else {
      const rejected = assert.rejects(tracker.ready, /cache missing/);
      listener({ data: { type: 'failed', jobId: null, message: 'cache missing' } }); await rejected;
    }
    assert.equal(terminated, true);
    tracker.release();
  }
});
