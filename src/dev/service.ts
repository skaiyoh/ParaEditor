// The analysis service page (/dev/service.html, dev builds only). At load it
// parses its levers and the build's model lock, starts opening the model
// loader, and builds one analysis service on the real sequence worker, as the
// composition root will; each Run reads the master (raw RGBA bytes) from the
// page's file input, fetches the stages' models through the service, and runs
// the stages as one sequence, a fresh bitmap made from the master each time
// the service asks for one. The report lists, for each run, every listener
// callback, the service's `alive.heavy` and termination record as each
// terminal callback saw them, and the events the service logged; once the
// sequence ends it is also posted to the results sink.
//
// Levers, in the query: `width` and `height` (the master's size, required),
// `stages` (comma-separated depth and encode; default depth,encode), `threads`
// (a whole number, or default; default 2), `closed=<stage>` (the master for
// that stage is a closed bitmap, which the page cannot post), `cancelAt=<stage>:<phase>`
// (cancel when the worker reports that phase of that stage), and
// `cancelBy=cancelHeavy|abort` (how that cancel is made; default cancelHeavy).

import { bundledLock } from '../analysis/bundled-lock.ts';
import { openModelLoader, webLocks } from '../analysis/models.ts';
import { createAnalysisService, type AnalysisError, type AnalysisEvent, type HeavyStage, type HeavyTermination } from '../analysis/service.ts';
import { isSceneId, type NonEmpty, type SceneId } from '../core/ids.ts';
import type { Size } from '../core/raster.ts';
import type { Result } from '../core/result.ts';
import { createBrowserClock } from '../platform/clock.ts';
import { createDiagnostics } from '../platform/diagnostics.ts';

/** A sequence that has not ended by then fails the page. */
const SEQUENCE_TIMEOUT_MS = 150_000;
/** A row the sink has not accepted by then is reported as not posted. */
const POST_TIMEOUT_MS = 10_000;
/** The scene id every run names; the service logs no scene. */
const SCENE = '00000000-0000-4000-8000-000000000000';

type Stage = 'depth' | 'encode';
const STAGES: readonly Stage[] = ['depth', 'encode'];
const isStage = (text: string): text is Stage => STAGES.some((stage) => stage === text);
const PHASES = ['session', 'infer'] as const;
type Phase = (typeof PHASES)[number];
const isPhase = (text: string): text is Phase => PHASES.some((phase) => phase === text);

type Levers = {
  readonly master: Size;
  readonly stages: NonEmpty<Stage>;
  readonly threads: number | 'default';
  readonly closed: Stage | null;
  readonly cancelAt: { readonly stage: Stage; readonly phase: Phase } | null;
  readonly cancelBy: 'cancelHeavy' | 'abort';
};

/** One listener callback as the report lists it, without the bulk of a product. */
type Callback =
  | { readonly kind: 'phase'; readonly stage: HeavyStage['kind']; readonly phase: Phase; readonly fraction: number | null }
  | { readonly kind: 'depth'; readonly size: Size; readonly length: number; readonly stats: { readonly p10: number; readonly median: number; readonly p90: number } }
  | { readonly kind: 'embeddings'; readonly model: string; readonly tensors: readonly { readonly name: string; readonly dims: readonly number[] }[] }
  | { readonly kind: 'plate'; readonly size: Size }
  | { readonly kind: 'failed'; readonly stage: HeavyStage['kind']; readonly error: AnalysisError; readonly heavy: boolean; readonly record: HeavyTermination | null }
  | { readonly kind: 'done'; readonly heavy: boolean; readonly record: HeavyTermination | null };

type Run = {
  fetch: Result<void, AnalysisError> | null;
  /** The termination record before the sequence started. */
  recordBefore: HeavyTermination | null;
  /** `alive.heavy` just after runSequence returned. */
  heavyAfterStart: boolean | null;
  callbacks: Callback[];
  /** The events the service logged during the run, the fetch's included, each with its time. */
  events: (AnalysisEvent & { readonly t: number })[];
  /** The termination record and `alive.heavy` once the run is over. */
  recordAfter: HeavyTermination | null;
  heavyAfter: boolean | null;
  elapsedMs: number | null;
};

