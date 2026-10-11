// src/dev/harness/sequence-run.ts, inputs.ts, and the runner's sequence
// executor and reconciliation, over the real analysis service on scripted
// worker ports and node's timers: a [depth, encode] run reporting wait,
// setup, run:depth, run:encode, and after, once its sequence is complete while
// its worker remains resident, and its reading, every available field; the
// cooldown from the latest completion record, the setup after it, and worker
// lifetime metrics unavailable without a new spawn or termination; the
// stand-in filled once, held across runs, summed after each, and released by
// a step that does not keep it and by release(); the kill-point ballast gone
// before a sequence runs; the cooldown before ballast and untouched steps
// after a run; a timeout, a worker failure, an error event, and Stop in the
// wait and in the run; a master fetch that fails, then recovers after the
// retry time, waited in the setup phase once the cooldown has ended, and a
// model fetch that fails; the cooldown after an encoder that failed before
// inference; the wait's arithmetic at the
// defaultsScale lever's 1 and 0.01, and its end on a clock whose timers fire
// early; the setup's time; a timeout timer cleared when the run ends; a second
// thread count's service; and the inputs on their own.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { ParsedLock } from '../src/analysis/lock.ts';
import { err, ok } from '../src/core/result.ts';
import type { Clock } from '../src/platform/clock.ts';
import { MB, STAND_IN_CHUNK } from '../src/dev/harness/ballast.ts';
import type { StepFacts } from '../src/dev/harness/engine.ts';
import { INPUT_TIMEOUT_MS, masterUrl } from '../src/dev/harness/inputs.ts';
import { COOLDOWN_MS } from '../src/dev/harness/lines.ts';
import type { Levers } from '../src/dev/harness/context.ts';
import type { StepOutcome } from '../src/dev/harness/rows.ts';
import { BLOCKED_RETRY_MS, createRunner, keptFor, RELEASE_ORDER, unbuiltCondition, type Holding } from '../src/dev/harness/runner.ts';
import { ABORTED, waitMsAfter, waitOut, type SequenceStep } from '../src/dev/harness/sequence-run.ts';
import type { Step } from '../src/dev/harness/steps.ts';
import { referenceSum } from './support/ballast-reference.ts';
import { HIGH_WATER, inputsWorld, readLock, serviceWorld, type ServiceWorld } from './support/harness-service.ts';
import { LEVERS } from './fixtures/harness.ts';

let lock: ParsedLock;
before(async () => {
  lock = await readLock();
});

const clock: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'> = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => Number(setTimeout(callback, ms)),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** The cooldown scale the tests run at: the encoder's 20 s default becomes 100 ms. */
const SCALE = 0.005;
/** 1 MB chunks and stand-in, short waits. */
const SMALL: Levers = { ...LEVERS, rows: ['U1.survival.none'], runs: 2, chunkMb: 1, defaultsScale: SCALE };
const MASTER = { width: 8, height: 6 } as const;

/** A survival run as the runs program makes it, at the test's small master. */
const RUN: SequenceStep = {
  kind: 'sequence',
  stages: ['depth', 'encode'],
  master: MASTER,
  hole: null,
  condition: { standIn: true, gl: 'none', ballastMb: 0, decoder: 'none' },
  threads: 2,
  wait: { kind: 'cooldown', scale: SCALE },
  decode: 'none',
  after: { gl: null, openDecoder: false },
};

const STAND_IN_SUM = (mb: number): number => referenceSum(STAND_IN_CHUNK, mb * MB);

type Phase = { readonly name: string; readonly at: number; readonly holding: Holding; readonly terminated: readonly boolean[] };

