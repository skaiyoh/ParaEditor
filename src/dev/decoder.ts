// The decoder page (/dev/decoder.html, dev builds only). At load it parses its
// levers and the build's model lock, starts opening the model loader, and
// builds one analysis service on the real workers, as the composition root
// will. Run reads the master (raw RGBA bytes) and the truth masks from the
// page's file inputs, fetches the models through the service, runs the
// encoder as one sequence (or makes stand-in embeddings), builds the guide
// from the master at long edge 1024, opens the decoder, makes each decode the
// levers list, checks every candidate against that decode's truth with
// checkMask, releases the decoder, and makes one decode after the release.
// The report lists each outcome, the service's events, `alive.decoder` at
// each step, and every reply the decode worker sent with its timings; once
// the run is done it is also posted to the results sink, and a run that fails
// is not posted.
//
// Levers, in the query: `width` and `height` (the master's size, required);
// `threads` (the encoder's thread count: a whole number, or default; default
// 2); `embeddings` (encoder, the default; zeros, the table's tensors filled
// with 0; other-model, those made by the depth model; wrong-tensors, the
// third tensor's dims reordered); `decode` (repeatable, one decode each: its
// points as `x,y,include|exclude` joined by `;`, in frame fractions);
// `abort=<index>:before|during` (repeatable: that decode's signal aborts
// before the call or right after it); `release=before|during|after` (when
// the decoder is released: before the decodes, right after they are made,
// or once they resolve; default after); `reopen=1` (open a decoder, make one
// decode on it, then open the decoder the decodes use, which replaces it);
// `unparseable=1` (post the decode worker a message it cannot parse right
// after the decodes are made); `step=1` (wait for Continue between the
// encoder and the decoder); and `evict=<served path>` (delete that file from
// the verified cache after the fetch).

import { bundledLock } from '../analysis/bundled-lock.ts';
import { checkMask, type MaskCheck } from '../analysis/checks.ts';
import { modelFileUrl, type ParsedLock } from '../analysis/lock.ts';
import { openModelLoader, webLocks } from '../analysis/models.ts';
import { parseDecodeReply, type SamEmbeddings, type StageTimings } from '../analysis/protocol.ts';
import { createAnalysisService, type AnalysisError, type AnalysisEvent, type DecodeResult, type Decoder } from '../analysis/service.ts';
import { SAM_EMBEDDING_TENSORS } from '../analysis/stage-math.ts';
import { isSceneId, type NonEmpty, type SceneId } from '../core/ids.ts';
import type { Plane, Rgb8, Size } from '../core/raster.ts';
import type { Result } from '../core/result.ts';
import type { TapPoint } from '../core/types.ts';
import { createBrowserClock } from '../platform/clock.ts';
import { createDiagnostics } from '../platform/diagnostics.ts';

/** An encoder run or a set of decodes that has not ended by then fails the page. */
const STEP_TIMEOUT_MS = 150_000;
/** A row the sink has not accepted by then is reported as not posted. */
const POST_TIMEOUT_MS = 10_000;
/** The scene id every decoder names; the service logs no scene. */
const SCENE = '00000000-0000-4000-8000-000000000000';
/** The guide's long edge, as the decoder's caller makes it. */
const GUIDE_LONG_EDGE = 1024;
/** The point the decode after the release, and the replaced decoder's decodes, use when no decode is listed. */
const CENTER: NonEmpty<TapPoint> = [{ at: { x: 0.5, y: 0.5 }, label: 'include' }];

const EMBEDDINGS = ['encoder', 'zeros', 'other-model', 'wrong-tensors'] as const;
type EmbeddingsLever = (typeof EMBEDDINGS)[number];
const isEmbeddingsLever = (text: string): text is EmbeddingsLever => EMBEDDINGS.some((e) => e === text);
type ReleaseAt = 'before' | 'during' | 'after';

