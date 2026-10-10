// The model loader page (/dev/models.html, dev builds only). At load it parses
// the build's model lock and opens the loader, which clears the caches of
// other locks; Run fetches the files of the chosen operation. The page shows
// one JSON report: the phase, the lock hash and cache names, each model's
// progress, the last result, and every model cache's entries. `?op=` picks
// the operation and `?stallMs=` sets the stall timeout, for tests.

import { bundledLock } from '../analysis/bundled-lock.ts';
import { MODEL_CACHE_PREFIX, OP_SESSIONS } from '../analysis/lock.ts';
import { FETCH_STALL_MS, openModelLoader, webLocks, type ModelLoader } from '../analysis/models.ts';
import type { AnalysisError } from '../analysis/protocol.ts';
import type { AnalysisOp } from '../core/derive.ts';
import type { Result } from '../core/result.ts';
import { createBrowserClock } from '../platform/clock.ts';

type Report = {
  phase: 'starting' | 'ready' | 'running' | 'failed';
  /** Why the page could not start, when it could not. */
  detail: string | null;
  lockHash: string | null;
  cacheName: string | null;
  partialCacheName: string | null;
  stallMs: number;
  op: AnalysisOp;
  runs: number;
  /** The last run's result and how long it took. */
  result: Result<void, AnalysisError> | null;
  elapsedMs: number | null;
  /** The last fraction reported for each model, by ModelId. */
  progress: Record<string, number>;
  /** Every model cache, by name, with the path and query of each entry. */
  caches: Record<string, string[]>;
};

const isOp = (text: string | null): text is AnalysisOp => text !== null && Object.hasOwn(OP_SESSIONS, text);

function stallFromUrl(params: URLSearchParams): number | null {
  const text = params.get('stallMs');
  if (text === null) return FETCH_STALL_MS;
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

async function modelCaches(): Promise<Record<string, string[]>> {
  const listing: Record<string, string[]> = {};
  for (const name of (await caches.keys()).sort()) {
    if (!name.startsWith(MODEL_CACHE_PREFIX)) continue;
    const cache = await caches.open(name);
    listing[name] = (await cache.keys()).map((r) => {
      const url = new URL(r.url);
      return `${url.pathname}${url.search}`;
    }).sort();
  }
  return listing;
}

async function start(out: HTMLElement, opSelect: HTMLSelectElement, button: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('op');
  const stallMs = stallFromUrl(params);
  const report: Report = {
    phase: 'starting',
    detail: null,
    lockHash: null,
    cacheName: null,
    partialCacheName: null,
    stallMs: stallMs ?? FETCH_STALL_MS,
    op: isOp(requested) ? requested : 'decode',
    runs: 0,
    result: null,
    elapsedMs: null,
    progress: {},
    caches: {},
  };
  let renderQueued = false;
  const render = (): void => {
    renderQueued = false;
    out.dataset['phase'] = report.phase;
    out.textContent = JSON.stringify(report, null, 2);
  };
  const renderSoon = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    window.setTimeout(render, 100);
  };
  const fail = (detail: string): void => {
    report.phase = 'failed';
    report.detail = detail;
    render();
  };
  opSelect.value = report.op;
  render();

  if (stallMs === null) return fail('?stallMs= must be a whole number of milliseconds above 0.');
  if (requested !== null && !isOp(requested)) return fail(`?op=${requested} names no operation.`);
  const lock = bundledLock();
  if (!lock.ok) return fail(lock.error);
  const opened = await openModelLoader({
    lock: lock.value,
    origin: window.location.origin,
    caches,
    fetch: (url, init) => window.fetch(url, init),
    subtle: crypto.subtle,
    locks: webLocks(navigator.locks),
    clock: createBrowserClock(window),
    stallMs,
  });
  if (!opened.ok) return fail(`the loader did not open: ${JSON.stringify(opened.error)}`);
  const loader: ModelLoader = opened.value;
  report.lockHash = loader.lockHash;
  report.cacheName = loader.cacheName;
  report.partialCacheName = loader.partialCacheName;
  report.caches = await modelCaches();
  report.phase = 'ready';
  render();

  opSelect.addEventListener('change', () => {
    if (isOp(opSelect.value)) report.op = opSelect.value;
    render();
  });
  button.addEventListener('click', () => {
    if (report.phase !== 'ready') return;
    button.setAttribute('disabled', '');
    report.phase = 'running';
    report.result = null;
    report.elapsedMs = null;
    report.progress = {};
    render();
    const began = performance.now();
    void loader
      .fetchModels([report.op], new AbortController().signal, (model, fraction) => {
        report.progress[model] = Math.round(fraction * 1000) / 1000;
        renderSoon();
      })
      .then(async (result) => {
        report.elapsedMs = Math.round(performance.now() - began);
        report.result = result;
        report.runs += 1;
        report.caches = await modelCaches();
        report.phase = 'ready';
        render();
        button.removeAttribute('disabled');
      })
      .catch((e: unknown) => fail(`the run threw, which the loader never does for an expected failure: ${String(e)}`));
  });
  button.removeAttribute('disabled');
}

const out = document.getElementById('report');
const opSelect = document.getElementById('op');
const button = document.getElementById('run');
if (out !== null && opSelect instanceof HTMLSelectElement && button !== null) {
  // Wrap long lines at phone width; set through the CSSOM, which the CSP allows.
  out.style.whiteSpace = 'pre-wrap';
  out.style.overflowWrap = 'anywhere';
  void start(out, opSelect, button);
}
