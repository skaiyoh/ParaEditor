// src/analysis/service.ts's decoder half, driven with scripted decode-worker
// ports and a clock the test sets: openDecoder and its init, decodes answered
// in and out of order, a failed reply, aborts before and while a decode is
// pending, release before, during, and after decodes and twice, reuse on
// openDecoder while a decoder is alive, fatal worker replacement, and an
// unparseable reply, spawn and postMessage throwing, and the events each path
// logs. A promise settles at most once; a decode resolving twice would show
// as a second stage.end or stage.failed in the event lists the tests assert.
// The browser scenarios in test/browser/scenarios/decoder.scenario.ts drive
// the same service on the real decode worker.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { parseLock, type ParsedLock } from '../src/analysis/lock.ts';
import type { DecodeReply, DecodeRequest, SamEmbeddings } from '../src/analysis/protocol.ts';
import { createAnalysisService, DECODER_TIMEOUT_MS, type AnalysisError, type AnalysisEvent, type AnalysisService, type DecodeResult, type Decoder, type DecodeWorkerPort } from '../src/analysis/service.ts';
import { isSceneId, type NonEmpty, type SceneId } from '../src/core/ids.ts';
import type { Rgb8 } from '../src/core/raster.ts';
import { err, type Result } from '../src/core/result.ts';
import type { TapPoint } from '../src/core/types.ts';

