// src/dev/harness/liveness.ts and wake-lock.ts through the engine, over the
// fake origin of test/support/harness-world.ts: every death verdict (a kill,
// a death in a wait after a worker's termination, a death with no worker
// draining, a page reclaimed while hidden, a lost marker) posts one liveness
// row and its two late rows, with the dead tab's app-shaped marker present
// and absent, and removes that marker; no other verdict (fresh, left, hidden,
// after completion, applied earlier, stale) posts one; the dead tab's lock
// held, pending, and free at the load, 2 s, and 10 s, and held with the dead
// page's runner lock, read before the load waits for that lock, and read
// again after the wait when the holder wrote the run during it; a reload
// before the late rows were due; the late rows never delaying a step; the tab
// lock held for the page's life; the app-shaped marker's own life; an engine
// built without the liveness dependency; and the wake lock granted, refused,
// absent, released by the browser, requested again when the page turns
// visible and by Start before its first await and by a tap, a refusal or a
// grant that answers while a lock is held, and released at DONE, at Stop, and
// by a Start that fails before its run begins.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TabId } from '../src/core/ids.ts';
import { AFTER_PHASE, RUNNER_LOCK, runPhase, type LeverChoice } from '../src/dev/harness/engine.ts';
import { HIDDEN_GRACE_MS, LIVENESS_LATE_MS } from '../src/dev/harness/lines.ts';
import { APP_MARKER_PREFIX, appMarkerKey, opOf, sceneOf, tabLockName, type AppMarker } from '../src/dev/harness/liveness.ts';
import { completeStep, planStateSchema, type PlanState } from '../src/dev/harness/plan.ts';
import type { Step } from '../src/dev/harness/steps.ts';
import type { HarnessEvent, HarnessRow, StepOutcome } from '../src/dev/harness/rows.ts';
import { begin, BUILD, LEVERS, markerFor, OTHER_BUILD, planOf, RUN, SURVIVED, T0, TAB } from './fixtures/harness.ts';
import { KEYS, World, type Page, type PageOptions, type RunnerCall } from './support/harness-world.ts';

const MB = 300;
const UNTOUCHED: LeverChoice = { levers: { ...LEVERS, rows: ['U1.untouched'], untouchedMb: MB }, levered: true };
const PHASES = ['setup', 'alloc:100', 'alloc:200', 'alloc:300', 'hold:300', AFTER_PHASE];
const HELD: StepOutcome = { kind: 'held', mb: MB, chunks: 3, checksums: [], fillMs: 0 };
const LIVE: PageOptions = { liveness: true };
const FREE = { kind: 'read', held: false, pending: false } as const;

function untouched(page: Page, options: { readonly hangAt?: string } = {}): (call: RunnerCall) => void {
  return (call) => {
    for (const name of PHASES) {
      call.phase(name);
      if (name === options.hangAt) return;
    }
    call.answer(HELD);
  };
}

async function load(world: World, page: Page): Promise<void> {
  void page.engine.load();
  await world.advance(0);
}

async function startUntouched(world: World, page: Page): Promise<void> {
  void page.engine.start('full', UNTOUCHED);
  await world.advance(0);
}

/** The sink's rows, deduped by rowId, in seq order: late rows reach the sink after rows with higher seqs. */
function rowsBySeq(world: World): readonly HarnessRow[] {
  const unique = new Map<string, HarnessRow>();
  for (const row of world.sink) if (!unique.has(row.rowId)) unique.set(row.rowId, row);
  return [...unique.values()].sort((a, b) => a.seq - b.seq);
}

const types = (rows: readonly HarnessRow[]): readonly string[] => rows.map((r) => `${r.seq}:${r.event.type}`);

function events<T extends HarnessEvent['type']>(rows: readonly HarnessRow[], type: T): Extract<HarnessEvent, { readonly type: T }>[] {
  return rows.map((r) => r.event).filter((e): e is Extract<HarnessEvent, { readonly type: T }> => e.type === type);
}

const livenessRows = (world: World): readonly HarnessRow[] => rowsBySeq(world).filter((r) => r.event.type === 'liveness' || r.event.type === 'liveness-late');

function stored(world: World): PlanState {
  const plan = world.plan();
  if (plan === null) throw new Error('no plan is stored');
  return plan;
}

function appMarker(world: World, tab: TabId): unknown {
  const text = world.items.get(appMarkerKey(tab));
  return text === undefined ? null : JSON.parse(text);
}

function noViolations(world: World): void {
  assert.deepEqual(world.violations, [], 'no page wrote the harness keys without the runner lock');
}

