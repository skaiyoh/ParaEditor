// tools/build.mjs end to end: the five entries in both modes, the production
// console drop, the build id, the dev-only --migrations substitution, the
// vendored ONNX Runtime files, and the dev pages, each by running the real CLI
// into a temporary directory.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { parseLock } from '../src/analysis/lock.ts';
import { z } from 'zod';
import { landscapeSchema, parseLandscapeMesh } from '../src/app/showcase/landscape.ts';
import { REPO, runTool, tempDir, writeTree } from './support/cli.ts';

const BuildMeta = z.object({
  mode: z.enum(['dev', 'production']),
  buildId: z.string(),
  app: z.string(),
  scenes: z.string().optional(),
  workers: z.object({ sequence: z.string(), decode: z.string(), gif: z.string(), face: z.string() }),
  devPages: z.record(z.string(), z.string()),
  devWorkers: z.record(z.string(), z.string()),
  ort: z.object({ version: z.string(), dir: z.string(), files: z.array(z.string()) }),
  migrations: z.string().nullable(),
  files: z.array(z.string()),
});

/** The files of onnxruntime-web's plain wasm build that the runtime loads, and only those. */
const ORT_FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
type BuildMeta = z.infer<typeof BuildMeta>;

let scratch = '';
before(async () => {
  scratch = await tempDir('build');
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(args: readonly string[], outdir: string): Promise<BuildMeta> {
  const run = await runTool('tools/build.mjs', [...args, '--outdir', outdir]);
  assert.equal(run.code, 0, run.stderr);
  return BuildMeta.parse(JSON.parse(await readFile(path.join(outdir, 'build.json'), 'utf8')));
}

const jsFiles = (meta: BuildMeta) => meta.files.filter((f) => f.endsWith('.js'));

/** A throwaway source tree with the five entries the build requires. */
async function probeTree(name: string, main: string, extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const src = path.join(scratch, name);
  const stub = 'export {};\n';
  await writeTree(src, {
    'main.tsx': main,
    'analysis/sequence-worker.ts': stub,
    'analysis/decode-worker.ts': stub,
    'analysis/face-worker.ts': stub,
    'export/gif-worker.ts': stub,
    'index.html': '<!doctype html><script type="module" src="%NOISY_APP%"></script>\n',
    'manifest.webmanifest': '{}\n',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    ...extra,
  });
  return src;
}

for (const mode of ['dev', 'production'] as const) {
  test(`a ${mode} build of src/ writes the app and the four workers`, async () => {
    const outdir = path.join(scratch, `real-${mode}`);
    const meta = await build(['--mode', mode], outdir);
    assert.equal(meta.mode, mode);
    assert.match(meta.buildId, /^([0-9a-f]{12,}|nocommit)-\d{8}$/);
    const entries = [meta.app, meta.workers.sequence, meta.workers.decode, meta.workers.gif, meta.workers.face];
    assert.deepEqual(
      entries.map((u) => path.posix.basename(u).replace(/-[A-Z0-9]{8}\.js$/, '')),
      ['main', 'sequence-worker', 'decode-worker', 'gif-worker', 'face-worker'],
    );
    for (const url of entries) {
      assert.match(url, /^\/assets\/[a-z-]+-[A-Z0-9]{8}\.js$/);
      assert.ok(existsSync(path.join(outdir, url)), url);
    }
    const html = await readFile(path.join(outdir, 'index.html'), 'utf8');
    assert.ok(html.includes(`<script type="module" src="${meta.app}"></script>`));
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'no inline script');
    assert.doesNotMatch(html, /<style|\sstyle=/, 'no inline style');
    const app = await readFile(path.join(outdir, meta.app), 'utf8');
    assert.ok(app.includes(meta.buildId), 'the build id is compiled into the app');
  });
}

test('the compile-time constants reach the app: build id, dev flag, and the hashed worker URLs', async () => {
  const src = await probeTree(
    'constants-probe',
    'Object.assign(globalThis, { noisyProbe: { buildId: NOISY_BUILD_ID, dev: NOISY_DEV, workers: NOISY_WORKER_URLS } });\n',
  );
  for (const mode of ['dev', 'production'] as const) {
    const outdir = path.join(scratch, `constants-${mode}`);
    const meta = await build(['--mode', mode, '--src', src], outdir);
    await import(pathToFileURL(path.join(outdir, meta.app)).href);
    const probe: unknown = Reflect.get(globalThis, 'noisyProbe');
    assert.deepEqual(probe, { buildId: meta.buildId, dev: mode === 'dev', workers: meta.workers }, mode);
  }
});

test('--lock picks the lock a bundle carries as NOISY_MODEL_LOCK, models.lock.json by default, and a lock that is not JSON fails the build', async () => {
  const src = await probeTree('lock-probe', 'Object.assign(globalThis, { noisyLockProbe: NOISY_MODEL_LOCK });\n');
  const other = path.join(scratch, 'other.lock.json');
  const otherLock = { lockVersion: 1, models: { probe: { note: 'any JSON; the browser parses it' } } };
  await writeTree(scratch, { 'other.lock.json': JSON.stringify(otherLock), 'broken.lock.json': '{ not json' });
  const read = async (args: readonly string[], name: string): Promise<unknown> => {
    const outdir = path.join(scratch, name);
    const meta = await build(['--mode', 'production', '--src', src, ...args], outdir);
    await import(pathToFileURL(path.join(outdir, meta.app)).href);
    return Reflect.get(globalThis, 'noisyLockProbe');
  };
  assert.deepEqual(await read([], 'lock-default'), JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
  assert.deepEqual(await read(['--lock', other], 'lock-other'), otherLock);
  const broken = await runTool('tools/build.mjs', ['--src', src, '--lock', path.join(scratch, 'broken.lock.json'), '--outdir', path.join(scratch, 'lock-broken')]);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /^build: the model lock .*broken\.lock\.json cannot be read as JSON, so nothing was written/);
});

test('a production build has no console call in any bundle it writes, and a dev build keeps them', async () => {
  const real = await build(['--mode', 'production'], path.join(scratch, 'console-real'));
  for (const file of jsFiles(real)) {
    assert.ok(!(await readFile(path.join(scratch, 'console-real', file), 'utf8')).includes('console.'), file);
  }
  // The check can fail: a probe that logs keeps its call in a dev build only.
  const src = await probeTree('console-probe', 'console.log("probe-log");\ndebugger;\n');
  const dev = await build(['--mode', 'dev', '--src', src], path.join(scratch, 'console-dev'));
  const prod = await build(['--mode', 'production', '--src', src], path.join(scratch, 'console-prod'));
  assert.ok((await readFile(path.join(scratch, 'console-dev', dev.app), 'utf8')).includes('console.log("probe-log")'));
  const prodApp = await readFile(path.join(scratch, 'console-prod', prod.app), 'utf8');
  assert.ok(!prodApp.includes('console.') && !prodApp.includes('debugger'), prodApp);
});

test('--migrations substitutes core/migrate.ts in a dev build, and a production build refuses it', async () => {
  const src = await probeTree(
    'migrations-probe',
    'import { MIGRATION_MARK } from "./core/migrate.ts";\nObject.assign(globalThis, { noisyMigrationMark: MIGRATION_MARK });\n',
    {
      'core/migrate.ts': 'export const MIGRATION_MARK = "real";\n',
      'substitute.ts': 'export const MIGRATION_MARK = "substitute";\n',
      // The same module through a .js specifier, which esbuild also resolves to migrate.ts.
      'analysis/decode-worker.ts': 'import { MIGRATION_MARK } from "../core/migrate.js";\nself.postMessage(MIGRATION_MARK);\n',
    },
  );
  // On a case-insensitive file system (macOS by default) a wrong-case spelling
  // resolves to the same file, so it must be substituted too.
  const caseInsensitive = existsSync(path.join(src, 'core/Migrate.ts'));
  if (caseInsensitive) {
    await writeTree(src, { 'export/gif-worker.ts': 'import { MIGRATION_MARK } from "../core/Migrate.ts";\nself.postMessage(MIGRATION_MARK);\n' });
  }
  const markOf = async (outdir: string, meta: BuildMeta): Promise<unknown> => {
    await import(pathToFileURL(path.join(outdir, meta.app)).href);
    return Reflect.get(globalThis, 'noisyMigrationMark');
  };
  const plainDir = path.join(scratch, 'mig-plain');
  const plain = await build(['--mode', 'dev', '--src', src], plainDir);
  assert.equal(await markOf(plainDir, plain), 'real');
  assert.equal(plain.migrations, null);
  assert.match(await readFile(path.join(plainDir, plain.workers.decode), 'utf8'), /"real"/);

  const substitute = path.join(src, 'substitute.ts');
  const swappedDir = path.join(scratch, 'mig-swapped');
  const swapped = await build(['--mode', 'dev', '--src', src, '--migrations', substitute], swappedDir);
  assert.equal(await markOf(swappedDir, swapped), 'substitute');
  assert.ok(!(await readFile(path.join(swappedDir, swapped.app), 'utf8')).includes('"real"'), 'the real module is not bundled');
  assert.equal(swapped.migrations, substitute);
  const worker = await readFile(path.join(swappedDir, swapped.workers.decode), 'utf8');
  assert.ok(worker.includes('"substitute"') && !worker.includes('"real"'), 'the .js specifier is substituted too');
  if (caseInsensitive) {
    const gif = await readFile(path.join(swappedDir, swapped.workers.gif), 'utf8');
    assert.ok(gif.includes('"substitute"') && !gif.includes('"real"'), 'the wrong-case specifier is substituted too');
  }

  const unusedDir = path.join(scratch, 'mig-unused');
  const unused = await runTool('tools/build.mjs', ['--mode', 'dev', '--src', await probeTree('migrations-unused', 'export {};\n'), '--migrations', path.join(src, 'substitute.ts'), '--outdir', unusedDir]);
  assert.notEqual(unused.code, 0, 'a --migrations flag that substitutes nothing fails the build');
  assert.match(unused.stderr, /would substitute nothing/);
  assert.ok(!existsSync(unusedDir));

  const refusedDir = path.join(scratch, 'mig-refused');
  const refused = await runTool('tools/build.mjs', ['--mode', 'production', '--src', src, '--migrations', substitute, '--outdir', refusedDir]);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.stderr.trim().split('\n').length, 1, refused.stderr);
  assert.match(refused.stderr, /production build refuses it/);
  assert.ok(!existsSync(refusedDir), 'nothing was written');
});

