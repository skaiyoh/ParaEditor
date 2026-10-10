// tools/serve.mjs in dev mode, end to end over HTTP: the header contract
// (through tools/check-headers.mjs), Range on /models/
// and the request log, every fault kind on both fault prefixes and the no-store
// header on what they alter, the results sink, the report-only CSP and its
// report endpoint, the build's vendored runtime, path traversal, and the
// synth master route.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import { synthScene } from './fixtures/synth/synth.ts';
import { REPO, runTool, startServer, tempDir, writeTree, type Server } from './support/cli.ts';

const MODEL = randomBytes(10_000);
const WASM = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), randomBytes(4_000)]);
const SECRET = 'outside-every-root-sentinel';
const FAULT_PATHS = { '/models/': '/models/depth.onnx', '/vendor/ort/': '/vendor/ort/ort.wasm' } as const;
const BODIES: Readonly<Record<string, Buffer>> = { '/models/depth.onnx': MODEL, '/vendor/ort/ort.wasm': WASM };

const FaultState = z.object({
  isolation: z.boolean(),
  rules: z.array(z.object({ spec: z.string(), hits: z.number(), remaining: z.number().nullable() })),
});
const LogRow = z.object({
  seq: z.number(),
  scheme: z.enum(['http', 'https']),
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string(), z.string()),
  status: z.number(),
  fault: z.string().nullable(),
});
const Capture = z.object({ ok: z.literal(true), path: z.string(), file: z.string(), bytes: z.number(), sha256: z.string() });

let scratch = '';
let server: Server;
const url = (p: string) => new URL(p, server.url);

before(async () => {
  scratch = await tempDir('serve');
  const run = await runTool('tools/build.mjs', ['--mode', 'dev', '--outdir', path.join(scratch, 'root')]);
  assert.equal(run.code, 0, run.stderr);
  await writeTree(scratch, {
    'models/depth.onnx': MODEL,
    'models/empty.onnx': '',
    'ort/ort.wasm': WASM,
    'secret.txt': SECRET,
  });
  await symlink(path.join(scratch, 'secret.txt'), path.join(scratch, 'models', 'escape.onnx'));
  server = await startServer([
    '--mode', 'dev',
    '--root', path.join(scratch, 'root'),
    '--models', path.join(scratch, 'models'),
    '--vendor-ort', path.join(scratch, 'ort'),
    '--results', path.join(scratch, 'results'),
    '--request-log', path.join(scratch, 'requests.jsonl'),
  ]);
});

after(async () => {
  await server?.stop();
  await rm(scratch, { recursive: true, force: true });
});

async function setFaults(rules: readonly string[]): Promise<z.infer<typeof FaultState>> {
  const res = await fetch(url('/dev/fault'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules }) });
  assert.equal(res.status, 200, await res.clone().text());
  return FaultState.parse(await res.json());
}

