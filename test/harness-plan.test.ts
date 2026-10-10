// src/dev/harness/plan.ts, rows.ts, and programs/runs.ts: the plan Start
// makes, the encode mode for both plan kinds, the registry's missing
// programs, the run-counting program with its first non-survival at the
// first, a middle, and the last run and with every run surviving, a step's
// voids from one to the cap, a void's counts carried across another step of
// its row, a GL that could not be made, the posted row contract (every
// harness event parses through the one schema whose inferred `HarnessRow`
// type `stampRows` returns), and the serialized plan at the full plan's
// largest state under its budget.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisError } from '../src/analysis/protocol.ts';
import type { EnvironmentSnapshot } from '../src/app/events.ts';
import * as lines from '../src/dev/harness/lines.ts';
import { LEVER_DEFAULTS, PLAN_MAX_UNITS, VOID_CAP } from '../src/dev/harness/lines.ts';
import { PLAN_ROWS, ROW_IDS } from '../src/dev/harness/catalog.ts';
import { encodeMode } from '../src/dev/harness/context.ts';
import { completeStep, createPlan, mintRunId, initialState, nextPlanStep, parsePlan, planStateSchema, type PlanState } from '../src/dev/harness/plan.ts';
import { missingPrograms, rowVerdict } from '../src/dev/harness/registry.ts';
import { verdictText, type RowState, type RunsState } from '../src/dev/harness/states.ts';
import { analysisErrorSchema } from '../src/dev/harness/steps.ts';
import { runsProgram } from '../src/dev/harness/programs/runs.ts';
import { environmentReadSchema, harnessRowSchema, parseHarnessRow, type HarnessEvent, type HarnessRow } from '../src/dev/harness/rows.ts';
import { begin, BUILD, LEVERS, planOf, ran, reading, RUN, SURVIVED, T0, TAB } from './fixtures/harness.ts';
import type { z } from '../src/core/zod.ts';

/** Runs every step of the plan's current row with `outcomes` in turn, then whatever survives; returns the plan and every row posted. */
function runRow(plan: PlanState, outcomes: readonly (typeof SURVIVED)[]): { readonly plan: PlanState; readonly rows: readonly HarnessRow[] } {
  let current = plan;
  const rows: HarnessRow[] = [];
  const row = nextPlanStep(plan);
  for (let i = 0; nextPlanStep(current).kind === 'step'; i += 1) {
    const next = nextPlanStep(current);
    if (next.kind !== 'step' || row.kind !== 'step' || next.row !== row.row) break;
    const begun = begin(current);
    const done = completeStep(begun.plan, outcomes[i] ?? SURVIVED, T0);
    rows.push(...begun.rows, ...done.rows);
    current = done.plan;
  }
  return { plan: current, rows };
}

const runsState = (plan: PlanState, index = 0): RunsState => {
  const state = plan.rows[index]?.state;
  if (state?.family !== 'runs') throw new Error('not a runs row');
  return state;
};

const events = (rows: readonly HarnessRow[]): readonly HarnessEvent[] => rows.map((r) => r.event);

// ---------------------------------------------------------------------------
// the plan

test('the full plan holds the fourteen rows and Short run the four, in plan order', () => {
  assert.deepEqual([...PLAN_ROWS.full], [...ROW_IDS]);
  assert.equal(PLAN_ROWS.full.length, 14);
  assert.deepEqual(PLAN_ROWS.short, ['U1.killpoint', 'U1.survival.full', 'U1.killpoint.after', 'U1.headroom']);
});

test('Start makes a plan at load 1 with its plan row first, stamped with the run, its sequence number, the time, and the load', () => {
  const levers = { ...LEVERS, rows: ['U1.survival.full', 'U1.panorama'] as const };
  const made = createPlan({ kind: 'full', run: RUN, build: BUILD, levers, levered: true, ascentCapMb: 800, nowWall: T0 });
  assert.ok(made.ok);
  const { plan, rows } = made.value;
  assert.deepEqual(plan.rows.map((r) => r.state.row), ['U1.survival.full', 'U1.panorama']);
  assert.deepEqual([plan.cursor, plan.inFlight, plan.reruns, plan.loads, plan.kills, plan.voids, plan.seq, plan.startedAt], [0, null, [], 1, 0, 0, 1, T0]);
  assert.deepEqual(rows, [
    {
      kind: 'harness',
      v: 1,
      run: RUN,
      seq: 0,
      rowId: `${RUN}:0`,
      at: new Date(T0).toISOString(),
      load: 1,
      event: { type: 'plan', planKind: 'full', rows: ['U1.survival.full', 'U1.panorama'], levers, levered: true, ascentCapMb: 800 },
    },
  ]);
  assert.match(mintRunId(T0, { getRandomValues: <T extends ArrayBufferView | null>(a: T): T => a }), /^20261003T120000Z-0000$/);
});