type Levers = {
  readonly master: Size;
  readonly threads: number | 'default';
  readonly embeddings: EmbeddingsLever;
  readonly decodes: readonly NonEmpty<TapPoint>[];
  readonly aborts: readonly { readonly index: number; readonly when: 'before' | 'during' }[];
  readonly release: ReleaseAt;
  readonly reopen: boolean;
  readonly unparseable: boolean;
  readonly step: boolean;
  readonly evict: string | null;
};

/** One candidate as the report lists it: its score, size, how many texels are at or above 128, and its check against the decode's truth. */
type CandidateSummary = { readonly score: number; readonly size: Size; readonly inside: number; readonly check: MaskCheck | { readonly error: string } | null };
type Outcome = { readonly kind: 'ok'; readonly candidates: readonly CandidateSummary[] } | { readonly kind: 'err'; readonly error: AnalysisError };
type DecodeEntry = { readonly index: number; readonly points: NonEmpty<TapPoint>; readonly abort: 'before' | 'during' | null; outcome: Outcome | null; elapsedMs: number | null };
/** One reply the decode worker sent, as the page's own listener on the Worker parsed it. */
type RawReply =
  | { readonly type: 'decoded'; readonly jobId: number; readonly timings: StageTimings }
  | { readonly type: 'failed'; readonly jobId: number; readonly message: string }
  | { readonly type: 'unparsed'; readonly detail: string };

type Report = {
  phase: 'starting' | 'ready' | 'fetching' | 'encoding' | 'encoded' | 'decoding' | 'done' | 'failed';
  /** Why the page failed, when it did. */
  detail: string | null;
  levers: Levers | null;
  env: { readonly crossOriginIsolated: boolean; readonly hardwareConcurrency: number; readonly userAgent: string };
  fetch: Result<void, AnalysisError> | null;
  evicted: boolean | null;
  /** The encoder sequence's end: `done`, or `failed` with its error; null when no encoder ran. */
  encode: { readonly kind: 'done'; readonly ms: number } | { readonly kind: 'failed'; readonly error: AnalysisError } | null;
  guide: Size | null;
  /** With `reopen`: the replaced decoder's decode made before the replacement and one made after it. */
  replaced: { pending: Outcome | null; later: Outcome | null } | null;
  /** `alive.decoder` after the open, after the decodes resolved, and after the release. */
  alive: { afterOpen: boolean | null; afterDecodes: boolean | null; afterRelease: boolean | null };
  decodes: DecodeEntry[];
  afterRelease: Outcome | null;
  replies: RawReply[];
  /** The message of each `error` event the decode worker raised, as the page's own listener saw it. */
  errors: string[];
  /** The events the service logged during the run, the fetch's included, each with its time. */
  events: (AnalysisEvent & { readonly t: number })[];
};

class LeverError extends Error {}

function readPoints(text: string): NonEmpty<TapPoint> {
  const points = text.split(';').map((part): TapPoint => {
    const [x = '', y = '', label = ''] = part.split(',');
    const at = { x: Number(x), y: Number(y) };
    if (!(at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1) || (label !== 'include' && label !== 'exclude')) {
      throw new LeverError('?decode= must list points as x,y,include|exclude with x and y from 0 to 1, joined by ;.');
    }
    return { at, label };
  });
  const [first, ...rest] = points;
  if (first === undefined) throw new LeverError('?decode= must list at least one point.');
  return [first, ...rest];
}

function readLevers(params: URLSearchParams): Levers {
  const whole = (name: string, text: string | null = params.get(name)): number => {
    if (text === null || !/^[1-9]\d*$/.test(text)) throw new LeverError(`?${name}= must be a whole number above 0.`);
    return Number(text);
  };
  const threadsText = params.get('threads') ?? '2';
  const embeddings = params.get('embeddings') ?? 'encoder';
  if (!isEmbeddingsLever(embeddings)) throw new LeverError(`?embeddings= must be one of ${EMBEDDINGS.join(', ')}.`);
  const decodes = params.getAll('decode').map(readPoints);
  const aborts = params.getAll('abort').map((text): Levers['aborts'][number] => {
    const [index = '', when = ''] = text.split(':');
    if (!/^\d+$/.test(index) || Number(index) >= decodes.length || (when !== 'before' && when !== 'during')) {
      throw new LeverError('?abort= must be <index of a decode>:before|during.');
    }
    return { index: Number(index), when };
  });
  const release = params.get('release') ?? 'after';
  if (release !== 'before' && release !== 'during' && release !== 'after') throw new LeverError('?release= must be before, during, or after.');
  return {
    master: { width: whole('width'), height: whole('height') },
    threads: threadsText === 'default' ? 'default' : whole('threads', threadsText),
    embeddings,
    decodes,
    aborts,
    release,
    reopen: params.get('reopen') === '1',
    unparseable: params.get('unparseable') === '1',
    step: params.get('step') === '1',
    evict: params.get('evict'),
  };
}

