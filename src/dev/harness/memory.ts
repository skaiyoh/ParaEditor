// The memory harness page (/dev/harness/memory.html, dev builds only). It
// wires the engine to the page's own storage, Web Locks, clock, visibility,
// outbox, and runner, reads the levers from its URL once, and loads the
// stored run before anything else: a load that finds a run another page
// left behind scores its dead step and continues it, with no tap. Start and
// Short run begin a run, Stop ends one, and the status says, in large text,
// where the run is and when it is DONE. The engine holds the screen wake lock
// and, on this page, the tab lock and the liveness report; when the wake lock
// is refused the status shows a tap target that requests it again.
//
// `#report` holds the page's state as JSON for the browser scenarios, with
// `data-phase` (the status shown), `data-row`, and `data-step` (the phase of
// the step in flight).

import { environment } from '../checklist-environment.ts';
import { bundledLock } from '../../analysis/bundled-lock.ts';
import { lockHash, type ParsedLock } from '../../analysis/lock.ts';
import { openModelLoader, webLocks, type ModelLoader } from '../../analysis/models.ts';
import type { AnalysisError } from '../../analysis/protocol.ts';
import { createAnalysisService, type AnalysisEvent } from '../../analysis/service.ts';
import type { ModelId } from '../../core/ids.ts';
import type { Result } from '../../core/result.ts';
import type { Clock } from '../../platform/clock.ts';
import type { DiagnosticSink } from '../../platform/diagnostics.ts';
import { readBuildId } from '../../platform/build-id.ts';
import { createBrowserClock } from '../../platform/clock.ts';
import { mintTabId } from '../../platform/tab-id.ts';
import { createVisibilitySource } from '../../platform/visibility.ts';
import { AFTER_PHASE, createEngine, SETUP_PHASE, stageOfPhase, WAIT_PHASE, type LeverChoice, type LoadAnswer, type LoadFacts, type StepView } from './engine.ts';
import { HOLE_SHAPES, type HoleShape } from './holes.ts';
import { createInputs, type Inputs } from './inputs.ts';
import { leverErrorText, parseLevers } from './levers.ts';
import { createOutbox, createPost } from './outbox.ts';
import type { PlanKind } from './catalog.ts';
import type { Levers } from './context.ts';
import type { Step } from './steps.ts';
import type { LivenessLocks } from './liveness.ts';
import { parseBallastPhase } from './programs/killpoint.ts';
import { parseUntouchedPhase } from './programs/untouched.ts';
import type { WakeLockState } from './rows.ts';
import { createRunner, unexecutedRows, type Holding } from './runner.ts';
import type { HeavyService } from './sequence-run.ts';
import { createStatusView, headline, pageContext, rowName, type StepWords, type ViewStatus } from './status-view.ts';
import { adoptHarnessStyles } from './style.ts';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`the page has no #${id}`);
  return el;
}

const els = {
  status: element('status', HTMLElement),
  start: element('start', HTMLButtonElement),
  shortRun: element('short-run', HTMLButtonElement),
  stop: element('stop', HTMLButtonElement),
  report: element('report', HTMLPreElement),
};

/** `navigator.standalone`, a non-standard property WebKit exposes (iOS Safari, and macOS WebKit, where a page reads false); null where it is absent. */
function navigatorStandalone(): boolean | null {
  return 'standalone' in navigator && typeof navigator.standalone === 'boolean' ? navigator.standalone : null;
}