test('Start refuses a plan holding a row whose program is not built, naming every such row', () => {
  for (const kind of ['full', 'short'] as const) {
    const made = createPlan({ kind, run: RUN, build: BUILD, levers: LEVERS, levered: false, ascentCapMb: null, nowWall: T0 });
    assert.deepEqual(made, { ok: false, error: { kind: 'no-program', rows: missingPrograms(PLAN_ROWS[kind]) } }, kind);
  }
});

test('the rows lever runs its subset in plan order, and a row outside the plan kind is refused by name', () => {
  const plan = planOf(['U1.panorama', 'U1.survival.low']);
  assert.deepEqual(plan.rows.map((r) => r.state.row), ['U1.survival.low', 'U1.panorama']);
  const refused = createPlan({ kind: 'short', run: RUN, build: BUILD, levers: { ...LEVERS, rows: ['U1.survival.low'] }, levered: true, ascentCapMb: null, nowWall: T0 });
  assert.deepEqual(refused, { ok: false, error: { kind: 'rows-outside-plan', rows: ['U1.survival.low'] } });
});

test('missingPrograms names every plan row whose family has no program yet', () => {
  assert.deepEqual(missingPrograms(['U1.survival.full', 'U1.survival.low', 'U1.survival.none', 'U1.panorama']), []);
  assert.deepEqual(missingPrograms(['U1.killpoint', 'U1.killpoint.after']), []);
  assert.deepEqual(missingPrograms(PLAN_ROWS.short), ['U1.headroom']);
  assert.equal(missingPrograms(ROW_IDS).length, 7);
});

// ---------------------------------------------------------------------------
// the encode mode

const survival = (row: RunsState['row'], survived: number, patch: Partial<RunsState> = {}): RowState => ({
  family: 'runs',
  row,
  of: 10,
  survived,
  contextLost: false,
  end: survived === 10 ? null : { score: 'killed', phase: 'run:encode', run: survived + 1 },
  ...patch,
});

test('encodeMode selects full, else low, else none, else none survived in the full plan', () => {
  const full = (n: number, lost = false): RowState => survival('U1.survival.full', n, { contextLost: lost });
  const low = (n: number, lost = false): RowState => survival('U1.survival.low', n, { contextLost: lost });
  const none = (n: number): RowState => survival('U1.survival.none', n);
  const cases: readonly [readonly RowState[], ReturnType<typeof encodeMode>][] = [
    [[full(10), low(10), none(10)], { kind: 'selected', gl: 'full' }],
    [[full(10, true), low(10), none(10)], { kind: 'selected', gl: 'low' }],
    [[full(9), low(10), none(10)], { kind: 'selected', gl: 'low' }],
    [[full(9), low(10, true), none(10)], { kind: 'selected', gl: 'none' }],
    [[full(0), low(3), none(10)], { kind: 'selected', gl: 'none' }],
    [[full(0), low(3), none(9)], { kind: 'none-survived' }],
    [[full(10), low(10), survival('U1.survival.none', 10, { contextLost: true })], { kind: 'selected', gl: 'full' }],
    [[], { kind: 'none-survived' }],
  ];
  for (const [rows, mode] of cases) assert.deepEqual(encodeMode('full', rows), mode, JSON.stringify(rows.map((r) => r.family === 'runs' && [r.row, r.survived, r.contextLost])));
  // The no-GL row has no GL context to lose: its context-loss flag does not bar `none`.
  assert.deepEqual(encodeMode('full', [full(0), survival('U1.survival.none', 10, { contextLost: true })]), { kind: 'selected', gl: 'none' });
  // A survival row still running has not survived all its runs.
  assert.deepEqual(encodeMode('full', [survival('U1.survival.full', 4, { end: null })]), { kind: 'none-survived' });
});

