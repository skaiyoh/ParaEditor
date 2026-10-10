// src/dev/harness/engine.ts over a fake origin (test/support/harness-world.ts):
// a run of the untouched row to DONE; a page killed in each phase of a step,
// between the plan's write and the marker's clearing, after pagehide, hidden,
// and hidden briefly, each resumed by a new page over the same storage whose
// load scores the step as the load verdicts say; a step completed after a
// hidden period past the grace; five voids of one step; a page hidden when a
// step would start; a sink that fails and recovers; a stored run of another
// build or that does not parse; plan and marker writes that throw; a runner
// that rejects; a second page while the first holds the runner lock; a page
// left open at DONE while another runs; Start refused; Start's own load row,
// with Web Locks and without; Start over a run another page left unfinished,
// with a step in flight or between steps, which it refuses, and over one it
// replaces; Stop mid-step and at DONE, and Start after Stop; and a death in a
// wait after a worker's termination. Every test that
// opens a page with Web Locks also checks that no page wrote the harness's
// keys before it first held the runner lock, nor the plan or the marker while
// another held it.
// And programs/untouched.ts: its phase names, fold, and verdict.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AFTER_PHASE, LOCK_WAIT_MS, RUNNER_LOCK, runPhase, stageOfPhase, statusText, STEP_START_POST_MS, type LeverChoice, type LoadAnswer, type RunnerLocks } from '../src/dev/harness/engine.ts';
import { COOLDOWN_MS, HIDDEN_GRACE_MS, VOID_CAP } from '../src/dev/harness/lines.ts';
import { stepMarkerSchema, type StepMarker } from '../src/dev/harness/load.ts';
import { PLAN_ROWS } from '../src/dev/harness/catalog.ts';
import { planStateSchema, type PlanState } from '../src/dev/harness/plan.ts';
import { missingPrograms } from '../src/dev/harness/registry.ts';
import { verdictText } from '../src/dev/harness/states.ts';
import { parseUntouchedPhase, untouchedPhase, untouchedProgram } from '../src/dev/harness/programs/untouched.ts';
import type { HarnessEvent, HarnessRow, StepOutcome } from '../src/dev/harness/rows.ts';
import { LEVERS, OTHER_BUILD, planOf, SURVIVED, T0 } from './fixtures/harness.ts';
import { KEYS, World, type Page, type RunnerCall } from './support/harness-world.ts';

// Compiles only while the browser's lock manager is one the engine can take.
const browserLocks: RunnerLocks = navigator.locks;
void browserLocks;

const MB = 300;
const UNTOUCHED: LeverChoice = { levers: { ...LEVERS, rows: ['U1.untouched'], untouchedMb: MB }, levered: true };
/** The phases this test's scripted runner reports for the untouched step, with 100 MB chunks: the real executor's alloc and hold phases, with a setup and an after phase around them that the real executor does not report. */
const UNTOUCHED_PHASES = ['setup', 'alloc:100', 'alloc:200', 'alloc:300', 'hold:300', AFTER_PHASE];
const HELD: StepOutcome = { kind: 'held', mb: MB, chunks: 3, checksums: [], fillMs: 0 };

/** Answers the untouched step: reports every phase and answers held, or kills the page right after reporting `killAt`, or stops there and waits when `hangAt`. */
function untouched(page: Page, options: { readonly killAt?: string; readonly hangAt?: string } = {}): (call: RunnerCall) => void {
  return (call) => {
    for (const name of UNTOUCHED_PHASES) {
      call.phase(name);
      if (name === options.killAt) {
        page.kill();
        return;
      }
      if (name === options.hangAt) return;
    }
    call.answer(HELD);
  };
}

async function load(world: World, page: Page): Promise<LoadAnswer> {
  const answer = page.engine.load();
  await world.advance(0);
  return answer;
}

/** Starts the untouched plan on `page` and lets it run as far as the runner lets it; `run` settles when the loop ends. */
async function startUntouched(world: World, page: Page): Promise<{ readonly run: Promise<void> }> {
  const run = page.engine.start('full', UNTOUCHED);
  await world.advance(0);
  return { run };
}

function stored(world: World): PlanState {
  const plan = world.plan();
  if (plan === null) throw new Error('no plan is stored');
  return plan;
}

/** The sink's rows, deduped by rowId, after checking they arrived in seq order. */
function posted(world: World): readonly HarnessRow[] {
  const unique: HarnessRow[] = [];
  for (const row of world.sink) if (!unique.some((r) => r.rowId === row.rowId)) unique.push(row);
  const seqs = unique.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'rows reach the sink in seq order');
  return unique;
}

const types = (rows: readonly HarnessRow[]): readonly string[] => rows.map((r) => `${r.seq}:${r.event.type}`);

function eventOf<T extends HarnessEvent['type']>(rows: readonly HarnessRow[], type: T): Extract<HarnessEvent, { readonly type: T }> {
  const found = rows.map((r) => r.event).find((e): e is Extract<HarnessEvent, { readonly type: T }> => e.type === type);
  if (found === undefined) throw new Error(`no ${type} row`);
  return found;
}

/** The marker phases written, in order, with repeats (heartbeats and visibility writes) collapsed. */
function markerPhases(world: World): readonly string[] {
  const phases: string[] = [];
  for (const write of world.writes) {
    if (write.key !== KEYS.step || write.value === '') continue;
    const phase = stepMarkerSchema.parse(JSON.parse(write.value)).phase;
    if (phases.at(-1) !== phase) phases.push(phase);
  }
  return phases;
}

function noViolations(world: World): void {
  assert.deepEqual(world.violations, [], 'no page wrote the harness keys without the runner lock');
}

const writesBy = (world: World, page: Page): number => world.writes.filter((w) => w.page === page.name).length;

const counters = (plan: PlanState): readonly number[] => [plan.loads, plan.kills, plan.voids];

/** The rows posted in page load `n` of the run. */
const inLoad = (rows: readonly HarnessRow[], n: number): readonly HarnessRow[] => rows.filter((r) => r.load === n);

// ---------------------------------------------------------------------------
// a run to DONE

test('a full plan of the untouched row runs to DONE, posts its rows in seq order, and releases the runner and the lock', async () => {
  const world = new World();
  const page = world.open();
  page.runner.auto = untouched(page);
  assert.deepEqual(await load(world, page), { kind: 'idle' });
  await (await startUntouched(world, page)).run;
  const plan = stored(world);
  assert.equal(plan.cursor, 1);
  assert.equal(plan.inFlight, null);
  assert.deepEqual(counters(plan), [1, 0, 0]);
  assert.equal(world.marker(), null);
  assert.deepEqual(markerPhases(world), ['wait', ...UNTOUCHED_PHASES]);
  const rows = posted(world);
  assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done']);
  assert.deepEqual(eventOf(rows, 'step-start').step, { kind: 'untouched', mb: MB });
  assert.deepEqual(eventOf(rows, 'row-end').verdict, { kind: 'untouched', end: { kind: 'survived' } });
  assert.deepEqual(eventOf(rows, 'done'), { type: 'done', loads: 1, kills: 0, voids: 0 });
  assert.equal(page.runner.released, 1);
  assert.equal(world.locks.holder(RUNNER_LOCK), null);
  assert.deepEqual(page.status, { kind: 'done', plan, pending: 0 });
  noViolations(world);
});

