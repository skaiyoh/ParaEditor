// The rows the memory harness posts to the results sink: one schema per
// event, inside one envelope. Every row is built as a `HarnessRow` (plan.ts's
// `stampRows`) and the readers parse each line with `parseHarnessRow`, so both
// sides hold the same contract. A row's `rowId` is `<run>:<seq>`, the key
// readers dedupe by, since a row can reach the sink twice.

import { isBuildId, isModelId, isTabId, type BuildId, type ModelId, type TabId } from '../../core/ids.ts';
import { err, ok, type Result } from '../../core/result.ts';
import { describeIssues } from '../../core/schema.ts';
import { z } from '../../core/zod.ts';
import { LIVENESS_LATE_MS } from './lines.ts';
import { memoryPlanKindSchema, rowIdSchema } from './catalog.ts';
import { leversSchema } from './context.ts';
import { runIdSchema } from './plan.ts';
import { rowVerdictSchema } from './states.ts';
import { GL_MODES, phaseSchema, scoreSchema, stepKeySchema, stepSchema, voidReasonSchema } from './steps.ts';

const countSchema = z.int().min(0);
const msSchema = z.number().min(0);
const sizeSchema = z.strictObject({ width: z.int().min(1), height: z.int().min(1) }).readonly();
const tabIdSchema = z.custom<TabId>((value) => typeof value === 'string' && isTabId(value), { message: 'expected a lowercase UUID v4' });
const modelIdSchema = z.custom<ModelId>((value) => typeof value === 'string' && isModelId(value), {
  message: "expected '<model name>@<64 lowercase hex digits>'",
});
const buildIdSchema = z.custom<BuildId>((value) => typeof value === 'string' && isBuildId(value), { message: "expected a build id, '<commit>-<yyyymmdd>'" });

// ---------------------------------------------------------------------------
// what a step reports

/** One ballast chunk's page sum when it was filled and after the latest run, null before any run. */
export const checksumPairSchema = z.strictObject({ chunk: countSchema, fill: z.int(), after: z.int().nullable() }).readonly();
export type ChecksumPair = z.infer<typeof checksumPairSchema>;

/** One run of a sequence step, as the runner measured it. */
export const sequenceReadingSchema = z
  .strictObject({
    /** Per stage, in stage order: `ms` from its `stage.end`, and the worker's high-water mark. */
    stages: z
      .array(z.strictObject({ op: z.enum(['depth', 'encode', 'inpaint']), ms: msSchema, wasmHighWaterBytes: countSchema.nullable() }).readonly())
      .max(2)
      .readonly(),
    /** From the worker's spawn to its termination; null when it was never terminated. */
    wallMs: msSchema.nullable(),
    /** From the latest heavy termination to this spawn; null when none came before it in this load. */
    gapMs: msSchema.nullable(),
    setupMs: msSchema,
    /** The shape of each product, as a check that the stage made one of the right shape. */
    product: z
      .strictObject({
        map: z.strictObject({ size: sizeSchema, min: z.number(), max: z.number() }).readonly().nullable(),
        embeddings: z.strictObject({ dims: z.array(z.array(z.int().min(1)).readonly()).readonly() }).readonly().nullable(),
        plate: sizeSchema.nullable(),
      })
      .readonly(),
    condition: z
      .strictObject({
        gl: z.enum(GL_MODES),
        textureBytes: countSchema,
        /** The GL ballast's build time and whether every texture's spot-checked texel matched; null with no GL. */
        glBuild: z.strictObject({ ms: msSchema, spotCheck: z.boolean() }).readonly().nullable(),
        framesDrawn: countSchema,
        /** When the GL context was lost during the run, on the page's clock; null when it was not. */
        contextLostAtMs: z.number().nullable(),
        standIn: z.array(checksumPairSchema).readonly(),
        ballast: z.array(checksumPairSchema).readonly(),
        /** Whether every chunk's sum after the run equals its sum when filled. */
        checksumsMatch: z.boolean(),
      })
      .readonly(),
    hiddenMs: msSchema,
    longestHiddenMs: msSchema,
    load: z.int().min(1),
  })
  .readonly();
export type SequenceReading = z.infer<typeof sequenceReadingSchema>;