test('encodeMode in Short run selects full when its survival row has every run with no context loss, else low', () => {
  assert.deepEqual(encodeMode('short', [survival('U1.survival.full', 10)]), { kind: 'selected', gl: 'full' });
  assert.deepEqual(encodeMode('short', [survival('U1.survival.full', 10, { contextLost: true })]), { kind: 'selected', gl: 'low' });
  assert.deepEqual(encodeMode('short', [survival('U1.survival.full', 0)]), { kind: 'selected', gl: 'low' });
  assert.deepEqual(encodeMode('short', []), { kind: 'selected', gl: 'low' });
});

// ---------------------------------------------------------------------------
// the runs program

test('a survival row runs [depth, encode] on 2048 x 1536 under its own GL with the stand-in, waiting the cooldown default', () => {
  for (const [row, gl] of [['U1.survival.full', 'full'], ['U1.survival.low', 'low'], ['U1.survival.none', 'none']] as const) {
    const next = nextPlanStep(planOf([row]));
    assert.equal(next.kind, 'step');
    if (next.kind !== 'step') return;
    assert.deepEqual(next.planned, {
      key: 'run-1',
      step: {
        kind: 'sequence',
        stages: ['depth', 'encode'],
        master: { width: 2048, height: 1536 },
        hole: null,
        condition: { standIn: true, gl, ballastMb: 0, decoder: 'none' },
        threads: 2,
        wait: { kind: 'cooldown', scale: 1 },
        decode: 'none',
        after: { gl: null, openDecoder: false },
      },
    });
  }
});

test('the panorama runs on 2048 x 512 under the encode mode and returns the GL to full after each run when that mode is not full', () => {
  const step = (rowsBefore: readonly RunsState['row'][], survived: (row: string) => number) => {
    let plan = planOf([...rowsBefore, 'U1.panorama'], 2);
    plan = { ...plan, rows: plan.rows.map((r) => (r.state.family === 'runs' && r.state.row !== 'U1.panorama' ? { ...r, state: { ...r.state, survived: survived(r.state.row), end: survived(r.state.row) === 2 ? null : { score: 'killed' as const, phase: 'run:encode', run: 1 } } } : r)), cursor: rowsBefore.length };
    const next = nextPlanStep(plan);
    if (next.kind !== 'step' || next.planned.step.kind !== 'sequence') throw new Error('no sequence step');
    return next.planned.step;
  };
  const full = step(['U1.survival.full'], () => 2);
  assert.deepEqual([full.master, full.condition.gl, full.after.gl], [{ width: 2048, height: 512 }, 'full', null]);
  const low = step(['U1.survival.full', 'U1.survival.low'], (r) => (r === 'U1.survival.low' ? 2 : 0));
  assert.deepEqual([low.condition.gl, low.after.gl], ['low', 'full']);
  const none = step(['U1.survival.full', 'U1.survival.low', 'U1.survival.none'], () => 0);
  assert.deepEqual([none.condition.gl, none.after.gl], ['none', 'full']);
});

test('the runs program with every run surviving ends N of N and posts one row-end', () => {
  const { plan, rows } = runRow(planOf(['U1.survival.full'], 3), []);
  assert.deepEqual(runsState(plan), { family: 'runs', row: 'U1.survival.full', of: 3, survived: 3, contextLost: false, end: null });
  assert.equal(plan.cursor, 1);
  assert.deepEqual(events(rows).map((e) => e.type), ['step-start', 'step-end', 'step-start', 'step-end', 'step-start', 'step-end', 'row-end']);
  assert.deepEqual(events(rows).filter((e) => e.type === 'step-start').map((e) => e.type === 'step-start' && [e.stepKey, e.attempt]), [['run-1', 1], ['run-2', 1], ['run-3', 1]]);
  const end = events(rows).at(-1);
  assert.deepEqual(end, { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'runs', survived: 3, of: 3, end: null }, amends: false });
  if (end?.type === 'row-end') assert.equal(verdictText(end.verdict), '3 of 3');
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => 1 + i));
  assert.equal(plan.seq, 1 + rows.length);
  assert.deepEqual(nextPlanStep(plan), { kind: 'done' });
});

