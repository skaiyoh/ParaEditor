// One heavy run of a sequence step through the analysis service, and the
// wait every step makes before its setup.
//
// The wait: a step waits from the latest heavy termination of every service
// the page built until its wait has elapsed: a cooldown, the app's default
// for the largest stage the termination names times the step's scale, or the
// gap a row measures.
//
// The run: the wait, then the runner's setup (which makes the page hold what
// the run is held beside and fetches the run's inputs and models; a step
// whose setup could not fetch what it needed waits out its retry time in the
// setup phase, not the wait, before it tries again), then one
// sequence in a new worker, its phase `run:<stage>` from each `stage.start`
// the service logs, and `after` once the service has terminated the worker.
// A run that has not ended within the timeout is cancelled and scores
// `timeout`; a worker failure, a failed wasm growth among them, scores
// `failed` with its phase and error. The reading records each stage's time
// and high-water mark, the worker's life from spawn to termination, the gap
// it waited, the setup's time, the products' shapes, and what the run was
// held beside, summed after it. No browser global is read here.

import type { AnalysisError, AnalysisEvent, AnalysisService, HeavyStage, HeavyTermination, SequenceInput, SequenceListener } from '../../analysis/service.ts';
import { isSceneId, type NonEmpty, type SceneId } from '../../core/ids.ts';
import type { Result } from '../../core/result.ts';
import type { Clock } from '../../platform/clock.ts';
import { AFTER_PHASE, runPhase, SETUP_PHASE, WAIT_PHASE, type StepFacts } from './engine.ts';
import { COOLDOWN_MS } from './lines.ts';
import type { SequenceReading, StepOutcome } from './rows.ts';
import type { Score, Step, Wait } from './steps.ts';

/** What a run uses of an analysis service. */
export type HeavyService = Pick<AnalysisService, 'runSequence' | 'cancelHeavy' | 'fetchModels' | 'lastHeavyTermination'>;

/** An event a service the runner built logged, with the time on the runner's clock when it did. */
export type ServiceEvent = AnalysisEvent & { readonly t: number };

export type SequenceStep = Extract<Step, { readonly kind: 'sequence' }>;

/** The outcome of a step Stop aborted; the engine has left the run and folds nothing. */
export const ABORTED: StepOutcome = { kind: 'blocked', reason: 'aborted by Stop' };

/** The scene every harness sequence names; the service logs none. */
const SCENE_TEXT = '00000000-0000-4000-8000-000000000000';

function harnessScene(): SceneId {
  if (!isSceneId(SCENE_TEXT)) throw new Error(`the harness's scene id ${SCENE_TEXT} is not a scene id`);
  return SCENE_TEXT;
}

type Timers = Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>;

/** Resolves true after `ms`, or false at once when `signal` aborts first. */
export function pause(clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clock.clearTimeout(timer);
      resolve(false);
    };
    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** How long `wait` asks for after `latest`: a cooldown is the default of the stage `latest` names, times its scale; a gap is its own length; nothing when no worker has terminated. */
export function waitMsAfter(wait: Wait, latest: HeavyTermination | null): number {
  if (latest === null) return 0;
  switch (wait.kind) {
    case 'cooldown':
      return COOLDOWN_MS[latest.largest] * wait.scale;
    case 'gap':
      return wait.ms;
    default: {
      const exhaustive: never = wait;
      return exhaustive;
    }
  }
}

/** Resolves true once the clock has reached `end`, or false when `signal` aborts first. */
export async function pauseUntil(clock: Timers, end: number, signal: AbortSignal): Promise<boolean> {
  // A timer can fire before its delay has elapsed by the clock, a fractional delay most often, so this pauses
  // whole milliseconds and pauses again until the clock has reached `end`.
  for (let left = end - clock.now(); left > 0; left = end - clock.now()) {
    if (!(await pause(clock, Math.ceil(left), signal))) return false;
  }
  return !signal.aborted;
}

export type WaitOut = {
  readonly clock: Timers;
  readonly wait: Wait;
  /** The latest heavy termination of every service the page built, or null when none has terminated in this load. */
  readonly latest: HeavyTermination | null;
  readonly phase: (name: string) => void;
  readonly signal: AbortSignal;
};

/** Reports `wait`, then waits until `wait` has elapsed from `latest`; false when `signal` aborts first. */
export function waitOut(args: WaitOut): Promise<boolean> {
  const { clock, latest, signal } = args;
  args.phase(WAIT_PHASE);
  return pauseUntil(clock, latest === null ? 0 : latest.atMs + waitMsAfter(args.wait, latest), signal);
}

/** What the runner's setup made ready for one run. */
export type SequenceSetup = {
  /** The run's stages, an inpaint stage with its hole. */
  readonly stages: NonEmpty<HeavyStage>;
  readonly input: SequenceInput;
  /** What the run was held beside, its chunks summed when called; called once the worker has terminated. */
  readonly condition: () => SequenceReading['condition'];
};

export type SequenceRunDeps = {
  readonly clock: Timers;
  readonly service: HeavyService;
  /** Hears the events the runner's services log until the returned function is called. */
  readonly listen: (listener: (event: ServiceEvent) => void) => () => void;
  /** The latest heavy termination of every service the page built, or null. */
  readonly latest: () => HeavyTermination | null;
};