/**
 * How a step ended: `held` and `throw` for an untouched or ballast step,
 * `ran` for a sequence that returned; `killed` and `died-after-terminate` are
 * scored at the next load; `void` reruns the step and `blocked` (a setup that
 * could not fetch what it needs) retries it, neither of them a score;
 * `gl-unavailable` (a setup that could not make its GL context or a texture,
 * after its retries) ends the row, flagged.
 */
export const stepOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('held'), mb: countSchema, chunks: countSchema, checksums: z.array(checksumPairSchema).readonly(), fillMs: msSchema }).readonly(),
  z.strictObject({ kind: z.literal('throw'), atMb: countSchema, message: z.string() }).readonly(),
  z.strictObject({ kind: z.literal('ran'), score: scoreSchema, reading: sequenceReadingSchema }).readonly(),
  z
    .strictObject({ kind: z.literal('killed'), phase: phaseSchema, markerAgeMs: z.number().nullable(), aliveAgeMs: z.number().nullable(), hiddenMs: msSchema })
    .readonly(),
  z.strictObject({ kind: z.literal('died-after-terminate'), sinceTerminateMs: z.number().nullable(), aliveAgeMs: z.number().nullable() }).readonly(),
  z.strictObject({ kind: z.literal('void'), reason: voidReasonSchema }).readonly(),
  z.strictObject({ kind: z.literal('blocked'), reason: z.string() }).readonly(),
  z.strictObject({ kind: z.literal('gl-unavailable'), reason: z.string() }).readonly(),
]);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

// ---------------------------------------------------------------------------
// the load row's parts

/** The screen wake lock: granted, refused with the error's name, absent from the browser, or released by the system. */
export const wakeLockStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('held') }).readonly(),
  z.strictObject({ kind: z.literal('refused'), name: z.string() }).readonly(),
  z.strictObject({ kind: z.literal('unsupported') }).readonly(),
  z.strictObject({ kind: z.literal('released') }).readonly(),
]);
export type WakeLockState = z.infer<typeof wakeLockStateSchema>;

/** checklist-environment.ts's EnvironmentRead, parsed. */
export const environmentReadSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('read'),
      snapshot: z
        .strictObject({
          userAgent: z.string(),
          deviceClass: z.enum(['phone', 'desktop']),
          crossOriginIsolated: z.boolean(),
          hardwareConcurrency: z.number(),
          standalone: z.boolean(),
          storage: z.strictObject({ quota: z.number().nullable(), persisted: z.boolean() }).readonly(),
          build: buildIdSchema,
        })
        .readonly(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.string() }).readonly(),
]);

/** The runner lock at a load that applied its verdict: held, after waiting `waitedMs` for it, or not taken because Web Locks are absent. */
export const runnerLockStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('held'), waitedMs: msSchema }).readonly(),
  z.strictObject({ kind: z.literal('absent') }).readonly(),
]);
export type RunnerLockState = z.infer<typeof runnerLockStateSchema>;

/**
 * One reading of a dead page's tab lock from `navigator.locks.query()`:
 * whether a lock of its name is held and whether a request for it is
 * pending (both false: free); `absent` without Web Locks; `failed` when the
 * query threw or did not answer in time.
 */
export const lockReadingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read'), held: z.boolean(), pending: z.boolean() }).readonly(),
  z.strictObject({ kind: z.literal('absent') }).readonly(),
  z.strictObject({ kind: z.literal('failed'), reason: z.string() }).readonly(),
]);
export type LockReading = z.infer<typeof lockReadingSchema>;

export const LOAD_VERDICTS = ['fresh', 'stale', 'left', 'background', 'hidden', 'died-idle', 'killed', 'died-after-terminate', 'after-completion', 'marker-lost'] as const;
/** What a load found (load.ts's LoadVerdict), by name; a void is named by its reason. */
export type LoadVerdictName = (typeof LOAD_VERDICTS)[number];

/** How the dead process's step was scored, as a `step-lost` row names it. */
export const LOST_VERDICTS = ['killed', 'background', 'left', 'hidden', 'died-after-terminate', 'died-idle'] as const;
export type LostVerdict = (typeof LOST_VERDICTS)[number];

// ---------------------------------------------------------------------------
// the events