test('the runs program ends at its first non-survival at the first, a middle, and the last run', () => {
  const failed = ran({ kind: 'failed', phase: 'run:encode', error: { kind: 'worker', op: 'encode', message: 'memory access out of bounds' } });
  const cases = [
    { at: 1, outcome: failed, text: '0 of 3, then failed in run:encode' },
    { at: 2, outcome: ran({ kind: 'timeout', phase: 'run:depth' }), text: '1 of 3, then timeout in run:depth' },
    { at: 3, outcome: { kind: 'killed', phase: 'run:encode', markerAgeMs: 900, aliveAgeMs: 400, hiddenMs: 0 } as const, text: '2 of 3, then killed in run:encode' },
  ];
  for (const { at, outcome, text } of cases) {
    const outcomes = [...Array.from({ length: at - 1 }, () => SURVIVED), outcome];
    const { plan, rows } = runRow(planOf(['U1.survival.low', 'U1.survival.none'], 3), outcomes);
    assert.equal(runsState(plan).survived, at - 1, text);
    assert.equal(plan.cursor, 1, text);
    assert.equal(events(rows).filter((e) => e.type === 'step-start').length, at, `${text}: no run after the first non-survival`);
    const end = events(rows).at(-1);
    assert.ok(end?.type === 'row-end' && !end.amends, text);
    if (end?.type === 'row-end') assert.equal(verdictText(end.verdict), text);
    // The next row starts at its first run.
    const next = nextPlanStep(plan);
    assert.deepEqual(next.kind === 'step' && [next.row, next.planned.key], ['U1.survival.none', 'run-1'], text);
  }
});

test('the runs program records a counted run that lost its GL context', () => {
  const lost = { kind: 'ran', score: { kind: 'survived' }, reading: reading({ contextLostAtMs: 1234 }) } as const;
  const { plan } = runRow(planOf(['U1.survival.full'], 2), [lost]);
  assert.deepEqual([runsState(plan).survived, runsState(plan).contextLost], [2, true]);
  assert.deepEqual(encodeMode('short', [runsState(plan)]), { kind: 'selected', gl: 'low' });
});

// ---------------------------------------------------------------------------
// voids from completed steps

test('one step voided one to five times reruns with its void count raised, and the fifth void ends the row no-reading', () => {
  for (let voids = 1; voids <= 5; voids += 1) {
    let plan = planOf(['U1.survival.full', 'U1.survival.low'], 3);
    plan = completeStep(begin(plan).plan, SURVIVED, T0).plan;
    const posted: HarnessRow[] = [];
    for (let i = 0; i < voids; i += 1) {
      const begun = begin(plan);
      assert.deepEqual([begun.counts.stepKey, begun.counts.attempt, begun.counts.voids], ['run-2', i + 1, i], `void ${i + 1} of ${voids}`);
      const done = completeStep(begun.plan, { kind: 'void', reason: 'hidden' }, T0);
      posted.push(...done.rows);
      plan = done.plan;
    }
    assert.equal(plan.voids, voids);
    assert.equal(plan.kills, 0);
    assert.equal(plan.inFlight, null);
    if (voids < 5) {
      assert.deepEqual(plan.reruns, [{ row: 'U1.survival.full', stepKey: 'run-2', attempt: voids, voids }]);
      assert.equal(plan.cursor, 0);
      assert.equal(runsState(plan).survived, 1, 'a void is not folded into the row');
      assert.ok(!events(posted).some((e) => e.type === 'row-end'));
    } else {
      assert.deepEqual(plan.reruns, []);
      assert.equal(plan.cursor, 1);
      assert.deepEqual(plan.rows[0]?.halt, { kind: 'no-reading', stepKey: 'run-2' });
      assert.deepEqual(events(posted).at(-1), { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'no-reading', stepKey: 'run-2' }, amends: false });
      const next = nextPlanStep(plan);
      assert.deepEqual(next.kind === 'step' && [next.row, next.planned.key], ['U1.survival.low', 'run-1']);
    }
  }
});

test('a void of one step does not carry to the next step, and a blocked step reruns uncounted', () => {
  let plan = planOf(['U1.survival.full'], 3);
  plan = completeStep(begin(plan).plan, { kind: 'void', reason: 'left' }, T0).plan;
  plan = completeStep(begin(plan).plan, SURVIVED, T0).plan;
  assert.deepEqual(plan.reruns, []);
  const second = begin(plan);
  assert.deepEqual([second.counts.stepKey, second.counts.attempt, second.counts.voids], ['run-2', 1, 0]);
  const blocked = completeStep(second.plan, { kind: 'blocked', reason: 'the master did not arrive' }, T0);
  assert.deepEqual([blocked.plan.voids, blocked.plan.reruns], [1, [{ row: 'U1.survival.full', stepKey: 'run-2', attempt: 1, voids: 0 }]]);
  assert.deepEqual(events(blocked.rows), [{ type: 'step-end', row: 'U1.survival.full', stepKey: 'run-2', outcome: { kind: 'blocked', reason: 'the master did not arrive' } }]);
  assert.deepEqual(begin(blocked.plan).counts, { row: 'U1.survival.full', stepKey: 'run-2', attempt: 2, voids: 0, tab: TAB });
});

