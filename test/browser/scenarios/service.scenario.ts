// The analysis service, driven through its dev page, /dev/service.html, on
// the real sequence worker, the real models, and the synth fixture. Each
// scenario paints the fixture in node, writes the master's RGBA bytes to a
// temporary file, and hands it to the page through its file input; the page
// fetches the models through the service and runs one sequence, and its
// report lists every listener callback, the service's events, and its
// termination record.
//
// While a sequence runs, each scenario lists the worker targets the driver
// has attached under the page, so it sees the sequence worker and the pthread
// workers ONNX Runtime starts inside it, and after the sequence ends it waits
// for the browser to detach every one of them.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Size } from '../../../src/core/raster.ts';
import { z } from '../../../src/core/zod.ts';
import { synthScene } from '../../fixtures/synth/synth.ts';
import type { WorkerTarget } from '../driver/browser.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const SYNTH: Size = { width: 2048, height: 1536 };

const Stage = z.enum(['depth', 'encode', 'inpaint']);
const Record = z.object({ atMs: z.number(), largest: Stage }).nullable();
const ErrorSchema = z.object({ kind: z.string(), op: z.string().optional(), message: z.string().optional() });
const Callback = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phase'), stage: Stage, phase: z.enum(['session', 'infer']), fraction: z.number().nullable() }),
  z.object({ kind: z.literal('depth'), size: z.object({ width: z.number(), height: z.number() }), length: z.number(), stats: z.object({ p10: z.number(), median: z.number(), p90: z.number() }) }),
  z.object({ kind: z.literal('embeddings'), model: z.string(), tensors: z.array(z.object({ name: z.string(), dims: z.array(z.number()) })) }),
  z.object({ kind: z.literal('plate'), size: z.object({ width: z.number(), height: z.number() }) }),
  z.object({ kind: z.literal('failed'), stage: Stage, error: ErrorSchema, heavy: z.boolean(), record: Record }),
  z.object({ kind: z.literal('done'), heavy: z.boolean(), record: Record }),
]);
type Callback = z.infer<typeof Callback>;
const Event = z.object({
  event: z.string(),
  t: z.number(),
  worker: z.string().optional(),
  reason: z.string().optional(),
  op: z.string().optional(),
  ms: z.number().optional(),
  wasmHighWaterBytes: z.number().nullable().optional(),
  error: ErrorSchema.optional(),
  model: z.string().optional(),
});
type Event = z.infer<typeof Event>;
const Run = z.object({
  fetch: z.object({ ok: z.boolean() }).nullable(),
  recordBefore: Record,
  heavyAfterStart: z.boolean().nullable(),
  callbacks: z.array(Callback),
  events: z.array(Event),
  recordAfter: Record,
  heavyAfter: z.boolean().nullable(),
  elapsedMs: z.number().nullable(),
});
type Run = z.infer<typeof Run>;
const Report = z.object({
  phase: z.enum(['starting', 'ready', 'fetching', 'running', 'done', 'failed']),
  detail: z.string().nullable(),
  env: z.object({ crossOriginIsolated: z.boolean(), hardwareConcurrency: z.number(), userAgent: z.string() }),
  runs: z.array(Run),
});
type Report = z.infer<typeof Report>;

function readyPhase(): string | null {
  const phase = document.querySelector<HTMLElement>('[data-testid=report]')?.dataset['phase'];
  return phase === 'ready' || phase === 'failed' ? phase : null;
}

/** The report once the run is done and its row settled, or failed; null before. */
function settledReport(): unknown {
  const out = document.querySelector<HTMLElement>('[data-testid=report]');
  if (out === null) return null;
  const phase = out.dataset['phase'];
  const row = out.dataset['row'];
  if (phase === 'failed' || (phase === 'done' && row !== undefined && row !== 'posting')) return JSON.parse(out.textContent);
  return null;
}

/**
 * The worker targets the driver had attached under the page while the
 * sequence ran: the most sequence workers and the most of ONNX Runtime's
 * pthread workers (named `em-pthread`) alive at once, the targets left once
 * the sequence ended and every worker had detached (or after 10 seconds), how
 * long that took, and the order they detached in.
 */
type Census = {
  readonly mostSequence: number;
  readonly mostPthreads: number;
  readonly titles: readonly string[];
  readonly after: readonly WorkerTarget[];
  readonly goneAfterMs: number;
  /** The titles still attached each time the list changed after the report settled, with the milliseconds since then. */
  readonly detaching: readonly { readonly ms: number; readonly alive: readonly string[] }[];
};

