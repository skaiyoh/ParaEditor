// src/dev/harness/runner.ts: the memory page's runner over node's timers.
// The untouched step allocating in chunks, holding, and releasing, with every
// buffer it was handed left untouched; Stop's abort while it allocates and
// while it holds; the throwAtMb lever and an allocation that throws. The
// ballast step at 1 MB and 100 MB chunks: each step of the ladder allocating
// and filling only its new chunk, its checksums against the independent
// recomputation, the ballast held from step to step and past the ladder's
// last step, kept below a throw with the lever at, just below, and just above
// a step's size, dropped by Stop in the fill and in the hold, and by release()
// mid-row and at the row's end; the second kill-point row after the first;
// a step run again, the last one and one that threw included. Every step
// reports its wait first. The steps it rejects, and the rows the page
// refuses to start because no executor runs them; test/harness-sequence.test.ts
// drives the sequence executor.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock } from '../src/platform/clock.ts';
import { MB } from '../src/dev/harness/ballast.ts';
import type { Levers } from '../src/dev/harness/context.ts';
import type { Step } from '../src/dev/harness/steps.ts';
import type { StepOutcome } from '../src/dev/harness/rows.ts';
import { createRunner, unexecutedRows, type Holding } from '../src/dev/harness/runner.ts';
import { referenceSum } from './support/ballast-reference.ts';
import { inputsWorld } from './support/harness-service.ts';
import { LEVERS } from './fixtures/harness.ts';

const clock: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'> = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => Number(setTimeout(callback, ms)),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** 10 MB in chunks of 3 MB, held for 10 ms. */
const SMALL: Levers = { ...LEVERS, rows: ['U1.untouched'], chunkMb: 3, defaultsScale: 0.002 };
const STEP: Step = { kind: 'untouched', mb: 10 };
const ABORTED: StepOutcome = { kind: 'blocked', reason: 'aborted by Stop' };

/** The sequence dependencies of a runner that runs no sequence. */
const NO_SEQUENCES = {
  service: () => {
    throw new Error('this test runs no sequence');
  },
  inputs: inputsWorld(clock).inputs,
};

/**
 * A runner whose allocations are recorded and handed out as proxies that
 * record every touch: a read, a write, or any other look at the buffer.
 */
function world(levers: Levers | null, options: { readonly allocateThrowsAt?: number } = {}) {
  const allocated: number[] = [];
  const touches: string[] = [];
  const seen: Holding[] = [];
  const handler: ProxyHandler<Uint8Array> = {
    get: (_target, key) => void touches.push(`get ${String(key)}`),
    set: (_target, key) => {
      touches.push(`set ${String(key)}`);
      return true;
    },
    has: (_target, key) => {
      touches.push(`has ${String(key)}`);
      return false;
    },
    ownKeys: () => {
      touches.push('ownKeys');
      return [];
    },
  };
  const runner = createRunner({
    clock,
    levers: () => levers,
    allocate: (bytes) => {
      if (allocated.length + 1 === options.allocateThrowsAt) throw new RangeError('Array buffer allocation failed');
      allocated.push(bytes);
      return new Proxy(new Uint8Array(0), handler);
    },
    onHolding: (holding) => seen.push(holding),
    ...NO_SEQUENCES,
  });
  return { runner, allocated, touches, seen };
}

/** Executes `step`, recording its phases; `onPhase` may abort the step through the controller it is handed. */
async function execute(
  runner: ReturnType<typeof world>['runner'],
  step: Step,
  onPhase: (name: string, controller: AbortController) => void = () => undefined,
): Promise<{ readonly outcome: StepOutcome; readonly phases: readonly string[] }> {
  const controller = new AbortController();
  const phases: string[] = [];
  const outcome = await runner.execute(
    step,
    (name) => {
      phases.push(name);
      onPhase(name, controller);
    },
    controller.signal,
    () => ({ load: 1, hiddenMs: 0, longestHiddenMs: 0 }),
  );
  return { outcome, phases };
}