test("a voided step's counts carry across another step of its row run in between, so its fifth void still ends the row", () => {
  // A program that restarts its row after a load (a setup step first) runs other steps before the voided one reruns.
  const fresh = planOf(['U1.survival.full', 'U1.survival.low'], 3);
  const voided = { row: 'U1.survival.full', stepKey: 'run-2', attempt: 4, voids: 4 } as const;
  let plan: PlanState = { ...fresh, reruns: [voided] };
  const between = begin(plan);
  assert.deepEqual([between.counts, between.plan.reruns], [{ row: 'U1.survival.full', stepKey: 'run-1', attempt: 1, voids: 0, tab: TAB }, [voided]]);
  plan = completeStep(between.plan, SURVIVED, T0).plan;
  assert.deepEqual(plan.reruns, [voided]);
  const rerun = begin(plan);
  assert.deepEqual([rerun.counts, rerun.plan.reruns], [{ ...voided, attempt: 5, tab: TAB }, []]);
  const fifth = completeStep(rerun.plan, { kind: 'void', reason: 'background' }, T0);
  assert.deepEqual([fifth.plan.rows[0]?.halt, fifth.plan.cursor, fifth.plan.reruns], [{ kind: 'no-reading', stepKey: 'run-2' }, 1, []]);
  // Once the cursor has moved past a row, its reruns are dropped at the next step.
  const next = begin({ ...fifth.plan, reruns: [voided] });
  assert.deepEqual([next.counts.row, next.plan.reruns], ['U1.survival.low', []]);
});

test('a step whose GL could not be made ends its row gl-unavailable, uncounted, and the plan moves on', () => {
  let plan = planOf(['U1.survival.full', 'U1.survival.low'], 3);
  plan = completeStep(begin(plan).plan, SURVIVED, T0).plan;
  const outcome = { kind: 'gl-unavailable', reason: 'webglcontextcreationerror' } as const;
  const done = completeStep(begin(plan).plan, outcome, T0);
  assert.deepEqual([done.plan.cursor, done.plan.inFlight, done.plan.kills, done.plan.voids, done.plan.rows[0]?.halt], [1, null, 0, 0, { kind: 'gl-unavailable', stepKey: 'run-2' }]);
  assert.deepEqual(events(done.rows), [
    { type: 'step-end', row: 'U1.survival.full', stepKey: 'run-2', outcome },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'gl-unavailable', stepKey: 'run-2' }, amends: false },
  ]);
  assert.equal(runsState(done.plan).survived, 1, 'the program folds nothing');
  for (const row of done.rows) assert.ok(harnessRowSchema.safeParse(row).success, row.event.type);
  assert.equal(verdictText({ kind: 'gl-unavailable', stepKey: 'run-2' }), 'GL unavailable (at run-2)');
});

test('the runs program ignores an outcome for a run it is not on, and a death after any run but the last counted', () => {
  const state: RunsState = { family: 'runs', row: 'U1.survival.full', of: 10, survived: 4, contextLost: false, end: null };
  const step = begin(planOf(['U1.survival.full'])).planned.step;
  const killed = { kind: 'killed', phase: 'run:encode', markerAgeMs: 1, aliveAgeMs: 1, hiddenMs: 0 } as const;
  const died = { kind: 'died-after-terminate', sinceTerminateMs: 1, aliveAgeMs: 1 } as const;
  assert.deepEqual(runsProgram.fold(state, { key: 'run-4', step }, killed), state);
  assert.deepEqual(runsProgram.fold(state, { key: 'run-6', step }, killed), state);
  assert.deepEqual(runsProgram.fold(state, { key: 'run-3', step }, died), state);
  assert.deepEqual(runsProgram.fold(state, { key: 'run-5', step }, died), state);
  assert.deepEqual(runsProgram.fold(state, { key: 'run-5', step }, killed).end, { score: 'killed', phase: 'run:encode', run: 5 });
  assert.deepEqual(runsProgram.fold(state, { key: 'run-4', step }, died), { ...state, survived: 3, end: { score: 'died-after-terminate', phase: null, run: 4 } });
});

