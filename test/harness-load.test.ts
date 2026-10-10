// src/dev/harness/load.ts: every row of the load-time verdict table, a
// completed step hidden for less than, exactly, and more than the app's
// grace, and how each verdict is applied to the plan: a kill folded and never
// rerun, a void rerun with its count raised until the fifth ends the row
// `no-reading`, a death in a wait folded into the row whose worker it was
// waiting out (still running, or ended and amended without moving the
// cursor), a death after the step's state was saved posted and not folded,
// a lost marker folded as killed in phase `unknown`, the counters, and the
// least wait before the next step.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLoad, classifyLoad, loadVerdictName, parseMarker, scoreCompleted, type LoadVerdict, type StepMarker } from '../src/dev/harness/load.ts';
import { COOLDOWN_MS, HIDDEN_GRACE_MS } from '../src/dev/harness/lines.ts';
import { completeStep, nextPlanStep, type PlanState } from '../src/dev/harness/plan.ts';
import { resumeWaitMsFor, type Step } from '../src/dev/harness/steps.ts';
import type { HarnessEvent, HarnessRow } from '../src/dev/harness/rows.ts';
import { begin, BUILD, markerFor, OTHER_BUILD, planOf, ran, SURVIVED, T0, TAB } from './fixtures/harness.ts';

const NOW = T0 + 10_000;

const events = (rows: readonly HarnessRow[]): readonly HarnessEvent[] => rows.map((r) => r.event);

/** A plan of two survival rows of three runs with run 1 survived and run 2 in flight, and the marker the engine wrote for it. */
function secondRunInFlight(patch: Partial<StepMarker> = {}): { readonly plan: PlanState; readonly marker: StepMarker } {
  const first = begin(planOf(['U1.survival.full', 'U1.survival.low'], 3));
  const afterFirst = completeStep(first.plan, SURVIVED, T0).plan;
  const second = begin(afterFirst);
  return { plan: second.plan, marker: markerFor(second.plan, second.planned, patch) };
}

/** run 1's termination, which run 2's wait is waiting out. */
function waitingOutRun1(plan: PlanState): NonNullable<StepMarker['waitingOut']> {
  const step = nextPlanStep(plan);
  if (step.kind !== 'step') throw new Error('done');
  return { row: 'U1.survival.full', stepKey: 'run-1', step: step.planned.step, load: 1, stage: 'encode', terminatedAtWall: T0 + 1_000 };
}

const verdictOf = (plan: PlanState | null, marker: StepMarker | null): LoadVerdict => classifyLoad(plan, marker, BUILD, NOW);

// ---------------------------------------------------------------------------
// the verdict table

test('no plan, and a plan with no step in flight and no marker, are fresh', () => {
  const { plan, marker } = secondRunInFlight();
  assert.deepEqual(verdictOf(null, null), { kind: 'fresh' });
  assert.deepEqual(verdictOf(null, marker), { kind: 'fresh' });
  assert.deepEqual(verdictOf({ ...plan, inFlight: null }, null), { kind: 'fresh' });
});

test('a plan with no step in flight and a marker of its run died after the step state was saved', () => {
  const { plan, marker } = secondRunInFlight({ phase: 'after' });
  assert.deepEqual(verdictOf({ ...plan, inFlight: null }, marker), { kind: 'after-completion', marker, death: 'killed' });
  assert.deepEqual(verdictOf({ ...plan, inFlight: null }, { ...marker, pagehideAtWall: NOW - 50 }), { kind: 'after-completion', marker: { ...marker, pagehideAtWall: NOW - 50 }, death: 'left' });
  // A marker another run left behind is not this plan's.
  assert.deepEqual(verdictOf({ ...plan, inFlight: null }, { ...marker, run: '20261003T110000Z-0001' }), { kind: 'fresh' });
  // One a later load already applied, then died before clearing, posts nothing again and is named fresh.
  const applied = verdictOf({ ...plan, inFlight: null, loads: marker.load + 1 }, marker);
  assert.deepEqual(applied, { kind: 'applied-earlier', marker });
  assert.equal(loadVerdictName(applied), 'fresh');
});

test('a step in flight whose marker has pagehideAtWall is a left void, whatever else the marker says', () => {
  const { plan, marker } = secondRunInFlight({ pagehideAtWall: T0 + 3_000, visibility: 'hidden', hiddenSinceWall: T0 + 3_000 });
  assert.deepEqual(verdictOf(plan, marker), { kind: 'void', reason: 'left', marker });
});