let lock: ParsedLock;
before(async () => {
  const parsed = parseLock(JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  lock = parsed.value;
});

const sceneId = (id: string): SceneId => {
  if (!isSceneId(id)) throw new Error('not a scene id');
  return id;
};
const SCENE = sceneId('00000000-0000-4000-8000-000000000000');
const OTHER_SCENE = sceneId('00000000-0000-4000-8000-000000000001');

// ---------------------------------------------------------------- the port

/** A decode-worker port the test scripts: it records what is posted and fires the events the test asks for. */
type ScriptedPort = DecodeWorkerPort & {
  readonly posted: DecodeRequest[];
  readonly transfers: Transferable[][];
  terminated: number;
  /** When set, postMessage throws for a message it returns true for. */
  throwOn: ((message: DecodeRequest) => boolean) | null;
  autoAcknowledge: boolean;
  reply(data: unknown): void;
  error(message: string | null): void;
  messageError(): void;
};

/** A synchronous channel avoids Node handles while exercising port ownership. */
class TestMessagePort extends EventTarget implements MessagePort {
  readonly [Symbol.toStringTag] = 'MessagePort';
  onmessage: MessagePort['onmessage'] = null;
  onmessageerror: MessagePort['onmessageerror'] = null;
  peer: TestMessagePort | null = null;
  closed = false;
  postMessage(data: unknown): void {
    const peer = this.peer;
    if (this.closed || peer === null || peer.closed) return;
    peer.onmessage?.call(peer, new MessageEvent('message', { data }));
  }
  start(): void {}
  close(): void { this.closed = true; }
}

function decoderChannel(): Pick<MessageChannel, 'port1' | 'port2'> {
  const port1 = new TestMessagePort(), port2 = new TestMessagePort();
  port1.peer = port2; port2.peer = port1;
  return { port1, port2 };
}

function scriptedPort(autoAcknowledge = true): ScriptedPort {
  const messages: ((event: { readonly data: unknown }) => void)[] = [];
  const errors: ((event: object) => void)[] = [];
  const messageErrors: (() => void)[] = [];
  const port: ScriptedPort = {
    posted: [],
    transfers: [],
    terminated: 0,
    throwOn: null,
    autoAcknowledge,
    postMessage(message, transfer) {
      if (port.throwOn?.(message) === true) throw new Error('DataCloneError: the message could not be cloned.');
      port.posted.push(message);
      port.transfers.push(transfer);
      if (port.autoAcknowledge && message.type === 'initialize') {
        const channel = port.posted.find((request) => request.type === 'control');
        if (channel?.type === 'control') channel.port.postMessage({ type: 'initialized', requestId: message.requestId, message: null });
      }
      if (port.autoAcknowledge && message.type === 'dispose') {
        const channel = port.posted.find((request) => request.type === 'control');
        if (channel?.type === 'control') channel.port.postMessage({ type: 'disposed', requestId: message.requestId });
      }
    },
    terminate() {
      port.terminated += 1;
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

// ---------------------------------------------------------------- values

function embeddings(): SamEmbeddings {
  const tensor = (name: string): { name: string; dims: number[]; data: Float32Array } => ({ name, dims: [1, 2], data: new Float32Array([0.25, -0.25]) });
  return { model: lock.ops.decode.model, tensors: [tensor('image_embeddings.0'), tensor('image_embeddings.1'), tensor('image_embeddings.2')] };
}

const GUIDE: Rgb8 = { size: { width: 2, height: 1 }, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };

const TAP: NonEmpty<TapPoint> = [{ at: { x: 0.25, y: 0.5 }, label: 'include' }];
const TWO_TAPS: NonEmpty<TapPoint> = [
  { at: { x: 0.25, y: 0.5 }, label: 'include' },
  { at: { x: 0.75, y: 0.5 }, label: 'exclude' },
];

/** A `decoded` reply for `jobId` whose first candidate's mask holds `marker`, so a test can tell results apart. */
function decoded(jobId: number, marker = 255, wasmHighWaterBytes = 90_000_000): DecodeReply {
  const mask = (byte: number): { format: 'u8'; size: { width: number; height: number }; data: Uint8Array } => ({ format: 'u8', size: { width: 2, height: 1 }, data: new Uint8Array([byte, 0]) });
  return {
    type: 'decoded',
    jobId,
    result: { candidates: [{ mask: mask(marker), score: 0.9 }, { mask: mask(0), score: 0.5 }, { mask: mask(0), score: 0.1 }] },
    timings: { sessionMs: 0, inferMs: 30, wasmHighWaterBytes },
  };
}

// ---------------------------------------------------------------- the harness

type Harness = {
  readonly service: AnalysisService;
  readonly ports: ScriptedPort[];
  readonly events: AnalysisEvent[];
  setNow(ms: number): void;
  /** Makes every later spawnDecoder throw `e`, or spawn again when null. */
  failSpawn(e: Error | null): void;
  /** Opens a decoder on fresh embeddings and the guide. */
  open(scene?: SceneId): Decoder;
};

function harness(): Harness {
  let now = 0;
  let spawnError: Error | null = null;
  const ports: ScriptedPort[] = [];
  const events: AnalysisEvent[] = [];
  const service = createAnalysisService({
    clock: { now: () => now },
    diag: { log: (e) => events.push(e) },
    spawn: () => assert.fail('the decoder tests run no sequence'),
    spawnDecoder: () => {
      if (spawnError !== null) throw spawnError;
      const port = scriptedPort();
      ports.push(port);
      return port;
    },
    decoderChannel,
    ortBase: '/vendor/ort/1.30.0/',
    threads: 2,
    lock,
    loader: Promise.resolve(err({ kind: 'quota' })),
  });
  return {
    service,
    ports,
    events,
    setNow: (ms) => {
      now = ms;
    },
    failSpawn: (e) => {
      spawnError = e;
    },
    open: (scene = SCENE) => service.openDecoder({ scene, embeddings: embeddings(), guide: GUIDE }),
  };
}

/** Lets every pending promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A decode's promise and its outcome once it settles; a test reads the outcome after `settle()`, so `null` there means it never settled. */
type Watched = { readonly promise: Promise<Result<DecodeResult, AnalysisError>>; outcome: Result<DecodeResult, AnalysisError> | null };

function watch(promise: Promise<Result<DecodeResult, AnalysisError>>): Watched {
  const watched: Watched = { promise, outcome: null };
  void promise.then((outcome) => {
    watched.outcome = outcome;
  });
  return watched;
}

/** The outcome as text: `ok <first mask byte>`, `worker <message>`, or `cancelled`; `pending` before it settles. */
function outcomeOf(watched: Watched): string {
  const outcome = watched.outcome;
  if (outcome === null) return 'pending';
  if (outcome.ok) return `ok ${outcome.value.candidates[0].mask.data[0] ?? 'none'}`;
  return outcome.error.kind === 'worker' ? `worker ${outcome.error.op}: ${outcome.error.message}` : outcome.error.kind;
}

/** Each event as its name and its worker and reason, its op, or its op and error kind. */
const eventKinds = (events: readonly AnalysisEvent[]): string[] =>
  events.map((e) => {
    if (e.event === 'worker.spawn' || e.event === 'worker.terminate') return `${e.event} ${e.worker} ${e.reason}`;
    if (e.event === 'stage.failed') return `stage.failed ${e.op} ${e.error.kind}`;
    if (e.event === 'stage.start' || e.event === 'stage.end') return `${e.event} ${e.op}`;
    return e.event;
  });

const decodesPosted = (port: ScriptedPort | undefined): Extract<DecodeRequest, { readonly type: 'decode' }>[] =>
  (port?.posted ?? []).filter((m): m is Extract<DecodeRequest, { readonly type: 'decode' }> => m.type === 'decode');

// ---------------------------------------------------------------- tests

test('openDecoder spawns one worker, posts init with the embeddings and the guide cloned, and alive.decoder is true until release', async () => {
  const h = harness();
  assert.equal(h.service.alive.decoder, false);
  const input = { scene: SCENE, embeddings: embeddings(), guide: GUIDE };
  const decoder = h.service.openDecoder(input);
  assert.equal(decoder.scene, SCENE);
  assert.equal(h.ports.length, 1);
  assert.equal(h.service.alive.decoder, true);
  assert.equal(h.service.alive.heavy, false);
  const port = h.ports[0];
  const initialize = port?.posted.find((message) => message.type === 'initialize');
  assert.deepEqual(initialize, { type: 'initialize', requestId: initialize?.requestId, ortBase: '/vendor/ort/1.30.0/', embeddings: input.embeddings, guide: GUIDE });
  assert.deepEqual(port?.transfers.at(-1), [], 'the embeddings and guide are copied');
  assert.equal(port?.posted.filter((message) => message.type === 'control').length, 1, 'one control channel per worker');
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open']);
  decoder.release();
  assert.equal(h.service.alive.decoder, false);
  assert.equal(port?.terminated, 0);
  assert.equal(port?.posted.at(-1)?.type, 'dispose');
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open']);
});

test('a decode posts its points with a new jobId and resolves ok with the parsed result; stage.start, then stage.end with its time and high-water mark', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  h.setNow(100);
  const first = watch(decoder.decode(TWO_TAPS, new AbortController().signal));
  const [request] = decodesPosted(port);
  assert.deepEqual(request, { type: 'decode', jobId: request?.jobId, points: TWO_TAPS });
  assert.deepEqual(port?.transfers.at(-1), []);
  h.setNow(160);
  port?.reply(decoded(request?.jobId ?? -1, 7, 91_000_000));
  await settle();
  assert.equal(outcomeOf(first), 'ok 7');
  const end = h.events.find((e) => e.event === 'stage.end');
  assert.deepEqual(end, { event: 'stage.end', op: 'decode', ms: 60, wasmHighWaterBytes: 91_000_000 });
  const start = h.events.find((e) => e.event === 'stage.start');
  assert.deepEqual(start, { event: 'stage.start', op: 'decode', ms: 0, wasmHighWaterBytes: null });
  assert.equal(h.service.alive.decoder, true, 'a decode leaves the decoder alive');
  // The result is the parsed reply: a frozen copy of the structure around the received arrays.
  assert.equal(first.outcome?.ok === true && Object.isFrozen(first.outcome.value), true);
});

test('decodes answered out of order each resolve with their own reply; jobIds differ', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  const b = watch(decoder.decode(TAP, new AbortController().signal));
  const [ra, rb] = decodesPosted(port);
  assert.notEqual(ra?.jobId, rb?.jobId);
  port?.reply(decoded(rb?.jobId ?? -1, 2));
  port?.reply(decoded(ra?.jobId ?? -1, 1));
  await settle();
  assert.deepEqual([outcomeOf(a), outcomeOf(b)], ['ok 1', 'ok 2']);
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.start decode', 'stage.start decode', 'stage.end decode', 'stage.end decode']);
});

test('a failed reply resolves that decode with worker and its message; the decoder stays alive and decodes again', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  const [ra] = decodesPosted(port);
  port?.reply({ type: 'failed', jobId: ra?.jobId, message: 'the run threw RangeError: decode failed' });
  await settle();
  assert.equal(outcomeOf(a), 'worker decode: the run threw RangeError: decode failed');
  assert.equal(h.service.alive.decoder, true);
  assert.equal(port?.terminated, 0);
  const b = watch(decoder.decode(TAP, new AbortController().signal));
  port?.reply(decoded(decodesPosted(port)[1]?.jobId ?? -1, 3));
  await settle();
  assert.equal(outcomeOf(b), 'ok 3');
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.start decode', 'stage.failed decode worker', 'stage.start decode', 'stage.end decode']);
});

test('a signal already aborted resolves cancelled at once, posting nothing and logging only stage.failed', async () => {
  const h = harness();
  const decoder = h.open();
  const controller = new AbortController();
  controller.abort();
  const a = watch(decoder.decode(TAP, controller.signal));
  await settle();
  assert.equal(outcomeOf(a), 'cancelled');
  assert.deepEqual(decodesPosted(h.ports[0]), []);
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.failed decode cancelled']);
});

test('an abort while a decode is pending resolves it cancelled; the late reply is dropped and the next decode resolves with its own', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  const controller = new AbortController();
  const a = watch(decoder.decode(TAP, controller.signal));
  controller.abort();
  await settle();
  assert.equal(outcomeOf(a), 'cancelled');
  const b = watch(decoder.decode(TAP, new AbortController().signal));
  const [ra, rb] = decodesPosted(port);
  port?.reply(decoded(ra?.jobId ?? -1, 1));
  await settle();
  assert.equal(outcomeOf(a), 'cancelled', 'the late reply changes nothing');
  assert.equal(outcomeOf(b), 'pending', 'the late reply is not the next decode\'s');
  port?.reply(decoded(rb?.jobId ?? -1, 2));
  await settle();
  assert.equal(outcomeOf(b), 'ok 2');
  controller.abort();
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.start decode', 'stage.failed decode cancelled', 'stage.start decode', 'stage.end decode']);
});

