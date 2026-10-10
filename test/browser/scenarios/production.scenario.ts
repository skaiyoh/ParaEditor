// The production server, as npm start runs it: the shell loads isolated and
// without the test surface, every response's headers equal headers.json, no
// spelling of a dev-only route reaches one, and a model answers a Range
// request. The same scenarios run attached to the tailnet origin:
//   node tools/drive-chrome.mjs --base-url https://<MagicDNS name>/ --target production

import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseLock } from '../../../src/analysis/lock.ts';
import { z } from '../../../src/core/zod.ts';
import { REPO } from '../driver/server.ts';
import type { Scenario } from '../scenario.ts';
import { runTool } from '../../support/cli.ts';
import { DEV_ONLY_REQUESTS, rawRequest } from '../../support/dev-only-paths.ts';

function readShell(): unknown {
  const isolation = document.querySelector('[data-testid=isolation]')?.textContent ?? null;
  if (isolation === null) return null;
  return { isolation, build: document.querySelector('[data-testid=build-id]')?.textContent ?? null };
}

function pageFacts(): unknown {
  return { crossOriginIsolated: window.crossOriginIsolated, surface: '__noisyTest' in window };
}

/** Each request from the page, with the status it got. */
async function pageStatuses(requests: readonly { method: string; path: string }[]): Promise<unknown> {
  const out = [];
  for (const r of requests) {
    const init: RequestInit = { method: r.method, cache: 'no-store' };
    if (r.method === 'POST') {
      init.headers = { 'content-type': 'application/json' };
      init.body = '{"probe":true}';
    }
    const res = await fetch(`${location.origin}${r.path}`, init);
    out.push({ method: r.method, path: r.path, status: res.status });
  }
  return out;
}

