// The memory harness's steps: what one step of a row runs (an untouched
// allocation, a ballast step, or a sequence of stages under a condition),
// what the shared rules read per step kind, the score a step that returned
// reports, and why a step is voided. A row program says which steps its row
// takes; this module says what a step is.

import type { AnalysisOp } from '../../core/derive.ts';
import { isModelId, type ModelId } from '../../core/ids.ts';
import { z } from '../../core/zod.ts';
import { HOLE_SHAPES } from './holes.ts';
import { COOLDOWN_MS, HIDDEN_GRACE_MS } from './lines.ts';

// ---------------------------------------------------------------------------
// steps

export const GL_MODES = ['full', 'low', 'none'] as const;
/** The GL texture ballast a step runs beside: the full or low texture set, or no GL context. */
export type GlMode = (typeof GL_MODES)[number];
export const glModeSchema = z.enum(GL_MODES);

/** A phase name: `wait`, a sequence step's `setup`, `run:<stage>`, and `after`, the untouched step's `alloc:<mb>` and `hold:<mb>`, a ballast step's `fill:<mb>` and `hold:<mb>`, or `unknown` when the marker was lost. */
export const phaseSchema = z.string().min(1).max(32);

const sizeSchema = z.strictObject({ width: z.int().min(1), height: z.int().min(1) }).readonly();

/** The MI-GAN input the probe chooses: a master size and a hole shape (holes.ts). */
export const miganInputSchema = z.strictObject({ size: sizeSchema, hole: z.enum(HOLE_SHAPES) }).readonly();
export type MiganInput = z.infer<typeof miganInputSchema>;

/** What a step runs beside: the 100 MB stand-in, a GL condition, a filled ballast, and the resident decoder. */
export const conditionSchema = z
  .strictObject({ standIn: z.boolean(), gl: glModeSchema, ballastMb: z.int().min(0), decoder: z.enum(['none', 'resident']) })
  .readonly();
export type Condition = z.infer<typeof conditionSchema>;

/** The sequences a step runs: the import, and each stage alone. */
export const stagesSchema = z.union([
  z.tuple([z.literal('depth'), z.literal('encode')]).readonly(),
  z.tuple([z.literal('depth')]).readonly(),
  z.tuple([z.literal('encode')]).readonly(),
  z.tuple([z.literal('inpaint')]).readonly(),
]);
export type Stages = z.infer<typeof stagesSchema>;

/**
 * How long a sequence step waits from the latest heavy termination before its
 * setup: `cooldown`, the app's specified default for the largest stage the
 * terminated worker ran, times `scale` (the defaultsScale lever); `gap`, the
 * gap a U2 row measures, in ms. A cooldown depends on the previous worker's
 * run, which a program cannot know, so a program names the rule, not the
 * number.
 */
export const waitSchema = z.union([
  z.strictObject({ kind: z.literal('cooldown'), scale: z.number().positive() }).readonly(),
  z.strictObject({ kind: z.literal('gap'), ms: z.number().min(0) }).readonly(),
]);
export type Wait = z.infer<typeof waitSchema>;

/**
 * One step: `untouched` allocates `mb` without writing it; `ballast` (a
 * kill-point step) releases everything but the filled ballast, keeps up to
 * `mb` of the ballast it already holds, grows it to `mb` by its missing
 * chunks, and holds it; `sequence` runs `stages` on the `master` under
 * `condition`, after its `wait`, and then does in its `after` phase what the
 * app is specified to do when that sequence ends.
 */
export const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('untouched'), mb: z.int().min(1) }).readonly(),
  z.strictObject({ kind: z.literal('ballast'), mb: z.int().min(1), release: z.literal('all') }).readonly(),
  z
    .strictObject({
      kind: z.literal('sequence'),
      stages: stagesSchema,
      master: sizeSchema,
      hole: z.enum(HOLE_SHAPES).nullable(),
      condition: conditionSchema,
      threads: z.union([z.literal(1), z.literal(2)]),
      wait: waitSchema,
      decode: z.enum(['none', 'during-infer-and-after']),
      after: z.strictObject({ gl: glModeSchema.nullable(), openDecoder: z.boolean() }).readonly(),
    })
    .readonly(),
]);
export type Step = z.infer<typeof stepSchema>;

/** A step and the key that names it within its row, such as `run-3`. */
export type PlannedStep = { readonly key: string; readonly step: Step };

export const stepKeySchema = z.string().min(1).max(64);

// What differs by step kind: one exhaustive switch each, so a new kind adds its case here and the rules that read them stay as they are.

/** How long a completed step may have been hidden and still count (scoreCompleted). */
export function hiddenGraceMsFor(step: Step): number {
  switch (step.kind) {
    case 'untouched':
    case 'ballast':
    case 'sequence':
      return HIDDEN_GRACE_MS;
  }
}

/** The least wait before the first step after a load that was not fresh, when `step` is the dead one: its largest stage's cooldown default, scaled by `scale`, or 0 for a step with no stage. */
export function resumeWaitMsFor(step: Step, scale: number): number {
  switch (step.kind) {
    case 'untouched':
    case 'ballast':
      return 0;
    case 'sequence':
      return Math.max(...step.stages.map((stage) => COOLDOWN_MS[stage])) * scale;
  }
}

/** What a step's fifth void ends (voidStep): its whole row, `no-reading`, or the step alone. */
export function voidCapScopeFor(step: Step): 'row' | 'step' {
  switch (step.kind) {
    case 'untouched':
    case 'ballast':
    case 'sequence':
      return 'row';
  }
}

// ---------------------------------------------------------------------------
// scores

const ANALYSIS_OPS = ['depth', 'encode', 'decode', 'inpaint'] as const satisfies readonly AnalysisOp[];
const opSchema = z.enum(ANALYSIS_OPS);
const modelIdSchema = z.custom<ModelId>((value) => typeof value === 'string' && isModelId(value), {
  message: "expected '<model name>@<64 lowercase hex digits>'",
});

/** analysis/protocol.ts's AnalysisError, parsed. */
export const analysisErrorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('download'), model: modelIdSchema, status: z.union([z.int(), z.literal('offline'), z.literal('stalled')]) }).readonly(),
  z.strictObject({ kind: z.literal('integrity'), model: modelIdSchema }).readonly(),
  z.strictObject({ kind: z.literal('timeout'), op: opSchema, visibleMs: z.number() }).readonly(),
  z.strictObject({ kind: z.literal('worker'), op: opSchema, message: z.string() }).readonly(),
  z.strictObject({ kind: z.literal('quota') }).readonly(),
  z.strictObject({ kind: z.literal('cancelled') }).readonly(),
]);

/** What a run that returned reports; a death never returns, so it is scored at the next load. */
export const scoreSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('survived') }).readonly(),
  z.strictObject({ kind: z.literal('failed'), phase: phaseSchema, error: analysisErrorSchema }).readonly(),
  z.strictObject({ kind: z.literal('timeout'), phase: phaseSchema }).readonly(),
]);
export type Score = z.infer<typeof scoreSchema>;

export const VOID_REASONS = ['hidden', 'left', 'background', 'died-idle'] as const;
/** Why a step is voided and rerun: hidden past the grace, a reload or navigation, reclaimed while hidden, or a death with no worker draining. */
export type VoidReason = (typeof VOID_REASONS)[number];
export const voidReasonSchema = z.enum(VOID_REASONS);