async function clearFaults(): Promise<void> {
  const res = await fetch(url('/dev/fault'), { method: 'DELETE' });
  assert.deepEqual(FaultState.parse(await res.json()), { isolation: true, rules: [] });
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

/** A raw request, so the path reaches the server exactly as written (fetch would normalize it). */
function rawGet(rawPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url('/'), { path: rawPath }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('responses for /, the hashed app script, a .wasm, a model, and index.html carry what headers.json requires', async () => {
  const run = await runTool('tools/check-headers.mjs', [server.url, '--path', '/vendor/ort/ort.wasm', '--path', '/models/depth.onnx']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const rows = run.stdout.trim().split('\n').map((l) => z.object({ path: z.string(), ok: z.boolean() }).parse(JSON.parse(l)));
  const checked = rows.map((r) => r.path);
  for (const p of ['/', '/index.html', '/vendor/ort/ort.wasm', '/models/depth.onnx']) assert.ok(checked.includes(p), p);
  assert.ok(checked.some((p) => /^\/assets\/main-[A-Z0-9]{8}\.js$/.test(p)), 'the hashed app script');
  assert.ok(rows.every((r) => r.ok));
});

test('Range: bytes=N- on a model answers 206 with the remaining bytes, and the request log shows the header', async () => {
  const res = await fetch(url('/models/depth.onnx'), { headers: { Range: 'bytes=4000-' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 4000-9999/10000');
  assert.ok((await bytes(res)).equals(MODEL.subarray(4000)));

  const log = z.array(LogRow).parse(await (await fetch(url('/dev/requests'))).json());
  const row = log.findLast((r) => r.path === '/models/depth.onnx');
  assert.equal(row?.headers['range'], 'bytes=4000-');
  assert.equal(row?.status, 206);
  assert.equal(row?.scheme, 'http');

  const beyond = await fetch(url('/models/depth.onnx'), { headers: { Range: 'bytes=10000-' } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), 'bytes */10000');

  for (const range of ['bytes=0-', 'bytes=-5']) {
    const empty = await fetch(url('/models/empty.onnx'), { headers: { Range: range } });
    assert.equal(empty.status, 416, range);
    assert.equal(empty.headers.get('content-range'), 'bytes */0', range);
  }
});

test('an error response carries the contract\'s error headers, never a path rule\'s immutable caching', async () => {
  const contract = z
    .object({ all: z.record(z.string(), z.string()), errors: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')));
  for (const [target, status] of [['/assets/missing-AAAAAAAA.js', 404], ['/assets/%E0.js', 400], ['/models/missing.onnx', 404]] as const) {
    const res = await rawGet(target);
    assert.equal(res.status, status, target);
    for (const [name, value] of Object.entries({ ...contract.all, ...contract.errors })) {
      assert.equal(res.headers[name.toLowerCase()], value, `${target} ${name}`);
    }
  }
});

for (const [prefix, file] of Object.entries(FAULT_PATHS)) {
  const body = BODIES[file] ?? Buffer.alloc(0);

  test(`http500 on ${prefix} fails the request`, async () => {
    await setFaults([`path:${prefix}:http500`]);
    assert.equal((await fetch(url(file))).status, 500);
    await clearFaults();
    assert.equal((await fetch(url(file))).status, 200);
  });

  test(`corrupt on ${prefix} sends bytes of the right length that differ`, async () => {
    await setFaults([`path:${prefix}:corrupt`]);
    const res = await fetch(url(file));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a faulted body is never cached');
    const got = await bytes(res);
    assert.equal(got.length, body.length);
    assert.ok(got.every((b, i) => b === ((body[i] ?? 0) ^ 0xff)));
    await clearFaults();
  });

  test(`truncate on ${prefix} drops mid-transfer after declaring the full length, and the retry's Range resumes with 206`, async () => {
    const state = await setFaults([`path:${prefix}:truncate=1000:times=1`]);
    assert.equal(state.rules[0]?.remaining, 1);
    const res = await fetch(url(file));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-length'), String(body.length));
    await assert.rejects(res.arrayBuffer());
    const resumed = await fetch(url(file), { headers: { Range: 'bytes=1000-' } });
    assert.equal(resumed.status, 206);
    assert.ok((await bytes(resumed)).equals(body.subarray(1000)));
    const after = FaultState.parse(await (await fetch(url('/dev/fault'))).json());
    assert.deepEqual(after.rules, [{ spec: `path:${prefix}:truncate=1000:times=1`, hits: 1, remaining: 0 }]);
    await clearFaults();
  });

  test(`stall on ${prefix} sends headers and then nothing`, async () => {
    await setFaults([`path:${prefix}:stall`]);
    const abort = new AbortController();
    const res = await fetch(url(file), { signal: abort.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const outcome = await Promise.race([res.arrayBuffer().then(() => 'body'), new Promise((r) => setTimeout(r, 400, 'stalled'))]);
    assert.equal(outcome, 'stalled');
    abort.abort();
    await clearFaults();
  });

  test(`slow on ${prefix} delays the response and then sends it whole`, async () => {
    await setFaults([`path:${prefix}:slow=300`]);
    const t0 = performance.now();
    const res = await fetch(url(file));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const got = await bytes(res);
    assert.ok(performance.now() - t0 >= 290);
    assert.ok(got.equals(body));
    await clearFaults();
  });
}

test('a count-limited fault stops after its count, only matching paths count, and the request log names the fault', async () => {
  await setFaults(['path:/models/depth:http500:times=2']);
  assert.equal((await fetch(url('/vendor/ort/ort.wasm'))).status, 200);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(url('/models/depth.onnx'))).status);
  assert.deepEqual(statuses, [500, 500, 200]);
  const log = z.array(LogRow).parse(await (await fetch(url('/dev/requests'))).json());
  const faultsLogged = log.filter((r) => r.path === '/models/depth.onnx').slice(-3).map((r) => r.fault);
  assert.deepEqual(faultsLogged, ['path:/models/depth:http500:times=2', 'path:/models/depth:http500:times=2', null]);
  await clearFaults();
});

test('no-isolation drops COOP and COEP from every response, and the header check then fails', async () => {
  await setFaults(['no-isolation']);
  for (const p of ['/', '/models/depth.onnx', '/dev/fault']) {
    const res = await fetch(url(p));
    await res.arrayBuffer();
    assert.equal(res.headers.get('cross-origin-opener-policy'), null, p);
    assert.equal(res.headers.get('cross-origin-embedder-policy'), null, p);
    assert.ok(res.headers.get('content-security-policy'), p);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${p}: a response without isolation headers is never cached`);
  }
  const run = await runTool('tools/check-headers.mjs', [server.url]);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Cross-Origin-Opener-Policy/);
  await clearFaults();
  const res = await fetch(url('/'));
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
});

test('an invalid fault rule is refused and leaves the state unchanged', async () => {
  await setFaults(['path:/models/:stall']);
  const invalid = [
    'path:/assets/:http500',
    'path:/models/:truncate=0',
    'path:/models/:explode',
    'path:/models/:stall:times=0',
    'isolation-off',
    'path:/models/:truncate=5=6',
    'path:/models/:slow=10=abc',
    'path:/models/:http500=1',
    'path:/models/:slow=3000000000',
  ];
  for (const rule of invalid) {
    const res = await fetch(url('/dev/fault'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: [rule] }) });
    assert.equal(res.status, 400, rule);
  }
  const state = FaultState.parse(await (await fetch(url('/dev/fault'))).json());
  assert.deepEqual(state.rules.map((r) => r.spec), ['path:/models/:stall']);
  await clearFaults();
});

test('the results sink stores a binary capture byte for byte and appends a JSON row', async () => {
  const png = randomBytes(50_000);
  const res = await fetch(url('/api/log?name=../evil%20name.png'), { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(res.status, 200);
  const capture = Capture.parse(await res.json());
  const sha = createHash('sha256').update(png).digest('hex');
  assert.equal(capture.sha256, sha);
  assert.equal(capture.bytes, png.length);
  assert.match(capture.path, /^captures\/[^/]+-_evil_name\.png$/);
  assert.equal(capture.file, path.join(scratch, 'results', capture.path));
  assert.equal(createHash('sha256').update(await readFile(capture.file)).digest('hex'), sha);

  const row = { kind: 'probe', value: 42, nested: { ok: true } };
  const posted = await fetch(url('/api/log'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(row) });
  assert.equal(posted.status, 200);
  const lines = (await readFile(path.join(scratch, 'results', 'log.jsonl'), 'utf8')).trim().split('\n');
  const last = z.object({ at: z.string(), row: z.unknown() }).parse(JSON.parse(lines.at(-1) ?? 'null'));
  assert.deepEqual(last.row, row);
  assert.ok(lines.some((l) => l.includes(sha)), 'the capture is recorded in the row log too');

  const big = await fetch(url('/api/log'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: `"${'x'.repeat(1024 * 1024)}"` });
  assert.equal(big.status, 413);
});

test('the sink reads the media type case-insensitively and takes only application/json as a row', async () => {
  const row = { kind: 'cased' };
  const cased = await fetch(url('/api/log'), { method: 'POST', headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: JSON.stringify(row) });
  assert.deepEqual(await cased.json(), { ok: true });
  const lines = (await readFile(path.join(scratch, 'results', 'log.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1) ?? 'null').row, row);

  const jsonl = Buffer.from('{"a":1}\n{"a":2}\n');
  const capture = Capture.parse(await (await fetch(url('/api/log?name=rows.jsonl'), { method: 'POST', headers: { 'content-type': 'application/jsonl' }, body: jsonl })).json());
  assert.ok((await readFile(capture.file)).equals(jsonl));
});

test('the server refuses traversal and never serves a file outside its roots', async () => {
  const attempts = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/models/../../secret.txt',
    '/models/%2e%2e/%2e%2e/secret.txt',
    '/vendor/ort/..%2f..%2fsecret.txt',
    `/${path.join(scratch, 'secret.txt')}`,
    `/${encodeURIComponent(path.join(scratch, 'secret.txt'))}`,
    '/models/escape.onnx',
    '/models/%00depth.onnx',
  ];
  for (const attempt of attempts) {
    const res = await rawGet(attempt);
    assert.ok(res.status === 400 || res.status === 404, `${attempt} answered ${res.status}`);
    assert.ok(!res.body.includes(SECRET), attempt);
  }
  // Absolute-form request targets are refused outright.
  assert.equal((await rawGet(`http://evil.example${path.join(scratch, 'secret.txt')}`)).status, 400);
});

test('the server keeps serving and logging when the request log\'s directory is removed under it', async () => {
  const dir = path.join(scratch, 'second');
  const logFile = path.join(dir, 'logs', 'requests.jsonl');
  const second = await startServer([
    '--mode', 'dev',
    '--root', path.join(scratch, 'root'),
    '--models', path.join(scratch, 'models'),
    '--vendor-ort', path.join(scratch, 'ort'),
    '--results', path.join(dir, 'results'),
    '--request-log', logFile,
  ]);
  try {
    assert.equal((await fetch(new URL('/models/depth.onnx', second.url))).status, 200);
    await rm(path.join(dir, 'logs'), { recursive: true });
    const res = await fetch(new URL('/models/depth.onnx', second.url));
    assert.equal(res.status, 200);
    assert.ok((await bytes(res)).equals(MODEL));
    const rows = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => LogRow.parse(JSON.parse(l)));
    assert.deepEqual(rows.map((r) => [r.path, r.status]), [['/models/depth.onnx', 200]]);
  } finally {
    await second.stop();
  }
});

test('the server refuses an unknown mode and an unwritable request log at startup, with one sentence', async () => {
  const logDir = path.join(scratch, 'log-is-a-dir');
  await mkdir(logDir, { recursive: true });
  const cases = [
    ['--mode', 'toString'],
    ['--mode', 'dev', '--results', path.join(scratch, 'results'), '--request-log', logDir],
  ];
  for (const args of cases) {
    const run = await runTool('tools/serve.mjs', ['--port', '0', ...args]);
    assert.equal(run.code, 1, args.join(' '));
    assert.match(run.stderr, /^serve: /, args.join(' '));
    assert.equal(run.stdout, '', args.join(' '));
  }
});

test('check-headers tells an unreachable server (exit 3) and a malformed --path (exit 2) from a header mismatch', async () => {
  const closed = await new Promise<number>((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
  const unreachable = await runTool('tools/check-headers.mjs', [`http://127.0.0.1:${closed}/`]);
  assert.equal(unreachable.code, 3, unreachable.stderr);
  assert.equal(unreachable.stderr.trim().split('\n').length, 1, unreachable.stderr);
  const malformed = await runTool('tools/check-headers.mjs', [server.url, '--path', '/models/%zz']);
  assert.equal(malformed.code, 2, malformed.stderr);
});

test('an unfaulted runtime file is cached as immutable, a model file never by the HTTP cache, and the report-only CSP copies the contract\'s', async () => {
  const contract = z
    .object({ all: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')));
  const csp = contract.all['Content-Security-Policy'];
  assert.ok(csp !== undefined);
  for (const p of ['/models/depth.onnx', '/vendor/ort/ort.wasm', '/', '/dev/fault']) {
    const res = await fetch(url(p));
    await res.arrayBuffer();
    if (p.startsWith('/vendor/ort/')) assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', p);
    // A model file the browser has not verified is never kept, so a bad one on
    // disk is not served again from the HTTP cache once the disk is fixed.
    if (p.startsWith('/models/')) assert.equal(res.headers.get('cache-control'), 'no-store', p);
    assert.equal(res.headers.get('content-security-policy'), csp, `${p}: the enforced CSP is exactly the contract's`);
    assert.equal(res.headers.get('content-security-policy-report-only'), `${csp}; report-uri /dev/csp-report`, p);
  }
});

test('the CSP report endpoint stores each report it is sent, and returns them', async () => {
  const report = { 'csp-report': { 'document-uri': 'http://127.0.0.1/dev/threads.html', 'effective-directive': 'worker-src', 'blocked-uri': 'blob' } };
  const res = await fetch(url('/dev/csp-report'), { method: 'POST', headers: { 'content-type': 'application/csp-report', 'user-agent': 'probe-agent' }, body: JSON.stringify(report) });
  assert.equal(res.status, 200);
  const Stored = z.object({ at: z.string(), contentType: z.string().nullable(), userAgent: z.string().nullable(), report: z.unknown() });
  const lines = (await readFile(path.join(scratch, 'results', 'csp-reports.jsonl'), 'utf8')).trim().split('\n');
  const last = Stored.parse(JSON.parse(lines.at(-1) ?? 'null'));
  assert.deepEqual([last.contentType, last.userAgent, last.report], ['application/csp-report', 'probe-agent', report]);
  const listed = z.array(Stored).parse(await (await fetch(url('/dev/csp-report'))).json());
  assert.deepEqual(listed.at(-1), last);
  const notJson = await fetch(url('/dev/csp-report'), { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: 'nope' });
  assert.equal(notJson.status, 400);
});

test('by default /vendor/ort/ serves the build\'s vendored runtime, and its .wasm and a hashed model pass the header check', async () => {
  const meta = z
    .object({ ort: z.object({ dir: z.string(), files: z.array(z.string()) }) })
    .parse(JSON.parse(await readFile(path.join(scratch, 'root', 'build.json'), 'utf8')));
  const wasm = meta.ort.files.find((f) => f.endsWith('.wasm'));
  assert.ok(wasm !== undefined);
  const model = '/models/depth-0123abcd.onnx';
  await writeTree(scratch, { [`hashed-models${model.slice('/models'.length)}`]: MODEL });
  const third = await startServer([
    '--mode', 'dev',
    '--root', path.join(scratch, 'root'),
    '--models', path.join(scratch, 'hashed-models'),
    '--results', path.join(scratch, 'third-results'),
    '--request-log', path.join(scratch, 'third-results', 'requests.jsonl'),
  ]);
  try {
    const wasmPath = `${meta.ort.dir}${wasm}`;
    const served = await fetch(new URL(wasmPath, third.url));
    assert.ok((await bytes(served)).equals(await readFile(path.join(scratch, 'root', wasmPath.slice(1)))));
    const run = await runTool('tools/check-headers.mjs', [third.url, '--path', wasmPath, '--path', model]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const checked = run.stdout.trim().split('\n').map((l) => z.object({ path: z.string(), ok: z.boolean() }).parse(JSON.parse(l)));
    assert.ok(checked.some((r) => r.path === wasmPath && r.ok));
    assert.ok(checked.some((r) => r.path === model && r.ok));
  } finally {
    await third.stop();
  }
});

/** The SHA-256 test/synth.test.ts pins for synth's 2048 x 1536 master as RGBA bytes. */
const SYNTH_MASTER_SHA256 = '5da94341047ce46637c583ee480520a910dd28cb9391400397c3ce172b31d1bf';

test('/dev/synth/master answers the synth fixture\'s master as raw RGBA bytes, uncached, at even sizes from 2 to 4096', async () => {
  const res = await fetch(url('/dev/synth/master?width=2048&height=1536'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-length'), String(2048 * 1536 * 4));
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  const body = await bytes(res);
  assert.equal(createHash('sha256').update(body).digest('hex'), SYNTH_MASTER_SHA256);

  for (const [width, height] of [[2, 2], [4096, 2], [2, 4096], [1024, 768], [2048, 512], [6, 4], [2048, 2048]] as const) {
    const sized = await fetch(url(`/dev/synth/master?height=${height}&width=${width}`));
    assert.equal(sized.status, 200, `${width} x ${height}`);
    const rgba = synthScene({ width, height }).masterRgba();
    assert.ok((await bytes(sized)).equals(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)), `${width} x ${height}`);
  }
  // Seven other sizes were asked for since, more than the four the route holds, so this paints 2048 x 1536 again.
  const again = await bytes(await fetch(url('/dev/synth/master?width=2048&height=1536')));
  assert.equal(createHash('sha256').update(again).digest('hex'), SYNTH_MASTER_SHA256);

  const headOnly = await fetch(url('/dev/synth/master?width=6&height=4'), { method: 'HEAD' });
  assert.equal(headOnly.status, 200);
  assert.equal(headOnly.headers.get('content-length'), String(6 * 4 * 4));
  assert.equal((await bytes(headOnly)).length, 0);

  const log = z.array(LogRow).parse(await (await fetch(url('/dev/requests'))).json());
  assert.deepEqual(log.findLast((r) => r.path.startsWith('/dev/synth/master'))?.status, 200);
});

test('/dev/synth/master answers 400 to a width or height that is not one even whole number from 2 to 4096, and 405 to any method but GET and HEAD', async () => {
  const bad = [
    'width=2047&height=1536', 'width=2048&height=1535',
    'width=0&height=1536', 'width=2048&height=0',
    'width=-2&height=1536', 'width=2048&height=-2048',
    'width=2048.5&height=1536', 'width=2048.0&height=1536', 'width=2048&height=1e3',
    'width=abc&height=1536', 'width=2048&height=', 'width=0x800&height=1536', 'width=+2048&height=1536', 'width=02048&height=1536', 'width=%202048&height=1536',
    'height=1536', 'width=2048', '',
    'width=4098&height=1536', 'width=2048&height=8192', 'width=99999999999999999999&height=2',
    'width=2048&width=1024&height=1536',
  ];
  for (const query of bad) {
    const res = await fetch(url(`/dev/synth/master?${query}`));
    assert.equal(res.status, 400, query);
    assert.match(await res.text(), /even whole number from 2 to 4096/, query);
    assert.equal(res.headers.get('cache-control'), 'no-store', query);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await fetch(url('/dev/synth/master?width=2&height=2'), { method });
    assert.equal(res.status, 405, method);
  }
});

test('--host and --tls serve the unchanged routes and headers over CA-verified HTTPS in both modes', async (t) => {
  const tlsDir = path.join(scratch, 'tls');
  const cert = await runTool('tools/make-cert.mjs', ['--outdir', tlsDir]);
  assert.equal(cert.code, 0, cert.stdout + cert.stderr);
  const ca = await readFile(path.join(tlsDir, 'ca.pem'));
  const contract = z.object({ all: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(path.join(REPO, 'headers.json'), 'utf8')));
  for (const mode of ['dev', 'production']) await t.test(mode, async (t) => {
    const child = spawn(process.execPath, [path.join(REPO, 'tools/serve.mjs'),
      '--mode', mode, '--host', '0.0.0.0', '--port', '0', '--tls', tlsDir,
      '--root', path.join(scratch, 'root'), '--models', path.join(scratch, 'models'),
      ...(mode === 'dev' ? ['--results', path.join(scratch, 'tls-results'), '--request-log', path.join(scratch, 'tls-requests.jsonl')] : []),
    ], { cwd: REPO });
    let output = '';
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    t.after(async () => { child.kill('SIGTERM'); await exited; });
    const base = await new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTPS startup timed out: ' + output)), 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /https:\/\/0\.0\.0\.0:(\d+)\//.exec(output);
        if (match?.[1] !== undefined) { clearTimeout(timer); resolve(new URL('https://127.0.0.1:' + match[1] + '/')); }
      });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error('HTTPS exited ' + code + ': ' + output)); });
    });
    const get = (pathname: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
      new Promise((resolve, reject) => {
        const req = https.get(new URL(pathname, base), { ca }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
      });
    const index = await get('/');
    assert.equal(index.status, 200);
    assert.match(index.body.toString(), /<html/);
    for (const [name, value] of Object.entries(contract.all)) assert.equal(index.headers[name.toLowerCase()], value, name);
    const css = await get('/assets-static/app.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css/);
    assert.ok(css.body.length > 0);
    const model = await get('/models/depth.onnx');
    assert.equal(model.status, 200);
    assert.ok(model.body.equals(MODEL));
    const dev = await get('/dev/requests');
    assert.equal(dev.status, mode === 'dev' ? 200 : 404);
    if (mode === 'dev') {
      const rows = z.array(LogRow).parse(JSON.parse(dev.body.toString()));
      assert.ok(rows.some((row) => row.path === '/' && row.scheme === 'https'));
      assert.ok(rows.every((row) => row.scheme === 'https'));
    }
  });
});

test('--tls fails closed when its certificate files are missing', async () => {
  const run = await runTool('tools/serve.mjs', ['--mode', 'production', '--tls', path.join(scratch, 'missing-tls')]);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^serve: cannot start server:.*server\.pem/m);
  assert.doesNotMatch(run.stdout, /mode on http/);
});