function standalone(): boolean {
  try {
    return navigatorStandalone() === true || matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

function navigationType(): string {
  const entry = performance.getEntriesByType('navigation')[0];
  return entry instanceof PerformanceNavigationTiming ? entry.type : 'unknown';
}

/** The build's lock hash and model ids; a lock that does not parse is reported in the hash's place, with no models. */
async function readLock(): Promise<{ readonly lockHash: string; readonly models: readonly ModelId[] }> {
  const lock = bundledLock();
  if (!lock.ok) return { lockHash: `unavailable: ${lock.error}`, models: [] };
  try {
    return { lockHash: await lockHash(lock.value.lock, crypto.subtle), models: Object.values(lock.value.lock.models).map((model) => model.modelId) };
  } catch (e) {
    return { lockHash: `unavailable: ${errorText(e)}`, models: [] };
  }
}

async function readLoadFacts(): Promise<LoadFacts> {
  const [env, lock] = await Promise.all([environment, readLock()]);
  return { environment: env, navigatorStandalone: navigatorStandalone(), navigation: navigationType(), lockHash: lock.lockHash, models: lock.models };
}

/**
 * The phase in words: the wait, the setup, a heavy stage running, and what
 * follows its worker's termination; for a ballast step, the fill reaching a
 * size and the hold of the filled ballast; for an untouched step, the
 * allocation reaching a size and the hold.
 */
function phaseWords(phase: string, kind: Step['kind'] | null): string {
  if (phase === WAIT_PHASE) return 'Waiting before the step';
  if (phase === SETUP_PHASE) return 'Setting up the step';
  if (phase === AFTER_PHASE) return 'After the run';
  const stage = stageOfPhase(phase);
  if (stage !== null) return `Running ${stage}`;
  const ballast = kind === 'ballast' ? parseBallastPhase(phase) : null;
  if (ballast?.kind === 'fill') return `Filling up to ${ballast.mb} MB`;
  if (ballast?.kind === 'hold') return `Holding ${ballast.mb} MB, filled and summed`;
  const untouched = parseUntouchedPhase(phase);
  if (untouched?.kind === 'alloc') return `Allocating up to ${untouched.mb} MB`;
  if (untouched?.kind === 'hold') return `Holding ${untouched.mb} MB`;
  return `Phase ${phase}`;
}

/** `U1 untouched: 1500 MB, attempt 1`, and the phase in words. */
function describeStep(step: Step | null, view: StepView): StepWords {
  const size = step === null ? view.stepKey : step.kind === 'sequence' ? step.stages.join(' then ') : `${step.mb} MB`;
  return { step: `${rowName(view.row)}: ${size}, attempt ${view.attempt}`, phase: phaseWords(view.phase, step?.kind ?? null) };
}

/**
 * The statuses from which Start and Short run are offered. Not `elsewhere`:
 * while another page holds the run Start does nothing, and once that page
 * has died Start refuses the unfinished run it left; a reload loads that
 * plan and scores the step.
 */
const OFFERS_START: ReadonlySet<ViewStatus['kind']> = new Set(['idle', 'stale', 'storage-failed', 'refused', 'not-executed', 'done', 'stopped', 'failed']);

const context = pageContext(standalone());
/** The engine's wake-lock request for a tap on the target, set once the engine exists. */
let requestWakeLock: (() => void) | null = null;
const view = createStatusView(els.status, { context, describeStep, onWakeTap: () => requestWakeLock?.() });

let status: ViewStatus = { kind: 'starting' };
/** A refusal the page made itself, shown until the engine reports again. */
let note: ViewStatus | null = null;
let choice: LeverChoice | null = null;
let leverError: string | null = null;
let loadAnswer: LoadAnswer['kind'] | null = null;
let tab: string | null = null;
/** The levers of the run the engine last reported, which the runner executes with. */
let runLevers: Levers | null = null;
let holding: Holding = { chunks: 0, mb: 0 };
let wakeLock: WakeLockState | null = null;

function render(): void {
  const shown = note ?? status;
  const plan = status.kind === 'running' || status.kind === 'done' ? status.plan : null;
  const step = status.kind === 'running' ? status.step : null;
  const levered = plan?.levered ?? choice?.levered ?? false;
  view.render(shown, levered, wakeLock);
  const offered = OFFERS_START.has(shown.kind) && choice !== null;
  els.start.hidden = !offered;
  els.shortRun.hidden = !offered;
  els.stop.hidden = status.kind !== 'running';
  els.report.dataset['phase'] = shown.kind;
  els.report.dataset['row'] = step?.row ?? '';
  els.report.dataset['step'] = step?.phase ?? '';
  els.report.textContent = JSON.stringify(
    {
      phase: shown.kind,
      headline: headline(shown),
      context,
      levers: choice?.levers ?? null,
      levered,
      leverError,
      load: loadAnswer,
      tab,
      navigation: navigationType(),
      run: plan === null ? null : { run: plan.run, kind: plan.kind, loads: plan.loads, kills: plan.kills, voids: plan.voids, cursor: plan.cursor, seq: plan.seq },
      step,
      pending: 'pending' in status ? status.pending : null,
      reason: 'reason' in shown ? shown.reason : null,
      refused: shown.kind === 'refused' ? shown.refusal : shown.kind === 'not-executed' ? { kind: 'not-executed', rows: shown.rows } : null,
      runner: holding,
      wakeLock,
    },
    null,
    2,
  );
}

/**
 * The analysis services' builder: each service runs on the real sequence
 * worker with the vendored runtime, as the analysis service page builds it,
 * and all of them share one model loader, opened when the first is built.
 */
function serviceBuilder(clock: Clock, locks: LockManager | null): (threads: 1 | 2, diag: DiagnosticSink<AnalysisEvent>) => HeavyService {
  let opened: { readonly lock: ParsedLock; readonly loader: Promise<Result<ModelLoader, AnalysisError>> } | null = null;
  return (threads, diag) => {
    if (opened === null) {
      const lock = bundledLock();
      if (!lock.ok) throw new Error(`the build's model lock does not parse: ${lock.error}`);
      if (locks === null) throw new Error('the model loader needs Web Locks, which this browser does not have');
      const loader = openModelLoader({ lock: lock.value, origin: location.origin, caches, fetch: (url, init) => window.fetch(url, init), subtle: crypto.subtle, locks: webLocks(locks), clock });
      opened = { lock: lock.value, loader };
    }
    return createAnalysisService({
      clock,
      diag,
      spawn: () => new Worker(NOISY_WORKER_URLS.sequence, { type: 'module', name: 'sequence' }),
      spawnDecoder: () => new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' }),
      ortBase: NOISY_ORT_DIR,
      threads,
      lock: opened.lock,
      loader: opened.loader,
    });
  };
}

/**
 * The page's surface for the browser scenarios, `window.__noisyHarness`:
 * the SHA-256, in lowercase hex, of the hole the page's inputs make.
 */
function exposeSurface(inputs: Inputs): void {
  const isShape = (text: string): text is HoleShape => HOLE_SHAPES.some((shape) => shape === text);
  const surface = {
    async holeDigest(shape: string, width: number, height: number): Promise<string> {
      if (!isShape(shape)) throw new Error(`no hole shape ${shape}`);
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(inputs.hole(shape, { width, height }).data));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    },
  };
  Object.defineProperty(window, '__noisyHarness', { value: Object.freeze(surface), enumerable: false, writable: false, configurable: false });
}

function fail(reason: string): void {
  status = { kind: 'page-failed', reason };
  note = null;
  render();
}

async function boot(): Promise<void> {
  adoptHarnessStyles(document);
  render();
  const parsed = parseLevers(location.search);
  if (!parsed.ok) {
    leverError = leverErrorText(parsed.error);
    fail(leverError);
    return;
  }
  const levers = parsed.value;
  choice = levers;
  const storage = window.localStorage;
  const build = readBuildId();
  const tabId = mintTabId(crypto);
  tab = tabId;
  const facts = await readLoadFacts();
  const clock = createBrowserClock(window);
  const locks: LivenessLocks | null = 'locks' in navigator ? navigator.locks : null;
  const inputs = createInputs({
    fetch: (url, init) => window.fetch(url, init),
    makeBitmap: (rgba, size) => createImageBitmap(new ImageData(rgba, size.width, size.height)),
    clock,
  });
  exposeSurface(inputs);
  const runner = createRunner({
    clock,
    levers: () => runLevers,
    allocate: (bytes) => new Uint8Array(bytes),
    service: serviceBuilder(clock, 'locks' in navigator ? navigator.locks : null),
    inputs,
    onHolding: (now) => {
      holding = now;
      render();
    },
  });
  const engine = createEngine({
    page: 'memory',
    storage,
    locks,
    clock,
    visibility: createVisibilitySource({ document, window }),
    outbox: createOutbox({ page: 'memory', storage, post: createPost({ fetch }) }),
    runner,
    build,
    tab: tabId,
    facts,
    random: crypto,
    onStatus: (next) => {
      status = next;
      note = null;
      if (next.kind === 'running' || next.kind === 'done') runLevers = next.plan.levers;
      render();
    },
    wakeLock: 'wakeLock' in navigator ? navigator.wakeLock : null,
    onWakeLock: (state) => {
      wakeLock = state;
      render();
    },
    liveness: { locks },
  });
  // Called from the target's click handler, so the request carries the tap's activation.
  requestWakeLock = () => void engine.requestWakeLock();

  const begin = (kind: PlanKind): void => {
    const rows = unexecutedRows(kind, levers.levers);
    if (rows.length > 0) {
      note = { kind: 'not-executed', rows };
      render();
      return;
    }
    note = null;
    void engine.start(kind, levers);
  };
  els.start.addEventListener('click', () => begin('full'));
  els.shortRun.addEventListener('click', () => begin('short'));
  els.stop.addEventListener('click', () => engine.stop());

  const answer = await engine.load();
  loadAnswer = answer.kind;
  render();
  if (answer.kind === 'resume') void engine.continue();
}

boot().catch((e: unknown) => fail(`The page could not start: ${errorText(e)}`));
