// The memory harness's row states and verdicts: every row family's state as
// the plan persists it, counts, positions, and outcomes, and the probe
// cells' high-water marks, each variant tagged by family and row; the plan
// row, which pairs a state with how the shared layer ended the row; and the
// row verdicts the `row-end` rows post, with the text the page shows for
// each. A row program owns the rules over its own state;
// this module owns the shapes.

import { z } from '../../core/zod.ts';
import type { Family } from './catalog.ts';
import { VOID_CAP } from './lines.ts';
import { parseBallastPhase } from './programs/killpoint.ts';
import { glModeSchema, miganInputSchema, phaseSchema, stepKeySchema } from './steps.ts';

// ---------------------------------------------------------------------------
// row states: counts, positions, outcomes, and the probe cells' high-water
// marks, each variant tagged by family and row

/** A non-survival that ended a run-counting row, at its 1-based run. */
const runEndScoreSchema = z.enum(['killed', 'failed', 'timeout', 'died-after-terminate']);
const runEndSchema = z.strictObject({ score: runEndScoreSchema, phase: phaseSchema.nullable(), run: z.int().min(1) }).readonly();
const mbSchema = z.int().min(0);

const untouchedStateSchema = z
  .strictObject({
    family: z.literal('untouched'),
    row: z.literal('U1.untouched'),
    end: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('held') }).readonly(),
        z.strictObject({ kind: z.literal('killed'), phase: phaseSchema }).readonly(),
        z.strictObject({ kind: z.literal('throw'), atMb: mbSchema }).readonly(),
      ])
      .nullable(),
  })
  .readonly();

/** How a kill-point ladder ended: a kill in a step, with the step's size and the kill's phase, a throw in a step, with the step's size, or its last step held. */
const killpointEndSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('killed'), atMb: mbSchema, phase: phaseSchema }).readonly(),
  z.strictObject({ kind: z.literal('throw'), atMb: mbSchema }).readonly(),
  z.strictObject({ kind: z.literal('ceiling') }).readonly(),
]);

const killpointStateSchema = z
  .strictObject({
    family: z.literal('killpoint'),
    row: z.enum(['U1.killpoint', 'U1.killpoint.after']),
    /** The ladder's last step, the ceilingMb lever floored to a whole chunk; holding it ends the row at the ceiling. */
    topMb: mbSchema,
    /** The last step held, 0 before the first. */
    heldMb: mbSchema,
    end: killpointEndSchema.nullable(),
  })
  .readonly();

const runsStateSchema = z
  .strictObject({
    family: z.literal('runs'),
    row: z.enum(['U1.survival.full', 'U1.survival.low', 'U1.survival.none', 'U1.panorama']),
    /** The runs the row asks for. */
    of: z.int().min(1),
    /** Runs that survived, before any non-survival. */
    survived: z.int().min(0),
    /** Whether any counted run lost its GL context. */
    contextLost: z.boolean(),
    end: runEndSchema.nullable(),
  })
  .readonly();

const headroomStateSchema = z
  .strictObject({
    family: z.literal('headroom'),
    row: z.literal('U1.headroom'),
    /** The GL mode the ladder runs under, fixed at its first step. */
    gl: glModeSchema.nullable(),
    stepMb: mbSchema.nullable(),
    /** Runs that survived at the current step. */
    runsAtStep: z.int().min(0),
    direction: z.enum(['up', 'down']),
    /** The largest step with every run surviving, and the smallest that failed. */
    bestMb: mbSchema.nullable(),
    failedMb: mbSchema.nullable(),
    end: z
      .strictObject({
        kind: z.enum(['failed', 'step-zero-failed', 'reached-ceiling', 'reached-cap', 'throw', 'not-run']),
        atMb: mbSchema.nullable(),
      })
      .readonly()
      .nullable(),
  })
  .readonly();

const probeStateSchema = z
  .strictObject({
    family: z.literal('probe'),
    row: z.literal('U1.migan-probe'),
    /** One entry per cell run so far, in the probe's order. */
    cells: z
      .array(
        z
          .strictObject({
            input: miganInputSchema,
            score: z.enum(['survived', 'killed', 'failed', 'timeout', 'died-after-terminate']),
            highWaterBytes: z.int().min(0).nullable(),
          })
          .readonly(),
      )
      .max(8)
      .readonly(),
    /** The input U1.exemption, U2.encode, and U2.inpaint run on, set when the probe ends. */
    chosen: miganInputSchema.nullable(),
    done: z.boolean(),
  })
  .readonly();

const exemptionStateSchema = z
  .strictObject({
    family: z.literal('exemption'),
    row: z.literal('U1.exemption'),
    /** The load whose setup step opened the decoder; a later load restarts the row at its setup. */
    setupLoad: z.int().min(1).nullable(),
    of: z.int().min(1),
    survived: z.int().min(0),
    end: runEndSchema.nullable(),
  })
  .readonly();

const threadsStateSchema = z
  .strictObject({
    family: z.literal('threads'),
    row: z.literal('U1.threads'),
    /** Runs done of the six the row is planned to run; no code holds that count yet, and no program runs the row. */
    done: z.int().min(0),
    end: runEndSchema.nullable(),
  })
  .readonly();