test('the untouched step allocates its megabytes in chunks, reporting each total first, holds them, then drops them and answers held, never touching a buffer', async () => {
  const { runner, allocated, touches, seen } = world(SMALL);
  const { outcome, phases } = await execute(runner, STEP);
  assert.deepEqual(phases, ['wait', 'alloc:3', 'alloc:6', 'alloc:9', 'alloc:10', 'hold:10']);
  assert.deepEqual(allocated, [3 * MB, 3 * MB, 3 * MB, 1 * MB]);
  assert.deepEqual(outcome, { kind: 'held', mb: 10, chunks: 4, checksums: [], fillMs: 0 });
  assert.deepEqual(seen, [
    { chunks: 1, mb: 3 },
    { chunks: 2, mb: 6 },
    { chunks: 3, mb: 9 },
    { chunks: 4, mb: 10 },
    { chunks: 0, mb: 0 },
  ]);
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
  assert.deepEqual(touches, []);
});

test('Stop while the step allocates allocates no chunk after the one under way, drops what it holds, and answers blocked without holding', async () => {
  const { runner, allocated, touches } = world(SMALL);
  const { outcome, phases } = await execute(runner, STEP, (name, controller) => {
    if (name === 'alloc:6') controller.abort();
  });
  assert.deepEqual(outcome, ABORTED);
  assert.deepEqual(phases, ['wait', 'alloc:3', 'alloc:6']);
  assert.deepEqual(allocated, [3 * MB, 3 * MB]);
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
  assert.deepEqual(touches, []);
});

test('Stop during the hold drops the chunks at once and answers blocked', async () => {
  const { runner } = world({ ...SMALL, defaultsScale: 100 });
  const started = Date.now();
  const { outcome, phases } = await execute(runner, STEP, (name, controller) => {
    if (name === 'hold:10') setTimeout(() => controller.abort(), 0);
  });
  assert.deepEqual(outcome, ABORTED);
  assert.equal(phases.at(-1), 'hold:10');
  assert.ok(Date.now() - started < 1_000, 'the 500 s hold ended at the abort');
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
});

test('the throwAtMb lever makes the allocation that reaches it throw: the step answers throw at that total and holds nothing', async () => {
  const { runner, allocated } = world({ ...SMALL, throwAtMb: 5 });
  const { outcome, phases } = await execute(runner, STEP);
  assert.deepEqual(phases, ['wait', 'alloc:3', 'alloc:6']);
  assert.deepEqual(allocated, [3 * MB]);
  assert.ok(outcome.kind === 'throw' && outcome.atMb === 6 && outcome.message.includes('throwAtMb'), JSON.stringify(outcome));
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
});

test('an allocation that throws ends the step throw at the total it would have reached, with its message', async () => {
  const { runner } = world(SMALL, { allocateThrowsAt: 3 });
  const { outcome } = await execute(runner, STEP);
  assert.deepEqual(outcome, { kind: 'throw', atMb: 9, message: 'Array buffer allocation failed' });
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
});

test('a step no executor runs, and a step handed over with no run\'s levers, reject naming why', async () => {
  const sequence = { kind: 'sequence', stages: ['depth'], master: { width: 2048, height: 1536 }, hole: null, condition: { standIn: true, gl: 'full', ballastMb: 0, decoder: 'none' }, threads: 2, wait: { kind: 'cooldown', scale: 1 }, decode: 'none', after: { gl: null, openDecoder: false } } as const;
  await assert.rejects(execute(world(SMALL).runner, sequence), /^Error: no executor runs a sequence step with a GL ballast yet$/);
  await assert.rejects(execute(world(null).runner, STEP), /^Error: the runner was handed a step with no run to take its levers from$/);
});

test('the rows the page refuses to start are those no executor runs, and none when the plan\'s own refusals come first', () => {
  assert.deepEqual(unexecutedRows('full', { ...LEVERS, rows: ['U1.untouched'] }), []);
  assert.deepEqual(unexecutedRows('full', { ...LEVERS, rows: ['U1.untouched', 'U1.killpoint', 'U1.killpoint.after'] }), []);
  assert.deepEqual(unexecutedRows('short', { ...LEVERS, rows: ['U1.killpoint', 'U1.killpoint.after'] }), []);
  assert.deepEqual(unexecutedRows('full', { ...LEVERS, rows: ['U1.untouched', 'U1.panorama'] }), ['U1.panorama']);
  assert.deepEqual(unexecutedRows('full', { ...LEVERS, rows: ['U1.survival.full', 'U1.survival.low', 'U1.survival.none'] }), ['U1.survival.full', 'U1.survival.low']);
  assert.deepEqual(unexecutedRows('short', { ...LEVERS, rows: ['U1.survival.full'] }), ['U1.survival.full']);
  assert.deepEqual(unexecutedRows('short', { ...LEVERS, rows: ['U1.untouched'] }), [], 'a row outside the plan kind');
  assert.deepEqual(unexecutedRows('full', LEVERS), [], 'rows with no program');
});