test('a step in flight hidden at death is a background void', () => {
  const { plan, marker } = secondRunInFlight({ visibility: 'hidden', hiddenSinceWall: T0 + 3_000 });
  assert.deepEqual(verdictOf(plan, marker), { kind: 'void', reason: 'background', marker });
});

test('a step visible at death whose longest hidden period was above the grace is a hidden void, and one at the grace is a kill', () => {
  const above = secondRunInFlight({ hiddenMs: HIDDEN_GRACE_MS + 1, longestHiddenMs: HIDDEN_GRACE_MS + 1 });
  assert.deepEqual(verdictOf(above.plan, above.marker), { kind: 'void', reason: 'hidden', marker: above.marker });
  const at = secondRunInFlight({ hiddenMs: HIDDEN_GRACE_MS + 900, longestHiddenMs: HIDDEN_GRACE_MS });
  assert.deepEqual(verdictOf(at.plan, at.marker), {
    kind: 'killed',
    marker: at.marker,
    outcome: { kind: 'killed', phase: 'run:encode', markerAgeMs: 10_000, aliveAgeMs: 6_000, hiddenMs: HIDDEN_GRACE_MS + 900 },
  });
});

test('a kill after a brief hide, visible at death, is a kill with its hidden time attached, not a void', () => {
  const { plan, marker } = secondRunInFlight({ hiddenMs: 1_000, longestHiddenMs: 1_000, phase: 'run:depth' });
  assert.deepEqual(verdictOf(plan, marker), { kind: 'killed', marker, outcome: { kind: 'killed', phase: 'run:depth', markerAgeMs: 10_000, aliveAgeMs: 6_000, hiddenMs: 1_000 } });
});

test('a step visible at death in its wait while an earlier worker drained died after that termination', () => {
  const base = secondRunInFlight();
  const waitingOut = waitingOutRun1(base.plan);
  const marker: StepMarker = { ...base.marker, phase: 'wait', aliveAtWall: T0 + 4_000, waitingOut };
  assert.deepEqual(verdictOf(base.plan, marker), {
    kind: 'died-after-terminate',
    marker,
    attributedTo: waitingOut,
    outcome: { kind: 'died-after-terminate', sinceTerminateMs: 3_000, aliveAgeMs: 6_000 },
  });
});

test('a step visible at death in its wait with no worker waited out died idle, a void', () => {
  const { plan, marker } = secondRunInFlight({ phase: 'wait' });
  assert.deepEqual(verdictOf(plan, marker), { kind: 'void', reason: 'died-idle', marker });
});

test('a U2 step visible at death in its wait is killed in wait, with or without a worker waited out', () => {
  const base = secondRunInFlight();
  const counts = { row: 'U2.encode', stepKey: 'gap-0-pair-1-inpaint', attempt: 1, voids: 0, tab: TAB } as const;
  const plan: PlanState = { ...base.plan, inFlight: counts };
  for (const waitingOut of [null, waitingOutRun1(base.plan)]) {
    const marker: StepMarker = { ...base.marker, row: counts.row, stepKey: counts.stepKey, phase: 'wait', waitingOut };
    assert.deepEqual(verdictOf(plan, marker), { kind: 'killed', marker, outcome: { kind: 'killed', phase: 'wait', markerAgeMs: 10_000, aliveAgeMs: 6_000, hiddenMs: 0 } });
  }
});

test('a step visible at death in any other phase is killed in that phase', () => {
  for (const phase of ['setup', 'run:encode', 'run:inpaint', 'fill', 'hold', 'after']) {
    const { plan, marker } = secondRunInFlight({ phase });
    const verdict = verdictOf(plan, marker);
    assert.deepEqual(verdict.kind === 'killed' && verdict.outcome.phase, phase);
  }
});

test('a step in flight with no marker, or a marker of another attempt or run, lost its marker', () => {
  const { plan, marker } = secondRunInFlight();
  assert.deepEqual(verdictOf(plan, null), { kind: 'marker-lost' });
  assert.deepEqual(verdictOf(plan, { ...marker, attempt: 2 }), { kind: 'marker-lost' });
  assert.deepEqual(verdictOf(plan, { ...marker, stepKey: 'run-1' }), { kind: 'marker-lost' });
  assert.deepEqual(verdictOf(plan, { ...marker, run: '20261003T110000Z-0001' }), { kind: 'marker-lost' });
});