type Report = {
  phase: 'starting' | 'ready' | 'fetching' | 'running' | 'done' | 'failed';
  /** Why the page failed, when it did. */
  detail: string | null;
  levers: Levers | null;
  env: { readonly crossOriginIsolated: boolean; readonly hardwareConcurrency: number; readonly userAgent: string };
  runs: Run[];
};

class LeverError extends Error {}

function readLevers(params: URLSearchParams): Levers {
  const whole = (name: string, text: string | null = params.get(name)): number => {
    if (text === null || !/^[1-9]\d*$/.test(text)) throw new LeverError(`?${name}= must be a whole number above 0.`);
    return Number(text);
  };
  const stages = (params.get('stages') ?? 'depth,encode').split(',').filter(isStage);
  const [first, ...rest] = stages;
  if (first === undefined || stages.length !== (params.get('stages') ?? 'depth,encode').split(',').length) throw new LeverError('?stages= must list depth or encode, comma-separated.');
  const threadsText = params.get('threads') ?? '2';
  const closed = params.get('closed');
  if (closed !== null && !isStage(closed)) throw new LeverError('?closed= must be depth or encode.');
  const cancelAtText = params.get('cancelAt');
  let cancelAt: Levers['cancelAt'] = null;
  if (cancelAtText !== null) {
    const [stage = '', phase = ''] = cancelAtText.split(':');
    if (!isStage(stage) || !isPhase(phase)) throw new LeverError('?cancelAt= must be <depth|encode>:<session|infer>.');
    cancelAt = { stage, phase };
  }
  const cancelBy = params.get('cancelBy') ?? 'cancelHeavy';
  if (cancelBy !== 'cancelHeavy' && cancelBy !== 'abort') throw new LeverError('?cancelBy= must be cancelHeavy or abort.');
  return {
    master: { width: whole('width'), height: whole('height') },
    stages: [first, ...rest],
    threads: threadsText === 'default' ? 'default' : whole('threads', threadsText),
    closed,
    cancelAt,
    cancelBy,
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

async function start(out: HTMLElement, button: HTMLElement, masterInput: HTMLInputElement): Promise<void> {
  const report: Report = {
    phase: 'starting',
    detail: null,
    levers: null,
    env: { crossOriginIsolated: window.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent },
    runs: [],
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
  if (!isSceneId(SCENE)) return fail('the page\'s scene id is not one');
  const scene: SceneId = SCENE;

  const clock = createBrowserClock(window);
  const diag = createDiagnostics<AnalysisEvent>(clock);
  const workerUrl = NOISY_WORKER_URLS.sequence;
  const service = createAnalysisService({
    clock,
    diag,
    spawn: () => new Worker(workerUrl, { type: 'module', name: 'sequence' }),
    spawnDecoder: () => new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' }),
    ortBase: NOISY_ORT_DIR,
    threads: levers.threads,
    lock: lock.value,
    loader: openModelLoader({
      lock: lock.value,
      origin: window.location.origin,
      caches,
      fetch: (url, init) => window.fetch(url, init),
      subtle: crypto.subtle,
      locks: webLocks(navigator.locks),
      clock,
    }),
  });
  report.phase = 'ready';
  render();

  /** One Run: the fetch through the service, then the sequence, until its terminal callback. */
  const runOnce = async (): Promise<void> => {
    const { width, height } = levers.master;
    const file = masterInput.files?.[0];
    if (file === undefined) throw new LeverError('choose the master file first.');
    const bytes = new Uint8ClampedArray(await file.arrayBuffer());
    if (bytes.length !== width * height * 4) throw new LeverError(`the master file holds ${bytes.length} bytes, not ${width * height * 4}.`);
    const imageData = new ImageData(bytes, width, height);
    const run: Run = { fetch: null, recordBefore: service.lastHeavyTermination, heavyAfterStart: null, callbacks: [], events: [], recordAfter: null, heavyAfter: null, elapsedMs: null };
    report.runs.push(run);
    const firstEvent = diag.events.length;
    const collect = (): void => {
      run.events = diag.events.slice(firstEvent);
    };

    report.phase = 'fetching';
    render();
    run.fetch = await service.fetchModels(levers.stages, new AbortController().signal, () => undefined);
    collect();
    if (!run.fetch.ok) throw new LeverError(`the model fetch failed: ${JSON.stringify(run.fetch.error)}`);

    report.phase = 'running';
    render();
    const controller = new AbortController();
    const began = performance.now();
    let masters = 0;
    let cancelled = false;
    const ended = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new LeverError(`the sequence had not ended after ${SEQUENCE_TIMEOUT_MS} ms.`)), SEQUENCE_TIMEOUT_MS);
      const note = (callback: Callback): void => {
        run.callbacks.push(callback);
        collect();
        render();
        if (callback.kind === 'failed' || callback.kind === 'done') {
          window.clearTimeout(timer);
          resolve();
        }
      };
      const stages: NonEmpty<HeavyStage> = [{ kind: levers.stages[0] }, ...levers.stages.slice(1).map((kind) => ({ kind }))];
      service.runSequence(
        scene,
        stages,
        {
          master: async () => {
            const stage = levers.stages[masters];
            masters += 1;
            const bitmap = await createImageBitmap(imageData);
            if (stage === levers.closed) bitmap.close();
            return bitmap;
          },
        },
        {
          onPhase: (stage, phase, fraction) => {
            note({ kind: 'phase', stage, phase, fraction });
            if (!cancelled && levers.cancelAt?.stage === stage && levers.cancelAt.phase === phase) {
              cancelled = true;
              if (levers.cancelBy === 'abort') controller.abort();
              else service.cancelHeavy();
            }
          },
          onDepth: (map, stats) => note({ kind: 'depth', size: map.size, length: map.data.length, stats }),
          onEmbeddings: (embeddings) => note({ kind: 'embeddings', model: embeddings.model, tensors: embeddings.tensors.map((t) => ({ name: t.name, dims: t.dims })) }),
          onPlate: (image) => note({ kind: 'plate', size: image.size }),
          onFailed: (stage, error) => note({ kind: 'failed', stage, error, heavy: service.alive.heavy, record: service.lastHeavyTermination }),
          onDone: () => note({ kind: 'done', heavy: service.alive.heavy, record: service.lastHeavyTermination }),
        },
        controller.signal,
      );
      run.heavyAfterStart = service.alive.heavy;
    });
    try {
      await ended;
    } finally {
      run.elapsedMs = Math.round(performance.now() - began);
      run.recordAfter = service.lastHeavyTermination;
      run.heavyAfter = service.alive.heavy;
      collect();
    }
  };

  button.addEventListener('click', () => {
    if (report.phase !== 'ready' && report.phase !== 'done') return;
    button.setAttribute('disabled', '');
    delete out.dataset['row'];
    void runOnce()
      .then(async () => {
        report.phase = 'done';
        render();
        out.dataset['row'] = 'posting';
        const posted = await postRow({ kind: 'service-run', buildId: NOISY_BUILD_ID, ...report });
        out.dataset['row'] = posted ? 'posted' : 'not-posted';
        button.removeAttribute('disabled');
      })
      .catch((e: unknown) => fail(e instanceof LeverError ? e.message : `the run threw: ${String(e)}`));
  });
  button.removeAttribute('disabled');
}

const out = document.getElementById('report');
const button = document.getElementById('run');
const master = document.getElementById('master');
if (out !== null && button !== null && master instanceof HTMLInputElement) {
  // Wrap long lines at phone width; set through the CSSOM, which the CSP allows.
  out.style.whiteSpace = 'pre-wrap';
  out.style.overflowWrap = 'anywhere';
  void start(out, button, master);
}