/** A Range request for the tail of a file from the page: its status, Content-Range, length, and SHA-256. */
async function rangeFromPage(url: string, start: number): Promise<unknown> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-` }, cache: 'no-store' });
  const body = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return {
    status: res.status,
    contentRange: res.headers.get('content-range'),
    bytes: body.length,
    sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

const Shell = z.object({ isolation: z.string(), build: z.string().nullable() });
const Facts = z.object({ crossOriginIsolated: z.boolean(), surface: z.boolean() });
const Statuses = z.array(z.object({ method: z.string(), path: z.string(), status: z.number() }));
const RangeReply = z.object({ status: z.number(), contentRange: z.string().nullable(), bytes: z.number(), sha256: z.string() });
const HeaderLine = z.object({ path: z.string(), status: z.number(), ok: z.boolean(), mismatches: z.array(z.unknown()) });

/** The lock's smallest model file, so the header check, which reads each file it checks whole, moves few bytes over the tailnet. */
async function smallestModel(): Promise<{ served: string; bytes: number }> {
  const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  const files = Object.values(parsed.value.lock.models).flatMap((m) => m.files).sort((a, b) => a.bytes - b.bytes);
  const first = files[0];
  if (first === undefined) throw new Error('models.lock.json lists no model file');
  return first;
}

/** The named routes a page asks for; the full list of spellings goes raw from node. */
const FROM_PAGE = [
  { method: 'GET', path: '/dev/fault' },
  { method: 'GET', path: '/dev/checklist.html' },
  { method: 'GET', path: '/dev/csp-report' },
  { method: 'GET', path: '/dev/requests' },
  { method: 'GET', path: '/api/log' },
  { method: 'POST', path: '/api/log' },
  { method: 'POST', path: '/dev/csp-report' },
] as const;

export const scenarios: readonly Scenario[] = [
  {
    id: 'production.shell',
    title: 'the production server\'s shell loads cross-origin isolated, with the build id and no __noisyTest',
    target: 'production',
    covers: ['X11', 'C6'],
    async run(t) {
      await t.page.goto('/');
      const shell = await t.page.waitFor('the shell to render', Shell, readShell);
      const facts = await t.page.evaluate(Facts, pageFacts);
      t.equal('crossOriginIsolated is true', facts.crossOriginIsolated, true);
      t.equal('the page has no __noisyTest', facts.surface, false);
      t.equal('the shell reads isolated: yes', shell.isolation, 'isolated: yes');
      t.equal('the shell shows the served production build id', shell.build, `build ${t.build.buildId}`);
      t.equal('the served build is a production build', t.build.mode, 'production');
      await t.page.screenshot('shell');
    },
  },
  {
    id: 'production.headers',
    title: 'tools/check-headers.mjs passes against the production server: /, index.html, the hashed scripts, the runtime\'s .wasm, and a model',
    target: 'production',
    covers: ['X11', 'R8'],
    async run(t) {
      const model = await smallestModel();
      const paths = [...Object.values(t.build.workers), ...t.build.ort.files.map((f) => `${t.build.ort.dir}${f}`), model.served];
      const result = await runTool('tools/check-headers.mjs', [t.baseUrl, ...paths.flatMap((p) => ['--path', p])]);
      const lines = result.stdout.split('\n').filter(Boolean).map((line) => HeaderLine.parse(JSON.parse(line)));
      const checked = lines.map((l) => l.path);
      t.ok('the checked paths include /, /index.html, the app script, a .wasm, and a model',
        ['/', '/index.html', t.build.app, model.served].every((p) => checked.includes(p)) && checked.some((p) => p.endsWith('.wasm')), { checked });
      t.equal('check-headers exits 0', result.code, 0, { stderr: result.stderr });
      t.equal('every checked path is a 200 with the contract\'s headers', lines.filter((l) => !l.ok), [], { checked });
      const index = await rawRequest(t.baseUrl, { method: 'GET', path: '/' });
      t.equal('no report-only CSP, which only dev mode adds', index.headers['content-security-policy-report-only'], undefined);
    },
  },
  {
    id: 'production.dev-routes',
    title: 'every spelling of /dev and /api, the fault state, checklist, CSP reports, request log, and sink among them, answers 404 to GET, HEAD, and POST',
    target: 'production',
    covers: ['X11'],
    async run(t) {
      t.expectMessage({ because: 'the page asks for dev-only routes, which answer 404', channel: 'log', source: 'network', level: 'error', url: /\/(dev|api)\//i });
      await t.page.goto('/');
      const fromPage = await t.page.evaluate(Statuses, pageStatuses, FROM_PAGE);
      t.equal('from the page, every dev-only route answers 404', fromPage.filter((r) => r.status !== 404), [], { fromPage });
      const raw = [];
      for (const request of DEV_ONLY_REQUESTS) {
        const res = await rawRequest(t.baseUrl, request);
        raw.push({ ...request, status: res.status });
      }
      t.equal('sent raw, every spelling answers 404', raw.filter((r) => r.status !== 404), [], { sent: raw.length });
    },
  },
  {
    id: 'production.range',
    title: 'a model answers Range: bytes=N- with 206 and the remaining bytes',
    target: 'production',
    covers: ['X11'],
    async run(t) {
      await t.page.goto('/');
      const model = await smallestModel();
      const start = Math.max(0, model.bytes - 4096);
      const reply = await t.page.evaluate(RangeReply, rangeFromPage, model.served, start);
      const tail = Buffer.alloc(model.bytes - start);
      const file = await open(path.join(REPO, 'models', model.served.slice('/models/'.length)));
      try {
        await file.read(tail, 0, tail.length, start);
      } finally {
        await file.close();
      }
      t.equal('the answer is 206 with the range', { status: reply.status, contentRange: reply.contentRange }, { status: 206, contentRange: `bytes ${start}-${model.bytes - 1}/${model.bytes}` });
      t.equal('the body is the file\'s remaining bytes', { bytes: reply.bytes, sha256: reply.sha256 }, { bytes: tail.length, sha256: createHash('sha256').update(tail).digest('hex') });
    },
  },
];