// ---------------------------------------------------------------------------
// a page killed mid-step, and its reload

/** Starts the untouched plan on a first page, kills it as `kill` says, and loads a second page over the same storage. */
async function killAndReload(kill: (world: World, page: Page) => void): Promise<{ readonly world: World; readonly next: Page; readonly answer: LoadAnswer }> {
  const world = new World();
  const first = world.open();
  kill(world, first);
  await load(world, first);
  await startUntouched(world, first);
  assert.equal(first.alive, false, 'the first page was killed');
  const next = world.open();
  next.runner.auto = untouched(next);
  const answer = await load(world, next);
  return { world, next, answer };
}

const isMarkerWrite = (phase: string) => (key: string, value: string) => key === KEYS.step && value !== '' && stepMarkerSchema.parse(JSON.parse(value)).phase === phase;

test('a page killed in its wait with no worker waited out is voided died-idle, and the step reruns as its next attempt', async () => {
  const { world, next, answer } = await killAndReload((_, page) => page.killAfterWrite(isMarkerWrite('wait')));
  assert.deepEqual(answer, { kind: 'resume' });
  assert.equal(eventOf(inLoad(posted(world), 2), 'load').verdict, 'died-idle');
  await next.engine.continue();
  const rows = posted(world);
  assert.deepEqual(eventOf(rows, 'step-lost'), {
    type: 'step-lost',
    row: 'U1.untouched',
    stepKey: 'untouched',
    attempt: 1,
    verdict: 'died-idle',
    phase: 'wait',
    markerAgeMs: 0,
    aliveAgeMs: 0,
    hiddenMs: 0,
    attributedTo: null,
    afterCompletion: false,
  });
  // The first page died after its marker and before it enqueued its step-start, whose seq is the gap readers flag.
  assert.deepEqual(types(rows), ['0:plan', '1:load', '3:load', '4:step-lost', '5:step-start', '6:step-end', '7:row-end', '8:done']);
  assert.equal(eventOf(rows, 'step-start').attempt, 2);
  assert.deepEqual(eventOf(rows, 'row-end').verdict, { kind: 'untouched', end: { kind: 'survived' } });
  assert.deepEqual(counters(stored(world)), [2, 0, 1]);
  noViolations(world);
});

for (const [phase, verdict] of [
  ['setup', 'killed in setup'],
  ['alloc:200', 'killed at 200 MB'],
  ['hold:300', 'killed at 300 MB'],
  [AFTER_PHASE, 'killed in after'],
] as const) {
  test(`a page killed visible in phase ${phase} is a kill folded into its row, ${verdict}, and never reruns`, async () => {
    const world = new World();
    const first = world.open();
    first.runner.auto = untouched(first, { killAt: phase });
    await load(world, first);
    await startUntouched(world, first);
    const killedAt = world.marker();
    assert.equal(killedAt?.phase, phase, 'the phase was written before the runner went on');
    await world.advance(1_500);
    const next = world.open();
    assert.deepEqual(await load(world, next), { kind: 'done' });
    const rows = posted(world);
    assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '3:load', '4:step-lost', '5:row-end', '6:done']);
    const lost = eventOf(rows, 'step-lost');
    assert.deepEqual([lost.verdict, lost.phase, lost.markerAgeMs, lost.aliveAgeMs], ['killed', phase, 1_500, 1_500]);
    const rowEnd = eventOf(rows, 'row-end');
    assert.equal(verdictText(rowEnd.verdict), verdict);
    assert.deepEqual(eventOf(rows, 'done'), { type: 'done', loads: 2, kills: 1, voids: 0 });
    assert.equal(next.runner.calls.length, 0);
    assert.equal(world.marker(), null);
    assert.equal(world.locks.holder(RUNNER_LOCK), null, 'DONE at load releases the lock');
    noViolations(world);
  });
}

test('a page killed between its plan write with the step in flight and its marker write lost the marker: a kill in phase unknown', async () => {
  const { world, answer } = await killAndReload((_, page) =>
    page.killAfterWrite((key, value) => key === KEYS.plan && planStateSchema.parse(JSON.parse(value)).inFlight !== null),
  );
  assert.deepEqual(answer, { kind: 'done' });
  const rows = posted(world);
  assert.equal(eventOf(inLoad(rows, 2), 'load').verdict, 'marker-lost');
  assert.equal(verdictText(eventOf(rows, 'row-end').verdict), 'killed in unknown');
  assert.deepEqual(counters(stored(world)), [2, 1, 0]);
  noViolations(world);
});

test('a page killed between the plan write that folds its step and the marker clearing posts step-lost after completion and folds nothing', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = untouched(first);
  first.killAfterWrite((key, value) => key === KEYS.plan && planStateSchema.parse(JSON.parse(value)).cursor === 1);
  await load(world, first);
  await startUntouched(world, first);
  assert.equal(first.alive, false);
  assert.equal(world.marker()?.phase, AFTER_PHASE, 'the marker is still there');
  const next = world.open();
  assert.deepEqual(await load(world, next), { kind: 'done' });
  const rows = posted(world);
  // The rows the first page had stamped but not enqueued are lost: their seqs are the gap readers flag.
  assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '6:load', '7:step-lost']);
  assert.equal(eventOf(inLoad(rows, 2), 'load').verdict, 'after-completion');
  assert.equal(eventOf(rows, 'step-lost').afterCompletion, true);
  const plan = stored(world);
  assert.deepEqual(counters(plan), [2, 0, 0]);
  assert.equal(plan.rows[0]?.state.family === 'untouched' && plan.rows[0].state.end?.kind, 'held');
  assert.equal(world.marker(), null);
  noViolations(world);
});

test('a load killed between its plan write and the marker clearing leaves a marker the next load ignores, since its step is scored', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = (call) => {
    untouched(first, { hangAt: 'alloc:200' })(call);
    first.pagehide();
    first.kill();
  };
  await load(world, first);
  await startUntouched(world, first);
  const second = world.open();
  second.killAfterWrite((key) => key === KEYS.plan);
  await load(world, second);
  assert.equal(second.alive, false);
  assert.equal(world.marker()?.phase, 'alloc:200', 'the dead step marker is still there');
  assert.deepEqual(counters(stored(world)), [2, 0, 1]);
  const third = world.open();
  third.runner.auto = untouched(third);
  assert.deepEqual(await load(world, third), { kind: 'resume' });
  assert.equal(world.marker(), null);
  await third.engine.continue();
  const rows = posted(world);
  // The second page's load and step-lost rows died with it: their seqs are the gap readers flag.
  assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '5:load', '6:step-start', '7:step-end', '8:row-end', '9:done']);
  assert.equal(eventOf(inLoad(rows, 3), 'load').verdict, 'fresh');
  assert.deepEqual(eventOf(rows, 'done'), { type: 'done', loads: 3, kills: 0, voids: 1 });
  noViolations(world);
});

