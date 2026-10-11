// The analysis service: the page's one owner of its analysis workers. It
// runs an ordered list of heavy stages in one sequence worker, hands each
// product to the caller as it lands, ends every sequence in exactly one
// terminal callback, reuses its worker and wasm heap across photos, and
// records the completion the cooldown rule reads; it opens the resident
// decode worker on a scene's embeddings and guide and hands back the one
// handle that decodes, each decode resolving exactly once; and it fetches
// models through the model loader and logs the analysis part of the
// diagnostic vocabulary. Deciding which heavy stages to run, their watchdogs,
// cooldowns and retries are the caller's. The service bounds decoder operations
// and replaces a stalled runtime before the newest scene uses it.
//
// Workers arrive through spawn functions returning narrow ports that the
// browser's Worker satisfies. A native MessageChannel carries decoder lifecycle
// replies; node tests inject its factory and scripted ports. docs/ARCHITECTURE.md
// ("The analysis service") states each member's behavior.

import type { AnalysisOp } from '../core/derive.ts';
import type { ModelId, NonEmpty, SceneId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import type { DepthStats, TapPoint } from '../core/types.ts';
import type { Clock } from '../platform/clock.ts';
import type { DiagnosticSink } from '../platform/diagnostics.ts';
import type { ModelOp, ParsedLock } from './lock.ts';
import type { ModelLoader } from './models.ts';
import {
  oneLine,
  parseDecodeLifecycleReply,
  parseDecodeReply,
  parseFaceReply,
  parseSequenceReply,
  type AnalysisError,
  type DecodeRequest,
  type DecodeResult,
  type FaceDetection,
  type FaceRequest,
  type HeavyStage,
  type SamEmbeddings,
  type SequenceReply,
  type SequenceRequest,
} from './protocol.ts';

export type { AnalysisError, Candidate, DecodeResult, HeavyStage } from './protocol.ts';

type StageKind = HeavyStage['kind'];

/** Page-owned deadlines also cover a worker blocked inside synchronous wasm. */
export const DECODER_TIMEOUT_MS = { init: 30_000, inference: 30_000, release: 10_000 } satisfies Record<'init' | 'inference' | 'release', number>;

/** The analysis module's part of the diagnostic vocabulary. */
export type AnalysisEvent =
  /**
   * A worker started or was terminated; a sequence worker's spawn names its stages, and its terminate `done`,
   * `failed`, or `cancelled`; a decode worker's spawn says `open`, and its terminate `released`, `replaced`, or `failed`.
   */
  | { readonly event: 'worker.spawn' | 'worker.terminate'; readonly worker: 'sequence' | 'decode' | 'face'; readonly reason: string }
  /** A stage's run or a decode was posted (`ms` 0, no high-water mark), or its answer arrived (`ms` since its start on the service's clock, the worker's high-water mark). */
  | { readonly event: 'stage.start' | 'stage.end'; readonly op: AnalysisOp; readonly ms: number; readonly wasmHighWaterBytes: number | null }
  /** A sequence ended in failure or a cancel, naming the stage and the error its terminal callback carries; or a decode resolved with an error, with op `decode`. */
  | { readonly event: 'stage.failed'; readonly op: AnalysisOp; readonly error: AnalysisError }
  /** A `fetchModels` call began or ended for one model of its operations. */
  | { readonly event: 'fetch.start' | 'fetch.end'; readonly model: ModelId };

/** The terminate of a sequence worker that ran at least one stage: its clock time and the largest stage it ran (encode above inpaint above depth). */
export type HeavyTermination = { readonly atMs: number; readonly largest: StageKind };

/**
 * Where a sequence's bitmaps come from: `master` is called once per stage,
 * just before that stage's run is posted, and the bitmap it gives is
 * transferred to the worker, so it is closed for the page once posted. A
 * bitmap the service cannot post, or receives after its sequence ended, is
 * closed.
 */
export type SequenceInput = { readonly master: () => Promise<ImageBitmap> };

/** What a sequence reports, as it happens. Exactly one of `onDone` and `onFailed` ends each sequence. */
export type SequenceListener = {
  readonly onPhase: (stage: StageKind, phase: 'session' | 'infer', fraction: number | null) => void;
  readonly onDepth: (map: Plane<'f32'>, stats: DepthStats) => void;
  /** The service keeps nothing it hands on: the caller holds the embeddings from here. */
  readonly onEmbeddings: (embeddings: SamEmbeddings) => void;
  readonly onPlate: (image: Rgb8) => void;
  /** The sequence failed or was cancelled at `stage`; later products are discarded. */
  readonly onFailed: (stage: StageKind, error: AnalysisError) => void;
  /** Every stage's product has been handed on and its sessions released. */
  readonly onDone: () => void;
};

/**
 * The part of a dedicated worker the service uses, for a worker that takes
 * `Request`s; the browser's Worker is one. A reply arrives as a `message`
 * event's `data`, which the service parses before reading.
 */
export interface WorkerPort<Request> {
  postMessage(message: Request, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: object) => void): void;
  addEventListener(type: 'messageerror', listener: () => void): void;
}

