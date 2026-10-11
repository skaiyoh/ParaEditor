// The decode worker: one resident runtime reused across scenes. `init` loads the
// runtime once, creates the decoder's session from the verified model cache,
// and keeps the scene's embeddings, as input tensors, and the guide's size;
// each `decode` runs the session on its tap points and posts the three
// candidate masks at the guide's size, made by analysis/stage-math.ts. Every
// request is parsed on receipt and handled one at a time, in arrival order,
// and every `decode` is answered with exactly one `decoded` or one `failed`.
// `release` drops the scene's session and tensors; another `init` replaces it
// only after that release completes. The page terminates only a fatal worker.
// docs/ARCHITECTURE.md ("The decode worker") documents each request's answer
// and the failure paths.
//
// Worker-global calls (self.postMessage, the message handler, self.close)
// live only in *-worker.ts entries (docs/ARCHITECTURE.md, "Type checking").

import type { InferenceSession, Tensor } from 'noisy:vendor-ort';
import type { Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import { bundledLock } from './bundled-lock.ts';
import { createSession, describeThrown, loadOrt, modelStore, releaseSession, runSession, type ModelStore, type OrtRuntime } from './ort-runtime.ts';
import { oneLine, parseDecodeRequest, type DecodeLifecycleReply, type DecodeReply, type DecodeRequest } from './protocol.ts';
import { decodeCandidates, decoderEmbeddings, decoderPrompt, DECODER_BOXES, DECODER_LABELS, DECODER_POINTS } from './stage-math.ts';

type InitRequest = Extract<DecodeRequest, { readonly type: 'init' | 'initialize' }>;
type DecodeJob = Extract<DecodeRequest, { readonly type: 'decode' }>;

/** What the worker holds between requests. */
type State =
  | { readonly kind: 'waiting-for-init' }
  /** `init` failed; every later `decode` is answered `failed` with this message. */
  | { readonly kind: 'init-failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly runtime: OrtRuntime;
      readonly session: InferenceSession;
      /** The embeddings as the decoder's input tensors, by name, made once at init. */
      readonly embeddings: Readonly<Record<string, Tensor>>;
      /** The guide's size: every candidate mask is made at it. */
      readonly guide: Size;
      /** The session's creation time, reported once, on the first `decoded` reply. */
      sessionMs: number;
    };

let state: State = { kind: 'waiting-for-init' };
let runtime: Promise<Result<OrtRuntime, string>> | null = null;
let store: Promise<ModelStore> | null = null;
/** Pending requests for only the newest scene, handled in arrival order. */
const queue: DecodeRequest[] = [];
let draining = false;
let stopped = false;
let control: MessagePort | null = null;

const post = (reply: DecodeReply, transfer: readonly ArrayBuffer[] = []): void => self.postMessage(reply, [...transfer]);
const acknowledge = (reply: DecodeLifecycleReply): void => {
  if (control === null) throw new Error('the decoder has no lifecycle channel');
  control.postMessage(reply);
};

const fail = (jobId: number, message: string): void => post({ type: 'failed', jobId, message: oneLine(message) });

/** A release failure is fatal: creating another session could leave two alive. */
async function release(session: InferenceSession): Promise<void> {
  const released = await releaseSession(session);
  if (!released.ok) throw new Error(`the decoder could not release its session: ${released.error}`);
}

/** Drops scene data before awaiting release; the queue admits no next init yet. */
async function handleRelease(): Promise<void> {
  const previous = state;
  state = { kind: 'waiting-for-init' };
  if (previous.kind === 'ready') await release(previous.session);
}

/**
 * Loads the lock, the runtime, and the decoder's session, and keeps the
 * embeddings and the guide's size. Invalid embeddings fail later decodes;
 * runtime or session initialization failures are fatal. Every `init` releases
 * the previous session first. The embeddings are checked
 * against the lock before the model store, the runtime, and the session are
 * loaded, so embeddings of another model or with other tensors fail at once.
 */
async function handleInit(request: InitRequest): Promise<void> {
  await handleRelease();
  let openedSession: InferenceSession | null = null;
  try {
    const lock = bundledLock();
    if (!lock.ok) {
      state = { kind: 'init-failed', message: lock.error };
      return;
    }
    const files = lock.value.ops.decode;
    const tensors = decoderEmbeddings(request.embeddings, files.model);
    if (!tensors.ok) {
      state = { kind: 'init-failed', message: tensors.error };
      return;
    }
    const verified = await (store ??= modelStore({ lock: lock.value, subtle: crypto.subtle, caches, origin: self.location.origin }));
    runtime ??= loadOrt({ ortBase: request.ortBase, threads: 'default', worker: 'decode' });
    const loaded = await runtime;
    if (!loaded.ok) throw new Error(loaded.error);
    const opened = await createSession(loaded.value, verified, files);
    if (!opened.ok) throw new Error(opened.error);
    openedSession = opened.value.session;
    const { ort } = loaded.value;
    const embeddings: Record<string, Tensor> = {};
    for (const tensor of tensors.value) embeddings[tensor.name] = new ort.Tensor('float32', tensor.data, tensor.dims);
    state = {
      kind: 'ready',
      runtime: loaded.value,
      session: opened.value.session,
      embeddings,
      guide: { width: request.guide.size.width, height: request.guide.size.height },
      sessionMs: opened.value.sessionMs,
    };
    openedSession = null;
  } catch (thrown) {
    state = { kind: 'init-failed', message: describeThrown(thrown) };
    // A runtime or session initialization failure can leave ORT's backend
    // poisoned. Only a new worker can reliably retry it.
    throw thrown;
  } finally {
    // Tensor construction can fail after session creation; that session still
    // belongs to this init until the ready state takes ownership of it.
    if (openedSession !== null) await release(openedSession);
  }
}

type Ready = Extract<State, { readonly kind: 'ready' }>;

/** One decode on the resident session: its prompt, its run, and its candidates. */
async function runDecode(ready: Ready, request: DecodeJob): Promise<Result<{ readonly reply: DecodeReply; readonly transfer: readonly ArrayBuffer[] }, string>> {
  const { ort } = ready.runtime;
  const prompt = decoderPrompt(request.points);
  if (!prompt.ok) return prompt;
  const { input_points: points, input_labels: labels, input_boxes: boxes } = prompt.value;
  const feeds: InferenceSession.FeedsType = {
    ...ready.embeddings,
    [DECODER_POINTS]: new ort.Tensor('float32', points.data, points.dims),
    [DECODER_LABELS]: new ort.Tensor('int64', labels.data, labels.dims),
    [DECODER_BOXES]: new ort.Tensor('float32', boxes.data, boxes.dims),
  };
  const ran = await runSession(ready.session, feeds);
  if (!ran.ok) return ran;
  const result = decodeCandidates(ran.value.outputs, ready.guide);
  if (!result.ok) return result;
  const wasmHighWaterBytes = ready.runtime.wasmHighWaterBytes();
  if (wasmHighWaterBytes === null) return err('the runtime created no wasm memory this worker saw, so the decode has no high-water mark');
  const sessionMs = ready.sessionMs;
  ready.sessionMs = 0;
  const transfer: ArrayBuffer[] = [];
  for (const candidate of result.value.candidates) if (candidate.mask.data.buffer instanceof ArrayBuffer) transfer.push(candidate.mask.data.buffer);
  return ok({
    reply: { type: 'decoded', jobId: request.jobId, result: result.value, timings: { sessionMs, inferMs: ran.value.inferMs, wasmHighWaterBytes } },
    transfer,
  });
}

/** Answers the decode with exactly one `decoded` or one `failed`. */
async function handleDecode(request: DecodeJob): Promise<void> {
  try {
    if (state.kind === 'waiting-for-init') return fail(request.jobId, 'no init request came before this decode');
    if (state.kind === 'init-failed') return fail(request.jobId, `the decoder did not start: ${state.message}`);
    const decoded = await runDecode(state, request);
    if (!decoded.ok) return fail(request.jobId, decoded.error);
    post(decoded.value.reply, decoded.value.transfer);
  } catch (thrown) {
    fail(request.jobId, describeThrown(thrown));
  }
}

/** Handles requests in arrival order; fatal initialization or release rejects and stops the worker. */
async function drain(): Promise<void> {
  draining = true;
  try {
    for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
      switch (request.type) {
        case 'control':
          if (control !== null) throw new Error('the decoder already has a lifecycle channel');
          control = request.port;
          break;
        case 'init':
          await handleInit(request);
          break;
        case 'initialize':
          await handleInit(request);
          acknowledge({ type: 'initialized', requestId: request.requestId, message: state.kind === 'init-failed' ? state.message : null });
          break;
        case 'decode':
          await handleDecode(request);
          break;
        case 'release':
          await handleRelease();
          break;
        case 'dispose':
          await handleRelease();
          acknowledge({ type: 'disposed', requestId: request.requestId });
          break;
        default: {
          const exhaustive: never = request;
          return exhaustive;
        }
      }
    }
  } finally {
    draining = false;
  }
}

