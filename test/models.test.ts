// models.lock.json and tools/fetch-models.mjs: the lock's shape, read with
// the schema the browser parses it with (src/analysis/lock.ts), its ModelId
// rule, the operations' files, the lock hash, the model caches' names and
// keys, the working tree's models/
// against the lock (it fails, never skips, when the files are missing),
// refusal of a tampered or truncated file and of a malformed lock, and the
// download path against a local server standing in for Hugging Face, each by
// running the real CLI.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { lockHash, lockHashText, MODEL_CACHE_PREFIX, modelCacheNames, modelFileUrl, OP_SESSIONS, parseLock, type LockedFile, type LockedModel, type ModelLock } from '../src/analysis/lock.ts';
import { REPO, runTool, tempDir } from './support/cli.ts';
import * as ort from 'onnxruntime-web/wasm';
import { checkFaceKnownAnswer, decodeFace, faceInput, FACE_ROWS } from '../src/analysis/face-check.ts';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The documented ModelId rule: '<name>@' + SHA-256 of each file's sha256 hex plus "\n", in lock order. */
const modelIdOf = (name: string, files: readonly LockedFile[]): string => `${name}@${sha256(files.map((f) => `${f.sha256}\n`).join(''))}`;

let lock: ModelLock;
let scratch = '';
before(async () => {
  const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
  if (!parsed.ok) assert.fail(parsed.error);
  lock = parsed.value.lock;
  scratch = await tempDir('models');
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const allFiles = (): LockedFile[] => Object.values(lock.models).flatMap((m) => m.files);

/** Writes a lock holding only `models`, for runs that must not reach the network. */
async function lockOf(name: string, models: Readonly<Record<string, Pick<LockedModel, 'repo' | 'commit' | 'files'>>>): Promise<string> {
  const file = path.join(scratch, `${name}.lock.json`);
  await writeFile(file, JSON.stringify({ lockVersion: 1, models }));
  return file;
}

/** A local server standing in for Hugging Face: `respond` answers each request by its path. */
async function withOrigin(respond: http.RequestListener, body: (origin: string) => Promise<void>): Promise<void> {
  const server = http.createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    await body(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const REPO_ID = 'test/probe';
const COMMIT = '0'.repeat(40);
const PINNED = `https://huggingface.co/${REPO_ID}/resolve/${COMMIT}`;
const GOOD = Buffer.from('pinned model bytes\n'.repeat(1000));

/** A one-file probe model whose source is PINNED/<file>. */
const probeModel = (file: string, served: string, { bytes = GOOD } = {}): Pick<LockedModel, 'repo' | 'commit' | 'files'> => ({
  repo: REPO_ID,
  commit: COMMIT,
  files: [{ session: 'probe', role: 'graph', source: `${PINNED}/${file}`, sha256: sha256(bytes), bytes: bytes.length, served }],
});

test('the lock is well formed: pinned sources, unique hashed served names, one graph per session, and ModelIds by the rule', () => {
  const served = allFiles().map((f) => f.served);
  assert.equal(new Set(served).size, served.length, 'served names are unique');
  for (const [name, model] of Object.entries(lock.models)) {
    assert.equal(model.modelId, modelIdOf(name, model.files), name);
    const sessions = [...new Set(model.files.map((f) => f.session))];
    for (const session of sessions) {
      const files = model.files.filter((f) => f.session === session);
      assert.deepEqual(files.map((f) => f.role).slice(0, 1), ['graph'], `${name} ${session} lists its graph first`);
      assert.equal(files.filter((f) => f.role === 'graph').length, 1, `${name} ${session} has one graph file`);
    }
    // A session's files are contiguous, so its graph precedes its own external data.
    assert.deepEqual(model.files.map((f) => f.session).filter((s, i, all) => s !== all[i - 1]), sessions, `${name} groups each session's files`);
    for (const f of model.files) {
      const ext = path.posix.basename(new URL(f.source).pathname).replace(/^[^.]*\./, '');
      assert.equal(f.served, `/models/${name}-${f.sha256.slice(0, 8)}.${ext}`, f.served);
      assert.ok(f.source.startsWith(`https://huggingface.co/${model.repo}/resolve/${model.commit}/`), f.source);
      if (f.role === 'external-data') assert.equal(f.externalDataPath, path.posix.basename(new URL(f.source).pathname), f.served);
      else assert.equal('externalDataPath' in f, false, f.served);
    }
  }
});

test('the files under models/ hash to the lock (run `node tools/fetch-models.mjs` first if this fails)', async () => {
  const run = await runTool('tools/fetch-models.mjs', ['--verify-only']);
  assert.equal(run.code, 0, `the working tree's models/ does not verify: ${run.stderr}`);
  assert.match(run.stdout, new RegExp(`${allFiles().length} files verified in .*, 0 downloaded`));
  // Each graph file names its session's external data file as the lock
  // records it, which is the path ORT's externalData option must be given.
  for (const model of Object.values(lock.models)) {
    for (const data of model.files.filter((f) => f.role === 'external-data')) {
      const graph = model.files.find((f) => f.session === data.session && f.role === 'graph');
      assert.ok(graph !== undefined && data.externalDataPath !== undefined, data.served);
      const bytes = await readFile(path.join(REPO, graph.served.slice(1)));
      assert.ok(bytes.includes(Buffer.from(data.externalDataPath)), `${graph.served} names ${data.externalDataPath}`);
    }
  }
});

test('with the files missing, --verify-only fails with one sentence naming the command to run', async () => {
  const run = await runTool('tools/fetch-models.mjs', ['--verify-only', '--models', path.join(scratch, 'absent')]);
  assert.equal(run.code, 3, run.stderr);
  assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
  assert.match(run.stderr, /run `node tools\/fetch-models\.mjs`/);
});

test('a tampered or truncated file is refused with one sentence, left as it is, and nothing is renamed into place', async () => {
  const smallest = allFiles().reduce((a, b) => (a.bytes <= b.bytes ? a : b));
  const [modelName, owner] = Object.entries(lock.models).find(([, m]) => m.files.includes(smallest)) ?? assert.fail('the lock has no file');
  const name = path.posix.basename(smallest.served);
  const original = await readFile(path.join(REPO, smallest.served.slice(1)));
  const lockFile = await lockOf('one', { [modelName]: { repo: owner.repo, commit: owner.commit, files: [smallest] } });
  const cases = {
    tampered: async (file: string) => {
      const bytes = Buffer.from(original);
      bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] ?? 0) ^ 0x01;
      await writeFile(file, bytes);
    },
    truncated: async (file: string) => {
      await copyFile(path.join(REPO, smallest.served.slice(1)), file);
      await truncate(file, original.length - 1000);
    },
  };
  for (const [label, make] of Object.entries(cases)) {
    const dir = path.join(scratch, label);
    await mkdir(dir, { recursive: true });
    await make(path.join(dir, name));
    const before = sha256(await readFile(path.join(dir, name)));
    // Without --verify-only too: a refused file stops the run before any download.
    for (const args of [['--verify-only'], []]) {
      const run = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', lockFile, ...args]);
      assert.equal(run.code, 1, `${label} ${args.join(' ')}: ${run.stderr}`);
      assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
      assert.match(run.stderr, new RegExp(`${name} does not match the lock`));
      assert.match(run.stderr, /delete it and run/);
    }
    assert.deepEqual(await readdir(dir), [name], `${label}: nothing else was written`);
    assert.equal(sha256(await readFile(path.join(dir, name))), before, `${label}: the file was left as it was`);
  }
});

test('a lock that serves two files under one name, or names a source other than its pinned Hugging Face URL, is refused before any download', async () => {
  const dir = path.join(scratch, 'refused-lock');
  const twice = await lockOf('twice', { a: probeModel('a.onnx', '/models/x.onnx'), b: probeModel('b.onnx', '/models/x.onnx') });
  const elsewhere = probeModel('a.onnx', '/models/x.onnx');
  const cases = {
    twice,
    'another host': await lockOf('host', { a: { ...elsewhere, files: elsewhere.files.map((f) => ({ ...f, source: 'https://example.com/a.onnx' })) } }),
    'another commit': await lockOf('commit', { a: { ...elsewhere, commit: '1'.repeat(40) } }),
    'plain http': await lockOf('http', { a: { ...elsewhere, files: elsewhere.files.map((f) => ({ ...f, source: f.source.replace('https:', 'http:') })) } }),
  };
  for (const [label, lockFile] of Object.entries(cases)) {
    const run = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', lockFile]);
    assert.equal(run.code, 2, `${label}: ${run.stderr}`);
    assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
    assert.match(run.stderr, /is malformed/, label);
  }
  assert.equal((await readdir(scratch)).includes('refused-lock'), false, 'no models directory was created');
});

test('a download is placed only after it verifies, a second run downloads nothing, and a wrong download is never placed', async () => {
  const dir = path.join(scratch, 'download');
  await withOrigin(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(req.url === `/${REPO_ID}/resolve/${COMMIT}/good` ? GOOD : Buffer.from(GOOD).fill(0x41, 0, 10));
    },
    async (origin) => {
      const goodLock = await lockOf('good', { probe: probeModel('good', '/models/probe-good.onnx') });
      const first = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', goodLock, '--origin', origin]);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /1 files verified .*, 1 downloaded/);
      assert.ok((await readFile(path.join(dir, 'probe-good.onnx'))).equals(GOOD));
      const second = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', goodLock, '--origin', origin]);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /1 files verified .*, 0 downloaded/);

      const badLock = await lockOf('bad', { probe: probeModel('bad', '/models/probe-bad.onnx') });
      const bad = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', badLock, '--origin', origin]);
      assert.equal(bad.code, 4, bad.stderr);
      assert.equal(bad.stderr.trim().split('\n').length, 1, bad.stderr);
      assert.match(bad.stderr, /probe-bad\.onnx was not placed/);
      assert.match(bad.stderr, /not the bytes the lock pins/, 'a wrong body is not blamed on the network');
      assert.deepEqual(await readdir(dir), ['probe-good.onnx'], 'neither the wrong file nor its partial download remains');
    },
  );
});

test('a body longer than the lock says is cut off at that length, so an endless body ends the run', async () => {
  const dir = path.join(scratch, 'endless');
  let sent = 0;
  await withOrigin(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x42);
      const more = (): void => {
        // Never ends; the client must stop reading.
        while (res.write(chunk)) sent += chunk.length;
        sent += chunk.length;
        res.once('drain', more);
      };
      more();
      res.on('close', () => res.removeAllListeners('drain'));
    },
    async (origin) => {
      const lockFile = await lockOf('endless', { probe: probeModel('endless', '/models/probe-endless.onnx') });
      const run = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', lockFile, '--origin', origin]);
      assert.equal(run.code, 4, run.stderr);
      assert.match(run.stderr, /more than the lock's \d+ bytes/);
      assert.deepEqual(await readdir(dir), [], 'nothing is left behind');
    },
  );
  assert.ok(sent < 64 * 1024 * 1024, `the server sent ${sent} bytes before the client stopped`);
});