// ---------------------------------------------------------------------------
// the row contract

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** checklist-environment.ts's EnvironmentRead, which the test project cannot import, since that module reads a build constant. */
type EnvironmentRead = { readonly kind: 'read'; readonly snapshot: EnvironmentSnapshot } | { readonly kind: 'unavailable'; readonly reason: string };
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("the parsed AnalysisError and EnvironmentRead are the analysis service's and the checklist's", () => {
  const checks = [true satisfies Equal<z.infer<typeof analysisErrorSchema>, AnalysisError>, true satisfies Mutual<z.infer<typeof environmentReadSchema>, EnvironmentRead>];
  assert.deepEqual(checks, [true, true]);
});

test('every harness event parses through the one row schema the page builds rows against', () => {
  const plan = planOf(['U1.survival.full'], 2);
  const begun = begin(plan);
  const envelope = { kind: 'harness', v: 1, run: RUN, at: new Date(T0).toISOString(), load: 2 } as const;
  const eventsToPost: readonly HarnessEvent[] = [
    { type: 'plan', planKind: 'full', rows: ['U1.survival.full'], levers: { ...LEVER_DEFAULTS, rows: ['U1.survival.full'] }, levered: true, ascentCapMb: 800 },
    {
      type: 'load',
      tab: TAB,
      environment: {
        kind: 'read',
        snapshot: { userAgent: 'Mozilla/5.0 (iPhone)', deviceClass: 'phone', crossOriginIsolated: true, hardwareConcurrency: 4, standalone: true, storage: { quota: null, persisted: false }, build: BUILD },
      },
      navigatorStandalone: true,
      navigation: 'reload',
      lockHash: 'a'.repeat(64),
      models: [],
      wakeLock: { kind: 'refused', name: 'NotAllowedError' },
      webLocks: true,
      runnerLock: { kind: 'held', waitedMs: 120 },
      verdict: 'killed',
      outboxDropped: 3,
    },
    { type: 'step-start', row: 'U1.survival.full', stepKey: 'run-1', attempt: 1, step: begun.planned.step },
    { type: 'step-end', row: 'U1.survival.full', stepKey: 'run-1', outcome: SURVIVED },
    { type: 'step-end', row: 'U1.survival.full', stepKey: 'run-1', outcome: { kind: 'held', mb: 300, chunks: 3, checksums: [{ chunk: 0, fill: -5, after: null }], fillMs: 51 } },
    {
      type: 'step-lost',
      row: 'U1.survival.full',
      stepKey: 'run-2',
      attempt: 1,
      verdict: 'died-after-terminate',
      phase: 'wait',
      markerAgeMs: 9000,
      aliveAgeMs: 2100,
      hiddenMs: 0,
      attributedTo: { row: 'U1.survival.full', stepKey: 'run-1', sinceTerminateMs: 3000 },
      afterCompletion: false,
    },
    { type: 'liveness', deadTab: TAB, killIndex: 1, appMarker: { survived: true, value: { scene: 'x', hiddenAt: null } }, lockAtLoad: { kind: 'read', held: true, pending: false } },
    { type: 'liveness-late', deadTab: TAB, afterMs: 2_000, lock: { kind: 'read', held: false, pending: false } },
    { type: 'liveness-late', deadTab: TAB, afterMs: 10_000, lock: { kind: 'failed', reason: 'query() did not answer' } },
    { type: 'wake-lock', state: { kind: 'released' } },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'runs', survived: 0, of: 2, end: { score: 'died-after-terminate', phase: null } }, amends: true },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'no-reading', stepKey: 'run-2' }, amends: false },
    { type: 'step-end', row: 'U1.survival.full', stepKey: 'run-3', outcome: { kind: 'gl-unavailable', reason: 'OUT_OF_MEMORY' } },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'gl-unavailable', stepKey: 'run-3' }, amends: false },
    { type: 'done', loads: 3, kills: 1, voids: 2 },
    { type: 'stopped', loads: 1, kills: 0, voids: 0 },
  ];
  // Listing every event type here fails the type check when the schema gains one, and the list must match what is posted.
  const everyType = { plan: true, load: true, 'step-start': true, 'step-end': true, 'step-lost': true, liveness: true, 'liveness-late': true, 'wake-lock': true, 'row-end': true, done: true, stopped: true } satisfies Record<HarnessEvent['type'], true>;
  assert.deepEqual(new Set(eventsToPost.map((e) => e.type)), new Set(Object.keys(everyType)));
  for (const [seq, event] of eventsToPost.entries()) {
    const row = { ...envelope, seq, rowId: `${RUN}:${seq}`, event } satisfies HarnessRow;
    const parsed = parseHarnessRow(JSON.parse(JSON.stringify(row)));
    assert.ok(parsed.ok, `${event.type}: ${parsed.ok ? '' : parsed.error}`);
    assert.deepEqual(parsed.value, row, event.type);
  }
  // Every row the plan functions stamp parses too.
  for (const row of [...begun.rows, ...completeStep(begun.plan, SURVIVED, T0).rows]) assert.ok(harnessRowSchema.safeParse(row).success, row.event.type);
  const bad = parseHarnessRow({ ...envelope, seq: 4, rowId: `${RUN}:5`, event: { type: 'done', loads: 1, kills: 0, voids: 0, extra: 1 } });
  assert.deepEqual(bad.ok ? null : bad.error, 'event.extra: unknown key; rowId: expected `<run>:<seq>`');
});