test('a load killed between its plan write and the marker clearing still leaves the dead step cooldown for the next load to wait', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = (call) => {
    for (const name of ['wait', 'setup', runPhase('depth'), runPhase('encode')]) call.phase(name);
    first.kill();
  };
  await load(world, first);
  void first.engine.start('full', { levers: { ...LEVERS, rows: ['U1.survival.full', 'U1.survival.low'], runs: 2 }, levered: true });
  await world.advance(0);
  assert.equal(first.alive, false);
  await world.advance(500);
  const second = world.open();
  second.killAfterWrite((key) => key === KEYS.plan);
  await load(world, second);
  assert.equal(second.alive, false);
  assert.equal(world.marker()?.phase, runPhase('encode'), 'the dead step marker is still there');
  assert.deepEqual(counters(stored(world)), [2, 1, 0]);
  await world.advance(500);
  const third = world.open();
  assert.deepEqual(await load(world, third), { kind: 'resume' });
  assert.equal(world.marker(), null);
  void third.engine.continue();
  await world.advance(COOLDOWN_MS.encode - 1);
  assert.equal(third.runner.calls.length, 0, 'the first step after the load waits the cooldown the dead load owed');
  await world.advance(1);
  assert.equal(third.runner.calls.length, 1);
  const rows = posted(world);
  assert.equal(rows.filter((r) => r.event.type === 'step-lost').length, 0, "the second page's step-lost died with it, and no load posts another");
  assert.equal(eventOf(rows.filter((r) => r.load === 3), 'load').verdict, 'fresh');
  assert.deepEqual(counters(stored(world)), [3, 1, 0]);
  noViolations(world);
});

test('pagehide before a drop voids the step as left, and it reruns', async () => {
  const { world, next, answer } = await killAndReload((_, page) => {
    page.runner.auto = (call) => {
      untouched(page, { hangAt: 'alloc:200' })(call);
      page.pagehide();
      page.kill();
    };
  });
  assert.deepEqual(answer, { kind: 'resume' });
  await next.engine.continue();
  const rows = posted(world);
  assert.equal(eventOf(inLoad(rows, 2), 'load').verdict, 'left');
  assert.equal(eventOf(rows, 'step-lost').verdict, 'left');
  assert.deepEqual(eventOf(rows, 'row-end').verdict, { kind: 'untouched', end: { kind: 'survived' } });
  assert.deepEqual(counters(stored(world)), [2, 0, 1]);
  noViolations(world);
});

test('a page hidden at the drop is voided background, and the step reruns', async () => {
  const { world, next, answer } = await killAndReload((_, page) => {
    page.runner.auto = (call) => {
      untouched(page, { hangAt: 'alloc:200' })(call);
      page.setHidden(true);
      page.kill();
    };
  });
  assert.deepEqual(answer, { kind: 'resume' });
  await next.engine.continue();
  const rows = posted(world);
  assert.equal(eventOf(rows, 'step-lost').verdict, 'background');
  assert.deepEqual(counters(stored(world)), [2, 0, 1]);
  noViolations(world);
});

test('a page hidden briefly and visible again at the drop is a kill with its hidden time, not a void', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = untouched(first, { hangAt: 'hold:300' });
  await load(world, first);
  await startUntouched(world, first);
  first.setHidden(true);
  await world.advance(2_000);
  first.setHidden(false);
  await world.advance(500);
  const hidden = world.marker();
  assert.deepEqual([hidden?.visibility, hidden?.hiddenMs, hidden?.longestHiddenMs, hidden?.hiddenSinceWall], ['visible', 2_000, 2_000, null]);
  first.kill();
  const next = world.open();
  assert.deepEqual(await load(world, next), { kind: 'done' });
  const rows = posted(world);
  const lost = eventOf(rows, 'step-lost');
  assert.deepEqual([lost.verdict, lost.phase, lost.hiddenMs], ['killed', 'hold:300', 2_000]);
  assert.equal(verdictText(eventOf(rows, 'row-end').verdict), 'killed at 300 MB');
  assert.deepEqual(counters(stored(world)), [2, 1, 0]);
  noViolations(world);
});

test('a step hidden past the grace that completes is voided hidden and reruns', async () => {
  const world = new World();
  const page = world.open();
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  const { run } = await startUntouched(world, page);
  page.setHidden(true);
  await world.advance(HIDDEN_GRACE_MS + 1);
  page.setHidden(false);
  page.runner.auto = untouched(page);
  page.runner.calls[0]?.answer(HELD);
  await world.advance(0);
  await run;
  const rows = posted(world);
  const ends = rows.flatMap((r) => (r.event.type === 'step-end' ? [r.event.outcome] : []));
  assert.deepEqual(ends, [{ kind: 'void', reason: 'hidden' }, HELD]);
  assert.equal(page.runner.calls.length, 2);
  assert.deepEqual(counters(stored(world)), [1, 0, 1]);
  noViolations(world);
});