/** Advances past both late readings and checks the late rows: seqs right after the liveness row's, at 2 s and 10 s. */
async function lateRows(world: World, liveness: HarnessRow, locks: readonly [unknown, unknown] = [FREE, FREE]): Promise<void> {
  if (liveness.event.type !== 'liveness') throw new Error('not a liveness row');
  const deadTab = liveness.event.deadTab;
  const lateOf = (): readonly HarnessRow[] => rowsBySeq(world).filter((r) => r.event.type === 'liveness-late');
  await world.advance(LIVENESS_LATE_MS[0] - 1);
  assert.deepEqual(lateOf(), [], 'no late row before 2 s');
  await world.advance(1);
  assert.equal(lateOf().length, 1, 'the 2 s row at 2 s');
  await world.advance(LIVENESS_LATE_MS[1] - LIVENESS_LATE_MS[0]);
  const late = lateOf();
  assert.deepEqual(
    late.map((r) => [r.seq, r.load, r.run, r.event]),
    [
      [liveness.seq + 1, liveness.load, liveness.run, { type: 'liveness-late', deadTab, afterMs: 2_000, lock: locks[0] }],
      [liveness.seq + 2, liveness.load, liveness.run, { type: 'liveness-late', deadTab, afterMs: 10_000, lock: locks[1] }],
    ],
  );
}

/** The late rows under `liveness`'s reserved seqs, as [seq, afterMs, deadTab, lock]. */
function lateOf(world: World, liveness: HarnessRow): readonly unknown[] {
  return rowsBySeq(world)
    .filter((r) => r.seq === liveness.seq + 1 || r.seq === liveness.seq + 2)
    .map((r) => (r.event.type === 'liveness-late' ? [r.seq, r.event.afterMs, r.event.deadTab, r.event.lock] : [r.seq, r.event.type]));
}

/** Starts the untouched plan on a page with the liveness dependency, lets `kill` kill it, and loads a second page over the same storage. */
async function deathAndLoad(kill: (page: Page) => void, options: PageOptions = LIVE): Promise<{ readonly world: World; readonly first: Page; readonly next: Page }> {
  const world = new World();
  const first = world.open(options);
  kill(first);
  await load(world, first);
  await startUntouched(world, first);
  assert.equal(first.alive, false, 'the first page died');
  await world.advance(700);
  const next = world.open(options);
  next.runner.auto = untouched(next);
  await load(world, next);
  return { world, first, next };
}

// ---------------------------------------------------------------------------
// the app-shaped marker

test('the scene id is the run id written as a UUID v4, and the op is the first stage or the step kind', () => {
  assert.equal(sceneOf(RUN), '20261003-1200-4000-8bee-f00000000000');
  assert.equal(sceneOf(RUN), sceneOf(RUN));
  assert.notEqual(sceneOf('20261003T120000Z-beee'), sceneOf(RUN));
  assert.throws(() => sceneOf('not a run'), /is not a run id/);
  const sequence = begin(planOf(['U1.survival.full'])).planned.step;
  if (sequence.kind !== 'sequence') throw new Error('a survival row runs sequence steps');
  const steps: readonly [Step, string][] = [
    [{ kind: 'untouched', mb: 10 }, 'untouched'],
    [{ kind: 'ballast', mb: 8, release: 'all' }, 'ballast'],
    [sequence, 'depth'],
    [{ ...sequence, stages: ['inpaint'] }, 'inpaint'],
  ];
  for (const [step, op] of steps) assert.equal(opOf(step), op);
  assert.equal(appMarkerKey(TAB), `noisy.harness.job.${TAB}.heavy`);
  assert.ok(!APP_MARKER_PREFIX.startsWith('noisy.job.'));
  assert.equal(tabLockName(TAB), `noisy-tab-${TAB}`);
});

test('the app-shaped marker is written right after the step marker, holds hiddenAt while hidden, and goes when the step ends', async () => {
  const world = new World();
  const page = world.open(LIVE);
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  await startUntouched(world, page);
  const key = appMarkerKey(page.tab);
  const keys = world.writes.filter((w) => w.value !== '').map((w) => w.key).filter((k) => k === KEYS.step || k === key);
  assert.deepEqual(keys.slice(0, 2), [KEYS.step, key], 'the step marker first, then the app-shaped marker');
  const plan = stored(world);
  const expected: AppMarker = { scene: sceneOf(plan.run), op: 'untouched', build: BUILD, tab: page.tab, startedAt: T0, hiddenAt: null };
  assert.deepEqual(appMarker(world, page.tab), expected);
  await world.advance(1_000);
  page.setHidden(true);
  assert.deepEqual(appMarker(world, page.tab), { ...expected, hiddenAt: T0 + 1_000 });
  await world.advance(1_000);
  page.setHidden(false);
  assert.deepEqual(appMarker(world, page.tab), expected, 'visible again clears hiddenAt, as the app does inside its grace');
  page.runner.calls[0]?.phase(AFTER_PHASE);
  page.runner.calls[0]?.answer(HELD);
  await world.advance(0);
  assert.equal(appMarker(world, page.tab), null, 'the step ended');
  assert.equal(page.status?.kind, 'done');
  noViolations(world);
});

test('pagehide and Stop each remove the app-shaped marker', async () => {
  for (const end of ['pagehide', 'stop'] as const) {
    const world = new World();
    const page = world.open(LIVE);
    page.runner.auto = untouched(page, { hangAt: 'hold:300' });
    await load(world, page);
    await startUntouched(world, page);
    assert.notEqual(appMarker(world, page.tab), null, end);
    if (end === 'pagehide') page.pagehide();
    else page.engine.stop();
    assert.equal(appMarker(world, page.tab), null, end);
    noViolations(world);
  }
});

