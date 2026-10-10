// The memory harness page, /dev/harness/memory.html, driving the engine on
// Chrome's real storage, Web Locks, visibility, and renderer: the untouched
// calibration run to DONE; the renderer crashed in each of the step's phases
// (its wait, its allocation, its hold) and the page reopened; the page
// reloaded while the step allocates and while it holds; frozen as a
// background tab and crashed in each phase, frozen briefly and crashed, and
// frozen past the hidden grace while the step completes;
// five frozen crashes of one step; the sink answering 500 until a later
// load; a stored plan of another build and one that does not parse; the
// levers, valid and not; the page's and the plan's refusals of Start and
// Short run; Stop mid-step; a same-origin frame standing in for a second
// tab, opened on a running plan; Start in a page after a frame standing in
// for another tab started a run and was removed mid-step; the page at
// phone size in light and dark; and the two kill-point rows at 1 MB chunks:
// the ladder to its ceiling in both rows with every checksum recomputed in
// node, the throwAtMb lever ending it, and the renderer crashed in a step's
// fill and in a step's hold, each crash read back by the next load's liveness
// row and its late rows; and the wake lock held, refused when the page turns
// visible again, and requested again by a tap on its target; U1.survival.none
// on the real models run to DONE, with each run's phases, high-water marks,
// worker census, stand-in checksums, and gap, the renderer crashed in run 1's
// setup, run:depth, run:encode, and after and in the wait before run 2, and
// the master's route answering 503 until it recovers; and the holes the
// page's inputs make, hashed in Chrome. Every scenario but the last reads the
// rows back from the sink, deduplicated by rowId and ordered by seq, and
// checks them against the load verdicts and the plan's rules.

import { depthInputSize } from '../../../src/analysis/depth-size.ts';
import { SAM_EMBEDDING_TENSORS } from '../../../src/analysis/stage-math.ts';
import { isBuildId } from '../../../src/core/ids.ts';
import { z } from '../../../src/core/zod.ts';
import { LOCK_WAIT_MS } from '../../../src/dev/harness/engine.ts';
import { MB, STAND_IN_CHUNK } from '../../../src/dev/harness/ballast.ts';
import { HOLE_SHAPES } from '../../../src/dev/harness/holes.ts';
import { COOLDOWN_MS, LEVER_DEFAULTS } from '../../../src/dev/harness/lines.ts';
import { BLOCKED_RETRY_MS } from '../../../src/dev/harness/runner.ts';
import { harnessKeys, PLAN_ROWS, type RowId } from '../../../src/dev/harness/catalog.ts';
import { createPlan } from '../../../src/dev/harness/plan.ts';
import { missingPrograms } from '../../../src/dev/harness/registry.ts';
import { parseHarnessRow, type ChecksumPair, type HarnessEvent, type HarnessRow } from '../../../src/dev/harness/rows.ts';
import { referenceSum } from '../../support/ballast-reference.ts';
import { HOLE_MASTERS, PINNED_HOLE_DIGESTS } from '../../fixtures/hole-digests.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const PAGE = '/dev/harness/memory.html';
const KEYS = harnessKeys('memory');
/** The untouched row alone, 10 MB in chunks of 1 MB. */
const SMALL = 'rows=U1.untouched&untouchedMb=10&chunkMb=1';
const PHONE = { width: 393, height: 852 } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const url = (levers: string): string => `${PAGE}?${levers}`;

// ---------------------------------------------------------------------------
// the page

const Report = z.object({
  phase: z.string(),
  headline: z.string(),
  context: z.string(),
  levers: z.record(z.string(), z.unknown()).nullable(),
  levered: z.boolean(),
  leverError: z.string().nullable(),
  load: z.string().nullable(),
  tab: z.string().nullable(),
  navigation: z.string(),
  run: z.object({ run: z.string(), kind: z.string(), loads: z.number(), kills: z.number(), voids: z.number(), cursor: z.number(), seq: z.number() }).nullable(),
  step: z.object({ row: z.string(), stepKey: z.string(), attempt: z.number(), phase: z.string() }).nullable(),
  pending: z.number().nullable(),
  reason: z.string().nullable(),
  refused: z.unknown(),
  runner: z.object({ chunks: z.number(), mb: z.number() }),
  wakeLock: z.unknown(),
});

const View = z.object({
  report: Report,
  wake: z.string().nullable(),
  wakeTap: z.boolean(),
  context: z.string().nullable(),
  headline: z.string().nullable(),
  step: z.string().nullable(),
  phase: z.string().nullable(),
  counts: z.string().nullable(),
  verdicts: z.array(z.string()),
  pending: z.string().nullable(),
  levered: z.boolean(),
  start: z.boolean(),
  shortRun: z.boolean(),
  stop: z.boolean(),
});
type View = z.infer<typeof View>;

/** The page's status and report, read from `doc`'s DOM; null while it is starting. */
function readView(frame: string | null): unknown {
  const doc = frame === null ? document : document.querySelector<HTMLIFrameElement>(`iframe#${frame}`)?.contentDocument;
  const report = doc?.querySelector<HTMLElement>('[data-testid=report]');
  if (doc === null || doc === undefined || report === null || report === undefined || report.dataset['phase'] === 'starting' || report.textContent === '') return null;
  const text = (id: string): string | null => {
    const el = doc.querySelector<HTMLElement>(`[data-testid=status] [data-testid=${id}]`);
    return el === null || el.hidden ? null : el.textContent;
  };
  const shown = (id: string): boolean => {
    const el = doc.querySelector<HTMLElement>(`[data-testid=${id}]`);
    return el !== null && !el.hidden;
  };
  return {
    report: JSON.parse(report.textContent ?? ''),
    context: text('context'),
    headline: text('headline'),
    step: text('step'),
    phase: text('phase'),
    counts: text('counts'),
    verdicts: [...doc.querySelectorAll('[data-testid=verdicts] li')].map((li) => li.textContent ?? ''),
    pending: text('pending'),
    wake: text('wake'),
    wakeTap: shown('wake-tap'),
    levered: shown('levered'),
    start: shown('start'),
    shortRun: shown('short-run'),
    stop: shown('stop'),
  };
}

/** Polls the page (or the frame `frame`) until `done` holds for its view; a navigation under way reads as not yet. */
async function until(t: ScenarioContext, description: string, done: (view: View) => boolean, timeoutMs = 15_000, frame: string | null = null): Promise<View> {
  const deadline = Date.now() + timeoutMs;
  let last: View | null = null;
  for (;;) {
    try {
      const view = await t.page.evaluate(View.nullable(), readView, frame);
      if (view !== null) {
        last = view;
        if (done(view)) return view;
      }
    } catch {
      // A page between navigations answers nothing; ask again.
    }
    if (Date.now() > deadline) throw new Error(`${description}: not within ${timeoutMs} ms; last view ${JSON.stringify(last)}`);
    await sleep(50);
  }
}

const isIdle = (v: View): boolean => v.report.phase === 'idle';
const isDonePosted = (v: View): boolean => v.report.phase === 'done' && v.report.pending === 0;
const inPhase = (phase: string, attempt = 1) => (v: View): boolean => v.report.step?.phase === phase && v.report.step.attempt === attempt;
const allocating = (atLeastMb: number) => (v: View): boolean => /^alloc:\d+$/.test(v.report.step?.phase ?? '') && Number(v.report.step?.phase.slice(6)) >= atLeastMb;

async function open(t: ScenarioContext, levers: string): Promise<View> {
  await t.page.goto(url(levers));
  return until(t, 'the page to be ready', isIdle);
}

async function startRun(t: ScenarioContext): Promise<void> {
  await t.page.click('[data-testid=start]');
}

const Stored = z.tuple([z.string().nullable(), z.string().nullable(), z.string().nullable()]);

/** The plan, the step marker, and the outbox, as stored. */
function readStored(planKey: string, stepKey: string, outboxKey: string): unknown {
  return [localStorage.getItem(planKey), localStorage.getItem(stepKey), localStorage.getItem(outboxKey)];
}

async function stored(t: ScenarioContext): Promise<z.infer<typeof Stored>> {
  return t.page.evaluate(Stored, readStored, KEYS.plan, KEYS.step, KEYS.outbox);
}

const StoredWithApp = z.tuple([z.string().nullable(), z.string().nullable(), z.string().nullable(), z.string().nullable()]);

/** The plan, the step marker, the outbox, and the one app-shaped marker stored, if any. */
function readStoredWithApp(planKey: string, stepKey: string, outboxKey: string): unknown {
  const app = Object.keys(localStorage).filter((key) => key.startsWith('noisy.harness.job.'));
  return [localStorage.getItem(planKey), localStorage.getItem(stepKey), localStorage.getItem(outboxKey), app.length === 1 && app[0] !== undefined ? localStorage.getItem(app[0]) : null];
}

const Marker = z.object({ phase: z.string(), visibility: z.string(), hiddenMs: z.number(), attempt: z.number() });
const OutboxShape = z.object({ rows: z.array(z.unknown()) });

/** The rows waiting in the stored outbox. */
function outboxRows(text: string | null): number {
  return text === null ? 0 : OutboxShape.parse(JSON.parse(text)).rows.length;
}

// ---------------------------------------------------------------------------
// the sink

type Sink = { readonly rows: readonly HarnessRow[]; readonly copies: number; readonly differing: readonly string[] };

/** The harness rows in the sink, deduplicated by rowId (a copy that differs is listed) and ordered by run, then seq. */
async function readSink(t: ScenarioContext): Promise<Sink> {
  const byId = new Map<string, HarnessRow>();
  const differing: string[] = [];
  let copies = 0;
  for (const line of await t.server.sinkLines()) {
    if (!('row' in line)) continue;
    const value = line.row;
    if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'harness') continue;
    const parsed = parseHarnessRow(value);
    if (!parsed.ok) throw new Error(`a harness row in the sink does not parse: ${parsed.error}`);
    copies += 1;
    const seen = byId.get(parsed.value.rowId);
    if (seen === undefined) byId.set(parsed.value.rowId, parsed.value);
    else if (JSON.stringify(seen) !== JSON.stringify(parsed.value)) differing.push(parsed.value.rowId);
  }
  const rows = [...byId.values()].sort((a, b) => (a.run === b.run ? a.seq - b.seq : a.run < b.run ? -1 : 1));
  return { rows, copies, differing };
}

const types = (rows: readonly HarnessRow[]): string[] => rows.map((r) => r.event.type);

function eventOf<T extends HarnessEvent['type']>(rows: readonly HarnessRow[], type: T, nth = 0): Extract<HarnessEvent, { readonly type: T }> {
  const found = rows.map((r) => r.event).filter((e): e is Extract<HarnessEvent, { readonly type: T }> => e.type === type)[nth];
  if (found === undefined) throw new Error(`the sink has no ${type} row number ${nth + 1}`);
  return found;
}

/** A late row, or the gap its reserved seq leaves when the page that reserved it died before it was due. */
const LATE_OR_GAP = 'liveness-late|gap';
/** The rows a death verdict posts after its verdict's rows, the page living past 10 s. */
const LIVENESS = ['liveness', 'liveness-late', 'liveness-late'] as const;
/** The same, from a page that may have died before its late rows were due. */
const LIVENESS_CUT = ['liveness', LATE_OR_GAP, LATE_OR_GAP] as const;

/** The event types by seq from 0, each missing seq a `gap`, `wake-lock` rows left out (a page posts one for each wake-lock answer while it runs, at times the browser picks). */
function seqTypes(rows: readonly HarnessRow[]): string[] {
  const last = Math.max(-1, ...rows.map((r) => r.seq));
  return Array.from({ length: last + 1 }, (_, seq) => rows.find((r) => r.seq === seq)?.event.type ?? 'gap').filter((type) => type !== 'wake-lock');
}

/**
 * Checks the sink's rows: one run, no copy differing, and `seqTypes` the
 * expected events, an entry listing alternatives with `|`. Late rows come up
 * to 10 s after their load, so it reads the sink again until the events match
 * or 20 s pass.
 */