function world(levers: Levers = SMALL) {
  const services: ServiceWorld = serviceWorld(clock, lock);
  const inputs = inputsWorld(clock);
  const allocated: number[] = [];
  let facts: StepFacts = { load: 1, hiddenMs: 0, longestHiddenMs: 0 };
  const runner = createRunner({
    clock,
    levers: () => levers,
    allocate: (bytes) => {
      allocated.push(bytes / MB);
      return new Uint8Array(bytes);
    },
    service: services.service,
    inputs: inputs.inputs,
  });
  /** Executes `step`, recording each phase with the time, what the runner held, and which ports were terminated. */
  const execute = async (step: Step, onPhase: (name: string, controller: AbortController) => void = () => undefined): Promise<{ readonly outcome: StepOutcome; readonly phases: readonly Phase[] }> => {
    const controller = new AbortController();
    const phases: Phase[] = [];
    const outcome = await runner.execute(
      step,
      (name) => {
        phases.push({ name, at: clock.now(), holding: runner.holding, terminated: services.ports.map((port) => port.terminated) });
        onPhase(name, controller);
      },
      controller.signal,
      () => facts,
    );
    return { outcome, phases };
  };
  return {
    runner,
    services,
    inputs,
    allocated,
    execute,
    setFacts: (next: StepFacts) => {
      facts = next;
    },
  };
}

const names = (phases: readonly Phase[]): string[] => phases.map((phase) => phase.name);
const at = (phases: readonly Phase[], name: string): Phase => {
  const found = phases.find((phase) => phase.name === name);
  if (found === undefined) throw new Error(`no ${name} phase in ${names(phases).join(', ')}`);
  return found;
};

function ran(outcome: StepOutcome): Extract<StepOutcome, { readonly kind: 'ran' }> {
  if (outcome.kind !== 'ran') throw new Error(`expected a run, got ${JSON.stringify(outcome)}`);
  return outcome;
}

test('a [depth, encode] run reports wait, setup, run:depth, run:encode, and after with its worker resident, and survives with a reading of every available field', async () => {
  const w = world();
  w.setFacts({ load: 3, hiddenMs: 1_200, longestHiddenMs: 900 });
  const { outcome, phases } = await w.execute(RUN);
  assert.deepEqual(names(phases), ['wait', 'setup', 'run:depth', 'run:encode', 'after']);
  assert.deepEqual(at(phases, 'run:encode').terminated, [false], 'the worker is alive while the encoder runs');
  assert.deepEqual(at(phases, 'after').terminated, [false], 'after is reported once the sequence ends, retaining its worker');
  const { score, reading } = ran(outcome);
  assert.deepEqual(score, { kind: 'survived' });
  assert.deepEqual(reading.stages.map((stage) => [stage.op, stage.wasmHighWaterBytes]), [
    ['depth', HIGH_WATER.depth],
    ['encode', HIGH_WATER.encode],
  ]);
  assert.ok(reading.stages.every((stage) => stage.ms >= 0), JSON.stringify(reading.stages));
  assert.equal(reading.wallMs, null, 'the historical worker-lifetime reading has no termination event on success');
  assert.equal(reading.gapMs, null, 'no worker terminated before the first run');
  assert.ok(reading.setupMs >= 0);
  assert.deepEqual(reading.product, { map: { size: { width: 3, height: 2 }, min: 0, max: 1 }, embeddings: { dims: [[1, 2], [1, 2], [1, 2]] }, plate: null });
  assert.deepEqual(reading.condition, {
    gl: 'none',
    textureBytes: 0,
    glBuild: null,
    framesDrawn: 0,
    contextLostAtMs: null,
    standIn: [{ chunk: STAND_IN_CHUNK, fill: STAND_IN_SUM(1), after: STAND_IN_SUM(1) }],
    ballast: [],
    checksumsMatch: true,
  });
  assert.deepEqual([reading.hiddenMs, reading.longestHiddenMs, reading.load], [1_200, 900, 3]);
  assert.deepEqual(w.services.built, [2], 'one service, at 2 threads');
  assert.deepEqual(w.services.ports[0]?.posted.map((m) => (m.type === 'init' ? `init ${m.threads}` : m.type === 'run' ? `run ${m.stage}` : m.type)), ['init 2', 'run depth', 'run encode']);
  assert.deepEqual(w.inputs.fetched, [masterUrl(MASTER)]);
});

