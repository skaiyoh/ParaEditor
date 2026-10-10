// The sequence worker page (/dev/sequence.html, dev builds only). At load it
// parses its levers and the build's model lock and opens the model loader;
// Run reads the master (raw RGBA bytes) and, for inpaint, the hole (one byte
// per pixel) from the page's file inputs, and any truth planes chosen beside
// them, fetches the models the stages need,
// starts the real sequence worker, and drives it over its protocol: `init`,
// a fresh bitmap per `run`, then `end`, all posted at once, so the worker
// queues them. Once every run is answered it posts one more run, which a
// worker that closed on `end` never answers, and listens for a further second
// before it terminates the worker, so a reply after the last answer reaches
// the report too. Every reply is parsed with the page's parser and summarized
// in one JSON report, which is also posted to the results sink once the run
// is done; a run that fails is not posted. When truth planes were chosen, the
// page runs the known-answer check of analysis/checks.ts on each depth map
// and plate as it arrives and puts the check's numbers and verdict in the
// product's summary; the planes stay in
// the page.
//
// Levers, in the query: `stages` (comma-separated depth, encode, inpaint;
// default depth), `threads` (a whole number, or default), `width` and `height`
// (the master's size, required), `hole` (`file`, or `mismatched` for a hole of
// another size than the master), `init=0` (send no init), `unparseable=1` (send
// a request the worker cannot parse after init), `secondInit=1` (send a second
// init, with an `ortBase` that serves no runtime and threads 1, after the
// first), `afterEnd=1` (send one more run of the first stage after end), and
// `evict=<served path>` (delete that file from the verified cache after the
// fetch).

import { bundledLock } from '../analysis/bundled-lock.ts';
import { checkDepth, checkInpaint, type DepthCheck, type InpaintCheck } from '../analysis/checks.ts';
import { depthInputSize } from '../analysis/depth-size.ts';
import { modelFileUrl, type ParsedLock } from '../analysis/lock.ts';
import { openModelLoader, webLocks, type ModelLoader } from '../analysis/models.ts';
import { parseSequenceReply, type AnalysisError, type SequenceReply, type StageTimings } from '../analysis/protocol.ts';
import type { Plane, Rgb8, Size } from '../core/raster.ts';
import type { Result } from '../core/result.ts';
import { createBrowserClock } from '../platform/clock.ts';

/** A run that has not been answered by then fails the page. */
const ANSWER_TIMEOUT_MS = 150_000;
/** How long the page listens, once every run is answered and the probe run posted, before it terminates the worker. */
const QUIET_MS = 1_000;
/** A row the sink has not accepted by then is reported as not posted. */
const POST_TIMEOUT_MS = 10_000;

type Stage = 'depth' | 'encode' | 'inpaint';
const STAGES: readonly Stage[] = ['depth', 'encode', 'inpaint'];
const isStage = (text: string): text is Stage => STAGES.some((stage) => stage === text);

type Levers = {
  readonly stages: readonly Stage[];
  readonly threads: number | 'default';
  readonly master: Size;
  readonly hole: 'file' | 'mismatched';
  readonly init: boolean;
  readonly unparseable: boolean;
  readonly secondInit: boolean;
  readonly afterEnd: boolean;
  readonly evict: string | null;
};

/** One reply as the report lists it: what it carried, without the bulk of its arrays. */
type ReplySummary =
  | { readonly type: 'unparsed'; readonly detail: string }
  | { readonly type: 'phase'; readonly stage: Stage; readonly phase: 'session' | 'infer'; readonly fraction: number | null }
  | {
      readonly type: 'depth';
      readonly size: Size;
      readonly length: number;
      readonly min: number;
      readonly max: number;
      readonly stats: { readonly p10: number; readonly median: number; readonly p90: number };
      readonly timings: StageTimings;
      /** The depth check's result, or null when no near and far planes were chosen. */
      readonly check: Result<DepthCheck, string> | null;
    }
  | {
      readonly type: 'embeddings';
      readonly model: string;
      readonly tensors: readonly { readonly name: string; readonly dims: readonly number[]; readonly length: number }[];
      readonly timings: StageTimings;
    }
  | {
      readonly type: 'plate';
      readonly size: Size;
      readonly length: number;
      readonly timings: StageTimings;
      /** The inpaint check's result, or null when no ring plane was chosen. */
      readonly check: Result<InpaintCheck, string> | null;
    }
  | { readonly type: 'failed'; readonly stage: Stage; readonly message: string };