test('a download run removes the partial file a killed run left, and leaves a live run\'s', async () => {
  const dir = path.join(scratch, 'stale');
  await mkdir(dir, { recursive: true });
  // A pid that has exited, as a run killed by SIGKILL leaves behind.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(dead !== undefined);
  const stale = `probe-good.onnx.part-${dead}`;
  const live = `probe-good.onnx.part-${process.pid}`;
  await writeFile(path.join(dir, stale), 'partial');
  await writeFile(path.join(dir, live), 'partial');
  await withOrigin(
    (_req, res) => {
      res.writeHead(200);
      res.end(GOOD);
    },
    async (origin) => {
      const lockFile = await lockOf('stale', { probe: probeModel('good', '/models/probe-good.onnx') });
      const verify = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', lockFile, '--verify-only']);
      assert.equal(verify.code, 3, verify.stderr);
      assert.deepEqual((await readdir(dir)).sort(), [live, stale].sort(), '--verify-only removes nothing');
      const run = await runTool('tools/fetch-models.mjs', ['--models', dir, '--lock', lockFile, '--origin', origin]);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`removed ${stale.replace('.', '\\.')}`));
      assert.deepEqual((await readdir(dir)).sort(), ['probe-good.onnx', live].sort());
    },
  );
});

test('each operation reads its files from the lock by session: depth, SAM, MI-GAN, and UltraFace', () => {
  const parsed = parseLock(lock);
  const ops = parsed.ok ? parsed.value.ops : assert.fail(parsed.error);
  for (const op of ['depth', 'encode', 'decode', 'inpaint', 'face'] as const) {
    const { model, session } = OP_SESSIONS[op];
    const files = lock.models[model]?.files.filter((f) => f.session === session) ?? [];
    const found = ops[op];
    assert.deepEqual(found.files, files, op);
    assert.equal(found.model, lock.models[model]?.modelId, op);
    assert.ok(files.some((f) => f.role === 'graph'), `${op} has its graph`);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(ops).map(([op, o]) => [op, o.files.map((f) => f.served)])),
    {
      depth: ['/models/depth-fcf51f1b.onnx'],
      encode: ['/models/sam-8800fdd0.onnx', '/models/sam-ea1f6775.onnx_data'],
      decode: ['/models/sam-a5f31dba.onnx', '/models/sam-fdb3179a.onnx_data'],
      inpaint: ['/models/migan-6f1f3530.onnx'],
      face: ['/models/face-34cd7e60.onnx'],
    },
  );
});

