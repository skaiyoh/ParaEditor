// src/dev/harness/programs/killpoint.ts through the plan: the kill-point
// ladder at 1 MB and 100 MB chunks ending at its ceiling (a multiple of the
// chunk, not a multiple, and below one chunk), by a kill in a fill, in a
// hold, in a phase that names no size, and at a smaller total while a step
// grows the ballast again, and by a throw, a smaller one too; its phase names
// and its verdicts; the outcomes it ignores; the second kill-point row after
// the first in one plan; and the headroom ceiling planContext reads from the
// first row, which agrees with the row's own last held step at every ending.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEVER_DEFAULTS } from '../src/dev/harness/lines.ts';
import { applyLoad, classifyLoad } from '../src/dev/harness/load.ts';
import type { RowId } from '../src/dev/harness/catalog.ts';
import type { Levers } from '../src/dev/harness/context.ts';
import { completeStep, createPlan, nextPlanStep, planContext, type PlanState } from '../src/dev/harness/plan.ts';
import { rowVerdict, type Folded } from '../src/dev/harness/registry.ts';
import { verdictText, type StateOf } from '../src/dev/harness/states.ts';
import { ballastPhase, killpointProgram, ladderTopMb, parseBallastPhase } from '../src/dev/harness/programs/killpoint.ts';
import type { HarnessEvent, StepOutcome } from '../src/dev/harness/rows.ts';
import { begin, BUILD, markerFor, RUN, SURVIVED, T0 } from './fixtures/harness.ts';

type KillpointState = StateOf<'killpoint'>;

function planWith(rows: readonly RowId[], levers: Partial<Levers>): { readonly plan: PlanState; readonly events: readonly HarnessEvent[] } {
  const made = createPlan({ kind: 'full', run: RUN, build: BUILD, levers: { ...LEVER_DEFAULTS, ...levers, rows }, levered: true, ascentCapMb: null, nowWall: T0 });
  if (!made.ok) throw new Error(`createPlan refused: ${made.error.kind}`);
  return { plan: made.value.plan, events: made.value.rows.map((r) => r.event) };
}

const held = (mb: number, chunks: number): Folded => ({ kind: 'held', mb, chunks, checksums: [], fillMs: 1 });
const killed = (phase: string): Folded => ({ kind: 'killed', phase, markerAgeMs: 900, aliveAgeMs: 300, hiddenMs: 0 });

/**
 * Runs the plan's steps while they are `row`'s, answering each with
 * `answer(mb)` (held when it answers null); returns the plan, the step sizes
 * run, and every event posted.
 */
function runLadder(plan: PlanState, row: RowId, answer: (mb: number) => StepOutcome | null = () => null) {
  let current = plan;
  const steps: number[] = [];
  const events: HarnessEvent[] = [];
  for (;;) {
    const next = nextPlanStep(current);
    if (next.kind !== 'step' || next.row !== row) break;
    const begun = begin(current);
    const step = begun.planned.step;
    if (step.kind !== 'ballast') throw new Error('not a ballast step');
    assert.equal(begun.planned.key, `mb-${step.mb}`);
    steps.push(step.mb);
    const done = completeStep(begun.plan, answer(step.mb) ?? held(step.mb, steps.length), T0);
    events.push(...begun.rows.map((r) => r.event), ...done.rows.map((r) => r.event));
    current = done.plan;
  }
  return { plan: current, steps, events };
}

const stateOf = (plan: PlanState, index: number): KillpointState => {
  const state = plan.rows[index]?.state;
  if (state?.family !== 'killpoint') throw new Error('not a kill-point row');
  return state;
};
const verdictOf = (plan: PlanState, index: number): string => verdictText(rowVerdict(plan.rows[index] ?? assert.fail()));
const rowEnds = (events: readonly HarnessEvent[]) => events.filter((e) => e.type === 'row-end');
const range = (from: number, to: number, by: number): number[] => Array.from({ length: Math.floor((to - from) / by) + 1 }, (_, i) => from + i * by);

/** The headroom ceiling from the kill-point lever alone: a row that reached its ceiling reads the ceilingMb lever, less a chunk, floored to a chunk. */
const ceilingFromLever = (ceilingMb: number, chunkMb: number): number => Math.max(0, Math.floor((ceilingMb - chunkMb) / chunkMb) * chunkMb);

