// The step marker, and what a page load makes of it. Before every step and at
// every phase change the engine writes the marker synchronously, and while a
// step runs it rewrites `aliveAtWall` every second; visibility changes and
// `pagehide` annotate it and never clear it. A process killed by the system
// runs no `pagehide`, so at the next load the marker, read beside the plan,
// says how the step in flight died: a kill is folded into its row and never
// reruns the step; a void (the page was left, hidden at death, or hidden
// longer than the grace the app is specified to allow) reruns it, capped
// apart from kills; a death in a wait after a worker's termination is folded
// into the row that ran that worker. Pure: the engine reads the two keys,
// calls these, persists the plan they return, and enqueues the rows.

import { err, ok, type Result } from '../../core/result.ts';
import { isTabId, type BuildId, type TabId } from '../../core/ids.ts';
import { describeIssues } from '../../core/schema.ts';
import { z } from '../../core/zod.ts';
import { COOLDOWN_MS, HIDDEN_GRACE_MS } from './lines.ts';
import { rowIdSchema } from './catalog.ts';
import { foldInto, inFlightStep, runIdSchema, stampRows, voidStep, withRerun, type Applied, type PlanState, type StepCounts } from './plan.ts';
import { hiddenGraceMsFor, phaseSchema, resumeWaitMsFor, stepKeySchema, stepSchema, type PlannedStep, type VoidReason } from './steps.ts';
import type { HarnessEvent, LoadVerdictName, LostVerdict, StepOutcome } from './rows.ts';

const wallSchema = z.number();
const tabIdSchema = z.custom<TabId>((value) => typeof value === 'string' && isTabId(value), { message: 'expected a lowercase UUID v4' });

export const stepMarkerSchema = z
  .strictObject({
    run: runIdSchema,
    row: rowIdSchema,
    stepKey: stepKeySchema,
    step: stepSchema,
    attempt: z.int().min(1),
    voids: z.int().min(0),
    tab: tabIdSchema,
    load: z.int().min(1),
    phase: phaseSchema,
    startedAtWall: wallSchema,
    /** Rewritten every second while the step is in flight, so a death is dated within a second. */
    aliveAtWall: wallSchema,
    visibility: z.enum(['visible', 'hidden']),
    hiddenSinceWall: wallSchema.nullable(),
    /** The hidden periods that ended, summed, and the longest of them. */
    hiddenMs: z.number().min(0),
    longestHiddenMs: z.number().min(0),
    pagehideAtWall: wallSchema.nullable(),
    /** The step whose heavy worker this step's wait is waiting out, terminated in this load; null when none has terminated in it. */
    waitingOut: z
      .strictObject({
        row: rowIdSchema,
        stepKey: stepKeySchema,
        step: stepSchema,
        load: z.int().min(1),
        stage: z.enum(['depth', 'encode', 'inpaint']),
        terminatedAtWall: wallSchema,
      })
      .readonly()
      .nullable(),
  })
  .readonly();
export type StepMarker = z.infer<typeof stepMarkerSchema>;
export type WaitingOut = NonNullable<StepMarker['waitingOut']>;