test('five voids of one step end its row no-reading, counted apart from kills', async () => {
  const world = new World();
  let page = world.open();
  const leave = (p: Page) => (call: RunnerCall) => {
    untouched(p, { hangAt: 'alloc:100' })(call);
    p.pagehide();
    p.kill();
  };
  page.runner.auto = leave(page);
  await load(world, page);
  await startUntouched(world, page);
  for (let load = 2; load <= VOID_CAP; load += 1) {
    page = world.open();
    page.runner.auto = leave(page);
    const answer = page.engine.load();
    await world.advance(0);
    assert.deepEqual(await answer, { kind: 'resume' });
    void page.engine.continue();
    await world.advance(0);
    assert.equal(page.alive, false);
  }
  page = world.open();
  assert.deepEqual(await load(world, page), { kind: 'done' });
  const rows = posted(world);
  assert.deepEqual(
    rows.flatMap((r) => (r.event.type === 'step-start' ? [r.event.attempt] : [])),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(eventOf(rows, 'row-end').verdict, { kind: 'no-reading', stepKey: 'untouched' });
  assert.deepEqual(eventOf(rows, 'done'), { type: 'done', loads: 6, kills: 0, voids: 5 });
  noViolations(world);
});

test('no step starts while the page is hidden; it starts once the page is visible', async () => {
  const world = new World();
  const page = world.open({ hidden: true });
  page.runner.auto = untouched(page);
  await load(world, page);
  const { run } = await startUntouched(world, page);
  await world.advance(60_000);
  assert.equal(page.runner.calls.length, 0);
  assert.equal(stored(world).inFlight, null);
  assert.equal(world.marker(), null);
  assert.deepEqual(types(posted(world)), ['0:plan', '1:load']);
  assert.equal(page.status?.kind === 'running' && page.status.waitingForVisible, true);
  assert.equal(page.status !== undefined && statusText(page.status), 'Waiting for the page to be visible');
  page.setHidden(false);
  await world.advance(0);
  await run;
  assert.equal(page.runner.calls.length, 1);
  assert.equal(eventOf(posted(world), 'step-start').attempt, 1);
  noViolations(world);
});

// ---------------------------------------------------------------------------
// the sink

test('a sink answering 500 and then ok gets every row, in seq order, from the 30 s flush', async () => {
  const world = new World();
  world.sinkStatus = 500;
  const page = world.open();
  page.runner.auto = untouched(page);
  await load(world, page);
  await (await startUntouched(world, page)).run;
  assert.deepEqual(world.sink, []);
  assert.equal(world.outboxRows().length, 6);
  assert.deepEqual(page.status?.kind === 'done' && page.status.pending, 6);
  world.sinkStatus = 200;
  await world.advance(29_999);
  assert.deepEqual(world.sink, []);
  await world.advance(1);
  assert.deepEqual(types(posted(world)), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done']);
  assert.deepEqual(world.outboxRows(), []);
  assert.deepEqual(page.status?.kind === 'done' && page.status.pending, 0);
  noViolations(world);
});

test('a sink that never answers holds a step for at most 2 s before its runner starts', async () => {
  const world = new World();
  world.sinkHangs = true;
  const page = world.open();
  page.runner.auto = untouched(page);
  await load(world, page);
  const { run } = await startUntouched(world, page);
  assert.equal(world.marker()?.phase, 'wait');
  await world.advance(STEP_START_POST_MS - 1);
  assert.equal(page.runner.calls.length, 0);
  await world.advance(1);
  await run;
  assert.equal(page.runner.calls.length, 1);
  assert.equal(page.status?.kind === 'done' && page.status.pending, 6);
  noViolations(world);
});

// ---------------------------------------------------------------------------
// what a load reads

test('a stored plan of another build is stale, and the page writes nothing and takes no lock', async () => {
  const world = new World();
  world.items.set(KEYS.plan, JSON.stringify({ ...planOf(['U1.untouched']), build: OTHER_BUILD }));
  const before = world.snapshot();
  const page = world.open();
  assert.deepEqual(await load(world, page), { kind: 'stale' });
  assert.deepEqual(world.snapshot(), before);
  assert.equal(writesBy(world, page), 0);
  assert.deepEqual(world.locks.requests, []);
  assert.equal(page.status !== undefined && statusText(page.status), 'Built since this run started');
  noViolations(world);
});

test('a plan an earlier build stored in a shape this build no longer parses is stale, not unreadable, and the page writes nothing', async () => {
  const world = new World();
  // An earlier build's plan: this build's fields missing and one it no longer knows.
  const { deaths: _deaths, ...older } = { ...planOf(['U1.untouched']), build: OTHER_BUILD, retired: true };
  world.items.set(KEYS.plan, JSON.stringify(older));
  const before = world.snapshot();
  const page = world.open();
  assert.deepEqual(await load(world, page), { kind: 'stale' });
  assert.deepEqual(world.snapshot(), before);
  assert.equal(writesBy(world, page), 0);
  assert.equal(page.status !== undefined && statusText(page.status), 'Built since this run started');
  noViolations(world);
});

test('a stored plan that does not parse, and a plan of a kind no page of this build runs, are storage-failed, named', async () => {
  for (const [text, reason] of [
    ['{"v":1', /^the stored plan is not JSON/],
    [JSON.stringify({ ...planOf(['U1.untouched']), kind: 'capability' }), /^the stored plan does not parse: .*kind/],
  ] as const) {
    const world = new World();
    world.items.set(KEYS.plan, text);
    const page = world.open();
    const answer = await load(world, page);
    assert.equal(answer.kind, 'storage-failed');
    assert.match(answer.kind === 'storage-failed' ? answer.reason : '', reason);
    assert.equal(writesBy(world, page), 0);
    assert.deepEqual(world.locks.requests, []);
    noViolations(world);
  }
});

test('a stored marker that does not parse is storage-failed, named, and nothing is written', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = untouched(first, { killAt: 'alloc:100' });
  await load(world, first);
  await startUntouched(world, first);
  world.items.set(KEYS.step, '{"run":1}');
  const before = world.snapshot();
  const next = world.open();
  const answer = await load(world, next);
  assert.match(answer.kind === 'storage-failed' ? answer.reason : '', /^the stored step marker does not parse/);
  assert.deepEqual(world.snapshot(), before);
  assert.equal(writesBy(world, next), 0);
  noViolations(world);
});

// ---------------------------------------------------------------------------
// writes that throw

/** A page whose outbox counts makeRoom calls, started with the untouched plan; started hidden, the test can arm faults before the first step. */
async function countedStart(world: World, options: { readonly hidden: boolean; readonly hangAt?: string }): Promise<{ readonly page: Page; readonly made: () => number; readonly run: Promise<void> }> {
  let made = 0;
  const page = world.open({
    hidden: options.hidden,
    wrapOutbox: (outbox) => ({
      enqueue: (row) => outbox.enqueue(row),
      flush: () => outbox.flush(),
      makeRoom: () => {
        made += 1;
        outbox.makeRoom();
      },
      get pending() {
        return outbox.pending;
      },
      get dropped() {
        return outbox.dropped;
      },
      get refused() {
        return outbox.refused;
      },
    }),
  });
  page.runner.auto = untouched(page, options.hangAt === undefined ? {} : { hangAt: options.hangAt });
  await load(world, page);
  const { run } = await startUntouched(world, page);
  return { page, made: () => made, run };
}

/** A run a write stopped: the plan and the marker are gone, the rows end with `stopped`, and a later load finds no run to score. */
async function endedByFailure(world: World, page: Page, reason: RegExp, rows: readonly string[]): Promise<void> {
  assert.match(page.status?.kind === 'failed' ? page.status.reason : '', reason);
  assert.equal(page.status !== undefined && statusText(page.status).startsWith('Stopped: '), true);
  assert.equal(page.runner.released, 1);
  assert.equal(world.locks.holder(RUNNER_LOCK), null);
  assert.equal(world.plan(), null);
  assert.equal(world.marker(), null);
  assert.deepEqual(types(posted(world)), rows);
  assert.deepEqual(eventOf(posted(world), 'stopped'), { type: 'stopped', loads: 1, kills: 0, voids: 0 });
  const next = world.open();
  assert.deepEqual(await load(world, next), { kind: 'idle' });
  assert.equal(posted(world).length, rows.length, 'the later load posts nothing');
}

test('a plan write and a marker write that each throw once make room in the outbox and are retried, and the run goes on', async () => {
  const world = new World();
  const { page, made, run } = await countedStart(world, { hidden: true });
  page.failWrites(KEYS.plan, 1);
  page.failWrites(KEYS.step, 1);
  page.setHidden(false);
  await world.advance(0);
  await run;
  assert.equal(made(), 2);
  assert.equal(page.status?.kind, 'done');
  assert.deepEqual(eventOf(posted(world), 'row-end').verdict, { kind: 'untouched', end: { kind: 'survived' } });
  noViolations(world);
});

test('a heartbeat write that throws once makes room in the outbox and is retried, and the step goes on', async () => {
  const world = new World();
  const { page, made, run } = await countedStart(world, { hidden: false, hangAt: 'hold:300' });
  page.failWrites(KEYS.step, 1);
  await world.advance(1_000);
  assert.equal(made(), 1);
  assert.equal(page.status?.kind, 'running');
  assert.equal(world.marker()?.aliveAtWall, T0 + 1_000);
  page.runner.calls[0]?.answer(HELD);
  await world.advance(0);
  await run;
  assert.equal(page.status?.kind, 'done');
  assert.deepEqual(eventOf(posted(world), 'row-end').verdict, { kind: 'untouched', end: { kind: 'survived' } });
  noViolations(world);
});

test('a plan write that throws twice before the step begins stops the run with the reason, as Stop does', async () => {
  const world = new World();
  const { page, made, run } = await countedStart(world, { hidden: true });
  page.failWrites(KEYS.plan, 2);
  page.setHidden(false);
  await world.advance(0);
  await run;
  assert.equal(made(), 1);
  assert.equal(page.runner.calls.length, 0);
  await endedByFailure(world, page, /^the plan could not be written: The quota has been exceeded/, ['0:plan', '1:load', '2:stopped']);
  noViolations(world);
});

test('a marker write that throws twice at the step start stops the run before the runner is called, and a reload reads no kill', async () => {
  const world = new World();
  const { page, run } = await countedStart(world, { hidden: true });
  page.failWrites(KEYS.step, 2);
  page.setHidden(false);
  await world.advance(0);
  await run;
  assert.equal(page.runner.calls.length, 0);
  await endedByFailure(world, page, /^the step marker could not be written/, ['0:plan', '1:load', '2:stopped']);
  noViolations(world);
});

test('a heartbeat write that throws twice stops the run mid-step: the runner is aborted, then released with the lock, and a reload reads no kill', async () => {
  const world = new World();
  const { page, run } = await countedStart(world, { hidden: false, hangAt: 'hold:300' });
  page.failWrites(KEYS.step, 2);
  await world.advance(1_000);
  const call = page.runner.calls[0];
  assert.equal(call?.signal.aborted, true);
  assert.equal(page.status?.kind, 'failed');
  assert.equal(page.runner.released, 0, 'released once the runner answers');
  assert.equal(world.locks.holder(RUNNER_LOCK), page);
  call?.answer(HELD);
  await world.advance(0);
  await run;
  await endedByFailure(world, page, /^the step marker could not be written/, ['0:plan', '1:load', '2:step-start', '3:stopped']);
  noViolations(world);
});

test('a plan write that throws twice once the runner answers stops the run, and a reload reads no kill', async () => {
  const world = new World();
  const { page, run } = await countedStart(world, { hidden: false, hangAt: 'hold:300' });
  page.failWrites(KEYS.plan, 2);
  page.runner.calls[0]?.answer(HELD);
  await world.advance(0);
  await run;
  await endedByFailure(world, page, /^the plan could not be written/, ['0:plan', '1:load', '2:step-start', '3:stopped']);
  noViolations(world);
});

test('a runner that rejects stops the run with the reason, as Stop does, and a reload reads no kill', async () => {
  const world = new World();
  const { page, run } = await countedStart(world, { hidden: false, hangAt: 'hold:300' });
  page.runner.calls[0]?.reject(new Error('the runner failed'));
  await world.advance(0);
  await run;
  await endedByFailure(world, page, /^the runner threw: the runner failed$/, ['0:plan', '1:load', '2:step-start', '3:stopped']);
  noViolations(world);
});

// ---------------------------------------------------------------------------
// the runner lock

/** A first page running the untouched step, hung in hold, holding the runner lock. */
async function holding(world: World): Promise<Page> {
  const first = world.open();
  first.runner.auto = untouched(first, { hangAt: 'hold:300' });
  await load(world, first);
  await startUntouched(world, first);
  assert.equal(world.locks.holder(RUNNER_LOCK), first);
  return first;
}

test('a second page waits for the runner lock, writing nothing, and once the first is killed within LOCK_WAIT_MS it scores the step', async () => {
  const world = new World();
  const first = await holding(world);
  const second = world.open();
  const answer = second.engine.load();
  await world.advance(0);
  assert.equal(second.status?.kind, 'waiting-for-lock');
  assert.equal(second.status !== undefined && statusText(second.status), 'Waiting for the previous run to let go');
  await world.advance(3_000);
  assert.equal(writesBy(world, second), 0);
  first.kill();
  await world.advance(0);
  assert.deepEqual(await answer, { kind: 'done' });
  const rows = posted(world);
  assert.deepEqual(eventOf(inLoad(rows, 2), 'load').runnerLock, { kind: 'held', waitedMs: 3_000 });
  assert.equal(eventOf(rows, 'step-lost').phase, 'hold:300');
  assert.deepEqual(counters(stored(world)), [2, 1, 0]);
  noViolations(world);
});

test('a second page that waited reads the run again once it holds the lock, so it scores the step the holder died in, not the one it saw first', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = (call) => {
    for (const name of ['wait', 'setup', runPhase('depth')]) call.phase(name);
    if (first.runner.calls.length > 1) first.kill();
  };
  await load(world, first);
  void first.engine.start('full', { levers: { ...LEVERS, rows: ['U1.survival.full'], runs: 2 }, levered: true });
  await world.advance(0);
  assert.equal(stored(world).inFlight?.stepKey, 'run-1');
  const second = world.open();
  const answer = second.engine.load();
  await world.advance(1_000);
  assert.equal(second.status?.kind, 'waiting-for-lock');
  first.runner.calls[0]?.phase(AFTER_PHASE);
  first.runner.calls[0]?.answer(SURVIVED);
  await world.advance(0);
  assert.equal(first.alive, false, 'the first page died in run-2');
  assert.deepEqual(await answer, { kind: 'done' });
  const rows = posted(world);
  assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:step-start', '5:load', '6:step-lost', '7:row-end', '8:done']);
  const lost = eventOf(rows, 'step-lost');
  assert.deepEqual([lost.stepKey, lost.attempt, lost.verdict, lost.phase], ['run-2', 1, 'killed', 'run:depth']);
  assert.equal(verdictText(eventOf(rows, 'row-end').verdict), '1 of 2, then killed in run:depth');
  assert.deepEqual(eventOf(inLoad(rows, 2), 'load').runnerLock, { kind: 'held', waitedMs: 1_000 });
  assert.deepEqual(counters(stored(world)), [2, 1, 0]);
  noViolations(world);
});