test('the ballast phases are fill:<mb> and hold:<mb>, read back by the same module, and no other name parses', () => {
  assert.deepEqual([ballastPhase({ kind: 'fill', mb: 8 }), ballastPhase({ kind: 'hold', mb: 4000 })], ['fill:8', 'hold:4000']);
  assert.deepEqual([parseBallastPhase('fill:8'), parseBallastPhase('hold:4000')], [{ kind: 'fill', mb: 8 }, { kind: 'hold', mb: 4000 }]);
  for (const name of ['wait', 'setup', 'after', 'unknown', 'fill:0', 'fill:', 'hold:-5', 'alloc:100', 'run:encode']) assert.equal(parseBallastPhase(name), null, name);
});

test('the ladder at 1 MB chunks runs one step per chunk from 1 to the 30 MB ceiling and ends no kill up to 30 MB, holding 30', () => {
  const { plan } = planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30 });
  assert.deepEqual(stateOf(plan, 0), { family: 'killpoint', row: 'U1.killpoint', topMb: 30, heldMb: 0, end: null });
  assert.equal(verdictOf(plan, 0), 'not run');
  const first = begin(plan).planned;
  assert.deepEqual(first, { key: 'mb-1', step: { kind: 'ballast', mb: 1, release: 'all' } });
  const run = runLadder(plan, 'U1.killpoint');
  assert.deepEqual(run.steps, range(1, 30, 1));
  assert.deepEqual(stateOf(run.plan, 0), { family: 'killpoint', row: 'U1.killpoint', topMb: 30, heldMb: 30, end: { kind: 'ceiling' } });
  assert.deepEqual(rowEnds(run.events), [{ type: 'row-end', row: 'U1.killpoint', verdict: { kind: 'killpoint', heldMb: 30, end: { kind: 'ceiling' } }, amends: false }]);
  assert.equal(verdictOf(run.plan, 0), 'no kill up to 30 MB');
  assert.deepEqual([run.plan.cursor, nextPlanStep(run.plan).kind], [1, 'done']);
});

test('the ladder at 100 MB chunks runs 100 to 4,000 at the default ceiling, and a ceiling the chunk does not divide stops at the last whole step below it', () => {
  const full = runLadder(planWith(['U1.killpoint'], { chunkMb: 100, ceilingMb: 4000 }).plan, 'U1.killpoint');
  assert.deepEqual(full.steps, range(100, 4000, 100));
  assert.equal(verdictOf(full.plan, 0), 'no kill up to 4000 MB');
  const odd = runLadder(planWith(['U1.killpoint'], { chunkMb: 100, ceilingMb: 250 }).plan, 'U1.killpoint');
  assert.deepEqual([odd.steps, stateOf(odd.plan, 0).topMb, verdictOf(odd.plan, 0)], [[100, 200], 200, 'no kill up to 200 MB']);
  assert.deepEqual([ladderTopMb({ chunkMb: 100, ceilingMb: 250 }), ladderTopMb({ chunkMb: 1, ceilingMb: 30 }), ladderTopMb({ chunkMb: 100, ceilingMb: 50 })], [200, 30, 0]);
});

test('a ceiling below one chunk leaves the ladder no step: the row ends at Start, no kill up to 0 MB', () => {
  const { plan, events } = planWith(['U1.killpoint'], { chunkMb: 100, ceilingMb: 50 });
  assert.deepEqual(stateOf(plan, 0), { family: 'killpoint', row: 'U1.killpoint', topMb: 0, heldMb: 0, end: { kind: 'ceiling' } });
  assert.deepEqual(rowEnds(events), [{ type: 'row-end', row: 'U1.killpoint', verdict: { kind: 'killpoint', heldMb: 0, end: { kind: 'ceiling' } }, amends: false }]);
  assert.equal(nextPlanStep(plan).kind, 'done');
});

test('a kill in the 8 MB step\'s fill ends the row with the kill point 8 and 7 MB the last held; in its hold, the same kill point', () => {
  for (const [phase, text] of [
    ['fill:8', 'kill point 8 MB in fill'],
    ['hold:8', 'kill point 8 MB in hold'],
  ] as const) {
    const run = runLadder(planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30 }).plan, 'U1.killpoint', (mb) => (mb === 8 ? killed(phase) : null));
    assert.deepEqual(run.steps, range(1, 8, 1), phase);
    assert.deepEqual(stateOf(run.plan, 0), { family: 'killpoint', row: 'U1.killpoint', topMb: 30, heldMb: 7, end: { kind: 'killed', atMb: 8, phase } }, phase);
    assert.deepEqual(rowEnds(run.events).map((e) => e.verdict), [{ kind: 'killpoint', heldMb: 7, end: { kind: 'killed', atMb: 8, phase } }], phase);
    assert.equal(verdictOf(run.plan, 0), text);
  }
});