test('a plan of another build is stale, whatever the marker', () => {
  const { plan, marker } = secondRunInFlight();
  for (const m of [null, marker]) {
    assert.deepEqual(classifyLoad(plan, m, OTHER_BUILD, NOW), { kind: 'stale' });
    assert.deepEqual(classifyLoad({ ...plan, inFlight: null }, m, OTHER_BUILD, NOW), { kind: 'stale' });
  }
});

test('loadVerdictName names a void by its reason and every other verdict by its kind', () => {
  const { marker } = secondRunInFlight();
  assert.equal(loadVerdictName({ kind: 'void', reason: 'background', marker }), 'background');
  assert.equal(loadVerdictName({ kind: 'marker-lost' }), 'marker-lost');
  assert.equal(loadVerdictName({ kind: 'fresh' }), 'fresh');
});

test('parseMarker round-trips a marker and names what fails', () => {
  const { marker } = secondRunInFlight({ waitingOut: null });
  assert.deepEqual(parseMarker(JSON.stringify(marker)), { ok: true, value: marker });
  assert.deepEqual(parseMarker(null), { ok: true, value: null });
  assert.deepEqual(parseMarker(JSON.stringify({ ...marker, visibility: 'prerender' })), {
    ok: false,
    error: 'the stored step marker does not parse: visibility: Invalid option: expected one of "visible"|"hidden"',
  });
});

// ---------------------------------------------------------------------------
// a completed step

test('a completed step hidden for less than or exactly the grace counts, and one hidden longer is a hidden void', () => {
  const { marker } = secondRunInFlight();
  const score = (longestHiddenMs: number): string => scoreCompleted(SURVIVED, { ...marker, hiddenMs: longestHiddenMs, longestHiddenMs }, NOW).kind;
  assert.equal(score(HIDDEN_GRACE_MS - 1), 'ran');
  assert.equal(score(HIDDEN_GRACE_MS), 'ran');
  assert.equal(score(HIDDEN_GRACE_MS + 1), 'void');
  assert.deepEqual(scoreCompleted(ran({ kind: 'timeout', phase: 'run:encode' }), { ...marker, longestHiddenMs: HIDDEN_GRACE_MS + 1 }, NOW), { kind: 'void', reason: 'hidden' });
});

test('a step that completes while still hidden counts the hidden period it is in', () => {
  const { marker } = secondRunInFlight({ visibility: 'hidden', hiddenSinceWall: NOW - HIDDEN_GRACE_MS - 1 });
  assert.deepEqual(scoreCompleted(SURVIVED, marker, NOW), { kind: 'void', reason: 'hidden' });
  assert.deepEqual(scoreCompleted(SURVIVED, { ...marker, hiddenSinceWall: NOW - HIDDEN_GRACE_MS }, NOW), SURVIVED);
  assert.deepEqual(scoreCompleted({ kind: 'blocked', reason: 'no master' }, { ...marker, longestHiddenMs: 60_000 }, NOW), { kind: 'blocked', reason: 'no master' });
  // A step the runner already voided keeps its own reason.
  assert.deepEqual(scoreCompleted({ kind: 'void', reason: 'left' }, { ...marker, longestHiddenMs: 60_000 }, NOW), { kind: 'void', reason: 'left' });
});

// ---------------------------------------------------------------------------
// applying the verdicts

test('a fresh load raises loads and asks for no wait; a stale one changes nothing', () => {
  const { plan } = secondRunInFlight();
  const idle = { ...plan, inFlight: null };
  assert.deepEqual(applyLoad(idle, { kind: 'fresh' }, NOW), { plan: { ...idle, loads: 2 }, rows: [], leastWaitMs: 0 });
  assert.deepEqual(applyLoad(plan, { kind: 'stale' }, NOW), { plan, rows: [], leastWaitMs: 0 });
});

test('a marker a later load applied and died before clearing posts and folds nothing, but its cooldown still holds', () => {
  const { plan, marker } = secondRunInFlight();
  const idle = { ...plan, inFlight: null, loads: marker.load + 1 };
  assert.deepEqual(applyLoad(idle, verdictOf(idle, marker), NOW), { plan: { ...idle, loads: idle.loads + 1 }, rows: [], leastWaitMs: COOLDOWN_MS.encode });
});