/** The guide's size: long edge 1024, the short side the master's aspect rounded to the nearest texel, at least 1. */
function guideSize(master: Size): Size {
  const long = Math.max(master.width, master.height);
  const side = (extent: number): number => Math.max(1, Math.round((extent * GUIDE_LONG_EDGE) / long));
  return { width: side(master.width), height: side(master.height) };
}

/** The guide: the master drawn at `size` with high-quality smoothing, as RGB. */
async function makeGuide(master: ImageData, size: Size): Promise<Rgb8> {
  const bitmap = await createImageBitmap(master);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new LeverError('an OffscreenCanvas gave no 2D context.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const rgba = context.getImageData(0, 0, size.width, size.height).data;
  const data = new Uint8Array(size.width * size.height * 3);
  for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
    data[i] = rgba[j] ?? 0;
    data[i + 1] = rgba[j + 1] ?? 0;
    data[i + 2] = rgba[j + 2] ?? 0;
  }
  return { size, data };
}

/** Stand-in embeddings of the table's names and dims, all zeros: `model` names their maker, and `wrongTensors` gives the third tensor its dims reordered. */
function standInEmbeddings(model: SamEmbeddings['model'], wrongTensors: boolean): SamEmbeddings {
  const [a, b, c] = SAM_EMBEDDING_TENSORS.map((spec, i) => {
    const dims = wrongTensors && i === 2 ? [1, 64, 256, 64] : [...spec.dims];
    return { name: spec.name, dims, data: new Float32Array(dims.reduce((n, d) => n * d, 1)) };
  });
  if (a === undefined || b === undefined || c === undefined) throw new LeverError('the embeddings table does not hold three tensors.');
  return { model, tensors: [a, b, c] };
}

function summarize(result: Result<DecodeResult, AnalysisError>, truth: Plane<'u8'> | null): Outcome {
  if (!result.ok) return { kind: 'err', error: result.error };
  return {
    kind: 'ok',
    candidates: result.value.candidates.map((candidate) => {
      let inside = 0;
      for (const byte of candidate.mask.data) if (byte >= 128) inside += 1;
      const check = truth === null ? null : checkMask({ mask: candidate.mask, truth });
      return { score: candidate.score, size: candidate.mask.size, inside, check: check === null ? null : check.ok ? check.value : { error: check.error } };
    }),
  };
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

/** `promise`, or a LeverError naming `what` after STEP_TIMEOUT_MS. */
function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new LeverError(`${what} had not ended after ${STEP_TIMEOUT_MS} ms.`)), STEP_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

type Elements = { readonly out: HTMLElement; readonly run: HTMLElement; readonly next: HTMLElement; readonly master: HTMLInputElement; readonly truths: HTMLInputElement };

