// The analysis service's decoder, driven through its dev page,
// /dev/decoder.html, on the real decode worker and the real models. Each
// scenario paints the synth fixture in node, writes the master's RGBA bytes
// and, where it checks masks, the truth masks at the guide's size to
// temporary files, and hands them to the page through its file inputs; the
// page runs the encoder through the service, or makes stand-in embeddings
// where a scenario needs only a working decoder, opens the decoder, makes the
// decodes its levers list, releases the decoder, and makes one decode after
// the release.
//
// While the page runs, each scenario lists the worker targets the driver has
// attached under the page, so it sees the decode worker and the pthread
// workers ONNX Runtime starts inside it, and after the report settles it
// waits for the browser to detach every one of them.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLock, type ParsedLock } from '../../../src/analysis/lock.ts';
import type { Size } from '../../../src/core/raster.ts';
import { z } from '../../../src/core/zod.ts';
import { sceneGeometry } from '../../fixtures/synth/scene.ts';
import { maskSize, synthScene } from '../../fixtures/synth/synth.ts';
import type { WorkerTarget } from '../driver/browser.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SYNTH: Size = { width: 2048, height: 1536 };

const SizeSchema = z.object({ width: z.number(), height: z.number() });
const ErrorSchema = z.object({ kind: z.string(), op: z.string().optional(), message: z.string().optional() });
const MaskCheckSchema = z.object({ pass: z.boolean(), iou: z.number(), backgroundFalsePositive: z.number(), maskCount: z.number(), truthCount: z.number() });
const CandidateSchema = z.object({ score: z.number(), size: SizeSchema, inside: z.number(), check: z.union([MaskCheckSchema, z.object({ error: z.string() })]).nullable() });
const OutcomeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('ok'), candidates: z.array(CandidateSchema) }), z.object({ kind: z.literal('err'), error: ErrorSchema })]);
type Outcome = z.infer<typeof OutcomeSchema>;
const TimingsSchema = z.object({ sessionMs: z.number(), inferMs: z.number(), wasmHighWaterBytes: z.number() });
const ReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('decoded'), jobId: z.number(), timings: TimingsSchema }),
  z.object({ type: z.literal('failed'), jobId: z.number(), message: z.string() }),
  z.object({ type: z.literal('unparsed'), detail: z.string() }),
]);
const EventSchema = z.object({
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
type Event = z.infer<typeof EventSchema>;
const ReportSchema = z.object({
  phase: z.enum(['starting', 'ready', 'fetching', 'encoding', 'encoded', 'decoding', 'done', 'failed']),
  detail: z.string().nullable(),
  env: z.object({ crossOriginIsolated: z.boolean(), hardwareConcurrency: z.number(), userAgent: z.string() }),
  fetch: z.object({ ok: z.boolean() }).nullable(),
  evicted: z.boolean().nullable(),
  encode: z.union([z.object({ kind: z.literal('done'), ms: z.number() }), z.object({ kind: z.literal('failed'), error: ErrorSchema })]).nullable(),
  guide: SizeSchema.nullable(),
  replaced: z.object({ pending: OutcomeSchema.nullable(), later: OutcomeSchema.nullable() }).nullable(),
  alive: z.object({ afterOpen: z.boolean().nullable(), afterDecodes: z.boolean().nullable(), afterRelease: z.boolean().nullable() }),
  decodes: z.array(z.object({ index: z.number(), abort: z.enum(['before', 'during']).nullable(), outcome: OutcomeSchema.nullable(), elapsedMs: z.number().nullable() })),
  afterRelease: OutcomeSchema.nullable(),
  replies: z.array(ReplySchema),
  errors: z.array(z.string()),
  events: z.array(EventSchema),
});
type Report = z.infer<typeof ReportSchema>;

function readyPhase(): string | null {
  const phase = document.querySelector<HTMLElement>('[data-testid=report]')?.dataset['phase'];
  return phase === 'ready' || phase === 'failed' ? phase : null;
}

/** The page's phase and its row's state, as the poll reads them. */
function pageState(): unknown {
  const out = document.querySelector<HTMLElement>('[data-testid=report]');
  return { phase: out?.dataset['phase'] ?? null, row: out?.dataset['row'] ?? null };
}

function reportText(): unknown {
  const text = document.querySelector('[data-testid=report]')?.textContent;
  return text === undefined || text === null ? null : JSON.parse(text);
}

const PageState = z.object({ phase: z.string().nullable(), row: z.string().nullable() });

/**
 * The worker targets the driver had attached under the page while it
 * decoded: the most decode workers and the most of ONNX Runtime's pthread
 * workers (named `em-pthread`) attached at once, every title seen, the
 * targets left once every worker had detached (or after 10 seconds), and how
 * long that took after the report settled.
 */
type Census = {
  readonly mostDecode: number;
  readonly mostPthreads: number;
  readonly titles: readonly string[];
  readonly after: readonly WorkerTarget[];
  readonly goneAfterMs: number;
};

const PTHREAD = /^em-pthread/;

type PageRun = { readonly report: Report; readonly row: string | null; readonly census: Census };

/** The truth masks a run hands the page, one per decode, at the guide's size. */
type Truths = readonly ('sphere' | 'box')[];

/**
 * Opens the page with `query`, chooses the master and the truths, runs, and
 * lists the attached worker targets every 50 ms until the report settles.
 * With `step=1` in the query, the page waits after the encoder; this waits
 * there until no worker is attached, at most 10 seconds, and then lets it go
 * on, so the census of the decoding phase counts the decode worker alone.
 */
async function runPage(t: ScenarioContext, query: string, truths: Truths = []): Promise<PageRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noisy-decoder-'));
  try {
    const scene = synthScene(SYNTH);
    const masterFile = path.join(dir, `master-${SYNTH.width}x${SYNTH.height}.rgba`);
    await writeFile(masterFile, scene.masterRgba());
    await t.page.goto(`/dev/decoder.html?width=${SYNTH.width}&height=${SYNTH.height}&${query}`);
    const ready = await t.page.waitFor('the page to be ready', z.string(), readyPhase);
    if (ready !== 'ready') throw new Error(`the decoder page failed at load: ${JSON.stringify(await t.page.evaluate(z.unknown(), reportText))}`);
    await t.page.setFiles('[data-testid=master]', [masterFile]);
    if (truths.length > 0) {
      const files: string[] = [];
      for (const [i, which] of truths.entries()) {
        const file = path.join(dir, `truth-${i}-${which}.u8`);
        await writeFile(file, which === 'sphere' ? scene.sphereMask().data : scene.boxMask().data);
        files.push(file);
      }
      await t.page.setFiles('[data-testid=truths]', files);
    }
    await t.page.click('[data-testid=run]');
    const titles = new Set<string>();
    let mostDecode = 0;
    let mostPthreads = 0;
    let stepped = false;
    const deadline = Date.now() + 200_000;
    for (;;) {
      const state = await t.page.evaluate(PageState, pageState);
      const alive = t.page.workers();
      if (state.phase === 'decoding' || state.phase === 'done') {
        for (const target of alive) titles.add(target.title);
        mostDecode = Math.max(mostDecode, alive.filter((target) => target.title === 'decode').length);
        mostPthreads = Math.max(mostPthreads, alive.filter((target) => PTHREAD.test(target.title)).length);
      }
      if (state.phase === 'encoded' && !stepped && (alive.length === 0 || Date.now() > deadline - 190_000)) {
        stepped = true;
        await t.page.click('[data-testid=continue]');
      }
      if (state.phase === 'failed' || (state.phase === 'done' && state.row !== null && state.row !== 'posting')) break;
      if (Date.now() > deadline) throw new Error('the decoder page did not settle within 200 seconds');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const report = ReportSchema.parse(await t.page.evaluate(z.unknown(), reportText));
    const settledAt = Date.now();
    while (t.page.workers().length > 0 && Date.now() < settledAt + 10_000) await new Promise((resolve) => setTimeout(resolve, 50));
    const row = (await t.page.evaluate(PageState, pageState)).row;
    return { report, row, census: { mostDecode, mostPthreads, titles: [...titles], after: t.page.workers(), goneAfterMs: Date.now() - settledAt } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lock(): Promise<ParsedLock> {
  const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** The page reached `done` cross-origin isolated with its row posted. */
function expectDone(t: ScenarioContext, run: PageRun): Report {
  t.equal('the page ran to its end', run.report.phase, 'done', { detail: run.report.detail });
  t.equal('the page posted its row to the sink', run.row, 'posted');
  t.equal('the page was cross-origin isolated', run.report.env.crossOriginIsolated, true);
  t.equal('the fetch through the service succeeded', run.report.fetch, { ok: true });
  return run.report;
}

/** The decoder's events in order (the fetch's and the encoder sequence's left out), each as its name and its worker and reason, op, or error kind. */
function decoderEvents(report: Report): string[] {
  const events = report.events;
  const firstDecode = events.findIndex((e) => e.worker === 'decode' || e.op === 'decode');
  return events
    .slice(firstDecode < 0 ? events.length : firstDecode)
    .map((e) => {
      if (e.event === 'worker.spawn' || e.event === 'worker.terminate') return `${e.event} ${e.worker ?? ''} ${e.reason ?? ''}`;
      if (e.event === 'stage.failed') return `stage.failed ${e.op ?? ''} ${e.error?.kind ?? ''}`;
      return `${e.event} ${e.op ?? e.model ?? ''}`;
    });
}

/** An outcome as text: `ok`, `worker <message>`, or the error's kind; `none` when missing. */
function outcomeText(outcome: Outcome | null | undefined): string {
  if (outcome === null || outcome === undefined) return 'none';
  if (outcome.kind === 'ok') return 'ok';
  return outcome.error.kind === 'worker' ? `worker ${outcome.error.message ?? ''}` : outcome.error.kind;
}

/** Every worker target is detached after the report settled. */
function expectAllGone(t: ScenarioContext, census: Census): void {
  t.equal('after the release, the decode worker and its pthread workers were all detached within 10 seconds', census.after, [], census);
}

/** A tap at the center of the sphere's disk and one at the center of the box's face, in frame fractions of the master. */
function synthTaps(): { readonly sphere: string; readonly box: string } {
  const g = sceneGeometry(SYNTH);
  const f = (value: number): string => value.toFixed(6);
  return {
    sphere: `${f(g.sphere.cx / SYNTH.width)},${f(g.sphere.cy / SYNTH.height)},include`,
    box: `${f((g.box.x0 + g.box.x1) / 2 / SYNTH.width)},${f((g.box.y0 + g.box.y1) / 2 / SYNTH.height)},include`,
  };
}

/** A stand-in decoder run's decode and release lever, on zero-filled embeddings: one tap at the frame's center. */
const CENTER = '0.5,0.5,include';

/** A decode whose init failed resolves worker naming the failure; the worker stays alive until release, which terminates it. */
function expectInitFailure(t: ScenarioContext, report: Report, message: RegExp): void {
  const [decode] = report.decodes;
  const text = outcomeText(decode?.outcome);
  t.ok('the decode resolves worker, naming why the decoder did not start', message.test(text), { outcome: decode?.outcome });
  t.equal('the worker answered the decode once, with failed', report.replies.map((r) => r.type), ['failed']);
  t.equal('alive.decoder was true after the open and after the decode, and false after the release', report.alive, { afterOpen: true, afterDecodes: true, afterRelease: false });
  t.equal('the events: the spawn, the decode, its failure, and the release', decoderEvents(report), [
    'worker.spawn decode open',
    'stage.start decode',
    'stage.failed decode worker',
    'worker.terminate decode released',
    'stage.failed decode cancelled',
  ]);
  t.equal('the decode after the release resolves cancelled', outcomeText(report.afterRelease), 'cancelled');
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'decoder.sphere-box',
    title: 'on the encoder\'s embeddings of synth and a 1024 x 768 guide, a tap on the sphere and one on the box each give a best candidate that passes checkMask; release terminates the worker and a later decode resolves cancelled',
    target: 'dev',
    covers: ['O1'],
    timeoutMs: 240_000,
    readsSinkFiles: true,
    async run(t) {
      const taps = synthTaps();
      const run = await runPage(t, `threads=2&step=1&decode=${taps.sphere}&decode=${taps.box}`, ['sphere', 'box']);
      const report = expectDone(t, run);
      t.equal('the encoder ran through the service', report.encode?.kind, 'done', { encode: report.encode });
      t.equal('the guide is the master at long edge 1024, the size of the fixture\'s truth masks', report.guide, maskSize(SYNTH));
      for (const [index, what] of ['sphere', 'box'].entries()) {
        const outcome = report.decodes[index]?.outcome;
        if (outcome?.kind !== 'ok') {
          t.ok(`the ${what} decode resolved ok`, false, { outcome });
          continue;
        }
        const scores = outcome.candidates.map((c) => c.score);
        t.ok(`the ${what} decode gives three candidates in descending score`, scores.length === 3 && scores.every((s, i) => i === 0 || s <= (scores[i - 1] ?? Infinity)), { scores });
        t.ok(`every ${what} candidate is 1024 x 768`, outcome.candidates.every((c) => c.size.width === 1024 && c.size.height === 768), { sizes: outcome.candidates.map((c) => c.size) });
        const best = outcome.candidates[0];
        const check = best?.check;
        t.ok(`the ${what} decode's best candidate passes checkMask against the ${what}'s truth (IoU >= 0.85, background false positives <= 0.02)`, check !== null && check !== undefined && 'pass' in check && check.pass, {
          check,
          all: outcome.candidates.map((c) => ({ score: c.score, inside: c.inside, check: c.check })),
        });
      }
      t.equal('alive.decoder was true after the open and after the decodes, and false after the release', report.alive, { afterOpen: true, afterDecodes: true, afterRelease: false });
      t.equal('the decode after the release resolves cancelled', outcomeText(report.afterRelease), 'cancelled');
      t.equal('the decoder\'s events: one spawn, a start and an end per decode, one terminate on release, and the later decode\'s cancel', decoderEvents(report), [
        'worker.spawn decode open',
        'stage.start decode',
        'stage.start decode',
        'stage.end decode',
        'stage.end decode',
        'worker.terminate decode released',
        'stage.failed decode cancelled',
      ]);
      const ends = report.events.filter((e) => e.event === 'stage.end' && e.op === 'decode');
      t.ok('each decode\'s stage.end carries its time and a high-water mark', ends.length === 2 && ends.every((e) => (e.ms ?? 0) > 0 && (e.wasmHighWaterBytes ?? 0) > 0), { ends });
      const decoded = report.replies.filter((r) => r.type === 'decoded');
      t.equal('the worker answered each decode once, with decoded', report.replies.map((r) => r.type), ['decoded', 'decoded']);
      t.ok(
        'the first decoded reply carries the session\'s creation time and the second none',
        decoded.length === 2 && (decoded[0]?.timings.sessionMs ?? 0) > 0 && decoded[1]?.timings.sessionMs === 0,
        { timings: decoded.map((r) => r.timings), elapsedMs: report.decodes.map((d) => d.elapsedMs), encode: report.encode },
      );
      t.equal('one decode worker at most was attached at once', run.census.mostDecode, 1, run.census);
      t.ok('the decode worker ran pthread workers of ONNX Runtime', run.census.mostPthreads >= 1, run.census);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.abort',
    title: 'a decode whose signal aborted before the call, and one aborted right after it, resolve cancelled; the late answer is dropped and the next decode resolves ok',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}&decode=${CENTER}&decode=${CENTER}&abort=0:before&abort=1:during`);
      const report = expectDone(t, run);
      t.equal('the outcomes: cancelled, cancelled, ok', report.decodes.map((d) => outcomeText(d.outcome)), ['cancelled', 'cancelled', 'ok']);
      t.equal('the worker answered the two decodes posted, the aborted one\'s answer included', report.replies.map((r) => r.type), ['decoded', 'decoded']);
      t.equal('the events: the decode aborted before the call is never started; the one aborted after it starts and is cancelled', decoderEvents(report), [
        'worker.spawn decode open',
        'stage.failed decode cancelled',
        'stage.start decode',
        'stage.failed decode cancelled',
        'stage.start decode',
        'stage.end decode',
        'worker.terminate decode released',
        'stage.failed decode cancelled',
      ]);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.release-during',
    title: 'release while two decodes are pending resolves both cancelled, terminates the worker, and a later decode resolves cancelled',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}&decode=${CENTER}&release=during`);
      const report = expectDone(t, run);
      t.equal('both decodes and the one after the release resolve cancelled', [...report.decodes.map((d) => outcomeText(d.outcome)), outcomeText(report.afterRelease)], ['cancelled', 'cancelled', 'cancelled']);
      t.equal('alive.decoder is false once released', [report.alive.afterOpen, report.alive.afterDecodes, report.alive.afterRelease], [true, false, false]);
      t.equal('the events: both started, both cancelled, then the terminate', decoderEvents(report), [
        'worker.spawn decode open',
        'stage.start decode',
        'stage.start decode',
        'stage.failed decode cancelled',
        'stage.failed decode cancelled',
        'worker.terminate decode released',
        'stage.failed decode cancelled',
      ]);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.release-before',
    title: 'release before any decode: the decode resolves cancelled without being posted, and the worker answers nothing',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}&release=before`);
      const report = expectDone(t, run);
      t.equal('the decode and the one after the release resolve cancelled', [outcomeText(report.decodes[0]?.outcome), outcomeText(report.afterRelease)], ['cancelled', 'cancelled']);
      t.equal('the worker answered nothing', report.replies, []);
      t.equal('the events: the spawn, the terminate, and two cancels without a start', decoderEvents(report), [
        'worker.spawn decode open',
        'worker.terminate decode released',
        'stage.failed decode cancelled',
        'stage.failed decode cancelled',
      ]);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.reopen',
    title: 'openDecoder while a decoder is alive terminates it: its pending decode and a later one resolve cancelled, and the new decoder decodes',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}&reopen=1`);
      const report = expectDone(t, run);
      t.equal('the replaced decoder\'s pending and later decodes resolve cancelled', [outcomeText(report.replaced?.pending), outcomeText(report.replaced?.later)], ['cancelled', 'cancelled']);
      t.equal('the new decoder\'s decode resolves ok', outcomeText(report.decodes[0]?.outcome), 'ok');
      t.equal('alive.decoder was true after the reopen and false after the release', [report.alive.afterOpen, report.alive.afterRelease], [true, false]);
      t.equal('the events: the first decoder replaced, the second spawned and released', decoderEvents(report), [
        'worker.spawn decode open',
        'stage.start decode',
        'stage.failed decode cancelled',
        'worker.terminate decode replaced',
        'worker.spawn decode open',
        'stage.failed decode cancelled',
        'stage.start decode',
        'stage.end decode',
        'worker.terminate decode released',
        'stage.failed decode cancelled',
      ]);
      t.ok('the census saw a decode worker', run.census.mostDecode >= 1, run.census);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.error-event',
    title: 'a message the decode worker cannot parse raises an error event: both pending decodes resolve worker, the worker is terminated, and the decoder is stopped',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the page posts the decode worker a message it cannot parse, which it throws as an error event', text: /the decode worker cannot read a request/ });
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}&decode=${CENTER}&unparseable=1`);
      const report = expectDone(t, run);
      const expected = 'worker the worker raised an error: Uncaught Error: the decode worker cannot read a request: (message): Invalid input: expected object, received string';
      t.equal('both pending decodes resolve worker with the error event\'s message', report.decodes.map((d) => outcomeText(d.outcome)), [expected, expected]);
      t.equal('alive.decoder is false once the decoder stopped', [report.alive.afterOpen, report.alive.afterDecodes, report.alive.afterRelease], [true, false, false]);
      t.equal('the decode after the release resolves cancelled', outcomeText(report.afterRelease), 'cancelled');
      t.equal('the events: both started, both failed, the terminate as failed, and the later cancel', decoderEvents(report), [
        'worker.spawn decode open',
        'stage.start decode',
        'stage.start decode',
        'stage.failed decode worker',
        'stage.failed decode worker',
        'worker.terminate decode failed',
        'stage.failed decode cancelled',
      ]);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.runtime-fails',
    title: 'with /vendor/ort/ answering 500, the decoder\'s init fails and the decode resolves worker, naming the runtime',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the fault answers the runtime with a 500', channel: 'log', source: 'network', level: 'error', url: /\/vendor\/ort\// });
      await t.server.setFaults(['path:/vendor/ort/:http500']);
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}`);
      expectInitFailure(t, expectDone(t, run), /^worker the decoder did not start: ONNX Runtime did not load: /);
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.missing-file',
    title: 'with the decoder\'s external data removed from the verified cache, the init fails and the decode resolves worker, naming the file',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const external = (await lock()).ops.decode.files.find((file) => file.role === 'external-data');
      if (external === undefined) throw new Error('the decoder session has no external-data file');
      const run = await runPage(t, `embeddings=zeros&decode=${CENTER}&evict=${encodeURIComponent(external.served)}`);
      const report = expectDone(t, run);
      t.equal('the page removed the file from the verified cache', report.evicted, true);
      expectInitFailure(t, report, new RegExp(`^worker the decoder did not start: the verified model cache \\S+ holds no ${external.served.replaceAll('.', '\\.')}; fetch the models again$`));
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.other-model',
    title: 'embeddings made by another model fail the init, and the decode resolves worker naming both models',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const facts = await lock();
      const run = await runPage(t, `embeddings=other-model&decode=${CENTER}`);
      expectInitFailure(t, expectDone(t, run), new RegExp(`^worker the decoder did not start: embeddings: made by ${facts.ops.depth.model}, not by the decoder's model ${facts.ops.decode.model}$`));
      expectAllGone(t, run.census);
    },
  },
  {
    id: 'decoder.wrong-tensors',
    title: 'embeddings whose third tensor has other dims fail the init, and the decode resolves worker naming the tensor',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const run = await runPage(t, `embeddings=wrong-tensors&decode=${CENTER}`);
      expectInitFailure(
        t,
        expectDone(t, run),
        /^worker the decoder did not start: embeddings\.tensors\[2\]: expected image_embeddings\.2 with dims \[1, 256, 64, 64\], got image_embeddings\.2 with dims \[1, 64, 256, 64\]$/,
      );
      expectAllGone(t, run.census);
    },
  },
];