// ---------------------------------------------------------------------------
// every death verdict

test('a kill posts one liveness row with the dead tab, the marker that survived, and the lock free, then the late rows, and removes the marker', async () => {
  let dead: AppMarker | null = null;
  const { world, first, next } = await deathAndLoad((page) => {
    page.runner.auto = (call) => {
      untouched(page, { hangAt: 'hold:300' })(call);
      const text = page.world.items.get(appMarkerKey(page.tab));
      dead = text === undefined ? null : JSON.parse(text);
      page.kill();
    };
  });
  const rows = rowsBySeq(world);
  assert.deepEqual(types(rows.filter((r) => r.load === 2)), ['3:load', '4:step-lost', '5:row-end', '6:liveness', '9:done']);
  const [liveness] = rows.filter((r) => r.event.type === 'liveness');
  assert.ok(liveness !== undefined && dead !== null);
  assert.deepEqual(liveness.event, { type: 'liveness', killIndex: 1, deadTab: first.tab, appMarker: { survived: true, value: dead }, lockAtLoad: FREE });
  assert.equal(events(rows, 'load')[1]?.verdict, 'killed');
  assert.equal(appMarker(world, first.tab), null, "the dead tab's marker is removed");
  assert.equal(stored(world).deaths, 1);
  assert.equal(next.status?.kind, 'done');
  await lateRows(world, liveness);
  assert.equal(livenessRows(world).length, 3, 'one liveness row and two late rows');
  noViolations(world);
});

test('a death in a wait with no worker draining, with the marker written and with it not yet written, posts its liveness row', async () => {
  for (const [after, survived] of [
    ['the app-shaped marker', true],
    ['the step marker', false],
  ] as const) {
    const { world, first } = await deathAndLoad((page) =>
      page.killAfterWrite((key, value) => value !== '' && key === (after === 'the step marker' ? KEYS.step : appMarkerKey(page.tab))),
    );
    const rows = rowsBySeq(world);
    assert.equal(events(rows, 'load')[1]?.verdict, 'died-idle', after);
    const [liveness] = rows.filter((r) => r.event.type === 'liveness');
    assert.ok(liveness?.event.type === 'liveness', after);
    assert.deepEqual([liveness.event.deadTab, liveness.event.appMarker.survived, liveness.event.lockAtLoad], [first.tab, survived, FREE], after);
    if (!survived) assert.equal(liveness.event.appMarker.value, null, after);
    assert.equal(appMarker(world, first.tab), null, after);
    await lateRows(world, liveness);
    assert.equal(livenessRows(world).length, 3, `${after}: one liveness row and two late rows`);
    noViolations(world);
  }
});

test('a page reclaimed while hidden posts its liveness row, the marker holding when it was hidden', async () => {
  const { world, first } = await deathAndLoad((page) => {
    page.runner.auto = (call) => {
      untouched(page, { hangAt: 'alloc:200' })(call);
      page.setHidden(true);
      page.kill();
    };
  });
  const rows = rowsBySeq(world);
  assert.equal(events(rows, 'load')[1]?.verdict, 'background');
  const [liveness] = events(rows, 'liveness');
  const value: unknown = liveness?.appMarker.value;
  assert.ok(typeof value === 'object' && value !== null && 'hiddenAt' in value);
  assert.deepEqual([liveness?.deadTab, liveness?.appMarker.survived, value.hiddenAt], [first.tab, true, T0]);
  assert.equal(appMarker(world, first.tab), null);
  const [row] = rows.filter((r) => r.event.type === 'liveness');
  assert.ok(row !== undefined);
  await lateRows(world, row);
  assert.equal(livenessRows(world).length, 3, 'one liveness row and two late rows');
  noViolations(world);
});

test('a lost marker posts its liveness row with the dead tab from the plan and no marker', async () => {
  const { world, first } = await deathAndLoad((page) => page.killAfterWrite((key, value) => key === KEYS.plan && planStateSchema.parse(JSON.parse(value)).inFlight !== null));
  const rows = rowsBySeq(world);
  assert.equal(events(rows, 'load')[1]?.verdict, 'marker-lost');
  assert.deepEqual(events(rows, 'liveness'), [{ type: 'liveness', killIndex: 1, deadTab: first.tab, appMarker: { survived: false, value: null }, lockAtLoad: FREE }]);
  const [row] = rows.filter((r) => r.event.type === 'liveness');
  assert.ok(row !== undefined);
  await lateRows(world, row);
  assert.equal(livenessRows(world).length, 3, 'one liveness row and two late rows');
  noViolations(world);
});

