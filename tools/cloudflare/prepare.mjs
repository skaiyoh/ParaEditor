import { build } from 'esbuild';
import { gpuHeaders, gpuUrl } from '../build.mjs';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '../../src/core/zod.ts';
import { parseLock } from '../../src/analysis/lock.ts';
import { expectedHeaders, loadHeaderContract } from '../headers.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const OUTPUT = path.join(ROOT, 'build/cloudflare');
export const STATE = path.join(ROOT, '.local/cloudflare');
export const PROJECT = 'noisy-demo';
export const BUCKET = 'noisy-demo-models';
export const DOMAIN = 'nathan.fish';
const hashedScript = z.string().regex(/^\/assets\/[a-z-]+-[A-Z0-9]{8}\.js$/);
const Build = z.object({
  gpu: z.string().default(''),
  mode: z.literal('production'), buildId: z.string(), app: hashedScript, gallery: hashedScript, scenes: hashedScript,
  workers: z.object({ sequence: hashedScript, decode: hashedScript, gif: hashedScript, face: hashedScript }),
  devPages: z.record(z.string(), z.never()), devWorkers: z.record(z.string(), z.never()),
  ort: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), dir: z.string(), files: z.array(z.string()) }),
  files: z.array(z.string()),
});
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MESH_PART_BYTES = 16 * 1024 * 1024;
const Chunks = z.object({
  version: z.literal(1), bytes: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parts: z.array(z.string().regex(/^field\.mesh\.(0|[1-9]\d*)$/)).min(1),
}).strict();

