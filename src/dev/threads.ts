// The thread probe page (/dev/threads.html, dev builds only). Run starts the
// probe worker, collects what it reports and every CSP violation the page or
// the worker sees, shows the result, and posts it as one row to the results
// sink, with the environment that makes a phone row attributable.

import { ProbeMessage, type CspViolation } from './threads-protocol.ts';

/** A run that has not finished by then is reported as timed out. */
const TIMEOUT_MS = 120_000;
/** A row the sink has not accepted by then is reported as not posted. */
const POST_TIMEOUT_MS = 10_000;

type Env = {
  readonly userAgent: string;
  readonly crossOriginIsolated: boolean;
  readonly standalone: boolean;
  readonly hardwareConcurrency: number;
};

type Outcome =
  | { readonly kind: 'completed'; readonly numThreads: number | null; readonly sessionMs: number; readonly runMs: number; readonly outputOk: boolean }
  | { readonly kind: 'failed'; readonly error: string; readonly numThreads: number | null }
  | { readonly kind: 'timed-out'; readonly afterMs: number };

/** The row posted to /api/log. */
type ProbeRow = {
  readonly kind: 'threads-probe';
  readonly buildId: string;
  readonly env: Env;
  readonly outcome: Outcome;
  readonly pthreadWorkers: number;
  /** ORT's pthread workers are not covered: their violations reach only the server's /dev/csp-report. */
  readonly csp: { readonly seenBy: 'page and probe worker'; readonly count: number; readonly violations: readonly CspViolation[] };
};

const button = document.getElementById('run');
const output = document.getElementById('result');

/** Every violation the page has seen since it loaded; each row carries them all. */
const pageViolations: CspViolation[] = [];
document.addEventListener('securitypolicyviolation', (event) => {
  pageViolations.push({ scope: 'page', directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition });
});

function environment(): Env {
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: window.crossOriginIsolated,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}

const yesNo = (v: boolean): string => (v ? 'yes' : 'no');

function describe(row: ProbeRow): string[] {
  const { outcome, env, csp } = row;
  const lines = [`state: ${outcome.kind}`];
  switch (outcome.kind) {
    case 'completed':
      lines.push(
        `numThreads: ${outcome.numThreads ?? 'unknown'}`,
        `pthread workers: ${row.pthreadWorkers}`,
        `session: ${Math.round(outcome.sessionMs)} ms, run: ${Math.round(outcome.runMs)} ms`,
        `output correct: ${yesNo(outcome.outputOk)}`,
      );
      break;
    case 'failed':
      lines.push(`error: ${outcome.error}`, `numThreads: ${outcome.numThreads ?? 'unknown'}`, `pthread workers: ${row.pthreadWorkers}`);
      break;
    case 'timed-out':
      lines.push(`no result after ${outcome.afterMs} ms`, `pthread workers: ${row.pthreadWorkers}`);
      break;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
  lines.push(`CSP violations seen by the page and the probe worker: ${csp.count} (pthread workers report only to /dev/csp-report)`);
  for (const v of csp.violations) lines.push(`  ${v.disposition} ${v.directive} blocked ${v.blockedURI || '(no URI)'} in the ${v.scope}`);
  lines.push(
    `crossOriginIsolated: ${yesNo(env.crossOriginIsolated)}`,
    `standalone: ${yesNo(env.standalone)}`,
    `hardwareConcurrency: ${env.hardwareConcurrency}`,
    `build: ${row.buildId}`,
    `user agent: ${env.userAgent}`,
  );
  return lines;
}

type Posted = { readonly ok: boolean; readonly text: string };

async function postRow(row: ProbeRow): Promise<Posted> {
  try {
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok ? { ok: true, text: 'posted' } : { ok: false, text: `not posted (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, text: `not posted (${e instanceof Error ? e.message : String(e)})` };
  }
}

function run(out: HTMLElement, start: HTMLElement): void {
  const workerUrl = NOISY_DEV_WORKER_URLS['threads'];
  if (workerUrl === undefined) {
    out.dataset['state'] = 'failed';
    out.textContent = 'state: failed\nerror: this build has no threads worker';
    return;
  }
  const workerViolations: CspViolation[] = [];
  let pthreadWorkers = 0;
  let finished = false;
  out.dataset['state'] = 'running';
  delete out.dataset['row'];
  out.textContent = 'state: running';
  start.setAttribute('disabled', '');

  const worker = new Worker(workerUrl, { type: 'module', name: 'threads-probe' });

  const finish = (outcome: Outcome): void => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    worker.terminate();
    const row: ProbeRow = {
      kind: 'threads-probe',
      buildId: NOISY_BUILD_ID,
      env: environment(),
      outcome,
      pthreadWorkers,
      csp: { seenBy: 'page and probe worker', count: pageViolations.length + workerViolations.length, violations: [...pageViolations, ...workerViolations] },
    };
    const lines = describe(row);
    // The outcome is final now; the row's fate is reported separately, so a
    // stalled sink delays only data-row, never data-state.
    out.dataset['state'] = outcome.kind;
    out.dataset['row'] = 'posting';
    out.textContent = [...lines, 'row: posting'].join('\n');
    void postRow(row).then((posted) => {
      out.textContent = [...lines, `row: ${posted.text}`].join('\n');
      out.dataset['row'] = posted.ok ? 'posted' : 'not-posted';
      start.removeAttribute('disabled');
    });
  };
  const timer = window.setTimeout(() => finish({ kind: 'timed-out', afterMs: TIMEOUT_MS }), TIMEOUT_MS);

  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const parsed = ProbeMessage.safeParse(event.data);
    if (!parsed.success) return finish({ kind: 'failed', error: `the worker sent an unexpected message: ${parsed.error.message}`, numThreads: null });
    const message = parsed.data;
    switch (message.kind) {
      case 'nested-worker':
        pthreadWorkers = message.pthreadWorkers;
        return undefined;
      case 'nested-worker-error':
        pthreadWorkers = message.pthreadWorkers;
        return finish({ kind: 'failed', error: `nested worker "${message.name}" failed: ${message.message}`, numThreads: null });
      case 'csp':
        workerViolations.push(message.violation);
        return undefined;
      case 'completed':
        pthreadWorkers = message.pthreadWorkers;
        return finish({ kind: 'completed', numThreads: message.numThreads, sessionMs: message.sessionMs, runMs: message.runMs, outputOk: message.outputOk });
      case 'failed':
        pthreadWorkers = message.pthreadWorkers;
        return finish({ kind: 'failed', error: message.error, numThreads: message.numThreads });
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  });
  worker.addEventListener('error', (event) => {
    // A script that fails to load fires a plain Event, with no message.
    const detail = event instanceof ErrorEvent && event.message !== '' ? event.message : 'the probe worker did not load';
    finish({ kind: 'failed', error: detail, numThreads: null });
  });
  worker.addEventListener('messageerror', () => finish({ kind: 'failed', error: 'a worker message could not be read', numThreads: null }));
}

if (button !== null && output !== null) {
  // Wrap the long lines (the user agent) at phone width. Set through the CSSOM,
  // which the CSP allows, since it has no 'unsafe-inline' for a style attribute.
  output.style.whiteSpace = 'pre-wrap';
  output.style.overflowWrap = 'anywhere';
  button.addEventListener('click', () => run(output, button));
  button.removeAttribute('disabled');
}
