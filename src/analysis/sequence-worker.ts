// The sequence worker: runs the heavy stages a page asks for, one after
// another, in one ONNX Runtime wasm heap. `init` loads the runtime once; each
// `run` draws the bitmap it carries, creates the stage's session, runs it,
// turns the outputs into the stage's product with analysis/stage-math.ts,
// releases the session, and posts the product with its timings; `end` closes
// the worker. Every request is parsed on receipt and handled one at a time, in
// arrival order, and every `run` it receives before `end` closes it is
// answered with exactly one product or one `failed`. docs/ARCHITECTURE.md
// ("The sequence worker") documents each request's answer and the failure
// paths.
//
// Worker-global calls (self.postMessage, the message handler, self.close)
// live only in *-worker.ts entries (docs/ARCHITECTURE.md, "Type checking").

import type { InferenceSession } from 'noisy:vendor-ort';
import type { Size } from '../core/raster.ts';
import { err, ok, type Result } from '../core/result.ts';
import { bundledLock } from './bundled-lock.ts';
import { depthInputSize } from './depth-size.ts';
import type { OpFiles, ParsedLock } from './lock.ts';
import { createSession, describeThrown, loadOrt, modelStore, releaseSession, runSession, type ModelStore, type OrtRuntime } from './ort-runtime.ts';
import { oneLine, parseSequenceRequest, type SequenceReply, type SequenceRequest, type StageTimings } from './protocol.ts';
import { depthProduct, imagenetInput, miganInput, PIXEL_VALUES, plateFromResult, SAM_INPUT_SIZE, samEmbeddings, type TensorMap } from './stage-math.ts';

type RunRequest = Extract<SequenceRequest, { readonly type: 'run' }>;
type Stage = RunRequest['stage'];

/** What the worker holds between requests. */
type State =
  | { readonly kind: 'waiting-for-init' }
  /** `init` failed; every later `run` is answered `failed` with this message. */
  | { readonly kind: 'init-failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly runtime: OrtRuntime; readonly store: ModelStore; readonly lock: ParsedLock };

/** A stage's product and the buffers its reply transfers. */
type Product = { readonly reply: SequenceReply; readonly transfer: readonly ArrayBuffer[] };

let state: State = { kind: 'waiting-for-init' };
/** Requests received and not yet handled, in arrival order. */
const queue: SequenceRequest[] = [];
let draining = false;

const post = (reply: SequenceReply, transfer: readonly ArrayBuffer[] = []): void => self.postMessage(reply, [...transfer]);

const fail = (stage: Stage, message: string): void => post({ type: 'failed', stage, message: oneLine(message) });

/** The ArrayBuffer under each view, once each, for a transfer list; a view over a SharedArrayBuffer is left out. */
function buffersOf(views: readonly ArrayBufferView[]): readonly ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of views) if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  return [...buffers];
}

/**
 * Draws the bitmap at `size` on an OffscreenCanvas's 2D context with
 * high-quality smoothing, closes the bitmap, and hands the RGBA bytes to
 * `build`, which makes the model's input from them; only that input outlives
 * the call. The canvas's backing store is shrunk once read.
 */
