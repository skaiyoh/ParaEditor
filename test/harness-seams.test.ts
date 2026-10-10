// What the harness's core reads per page and per step kind, with only the
// memory page's cases: the storage keys of each page, the plan kinds of each
// page, a plan's levers keyed by its plan kind in the `plan` event and the
// stored plan, and, for every memory step kind, the hidden grace a completed
// step is scored by and what its fifth void ends. The resume wait per step
// kind is pinned in harness-load.test.ts, "the least wait after a non-fresh
// load is the dead step largest stage cooldown, scaled, and 0 after a ballast
// step".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreCompleted } from '../src/dev/harness/load.ts';
import { HIDDEN_GRACE_MS, VOID_CAP } from '../src/dev/harness/lines.ts';
import { createOutbox, type OutboxStorage } from '../src/dev/harness/outbox.ts';
import { harnessKeys, memoryPlanKindSchema, PLAN_KINDS, PLAN_PAGE, type PlanKindOf } from '../src/dev/harness/catalog.ts';
import { createPlan, parsePlan, voidStep } from '../src/dev/harness/plan.ts';
import { hiddenGraceMsFor, voidCapScopeFor, type Step } from '../src/dev/harness/steps.ts';
import { parseHarnessRow } from '../src/dev/harness/rows.ts';
import { begin, BUILD, LEVERS, markerFor, planOf, RUN, SURVIVED, T0 } from './fixtures/harness.ts';

/** One step of each memory step kind. */
function memorySteps(): readonly Step[] {
  const sequence = begin(planOf(['U1.survival.full'])).planned.step;
  return [{ kind: 'untouched', mb: 1500 }, { kind: 'ballast', mb: 800, release: 'all' }, sequence];
}

test('the memory page stores its plan, step marker, and outbox under its own keys', () => {
  assert.deepEqual(harnessKeys('memory'), { plan: 'noisy.harness.memory.plan', step: 'noisy.harness.memory.step', outbox: 'noisy.harness.memory.outbox' });
  const items = new Map<string, string>();
  const storage: OutboxStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
  const outbox = createOutbox({ page: 'memory', storage, post: async () => ({ kind: 'recorded' }) });
  outbox.enqueue(begin(planOf(['U1.survival.full'])).rows[0] ?? assert.fail());
  assert.deepEqual([...items.keys()], ['noisy.harness.memory.outbox']);
});

test('both plan kinds run on the memory page', () => {
  assert.deepEqual(PLAN_PAGE, { full: 'memory', short: 'memory' });
  assert.deepEqual(memoryPlanKindSchema.options, ['full', 'short']);
  // Compiles only while every plan kind is the memory page's.
  const memoryKinds: readonly PlanKindOf<'memory'>[] = PLAN_KINDS;
  assert.deepEqual(memoryKinds, ['full', 'short']);
});

test('a plan event and a stored plan of each memory plan kind hold the memory levers and parse back unchanged', () => {
  for (const kind of ['full', 'short'] as const) {
    const made = createPlan({ kind, run: RUN, build: BUILD, levers: { ...LEVERS, rows: ['U1.survival.full'] }, levered: true, ascentCapMb: null, nowWall: T0 });
    assert.ok(made.ok, kind);
    const { plan, rows } = made.value;
    const stored = JSON.stringify(plan);
    const parsed = parsePlan(stored);
    assert.deepEqual(parsed, { ok: true, value: plan }, kind);
    assert.equal(parsed.ok && JSON.stringify(parsed.value), stored, `${kind}: the stored plan's text is unchanged by a parse`);
    const row = rows[0] ?? assert.fail();
    assert.equal(row.event.type === 'plan' && row.event.planKind, kind);
    const posted = parseHarnessRow(JSON.parse(JSON.stringify(row)));
    assert.deepEqual(posted, { ok: true, value: row }, kind);
    assert.equal(posted.ok && JSON.stringify(posted.value), JSON.stringify(row), `${kind}: the posted row's text is unchanged by a parse`);

    // Levers that are not the memory levers are refused, in the event and in the stored plan.
    const { runs: _runs, ...withoutRuns } = plan.levers;
    assert.equal(parsePlan(JSON.stringify({ ...plan, levers: withoutRuns })).ok, false, kind);
    assert.equal(parseHarnessRow({ ...row, event: { ...row.event, levers: withoutRuns } }).ok, false, kind);
    // A plan kind no page runs has no levers variant.
    assert.equal(parsePlan(JSON.stringify({ ...plan, kind: 'capability' })).ok, false, kind);
    assert.equal(parseHarnessRow({ ...row, event: { ...row.event, planKind: 'capability' } }).ok, false, kind);
  }
});

test('every memory step kind is scored by the app hidden grace when it completes', () => {
  for (const step of memorySteps()) {
    assert.equal(hiddenGraceMsFor(step), HIDDEN_GRACE_MS, step.kind);
    const begun = begin(planOf(['U1.survival.full']));
    const marker = markerFor(begun.plan, { key: begun.planned.key, step });
    const scored = (longestHiddenMs: number): string => scoreCompleted(SURVIVED, { ...marker, hiddenMs: longestHiddenMs, longestHiddenMs }, T0).kind;
    assert.deepEqual([scored(HIDDEN_GRACE_MS), scored(HIDDEN_GRACE_MS + 1)], ['ran', 'void'], step.kind);
  }
});

test("every memory step kind's fifth void ends its row no-reading", () => {
  for (const step of memorySteps()) {
    assert.equal(voidCapScopeFor(step), 'row', step.kind);
    const begun = begin(planOf(['U1.survival.full', 'U1.survival.low']));
    const below = voidStep(begun.plan, { ...begun.counts, voids: VOID_CAP - 2 }, step, T0);
    assert.deepEqual([below.plan.rows[0]?.halt, below.plan.cursor, below.rows], [null, 0, []], step.kind);
    const capped = voidStep(begun.plan, { ...begun.counts, voids: VOID_CAP - 1 }, step, T0);
    assert.deepEqual([capped.plan.rows[0]?.halt, capped.plan.cursor], [{ kind: 'no-reading', stepKey: 'run-1' }, 1], step.kind);
    assert.deepEqual(
      capped.rows.map((r) => r.event),
      [{ type: 'row-end', row: 'U1.survival.full', verdict: { kind: 'no-reading', stepKey: 'run-1' }, amends: false }],
      step.kind,
    );
  }
});