async function start(elements: Elements): Promise<void> {
  const { out, run, next } = elements;
  const report: Report = {
    phase: 'starting',
    detail: null,
    levers: null,
    env: { crossOriginIsolated: window.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent },
    fetch: null,
    evicted: null,
    encode: null,
    guide: null,
    replaced: null,
    alive: { afterOpen: null, afterDecodes: null, afterRelease: null },
    decodes: [],
    afterRelease: null,
    replies: [],
    errors: [],
    events: [],
  };
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
    levers = readLevers(new URLSearchParams(window.location.search));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  report.levers = levers;
  if (!isSceneId(SCENE)) return fail("the page's scene id is not one");
  const scene: SceneId = SCENE;

  const clock = createBrowserClock(window);
  const diag = createDiagnostics<AnalysisEvent>(clock);
  const loader = openModelLoader({
    lock: lock.value,
    origin: window.location.origin,
    caches,
    fetch: (url, init) => window.fetch(url, init),
    subtle: crypto.subtle,
    locks: webLocks(navigator.locks),
    clock,
  });
  /** Every decode worker the service started, newest last, so `unparseable` can reach the live one. */
  const decodeWorkers: Worker[] = [];
  const service = createAnalysisService({
    clock,
    diag,
    spawn: () => new Worker(NOISY_WORKER_URLS.sequence, { type: 'module', name: 'sequence' }),
    spawnDecoder: () => {
      const worker = new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' });
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        const parsed = parseDecodeReply(event.data);
        if (!parsed.ok) report.replies.push({ type: 'unparsed', detail: parsed.error.detail });
        else if (parsed.value.type === 'decoded') report.replies.push({ type: 'decoded', jobId: parsed.value.jobId, timings: parsed.value.timings });
        else report.replies.push({ type: 'failed', jobId: parsed.value.jobId, message: parsed.value.message });
      });
      worker.addEventListener('error', (event) => {
        report.errors.push(event.message || 'an error event without a message');
      });
      decodeWorkers.push(worker);
      return worker;
    },
    ortBase: NOISY_ORT_DIR,
    threads: levers.threads,
    lock: lock.value,
    loader,
  });
  report.phase = 'ready';
  render();

  const runOnce = async (): Promise<void> => {
    const { width, height } = levers.master;
    const file = elements.master.files?.[0];
    if (file === undefined) throw new LeverError('choose the master file first.');
    const bytes = new Uint8ClampedArray(await file.arrayBuffer());
    if (bytes.length !== width * height * 4) throw new LeverError(`the master file holds ${bytes.length} bytes, not ${width * height * 4}.`);
    const imageData = new ImageData(bytes, width, height);
    const size = guideSize(levers.master);
    const truths: Plane<'u8'>[] = [];
    for (const truthFile of elements.truths.files ?? []) {
      const data = new Uint8Array(await truthFile.arrayBuffer());
      if (data.length !== size.width * size.height) throw new LeverError(`the truth file ${truthFile.name} holds ${data.length} bytes, not ${size.width * size.height}.`);
      truths.push({ format: 'u8', size, data });
    }
    const firstEvent = diag.events.length;
    const collect = (): void => {
      report.events = diag.events.slice(firstEvent);
      render();
    };

    report.phase = 'fetching';
    render();
    report.fetch = await service.fetchModels(levers.embeddings === 'encoder' ? ['encode', 'decode'] : ['decode'], new AbortController().signal, () => undefined);
    collect();
    if (!report.fetch.ok) throw new LeverError(`the model fetch failed: ${JSON.stringify(report.fetch.error)}`);
    if (levers.evict !== null) {
      const opened = await loader;
      if (!opened.ok) throw new LeverError('the model loader did not open.');
      const verified = await caches.open(opened.value.cacheName);
      report.evicted = await verified.delete(modelFileUrl({ served: levers.evict }, window.location.origin));
    }

    let embeddings: SamEmbeddings;
    if (levers.embeddings === 'encoder') {
      report.phase = 'encoding';
      render();
      const began = performance.now();
      let made: SamEmbeddings | null = null;
      const ended = new Promise<void>((resolve) => {
        service.runSequence(
          scene,
          [{ kind: 'encode' }],
          { master: () => createImageBitmap(imageData) },
          {
            onPhase: () => undefined,
            onDepth: () => undefined,
            onEmbeddings: (value) => {
              made = value;
            },
            onPlate: () => undefined,
            onFailed: (_stage, error) => {
              report.encode = { kind: 'failed', error };
              resolve();
            },
            onDone: () => {
              report.encode = { kind: 'done', ms: Math.round(performance.now() - began) };
              resolve();
            },
          },
          new AbortController().signal,
        );
      });
      await withTimeout(ended, 'the encoder');
      collect();
      if (made === null) throw new LeverError(`the encoder gave no embeddings: ${JSON.stringify(report.encode)}`);
      embeddings = made;
    } else {
      const ops: Pick<ParsedLock['ops'], 'decode' | 'depth'> = lock.value.ops;
      embeddings = standInEmbeddings(levers.embeddings === 'other-model' ? ops.depth.model : ops.decode.model, levers.embeddings === 'wrong-tensors');
    }

    if (levers.step) {
      report.phase = 'encoded';
      render();
      await new Promise<void>((resolve) => {
        next.addEventListener('click', () => resolve(), { once: true });
        next.removeAttribute('disabled');
      });
      next.setAttribute('disabled', '');
    }

    report.phase = 'decoding';
    report.guide = size;
    render();
    const guide = await makeGuide(imageData, size);
    const signal = (): AbortSignal => new AbortController().signal;
    if (levers.reopen) {
      const old = service.openDecoder({ scene, embeddings, guide });
      const pending = old.decode(levers.decodes[0] ?? CENTER, signal());
      const decoder = service.openDecoder({ scene, embeddings, guide });
      const later = old.decode(levers.decodes[0] ?? CENTER, signal());
      report.replaced = { pending: summarize(await pending, null), later: summarize(await later, null) };
      await runDecodes(decoder);
    } else {
      await runDecodes(service.openDecoder({ scene, embeddings, guide }));
    }
    collect();

    async function runDecodes(decoder: Decoder): Promise<void> {
      report.alive.afterOpen = service.alive.decoder;
      if (levers.release === 'before') decoder.release();
      const made = levers.decodes.map((points, index) => {
        const abort = levers.aborts.find((a) => a.index === index)?.when ?? null;
        const entry: DecodeEntry = { index, points, abort, outcome: null, elapsedMs: null };
        report.decodes.push(entry);
        const controller = new AbortController();
        if (abort === 'before') controller.abort();
        const began = performance.now();
        const promise = decoder.decode(points, controller.signal).then((result) => {
          entry.outcome = summarize(result, truths[index] ?? null);
          entry.elapsedMs = Math.round(performance.now() - began);
          render();
        });
        if (abort === 'during') controller.abort();
        return promise;
      });
      if (levers.release === 'during') decoder.release();
      if (levers.unparseable) decodeWorkers.at(-1)?.postMessage('not a decode request');
      await withTimeout(Promise.all(made), 'the decodes');
      report.alive.afterDecodes = service.alive.decoder;
      if (levers.release === 'after') decoder.release();
      // A second release, which must change nothing.
      decoder.release();
      report.alive.afterRelease = service.alive.decoder;
      report.afterRelease = summarize(await decoder.decode(levers.decodes[0] ?? CENTER, signal()), null);
    }
  };

  run.addEventListener('click', () => {
    if (report.phase !== 'ready') return;
    run.setAttribute('disabled', '');
    void runOnce()
      .then(async () => {
        report.phase = 'done';
        render();
        out.dataset['row'] = 'posting';
        const posted = await postRow({ kind: 'decoder-run', buildId: NOISY_BUILD_ID, ...report });
        out.dataset['row'] = posted ? 'posted' : 'not-posted';
      })
      .catch((e: unknown) => fail(e instanceof LeverError ? e.message : `the run threw: ${String(e)}`));
  });
  run.removeAttribute('disabled');
}

const out = document.getElementById('report');
const run = document.getElementById('run');
const next = document.getElementById('continue');
const master = document.getElementById('master');
const truths = document.getElementById('truths');
if (out !== null && run !== null && next !== null && master instanceof HTMLInputElement && truths instanceof HTMLInputElement) {
  // Wrap long lines at phone width; set through the CSSOM, which the CSP allows.
  out.style.whiteSpace = 'pre-wrap';
  out.style.overflowWrap = 'anywhere';
  void start({ out, run, next, master, truths });
}
