// The decode worker: the resident SAM decoder for one scene. `init` loads the
// runtime once, creates the decoder's session from the verified model cache,
// and keeps the scene's embeddings, as input tensors, and the guide's size;
// each `decode` runs the session on its tap points and posts the three
// candidate masks at the guide's size, made by analysis/stage-math.ts. Every
// request is parsed on receipt and handled one at a time, in arrival order,
// and every `decode` is answered with exactly one `decoded` or one `failed`.
// The protocol has no `end` for this worker: the page terminates it.
// docs/ARCHITECTURE.md ("The decode worker") documents each request's answer
// and the failure paths.
//
// Worker-global calls (self.postMessage, the message handler, self.close)
// live only in *-worker.ts entries (docs/ARCHITECTURE.md, "Type checking").

import type { InferenceSession, Tensor } from 'noisy:vendor-ort';
import type { Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import { bundledLock } from './bundled-lock.ts';
import { createSession, describeThrown, loadOrt, modelStore, runSession, type OrtRuntime } from './ort-runtime.ts';
import { oneLine, parseDecodeRequest, type DecodeReply, type DecodeRequest } from './protocol.ts';
import { decodeCandidates, decoderEmbeddings, decoderPrompt, DECODER_BOXES, DECODER_LABELS, DECODER_POINTS } from './stage-math.ts';

type InitRequest = Extract<DecodeRequest, { readonly type: 'init' }>;
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
/** Requests received and not yet handled, in arrival order. */
const queue: DecodeRequest[] = [];
let draining = false;

const post = (reply: DecodeReply, transfer: readonly ArrayBuffer[] = []): void => self.postMessage(reply, [...transfer]);

const fail = (jobId: number, message: string): void => post({ type: 'failed', jobId, message: oneLine(message) });

/**
 * Loads the lock, the runtime, and the decoder's session, and keeps the
 * embeddings and the guide's size; a failure is held and answered to every
 * later decode. Only the first `init` counts. The embeddings are checked
 * against the lock before the model store, the runtime, and the session are
 * loaded, so embeddings of another model or with other tensors fail at once.
 */
async function handleInit(request: InitRequest): Promise<void> {
  if (state.kind !== 'waiting-for-init') return;
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
    const store = await modelStore({ lock: lock.value, subtle: crypto.subtle, caches, origin: self.location.origin });
    const runtime = await loadOrt({ ortBase: request.ortBase, threads: 'default' });
    if (!runtime.ok) {
      state = { kind: 'init-failed', message: runtime.error };
      return;
    }
    const opened = await createSession(runtime.value, store, files);
    if (!opened.ok) {
      state = { kind: 'init-failed', message: opened.error };
      return;
    }
    const { ort } = runtime.value;
    const embeddings: Record<string, Tensor> = {};
    for (const tensor of tensors.value) embeddings[tensor.name] = new ort.Tensor('float32', tensor.data, tensor.dims);
    state = {
      kind: 'ready',
      runtime: runtime.value,
      session: opened.value.session,
      embeddings,
      guide: { width: request.guide.size.width, height: request.guide.size.height },
      sessionMs: opened.value.sessionMs,
    };
  } catch (thrown) {
    state = { kind: 'init-failed', message: describeThrown(thrown) };
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

/** Handles the queued requests one at a time, in arrival order; each handler answers its own failures and never rejects. */
async function drain(): Promise<void> {
  draining = true;
  try {
    for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
      switch (request.type) {
        case 'init':
          await handleInit(request);
          break;
        case 'decode':
          await handleDecode(request);
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
  const parsed = parseDecodeRequest(event.data);
  if (!parsed.ok) throw new Error(`the decode worker cannot read a request: ${parsed.error.detail}`);
  queue.push(parsed.value);
  if (!draining) void drain();
};

self.onmessageerror = () => {
  throw new Error('the decode worker received a request it could not deserialize');
};