test('the build refuses to replace a directory that is not a build output, or a file, with one sentence', async () => {
  const dir = path.join(scratch, 'not-a-build');
  await writeTree(dir, { 'keep.txt': 'mine\n' });
  const run = await runTool('tools/build.mjs', ['--outdir', dir]);
  assert.equal(run.code, 1);
  assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'mine\n');

  const file = path.join(scratch, 'a-file');
  await writeTree(scratch, { 'a-file': 'mine\n' });
  const onFile = await runTool('tools/build.mjs', ['--outdir', file]);
  assert.equal(onFile.code, 1);
  assert.match(onFile.stderr, /^build: .* is not a directory/);
  assert.equal(onFile.stderr.trim().split('\n').length, 1, onFile.stderr);
  assert.equal(await readFile(file, 'utf8'), 'mine\n');
});

const sha256 = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');

test('an oversized shipped file fails before replacing an existing build', async () => {
  const src = await probeTree('oversized-asset', 'export {};\n', { 'assets/oversized.bin': '' });
  const outdir = path.join(scratch, 'oversized-output');
  await build(['--mode', 'production', '--src', src], outdir);
  const previous = await readFile(path.join(outdir, 'build.json'), 'utf8');
  await truncate(path.join(src, 'assets/oversized.bin'), 25 * 1024 * 1024 + 1);
  const run = await runTool('tools/build.mjs', ['--mode', 'production', '--src', src, '--outdir', outdir]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /assets-static\/oversized\.bin exceeds the 25 MiB hosted file limit/);
  assert.equal(await readFile(path.join(outdir, 'build.json'), 'utf8'), previous);
});