test('a death in a wait after a worker terminated posts its liveness row, and a second death is kill index 2', async () => {
  const world = new World();
  const first = world.open(LIVE);
  first.runner.auto = (call) => {
    if (first.runner.calls.length === 1) {
      for (const name of ['wait', 'setup', runPhase('depth'), runPhase('encode'), AFTER_PHASE]) call.phase(name);
      call.answer(SURVIVED);
      return;
    }
    call.phase('wait');
    first.kill();
  };
  await load(world, first);
  void first.engine.start('full', { levers: { ...LEVERS, rows: ['U1.survival.full', 'U1.survival.low'], runs: 2 }, levered: true });
  await world.advance(0);
  assert.equal(first.alive, false);
  const second = world.open(LIVE);
  second.runner.auto = (call) => {
    call.phase('setup');
    call.phase(runPhase('depth'));
    second.kill();
  };
  await load(world, second);
  assert.equal(events(rowsBySeq(world), 'load')[1]?.verdict, 'died-after-terminate');
  assert.deepEqual(
    events(rowsBySeq(world), 'liveness').map((e) => [e.killIndex, e.deadTab, e.appMarker.survived]),
    [[1, first.tab, true]],
  );
  void second.engine.continue();
  await world.advance(30_000);
  assert.equal(second.alive, false, 'the second page was killed in its run');
  const third = world.open(LIVE);
  await load(world, third);
  const rows = rowsBySeq(world);
  assert.equal(events(rows, 'load')[2]?.verdict, 'killed');
  assert.deepEqual(
    events(rows, 'liveness').map((e) => [e.killIndex, e.deadTab, e.appMarker.survived]),
    [
      [1, first.tab, true],
      [2, second.tab, true],
    ],
  );
  assert.equal(stored(world).deaths, 2);
  await world.advance(LIVENESS_LATE_MS[1]);
  const reports = rowsBySeq(world).filter((r) => r.event.type === 'liveness');
  assert.equal(reports.length, 2, 'one liveness row for each death');
  for (const [report, tab] of [
    [reports[0], first.tab],
    [reports[1], second.tab],
  ] as const) {
    assert.ok(report !== undefined);
    assert.deepEqual(lateOf(world, report), [
      [report.seq + 1, 2_000, tab, FREE],
      [report.seq + 2, 10_000, tab, FREE],
    ]);
  }
  noViolations(world);
});

// ---------------------------------------------------------------------------
// no other verdict

test('a fresh Start, a page left, and a step hidden past the grace post no liveness row', async () => {
  // Left: pagehide, then the page goes.
  const left = await deathAndLoad((page) => {
    page.runner.auto = (call) => {
      untouched(page, { hangAt: 'alloc:200' })(call);
      page.pagehide();
      page.kill();
    };
  });
  // Hidden: hidden past the grace, visible again, and killed visible.
  const hidden = { world: new World() };
  const hiddenFirst = hidden.world.open(LIVE);
  hiddenFirst.runner.auto = untouched(hiddenFirst, { hangAt: 'alloc:200' });
  await load(hidden.world, hiddenFirst);
  await startUntouched(hidden.world, hiddenFirst);
  hiddenFirst.setHidden(true);
  await hidden.world.advance(HIDDEN_GRACE_MS + 1);
  hiddenFirst.setHidden(false);
  hiddenFirst.kill();
  await load(hidden.world, hidden.world.open(LIVE));
  for (const [world, verdict, deadTab] of [
    [left.world, 'left', left.first.tab],
    [hidden.world, 'hidden', hiddenFirst.tab],
  ] as const) {
    await world.advance(15_000);
    const rows = rowsBySeq(world);
    assert.ok(events(rows, 'load').some((e) => e.verdict === verdict), verdict);
    assert.deepEqual(livenessRows(world), [], verdict);
    assert.equal(appMarker(world, deadTab), null, `${verdict}: no app-shaped marker of the dead page is left`);
    assert.equal(stored(world).deaths, 0, verdict);
  }
  // Fresh: Start's own load.
  const world = new World();
  const page = world.open(LIVE);
  page.runner.auto = untouched(page);
  await load(world, page);
  await startUntouched(world, page);
  await world.advance(15_000);
  assert.deepEqual(events(rowsBySeq(world), 'load').map((e) => e.verdict), ['fresh']);
  assert.deepEqual(livenessRows(world), []);
});

test('a death after the step was saved, and a marker a later load applied, post no liveness row but remove the dead tab marker', async () => {
  const deadTab = TAB;
  for (const verdict of ['after-completion', 'applied-earlier'] as const) {
    const begun = begin(planOf(['U1.survival.full'], 2));
    const saved = completeStep(begun.plan, SURVIVED, T0).plan;
    const plan: PlanState = verdict === 'after-completion' ? saved : { ...saved, loads: 2 };
    const world = new World();
    world.items.set(KEYS.plan, JSON.stringify(plan));
    world.items.set(KEYS.step, JSON.stringify(markerFor(begun.plan, begun.planned, { tab: deadTab, phase: 'after', load: 1 })));
    world.items.set(appMarkerKey(deadTab), JSON.stringify({ scene: sceneOf(RUN), op: 'depth', build: BUILD, tab: deadTab, startedAt: T0, hiddenAt: null }));
    const page = world.open(LIVE);
    await load(world, page);
    await world.advance(15_000);
    assert.deepEqual(
      events(rowsBySeq(world), 'load').map((e) => e.verdict),
      [verdict === 'after-completion' ? 'after-completion' : 'fresh'],
      verdict,
    );
    assert.deepEqual(livenessRows(world), [], verdict);
    assert.equal(appMarker(world, deadTab), null, verdict);
    assert.equal(stored(world).deaths, 0, verdict);
  }
});