test('the next run waits the encoder\'s cooldown from its completion before setup, reuses its worker, and keeps the stand-in it filled once, summed after each run', async () => {
  const w = world();
  const first = await w.execute(RUN);
  const completed = ran(first.outcome).reading;
  const firstAfter = at(first.phases, 'after').at;
  const second = await w.execute(RUN);
  const waitMs = COOLDOWN_MS.encode * SCALE;
  const setupAt = at(second.phases, 'setup').at;
  assert.ok(setupAt - firstAfter >= waitMs - 1, `the setup came ${setupAt - firstAfter} ms after the termination, the wait being ${waitMs} ms`);
  const reading = ran(second.outcome).reading;
  assert.equal(reading.gapMs, null, 'the historical spawn gap cannot describe a run in an already resident worker');
  assert.equal(completed.wallMs, null);
  assert.deepEqual(w.allocated, [1], 'the stand-in was allocated once');
  assert.deepEqual(at(second.phases, 'wait').holding, { chunks: 1, mb: 1 }, 'and held across the runs');
  assert.deepEqual(reading.condition.standIn, [{ chunk: STAND_IN_CHUNK, fill: STAND_IN_SUM(1), after: STAND_IN_SUM(1) }]);
  assert.equal(w.services.ports.length, 1, 'one resident worker serves both runs');
  assert.deepEqual(w.inputs.fetched, [masterUrl(MASTER)], 'the master was fetched once');
  w.runner.release();
  assert.deepEqual(w.runner.holding, { chunks: 0, mb: 0 }, 'release() drops the stand-in');
});

test('the worker fixture scripts logical runs independently of the resident worker count', async () => {
  const w = world();
  const requested: [string, number][] = [];
  w.services.answer = (stage, run) => {
    requested.push([stage, run]);
    return stage === 'encode' && run === 1 ? { kind: 'failed', message: 'the second photo could not encode' } : { kind: 'product' };
  };
  assert.deepEqual(ran((await w.execute(RUN)).outcome).score, { kind: 'survived' });
  assert.deepEqual(ran((await w.execute(RUN)).outcome).score, { kind: 'failed', phase: 'run:encode', error: { kind: 'worker', op: 'encode', message: 'the second photo could not encode' } });
  assert.deepEqual(ran((await w.execute(RUN)).outcome).score, { kind: 'survived' });
  assert.deepEqual(requested, [['depth', 0], ['encode', 0], ['depth', 1], ['encode', 1], ['depth', 2], ['encode', 2]]);
  assert.equal(w.services.ports.length, 1);
  assert.equal(w.services.ports[0]?.terminated, false);
  assert.equal(w.services.ports[0]?.posted.filter((message) => message.type === 'init').length, 1);
});

test('the kill-point ballast is gone before a sequence runs, the stand-in at 100 MB beside it; the ballast and untouched steps after a run wait the cooldown and release the stand-in', async () => {
  const w = world({ ...SMALL, chunkMb: 100 });
  for (const mb of [100, 200]) await w.execute({ kind: 'ballast', mb, release: 'all' });
  assert.deepEqual(w.runner.holding, { chunks: 2, mb: 200 }, 'the ladder left its ballast held');
  const run = await w.execute(RUN);
  assert.deepEqual(at(run.phases, 'wait').holding, { chunks: 2, mb: 200 }, 'held through the wait');
  assert.deepEqual(at(run.phases, 'run:depth').holding, { chunks: 1, mb: 100 }, 'the setup dropped the ballast and holds the stand-in alone');
  assert.equal(ran(run.outcome).reading.condition.standIn[0]?.fill, STAND_IN_SUM(100));
  const terminatedAt = at(run.phases, 'after').at;
  const ladder = await w.execute({ kind: 'ballast', mb: 100, release: 'all' });
  assert.deepEqual(names(ladder.phases), ['wait', 'fill:100', 'hold:100']);
  assert.ok(at(ladder.phases, 'fill:100').at - terminatedAt >= COOLDOWN_MS.encode * SCALE - 1, 'the ballast step waited the encoder\'s cooldown');
  assert.deepEqual(at(ladder.phases, 'fill:100').holding, { chunks: 0, mb: 0 }, 'its setup released the stand-in');
  const again = await w.execute(RUN);
  const untouched = await w.execute({ kind: 'untouched', mb: 2 });
  assert.ok(at(untouched.phases, 'alloc:2').at - at(again.phases, 'after').at >= COOLDOWN_MS.encode * SCALE - 1, 'the untouched step waited the encoder\'s cooldown');
  assert.deepEqual(at(untouched.phases, 'alloc:2').holding, { chunks: 0, mb: 0 }, 'its setup released the stand-in before its one chunk');
});

