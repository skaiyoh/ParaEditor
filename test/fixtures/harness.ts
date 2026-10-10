// Shared values for the memory harness's node tests: a build id, a tab, the
// default levers, plans of the rows given (each row's family must have a
// program), the step marker the engine would write for the step in flight,
// and a sequence run's outcome.

import { isBuildId, isTabId, type BuildId, type TabId } from '../../src/core/ids.ts';
import type { StepMarker } from '../../src/dev/harness/load.ts';
import { LEVER_DEFAULTS } from '../../src/dev/harness/lines.ts';
import type { PlanKind, RowId } from '../../src/dev/harness/catalog.ts';
import type { Levers } from '../../src/dev/harness/context.ts';
import { beginStep, createPlan, type PlanState, type StepCounts } from '../../src/dev/harness/plan.ts';
import type { PlannedStep, Score } from '../../src/dev/harness/steps.ts';
import type { HarnessRow, SequenceReading, StepOutcome } from '../../src/dev/harness/rows.ts';

function buildId(text: string): BuildId {
  if (!isBuildId(text)) throw new Error(`not a build id: ${text}`);
  return text;
}

function tabId(text: string): TabId {
  if (!isTabId(text)) throw new Error(`not a tab id: ${text}`);
  return text;
}

export const BUILD = buildId('0123456789ab-20261003');
export const OTHER_BUILD = buildId('ba9876543210-20261004');
export const TAB = tabId('3f0c1a52-8d4e-4b7a-9c61-0e2f5d7a8b90');
export const RUN = '20261003T120000Z-beef';
/** The wall clock at Start. */
export const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

export const LEVERS: Levers = { ...LEVER_DEFAULTS };

/** A plan of `rows` at `runs` runs each, as Start makes it. */
export function planOf(rows: readonly RowId[], runs = 3, kind: PlanKind = 'full'): PlanState {
  const made = createPlan({ kind, run: RUN, build: BUILD, levers: { ...LEVERS, rows, runs }, levered: true, ascentCapMb: null, nowWall: T0 });
  if (!made.ok) throw new Error(`createPlan refused: ${made.error.rows.join(', ')}`);
  return made.value.plan;
}

/** Begins the plan's next step and returns the plan with it in flight, the step, and its counts. */
export function begin(plan: PlanState, nowWall = T0): { readonly plan: PlanState; readonly planned: PlannedStep; readonly counts: StepCounts; readonly rows: readonly HarnessRow[] } {
  const begun = beginStep(plan, nowWall, TAB);
  if (begun === null) throw new Error('the plan is done');
  return begun;
}

/** The marker the engine writes for the step in flight, at `phase`, visible, never hidden, with no worker waited out. */
export function markerFor(plan: PlanState, planned: PlannedStep, patch: Partial<StepMarker> = {}): StepMarker {
  const counts = plan.inFlight;
  if (counts === null) throw new Error('no step in flight');
  return {
    run: plan.run,
    row: counts.row,
    stepKey: counts.stepKey,
    step: planned.step,
    attempt: counts.attempt,
    voids: counts.voids,
    tab: TAB,
    load: plan.loads,
    phase: 'run:encode',
    startedAtWall: T0,
    aliveAtWall: T0 + 4_000,
    visibility: 'visible',
    hiddenSinceWall: null,
    hiddenMs: 0,
    longestHiddenMs: 0,
    pagehideAtWall: null,
    waitingOut: null,
    ...patch,
  };
}

export function reading(patch: Partial<SequenceReading['condition']> = {}): SequenceReading {
  return {
    stages: [
      { op: 'depth', ms: 2300, wasmHighWaterBytes: 300_000_000 },
      { op: 'encode', ms: 4800, wasmHighWaterBytes: 722_000_000 },
    ],
    wallMs: 6200,
    gapMs: 20_000,
    setupMs: 3,
    product: { map: { size: { width: 1190, height: 896 }, min: 0, max: 1 }, embeddings: { dims: [[1, 256, 64, 64]] }, plate: null },
    condition: {
      gl: 'full',
      textureBytes: 239_000_000,
      glBuild: { ms: 40, spotCheck: true },
      framesDrawn: 370,
      contextLostAtMs: null,
      standIn: [{ chunk: 0, fill: 123, after: 123 }],
      ballast: [],
      checksumsMatch: true,
      ...patch,
    },
    hiddenMs: 0,
    longestHiddenMs: 0,
    load: 1,
  };
}

export const SURVIVED: StepOutcome = { kind: 'ran', score: { kind: 'survived' }, reading: reading() };

export function ran(score: Score): StepOutcome {
  return { kind: 'ran', score, reading: reading() };
}