test('a stale plan posts nothing and leaves storage as it was', async () => {
  const world = new World();
  world.items.set(KEYS.plan, JSON.stringify({ ...planOf(['U1.survival.full']), build: OTHER_BUILD }));
  world.items.set(appMarkerKey(TAB), '{}');
  const page = world.open(LIVE);
  await load(world, page);
  await world.advance(15_000);
  assert.equal(page.status?.kind, 'stale');
  assert.deepEqual([world.sink, appMarker(world, TAB)], [[], {}]);
});

// ---------------------------------------------------------------------------
// the dead tab's lock, the late rows, and the tab lock

test("the dead tab's lock read held and pending at the load, held at 2 s, and free at 10 s", async () => {
  const world = new World();
  const first = world.open(LIVE);
  first.runner.auto = (call) => {
    untouched(first, { hangAt: 'hold:300' })(call);
    first.kill([tabLockName(first.tab)]);
  };
  await load(world, first);
  await startUntouched(world, first);
  const name = tabLockName(first.tab);
  assert.equal(world.locks.holder(name), first, 'the dead page still holds its tab lock');
  // A third page asks for the dead tab's lock, so a request for it is pending.
  const waiter = world.open();
  let letGo: () => void = () => undefined;
  void world.locks.view(waiter).request(name, {}, () => new Promise<void>((resolve) => (letGo = resolve)));
  const next = world.open(LIVE);
  await load(world, next);
  const [liveness] = rowsBySeq(world).filter((r) => r.event.type === 'liveness');
  assert.ok(liveness?.event.type === 'liveness');
  assert.deepEqual(liveness.event.lockAtLoad, { kind: 'read', held: true, pending: true });
  // At 1 s the browser lets the dead page's lock go, and the waiting page takes it.
  await world.advance(1_000);
  world.locks.release(name);
  await world.advance(0);
  assert.equal(world.locks.holder(name), waiter);
  // After the 2 s reading, the waiting page lets go too.
  await world.advance(1_500);
  letGo();
  await world.advance(0);
  assert.equal(world.locks.holder(name), null);
  await world.advance(7_500);
  const late = events(rowsBySeq(world), 'liveness-late');
  assert.deepEqual(
    late.map((e) => [e.afterMs, e.lock]),
    [
      [2_000, { kind: 'read', held: true, pending: false }],
      [10_000, FREE],
    ],
  );
});

test("a browser that keeps a dead page's locks: its tab lock reads held at the load, before the wait for its runner lock", async () => {
  for (const releaseAfterMs of [3_000, null]) {
    const world = new World();
    const first = world.open(LIVE);
    first.runner.auto = (call) => {
      untouched(first, { hangAt: 'hold:300' })(call);
      first.kill([tabLockName(first.tab), RUNNER_LOCK]);
    };
    await load(world, first);
    await startUntouched(world, first);
    assert.equal(world.locks.holder(RUNNER_LOCK), first, 'the dead page still holds the runner lock');
    const next = world.open(LIVE);
    await load(world, next);
    assert.equal(next.status?.kind, 'waiting-for-lock');
    if (releaseAfterMs === null) {
      // Kept past LOCK_WAIT_MS: the page cannot tell the dead page from a live one, applies nothing, and posts nothing.
      await world.advance(15_000);
      assert.equal(next.status?.kind, 'elsewhere');
      assert.deepEqual(events(rowsBySeq(world), 'load').length, 1, "only the first page's load row");
      assert.deepEqual(livenessRows(world), []);
      continue;
    }
    await world.advance(releaseAfterMs);
    world.locks.release(tabLockName(first.tab));
    world.locks.release(RUNNER_LOCK);
    await world.advance(0);
    const rows = rowsBySeq(world);
    assert.deepEqual(events(rows, 'load')[1]?.runnerLock, { kind: 'held', waitedMs: releaseAfterMs });
    const [liveness] = rows.filter((r) => r.event.type === 'liveness');
    assert.ok(liveness?.event.type === 'liveness');
    assert.deepEqual(liveness.event.lockAtLoad, { kind: 'read', held: true, pending: false }, 'read at the load, not after the wait');
    assert.deepEqual(lateOf(world, liveness), [[liveness.seq + 1, 2_000, first.tab, { kind: 'read', held: true, pending: false }]], 'the 2 s reading, taken before the release, posted with the load');
    await world.advance(LIVENESS_LATE_MS[1] - releaseAfterMs);
    assert.deepEqual(lateOf(world, liveness), [
      [liveness.seq + 1, 2_000, first.tab, { kind: 'read', held: true, pending: false }],
      [liveness.seq + 2, 10_000, first.tab, FREE],
    ]);
    noViolations(world);
  }
});