test('the lock parse refuses what the browser could not load from', () => {
  const base: unknown = JSON.parse(JSON.stringify(lock));
  const variant = (change: (draft: { lockVersion: number; models: Record<string, Record<string, unknown> & { files: Record<string, unknown>[] }> }) => void): unknown => {
    const draft = JSON.parse(JSON.stringify(base));
    change(draft);
    return draft;
  };
  const cases: Readonly<Record<string, readonly [unknown, RegExp]>> = {
    'an unknown key': [variant((d) => { (d.models['depth'] ?? assert.fail()).extra = 1; }), /models\.depth: unknown key|extra/],
    'another lock version': [variant((d) => { d.lockVersion = 2; }), /lockVersion/],
    'a served path off /models/': [variant((d) => { (d.models['depth']?.files[0] ?? assert.fail()).served = 'https://cdn.example/depth-fcf51f1b.onnx'; }), /served/],
    'external data without its path': [variant((d) => { delete (d.models['sam']?.files[1] ?? assert.fail()).externalDataPath; }), /externalDataPath/],
    'a graph with an external data path': [variant((d) => { (d.models['depth']?.files[0] ?? assert.fail()).externalDataPath = 'x'; }), /unknown key/],
    'a malformed modelId': [variant((d) => { (d.models['depth'] ?? assert.fail()).modelId = 'depth@abc'; }), /modelId/],
    "another model's id": [variant((d) => { (d.models['depth'] ?? assert.fail()).modelId = lock.models['migan']?.modelId; }), /names another model/],
    'one served path twice': [variant((d) => { (d.models['depth']?.files[0] ?? assert.fail()).served = '/models/migan-6f1f3530.onnx'; }), /two files at \/models\/migan-6f1f3530\.onnx/],
    'no decoder session': [variant((d) => { const sam = d.models['sam'] ?? assert.fail(); sam.files = sam.files.filter((f) => f['session'] !== 'decoder'); }), /no sam model with a decoder session, which decode needs/],
    'no inpaint model': [variant((d) => { delete d.models['migan']; }), /no migan model/],
    'no face model': [variant((d) => { delete d.models['face']; }), /no face model/],
    'a session without its graph': [variant((d) => { const sam = d.models['sam'] ?? assert.fail(); sam.files = sam.files.filter((f) => !(f['session'] === 'encoder' && f['role'] === 'graph')); }), /encoder session has no graph file/],
  };
  for (const [label, [json, reason]] of Object.entries(cases)) {
    const parsed = parseLock(json);
    assert.equal(parsed.ok, false, label);
    if (!parsed.ok) assert.match(parsed.error, reason, label);
  }
  assert.equal(parseLock(base).ok, true, 'the unchanged copy parses');
});