async function sinkRun(t: ScenarioContext, expected: readonly string[]): Promise<readonly HarnessRow[]> {
  const matches = (found: readonly string[]): boolean => found.length === expected.length && found.every((type, i) => (expected[i] ?? '').split('|').includes(type));
  const deadline = Date.now() + 20_000;
  let sink = await readSink(t);
  while (!matches(seqTypes(sink.rows)) && Date.now() < deadline) {
    await sleep(250);
    sink = await readSink(t);
  }
  const runs = [...new Set(sink.rows.map((r) => r.run))];
  t.equal('the sink holds the rows of one run', runs.length, 1, { runs });
  t.equal('every copy of a row the sink got twice is the same row', sink.differing, [], { copies: sink.copies, unique: sink.rows.length });
  t.ok('its rows by seq, deduplicated by rowId, each missing seq a gap and wake-lock rows left out, are the expected events', matches(seqTypes(sink.rows)), { found: seqTypes(sink.rows), expected });
  return sink.rows;
}

/** Checks a liveness row of the page `deadTab`: its marker survived with the step's values, and its tab lock was free at the load. */
function checkLiveness(t: ScenarioContext, rows: readonly HarnessRow[], nth: number, deadTab: string | null, killIndex: number, op: string): void {
  const liveness = eventOf(rows, 'liveness', nth);
  t.equal(`liveness ${killIndex}: the dead tab, its kill index, and its tab lock free at the load`, [liveness.deadTab, liveness.killIndex, liveness.lockAtLoad], [deadTab, killIndex, { kind: 'read', held: false, pending: false }]);
  const value = AppMarker.safeParse(liveness.appMarker.value);
  t.ok(`liveness ${killIndex}: the app-shaped marker survived the crash, the dead tab's, for op ${op}`, liveness.appMarker.survived && value.success && value.data.tab === deadTab && value.data.op === op, liveness.appMarker);
}

/** The late rows of the liveness row `nth`: its tab lock free at 2 s and 10 s, in the seqs after it. */
function checkLate(t: ScenarioContext, rows: readonly HarnessRow[], nth: number): void {
  const at = rows.filter((r) => r.event.type === 'liveness')[nth];
  const late = rows.filter((r) => at !== undefined && (r.seq === at.seq + 1 || r.seq === at.seq + 2)).map((r) => r.event);
  const deadTab = at?.event.type === 'liveness' ? at.event.deadTab : null;
  t.equal(`the late rows of liveness ${nth + 1} read its tab lock free at 2 s and 10 s`, late, [2_000, 10_000].map((afterMs) => ({ type: 'liveness-late', deadTab, afterMs, lock: { kind: 'read', held: false, pending: false } })));
}

/**
 * Every liveness row: the dead tab's app-shaped marker survived, as that
 * tab's, for `op`, and its tab lock was free at the load; every late row the
 * sink holds: in the two seqs after its liveness row, of the same tab, the
 * lock free.
 */
function checkDeaths(t: ScenarioContext, rows: readonly HarnessRow[], op: string): void {
  const isFree = (reading: { readonly kind: string; readonly held?: boolean; readonly pending?: boolean }): boolean => reading.kind === 'read' && reading.held === false && reading.pending === false;
  const reports = rows.flatMap((r) => (r.event.type === 'liveness' ? [{ seq: r.seq, event: r.event }] : []));
  const survived = reports.every(({ event }) => {
    const value = AppMarker.safeParse(event.appMarker.value);
    return event.appMarker.survived && value.success && value.data.tab === event.deadTab && value.data.op === op && isFree(event.lockAtLoad);
  });
  t.ok(`every liveness row (${reports.length}): the dead tab's marker survived, for op ${op}, and its tab lock was free at the load`, reports.length > 0 && survived, reports);
  const late = rows.flatMap((r) => (r.event.type === 'liveness-late' ? [{ seq: r.seq, event: r.event }] : []));
  const placed = late.every(({ seq, event }) => reports.some((report) => (seq === report.seq + 1 || seq === report.seq + 2) && report.event.deadTab === event.deadTab) && isFree(event.lock));
  t.ok(`every late row (${late.length}) follows its dead tab's liveness row and reads the lock free`, late.length > 0 && placed, late);
}

const AppMarker = z.object({ scene: z.string(), op: z.string(), build: z.string(), tab: z.string(), startedAt: z.number(), hiddenAt: z.number().nullable() });

// ---------------------------------------------------------------------------
// the page's layout at phone size

function layout(): unknown {
  const headline = document.querySelector('[data-testid=status] [data-testid=headline]');
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    headlinePx: headline === null ? 0 : parseFloat(getComputedStyle(headline).fontSize),
    wider: [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .map((el) => el.tagName),
  };
}
const Layout = z.object({ scrollWidth: z.number(), innerWidth: z.number(), scheme: z.string(), headlinePx: z.number(), wider: z.array(z.string()) });

/** Every visible button, link, field, and summary smaller than 44 x 44 CSS pixels. */
function smallTargets(): unknown {
  return [...document.querySelectorAll<HTMLElement>('main a, main button, main input, main summary')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const box = el.getBoundingClientRect();
      return { tag: el.tagName, text: (el.textContent ?? '').trim().slice(0, 40), width: Math.round(box.width), height: Math.round(box.height) };
    })
    .filter((target) => target.width < 44 || target.height < 44);
}
const Targets = z.array(z.object({ tag: z.string(), text: z.string(), width: z.number(), height: z.number() }));

// ---------------------------------------------------------------------------
// the second tab

/** Opens `src` in a same-origin frame `id`, which shares the page's storage and Web Locks as a second tab of the origin does. */
function addFrame(id: string, src: string): true {
  const frame = document.createElement('iframe');
  frame.id = id;
  frame.src = src;
  document.body.append(frame);
  return true;
}

/** Clicks the button `testid` in the frame `frame`. */
function clickInFrame(frame: string, testid: string): true {
  const button = document.querySelector<HTMLIFrameElement>(`iframe#${frame}`)?.contentDocument?.querySelector<HTMLElement>(`[data-testid=${testid}]`);
  if (button === null || button === undefined) throw new Error(`no ${testid} button in the frame ${frame}`);
  button.click();
  return true;
}

/** Removes the frame `frame`, which unloads its page as closing a tab does. */
function removeFrame(frame: string): true {
  document.querySelector(`iframe#${frame}`)?.remove();
  return true;
}

/** True once no page of the origin holds the runner lock. */
async function runnerLockFree(): Promise<boolean> {
  const state = await navigator.locks.query();
  return (state.held ?? []).every((lock) => lock.name !== 'noisy-harness-runner');
}

// ---------------------------------------------------------------------------
// the plan's refusals, from the plan's own rules

const noProgram = (kind: 'full' | 'short'): string => `Start refused (no-program): ${missingPrograms(PLAN_ROWS[kind]).join(', ')}`;

/** A plan of another build, as a page of that build would have stored it. */
function otherBuildPlan(): string {
  const build = '0123456789ab-20260101';
  if (!isBuildId(build)) throw new Error('the other build id is not a build id');
  const rows: readonly RowId[] = ['U1.untouched'];
  const made = createPlan({ kind: 'full', run: '20260101T000000Z-abcd', build, levers: { ...LEVER_DEFAULTS, rows, untouchedMb: 10, chunkMb: 1 }, levered: true, ascentCapMb: null, nowWall: Date.UTC(2026, 0, 1) });
  if (!made.ok) throw new Error(`the other build's plan was refused: ${made.error.kind}`);
  return JSON.stringify(made.value.plan);
}

function writePlan(key: string, text: string): true {
  localStorage.setItem(key, text);
  return true;
}

// ---------------------------------------------------------------------------
// the kill-point rows

/** The kill-point ladder at 1 MB chunks up to 30 MB. */
const LADDER = 'chunkMb=1&ceilingMb=30';
const LADDER_MB = 30;

/** Chunk i's checksum at 1 MB, recomputed in node from its seed, for every chunk the ladder makes. */
const LADDER_SUMS: readonly number[] = Array.from({ length: LADDER_MB }, (_, chunk) => referenceSum(chunk, 1_000_000));

/** The checksum pairs of a ballast of `n` 1 MB chunks, each filled and still holding the recomputed sum. */
const ladderPairs = (n: number): ChecksumPair[] => LADDER_SUMS.slice(0, n).map((sum, chunk) => ({ chunk, fill: sum, after: sum }));

/** The rows a kill-point row posts for its steps 1 to `n` MB, each held. */
const heldSteps = (n: number): string[] => Array.from({ length: n }, () => ['step-start', 'step-end']).flat();

/**
 * Makes the page stop dead, inside the engine's synchronous write of the
 * step marker in `phase`, once that write has stored the marker: it loops
 * until the renderer is crashed, so the stored marker is in that phase when
 * the page dies, as on the phone a page killed while filling a chunk.
 */
function stallAtMarkerPhase(key: string, phase: string): true {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (this: Storage, name: string, value: string): void {
    setItem.call(this, name, value);
    if (name !== key || !value.includes(`"phase":"${phase}"`)) return;
    for (;;) {
      // Stalled until the renderer is crashed.
    }
  };
  return true;
}

/**
 * Records every text the status's phase line shows, in order, in the
 * document element's `data-phase-words`, since a 1 MB chunk's fill is shown
 * for too short a time to be polled.
 */
function recordPhaseWords(): true {
  const line = document.querySelector('[data-testid=status] [data-testid=phase]');
  if (line === null) throw new Error('the status has no phase line');
  const words: string[] = [];
  new MutationObserver(() => {
    const text = line.textContent ?? '';
    if (words.at(-1) !== text) words.push(text);
    document.documentElement.dataset['phaseWords'] = JSON.stringify(words);
  }).observe(line, { childList: true, characterData: true, subtree: true });
  return true;
}

function readPhaseWords(): unknown {
  return JSON.parse(document.documentElement.dataset['phaseWords'] ?? '[]');
}