function fromPixels<T>(bitmap: ImageBitmap, size: Size, build: (rgba: Uint8ClampedArray) => Result<T, string>): Result<T, string> {
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return err('an OffscreenCanvas gave no 2D context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const rgba = context.getImageData(0, 0, size.width, size.height).data;
  canvas.width = 1;
  canvas.height = 1;
  return build(rgba);
}

type Ready = Extract<State, { readonly kind: 'ready' }>;

/**
 * Creates the session of `files`, runs it on `feeds`, and gives its outputs to
 * `use`, which makes the product; then releases the session, whatever
 * happened, before the product is posted. Posts the `session` phase before the
 * files are read and the `infer` phase before the run. The timings are this
 * run's: `sessionMs` covers reading the files and creating the session,
 * `inferMs` the run alone, and the high-water mark is read once the session is
 * released.
 */
async function inSession<T>(
  ready: Ready,
  stage: Stage,
  files: OpFiles,
  feeds: InferenceSession.FeedsType,
  use: (outputs: TensorMap) => Result<T, string>,
): Promise<Result<{ readonly product: T; readonly timings: StageTimings }, string>> {
  post({ type: 'phase', stage, phase: 'session', fraction: null });
  const opened = await createSession(ready.runtime, ready.store, files);
  if (!opened.ok) return opened;
  const { session, sessionMs } = opened.value;
  let outcome: Result<{ readonly product: T; readonly inferMs: number }, string>;
  try {
    post({ type: 'phase', stage, phase: 'infer', fraction: null });
    const ran = await runSession(session, feeds);
    if (ran.ok) {
      const product = use(ran.value.outputs);
      outcome = product.ok ? ok({ product: product.value, inferMs: ran.value.inferMs }) : product;
    } else {
      outcome = ran;
    }
  } catch (thrown) {
    outcome = err(describeThrown(thrown));
  }
  const released = await releaseSession(session);
  if (!released.ok) return released;
  if (!outcome.ok) return outcome;
  const wasmHighWaterBytes = ready.runtime.wasmHighWaterBytes();
  if (wasmHighWaterBytes === null) return err('the runtime created no wasm memory this worker saw, so the stage has no high-water mark');
  return ok({ product: outcome.value.product, timings: { sessionMs, inferMs: outcome.value.inferMs, wasmHighWaterBytes } });
}

/** One stage on one bitmap: its input, its session, and its reply. */
async function runStage(ready: Ready, request: RunRequest): Promise<Result<Product, string>> {
  const { ort } = ready.runtime;
  const { ops } = ready.lock;
  const master: Size = { width: request.image.width, height: request.image.height };
  switch (request.stage) {
    case 'depth': {
      const size = depthInputSize(master);
      const input = fromPixels(request.image, size, (rgba) => imagenetInput(rgba, size));
      if (!input.ok) return input;
      const feeds = { [PIXEL_VALUES]: new ort.Tensor('float32', input.value.data, input.value.dims) };
      const ran = await inSession(ready, 'depth', ops.depth, feeds, (outputs) => depthProduct(outputs, size));
      if (!ran.ok) return ran;
      const { map, stats } = ran.value.product;
      return ok({ reply: { type: 'depth', map, stats, timings: ran.value.timings }, transfer: buffersOf([map.data]) });
    }
    case 'encode': {
      const input = fromPixels(request.image, SAM_INPUT_SIZE, (rgba) => imagenetInput(rgba, SAM_INPUT_SIZE));
      if (!input.ok) return input;
      const feeds = { [PIXEL_VALUES]: new ort.Tensor('float32', input.value.data, input.value.dims) };
      const ran = await inSession(ready, 'encode', ops.encode, feeds, (outputs) => samEmbeddings(outputs, ops.encode.model));
      if (!ran.ok) return ran;
      const embeddings = ran.value.product;
      return ok({ reply: { type: 'embeddings', embeddings, timings: ran.value.timings }, transfer: buffersOf(embeddings.tensors.map((tensor) => tensor.data)) });
    }
    case 'inpaint': {
      const { hole } = request;
      if (hole.size.width !== master.width || hole.size.height !== master.height) {
        return err(`hole: expected the image's size ${master.width} x ${master.height}, got ${hole.size.width} x ${hole.size.height}`);
      }
      const input = fromPixels(request.image, master, (rgba) => miganInput(rgba, master, hole));
      if (!input.ok) return input;
      const { image, mask } = input.value;
      const feeds = { image: new ort.Tensor('uint8', image.data, image.dims), mask: new ort.Tensor('uint8', mask.data, mask.dims) };
      const ran = await inSession(ready, 'inpaint', ops.inpaint, feeds, (outputs) => plateFromResult(outputs, master));
      if (!ran.ok) return ran;
      const plate = ran.value.product;
      return ok({ reply: { type: 'plate', image: plate, timings: ran.value.timings }, transfer: buffersOf([plate.data]) });
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** Loads the lock, names the model store, and loads the runtime; a failure is held and answered to every later run. Only the first `init` counts. */
async function handleInit(request: Extract<SequenceRequest, { readonly type: 'init' }>): Promise<void> {
  if (state.kind !== 'waiting-for-init') return;
  try {
    const lock = bundledLock();
    if (!lock.ok) {
      state = { kind: 'init-failed', message: lock.error };
      return;
    }
    const store = await modelStore({ lock: lock.value, subtle: crypto.subtle, caches, origin: self.location.origin });
    const runtime = await loadOrt({ ortBase: request.ortBase, threads: request.threads });
    state = runtime.ok ? { kind: 'ready', runtime: runtime.value, store, lock: lock.value } : { kind: 'init-failed', message: runtime.error };
  } catch (thrown) {
    state = { kind: 'init-failed', message: describeThrown(thrown) };
  }
}

/** Answers the run with exactly one product or one `failed`, and closes its bitmap whatever happens. */
async function handleRun(request: RunRequest): Promise<void> {
  try {
    if (state.kind === 'waiting-for-init') return fail(request.stage, 'no init request came before this run');
    if (state.kind === 'init-failed') return fail(request.stage, `the worker did not start: ${state.message}`);
    const product = await runStage(state, request);
    if (!product.ok) return fail(request.stage, product.error);
    post(product.value.reply, product.value.transfer);
  } catch (thrown) {
    fail(request.stage, describeThrown(thrown));
  } finally {
    request.image.close();
  }
}

/**
 * Answers each run still queued behind `end` with `failed`, then closes the
 * worker. Every stage released its session before its product was posted, so
 * no session is alive here. A request that arrives after the close is never
 * handled.
 */
function handleEnd(): void {
  for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
    if (request.type !== 'run') continue;
    fail(request.stage, 'the worker ended before this run');
    request.image.close();
  }
  self.close();
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
        case 'run':
          await handleRun(request);
          break;
        case 'end':
          handleEnd();
          return;
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

/** Closes the bitmap a message that did not parse carries at `image`, if it carries one, since no stage will draw it. */
function closeStrayBitmap(data: unknown): void {
  if (typeof data === 'object' && data !== null && 'image' in data && data.image instanceof ImageBitmap) data.image.close();
}

// A request that does not parse is thrown from the handler, so the page's
// Worker receives an `error` event naming it; nothing here cancels that event.
self.onmessage = (event: MessageEvent<unknown>) => {
  const parsed = parseSequenceRequest(event.data);
  if (!parsed.ok) {
    closeStrayBitmap(event.data);
    throw new Error(`the sequence worker cannot read a request: ${parsed.error.detail}`);
  }
  queue.push(parsed.value);
  if (!draining) void drain();
};

self.onmessageerror = () => {
  throw new Error('the sequence worker received a request it could not deserialize');
};
