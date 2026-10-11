import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { z } from '../src/core/zod.ts';
import { REPO, runTool, tempDir } from './support/cli.ts';

const metadata = z.object({ files: z.array(z.string()), scenes: z.string(), ort: z.object({ dir: z.string() }).passthrough() }).passthrough();
const chunksSchema = z.object({ version: z.number(), bytes: z.number(), sha256: z.string(), parts: z.array(z.string()) });
let scratch = '';
let source = '';
before(async () => {
  scratch = await tempDir('cloudflare-prepare');
  source = path.join(scratch, 'production');
  const built = await runTool('tools/build.mjs', ['--mode', 'production', '--outdir', source]);
  assert.equal(built.code, 0, built.stderr);
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });

function prepare(input: string, name: string): string {
  // Run the real preparer and its generated routing worker, isolated from the
  // shared build trees and deploy state. Paths cross the CLI as arguments.
  return execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { prepare, inventory } from './tools/cloudflare/prepare.mjs';
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    const [source, output, state] = process.argv.slice(1);
    await prepare({ source, output, state });
    const handler = (await import(pathToFileURL(path.join(output, '_worker.js')).href)).default;
    const meta = JSON.parse(await readFile(path.join(output, 'build.json'), 'utf8'));
    const assets = meta.files.filter(name => name.startsWith('assets-static/scenes/') || name === 'scenes.html' || name === meta.scenes.slice(1) || name === 'assets-static/scenes.css');
    const env = { ASSETS: { async fetch(request) { return new Response(request.method === 'HEAD' ? null : new URL(request.url).pathname); } } };
    for (const asset of assets) {
      for (const method of ['GET', 'HEAD']) {
        const response = await handler.fetch(new Request('https://demo.test/' + asset, { method }), env);
        assert.equal(response.status, 200, asset);
        assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', asset);
      }
    }
    for (const asset of ['assets-static/scenes/highland-field/field.mesh', 'assets-static/scenes/highland-field/tracking.js', 'assets-static/scenes/highland-field/highland-field.blend', 'dev/showcase.html']) {
      assert.equal((await handler.fetch(new Request('https://demo.test/' + asset), env)).status, 404, asset);
    }
    const recorded = JSON.parse(await readFile(path.join(state, 'prepared.json'), 'utf8'));
    assert.deepEqual(Object.keys(recorded.files).sort(), await inventory(output));
    console.log('Scene GET/HEAD routes, isolation headers, blocked authoring routes and prepared inventory passed.');
  `, input, path.join(scratch, `${name}-output`), path.join(scratch, `${name}-state`)], { cwd: REPO, encoding: 'utf8', env: { ...process.env, NOISY_GPU_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function fixture(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await cp(source, dir, { recursive: true });
  return dir;
}
async function changeMeta(dir: string, edit: (value: z.infer<typeof metadata>) => void): Promise<void> {
  const file = path.join(dir, 'build.json');
  const value = metadata.parse(JSON.parse(await readFile(file, 'utf8')));
  edit(value);
  await writeFile(file, JSON.stringify(value));
}
async function changeChunks(dir: string, edit: (value: z.infer<typeof chunksSchema>) => void): Promise<void> {
  const file = path.join(dir, 'assets-static/scenes/highland-field/field.chunks.json');
  const value = chunksSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  edit(value);
  await writeFile(file, JSON.stringify(value));
}

test('real production scenes prepare and resolve through the generated hosting worker', () => {
  assert.match(prepare(source, 'real'), /Scene GET\/HEAD routes.*passed/);
});

test('scene CSS is optional only when absent from the build and its inventory', async () => {
  const dir = await fixture('without-css');
  await rm(path.join(dir, 'assets-static/scenes.css'));
  await changeMeta(dir, value => { value.files = value.files.filter(name => name !== 'assets-static/scenes.css'); });
  assert.match(prepare(dir, 'without-css'), /Scene GET\/HEAD routes.*passed/);
});

const rejections: readonly { name: string; pattern: RegExp; change(dir: string): Promise<void> }[] = [
  { name: 'missing-scenes-bundle', pattern: /unexpected or missing files/, async change(dir) {
    const value = metadata.parse(JSON.parse(await readFile(path.join(dir, 'build.json'), 'utf8')));
    await rm(path.join(dir, value.scenes));
  } },
  { name: 'missing-scenes-schema', pattern: /scenes/, async change(dir) {
    await changeMeta(dir, value => { Reflect.deleteProperty(value, 'scenes'); });
  } },
  { name: 'unexpected-authoring-even-in-metadata', pattern: /unexpected or missing files/, async change(dir) {
    const file = 'assets-static/scenes/highland-field/build_scene.py';
    await writeFile(path.join(dir, file), 'authoring');
    await changeMeta(dir, value => { value.files.push(file); });
  } },
  { name: 'whole-mesh', pattern: /unexpected or missing files/, async change(dir) {
    const file = 'assets-static/scenes/highland-field/field.mesh';
    await writeFile(path.join(dir, file), 'must not ship');
    await changeMeta(dir, value => { value.files.push(file); });
  } },
  { name: 'metadata-missing-poster', pattern: /unexpected or missing files/, async change(dir) {
    await changeMeta(dir, value => { value.files = value.files.filter(name => !name.endsWith('/highland-field.png')); });
  } },
  { name: 'wrong-ort-directory', pattern: /Unexpected ORT runtime inventory/, async change(dir) {
    await changeMeta(dir, value => { value.ort.dir = '/vendor/other/'; });
  } },
  { name: 'dev-worker', pattern: /devWorkers/, async change(dir) {
    await changeMeta(dir, value => { Reflect.set(value, 'devWorkers', { probe: '/assets/probe-ABCDEFGH.js' }); });
  } },
  { name: 'symlink-file', pattern: /Refusing symlink/, async change(dir) {
    const file = path.join(dir, 'assets-static/scenes/highland-field/highland-field.png');
    await rm(file); await symlink(path.join(source, 'assets-static/scenes/highland-field/highland-field.png'), file);
  } },
  { name: 'oversized-runtime-file', pattern: /exceeds the 25 MiB hosted file limit/, async change(dir) {
    await truncate(path.join(dir, 'assets-static/scenes/highland-field/highland-field.png'), 25 * 1024 * 1024 + 1);
  } },
  { name: 'reordered-parts', pattern: /Unexpected landscape chunk inventory/, async change(dir) {
    await changeChunks(dir, value => { value.parts.reverse(); });
  } },
  { name: 'duplicate-parts', pattern: /Unexpected landscape chunk inventory/, async change(dir) {
    await changeChunks(dir, value => { value.parts = value.parts.map(() => 'field.mesh.0'); });
  } },
  { name: 'part-traversal', pattern: /Invalid string/, async change(dir) {
    await changeChunks(dir, value => { value.parts = ['../../field.mesh.0']; });
  } },
  { name: 'wrong-total-bytes', pattern: /unexpected landscape chunk size/, async change(dir) {
    await changeChunks(dir, value => { value.bytes--; });
  } },
  { name: 'wrong-hash', pattern: /differ from their SHA-256 manifest/, async change(dir) {
    await changeChunks(dir, value => { value.sha256 = '0'.repeat(64); });
  } },
  { name: 'damaged-part', pattern: /differ from their SHA-256 manifest/, async change(dir) {
    const file = path.join(dir, 'assets-static/scenes/highland-field/field.mesh.0');
    const bytes = await readFile(file); bytes[0] = (bytes[0] ?? 0) ^ 1; await writeFile(file, bytes);
  } },
  { name: 'short-part', pattern: /unexpected landscape chunk size/, async change(dir) {
    await truncate(path.join(dir, 'assets-static/scenes/highland-field/field.mesh.0'), 16 * 1024 * 1024 - 1);
  } },
];
for (const rejection of rejections) test(`preparation rejects ${rejection.name}`, async () => {
  const dir = await fixture(rejection.name);
  await rejection.change(dir);
  assert.throws(() => prepare(dir, rejection.name), rejection.pattern);
});
