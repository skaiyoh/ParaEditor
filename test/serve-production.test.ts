// tools/serve.mjs in production mode, over HTTP: the header contract and
// nothing dev mode adds, Range on /models/, and 404 for every spelling of
// /dev and /api. The production root here is a throwaway build with a real
// dev/ and api/ planted in it, and symlinks into them, so the guard is tested
// as the only defense; a dev-mode server on the same root serves the planted
// files, which shows they are there to be refused.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import { REPO, runTool, startServer, tempDir, writeTree, type Server } from './support/cli.ts';
import { DEV_ONLY_REQUESTS, rawRequest } from './support/dev-only-paths.ts';

const MODEL = randomBytes(10_000);
const PLANTED = 'planted-dev-page';
/** The paths that reach the planted files, each spelled as a request could spell it. */
const PLANTED_PATHS = [
  '/dev/planted.html',
  '/DEV/planted.html',
  '//dev/planted.html',
  '/%2Fdev/planted.html',
  '/%64ev/planted.html',
  '/api/log',
  '/API/LOG',
  '/via-symlink.html',
  '/devlink/planted.html',
  '/Devlink/planted.html',
];

/** Headers a response may carry beyond the contract's: Node's own framing and the Range headers. */
const TRANSPORT = new Set(['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-ranges', 'content-range']);

const Contract = z.object({
  all: z.record(z.string(), z.string()),
  byPath: z.array(z.object({ path: z.string(), headers: z.record(z.string(), z.string()) })),
  errors: z.record(z.string(), z.string()),
});

let scratch = '';
let root = '';
let production: Server;
let dev: Server;

before(async () => {
  scratch = await tempDir('serve-production');
  root = path.join(scratch, 'root');
  const run = await runTool('tools/build.mjs', ['--mode', 'production', '--outdir', root]);
  assert.equal(run.code, 0, run.stderr);
  await writeTree(scratch, {
    'models/depth.onnx': MODEL,
    'root/dev/planted.html': PLANTED,
    // Separate fixtures on Linux; the same file on case-insensitive macOS.
    'root/DEV/planted.html': PLANTED,
    'root/api/log': PLANTED,
  });
  await symlink('DEV/planted.html', path.join(root, 'via-symlink.html'));
  await symlink('dev', path.join(root, 'devlink'));
  const common = ['--root', root, '--models', path.join(scratch, 'models')];
  production = await startServer(['--mode', 'production', ...common]);
  dev = await startServer(['--mode', 'dev', ...common, '--results', path.join(scratch, 'results'), '--request-log', path.join(scratch, 'requests.jsonl')]);
});

after(async () => {
  await production?.stop();
  await dev?.stop();
  await rm(scratch, { recursive: true, force: true });
});