test('an abort after a decode resolved logs nothing more', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  const controller = new AbortController();
  const a = watch(decoder.decode(TAP, controller.signal));
  port?.reply(decoded(decodesPosted(port)[0]?.jobId ?? -1, 4));
  await settle();
  controller.abort();
  decoder.release();
  await settle();
  assert.equal(outcomeOf(a), 'ok 4');
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.start decode', 'stage.end decode']);
  assert.equal(port?.posted.at(-1)?.type, 'dispose');
});

test('release while decodes are pending resolves each cancelled, releases the session once, and every later decode resolves cancelled; a reply after it is dropped', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  const b = watch(decoder.decode(TAP, new AbortController().signal));
  decoder.release();
  assert.equal(port?.terminated, 0);
  assert.equal(h.service.alive.decoder, false);
  port?.reply(decoded(decodesPosted(port)[0]?.jobId ?? -1));
  port?.reply(decoded(decodesPosted(port)[1]?.jobId ?? -1));
  const c = watch(decoder.decode(TAP, new AbortController().signal));
  decoder.release();
  await settle();
  assert.deepEqual([outcomeOf(a), outcomeOf(b), outcomeOf(c)], ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(port?.terminated, 0, 'release keeps the runtime alive');
  assert.equal(port?.posted.filter((message) => message.type === 'dispose').length, 1, 'a second release does nothing');
  assert.equal(decodesPosted(port).length, 2, 'nothing is posted after release');
  assert.deepEqual(eventKinds(h.events), [
    'worker.spawn decode open',
    'stage.start decode',
    'stage.start decode',
    'stage.failed decode cancelled',
    'stage.failed decode cancelled',
    'stage.failed decode cancelled',
  ]);
});

