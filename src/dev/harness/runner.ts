// The memory page's runner: it executes the step the engine hands it and
// answers how the step ended, never throwing for anything the step does.
// Each step kind has its executor: the untouched calibration's, the
// kill-point ladder's, and the heavy sequences', which runs a sequence beside
// the stand-in with no GL ballast, no memory ballast, and no decoder; the
// page refuses to start a plan holding a row whose steps no executor runs
// (`unexecutedRows`).
//
// Every step first waits from the latest heavy worker termination of the
// services the runner built until the app's cooldown default for the largest
// stage that started in that worker, scaled by the defaultsScale lever (a
// sequence step waits its own `wait`), so no harness allocation lands beside a
// draining worker. Its setup then reconciles what the runner holds with what the step
// runs beside: it releases, in `RELEASE_ORDER`, everything the step does not
// keep (`keptFor`), and a sequence step then holds the stand-in, its master
// and hole, and its models.
//
// The untouched step allocates its megabytes in chunks and never writes or
// reads them: it checks that allocation alone does not count against the
// kill point. It reports `alloc:<total>` before each chunk, so a kill names
// the size the allocation had reached, holds the chunks, and drops them.
//
// A ballast step grows the filled ballast (ballast.ts) to the step's size,
// keeping the chunks it holds up to that size, so a step after the one below
// it allocates and fills only its new chunk and a step that held, run again in
// the same load, allocates nothing; it reports `fill:<total>` before each new chunk,
// sums every chunk, and holds them reporting `hold:<mb>`. The ballast stays
// held from one step to the next, the ladder's last step and a step whose
// allocation throws included, since the engine may still void that step and
// run it again; the next step's setup drops what that step does not need, and
// Stop and `release()` (at DONE) drop it all.
//
// The stand-in is filled by the first sequence step that runs beside it and
// held, summed after every run, until a step that does not keep it, Stop, or
// `release()`. A sequence step whose setup cannot fetch its master or its
// models, or allocate the stand-in, answers `blocked`, and the step's next
// attempt waits the retry time in its setup phase, after its wait.
//
// Every buffer the runner holds comes from `leveredAllocator`; the throwAtMb
// lever acts on the untouched chunks and the ballast, not on the stand-in.
// What the runner cannot answer for, a step of a kind or a condition no
// executor runs and a step handed over with no run's levers, it rejects, and
// the engine stops the run with the reason.

import type { AnalysisEvent, HeavyStage, HeavyTermination } from '../../analysis/service.ts';
import type { NonEmpty } from '../../core/ids.ts';
import { err, ok, type Result } from '../../core/result.ts';
import type { Clock } from '../../platform/clock.ts';
import type { DiagnosticSink } from '../../platform/diagnostics.ts';
import { createHeap, createStandIn, leveredAllocator, type Allocate, type BallastHeap, type StandIn } from './ballast.ts';
import type { Runner, StepFacts } from './engine.ts';
import { PLAN_ROWS, type PlanKind, type RowId } from './catalog.ts';
import type { Levers } from './context.ts';
import type { Inputs } from './inputs.ts';
import { missingPrograms } from './registry.ts';
import { COOLDOWN_MS } from './lines.ts';
import { ABORTED, pause, runSequenceStep, waitOut, type HeavyService, type SequenceSetup, type SequenceStep, type ServiceEvent } from './sequence-run.ts';
import type { Step } from './steps.ts';
import { ballastPhase } from './programs/killpoint.ts';
import { untouchedPhase } from './programs/untouched.ts';
import type { ChecksumPair, SequenceReading, StepOutcome } from './rows.ts';

/** How long the untouched step holds its chunks, before the `defaultsScale` lever scales it. */
export const UNTOUCHED_HOLD_MS = 5_000;

/** How long a ballast step holds the ballast it grew, before the `defaultsScale` lever scales it. */
export const BALLAST_HOLD_MS = 2_000;

/** How long a blocked sequence step's next attempt waits in its setup phase before its setup, before the `defaultsScale` lever scales it. */
export const BLOCKED_RETRY_MS = 30_000;

