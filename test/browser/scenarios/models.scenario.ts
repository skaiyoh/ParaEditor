// The model loader, driven through its dev page, /dev/models.html, against
// the dev server's faults. Every scenario runs the decode operation, whose
// files are the lock's smallest graph and its external data, and faults the
// graph, the lock's smallest file, except the truncation, which cuts the
// external data past the first segment.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { lockHash, parseLock, type ParsedLock } from '../../../src/analysis/lock.ts';
import { SEGMENT_BYTES } from '../../../src/analysis/models.ts';
import { z } from '../../../src/core/zod.ts';
import { REPO } from '../driver/server.ts';
import type { RequestLine, Scenario, ScenarioContext } from '../scenario.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const Report = z.object({
  phase: z.enum(['starting', 'ready', 'running', 'failed']),
  detail: z.string().nullable(),
  lockHash: z.string().nullable(),
  cacheName: z.string().nullable(),
  partialCacheName: z.string().nullable(),
  stallMs: z.number(),
  op: z.string(),
  runs: z.number(),
  result: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.record(z.string(), z.unknown()) })]).nullable(),
  elapsedMs: z.number().nullable(),
  progress: z.record(z.string(), z.number()),
  caches: z.record(z.string(), z.array(z.string())),
});
type Report = z.infer<typeof Report>;

/** The page's report once it is ready after at least `runs` runs, or failed; null while it is not. */
function settledReport(runs: number): unknown {
  const out = document.querySelector<HTMLElement>('[data-testid=report]');
  const phase = out?.dataset['phase'];
  if (out === null || (phase !== 'ready' && phase !== 'failed')) return null;
  const report: unknown = JSON.parse(out.textContent);
  const done = typeof report === 'object' && report !== null && 'runs' in report && typeof report.runs === 'number' && report.runs >= runs;
  return phase === 'failed' || done ? report : null;
}

async function settled(t: ScenarioContext, runs: number, timeoutMs = 30_000): Promise<Report> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const report = await t.page.evaluate(Report.nullable(), settledReport, runs);
    if (report !== null) {
      if (report.phase === 'failed') throw new Error(`the model page failed: ${report.detail ?? ''}`);
      return report;
    }
    if (Date.now() > deadline) throw new Error(`the model page did not settle after run ${runs} within ${timeoutMs} ms`);
    await sleep(100);
  }
}

async function open(t: ScenarioContext, query = '?op=decode'): Promise<Report> {
  await t.page.goto(`/dev/models.html${query}`);
  return settled(t, 0);
}

async function run(t: ScenarioContext, runs: number): Promise<Report> {
  await t.page.click('[data-testid=run]');
  return settled(t, runs);
}

type LockFacts = {
  readonly parsed: ParsedLock;
  readonly hash: string;
  readonly verified: string;
  readonly partial: string;
  /** The decode operation's files, the smallest first. */
  readonly target: string;
  readonly other: string;
  readonly decodeFiles: readonly string[];
};

async function lockFacts(): Promise<LockFacts> {
  const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  const hash = await lockHash(parsed.value.lock, crypto.subtle);
  const files = [...parsed.value.ops.decode.files].sort((a, b) => a.bytes - b.bytes).map((f) => f.served);
  const [target, other] = files;
  if (target === undefined || other === undefined) throw new Error('the decode operation needs two files');
  return { parsed: parsed.value, hash, verified: `noisy-models-${hash}`, partial: `noisy-models-${hash}-partial`, target, other, decodeFiles: [...files].sort() };
}

/** Request-log rows after `since` for `served`, as method, range, status, and fault. */
async function requestsFor(t: ScenarioContext, since: number, served: string): Promise<readonly { method: string; range: string | null; status: number; fault: string | null }[]> {
  const rows: readonly RequestLine[] = await t.server.requestLog();
  return rows
    .filter((r) => r.seq > since && r.path === served)
    .map((r) => ({ method: r.method, range: r.headers['range'] ?? null, status: r.status, fault: r.fault }));
}

/** A served path as the intercept rule's type spells it. */
const rootPath = (served: string): `/${string}` => {
  if (!served.startsWith('/')) throw new Error(`${served} is not a root-relative path`);
  return `/${served.slice(1)}`;
};

