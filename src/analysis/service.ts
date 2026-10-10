// The analysis service: the page's one owner of the two analysis workers. It
// runs an ordered list of heavy stages in one sequence worker, hands each
// product to the caller as it lands, ends every sequence in exactly one
// terminal callback, terminates the worker on every terminal path, and
// records the termination the cooldown rule reads; it opens the resident
// decode worker on a scene's embeddings and guide and hands back the one
// handle that decodes, each decode resolving exactly once; and it fetches
// models through the model loader and logs the analysis part of the
// diagnostic vocabulary. Deciding what to run, the watchdogs, the cooldowns,
// the retries, and when a decoder lives are the caller's.
//
// Every browser object arrives in its deps, each worker as a spawn function
// returning a narrow port that the browser's Worker satisfies, so node tests
// drive the service with scripted ports. docs/ARCHITECTURE.md ("The analysis
// service") states each member's behavior.

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
  /** The sequence failed or was cancelled at `stage`; its worker is already terminated. */
  readonly onFailed: (stage: StageKind, error: AnalysisError) => void;
  /** Every stage's product has been handed on and the worker is terminated. */
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
  /** Terminates the worker and settles pending startup/tracking; idempotent. */
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
  /** Terminates the worker and resolves every pending and later decode with `cancelled`; does nothing the second time. */
  release(): void;
}