test('both builds copy exactly the plain wasm runtime files, byte for byte, and only a dev build writes /dev/ pages', async () => {
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(path.join(REPO, 'node_modules/onnxruntime-web/package.json'), 'utf8')));
  for (const mode of ['dev', 'production'] as const) {
    const outdir = path.join(scratch, `ort-${mode}`);
    const meta = await build(['--mode', mode], outdir);
    assert.deepEqual(meta.ort, { version, dir: `/vendor/ort/${version}/`, files: ORT_FILES });
    const vendored = meta.files.filter((f) => f.startsWith('vendor/'));
    assert.deepEqual(vendored, ORT_FILES.map((f) => `vendor/ort/${version}/${f}`).sort(), mode);
    for (const file of ORT_FILES) {
      const pinned = await sha256(path.join(REPO, 'node_modules/onnxruntime-web/dist', file));
      assert.equal(await sha256(path.join(outdir, 'vendor/ort', version, file)), pinned, `${mode} ${file}`);
    }
    assert.ok(meta.scenes !== undefined && meta.files.includes(meta.scenes.slice(1)), 'both builds include the canonical viewer');
    assert.match(await readFile(path.join(outdir, 'scenes.html'), 'utf8'), /Scene.*|scene-choice/);
    const sceneDir = path.join(outdir, 'assets-static/scenes/highland-field');
    assert.equal(existsSync(path.join(sceneDir, 'field.mesh')), false, 'the oversized source mesh does not ship');
    const chunks = z.object({ version: z.literal(1), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      parts: z.array(z.string().regex(/^field\.mesh\.\d+$/)).min(1),
    }).strict().parse(JSON.parse(await readFile(path.join(sceneDir, 'field.chunks.json'), 'utf8')));
    const parts = await Promise.all(chunks.parts.map(name => readFile(path.join(sceneDir, name))));
    assert.deepEqual(chunks.parts, parts.map((_, i) => `field.mesh.${i}`));
    for (const [i, part] of parts.entries()) {
      assert.equal(part.byteLength, Math.min(16 * 1024 * 1024, chunks.bytes - i * 16 * 1024 * 1024));
    }
    const joined = Buffer.concat(parts);
    const hash = createHash('sha256').update(joined).digest('hex');
    assert.equal(joined.byteLength, chunks.bytes);
    assert.equal(hash, chunks.sha256);
    assert.equal(hash, await sha256(path.join(REPO, 'assets/scenes/highland-field/field.mesh')), 'reassembled approved landscape bytes are unchanged');
    assert.equal(await sha256(path.join(sceneDir, 'field.json')), await sha256(path.join(REPO, 'assets/scenes/highland-field/field.json')), 'current metadata ships unchanged');
    const field = landscapeSchema.parse(JSON.parse(await readFile(path.join(sceneDir, 'field.json'), 'utf8')));
    const geometry = parseLandscapeMesh(field, new Uint8Array(joined).buffer);
    assert.equal(joined.byteLength, field.meshBytes);
    assert.equal(geometry.vertices.length, field.vertexCount * field.strideBytes / 4);
    assert.equal(geometry.indices.length, field.triangleCount * 3);
    assert.equal(await sha256(path.join(outdir, 'assets-static/scenes/lantern-court/geometry.bin')),
      await sha256(path.join(REPO, 'src/dev/assets/lantern-court/geometry.bin')), 'courtyard bytes are unchanged');
    assert.equal(meta.files.some(file => /\.blend(?:\d+)?$|\.py$|(?:tracking(?:\.entry)?|viewer)\.js$|(?:serve|build_tracking)\.mjs$/.test(file)), false, 'authoring and standalone runtime do not ship');
    for (const file of meta.files) assert.ok((await stat(path.join(outdir, file))).size <= 25 * 1024 * 1024, file);
    const devFiles = meta.files.filter((f) => f.startsWith('dev/'));
    if (mode === 'production') {
      assert.deepEqual(devFiles, [], 'a production build writes no dev page');
      assert.deepEqual([meta.devPages, meta.devWorkers], [{}, {}]);
      continue;
    }
    assert.deepEqual(devFiles, ['dev/checklist.html', 'dev/decoder.html', 'dev/harness/memory.html', 'dev/models.html', 'dev/sequence.html', 'dev/service.html', 'dev/showcase.html', 'dev/store.html', 'dev/threads.html'].sort());
    const scripts: Record<string, string> = {};
    for (const name of ['checklist', 'decoder', 'harness/memory', 'models', 'sequence', 'service', 'showcase', 'store', 'threads']) {
      assert.equal(meta.devPages[name], `/dev/${name}.html`);
      const html = await readFile(path.join(outdir, `dev/${name}.html`), 'utf8');
      const bundle = path.basename(name);
      const src = new RegExp(`<script type="module" src="(/assets/${bundle}-[A-Z0-9]{8}\\.js)"></script>`).exec(html)?.[1];
      assert.ok(src !== undefined && meta.files.includes(src.slice(1)), html);
      assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=/, `${name}: no inline script or style`);
      scripts[name] = src;
    }
    const parsed = parseLock(JSON.parse(await readFile(path.join(REPO, 'models.lock.json'), 'utf8')));
    const lock = parsed.ok ? parsed.value.lock : assert.fail(parsed.error);
    const modelsPage = await readFile(path.join(outdir, scripts['models'] ?? ''), 'utf8');
    assert.ok(modelsPage.includes(`lockVersion: ${lock.lockVersion}`), 'the model page carries the lock');
    for (const model of Object.values(lock.models)) {
      assert.ok(modelsPage.includes(JSON.stringify(model.modelId)), `the model page carries ${model.modelId}`);
    }
    const script = scripts['threads'] ?? '';
    const workerUrl = meta.devWorkers['threads'];
    assert.match(workerUrl ?? '', /^\/assets\/threads-worker-[A-Z0-9]{8}\.js$/);
    assert.ok((await readFile(path.join(outdir, script), 'utf8')).includes(JSON.stringify(workerUrl)), 'the page knows its worker URL');
    const worker = await readFile(path.join(outdir, workerUrl ?? ''), 'utf8');
    assert.ok(worker.includes(`import("/vendor/ort/${version}/ort.wasm.min.mjs")`), 'the worker imports the vendored entry at run time');
    assert.ok(!worker.includes('WebAssembly backend initializing'), 'no runtime code is bundled into the worker');
  }
});