/** A sequence worker as the service uses it. */
export type SequenceWorkerPort = WorkerPort<SequenceRequest>;
/** A decode worker as the service uses it. */
export type DecodeWorkerPort = WorkerPort<DecodeRequest>;
export type FaceWorkerPort = WorkerPort<FaceRequest>;

export interface FaceTracker {
  /** Session creation and its synthetic known-answer warm-up, without a network fetch. */
  readonly ready: Promise<void>;
  /** Consumes a fresh bitmap; drops and closes it if a frame is already in flight. */
  track(frame: ImageBitmap): Promise<FaceDetection | null>;
  /** Settles pending startup/tracking and releases this handle; keeps the resident worker. */
  release(): void;
}

/** What a decoder is opened on: the scene's embeddings, and its guide, the master at long edge 1024; candidate masks are made at the guide's size. */
export type DecoderInput = { readonly scene: SceneId; readonly embeddings: SamEmbeddings; readonly guide: Rgb8 };

/** The one way to decode: a handle on one decode worker, which `openDecoder` returns. */
export interface Decoder {
  readonly scene: SceneId;
  /**
   * Decodes `points` against the decoder's embeddings and resolves exactly
   * once: with the three candidates, with a `worker` error when the decode or
   * the worker's init failed or the worker stopped, or with `cancelled` when
   * `signal` aborts first or the decoder is released. The worker answers
   * decodes in the order they were made, each after its init.
   */
  decode(points: NonEmpty<TapPoint>, signal: AbortSignal): Promise<Result<DecodeResult, AnalysisError>>;
  /** Releases the scene's session and resolves pending and later decodes with `cancelled`; does nothing the second time. */
  release(): void;
}

export type AnalysisServiceDeps = {
  readonly clock: Pick<Clock, 'now'> & Partial<Pick<Clock, 'setTimeout' | 'clearTimeout'>>;
  readonly diag: DiagnosticSink<AnalysisEvent>;
  /** Starts a sequence worker; a page passes `() => new Worker(<the sequence worker's URL>, { type: 'module', name: 'sequence' })`. */
  readonly spawn: () => SequenceWorkerPort;
  /** Starts a decode worker; a page passes `() => new Worker(<the decode worker's URL>, { type: 'module', name: 'decode' })`. */
  readonly spawnDecoder: () => DecodeWorkerPort;
  /** One channel per decoder worker; injected only by deterministic owner tests. */
  readonly decoderChannel?: () => Pick<MessageChannel, 'port1' | 'port2'>;
  /** Optional for analysis-only dev harnesses that never track a camera. */
  readonly spawnFaceTracker?: () => FaceWorkerPort;
  /** The runtime's directory, sent in each worker's `init`. */
  readonly ortBase: string;
  /** ORT's thread count, sent in the sequence worker's `init`. */
  readonly threads: number | 'default';
  /** The lock the loader was opened with; it names the model each operation's files belong to. */
  readonly lock: ParsedLock;
  /** What `openModelLoader` returns; `fetchModels` awaits it. */
  readonly loader: Promise<Result<ModelLoader, AnalysisError>>;
};

export interface AnalysisService {
  /**
   * Runs `stages` in order in the page's sequence worker, cancelling a sequence
   * still alive first, and hands each product to `on` as it lands. The
   * sequence ends in exactly one of `on.onDone` and `on.onFailed`, after every
   * product of the stages that completed. An abort of `signal` cancels it as
   * `cancelHeavy` does. An already posted stage drains before the next starts.
   * When the cancelled sequence's `onFailed` starts another sequence, that
   * one stands and this one ends at once in `onFailed` with `cancelled`.
   */
  runSequence(scene: SceneId, stages: NonEmpty<HeavyStage>, input: SequenceInput, on: SequenceListener, signal: AbortSignal): void;
  /** Ends the sequence immediately in `onFailed` with `cancelled`, discarding its pending product; keeps its worker. */
  cancelHeavy(reason?: 'timeout'): void;
  /**
   * Reuses the decode worker for `input`, first releasing the decoder alive,
   * whose handle then acts as released, and posts its `init` with the
   * embeddings and the guide copied, not transferred. While older work drains,
   * the service holds only the newest input; posting its init drops that input.
   * Replacement and release drop queued inputs immediately. Returns the handle.
   */
  openDecoder(input: DecoderInput): Decoder;
  openFaceTracker(): FaceTracker;
  /**
   * Gets the model files `ops` need through the loader, logging `fetch.start`
   * and `fetch.end` for each model of `ops` around the call. Resolves with the
   * loader's failure to open or the fetch's result.
   */
  fetchModels(ops: readonly ModelOp[], signal: AbortSignal, onProgress: (model: ModelId, fraction: number) => void): Promise<Result<void, AnalysisError>>;
  /** Active sequence and decoder ownership, independent of idle resident workers. */
  readonly alive: { readonly heavy: boolean; readonly decoder: boolean };
  /** The last sequence this service ended after it had run at least one stage, or null before that. */
  readonly lastHeavyTermination: HeavyTermination | null;
}