test('a sequence step without the stand-in releases the one held; release() keeps the termination, so a run after it still waits the cooldown, while a new runner (a reload) waits nothing and fills the stand-in anew', async () => {
  const w = world();
  await w.execute(RUN);
  const bare = await w.execute({ ...RUN, condition: { ...RUN.condition, standIn: false } });
  assert.deepEqual(at(bare.phases, 'run:depth').holding, { chunks: 0, mb: 0 });
  assert.deepEqual(ran(bare.outcome).reading.condition.standIn, []);
  const terminatedAt = at(bare.phases, 'after').at;
  w.runner.release();
  const after = await w.execute(RUN);
  assert.ok(at(after.phases, 'setup').at - terminatedAt >= COOLDOWN_MS.encode * SCALE - 1, 'the released services\' termination still counts');
  assert.deepEqual(w.services.built, [2, 2], 'release() dropped the service, and the next run built another');
  const reloaded = world();
  const fresh = await reloaded.execute(RUN);
  assert.equal(ran(fresh.outcome).reading.gapMs, null);
  assert.deepEqual(reloaded.allocated, [1]);
});

test('the setup\'s time, from setup to its answer, is the reading\'s setupMs after the wait, while a reused worker has no spawn gap', async () => {
  const w = world();
  await w.execute(RUN);
  const SETUP_MS = 40;
  w.services.fetchModels = () => new Promise((resolve) => setTimeout(() => resolve(ok(undefined)), SETUP_MS));
  const { outcome, phases } = await w.execute(RUN);
  const reading = ran(outcome).reading;
  const measured = at(phases, 'run:depth').at - at(phases, 'setup').at;
  assert.ok(reading.setupMs >= SETUP_MS - 1 && reading.setupMs <= measured, `setupMs ${reading.setupMs}, the model fetch ${SETUP_MS} ms, setup to run:depth ${measured} ms`);
  assert.equal(reading.gapMs, null, 'there was no worker spawn in this run');
});

test('a run that ends before its timeout leaves no timer: nothing is cancelled after it', async () => {
  const w = world({ ...SMALL, timeoutS: 0.25 });
  assert.equal(ran((await w.execute(RUN)).outcome).score.kind, 'survived');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(w.services.cancels, 0);
});

test('the wait ends no earlier than its end on the clock, though the clock\'s timers fire up to 0.9 ms early', async () => {
  let now = 1_000;
  /** Fires each timer 0.9 ms before its delay, or after 0.1 ms for a shorter one. */
  const early: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'> = {
    now: () => now,
    setTimeout: (callback, ms) =>
      Number(
        setTimeout(() => {
          now += Math.max(ms - 0.9, 0.1);
          callback();
        }, 0),
      ),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const latest = { atMs: 999.7, largest: 'depth' } as const;
  const end = latest.atMs + COOLDOWN_MS.depth * SCALE;
  const phases: string[] = [];
  const waited = await waitOut({ clock: early, wait: { kind: 'cooldown', scale: SCALE }, latest, phase: (name) => phases.push(name), signal: new AbortController().signal });
  assert.deepEqual([waited, phases], [true, ['wait']]);
  assert.ok(now >= end, `the wait ended at ${now}, before its end ${end}`);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await waitOut({ clock: early, wait: { kind: 'cooldown', scale: SCALE }, latest: null, phase: () => undefined, signal: stopped.signal }), false, 'an aborted wait with nothing to wait answers false');
});

test('a run that has not ended within the timeoutS lever is cancelled in its phase and scores timeout, retaining its worker in after', async () => {
  const w = world({ ...SMALL, timeoutS: 0.25 });
  w.services.answer = (stage) => (stage === 'encode' ? { kind: 'hang' } : { kind: 'product' });
  const { outcome, phases } = await w.execute(RUN);
  assert.deepEqual(names(phases), ['wait', 'setup', 'run:depth', 'run:encode', 'after']);
  assert.deepEqual(at(phases, 'after').terminated, [false]);
  const { score, reading } = ran(outcome);
  assert.deepEqual(score, { kind: 'timeout', phase: 'run:encode' });
  assert.deepEqual(reading.stages.map((stage) => stage.op), ['depth']);
  assert.equal(reading.wallMs, null, 'logical timeout leaves no worker termination event');
  assert.ok(at(phases, 'after').at - at(phases, 'setup').at >= 245, 'the timeout did not fire early');
  assert.equal(reading.condition.checksumsMatch, true, 'the stand-in is summed after a timeout too');
});

