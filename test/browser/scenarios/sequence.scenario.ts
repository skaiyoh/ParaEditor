// The sequence worker, driven over its protocol through its dev page,
// /dev/sequence.html, on the real models and the synth fixtures. Each scenario
// paints its fixture in node, writes the master's RGBA bytes (and the hole's,
// for inpaint) to a temporary file, and hands it to the page through the
// page's file input; the page fetches the models, posts init, a run per stage
// with a fresh bitmap, and end, and reports every reply, each parsed with the
// page's parser. Once every run is answered the page posts one more run and
// listens for a second, so each scenario's check of the whole reply list also
// sees a second answer to the last run, or an answer from a worker that did
// not close on end. sequence.depth, sequence.depth-pano, and
// sequence.no-isolation also hand the page the depth check's near and far
// regions, and sequence.inpaint the inpaint check's ring, so the page runs
// the known-answer check on each product and reports its numbers and
// verdict; the planes never come back. The other scenarios hand it no truth
// plane, and their reports carry no check.
//
// The wasm high-water marks are read at 2 threads, the condition of the
// earlier Mac measurements these bands start from, which this repository does
// not record; a megabyte here is 10^6 bytes, as theirs was, and a reading is rounded to whole megabytes before it is compared. The
// depth bands and the encoder's band in a worker of its own are those
// measurements'. The encoder after depth in one worker reads 722 MB on this
// Mac in Chrome 154 at 2 threads, but the same sequence read 791 MB in those
// measurements' Safari run at 2 threads, and at ORT's default thread count
// its reading varies from run to run (sequence.default-threads records it),
// so its band runs from 2% under 722 MB to 796 MB, the top of those
// measurements' band for the encoder. MI-GAN on the synth fixture's hole reads 419 MB on this Mac in
// Chrome 154, three times with the same reading, given 2% either side, since
// its memory depends on the hole: on the input the earlier 474 MB
// measurement used, a patterned image with a hole over the central fifth of
// each side, sequence.inpaint-box reads 474 MB.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { depthInputSize } from '../../../src/analysis/depth-size.ts';
import { parseLock, type ParsedLock } from '../../../src/analysis/lock.ts';
import { SAM_EMBEDDING_TENSORS } from '../../../src/analysis/stage-math.ts';
import type { Size } from '../../../src/core/raster.ts';
import { z } from '../../../src/core/zod.ts';
import { holePlane, type HoleShape } from '../../../src/dev/harness/holes.ts';
import { synthScene } from '../../fixtures/synth/synth.ts';
import { REPO } from '../driver/server.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const SYNTH: Size = { width: 2048, height: 1536 };
const SYNTH_PANO: Size = { width: 2048, height: 512 };
const SQUARE: Size = { width: 2048, height: 2048 };

const SizeSchema = z.object({ width: z.number(), height: z.number() });
const Timings = z.object({ sessionMs: z.number(), inferMs: z.number(), wasmHighWaterBytes: z.number() });
const Stage = z.enum(['depth', 'encode', 'inpaint']);
/** A check's Result as the page reports it, or null when the page was given no truth for it. */
const checkResult = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }), z.object({ ok: z.literal(false), error: z.string() })]).nullable();
const DepthCheck = z.object({
  pass: z.boolean(),
  nearCount: z.number(),
  farCount: z.number(),
  min: z.number(),
  max: z.number(),
  range: z.number(),
  nearMedian: z.number(),
  farMedian: z.number(),
  gapShare: z.number(),
});
const RgbSchema = z.tuple([z.number(), z.number(), z.number()]);
const InpaintCheck = z.object({
  pass: z.boolean(),
  outsideCount: z.number(),
  holeCount: z.number(),
  ringCount: z.number(),
  outsideMeanDifference: z.number(),
  outsideChangedShare: z.number(),
  holeMean: RgbSchema,
  ringMean: RgbSchema,
  originalHoleMean: RgbSchema,
  holeToRing: z.number(),
  originalToRing: z.number(),
  holeChange: z.number(),
  redShare: z.number(),
});
const Reply = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unparsed'), detail: z.string() }),
  z.object({ type: z.literal('phase'), stage: Stage, phase: z.enum(['session', 'infer']), fraction: z.number().nullable() }),
  z.object({
    type: z.literal('depth'),
    size: SizeSchema,
    length: z.number(),
    min: z.number(),
    max: z.number(),
    stats: z.object({ p10: z.number(), median: z.number(), p90: z.number() }),
    timings: Timings,
    check: checkResult(DepthCheck),
  }),
  z.object({
    type: z.literal('embeddings'),
    model: z.string(),
    tensors: z.array(z.object({ name: z.string(), dims: z.array(z.number()), length: z.number() })),
    timings: Timings,
  }),
  z.object({ type: z.literal('plate'), size: SizeSchema, length: z.number(), timings: Timings, check: checkResult(InpaintCheck) }),
  z.object({ type: z.literal('failed'), stage: Stage, message: z.string() }),
]);
type Reply = z.infer<typeof Reply>;

