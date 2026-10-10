// The memory harness's plan: the state the page persists in localStorage
// between steps and across page loads, the context it builds for a row
// program (context.ts), and the plan's lifecycle, which asks each row's
// program (registry.ts) for its next step and folds each outcome back into
// it.
//
// The plan holds counts, positions, and outcomes, and of the readings only
// each MI-GAN probe cell's high-water mark (states.ts): every other reading
// travels in the posted rows (rows.ts), so the plan stays small enough never
// to compete with the outbox for storage. Every function here is pure: it
// takes a plan and returns a new one with the rows it wants posted, stamped
// with the run's sequence numbers, so the engine persists one value and
// enqueues the rows.
//
// The shared layer owns what holds for every row: a voided step reruns with
// its void count raised, and the fifth void ends the row `no-reading`;
// blocked steps rerun uncounted; a GL the setup could not make ends the row
// `gl-unavailable`; a row that ends posts its `row-end`; a death folded into
// a row that has already ended amends its verdict with a new `row-end` and
// never moves the cursor back. A row program owns only its own ladder or
// count rules, over its own RowState variant.

import { isBuildId, isTabId, type BuildId, type TabId } from '../../core/ids.ts';
import { err, ok, type Result } from '../../core/result.ts';
import { describeIssues } from '../../core/schema.ts';
import { z } from '../../core/zod.ts';
import { memoryPlanKindSchema, PLAN_ROWS, ROW_IDS, rowIdSchema, type PlanKind, type RowId } from './catalog.ts';
import { encodeMode, leversSchema, type Levers, type PlanContext } from './context.ts';
import { VOID_CAP } from './lines.ts';
import { ladderTopMb } from './programs/killpoint.ts';
import { foldStep, missingPrograms, nextStep, rowVerdict, type Folded } from './registry.ts';
import type { HarnessEvent, HarnessRow, StepOutcome } from './rows.ts';
import { planRowSchema, type Halt, type PlanRow, type RowState, type RowVerdict } from './states.ts';
import { stepKeySchema, voidCapScopeFor, type PlannedStep, type Step } from './steps.ts';

// ---------------------------------------------------------------------------
// the plan

const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
/** `<UTC yyyymmddThhmmssZ>-<4 hex>`, minted at Start. */
export const runIdSchema = z.string().regex(RUN_ID);

const buildIdSchema = z.custom<BuildId>((value) => typeof value === 'string' && isBuildId(value), { message: "expected a build id, '<commit>-<yyyymmdd>'" });

const stepCountsShape = { row: rowIdSchema, stepKey: stepKeySchema, attempt: z.int().min(1), voids: z.int().min(0) };
const stepCountsSchema = z.strictObject(stepCountsShape).readonly();
/** A step's attempts so far and its voids. */
export type StepCounts = z.infer<typeof stepCountsSchema>;

const tabIdSchema = z.custom<TabId>((value) => typeof value === 'string' && isTabId(value), { message: 'expected a lowercase UUID v4' });
/** The step in flight's counts and the tab id of the page that began it, which a load reads when the step's marker was lost. */
const inFlightSchema = z.strictObject({ ...stepCountsShape, tab: tabIdSchema }).readonly();
export type InFlight = z.infer<typeof inFlightSchema>;