test('the dev-page mechanism: every dev/<name>.html with its script, every dev/<name>-worker.ts, in dev builds only', async () => {
  const page = '<!doctype html><script type="module" src="%NOISY_SCRIPT%"></script>\n';
  const src = await probeTree('devpages-probe', 'export {};\n', {
    'dev/alpha.html': page,
    'dev/alpha.ts': 'Object.assign(globalThis, { noisyDevWorkers: NOISY_DEV_WORKER_URLS });\n',
    'dev/beta.html': page,
    'dev/beta.tsx': 'export {};\n',
    'dev/gamma-worker.ts': 'self.postMessage("gamma");\n',
  });
  const dev = await build(['--mode', 'dev', '--src', src], path.join(scratch, 'devpages-dev'));
  assert.deepEqual(dev.devPages, { alpha: '/dev/alpha.html', beta: '/dev/beta.html' });
  assert.deepEqual(Object.keys(dev.devWorkers), ['gamma']);
  const alpha = await readFile(path.join(scratch, 'devpages-dev/dev/alpha.html'), 'utf8');
  const alphaScript = /src="([^"]+)"/.exec(alpha)?.[1] ?? '';
  assert.match(alphaScript, /^\/assets\/alpha-[A-Z0-9]{8}\.js$/);
  await import(pathToFileURL(path.join(scratch, 'devpages-dev', alphaScript)).href);
  assert.deepEqual(Reflect.get(globalThis, 'noisyDevWorkers'), dev.devWorkers);

  const prod = await build(['--mode', 'production', '--src', src], path.join(scratch, 'devpages-prod'));
  assert.deepEqual(prod.files.filter((f) => f.startsWith('dev/') || /alpha|beta|gamma/.test(f)), []);

  const orphan = await probeTree('devpages-orphan', 'export {};\n', { 'dev/lonely.html': page });
  const run = await runTool('tools/build.mjs', ['--mode', 'dev', '--src', orphan, '--outdir', path.join(scratch, 'devpages-orphan-out')]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /dev page .*lonely\.html has no script lonely\.ts or lonely\.tsx/);
  assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
});