// ---------------------------------------------------------------------------
// the ballast step

/** The kill-point ladder at 1 MB chunks up to a 5 MB ceiling, each hold 2 ms. */
const LADDER: Levers = { ...LEVERS, rows: ['U1.killpoint'], chunkMb: 1, ceilingMb: 5, defaultsScale: 0.001 };
const ballastStep = (mb: number): Step => ({ kind: 'ballast', mb, release: 'all' });

/** A runner whose allocations are real buffers, each recorded with its size in MB. */
function ballastWorld(levers: Levers, options: { readonly allocateThrowsAt?: number } = {}) {
  const allocated: number[] = [];
  const seen: Holding[] = [];
  const runner = createRunner({
    clock,
    levers: () => levers,
    allocate: (bytes) => {
      if (allocated.length + 1 === options.allocateThrowsAt) throw new RangeError('Array buffer allocation failed');
      allocated.push(bytes / MB);
      return new Uint8Array(bytes);
    },
    onHolding: (holding) => seen.push(holding),
    ...NO_SEQUENCES,
  });
  return { runner, allocated, seen };
}

/** The checksum pairs of chunks 0 to n - 1 of `chunkMb`, each sum the reference's, unchanged since the fill. */
const pairs = (n: number, chunkMb: number) => Array.from({ length: n }, (_, chunk) => ({ chunk, fill: referenceSum(chunk, chunkMb * MB), after: referenceSum(chunk, chunkMb * MB) }));

/** `outcome` with its fill time checked and set to 0. */
function timeless(outcome: StepOutcome): StepOutcome {
  if (outcome.kind !== 'held') return outcome;
  assert.ok(outcome.fillMs >= 0, String(outcome.fillMs));
  return { ...outcome, fillMs: 0 };
}

test('each ladder step allocates and fills only its new chunk, reporting fill then hold, sums every chunk, and holds it into the next step and past the last, until release()', async () => {
  const { runner, allocated, seen } = ballastWorld(LADDER);
  for (let mb = 1; mb <= 5; mb += 1) {
    const before = allocated.length;
    const { outcome, phases } = await execute(runner, ballastStep(mb));
    assert.deepEqual(phases, ['wait', `fill:${mb}`, `hold:${mb}`], `step ${mb}`);
    assert.deepEqual(allocated.slice(before), [1], `step ${mb}: one new chunk of 1 MB`);
    assert.deepEqual(timeless(outcome), { kind: 'held', mb, chunks: mb, checksums: pairs(mb, 1), fillMs: 0 }, `step ${mb}`);
    assert.deepEqual(runner.holding, { chunks: mb, mb }, `step ${mb}: held into the next step`);
  }
  runner.release();
  assert.deepEqual(seen, [...[1, 2, 3, 4, 5].map((mb) => ({ chunks: mb, mb })), { chunks: 0, mb: 0 }], 'release() at the row\'s end drops it');
});

test('at 100 MB chunks each step allocates one chunk of 100,000,000 bytes, and the checksums are the recomputation\'s', async () => {
  const levers: Levers = { ...LADDER, chunkMb: 100, ceilingMb: 300 };
  const { runner, allocated } = ballastWorld(levers);
  for (const mb of [100, 200, 300]) {
    const { outcome } = await execute(runner, ballastStep(mb));
    assert.deepEqual(timeless(outcome), { kind: 'held', mb, chunks: mb / 100, checksums: pairs(mb / 100, 100), fillMs: 0 }, `step ${mb}`);
  }
  assert.deepEqual([allocated, runner.holding], [[100, 100, 100], { chunks: 3, mb: 300 }]);
});

