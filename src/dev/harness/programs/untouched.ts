// The program of the untouched calibration: one step that allocates the
// `untouchedMb` lever's megabytes chunk by chunk without writing or reading
// them, holds them, and releases them, with no model, no GL, and no stand-in.
// It checks that allocation alone does not count against the kill point: it
// is expected to survive, and a kill names the size the allocation had
// reached, read from the phase the runner wrote before the process died.
// The runner writes its phases with `untouchedPhase` and the verdict reads
// them back with `parseUntouchedPhase`, so the two cannot drift. Pure.

import type { Program } from '../registry.ts';
import type { RowVerdict, StateOf } from '../states.ts';
import type { PlannedStep } from '../steps.ts';

type UntouchedState = StateOf<'untouched'>;

/** The step's one key. */
export const UNTOUCHED_KEY = 'untouched';

/** What the untouched step is doing: allocating the chunk that brings it to `mb`, or holding `mb`. */
export type UntouchedPhase = { readonly kind: 'alloc'; readonly mb: number } | { readonly kind: 'hold'; readonly mb: number };

/** The phase name the runner reports: `alloc:<mb>` or `hold:<mb>`. */
export function untouchedPhase(phase: UntouchedPhase): string {
  return `${phase.kind}:${phase.mb}`;
}

/** The untouched phase `name` names, or null for any other phase (`wait`, `setup`, `after`, `unknown`). */
export function parseUntouchedPhase(name: string): UntouchedPhase | null {
  const match = /^(alloc|hold):([1-9]\d*)$/.exec(name);
  if (match === null) return null;
  const [, kind, mb = ''] = match;
  return kind === 'alloc' ? { kind: 'alloc', mb: Number(mb) } : kind === 'hold' ? { kind: 'hold', mb: Number(mb) } : null;
}

export const untouchedProgram: Program<UntouchedState> = {
  next(state, ctx): PlannedStep | null {
    if (state.end !== null) return null;
    return { key: UNTOUCHED_KEY, step: { kind: 'untouched', mb: ctx.levers.untouchedMb } };
  },

  fold(state, planned, outcome): UntouchedState {
    if (state.end !== null || planned.key !== UNTOUCHED_KEY) return state;
    switch (outcome.kind) {
      case 'held':
        return { ...state, end: { kind: 'held' } };
      case 'throw':
        return { ...state, end: { kind: 'throw', atMb: outcome.atMb } };
      case 'killed':
        return { ...state, end: { kind: 'killed', phase: outcome.phase } };
      case 'ran':
      case 'died-after-terminate':
        // A sequence's outcome, and a death after a worker's termination, cannot come from an untouched step.
        return state;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },

  verdict(state): RowVerdict {
    const end = state.end;
    if (end === null) return { kind: 'untouched', end: null };
    switch (end.kind) {
      case 'held':
        return { kind: 'untouched', end: { kind: 'survived' } };
      case 'throw':
        return { kind: 'untouched', end: { kind: 'throw', atMb: end.atMb } };
      case 'killed':
        return { kind: 'untouched', end: { kind: 'killed', atMb: parseUntouchedPhase(end.phase)?.mb ?? null, phase: end.phase } };
      default: {
        const exhaustive: never = end;
        return exhaustive;
      }
    }
  },
};