test('a renderer death in the 8 MB step\'s fill, read at the next load from the marker, folds the kill point 8 in fill:8 and ends the row, with no rerun and no wait', () => {
  // Run to the 8 MB step and leave it in flight, as the page that died left it.
  let plan = planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30 }).plan;
  for (let mb = 1; mb < 8; mb += 1) plan = completeStep(begin(plan).plan, held(mb, mb), T0).plan;
  const dying = begin(plan);
  assert.equal(dying.planned.key, 'mb-8');
  const marker = markerFor(dying.plan, dying.planned, { phase: 'fill:8' });
  const verdict = classifyLoad(dying.plan, marker, BUILD, T0 + 5_000);
  assert.equal(verdict.kind, 'killed');
  const applied = applyLoad(dying.plan, verdict, T0 + 5_000);
  assert.deepEqual(stateOf(applied.plan, 0), { family: 'killpoint', row: 'U1.killpoint', topMb: 30, heldMb: 7, end: { kind: 'killed', atMb: 8, phase: 'fill:8' } });
  assert.deepEqual(
    applied.rows.map((r) => r.event).filter((e) => e.type === 'row-end'),
    [{ type: 'row-end', row: 'U1.killpoint', verdict: { kind: 'killpoint', heldMb: 7, end: { kind: 'killed', atMb: 8, phase: 'fill:8' } }, amends: false }],
  );
  assert.deepEqual([applied.plan.kills, applied.leastWaitMs, nextPlanStep(applied.plan).kind], [1, 0, 'done']);
});

test('at 100 MB chunks a kill in the 1,300 MB step\'s fill is the kill point 1,300 with 1,200 the last held', () => {
  const run = runLadder(planWith(['U1.killpoint'], { chunkMb: 100, ceilingMb: 4000 }).plan, 'U1.killpoint', (mb) => (mb === 1300 ? killed('fill:1300') : null));
  assert.deepEqual([stateOf(run.plan, 0).heldMb, stateOf(run.plan, 0).end, verdictOf(run.plan, 0)], [1200, { kind: 'killed', atMb: 1300, phase: 'fill:1300' }, 'kill point 1300 MB in fill']);
});

test('a kill or a throw at a smaller total, as when a step run after a reload grows the ballast again from nothing, is the step\'s own size, one chunk above the last held, with the phase kept; so is a phase naming no size', () => {
  const regrow = runLadder(planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30 }).plan, 'U1.killpoint', (mb) => (mb === 8 ? killed('fill:3') : null));
  assert.deepEqual([stateOf(regrow.plan, 0).heldMb, stateOf(regrow.plan, 0).end, verdictOf(regrow.plan, 0)], [7, { kind: 'killed', atMb: 8, phase: 'fill:3' }, 'kill point 8 MB in fill']);
  assert.equal(planContext(regrow.plan).ceilingMb, 6, 'the headroom ceiling is the last held 7 MB less one chunk, below the kill point');
  const thrown = runLadder(planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30 }).plan, 'U1.killpoint', (mb) => (mb === 8 ? { kind: 'throw', atMb: 3, message: 'Array buffer allocation failed' } : null));
  assert.deepEqual([stateOf(thrown.plan, 0).heldMb, stateOf(thrown.plan, 0).end, verdictOf(thrown.plan, 0)], [7, { kind: 'throw', atMb: 8 }, 'throw at 8 MB']);
  const unknown = runLadder(planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30 }).plan, 'U1.killpoint', (mb) => (mb === 8 ? killed('unknown') : null));
  assert.deepEqual([stateOf(unknown.plan, 0).end, verdictOf(unknown.plan, 0)], [{ kind: 'killed', atMb: 8, phase: 'unknown' }, 'kill point 8 MB in unknown']);
});

test('a throw at the 12 MB step ends the row throw at 12 MB with 11 the last held', () => {
  const run = runLadder(planWith(['U1.killpoint'], { chunkMb: 1, ceilingMb: 30, throwAtMb: 12 }).plan, 'U1.killpoint', (mb) =>
    mb === 12 ? { kind: 'throw', atMb: 12, message: 'the throwAtMb lever refuses the allocation that brings the total to 12 MB' } : null,
  );
  assert.deepEqual(run.steps, range(1, 12, 1));
  assert.deepEqual(rowEnds(run.events).map((e) => e.verdict), [{ kind: 'killpoint', heldMb: 11, end: { kind: 'throw', atMb: 12 } }]);
  assert.equal(verdictOf(run.plan, 0), 'throw at 12 MB');
});

