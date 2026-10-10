// The program of the two kill-point rows, `U1.killpoint` and
// `U1.killpoint.after`: a ladder of ballast steps, one chunk (the chunkMb
// lever) apart, from one chunk up to the ceilingMb lever. Each step grows the
// filled ballast by one chunk, sums every chunk, and holds it; a step held
// moves the row's last held step up to it. A kill or a throw in a step ends
// the row at that step's size, the last held step one chunk below, and
// holding the ladder's last step ends it at the ceiling. A kill keeps the
// phase it came in: the step's own `fill:` or `hold:`, or the smaller `fill:`
// of a step growing the ballast again from nothing after a reload, which the
// reader sees beside the kill point. The runner writes its phases with
// `ballastPhase` and the verdict reads them back with `parseBallastPhase`,
// so the two cannot drift. Pure.

import type { Levers } from '../context.ts';
import type { Program } from '../registry.ts';
import type { RowVerdict, StateOf } from '../states.ts';
import type { PlannedStep } from '../steps.ts';

type KillpointState = StateOf<'killpoint'>;

/** What a ballast step is doing: allocating and filling the chunk that brings the ballast to `mb`, or holding `mb`. */
export type BallastPhase = { readonly kind: 'fill'; readonly mb: number } | { readonly kind: 'hold'; readonly mb: number };

/** The phase name the runner reports: `fill:<mb>` or `hold:<mb>`. */
export function ballastPhase(phase: BallastPhase): string {
  return `${phase.kind}:${phase.mb}`;
}

/** The ballast phase `name` names, or null for any other phase (`wait`, `setup`, `after`, `unknown`). */
export function parseBallastPhase(name: string): BallastPhase | null {
  const match = /^(fill|hold):([1-9]\d*)$/.exec(name);
  if (match === null) return null;
  const [, kind, mb = ''] = match;
  return kind === 'fill' ? { kind: 'fill', mb: Number(mb) } : kind === 'hold' ? { kind: 'hold', mb: Number(mb) } : null;
}

/** The ladder's last step: the ceilingMb lever floored to a whole chunk, 0 when the ceiling is below one chunk. */
export function ladderTopMb(levers: Pick<Levers, 'chunkMb' | 'ceilingMb'>): number {
  return Math.floor(levers.ceilingMb / levers.chunkMb) * levers.chunkMb;
}

/** A step's key: `mb-<size>`. */
export const stepKeyOf = (mb: number): string => `mb-${mb}`;

export const killpointProgram: Program<KillpointState> = {
  next(state, ctx): PlannedStep | null {
    if (state.end !== null) return null;
    const mb = state.heldMb + ctx.levers.chunkMb;
    return { key: stepKeyOf(mb), step: { kind: 'ballast', mb, release: 'all' } };
  },

  fold(state, planned, outcome): KillpointState {
    const step = planned.step;
    if (state.end !== null || step.kind !== 'ballast' || planned.key !== stepKeyOf(step.mb) || step.mb <= state.heldMb) return state;
    switch (outcome.kind) {
      case 'held':
        return { ...state, heldMb: step.mb, end: step.mb >= state.topMb ? { kind: 'ceiling' } : null };
      // The step's size, not the total its phase or its throw names: those are smaller while a step grows the
      // ballast again from nothing, and the kill point is the step that did not hold, one chunk above the last held.
      case 'throw':
        return { ...state, end: { kind: 'throw', atMb: step.mb } };
      case 'killed':
        return { ...state, end: { kind: 'killed', atMb: step.mb, phase: outcome.phase } };
      case 'ran':
      case 'died-after-terminate':
        // A sequence's outcome, and a death after a worker's termination, cannot come from a ballast step.
        return state;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },

  verdict(state): RowVerdict {
    return { kind: 'killpoint', heldMb: state.heldMb, end: state.end };
  },
};