export async function lockedFiles() {
  const parsed = parseLock(JSON.parse(await readFile(path.join(ROOT, 'models.lock.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.error);
  return Object.values(parsed.value.lock.models).flatMap((model) => model.files);
}

export async function verifiedModels() {
  const files = await lockedFiles();
  for (const file of files) {
    const local = path.join(ROOT, file.served.slice(1));
    if (!(await lstat(local)).isFile()) throw new Error(`${file.served}: expected a regular file`);
    const bytes = await readFile(local);
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`${file.served}: differs from models.lock.json`);
  }
  return files;
}

export async function inventory(dir, prefix = '') {
  if (!(await lstat(dir)).isDirectory()) throw new Error(`Refusing non-directory or symlink: ${dir}`);
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${name}`);
    if (entry.isDirectory()) files.push(...await inventory(path.join(dir, entry.name), `${name}/`));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Refusing non-file: ${name}`);
  }
  return files.sort();
}

/** Validate the closed production inventory before touching prepared output. */
export async function productionInventory(source) {
  if (!(await lstat(source)).isDirectory()) throw new Error('Production build must be a regular directory.');
  const actual = await inventory(source);
  for (const file of actual) {
    if ((await lstat(path.join(source, file))).size > MAX_FILE_BYTES) throw new Error(`${file} exceeds the 25 MiB hosted file limit; refusing to publish.`);
  }
  const info = Build.parse(JSON.parse(await readFile(path.join(source, 'build.json'), 'utf8')));
  const ortFiles = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  if (info.ort.dir !== `/vendor/ort/${info.ort.version}/` || JSON.stringify([...info.ort.files].sort()) !== JSON.stringify([...ortFiles].sort())) throw new Error('Unexpected ORT runtime inventory.');
  const assets = [...new Set([
    'index.html', 'gallery.html', 'scenes.html', 'build.json', 'manifest.webmanifest', 'icon.svg',
    'assets-static/app.css', 'assets-static/sample.jpg', info.app.slice(1), info.gallery.slice(1), info.scenes.slice(1),
    ...Object.values(info.workers).map((value) => value.slice(1)),
    ...ortFiles.map((name) => `${info.ort.dir.slice(1)}${name}`),
    ...(info.files.includes('assets-static/scenes.css') ? ['assets-static/scenes.css'] : []),
    ...['field.json', 'field.chunks.json', 'highland-field.png', 'highland-field.png.json'].map(name => `assets-static/scenes/highland-field/${name}`),
    ...['geometry.bin', 'scene.json', 'lantern-court.png', 'lantern-court.png.json',
      ...['neutral', 'left', 'right', 'up', 'down'].flatMap(name => [`${name}.webp`, `${name}.webp.json`]),
    ].map(name => `assets-static/scenes/lantern-court/${name}`),
  ])];
  const landscape = path.join(source, 'assets-static/scenes/highland-field');
  const chunks = Chunks.parse(JSON.parse(await readFile(path.join(landscape, 'field.chunks.json'), 'utf8')));
  const parts = chunks.parts.map((_, i) => `field.mesh.${i}`);
  if (chunks.parts.length !== Math.ceil(chunks.bytes / MESH_PART_BYTES) || JSON.stringify(chunks.parts) !== JSON.stringify(parts)) throw new Error('Unexpected landscape chunk inventory.');
  assets.push(...parts.map(name => `assets-static/scenes/highland-field/${name}`));
  assets.sort();
  if (JSON.stringify(assets) !== JSON.stringify(actual) || JSON.stringify(assets) !== JSON.stringify([...info.files].sort())) throw new Error('Production build contains unexpected or missing files; refusing to publish.');
  const hash = createHash('sha256');
  for (const [i, part] of parts.entries()) {
    const bytes = await readFile(path.join(landscape, part));
    if (bytes.length !== Math.min(MESH_PART_BYTES, chunks.bytes - i * MESH_PART_BYTES)) throw new Error(`${part}: unexpected landscape chunk size.`);
    hash.update(bytes);
  }
  if (hash.digest('hex') !== chunks.sha256) throw new Error('Landscape chunks differ from their SHA-256 manifest.');
  return { info, assets };
}

export async function prepare({ source = path.join(ROOT, 'build/production'), output = OUTPUT, state = STATE } = {}) {
  const { info, assets } = await productionInventory(source);
  const gpu = gpuUrl(process.env.NOISY_GPU_URL ?? info.gpu);
  const contract = gpuHeaders(await loadHeaderContract(path.join(ROOT, 'headers.json')), gpu);
  const routes = Object.fromEntries(['/', ...assets.map((name) => `/${name}`)].map((url) => [url, { kind: 'asset', headers: expectedHeaders(contract, url) }]));
  for (const file of await lockedFiles()) routes[file.served] = { kind: 'model', key: path.basename(file.served), bytes: file.bytes, headers: expectedHeaders(contract, file.served) };
  // The shared project store and the public gallery stay offline until owner access exists.
  const config = { routes, errors: { ...expectedHeaders(contract, '/', { status: 404 }), 'Content-Type': 'text/plain; charset=utf-8' }, store: 'offline' };
  // This directory is generated exclusively by this command, never a source tree.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const asset of assets) {
    await mkdir(path.dirname(path.join(output, asset)), { recursive: true });
    await cp(path.join(source, asset), path.join(output, asset));
  }
  await writeFile(path.join(output, 'build.json'), JSON.stringify({ ...JSON.parse(await readFile(path.join(source, 'build.json'), 'utf8')), gpu, headers: contract }, null, 2));
  await writeFile(path.join(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude: [] }));
  await build({
    stdin: { contents: `import { createHandler } from './worker.ts'; export default createHandler(${JSON.stringify(config)});`, resolveDir: path.join(ROOT, 'tools/cloudflare'), sourcefile: 'hosting-entry.ts', loader: 'ts' },
    outfile: path.join(output, '_worker.js'), bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: false,
  });
  await mkdir(state, { recursive: true, mode: 0o700 });
  const hashes = {};
  for (const name of await inventory(output)) {
    if ((await lstat(path.join(output, name))).size > MAX_FILE_BYTES) throw new Error(`${name} exceeds the 25 MiB hosted file limit; refusing to publish.`);
    hashes[name] = createHash('sha256').update(await readFile(path.join(output, name))).digest('hex');
  }
  await writeFile(path.join(state, 'prepared.json'), JSON.stringify({ buildId: info.buildId, files: hashes }, null, 2));
  console.log(`Prepared ${assets.length} public files and the routing worker for ${info.buildId}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepare();