/** The persisted plan, keyed by its plan kind: a memory plan holds the memory levers. */
export const planStateSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({
        v: z.literal(1),
        run: runIdSchema,
        kind: memoryPlanKindSchema,
        build: buildIdSchema,
        levers: leversSchema,
        levered: z.boolean(),
        ascentCapMb: z.int().min(1).nullable(),
        rows: z.array(planRowSchema).min(1).max(ROW_IDS.length).readonly(),
        /** The index of the row being run; rows.length once every row has ended. */
        cursor: z.int().min(0),
        /** The step running now, from its start until its outcome is folded. */
        inFlight: inFlightSchema.nullable(),
        /**
         * The steps that may run again with counts of their own: each one voided or
         * blocked, or the step that was waiting when a died-after-terminate death
         * came, until it starts again. When the row's program ends a row, its
         * entries outlive the cursor's leaving it until the next `beginStep`
         * drops them, so a finished plan whose last row its program ended keeps
         * them; when the shared layer ends a row (`haltRow`), its entries go as
         * the cursor leaves it.
         */
        reruns: z.array(stepCountsSchema).readonly(),
        /** The next posted row's sequence number. */
        seq: z.int().min(0),
        loads: z.int().min(1),
        kills: z.int().min(0),
        voids: z.int().min(0),
        /** The deaths the liveness report covers that the load verdicts found: kills, deaths in a wait, lost markers, and pages reclaimed while hidden. */
        deaths: z.int().min(0),
        /** Start, by the wall clock, in ms. */
        startedAt: z.number(),
      })
      .readonly(),
  ])
  .refine((plan) => plan.cursor <= plan.rows.length, { message: 'the cursor is past the last row', path: ['cursor'] });
export type PlanState = z.infer<typeof planStateSchema>;

/**
 * The `build` a stored plan names, read before its shape, so a plan an
 * earlier build stored reads as another build's even when this build's
 * schema no longer parses it; null when the text is not JSON or names none.
 */
export function storedBuildOf(text: string | null): string | null {
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('build' in json)) return null;
  return typeof json.build === 'string' ? json.build : null;
}