test('the program ignores a sequence outcome, a death after a worker\'s termination, a step at or below the last held, a key that is not the step\'s, and anything after the row ended', () => {
  const state: KillpointState = { family: 'killpoint', row: 'U1.killpoint', topMb: 30, heldMb: 5, end: null };
  const step = (mb: number) => ({ key: `mb-${mb}`, step: { kind: 'ballast', mb, release: 'all' } as const });
  if (SURVIVED.kind === 'ran') assert.equal(killpointProgram.fold(state, step(6), SURVIVED), state);
  assert.equal(killpointProgram.fold(state, step(6), { kind: 'died-after-terminate', sinceTerminateMs: 1, aliveAgeMs: 1 }), state);
  assert.equal(killpointProgram.fold(state, step(5), held(5, 5)), state);
  assert.equal(killpointProgram.fold(state, { ...step(6), key: 'mb-7' }, held(6, 6)), state);
  const ended: KillpointState = { ...state, end: { kind: 'throw', atMb: 6 } };
  assert.equal(killpointProgram.fold(ended, step(6), held(6, 6)), ended);
  assert.equal(verdictText(killpointProgram.verdict(state)), 'held 5 MB so far');
});

test('the second kill-point row runs after the first in one plan from one chunk again, and the headroom ceiling reads the first row only', () => {
  const { plan } = planWith(['U1.killpoint', 'U1.killpoint.after'], { chunkMb: 1, ceilingMb: 30 });
  const first = runLadder(plan, 'U1.killpoint', (mb) => (mb === 8 ? killed('fill:8') : null));
  assert.deepEqual(begin(first.plan).planned, { key: 'mb-1', step: { kind: 'ballast', mb: 1, release: 'all' } });
  const second = runLadder(first.plan, 'U1.killpoint.after');
  assert.deepEqual(second.steps, range(1, 30, 1));
  assert.deepEqual([verdictOf(second.plan, 0), verdictOf(second.plan, 1)], ['kill point 8 MB in fill', 'no kill up to 30 MB']);
  assert.equal(planContext(second.plan).ceilingMb, 6, 'the first kill-point row held 7 MB: less one chunk is 6');
  assert.equal(nextPlanStep(second.plan).kind, 'done');
});

test('the headroom ceiling planContext reads agrees with the first row\'s last held step less one chunk, floored, at every ending', () => {
  const cases: readonly { readonly chunkMb: number; readonly ceilingMb: number; readonly answer: (mb: number) => StepOutcome | null; readonly heldMb: number }[] = [
    { chunkMb: 1, ceilingMb: 30, answer: () => null, heldMb: 30 },
    { chunkMb: 100, ceilingMb: 4000, answer: () => null, heldMb: 4000 },
    { chunkMb: 100, ceilingMb: 250, answer: () => null, heldMb: 200 },
    { chunkMb: 7, ceilingMb: 30, answer: () => null, heldMb: 28 },
    { chunkMb: 100, ceilingMb: 50, answer: () => null, heldMb: 0 },
    { chunkMb: 1, ceilingMb: 30, answer: (mb) => (mb === 8 ? killed('hold:8') : null), heldMb: 7 },
    { chunkMb: 100, ceilingMb: 4000, answer: (mb) => (mb === 100 ? killed('fill:100') : null), heldMb: 0 },
    { chunkMb: 1, ceilingMb: 30, answer: (mb) => (mb === 12 ? { kind: 'throw', atMb: 12, message: 'RangeError' } : null), heldMb: 11 },
  ];
  for (const { chunkMb, ceilingMb, answer, heldMb } of cases) {
    const label = `chunk ${chunkMb}, ceiling ${ceilingMb}, held ${heldMb}`;
    const run = runLadder(planWith(['U1.killpoint'], { chunkMb, ceilingMb }).plan, 'U1.killpoint', answer);
    const state = stateOf(run.plan, 0);
    assert.equal(state.heldMb, heldMb, label);
    const fromRow = Math.max(0, Math.floor((state.heldMb - chunkMb) / chunkMb) * chunkMb);
    assert.equal(planContext(run.plan).ceilingMb, fromRow, label);
    if (state.end?.kind === 'ceiling') assert.equal(fromRow, ceilingFromLever(ceilingMb, chunkMb), `${label}: at the ceiling the row and the lever agree`);
  }
  assert.equal(planContext(planWith(['U1.untouched'], { chunkMb: 100, ceilingMb: 4000 }).plan).ceilingMb, 3900, 'with no kill-point row the lever gives 3,900');
});