export type SequenceRun = {
  readonly step: SequenceStep;
  /** A run not ended by then is cancelled and scores `timeout`. */
  readonly timeoutMs: number;
  /** On the clock: the retry time of a blocked attempt before this one, which the setup phase waits out before the setup; 0 when none. */
  readonly retryAt: number;
  /** The runner's setup: answers what the run needs, or why it could not be made ready, which leaves the step blocked. */
  readonly setup: (signal: AbortSignal) => Promise<Result<SequenceSetup, string>>;
  readonly phase: (name: string) => void;
  readonly signal: AbortSignal;
  readonly facts: () => StepFacts;
};

type Ended = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly error: AnalysisError; readonly phase: string };

type Products = { -readonly [K in keyof SequenceReading['product']]: SequenceReading['product'][K] };

/** The least and the largest value of `data`, or 0 and 0 when it is empty. */
function range(data: Float32Array): { readonly min: number; readonly max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return data.length === 0 ? { min: 0, max: 0 } : { min, max };
}

/**
 * Runs `run.step` once: its wait, the setup, the sequence in a new worker of
 * `deps.service`, and `after`. Answers `ran` with its score and reading,
 * `blocked` when the setup could not make it ready, and the blocked answer
 * Stop gets when `run.signal` aborts.
 */
export async function runSequenceStep(deps: SequenceRunDeps, run: SequenceRun): Promise<StepOutcome> {
  const { clock, service } = deps;
  const { step, signal } = run;
  if (!(await waitOut({ clock, wait: step.wait, latest: deps.latest(), phase: run.phase, signal }))) return ABORTED;

  let current = SETUP_PHASE;
  const report = (name: string): void => {
    current = name;
    run.phase(name);
  };
  report(SETUP_PHASE);
  // The retry time is not a cooldown, so it is waited here, in the setup phase, after the wait has ended: a
  // death in it is a death in this step's setup, not one in the wait after the run before it.
  if (!(await pauseUntil(clock, run.retryAt, signal))) return ABORTED;
  const setupStarted = clock.now();
  const setup = await run.setup(signal);
  if (signal.aborted) return ABORTED;
  if (!setup.ok) return { kind: 'blocked', reason: setup.error };
  const setupMs = clock.now() - setupStarted;

  const scene = harnessScene();
  const stages: SequenceReading['stages'][number][] = [];
  const product: Products = { map: null, embeddings: null, plate: null };
  /** The worker's spawn and termination on the clock, the gap from the latest termination before it to its spawn, and the phase the timeout fired in. */
  const life: { spawnedAt: number | null; terminatedAt: number | null; gapMs: number | null; timedOutIn: string | null } = { spawnedAt: null, terminatedAt: null, gapMs: null, timedOutIn: null };
  const stop = deps.listen((event) => {
    switch (event.event) {
      case 'worker.spawn': {
        if (event.worker !== 'sequence') return;
        const latest = deps.latest();
        life.spawnedAt = event.t;
        life.gapMs = latest === null ? null : event.t - latest.atMs;
        return;
      }
      case 'worker.terminate':
        if (event.worker === 'sequence') life.terminatedAt = event.t;
        return;
      case 'stage.start':
        if (event.op !== 'decode') report(runPhase(event.op));
        return;
      case 'stage.end':
        if (event.op !== 'decode') stages.push({ op: event.op, ms: event.ms, wasmHighWaterBytes: event.wasmHighWaterBytes });
        return;
      case 'stage.failed':
      case 'fetch.start':
      case 'fetch.end':
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  });

  const ended = await new Promise<Ended>((resolve) => {
    const timer = clock.setTimeout(() => {
      life.timedOutIn = current;
      service.cancelHeavy();
    }, run.timeoutMs);
    const finish = (end: Ended): void => {
      clock.clearTimeout(timer);
      resolve(end);
    };
    const listener: SequenceListener = {
      onPhase: () => undefined,
      onDepth: (map) => {
        product.map = { size: map.size, ...range(map.data) };
      },
      onEmbeddings: (embeddings) => {
        product.embeddings = { dims: embeddings.tensors.map((tensor) => [...tensor.dims]) };
      },
      onPlate: (image) => {
        product.plate = image.size;
      },
      onFailed: (_stage, error) => finish({ kind: 'failed', error, phase: current }),
      onDone: () => finish({ kind: 'done' }),
    };
    service.runSequence(scene, setup.value.stages, setup.value.input, listener, signal);
  });
  stop();
  const { spawnedAt, terminatedAt, gapMs, timedOutIn } = life;
  if (ended.kind === 'failed' && ended.error.kind === 'cancelled' && timedOutIn === null && signal.aborted) return ABORTED;

  // The service calls the terminal callback only once the worker is terminated.
  report(AFTER_PHASE);
  const score: Score =
    ended.kind === 'done' ? { kind: 'survived' } : timedOutIn !== null && ended.error.kind === 'cancelled' ? { kind: 'timeout', phase: timedOutIn } : { kind: 'failed', phase: ended.phase, error: ended.error };
  const facts = run.facts();
  const reading: SequenceReading = {
    stages,
    wallMs: spawnedAt !== null && terminatedAt !== null ? terminatedAt - spawnedAt : null,
    gapMs,
    setupMs,
    product,
    condition: setup.value.condition(),
    hiddenMs: facts.hiddenMs,
    longestHiddenMs: facts.longestHiddenMs,
    load: facts.load,
  };
  return { kind: 'ran', score, reading };
}