const lastSeq = async (t: ScenarioContext): Promise<number> => Math.max(0, ...(await t.server.requestLog()).map((r) => r.seq));

/** Checks the verified cache holds both decode files, and that no segment is left. */
function expectCached(t: ScenarioContext, report: Report, facts: LockFacts, when: string): void {
  t.equal(`${when}: the verified cache holds both decode files`, report.caches[facts.verified], facts.decodeFiles);
  t.equal(`${when}: no segment is left`, report.caches[facts.partial], []);
}

/** Every model cache, by name, with the path and query of each entry, read in the page. */
async function listModelCaches(): Promise<unknown> {
  const listing: Record<string, string[]> = {};
  for (const name of (await caches.keys()).filter((n) => n.startsWith('noisy-models-')).sort()) {
    const keys = await (await caches.open(name)).keys();
    listing[name] = keys.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`).sort();
  }
  return listing;
}

/** Plants caches and entries a startup must clean, the depth file's first `keep` bytes, left as a dead page's download would leave them, among them. */
async function plant(other: string, partialName: string, depthServed: string, verifiedServed: string, keep: number): Promise<unknown> {
  const stale = await caches.open(`noisy-models-${other}`);
  await stale.put('/models/stale.onnx', new Response('stale'));
  await caches.open(`noisy-models-${other}-partial`);
  const partial = await caches.open(partialName);
  const head = await fetch(depthServed, { headers: { range: `bytes=0-${keep - 1}` }, cache: 'no-store' });
  await partial.put(`${depthServed}?noisy-partial=0-${keep}`, new Response(await head.arrayBuffer()));
  await partial.put(`${depthServed}?noisy-partial=${keep * 5}-${keep * 6}`, new Response(new Uint8Array(keep)));
  await partial.put(depthServed, new Response('not a segment'));
  await partial.put('/models/unknown-00000000.onnx?noisy-partial=0-4', new Response('four'));
  await partial.put(`${verifiedServed}?noisy-partial=0-4`, new Response('four'));
  return head.status;
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'models.clean-fetch',
    title: 'a clean fetch verifies and caches the decode files under the lock hash, and a second fetch requests nothing',
    target: 'dev',
    covers: ['F1'],
    async run(t) {
      const facts = await lockFacts();
      const opened = await open(t);
      t.equal('the page computes the lock hash node computes', opened.lockHash, facts.hash);
      t.equal('the caches are named for the lock hash', [opened.cacheName, opened.partialCacheName], [facts.verified, facts.partial]);
      t.equal('a fresh profile starts with two empty model caches', opened.caches, { [facts.verified]: [], [facts.partial]: [] });
      const since = await lastSeq(t);
      const first = await run(t, 1);
      t.equal('the first fetch succeeds', first.result, { ok: true });
      t.equal('the decoder model reports all its bytes', first.progress, { [facts.parsed.ops.decode.model]: 1 });
      expectCached(t, first, facts, 'after the first fetch');
      for (const served of facts.decodeFiles) {
        t.equal(`${served} was requested once, whole`, await requestsFor(t, since, served), [{ method: 'GET', range: null, status: 200, fault: null }]);
      }
      const between = await lastSeq(t);
      const second = await run(t, 2);
      t.equal('the second fetch succeeds', second.result, { ok: true });
      const again = (await t.server.requestLog()).filter((r) => r.seq > between && r.path.startsWith('/models/'));
      t.equal('the second fetch makes no request for a model file', again, []);
      expectCached(t, second, facts, 'after the second fetch');
      await t.page.screenshot('models-cached');
    },
  },
  {
    id: 'models.http500',
    title: 'a 500 on a model file fails as download 500 with nothing verified for it, and a clean retry caches it',
    target: 'dev',
    covers: ['F1'],
    async run(t) {
      const facts = await lockFacts();
      await open(t);
      t.expectMessage({ because: 'the fault answers the model file with a 500', channel: 'log', source: 'network', level: 'error', url: /\/models\// });
      await t.server.setFaults([`path:${facts.target}:http500`]);
      const failed = await run(t, 1);
      t.equal('the fetch fails as download with status 500', failed.result, { ok: false, error: { kind: 'download', model: facts.parsed.ops.decode.model, status: 500 } });
      t.equal('the verified cache holds nothing', failed.caches[facts.verified], []);
      await t.server.clearFaults();
      expectCached(t, await run(t, 2), facts, 'after the retry');
    },
  },
  {
    id: 'models.truncate-resume',
    title: 'a truncated download keeps the bytes the page read, and the retry asks for the rest with Range, gets 206, and verifies',
    target: 'dev',
    covers: ['F1'],
    async run(t) {
      const facts = await lockFacts();
      // Past the first segment: Chrome drops the bytes it received but the page
      // had not read when the cut arrives, so only a cut this far in is sure to
      // leave a segment, and the retry's Range is the bytes the page kept.
      const cut = SEGMENT_BYTES + 2 * 1024 * 1024;
      const rule = `path:${facts.other}:truncate=${cut}:times=1`;
      await open(t);
      t.expectMessage({ because: 'the truncated body ends the transfer with a network error', channel: 'log', source: 'network', level: 'error', url: /\/models\// });
      const since = await lastSeq(t);
      await t.server.setFaults([rule]);
      const failed = await run(t, 1);
      t.equal('the cut transfer fails as download offline', failed.result, { ok: false, error: { kind: 'download', model: facts.parsed.ops.decode.model, status: 'offline' } });
      t.equal('the verified cache holds only the graph, which came whole', failed.caches[facts.verified], [facts.target]);
      const segments = (failed.caches[facts.partial] ?? []).map((entry) => {
        const match = /^(.+)\?noisy-partial=(\d+)-(\d+)$/.exec(entry);
        return match === null ? { file: entry, start: -1, end: -1 } : { file: match[1], start: Number(match[2]), end: Number(match[3]) };
      }).sort((a, b) => a.start - b.start);
      const kept = segments.at(-1)?.end ?? 0;
      t.ok('the kept segments are the cut file\'s, from byte 0 without a gap', segments.length > 0 && segments.every((seg, i) => seg.file === facts.other && seg.start === (i === 0 ? 0 : segments[i - 1]?.end)), segments);
      t.ok('they hold at least the first segment and no more than the cut', kept >= SEGMENT_BYTES && kept <= cut, { kept, cut });
      const retried = await run(t, 2);
      t.equal('the retry succeeds', retried.result, { ok: true });
      const requests = await requestsFor(t, since, facts.other);
      t.equal('the retry asked for the rest with Range: bytes=N- and the server answered 206', requests, [
        { method: 'GET', range: null, status: 200, fault: rule },
        { method: 'GET', range: `bytes=${kept}-`, status: 206, fault: null },
      ], (await t.server.requestLog()).filter((r) => r.seq > since && r.path === facts.other));
      expectCached(t, retried, facts, 'after the retry');
    },
  },
  {
    id: 'models.corrupt',
    title: 'a corrupt model file fails as integrity with the model id, nothing is promoted or kept, and a clean retry caches it',
    target: 'dev',
    covers: ['F2'],
    async run(t) {
      const facts = await lockFacts();
      await open(t);
      await t.server.setFaults([`path:${facts.target}:corrupt`]);
      const failed = await run(t, 1);
      t.equal('the fetch fails as integrity with the decoder model id', failed.result, { ok: false, error: { kind: 'integrity', model: facts.parsed.ops.decode.model } });
      t.equal('nothing is promoted to the verified cache', failed.caches[facts.verified], []);
      t.equal('no segment of the corrupt file is kept', failed.caches[facts.partial], []);
      await t.server.clearFaults();
      expectCached(t, await run(t, 2), facts, 'after the clean retry');
    },
  },
  {
    id: 'models.stall',
    title: 'a response that sends no body fails as stalled after the stall timeout, and a clean retry caches the file',
    target: 'dev',
    covers: ['F1'],
    async run(t) {
      const facts = await lockFacts();
      const opened = await open(t, '?op=decode&stallMs=1000');
      t.equal('the page takes the stall timeout from its URL', opened.stallMs, 1000);
      await t.server.setFaults([`path:${facts.target}:stall`]);
      const failed = await run(t, 1);
      t.equal('the fetch fails as download stalled', failed.result, { ok: false, error: { kind: 'download', model: facts.parsed.ops.decode.model, status: 'stalled' } });
      t.ok('it gave up after the stall timeout and well before the default', failed.elapsedMs !== null && failed.elapsedMs >= 1000 && failed.elapsedMs < 10_000, { elapsedMs: failed.elapsedMs });
      t.equal('the verified cache holds nothing', failed.caches[facts.verified], []);
      await t.server.clearFaults();
      expectCached(t, await run(t, 2), facts, 'after the retry');
    },
  },
  {
    id: 'models.offline',
    title: 'a model request that fails on the network fails as download offline, and a retry once it passes caches the file',
    target: 'dev',
    covers: ['F1'],
    async run(t) {
      const facts = await lockFacts();
      await open(t);
      t.expectMessage({ because: 'the intercepted model request fails as a network error', channel: 'log', source: 'network', level: 'error', url: /\/models\// });
      await t.page.intercept([{ method: 'GET', path: rootPath(facts.target), action: { kind: 'fail' } }]);
      const failed = await run(t, 1);
      t.equal('the fetch fails as download offline', failed.result, { ok: false, error: { kind: 'download', model: facts.parsed.ops.decode.model, status: 'offline' } });
      t.equal('the verified cache holds nothing', failed.caches[facts.verified], []);
      await t.page.intercept([]);
      expectCached(t, await run(t, 2), facts, 'after the retry');
    },
  },
  {
    id: 'models.startup-cleanup',
    title: 'startup deletes the caches of another lock and stray segments, keeps a dead page\'s run from byte 0, and the next fetch resumes from it',
    target: 'dev',
    covers: ['F1'],
    timeoutMs: 90_000,
    async run(t) {
      const facts = await lockFacts();
      const depth = facts.parsed.ops.depth.files[0].served;
      const other = 'f'.repeat(64);
      const keep = 1000;
      await open(t);
      expectCached(t, await run(t, 1), facts, 'after the decode fetch');
      const status = await t.page.evaluate(z.number(), plant, other, facts.partial, depth, facts.target, keep);
      t.equal('the planted head of the depth file came from a 206', status, 206);
      t.equal('before the reload the planted caches and entries exist', await t.page.evaluate(z.record(z.string(), z.array(z.string())), listModelCaches), {
        [`noisy-models-${other}`]: ['/models/stale.onnx'],
        [`noisy-models-${other}-partial`]: [],
        [facts.verified]: facts.decodeFiles,
        [facts.partial]: [depth, `${depth}?noisy-partial=0-${keep}`, `${depth}?noisy-partial=${keep * 5}-${keep * 6}`, `${facts.target}?noisy-partial=0-4`, '/models/unknown-00000000.onnx?noisy-partial=0-4'].sort(),
      });
      const reopened = await open(t, '?op=depth');
      t.equal('after a reload only the current lock\'s caches remain, the verified files kept and only the depth file\'s run from byte 0', reopened.caches, {
        [facts.verified]: facts.decodeFiles,
        [facts.partial]: [`${depth}?noisy-partial=0-${keep}`],
      });
      const since = await lastSeq(t);
      const fetched = await settledRun(t);
      t.equal('the depth fetch succeeds', fetched.result, { ok: true });
      t.equal('the depth fetch resumed from the kept bytes', await requestsFor(t, since, depth), [{ method: 'GET', range: `bytes=${keep}-`, status: 206, fault: null }]);
      t.equal('the verified cache holds the decode and depth files, and no segment is left', fetched.caches, {
        [facts.verified]: [...facts.decodeFiles, depth].sort(),
        [facts.partial]: [],
      });
    },
  },
];

/** Runs once on a freshly opened page, waiting long enough for the depth model. */
async function settledRun(t: ScenarioContext): Promise<Report> {
  await t.page.click('[data-testid=run]');
  return settled(t, 1, 60_000);
}