test('a worker failure, a wasm growth that failed, scores failed with its phase and error; an error event too', async () => {
  const failing = world();
  failing.services.answer = (stage) => (stage === 'encode' ? { kind: 'failed', message: 'RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded' } : { kind: 'product' });
  const failed = ran((await failing.execute(RUN)).outcome);
  assert.deepEqual(failed.score, { kind: 'failed', phase: 'run:encode', error: { kind: 'worker', op: 'encode', message: 'RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded' } });
  assert.deepEqual(failed.reading.stages.map((stage) => stage.op), ['depth']);
  const raising = world();
  raising.services.answer = (stage) => (stage === 'depth' ? { kind: 'error', message: 'out of memory' } : { kind: 'product' });
  const { outcome, phases } = await raising.execute(RUN);
  assert.deepEqual(names(phases), ['wait', 'setup', 'run:depth', 'after']);
  assert.deepEqual(ran(outcome).score, { kind: 'failed', phase: 'run:depth', error: { kind: 'worker', op: 'depth', message: 'the worker raised an error: out of memory' } });
  assert.deepEqual(ran(outcome).reading.stages, []);
});

test('Stop in the run cancels the sequence and in the wait spawns nothing; each answers the abort and releases what the runner held', async () => {
  const w = world();
  w.services.answer = (stage) => (stage === 'encode' ? { kind: 'product', afterMs: 10_000 } : { kind: 'product' });
  const started = clock.now();
  const inRun = await w.execute(RUN, (name, controller) => {
    if (name === 'run:encode') setTimeout(() => controller.abort(), 5);
  });
  assert.deepEqual(inRun.outcome, ABORTED);
  assert.ok(clock.now() - started < 1_000, 'the 10 s encoder ended at the abort');
  assert.deepEqual([w.services.ports[0]?.terminated, w.runner.holding], [false, { chunks: 0, mb: 0 }]);
  const slow = world({ ...SMALL, defaultsScale: 1 });
  await slow.execute({ ...RUN, wait: { kind: 'cooldown', scale: 1 } });
  const waiting = await slow.execute({ ...RUN, wait: { kind: 'cooldown', scale: 1 } }, (name, controller) => {
    if (name === 'wait') setTimeout(() => controller.abort(), 20);
  });
  assert.deepEqual([waiting.outcome, names(waiting.phases), slow.services.ports.length], [ABORTED, ['wait'], 1], 'aborted in the 20 s wait at defaultsScale 1, no worker spawned');
});

test('a master fetch that fails leaves the step blocked with its reason and no worker; its next attempt waits the retry time and fetches again, and the master is then kept', async () => {
  const w = world();
  w.inputs.status = 503;
  const blocked = await w.execute(RUN);
  const blockedAt = clock.now();
  assert.deepEqual(blocked.outcome, { kind: 'blocked', reason: 'the 8 x 6 master could not be fetched: the server answered 503' });
  assert.deepEqual([names(blocked.phases), w.services.ports.length], [['wait', 'setup'], 0]);
  w.inputs.status = 200;
  const recovered = await w.execute(RUN);
  const { setupMs } = ran(recovered.outcome).reading;
  assert.ok(at(recovered.phases, 'run:depth').at - blockedAt >= BLOCKED_RETRY_MS * SCALE + setupMs, 'the retry waited the retry time before its setup');
  assert.ok(setupMs < BLOCKED_RETRY_MS * SCALE, `setupMs ${setupMs} does not hold the retry time`);
  assert.equal(ran(recovered.outcome).score.kind, 'survived');
  await w.execute(RUN);
  assert.deepEqual(w.inputs.fetched, [masterUrl(MASTER), masterUrl(MASTER)], 'fetched again after the failure, then kept');
  const short = world();
  short.inputs.bytes = () => 5;
  assert.deepEqual((await short.execute(RUN)).outcome, { kind: 'blocked', reason: 'the 8 x 6 master could not be fetched: it held 5 bytes, not 192' });
});