test('a kill is folded into its row, counted, posted as step-lost, and never reruns the step', () => {
  const { plan, marker } = secondRunInFlight();
  const applied = applyLoad(plan, verdictOf(plan, marker), NOW);
  assert.deepEqual([applied.plan.loads, applied.plan.kills, applied.plan.voids, applied.plan.inFlight, applied.plan.reruns, applied.plan.cursor], [2, 1, 0, null, [], 1]);
  assert.deepEqual(events(applied.rows), [
    { type: 'step-lost', row: 'U1.survival.full', stepKey: 'run-2', attempt: 1, verdict: 'killed', phase: 'run:encode', markerAgeMs: 10_000, aliveAgeMs: 6_000, hiddenMs: 0, attributedTo: null, afterCompletion: false },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'runs', survived: 1, of: 3, end: { score: 'killed', phase: 'run:encode' } }, amends: false },
  ]);
  assert.deepEqual(applied.rows.map((r) => [r.load, r.seq]), [[2, plan.seq], [2, plan.seq + 1]]);
  const next = nextPlanStep(applied.plan);
  assert.deepEqual(next.kind === 'step' && [next.row, next.planned.key], ['U1.survival.low', 'run-1']);
  assert.equal(applied.leastWaitMs, COOLDOWN_MS.encode);
});

test('each void reruns the step with its count raised, counted apart from kills, with no fold', () => {
  for (const [patch, reason] of [
    [{ pagehideAtWall: T0 + 3_000 }, 'left'],
    [{ visibility: 'hidden', hiddenSinceWall: T0 + 3_000 }, 'background'],
    [{ longestHiddenMs: HIDDEN_GRACE_MS + 1 }, 'hidden'],
    [{ phase: 'wait' }, 'died-idle'],
  ] as const) {
    const { plan, marker } = secondRunInFlight(patch);
    const applied = applyLoad(plan, verdictOf(plan, marker), NOW);
    assert.deepEqual([applied.plan.kills, applied.plan.voids, applied.plan.inFlight, applied.plan.cursor], [0, 1, null, 0], reason);
    assert.deepEqual(applied.plan.reruns, [{ row: 'U1.survival.full', stepKey: 'run-2', attempt: 1, voids: 1 }], reason);
    assert.deepEqual(applied.plan.rows, plan.rows, `${reason}: the row is not folded`);
    assert.deepEqual(events(applied.rows).map((e) => e.type === 'step-lost' && [e.verdict, e.afterCompletion]), [[reason, false]], reason);
    assert.deepEqual(begin(applied.plan).counts, { row: 'U1.survival.full', stepKey: 'run-2', attempt: 2, voids: 1, tab: TAB }, reason);
  }
});

test('one step voided at load one to five times: the fifth void ends its row no-reading and the plan moves on', () => {
  for (let voids = 1; voids <= 5; voids += 1) {
    let { plan } = secondRunInFlight();
    const posted: HarnessRow[] = [];
    for (let i = 0; i < voids; i += 1) {
      if (i > 0) plan = begin(plan).plan;
      assert.deepEqual([plan.inFlight?.attempt, plan.inFlight?.voids], [i + 1, i]);
      const marker = markerFor(plan, { key: 'run-2', step: begin(planOf(['U1.survival.full'])).planned.step }, { visibility: 'hidden', hiddenSinceWall: T0 });
      const applied = applyLoad(plan, verdictOf(plan, marker), NOW);
      posted.push(...applied.rows);
      plan = applied.plan;
    }
    assert.deepEqual([plan.voids, plan.kills, plan.loads], [voids, 0, 1 + voids]);
    if (voids < 5) {
      assert.deepEqual([plan.cursor, plan.reruns.map((r) => r.voids)], [0, [voids]]);
      assert.ok(!events(posted).some((e) => e.type === 'row-end'));
    } else {
      assert.deepEqual([plan.cursor, plan.reruns, plan.rows[0]?.halt], [1, [], { kind: 'no-reading', stepKey: 'run-2' }]);
      assert.deepEqual(events(posted).at(-1), { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'no-reading', stepKey: 'run-2' }, amends: false });
    }
  }
});

