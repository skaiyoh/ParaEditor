// The harness's engine: the plan's whole lifecycle on a page (load, Start,
// the step loop, DONE, Stop) over injected storage, locks, clock,
// visibility, outbox, and runner, so that a page killed at any moment
// resumes on its next load with the dead step scored by the load verdicts.
//
// Every write a kill must find is synchronous and made before the next
// await: the plan with the step in flight, then the step marker, before the
// runner starts; every phase the runner reports, every visibility change,
// `pagehide`, and a heartbeat every second while a step runs; and, when the
// runner answers, the plan with the outcome folded, then the marker cleared.
// With Web Locks, a page writes nothing under its keys until it holds the
// runner lock, which it keeps from Start or a resumed load until DONE, Stop,
// or a write that fails, so a second tab of the same storage does not apply a
// verdict to a run another tab is running. The screen wake lock is requested
// at every load, by Start before its first await, by a tap, and when the page
// turns visible until DONE, Stop, or a failed run or Start releases it; given
// the liveness dependency, the engine also holds the page's tab lock, keeps
// the app-shaped marker beside the step marker, and posts the liveness rows
// after a death verdict (liveness.ts). Nothing the engine does throws to the
// page.

import type { BuildId, TabId } from '../../core/ids.ts';
import type { Clock } from '../../platform/clock.ts';
import type { VisibilitySource } from '../../platform/visibility.ts';
import { COOLDOWN_MS, LIVENESS_LATE_MS } from './lines.ts';
import { createLiveness, verdictTab, type DeadPage, type LivenessDeps, type LockWatch } from './liveness.ts';
import { applyLoad, classifyLoad, isProcessDeath, loadVerdictName, parseMarker, scoreCompleted, type LoadVerdict, type StepMarker, type WaitingOut } from './load.ts';
import type { Outbox } from './outbox.ts';
import { harnessKeys, PLAN_PAGE, type HarnessPage, type PlanKind, type RowId } from './catalog.ts';
import type { Levers } from './context.ts';
import {
  beginStep,
  completeStep,
  createPlan,
  mintRunId,
  nextPlanStep,
  parsePlan,
  storedBuildOf,
  stampRows,
  type Applied,
  type NewPlan,
  type PlanRefusal,
  type PlanState,
} from './plan.ts';
import type { Step } from './steps.ts';
import type { HarnessEvent, LoadVerdictName, RunnerLockState, StepOutcome, WakeLockState } from './rows.ts';
import { createWakeLock, WAKE_ANSWER_MS, type ScreenWakeLock } from './wake-lock.ts';

/** The Web Lock one harness run per storage partition holds. */
export const RUNNER_LOCK = 'noisy-harness-runner';
/** How long a load waits for the runner lock when the stored plan has a step in flight. */
export const LOCK_WAIT_MS = 10_000;
/** How long a step's wait gives its `step-start` row to reach the sink. */
export const STEP_START_POST_MS = 2_000;
/** How often the marker's `aliveAtWall` is rewritten while a step is in flight. */
export const HEARTBEAT_MS = 1_000;
/** How often the outbox is flushed while rows wait. */
export const FLUSH_EVERY_MS = 30_000;

// ---------------------------------------------------------------------------
// the runner's contract

/**
 * What the engine knows of the step in flight that a sequence's reading
 * records: the page load it runs in, and its hidden time so far, a hidden
 * period it is still in included.
 */
export type StepFacts = { readonly load: number; readonly hiddenMs: number; readonly longestHiddenMs: number };

/** Executes a step; the page's runner implements it. */
export interface Runner {
  /**
   * Runs the step, reporting each phase's name as it begins (the page's
   * runner reports `wait` first, then a sequence step's `setup`,
   * `run:<stage>`, and `after`, a ballast step's `fill:<mb>` and `hold:<mb>`,
   * or the untouched step's `alloc:<mb>` and `hold:<mb>`), and answers how the
   * step ended; `facts` reads the step's load and hidden time when it is
   * called. A rejection is not an outcome: the engine stops the run with the
   * reason, as Stop does.
   */
  execute(step: Step, phase: (name: string) => void, signal: AbortSignal, facts: () => StepFacts): Promise<StepOutcome>;
  /** Drops everything the runner holds: every ballast, the GL ballast, the decoder, the services, and the inputs. */
  release(): void;
}

export type HeavyStage = WaitingOut['stage'];

/** The phase a heavy stage runs in. */
export function runPhase(stage: HeavyStage): string {
  return `run:${stage}`;
}

/** The heavy stage phase `name` names, or null. */
export function stageOfPhase(name: string): HeavyStage | null {
  const match = /^run:(depth|encode|inpaint)$/.exec(name);
  const stage = match?.[1];
  return stage === 'depth' || stage === 'encode' || stage === 'inpaint' ? stage : null;
}