test('a dev build reads one level of dev-page subdirectory: pages there build to /dev/<dir>/<name>.html beside the flat ones, deeper directories hold modules, and a worker in a subdirectory at any depth or two entries with one file name fail the build', async () => {
  const page = '<!doctype html><script type="module" src="%NOISY_SCRIPT%"></script>\n';
  const src = await probeTree('subpages-probe', 'export {};\n', {
    'dev/flat.html': page,
    'dev/flat.ts': 'Object.assign(globalThis, { noisyFlat: "flat" });\n',
    'dev/harness/memory.html': page,
    'dev/harness/memory.ts': 'import { DEEP } from "./programs/deep/mark.ts";\nimport { FLAT } from "./flat.ts";\nObject.assign(globalThis, { noisyMemory: DEEP, noisyModule: FLAT });\n',
    'dev/harness/flat.ts': 'export const FLAT = "a module may share an entry\'s file name";\n',
    'dev/harness/programs/deep/mark.ts': 'export const DEEP = "two levels down";\n',
    'dev/harness/programs/deep/ignored.html': page,
    'dev/harness/plain.ts': 'export const PLAIN = 1;\n',
    'dev/tools/capability.html': page,
    'dev/tools/capability.tsx': 'Object.assign(globalThis, { noisyCapability: "tsx" });\n',
  });
  const outdir = path.join(scratch, 'subpages-dev');
  const dev = await build(['--mode', 'dev', '--src', src], outdir);
  assert.deepEqual(dev.devPages, { flat: '/dev/flat.html', 'harness/memory': '/dev/harness/memory.html', 'tools/capability': '/dev/tools/capability.html' });
  assert.deepEqual(dev.files.filter((f) => f.startsWith('dev/')), ['dev/flat.html', 'dev/harness/memory.html', 'dev/tools/capability.html']);
  for (const [file, name, global, value] of [
    ['dev/flat.html', 'flat', 'noisyFlat', 'flat'],
    ['dev/harness/memory.html', 'memory', 'noisyMemory', 'two levels down'],
    ['dev/tools/capability.html', 'capability', 'noisyCapability', 'tsx'],
  ] as const) {
    const html = await readFile(path.join(outdir, file), 'utf8');
    const script = new RegExp(`<script type="module" src="(/assets/${name}-[A-Z0-9]{8}\\.js)"></script>`).exec(html)?.[1];
    assert.ok(script !== undefined && dev.files.includes(script.slice(1)), html);
    await import(pathToFileURL(path.join(outdir, script)).href);
    assert.equal(Reflect.get(globalThis, global), value, file);
  }
  assert.equal(Reflect.get(globalThis, 'noisyModule'), "a module may share an entry's file name");
  const prod = await build(['--mode', 'production', '--src', src], path.join(scratch, 'subpages-prod'));
  assert.deepEqual([prod.devPages, prod.files.filter((f) => f.startsWith('dev/') || /flat|memory|capability/.test(f))], [{}, []]);

  const refused = async (name: string, extra: Readonly<Record<string, string>>, message: RegExp): Promise<void> => {
    const tree = await probeTree(name, 'export {};\n', extra);
    const out = path.join(scratch, `${name}-out`);
    const run = await runTool('tools/build.mjs', ['--mode', 'dev', '--src', tree, '--outdir', out]);
    assert.equal(run.code, 1, name);
    assert.match(run.stderr, message);
    assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
    assert.ok(!existsSync(out), `${name}: nothing was written`);
  };
  await refused('subpages-worker', { 'dev/harness/memory.html': page, 'dev/harness/memory.ts': 'export {};\n', 'dev/harness/stray-worker.ts': 'export {};\n' }, /dev worker .*harness\/stray-worker\.ts is in a subdirectory of dev\//);
  await refused('subpages-deep-worker', { 'dev/harness/memory.html': page, 'dev/harness/memory.ts': 'export {};\n', 'dev/harness/lib/deep/y-worker.ts': 'export {};\n' }, /dev worker .*harness\/lib\/deep\/y-worker\.ts is in a subdirectory of dev\//);
  await refused('subpages-same-name', { 'dev/memory.html': page, 'dev/memory.ts': 'export {};\n', 'dev/harness/memory.html': page, 'dev/harness/memory.ts': 'export {};\n' }, /two entries share the file name memory\.ts/);
  await refused('subpages-orphan', { 'dev/harness/lonely.html': page }, /dev page .*harness\/lonely\.html has no script lonely\.ts or lonely\.tsx/);
});

test('a source that imports onnxruntime-web fails the build, so the runtime is never bundled', async () => {
  const src = await probeTree('bundled-ort', 'import { env } from "onnxruntime-web";\nObject.assign(globalThis, { env });\n');
  const outdir = path.join(scratch, 'bundled-ort-out');
  const run = await runTool('tools/build.mjs', ['--mode', 'dev', '--src', src, '--outdir', outdir]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /onnxruntime-web is never bundled; import the vendored runtime as "noisy:vendor-ort"/);
  assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
  assert.ok(!existsSync(outdir));
});