test('voids are capped apart from kills: a step voided four times and then killed is folded as a kill, not ended no-reading', () => {
  let { plan } = secondRunInFlight();
  for (let i = 0; i < 4; i += 1) {
    if (i > 0) plan = begin(plan).plan;
    const marker = markerFor(plan, { key: 'run-2', step: begin(planOf(['U1.survival.full'])).planned.step }, { pagehideAtWall: NOW });
    plan = applyLoad(plan, verdictOf(plan, marker), NOW).plan;
  }
  plan = begin(plan).plan;
  assert.deepEqual([plan.inFlight?.attempt, plan.inFlight?.voids], [5, 4]);
  const killed = applyLoad(plan, verdictOf(plan, markerFor(plan, { key: 'run-2', step: begin(planOf(['U1.survival.full'])).planned.step })), NOW);
  assert.deepEqual([killed.plan.kills, killed.plan.voids, killed.plan.rows[0]?.halt, killed.plan.reruns], [1, 4, null, []]);
  assert.deepEqual(events(killed.rows).at(-1), { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'runs', survived: 1, of: 3, end: { score: 'killed', phase: 'run:encode' } }, amends: false });
});

test('a death in a wait whose waited-out row is still running is folded into that run as a non-survival, and the row ends', () => {
  const base = secondRunInFlight();
  const marker: StepMarker = { ...base.marker, phase: 'wait', waitingOut: waitingOutRun1(base.plan) };
  const applied = applyLoad(base.plan, verdictOf(base.plan, marker), NOW);
  assert.deepEqual([applied.plan.kills, applied.plan.voids, applied.plan.cursor, applied.plan.inFlight], [1, 0, 1, null]);
  assert.deepEqual(events(applied.rows), [
    {
      type: 'step-lost',
      row: 'U1.survival.full',
      stepKey: 'run-2',
      attempt: 1,
      verdict: 'died-after-terminate',
      phase: 'wait',
      markerAgeMs: 10_000,
      aliveAgeMs: 6_000,
      hiddenMs: 0,
      attributedTo: { row: 'U1.survival.full', stepKey: 'run-1', sinceTerminateMs: 3_000 },
      afterCompletion: false,
    },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'runs', survived: 0, of: 3, end: { score: 'died-after-terminate', phase: null } }, amends: false },
  ]);
  // The waiting step's counts stay in reruns, though the cursor has left its row, until the next step starts.
  assert.deepEqual(applied.plan.reruns, [{ row: 'U1.survival.full', stepKey: 'run-2', attempt: 1, voids: 0 }]);
  // The waiting step's row no longer wants it: the next row starts.
  const next = nextPlanStep(applied.plan);
  assert.deepEqual(next.kind === 'step' && [next.row, next.planned.key], ['U1.survival.low', 'run-1']);
  const begun = begin(applied.plan);
  assert.deepEqual([begun.counts.attempt, begun.plan.reruns], [1, []]);
});

test('a death in a wait whose waited-out row has ended amends its verdict with a new row-end and never moves the cursor back', () => {
  let plan = planOf(['U1.survival.full', 'U1.survival.low'], 2);
  for (let i = 0; i < 2; i += 1) plan = completeStep(begin(plan).plan, SURVIVED, T0).plan;
  assert.equal(plan.cursor, 1);
  const waiting = begin(plan);
  const waitingOut = { row: 'U1.survival.full', stepKey: 'run-2', step: waiting.planned.step, load: 1, stage: 'encode', terminatedAtWall: T0 + 1_000 } as const;
  const marker = markerFor(waiting.plan, waiting.planned, { phase: 'wait', waitingOut });
  const applied = applyLoad(waiting.plan, verdictOf(waiting.plan, marker), NOW);
  assert.deepEqual([applied.plan.kills, applied.plan.cursor, applied.plan.inFlight], [1, 1, null]);
  assert.deepEqual(events(applied.rows).map((e) => e.type), ['step-lost', 'row-end']);
  assert.deepEqual(events(applied.rows)[1], {
    type: 'row-end',
    row: 'U1.survival.full',
    verdict: { kind: 'runs', survived: 1, of: 2, end: { score: 'died-after-terminate', phase: null } },
    amends: true,
  });
  // The waiting step was never scored: it runs next, as its next attempt.
  assert.deepEqual(begin(applied.plan).counts, { row: 'U1.survival.low', stepKey: 'run-1', attempt: 2, voids: 0, tab: TAB });
});