/** The phase a step starts in; the engine writes it, and a runner that waits reports it again. */
export const WAIT_PHASE = 'wait';
/** The phase in which a sequence step's setup makes the page hold what the run is held beside, after its wait. */
export const SETUP_PHASE = 'setup';
/** The phase that begins once a step's worker has terminated. */
export const AFTER_PHASE = 'after';

// ---------------------------------------------------------------------------
// the engine's dependencies and answers

/** The part of LockManager the engine uses; `navigator.locks` is one. */
export type RunnerLocks = {
  request(name: string, options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | undefined): Promise<unknown>;
};

export type EngineStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** What the `load` row reports about the page beyond the engine's own state. */
export type LoadFacts = Pick<Extract<HarnessEvent, { readonly type: 'load' }>, 'environment' | 'navigatorStandalone' | 'navigation' | 'lockHash' | 'models'>;

export type EngineDeps = {
  readonly page: HarnessPage;
  readonly storage: EngineStorage;
  /** Null when the browser has no Web Locks: the runner lock is skipped, and the `load` row says so. */
  readonly locks: RunnerLocks | null;
  readonly clock: Clock;
  readonly visibility: VisibilitySource;
  /** The outbox over the same storage and page. */
  readonly outbox: Outbox;
  readonly runner: Runner;
  readonly build: BuildId;
  readonly tab: TabId;
  readonly facts: LoadFacts;
  /** For the run id Start mints. */
  readonly random: Pick<Crypto, 'getRandomValues'>;
  readonly onStatus: (status: EngineStatus) => void;
  /** `navigator.wakeLock`, or null when the browser has none, when every request answers `unsupported`. */
  readonly wakeLock: ScreenWakeLock | null;
  /** Hears each wake-lock answer, and null when the engine releases the lock. */
  readonly onWakeLock: (state: WakeLockState | null) => void;
  /** The tab lock, the app-shaped marker, and the liveness rows; without it the engine takes no tab lock, writes no app-shaped marker, and posts no liveness row. */
  readonly liveness?: LivenessDeps;
};

/** The levers Start runs with, and whether any is away from its default. */
export type LeverChoice = { readonly levers: Levers; readonly levered: boolean };

export type LoadAnswer = { readonly kind: 'idle' | 'resume' | 'done' | 'stale' | 'elsewhere' } | { readonly kind: 'storage-failed'; readonly reason: string };

/**
 * Why Start did not begin a run: the plan's own refusals, another page's plan
 * kind, or an unfinished run of this page and build in storage, which a
 * reload resumes.
 */
export type StartRefusal = PlanRefusal | { readonly kind: 'other-page'; readonly planKind: PlanKind } | { readonly kind: 'stored-run' };

export type StepView = { readonly row: RowId; readonly stepKey: string; readonly attempt: number; readonly phase: string };

export type EngineStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'waiting-for-lock' }
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'storage-failed'; readonly reason: string }
  | { readonly kind: 'refused'; readonly refusal: StartRefusal }
  | { readonly kind: 'running'; readonly plan: PlanState; readonly step: StepView | null; readonly waitingForVisible: boolean; readonly pending: number }
  | { readonly kind: 'done'; readonly plan: PlanState; readonly pending: number }
  | { readonly kind: 'stopped'; readonly pending: number }
  | { readonly kind: 'failed'; readonly reason: string; readonly pending: number };