test('rows the holder stored while a second page waited for the lock stay in the outbox the second page writes', async () => {
  const world = new World();
  world.sinkStatus = 500;
  const first = await holding(world);
  const second = world.open();
  const answer = second.engine.load();
  await world.advance(1_000);
  first.runner.calls[0]?.phase(AFTER_PHASE);
  first.runner.calls[0]?.answer(HELD);
  await world.advance(0);
  assert.equal(first.status?.kind, 'done');
  assert.deepEqual(await answer, { kind: 'done' });
  assert.deepEqual(types(world.outboxRows()), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done', '6:load']);
  first.kill();
  world.sinkStatus = 200;
  await world.advance(30_000);
  assert.deepEqual(types(posted(world)), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done', '6:load']);
  noViolations(world);
});

test('a page left open at DONE flushes the outbox without erasing the rows of a run another page started since', async () => {
  const world = new World();
  world.sinkStatus = 500;
  const first = world.open();
  first.runner.auto = untouched(first);
  await load(world, first);
  await (await startUntouched(world, first)).run;
  const firstRun = stored(world).run;
  await world.advance(1_000);
  const second = world.open();
  second.runner.auto = untouched(second, { hangAt: 'hold:300' });
  assert.deepEqual(await load(world, second), { kind: 'done' });
  void second.engine.start('full', UNTOUCHED);
  await world.advance(0);
  const secondRun = stored(world).run;
  assert.notEqual(secondRun, firstRun);
  second.kill();
  world.sinkStatus = 200;
  await world.advance(30_000);
  const of = (run: string): readonly string[] => types(world.sink.filter((r) => r.run === run));
  assert.deepEqual(of(firstRun), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done', '6:load']);
  assert.deepEqual(of(secondRun), ['0:plan', '1:load', '2:step-start']);
  assert.deepEqual(world.outboxRows(), []);
  const third = world.open();
  assert.deepEqual(await load(world, third), { kind: 'done' });
  assert.equal(verdictText(eventOf(world.sink.filter((r) => r.run === secondRun), 'row-end').verdict), 'killed at 300 MB');
  noViolations(world);
});

test('a second page whose wait for the runner lock expires answers elsewhere and writes nothing, even once the lock is free', async () => {
  const world = new World();
  const first = await holding(world);
  const second = world.open();
  const answer = second.engine.load();
  await world.advance(LOCK_WAIT_MS - 1);
  assert.equal(second.status?.kind, 'waiting-for-lock');
  await world.advance(1);
  assert.deepEqual(await answer, { kind: 'elsewhere' });
  assert.equal(second.status !== undefined && statusText(second.status), 'Running in another tab');
  first.kill();
  await world.advance(5_000);
  assert.equal(writesBy(world, second), 0);
  assert.equal(world.locks.holder(RUNNER_LOCK), null);
  noViolations(world);
});

test('a second page answers elsewhere at once when the holder has no step in flight', async () => {
  const world = new World();
  const first = await holding(world);
  first.runner.calls[0]?.answer({ kind: 'blocked', reason: 'the sink is down' });
  first.setHidden(true);
  await world.advance(0);
  assert.equal(stored(world).inFlight, null);
  const second = world.open();
  assert.deepEqual(await load(world, second), { kind: 'elsewhere' });
  assert.deepEqual(world.locks.requests.at(-1), { page: second.name, ifAvailable: true, signal: false });
  assert.equal(writesBy(world, second), 0);
  noViolations(world);
});

test('without Web Locks the run goes on, and the load row says the runner lock was absent', async () => {
  const world = new World();
  world.checkLock = false;
  const first = world.open({ webLocks: false });
  first.runner.auto = untouched(first, { killAt: 'alloc:100' });
  await load(world, first);
  await startUntouched(world, first);
  const next = world.open({ webLocks: false });
  assert.deepEqual(await load(world, next), { kind: 'done' });
  const loadRow = eventOf(inLoad(posted(world), 2), 'load');
  assert.deepEqual([loadRow.webLocks, loadRow.runnerLock], [false, { kind: 'absent' }]);
  assert.deepEqual(world.locks.requests, []);
});

// ---------------------------------------------------------------------------
// Start and Stop

test('Start is refused, naming the rows, for a plan holding a row without a program, and nothing is written', async () => {
  const world = new World();
  const page = world.open();
  await load(world, page);
  await page.engine.start('full', { levers: LEVERS, levered: false });
  assert.deepEqual(page.status, { kind: 'refused', refusal: { kind: 'no-program', rows: missingPrograms(PLAN_ROWS.full) } });
  assert.match(page.status !== undefined ? statusText(page.status) : '', /^Start refused \(no-program\): U1\.headroom, /);
  assert.equal(writesBy(world, page), 0);
  assert.deepEqual(world.locks.requests, []);
  noViolations(world);
});

for (const webLocks of [true, false]) {
  test(`Start posts the load row of its own load right after the plan row: fresh, with the runner lock it took (${webLocks ? 'held at once' : 'absent'}) and the outbox's dropped count`, async () => {
    const world = new World();
    world.checkLock = webLocks;
    world.items.set(KEYS.outbox, '{"v":1,"dropped":3,"refused":0,"rows":[]}');
    const page = world.open({ webLocks });
    page.runner.auto = untouched(page);
    assert.deepEqual(await load(world, page), { kind: 'idle' });
    await (await startUntouched(world, page)).run;
    const rows = posted(world);
    assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done']);
    assert.deepEqual(eventOf(rows, 'load'), {
      type: 'load',
      tab: page.tab,
      environment: { kind: 'unavailable', reason: 'node' },
      navigatorStandalone: null,
      navigation: 'navigate',
      lockHash: 'a'.repeat(64),
      models: [],
      wakeLock: { kind: 'held' },
      webLocks,
      runnerLock: webLocks ? { kind: 'held', waitedMs: 0 } : { kind: 'absent' },
      verdict: 'fresh',
      outboxDropped: 3,
    });
    assert.ok(rows.every((r) => r.load === 1));
    assert.deepEqual(eventOf(rows, 'done'), { type: 'done', loads: 1, kills: 0, voids: 0 });
    assert.equal(stored(world).seq, 6);
    noViolations(world);
  });
}

/** Opens a page that starts a run and leaves it as `left` says, still alive and holding the runner lock. */
async function leaveRun(world: World, left: 'in flight' | 'between steps'): Promise<Page> {
  const other = world.open();
  await load(world, other);
  if (left === 'in flight') {
    other.runner.auto = untouched(other, { hangAt: 'hold:300' });
    await startUntouched(world, other);
    assert.equal(world.marker()?.phase, 'hold:300');
    return other;
  }
  void other.engine.start('full', { levers: { ...LEVERS, rows: ['U1.survival.full'], runs: 2 }, levered: true });
  await world.advance(0);
  // Hidden once the first run answers, the page begins no second step.
  other.setHidden(true);
  other.runner.calls[0]?.answer(SURVIVED);
  await world.advance(0);
  const plan = stored(world);
  assert.deepEqual([plan.inFlight, plan.cursor, world.marker()], [null, 0, null]);
  return other;
}

for (const left of ['in flight', 'between steps'] as const) {
  for (const when of ['loaded before that run began', 'loaded while that page held the lock'] as const) {
    test(`Start in a page ${when} refuses a run another page left unfinished with a step ${left}, writing nothing, and a reload ${left === 'in flight' ? 'scores the killed step, ending the run at DONE' : 'resumes the run to DONE'}`, async () => {
      const world = new World();
      const page = world.open();
      if (when === 'loaded before that run began') assert.deepEqual(await load(world, page), { kind: 'idle' });
      const other = await leaveRun(world, left);
      if (when === 'loaded while that page held the lock') {
        const answer = page.engine.load();
        await world.advance(left === 'in flight' ? LOCK_WAIT_MS : 0);
        assert.deepEqual(await answer, { kind: 'elsewhere' });
      }
      other.kill();
      const before = world.snapshot();
      const requests = world.locks.requests.length;
      // Not awaited: a Start that ran would wait on a runner nobody answers.
      void page.engine.start('full', UNTOUCHED);
      await world.advance(0);
      assert.deepEqual(page.status, { kind: 'refused', refusal: { kind: 'stored-run' } });
      assert.equal(page.status !== undefined && statusText(page.status), 'A run is stored here: reload the page to resume it.');
      assert.deepEqual(world.snapshot(), before, 'the plan, the marker, and the outbox are as the other page left them');
      assert.equal(writesBy(world, page), 0);
      assert.deepEqual(world.locks.requests.slice(requests), [{ page: page.name, ifAvailable: true, signal: false }]);
      assert.equal(world.locks.holder(RUNNER_LOCK), null, 'the refusal released the runner lock');
      assert.deepEqual([page.runner.calls.length, page.runner.released], [0, 0]);

      const next = world.open();
      if (left === 'in flight') {
        assert.deepEqual(await load(world, next), { kind: 'done' });
        const rows = inLoad(posted(world), 2);
        assert.deepEqual(types(rows).map((t) => t.split(':')[1]), ['load', 'step-lost', 'row-end', 'done']);
        assert.equal(eventOf(rows, 'load').verdict, 'killed');
        assert.deepEqual([eventOf(rows, 'step-lost').verdict, eventOf(rows, 'step-lost').phase], ['killed', 'hold:300']);
        assert.equal(verdictText(eventOf(rows, 'row-end').verdict), 'killed at 300 MB');
        assert.deepEqual(counters(stored(world)), [2, 1, 0]);
      } else {
        next.runner.auto = (call) => call.answer(SURVIVED);
        assert.deepEqual(await load(world, next), { kind: 'resume' });
        await next.engine.continue();
        const rows = inLoad(posted(world), 2);
        assert.deepEqual(types(rows).map((t) => t.split(':')[1]), ['load', 'step-start', 'step-end', 'row-end', 'done']);
        assert.equal(eventOf(rows, 'load').verdict, 'fresh');
        assert.equal(eventOf(rows, 'step-start').stepKey, 'run-2');
        assert.equal(verdictText(eventOf(rows, 'row-end').verdict), '2 of 2');
        assert.deepEqual(counters(stored(world)), [2, 0, 0]);
      }
      noViolations(world);
    });
  }
}

for (const [left, leave] of [
  ['a DONE run another page left since this page loaded', 'done'],
  ['a DONE run another page reached while this page waited for the lock at its load', 'done-waited'],
  ['a plan of another build stored since this page loaded', 'stale'],
  ['a plan that does not parse stored since this page loaded', 'unreadable'],
] as const) {
  test(`Start replaces ${left} with a new run of this build, posting its own load row`, async () => {
    const world = new World();
    const page = world.open();
    if (leave !== 'done-waited') assert.deepEqual(await load(world, page), { kind: 'idle' });
    let otherRun: string | null = null;
    if (leave === 'done' || leave === 'done-waited') {
      const other = await leaveRun(world, 'in flight');
      if (leave === 'done-waited') {
        const answer = page.engine.load();
        await world.advance(LOCK_WAIT_MS);
        assert.deepEqual(await answer, { kind: 'elsewhere' });
      }
      other.runner.calls[0]?.answer(HELD);
      await world.advance(0);
      assert.equal(other.status?.kind, 'done');
      otherRun = stored(world).run;
    } else {
      world.items.set(KEYS.plan, leave === 'stale' ? JSON.stringify({ ...planOf(['U1.untouched']), build: OTHER_BUILD }) : '{"v":1');
    }
    page.runner.auto = untouched(page);
    await page.engine.start('full', UNTOUCHED);
    assert.equal(page.status?.kind, 'done');
    const plan = stored(world);
    assert.notEqual(plan.run, otherRun);
    assert.notEqual(plan.run, planOf(['U1.untouched']).run);
    assert.deepEqual(counters(plan), [1, 0, 0]);
    const rows = world.sink.filter((r) => r.run === plan.run);
    assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done']);
    assert.deepEqual([eventOf(rows, 'load').tab, eventOf(rows, 'load').verdict, eventOf(rows, 'load').runnerLock], [page.tab, 'fresh', { kind: 'held', waitedMs: 0 }]);
    noViolations(world);
  });
}

test('Stop mid-step posts stopped, clears the plan and the marker, keeps the outbox, and releases the runner and the lock once it answers', async () => {
  const world = new World();
  world.sinkStatus = 500;
  const page = world.open();
  page.runner.auto = untouched(page, { hangAt: 'alloc:200' });
  await load(world, page);
  const { run } = await startUntouched(world, page);
  page.engine.stop();
  assert.equal(world.plan(), null);
  assert.equal(world.marker(), null);
  assert.deepEqual(types(world.outboxRows()), ['0:plan', '1:load', '2:step-start', '3:stopped']);
  assert.deepEqual(eventOf(world.outboxRows(), 'stopped'), { type: 'stopped', loads: 1, kills: 0, voids: 0 });
  const call = page.runner.calls[0];
  assert.equal(call?.signal.aborted, true);
  assert.equal(world.locks.holder(RUNNER_LOCK), page, 'held until the runner answers');
  call?.answer(HELD);
  await world.advance(0);
  await run;
  assert.equal(page.runner.released, 1);
  assert.equal(world.locks.holder(RUNNER_LOCK), null);
  assert.equal(world.plan(), null, 'the answer after Stop writes nothing');
  assert.equal(page.status?.kind, 'stopped');
  world.sinkStatus = 200;
  await world.advance(30_000);
  assert.deepEqual(types(posted(world)), ['0:plan', '1:load', '2:step-start', '3:stopped']);
  noViolations(world);
});

test('Start right after Stop in a step wait begins the new run at once', async () => {
  const world = new World();
  world.sinkHangs = true;
  const page = world.open();
  page.runner.auto = untouched(page);
  await load(world, page);
  const { run } = await startUntouched(world, page);
  const firstRun = stored(world).run;
  await world.advance(500);
  assert.equal(world.marker()?.phase, 'wait');
  page.engine.stop();
  await world.advance(0);
  await run;
  assert.equal(world.locks.holder(RUNNER_LOCK), null, 'the stopped run let go in its wait');
  const again = page.engine.start('full', UNTOUCHED);
  await world.advance(0);
  assert.notEqual(stored(world).run, firstRun);
  assert.equal(world.locks.holder(RUNNER_LOCK), page);
  // The post still hangs, so the new step's wait gives it its 2 s.
  await world.advance(STEP_START_POST_MS);
  await again;
  assert.notEqual(stored(world).run, firstRun);
  assert.equal(page.runner.calls.length, 1);
  assert.equal(page.status?.kind, 'done');
  assert.equal(world.locks.holder(RUNNER_LOCK), null);
  noViolations(world);
});

for (const webLocks of [true, false]) {
  test(`Start after Stop is ignored until the stopped step's runner answers, then begins the new run (${webLocks ? 'with' : 'without'} Web Locks)`, async () => {
    const world = new World();
    world.checkLock = webLocks;
    const page = world.open({ webLocks });
    page.runner.auto = untouched(page, { hangAt: 'alloc:200' });
    await load(world, page);
    const { run } = await startUntouched(world, page);
    page.engine.stop();
    await world.advance(0);
    const requests = world.locks.requests.length;
    const writes = writesBy(world, page);
    await page.engine.start('full', UNTOUCHED);
    assert.equal(page.status?.kind, 'stopped');
    assert.equal(world.locks.requests.length, requests);
    assert.equal(writesBy(world, page), writes);
    page.runner.calls[0]?.answer(HELD);
    await world.advance(0);
    await run;
    assert.equal(page.runner.released, 1);
    page.runner.auto = untouched(page);
    await page.engine.start('full', UNTOUCHED);
    assert.equal(page.runner.calls.length, 2);
    assert.equal(page.status?.kind, 'done');
    assert.equal(page.runner.released, 2);
    assert.deepEqual(eventOf(world.sink.filter((r) => r.run === stored(world).run), 'row-end').verdict, { kind: 'untouched', end: { kind: 'survived' } });
    noViolations(world);
  });
}

test('Stop at DONE changes nothing: the run is over, the plan stays, and no row is posted', async () => {
  const world = new World();
  const page = world.open();
  page.runner.auto = untouched(page);
  await load(world, page);
  await (await startUntouched(world, page)).run;
  const before = world.snapshot();
  const requests = world.locks.requests.length;
  page.engine.stop();
  await world.advance(30_000);
  assert.deepEqual(world.snapshot(), before);
  assert.equal(world.locks.requests.length, requests);
  assert.equal(page.status?.kind, 'done');
  assert.deepEqual(types(posted(world)), ['0:plan', '1:load', '2:step-start', '3:step-end', '4:row-end', '5:done']);
  noViolations(world);
});

// ---------------------------------------------------------------------------
// a death in a wait after a worker's termination

test('a death in a wait after a sequence step is folded into the step whose worker terminated, and the next step waits its cooldown', async () => {
  const world = new World();
  const first = world.open();
  first.runner.auto = (call) => {
    if (first.runner.calls.length === 1) {
      for (const name of ['wait', 'setup', runPhase('depth'), runPhase('encode')]) call.phase(name);
      return;
    }
    call.phase('wait');
    first.kill();
  };
  await load(world, first);
  const levers = { ...LEVERS, rows: ['U1.survival.full', 'U1.survival.low'] as const, runs: 2 };
  void first.engine.start('full', { levers: { ...levers, rows: [...levers.rows] }, levered: true });
  await world.advance(5_000);
  const run1 = first.runner.calls[0];
  run1?.phase(AFTER_PHASE);
  await world.advance(500);
  run1?.answer(SURVIVED);
  await world.advance(0);
  assert.equal(first.alive, false);
  const waiting: StepMarker | null = world.marker();
  assert.deepEqual(waiting?.waitingOut, {
    row: 'U1.survival.full',
    stepKey: 'run-1',
    step: run1?.step,
    load: 1,
    stage: 'encode',
    terminatedAtWall: T0 + 5_000,
  });
  await world.advance(1_000);

  const next = world.open();
  assert.deepEqual(await load(world, next), { kind: 'resume' });
  const lost = eventOf(posted(world), 'step-lost');
  assert.deepEqual([lost.verdict, lost.attributedTo], ['died-after-terminate', { row: 'U1.survival.full', stepKey: 'run-1', sinceTerminateMs: 500 }]);
  assert.equal(verdictText(eventOf(posted(world), 'row-end').verdict), '0 of 2, then died-after-terminate');
  void next.engine.continue();
  await world.advance(COOLDOWN_MS.encode - 1);
  assert.equal(next.runner.calls.length, 0, 'the first step after the load waits the dead step cooldown');
  assert.equal(world.marker()?.phase, 'wait');
  await world.advance(1);
  assert.equal(next.runner.calls.length, 1);
  assert.equal(next.runner.calls[0]?.step.kind, 'sequence');
  assert.deepEqual(counters(stored(world)).slice(0, 2), [2, 1]);
  noViolations(world);
});

// ---------------------------------------------------------------------------
// the untouched program and the phase names

test('the untouched phases round-trip, and other phases name no size', () => {
  for (const phase of [{ kind: 'alloc', mb: 100 }, { kind: 'hold', mb: 1500 }] as const) assert.deepEqual(parseUntouchedPhase(untouchedPhase(phase)), phase);
  for (const name of ['wait', 'setup', 'after', 'unknown', 'alloc:0', 'alloc:', 'hold:-5', 'fill:100', 'run:depth']) assert.equal(parseUntouchedPhase(name), null, name);
  assert.equal(stageOfPhase(runPhase('inpaint')), 'inpaint');
  assert.equal(stageOfPhase('run:decode'), null);
});

test('the untouched program runs one step of the untouchedMb lever and reads survived, killed at N MB, and throw at N MB', () => {
  const plan = planOf(['U1.untouched']);
  const state = plan.rows[0]?.state;
  assert.equal(state?.family, 'untouched');
  if (state?.family !== 'untouched') return;
  const ctx = { load: 1, encode: { kind: 'none-survived' }, ceilingMb: 0, ascentCapMb: null, probe: null, levers: { ...LEVERS, untouchedMb: 700 } } as const;
  const planned = untouchedProgram.next(state, ctx);
  assert.deepEqual(planned, { key: 'untouched', step: { kind: 'untouched', mb: 700 } });
  if (planned === null) return;
  const text = (outcome: Parameters<typeof untouchedProgram.fold>[2]): string => {
    const folded = untouchedProgram.fold(state, planned, outcome);
    assert.equal(untouchedProgram.next(folded, ctx), null);
    return verdictText(untouchedProgram.verdict(folded));
  };
  assert.equal(text({ kind: 'held', mb: 700, chunks: 7, checksums: [], fillMs: 0 }), 'survived');
  assert.equal(text({ kind: 'killed', phase: 'alloc:400', markerAgeMs: 1, aliveAgeMs: 1, hiddenMs: 0 }), 'killed at 400 MB');
  assert.equal(text({ kind: 'killed', phase: 'hold:700', markerAgeMs: 1, aliveAgeMs: 1, hiddenMs: 0 }), 'killed at 700 MB');
  assert.equal(text({ kind: 'killed', phase: 'setup', markerAgeMs: 1, aliveAgeMs: 1, hiddenMs: 0 }), 'killed in setup');
  assert.equal(text({ kind: 'throw', atMb: 600, message: 'RangeError' }), 'throw at 600 MB');
  if (SURVIVED.kind === 'ran') assert.equal(untouchedProgram.fold(state, planned, SURVIVED), state, 'a sequence outcome is not an untouched one');
  assert.equal(verdictText(untouchedProgram.verdict(state)), 'not run');
});