// ---------------------------------------------------------------------------
// the plan's size

/** Every row of the full plan in the largest state its persisted shape can hold in a phone run. */
function largestStates(): readonly RowState[] {
  const end = { score: 'died-after-terminate', phase: 'run:inpaint', run: 10 } as const;
  return [
    { family: 'untouched', row: 'U1.untouched', end: { kind: 'killed', phase: 'alloc:1500' } },
    { family: 'killpoint', row: 'U1.killpoint', topMb: 4000, heldMb: 3900, end: { kind: 'killed', atMb: 4000, phase: 'hold:4000' } },
    { family: 'runs', row: 'U1.survival.full', of: 10, survived: 9, contextLost: true, end },
    { family: 'runs', row: 'U1.survival.low', of: 10, survived: 9, contextLost: true, end },
    { family: 'runs', row: 'U1.survival.none', of: 10, survived: 9, contextLost: true, end },
    { family: 'killpoint', row: 'U1.killpoint.after', topMb: 4000, heldMb: 3900, end: { kind: 'killed', atMb: 4000, phase: 'hold:4000' } },
    { family: 'headroom', row: 'U1.headroom', gl: 'none', stepMb: 3800, runsAtStep: 9, direction: 'down', bestMb: 3700, failedMb: 3800, end: { kind: 'step-zero-failed', atMb: 3900 } },
    {
      family: 'probe',
      row: 'U1.migan-probe',
      cells: Array.from({ length: 8 }, (_, i) => ({
        input: { size: { width: 2048, height: i % 2 === 0 ? 1536 : 2048 }, hole: i % 4 < 2 ? ('corners' as const) : ('full' as const) },
        score: 'died-after-terminate' as const,
        highWaterBytes: 903_151_616,
      })),
      chosen: { size: { width: 2048, height: 2048 }, hole: 'corners' },
      done: true,
    },
    { family: 'exemption', row: 'U1.exemption', setupLoad: 9999, of: 10, survived: 9, end },
    { family: 'runs', row: 'U1.panorama', of: 10, survived: 9, contextLost: true, end },
    { family: 'threads', row: 'U1.threads', done: 6, end },
    { family: 'gaps', row: 'U2.encode', gapIndex: 4, passed: 9, position: 21, redo: 1, end: { kind: 'encoder-died-after-inpaint', gapIndex: 4 } },
    { family: 'gaps', row: 'U2.inpaint', gapIndex: 4, passed: 9, position: 21, redo: 1, end: { kind: 'encoder-died-after-inpaint', gapIndex: 4 } },
    { family: 'cycles', row: 'U3.depth', cycle: 20, end: { kind: 'died-after-terminate', cycle: 20 } },
  ];
}

test('the serialized plan at the full plan largest state is under 16,000 characters and parses back', () => {
  const states = largestStates();
  assert.deepEqual(states.map((s) => s.row), [...ROW_IDS]);
  for (const s of states) assert.equal(s.family, initialState(s.row, LEVERS).family, s.row);
  const counts = { row: 'U3.depth', stepKey: `cycle-${'9'.repeat(58)}`, attempt: 99_999, voids: 4 } as const;
  const plan: PlanState = {
    v: 1,
    run: RUN,
    kind: 'full',
    build: BUILD,
    levers: { ...LEVER_DEFAULTS, rows: ROW_IDS, gaps: [20, 10, 5, 2, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 20, 10, 5, 2, 0.5, 0.25], defaultsScale: 0.123456789, throwAtMb: 3999, timeoutS: 179.5 },
    levered: true,
    ascentCapMb: 800,
    rows: states.map((state, i) => ({ state, halt: i % 2 === 0 ? { kind: 'gl-unavailable', stepKey: `step-${'9'.repeat(59)}` } : null })),
    cursor: 14,
    inFlight: { ...counts, tab: TAB },
    reruns: [counts, counts, counts],
    seq: 9_999_999,
    loads: 99_999,
    kills: 99_999,
    voids: 99_999,
    deaths: 99_999,
    startedAt: T0,
  };
  const text = JSON.stringify(plan);
  console.log(`the full plan's largest state serializes to ${text.length} characters (budget ${PLAN_MAX_UNITS})`);
  assert.ok(text.length < PLAN_MAX_UNITS, `${text.length} characters`);
  assert.deepEqual(parsePlan(text), { ok: true, value: plan });
  assert.ok(planStateSchema.safeParse(plan).success);
});