function refusalText(refusal: StartRefusal): string {
  switch (refusal.kind) {
    case 'other-page':
      return `${refusal.planKind} runs on another page`;
    case 'stored-run':
      return 'A run is stored here: reload the page to resume it.';
    case 'rows-outside-plan':
    case 'no-program':
      return `Start refused (${refusal.kind}): ${refusal.rows.join(', ')}`;
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

/** The status's headline as the page shows it. */
export function statusText(status: EngineStatus): string {
  switch (status.kind) {
    case 'loading':
      return 'Loading';
    case 'waiting-for-lock':
      return 'Waiting for the previous run to let go';
    case 'elsewhere':
      return 'Running in another tab';
    case 'idle':
      return 'Ready';
    case 'stale':
      return 'Built since this run started';
    case 'storage-failed':
      return `The stored run cannot be read: ${status.reason}`;
    case 'refused':
      return refusalText(status.refusal);
    case 'running':
      return status.waitingForVisible ? 'Waiting for the page to be visible' : 'Running';
    case 'done':
      return status.pending > 0 ? `DONE, ${status.pending} rows waiting to post` : 'DONE';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return `Stopped: ${status.reason}`;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export interface Engine {
  /** Reads the stored run, takes the runner lock before applying anything, scores a dead step, and posts its rows. */
  load(): Promise<LoadAnswer>;
  /** Begins a new run and runs it; refusals are answered in the status. */
  start(kind: PlanKind, choice: LeverChoice): Promise<void>;
  /** Runs the resumed plan's steps until DONE, Stop, or a write that fails. */
  continue(): Promise<void>;
  /** Posts `stopped`, clears the plan and the marker, keeps the outbox, and releases the runner, the lock, and the wake lock. */
  stop(): void;
  /** Requests the wake lock before it returns, so a tap's handler that calls it carries the tap's activation; answers the result. */
  requestWakeLock(): Promise<WakeLockState>;
}

// ---------------------------------------------------------------------------
// the runner lock

type Hold = { readonly release: () => void };

/** Requests the runner lock; resolves with the hold once granted, or null when refused, aborted, or failed. */
function requestRunnerLock(locks: RunnerLocks, options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal }): Promise<Hold | null> {
  return new Promise((answer) => {
    let answered = false;
    const resolve = (hold: Hold | null): void => {
      answered = true;
      answer(hold);
    };
    try {
      locks
        .request(RUNNER_LOCK, options, (lock) => {
          // A grant after the request was answered (refused or aborted) is given back at once, never held unseen.
          if (lock === null || answered) {
            if (!answered) resolve(null);
            return undefined;
          }
          return new Promise<void>((release) => resolve({ release: () => release() }));
        })
        .catch(() => {
          if (!answered) resolve(null);
        });
    } catch {
      resolve(null);
    }
  });
}

type Locked = { readonly kind: 'held'; readonly hold: Hold | null; readonly state: RunnerLockState } | { readonly kind: 'elsewhere' };

// ---------------------------------------------------------------------------
// the engine

type Mode =
  | { readonly kind: 'created' | 'loading' | 'waiting-for-lock' | 'elsewhere' | 'idle' | 'stale' | 'ready' | 'running' | 'done' | 'stopped' }
  | { readonly kind: 'storage-failed' | 'failed'; readonly reason: string }
  | { readonly kind: 'refused'; readonly refusal: StartRefusal };

/** What a load found in storage. */
type Examined =
  | { readonly kind: 'none' | 'stale' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'found'; readonly plan: PlanState; readonly verdict: LoadVerdict; readonly texts: { readonly plan: string | null; readonly marker: string | null } };

/** The step being run in this page: its abort, the heavy stages it reported, and when its worker terminated. */
type Active = { readonly controller: AbortController; readonly stages: HeavyStage[]; terminatedAtWall: number | null; executing: boolean };

const STARTABLE: ReadonlySet<Mode['kind']> = new Set(['created', 'idle', 'stale', 'elsewhere', 'storage-failed', 'refused', 'done', 'stopped', 'failed']);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isDone = (plan: PlanState): boolean => plan.inFlight === null && nextPlanStep(plan).kind === 'done';

/** The largest of the stages a worker ran, by its cooldown default. */
const largestStage = (stages: readonly [HeavyStage, ...HeavyStage[]]): HeavyStage => stages.reduce((a, b) => (COOLDOWN_MS[b] > COOLDOWN_MS[a] ? b : a));

function withDone(applied: Applied, nowWall: number): Applied {
  const { loads, kills, voids } = applied.plan;
  const done = stampRows(applied.plan, [{ type: 'done', loads, kills, voids }], nowWall);
  return { plan: done.plan, rows: [...applied.rows, ...done.rows] };
}

export function createEngine(deps: EngineDeps): Engine {
  const { storage, clock, visibility, outbox, runner } = deps;
  const keys = harnessKeys(deps.page);

  let mode: Mode = { kind: 'created' };
  let loaded: Promise<LoadAnswer> | null = null;
  let loop: Promise<void> | null = null;
  let plan: PlanState | null = null;
  let marker: StepMarker | null = null;
  let active: Active | null = null;
  /** Whether this page holds a run: the lock (when Web Locks exist) and whatever the runner allocated. */
  let holding = false;
  let hold: Hold | null = null;
  /** The latest heavy worker termination in this load, which every later step's wait waits out. */
  let lastTermination: WaitingOut | null = null;
  /** On the monotonic clock: the first step after a load that was not fresh waits until then. */
  let leastWaitUntil = 0;
  let waitingForVisible = false;
  let heartbeat: number | null = null;
  let flushTimer: number | null = null;
  let visibleWaiters: (() => void)[] = [];
  /** Whether the wake lock should be held: from a load, Start, or a tap until DONE, Stop, or a failed run or Start. */
  let wakeWanted = false;

  const statusNow = (): EngineStatus => {
    switch (mode.kind) {
      case 'created':
      case 'loading':
        return { kind: 'loading' };
      case 'ready':
      case 'running': {
        if (plan === null) return { kind: 'loading' };
        const step = marker === null ? null : { row: marker.row, stepKey: marker.stepKey, attempt: marker.attempt, phase: marker.phase };
        return { kind: 'running', plan, step, waitingForVisible, pending: outbox.pending };
      }
      case 'done':
        return plan === null ? { kind: 'stopped', pending: outbox.pending } : { kind: 'done', plan, pending: outbox.pending };
      case 'stopped':
        return { kind: 'stopped', pending: outbox.pending };
      case 'failed':
        return { kind: 'failed', reason: mode.reason, pending: outbox.pending };
      case 'waiting-for-lock':
      case 'elsewhere':
      case 'idle':
      case 'stale':
        return { kind: mode.kind };
      case 'storage-failed':
        return { kind: 'storage-failed', reason: mode.reason };
      case 'refused':
        return { kind: 'refused', refusal: mode.refusal };
      default: {
        const exhaustive: never = mode;
        return exhaustive;
      }
    }
  };
  const report = (): void => {
    try {
      deps.onStatus(statusNow());
    } catch {
      // The page's rendering is not the engine's to fail.
    }
  };
  const enter = (next: Mode): void => {
    mode = next;
    report();
  };

  // --- storage

  /** Writes `value`; when the write throws, makes room in the outbox and retries once. Answers the second error, or null. */
  const put = (key: string, value: string): string | null => {
    try {
      storage.setItem(key, value);
      return null;
    } catch {
      outbox.makeRoom();
    }
    try {
      storage.setItem(key, value);
      return null;
    } catch (e) {
      return errorText(e);
    }
  };
  const live = deps.liveness === undefined ? null : createLiveness({ locks: deps.liveness.locks, storage, write: put, clock, tab: deps.tab, build: deps.build });

  const writePlan = (next: PlanState): string | null => {
    const error = put(keys.plan, JSON.stringify(next));
    return error === null ? null : `the plan could not be written: ${error}`;
  };
  const writeMarker = (next: StepMarker): string | null => {
    const error = put(keys.step, JSON.stringify(next));
    return error === null ? null : `the step marker could not be written: ${error}`;
  };
  const remove = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing more can be done, and the engine never throws.
    }
  };

  const flush = (): Promise<unknown> => {
    const flushed = outbox.flush();
    void flushed.then(report);
    return flushed;
  };
  const post = (rows: Applied['rows']): void => {
    for (const row of rows) outbox.enqueue(row);
    void flush();
  };
  const armFlushTimer = (): void => {
    if (flushTimer !== null) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = null;
      if (outbox.pending > 0) void flush();
      armFlushTimer();
    }, FLUSH_EVERY_MS);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (ms <= 0) resolve();
      else clock.setTimeout(resolve, ms);
    });

  // --- the run's resources

  /** Releases the runner and the runner lock, once per run. */
  const finishRun = (): void => {
    if (!holding) return;
    holding = false;
    try {
      runner.release();
    } catch {
      // A runner that throws on release has nothing more to give back.
    }
    hold?.release();
    hold = null;
  };

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) clock.clearTimeout(heartbeat);
    heartbeat = null;
  };

  const wakeVisibleWaiters = (): void => {
    const waiters = visibleWaiters;
    visibleWaiters = [];
    for (const wake of waiters) wake();
  };

  /**
   * Ends the run before DONE, entering `next`: the `stopped` row is enqueued,
   * the plan and the marker are removed, and the outbox is kept, so a later
   * load finds no run to score; the step in flight is aborted, and the
   * runner and the lock are released at once, or once the runner answers.
   */
  const end = (next: Mode): void => {
    const current = plan;
    mode = next;
    stopHeartbeat();
    active?.controller.abort();
    live?.clear();
    releaseWake();
    if (current !== null) {
      const { loads, kills, voids } = current;
      const stopped = stampRows(current, [{ type: 'stopped', loads, kills, voids }], clock.wallNow());
      for (const row of stopped.rows) outbox.enqueue(row);
      remove(keys.plan);
      remove(keys.step);
      void flush();
    }
    plan = null;
    marker = null;
    if (active === null || !active.executing) finishRun();
    wakeVisibleWaiters();
    report();
  };

  /** Stops the run with `reason`, as Stop does: a harness that cannot write its plan or marker cannot attribute a kill. */
  const fail = (reason: string): void => end({ kind: 'failed', reason });

  // --- the wake lock

  /** Tells the page each answer, and records it in a `wake-lock` row while this page holds a run's plan. */
  const wake = createWakeLock(deps.wakeLock, (state) => {
    try {
      syncVisibility();
      deps.onWakeLock(state);
    } catch {
      // As onStatus.
    }
    if (state === null || plan === null || !holding || (mode.kind !== 'ready' && mode.kind !== 'running')) return;
    const next = stampRows(plan, [{ type: 'wake-lock', state }], clock.wallNow());
    const error = writePlan(next.plan);
    if (error !== null) {
      fail(error);
      return;
    }
    plan = next.plan;
    post(next.rows);
    report();
  });
  const wantWake = (): Promise<WakeLockState> => {
    wakeWanted = true;
    return wake.request();
  };
  function releaseWake(): void {
    wakeWanted = false;
    wake.release();
  }

  /** DONE: the runner, the runner lock, and the wake lock are released. */
  const enterDone = (): void => {
    finishRun();
    releaseWake();
    enter({ kind: 'done' });
  };

  /** Rewrites the marker with `patch` and `aliveAtWall` now; a write that fails twice stops the run. */
  const updateMarker = (patch: Partial<StepMarker>): void => {
    if (marker === null || mode.kind !== 'running') return;
    marker = { ...marker, ...patch, aliveAtWall: clock.wallNow() };
    const error = writeMarker(marker);
    if (error !== null) fail(error);
  };

  const beat = (): void => {
    heartbeat = clock.setTimeout(() => {
      heartbeat = null;
      if (marker === null || mode.kind !== 'running') return;
      updateMarker({});
      if (marker !== null) beat();
    }, HEARTBEAT_MS);
  };

  /**
   * Brings the marker and the app-shaped marker to the page's visibility now,
   * if they differ. `visibilitychange` calls it, and so does a wake-lock
   * answer: the lock's release comes with hiding the page, its answer can run
   * before the event, and a page killed between the two would otherwise leave
   * its markers visible.
   */
  const syncVisibility = (): void => {
    const hidden = visibility.hidden;
    if (marker !== null) {
      const now = clock.wallNow();
      if (hidden && marker.visibility === 'visible') updateMarker({ visibility: 'hidden', hiddenSinceWall: now });
      if (!hidden && marker.visibility === 'hidden') {
        const period = now - (marker.hiddenSinceWall ?? now);
        updateMarker({ visibility: 'visible', hiddenSinceWall: null, hiddenMs: marker.hiddenMs + period, longestHiddenMs: Math.max(marker.longestHiddenMs, period) });
      }
    }
    const appError = live?.setHidden(hidden ? clock.wallNow() : null) ?? null;
    if (appError !== null && mode.kind === 'running') fail(appError);
  };

  visibility.onChange((hidden) => {
    try {
      syncVisibility();
      if (!hidden) {
        wakeVisibleWaiters();
        if (wakeWanted) void wake.request();
      }
    } catch {
      // A listener never throws into the page.
    }
  });
  visibility.onPageHide(() => {
    try {
      updateMarker({ pagehideAtWall: clock.wallNow() });
      live?.clear();
    } catch {
      // As above.
    }
  });

  // --- load

  /** Reads and classifies the stored run; a broken plan or marker, or another page's plan, is unreadable, named. */
  const examine = (): Examined => {
    let planText: string | null;
    let markerText: string | null;
    try {
      planText = storage.getItem(keys.plan);
      markerText = storage.getItem(keys.step);
    } catch (e) {
      return { kind: 'unreadable', reason: `the stored run could not be read: ${errorText(e)}` };
    }
    // Another build's plan is stale whatever its shape, which a later build's schema may no longer parse.
    const storedBuild = storedBuildOf(planText);
    if (storedBuild !== null && storedBuild !== deps.build) return { kind: 'stale' };
    const stored = parsePlan(planText);
    if (!stored.ok) return { kind: 'unreadable', reason: stored.error };
    if (stored.value === null) return { kind: 'none' };
    const page = PLAN_PAGE[stored.value.kind];
    if (page !== deps.page) return { kind: 'unreadable', reason: `the stored plan is a ${stored.value.kind} plan, which runs on the ${page} page` };
    if (stored.value.build !== deps.build) return { kind: 'stale' };
    const storedMarker = parseMarker(markerText);
    if (!storedMarker.ok) return { kind: 'unreadable', reason: storedMarker.error };
    return { kind: 'found', plan: stored.value, verdict: classifyLoad(stored.value, storedMarker.value, deps.build, clock.wallNow()), texts: { plan: planText, marker: markerText } };
  };

  /** Answers a load that applies nothing. */
  const settle = (examined: Exclude<Examined, { readonly kind: 'found' }>): LoadAnswer => {
    switch (examined.kind) {
      case 'none':
        enter({ kind: 'idle' });
        return { kind: 'idle' };
      case 'stale':
        enter({ kind: 'stale' });
        return { kind: 'stale' };
      case 'unreadable':
        enter({ kind: 'storage-failed', reason: examined.reason });
        return { kind: 'storage-failed', reason: examined.reason };
      default: {
        const exhaustive: never = examined;
        return exhaustive;
      }
    }
  };

  /** Takes the runner lock if it is free; when it is not and `wait`, waits up to LOCK_WAIT_MS for it. */
  const takeLock = async (wait: boolean): Promise<Locked> => {
    const locks = deps.locks;
    if (locks === null) return { kind: 'held', hold: null, state: { kind: 'absent' } };
    const asked = clock.now();
    const free = await requestRunnerLock(locks, { ifAvailable: true });
    if (free !== null) return { kind: 'held', hold: free, state: { kind: 'held', waitedMs: 0 } };
    if (!wait) return { kind: 'elsewhere' };
    enter({ kind: 'waiting-for-lock' });
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), LOCK_WAIT_MS);
    const waited = await requestRunnerLock(locks, { signal: controller.signal });
    clock.clearTimeout(timer);
    return waited === null ? { kind: 'elsewhere' } : { kind: 'held', hold: waited, state: { kind: 'held', waitedMs: clock.now() - asked } };
  };

  /** The `load` row of this page's load: its facts, the verdict, the runner lock it holds, and the outbox's dropped count. */
  const loadEvent = (verdict: LoadVerdictName, lock: RunnerLockState): HarnessEvent => ({
    type: 'load',
    tab: deps.tab,
    ...deps.facts,
    wakeLock: wake.state,
    webLocks: deps.locks !== null,
    runnerLock: lock,
    verdict,
    outboxDropped: outbox.dropped,
  });

  /**
   * Applies a load's verdict under the runner lock: one plan write, the marker
   * cleared, the `load` row and the verdict's rows posted, and, after a death
   * `dead` read, its `liveness` row with the seqs of its late rows reserved.
   */
  const apply = (stored: PlanState, verdict: LoadVerdict, lock: RunnerLockState, dead: { readonly page: DeadPage; readonly watch: LockWatch } | null): LoadAnswer => {
    const now = clock.wallNow();
    const event = loadEvent(loadVerdictName(verdict), lock);
    // The load row comes first, stamped with the new load; applyLoad then raises the load itself.
    const stamped = stampRows({ ...stored, loads: stored.loads + 1 }, [event], now);
    const applied = applyLoad({ ...stamped.plan, loads: stored.loads }, verdict, now);
    let next: Applied = { plan: applied.plan, rows: [...stamped.rows, ...applied.rows] };
    // The late rows are posted when their readings come, under these seqs, so they need no plan write, no lock, and no step's time.
    let lateSeq: number | null = null;
    if (dead !== null) {
      const reported = stampRows(next.plan, [{ type: 'liveness', killIndex: next.plan.deaths, ...dead.page }], now);
      lateSeq = reported.plan.seq;
      next = { plan: { ...reported.plan, seq: lateSeq + LIVENESS_LATE_MS.length }, rows: [...next.rows, ...reported.rows] };
    }
    const wasDone = isDone(stored);
    if (!wasDone && isDone(next.plan)) next = withDone(next, now);
    const error = writePlan(next.plan);
    if (error !== null) {
      finishRun();
      enter({ kind: 'storage-failed', reason: error });
      return { kind: 'storage-failed', reason: error };
    }
    plan = next.plan;
    remove(keys.step);
    const left = verdictTab(stored, verdict);
    if (left !== null) live?.forget(left);
    post(next.rows);
    if (dead !== null && lateSeq !== null) {
      const first = lateSeq;
      const at = next.plan;
      live?.postLate(dead.page.deadTab, dead.watch, (late, index) => post(stampRows({ ...at, seq: first + index }, [late], clock.wallNow()).rows));
    }
    armFlushTimer();
    leastWaitUntil = clock.now() + applied.leastWaitMs;
    if (isDone(plan)) {
      enterDone();
      return { kind: 'done' };
    }
    enter({ kind: 'ready' });
    return { kind: 'resume' };
  };

  const runLoad = async (): Promise<LoadAnswer> => {
    enter({ kind: 'loading' });
    live?.holdTabLock();
    const wakeAsked = wantWake();
    const first = examine();
    if (first.kind !== 'found') return settle(first);
    // The dead page held the runner lock too, so its tab lock is read before the wait for the runner lock, which lasts while the browser keeps the dead page's locks, up to LOCK_WAIT_MS.
    const watched = live !== null && isProcessDeath(first.verdict) ? live.watch() : null;
    // A live tab's step in flight looks like a dead one's, so nothing is applied until the lock is held.
    const locked = await takeLock(first.plan.inFlight !== null);
    if (locked.kind === 'elsewhere') {
      enter({ kind: 'elsewhere' });
      return { kind: 'elsewhere' };
    }
    holding = true;
    hold = locked.hold;
    // The holder before may have changed the run while this page waited.
    const again = examine();
    if (again.kind !== 'found') {
      finishRun();
      return settle(again);
    }
    let dead: { readonly page: DeadPage; readonly watch: LockWatch } | null = null;
    if (live !== null && isProcessDeath(again.verdict)) {
      // A holder that wrote the run while this page waited, if only a heartbeat, was alive after that first reading, so its locks are read again now.
      const unwritten = again.texts.plan === first.texts.plan && again.texts.marker === first.texts.marker;
      const watch = watched !== null && unwritten ? watched : live.watch();
      const page = await live.readDeath(again.plan, again.verdict, watch);
      dead = page === null ? null : { page, watch };
    }
    await within(wakeAsked, WAKE_ANSWER_MS);
    return apply(again.plan, again.verdict, locked.state, dead);
  };

  // --- the step loop

  /** Waits until the page is visible, unless the run ends first. */
  const untilVisible = async (): Promise<void> => {
    if (!visibility.hidden) return;
    waitingForVisible = true;
    report();
    while (visibility.hidden && mode.kind === 'running') await new Promise<void>((wake) => visibleWaiters.push(wake));
    waitingForVisible = false;
    report();
  };

  /** Gives `posted` up to `ms` to settle. */
  const within = (posted: Promise<unknown>, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = clock.setTimeout(resolve, ms);
      void posted.then(() => {
        clock.clearTimeout(timer);
        resolve();
      });
    });

  /** The step in flight's load and hidden time now, from its marker. */
  const stepFacts = (load: number): StepFacts => {
    if (marker === null) return { load, hiddenMs: 0, longestHiddenMs: 0 };
    const open = marker.visibility === 'hidden' && marker.hiddenSinceWall !== null ? Math.max(0, clock.wallNow() - marker.hiddenSinceWall) : 0;
    return { load, hiddenMs: marker.hiddenMs + open, longestHiddenMs: Math.max(marker.longestHiddenMs, open) };
  };

  /** Runs the plan's next step; answers whether the loop goes on. */
  const runStep = async (current: PlanState): Promise<boolean> => {
    const startedAt = clock.wallNow();
    const begun = beginStep(current, startedAt, deps.tab);
    if (begun === null) {
      enterDone();
      return false;
    }
    // Synchronous from here to the marker; a kill between the two writes leaves the step in flight with no marker, which a load reads as a lost marker.
    const planError = writePlan(begun.plan);
    if (planError !== null) {
      fail(planError);
      return false;
    }
    const { counts, planned } = begun;
    marker = {
      run: begun.plan.run,
      row: counts.row,
      stepKey: counts.stepKey,
      step: planned.step,
      attempt: counts.attempt,
      voids: counts.voids,
      tab: deps.tab,
      load: begun.plan.loads,
      phase: WAIT_PHASE,
      startedAtWall: startedAt,
      aliveAtWall: startedAt,
      visibility: visibility.hidden ? 'hidden' : 'visible',
      hiddenSinceWall: visibility.hidden ? startedAt : null,
      hiddenMs: 0,
      longestHiddenMs: 0,
      pagehideAtWall: null,
      waitingOut: lastTermination,
    };
    const markerError = writeMarker(marker) ?? live?.mark(begun.plan.run, planned.step, startedAt, visibility.hidden) ?? null;
    if (markerError !== null) {
      fail(markerError);
      return false;
    }
    plan = begun.plan;
    const step: Active = { controller: new AbortController(), stages: [], terminatedAtWall: null, executing: false };
    active = step;
    beat();
    for (const row of begun.rows) outbox.enqueue(row);
    const posted = flush();
    report();

    // Stop or a failure aborts the step, which ends the wait at once.
    const aborted = new Promise<void>((resolve) => step.controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    await Promise.race([Promise.all([sleep(leastWaitUntil - clock.now()), within(posted, STEP_START_POST_MS)]), aborted]);
    leastWaitUntil = 0;
    if (mode.kind !== 'running') {
      active = null;
      return false;
    }

    const onPhase = (name: string): void => {
      try {
        if (active !== step || marker === null) return;
        const stage = stageOfPhase(name);
        if (stage !== null) step.stages.push(stage);
        if (name === AFTER_PHASE && step.stages.length > 0 && step.terminatedAtWall === null) step.terminatedAtWall = clock.wallNow();
        updateMarker({ phase: name });
        report();
      } catch {
        // The runner's callback never throws into the runner.
      }
    };
    step.executing = true;
    let outcome: StepOutcome;
    try {
      outcome = await runner.execute(planned.step, onPhase, step.controller.signal, () => stepFacts(begun.plan.loads));
    } catch (e) {
      step.executing = false;
      active = null;
      if (mode.kind === 'running') fail(`the runner threw: ${errorText(e)}`);
      finishRun();
      return false;
    }
    step.executing = false;
    active = null;
    stopHeartbeat();
    const finished = marker;
    if (mode.kind !== 'running' || finished === null) {
      // Stopped or failed while the step ran: the runner has answered, so the run's resources can go.
      finishRun();
      return false;
    }

    // Synchronous from here to the marker's clearing: the outcome is folded into the plan before the marker goes.
    const endedAt = clock.wallNow();
    const [first, ...rest] = step.stages;
    if (first !== undefined) {
      lastTermination = {
        row: counts.row,
        stepKey: counts.stepKey,
        step: planned.step,
        load: plan.loads,
        stage: largestStage([first, ...rest]),
        terminatedAtWall: step.terminatedAtWall ?? endedAt,
      };
    }
    let next = completeStep(plan, scoreCompleted(outcome, finished, endedAt), endedAt);
    const done = isDone(next.plan);
    if (done) next = withDone(next, endedAt);
    const error = writePlan(next.plan);
    if (error !== null) {
      fail(error);
      return false;
    }
    plan = next.plan;
    marker = null;
    remove(keys.step);
    live?.clear();
    post(next.rows);
    if (done) {
      enterDone();
      return false;
    }
    report();
    return true;
  };

  const runLoop = async (): Promise<void> => {
    enter({ kind: 'running' });
    try {
      for (;;) {
        await untilVisible();
        if (mode.kind !== 'running' || plan === null) return;
        // No await between this check and the step's first writes, so no step begins while the page is hidden.
        if (visibility.hidden) continue;
        if (!(await runStep(plan))) return;
      }
    } catch (e) {
      if (mode.kind === 'running') fail(`the engine failed: ${errorText(e)}`);
    }
  };

  const continueRun = (): Promise<void> => {
    if (mode.kind !== 'ready' && mode.kind !== 'running') return Promise.resolve();
    loop ??= runLoop().finally(() => {
      loop = null;
    });
    return loop;
  };

  // --- Start and Stop

  const runStart = async (kind: PlanKind, choice: LeverChoice): Promise<void> => {
    // A run that ended early still holds until the step it was in has ended.
    if (!STARTABLE.has(mode.kind) || holding || loop !== null) return;
    const page = PLAN_PAGE[kind];
    if (page !== deps.page) {
      enter({ kind: 'refused', refusal: { kind: 'other-page', planKind: kind } });
      return;
    }
    const now = clock.wallNow();
    const input: NewPlan = { kind, run: mintRunId(now, deps.random), build: deps.build, levers: choice.levers, levered: choice.levered, ascentCapMb: null, nowWall: now };
    const checked = createPlan(input);
    if (!checked.ok) {
      enter({ kind: 'refused', refusal: checked.error });
      return;
    }
    // Before the first await, so the tap that called Start carries the request.
    const wakeAsked = wantWake();
    enter({ kind: 'loading' });
    const locked = await takeLock(false);
    if (locked.kind === 'elsewhere') {
      enter({ kind: 'elsewhere' });
      return;
    }
    await within(wakeAsked, WAKE_ANSWER_MS);
    // Another page of this storage may have started a run since this page loaded and died with it unfinished; a reload's load applies it as the load verdicts say, so Start leaves it as stored.
    const stored = examine();
    if (stored.kind === 'found' && !isDone(stored.plan)) {
      locked.hold?.release();
      enter({ kind: 'refused', refusal: { kind: 'stored-run' } });
      return;
    }
    holding = true;
    hold = locked.hold;
    // The plan checked above, with this load's `load` row stamped right after its `plan` row.
    const made = createPlan(input, [loadEvent('fresh', locked.state)]);
    if (!made.ok) {
      finishRun();
      enter({ kind: 'refused', refusal: made.error });
      return;
    }
    let next: Applied = made.value;
    if (isDone(next.plan)) next = withDone(next, now);
    const error = writePlan(next.plan);
    if (error !== null) {
      finishRun();
      releaseWake();
      enter({ kind: 'failed', reason: error });
      return;
    }
    plan = next.plan;
    marker = null;
    remove(keys.step);
    lastTermination = null;
    leastWaitUntil = 0;
    post(next.rows);
    armFlushTimer();
    if (isDone(plan)) {
      enterDone();
      return;
    }
    enter({ kind: 'ready' });
    await continueRun();
  };

  return {
    load() {
      loaded ??= runLoad().catch((e: unknown): LoadAnswer => {
        finishRun();
        const reason = `the load failed: ${errorText(e)}`;
        enter({ kind: 'storage-failed', reason });
        return { kind: 'storage-failed', reason };
      });
      return loaded;
    },

    start(kind, choice) {
      return runStart(kind, choice).catch((e: unknown) => {
        finishRun();
        releaseWake();
        enter({ kind: 'failed', reason: `Start failed: ${errorText(e)}` });
      });
    },

    continue() {
      return continueRun();
    },

    stop() {
      try {
        if (mode.kind !== 'ready' && mode.kind !== 'running') return;
        end({ kind: 'stopped' });
      } catch {
        // Stop never throws into the page.
      }
    },

    requestWakeLock() {
      return wantWake();
    },
  };
}