type Report = {
  phase: 'starting' | 'ready' | 'fetching' | 'running' | 'done' | 'failed';
  /** Why the page failed, when it did. */
  detail: string | null;
  levers: Levers | null;
  env: { readonly crossOriginIsolated: boolean; readonly hardwareConcurrency: number; readonly userAgent: string };
  fetch: Result<void, AnalysisError> | null;
  /** Whether `evict` deleted its file from the verified cache. */
  evicted: boolean | null;
  /** The requests posted, in order: `init`, `unparseable`, `run <stage>`, `end`, and `run <stage> after the answers`. */
  posted: string[];
  /** Every reply, in arrival order. */
  replies: ReplySummary[];
  /** The message of each `error` event the Worker received. */
  errors: string[];
  messageErrors: number;
  /** How many replies other than a `phase` came: products, `failed`, and replies the parser refused. */
  answered: number;
  elapsedMs: number | null;
};

class LeverError extends Error {}

/** The truth planes chosen beside the master, which the page checks each depth map and plate against. */
type Truth = {
  /** The depth check's near and far regions, at depthInputSize(master), the depth map's size. */
  readonly depth: { readonly near: Plane<'u8'>; readonly far: Plane<'u8'> } | null;
  /** The inpaint check's original, the master as Rgb8, with the hole sent and the ring, at the master's size. */
  readonly inpaint: { readonly original: Rgb8; readonly hole: Plane<'u8'>; readonly ring: Plane<'u8'> } | null;
};

function wholeAtLeastOne(params: URLSearchParams, name: string): number {
  const text = params.get(name);
  if (text === null || !/^[1-9]\d*$/.test(text)) throw new LeverError(`?${name}= must be a whole number above 0.`);
  return Number(text);
}

function readLevers(params: URLSearchParams, lock: ParsedLock): Levers {
  const stages = (params.get('stages') ?? 'depth').split(',');
  const parsedStages = stages.filter(isStage);
  if (parsedStages.length === 0 || parsedStages.length !== stages.length) throw new LeverError(`?stages=${params.get('stages') ?? ''} must list depth, encode, or inpaint.`);
  const threadsText = params.get('threads') ?? 'default';
  const threads = threadsText === 'default' ? 'default' : wholeAtLeastOne(params, 'threads');
  const hole = params.get('hole') ?? 'file';
  if (hole !== 'file' && hole !== 'mismatched') throw new LeverError('?hole= must be file or mismatched.');
  const evict = params.get('evict');
  const served = Object.values(lock.lock.models).flatMap((model) => model.files.map((file) => file.served));
  if (evict !== null && !served.includes(evict)) throw new LeverError(`?evict=${evict} names no file of the lock.`);
  return {
    stages: parsedStages,
    threads,
    master: { width: wholeAtLeastOne(params, 'width'), height: wholeAtLeastOne(params, 'height') },
    hole,
    init: params.get('init') !== '0',
    unparseable: params.get('unparseable') === '1',
    secondInit: params.get('secondInit') === '1',
    afterEnd: params.get('afterEnd') === '1',
    evict,
  };
}

function summarize(reply: SequenceReply, truth: Truth): ReplySummary {
  switch (reply.type) {
    case 'phase':
      return { type: 'phase', stage: reply.stage, phase: reply.phase, fraction: reply.fraction };
    case 'depth': {
      let min = Infinity;
      let max = -Infinity;
      for (const value of reply.map.data) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
      const check = truth.depth === null ? null : checkDepth({ depth: reply.map, ...truth.depth });
      return { type: 'depth', size: reply.map.size, length: reply.map.data.length, min, max, stats: reply.stats, timings: reply.timings, check };
    }
    case 'embeddings':
      return {
        type: 'embeddings',
        model: reply.embeddings.model,
        tensors: reply.embeddings.tensors.map((tensor) => ({ name: tensor.name, dims: tensor.dims, length: tensor.data.length })),
        timings: reply.timings,
      };
    case 'plate':
      const check = truth.inpaint === null ? null : checkInpaint({ ...truth.inpaint, plate: reply.image });
      return { type: 'plate', size: reply.image.size, length: reply.image.data.length, timings: reply.timings, check };
    case 'failed':
      return { type: 'failed', stage: reply.stage, message: reply.message };
    default: {
      const exhaustive: never = reply;
      return exhaustive;
    }
  }
}

const chosen = (input: HTMLInputElement): boolean => (input.files?.length ?? 0) > 0;