/**
 * encode above inpaint above depth: the rank that names a termination record's
 * largest stage, which a cooldown is keyed by. It is not the order of the
 * stages' wasm peaks on every master: in Chrome, inpaint with a frame-wide
 * hole on a 2048 x 2048 master reads 885 to 921 MB, above the encoder's 791
 * to 796 MB (the sequence scenarios' bands).
 */
const STAGE_RANK = { depth: 0, inpaint: 1, encode: 2 } as const satisfies Record<StageKind, number>;

/** The reply that carries each stage's product. */
const PRODUCT_OF = { depth: 'depth', encode: 'embeddings', inpaint: 'plate' } as const satisfies Record<StageKind, SequenceReply['type']>;

function larger(a: StageKind | null, b: StageKind): StageKind {
  return a === null || STAGE_RANK[b] > STAGE_RANK[a] ? b : a;
}

/** A thrown value as one line, without letting a hostile value throw again. */
function describeThrown(thrown: unknown): string {
  try {
    return oneLine(thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown));
  } catch {
    return 'a value that could not be described';
  }
}

/** One logical sequence, from its start to its terminal callback. */
type Sequence = {
  port: SequenceWorkerPort;
  readonly stages: NonEmpty<HeavyStage>;
  readonly input: SequenceInput;
  readonly on: SequenceListener;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  /** The stage being prepared (its master pending, or the stage before it handing on its product) or run (its run posted and not answered). */
  index: number;
  /** When the current stage's run was posted, on the service's clock; null while its master is pending. */
  postedAt: number | null;
  /** The largest stage whose `infer` phase the worker reported. */
  largestRun: StageKind | null;
};

type Ending = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly error: AnalysisError };

/** A queued or posted decode; removing it from its decoder's map resolves it once. */
type PendingDecode = {
  readonly points: NonEmpty<TapPoint>;
  postedAt: number | null;
  readonly done: (result: DecodeResult, wasmHighWaterBytes: number) => void;
  readonly fail: (error: AnalysisError) => void;
};

type DecoderFailure = Extract<AnalysisError, { readonly kind: 'worker' | 'timeout' }>;

/** One decoder's lifecycle: its worker alive with the decodes it has not answered, stopped by a failure, or released (replaced included). */
type DecoderState =
  | { readonly kind: 'open'; input: DecoderInput | null; readonly pending: Map<number, PendingDecode> }
  | { readonly kind: 'stopped'; readonly error: DecoderFailure }
  | { readonly kind: 'released' };

/** The state a handle reads; the service moves it, and only an open decoder is alive. */
type DecoderSlot = { readonly id: number; state: DecoderState };

/** Scalars only: cancelling a scene must not keep its embeddings or callbacks. */
type DecoderFlight =
  | { readonly kind: 'init'; readonly port: DecodeWorkerPort; readonly requestId: number; readonly decoderId: number }
  | { readonly kind: 'inference'; readonly port: DecodeWorkerPort; readonly jobId: number; readonly decoderId: number; readonly deadlineAt: number }
  | { readonly kind: 'release'; readonly port: DecodeWorkerPort; readonly requestId: number };

type FaceSlot = {
  error: Error | null;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  pending: { id: number; resolve: (face: FaceDetection | null) => void; reject: (error: Error) => void } | null;
};
type FaceResident = { readonly port: FaceWorkerPort; ready: boolean; busy: number | null };