test("a page still alive when the load waited for its runner lock, killed during the wait: its tab lock is read after the wait, not held from before", async () => {
  const world = new World();
  const first = world.open(LIVE);
  first.runner.auto = untouched(first, { hangAt: 'hold:300' });
  await load(world, first);
  await startUntouched(world, first);
  assert.equal(first.alive, true, 'the first page is alive, in its step');
  const next = world.open(LIVE);
  await load(world, next);
  assert.equal(next.status?.kind, 'waiting-for-lock');
  // The first page is alive for 3 s of the wait, its heartbeat rewriting its marker, then killed, which lets both its locks go.
  await world.advance(3_000);
  assert.equal(world.locks.holder(tabLockName(first.tab)), first);
  first.kill();
  await world.advance(0);
  const rows = rowsBySeq(world);
  assert.deepEqual(events(rows, 'load')[1]?.runnerLock, { kind: 'held', waitedMs: 3_000 });
  const [liveness] = rows.filter((r) => r.event.type === 'liveness');
  assert.ok(liveness?.event.type === 'liveness');
  assert.deepEqual(liveness.event.lockAtLoad, FREE, 'read once the lock was held, after the page that was alive died');
  await lateRows(world, liveness);
  noViolations(world);
});

test('a reload before the late rows were due posts no late row, leaves their seqs a gap, and the next load posts no liveness row', async () => {
  const { world, next } = await deathAndLoad((page) => {
    page.runner.auto = (call) => {
      untouched(page, { hangAt: 'hold:300' })(call);
      page.kill();
    };
  });
  const [liveness] = rowsBySeq(world).filter((r) => r.event.type === 'liveness');
  assert.ok(liveness !== undefined);
  await world.advance(1_000);
  next.pagehide();
  next.kill();
  const third = world.open(LIVE);
  await load(world, third);
  await world.advance(20_000);
  const rows = rowsBySeq(world);
  assert.deepEqual(events(rows, 'liveness-late'), []);
  assert.deepEqual(
    rows.filter((r) => r.seq === liveness.seq + 1 || r.seq === liveness.seq + 2),
    [],
    'the reserved seqs are the gap readers flag',
  );
  assert.equal(events(rows, 'liveness').length, 1, 'the third load posts none');
  assert.ok(rows.some((r) => r.seq > liveness.seq + 2), 'later rows go on after the gap');
});

test('the late rows never delay a step: the voided step reruns and completes before the 2 s row', async () => {
  const { world, next } = await deathAndLoad((page) => page.killAfterWrite((key) => key === appMarkerKey(page.tab)));
  void next.engine.continue();
  await world.advance(0);
  assert.equal(next.runner.calls.length, 1, 'the rerun began at the load');
  assert.equal(next.status?.kind, 'done', 'and ended');
  const before = rowsBySeq(world);
  assert.deepEqual(events(before, 'liveness-late'), []);
  const [liveness] = before.filter((r) => r.event.type === 'liveness');
  assert.ok(liveness !== undefined);
  const after = before.filter((r) => r.seq > liveness.seq);
  assert.deepEqual(
    after.map((r) => r.event.type),
    ['step-start', 'step-end', 'row-end', 'done'],
  );
  assert.equal(after[0]?.seq, liveness.seq + 3, 'the step rows follow the reserved seqs');
  await lateRows(world, liveness);
  noViolations(world);
});

test('the tab lock is taken at the load and held for the page life, through DONE, until the page dies', async () => {
  const world = new World();
  const page = world.open(LIVE);
  page.runner.auto = untouched(page);
  await load(world, page);
  assert.equal(world.locks.holder(tabLockName(page.tab)), page, 'held from the load');
  await startUntouched(world, page);
  assert.equal(page.status?.kind, 'done');
  await world.advance(60_000);
  assert.equal(world.locks.holder(tabLockName(page.tab)), page, 'held at DONE');
  page.kill();
  assert.equal(world.locks.holder(tabLockName(page.tab)), null);
});

test('without Web Locks the liveness row reads absent and no tab lock is asked for', async () => {
  const options: PageOptions = { liveness: true, webLocks: false };
  const { world } = await (async () => {
    const w = new World();
    w.checkLock = false;
    const first = w.open(options);
    first.runner.auto = (call) => {
      untouched(first, { hangAt: 'hold:300' })(call);
      first.kill();
    };
    await load(w, first);
    await startUntouched(w, first);
    const next = w.open(options);
    await load(w, next);
    return { world: w };
  })();
  const [liveness] = rowsBySeq(world).filter((r) => r.event.type === 'liveness');
  assert.ok(liveness?.event.type === 'liveness');
  assert.deepEqual(liveness.event.lockAtLoad, { kind: 'absent' });
  await lateRows(world, liveness, [{ kind: 'absent' }, { kind: 'absent' }]);
  assert.deepEqual(world.locks.requests, []);
});