async function fileBytes(input: HTMLInputElement, what: string, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  const file = input.files?.[0];
  if (file === undefined) throw new LeverError(`choose the ${what} file first.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== expected) throw new LeverError(`the ${what} file holds ${bytes.length} bytes, not ${expected}.`);
  return bytes;
}

async function postRow(row: object): Promise<boolean> {
  try {
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type Elements = {
  readonly out: HTMLElement;
  readonly button: HTMLElement;
  readonly master: HTMLInputElement;
  readonly hole: HTMLInputElement;
  readonly near: HTMLInputElement;
  readonly far: HTMLInputElement;
  readonly ring: HTMLInputElement;
};

function u8Plane(size: Size, data: Uint8Array): Plane<'u8'> {
  return { format: 'u8', size: { width: size.width, height: size.height }, data };
}

/** The master's RGBA bytes as Rgb8, alpha dropped. */
function toRgb8(rgba: Uint8ClampedArray, size: Size): Rgb8 {
  const n = size.width * size.height;
  const data = new Uint8Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    data[3 * i] = rgba[4 * i] ?? 0;
    data[3 * i + 1] = rgba[4 * i + 1] ?? 0;
    data[3 * i + 2] = rgba[4 * i + 2] ?? 0;
  }
  return { size: { width: size.width, height: size.height }, data };
}

/**
 * The truth planes chosen: the near and far files, both or neither, one byte per texel of depthInputSize(master);
 * and the ring file, one byte per pixel of the master, which needs the hole file.
 */
async function readTruth(levers: Levers, elements: Elements, rgba: Uint8ClampedArray, holeBytes: Uint8Array | null): Promise<Truth> {
  const { master } = levers;
  let depth: Truth['depth'] = null;
  if (chosen(elements.near) !== chosen(elements.far)) throw new LeverError('choose both the near and the far file, or neither.');
  if (chosen(elements.near)) {
    const size = depthInputSize(master);
    const count = size.width * size.height;
    depth = {
      near: u8Plane(size, await fileBytes(elements.near, 'near', count)),
      far: u8Plane(size, await fileBytes(elements.far, 'far', count)),
    };
  }
  let inpaint: Truth['inpaint'] = null;
  if (chosen(elements.ring)) {
    if (holeBytes === null) throw new LeverError('the ring file needs an inpaint run with the hole file.');
    const ring = await fileBytes(elements.ring, 'ring', master.width * master.height);
    inpaint = { original: toRgb8(rgba, master), hole: u8Plane(master, holeBytes), ring: u8Plane(master, ring) };
  }
  return { depth, inpaint };
}

/** Drives one sequence: the fetch, the worker, every reply, until each run is answered and the probe after them has had its time. */
async function sequence(report: Report, levers: Levers, loader: ModelLoader, elements: Elements, render: () => void): Promise<void> {
  const { width, height } = levers.master;
  const rgba = new Uint8ClampedArray(await fileBytes(elements.master, 'master', width * height * 4));
  const imageData = new ImageData(rgba, width, height);
  const holeBytes = levers.stages.includes('inpaint') && levers.hole === 'file' ? await fileBytes(elements.hole, 'hole', width * height) : null;
  const truth = await readTruth(levers, elements, rgba, holeBytes);

  report.phase = 'fetching';
  render();
  report.fetch = await loader.fetchModels(levers.stages, new AbortController().signal, () => undefined);
  if (!report.fetch.ok) throw new LeverError(`the model fetch failed: ${JSON.stringify(report.fetch.error)}`);
  if (levers.evict !== null) {
    const verified = await caches.open(loader.cacheName);
    report.evicted = await verified.delete(modelFileUrl({ served: levers.evict }, window.location.origin));
  }

  const workerUrl = NOISY_WORKER_URLS.sequence;
  const runs: Stage[] = [...levers.stages, ...(levers.afterEnd ? [levers.stages[0] ?? 'depth'] : [])];
  // A fresh bitmap for each run and for the probe after the answers, each transferred with it.
  const bitmaps = await Promise.all([...runs, 'probe'].map(() => createImageBitmap(imageData)));
  report.phase = 'running';
  render();
  const began = performance.now();
  const worker = new Worker(workerUrl, { type: 'module', name: 'sequence' });
  const answered = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new LeverError(`${runs.length - report.answered} of ${runs.length} runs had no answer after ${ANSWER_TIMEOUT_MS} ms.`)), ANSWER_TIMEOUT_MS);
    const settle = (): void => {
      if (report.answered < runs.length) return;
      window.clearTimeout(timer);
      resolve();
    };
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const parsed = parseSequenceReply(event.data);
      const summary = parsed.ok ? summarize(parsed.value, truth) : { type: 'unparsed' as const, detail: parsed.error.detail };
      report.replies.push(summary);
      if (summary.type !== 'phase') report.answered += 1;
      render();
      settle();
    });
    worker.addEventListener('error', (event) => {
      report.errors.push(event instanceof ErrorEvent && event.message !== '' ? event.message : 'an error event without a message');
      render();
    });
    worker.addEventListener('messageerror', () => {
      report.messageErrors += 1;
      render();
    });
  });

  const send = (label: string, message: unknown, transfer: Transferable[] = []): void => {
    report.posted.push(label);
    worker.postMessage(message, transfer);
  };
  const init = { type: 'init', ortBase: NOISY_ORT_DIR, threads: levers.threads };
  if (levers.init) send('init', init);
  if (levers.secondInit) send('init', { ...init, ortBase: `${NOISY_ORT_DIR}no-runtime-here/`, threads: 1 });
  if (levers.unparseable) send('unparseable', { type: 'run', stage: levers.stages[0] ?? 'depth' });
  const runRequest = (stage: Stage, image: ImageBitmap, label = `run ${stage}`): void => {
    if (stage !== 'inpaint') return send(label, { type: 'run', stage, image }, [image]);
    const hole: Plane<'u8'> =
      holeBytes === null
        ? { format: 'u8', size: { width: Math.max(1, width >> 1), height: Math.max(1, height >> 1) }, data: new Uint8Array(Math.max(1, width >> 1) * Math.max(1, height >> 1)) }
        : { format: 'u8', size: { width, height }, data: holeBytes.slice() };
    send(label, { type: 'run', stage, image, hole }, [image, hole.data.buffer]);
  };
  levers.stages.forEach((stage, i) => {
    const bitmap = bitmaps[i];
    if (bitmap !== undefined) runRequest(stage, bitmap);
  });
  send('end', { type: 'end' });
  const extra = bitmaps[levers.stages.length];
  if (levers.afterEnd && extra !== undefined) runRequest(runs[runs.length - 1] ?? 'depth', extra);
  try {
    await answered;
    report.elapsedMs = Math.round(performance.now() - began);
    // The worker closed itself on `end`, so this run is never answered; a reply
    // to it, or a second answer to the last run, lands in the report.
    const probe = bitmaps[runs.length];
    const probeStage = levers.stages[0] ?? 'depth';
    if (probe !== undefined) runRequest(probeStage, probe, `run ${probeStage} after the answers`);
    await new Promise((resolve) => window.setTimeout(resolve, QUIET_MS));
  } finally {
    report.elapsedMs ??= Math.round(performance.now() - began);
    worker.terminate();
  }
}

async function start(elements: Elements): Promise<void> {
  const report: Report = {
    phase: 'starting',
    detail: null,
    levers: null,
    env: { crossOriginIsolated: window.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent },
    fetch: null,
    evicted: null,
    posted: [],
    replies: [],
    errors: [],
    messageErrors: 0,
    answered: 0,
    elapsedMs: null,
  };
  const { out, button } = elements;
  const render = (): void => {
    out.dataset['phase'] = report.phase;
    out.textContent = JSON.stringify(report, null, 2);
  };
  const fail = (detail: string): void => {
    report.phase = 'failed';
    report.detail = detail;
    render();
  };
  render();

  const lock = bundledLock();
  if (!lock.ok) return fail(lock.error);
  let levers: Levers;
  try {
    levers = readLevers(new URLSearchParams(window.location.search), lock.value);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  report.levers = levers;
  const opened = await openModelLoader({
    lock: lock.value,
    origin: window.location.origin,
    caches,
    fetch: (url, init) => window.fetch(url, init),
    subtle: crypto.subtle,
    locks: webLocks(navigator.locks),
    clock: createBrowserClock(window),
  });
  if (!opened.ok) return fail(`the model loader did not open: ${JSON.stringify(opened.error)}`);
  report.phase = 'ready';
  render();

  button.addEventListener('click', () => {
    if (report.phase !== 'ready') return;
    button.setAttribute('disabled', '');
    void sequence(report, levers, opened.value, elements, render)
      .then(async () => {
        report.phase = 'done';
        render();
        out.dataset['row'] = 'posting';
        const posted = await postRow({ kind: 'sequence-run', buildId: NOISY_BUILD_ID, ...report });
        out.dataset['row'] = posted ? 'posted' : 'not-posted';
      })
      .catch((e: unknown) => fail(e instanceof LeverError ? e.message : `the run threw: ${String(e)}`));
  });
  button.removeAttribute('disabled');
}

const out = document.getElementById('report');
const button = document.getElementById('run');
const master = document.getElementById('master');
const hole = document.getElementById('hole');
const near = document.getElementById('near');
const far = document.getElementById('far');
const ring = document.getElementById('ring');
if (
  out !== null &&
  button !== null &&
  master instanceof HTMLInputElement &&
  hole instanceof HTMLInputElement &&
  near instanceof HTMLInputElement &&
  far instanceof HTMLInputElement &&
  ring instanceof HTMLInputElement
) {
  // Wrap long lines at phone width; set through the CSSOM, which the CSP allows.
  out.style.whiteSpace = 'pre-wrap';
  out.style.overflowWrap = 'anywhere';
  void start({ out, button, master, hole, near, far, ring });
}