const Report = z.object({
  phase: z.enum(['starting', 'ready', 'fetching', 'running', 'done', 'failed']),
  detail: z.string().nullable(),
  env: z.object({ crossOriginIsolated: z.boolean(), hardwareConcurrency: z.number(), userAgent: z.string() }),
  evicted: z.boolean().nullable(),
  posted: z.array(z.string()),
  replies: z.array(Reply),
  errors: z.array(z.string()),
  messageErrors: z.number(),
  answered: z.number(),
  elapsedMs: z.number().nullable(),
});
type Report = z.infer<typeof Report>;

/** The report once the run is done and its row settled, or failed; null before. */
function settledReport(): unknown {
  const out = document.querySelector<HTMLElement>('[data-testid=report]');
  const phase = out?.dataset['phase'];
  const row = out?.dataset['row'];
  if (out === null || out === undefined) return null;
  if (phase === 'failed' || (phase === 'done' && row !== undefined && row !== 'posting')) return JSON.parse(out.textContent);
  return null;
}

function rowState(): string | null {
  return document.querySelector<HTMLElement>('[data-testid=report]')?.dataset['row'] ?? null;
}

/** The settled report, its row's state, and the most of ONNX Runtime's pthread workers (named `em-pthread`) attached under the page at once while the run went on. */
type Run = { readonly report: Report; readonly row: string | null; readonly mostPthreads: number; readonly sawSequence: boolean };

const PTHREAD = /^em-pthread/;

/**
 * A master's RGBA bytes and, for inpaint, its hole, one byte per pixel; and the truth planes the page checks the
 * products against, when given: the depth check's near and far regions, one byte per texel of the depth map,
 * and the inpaint check's ring, one byte per pixel.
 */
type Input = {
  readonly size: Size;
  readonly rgba: Uint8ClampedArray;
  readonly hole: Uint8Array | null;
  readonly depthTruth: { readonly near: Uint8Array; readonly far: Uint8Array } | null;
  readonly ring: Uint8Array | null;
};

/** The synth scene at `size`; its hole when `hole`; and with `truth`, the depth check's regions, and the ring when `hole` too. */
function synthInput(size: Size, options: { readonly hole?: boolean; readonly truth?: boolean } = {}): Input {
  const scene = synthScene(size);
  const hole = options.hole === true;
  const truth = options.truth === true;
  return {
    size,
    rgba: scene.masterRgba(),
    hole: hole ? scene.hole().data : null,
    depthTruth: truth ? { near: scene.depthNear().data, far: scene.depthFar().data } : null,
    ring: truth && hole ? scene.ring().data : null,
  };
}

/** The planar pattern the earlier MI-GAN measurement fed: each pixel's R, G, and B are (i x 7) mod 256 at their index i in a planar layout. */
function patternRgba(size: Size): Uint8ClampedArray {
  const n = size.width * size.height;
  const rgba = new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i += 1) {
    rgba[4 * i] = (i * 7) & 255;
    rgba[4 * i + 1] = ((n + i) * 7) & 255;
    rgba[4 * i + 2] = ((2 * n + i) * 7) & 255;
    rgba[4 * i + 3] = 255;
  }
  return rgba;
}