/** The rows every one of whose steps an executor runs; Start refuses a plan holding any other. */
export const EXECUTED_ROWS: ReadonlySet<RowId> = new Set<RowId>(['U1.untouched', 'U1.killpoint', 'U1.killpoint.after', 'U1.survival.none']);

/**
 * The rows of the plan `kind` and `levers` would make whose steps no executor
 * runs yet, which the page refuses to start, naming them. Empty when the
 * plan's own refusals come first: a `rows` lever outside the plan kind, or a
 * row with no program, which Start answers itself.
 */
export function unexecutedRows(kind: PlanKind, levers: Levers): readonly RowId[] {
  const kindRows: readonly RowId[] = PLAN_ROWS[kind];
  const wanted = levers.rows;
  if (wanted !== null && wanted.some((row) => !kindRows.includes(row))) return [];
  const rows = wanted === null ? kindRows : kindRows.filter((row) => wanted.includes(row));
  if (missingPrograms(rows).length > 0) return [];
  return rows.filter((row) => !EXECUTED_ROWS.has(row));
}

/**
 * What the runner holds, in the order a step's setup releases what the step
 * does not keep: the untouched step's chunks, the filled ballast, the
 * stand-in, the analysis services (their termination records are kept, so
 * every later wait still counts from them), and the inputs.
 */
export const RELEASE_ORDER = ['untouched', 'ballast', 'stand-in', 'services', 'inputs'] as const;
export type Held = (typeof RELEASE_ORDER)[number];

/** What `step`'s setup keeps of what the runner holds; it releases the rest. */
export function keptFor(step: Step): ReadonlySet<Held> {
  switch (step.kind) {
    case 'untouched':
      return new Set();
    case 'ballast':
      return new Set<Held>(['ballast']);
    case 'sequence':
      return new Set<Held>(step.condition.standIn ? ['stand-in', 'services', 'inputs'] : ['services', 'inputs']);
  }
}

/** What a sequence step asks for that no executor builds yet, or null when the sequence executor runs it. */
export function unbuiltCondition(step: SequenceStep): string | null {
  if (step.condition.gl !== 'none' || step.after.gl !== null) return 'a GL ballast';
  if (step.condition.ballastMb > 0) return 'a memory ballast beside a sequence';
  if (step.condition.decoder !== 'none' || step.decode !== 'none' || step.after.openDecoder) return 'a decoder';
  if (step.stages.some((stage) => stage === 'inpaint') && step.hole === null) return 'an inpaint stage with no hole';
  return null;
}

/** What the runner holds now, untouched chunks, ballast chunks, and the stand-in together, for the page's report. */
export type Holding = { readonly chunks: number; readonly mb: number };

type StageKind = HeavyTermination['largest'];

/** The stage with the longer cooldown default, or `b` when `a` is null. */
function largerStage(a: StageKind | null, b: StageKind): StageKind {
  return a === null || COOLDOWN_MS[b] > COOLDOWN_MS[a] ? b : a;
}

/** The later of two terminations, the one with the longer cooldown at the same time, or either when the other is null. */
function laterOf(a: HeavyTermination | null, b: HeavyTermination | null): HeavyTermination | null {
  if (a === null) return b;
  if (b === null) return a;
  if (b.atMs !== a.atMs) return b.atMs > a.atMs ? b : a;
  return largerStage(a.largest, b.largest) === a.largest ? a : b;
}

export type RunnerDeps = {
  readonly clock: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>;
  /** The levers of the run being executed: the plan's, which a resumed run keeps whatever the URL now says. */
  readonly levers: () => Levers | null;
  /**
   * Allocates a zeroed buffer of `bytes`; the page's is `new Uint8Array(bytes)`.
   * Every buffer the runner holds comes from it, through the throwAtMb lever.
   */
  readonly allocate: Allocate;
  /** Builds an analysis service at `threads` that logs to `diag`; the page builds it on the real sequence worker. */
  readonly service: (threads: SequenceStep['threads'], diag: DiagnosticSink<AnalysisEvent>) => HeavyService;
  /** Where a sequence's master and hole come from. */
  readonly inputs: Inputs;
  /** Called whenever what the runner holds changes. */
  readonly onHolding?: (holding: Holding) => void;
};