export type AnalysisServiceDeps = {
  readonly clock: Pick<Clock, 'now'>;
  readonly diag: DiagnosticSink<AnalysisEvent>;
  /** Starts a sequence worker; a page passes `() => new Worker(<the sequence worker's URL>, { type: 'module', name: 'sequence' })`. */
  readonly spawn: () => SequenceWorkerPort;
  /** Starts a decode worker; a page passes `() => new Worker(<the decode worker's URL>, { type: 'module', name: 'decode' })`. */
  readonly spawnDecoder: () => DecodeWorkerPort;
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
   * Runs `stages` in order in one new sequence worker, cancelling a sequence
   * still alive first, and hands each product to `on` as it lands. The
   * sequence ends in exactly one of `on.onDone` and `on.onFailed`, after every
   * product of the stages that completed, and its worker is terminated before
   * either is called. An abort of `signal` cancels it as `cancelHeavy` does.
   * When the cancelled sequence's `onFailed` starts another sequence, that
   * one stands and this one ends at once in `onFailed` with `cancelled`.
   */
  runSequence(scene: SceneId, stages: NonEmpty<HeavyStage>, input: SequenceInput, on: SequenceListener, signal: AbortSignal): void;
  /** Terminates the sequence worker at once and ends its sequence in `onFailed` with `cancelled`; does nothing when none is alive. */
  cancelHeavy(): void;
  /**
   * Spawns a decode worker for `input`, first terminating the decoder alive,
   * whose handle then acts as released, and posts its `init` with the
   * embeddings and the guide copied, not transferred: the caller keeps both,
   * and the service keeps neither. Returns the new decoder's handle.
   */
  openDecoder(input: DecoderInput): Decoder;
  openFaceTracker(): FaceTracker;
  /**
   * Gets the model files `ops` need through the loader, logging `fetch.start`
   * and `fetch.end` for each model of `ops` around the call. Resolves with the
   * loader's failure to open or the fetch's result.
   */
  fetchModels(ops: readonly ModelOp[], signal: AbortSignal, onProgress: (model: ModelId, fraction: number) => void): Promise<Result<void, AnalysisError>>;
  /** `heavy` is true exactly while a sequence worker is alive, and `decoder` while a decode worker is, each from its spawn to its terminate. */
  readonly alive: { readonly heavy: boolean; readonly decoder: boolean };
  /** The last sequence worker this service terminated after it had run at least one stage, or null before that. */
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

/** One sequence, from its worker's spawn to its terminal callback. */
type Sequence = {
  readonly port: SequenceWorkerPort;
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

/** A decode posted to the worker and not yet resolved; whoever removes it from its decoder's pending map resolves it, through exactly one of these. */
type PendingDecode = {
  readonly done: (result: DecodeResult, wasmHighWaterBytes: number) => void;
  readonly fail: (error: AnalysisError) => void;
};

/** One decoder's lifecycle: its worker alive with the decodes it has not answered, stopped by a failure, or released (replaced included). */
type DecoderState =
  | { readonly kind: 'open'; readonly port: DecodeWorkerPort; readonly pending: Map<number, PendingDecode> }
  | { readonly kind: 'stopped'; readonly message: string }
  | { readonly kind: 'released' };

/** The state a handle reads; the service moves it, and only an open decoder is alive. */
type DecoderSlot = { state: DecoderState };

export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService {
  const { clock, diag } = deps;
  let live: Sequence | null = null;
  let lastHeavyTermination: HeavyTermination | null = null;
  /** The decoder whose worker is alive, or null; at most one is. */
  let liveDecoder: DecoderSlot | null = null;
  let liveFace: FaceTracker | null = null;
  let nextJobId = 0;

  const currentStage = (seq: Sequence): HeavyStage => seq.stages[seq.index] ?? seq.stages[0];

  /** Stops `seq` once: terminates its worker and records the termination. False when it had already stopped. */
  const stop = (seq: Sequence, ending: Ending): boolean => {
    if (live !== seq) return false;
    live = null;
    seq.signal.removeEventListener('abort', seq.onAbort);
    if (ending.kind === 'failed') diag.log({ event: 'stage.failed', op: currentStage(seq).kind, error: ending.error });
    else {
      // The worker closes itself on `end`; the terminate below does not wait for that.
      try {
        seq.port.postMessage({ type: 'end' }, []);
      } catch {
        // The worker is terminated next whatever happened to `end`.
      }
    }
    seq.port.terminate();
    const atMs = clock.now();
    const reason = ending.kind === 'done' ? 'done' : ending.error.kind === 'cancelled' ? 'cancelled' : 'failed';
    diag.log({ event: 'worker.terminate', worker: 'sequence', reason });
    if (seq.largestRun !== null) lastHeavyTermination = { atMs, largest: seq.largestRun };
    return true;
  };

  /** Ends `seq` in failure once: stops it, then calls `onFailed` for its current stage. */
  const end = (seq: Sequence, error: AnalysisError): void => {
    if (stop(seq, { kind: 'failed', error })) seq.on.onFailed(currentStage(seq).kind, error);
  };

  const fail = (seq: Sequence, message: string): void => end(seq, { kind: 'worker', op: currentStage(seq).kind, message: oneLine(message) });
  const cancel = (seq: Sequence): void => end(seq, { kind: 'cancelled' });

  /** Gets the current stage's bitmap and posts its run. */
  const post = async (seq: Sequence): Promise<void> => {
    const stage = currentStage(seq);
    let image: ImageBitmap;
    try {
      image = await seq.input.master();
    } catch (thrown) {
      return fail(seq, `the master bitmap for the ${stage.kind} stage could not be made: ${describeThrown(thrown)}`);
    }
    if (live !== seq) {
      image.close();
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
      fail(seq, `the ${stage.kind} run could not be posted: ${describeThrown(thrown)}`);
    }
  };

  const onReply = (seq: Sequence, data: unknown): void => {
    if (live !== seq) return;
    const parsed = parseSequenceReply(data);
    if (!parsed.ok) return fail(seq, `a reply from the worker did not parse: ${parsed.error.detail}`);
    const reply = parsed.value;
    const stage = currentStage(seq);
    const { postedAt } = seq;
    if (reply.type === 'failed') return fail(seq, reply.message);
    if (postedAt === null) return fail(seq, `the worker sent a ${reply.type} reply while no run was posted`);
    if (reply.type === 'phase') {
      if (reply.stage !== stage.kind) return fail(seq, `the worker reported the ${reply.stage} stage's ${reply.phase} phase while ${stage.kind} was running`);
      if (reply.phase === 'infer') seq.largestRun = larger(seq.largestRun, stage.kind);
      seq.on.onPhase(stage.kind, reply.phase, reply.fraction);
      return;
    }
    if (reply.type !== PRODUCT_OF[stage.kind]) return fail(seq, `the worker answered ${reply.type} to the ${stage.kind} run`);
    diag.log({ event: 'stage.end', op: stage.kind, ms: clock.now() - postedAt, wasmHighWaterBytes: reply.timings.wasmHighWaterBytes });
    // The stage is answered before its product is handed on, so a cancel or a
    // new sequence from inside the callback names the next stage, and after
    // the last product the sequence is already over: the worker is stopped
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
    else if (live === seq) void post(seq);
  };

  const decodeError = (message: string): AnalysisError => ({ kind: 'worker', op: 'decode', message: oneLine(message) });

  /**
   * Ends the open decoder in `slot` once: moves it to `next`, resolves each
   * pending decode with `error`, terminates the worker, and logs the
   * terminate with `reason`. Does nothing when the decoder is not open.
   */
  const endDecoder = (slot: DecoderSlot, next: DecoderState, error: AnalysisError, reason: 'released' | 'replaced' | 'failed'): void => {
    const state = slot.state;
    if (state.kind !== 'open') return;
    slot.state = next;
    if (liveDecoder === slot) liveDecoder = null;
    const pending = [...state.pending.values()];
    state.pending.clear();
    for (const job of pending) job.fail(error);
    state.port.terminate();
    diag.log({ event: 'worker.terminate', worker: 'decode', reason });
  };

  /** Stops the decoder in `slot` after its worker failed: every pending decode, and every later one, resolves `worker`. */
  const failDecoder = (slot: DecoderSlot, message: string): void => endDecoder(slot, { kind: 'stopped', message: oneLine(message) }, decodeError(message), 'failed');

  const onDecodeReply = (slot: DecoderSlot, data: unknown): void => {
    const state = slot.state;
    if (state.kind !== 'open') return;
    const parsed = parseDecodeReply(data);
    if (!parsed.ok) return failDecoder(slot, `a reply from the worker did not parse: ${parsed.error.detail}`);
    const reply = parsed.value;
    // A reply naming no pending decode, as the late answer to a cancelled one, is dropped.
    const job = state.pending.get(reply.jobId);
    if (job === undefined) return;
    state.pending.delete(reply.jobId);
    if (reply.type === 'failed') job.fail(decodeError(reply.message));
    else job.done(reply.result, reply.timings.wasmHighWaterBytes);
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
      diag.log({ event: 'stage.start', op: 'decode', ms: 0, wasmHighWaterBytes: null });
      const postedAt = clock.now();
      state.pending.set(jobId, {
        done: (result, wasmHighWaterBytes) => {
          signal.removeEventListener('abort', onAbort);
          diag.log({ event: 'stage.end', op: 'decode', ms: clock.now() - postedAt, wasmHighWaterBytes });
          resolve(ok(result));
        },
        fail: (error) => {
          signal.removeEventListener('abort', onAbort);
          diag.log({ event: 'stage.failed', op: 'decode', error });
          resolve(err(error));
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        state.port.postMessage({ type: 'decode', jobId, points }, []);
      } catch (thrown) {
        const job = state.pending.get(jobId);
        state.pending.delete(jobId);
        job?.fail(decodeError(`the decode could not be posted: ${describeThrown(thrown)}`));
      }
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
        error = decodeError(`the decoder stopped: ${state.message}`);
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
      let port: SequenceWorkerPort;
      try {
        port = deps.spawn();
      } catch (thrown) {
        const error: AnalysisError = { kind: 'worker', op: first, message: `the sequence worker could not be started: ${describeThrown(thrown)}` };
        diag.log({ event: 'stage.failed', op: first, error });
        return on.onFailed(first, error);
      }
      diag.log({ event: 'worker.spawn', worker: 'sequence', reason: stages.map((stage) => stage.kind).join(',') });
      const seq: Sequence = { port, stages, input, on, signal, onAbort: () => cancel(seq), index: 0, postedAt: null, largestRun: null };
      live = seq;
      port.addEventListener('message', (event) => onReply(seq, event.data));
      port.addEventListener('error', (event) => {
        const detail = 'message' in event && typeof event.message === 'string' && event.message !== '' ? event.message : 'an error event without a message';
        fail(seq, `the worker raised an error: ${detail}`);
      });
      port.addEventListener('messageerror', () => fail(seq, 'a reply from the worker could not be deserialized'));
      signal.addEventListener('abort', seq.onAbort, { once: true });
      try {
        port.postMessage({ type: 'init', ortBase: deps.ortBase, threads: deps.threads }, []);
      } catch (thrown) {
        return fail(seq, `init could not be posted: ${describeThrown(thrown)}`);
      }
      void post(seq);
    },

    cancelHeavy() {
      if (live !== null) cancel(live);
    },

    openDecoder(input) {
      if (liveDecoder !== null) endDecoder(liveDecoder, { kind: 'released' }, { kind: 'cancelled' }, 'replaced');
      const slot: DecoderSlot = { state: { kind: 'released' } };
      let port: DecodeWorkerPort;
      try {
        port = deps.spawnDecoder();
      } catch (thrown) {
        slot.state = { kind: 'stopped', message: `the decode worker could not be started: ${describeThrown(thrown)}` };
        return decoderHandle(slot, input.scene);
      }
      diag.log({ event: 'worker.spawn', worker: 'decode', reason: 'open' });
      slot.state = { kind: 'open', port, pending: new Map() };
      liveDecoder = slot;
      port.addEventListener('message', (event) => onDecodeReply(slot, event.data));
      port.addEventListener('error', (event) => {
        const detail = 'message' in event && typeof event.message === 'string' && event.message !== '' ? event.message : 'an error event without a message';
        failDecoder(slot, `the worker raised an error: ${detail}`);
      });
      port.addEventListener('messageerror', () => failDecoder(slot, 'a reply from the worker could not be deserialized'));
      // The embeddings and the guide are cloned, not transferred, so the caller's stay whole.
      try {
        port.postMessage({ type: 'init', ortBase: deps.ortBase, embeddings: input.embeddings, guide: input.guide }, []);
      } catch (thrown) {
        failDecoder(slot, `init could not be posted: ${describeThrown(thrown)}`);
      }
      return decoderHandle(slot, input.scene);
    },

    openFaceTracker() {
      liveFace?.release();
      type Job = { id: number; resolve: (face: FaceDetection | null) => void; reject: (error: Error) => void };
      type FaceState = { kind: 'open'; port: FaceWorkerPort; pending: Job | null } | { kind: 'stopped'; error: Error };
      let state: FaceState = { kind: 'stopped', error: new Error('Face tracker released.') };
      let resolveReady: () => void = () => undefined;
      let rejectReady: (error: Error) => void = () => undefined;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      void ready.catch(() => undefined);
      const stopFace = (error: Error, reason: 'released' | 'failed'): void => {
        const previous = state;
        state = { kind: 'stopped', error };
        rejectReady(error);
        if (previous.kind !== 'open') return;
        previous.pending?.reject(error);
        previous.port.terminate();
        diag.log({ event: 'worker.terminate', worker: 'face', reason });
        if (liveFace === handle) liveFace = null;
      };
      const handle: FaceTracker = {
        ready,
        track(frame) {
          if (state.kind !== 'open') { frame.close(); return Promise.reject(state.error); }
          if (state.pending !== null) { frame.close(); return Promise.resolve(null); }
          const open = state, id = nextJobId++;
          return new Promise((resolve, reject) => {
            open.pending = { id, resolve, reject };
            try { open.port.postMessage({ type: 'track', jobId: id, frame }, [frame]); }
            catch (error) { frame.close(); stopFace(new Error(describeThrown(error)), 'failed'); }
          });
        },
        release() { stopFace(new Error('Face tracker released.'), 'released'); },
      };
      try {
        if (deps.spawnFaceTracker === undefined) throw new Error('No face worker configured.');
        const port = deps.spawnFaceTracker();
        state = { kind: 'open', port, pending: null }; liveFace = handle;
        diag.log({ event: 'worker.spawn', worker: 'face', reason: 'open' });
        port.addEventListener('message', ({ data }) => {
          if (state.kind !== 'open') return;
          const parsed = parseFaceReply(data);
          if (!parsed.ok) { stopFace(new Error(parsed.error.detail), 'failed'); return; }
          const reply = parsed.value;
          if (reply.type === 'failed') { stopFace(new Error(reply.message), 'failed'); return; }
          if (reply.type === 'ready') { resolveReady(); return; }
          const job = state.pending;
          if (job === null || job.id !== reply.jobId) return;
          state.pending = null; job.resolve(reply.face);
        });
        port.addEventListener('error', (event) => stopFace(new Error('message' in event && typeof event.message === 'string' ? event.message : 'Face worker failed.'), 'failed'));
        port.addEventListener('messageerror', () => stopFace(new Error('Face reply could not be deserialized.'), 'failed'));
        port.postMessage({ type: 'init', ortBase: deps.ortBase }, []);
      } catch (error) { stopFace(new Error(describeThrown(error)), 'failed'); }
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