test('release() mid-row drops the ballast, and the next step grows it again from nothing, each chunk filled anew', async () => {
  const { runner, allocated } = ballastWorld(LADDER);
  await execute(runner, ballastStep(1));
  await execute(runner, ballastStep(2));
  runner.release();
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
  const { outcome, phases } = await execute(runner, ballastStep(3));
  assert.deepEqual(phases, ['wait', 'fill:1', 'fill:2', 'fill:3', 'hold:3']);
  assert.deepEqual(allocated, [1, 1, 1, 1, 1]);
  assert.deepEqual(timeless(outcome), { kind: 'held', mb: 3, chunks: 3, checksums: pairs(3, 1), fillMs: 0 });
});

test('a step run again in the same load, the ladder\'s last step included, allocates nothing and sums the chunks it holds', async () => {
  const { runner, allocated } = ballastWorld(LADDER);
  for (const mb of [1, 2, 3]) await execute(runner, ballastStep(mb));
  const again = await execute(runner, ballastStep(3));
  assert.deepEqual([again.phases, allocated.length, runner.holding], [['wait', 'hold:3'], 3, { chunks: 3, mb: 3 }], 'the rerun of 3 MB allocated nothing');
  assert.deepEqual(again.outcome, { kind: 'held', mb: 3, chunks: 3, checksums: pairs(3, 1), fillMs: 0 });
  for (const mb of [4, 5]) await execute(runner, ballastStep(mb));
  const top = await execute(runner, ballastStep(5));
  assert.deepEqual([top.phases, allocated.length, runner.holding], [['wait', 'hold:5'], 5, { chunks: 5, mb: 5 }], 'the rerun of the last step allocated nothing');
  assert.deepEqual(top.outcome, { kind: 'held', mb: 5, chunks: 5, checksums: pairs(5, 1), fillMs: 0 });
});

test('the second kill-point row\'s first step keeps the first chunk the first row left and drops the rest, and its next step fills one new chunk', async () => {
  const { runner, allocated } = ballastWorld(LADDER);
  for (const mb of [1, 2, 3, 4, 5]) await execute(runner, ballastStep(mb));
  const first = await execute(runner, ballastStep(1));
  assert.deepEqual([first.phases, allocated.length, runner.holding], [['wait', 'hold:1'], 5, { chunks: 1, mb: 1 }]);
  assert.deepEqual(first.outcome, { kind: 'held', mb: 1, chunks: 1, checksums: pairs(1, 1), fillMs: 0 });
  const second = await execute(runner, ballastStep(2));
  assert.deepEqual([second.phases, allocated.length, runner.holding], [['wait', 'fill:2', 'hold:2'], 6, { chunks: 2, mb: 2 }]);
  assert.deepEqual(timeless(second.outcome), { kind: 'held', mb: 2, chunks: 2, checksums: pairs(2, 1), fillMs: 0 });
});

test('the throwAtMb lever at a step\'s size, at 1 MB chunks, makes that step throw and keeps the chunks below it; at 100 MB chunks a lever just below a step\'s size refuses that step, and just above it the next', async () => {
  for (const [throwAtMb, throwsAt] of [
    [3, 3],
    [2, 2],
    [4, 4],
  ] as const) {
    const levers: Levers = { ...LADDER, throwAtMb };
    const { runner } = ballastWorld(levers);
    let outcome: StepOutcome | null = null;
    let mb = 0;
    while (outcome?.kind !== 'throw' && mb < 5) {
      mb += 1;
      outcome = (await execute(runner, ballastStep(mb))).outcome;
    }
    assert.deepEqual(outcome, { kind: 'throw', atMb: throwsAt, message: `the throwAtMb lever refuses the allocation that brings the total to ${throwsAt} MB` }, `throwAtMb ${throwAtMb}`);
    assert.deepEqual(runner.holding, { chunks: throwsAt - 1, mb: throwsAt - 1 }, `throwAtMb ${throwAtMb}`);
  }
  for (const [throwAtMb, throwsAt] of [
    [199, 200],
    [200, 200],
    [201, 300],
  ] as const) {
    const hundred = ballastWorld({ ...LADDER, chunkMb: 100, ceilingMb: 400, throwAtMb });
    const outcomes: StepOutcome[] = [];
    for (let mb = 100; mb <= throwsAt; mb += 100) outcomes.push((await execute(hundred.runner, ballastStep(mb))).outcome);
    assert.deepEqual(outcomes.map((o) => o.kind), [...Array.from({ length: throwsAt / 100 - 1 }, () => 'held'), 'throw'], `throwAtMb ${throwAtMb}`);
    assert.deepEqual(outcomes.at(-1), { kind: 'throw', atMb: throwsAt, message: `the throwAtMb lever refuses the allocation that brings the total to ${throwsAt} MB` }, `throwAtMb ${throwAtMb}`);
    assert.deepEqual([hundred.allocated.length, hundred.runner.holding], [throwsAt / 100 - 1, { chunks: throwsAt / 100 - 1, mb: throwsAt - 100 }], `throwAtMb ${throwAtMb}: the refused chunk was never allocated`);
  }
});