test('an engine without the liveness dependency takes no tab lock, writes no app-shaped marker, and posts no liveness row', async () => {
  const { world, first, next } = await deathAndLoad(
    (page) => {
      page.runner.auto = (call) => {
        untouched(page, { hangAt: 'hold:300' })(call);
        page.kill();
      };
    },
    {},
  );
  await world.advance(15_000);
  const rows = rowsBySeq(world);
  assert.deepEqual(types(rows), ['0:plan', '1:load', '2:step-start', '3:load', '4:step-lost', '5:row-end', '6:done']);
  assert.ok(!world.writes.some((w) => w.key.startsWith(APP_MARKER_PREFIX)));
  assert.equal(world.locks.holder(tabLockName(first.tab)), null);
  assert.equal(world.locks.holder(tabLockName(next.tab)), null);
  assert.ok(world.locks.requests.every((r) => r.ifAvailable || r.signal), 'only the runner lock was asked for');
  noViolations(world);
});

// ---------------------------------------------------------------------------
// the wake lock

test('the wake lock granted at the load is in the load row, Start does not ask again, and DONE releases it', async () => {
  const world = new World();
  const page = world.open();
  page.runner.auto = untouched(page);
  await load(world, page);
  assert.deepEqual([page.wakeLock.requests, page.wakeStates], [1, [{ kind: 'held' }]]);
  await startUntouched(world, page);
  assert.equal(page.status?.kind, 'done');
  const rows = rowsBySeq(world);
  assert.deepEqual(events(rows, 'load')[0]?.wakeLock, { kind: 'held' });
  assert.deepEqual(events(rows, 'wake-lock'), []);
  assert.deepEqual([page.wakeLock.requests, page.wakeLock.releasedByPage, page.wakeLock.holding, page.wakeStates.at(-1)], [1, 1, false, null]);
  // After DONE the page does not ask again when it turns visible.
  page.setHidden(true);
  page.setHidden(false);
  await world.advance(0);
  assert.equal(page.wakeLock.requests, 1);
});

test('without the wake lock API every answer is unsupported, in the load row', async () => {
  const world = new World();
  const page = world.open({ noWakeLock: true });
  page.runner.auto = untouched(page);
  await load(world, page);
  await startUntouched(world, page);
  assert.deepEqual(events(rowsBySeq(world), 'load')[0]?.wakeLock, { kind: 'unsupported' });
  assert.deepEqual(page.wakeStates, [{ kind: 'unsupported' }, { kind: 'unsupported' }, null]);
});

test('Start requests the wake lock before its first await, and a refusal is in its load row', async () => {
  const world = new World();
  const page = world.open();
  page.wakeLock.answer = 'refuse';
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  assert.deepEqual(page.wakeStates, [{ kind: 'refused', name: 'NotAllowedError' }]);
  assert.equal(page.wakeLock.requests, 1);
  void page.engine.start('full', UNTOUCHED);
  assert.equal(page.wakeLock.requests, 2, 'asked synchronously, inside the tap that called Start');
  await world.advance(0);
  assert.deepEqual(events(rowsBySeq(world), 'load')[0]?.wakeLock, { kind: 'refused', name: 'NotAllowedError' });
});

test('a refused wake lock is asked again when the page turns visible and by a tap, each answer in a wake-lock row', async () => {
  const world = new World();
  const page = world.open();
  page.wakeLock.answer = 'refuse';
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  await startUntouched(world, page);
  page.setHidden(true);
  page.setHidden(false);
  await world.advance(0);
  page.wakeLock.answer = 'grant';
  const answer = page.engine.requestWakeLock();
  assert.equal(page.wakeLock.requests, 4, 'the tap asked before it returned');
  assert.deepEqual(await answer, { kind: 'held' });
  await world.advance(0);
  const rows = rowsBySeq(world);
  assert.deepEqual(
    events(rows, 'wake-lock').map((e) => e.state),
    [{ kind: 'refused', name: 'NotAllowedError' }, { kind: 'held' }],
  );
  assert.ok(rows.every((r) => r.load === 1));
  page.engine.stop();
  assert.deepEqual([page.wakeLock.releasedByPage, page.wakeStates.at(-1)], [1, null], 'Stop releases it');
  noViolations(world);
});

/** Asserts the page released the wake lock its load was granted, and asks for none when it turns visible again. */
async function wakeReleased(world: World, page: Page): Promise<void> {
  assert.deepEqual([page.wakeLock.requests, page.wakeLock.releasedByPage, page.wakeLock.holding, page.wakeStates.at(-1)], [1, 1, false, null]);
  page.setHidden(true);
  page.wakeLock.releaseByBrowser();
  page.setHidden(false);
  await world.advance(0);
  assert.equal(page.wakeLock.requests, 1, 'not asked again once the page is visible');
}