test('release before any decode: the decode resolves cancelled without being posted', async () => {
  const h = harness();
  const decoder = h.open();
  decoder.release();
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  await settle();
  assert.equal(outcomeOf(a), 'cancelled');
  assert.deepEqual(h.ports[0]?.posted.map((m) => m.type), ['control', 'initialize', 'dispose']);
});

for (const [name, fire, message] of [
  ['an error event', (port: ScriptedPort) => port.error('Uncaught Error: the decode worker cannot read a request: (message): x'), 'the worker raised an error: Uncaught Error: the decode worker cannot read a request: (message): x'],
  ['an error event without a message', (port: ScriptedPort) => port.error(null), 'the worker raised an error: an error event without a message'],
  ['a messageerror event', (port: ScriptedPort) => port.messageError(), 'a reply from the worker could not be deserialized'],
  ['an unparseable reply', (port: ScriptedPort) => port.reply({ type: 'decoded', jobId: 0 }), 'a reply from the worker did not parse: '],
] as const) {
  test(`${name} fails every pending decode with worker, terminates the worker, and later decodes resolve worker naming that the decoder stopped`, async () => {
    const h = harness();
    const decoder = h.open();
    const port = h.ports[0];
    if (port === undefined) return assert.fail('no port');
    const a = watch(decoder.decode(TAP, new AbortController().signal));
    const b = watch(decoder.decode(TAP, new AbortController().signal));
    fire(port);
    assert.equal(port.terminated, 1);
    assert.equal(h.service.alive.decoder, false);
    port.reply(decoded(decodesPosted(port)[0]?.jobId ?? -1));
    const c = watch(decoder.decode(TAP, new AbortController().signal));
    await settle();
    for (const pending of [a, b]) assert.ok(outcomeOf(pending).startsWith(`worker decode: ${message}`), outcomeOf(pending));
    assert.ok(outcomeOf(c).startsWith(`worker decode: the decoder stopped: ${message}`), outcomeOf(c));
    assert.equal(decodesPosted(port).length, 2, 'nothing is posted after the decoder stopped');
    decoder.release();
    const d = watch(decoder.decode(TAP, new AbortController().signal));
    await settle();
    assert.equal(outcomeOf(d), 'cancelled', 'after release a stopped decoder\'s decodes resolve cancelled');
    assert.equal(port.terminated, 1, 'release does not terminate the worker again');
    assert.deepEqual(eventKinds(h.events), [
      'worker.spawn decode open',
      'stage.start decode',
      'stage.start decode',
      'worker.terminate decode failed',
      'stage.failed decode worker',
      'stage.failed decode worker',
      'stage.failed decode worker',
      'stage.failed decode cancelled',
    ]);
  });
}