const gapsStateSchema = z
  .strictObject({
    family: z.literal('gaps'),
    row: z.enum(['U2.encode', 'U2.inpaint']),
    /** The gap being run, an index into the gaps lever. */
    gapIndex: z.int().min(0),
    /** Transitions that passed at the current gap. */
    passed: z.int().min(0),
    /** The step within the current pair or chain. */
    position: z.int().min(0),
    /** How many times the current pair or chain was voided and rerun. */
    redo: z.int().min(0),
    end: z
      .strictObject({ kind: z.enum(['gap-failed', 'all-passed', 'encoder-died-after-inpaint']), gapIndex: z.int().min(0) })
      .readonly()
      .nullable(),
  })
  .readonly();

const cyclesStateSchema = z
  .strictObject({
    family: z.literal('cycles'),
    row: z.literal('U3.depth'),
    /** Cycles done. */
    cycle: z.int().min(0),
    end: z
      .strictObject({ kind: z.enum(['killed', 'failed', 'timeout', 'died-after-terminate']), cycle: z.int().min(1) })
      .readonly()
      .nullable(),
  })
  .readonly();

export const rowStateSchema = z.discriminatedUnion('family', [
  untouchedStateSchema,
  killpointStateSchema,
  runsStateSchema,
  headroomStateSchema,
  probeStateSchema,
  exemptionStateSchema,
  threadsStateSchema,
  gapsStateSchema,
  cyclesStateSchema,
]);
export type RowState = z.infer<typeof rowStateSchema>;
export type StateOf<F extends Family> = Extract<RowState, { readonly family: F }>;
export type RunsState = StateOf<'runs'>;

/**
 * How the shared layer ended a row, over its program: `no-reading`, the
 * step's fifth void; `gl-unavailable`, a GL context or texture the step's
 * setup could not make after its retries.
 */
const haltSchema = z.strictObject({ kind: z.enum(['no-reading', 'gl-unavailable']), stepKey: stepKeySchema }).readonly();
export type Halt = z.infer<typeof haltSchema>;

/** A row as the plan holds it: its program's state, and how the shared layer ended it, if it did. */
export const planRowSchema = z.strictObject({ state: rowStateSchema, halt: haltSchema.nullable() }).readonly();
export type PlanRow = z.infer<typeof planRowSchema>;

// ---------------------------------------------------------------------------
// verdicts

/** A row's verdict: `no-reading` when the void cap ended it (missing data, never a failure), `gl-unavailable` when its GL could not be made, else its program's. */
export const rowVerdictSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no-reading'), stepKey: stepKeySchema }).readonly(),
  z.strictObject({ kind: z.literal('gl-unavailable'), stepKey: stepKeySchema }).readonly(),
  z
    .strictObject({
      kind: z.literal('untouched'),
      /** Null before the step ends; a kill's `atMb` is the size its phase names, null when the phase names none. */
      end: z
        .discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('survived') }).readonly(),
          z.strictObject({ kind: z.literal('killed'), atMb: mbSchema.nullable(), phase: phaseSchema }).readonly(),
          z.strictObject({ kind: z.literal('throw'), atMb: mbSchema }).readonly(),
        ])
        .nullable(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('runs'),
      survived: z.int().min(0),
      of: z.int().min(1),
      end: z.strictObject({ score: runEndScoreSchema, phase: phaseSchema.nullable() }).readonly().nullable(),
    })
    .readonly(),
  /** A kill-point row: its last held step, and how it ended, null before it ends. */
  z.strictObject({ kind: z.literal('killpoint'), heldMb: mbSchema, end: killpointEndSchema.nullable() }).readonly(),
]);
export type RowVerdict = z.infer<typeof rowVerdictSchema>;

/**
 * A verdict as the page shows it: `k of N`, `k of N, then <score>` with
 * ` in <phase>` when a phase is known, `not run`, `survived`, `killed at N MB`,
 * `killed in <phase>`, `throw at N MB`, `kill point N MB in <fill, hold, or
 * phase>`, `no kill up to N MB`, `held N MB so far`, `no reading (...)`, or
 * `GL unavailable (...)`.
 */
export function verdictText(verdict: RowVerdict): string {
  switch (verdict.kind) {
    case 'no-reading':
      return `no reading (${verdict.stepKey} voided ${VOID_CAP} times)`;
    case 'gl-unavailable':
      return `GL unavailable (at ${verdict.stepKey})`;
    case 'untouched': {
      const end = verdict.end;
      if (end === null) return 'not run';
      if (end.kind === 'survived') return 'survived';
      if (end.kind === 'throw') return `throw at ${end.atMb} MB`;
      return end.atMb === null ? `killed in ${end.phase}` : `killed at ${end.atMb} MB`;
    }
    case 'runs': {
      const count = `${verdict.survived} of ${verdict.of}`;
      if (verdict.end === null) return count;
      return `${count}, then ${verdict.end.score}${verdict.end.phase === null ? '' : ` in ${verdict.end.phase}`}`;
    }
    case 'killpoint': {
      const end = verdict.end;
      if (end === null) return verdict.heldMb === 0 ? 'not run' : `held ${verdict.heldMb} MB so far`;
      switch (end.kind) {
        case 'killed':
          return `kill point ${end.atMb} MB in ${parseBallastPhase(end.phase)?.kind ?? end.phase}`;
        case 'throw':
          return `throw at ${end.atMb} MB`;
        case 'ceiling':
          return `no kill up to ${verdict.heldMb} MB`;
        default: {
          const exhaustive: never = end;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}