test('a death after a run that already ended its row in failure changes no verdict and posts no amended row-end', () => {
  let plan = planOf(['U1.survival.full', 'U1.survival.low'], 2);
  plan = completeStep(begin(plan).plan, ran({ kind: 'timeout', phase: 'run:encode' }), T0).plan;
  const waiting = begin(plan);
  const marker = markerFor(waiting.plan, waiting.planned, { phase: 'wait', waitingOut: { row: 'U1.survival.full', stepKey: 'run-1', step: waiting.planned.step, load: 1, stage: 'encode', terminatedAtWall: T0 } });
  const applied = applyLoad(waiting.plan, verdictOf(waiting.plan, marker), NOW);
  assert.deepEqual(events(applied.rows).map((e) => e.type), ['step-lost']);
  assert.deepEqual(applied.plan.rows[0], plan.rows[0]);
  assert.equal(applied.plan.kills, 1);
});

test('a death after the step state was saved is posted as step-lost after completion and folded into nothing', () => {
  const { plan } = secondRunInFlight();
  const done = completeStep(plan, SURVIVED, T0).plan;
  const marker = markerFor(plan, { key: 'run-2', step: begin(planOf(['U1.survival.full'])).planned.step }, { phase: 'after' });
  const verdict = verdictOf(done, marker);
  assert.equal(verdict.kind, 'after-completion');
  const applied = applyLoad(done, verdict, NOW);
  assert.deepEqual([applied.plan.rows, applied.plan.kills, applied.plan.voids, applied.plan.loads], [done.rows, 0, 0, 2]);
  assert.deepEqual(events(applied.rows), [
    { type: 'step-lost', row: 'U1.survival.full', stepKey: 'run-2', attempt: 1, verdict: 'killed', phase: 'after', markerAgeMs: 10_000, aliveAgeMs: 6_000, hiddenMs: 0, attributedTo: null, afterCompletion: true },
  ]);
  assert.equal(applied.leastWaitMs, COOLDOWN_MS.encode);
});

test('a lost marker is folded as killed in phase unknown and posted with no ages', () => {
  const { plan } = secondRunInFlight();
  const applied = applyLoad(plan, verdictOf(plan, null), NOW);
  assert.deepEqual([applied.plan.kills, applied.plan.voids, applied.plan.cursor, applied.plan.inFlight, applied.plan.reruns], [1, 0, 1, null, []]);
  assert.deepEqual(events(applied.rows), [
    { type: 'step-lost', row: 'U1.survival.full', stepKey: 'run-2', attempt: 1, verdict: 'killed', phase: 'unknown', markerAgeMs: null, aliveAgeMs: null, hiddenMs: 0, attributedTo: null, afterCompletion: false },
    { type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'runs', survived: 1, of: 3, end: { score: 'killed', phase: 'unknown' } }, amends: false },
  ]);
  assert.equal(applied.leastWaitMs, COOLDOWN_MS.encode);
});

test('the least wait after a non-fresh load is the dead step largest stage cooldown, scaled, and 0 after a ballast step', () => {
  const sequence = (stages: Extract<Step, { kind: 'sequence' }>['stages']): Step => {
    const step = begin(planOf(['U1.survival.full'])).planned.step;
    if (step.kind !== 'sequence') throw new Error('not a sequence');
    return { ...step, stages };
  };
  assert.equal(resumeWaitMsFor(sequence(['depth', 'encode']), 1), 20_000);
  assert.equal(resumeWaitMsFor(sequence(['encode']), 1), 20_000);
  assert.equal(resumeWaitMsFor(sequence(['depth']), 1), 5_000);
  assert.equal(resumeWaitMsFor(sequence(['inpaint']), 1), 5_000);
  assert.equal(resumeWaitMsFor(sequence(['depth', 'encode']), 0.01), 200);
  assert.equal(resumeWaitMsFor({ kind: 'ballast', mb: 800, release: 'all' }, 1), 0);
  assert.equal(resumeWaitMsFor({ kind: 'untouched', mb: 1500 }, 1), 0);

  // Through applyLoad: a death after a ballast step's state was saved waits nothing, and the defaultsScale lever scales a sequence's wait.
  const { plan, marker } = secondRunInFlight({ step: { kind: 'ballast', mb: 800, release: 'all' } });
  assert.equal(applyLoad({ ...plan, inFlight: null }, verdictOf({ ...plan, inFlight: null }, marker), NOW).leastWaitMs, 0);
  const scaled = secondRunInFlight();
  const leveredPlan = { ...scaled.plan, levers: { ...scaled.plan.levers, defaultsScale: 0.01 } };
  for (const m of [scaled.marker, { ...scaled.marker, pagehideAtWall: NOW }, null]) {
    assert.equal(applyLoad(leveredPlan, verdictOf(leveredPlan, m), NOW).leastWaitMs, 200, JSON.stringify(m?.pagehideAtWall));
  }
});