test('a Start whose plan write throws twice enters failed and releases the wake lock', async () => {
  const world = new World();
  const page = world.open();
  await load(world, page);
  page.failWrites(KEYS.plan, 2);
  await startUntouched(world, page);
  assert.match(page.status?.kind === 'failed' ? page.status.reason : '', /^the plan could not be written: The quota has been exceeded/);
  await wakeReleased(world, page);
});

test('a Start that rejects enters failed and releases the wake lock', async () => {
  const world = new World();
  let throwOnEnqueue = false;
  const page = world.open({
    wrapOutbox: (outbox) => ({
      enqueue: (row) => {
        if (throwOnEnqueue) throw new Error('the outbox threw');
        outbox.enqueue(row);
      },
      flush: () => outbox.flush(),
      makeRoom: () => outbox.makeRoom(),
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
  await load(world, page);
  throwOnEnqueue = true;
  await startUntouched(world, page);
  assert.equal(page.status?.kind === 'failed' ? page.status.reason : '', 'Start failed: the outbox threw');
  await wakeReleased(world, page);
});

test('a wake lock the browser releases is recorded, and asked for again when the page is visible', async () => {
  const world = new World();
  const page = world.open();
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  await startUntouched(world, page);
  page.setHidden(true);
  page.wakeLock.releaseByBrowser();
  await world.advance(500);
  page.setHidden(false);
  await world.advance(0);
  // Visible while held asks nothing.
  page.setHidden(true);
  page.setHidden(false);
  await world.advance(0);
  assert.equal(page.wakeLock.requests, 2);
  assert.deepEqual(
    events(rowsBySeq(world), 'wake-lock').map((e) => e.state),
    [{ kind: 'released' }, { kind: 'held' }],
  );
  noViolations(world);
});

test('a refusal that answers after a later request was granted leaves the lock held, and a tap then asks nothing', async () => {
  const world = new World();
  const page = world.open();
  page.wakeLock.answer = 'refuse';
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  await startUntouched(world, page);
  // Visible again, its request slow to answer; a tap meanwhile is granted.
  page.wakeLock.answer = 'later';
  page.setHidden(true);
  page.setHidden(false);
  page.wakeLock.answer = 'grant';
  assert.deepEqual(await page.engine.requestWakeLock(), { kind: 'held' });
  page.wakeLock.waiting[0]?.refuse();
  await world.advance(0);
  assert.deepEqual(page.wakeStates.at(-1), { kind: 'held' });
  assert.deepEqual(await page.engine.requestWakeLock(), { kind: 'held' });
  assert.equal(page.wakeLock.requests, 4, 'the load, Start, visible again, and the first tap; the second tap asked nothing');
  // A grant that answers while a lock is held is given back and changes nothing.
  page.wakeLock.answer = 'later';
  page.wakeLock.releaseByBrowser();
  page.setHidden(true);
  page.setHidden(false);
  page.wakeLock.answer = 'grant';
  assert.deepEqual(await page.engine.requestWakeLock(), { kind: 'held' });
  page.wakeLock.waiting[1]?.grant();
  await world.advance(0);
  assert.equal(page.wakeLock.holding, true);
  assert.deepEqual(
    events(rowsBySeq(world), 'wake-lock').map((e) => e.state),
    [{ kind: 'held' }, { kind: 'released' }, { kind: 'held' }],
  );
  noViolations(world);
});

test('a wake-lock release that runs before visibilitychange records the page hidden in both markers first, so a page killed before the event runs is background', async () => {
  const world = new World();
  const page = world.open(LIVE);
  page.runner.auto = untouched(page, { hangAt: 'hold:300' });
  await load(world, page);
  await startUntouched(world, page);
  await world.advance(500);
  // Hidden, its lock released, and killed before the event's task runs.
  page.setHidden(true, false);
  page.wakeLock.releaseByBrowser();
  await world.advance(0);
  const marker = world.items.get(KEYS.step);
  assert.ok(marker !== undefined);
  assert.deepEqual([JSON.parse(marker).visibility, JSON.parse(marker).hiddenSinceWall], ['hidden', T0 + 500]);
  const app = appMarker(world, page.tab);
  assert.ok(typeof app === 'object' && app !== null && 'hiddenAt' in app && app.hiddenAt === T0 + 500, 'the app-shaped marker holds when it was hidden');
  page.kill();
  const next = world.open(LIVE);
  await load(world, next);
  const rows = rowsBySeq(world);
  assert.deepEqual(
    rows.filter((r) => r.load === 1 && r.event.type === 'wake-lock').map((r) => r.event),
    [{ type: 'wake-lock', state: { kind: 'released' } }],
  );
  assert.equal(events(rows, 'load')[1]?.verdict, 'background');
  noViolations(world);
});

test('a page with no run records its answers for the page alone, with no row', async () => {
  const world = new World();
  const page = world.open();
  page.wakeLock.answer = 'refuse';
  await load(world, page);
  page.setHidden(true);
  page.setHidden(false);
  await world.advance(0);
  assert.deepEqual(page.wakeStates.length, 2);
  assert.deepEqual([world.sink, world.items.get(KEYS.plan)], [[], undefined]);
});