test('an allocation the browser refuses ends the step throw at the total it would have reached, keeping the chunks below it', async () => {
  const { runner } = ballastWorld(LADDER, { allocateThrowsAt: 3 });
  await execute(runner, ballastStep(1));
  await execute(runner, ballastStep(2));
  assert.deepEqual((await execute(runner, ballastStep(3))).outcome, { kind: 'throw', atMb: 3, message: 'Array buffer allocation failed' });
  assert.deepEqual(runner.holding, { chunks: 2, mb: 2 });
});

test('a throw the engine voids and runs again in the same load allocates only the refused chunk, never the chunks below it, which keep their sums; the next step\'s setup or release() drops them', async () => {
  const { runner, allocated } = ballastWorld({ ...LADDER, throwAtMb: 4 });
  for (const mb of [1, 2, 3]) await execute(runner, ballastStep(mb));
  const thrown = await execute(runner, ballastStep(4));
  const again = await execute(runner, ballastStep(4));
  const refused = { kind: 'throw', atMb: 4, message: 'the throwAtMb lever refuses the allocation that brings the total to 4 MB' };
  assert.deepEqual([thrown.outcome, thrown.phases, again.outcome, again.phases], [refused, ['wait', 'fill:4'], refused, ['wait', 'fill:4']]);
  assert.deepEqual([allocated.length, runner.holding], [3, { chunks: 3, mb: 3 }], 'the rerun allocated nothing below the step');
  const below = await execute(runner, ballastStep(3));
  assert.deepEqual([below.outcome, allocated.length], [{ kind: 'held', mb: 3, chunks: 3, checksums: pairs(3, 1), fillMs: 0 }, 3], 'the chunks kept after the throw hold the sums they were filled with');
  const first = await execute(runner, ballastStep(1));
  assert.deepEqual([first.phases, runner.holding], [['wait', 'hold:1'], { chunks: 1, mb: 1 }], 'the next row\'s first step truncates it');
  runner.release();
  assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
});

test('Stop while the ballast grows fills no chunk after the one under way, and Stop in the hold ends it at once; each drops the ballast and answers blocked', async () => {
  const growing = ballastWorld(LADDER);
  const grown = await execute(growing.runner, ballastStep(4), (name, controller) => {
    if (name === 'fill:2') controller.abort();
  });
  assert.deepEqual([grown.outcome, grown.phases, growing.allocated, growing.runner.holding], [ABORTED, ['wait', 'fill:1', 'fill:2'], [1, 1], { chunks: 0, mb: 0 }]);
  const holding = ballastWorld({ ...LADDER, defaultsScale: 100 });
  const started = Date.now();
  const held = await execute(holding.runner, ballastStep(1), (name, controller) => {
    if (name === 'hold:1') setTimeout(() => controller.abort(), 0);
  });
  assert.deepEqual([held.outcome, held.phases.at(-1), holding.runner.holding], [ABORTED, 'hold:1', { chunks: 0, mb: 0 }]);
  assert.ok(Date.now() - started < 1_000, 'the 200 s hold ended at the abort');
});

test('the untouched step drops a ballast the runner holds before it allocates', async () => {
  const { runner } = ballastWorld({ ...LADDER, untouchedMb: 2 });
  await execute(runner, ballastStep(1));
  const { phases } = await execute(runner, { kind: 'untouched', mb: 2 }, (name) => {
    if (name === 'alloc:1') assert.deepEqual(runner.holding, { chunks: 0, mb: 0 });
  });
  assert.deepEqual([phases, runner.holding], [['wait', 'alloc:1', 'alloc:2', 'hold:2'], { chunks: 0, mb: 0 }]);
});
