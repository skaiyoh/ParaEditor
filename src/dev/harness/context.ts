// What a memory harness row program reads beyond its own row: the levers as
// the plan holds them, the encode mode the survival rows select, and the
// `PlanContext` that carries both with the cross-row results earlier rows
// set. The plan (plan.ts) builds the context from its state; a program reads
// it and never the plan.

import { z } from '../../core/zod.ts';
import { ROW_IDS, rowIdSchema, type PlanKind } from './catalog.ts';
import type { RowState, RunsState } from './states.ts';
import type { GlMode, MiganInput } from './steps.ts';

// ---------------------------------------------------------------------------
// the levers

/** The levers as the plan holds them. */
export const leversSchema = z
  .strictObject({
    rows: z.array(rowIdSchema).min(1).max(ROW_IDS.length).readonly().nullable(),
    runs: z.int().min(1),
    chunkMb: z.int().min(1),
    untouchedMb: z.int().min(1),
    ceilingMb: z.int().min(1),
    startMb: z.int().min(0),
    gaps: z.array(z.number().min(0)).min(1).max(16).readonly(),
    cycles: z.int().min(1),
    defaultsScale: z.number().positive(),
    throwAtMb: z.int().min(1).nullable(),
    timeoutS: z.number().positive(),
  })
  .readonly();
export type Levers = z.infer<typeof leversSchema>;

// ---------------------------------------------------------------------------
// the encode mode

/** The GL mode encoder-bearing rows run under after the survival rows, or none when the encoder survived under no mode. */
export type EncodeMode = { readonly kind: 'selected'; readonly gl: GlMode } | { readonly kind: 'none-survived' };

/** Whether `row`'s state is a run-counting row that ran all its runs, and for a GL row lost no context. */
function survivedAll(rows: readonly RowState[], row: RunsState['row'], gl: boolean): boolean {
  return rows.some((s) => s.family === 'runs' && s.row === row && s.end === null && s.survived === s.of && !(gl && s.contextLost));
}

/**
 * The full plan: `full` when the full-GL survival row has every run with no
 * context loss, else `low` when the low row has, else `none` when the no-GL
 * row has every run, else none survived. Short run, which has no low row:
 * `full` on the same rule, else `low`, whose ladder steps then measure low.
 */
export function encodeMode(kind: PlanKind, rows: readonly RowState[]): EncodeMode {
  if (survivedAll(rows, 'U1.survival.full', true)) return { kind: 'selected', gl: 'full' };
  if (kind === 'short') return { kind: 'selected', gl: 'low' };
  if (survivedAll(rows, 'U1.survival.low', true)) return { kind: 'selected', gl: 'low' };
  if (survivedAll(rows, 'U1.survival.none', false)) return { kind: 'selected', gl: 'none' };
  return { kind: 'none-survived' };
}

// ---------------------------------------------------------------------------
// the plan context

/** What a program reads beyond its own row: the load, and the cross-row results earlier rows set. */
export type PlanContext = {
  readonly load: number;
  readonly encode: EncodeMode;
  /** The headroom ladder's ceiling: the first kill-point row's last held step less one chunk, floored to a step, never above the ascent cap. */
  readonly ceilingMb: number;
  readonly ascentCapMb: number | null;
  readonly probe: MiganInput | null;
  readonly levers: Levers;
};