test('responses for /, the hashed app script, a .wasm, a model, and index.html carry what headers.json requires', async () => {
  const build = z.object({ ort: z.object({ dir: z.string(), files: z.array(z.string()) }) }).parse(JSON.parse(await readFile(path.join(root, 'build.json'), 'utf8')));
  const wasm = build.ort.files.find((f) => f.endsWith('.wasm'));
  assert.ok(wasm !== undefined);
  const run = await runTool('tools/check-headers.mjs', [production.url, '--path', `${build.ort.dir}${wasm}`, '--path', '/models/depth.onnx']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const checked = run.stdout.trim().split('\n').map((l) => z.object({ path: z.string() }).parse(JSON.parse(l)).path);
  for (const p of ['/', '/index.html', `${build.ort.dir}${wasm}`, '/models/depth.onnx']) assert.ok(checked.includes(p), p);
  assert.ok(checked.some((p) => /^\/assets\/main-[A-Z0-9]{8}\.js$/.test(p)), 'the hashed app script');
});

test('no response carries a header beyond the contract\'s and the transport\'s: no report-only CSP and no no-store override', async () => {
  const contract = Contract.parse(JSON.parse(await readFile(path.join(REPO, 'headers.json'), 'utf8')));
  const allowed = new Set([...Object.keys(contract.all), ...contract.byPath.flatMap((r) => Object.keys(r.headers)), ...Object.keys(contract.errors), 'Content-Type'].map((h) => h.toLowerCase()));
  for (const target of ['/', '/index.html', '/models/depth.onnx', '/manifest.webmanifest', '/missing.txt', '/dev/fault']) {
    const res = await rawRequest(production.url, { method: 'GET', path: target });
    const extra = Object.keys(res.headers).filter((h) => !allowed.has(h) && !TRANSPORT.has(h));
    assert.deepEqual(extra, [], target);
  }
  const model = await rawRequest(production.url, { method: 'GET', path: '/models/depth.onnx' });
  assert.equal(model.headers['cache-control'], contract.byPath.find((r) => r.path === '/models/*')?.headers['Cache-Control']);
});

test('Range: bytes=N- on a model answers 206 with the remaining bytes', async () => {
  const res = await rawRequest(production.url, { method: 'GET', path: '/models/depth.onnx' }, { Range: 'bytes=4000-' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], 'bytes 4000-9999/10000');
  assert.ok(res.body.equals(MODEL.subarray(4000)));
});

test('every spelling of /dev and /api answers 404 to GET, HEAD, and POST', async () => {
  const wrong = [];
  for (const request of DEV_ONLY_REQUESTS) {
    const res = await rawRequest(production.url, request);
    if (res.status !== 404) wrong.push({ ...request, status: res.status });
  }
  assert.deepEqual(wrong, []);
});

test('files planted under dev/ and api/ in the production root answer 404 however they are reached', async () => {
  for (const target of PLANTED_PATHS) {
    const res = await rawRequest(production.url, { method: 'GET', path: target });
    assert.equal(res.status, 404, target);
    assert.ok(!res.body.toString().includes(PLANTED), target);
  }
});

test('the dev-mode server on the same root serves the planted files, so the 404s above are the guard\'s', async () => {
  for (const target of ['/dev/planted.html', '/DEV/planted.html', '/via-symlink.html', '/devlink/planted.html']) {
    const res = await rawRequest(dev.url, { method: 'GET', path: target });
    assert.equal(res.status, 200, target);
    assert.equal(res.body.toString(), PLANTED, target);
  }
});

test('a file under dev/ or api/ of the production root answers 404 when another mount reaches it', async () => {
  // /vendor/ort/ through a symlink outside the root into its dev/, and /models/ pointed at its api/.
  const ortLink = path.join(scratch, 'ort-into-dev');
  await symlink(path.join(root, 'dev'), ortLink);
  const mounts = ['--root', root, '--vendor-ort', ortLink, '--models', path.join(root, 'api')];
  const prod = await startServer(['--mode', 'production', ...mounts]);
  const devMode = await startServer(['--mode', 'dev', ...mounts, '--results', path.join(scratch, 'results-2'), '--request-log', path.join(scratch, 'requests-2.jsonl')]);
  try {
    for (const target of ['/vendor/ort/planted.html', '/models/log']) {
      const refused = await rawRequest(prod.url, { method: 'GET', path: target });
      assert.equal(refused.status, 404, target);
      assert.ok(!refused.body.toString().includes(PLANTED), target);
      const served = await rawRequest(devMode.url, { method: 'GET', path: target });
      assert.equal(served.status, 200, `dev mode serves ${target}`);
      assert.equal(served.body.toString(), PLANTED, `dev mode serves ${target}`);
    }
  } finally {
    await prod.stop();
    await devMode.stop();
  }
});

test('production mode refuses the dev-only flags', async () => {
  for (const flag of ['--results', '--request-log']) {
    const run = await runTool('tools/serve.mjs', ['--mode', 'production', '--port', '0', flag, path.join(scratch, 'never')]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /^serve: --results and --request-log place the dev surfaces' files, and production mode has no dev surfaces\.\n$/);
  }
});