export type PageRunner = Runner & { readonly holding: Holding };

/** What an executor is handed beside its step. */
type ExecContext = {
  readonly levers: Levers;
  readonly phase: (name: string) => void;
  readonly signal: AbortSignal;
  readonly facts: () => StepFacts;
};

export function createRunner(deps: RunnerDeps): PageRunner {
  const { clock } = deps;
  /** Every buffer the untouched step holds, with its size in MB. */
  let untouchedHeld: { readonly bytes: Uint8Array; readonly mb: number }[] = [];
  /** The kill-point ballast, with the throwAtMb lever its allocator was made with. */
  let ballast: { readonly heap: BallastHeap; readonly throwAtMb: number | null } | null = null;
  let standIn: StandIn | null = null;
  /** One analysis service per thread count, built when a step first asks for it. */
  const services = new Map<SequenceStep['threads'], HeavyService>();
  /** The latest termination of the services released. */
  let retired: HeavyTermination | null = null;
  /** The largest stage whose `stage.start` the sequence worker alive now logged; null between workers. */
  let startedIn: StageKind | null = null;
  /**
   * The latest sequence worker termination the runner heard in which a stage started, keyed by the largest
   * such stage: a service keys its own record by the stages that reached inference, which misses a stage
   * that failed before it, so a termination counts with the larger of the two.
   */
  let heard: HeavyTermination | null = null;
  /** Hears the services' events while a sequence runs. */
  let listener: ((event: ServiceEvent) => void) | null = null;
  /** On the clock: a blocked sequence step's next attempt waits until then in its setup phase. */
  let retryAt = 0;

  const holding = (): Holding => ({
    chunks: untouchedHeld.length + (ballast?.heap.chunks ?? 0) + (standIn === null ? 0 : 1),
    mb: untouchedHeld.reduce((sum, chunk) => sum + chunk.mb, 0) + (ballast?.heap.mb ?? 0) + (standIn?.mb ?? 0),
  });
  const changed = (): void => {
    try {
      deps.onHolding?.(holding());
    } catch {
      // The page's report is not the runner's to fail.
    }
  };

  /** The latest heavy termination of every service the runner built, released ones included, by the services' records and the runner's own. */
  const latest = (): HeavyTermination | null =>
    laterOf(
      [...services.values()].reduce((later, service) => laterOf(later, service.lastHeavyTermination), retired),
      heard,
    );

  /** Keeps the largest stage that started in the sequence worker alive, and the termination of one in which a stage started. */
  const hear = (event: AnalysisEvent, t: number): void => {
    if (event.event === 'worker.spawn' && event.worker === 'sequence') startedIn = null;
    else if (event.event === 'stage.start' && event.op !== 'decode') startedIn = largerStage(startedIn, event.op);
    else if (event.event === 'worker.terminate' && event.worker === 'sequence') {
      if (startedIn !== null) heard = { atMs: t, largest: startedIn };
      startedIn = null;
    }
  };

  const drop: Record<Held, () => void> = {
    untouched: () => {
      if (untouchedHeld.length === 0) return;
      untouchedHeld = [];
      changed();
    },
    ballast: () => {
      if (ballast === null) return;
      const { heap } = ballast;
      ballast = null;
      // The heap reports the change it makes, which the runner then counts without it.
      heap.release();
    },
    'stand-in': () => {
      if (standIn === null) return;
      standIn = null;
      changed();
    },
    services: () => {
      retired = latest();
      services.clear();
    },
    inputs: () => deps.inputs.release(),
  };
  /** Releases, in RELEASE_ORDER, everything the runner holds that `kept` does not name. */
  const releaseExcept = (kept: ReadonlySet<Held>): void => {
    for (const held of RELEASE_ORDER) if (!kept.has(held)) drop[held]();
  };
  const release = (): void => releaseExcept(new Set());

  const serviceFor = (threads: SequenceStep['threads']): HeavyService => {
    const built = services.get(threads);
    if (built !== undefined) return built;
    const service = deps.service(threads, {
      log: (event) => {
        const t = clock.now();
        hear(event, t);
        listener?.({ ...event, t });
      },
    });
    services.set(threads, service);
    return service;
  };

  /** The ballast for `levers`: the one held, or a new empty one when there is none or it was made for another run's chunk or throwAtMb. */
  const heapFor = (levers: Levers): BallastHeap => {
    if (ballast !== null && ballast.heap.chunkMb === levers.chunkMb && ballast.throwAtMb === levers.throwAtMb) return ballast.heap;
    drop.ballast();
    const heap = createHeap({ allocate: leveredAllocator(deps.allocate, levers.throwAtMb), chunkMb: levers.chunkMb, now: () => clock.now(), onChange: changed });
    ballast = { heap, throwAtMb: levers.throwAtMb };
    return heap;
  };

  /** The wait a step with no wait of its own makes: the cooldown default of the last worker, scaled by the defaultsScale lever. */
  const cooldown = ({ levers, phase, signal }: ExecContext): Promise<boolean> =>
    waitOut({ clock, wait: { kind: 'cooldown', scale: levers.defaultsScale }, latest: latest(), phase, signal });

  /** The untouched calibration: allocate in chunks, never write or read them, hold, release. */
  const untouched = async (step: Extract<Step, { readonly kind: 'untouched' }>, context: ExecContext): Promise<StepOutcome> => {
    const { levers, phase, signal } = context;
    if (!(await cooldown(context))) return ABORTED;
    releaseExcept(keptFor(step));
    const allocate = leveredAllocator(deps.allocate, levers.throwAtMb);
    let total = 0;
    while (total < step.mb) {
      if (signal.aborted) {
        release();
        return ABORTED;
      }
      const mb = Math.min(levers.chunkMb, step.mb - total);
      phase(untouchedPhase({ kind: 'alloc', mb: total + mb }));
      const made = allocate(mb, total + mb);
      if (!made.ok) {
        release();
        return { kind: 'throw', atMb: made.error.atMb, message: made.error.message };
      }
      untouchedHeld.push({ bytes: made.value, mb });
      changed();
      total += mb;
      // A task between chunks: the heartbeat and the status run, and Stop is heard, while a large step allocates.
      await pause(clock, 0, signal);
    }
    phase(untouchedPhase({ kind: 'hold', mb: total }));
    const completed = await pause(clock, UNTOUCHED_HOLD_MS * levers.defaultsScale, signal);
    const chunks = holding().chunks;
    release();
    return completed ? { kind: 'held', mb: total, chunks, checksums: [], fillMs: 0 } : ABORTED;
  };

  /** A kill-point step: grow the filled ballast to the step's size, sum every chunk, and hold it. */
  const ballastStep = async (step: Extract<Step, { readonly kind: 'ballast' }>, context: ExecContext): Promise<StepOutcome> => {
    const { levers, phase, signal } = context;
    if (!(await cooldown(context))) {
      drop.ballast();
      return ABORTED;
    }
    releaseExcept(keptFor(step));
    const heap = heapFor(levers);
    // Keep the chunks up to the step's size and drop the rest, a larger ballast an earlier row left. A step run
    // again in the same load holds its size already and allocates nothing; after a reload or `release()` nothing
    // is held, and the ballast grows again from nothing, its `fill:` phases naming totals below the step's size.
    heap.truncate(step.mb);
    const grown = await heap.growTo(step.mb, {
      onFill: (mb) => phase(ballastPhase({ kind: 'fill', mb })),
      // A task between chunks: the heartbeat and the status run, and Stop is heard, while a large step grows.
      between: () => pause(clock, 0, signal),
    });
    if (!grown.ok) {
      // A throw keeps the chunks below the refused one, as filled, so a throw the engine voids and runs again
      // allocates only the refused chunk; the next step's setup or `release()` drops them. Stop drops them all.
      if (grown.error.kind === 'throw') return { kind: 'throw', atMb: grown.error.atMb, message: grown.error.message };
      drop.ballast();
      return ABORTED;
    }
    const checksums = heap.check();
    phase(ballastPhase({ kind: 'hold', mb: heap.mb }));
    const completed = await pause(clock, BALLAST_HOLD_MS * levers.defaultsScale, signal);
    if (!completed) {
      drop.ballast();
      return ABORTED;
    }
    return { kind: 'held', mb: heap.mb, chunks: heap.chunks, checksums, fillMs: grown.value.fillMs };
  };

  /** A sequence step's setup: release what it does not keep, then hold the stand-in, the master and hole, and the models. */
  const sequenceSetup = async (step: SequenceStep, service: HeavyService, levers: Levers, signal: AbortSignal): Promise<Result<SequenceSetup, string>> => {
    releaseExcept(keptFor(step));
    if (step.condition.standIn && standIn === null) {
      // The stand-in is not the ballast the throwAtMb lever measures.
      const made = createStandIn(leveredAllocator(deps.allocate, null), levers.chunkMb);
      if (!made.ok) return err(`the stand-in could not be allocated: ${made.error.message}`);
      standIn = made.value;
      changed();
    }
    const master = await deps.inputs.master(step.master, signal);
    if (!master.ok) return err(master.error);
    const { hole } = step;
    const stageOf = (kind: SequenceStep['stages'][number]): HeavyStage => {
      if (kind !== 'inpaint') return { kind };
      // unbuiltCondition refuses an inpaint stage with no hole before the step begins.
      if (hole === null) throw new Error('an inpaint stage reached the setup with no hole');
      return { kind, hole: deps.inputs.hole(hole, step.master) };
    };
    const [first, ...rest] = step.stages;
    const stages: NonEmpty<HeavyStage> = [stageOf(first), ...rest.map(stageOf)];
    const fetched = await service.fetchModels(step.stages, signal, () => undefined);
    if (!fetched.ok) return err(`the models could not be fetched: ${JSON.stringify(fetched.error)}`);
    const heldBeside = standIn;
    const condition = (): SequenceReading['condition'] => {
      const standInPairs: readonly ChecksumPair[] = heldBeside === null ? [] : [heldBeside.check()];
      return {
        gl: 'none',
        textureBytes: 0,
        glBuild: null,
        framesDrawn: 0,
        contextLostAtMs: null,
        standIn: standInPairs,
        ballast: [],
        checksumsMatch: standInPairs.every((pair) => pair.after === pair.fill),
      };
    };
    return ok({ stages, input: { master: master.value.bitmap }, condition });
  };

  /** A sequence step: its wait, its setup, one run through the service of its thread count, and `after`. */
  const sequence = async (step: SequenceStep, { levers, phase, signal, facts }: ExecContext): Promise<StepOutcome> => {
    const unbuilt = unbuiltCondition(step);
    if (unbuilt !== null) throw new Error(`no executor runs a sequence step with ${unbuilt} yet`);
    const service = serviceFor(step.threads);
    const outcome = await runSequenceStep(
      {
        clock,
        service,
        listen: (heard) => {
          listener = heard;
          return () => {
            if (listener === heard) listener = null;
          };
        },
        latest,
      },
      { step, timeoutMs: levers.timeoutS * 1_000, retryAt, setup: (aborted) => sequenceSetup(step, service, levers, aborted), phase, signal, facts },
    );
    if (outcome === ABORTED) release();
    return outcome;
  };

  return {
    get holding() {
      return holding();
    },

    async execute(step, phase, signal, facts) {
      const levers = deps.levers();
      if (levers === null) throw new Error('the runner was handed a step with no run to take its levers from');
      const context: ExecContext = { levers, phase, signal, facts };
      let outcome: StepOutcome;
      switch (step.kind) {
        case 'untouched':
          outcome = await untouched(step, context);
          break;
        case 'ballast':
          outcome = await ballastStep(step, context);
          break;
        case 'sequence':
          outcome = await sequence(step, context);
          break;
        default: {
          const exhaustive: never = step;
          return exhaustive;
        }
      }
      // A step that could not be set up is retried after the retry time, which only the sequence executor waits; any other answer clears it.
      retryAt = outcome.kind === 'blocked' && outcome !== ABORTED ? clock.now() + BLOCKED_RETRY_MS * levers.defaultsScale : 0;
      return outcome;
    },

    release,
  };
}