test('parsePlan answers null for nothing stored and names what fails in a stored plan', () => {
  assert.deepEqual(parsePlan(null), { ok: true, value: null });
  assert.equal(parsePlan('{').ok, false);
  const plan = planOf(['U1.survival.full']);
  const bad = parsePlan(JSON.stringify({ ...plan, cursor: 7 }));
  assert.deepEqual(bad, { ok: false, error: 'the stored plan does not parse: cursor: the cursor is past the last row' });
});

test('a run ended by every survival is reported N of N, and the shared layer reports no-reading over the program', () => {
  const plan = runRow(planOf(['U1.survival.full'], 2), []).plan;
  const row = plan.rows[0];
  assert.ok(row !== undefined);
  assert.deepEqual(rowVerdict(row), { kind: 'runs', survived: 2, of: 2, end: null });
  assert.deepEqual(rowVerdict({ ...row, halt: { kind: 'no-reading', stepKey: 'run-1' } }), { kind: 'no-reading', stepKey: 'run-1' });
  assert.equal(verdictText({ kind: 'no-reading', stepKey: 'run-1' }), `no reading (run-1 voided ${VOID_CAP} times)`);
});

test("the plan's constants hold their specified figures", () => {
  assert.deepEqual(
    {
      RUNS: lines.RUNS,
      HEADROOM_LINE_MB: lines.HEADROOM_LINE_MB,
      CHUNK_MB: lines.CHUNK_MB,
      GAPS_S: lines.GAPS_S,
      CYCLES: lines.CYCLES,
      LEAK_RATIO: lines.LEAK_RATIO,
      PANORAMA_RATIO: lines.PANORAMA_RATIO,
      MAC_DEPTH_BAND_MB: lines.MAC_DEPTH_BAND_MB,
      COOLDOWN_MS: lines.COOLDOWN_MS,
      HIDDEN_GRACE_MS: lines.HIDDEN_GRACE_MS,
      VOID_CAP: lines.VOID_CAP,
      OUTBOX_CAP_UNITS: lines.OUTBOX_CAP_UNITS,
      PLAN_MAX_UNITS: lines.PLAN_MAX_UNITS,
      GL_TEXTURES: lines.GL_TEXTURES,
      KEEPALIVE_MAX_BYTES: lines.KEEPALIVE_MAX_BYTES,
      POST_TIMEOUT_MS: lines.POST_TIMEOUT_MS,
    },
    {
      RUNS: 10,
      HEADROOM_LINE_MB: 300,
      CHUNK_MB: 100,
      GAPS_S: [20, 10, 5, 2, 0.5],
      CYCLES: 20,
      LEAK_RATIO: 1.2,
      PANORAMA_RATIO: 1.2,
      MAC_DEPTH_BAND_MB: { low: 277, high: 348 },
      COOLDOWN_MS: { depth: 5000, encode: 20000, inpaint: 5000 },
      HIDDEN_GRACE_MS: 4000,
      VOID_CAP: 5,
      OUTBOX_CAP_UNITS: 500000,
      PLAN_MAX_UNITS: 16000,
      GL_TEXTURES: { full: 18, low: 5, none: 0 },
      KEEPALIVE_MAX_BYTES: 60000,
      POST_TIMEOUT_MS: 10000,
    },
  );
  assert.deepEqual(lines.LEVER_DEFAULTS, {
    rows: null,
    runs: 10,
    chunkMb: 100,
    untouchedMb: 1500,
    ceilingMb: 4000,
    startMb: 300,
    gaps: [20, 10, 5, 2, 0.5],
    cycles: 20,
    defaultsScale: 1,
    throwAtMb: null,
    timeoutS: 180,
  });
});