const PTHREAD = /^em-pthread/;

/**
 * Opens the page with `query`, chooses the master, runs, lists the attached
 * worker targets every 50 ms until the report settles, and returns the report
 * and that census.
 */
async function runPage(t: ScenarioContext, query: string): Promise<{ readonly report: Report; readonly row: string | null; readonly census: Census }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noisy-service-'));
  try {
    const masterFile = path.join(dir, `master-${SYNTH.width}x${SYNTH.height}.rgba`);
    await writeFile(masterFile, synthScene(SYNTH).masterRgba());
    await t.page.goto(`/dev/service.html?width=${SYNTH.width}&height=${SYNTH.height}&${query}`);
    const ready = await t.page.waitFor('the page to be ready', z.string(), readyPhase);
    if (ready !== 'ready') throw new Error(`the service page failed at load: ${JSON.stringify(await t.page.evaluate(z.unknown(), settledReport))}`);
    await t.page.setFiles('[data-testid=master]', [masterFile]);
    await t.page.click('[data-testid=run]');
    const titles = new Set<string>();
    let mostSequence = 0;
    let mostPthreads = 0;
    const deadline = Date.now() + 150_000;
    let report: Report | null = null;
    while (report === null) {
      const alive = t.page.workers();
      for (const target of alive) titles.add(target.title);
      mostSequence = Math.max(mostSequence, alive.filter((target) => target.title === 'sequence').length);
      mostPthreads = Math.max(mostPthreads, alive.filter((target) => PTHREAD.test(target.title)).length);
      const settled = await t.page.evaluate(z.unknown(), settledReport);
      if (settled !== null) report = Report.parse(settled);
      else if (Date.now() > deadline) throw new Error('the service page did not settle within 150 seconds');
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settledAt = Date.now();
    const detaching: { readonly ms: number; readonly alive: readonly string[] }[] = [];
    for (let alive = t.page.workers(); ; alive = t.page.workers()) {
      const titlesNow = alive.map((target) => target.title);
      if (detaching.at(-1)?.alive.join() !== titlesNow.join()) detaching.push({ ms: Date.now() - settledAt, alive: titlesNow });
      if (alive.length === 0 || Date.now() >= settledAt + 10_000) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const goneAfterMs = Date.now() - settledAt;
    const row = await t.page.evaluate(z.string().nullable(), () => document.querySelector<HTMLElement>('[data-testid=report]')?.dataset['row'] ?? null);
    return { report, row, census: { mostSequence, mostPthreads, titles: [...titles], after: t.page.workers(), goneAfterMs, detaching } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The report's one run, which must have reached `done` with its row posted. */
function expectRun(t: ScenarioContext, result: { readonly report: Report; readonly row: string | null }): Run | undefined {
  t.equal('the page ran to its end', result.report.phase, 'done', { detail: result.report.detail });
  t.equal('the page posted its row to the sink', result.row, 'posted');
  t.equal('the page was cross-origin isolated', result.report.env.crossOriginIsolated, true);
  t.equal('the report holds one run', result.report.runs.length, 1);
  const run = result.report.runs[0];
  t.equal('the fetch through the service succeeded', run?.fetch, { ok: true });
  t.equal('alive.heavy was true just after runSequence returned, and false once the sequence ended', [run?.heavyAfterStart, run?.heavyAfter], [true, false]);
  return run;
}

/** The callbacks in order, a product by its kind, a terminal one with its stage and error kind. */
const callbackKinds = (run: Run | undefined): string[] =>
  (run?.callbacks ?? []).map((c) => (c.kind === 'phase' ? `${c.stage} ${c.phase}` : c.kind === 'failed' ? `failed ${c.stage} ${c.error.kind}` : c.kind));

/** The sequence's events in order (the fetch's left out), each as its name and its op, reason, or error. */
const eventKinds = (run: Run | undefined): string[] =>
  (run?.events ?? [])
    .filter((e) => !e.event.startsWith('fetch.'))
    .map((e) => [e.event, e.op ?? e.reason ?? '', e.event === 'stage.failed' ? (e.error?.kind ?? '') : ''].filter((part) => part !== '').join(' '));

/** One fetch.start and one fetch.end for each model, every start before every end, all before the worker's spawn. */
function expectFetchBrackets(t: ScenarioContext, run: Run | undefined, models: readonly string[]): void {
  const events = run?.events ?? [];
  const fetches = events.filter((e) => e.event.startsWith('fetch.')).map((e) => `${e.event} ${(e.model ?? '').split('@')[0] ?? ''}`);
  t.equal('the fetch logged fetch.start, then fetch.end, for each model of the stages', fetches, [...models.map((m) => `fetch.start ${m}`), ...models.map((m) => `fetch.end ${m}`)]);
  const lastFetch = events.findLastIndex((e) => e.event === 'fetch.end');
  const spawn = events.findIndex((e) => e.event === 'worker.spawn');
  t.ok('every fetch event comes before the worker\'s spawn', lastFetch >= 0 && spawn > lastFetch, { lastFetch, spawn });
}

/** Records the census and checks the sequence worker and its pthread workers were attached while it ran and are all gone after. */
function expectCensus(t: ScenarioContext, census: Census, pthreads: number): void {
  t.equal('one sequence worker at most was alive at once', census.mostSequence, 1, census);
  t.equal(`the sequence worker ran ${pthreads} pthread worker(s) of ONNX Runtime`, census.mostPthreads, pthreads, census);
  t.equal('after the sequence ended, the sequence worker and its pthread workers were all detached', census.after, [], census);
}

const terminal = (run: Run | undefined): Callback | undefined => run?.callbacks.at(-1);

export const scenarios: readonly Scenario[] = [
  {
    id: 'service.depth-encode',
    title: '[depth, encode] through the service at 2 threads: both products, one worker.spawn, two stage.end, one worker.terminate, the record naming encode set before onDone, and the worker and its pthread worker gone after',
    target: 'dev',
    covers: ['I5'],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const result = await runPage(t, 'stages=depth,encode&threads=2');
      const run = expectRun(t, result);
      t.equal('the callbacks come in order, ending in one onDone', callbackKinds(run), ['depth session', 'depth infer', 'depth', 'encode session', 'encode infer', 'embeddings', 'done']);
      t.equal('the depth map is 686 x 518', run?.callbacks.find((c) => c.kind === 'depth')?.size, { width: 686, height: 518 });
      t.equal('there was no record before the sequence', run?.recordBefore, null);
      const done = terminal(run);
      t.ok('onDone saw alive.heavy false and the record naming encode', done?.kind === 'done' && !done.heavy && done.record?.largest === 'encode', { done });
      t.equal('the record after the run is the one onDone saw', run?.recordAfter, done?.kind === 'done' ? done.record : 'no onDone');
      t.equal('the events: one spawn, a start and an end per stage, one terminate', eventKinds(run), [
        'worker.spawn depth,encode',
        'stage.start depth',
        'stage.end depth',
        'stage.start encode',
        'stage.end encode',
        'worker.terminate done',
      ]);
      const events = run?.events ?? [];
      const ends = events.filter((e) => e.event === 'stage.end');
      t.ok('each stage.end carries its time and a high-water mark', ends.length === 2 && ends.every((e) => (e.ms ?? 0) > 0 && (e.wasmHighWaterBytes ?? 0) > 0), { ends });
      const starts = events.filter((e) => e.event === 'stage.start');
      t.ok('each stage.start has ms 0 and no high-water mark', starts.length === 2 && starts.every((e) => e.ms === 0 && e.wasmHighWaterBytes === null), { starts });
      const terminate = events.find((e) => e.event === 'worker.terminate');
      const atMs = done?.kind === 'done' ? done.record?.atMs : undefined;
      t.ok(
        'the record\'s atMs lies between the encoder\'s stage.end and the worker.terminate event',
        atMs !== undefined && terminate !== undefined && atMs >= (ends[1]?.t ?? Infinity) && atMs <= terminate.t,
        { atMs, encodeEnd: ends[1]?.t, terminate: terminate?.t },
      );
      expectFetchBrackets(t, run, ['depth', 'sam']);
      expectCensus(t, result.census, 1);
    },
  },
  {
    id: 'service.closed-bitmap',
    title: 'a closed bitmap for the encoder stage of [depth, encode]: the depth product arrives, the encoder stage fails with worker, the worker is terminated, and the record names depth',
    target: 'dev',
    covers: ['F3'],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const result = await runPage(t, 'stages=depth,encode&threads=2&closed=encode');
      const run = expectRun(t, result);
      t.equal('the depth product arrives, then one onFailed for encode with worker', callbackKinds(run), ['depth session', 'depth infer', 'depth', 'failed encode worker']);
      const failed = terminal(run);
      t.ok(
        'the failure names the run that could not be posted, a DataCloneError',
        failed?.kind === 'failed' && failed.error.op === 'encode' && /^the encode run could not be posted: DataCloneError: /.test(failed.error.message ?? ''),
        { failed },
      );
      t.ok('onFailed saw alive.heavy false and the record naming depth', failed?.kind === 'failed' && !failed.heavy && failed.record?.largest === 'depth', { failed });
      t.equal('the events: the encoder\'s start, its failure, and the terminate', eventKinds(run), [
        'worker.spawn depth,encode',
        'stage.start depth',
        'stage.end depth',
        'stage.start encode',
        'stage.failed encode worker',
        'worker.terminate failed',
      ]);
      expectCensus(t, result.census, 1);
    },
  },
  {
    id: 'service.runtime-fails',
    title: 'with /vendor/ort/ answering 500, the first stage fails with worker, the worker is terminated, and lastHeavyTermination stays unchanged',
    target: 'dev',
    covers: ['F3'],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the fault answers the runtime with a 500', channel: 'log', source: 'network', level: 'error', url: /\/vendor\/ort\// });
      await t.server.setFaults(['path:/vendor/ort/:http500']);
      // No model runs here, so the page is opened without ?threads=, on its default.
      const result = await runPage(t, 'stages=depth,encode');
      const run = expectRun(t, result);
      t.equal('one onFailed for the first stage, with worker, and no phase', callbackKinds(run), ['failed depth worker']);
      const failed = terminal(run);
      t.ok('the failure names the runtime that did not load', failed?.kind === 'failed' && /^the worker did not start: ONNX Runtime did not load: /.test(failed.error.message ?? ''), { failed });
      t.equal('the record is unchanged: null before, in onFailed, and after', [run?.recordBefore, failed?.kind === 'failed' ? failed.record : 'no onFailed', run?.recordAfter], [null, null, null]);
      t.equal('the events: the first stage started and failed, and the worker was terminated', eventKinds(run), [
        'worker.spawn depth,encode',
        'stage.start depth',
        'stage.failed depth worker',
        'worker.terminate failed',
      ]);
      t.equal('after the sequence ended no worker is attached', result.census.after, [], result.census);
    },
  },
  {
    id: 'service.cancel-encode',
    title: 'cancelHeavy while the encoder runs: one onFailed for encode with cancelled, the record naming encode, and the worker and its pthread worker gone after',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const result = await runPage(t, 'stages=depth,encode&threads=2&cancelAt=encode:infer&cancelBy=cancelHeavy');
      const run = expectRun(t, result);
      t.equal('the depth product arrives, then the encoder\'s phases, then one onFailed with cancelled', callbackKinds(run), ['depth session', 'depth infer', 'depth', 'encode session', 'encode infer', 'failed encode cancelled']);
      const failed = terminal(run);
      t.ok('onFailed saw alive.heavy false and the record naming encode', failed?.kind === 'failed' && !failed.heavy && failed.record?.largest === 'encode', { failed });
      t.equal('the events: the encoder started, was cancelled, and the worker terminated', eventKinds(run), [
        'worker.spawn depth,encode',
        'stage.start depth',
        'stage.end depth',
        'stage.start encode',
        'stage.failed encode cancelled',
        'worker.terminate cancelled',
      ]);
      expectCensus(t, result.census, 1);
    },
  },
  {
    id: 'service.abort-encode',
    title: 'the signal\'s abort while the encoder runs ends the sequence as cancelHeavy does',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const result = await runPage(t, 'stages=depth,encode&threads=2&cancelAt=encode:infer&cancelBy=abort');
      const run = expectRun(t, result);
      t.equal('one onFailed for encode with cancelled', callbackKinds(run).at(-1), 'failed encode cancelled');
      const failed = terminal(run);
      t.ok('onFailed saw the record naming encode', failed?.kind === 'failed' && failed.record?.largest === 'encode', { failed });
      t.equal('the terminate says cancelled', eventKinds(run).at(-1), 'worker.terminate cancelled');
      expectCensus(t, result.census, 1);
    },
  },
];