export const harnessEventSchema = z.discriminatedUnion('type', [
  // The plan's levers, keyed by its plan kind: a memory plan's are the memory levers.
  z.discriminatedUnion('planKind', [
    z
      .strictObject({
        type: z.literal('plan'),
        planKind: memoryPlanKindSchema,
        rows: z.array(rowIdSchema).readonly(),
        levers: leversSchema,
        levered: z.boolean(),
        ascentCapMb: z.int().min(1).nullable(),
      })
      .readonly(),
  ]),
  z
    .strictObject({
      type: z.literal('load'),
      tab: tabIdSchema,
      environment: environmentReadSchema,
      navigatorStandalone: z.boolean().nullable(),
      navigation: z.string(),
      lockHash: z.string(),
      models: z.array(modelIdSchema).readonly(),
      /** The wake lock's latest answer when the row was made, the load's own request given a moment to answer; null when none had answered. */
      wakeLock: wakeLockStateSchema.nullable(),
      webLocks: z.boolean(),
      runnerLock: runnerLockStateSchema,
      verdict: z.enum(LOAD_VERDICTS),
      outboxDropped: countSchema,
    })
    .readonly(),
  z.strictObject({ type: z.literal('step-start'), row: rowIdSchema, stepKey: stepKeySchema, attempt: z.int().min(1), step: stepSchema }).readonly(),
  z.strictObject({ type: z.literal('step-end'), row: rowIdSchema, stepKey: stepKeySchema, outcome: stepOutcomeSchema }).readonly(),
  z
    .strictObject({
      type: z.literal('step-lost'),
      row: rowIdSchema,
      stepKey: stepKeySchema,
      attempt: z.int().min(1),
      verdict: z.enum(LOST_VERDICTS),
      phase: phaseSchema,
      markerAgeMs: z.number().nullable(),
      aliveAgeMs: z.number().nullable(),
      hiddenMs: msSchema,
      /** The step whose worker termination a death in a wait followed, which the death was folded into. */
      attributedTo: z.strictObject({ row: rowIdSchema, stepKey: stepKeySchema, sinceTerminateMs: z.number().nullable() }).readonly().nullable(),
      /** The step's state had been saved when the process died, so nothing was folded. */
      afterCompletion: z.boolean(),
    })
    .readonly(),
  z
    .strictObject({
      type: z.literal('liveness'),
      /** The tab id of the page whose death this load found. */
      deadTab: tabIdSchema,
      /** The plan's `deaths` after this one: the deaths the liveness report covers so far in the run, this one included, from 1. */
      killIndex: z.int().min(1),
      /** Whether the dead page's app-shaped marker was still stored at this load, and what was stored (null when nothing was). */
      appMarker: z.strictObject({ survived: z.boolean(), value: z.unknown() }).readonly(),
      lockAtLoad: lockReadingSchema,
    })
    .readonly(),
  z
    .strictObject({
      type: z.literal('liveness-late'),
      deadTab: tabIdSchema,
      afterMs: z.union([z.literal(LIVENESS_LATE_MS[0]), z.literal(LIVENESS_LATE_MS[1])]),
      lock: lockReadingSchema,
    })
    .readonly(),
  z.strictObject({ type: z.literal('wake-lock'), state: wakeLockStateSchema }).readonly(),
  z.strictObject({ type: z.literal('row-end'), row: rowIdSchema, verdict: rowVerdictSchema, amends: z.boolean() }).readonly(),
  z.strictObject({ type: z.enum(['done', 'stopped']), loads: z.int().min(1), kills: countSchema, voids: countSchema }).readonly(),
]);
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

export const harnessRowSchema = z
  .strictObject({
    kind: z.literal('harness'),
    v: z.literal(1),
    run: runIdSchema,
    /** Per run, from 0, persisted with the plan. */
    seq: countSchema,
    rowId: z.string(),
    /** The device's wall clock, ISO. */
    at: z.iso.datetime(),
    /** The page load that posted it. */
    load: z.int().min(1),
    event: harnessEventSchema,
  })
  .readonly()
  .refine((row) => row.rowId === `${row.run}:${row.seq}`, { message: 'expected `<run>:<seq>`', path: ['rowId'] });
export type HarnessRow = z.infer<typeof harnessRowSchema>;

/** Parses one row as the sink stored it (a log line's `row`). */
export function parseHarnessRow(value: unknown): Result<HarnessRow, string> {
  const parsed = harnessRowSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(describeIssues(parsed.error.issues));
}