/** Parses the stored marker; null when nothing is stored. */
export function parseMarker(text: string | null): Result<StepMarker | null, string> {
  if (text === null) return ok(null);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return err(`the stored step marker is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = stepMarkerSchema.safeParse(json);
  return parsed.success ? ok(parsed.data) : err(`the stored step marker does not parse: ${describeIssues(parsed.error.issues)}`);
}

type Killed = Extract<StepOutcome, { readonly kind: 'killed' }>;
type DiedAfterTerminate = Extract<StepOutcome, { readonly kind: 'died-after-terminate' }>;

/** What a load found. */
export type LoadVerdict =
  /** No plan, or a plan between steps: continue at the cursor. */
  | { readonly kind: 'fresh' }
  /** A plan of another build: Start begins a new run. */
  | { readonly kind: 'stale' }
  /** The step in flight reruns. */
  | { readonly kind: 'void'; readonly reason: VoidReason; readonly marker: StepMarker }
  /** The step in flight was killed while visible: folded into its row. */
  | { readonly kind: 'killed'; readonly marker: StepMarker; readonly outcome: Killed }
  /** The process died in a wait while an earlier step's worker drained: folded into that step's row. */
  | { readonly kind: 'died-after-terminate'; readonly marker: StepMarker; readonly attributedTo: WaitingOut; readonly outcome: DiedAfterTerminate }
  /** The process died after the step's state was saved: posted, not folded. */
  | { readonly kind: 'after-completion'; readonly marker: StepMarker; readonly death: LostVerdict }
  /** A step was in flight and its marker is missing: folded as killed in phase `unknown`. */
  | { readonly kind: 'marker-lost' }
  /**
   * A plan between steps, and a marker a later load already applied and died
   * before clearing: named fresh, since nothing is posted or folded, but the
   * wait that load owed still holds.
   */
  | { readonly kind: 'applied-earlier'; readonly marker: StepMarker };

export function loadVerdictName(verdict: LoadVerdict): LoadVerdictName {
  if (verdict.kind === 'void') return verdict.reason;
  if (verdict.kind === 'applied-earlier') return 'fresh';
  return verdict.kind;
}

type Death =
  | { readonly kind: 'void'; readonly reason: VoidReason }
  | { readonly kind: 'killed'; readonly outcome: Killed }
  | { readonly kind: 'died-after-terminate'; readonly attributedTo: WaitingOut; readonly outcome: DiedAfterTerminate };

/** How the process holding `marker` died, by its visibility at death and its phase. */
function deathOf(marker: StepMarker, nowWall: number): Death {
  if (marker.pagehideAtWall !== null) return { kind: 'void', reason: 'left' };
  if (marker.visibility === 'hidden') return { kind: 'void', reason: 'background' };
  if (marker.longestHiddenMs > HIDDEN_GRACE_MS) return { kind: 'void', reason: 'hidden' };
  const aliveAgeMs = nowWall - marker.aliveAtWall;
  const killed: Death = {
    kind: 'killed',
    outcome: { kind: 'killed', phase: marker.phase, markerAgeMs: nowWall - marker.startedAtWall, aliveAgeMs, hiddenMs: marker.hiddenMs },
  };
  // In U2 the wait is the gap the row measures, so a death in it belongs to the waiting step.
  if (marker.phase !== 'wait' || marker.row.startsWith('U2.')) return killed;
  if (marker.waitingOut === null) return { kind: 'void', reason: 'died-idle' };
  return {
    kind: 'died-after-terminate',
    attributedTo: marker.waitingOut,
    outcome: { kind: 'died-after-terminate', sinceTerminateMs: marker.aliveAtWall - marker.waitingOut.terminatedAtWall, aliveAgeMs },
  };
}

/**
 * Whether a load's verdict is one of the deaths the liveness report covers:
 * a kill, a death in a wait, a death with no worker draining, a page reclaimed
 * while hidden, or a lost marker. A page that was left is not a death; the
 * process that ran a step hidden past the grace, or that died after the
 * step's state was saved, died too, but the report does not cover them.
 */
export function isProcessDeath(verdict: LoadVerdict): boolean {
  switch (verdict.kind) {
    case 'killed':
    case 'died-after-terminate':
    case 'marker-lost':
      return true;
    case 'void':
      return verdict.reason === 'died-idle' || verdict.reason === 'background';
    case 'fresh':
    case 'stale':
    case 'after-completion':
    case 'applied-earlier':
      return false;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

const lostVerdictOf = (death: Death): LostVerdict => (death.kind === 'void' ? death.reason : death.kind);

/** Whether `marker` was written for the step `counts` names, in `plan`'s run. */
function marks(marker: StepMarker, plan: PlanState, counts: StepCounts): boolean {
  return marker.run === plan.run && marker.row === counts.row && marker.stepKey === counts.stepKey && marker.attempt === counts.attempt;
}

/**
 * Classifies a load from the stored plan and step marker, the page's build
 * id, and the wall clock. A marker of another run, or of another attempt than
 * the one in flight, is not this plan's and counts as missing. A marker
 * written in an earlier load than the plan's latest, when no step is in
 * flight, was applied by a later load that died before clearing it:
 * `applied-earlier`.
 */
export function classifyLoad(plan: PlanState | null, marker: StepMarker | null, build: BuildId, nowWall: number): LoadVerdict {
  if (plan === null) return { kind: 'fresh' };
  if (plan.build !== build) return { kind: 'stale' };
  const counts = plan.inFlight;
  if (counts === null) {
    if (marker === null || marker.run !== plan.run) return { kind: 'fresh' };
    if (marker.load < plan.loads) return { kind: 'applied-earlier', marker };
    return { kind: 'after-completion', marker, death: lostVerdictOf(deathOf(marker, nowWall)) };
  }
  if (marker === null || !marks(marker, plan, counts)) return { kind: 'marker-lost' };
  const death = deathOf(marker, nowWall);
  switch (death.kind) {
    case 'void':
      return { kind: 'void', reason: death.reason, marker };
    case 'killed':
      return { kind: 'killed', marker, outcome: death.outcome };
    case 'died-after-terminate':
      return { kind: 'died-after-terminate', marker, attributedTo: death.attributedTo, outcome: death.outcome };
    default: {
      const exhaustive: never = death;
      return exhaustive;
    }
  }
}

/**
 * Scores a step that completed: one whose longest hidden period, the one
 * still running included, exceeded its kind's hidden grace
 * (`hiddenGraceMsFor`) is voided whatever its outcome, since the app is
 * specified to cancel a job hidden that long; any other outcome counts as it
 * is. A blocked step is not a score and stays blocked, and a step already
 * voided keeps its reason.
 */
export function scoreCompleted(outcome: StepOutcome, marker: StepMarker, nowWall: number): StepOutcome {
  if (outcome.kind === 'blocked' || outcome.kind === 'void') return outcome;
  const running = marker.visibility === 'hidden' && marker.hiddenSinceWall !== null ? nowWall - marker.hiddenSinceWall : 0;
  return Math.max(marker.longestHiddenMs, running) > hiddenGraceMsFor(marker.step) ? { kind: 'void', reason: 'hidden' } : outcome;
}

/** The plan after a load's verdict, the rows it posts, and the least wait before the next step, counted from the load. */
export type LoadApplied = Applied & { readonly leastWaitMs: number };

/**
 * Applies a load's verdict to the plan. Every load of the run raises
 * `loads`, and the rows it posts carry the new load; kills and voids raise
 * their counters, and a death the liveness report covers (isProcessDeath)
 * raises `deaths`. After any verdict but fresh (and stale, which changes
 * nothing), the next step waits at least the dead step's largest stage's
 * cooldown default (after a death in a wait, the waited-out step's), scaled
 * by the defaultsScale lever, from the load; `applied-earlier`, named fresh,
 * waits it too.
 */
export function applyLoad(plan: PlanState, verdict: LoadVerdict, nowWall: number): LoadApplied {
  if (verdict.kind === 'stale') return { plan, rows: [], leastWaitMs: 0 };
  const loaded: PlanState = { ...plan, loads: plan.loads + 1, deaths: plan.deaths + (isProcessDeath(verdict) ? 1 : 0) };
  const scale = plan.levers.defaultsScale;
  const counts = plan.inFlight;
  switch (verdict.kind) {
    case 'fresh':
      return { plan: loaded, rows: [], leastWaitMs: 0 };
    case 'applied-earlier':
      // The load that applied the marker died before it waited out the cooldown it owed, so this load owes it, counted from now.
      return { plan: loaded, rows: [], leastWaitMs: resumeWaitMsFor(owedStep(verdict.marker, nowWall), scale) };
    case 'after-completion': {
      const { marker } = verdict;
      const lost = lostEvent(marker, verdict.death, null, nowWall, true);
      return { ...stampRows(loaded, [lost], nowWall), leastWaitMs: resumeWaitMsFor(owedStep(marker, nowWall), scale) };
    }
    case 'marker-lost': {
      if (counts === null) return { plan: loaded, rows: [], leastWaitMs: 0 };
      // The step is recomputed in the load it started in, so a program keyed by the load gives the step that ran.
      const planned = inFlightStep(plan);
      const outcome: Killed = { kind: 'killed', phase: 'unknown', markerAgeMs: null, aliveAgeMs: null, hiddenMs: 0 };
      const lost: HarnessEvent = {
        type: 'step-lost',
        row: counts.row,
        stepKey: counts.stepKey,
        attempt: counts.attempt,
        verdict: 'killed',
        phase: outcome.phase,
        markerAgeMs: null,
        aliveAgeMs: null,
        hiddenMs: 0,
        attributedTo: null,
        afterCompletion: false,
      };
      const killed = { ...loaded, kills: loaded.kills + 1, inFlight: null };
      // A step the row no longer names cannot be folded or sized: the kill is counted and posted, and the wait is the longest default.
      const leastWaitMs = planned === null ? Math.max(...Object.values(COOLDOWN_MS)) * scale : resumeWaitMsFor(planned.step, scale);
      return withLost(killed, lost, nowWall, (p) => (planned === null ? { plan: p, rows: [] } : foldInto(p, counts.row, planned, outcome, nowWall)), leastWaitMs);
    }
    case 'void':
    case 'killed':
    case 'died-after-terminate': {
      if (counts === null) return { plan: loaded, rows: [], leastWaitMs: 0 };
      const { marker } = verdict;
      // A death in a wait came while the waited-out worker drained, and that worker, not the waiting step, may still be tearing down.
      const leastWaitMs = resumeWaitMsFor(verdict.kind === 'died-after-terminate' ? verdict.attributedTo.step : marker.step, scale);
      if (verdict.kind === 'void') {
        const lost = lostEvent(marker, verdict.reason, null, nowWall, false);
        return withLost(loaded, lost, nowWall, (p) => voidStep(p, counts, marker.step, nowWall), leastWaitMs);
      }
      const killed = { ...loaded, kills: loaded.kills + 1, inFlight: null };
      if (verdict.kind === 'killed') {
        const lost = lostEvent(marker, 'killed', null, nowWall, false);
        const planned: PlannedStep = { key: marker.stepKey, step: marker.step };
        return withLost(killed, lost, nowWall, (p) => foldInto(p, counts.row, planned, verdict.outcome, nowWall), leastWaitMs);
      }
      // The waiting step was never scored: it runs next, with its counts, if its row still wants it.
      const { attributedTo, outcome } = verdict;
      const attribution = { row: attributedTo.row, stepKey: attributedTo.stepKey, sinceTerminateMs: outcome.sinceTerminateMs };
      const lost = lostEvent(marker, 'died-after-terminate', attribution, nowWall, false);
      const drained: PlannedStep = { key: attributedTo.stepKey, step: attributedTo.step };
      return withLost({ ...killed, reruns: withRerun(killed.reruns, counts) }, lost, nowWall, (p) => foldInto(p, attributedTo.row, drained, outcome, nowWall), leastWaitMs);
    }
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/** The step whose cooldown a death `marker` records owes: after a death in a wait, the waited-out step; otherwise the marker's own. */
function owedStep(marker: StepMarker, nowWall: number): StepMarker['step'] {
  const death = deathOf(marker, nowWall);
  return death.kind === 'died-after-terminate' ? death.attributedTo.step : marker.step;
}

/** Posts `lost` first, then whatever `then` does to the plan. */
function withLost(plan: PlanState, lost: HarnessEvent, nowWall: number, then: (plan: PlanState) => Applied, leastWaitMs: number): LoadApplied {
  const first = stampRows(plan, [lost], nowWall);
  const rest = then(first.plan);
  return { plan: rest.plan, rows: [...first.rows, ...rest.rows], leastWaitMs };
}

type Attribution = Extract<HarnessEvent, { readonly type: 'step-lost' }>['attributedTo'];

/** The `step-lost` row of the step `marker` names. */
function lostEvent(marker: StepMarker, verdict: LostVerdict, attributedTo: Attribution, nowWall: number, afterCompletion: boolean): HarnessEvent {
  return {
    type: 'step-lost',
    row: marker.row,
    stepKey: marker.stepKey,
    attempt: marker.attempt,
    verdict,
    phase: marker.phase,
    markerAgeMs: nowWall - marker.startedAtWall,
    aliveAgeMs: nowWall - marker.aliveAtWall,
    hiddenMs: marker.hiddenMs,
    attributedTo,
    afterCompletion,
  };
}