/** The earlier MI-GAN measurement's hole: the central box from 0.4 to 0.6 of each side. */
function boxHole(size: Size): Uint8Array {
  const hole = new Uint8Array(size.width * size.height);
  for (let y = Math.trunc(size.height * 0.4); y < Math.trunc(size.height * 0.6); y += 1) {
    hole.fill(255, y * size.width + Math.trunc(size.width * 0.4), y * size.width + Math.trunc(size.width * 0.6));
  }
  return hole;
}

/** The input of the earlier MI-GAN measurement: the pattern, and the central box as its hole. */
function boxHoleInput(size: Size): Input {
  return { size, rgba: patternRgba(size), hole: boxHole(size), depthTruth: null, ring: null };
}

/** The synth master at `size` with one of the memory harness's holes. */
function harnessHoleInput(size: Size, shape: HoleShape): Input {
  return { size, rgba: synthScene(size).masterRgba(), hole: holePlane(shape, size).data, depthTruth: null, ring: null };
}

function readyPhase(): string | null {
  const phase = document.querySelector<HTMLElement>('[data-testid=report]')?.dataset['phase'];
  return phase === 'ready' || phase === 'failed' ? phase : null;
}

/**
 * Writes the input's bytes to a temporary directory, opens the page with
 * `query`, chooses the files, runs, lists the worker targets attached under
 * the page every 250 ms until the report settles, and returns the report and
 * what that listing saw; the directory is removed after.
 */