test('a blocked attempt\'s retry time is waited in the setup phase, after the cooldown has ended in the wait, so a death in it is not one in the wait after the run before', async () => {
  const w = world();
  await w.execute(RUN);
  w.services.fetchModels = () => err({ kind: 'download', model: lock.ops.encode.model, status: 'offline' });
  const blocked = await w.execute(RUN);
  const blockedAt = clock.now();
  assert.equal(blocked.outcome.kind, 'blocked');
  w.services.fetchModels = () => ok(undefined);
  const retried = await w.execute(RUN);
  assert.deepEqual(names(retried.phases), ['wait', 'setup', 'run:depth', 'run:encode', 'after']);
  const retryMs = BLOCKED_RETRY_MS * SCALE;
  assert.ok(at(retried.phases, 'setup').at - blockedAt < retryMs / 2, 'the cooldown had ended, so the wait ended at once and the setup phase began');
  assert.ok(at(retried.phases, 'run:depth').at - blockedAt >= retryMs, 'the setup phase held the retry time');
});

test('the cooldown after a worker counts the largest stage that started in it: an encoder that fails before inference waits the encoder\'s cooldown, not depth\'s', async () => {
  const w = world();
  w.services.answer = (stage, run) => (stage === 'encode' && run === 0 ? { kind: 'error', message: 'out of memory' } : { kind: 'product' });
  const first = await w.execute(RUN);
  assert.deepEqual(ran(first.outcome).score, { kind: 'failed', phase: 'run:encode', error: { kind: 'worker', op: 'encode', message: 'the worker raised an error: out of memory' } });
  const encodeWaitMs = COOLDOWN_MS.encode * SCALE;
  assert.ok(encodeWaitMs > COOLDOWN_MS.depth * SCALE);
  const second = await w.execute(RUN);
  assert.ok(at(second.phases, 'setup').at - at(first.phases, 'after').at >= encodeWaitMs, `the setup came ${at(second.phases, 'setup').at - at(first.phases, 'after').at} ms after the termination, the encoder's wait being ${encodeWaitMs} ms`);
  const { gapMs, setupMs } = ran(second.outcome).reading;
  assert.ok(gapMs !== null && gapMs >= encodeWaitMs + setupMs, JSON.stringify({ gapMs, setupMs }));
});

test('a model fetch that fails leaves the step blocked naming the error, with no worker', async () => {
  const w = world();
  w.services.fetchModels = () => err({ kind: 'download', model: lock.ops.encode.model, status: 'offline' });
  const { outcome } = await w.execute(RUN);
  assert.deepEqual(outcome, { kind: 'blocked', reason: `the models could not be fetched: {"kind":"download","model":"${lock.ops.encode.model}","status":"offline"}` });
  assert.equal(w.services.ports.length, 0);
});

test('the wait after a termination: the cooldown default of the stage it names times the scale, at defaultsScale 1 and 0.01; a gap its own length; nothing before any termination', () => {
  const encode = { atMs: 0, largest: 'encode' } as const;
  const depth = { atMs: 0, largest: 'depth' } as const;
  assert.deepEqual(
    [waitMsAfter({ kind: 'cooldown', scale: 1 }, encode), waitMsAfter({ kind: 'cooldown', scale: 0.01 }, encode), waitMsAfter({ kind: 'cooldown', scale: 1 }, depth), waitMsAfter({ kind: 'cooldown', scale: 0.01 }, depth)],
    [20_000, 200, 5_000, 50],
  );
  assert.equal(waitMsAfter({ kind: 'gap', ms: 500 }, depth), 500);
  assert.equal(waitMsAfter({ kind: 'cooldown', scale: 1 }, null), 0);
});

