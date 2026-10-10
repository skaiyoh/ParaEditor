// The memory harness's registry of row programs: what a program is, which
// families have one built, and the dispatch that asks a row's program for
// its next step, folds an outcome into its state, and reads its verdict. A
// new program adds its family to `BUILT` and its case to each dispatch here.

import { familyOf, type Family, type RowId } from './catalog.ts';
import type { PlanContext } from './context.ts';
import { killpointProgram } from './programs/killpoint.ts';
import { runsProgram } from './programs/runs.ts';
import { untouchedProgram } from './programs/untouched.ts';
import type { StepOutcome } from './rows.ts';
import type { PlanRow, RowState, RowVerdict } from './states.ts';
import type { PlannedStep } from './steps.ts';

/** What a program folds: a scored outcome; voids, blocked steps, and an unavailable GL are the shared layer's. */
export type Folded = Exclude<StepOutcome, { readonly kind: 'void' | 'blocked' | 'gl-unavailable' }>;

/** A row family's rules, pure, over its own state. */
export type Program<S extends RowState> = {
  /** The row's next step, or null when the row has ended. */
  readonly next: (state: S, ctx: PlanContext) => PlannedStep | null;
  /** The state after `planned`'s outcome; a `died-after-terminate` arrives for the step whose worker the death followed. */
  readonly fold: (state: S, planned: PlannedStep, outcome: Folded) => S;
  /** The verdict of the row, read once it has ended or been amended. */
  readonly verdict: (state: S) => RowVerdict;
};

/** The families whose programs are built; createPlan refuses a plan holding a row of any other. */
const BUILT: ReadonlySet<Family> = new Set<Family>(['untouched', 'killpoint', 'runs']);

/** The plan rows whose family has no program yet, which Start refuses to run, naming them. */
export function missingPrograms(rows: readonly RowId[]): readonly RowId[] {
  return rows.filter((row) => !BUILT.has(familyOf(row)));
}

function noProgram(state: RowState): Error {
  return new Error(`no program is built for ${state.row} (family ${state.family}); createPlan refuses a plan holding such a row`);
}

export function nextStep(state: RowState, ctx: PlanContext): PlannedStep | null {
  if (state.family === 'untouched') return untouchedProgram.next(state, ctx);
  if (state.family === 'killpoint') return killpointProgram.next(state, ctx);
  if (state.family === 'runs') return runsProgram.next(state, ctx);
  throw noProgram(state);
}

export function foldStep(state: RowState, planned: PlannedStep, outcome: Folded): RowState {
  if (state.family === 'untouched') return untouchedProgram.fold(state, planned, outcome);
  if (state.family === 'killpoint') return killpointProgram.fold(state, planned, outcome);
  if (state.family === 'runs') return runsProgram.fold(state, planned, outcome);
  throw noProgram(state);
}

export function rowVerdict(row: PlanRow): RowVerdict {
  if (row.halt !== null) return { kind: row.halt.kind, stepKey: row.halt.stepKey };
  if (row.state.family === 'untouched') return untouchedProgram.verdict(row.state);
  if (row.state.family === 'killpoint') return killpointProgram.verdict(row.state);
  if (row.state.family === 'runs') return runsProgram.verdict(row.state);
  throw noProgram(row.state);
}