async function runPage(t: ScenarioContext, input: Input, query: string, timeoutMs = 150_000): Promise<Run> {
  const { size } = input;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noisy-sequence-'));
  try {
    const masterFile = path.join(dir, `master-${size.width}x${size.height}.rgba`);
    await writeFile(masterFile, input.rgba);
    await t.page.goto(`/dev/sequence.html?width=${size.width}&height=${size.height}&${query}`);
    const ready = await t.page.waitFor('the page to be ready', z.string(), readyPhase);
    if (ready !== 'ready') throw new Error(`the sequence page failed at load: ${JSON.stringify(await t.page.evaluate(z.unknown(), settledReport))}`);
    await t.page.setFiles('[data-testid=master]', [masterFile]);
    const choose = async (testid: string, name: string, bytes: Uint8Array): Promise<void> => {
      const file = path.join(dir, name);
      await writeFile(file, bytes);
      await t.page.setFiles(`[data-testid=${testid}]`, [file]);
    };
    if (input.hole !== null) await choose('hole', `hole-${size.width}x${size.height}.u8`, input.hole);
    if (input.depthTruth !== null) {
      await choose('near', 'depth-near.u8', input.depthTruth.near);
      await choose('far', 'depth-far.u8', input.depthTruth.far);
    }
    if (input.ring !== null) await choose('ring', `ring-${size.width}x${size.height}.u8`, input.ring);
    await t.page.click('[data-testid=run]');
    const deadline = Date.now() + timeoutMs;
    let mostPthreads = 0;
    let sawSequence = false;
    for (;;) {
      const alive = t.page.workers();
      mostPthreads = Math.max(mostPthreads, alive.filter((target) => PTHREAD.test(target.title)).length);
      sawSequence ||= alive.some((target) => target.title === 'sequence');
      const settled = await t.page.evaluate(z.unknown(), settledReport);
      if (settled !== null) {
        return { report: Report.parse(settled), row: await t.page.evaluate(z.string().nullable(), rowState), mostPthreads, sawSequence };
      }
      if (Date.now() > deadline) throw new Error(`the sequence did not settle and post its row within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The run's report, which must have reached `done` with its row posted. */
function expectDone(t: ScenarioContext, run: Run): Report {
  t.equal('the page ran to its end', run.report.phase, 'done', { detail: run.report.detail });
  t.equal('the page posted its row to the sink', run.row, 'posted');
  t.equal('every reply parsed with the page\'s parser', run.report.replies.filter((r) => r.type === 'unparsed'), []);
  t.equal('the Worker received no error and no messageerror event', [run.report.errors, run.report.messageErrors], [[], 0]);
  return run.report;
}

/** The reply types in order: each stage's two phases, then its answer. */
function sequenceOf(replies: readonly Reply[]): readonly string[] {
  return replies.map((r) => (r.type === 'phase' ? `${r.stage} ${r.phase}` : r.type === 'failed' ? `failed ${r.stage}` : r.type));
}

const megabytes = (bytes: number): number => Math.round(bytes / 1e6);

/** Records the stage's timings as evidence and checks its high-water mark lies in [lo, hi] megabytes. */
function expectHighWater(t: ScenarioContext, what: string, timings: z.infer<typeof Timings> | undefined, lo: number, hi: number): void {
  const mb = timings === undefined ? null : megabytes(timings.wasmHighWaterBytes);
  t.ok(`${what}: the wasm high-water mark lies in ${lo} to ${hi} MB`, mb !== null && mb >= lo && mb <= hi, { megabytes: mb, timings });
}

function expectDepth(t: ScenarioContext, reply: Reply | undefined, master: Size): z.infer<typeof Timings> | undefined {
  if (reply?.type !== 'depth') {
    t.ok('the depth stage answered with a depth product', false, { reply });
    return undefined;
  }
  const size = depthInputSize(master);
  t.equal(`the depth map is depthInputSize(master), ${size.width} x ${size.height}`, [reply.size, reply.length], [size, size.width * size.height]);
  t.equal('the map is min-max normalized: its least value 0 and its largest 1', [reply.min, reply.max], [0, 1]);
  const { p10, median, p90 } = reply.stats;
  t.ok('the statistics lie in 0..1 and rise from p10 to p90', p10 >= 0 && p10 <= median && median <= p90 && p90 <= 1, reply.stats);
  return reply.timings;
}

/** Checks that the page ran the depth known-answer check on the map and that it passed, with its numbers as evidence. */
function expectDepthCheck(t: ScenarioContext, reply: Reply | undefined): void {
  const check = reply?.type === 'depth' ? reply.check : null;
  t.ok(
    'the depth known-answer check passes: the near median less the far median is above 0.1 of the range',
    check !== null && check.ok && check.value.pass,
    { check },
  );
}

async function lock(): Promise<ParsedLock> {
  const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const answers = (report: Report): readonly Reply[] => report.replies.filter((r) => r.type !== 'phase');

/**
 * MI-GAN on the synth master with each of the memory harness's holes, at the
 * 4:3 and the square master: each read one high-water mark three times in
 * fresh pages on this Mac in Chrome 154 at 2 threads, 686 MB at 2048 x 1536
 * and 903 MB at 2048 x 2048 for either hole, and each band is 2% either side.
 */
const HARNESS_HOLE_CELLS: readonly { readonly id: string; readonly size: Size; readonly shape: HoleShape; readonly lo: number; readonly hi: number }[] = [
  { id: 'sequence.inpaint-corners', size: SYNTH, shape: 'corners', lo: 672, hi: 700 },
  { id: 'sequence.inpaint-full', size: SYNTH, shape: 'full', lo: 672, hi: 700 },
  { id: 'sequence.inpaint-corners-square', size: SQUARE, shape: 'corners', lo: 885, hi: 921 },
  { id: 'sequence.inpaint-full-square', size: SQUARE, shape: 'full', lo: 885, hi: 921 },
];

export const scenarios: readonly Scenario[] = [
  {
    id: 'sequence.depth',
    title: 'depth on synth 2048 x 1536 at 2 threads, with one pthread worker: a 686 x 518 map that parses, statistics in 0..1, a passing known-answer check, and a high-water mark of 277 to 348 MB',
    target: 'dev',
    covers: ['C9'],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const run = await runPage(t, synthInput(SYNTH, { truth: true }), 'stages=depth&threads=2');
      const report = expectDone(t, run);
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['depth session', 'depth infer', 'depth']);
      t.equal('the page was cross-origin isolated', report.env.crossOriginIsolated, true);
      t.equal('depth ran on 2 threads: the sequence worker started one pthread worker', [run.sawSequence, run.mostPthreads], [true, 1]);
      const timings = expectDepth(t, report.replies[2], SYNTH);
      expectDepthCheck(t, report.replies[2]);
      expectHighWater(t, 'depth at 4:3', timings, 277, 348);
      const rows = (await t.server.sinkLines()).flatMap((line) => ('row' in line ? [line.row] : []));
      t.equal('the sink holds the page\'s one row', rows.length, 1);
    },
  },
  {
    id: 'sequence.depth-pano',
    title: 'depth on synth-pano 2048 x 512 at 2 threads: a 1190 x 294 map, a passing known-answer check at that size, and a high-water mark of 277 to 292 MB',
    target: 'dev',
    covers: ['C9'],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, synthInput(SYNTH_PANO, { truth: true }), 'stages=depth&threads=2'));
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['depth session', 'depth infer', 'depth']);
      const timings = expectDepth(t, report.replies[2], SYNTH_PANO);
      expectDepthCheck(t, report.replies[2]);
      expectHighWater(t, 'depth at 4:1', timings, 277, 292);
    },
  },
  {
    id: 'sequence.depth-encode',
    title: 'depth then encode in one worker at 2 threads: both products parse, the embeddings carry the table\'s names and dims, and the encoder\'s high-water mark is 708 to 796 MB',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const facts = await lock();
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=depth,encode&threads=2'));
      t.equal('the stages run one at a time, in order', sequenceOf(report.replies), ['depth session', 'depth infer', 'depth', 'encode session', 'encode infer', 'embeddings']);
      const depthTimings = expectDepth(t, report.replies[2], SYNTH);
      expectHighWater(t, 'depth at 4:3, first in the sequence', depthTimings, 277, 348);
      const embeddings = report.replies[5];
      if (embeddings?.type !== 'embeddings') {
        t.ok('the encode stage answered with embeddings', false, { reply: embeddings });
        return;
      }
      t.equal('the embeddings carry the encoder\'s ModelId', embeddings.model, facts.ops.encode.model);
      const expected = SAM_EMBEDDING_TENSORS.map((spec) => ({ name: spec.name, dims: [...spec.dims], length: spec.dims.reduce((a: number, b: number) => a * b, 1) }));
      t.equal('the embeddings carry the table\'s names and dims, in its order', embeddings.tensors, expected);
      expectHighWater(t, 'encode after depth', embeddings.timings, 708, 796);
    },
  },
  {
    id: 'sequence.encode',
    title: 'encode alone on synth 2048 x 1536 at 2 threads: embeddings that parse and a high-water mark of 791 to 796 MB',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=encode&threads=2'));
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['encode session', 'encode infer', 'embeddings']);
      const embeddings = report.replies[2];
      t.ok('the encode stage answered with embeddings', embeddings?.type === 'embeddings', { reply: embeddings });
      expectHighWater(t, 'encode in a worker of its own', embeddings?.type === 'embeddings' ? embeddings.timings : undefined, 791, 796);
    },
  },
  {
    id: 'sequence.inpaint',
    title: 'inpaint alone on synth 2048 x 1536 with its hole at 2 threads: a 2048 x 1536 plate that parses, a passing known-answer check, and a high-water mark of 411 to 427 MB',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, synthInput(SYNTH, { hole: true, truth: true }), 'stages=inpaint&threads=2'));
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['inpaint session', 'inpaint infer', 'plate']);
      const plate = report.replies[2];
      if (plate?.type !== 'plate') {
        t.ok('the inpaint stage answered with a plate', false, { reply: plate });
        return;
      }
      t.equal('the plate is the bitmap\'s size, 3 bytes a pixel', [plate.size, plate.length], [SYNTH, SYNTH.width * SYNTH.height * 3]);
      t.ok(
        'the inpaint known-answer check passes: the plate is unchanged outside the hole, and the hole takes the ring\'s color and is not red',
        plate.check !== null && plate.check.ok && plate.check.value.pass,
        { check: plate.check },
      );
      expectHighWater(t, 'inpaint at 2048 x 1536 on the synth hole, alone', plate.timings, 411, 427);
    },
  },
  {
    id: 'sequence.inpaint-box',
    title: 'inpaint alone at 2048 x 1536 on the input the earlier MI-GAN measurement used, at 2 threads: a high-water mark of 470 to 478 MB',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, boxHoleInput(SYNTH), 'stages=inpaint&threads=2'));
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['inpaint session', 'inpaint infer', 'plate']);
      const plate = report.replies[2];
      t.ok('the inpaint stage answered with a plate', plate?.type === 'plate', { reply: plate });
      expectHighWater(t, 'inpaint at 2048 x 1536 on a central box hole, alone', plate?.type === 'plate' ? plate.timings : undefined, 470, 478);
    },
  },
  ...HARNESS_HOLE_CELLS.map((cell): Scenario => ({
    id: cell.id,
    title: `inpaint alone on synth ${cell.size.width} x ${cell.size.height} with the harness's ${cell.shape} hole at 2 threads: a plate of the master's size and a high-water mark of ${cell.lo} to ${cell.hi} MB`,
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, harnessHoleInput(cell.size, cell.shape), 'stages=inpaint&threads=2'));
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['inpaint session', 'inpaint infer', 'plate']);
      const plate = report.replies[2];
      t.equal('the plate is the master\'s size, 3 bytes a pixel', plate?.type === 'plate' ? [plate.size, plate.length] : plate, [cell.size, cell.size.width * cell.size.height * 3]);
      expectHighWater(t, `inpaint at ${cell.size.width} x ${cell.size.height} on the ${cell.shape} hole, alone`, plate?.type === 'plate' ? plate.timings : undefined, cell.lo, cell.hi);
    },
  })),
  {
    id: 'sequence.no-isolation',
    title: 'under the no-isolation fault the page is not cross-origin isolated, depth completes on one thread, and its known-answer check passes',
    target: 'dev',
    covers: ['F26'],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      await t.server.setFaults(['no-isolation']);
      const run = await runPage(t, synthInput(SYNTH, { truth: true }), 'stages=depth&threads=2');
      const report = expectDone(t, run);
      t.equal('the page was not cross-origin isolated', report.env.crossOriginIsolated, false);
      t.equal('depth ran on one thread: the sequence worker, asked for 2 threads, started no pthread worker', [run.sawSequence, run.mostPthreads], [true, 0]);
      t.equal('the replies come in order: session, infer, product', sequenceOf(report.replies), ['depth session', 'depth infer', 'depth']);
      const timings = expectDepth(t, report.replies[2], SYNTH);
      t.ok('the depth stage reported its timings', timings !== undefined, { timings });
      expectDepthCheck(t, report.replies[2]);
    },
  },
  {
    id: 'sequence.unparseable',
    title: 'a request the worker cannot parse reaches the page as an error event naming the failure, and the run sent after it is still answered',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the worker throws a request it cannot parse, which the page receives as an error event', text: /the sequence worker cannot read a request/ });
      const run = await runPage(t, synthInput(SYNTH), 'stages=depth&threads=2&unparseable=1');
      const { report } = run;
      t.equal('the page ran to its end', report.phase, 'done', { detail: report.detail });
      t.equal('the requests went out in order', report.posted, ['init', 'unparseable', 'run depth', 'end', 'run depth after the answers']);
      t.equal('the Worker received one error event', report.errors.length, 1, { errors: report.errors });
      t.ok('the error names the parse failure, the run\'s missing image', /the sequence worker cannot read a request: image: /.test(report.errors[0] ?? ''), { errors: report.errors });
      t.equal('the run after it is still answered, in order', sequenceOf(report.replies), ['depth session', 'depth infer', 'depth']);
      expectDepth(t, report.replies[2], SYNTH);
    },
  },
  {
    id: 'sequence.runtime-fails',
    title: 'with /vendor/ort/ answering 500, the run is answered failed for its stage, naming the failed import',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the fault answers the runtime with a 500', channel: 'log', source: 'network', level: 'error', url: /\/vendor\/ort\// });
      await t.server.setFaults(['path:/vendor/ort/:http500']);
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=depth,encode&threads=2'));
      t.equal('each run is answered failed, in order, with no phase', sequenceOf(report.replies), ['failed depth', 'failed encode']);
      const messages = answers(report).map((r) => (r.type === 'failed' ? r.message : ''));
      const named = new RegExp(`^the worker did not start: ONNX Runtime did not load: .*${t.build.ort.dir.replaceAll('.', '\\.')}ort\\.wasm\\.min\\.mjs`);
      t.ok('each failure names the runtime\'s import that failed', messages.every((m) => named.test(m)), { messages });
    },
  },
  {
    id: 'sequence.wasm-fails',
    title: 'with the runtime\'s wasm answering 500, each run is answered failed for its stage as its session is created',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      t.expectMessage({ because: 'the fault answers the runtime\'s wasm with a 500', channel: 'log', source: 'network', level: 'error', url: /\.wasm$/ });
      await t.server.setFaults([`path:${t.build.ort.dir}ort-wasm-simd-threaded.wasm:http500`]);
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=depth,encode&threads=2'));
      t.equal('each run is answered failed after its session phase', sequenceOf(report.replies), ['depth session', 'failed depth', 'encode session', 'failed encode']);
      const failures = answers(report);
      t.ok(
        'each failure says its session could not be created',
        failures.every((r) => r.type === 'failed' && r.message.startsWith(`the ${r.stage === 'encode' ? 'encoder' : r.stage} session could not be created: `)),
        { failures },
      );
    },
  },
  {
    id: 'sequence.missing-file',
    title: 'with a model file removed from the verified cache, the run is answered failed, naming the file',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const facts = await lock();
      const external = facts.ops.encode.files.find((file) => file.role === 'external-data');
      if (external === undefined) throw new Error('the encoder session has no external-data file');
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), `stages=encode&threads=2&evict=${encodeURIComponent(external.served)}`));
      t.equal('the page removed the file from the verified cache', report.evicted, true);
      t.equal('the run is answered failed after its session phase', sequenceOf(report.replies), ['encode session', 'failed encode']);
      const failed = report.replies[1];
      t.ok('the failure names the file', failed?.type === 'failed' && failed.message.includes(`holds no ${external.served}`), { failed });
    },
  },
  {
    id: 'sequence.hole-size',
    title: 'an inpaint run whose hole is another size than its image is answered failed',
    target: 'dev',
    covers: [],
    timeoutMs: 120_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=inpaint&threads=2&hole=mismatched'));
      t.equal('the run is answered failed, before any session', sequenceOf(report.replies), ['failed inpaint']);
      t.equal('the failure gives both sizes', report.replies[0], { type: 'failed', stage: 'inpaint', message: 'hole: expected the image\'s size 2048 x 1536, got 1024 x 768' });
    },
  },
  {
    id: 'sequence.protocol-order',
    title: 'a run before init is answered failed; a second init, naming a runtime that is not there, changes nothing; a run queued behind end is answered failed; a run posted after every answer is not answered, since end closed the worker',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const noInit = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=depth&threads=2&init=0'));
      t.equal('without init the run is answered failed', noInit.replies, [{ type: 'failed', stage: 'depth', message: 'no init request came before this run' }]);
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=depth&threads=2&secondInit=1&afterEnd=1'));
      t.equal('the requests went out in order', report.posted, ['init', 'init', 'run depth', 'end', 'run depth', 'run depth after the answers']);
      t.equal(
        'the run before end is answered with its product, which the second init would have failed, the one queued behind end with failed, and the one after the answers not at all',
        sequenceOf(report.replies),
        ['depth session', 'depth infer', 'depth', 'failed depth'],
      );
      expectDepth(t, report.replies[2], SYNTH);
      t.equal('the run queued behind end says so', report.replies[3], { type: 'failed', stage: 'depth', message: 'the worker ended before this run' });
    },
  },
  {
    id: 'sequence.default-threads',
    title: 'depth then encode at ORT\'s default thread count, its high-water marks recorded for information',
    target: 'dev',
    covers: [],
    timeoutMs: 170_000,
    readsSinkFiles: true,
    async run(t) {
      const report = expectDone(t, await runPage(t, synthInput(SYNTH), 'stages=depth,encode&threads=default'));
      t.equal('the stages run one at a time, in order', sequenceOf(report.replies), ['depth session', 'depth infer', 'depth', 'encode session', 'encode infer', 'embeddings']);
      const timings = answers(report).map((r) => ('timings' in r ? { type: r.type, megabytes: megabytes(r.timings.wasmHighWaterBytes), ...r.timings } : r));
      t.ok('the high-water marks at the default thread count, for information', true, { hardwareConcurrency: report.env.hardwareConcurrency, timings });
    },
  },
];