test('each thread count gets a service of its own, and a run waits the latest termination of either', async () => {
  const w = world();
  const two = await w.execute(RUN);
  const one = await w.execute({ ...RUN, threads: 1 });
  assert.deepEqual(w.services.built, [2, 1]);
  assert.deepEqual(w.services.ports.map((port) => port.threads), [2, 1]);
  assert.ok(at(one.phases, 'setup').at - at(two.phases, 'after').at >= COOLDOWN_MS.encode * SCALE - 1, 'the thread-1 run waited the thread-2 service\'s termination');
});

test('the release order and what each step keeps; a condition no executor builds yet is refused', async () => {
  assert.deepEqual(RELEASE_ORDER, ['untouched', 'ballast', 'stand-in', 'services', 'inputs']);
  assert.deepEqual([...keptFor({ kind: 'untouched', mb: 1 })], []);
  assert.deepEqual([...keptFor({ kind: 'ballast', mb: 1, release: 'all' })], ['ballast']);
  assert.deepEqual([...keptFor(RUN)], ['stand-in', 'services', 'inputs']);
  assert.equal(unbuiltCondition(RUN), null);
  assert.equal(unbuiltCondition({ ...RUN, condition: { ...RUN.condition, gl: 'low' } }), 'a GL ballast');
  assert.equal(unbuiltCondition({ ...RUN, condition: { ...RUN.condition, ballastMb: 300 } }), 'a memory ballast beside a sequence');
  assert.equal(unbuiltCondition({ ...RUN, after: { gl: null, openDecoder: true } }), 'a decoder');
  assert.equal(unbuiltCondition({ ...RUN, stages: ['inpaint'], hole: null }), 'an inpaint stage with no hole');
  const w = world();
  await assert.rejects(w.execute({ ...RUN, condition: { ...RUN.condition, gl: 'full' } }), /^Error: no executor runs a sequence step with a GL ballast yet$/);
});

test('an inpaint run hands the worker the hole the inputs make, and records the plate', async () => {
  const w = world();
  const { outcome } = await w.execute({ ...RUN, stages: ['inpaint'], hole: 'corners' });
  const reading = ran(outcome).reading;
  assert.deepEqual([reading.stages.map((stage) => stage.op), reading.product.plate], [['inpaint'], { width: 4, height: 3 }]);
  const posted = w.services.ports[0]?.posted.find((message) => message.type === 'run');
  assert.ok(posted?.type === 'run' && posted.stage === 'inpaint' && posted.hole.data.length === MASTER.width * MASTER.height && posted.hole.data.some((value) => value === 255));
});

test('the inputs: a master fetched once per size and kept, a fresh bitmap each call; a hang ends at the timeout; holes kept; release() drops both', async (t) => {
  const w = inputsWorld(clock);
  const signal = new AbortController().signal;
  const first = await w.inputs.master({ width: 4, height: 2 }, signal);
  const second = await w.inputs.master({ width: 4, height: 2 }, signal);
  const other = await w.inputs.master({ width: 2, height: 2 }, signal);
  assert.ok(first.ok && second.ok && other.ok);
  assert.deepEqual(w.fetched, [masterUrl({ width: 4, height: 2 }), masterUrl({ width: 2, height: 2 })]);
  const [a, b] = await Promise.all([first.value.bitmap(), first.value.bitmap()]);
  assert.ok(a !== b && a.width === 4 && a.height === 2);
  const hole = w.inputs.hole('full', { width: 4, height: 2 });
  assert.equal(w.inputs.hole('full', { width: 4, height: 2 }), hole);
  assert.equal(w.inputs.bytes, 4 * 2 * 4 + 2 * 2 * 4 + 8);
  w.inputs.release();
  assert.equal(w.inputs.bytes, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = inputsWorld({ setTimeout: (callback, ms) => Number(setTimeout(callback, ms)), clearTimeout: (handle) => clearTimeout(handle) });
  hanging.status = 'hang';
  const pending = hanging.inputs.master({ width: 2, height: 2 }, signal);
  t.mock.timers.tick(INPUT_TIMEOUT_MS);
  assert.deepEqual(await pending, { ok: false, error: `the 2 x 2 master could not be fetched: no answer within ${INPUT_TIMEOUT_MS} ms` });
  t.mock.timers.reset();
  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await hanging.inputs.master({ width: 2, height: 2 }, stopped.signal), { ok: false, error: 'the 2 x 2 master was not fetched: the step was stopped' });
});