test('the lock hash is the SHA-256 of one line per file, `<served> <sha256> <bytes>`, models in name order', async () => {
  const lines = Object.keys(lock.models)
    .sort()
    .flatMap((name) => lock.models[name]?.files ?? [])
    .map((f) => `${f.served} ${f.sha256} ${f.bytes}\n`);
  assert.equal(lockHashText(lock), lines.join(''));
  assert.equal(lines.length, allFiles().length);
  const hash = await lockHash(lock, crypto.subtle);
  assert.equal(hash, sha256(lines.join('')), 'the hash over WebCrypto equals node:crypto\'s over the same text');

  const reordered: ModelLock = { ...lock, models: Object.fromEntries(Object.entries(lock.models).reverse()) };
  assert.equal(await lockHash(reordered, crypto.subtle), hash, 'the order of the models in the file does not matter');
  const depth = lock.models['depth'] ?? assert.fail('no depth model');
  const graph = depth.files[0] ?? assert.fail('no depth file');
  const withDepth = (file: LockedFile, license = depth.license): ModelLock => ({ ...lock, models: { ...lock.models, depth: { ...depth, license, files: [file] } } });
  assert.equal(await lockHash(withDepth(graph, 'MIT'), crypto.subtle), hash, 'a license changes no cached file, so not the hash');
  for (const changed of [{ ...graph, served: '/models/depth-00000000.onnx' }, { ...graph, sha256: '0'.repeat(64) }, { ...graph, bytes: graph.bytes + 1 }]) {
    assert.notEqual(await lockHash(withDepth(changed), crypto.subtle), hash, JSON.stringify(changed));
  }
});