test('openDecoder replaces the scene on the same worker: old pending and later decodes resolve cancelled, and the new one decodes', async () => {
  const h = harness();
  const old = h.open();
  const oldPort = h.ports[0];
  const pending = watch(old.decode(TAP, new AbortController().signal));
  const next = h.open(OTHER_SCENE);
  const newPort = h.ports[0];
  assert.equal(h.ports.length, 1);
  assert.equal(oldPort?.terminated, 0);
  assert.equal(newPort?.terminated, 0);
  assert.equal(h.service.alive.decoder, true);
  assert.equal(next.scene, OTHER_SCENE);
  const later = watch(old.decode(TAP, new AbortController().signal));
  old.release();
  assert.equal(newPort?.terminated, 0, 'releasing the replaced handle leaves the new decoder alone');
  const fresh = watch(next.decode(TAP, new AbortController().signal));
  oldPort?.reply(decoded(decodesPosted(oldPort)[0]?.jobId ?? -1, 5));
  const request = decodesPosted(newPort).at(-1);
  assert.ok(request !== undefined && request.jobId !== decodesPosted(oldPort)[0]?.jobId, 'jobIds are not reused across decoders');
  await settle();
  assert.equal(outcomeOf(fresh), 'pending', 'the old scene reply cannot answer the new scene');
  newPort?.reply(decoded(request?.jobId ?? -1, 9));
  await settle();
  assert.deepEqual([outcomeOf(pending), outcomeOf(later), outcomeOf(fresh)], ['cancelled', 'cancelled', 'ok 9']);
  assert.equal(h.service.alive.decoder, true);
  assert.deepEqual(eventKinds(h.events), [
    'worker.spawn decode open',
    'stage.start decode',
    'stage.failed decode cancelled',
    'stage.failed decode cancelled',
    'stage.start decode',
    'stage.end decode',
  ]);
});

test('a spawnDecoder that throws after a fatal idle-worker error: no decoder is alive and each decode names why', async () => {
  const h = harness();
  const old = h.open();
  old.release();
  h.ports[0]?.error('the resident decoder failed');
  h.failSpawn(new Error('Worker is not defined'));
  const decoder = h.open();
  assert.equal(h.ports[0]?.terminated, 1, 'the fatal worker was terminated before the spawn');
  assert.equal(h.service.alive.decoder, false);
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  const b = watch(old.decode(TAP, new AbortController().signal));
  await settle();
  assert.equal(outcomeOf(a), 'worker decode: the decoder stopped: the decode worker could not be started: Error: Worker is not defined');
  assert.equal(outcomeOf(b), 'cancelled');
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'worker.terminate decode failed', 'stage.failed decode worker', 'stage.failed decode cancelled']);
  h.failSpawn(null);
  h.open();
  assert.equal(h.service.alive.decoder, true, 'a later openDecoder spawns again');
});

test('an init that cannot be posted stops the decoder: the worker is terminated and each decode resolves worker naming it', async () => {
  const port = scriptedPort();
  port.throwOn = (m) => m.type === 'initialize';
  const service = createAnalysisService({
    clock: { now: () => 0 },
    diag: { log: () => undefined },
    spawn: () => assert.fail('no sequence'),
    spawnDecoder: () => port,
    decoderChannel,
    ortBase: '/o/',
    threads: 'default',
    lock,
    loader: Promise.resolve(err({ kind: 'quota' })),
  });
  const decoder = service.openDecoder({ scene: SCENE, embeddings: embeddings(), guide: GUIDE });
  assert.equal(port.terminated, 1);
  assert.equal(service.alive.decoder, false);
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  await settle();
  assert.equal(outcomeOf(a), 'worker decode: the decoder stopped: init could not be posted: Error: DataCloneError: the message could not be cloned.');
});

test('a decode that cannot be posted resolves worker and leaves nothing pending; the decoder stays alive, decodes again, and its release fails no decode a second time', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  if (port === undefined) return assert.fail('no port');
  port.throwOn = (m) => m.type === 'decode';
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  port.throwOn = null;
  const b = watch(decoder.decode(TAP, new AbortController().signal));
  port.reply(decoded(decodesPosted(port)[0]?.jobId ?? -1, 5));
  await settle();
  assert.equal(outcomeOf(a), 'worker decode: the decode could not be posted: Error: DataCloneError: the message could not be cloned.');
  assert.equal(outcomeOf(b), 'ok 5');
  assert.equal(h.service.alive.decoder, true);
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.start decode', 'stage.failed decode worker', 'stage.start decode', 'stage.end decode']);
  decoder.release();
  await settle();
  assert.deepEqual(eventKinds(h.events).slice(5), [], 'the release finds no decode pending');
  assert.equal(port.posted.at(-1)?.type, 'dispose');
  assert.equal(port.terminated, 0);
});

test('a reply naming no pending decode is dropped, and a reply answered twice resolves once', async () => {
  const h = harness();
  const decoder = h.open();
  const port = h.ports[0];
  const a = watch(decoder.decode(TAP, new AbortController().signal));
  const jobId = decodesPosted(port)[0]?.jobId ?? -1;
  port?.reply(decoded(jobId + 1000, 1));
  port?.reply(decoded(jobId, 2));
  port?.reply({ type: 'failed', jobId, message: 'a second answer' });
  await settle();
  assert.equal(outcomeOf(a), 'ok 2');
  assert.equal(h.service.alive.decoder, true);
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'stage.start decode', 'stage.end decode']);
});

test('the decoder and the sequence worker are independent: alive.heavy stays false and lastHeavyTermination null', () => {
  const h = harness();
  const decoder = h.open();
  assert.deepEqual(h.service.alive, { heavy: false, decoder: true });
  decoder.release();
  assert.deepEqual(h.service.alive, { heavy: false, decoder: false });
  assert.equal(h.service.lastHeavyTermination, null);
});