/** Waits until the sink holds the `step-start` of the step `stepKey`. */
async function sinkHasStepStart(t: ScenarioContext, stepKey: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await readSink(t);
    if (rows.some((r) => r.event.type === 'step-start' && r.event.stepKey === stepKey)) return;
    if (Date.now() > deadline) throw new Error(`the sink has no step-start of ${stepKey} within ${timeoutMs} ms`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------
// the survival row

/**
 * U1.survival.none alone at two runs, its waits a quarter of the app's: the
 * encoder's 20 s cooldown before run 2 lasts 5 s. In four runs of each
 * scenario on this Mac, at a quarter both runs' high-water marks read 290 MB
 * at depth and 722 MB at the encoder, and the census while each run's stages
 * ran read at most one sequence worker and one pthread worker. At a
 * hundredth, run 2 spawned 204 to 207 ms after run 1's termination; the census
 * while run 2's stages ran read two sequence workers and two pthread workers
 * in all four; run 1's encoder read 722 MB each time and run 2's 722, 798,
 * 722, and 791 MB, 798 above the band. So the scenario at a hundredth holds run 1
 * to the bands and the census, and records run 2's encoder and census.
 */
const SURVIVAL_SCALE = 0.25;
const survivalLevers = (scale: number): string => `rows=U1.survival.none&runs=2&defaultsScale=${scale}`;
const SURVIVAL = survivalLevers(SURVIVAL_SCALE);
/** The defaultsScale lever's value for a hundredth of the app's waits. */
const SHORT_SCALE = 0.01;
/** The input-recovers scenario's defaultsScale lever: a 300 ms retry time. */
const RECOVER_SCALE = 0.01;
const SURVIVAL_MASTER = { width: 2048, height: 1536 } as const;
/** The run step the runs program makes for U1.survival.none at `scale`. */
const survivalStep = (scale: number) => ({
  kind: 'sequence',
  stages: ['depth', 'encode'],
  master: SURVIVAL_MASTER,
  hole: null,
  condition: { standIn: true, gl: 'none', ballastMb: 0, decoder: 'none' },
  threads: 2,
  wait: { kind: 'cooldown', scale },
  decode: 'none',
  after: { gl: null, openDecoder: false },
});

/** A megabyte count from a byte count, rounded, as the sequence scenarios read a high-water mark. */
const megabytes = (bytes: number | null): number | null => (bytes === null ? null : Math.round(bytes / 1e6));

/**
 * Records every value `#report`'s `data-step` takes, in order, in the
 * document element's `data-step-trace`: each mutation's old value, the
 * current value read with them, so a phase that lasted less than a poll is
 * still listed.
 */
function recordStepPhases(): true {
  const report = document.querySelector<HTMLElement>('[data-testid=report]');
  if (report === null) throw new Error('the page has no report');
  const values: string[] = [];
  new MutationObserver((records) => {
    for (const record of records) values.push(record.oldValue ?? '');
    document.documentElement.dataset['stepTrace'] = JSON.stringify(values);
  }).observe(report, { attributes: true, attributeFilter: ['data-step'], attributeOldValue: true });
  return true;
}

/** The phases each step reported, in order, from the trace `recordStepPhases` keeps. */
function readStepPhases(): unknown {
  const values: string[] = [...JSON.parse(document.documentElement.dataset['stepTrace'] ?? '[]'), document.querySelector<HTMLElement>('[data-testid=report]')?.dataset['step'] ?? ''];
  const steps: string[][] = [];
  let previous: string | null = null;
  for (const value of values) {
    if (value === previous) continue;
    previous = value;
    if (value === '') steps.push([]);
    else if (steps.length === 0) steps.push([value]);
    else steps[steps.length - 1]?.push(value);
  }
  return steps.filter((phases) => phases.length > 0);
}

/** The SHA-256 of the hole the page's inputs make, from its surface. */
function pageHoleDigest(shape: string, width: number, height: number): Promise<string> {
  const surface = window.__noisyHarness;
  if (surface === undefined) throw new Error('the page has no harness surface');
  return surface.holeDigest(shape, width, height);
}

// ---------------------------------------------------------------------------
// the wake lock

/**
 * Wraps `WakeLock.prototype.request`, which the page's engine calls on
 * `navigator.wakeLock`, to count its calls in the document element's
 * `data-wake-requests` and to refuse each with a NotAllowedError while
 * `data-wake-refuse` is `true`, as a browser may refuse one made without a tap.
 */
function scriptWakeLock(refuse: boolean): true {
  const root = document.documentElement;
  root.dataset['wakeRefuse'] = String(refuse);
  if (root.dataset['wakeScripted'] === 'true') return true;
  root.dataset['wakeScripted'] = 'true';
  const request = WakeLock.prototype.request;
  WakeLock.prototype.request = function (this: WakeLock, type?: WakeLockType): Promise<WakeLockSentinel> {
    root.dataset['wakeRequests'] = String(Number(root.dataset['wakeRequests'] ?? '0') + 1);
    if (root.dataset['wakeRefuse'] === 'true') return Promise.reject(new DOMException('The scenario refused the wake lock.', 'NotAllowedError'));
    return request.call(this, type);
  };
  return true;
}

function wakeRequests(): unknown {
  return Number(document.documentElement.dataset['wakeRequests'] ?? '0');
}

/** U1.survival.none at two runs with its waits at `scale` of the app's, on the real models. */
function survivalNone(scale: number): Scenario {
  const quarter = scale === SURVIVAL_SCALE;
  const waitMs = COOLDOWN_MS.encode * scale;
  const levers = survivalLevers(scale);
  return {
    id: quarter ? 'harness.survival-none' : 'harness.survival-none-short',
    title: quarter
      ? `U1.survival.none at two runs and a quarter of the waits runs [depth, encode] on the real models to DONE, 2 of 2: each run reports wait, setup, run:depth, run:encode, and after, its depth high-water 277 to 348 MB and its encoder's 708 to 796 MB, one pthread worker beside its sequence worker, the stand-in's checksums node's, the second run's gap at least its ${waitMs} ms wait with its setup after it, and nothing held at DONE`
      : `U1.survival.none at two runs and a hundredth of the waits runs to DONE, 2 of 2, with the same phases, stand-in, and products: run 1 in the bands with one pthread worker beside its sequence worker, run 2's depth in its band, and the second run's gap at least its ${waitMs} ms wait with its setup after it; run 2's encoder high-water mark and census are recorded, not held to the bands`,
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 240_000,
    async run(t) {
      await open(t, levers);
      await t.page.evaluate(z.literal(true), recordStepPhases);
      await startRun(t);
      // The census, sampled with each view while the run goes: the sequence and pthread worker targets attached, by the step and phase the page was in.
      const census: { readonly stepKey: string; readonly phase: string; readonly sequence: number; readonly pthreads: number }[] = [];
      const held: { readonly phase: string; readonly runner: { readonly chunks: number; readonly mb: number } }[] = [];
      const deadline = Date.now() + 200_000;
      let done: View | null = null;
      while (done === null) {
        const alive = t.page.workers();
        let view: View | null = null;
        try {
          view = await t.page.evaluate(View.nullable(), readView, null);
        } catch {
          // A page between renders answers nothing; ask again.
        }
        const step = view?.report.step ?? null;
        if (step !== null && view !== null) {
          census.push({ stepKey: step.stepKey, phase: step.phase, sequence: alive.filter((w) => w.title === 'sequence').length, pthreads: alive.filter((w) => /^em-pthread/.test(w.title)).length });
          if (step.phase.startsWith('run:')) held.push({ phase: step.phase, runner: view.report.runner });
        }
        if (view !== null && isDonePosted(view)) done = view;
        else if (Date.now() > deadline) throw new Error(`the survival row did not reach DONE; last view ${JSON.stringify(view)}`);
        else await sleep(50);
      }
      t.equal('the page says DONE, 2 of 2, in one load, and holds nothing', [done.headline, done.counts, done.verdicts, done.report.runner], ['DONE', 'Loads 1, kills 0, voids 0', ['U1 survival none: 2 of 2'], { chunks: 0, mb: 0 }]);
      const phases = await t.page.evaluate(z.array(z.array(z.string())), readStepPhases);
      t.equal('each run reported wait, setup, run:depth, run:encode, and after, in that order', phases, [0, 1].map(() => ['wait', 'setup', 'run:depth', 'run:encode', 'after']));
      t.ok('while each run\'s stages ran the runner held the 100 MB stand-in alone', held.length > 0 && held.every((h) => h.runner.chunks === 1 && h.runner.mb === 100), held.slice(0, 3));
      await t.file('census.json', JSON.stringify(census, null, 2));
      // At a hundredth run 2 spawns while Chrome still lists run 1's workers, so only run 1 is held to the census there, and run 2's is recorded.
      for (const stepKey of ['run-1', 'run-2']) {
        const running = census.filter((c) => c.stepKey === stepKey && c.phase.startsWith('run:'));
        const most = [Math.max(0, ...running.map((c) => c.sequence)), Math.max(0, ...running.map((c) => c.pthreads))];
        if (quarter || stepKey === 'run-1') t.equal(`the census while ${stepKey}'s stages ran: one sequence worker and one pthread worker under it, ONNX Runtime's at 2 threads, and never more`, most, [1, 1], { samples: running.length });
        else t.ok(`the census while ${stepKey}'s stages ran was sampled, its most sequence and pthread workers recorded`, running.length > 0, { most, samples: running.length });
      }

      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'step-start', 'step-end', 'row-end', 'done']);
      await t.file('sink-rows.json', JSON.stringify(rows, null, 2));
      const starts = rows.map((r) => r.event).flatMap((e) => (e.type === 'step-start' ? [e] : []));
      t.equal(`the two steps are run-1 and run-2, each the survival run: [depth, encode] on 2048 x 1536 at 2 threads beside the stand-in with no GL, waiting the cooldown at ${scale}`, starts.map((e) => [e.row, e.stepKey, e.attempt, e.step]), [1, 2].map((k) => ['U1.survival.none', `run-${k}`, 1, survivalStep(scale)]));
      const readings = rows.map((r) => r.event).flatMap((e) => (e.type === 'step-end' && e.outcome.kind === 'ran' ? [{ score: e.outcome.score, reading: e.outcome.reading }] : []));
      t.equal('both runs survived', readings.map((r) => r.score), [{ kind: 'survived' }, { kind: 'survived' }]);
      const standInSum = referenceSum(STAND_IN_CHUNK, 100 * MB);
      const map = depthInputSize(SURVIVAL_MASTER);
      for (const [i, { reading }] of readings.entries()) {
        const run = `run ${i + 1}`;
        const [depth, encode] = reading.stages;
        t.equal(`${run}: one depth and one encode stage, in order`, reading.stages.map((stage) => stage.op), ['depth', 'encode']);
        const depthMb = megabytes(depth?.wasmHighWaterBytes ?? null);
        const encodeMb = megabytes(encode?.wasmHighWaterBytes ?? null);
        t.ok(`${run}: the depth high-water mark lies in 277 to 348 MB`, depthMb !== null && depthMb >= 277 && depthMb <= 348, { depthMb });
        if (quarter || i === 0) t.ok(`${run}: the encoder's high-water mark after depth lies in 708 to 796 MB`, encodeMb !== null && encodeMb >= 708 && encodeMb <= 796, { encodeMb });
        else t.ok(`${run}: the encoder's high-water mark after depth was read`, encodeMb !== null, { encodeMb });
        t.ok(`${run}: the worker lived from spawn to termination at least as long as its stages ran`, reading.wallMs !== null && reading.wallMs >= (depth?.ms ?? 0) + (encode?.ms ?? 0) - 1, { wallMs: reading.wallMs, stages: reading.stages });
        t.equal(`${run}: the products: a ${map.width} x ${map.height} map in 0 to 1, the encoder's three embeddings, no plate`, reading.product, {
          map: { size: map, min: 0, max: 1 },
          embeddings: { dims: SAM_EMBEDDING_TENSORS.map((spec) => [...spec.dims]) },
          plate: null,
        });
        t.equal(`${run}: no GL, and the stand-in's checksums node's recomputation at fill and after the run`, reading.condition, {
          gl: 'none',
          textureBytes: 0,
          glBuild: null,
          framesDrawn: 0,
          contextLostAtMs: null,
          standIn: [{ chunk: STAND_IN_CHUNK, fill: standInSum, after: standInSum }],
          ballast: [],
          checksumsMatch: true,
        });
        t.equal(`${run}: load 1, never hidden`, [reading.load, reading.hiddenMs, reading.longestHiddenMs], [1, 0, 0]);
      }
      const [first, second] = readings.map((r) => r.reading);
      t.equal('run 1 had no termination before it in the load, so no gap', first?.gapMs, null);
      t.ok('run 1\'s setup, which fetched the master and the models, took time', first !== undefined && first.setupMs > 0, { setupMs: first?.setupMs });
      t.ok(`run 2's gap from run 1's termination to its spawn holds its ${waitMs} ms wait and then its setup`, second !== undefined && second.gapMs !== null && second.gapMs >= waitMs + second.setupMs, { gapMs: second?.gapMs, setupMs: second?.setupMs, waitMs });
      t.equal('the row ends 2 of 2', eventOf(rows, 'row-end').verdict, { kind: 'runs', survived: 2, of: 2, end: null });
    },
  };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'harness.untouched-done',
    title: 'the untouched row allocates 10 MB in 1 MB chunks, holds them, releases them, and reaches DONE, posting plan, load, step-start, step-end, row-end, and done in seq order, the load row Start\'s own',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      const idle = await open(t, `${SMALL}&defaultsScale=0.2`);
      t.equal('a fresh page reads Ready and offers Start and Short run, not Stop', [idle.headline, idle.start, idle.shortRun, idle.stop], ['Ready', true, true, false]);
      t.equal('it names its context and shows the levered banner', [idle.context, idle.levered, idle.report.load], ['Safari tab', true, 'idle']);
      await startRun(t);
      const holding = await until(t, 'the step to hold', inPhase('hold:10'));
      t.equal('the status names the row, the step, and the phase in words', [holding.step, holding.phase], ['U1 untouched: 10 MB, attempt 1', 'Holding 10 MB']);
      t.equal('while it holds, the runner holds ten chunks, 10 MB', holding.report.runner, { chunks: 10, mb: 10 });
      t.equal('Stop is shown while the run is held, and Start is not', [holding.stop, holding.start], [true, false]);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page says DONE, the counts, the verdict, and that every row posted', [done.headline, done.counts, done.verdicts, done.pending], ['DONE', 'Loads 1, kills 0, voids 0', ['U1 untouched: survived'], 'Every row posted']);
      t.equal('at DONE the runner holds nothing, Stop is gone, and Start is offered', [done.report.runner, done.stop, done.start], [{ chunks: 0, mb: 0 }, false, true]);
      const [plan, marker, outbox] = await stored(t);
      t.equal('the plan stays stored at DONE with its cursor past the row, the marker is cleared, and the outbox is empty', [plan === null ? null : JSON.parse(plan).cursor, marker, outboxRows(outbox)], [1, null, 0]);

      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'row-end', 'done']);
      const planEvent = eventOf(rows, 'plan');
      t.equal('the plan row holds the untouched row and its levers, levered', [planEvent.planKind, planEvent.rows, planEvent.levers.untouchedMb, planEvent.levers.chunkMb, planEvent.levered], ['full', ['U1.untouched'], 10, 1, true]);
      const load = eventOf(rows, 'load');
      t.equal('the load row is Start\'s own load: its tab, a navigation, fresh, the runner lock held at once, Web Locks present, nothing dropped', [load.tab, load.navigation, load.verdict, load.runnerLock, load.webLocks, load.outboxDropped], [idle.report.tab, 'navigate', 'fresh', { kind: 'held', waitedMs: 0 }, true, 0]);
      t.ok('the load row records the wake lock\'s answer, whatever headless Chrome gives', load.wakeLock !== null, { wakeLock: load.wakeLock });
      t.ok('the load row carries the page\'s environment, cross-origin isolated, with this build', load.environment.kind === 'read' && load.environment.snapshot.crossOriginIsolated && load.environment.snapshot.build === t.build.buildId, load.environment);
      t.ok('the load row carries the lock hash and the model ids', /^[0-9a-f]{64}$/.test(load.lockHash) && load.models.length > 0, { lockHash: load.lockHash, models: load.models });
      t.equal('the step starts as attempt 1 of the untouched step of 10 MB', eventOf(rows, 'step-start'), { type: 'step-start', row: 'U1.untouched', stepKey: 'untouched', attempt: 1, step: { kind: 'untouched', mb: 10 } });
      t.equal('the step ends held: 10 MB in ten chunks, none written', eventOf(rows, 'step-end').outcome, { kind: 'held', mb: 10, chunks: 10, checksums: [], fillMs: 0 });
      t.equal('the row ends survived', eventOf(rows, 'row-end'), { type: 'row-end', row: 'U1.untouched', verdict: { kind: 'untouched', end: { kind: 'survived' } }, amends: false });
      t.equal('done counts one load, no kill, and no void', eventOf(rows, 'done'), { type: 'done', loads: 1, kills: 0, voids: 0 });
      t.ok('every row was posted in load 1', rows.every((r) => r.load === 1), rows.map((r) => r.load));
    },
  },
  {
    id: 'harness.crash-hold',
    title: 'a renderer crash during the hold, then the page reopened: one step-lost killed in hold:10, the row killed at 10 MB, the lock taken without waiting, and DONE with loads 2 and kills 1',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await open(t, SMALL);
      await startRun(t);
      await until(t, 'the step to hold', inPhase('hold:10'));
      const [, marker] = await stored(t);
      t.equal('the stored marker is in the hold when the renderer crashes', marker === null ? null : Marker.parse(JSON.parse(marker)).phase, 'hold:10');
      const deadTab = (await until(t, 'the step to hold', inPhase('hold:10'))).report.tab;
      await t.page.crash();
      await t.page.reopen(url(SMALL));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the reopened page answers done at its load and says DONE with the kill', [done.report.load, done.headline, done.counts, done.verdicts], ['done', 'DONE', 'Loads 2, kills 1, voids 0', ['U1 untouched: killed at 10 MB']]);

      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      checkLiveness(t, rows, 0, deadTab, 1, 'untouched');
      checkLate(t, rows, 0);
      checkDeaths(t, rows, 'untouched');
      await t.file('sink-rows.json', JSON.stringify(rows, null, 2));
      const load = eventOf(rows, 'load', 1);
      t.equal('the load row is the reopened page\'s: its tab, a navigation, the kill verdict, Web Locks present', [load.tab, load.navigation, load.verdict, load.webLocks], [done.report.tab, 'navigate', 'killed', true]);
      t.ok('the reopened page\'s load row records the wake lock\'s answer at its load, with no tap', load.wakeLock !== null, { wakeLock: load.wakeLock });
      t.equal('the reopened page took the runner lock without waiting', load.runnerLock, { kind: 'held', waitedMs: 0 });
      t.ok('the load row carries the page\'s environment, cross-origin isolated, with this build', load.environment.kind === 'read' && load.environment.snapshot.crossOriginIsolated && load.environment.snapshot.build === t.build.buildId, load.environment);
      t.ok('the load row carries the lock hash and the model ids', /^[0-9a-f]{64}$/.test(load.lockHash) && load.models.length > 0, { lockHash: load.lockHash, models: load.models });
      const lost = eventOf(rows, 'step-lost');
      t.equal('the step is lost as killed in hold:10, attempt 1, not after completion', [lost.row, lost.stepKey, lost.attempt, lost.verdict, lost.phase, lost.afterCompletion, lost.attributedTo, lost.hiddenMs], ['U1.untouched', 'untouched', 1, 'killed', 'hold:10', false, null, 0]);
      t.ok('the kill is dated: the marker\'s age and its heartbeat\'s age are known, the heartbeat within 2 s', lost.markerAgeMs !== null && lost.aliveAgeMs !== null && lost.aliveAgeMs >= 0 && lost.aliveAgeMs < 2_000, { markerAgeMs: lost.markerAgeMs, aliveAgeMs: lost.aliveAgeMs });
      t.equal('the row ends killed at 10 MB in hold:10', eventOf(rows, 'row-end').verdict, { kind: 'untouched', end: { kind: 'killed', atMb: 10, phase: 'hold:10' } });
      t.equal('done counts two loads, one kill, no void', eventOf(rows, 'done'), { type: 'done', loads: 2, kills: 1, voids: 0 });
      t.equal('the rows after the crash were posted in load 2', rows.filter((r) => r.event.type !== 'wake-lock').map((r) => r.load), [1, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
    },
  },
  {
    id: 'harness.crash-alloc',
    title: 'a renderer crash while the untouched step allocates: step-lost killed in alloc:N, and the row killed at the N MB its phase names',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      const levers = 'rows=U1.untouched&untouchedMb=600&chunkMb=1&defaultsScale=0.2';
      await open(t, levers);
      await startRun(t);
      const deadTab = (await until(t, 'the step to allocate 20 MB', allocating(20))).report.tab;
      await t.page.crash();
      await t.page.reopen(url(levers));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      checkLiveness(t, rows, 0, deadTab, 1, 'untouched');
      checkLate(t, rows, 0);
      checkDeaths(t, rows, 'untouched');
      const lost = eventOf(rows, 'step-lost');
      const mb = /^alloc:(\d+)$/.exec(lost.phase)?.[1];
      t.ok('the step is lost as killed while allocating, below the step\'s 600 MB', lost.verdict === 'killed' && mb !== undefined && Number(mb) >= 20 && Number(mb) <= 600, lost);
      t.equal('the row ends killed at the size the phase names', eventOf(rows, 'row-end').verdict, { kind: 'untouched', end: { kind: 'killed', atMb: Number(mb), phase: lost.phase } });
      t.equal('the page says so, with loads 2 and kills 1', [done.verdicts, done.counts], [[`U1 untouched: killed at ${mb ?? '?'} MB`], 'Loads 2, kills 1, voids 0']);
    },
  },
  {
    id: 'harness.crash-wait',
    title: 'a renderer crash in the step\'s wait, with the sink\'s posts held: voided died-idle, the step rerun as attempt 2, no kill, and every row posted once the sink answers',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      const levers = `${SMALL}&defaultsScale=0.2`;
      await open(t, levers);
      // With step-start unposted, the wait lasts its 2 s for the post.
      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'hold' } }]);
      await startRun(t);
      const deadTab = (await until(t, 'the step to wait', inPhase('wait'))).report.tab;
      await t.page.crash();
      await t.page.reopen(url(levers));
      await t.page.intercept([]);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page counts the void and no kill', [done.counts, done.verdicts], ['Loads 2, kills 0, voids 1', ['U1 untouched: survived']]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', ...LIVENESS, 'step-start', 'step-end', 'row-end', 'done']);
      checkLiveness(t, rows, 0, deadTab, 1, 'untouched');
      checkLate(t, rows, 0);
      checkDeaths(t, rows, 'untouched');
      t.equal('the reopened page\'s load reads died-idle', eventOf(rows, 'load', 1).verdict, 'died-idle');
      const lost = eventOf(rows, 'step-lost');
      t.equal('the step is lost died-idle in its wait, attempt 1', [lost.verdict, lost.phase, lost.attempt], ['died-idle', 'wait', 1]);
      t.equal('the step reruns as attempt 2 and holds', [eventOf(rows, 'step-start', 1).attempt, eventOf(rows, 'step-end').outcome.kind], [2, 'held']);
      t.equal('done counts two loads, no kill, one void', eventOf(rows, 'done'), { type: 'done', loads: 2, kills: 0, voids: 1 });
    },
  },
  {
    id: 'harness.reload-alloc-hold',
    title: 'a reload while the step allocates and a reload while it holds each void the step left and rerun it with its void count raised, no kill, until the third attempt holds',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 90_000,
    async run(t) {
      const levers = 'rows=U1.untouched&untouchedMb=600&chunkMb=1&defaultsScale=0.4';
      await open(t, levers);
      await startRun(t);
      await until(t, 'attempt 1 to allocate', (v) => allocating(20)(v) && v.report.step?.attempt === 1);
      await t.page.reload();
      await until(t, 'attempt 2 to hold', inPhase('hold:600', 2), 20_000);
      await t.page.reload();
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('the page counts two voids and no kill', [done.counts, done.verdicts], ['Loads 3, kills 0, voids 2', ['U1 untouched: survived']]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'step-start', 'load', 'step-lost', 'step-start', 'step-end', 'row-end', 'done']);
      const lost = [0, 1].map((n) => eventOf(rows, 'step-lost', n));
      t.equal('each reload is a load of navigation reload that reads left', [1, 2].map((n) => [eventOf(rows, 'load', n).navigation, eventOf(rows, 'load', n).verdict]), [['reload', 'left'], ['reload', 'left']]);
      t.equal('the steps lost were attempts 1 and 2, both left', lost.map((l) => [l.attempt, l.verdict]), [[1, 'left'], [2, 'left']]);
      t.ok('they were lost while allocating and in the hold', /^alloc:\d+$/.test(lost[0]?.phase ?? '') && lost[1]?.phase === 'hold:600', lost.map((l) => l.phase));
      t.equal('attempt 3 holds 600 MB in 600 chunks', [eventOf(rows, 'step-start', 2).attempt, eventOf(rows, 'step-end').outcome], [3, { kind: 'held', mb: 600, chunks: 600, checksums: [], fillMs: 0 }]);
      t.equal('done counts three loads, no kill, two voids', eventOf(rows, 'done'), { type: 'done', loads: 3, kills: 0, voids: 2 });
    },
  },
  {
    id: 'harness.freeze-crash-each-phase',
    title: 'the page frozen as a background tab in the step\'s wait, while it allocates, and in its hold, each time crashed and reopened: voided background and rerun with its void count raised, no kill, until the fourth attempt holds',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 90_000,
    async run(t) {
      const levers = 'rows=U1.untouched&untouchedMb=600&chunkMb=1&defaultsScale=0.4';
      await open(t, levers);
      // With step-start unposted, the wait lasts its 2 s for the post.
      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'hold' } }]);
      await startRun(t);
      await until(t, 'attempt 1 to wait', inPhase('wait', 1));
      await t.page.lifecycle('frozen');
      await t.page.crash();
      await t.page.reopen(url(levers));
      await t.page.intercept([]);
      await until(t, 'attempt 2 to allocate', (v) => allocating(20)(v) && v.report.step?.attempt === 2);
      await t.page.lifecycle('frozen');
      await t.page.crash();
      await t.page.reopen(url(levers));
      await until(t, 'attempt 3 to hold', inPhase('hold:600', 3), 20_000);
      await t.page.lifecycle('frozen');
      await t.page.crash();
      await t.page.reopen(url(levers));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('the page counts three voids and no kill', [done.counts, done.verdicts], ['Loads 4, kills 0, voids 3', ['U1 untouched: survived']]);
      // Each reopened page but the last is frozen and crashed within seconds of its load, before its late rows may be due.
      const cycle = ['load', 'step-lost', ...LIVENESS_CUT, 'step-start'];
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', ...cycle, ...cycle, 'load', 'step-lost', ...LIVENESS, 'step-start', 'step-end', 'row-end', 'done']);
      checkDeaths(t, rows, 'untouched');
      t.equal('each background death posted a liveness row, kill index 1 to 3, the marker surviving', [0, 1, 2].map((n) => [eventOf(rows, 'liveness', n).killIndex, eventOf(rows, 'liveness', n).appMarker.survived]), [[1, true], [2, true], [3, true]]);
      t.ok('the marker of a page reclaimed while hidden holds when it was hidden', [0, 1, 2].every((n) => { const value = AppMarker.safeParse(eventOf(rows, 'liveness', n).appMarker.value); return value.success && value.data.hiddenAt !== null; }), rows.filter((r) => r.event.type === 'liveness'));
      const lost = [0, 1, 2].map((n) => eventOf(rows, 'step-lost', n));
      t.equal('each reopened page\'s load reads background, and the steps lost were attempts 1 to 3', lost.map((l, n) => [eventOf(rows, 'load', n + 1).verdict, l.verdict, l.attempt]), [1, 2, 3].map((n) => ['background', 'background', n]));
      t.ok('they were lost in the wait, while allocating, and in the hold', lost[0]?.phase === 'wait' && /^alloc:\d+$/.test(lost[1]?.phase ?? '') && lost[2]?.phase === 'hold:600', lost.map((l) => l.phase));
      t.equal('attempt 4 holds', [eventOf(rows, 'step-start', 3).attempt, eventOf(rows, 'step-end').outcome.kind], [4, 'held']);
      t.equal('done counts four loads, no kill, three voids', eventOf(rows, 'done'), { type: 'done', loads: 4, kills: 0, voids: 3 });
    },
  },
  {
    id: 'harness.freeze-brief',
    title: 'the page frozen for 1 s during the hold, resumed, then crashed: killed in hold:10 with about 1 s hidden, not a void',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await open(t, SMALL);
      await startRun(t);
      await until(t, 'the step to hold', inPhase('hold:10'));
      await t.page.lifecycle('frozen');
      await sleep(1_000);
      await t.page.lifecycle('active');
      // The crash waits for the page to record its return to visible in the marker.
      await t.page.waitFor('the marker to record the hidden second', z.literal(true), () => {
        const text = localStorage.getItem('noisy.harness.memory.step');
        const marker: unknown = text === null ? null : JSON.parse(text);
        return typeof marker === 'object' && marker !== null && 'visibility' in marker && marker.visibility === 'visible' && 'hiddenMs' in marker && typeof marker.hiddenMs === 'number' && marker.hiddenMs > 0;
      });
      await t.page.crash();
      await t.page.reopen(url(SMALL));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page counts a kill and no void', [done.counts, done.verdicts], ['Loads 2, kills 1, voids 0', ['U1 untouched: killed at 10 MB']]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      checkDeaths(t, rows, 'untouched');
      const marker = AppMarker.safeParse(eventOf(rows, 'liveness').appMarker.value);
      t.ok('the marker of a page visible again at its death holds no hiddenAt', marker.success && marker.data.hiddenAt === null, marker);
      const lost = eventOf(rows, 'step-lost');
      t.equal('the step is lost killed in hold:10', [lost.verdict, lost.phase], ['killed', 'hold:10']);
      t.ok('its hidden time is near 1,000 ms', lost.hiddenMs >= 900 && lost.hiddenMs <= 1_500, { hiddenMs: lost.hiddenMs });
    },
  },
  {
    id: 'harness.freeze-long',
    title: 'the page frozen for 5 s during the hold, then resumed, the step completing: voided hidden and rerun, no kill',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      // An 8 s hold, so the step completes after the freeze.
      const levers = `${SMALL}&defaultsScale=1.6`;
      await open(t, levers);
      await startRun(t);
      await until(t, 'the step to hold', inPhase('hold:10'));
      await t.page.lifecycle('frozen');
      await sleep(5_000);
      await t.page.lifecycle('active');
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('the page counts one void and no kill, in one load', [done.counts, done.verdicts], ['Loads 1, kills 0, voids 1', ['U1 untouched: survived']]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'step-start', 'step-end', 'row-end', 'done']);
      t.equal('the first attempt ends void hidden, the second held', [eventOf(rows, 'step-end', 0).outcome, eventOf(rows, 'step-end', 1).outcome.kind], [{ kind: 'void', reason: 'hidden' }, 'held']);
      t.equal('the rerun is attempt 2', eventOf(rows, 'step-start', 1).attempt, 2);
      t.equal('done counts one load, no kill, one void', eventOf(rows, 'done'), { type: 'done', loads: 1, kills: 0, voids: 1 });
    },
  },
  {
    id: 'harness.void-cap',
    title: 'five frozen-then-crashed attempts of one step end its row no-reading, with five voids and no kill',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 120_000,
    async run(t) {
      await open(t, SMALL);
      await startRun(t);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await until(t, `attempt ${attempt} to hold`, inPhase('hold:10', attempt));
        await t.page.lifecycle('frozen');
        await t.page.crash();
        await t.page.reopen(url(SMALL));
      }
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page says DONE with the row no-reading', [done.headline, done.counts, done.verdicts], ['DONE', 'Loads 6, kills 0, voids 5', ['U1 untouched: no reading (untouched voided 5 times)']]);
      const cycle = ['load', 'step-lost', ...LIVENESS_CUT, 'step-start'];
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', ...cycle, ...cycle, ...cycle, ...cycle, 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      checkDeaths(t, rows, 'untouched');
      t.equal('each of the five deaths posted a liveness row, kill index 1 to 5', [0, 1, 2, 3, 4].map((n) => eventOf(rows, 'liveness', n).killIndex), [1, 2, 3, 4, 5]);
      t.equal('the five steps lost were attempts 1 to 5, each background', [0, 1, 2, 3, 4].map((n) => [eventOf(rows, 'step-lost', n).attempt, eventOf(rows, 'step-lost', n).verdict]), [1, 2, 3, 4, 5].map((n) => [n, 'background']));
      t.equal('the row ends no-reading at the untouched step', eventOf(rows, 'row-end').verdict, { kind: 'no-reading', stepKey: 'untouched' });
      t.equal('done counts six loads, no kill, five voids', eventOf(rows, 'done'), { type: 'done', loads: 6, kills: 0, voids: 5 });
    },
  },
  {
    id: 'harness.sink-down',
    title: 'with the sink answering 500 the run reaches DONE with its rows waiting in the outbox, and after the sink recovers a reload at DONE posts each of them once',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the intercepted sink answers 500', channel: 'log', source: 'network', level: 'error', url: /\/api\/log$/ });
      const levers = `${SMALL}&defaultsScale=0.2`;
      await open(t, levers);
      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'respond', status: 500, body: 'refused' } }]);
      await startRun(t);
      const waiting = await until(t, 'DONE', (v) => v.report.phase === 'done', 20_000);
      t.equal('DONE says the six rows are waiting to post', [waiting.headline, waiting.pending, waiting.report.pending], ['DONE', '6 rows waiting to post', 6]);
      const [, , outbox] = await stored(t);
      t.equal('the six rows wait in the stored outbox', outboxRows(outbox), 6);
      t.equal('none reached the sink', (await readSink(t)).rows.length, 0);

      await t.page.intercept([]);
      await t.page.reload();
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page opened at DONE answers done and says DONE', [done.report.load, done.headline, done.counts], ['done', 'DONE', 'Loads 2, kills 0, voids 0']);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'row-end', 'done', 'load']);
      t.equal('the sink got one copy of each row', (await readSink(t)).copies, rows.length);
      t.equal('the reload\'s load row reads fresh, in load 2', [eventOf(rows, 'load', 1).verdict, eventOf(rows, 'load', 1).navigation, rows.at(-1)?.load], ['fresh', 'reload', 2]);
      const [, , after] = await stored(t);
      t.equal('the outbox is empty', outboxRows(after), 0);
    },
  },
  {
    id: 'harness.stale-and-unreadable',
    title: 'a stored plan that does not parse reads "The stored run cannot be read" and one of another build reads "Built since this run started", neither written to; Start then begins a run of this build',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      const levers = `${SMALL}&defaultsScale=0.2`;
      await open(t, levers);
      for (const [label, text, phase, headline] of [
        ['a plan that is not JSON', '{not json', 'storage-failed', /^The stored run cannot be read: the stored plan is not JSON: /],
        ['a plan of another build', otherBuildPlan(), 'stale', /^Built since this run started$/],
      ] as const) {
        await t.page.evaluate(z.literal(true), writePlan, KEYS.plan, text);
        await t.page.reload();
        const view = await until(t, `the page to read ${label}`, (v) => v.report.phase === phase);
        t.ok(`${label}: the headline says so`, headline.test(view.headline ?? ''), view.headline);
        t.equal(`${label}: Start and Short run are offered, Stop is not`, [view.start, view.shortRun, view.stop], [true, true, false]);
        t.equal(`${label}: the load wrote nothing: the plan as written, no marker, no outbox`, await stored(t), [text, null, null]);
      }
      t.equal('no row reached the sink', (await readSink(t)).rows.length, 0);
      await startRun(t);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      const [plan] = await stored(t);
      t.equal('Start over the stale plan ran a new run of this build to DONE', [done.headline, plan === null ? null : JSON.parse(plan).build], ['DONE', t.build.buildId]);
      await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'row-end', 'done']);
    },
  },
  {
    id: 'harness.levers',
    title: 'a lever with a bad value, an unknown lever, and a lever given twice each fail the page at load naming it, writing nothing; levers at their defaults are not levered and one away is',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      for (const [query, expected] of [
        ['untouchedMb=abc', 'The lever untouchedMb cannot be used: expected a whole number in plain digits'],
        ['chunkMb=0', 'The lever chunkMb cannot be used: Too small: expected number to be >=1'],
        ['untouchMb=10', 'The lever untouchMb cannot be used: no such lever'],
        ['runs=1&runs=2', 'The lever runs cannot be used: given 2 times'],
        ['rows=U1.untouched,U1.nope', 'The lever rows cannot be used: Invalid option: expected one of "U1.untouched"|"U1.killpoint"|"U1.survival.full"|"U1.survival.low"|"U1.survival.none"|"U1.killpoint.after"|"U1.headroom"|"U1.migan-probe"|"U1.exemption"|"U1.panorama"|"U1.threads"|"U2.encode"|"U2.inpaint"|"U3.depth"'],
        ['defaultsScale=-1', 'The lever defaultsScale cannot be used: expected a number in plain digits'],
      ] as const) {
        await t.page.goto(url(query));
        const view = await until(t, `the page to fail on ?${query}`, (v) => v.report.phase === 'page-failed');
        t.equal(`?${query}: the page fails naming the lever, and offers nothing`, [view.headline, view.report.leverError, view.start, view.shortRun, view.stop], [expected, expected, false, false, false]);
        t.equal(`?${query}: nothing is stored`, await stored(t), [null, null, null]);
      }
      for (const [query, levered] of [
        ['', false],
        ['runs=10&chunkMb=100&gaps=20,10,5,2,0.5&defaultsScale=1', false],
        ['defaultsScale=0.5', true],
        ['throwAtMb=4', true],
        ['rows=U1.untouched', true],
      ] as const) {
        const view = await open(t, query);
        t.equal(`?${query}: the page is ready and ${levered ? 'shows' : 'does not show'} the levered banner`, [view.headline, view.report.levered, view.levered], ['Ready', levered, levered]);
      }
      const view = await open(t, 'rows=U1.untouched&untouchedMb=12&chunkMb=3&gaps=1,0.2&throwAtMb=9&timeoutS=1.5');
      t.equal('the levers parse to the plan\'s values over the defaults', view.report.levers, { ...LEVER_DEFAULTS, rows: ['U1.untouched'], untouchedMb: 12, chunkMb: 3, gaps: [1, 0.2], throwAtMb: 9, timeoutS: 1.5 });
      t.equal('no row reached the sink', (await readSink(t)).rows.length, 0);
    },
  },
  {
    id: 'harness.throw',
    title: 'with throwAtMb=4 the untouched step\'s allocation that reaches 4 MB throws: the row ends throw at 4 MB and the runner holds nothing',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await open(t, `${SMALL}&throwAtMb=4&defaultsScale=0.2`);
      await startRun(t);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page says DONE with the throw, and holds nothing', [done.headline, done.verdicts, done.report.runner], ['DONE', ['U1 untouched: throw at 4 MB'], { chunks: 0, mb: 0 }]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'row-end', 'done']);
      const outcome = eventOf(rows, 'step-end').outcome;
      t.ok('the step ends throw at 4 MB, naming the lever', outcome.kind === 'throw' && outcome.atMb === 4 && outcome.message.includes('throwAtMb'), outcome);
      t.equal('the row ends throw at 4 MB', eventOf(rows, 'row-end').verdict, { kind: 'untouched', end: { kind: 'throw', atMb: 4 } });
    },
  },
  {
    id: 'harness.refusals',
    title: 'Start and Short run are refused, naming the rows, for rows with no program, rows no runner executes, and a row outside Short run, and a refusal writes and posts nothing',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      const cases: readonly (readonly [string, string, string])[] = [
        ['', 'start', noProgram('full')],
        ['', 'short-run', noProgram('short')],
        ['rows=U1.survival.full', 'start', 'Start refused (no executor): U1.survival.full'],
        ['rows=U1.survival.full', 'short-run', 'Start refused (no executor): U1.survival.full'],
        ['rows=U1.untouched,U1.panorama', 'start', 'Start refused (no executor): U1.panorama'],
        ['rows=U1.untouched', 'short-run', 'Start refused (rows-outside-plan): U1.untouched'],
      ];
      for (const [query, button, expected] of cases) {
        await open(t, query);
        await t.page.click(`[data-testid=${button}]`);
        const view = await until(t, `${button} on ?${query} to be refused`, (v) => v.headline === expected, 5_000);
        t.equal(`?${query} ${button}: refused, naming the rows, with Start and Short run still offered`, [view.headline, view.start, view.shortRun, view.stop], [expected, true, true, false]);
        t.equal(`?${query} ${button}: nothing is stored`, await stored(t), [null, null, null]);
      }
      t.equal('no row reached the sink', (await readSink(t)).rows.length, 0);
    },
  },
  {
    id: 'harness.stop',
    title: 'Stop during the hold posts stopped with the counts, removes the plan and the marker, releases the runner, and a reload finds no run',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await open(t, SMALL);
      await startRun(t);
      await until(t, 'the step to hold', inPhase('hold:10'));
      await t.page.click('[data-testid=stop]');
      const stopped = await until(t, 'Stopped with every row posted', (v) => v.report.phase === 'stopped' && v.report.pending === 0);
      t.equal('the page says Stopped, holds nothing, hides Stop, and offers Start', [stopped.headline, stopped.report.runner, stopped.stop, stopped.start], ['Stopped', { chunks: 0, mb: 0 }, false, true]);
      const [plan, marker, outbox] = await stored(t);
      t.equal('the plan and the marker are removed and the outbox is empty', [plan, marker, outboxRows(outbox)], [null, null, 0]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'stopped']);
      t.equal('stopped counts one load, no kill, no void', eventOf(rows, 'stopped'), { type: 'stopped', loads: 1, kills: 0, voids: 0 });
      await t.page.reload();
      const after = await until(t, 'the reloaded page to be ready', isIdle);
      t.equal('a reload finds no run', [after.headline, after.report.load], ['Ready', 'idle']);
    },
  },
  {
    id: 'harness.second-tab',
    title: 'a same-origin frame standing in for a second tab, opened on a running plan, says "Waiting for the previous run to let go", then "Running in another tab" after the lock wait, offering nothing and writing nothing to the plan or the outbox; the first page reaches DONE in one load',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      // A 15 s hold outlasts the second tab's lock wait.
      const levers = `${SMALL}&defaultsScale=3`;
      await open(t, levers);
      await startRun(t);
      await until(t, 'the step to hold with every row posted', (v) => inPhase('hold:10')(v) && v.report.pending === 0);
      const [planBefore, , outboxBefore] = await stored(t);
      await t.page.evaluate(z.literal(true), addFrame, 'second', url(levers));
      const waiting = await until(t, 'the second tab to wait for the lock', (v) => v.report.phase === 'waiting-for-lock', 10_000, 'second');
      const waitSeen = Date.now();
      t.equal('the second tab says it waits for the previous run, offering nothing', [waiting.headline, waiting.start, waiting.stop], ['Waiting for the previous run to let go', false, false]);
      const elsewhere = await until(t, 'the second tab to give up', (v) => v.report.phase === 'elsewhere', LOCK_WAIT_MS + 5_000, 'second');
      const waitedMs = Date.now() - waitSeen;
      t.equal('the second tab then says the run is running in another tab, offering nothing', [elsewhere.headline, elsewhere.report.load, elsewhere.start, elsewhere.shortRun, elsewhere.stop], ['Running in another tab', 'elsewhere', false, false, false]);
      t.ok('it gave up only after the lock wait', waitedMs >= LOCK_WAIT_MS - 500, { waitedMs, lockWaitMs: LOCK_WAIT_MS });
      const [planAfter, marker, outboxAfter] = await stored(t);
      t.equal('the stored plan and outbox are as they were before the second tab opened', [planAfter, outboxAfter], [planBefore, outboxBefore]);
      const first = await until(t, 'the first page to be holding still', (v) => v.report.phase === 'running');
      t.equal('the step marker is still the first page\'s, in its hold', marker === null ? null : [JSON.parse(marker).tab, Marker.parse(JSON.parse(marker)).phase], [first.report.tab, 'hold:10']);
      const done = await until(t, 'the first page to reach DONE with every row posted', isDonePosted, 25_000);
      t.equal('the first page reaches DONE in its one load', [done.headline, done.counts], ['DONE', 'Loads 1, kills 0, voids 0']);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'row-end', 'done']);
      t.ok('the second tab posted no row: every row is load 1', rows.every((r) => r.load === 1), rows.map((r) => r.load));
    },
  },
  {
    id: 'harness.start-over-stored-run',
    title: 'Start in a page that loaded before a same-origin frame started a run and was removed with its step in the hold is refused, "A run is stored here: reload the page to resume it.", writing nothing; the reload scores the step and resumes the run to DONE',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      const levers = `${SMALL}&defaultsScale=1`;
      const idle = await open(t, levers);
      t.equal('the page loads Ready, offering Start', [idle.headline, idle.start], ['Ready', true]);
      await t.page.evaluate(z.literal(true), addFrame, 'other', url(levers));
      await until(t, 'the frame to be ready', isIdle, 15_000, 'other');
      await t.page.evaluate(z.literal(true), clickInFrame, 'other', 'start');
      const holding = await until(t, 'the frame\'s step to hold with every row posted', (v) => inPhase('hold:10')(v) && v.report.pending === 0, 15_000, 'other');
      await t.page.evaluate(z.literal(true), removeFrame, 'other');
      await t.page.waitFor('the removed frame to let go of the runner lock', z.literal(true), runnerLockFree);
      const before = await stored(t);
      t.ok('the frame left its plan with the step in flight and its marker in the hold', before[0] !== null && JSON.parse(before[0]).inFlight !== null && before[1] !== null && Marker.parse(JSON.parse(before[1])).phase === 'hold:10', before);

      await startRun(t);
      const refused = await until(t, 'Start to be refused', (v) => v.report.phase === 'refused', 5_000);
      t.equal('Start is refused with the reload to resume, and Start and Short run are still offered', [refused.headline, refused.report.refused, refused.start, refused.shortRun, refused.stop], ['A run is stored here: reload the page to resume it.', { kind: 'stored-run' }, true, true, false]);
      t.equal('the refusal wrote nothing: the plan, the marker, and the outbox are as the frame left them', await stored(t), before);
      t.ok('the refusal let go of the runner lock', await t.page.evaluate(z.boolean(), runnerLockFree), null);

      await t.page.reload();
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the reloaded page resumed the run to DONE, the step voided left and rerun', [done.report.load, done.headline, done.counts, done.verdicts], ['resume', 'DONE', 'Loads 2, kills 0, voids 1', ['U1 untouched: survived']]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'step-start', 'step-end', 'row-end', 'done']);
      t.equal('the first load row is the frame\'s Start, fresh', [eventOf(rows, 'load').tab, eventOf(rows, 'load').verdict], [holding.report.tab, 'fresh']);
      t.equal('the second is the reload\'s, which voided the frame\'s step left', [eventOf(rows, 'load', 1).tab, eventOf(rows, 'load', 1).navigation, eventOf(rows, 'load', 1).verdict, eventOf(rows, 'step-lost').verdict, eventOf(rows, 'step-lost').phase], [done.report.tab, 'reload', 'left', 'left', 'hold:10']);
      t.equal('the rerun is attempt 2 and holds', [eventOf(rows, 'step-start', 1).attempt, eventOf(rows, 'step-end').outcome.kind], [2, 'held']);
    },
  },
  {
    id: 'harness.phone',
    title: 'at a 393 x 852 phone viewport, in light and dark, the page is no wider than the viewport, its buttons are at least 44 x 44, and DONE is set large',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await t.page.emulate({ ...PHONE, deviceScaleFactor: 3, mobile: true, colorScheme });
        await t.page.goto(url(`${SMALL}&defaultsScale=0.8`));
        await t.page.evaluate(z.literal(true), () => {
          localStorage.clear();
          return true;
        });
        await t.page.reload();
        await until(t, 'the page to be ready', isIdle);
        for (const [state, wait] of [
          ['ready', null],
          ['holding', inPhase('hold:10')],
          ['done', isDonePosted],
        ] as const) {
          if (state === 'holding') await startRun(t);
          if (wait !== null) await until(t, `the page to be ${state}`, wait, 20_000);
          const shape = await t.page.evaluate(Layout, layout);
          t.equal(`${colorScheme}, ${state}: the page renders in the ${colorScheme} scheme at ${PHONE.width} CSS pixels`, [shape.scheme, shape.innerWidth], [colorScheme, PHONE.width]);
          t.ok(`${colorScheme}, ${state}: nothing is wider than the viewport`, shape.scrollWidth <= PHONE.width && shape.wider.length === 0, shape);
          t.equal(`${colorScheme}, ${state}: every button and summary is at least 44 x 44`, await t.page.evaluate(Targets, smallTargets), []);
          if (state === 'done') t.ok(`${colorScheme}, done: DONE is set at least 64 px`, shape.headlinePx >= 64, shape);
          await t.page.screenshot(`harness-phone-${colorScheme}-${state}`);
        }
      }
      const sink = await readSink(t);
      t.equal('both runs reached the sink, each to its done row', [...new Set(sink.rows.map((r) => r.run))].length, 2);
    },
  },
  {
    id: 'harness.killpoint-ceiling',
    title: 'the two kill-point rows at 1 MB chunks each climb one chunk a step from 1 MB to the 30 MB ceiling and end no kill up to 30 MB, every step\'s checksums equal to node\'s recomputation from the chunk seeds, and nothing held at DONE',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 90_000,
    async run(t) {
      const levers = `rows=U1.killpoint,U1.killpoint.after&${LADDER}&defaultsScale=0.05`;
      await open(t, levers);
      await t.page.evaluate(z.literal(true), recordPhaseWords);
      await startRun(t);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 60_000);
      const shown = await t.page.evaluate(z.array(z.string()), readPhaseWords);
      t.equal(
        'the status said each step\'s fill and hold in words, in order, in both rows; the second row\'s first step holds the first chunk the first row left, so it has no fill',
        shown.filter((text) => /^(Filling|Holding)/.test(text)),
        [1, 2].flatMap((row) => Array.from({ length: LADDER_MB }, (_, i) => (row === 2 && i === 0 ? ['Holding 1 MB, filled and summed'] : [`Filling up to ${i + 1} MB`, `Holding ${i + 1} MB, filled and summed`])).flat()),
        { shown: shown.slice(0, 8) },
      );
      t.equal('the page says DONE, both rows no kill up to 30 MB, one load, and holds nothing', [done.headline, done.counts, done.verdicts, done.report.runner], [
        'DONE',
        'Loads 1, kills 0, voids 0',
        ['U1 killpoint: no kill up to 30 MB', 'U1 killpoint after: no kill up to 30 MB'],
        { chunks: 0, mb: 0 },
      ]);
      const rows = await sinkRun(t, ['plan', 'load', ...heldSteps(LADDER_MB), 'row-end', ...heldSteps(LADDER_MB), 'row-end', 'done']);
      for (const [index, row] of (['U1.killpoint', 'U1.killpoint.after'] as const).entries()) {
        const starts = rows.map((r) => r.event).filter((e) => e.type === 'step-start' && e.row === row);
        const ends = rows.map((r) => r.event).filter((e) => e.type === 'step-end' && e.row === row);
        t.equal(`${row}: one step per MB from 1 to 30, each the ballast step of its size`, starts.map((e) => (e.type === 'step-start' ? [e.stepKey, e.attempt, e.step] : null)), Array.from({ length: LADDER_MB }, (_, i) => [`mb-${i + 1}`, 1, { kind: 'ballast', mb: i + 1, release: 'all' }]));
        const outcomes = ends.map((e) => (e.type === 'step-end' ? e.outcome : null));
        t.ok(`${row}: every step held its size in that many chunks, filled in under a second`, outcomes.every((o, i) => o?.kind === 'held' && o.mb === i + 1 && o.chunks === i + 1 && o.fillMs >= 0 && o.fillMs < 1_000), outcomes.map((o) => (o?.kind === 'held' ? [o.mb, o.chunks, o.fillMs] : o)));
        t.equal(
          `${row}: every step's checksums, taken in Chrome, equal node's recomputation of each chunk from its seed, at fill and after`,
          outcomes.map((o) => (o?.kind === 'held' ? o.checksums : null)),
          Array.from({ length: LADDER_MB }, (_, i) => ladderPairs(i + 1)),
        );
        t.equal(`${row}: the row ends at the ceiling, 30 MB held`, eventOf(rows, 'row-end', index), { type: 'row-end', row, verdict: { kind: 'killpoint', heldMb: 30, end: { kind: 'ceiling' } }, amends: false });
      }
      t.equal('done counts one load, no kill, and no void', eventOf(rows, 'done'), { type: 'done', loads: 1, kills: 0, voids: 0 });
    },
  },
  {
    id: 'harness.killpoint-throw',
    title: 'with throwAtMb=12 the kill-point ladder at 1 MB chunks holds 1 to 11 MB and the 12 MB step throws: the row ends throw at 12 MB with 11 MB the last held, and the runner holds nothing',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 60_000,
    async run(t) {
      await open(t, `rows=U1.killpoint&${LADDER}&throwAtMb=12&defaultsScale=0.05`);
      await startRun(t);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('the page says DONE with the throw, and holds nothing', [done.headline, done.verdicts, done.report.runner], ['DONE', ['U1 killpoint: throw at 12 MB'], { chunks: 0, mb: 0 }]);
      const rows = await sinkRun(t, ['plan', 'load', ...heldSteps(12), 'row-end', 'done']);
      const outcomes = rows.map((r) => r.event).flatMap((e) => (e.type === 'step-end' ? [e.outcome] : []));
      t.equal('steps 1 to 11 held, each with its checksums node\'s recomputation', outcomes.slice(0, 11).map((o) => (o.kind === 'held' ? [o.mb, o.checksums] : o)), Array.from({ length: 11 }, (_, i) => [i + 1, ladderPairs(i + 1)]));
      t.equal('the 12 MB step threw at 12 MB, naming the lever', outcomes[11], { kind: 'throw', atMb: 12, message: 'the throwAtMb lever refuses the allocation that brings the total to 12 MB' });
      t.equal('the row ends throw at 12 MB with 11 MB the last held', eventOf(rows, 'row-end').verdict, { kind: 'killpoint', heldMb: 11, end: { kind: 'throw', atMb: 12 } });
    },
  },
  {
    id: 'harness.killpoint-crash-fill',
    title: 'the renderer crashed in the 8 MB step\'s fill, then the page reopened: step-lost killed in fill:8, the row ends with the kill point 8 MB and 7 MB the last held, and DONE with loads 2 and kills 1',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 60_000,
    async run(t) {
      const levers = `rows=U1.killpoint&${LADDER}&defaultsScale=0.05`;
      await open(t, levers);
      await t.page.evaluate(z.literal(true), stallAtMarkerPhase, KEYS.step, 'fill:8');
      await startRun(t);
      // The step's wait gives its step-start up to 2 s to post; once it has posted, the step begins with fill:8 and stalls there.
      await sinkHasStepStart(t, 'mb-8');
      await sleep(1_000);
      await t.page.crash();
      await t.page.reopen(url(levers));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the reopened page answers done at its load and says DONE with the kill point', [done.report.load, done.headline, done.counts, done.verdicts], ['done', 'DONE', 'Loads 2, kills 1, voids 0', ['U1 killpoint: kill point 8 MB in fill']]);
      const rows = await sinkRun(t, ['plan', 'load', ...heldSteps(7), 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      await t.file('sink-rows.json', JSON.stringify(rows, null, 2));
      await t.file('liveness-rows.json', JSON.stringify(rows.filter((r) => r.event.type === 'liveness' || r.event.type === 'liveness-late'), null, 2));
      const deadTab = eventOf(rows, 'load', 0).tab;
      checkLiveness(t, rows, 0, deadTab, 1, 'ballast');
      const survived = AppMarker.safeParse(eventOf(rows, 'liveness').appMarker.value);
      const started = rows.find((r) => r.event.type === 'step-start' && r.event.stepKey === 'mb-8');
      t.ok('the marker that survived is the 8 MB step\'s, written at its start, visible, with this build', survived.success && started !== undefined && survived.data.startedAt === Date.parse(started.at) && survived.data.hiddenAt === null && survived.data.build === t.build.buildId, { marker: survived, started: started?.at });
      checkLate(t, rows, 0);
      checkDeaths(t, rows, 'ballast');
      const [, , , left] = await t.page.evaluate(StoredWithApp, readStoredWithApp, KEYS.plan, KEYS.step, KEYS.outbox);
      t.equal('no app-shaped marker is left stored: the dead tab\'s is removed after the load', left, null);
      t.equal('the reopened page\'s load reads killed', eventOf(rows, 'load', 1).verdict, 'killed');
      const lost = eventOf(rows, 'step-lost');
      t.equal('the step is lost as killed in fill:8, attempt 1, not after completion', [lost.row, lost.stepKey, lost.attempt, lost.verdict, lost.phase, lost.afterCompletion, lost.attributedTo], ['U1.killpoint', 'mb-8', 1, 'killed', 'fill:8', false, null]);
      t.equal('the row ends with the kill point 8 MB in fill:8 and 7 MB the last held', eventOf(rows, 'row-end').verdict, { kind: 'killpoint', heldMb: 7, end: { kind: 'killed', atMb: 8, phase: 'fill:8' } });
      t.equal('steps 1 to 7 held, each with its checksums node\'s recomputation', rows.map((r) => r.event).flatMap((e) => (e.type === 'step-end' && e.outcome.kind === 'held' ? [e.outcome.checksums] : [])), Array.from({ length: 7 }, (_, i) => ladderPairs(i + 1)));
      t.equal('done counts two loads, one kill, no void', eventOf(rows, 'done'), { type: 'done', loads: 2, kills: 1, voids: 0 });
    },
  },
  {
    id: 'harness.killpoint-crash-hold',
    title: 'the renderer crashed in the 5 MB step\'s 2 s hold, the status saying so in words, then the page reopened: the row ends with the kill point 5 MB in hold and 4 MB the last held',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 60_000,
    async run(t) {
      const levers = `rows=U1.killpoint&${LADDER}`;
      await open(t, levers);
      await startRun(t);
      const holding = await until(t, 'the 5 MB step to hold', inPhase('hold:5'), 30_000);
      t.equal('the status names the row, the step, and the hold in words, and the runner holds five chunks', [holding.step, holding.phase, holding.report.runner], ['U1 killpoint: 5 MB, attempt 1', 'Holding 5 MB, filled and summed', { chunks: 5, mb: 5 }]);
      await t.page.crash();
      await t.page.reopen(url(levers));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 20_000);
      t.equal('the page says DONE with the kill point in the hold', [done.headline, done.counts, done.verdicts], ['DONE', 'Loads 2, kills 1, voids 0', ['U1 killpoint: kill point 5 MB in hold']]);
      const rows = await sinkRun(t, ['plan', 'load', ...heldSteps(4), 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      checkLiveness(t, rows, 0, holding.report.tab, 1, 'ballast');
      checkLate(t, rows, 0);
      checkDeaths(t, rows, 'ballast');
      t.equal('the step is lost as killed in hold:5', [eventOf(rows, 'step-lost').stepKey, eventOf(rows, 'step-lost').verdict, eventOf(rows, 'step-lost').phase], ['mb-5', 'killed', 'hold:5']);
      t.equal('the row ends with the kill point 5 MB in hold:5 and 4 MB the last held', eventOf(rows, 'row-end').verdict, { kind: 'killpoint', heldMb: 4, end: { kind: 'killed', atMb: 5, phase: 'hold:5' } });
    },
  },
  {
    id: 'harness.wake-lock',
    title: 'the wake lock held from the load and through Start, released by Chrome while the page is frozen, refused when the page turns visible again, which shows the tap target, and requested again by a tap on it, each answer in a wake-lock row; DONE releases it',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 60_000,
    async run(t) {
      await t.page.emulate({ ...PHONE, deviceScaleFactor: 3, mobile: true, colorScheme: 'light' });
      // A 16 s hold, long enough for a brief freeze and a tap.
      const levers = `${SMALL}&defaultsScale=3.2`;
      await open(t, levers);
      const idle = await until(t, 'the load\'s wake-lock request to be answered', (v) => v.report.wakeLock !== null);
      t.equal('the load\'s request is answered, shown, and offers no tap target while held', [idle.report.wakeLock, idle.wake, idle.wakeTap], [{ kind: 'held' }, 'Screen kept on', false]);
      await startRun(t);
      const holding = await until(t, 'the step to hold', inPhase('hold:10'));
      t.equal('the run holds the lock it was granted at the load', [holding.report.wakeLock, holding.wakeTap], [{ kind: 'held' }, false]);
      await t.page.evaluate(z.literal(true), scriptWakeLock, true);
      // Frozen, then active again: Chrome releases the lock while the page is frozen, and the page asks again when visible.
      await t.page.lifecycle('frozen');
      await sleep(500);
      await t.page.lifecycle('active');
      const refused = await until(t, 'the tap target', (v) => v.wakeTap);
      t.equal('a refused request shows why and the tap target', [refused.report.wakeLock, refused.wake], [{ kind: 'refused', name: 'NotAllowedError' }, 'The screen may sleep: the wake lock was refused (NotAllowedError)']);
      t.equal('the page asked once when it turned visible', await t.page.evaluate(z.number(), wakeRequests), 1);
      await t.page.screenshot('harness-wake-lock-refused');
      t.equal('the tap target is at least 44 x 44', (await t.page.evaluate(Targets, smallTargets)).filter((target) => target.text.startsWith('Tap to keep')), []);
      await t.page.evaluate(z.literal(true), scriptWakeLock, false);
      await t.page.click('[data-testid=wake-tap]');
      const held = await until(t, 'the tap target to go', (v) => !v.wakeTap);
      t.equal('the tap asked again and was granted', [await t.page.evaluate(z.number(), wakeRequests), held.report.wakeLock, held.wake], [2, { kind: 'held' }, 'Screen kept on']);
      await t.page.screenshot('harness-wake-lock-held');
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('DONE releases the lock: no answer is shown and no target', [done.report.wakeLock, done.wake, done.wakeTap], [null, null, false]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'row-end', 'done']);
      const states = rows.flatMap((r) => (r.event.type === 'wake-lock' ? [r.event.state] : []));
      await t.file('wake-lock-rows.json', JSON.stringify(rows.filter((r) => r.event.type === 'wake-lock' || r.event.type === 'load'), null, 2));
      t.equal('the load row records the lock held at Start', eventOf(rows, 'load').wakeLock, { kind: 'held' });
      t.equal('the wake-lock rows are Chrome releasing the lock while the page was frozen, the refusal when visible, and the grant the tap got', states, [{ kind: 'released' }, { kind: 'refused', name: 'NotAllowedError' }, { kind: 'held' }]);
    },
  },
  survivalNone(SURVIVAL_SCALE),
  survivalNone(SHORT_SCALE),
  {
    id: 'harness.survival-crash-encode',
    title: 'the renderer crashed while U1.survival.none\'s first run encodes, then the page reopened: step-lost killed in run:encode, the row 0 of 2, then killed in run:encode, and DONE with loads 2 and kills 1',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 180_000,
    async run(t) {
      await open(t, SURVIVAL);
      await startRun(t);
      const encoding = await until(t, 'run 1 to encode', (v) => v.report.step?.stepKey === 'run-1' && v.report.step.phase === 'run:encode', 120_000);
      await t.page.crash();
      await t.page.reopen(url(SURVIVAL));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('the reopened page says DONE with the kill in the encoder, holding nothing', [done.report.load, done.headline, done.counts, done.verdicts, done.report.runner], ['done', 'DONE', 'Loads 2, kills 1, voids 0', ['U1 survival none: 0 of 2, then killed in run:encode'], { chunks: 0, mb: 0 }]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      await t.file('sink-rows.json', JSON.stringify(rows, null, 2));
      const lost = eventOf(rows, 'step-lost');
      t.equal('run 1 is lost killed in run:encode, attempt 1, attributed to nothing', [lost.row, lost.stepKey, lost.attempt, lost.verdict, lost.phase, lost.attributedTo, lost.afterCompletion], ['U1.survival.none', 'run-1', 1, 'killed', 'run:encode', null, false]);
      t.equal('the reopened page\'s load reads killed', eventOf(rows, 'load', 1).verdict, 'killed');
      t.equal('the row ends 0 of 2, then killed in run:encode', eventOf(rows, 'row-end').verdict, { kind: 'runs', survived: 0, of: 2, end: { score: 'killed', phase: 'run:encode' } });
      checkLiveness(t, rows, 0, encoding.report.tab, 1, 'depth');
      checkLate(t, rows, 0);
      t.equal('done counts two loads, one kill, no void', eventOf(rows, 'done'), { type: 'done', loads: 2, kills: 1, voids: 0 });
    },
  },
  ...(['setup', 'run:depth', 'after'] as const).map((phase): Scenario => ({
    id: `harness.survival-crash-${phase.replace(':', '-')}`,
    title: `the renderer crashed with U1.survival.none's first run stopped dead in its ${phase} phase, then the page reopened: step-lost killed in ${phase}, the row 0 of 2, then killed in ${phase}, and DONE with loads 2 and kills 1`,
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 180_000,
    async run(t) {
      await open(t, SURVIVAL);
      await t.page.evaluate(z.literal(true), stallAtMarkerPhase, KEYS.step, phase);
      await startRun(t);
      // The step's wait gives its step-start up to 2 s to post; the run then reaches the phase and stalls there.
      await sinkHasStepStart(t, 'run-1');
      // A page stalled in its synchronous marker write answers no evaluate: a second without an answer is the stall.
      const answers = (): Promise<boolean> => t.page.evaluate(z.literal(true), () => true).then(
        () => true,
        () => true,
      );
      const deadline = Date.now() + 90_000;
      while (await Promise.race([answers(), sleep(1_000).then(() => false)])) {
        if (Date.now() > deadline) throw new Error(`run 1 did not stall in ${phase} within 90 s`);
        await sleep(200);
      }
      await t.page.crash();
      await t.page.reopen(url(SURVIVAL));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal(`the reopened page says DONE with the kill in ${phase}, holding nothing`, [done.headline, done.counts, done.verdicts, done.report.runner], ['DONE', 'Loads 2, kills 1, voids 0', [`U1 survival none: 0 of 2, then killed in ${phase}`], { chunks: 0, mb: 0 }]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      const lost = eventOf(rows, 'step-lost');
      t.equal(`run 1 is lost killed in ${phase}`, [lost.stepKey, lost.attempt, lost.verdict, lost.phase, lost.attributedTo], ['run-1', 1, 'killed', phase, null]);
      t.equal(`the row ends 0 of 2, then killed in ${phase}`, eventOf(rows, 'row-end').verdict, { kind: 'runs', survived: 0, of: 2, end: { score: 'killed', phase } });
    },
  })),
  {
    id: 'harness.survival-crash-wait',
    title: 'the renderer crashed in the 5 s wait before U1.survival.none\'s second run, then the page reopened: step-lost died-after-terminate attributed to run 1, the row 0 of 2, then died-after-terminate, and DONE with loads 2 and kills 1',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 180_000,
    async run(t) {
      // The encoder's 20 s cooldown before run 2 lasts 5 s at a quarter, long enough to crash in.
      const levers = SURVIVAL;
      await open(t, levers);
      await startRun(t);
      const waiting = await until(t, 'run 2 to wait', (v) => v.report.step?.stepKey === 'run-2' && v.report.step.phase === 'wait', 120_000);
      await sinkHasStepStart(t, 'run-2');
      const still = await until(t, 'run 2 to be still waiting', (v) => v.report.step?.stepKey === 'run-2', 1_000);
      t.equal('run 2 is still in its wait when the renderer is crashed', still.report.step?.phase, 'wait');
      await t.page.crash();
      await t.page.reopen(url(levers));
      const done = await until(t, 'DONE with every row posted', isDonePosted, 30_000);
      t.equal('the reopened page says DONE with the death after run 1, holding nothing', [done.report.load, done.headline, done.counts, done.verdicts, done.report.runner], ['done', 'DONE', 'Loads 2, kills 1, voids 0', ['U1 survival none: 0 of 2, then died-after-terminate'], { chunks: 0, mb: 0 }]);
      const rows = await sinkRun(t, ['plan', 'load', 'step-start', 'step-end', 'step-start', 'load', 'step-lost', 'row-end', ...LIVENESS, 'done']);
      await t.file('sink-rows.json', JSON.stringify(rows, null, 2));
      const ended = eventOf(rows, 'step-end');
      t.equal('run 1 survived before the crash', [ended.stepKey, ended.outcome.kind === 'ran' ? ended.outcome.score : ended.outcome], ['run-1', { kind: 'survived' }]);
      const lost = eventOf(rows, 'step-lost');
      t.equal('run 2 is lost in its wait as died-after-terminate, attributed to run 1', [lost.row, lost.stepKey, lost.attempt, lost.verdict, lost.phase, lost.attributedTo?.row, lost.attributedTo?.stepKey], ['U1.survival.none', 'run-2', 1, 'died-after-terminate', 'wait', 'U1.survival.none', 'run-1']);
      const since = lost.attributedTo?.sinceTerminateMs ?? null;
      t.ok('the death came within the 5 s wait after run 1\'s termination', since !== null && since >= 0 && since <= COOLDOWN_MS.encode * SURVIVAL_SCALE + 1_000, { sinceTerminateMs: since });
      t.equal('the reopened page\'s load reads died-after-terminate', eventOf(rows, 'load', 1).verdict, 'died-after-terminate');
      t.equal('the row ends 0 of 2, then died-after-terminate', eventOf(rows, 'row-end').verdict, { kind: 'runs', survived: 0, of: 2, end: { score: 'died-after-terminate', phase: null } });
      checkLiveness(t, rows, 0, waiting.report.tab, 1, 'depth');
      checkLate(t, rows, 0);
      t.equal('done counts two loads, one kill, no void', eventOf(rows, 'done'), { type: 'done', loads: 2, kills: 1, voids: 0 });
    },
  },
  {
    id: 'harness.survival-input-recovers',
    title: `with the master's route answering 503, U1.survival.none's run is blocked naming it, retried without a kill or a void, its last attempt ending at least the ${BLOCKED_RETRY_MS * RECOVER_SCALE} ms retry time plus its setup and its worker's life after the last blocked one, and once the route answers again the run fetches the master and survives`,
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    timeoutMs: 180_000,
    async run(t) {
      t.expectMessage({ because: 'the intercepted master answers 503', channel: 'log', source: 'network', level: 'error', url: /\/dev\/synth\/master\?width=2048&height=1536$/ });
      const levers = `rows=U1.survival.none&runs=1&defaultsScale=${RECOVER_SCALE}`;
      await open(t, levers);
      await t.page.intercept([{ method: 'GET', path: '/dev/synth/master?width=2048&height=1536', action: { kind: 'respond', status: 503, body: 'held back' } }]);
      await startRun(t);
      const deadline = Date.now() + 30_000;
      while (!(await readSink(t)).rows.some((r) => r.event.type === 'step-end' && r.event.outcome.kind === 'blocked')) {
        if (Date.now() > deadline) throw new Error('no blocked step-end reached the sink within 30 s');
        await sleep(100);
      }
      await t.page.intercept([]);
      const done = await until(t, 'DONE with every row posted', isDonePosted, 120_000);
      t.equal('the page says DONE, 1 of 1, with no kill and no void', [done.headline, done.counts, done.verdicts], ['DONE', 'Loads 1, kills 0, voids 0', ['U1 survival none: 1 of 1']]);
      const { rows } = await readSink(t);
      await t.file('sink-rows.json', JSON.stringify(rows, null, 2));
      const ends = rows.map((r) => r.event).flatMap((e) => (e.type === 'step-end' ? [e] : []));
      const starts = rows.map((r) => r.event).flatMap((e) => (e.type === 'step-start' ? [e] : []));
      const blocked = ends.filter((e) => e.outcome.kind === 'blocked');
      t.ok('at least one attempt was blocked, each naming the master\'s 503', blocked.length >= 1 && blocked.every((e) => e.outcome.kind === 'blocked' && e.outcome.reason === 'the 2048 x 1536 master could not be fetched: the server answered 503'), blocked.map((e) => e.outcome));
      const last = ends.at(-1)?.outcome;
      t.equal('every attempt is run-1, numbered from 1, and the last one ran and survived', [starts.map((e) => [e.stepKey, e.attempt]), last?.kind === 'ran' ? last.score : last], [Array.from({ length: blocked.length + 1 }, (_, i) => ['run-1', i + 1]), { kind: 'survived' }]);
      t.equal('the rows: plan, load, each blocked attempt\'s start and end, the run\'s, row-end, done', seqTypes(rows), ['plan', 'load', ...Array.from({ length: blocked.length + 1 }, () => ['step-start', 'step-end']).flat(), 'row-end', 'done']);
      const blockedEnd = rows.filter((r) => r.event.type === 'step-end' && r.event.outcome.kind === 'blocked').at(-1);
      const ranEnd = rows.filter((r) => r.event.type === 'step-end' && r.event.outcome.kind === 'ran').at(-1);
      const reading = ranEnd?.event.type === 'step-end' && ranEnd.event.outcome.kind === 'ran' ? ranEnd.event.outcome.reading : null;
      // The retry time runs from the blocked answer, which comes before its step-end's stamp; the stamps are whole milliseconds.
      const retryMs = BLOCKED_RETRY_MS * RECOVER_SCALE;
      const sinceBlocked = blockedEnd !== undefined && ranEnd !== undefined ? Date.parse(ranEnd.at) - Date.parse(blockedEnd.at) : null;
      t.ok(
        `the last attempt ended at least the ${retryMs} ms retry time, its setup, and its worker's life after the last blocked one`,
        sinceBlocked !== null && reading !== null && reading.wallMs !== null && sinceBlocked >= retryMs + reading.setupMs + reading.wallMs - 2,
        { sinceBlocked, setupMs: reading?.setupMs, wallMs: reading?.wallMs, retryMs },
      );
      t.equal('the row ends 1 of 1', eventOf(rows, 'row-end').verdict, { kind: 'runs', survived: 1, of: 1, end: null });
    },
  },
  {
    id: 'harness.hole-digests',
    title: 'the holes the memory page\'s inputs make, corners and full at 2048 x 1536 and 2048 x 2048, hash in Chrome to the SHA-256 digests node pins',
    target: 'dev',
    covers: [],
    readsSinkFiles: false,
    async run(t) {
      await open(t, SMALL);
      const digests: Record<string, string> = {};
      for (const size of HOLE_MASTERS) {
        for (const shape of HOLE_SHAPES) digests[`${shape} ${size.width}x${size.height}`] = await t.page.evaluate(z.string(), pageHoleDigest, shape, size.width, size.height);
      }
      t.equal('each hole\'s SHA-256 in Chrome is the digest node pins', digests, PINNED_HOLE_DIGESTS);
    },
  },
];