// A request that does not parse is thrown from the handler, so the page's
// Worker receives an `error` event naming it; nothing here cancels that event.
self.onmessage = (event: MessageEvent<unknown>) => {
  if (stopped) return;
  const parsed = parseDecodeRequest(event.data);
  if (!parsed.ok) throw new Error(`the decode worker cannot read a request: ${parsed.error.detail}`);
  if (parsed.value.type === 'init' || parsed.value.type === 'initialize' || parsed.value.type === 'release' || parsed.value.type === 'dispose') {
    // A running init/release may await ORT while new scenes arrive. Keep only
    // the newest queued scene so obsolete 16 MiB embeddings can be collected.
    // Init releases the current session itself, so a queued release is redundant.
    for (const obsolete of queue.splice(0)) {
      if (obsolete.type === 'decode') fail(obsolete.jobId, 'the decoder scene was replaced before this decode could run');
    }
  }
  queue.push(parsed.value);
  if (!draining) void drain().catch((thrown: unknown) => {
    stopped = true;
    queue.length = 0;
    // A rejected promise is not a Worker error event. Throw on a task so the
    // owner receives the fatal error and terminates this runtime before reuse.
    setTimeout(() => { throw new Error(`the decoder worker failed: ${describeThrown(thrown)}`); }, 0);
  });
};

self.onmessageerror = () => {
  throw new Error('the decode worker received a request it could not deserialize');
};