export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService {
  const { clock, diag } = deps;
  let live: Sequence | null = null;
  let sequencePort: SequenceWorkerPort | null = null;
  // One outstanding request, including bitmap preparation. Cancellation drops
  // the scene and callbacks here, but keeps the flight until its reply drains.
  let flight: { sequence: Sequence | null } | null = null;
  let drainTimer: number | null = null;
  let decoderPort: DecodeWorkerPort | null = null;
  let decoderControl: MessagePort | null = null;
  let decoderFlight: DecoderFlight | null = null;
  /** Posted taps keep only their identities after abort or scene replacement. */
  const decoderQueue: Extract<DecoderFlight, { readonly kind: 'inference' }>[] = [];
  let decoderTimer: number | null = null;
  /** The scene installed in the resident worker, independent of released handles. */
  let installedDecoder: number | null = null;
  let lastHeavyTermination: HeavyTermination | null = null;
  /** The decoder whose worker is alive, or null; at most one is. */
  let liveDecoder: DecoderSlot | null = null;
  let faceResident: FaceResident | null = null;
  let liveFace: FaceSlot | null = null;
  let nextJobId = 0;

  const currentStage = (seq: Sequence): HeavyStage => seq.stages[seq.index] ?? seq.stages[0];

  const clearFlight = (): void => {
    flight = null;
    if (drainTimer !== null) clock.clearTimeout?.(drainTimer);
    drainTimer = null;
  };

  /** Stops `seq` once and records completion without retiring its wasm heap. */
  const stop = (seq: Sequence, ending: Ending, endedAt?: number): boolean => {
    if (live !== seq) return false;
    live = null;
    if (flight?.sequence === seq) {
      flight.sequence = null;
      // Cancelled inference cannot be interrupted without discarding its heap.
      // Give it the longest stage deadline to drain; a nonresponsive worker is
      // fatal, so later imports can recover with exactly one replacement.
      if (clock.setTimeout !== undefined && clock.clearTimeout !== undefined && drainTimer === null) {
        const owner = seq.port;
        drainTimer = clock.setTimeout(() => failWorker(owner, 'the cancelled stage did not finish within 120 seconds'), 120_000);
      }
    }
    seq.signal.removeEventListener('abort', seq.onAbort);
    if (ending.kind === 'failed') diag.log({ event: 'stage.failed', op: currentStage(seq).kind, error: ending.error });
    const atMs = endedAt ?? clock.now();
    if (seq.largestRun !== null) lastHeavyTermination = { atMs, largest: seq.largestRun };
    return true;
  };

  /** Ends `seq` in failure once: stops it, then calls `onFailed` for its current stage. */
  const end = (seq: Sequence, error: AnalysisError, endedAt?: number): void => {
    if (stop(seq, { kind: 'failed', error }, endedAt)) seq.on.onFailed(currentStage(seq).kind, error);
  };

  const fail = (seq: Sequence, message: string, endedAt?: number): void => end(seq, { kind: 'worker', op: currentStage(seq).kind, message: oneLine(message) }, endedAt);
  const cancel = (seq: Sequence): void => end(seq, { kind: 'cancelled' });

  const failWorker = (port: SequenceWorkerPort, message: string): void => {
    if (sequencePort !== port) return;
    const waiting = flight?.sequence === null ? live : null;
    sequencePort = null;
    clearFlight();
    port.terminate();
    const endedAt = clock.now();
    diag.log({ event: 'worker.terminate', worker: 'sequence', reason: 'failed' });
    if (waiting !== null) {
      // This error belongs to cancelled work. The newest sequence has posted
      // nothing yet, so give it one replacement rather than a stale failure.
      try {
        const replacement = spawnSequencePort(waiting.stages);
        waiting.port = replacement;
        try { replacement.postMessage({ type: 'init', ortBase: deps.ortBase, threads: deps.threads }, []); }
        catch (thrown) { failWorker(replacement, `init could not be posted: ${describeThrown(thrown)}`); return; }
        resume();
      } catch (thrown) { fail(waiting, `the sequence worker could not be started: ${describeThrown(thrown)}`); }
    } else if (live !== null) fail(live, message, endedAt);
  };

  const spawnSequencePort = (stages: NonEmpty<HeavyStage>): SequenceWorkerPort => {
    const owner = deps.spawn();
    sequencePort = owner;
    diag.log({ event: 'worker.spawn', worker: 'sequence', reason: stages.map((stage) => stage.kind).join(',') });
    owner.addEventListener('message', (event) => onReply(owner, event.data));
    owner.addEventListener('error', (event) => {
      const detail = 'message' in event && typeof event.message === 'string' && event.message !== '' ? event.message : 'an error event without a message';
      failWorker(owner, `the worker raised an error: ${detail}`);
    });
    owner.addEventListener('messageerror', () => failWorker(owner, 'a reply from the worker could not be deserialized'));
    return owner;
  };

  const resume = (): void => { if (live !== null && flight === null) void post(live); };

  /** Gets the current stage's bitmap and posts its run. */
  const post = async (seq: Sequence): Promise<void> => {
    if (live !== seq || flight !== null) return;
    const stage = currentStage(seq);
    const pending = { sequence: seq };
    flight = pending;
    let image: ImageBitmap;
    try {
      image = await seq.input.master();
    } catch (thrown) {
      if (flight === pending) clearFlight();
      fail(seq, `the master bitmap for the ${stage.kind} stage could not be made: ${describeThrown(thrown)}`);
      resume();
      return;
    }
    if (live !== seq) {
      image.close();
      if (flight === pending) clearFlight();
      resume();
      return;
    }
    // The hole is cloned, not transferred, so the caller's plane stays whole.
    const request: SequenceRequest = stage.kind === 'inpaint' ? { type: 'run', stage: 'inpaint', image, hole: stage.hole } : { type: 'run', stage: stage.kind, image };
    diag.log({ event: 'stage.start', op: stage.kind, ms: 0, wasmHighWaterBytes: null });
    seq.postedAt = clock.now();
    try {
      seq.port.postMessage(request, [image]);
    } catch (thrown) {
      image.close();
      failWorker(seq.port, `the ${stage.kind} run could not be posted: ${describeThrown(thrown)}`);
    }
  };

  const onReply = (port: SequenceWorkerPort, data: unknown): void => {
    if (sequencePort !== port) return;
    const parsed = parseSequenceReply(data);
    if (!parsed.ok) return failWorker(port, `a reply from the worker did not parse: ${parsed.error.detail}`);
    const reply = parsed.value;
    if (reply.type === 'failed' && reply.fatal === true) return failWorker(port, reply.message);
    const seq = flight?.sequence;
    if (flight === null) return failWorker(port, `the worker sent a ${reply.type} reply while no run was posted`);
    if (seq === null || seq === undefined || live !== seq) {
      if (reply.type !== 'phase') { clearFlight(); resume(); }
      return;
    }
    const stage = currentStage(seq);
    const { postedAt } = seq;
    if (reply.type === 'failed') { clearFlight(); fail(seq, reply.message); resume(); return; }
    if (postedAt === null) return failWorker(port, `the worker sent a ${reply.type} reply while no run was posted`);
    if (reply.type === 'phase') {
      if (reply.stage !== stage.kind) return failWorker(port, `the worker reported the ${reply.stage} stage's ${reply.phase} phase while ${stage.kind} was running`);
      if (reply.phase === 'infer') seq.largestRun = larger(seq.largestRun, stage.kind);
      seq.on.onPhase(stage.kind, reply.phase, reply.fraction);
      return;
    }
    clearFlight();
    if (reply.type !== PRODUCT_OF[stage.kind]) return failWorker(port, `the worker answered ${reply.type} to the ${stage.kind} run`);
    diag.log({ event: 'stage.end', op: stage.kind, ms: clock.now() - postedAt, wasmHighWaterBytes: reply.timings.wasmHighWaterBytes });
    // The stage is answered before its product is handed on, so a cancel or a
    // new sequence from inside the callback names the next stage, and after
    // the last product the sequence is already over: ownership is cleared
    // first, and `onDone` follows the product.
    seq.postedAt = null;
    const last = seq.index === seq.stages.length - 1;
    if (last) stop(seq, { kind: 'done' });
    else seq.index += 1;
    switch (reply.type) {
      case 'depth':
        seq.on.onDepth(reply.map, reply.stats);
        break;
      case 'embeddings':
        seq.on.onEmbeddings(reply.embeddings);
        break;
      case 'plate':
        seq.on.onPlate(reply.image);
        break;
      default: {
        const exhaustive: never = reply;
        return exhaustive;
      }
    }
    if (last) seq.on.onDone();
    else if (live === seq) resume();
  };

  const decodeError = (message: string): Extract<AnalysisError, { readonly kind: 'worker' }> => ({ kind: 'worker', op: 'decode', message: oneLine(message) });

  const clearDecoderFlight = (): void => {
    decoderFlight = null;
    if (decoderTimer !== null) clock.clearTimeout?.(decoderTimer);
    decoderTimer = null;
  };

  /** Switching and aborting do not extend the deadline of already running work. */
  const beginDecoderFlight = (owner: DecoderFlight): void => {
    decoderFlight = owner;
    if (clock.setTimeout === undefined || clock.clearTimeout === undefined) return;
    const ms = DECODER_TIMEOUT_MS[owner.kind];
    const remaining = owner.kind === 'inference' ? Math.max(0, owner.deadlineAt - clock.now()) : ms;
    decoderTimer = clock.setTimeout(() => {
      if (decoderFlight !== owner) return;
      failDecoderWorker(owner.port, { kind: 'timeout', op: 'decode', visibleMs: ms });
    }, remaining);
  };

  /**
   * Ends the open decoder in `slot` once: moves it to `next`, resolves each
   * pending decode with `error`, and releases its session in the resident
   * worker. Does nothing when the decoder is not open.
   */
  const endDecoder = (slot: DecoderSlot, next: DecoderState, error: AnalysisError, reason: 'released' | 'replaced' | 'failed'): void => {
    const state = slot.state;
    if (state.kind !== 'open') return;
    slot.state = next;
    if (liveDecoder === slot) liveDecoder = null;
    const pending = [...state.pending.values()];
    state.pending.clear();
    for (const job of pending) job.fail(error);
    if (reason !== 'failed') resumeDecoder();
  };

  /** Stops the decoder once; pending and later decodes retain its worker error or timeout. */
  const failDecoder = (slot: DecoderSlot, error: DecoderFailure): void => endDecoder(slot, { kind: 'stopped', error }, error, 'failed');

  const failDecoderWorker = (port: DecodeWorkerPort, error: DecoderFailure): void => {
    if (decoderPort !== port) return;
    const current = liveDecoder;
    const waiting = current?.state.kind === 'open' && current.state.input !== null
      && decoderFlight !== null && (decoderFlight.kind === 'release' || decoderFlight.decoderId !== current.id);
    decoderPort = null;
    decoderControl?.close();
    decoderControl = null;
    installedDecoder = null;
    clearDecoderFlight();
    decoderQueue.length = 0;
    port.terminate();
    diag.log({ event: 'worker.terminate', worker: 'decode', reason: 'failed' });
    if (waiting) {
      // The failure belongs to obsolete work. The newest scene has posted
      // nothing yet, so start it once on one replacement, with its same handle.
      startDecoderPort();
      resumeDecoder();
    } else if (current !== null) failDecoder(current, error);
  };

  const startDecoderPort = (): DecodeWorkerPort | null => {
    if (decoderPort !== null) return decoderPort;
    let port: DecodeWorkerPort;
    try { port = deps.spawnDecoder(); }
    catch (thrown) {
      if (liveDecoder !== null) failDecoder(liveDecoder, { kind: 'worker', op: 'decode', message: `the decode worker could not be started: ${describeThrown(thrown)}` });
      return null;
    }
    decoderPort = port;
    diag.log({ event: 'worker.spawn', worker: 'decode', reason: 'open' });
    port.addEventListener('message', (event) => onDecodeReply(port, event.data));
    port.addEventListener('error', (event) => {
      const detail = 'message' in event && typeof event.message === 'string' && event.message !== '' ? event.message : 'an error event without a message';
      failDecoderWorker(port, { kind: 'worker', op: 'decode', message: `the worker raised an error: ${detail}` });
    });
    port.addEventListener('messageerror', () => failDecoderWorker(port, { kind: 'worker', op: 'decode', message: 'a reply from the worker could not be deserialized' }));
    try {
      const channel = deps.decoderChannel?.() ?? new MessageChannel();
      decoderControl = channel.port1;
      channel.port1.onmessage = (event: MessageEvent<unknown>) => onDecodeLifecycleReply(port, event.data);
      channel.port1.onmessageerror = () => failDecoderWorker(port, { kind: 'worker', op: 'decode', message: 'a lifecycle reply from the worker could not be deserialized' });
      channel.port1.start();
      try { port.postMessage({ type: 'control', port: channel.port2 }, [channel.port2]); }
      catch (thrown) { channel.port2.close(); throw thrown; }
    } catch (thrown) {
      failDecoderWorker(port, { kind: 'worker', op: 'decode', message: `the lifecycle channel could not be opened: ${describeThrown(thrown)}` });
      return null;
    }
    return port;
  };

  /** Posts only the active operation; queued scenes retain only the newest input. */
  const resumeDecoder = (): void => {
    const port = decoderPort;
    if (port === null) return;
    const slot = liveDecoder;
    const alreadyPosted = decoderQueue[0];
    if (decoderFlight === null && alreadyPosted !== undefined) beginDecoderFlight(alreadyPosted);
    // Same-scene taps retain the existing ability to be posted together. The
    // worker runs them serially; the front request owns the drain deadline.
    if (slot?.state.kind === 'open' && installedDecoder === slot.id && (decoderFlight === null || decoderFlight.kind === 'inference')) {
      const state = slot.state;
      for (const [jobId, job] of state.pending) {
        if (job.postedAt !== null) continue;
        job.postedAt = clock.now();
        diag.log({ event: 'stage.start', op: 'decode', ms: 0, wasmHighWaterBytes: null });
        const owner: Extract<DecoderFlight, { readonly kind: 'inference' }> = { kind: 'inference', port, jobId, decoderId: slot.id, deadlineAt: job.postedAt + DECODER_TIMEOUT_MS.inference };
        decoderQueue.push(owner);
        if (decoderFlight === null) beginDecoderFlight(owner);
        try { port.postMessage({ type: 'decode', jobId, points: job.points }, []); }
        catch (thrown) {
          const index = decoderQueue.indexOf(owner);
          if (index !== -1) decoderQueue.splice(index, 1);
          if (decoderFlight === owner) clearDecoderFlight();
          state.pending.delete(jobId);
          job.fail(decodeError(`the decode could not be posted: ${describeThrown(thrown)}`));
        }
      }
    }
    if (decoderFlight !== null) return;
    const queued = decoderQueue[0];
    if (queued !== undefined) { beginDecoderFlight(queued); return; }
    if (installedDecoder !== null && installedDecoder !== slot?.id) {
      const requestId = nextJobId++;
      beginDecoderFlight({ kind: 'release', port, requestId });
      try { port.postMessage({ type: 'dispose', requestId }, []); }
      catch (thrown) { failDecoderWorker(port, { kind: 'worker', op: 'decode', message: `release could not be posted: ${describeThrown(thrown)}` }); }
      return;
    }
    if (slot?.state.kind !== 'open') return;
    const state = slot.state;
    if (installedDecoder !== slot.id) {
      const input = state.input;
      if (input === null) return;
      const requestId = nextJobId++;
      beginDecoderFlight({ kind: 'init', port, requestId, decoderId: slot.id });
      try {
        port.postMessage({ type: 'initialize', requestId, ortBase: deps.ortBase, embeddings: input.embeddings, guide: input.guide }, []);
        state.input = null;
      }
      catch (thrown) { failDecoderWorker(port, { kind: 'worker', op: 'decode', message: `init could not be posted: ${describeThrown(thrown)}` }); }
      return;
    }
  };

  const onDecodeLifecycleReply = (port: DecodeWorkerPort, data: unknown): void => {
    if (decoderPort !== port) return;
    const owner = decoderFlight;
    const parsed = parseDecodeLifecycleReply(data);
    if (!parsed.ok) return failDecoderWorker(port, { kind: 'worker', op: 'decode', message: `a lifecycle reply from the worker did not parse: ${parsed.error.detail}` });
    const reply = parsed.value;
    if (owner === null || owner.kind === 'inference' || owner.requestId !== reply.requestId) return;
    if ((owner.kind === 'init') !== (reply.type === 'initialized')) return failDecoderWorker(port, { kind: 'worker', op: 'decode', message: 'the worker answered the wrong decoder lifecycle operation' });
    clearDecoderFlight();
    if (owner.kind === 'init' && reply.type === 'initialized') {
      const slot = liveDecoder;
      if (reply.message === null) {
        installedDecoder = owner.decoderId;
        if (slot?.id === owner.decoderId && slot.state.kind === 'open') slot.state.input = null;
      } else {
        installedDecoder = null;
        if (slot?.id === owner.decoderId) failDecoder(slot, { kind: 'worker', op: 'decode', message: `the decoder did not start: ${reply.message}` });
      }
    } else installedDecoder = null;
    resumeDecoder();
  };

  const onDecodeReply = (port: DecodeWorkerPort, data: unknown): void => {
    if (decoderPort !== port) return;
    const owner = decoderFlight;
    const parsed = parseDecodeReply(data);
    if (!parsed.ok) return failDecoderWorker(port, { kind: 'worker', op: 'decode', message: `a reply from the worker did not parse: ${parsed.error.detail}` });
    const reply = parsed.value;
    const index = decoderQueue.findIndex((job) => job.jobId === reply.jobId);
    const answered = decoderQueue[index];
    if (answered === undefined) return;
    decoderQueue.splice(index, 1);
    if (owner?.kind === 'inference' && owner.jobId === reply.jobId) clearDecoderFlight();
    const state = liveDecoder?.state;
    // A reply naming no pending decode, as the late answer to a cancelled one, is dropped.
    if (state?.kind === 'open' && liveDecoder?.id === answered.decoderId) {
      const job = state.pending.get(reply.jobId);
      state.pending.delete(reply.jobId);
      if (reply.type === 'failed') job?.fail(decodeError(reply.message));
      else job?.done(reply.result, reply.timings.wasmHighWaterBytes);
    }
    resumeDecoder();
  };

  /** Posts one decode to the open decoder `state` and resolves exactly once: through its pending entry, or as cancelled on `signal`'s abort. */
  const postDecode = (state: Extract<DecoderState, { readonly kind: 'open' }>, points: NonEmpty<TapPoint>, signal: AbortSignal): Promise<Result<DecodeResult, AnalysisError>> =>
    new Promise((resolve) => {
      const jobId = nextJobId;
      nextJobId += 1;
      const onAbort = (): void => {
        const job = state.pending.get(jobId);
        if (job === undefined) return;
        state.pending.delete(jobId);
        job.fail({ kind: 'cancelled' });
      };
      const job: PendingDecode = {
        points,
        postedAt: null,
        done: (result, wasmHighWaterBytes) => {
          signal.removeEventListener('abort', onAbort);
          diag.log({ event: 'stage.end', op: 'decode', ms: clock.now() - (job.postedAt ?? clock.now()), wasmHighWaterBytes });
          resolve(ok(result));
        },
        fail: (error) => {
          signal.removeEventListener('abort', onAbort);
          diag.log({ event: 'stage.failed', op: 'decode', error });
          resolve(err(error));
        },
      };
      state.pending.set(jobId, job);
      signal.addEventListener('abort', onAbort, { once: true });
      resumeDecoder();
    });

  /** The handle on the decoder in `slot`. */
  const decoderHandle = (slot: DecoderSlot, scene: SceneId): Decoder => ({
    scene,
    decode(points, signal) {
      const state = slot.state;
      let error: AnalysisError;
      if (state.kind === 'open') {
        if (!signal.aborted) return postDecode(state, points, signal);
        error = { kind: 'cancelled' };
      } else if (state.kind === 'stopped') {
        error = state.error.kind === 'worker' ? decodeError(`the decoder stopped: ${state.error.message}`) : state.error;
      } else {
        error = { kind: 'cancelled' };
      }
      diag.log({ event: 'stage.failed', op: 'decode', error });
      return Promise.resolve(err(error));
    },
    release() {
      if (slot.state.kind === 'open') endDecoder(slot, { kind: 'released' }, { kind: 'cancelled' }, 'released');
      else slot.state = { kind: 'released' };
    },
  });

  const stopFace = (slot: FaceSlot, error: Error): void => {
    if (slot.error !== null) return;
    slot.error = error;
    slot.rejectReady(error);
    slot.pending?.reject(error);
    slot.pending = null;
    if (liveFace === slot) liveFace = null;
  };
  const failFaceWorker = (owner: FaceResident, error: Error): void => {
    if (faceResident !== owner) return;
    faceResident = null;
    owner.port.terminate();
    diag.log({ event: 'worker.terminate', worker: 'face', reason: 'failed' });
    if (liveFace !== null) stopFace(liveFace, error);
  };

  return {
    runSequence(_scene, stages, input, on, signal) {
      if (live !== null) cancel(live);
      const first = stages[0].kind;
      // A sequence alive now was started by the cancelled one's onFailed, after
      // this call began: it stands, and this one ends as cancelled.
      if (signal.aborted || live !== null) {
        diag.log({ event: 'stage.failed', op: first, error: { kind: 'cancelled' } });
        return on.onFailed(first, { kind: 'cancelled' });
      }
      let port = sequencePort;
      const spawned = port === null;
      if (port === null) {
        try { port = spawnSequencePort(stages); }
        catch (thrown) {
          const error: AnalysisError = { kind: 'worker', op: first, message: `the sequence worker could not be started: ${describeThrown(thrown)}` };
          diag.log({ event: 'stage.failed', op: first, error });
          return on.onFailed(first, error);
        }
      }
      const seq: Sequence = { port, stages, input, on, signal, onAbort: () => cancel(seq), index: 0, postedAt: null, largestRun: null };
      live = seq;
      signal.addEventListener('abort', seq.onAbort, { once: true });
      if (spawned) {
        try { port.postMessage({ type: 'init', ortBase: deps.ortBase, threads: deps.threads }, []); }
        catch (thrown) { return failWorker(port, `init could not be posted: ${describeThrown(thrown)}`); }
      }
      resume();
    },

    cancelHeavy(reason) {
      if (live !== null) cancel(live);
      if (reason === 'timeout' && sequencePort !== null && flight !== null) failWorker(sequencePort, 'the stage timed out');
    },

    openDecoder(input) {
      if (liveDecoder !== null) endDecoder(liveDecoder, { kind: 'released' }, { kind: 'cancelled' }, 'replaced');
      const slot: DecoderSlot = { id: nextJobId++, state: { kind: 'open', input, pending: new Map() } };
      liveDecoder = slot;
      startDecoderPort();
      resumeDecoder();
      return decoderHandle(slot, input.scene);
    },

    openFaceTracker() {
      if (liveFace !== null) stopFace(liveFace, new Error('Face tracker released.'));
      const slot: FaceSlot = { error: null, pending: null, resolveReady: () => undefined, rejectReady: () => undefined };
      const ready = new Promise<void>((resolve, reject) => { slot.resolveReady = resolve; slot.rejectReady = reject; });
      void ready.catch(() => undefined);
      liveFace = slot;
      const handle: FaceTracker = {
        ready,
        track(frame) {
          const owner = faceResident;
          if (slot.error !== null || owner === null) { frame.close(); return Promise.reject(slot.error ?? new Error('Face worker unavailable.')); }
          if (owner.busy !== null) { frame.close(); return Promise.resolve(null); }
          const id = nextJobId++;
          return new Promise((resolve, reject) => {
            slot.pending = { id, resolve, reject }; owner.busy = id;
            try { owner.port.postMessage({ type: 'track', jobId: id, frame }, [frame]); }
            catch (error) { frame.close(); failFaceWorker(owner, new Error(describeThrown(error))); }
          });
        },
        release() { stopFace(slot, new Error('Face tracker released.')); },
      };
      try {
        if (faceResident === null) {
          if (deps.spawnFaceTracker === undefined) throw new Error('No face worker configured.');
          const port = deps.spawnFaceTracker();
          const owner: FaceResident = { port, ready: false, busy: null }; faceResident = owner;
          diag.log({ event: 'worker.spawn', worker: 'face', reason: 'open' });
          port.addEventListener('message', ({ data }) => {
            if (faceResident !== owner) return;
            const parsed = parseFaceReply(data);
            if (!parsed.ok) { failFaceWorker(owner, new Error(parsed.error.detail)); return; }
            const reply = parsed.value;
            if (reply.type === 'failed') { failFaceWorker(owner, new Error(reply.message)); return; }
            if (reply.type === 'ready') { owner.ready = true; liveFace?.resolveReady(); return; }
            if (owner.busy !== reply.jobId) return;
            owner.busy = null;
            const job = liveFace?.pending;
            if (job === null || job === undefined || job.id !== reply.jobId) return;
            if (liveFace !== null) liveFace.pending = null;
            job.resolve(reply.face);
          });
          port.addEventListener('error', (event) => failFaceWorker(owner, new Error('message' in event && typeof event.message === 'string' ? event.message : 'Face worker failed.')));
          port.addEventListener('messageerror', () => failFaceWorker(owner, new Error('Face reply could not be deserialized.')));
          try { port.postMessage({ type: 'init', ortBase: deps.ortBase }, []); }
          catch (error) { failFaceWorker(owner, new Error(describeThrown(error))); }
        } else if (faceResident.ready) slot.resolveReady();
      } catch (error) { stopFace(slot, new Error(describeThrown(error))); }
      return handle;
    },

    async fetchModels(ops, signal, onProgress) {
      const models = [...new Set(ops.map((op) => deps.lock.ops[op].model))];
      for (const model of models) diag.log({ event: 'fetch.start', model });
      try {
        const opened = await deps.loader;
        if (!opened.ok) return opened;
        return await opened.value.fetchModels(ops, signal, onProgress);
      } finally {
        for (const model of models) diag.log({ event: 'fetch.end', model });
      }
    },

    get alive() {
      return { heavy: live !== null, decoder: liveDecoder !== null };
    },

    get lastHeavyTermination() {
      return lastHeavyTermination;
    },
  };
}
