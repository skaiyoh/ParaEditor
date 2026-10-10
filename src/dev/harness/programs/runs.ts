// The program of the rows that run one sequence N times and end at the first
// run that does not survive: the three survival rows, each under its own GL
// condition, and the panorama, under the encode mode. Each run is
// `[depth, encode]` beside the stand-in, waiting the cooldown default from
// the previous worker's termination. Pure.

import type { PlanContext } from '../context.ts';
import type { Program } from '../registry.ts';
import type { RowVerdict, RunsState } from '../states.ts';
import type { GlMode, PlannedStep, Step } from '../steps.ts';

const MASTER_4_3 = { width: 2048, height: 1536 } as const;
const MASTER_PANORAMA = { width: 2048, height: 512 } as const;

/** The GL a run of `row` holds: a survival row's own condition, or for the panorama the encode mode (none when no mode survived). */
function glOf(row: RunsState['row'], ctx: PlanContext): GlMode {
  switch (row) {
    case 'U1.survival.full':
      return 'full';
    case 'U1.survival.low':
      return 'low';
    case 'U1.survival.none':
      return 'none';
    case 'U1.panorama':
      return ctx.encode.kind === 'selected' ? ctx.encode.gl : 'none';
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function runStep(row: RunsState['row'], ctx: PlanContext): Step {
  const gl = glOf(row, ctx);
  return {
    kind: 'sequence',
    stages: ['depth', 'encode'],
    master: row === 'U1.panorama' ? MASTER_PANORAMA : MASTER_4_3,
    hole: null,
    condition: { standIn: true, gl, ballastMb: 0, decoder: 'none' },
    threads: 2,
    wait: { kind: 'cooldown', scale: ctx.levers.defaultsScale },
    decode: 'none',
    // A survival row holds its own condition throughout; the panorama returns to full, as the app is specified to when the sequence holding the encode mode ends.
    after: { gl: row === 'U1.panorama' && gl !== 'full' ? 'full' : null, openDecoder: false },
  };
}

const runKey = (run: number): string => `run-${run}`;

/** The 1-based run `key` names, or null for a key this program did not make. */
function runOf(key: string): number | null {
  const match = /^run-([1-9]\d*)$/.exec(key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export const runsProgram: Program<RunsState> = {
  next(state, ctx): PlannedStep | null {
    if (state.end !== null || state.survived >= state.of) return null;
    return { key: runKey(state.survived + 1), step: runStep(state.row, ctx) };
  },

  fold(state, planned, outcome): RunsState {
    const run = runOf(planned.key);
    if (run === null) return state;
    if (outcome.kind === 'died-after-terminate') {
      // The death followed this run's termination: the run that counted as survived becomes the row's first non-survival.
      if (state.end !== null || run !== state.survived) return state;
      return { ...state, survived: run - 1, end: { score: 'died-after-terminate', phase: null, run } };
    }
    if (state.end !== null || run !== state.survived + 1) return state;
    switch (outcome.kind) {
      case 'ran': {
        const contextLost = state.contextLost || outcome.reading.condition.contextLostAtMs !== null;
        if (outcome.score.kind === 'survived') return { ...state, survived: run, contextLost };
        return { ...state, contextLost, end: { score: outcome.score.kind, phase: outcome.score.phase, run } };
      }
      case 'killed':
        return { ...state, end: { score: 'killed', phase: outcome.phase, run } };
      case 'held':
      case 'throw':
        // A ballast outcome cannot come from a sequence step.
        return state;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },

  verdict(state): RowVerdict {
    return { kind: 'runs', survived: state.survived, of: state.of, end: state.end === null ? null : { score: state.end.score, phase: state.end.phase } };
  },
};