test('the model caches are named from the lock hash, and each file is keyed by its served path on the origin', async () => {
  const hash = await lockHash(lock, crypto.subtle);
  assert.equal(MODEL_CACHE_PREFIX, 'noisy-models-');
  assert.deepEqual(modelCacheNames(hash), { verified: `noisy-models-${hash}`, partial: `noisy-models-${hash}-partial` });
  for (const name of Object.values(modelCacheNames(hash))) assert.ok(name.startsWith(MODEL_CACHE_PREFIX), name);
  for (const file of allFiles()) {
    assert.equal(modelFileUrl(file, 'http://127.0.0.1:8790'), `http://127.0.0.1:8790${file.served}`);
    assert.equal(modelFileUrl(file, 'https://mac.example.ts.net/'), `https://mac.example.ts.net${file.served}`, 'a trailing slash on the origin adds nothing');
  }
});

test('UltraFace on wasm: RGB preprocessing, real names, shapes and known synthetic answer', async () => {
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  const session = await ort.InferenceSession.create(await readFile(path.join(REPO, 'models/face-34cd7e60.onnx')), { executionProviders: ['wasm'], logSeverityLevel: 3 });
  try {
    assert.deepEqual(session.inputNames, ['input']);
    assert.deepEqual(session.outputNames, ['scores', 'boxes']);
    const rgba = new Uint8Array(320 * 240 * 4).fill(127);
    const zero = faceInput(rgba);
    assert.ok(zero.every((v) => v === 0));
    rgba.set([255, 127, 0, 255]);
    const rgb = faceInput(rgba);
    assert.equal(rgb[0], 1);
    assert.equal(rgb[320 * 240], 0);
    assert.equal(rgb[2 * 320 * 240], -127 / 128);
    const outputs = await session.run({ input: new ort.Tensor('float32', zero, [1, 3, 240, 320]) });
    const checked = checkFaceKnownAnswer(outputs);
    assert.ok(checked.ok, checked.ok ? '' : checked.error);
    assert.equal(checked.value.pass, true, JSON.stringify(checked.value));
    const scores = outputs['scores']?.data, boxes = outputs['boxes']?.data;
    assert.ok(scores instanceof Float32Array && boxes instanceof Float32Array);
    assert.ok(Math.abs((scores[0] ?? 0) - .942658) < .001);
    assert.ok(Math.abs((boxes[0] ?? 1) - .002109) < .001);
    assert.deepEqual(decodeFace(outputs), { ok: true, value: null });
  } finally { await session.release(); }
});

test('UltraFace decoder thresholds, clamps raw boxes and suppresses overlapping proposals', () => {
  const scores = new Float32Array(FACE_ROWS * 2), boxes = new Float32Array(FACE_ROWS * 4);
  const proposal = (i: number, score: number, box: readonly number[]) => { scores[i * 2 + 1] = score; boxes.set(box, i * 4); };
  proposal(0, .95, [.3, .2, .7, .6]);
  proposal(1, .8, [.28, .18, .72, .62]); // larger duplicate must lose to higher confidence
  proposal(2, .69, [0, 0, 1, 1]);
  const outputs = { scores: { dims: [1, FACE_ROWS, 2], data: scores }, boxes: { dims: [1, FACE_ROWS, 4], data: boxes } };
  const decoded = decodeFace(outputs);
  assert.ok(decoded.ok && decoded.value !== null);
  assert.ok(Math.abs(decoded.value.center.x - .5) < 1e-6);
  assert.ok(Math.abs(decoded.value.center.y - .4) < 1e-6);
  assert.ok(Math.abs(decoded.value.size - .4) < 1e-6);
  proposal(3, .9, [-.3, .7, .6, 1.2]);
  scores[1] = 0; scores[3] = 0;
  const clamped = decodeFace(outputs); assert.ok(clamped.ok && clamped.value !== null);
  assert.ok(Math.abs(clamped.value.center.x - .3) < 1e-6);
  assert.ok(Math.abs(clamped.value.center.y - .85) < 1e-6);
  assert.equal(decodeFace({ ...outputs, boxes: { dims: [1, 4, FACE_ROWS], data: boxes } }).ok, false);
  scores[0] = NaN;
  assert.equal(decodeFace(outputs).ok, false);
});