/** Parses the stored plan; null when nothing is stored. */
export function parsePlan(text: string | null): Result<PlanState | null, string> {
  if (text === null) return ok(null);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return err(`the stored plan is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = planStateSchema.safeParse(json);
  return parsed.success ? ok(parsed.data) : err(`the stored plan does not parse: ${describeIssues(parsed.error.issues)}`);
}

/** The context a row program reads, built from `plan`. */
export function planContext(plan: PlanState): PlanContext {
  const states = plan.rows.map((r) => r.state);
  const { chunkMb, ceilingMb: ladderCeiling } = plan.levers;
  const killpoint = states.find((s) => s.family === 'killpoint' && s.row === 'U1.killpoint');
  const held = killpoint?.family === 'killpoint' ? (killpoint.end?.kind === 'ceiling' ? ladderCeiling : killpoint.heldMb) : ladderCeiling;
  const floored = Math.max(0, Math.floor((held - chunkMb) / chunkMb) * chunkMb);
  const probe = states.find((s) => s.family === 'probe');
  return {
    load: plan.loads,
    encode: encodeMode(plan.kind, states),
    ceilingMb: plan.ascentCapMb === null ? floored : Math.min(floored, plan.ascentCapMb),
    ascentCapMb: plan.ascentCapMb,
    probe: probe?.family === 'probe' ? probe.chosen : null,
    levers: plan.levers,
  };
}

// ---------------------------------------------------------------------------
// the plan's lifecycle

/** Whether `row` has no further step. */
function ended(row: PlanRow, ctx: PlanContext): boolean {
  return row.halt !== null || nextStep(row.state, ctx) === null;
}

/** A new plan and the rows it posts, or rows to post for the plan as it now is. */
export type Applied = { readonly plan: PlanState; readonly rows: readonly HarnessRow[] };

/** Stamps `events` with the run, the next sequence numbers, the time, and the load, and advances the plan's `seq`. */
export function stampRows(plan: PlanState, events: readonly HarnessEvent[], nowWall: number): Applied {
  const at = new Date(nowWall).toISOString();
  const rows = events.map((event, i): HarnessRow => {
    const seq = plan.seq + i;
    return { kind: 'harness', v: 1, run: plan.run, seq, rowId: `${plan.run}:${seq}`, at, load: plan.loads, event };
  });
  return { plan: { ...plan, seq: plan.seq + events.length }, rows };
}

/** `<UTC yyyymmddThhmmssZ>-<4 hex>` for a run started at `nowWall`. */
export function mintRunId(nowWall: number, random: Pick<Crypto, 'getRandomValues'>): string {
  const stamp = new Date(nowWall).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const bytes = random.getRandomValues(new Uint8Array(2));
  return `${stamp}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A row's state before its first step. */
export function initialState(row: RowId, levers: Levers): RowState {
  switch (row) {
    case 'U1.untouched':
      return { family: 'untouched', row, end: null };
    case 'U1.killpoint':
    case 'U1.killpoint.after': {
      // A ceiling below one chunk leaves the ladder no step: the row has ended at its ceiling before it starts.
      const topMb = ladderTopMb(levers);
      return { family: 'killpoint', row, topMb, heldMb: 0, end: topMb === 0 ? { kind: 'ceiling' } : null };
    }
    case 'U1.survival.full':
    case 'U1.survival.low':
    case 'U1.survival.none':
    case 'U1.panorama':
      return { family: 'runs', row, of: levers.runs, survived: 0, contextLost: false, end: null };
    case 'U1.headroom':
      return { family: 'headroom', row, gl: null, stepMb: null, runsAtStep: 0, direction: 'up', bestMb: null, failedMb: null, end: null };
    case 'U1.migan-probe':
      return { family: 'probe', row, cells: [], chosen: null, done: false };
    case 'U1.exemption':
      return { family: 'exemption', row, setupLoad: null, of: levers.runs, survived: 0, end: null };
    case 'U1.threads':
      return { family: 'threads', row, done: 0, end: null };
    case 'U2.encode':
    case 'U2.inpaint':
      return { family: 'gaps', row, gapIndex: 0, passed: 0, position: 0, redo: 0, end: null };
    case 'U3.depth':
      return { family: 'cycles', row, cycle: 0, end: null };
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

export type NewPlan = {
  readonly kind: PlanKind;
  readonly run: string;
  readonly build: BuildId;
  readonly levers: Levers;
  readonly levered: boolean;
  readonly ascentCapMb: number | null;
  readonly nowWall: number;
};

/** Why Start refused: the `rows` lever names rows outside the plan kind, or the plan holds rows with no program yet. */
export type PlanRefusal = { readonly kind: 'rows-outside-plan' | 'no-program'; readonly rows: readonly RowId[] };

/**
 * The plan Start or Short run begins, at load 1, with its `plan` row and then
 * the `opening` events (Start's `load` row), stamped in that order before any
 * `row-end`: the plan kind's rows, or the `rows` lever's subset of them in
 * plan order. A lever naming a row outside the plan kind, and a plan holding a
 * row whose program is not built, are refused, naming the rows.
 */
export function createPlan(input: NewPlan, opening: readonly HarnessEvent[] = []): Result<Applied, PlanRefusal> {
  const kindRows: readonly RowId[] = PLAN_ROWS[input.kind];
  const wanted = input.levers.rows;
  if (wanted !== null) {
    const outside = wanted.filter((row) => !kindRows.includes(row));
    if (outside.length > 0) return err({ kind: 'rows-outside-plan', rows: outside });
  }
  const rows = wanted === null ? kindRows : kindRows.filter((row) => wanted.includes(row));
  const missing = missingPrograms(rows);
  if (missing.length > 0) return err({ kind: 'no-program', rows: missing });
  const plan: PlanState = {
    v: 1,
    run: input.run,
    kind: input.kind,
    build: input.build,
    levers: input.levers,
    levered: input.levered,
    ascentCapMb: input.ascentCapMb,
    rows: rows.map((row) => ({ state: initialState(row, input.levers), halt: null })),
    cursor: 0,
    inFlight: null,
    reruns: [],
    seq: 0,
    loads: 1,
    kills: 0,
    voids: 0,
    deaths: 0,
    startedAt: input.nowWall,
  };
  const event: HarnessEvent = { type: 'plan', planKind: input.kind, rows, levers: input.levers, levered: input.levered, ascentCapMb: input.ascentCapMb };
  const stamped = stampRows(plan, [event, ...opening], input.nowWall);
  const advanced = advance(stamped.plan, input.nowWall);
  return ok({ plan: advanced.plan, rows: [...stamped.rows, ...advanced.rows] });
}

/** Moves the cursor past every row with no further step, posting each one's `row-end`. */
function advance(plan: PlanState, nowWall: number): Applied {
  const ctx = planContext(plan);
  const events: HarnessEvent[] = [];
  let cursor = plan.cursor;
  for (let row = plan.rows[cursor]; row !== undefined && ended(row, ctx); row = plan.rows[cursor]) {
    events.push({ type: 'row-end', row: row.state.row, verdict: rowVerdict(row), amends: false });
    cursor += 1;
  }
  return stampRows({ ...plan, cursor }, events, nowWall);
}

/** The step the plan runs next, or done when every row has ended. */
export function nextPlanStep(plan: PlanState): { readonly kind: 'step'; readonly row: RowId; readonly planned: PlannedStep } | { readonly kind: 'done' } {
  const row = plan.rows[plan.cursor];
  const planned = row === undefined || row.halt !== null ? null : nextStep(row.state, planContext(plan));
  return row === undefined || planned === null ? { kind: 'done' } : { kind: 'step', row: row.state.row, planned };
}

const sameStep = (a: StepCounts, b: { readonly row: RowId; readonly stepKey: string }): boolean => a.row === b.row && a.stepKey === b.stepKey;

/** `reruns` with `counts` in place of any earlier counts of the same step; an in-flight step's tab is not kept. */
export function withRerun(reruns: readonly StepCounts[], counts: StepCounts): readonly StepCounts[] {
  const { row, stepKey, attempt, voids } = counts;
  return [...reruns.filter((r) => !sameStep(r, counts)), { row, stepKey, attempt, voids }];
}

/**
 * Starts the next step in the page `tab`: `inFlight` with its attempt raised
 * (its counts carried from `reruns` when it is there, even with other steps
 * of its row run in between), and its `step-start` row. Null when done.
 */
export function beginStep(plan: PlanState, nowWall: number, tab: TabId): (Applied & { readonly planned: PlannedStep; readonly counts: InFlight }) | null {
  const next = nextPlanStep(plan);
  if (next.kind === 'done') return null;
  const { row, planned } = next;
  const step = { row, stepKey: planned.key };
  const carried = plan.reruns.find((r) => sameStep(r, step));
  const counts: InFlight = { ...step, attempt: (carried?.attempt ?? 0) + 1, voids: carried?.voids ?? 0, tab };
  // Another row's reruns are moot: the cursor has moved past that row.
  const reruns = plan.reruns.filter((r) => r.row === row && !sameStep(r, step));
  const stamped = stampRows({ ...plan, inFlight: counts, reruns }, [{ type: 'step-start', row, stepKey: planned.key, attempt: counts.attempt, step: planned.step }], nowWall);
  return { ...stamped, planned, counts };
}

/** The in-flight step as the plan's programs see it, computed in the load it started in. */
export function inFlightStep(plan: PlanState): PlannedStep | null {
  if (plan.inFlight === null) return null;
  const next = nextPlanStep(plan);
  return next.kind === 'step' && next.row === plan.inFlight.row && next.planned.key === plan.inFlight.stepKey ? next.planned : null;
}

/**
 * Counts a void of `step`, the step `counts` names: its rerun carries the
 * raised count, and the void that reaches the cap ends what
 * `voidCapScopeFor(step)` names, for every memory step the row, `no-reading`.
 */
export function voidStep(plan: PlanState, counts: StepCounts, step: Step, nowWall: number): Applied {
  const voids = counts.voids + 1;
  const base: PlanState = { ...plan, inFlight: null, voids: plan.voids + 1 };
  if (voids < VOID_CAP) return { plan: { ...base, reruns: withRerun(base.reruns, { ...counts, voids }) }, rows: [] };
  const scope = voidCapScopeFor(step);
  switch (scope) {
    case 'row':
      return haltRow(base, counts, 'no-reading', nowWall);
    case 'step':
      // No step kind is capped by the step yet, and ending one step alone needs an outcome its row's program folds.
      throw new Error(`no step-scoped void cap is built (a ${step.kind} step reached the cap)`);
  }
}

/** Ends `counts`' row by the shared layer's rule, with its reruns, and moves the cursor past it. */
function haltRow(plan: PlanState, counts: StepCounts, kind: Halt['kind'], nowWall: number): Applied {
  const rows = plan.rows.map((r) => (r.state.row === counts.row ? { ...r, halt: { kind, stepKey: counts.stepKey } } : r));
  return advance({ ...plan, rows, inFlight: null, reruns: plan.reruns.filter((r) => r.row !== counts.row) }, nowWall);
}

/**
 * Folds `outcome` of `planned` into the row `row`. A row before the cursor's
 * had ended, so a verdict the fold changes is posted again with
 * `amends: true` and the cursor stays; the cursor's row is advanced past when
 * the fold ends it, or when the amended row changes what it reads from the
 * plan so that it has no next step. A row the shared layer ended keeps its
 * verdict.
 */
export function foldInto(plan: PlanState, row: RowId, planned: PlannedStep, outcome: Folded, nowWall: number): Applied {
  const index = plan.rows.findIndex((r) => r.state.row === row);
  const target = plan.rows[index];
  if (target === undefined || target.halt !== null) return { plan, rows: [] };
  const before = rowVerdict(target);
  const folded: PlanRow = { ...target, state: foldStep(target.state, planned, outcome) };
  const rows = plan.rows.map((r, i) => (i === index ? folded : r));
  if (index >= plan.cursor) return advance({ ...plan, rows }, nowWall);
  const after = rowVerdict(folded);
  const events: HarnessEvent[] = sameVerdict(before, after) ? [] : [{ type: 'row-end', row, verdict: after, amends: true }];
  const amended = stampRows({ ...plan, rows }, events, nowWall);
  const moved = advance(amended.plan, nowWall);
  return { plan: moved.plan, rows: [...amended.rows, ...moved.rows] };
}

function sameVerdict(a: RowVerdict, b: RowVerdict): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Folds the in-flight step's outcome, as `scoreCompleted` scored it, and posts
 * its `step-end`: a void reruns the step (the fifth ends the row), a blocked
 * step reruns uncounted, an unavailable GL ends the row, and any other
 * outcome goes to the row's program.
 */
export function completeStep(plan: PlanState, outcome: StepOutcome, nowWall: number): Applied {
  const counts = plan.inFlight;
  const planned = inFlightStep(plan);
  if (counts === null || planned === null) return { plan, rows: [] };
  const end = stampRows(plan, [{ type: 'step-end', row: counts.row, stepKey: counts.stepKey, outcome }], nowWall);
  const rest = afterOutcome(end.plan, counts, planned, outcome, nowWall);
  return { plan: rest.plan, rows: [...end.rows, ...rest.rows] };
}

function afterOutcome(plan: PlanState, counts: StepCounts, planned: PlannedStep, outcome: StepOutcome, nowWall: number): Applied {
  switch (outcome.kind) {
    case 'void':
      return voidStep(plan, counts, planned.step, nowWall);
    case 'blocked':
      return { plan: { ...plan, inFlight: null, reruns: withRerun(plan.reruns, counts) }, rows: [] };
    case 'gl-unavailable':
      return haltRow(plan, counts, 'gl-unavailable', nowWall);
    default:
      return foldInto({ ...plan, inFlight: null }, counts.row, planned, outcome, nowWall);
  }
}