test('the least wait after a death in a wait is the waited-out worker largest stage cooldown, whatever the waiting step runs', () => {
  const base = secondRunInFlight();
  const waitingOut = waitingOutRun1(base.plan);
  const inpaint: Step = { ...(waitingOut.step.kind === 'sequence' ? waitingOut.step : assert.fail()), stages: ['inpaint'] };
  const leveredPlan = { ...base.plan, levers: { ...base.plan.levers, defaultsScale: 0.5 } };
  for (const step of [{ kind: 'ballast', mb: 100, release: 'all' } as const, inpaint]) {
    const marker: StepMarker = { ...base.marker, step, phase: 'wait', waitingOut };
    const verdict = verdictOf(leveredPlan, marker);
    assert.equal(verdict.kind, 'died-after-terminate', step.kind);
    assert.equal(applyLoad(leveredPlan, verdict, NOW).leastWaitMs, COOLDOWN_MS.encode * 0.5, step.kind);
  }
});

test('a death in a wait recorded after the step state was saved, or applied by a later load, waits the waited-out worker largest stage cooldown', () => {
  const base = secondRunInFlight();
  const waitingOut = waitingOutRun1(base.plan);
  const idle: PlanState = { ...base.plan, inFlight: null, levers: { ...base.plan.levers, defaultsScale: 0.5 } };
  const marker: StepMarker = { ...base.marker, step: { kind: 'ballast', mb: 100, release: 'all' }, phase: 'wait', waitingOut };
  const after = verdictOf(idle, marker);
  assert.deepEqual(after, { kind: 'after-completion', marker, death: 'died-after-terminate' });
  assert.equal(applyLoad(idle, after, NOW).leastWaitMs, COOLDOWN_MS.encode * 0.5);
  const later = { ...idle, loads: marker.load + 1 };
  const applied = verdictOf(later, marker);
  assert.equal(applied.kind, 'applied-earlier');
  assert.equal(applyLoad(later, applied, NOW).leastWaitMs, COOLDOWN_MS.encode * 0.5);
});

test('a lost marker of a step its row no longer names is counted and posted, folds nothing, and waits the longest default', () => {
  const { plan } = secondRunInFlight();
  const stray: PlanState = { ...plan, levers: { ...plan.levers, defaultsScale: 0.5 }, inFlight: { row: 'U1.survival.full', stepKey: 'run-9', attempt: 1, voids: 0, tab: TAB } };
  const applied = applyLoad(stray, verdictOf(stray, null), NOW);
  assert.deepEqual([applied.plan.kills, applied.plan.inFlight, applied.plan.rows, applied.plan.cursor], [1, null, stray.rows, 0]);
  assert.deepEqual(events(applied.rows).map((e) => e.type === 'step-lost' && [e.stepKey, e.verdict, e.phase]), [['run-9', 'killed', 'unknown']]);
  assert.equal(applied.leastWaitMs, Math.max(...Object.values(COOLDOWN_MS)) * 0.5);
  assert.equal(applied.leastWaitMs, 10_000);
});

test('a death in a wait whose waited-out row the void cap ended keeps that row no-reading and posts no amended row-end', () => {
  let plan = planOf(['U1.survival.full', 'U1.survival.low'], 2);
  plan = completeStep(begin(plan).plan, SURVIVED, T0).plan;
  for (let i = 0; i < 5; i += 1) plan = completeStep(begin(plan).plan, { kind: 'void', reason: 'hidden' }, T0).plan;
  assert.deepEqual([plan.cursor, plan.rows[0]?.halt], [1, { kind: 'no-reading', stepKey: 'run-2' }]);
  const waiting = begin(plan);
  const marker = markerFor(waiting.plan, waiting.planned, { phase: 'wait', waitingOut: { row: 'U1.survival.full', stepKey: 'run-1', step: waiting.planned.step, load: 1, stage: 'encode', terminatedAtWall: T0 } });
  const applied = applyLoad(waiting.plan, verdictOf(waiting.plan, marker), NOW);
  assert.deepEqual(events(applied.rows).map((e) => e.type), ['step-lost']);
  assert.deepEqual([applied.plan.rows[0], applied.plan.cursor, applied.plan.kills], [plan.rows[0], 1, 1]);
});