test('five project opens reuse one decoder worker while old scene handles and replies cannot affect the current scene', async () => {
  const h = harness();
  let previous: Decoder | null = null;
  for (let index = 0; index < 5; index++) {
    const current = h.open(sceneId(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    const port = h.ports[0];
    assert.equal(h.ports.length, 1);
    assert.equal(port?.terminated, 0);
    previous?.release();
    const stale: ReturnType<typeof watch> | null = previous === null ? null : watch(previous.decode(TAP, new AbortController().signal));
    const fresh = watch(current.decode(TAP, new AbortController().signal));
    const request = decodesPosted(port).at(-1);
    if (request === undefined) assert.fail('no decode request');
    port?.reply(decoded(request.jobId, index));
    await settle();
    if (stale !== null) assert.equal(outcomeOf(stale), 'cancelled');
    assert.equal(outcomeOf(fresh), `ok ${index}`);
    assert.equal(h.service.alive.decoder, true);
    previous = current;
  }
  const port = h.ports[0];
  assert.equal(port?.posted.filter((request) => request.type === 'initialize').length, 5);
  assert.equal(port?.posted.filter((request) => request.type === 'dispose').length, 4);
  assert.equal(port?.posted.filter((request) => request.type === 'control').length, 1);
  assert.equal(h.events.filter((event) => event.event === 'worker.spawn').length, 1);
  assert.equal(h.events.filter((event) => event.event === 'worker.terminate').length, 0);
  previous?.release();
  assert.equal(h.service.alive.decoder, false);
  assert.equal(port?.terminated, 0);
});

test('a fatal decoder worker error terminates once and the next open creates exactly one replacement', async () => {
  const h = harness();
  const old = h.open();
  const oldPort = h.ports[0];
  const pending = watch(old.decode(TAP, new AbortController().signal));
  oldPort?.error('decoder backend initialization failed');
  assert.equal(oldPort?.terminated, 1);
  assert.equal(h.service.alive.decoder, false);
  const replacement = h.open(OTHER_SCENE);
  const newPort = h.ports[1];
  const fresh = watch(replacement.decode(TAP, new AbortController().signal));
  oldPort?.reply(decoded(decodesPosted(oldPort)[0]?.jobId ?? -1, 4));
  oldPort?.error('late old-worker error');
  oldPort?.messageError();
  old.release();
  newPort?.reply(decoded(decodesPosted(newPort)[0]?.jobId ?? -1, 8));
  await settle();
  assert.ok(outcomeOf(pending).includes('decoder backend initialization failed'));
  assert.equal(outcomeOf(fresh), 'ok 8');
  assert.equal(h.ports.length, 2);
  assert.equal(oldPort?.terminated, 1);
  assert.equal(newPort?.terminated, 0);
  h.open(SCENE);
  assert.equal(h.ports.length, 2, 'the replacement is reused');
});

test('a release that cannot be posted is fatal and the next decoder open replaces its worker', () => {
  const h = harness();
  const old = h.open();
  const port = h.ports[0];
  if (port === undefined) assert.fail('no port');
  port.throwOn = (message) => message.type === 'dispose';
  old.release();
  assert.equal(h.service.alive.decoder, false);
  assert.equal(port.terminated, 1);
  h.open(OTHER_SCENE);
  assert.equal(h.ports.length, 2);
  assert.equal(h.service.alive.decoder, true);
  assert.deepEqual(eventKinds(h.events), ['worker.spawn decode open', 'worker.terminate decode failed', 'worker.spawn decode open']);
});

/** The real service owns deadlines even when the worker cannot run a task. */
function deadlineHarness() {
  let now = 0, nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const callbacks: (() => void)[] = [];
  const ports: ScriptedPort[] = [];
  const events: AnalysisEvent[] = [];
  const service = createAnalysisService({
    clock: {
      now: () => now,
      setTimeout(callback, ms) {
        callbacks.push(callback);
        const id = nextTimer++;
        timers.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    },
    diag: { log: (event) => events.push(event) },
    spawn: () => assert.fail('no sequence worker'),
    spawnDecoder() { const port = scriptedPort(false); ports.push(port); return port; },
    decoderChannel,
    ortBase: '/ort/', threads: 'default', lock,
    loader: Promise.resolve(err({ kind: 'quota' })),
  });
  return {
    service, ports, events, callbacks,
    open: (scene = SCENE) => service.openDecoder({ scene, embeddings: embeddings(), guide: GUIDE }),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
        if (next === undefined) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = until;
    },
    pendingTimers: () => timers.size,
  };
}

function acknowledge(port: ScriptedPort | undefined, operation: 'initialize' | 'dispose'): void {
  const request = port?.posted.findLast((message) => Reflect.get(message, 'type') === operation);
  // Legacy workers have no lifecycle acknowledgement. Keeping this boundary
  // lets the regression exercise the original service as well as the fix.
  if (request === undefined) return;
  const requestId = Reflect.get(request, 'requestId');
  const channel = port?.posted.find((message) => message.type === 'control');
  if (channel?.type === 'control') channel.port.postMessage(operation === 'initialize'
    ? { type: 'initialized', requestId, message: null }
    : { type: 'disposed', requestId });
}

test('decoder deadlines: stalled initialization retires once and only the newest waiting scene starts on one replacement', async () => {
  const h = deadlineHarness();
  const first = h.open();
  const stale = watch(first.decode(TAP, new AbortController().signal));
  const oldPort = h.ports[0];
  h.advance(10_000);
  const middle = h.open(OTHER_SCENE);
  const superseded = watch(middle.decode(TAP, new AbortController().signal));
  h.advance(19_999);
  const newest = h.open(sceneId('00000000-0000-4000-8000-000000000002'));
  const fresh = watch(newest.decode(TAP, new AbortController().signal));
  assert.equal(oldPort?.terminated, 0);
  h.advance(1);
  assert.equal(oldPort?.terminated, 1, 'switching does not renew the original initialization deadline');
  assert.equal(h.ports.length, 2, 'exactly one replacement is spawned for the newest scene');
  const replacement = h.ports[1];
  acknowledge(replacement, 'initialize');
  const request = decodesPosted(replacement).at(-1);
  replacement?.reply(decoded(request?.jobId ?? -1, 9));
  acknowledge(oldPort, 'initialize');
  oldPort?.error('a late old worker error');
  oldPort?.messageError();
  h.callbacks[0]?.();
  await settle();
  assert.equal(outcomeOf(stale), 'cancelled');
  assert.equal(outcomeOf(superseded), 'cancelled');
  assert.equal(outcomeOf(fresh), 'ok 9');
  assert.equal(oldPort?.terminated, 1);
  assert.equal(replacement?.terminated, 0);
  assert.equal(h.pendingTimers(), 0);
});

test('decoder deadlines: stalled inference after an abort keeps its drain deadline and recovers the newest scene', async () => {
  const h = deadlineHarness();
  const first = h.open();
  const oldPort = h.ports[0];
  acknowledge(oldPort, 'initialize');
  const controller = new AbortController();
  const old = watch(first.decode(TAP, controller.signal));
  const oldJobId = decodesPosted(oldPort).at(-1)?.jobId ?? -1;
  h.advance(20_000);
  controller.abort();
  const newest = h.open(OTHER_SCENE);
  const fresh = watch(newest.decode(TAP, new AbortController().signal));
  h.advance(10_000);
  assert.equal(oldPort?.terminated, 1, 'aborting the handle does not cancel the in-flight inference deadline');
  assert.equal(h.ports.length, 2);
  const replacement = h.ports[1];
  acknowledge(replacement, 'initialize');
  oldPort?.reply(decoded(oldJobId, 4));
  const jobId = decodesPosted(replacement).at(-1)?.jobId ?? -1;
  replacement?.reply(decoded(jobId, 7));
  await settle();
  assert.equal(outcomeOf(old), 'cancelled');
  assert.equal(outcomeOf(fresh), 'ok 7');
  assert.equal(oldPort?.terminated, 1);
  assert.equal(h.pendingTimers(), 0);
});

test('decoder deadlines: stalled release retires once and newest scene initializes without waiting for old release', async () => {
  const h = deadlineHarness();
  const first = h.open();
  const oldPort = h.ports[0];
  acknowledge(oldPort, 'initialize');
  const ready = watch(first.decode(TAP, new AbortController().signal));
  oldPort?.reply(decoded(decodesPosted(oldPort).at(-1)?.jobId ?? -1, 1));
  first.release();
  const newest = h.open(OTHER_SCENE);
  const fresh = watch(newest.decode(TAP, new AbortController().signal));
  h.advance(9_999);
  assert.equal(oldPort?.terminated, 0);
  h.advance(1);
  assert.equal(oldPort?.terminated, 1);
  assert.equal(h.ports.length, 2);
  const replacement = h.ports[1];
  acknowledge(replacement, 'initialize');
  const jobId = decodesPosted(replacement).at(-1)?.jobId ?? -1;
  acknowledge(oldPort, 'dispose');
  oldPort?.error('late release error');
  replacement?.reply(decoded(jobId, 6));
  await settle();
  assert.equal(outcomeOf(ready), 'ok 1');
  assert.equal(outcomeOf(fresh), 'ok 6');
  assert.equal(oldPort?.terminated, 1);
  assert.equal(h.pendingTimers(), 0);
});

for (const operation of ['init', 'inference'] satisfies ('init' | 'inference')[]) {
  test(`decoder deadlines: current ${operation} failure resolves typed timeout without replaying the current scene`, async () => {
    const h = deadlineHarness();
    const first = h.open();
    const port = h.ports[0];
    if (operation === 'inference') acknowledge(port, 'initialize');
    const pending = watch(first.decode(TAP, new AbortController().signal));
    h.advance(DECODER_TIMEOUT_MS[operation]);
    await settle();
    assert.deepEqual(pending.outcome, err({ kind: 'timeout', op: 'decode', visibleMs: DECODER_TIMEOUT_MS[operation] }));
    assert.equal(port?.terminated, 1);
    assert.equal(h.ports.length, 1, 'the driver owns the current-scene retry');
    const late = await first.decode(TAP, new AbortController().signal);
    assert.deepEqual(late, pending.outcome, 'later calls retain the typed timeout');
    const channel = port?.posted.find((request) => request.type === 'control');
    assert.ok(channel?.type === 'control');
    assert.ok(channel.port instanceof TestMessagePort);
    assert.equal(channel.port.peer?.closed, true, 'the retired worker owner closes its lifetime control port');
    const replacement = h.open(OTHER_SCENE);
    const replacementPort = h.ports[1];
    assert.equal(h.ports.length, 2);
    acknowledge(replacementPort, 'initialize');
    const fresh = watch(replacement.decode(TAP, new AbortController().signal));
    replacementPort?.reply(decoded(decodesPosted(replacementPort).at(-1)?.jobId ?? -1, 8));
    await settle();
    assert.equal(outcomeOf(fresh), 'ok 8');
    assert.equal(h.pendingTimers(), 0);
  });
}

test('decoder deadlines: a stale acknowledgement on the same worker cannot end the newest initialization deadline', async () => {
  const h = deadlineHarness();
  const first = h.open();
  const port = h.ports[0];
  const original = port?.posted.find((request) => request.type === 'initialize');
  assert.ok(original?.type === 'initialize');
  acknowledge(port, 'initialize');
  first.release();
  acknowledge(port, 'dispose');
  const newest = h.open(OTHER_SCENE);
  const pending = watch(newest.decode(TAP, new AbortController().signal));
  const channel = port?.posted.find((request) => request.type === 'control');
  assert.ok(channel?.type === 'control');
  h.advance(20_000);
  channel.port.postMessage({ type: 'initialized', requestId: original.requestId, message: null });
  h.callbacks[0]?.();
  h.advance(10_000);
  await settle();
  assert.deepEqual(pending.outcome, err({ kind: 'timeout', op: 'decode', visibleMs: 30_000 }));
  assert.equal(port?.terminated, 1);
  assert.equal(h.ports.length, 1);
  assert.equal(h.pendingTimers(), 0);
});

test('decoder deadlines: queued old taps share their original post budget rather than extending the newest scene drain', async () => {
  const h = deadlineHarness();
  const first = h.open();
  const oldPort = h.ports[0];
  acknowledge(oldPort, 'initialize');
  const old = [
    watch(first.decode(TAP, new AbortController().signal)),
    watch(first.decode(TAP, new AbortController().signal)),
    watch(first.decode(TAP, new AbortController().signal)),
  ];
  const jobs = decodesPosted(oldPort);
  const newest = h.open(OTHER_SCENE);
  const fresh = watch(newest.decode(TAP, new AbortController().signal));
  h.advance(29_000);
  oldPort?.reply(decoded(jobs[0]?.jobId ?? -1, 1));
  h.advance(500);
  oldPort?.reply(decoded(jobs[1]?.jobId ?? -1, 2));
  h.advance(500);
  assert.equal(oldPort?.terminated, 1, 'the third old tap still expires at its original post time plus 30 seconds');
  assert.equal(h.ports.length, 2);
  const replacement = h.ports[1];
  acknowledge(replacement, 'initialize');
  replacement?.reply(decoded(decodesPosted(replacement).at(-1)?.jobId ?? -1, 9));
  await settle();
  assert.deepEqual(old.map(outcomeOf), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(outcomeOf(fresh), 'ok 9');
  assert.equal(h.pendingTimers(), 0);
});

test('the lifetime control channel closes both endpoints when it cannot be transferred', async () => {
  const port = scriptedPort();
  port.throwOn = (request) => request.type === 'control';
  const port1 = new TestMessagePort(), port2 = new TestMessagePort();
  port1.peer = port2; port2.peer = port1;
  const service = createAnalysisService({
    clock: { now: () => 0 }, diag: { log: () => undefined },
    spawn: () => assert.fail('no sequence'), spawnDecoder: () => port,
    decoderChannel: () => ({ port1, port2 }),
    ortBase: '/ort/', threads: 'default', lock, loader: Promise.resolve(err({ kind: 'quota' })),
  });
  const decoder = service.openDecoder({ scene: SCENE, embeddings: embeddings(), guide: GUIDE });
  assert.equal(port.terminated, 1);
  assert.equal(port1.closed, true);
  assert.equal(port2.closed, true);
  const result = await decoder.decode(TAP, new AbortController().signal);
  assert.ok(!result.ok && result.error.kind === 'worker');
  assert.match(result.error.message, /lifecycle channel could not be opened/);
});
