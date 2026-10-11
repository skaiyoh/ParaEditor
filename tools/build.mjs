#!/usr/bin/env node
// Builds noisy's five entries with esbuild, copies the pinned ONNX Runtime
// Web files byte for byte, defines the model lock as a compile-time constant,
// and in dev mode builds the dev pages. Node 25.
//
//   node tools/build.mjs [--mode dev|production] [--outdir <dir>] [--src <dir>]
//                        [--lock <file>] [--migrations <module>]
//
// docs/ARCHITECTURE.md ("Build") documents the flags, the output layout, the
// build id, the compile-time constants, the vendored runtime, and dev pages.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const META = 'build.json';
const WORKERS = {
  sequence: 'analysis/sequence-worker.ts',
  decode: 'analysis/decode-worker.ts',
  gif: 'export/gif-worker.ts',
  face: 'analysis/face-worker.ts',
};
const APP = 'main.tsx';
const GALLERY = 'gallery.ts';
const GALLERY_FIXTURE = 'dev/gallery-fixture.ts';
const STATIC = ['manifest.webmanifest', 'icon.svg'];
const MIGRATE = 'core/migrate.ts';
/** The directory under --src whose pages and workers only a dev build writes. */
const DEV = 'dev';
/**
 * ONNX Runtime Web's plain wasm build: the entry, the Emscripten glue it
 * imports (which also runs as each pthread worker's script), and the threaded
 * wasm the glue loads. Copied, never bundled or edited.
 */
const ORT_PACKAGE = path.join(REPO, 'node_modules', 'onnxruntime-web');
const ORT_FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
/** The default model lock. Every entry may read it as NOISY_MODEL_LOCK; esbuild writes it only into a bundle that does, through analysis/bundled-lock.ts. */
const MODEL_LOCK = path.join(REPO, 'models.lock.json');
/** The import specifier sources use for the vendored runtime's entry. */
const ORT_SPECIFIER = 'noisy:vendor-ort';

const USAGE = `usage: node tools/build.mjs [--mode dev|production] [--outdir <dir>] [--src <dir>] [--lock <file>] [--migrations <module>]
  --mode        dev (default): sourcemaps, no minify, NOISY_DEV true
                production: minified, console and debugger dropped, NOISY_DEV false
  --outdir      output directory (default build/<mode>); replaced whole on success
  --src         source root holding main.tsx, the worker entries, index.html, and dev/ (default src)
  --lock        the model lock the bundles carry as NOISY_MODEL_LOCK (default models.lock.json)
  --gpu         analysis service base URL (default NOISY_GPU_URL or empty)
  --migrations  dev only: a module that replaces <src>/core/migrate.ts`;

function die(sentence) {
  process.stderr.write(`build: ${sentence}\n`);
  process.exit(1);
}

function parseFlags() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        mode: { type: 'string', default: 'dev' },
        outdir: { type: 'string' },
        src: { type: 'string' },
        lock: { type: 'string' },
        migrations: { type: 'string' },
        gpu: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    die(`${e.message}\n${USAGE}`);
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (values.mode !== 'dev' && values.mode !== 'production') die(`--mode must be dev or production, not "${values.mode}".`);
  if (values.mode === 'production' && values.migrations !== undefined) {
    die('--migrations is a dev-only harness flag and a production build refuses it, so nothing was written.');
  }
  let gpu;
  try { gpu = gpuUrl(values.gpu ?? process.env.NOISY_GPU_URL ?? ''); } catch (error) { die(error.message); }
  return {
    mode: values.mode,
    gpu,
    outdir: path.resolve(values.outdir ?? path.join(REPO, 'build', values.mode)),
    src: path.resolve(values.src ?? path.join(REPO, 'src')),
    lock: path.resolve(values.lock ?? MODEL_LOCK),
    migrations: values.migrations === undefined ? null : path.resolve(values.migrations),
  };
}

/** '<commit>-<yyyymmdd>' (UTC build date); 'nocommit-<yyyymmdd>' when HEAD has no commit. */
function buildId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  let commit = 'nocommit';
  try {
    commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // No commit yet (or no git): keep the documented fallback.
  }
  return `${commit}-${date}`;
}

/**
 * The path as the file system stores it, symlinks resolved and, on a
 * case-insensitive file system, in its on-disk case; null when it does not exist.
 */
function onDisk(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return null;
  }
}

/**
 * esbuild plugin: every import that resolves to <src>/core/migrate.ts, however
 * it is spelled, loads `substitute` instead; `used.hit` records whether any
 * import did. Each import is resolved once more, and where it lands is
 * compared on disk, so a wrong-case spelling that macOS resolves is caught too.
 */
function migrationsPlugin(target, substitute, used) {
  const targetOnDisk = onDisk(target);
  return {
    name: 'noisy-migrations',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.noisyMigrations || targetOnDisk === null) return undefined;
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { noisyMigrations: true },
        });
        if (resolved.errors.length > 0 || resolved.path === '' || onDisk(resolved.path) !== targetOnDisk) return undefined;
        used.hit = true;
        return { path: substitute };
      });
    },
  };
}

/**
 * esbuild plugin: ORT_SPECIFIER becomes an external import of the vendored
 * entry's URL, and an import of onnxruntime-web itself that reaches resolution
 * fails the build, so the runtime is never bundled. esbuild drops an
 * `import type` statement before resolving it, so that one builds; under
 * verbatimModuleSyntax `import { type X }` stays a side-effect import and fails.
 */
function vendorOrtPlugin(entryUrl) {
  return {
    name: 'noisy-vendor-ort',
    setup(build) {
      build.onResolve({ filter: /^noisy:vendor-ort$/ }, () => ({ path: entryUrl, external: true }));
      build.onResolve({ filter: /^onnxruntime-(web|common)(\/|$)/ }, (args) => ({
        errors: [{ text: `${args.path} is never bundled; import the vendored runtime as "${ORT_SPECIFIER}"` }],
      }));
    },
  };
}

/** The pinned onnxruntime-web version, its files, and the URL directory they are served from. */
async function vendoredOrt() {
  const { version } = JSON.parse(await readFile(path.join(ORT_PACKAGE, 'package.json'), 'utf8'));
  return { version, dir: `/vendor/ort/${version}/`, files: ORT_FILES };
}

/**
 * The dev pages and dev workers under <src>/dev. Each <name>.html in dev/ is
 * a page whose script is <name>.ts or <name>.tsx beside it, and each
 * <name>-worker.ts in dev/ is a worker whose URL the pages read from
 * NOISY_DEV_WORKER_URLS[<name>]. One level of subdirectory holds pages too:
 * dev/<dir>/<name>.html with its script beside it is the page "<dir>/<name>";
 * a *-worker.ts there, or in any directory below it, fails the build rather
 * than being skipped unseen, and deeper directories are read for no page,
 * only as the modules that entries import.
 */
async function devSources(src) {
  const dir = path.join(src, DEV);
  let top;
  try {
    top = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e) {
    if (e.code === 'ENOENT') return { pages: [], workers: [] };
    throw e;
  }
  const pagesIn = (folder, names, prefix) =>
    names
      .filter((n) => n.endsWith('.html'))
      .map((n) => {
        const name = n.slice(0, -'.html'.length);
        const entry = ['.ts', '.tsx'].map((ext) => path.join(folder, `${name}${ext}`)).find((f) => existsSync(f));
        if (entry === undefined) throw new Error(`dev page ${path.join(folder, n)} has no script ${name}.ts or ${name}.tsx beside it.`);
        return { name: `${prefix}${name}`, html: path.join(folder, n), entry };
      });
  const names = top.filter((e) => !e.isDirectory()).map((e) => e.name);
  const pages = pagesIn(dir, names, '');
  const workers = names
    .filter((n) => n.endsWith('-worker.ts'))
    .map((n) => ({ name: n.slice(0, -'-worker.ts'.length), entry: path.join(dir, n) }));
  for (const sub of top.filter((e) => e.isDirectory())) {
    const folder = path.join(dir, sub.name);
    const inner = (await readdir(folder)).sort();
    const stray = (await readdir(folder, { recursive: true })).sort().find((n) => n.endsWith('-worker.ts'));
    if (stray !== undefined) throw new Error(`dev worker ${path.join(folder, stray)} is in a subdirectory of ${DEV}/, where no worker is built; dev workers live in ${DEV}/ itself.`);
    pages.push(...pagesIn(folder, inner, `${sub.name}/`));
  }
  return { pages, workers };
}

/** The model lock as JSON; the browser parses it with the lock's schema, so here it need only be JSON. */
async function modelLock(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    die(`the model lock ${file} cannot be read as JSON, so nothing was written: ${e.message}`);
  }
}

function esbuildOptions({ mode, src, migrations }, id, staging, used, ort, lock) {
  const production = mode === 'production';
  return {
    absWorkingDir: REPO,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    outdir: staging,
    entryNames: 'assets/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    chunkNames: 'assets/[name]-[hash]',
    charset: 'utf8',
    minify: production,
    sourcemap: production ? false : 'linked',
    drop: production ? ['console', 'debugger'] : [],
    metafile: true,
    logLevel: 'silent',
    plugins: [
      vendorOrtPlugin(`${ort.dir}${ORT_FILES[0]}`),
      ...(migrations === null ? [] : [migrationsPlugin(path.join(src, MIGRATE), migrations, used)]),
    ],
    define: {
      NOISY_BUILD_ID: JSON.stringify(id),
      NOISY_DEV: JSON.stringify(!production),
      NOISY_ORT_DIR: JSON.stringify(ort.dir),
      NOISY_MODEL_LOCK: JSON.stringify(lock),
    },
  };
}

/** Maps each entry point's file name (main() checks they are distinct) to its URL path. */
function entryUrls(metafile, staging) {
  const urls = {};
  for (const [file, info] of Object.entries(metafile.outputs)) {
    if (info.entryPoint) urls[path.basename(info.entryPoint)] = `/${path.relative(staging, path.resolve(REPO, file))}`;
  }
  return urls;
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])),
  );
  return nested.flat().sort();
}

/** The on-disk path of every input esbuild bundled, from its metafile. */
const bundledInputs = (metafile) => Object.keys(metafile.inputs).map((file) => onDisk(path.resolve(REPO, file)));

async function assertReplaceable(outdir) {
  let info;
  try {
    info = await stat(outdir);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    die(`--outdir ${outdir} cannot be read: ${e.message}`);
  }
  if (!info.isDirectory()) die(`--outdir ${outdir} is not a directory, so it is not a build output this tool may replace.`);
  const entries = await readdir(outdir);
  if (entries.length > 0 && !entries.includes(META)) {
    die(`${outdir} is not empty and holds no ${META}, so it is not a build output this tool may replace.`);
  }
}

async function main() {
  const flags = parseFlags();
  // Header helpers are also used by the dependency-free server.
  const esbuild = await import('esbuild');
  if (flags.migrations !== null && !existsSync(flags.migrations)) die(`--migrations module ${flags.migrations} does not exist.`);
  for (const rel of [APP, ...Object.values(WORKERS), 'index.html', ...STATIC]) {
    if (!existsSync(path.join(flags.src, rel))) die(`source ${path.join(flags.src, rel)} does not exist.`);
  }
  const staging = `${flags.outdir}.staging-${process.pid}`;
  try {
    await assertReplaceable(flags.outdir);
    // esbuild reports resolved paths with symlinks resolved (macOS's /var is
    // /private/var), so the substitution rule compares against the real path.
    flags.src = await realpath(flags.src);
    await rm(staging, { recursive: true, force: true });
  } catch (e) {
    die(`the build could not start, so nothing was written: ${e.message}`);
  }

  const id = buildId();
  const lock = await modelLock(flags.lock);
  try {
    const used = { hit: false };
    const ort = await vendoredOrt();
    const dev = flags.mode === 'dev' ? await devSources(flags.src) : { pages: [], workers: [] };
    // --src probe trees may omit the optional second page; the real source carries both files.
    const hasGallery = existsSync(path.join(flags.src, GALLERY));
    const hasFixture = hasGallery && flags.mode === 'dev' && existsSync(path.join(flags.src, GALLERY_FIXTURE));
    const extraEntries = [...(hasGallery ? [GALLERY] : []), ...(hasFixture ? [GALLERY_FIXTURE] : [])];
    const entryNames = [APP, ...extraEntries, ...Object.values(WORKERS), ...dev.pages.map((p) => p.entry), ...dev.workers.map((w) => w.entry)].map((f) => path.basename(f));
    const repeated = entryNames.find((n, i) => entryNames.indexOf(n) !== i);
    if (repeated !== undefined) throw new Error(`two entries share the file name ${repeated}, so their URLs cannot be told apart.`);
    const options = esbuildOptions(flags, id, staging, used, ort, lock);
    // Workers first, so the app and the dev pages can be told their content-hashed URLs.
    const workers = await esbuild.build({
      ...options,
      entryPoints: [...Object.values(WORKERS).map((w) => path.join(flags.src, w)), ...dev.workers.map((w) => w.entry)],
    });
    const workerOut = entryUrls(workers.metafile, staging);
    const workerUrls = Object.fromEntries(Object.entries(WORKERS).map(([key, rel]) => [key, workerOut[path.basename(rel)]]));
    const devWorkerUrls = Object.fromEntries(dev.workers.map((w) => [w.name, workerOut[path.basename(w.entry)]]));
    const app = await esbuild.build({
      ...options,
      entryPoints: [APP, ...extraEntries].map((entry) => path.join(flags.src, entry)).concat(dev.pages.map((p) => p.entry)),
      define: { ...options.define, NOISY_WORKER_URLS: JSON.stringify(workerUrls), NOISY_DEV_WORKER_URLS: JSON.stringify(devWorkerUrls) },
    });
    const appOut = entryUrls(app.metafile, staging);
    const appUrl = appOut[APP];
    if (flags.migrations !== null) {
      const real = path.join(flags.src, MIGRATE);
      if (!used.hit) throw new Error(`no import resolves to ${real}, so --migrations would substitute nothing.`);
      if ([workers, app].some((b) => bundledInputs(b.metafile).includes(onDisk(real)))) {
        throw new Error(`a bundle still holds ${real} after --migrations substituted it.`);
      }
    }

    const template = await readFile(path.join(flags.src, 'index.html'), 'utf8');
    if (!template.includes('%NOISY_APP%')) throw new Error(`${path.join(flags.src, 'index.html')} has no %NOISY_APP% placeholder.`);
    await writeFile(path.join(staging, 'index.html'), template.replaceAll('%NOISY_APP%', appUrl));
    if (hasGallery) {
      const html = await readFile(path.join(flags.src, 'gallery.html'), 'utf8');
      if (!html.includes('%NOISY_GALLERY%') || !html.includes('%NOISY_GALLERY_FIXTURE%')) throw new Error('gallery.html is missing its entry placeholders.');
      const fixture = hasFixture ? `<script type="module" src="${appOut[path.basename(GALLERY_FIXTURE)]}"></script>` : '';
      await writeFile(path.join(staging, 'gallery.html'), html.replaceAll('%NOISY_GALLERY%', appOut[GALLERY]).replaceAll('%NOISY_GALLERY_FIXTURE%', fixture));
    }
    for (const file of STATIC) await cp(path.join(flags.src, file), path.join(staging, file));
    const assets = path.join(flags.src, 'assets');
    if (existsSync(assets)) await cp(assets, path.join(staging, 'assets-static'), { recursive: true });
    const devPages = {};
    for (const page of dev.pages) {
      const html = await readFile(page.html, 'utf8');
      if (!html.includes('%NOISY_SCRIPT%')) throw new Error(`${page.html} has no %NOISY_SCRIPT% placeholder.`);
      const out = path.join(staging, DEV, `${page.name}.html`);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, html.replaceAll('%NOISY_SCRIPT%', appOut[path.basename(page.entry)]));
      devPages[page.name] = `/${DEV}/${page.name}.html`;
    }
    const ortOut = path.join(staging, ort.dir);
    await mkdir(ortOut, { recursive: true });
    for (const file of ORT_FILES) await copyFile(path.join(ORT_PACKAGE, 'dist', file), path.join(ortOut, file));

    const files = await listFiles(staging);
    const headerContract = JSON.parse(await readFile(path.join(REPO, 'headers.json'), 'utf8'));
    const meta = {
      gpu: flags.gpu,
      headers: gpuHeaders(headerContract, flags.gpu),
      mode: flags.mode,
      buildId: id,
      app: appUrl,
      ...(hasGallery ? { gallery: appOut[GALLERY] } : {}),
      workers: workerUrls,
      devPages,
      devWorkers: devWorkerUrls,
      ort,
      migrations: flags.migrations,
      files: [...files, META].sort(),
    };
    await writeFile(path.join(staging, META), `${JSON.stringify(meta, null, 2)}\n`);

    await mkdir(path.dirname(flags.outdir), { recursive: true });
    await rm(flags.outdir, { recursive: true, force: true });
    await rename(staging, flags.outdir);
    process.stdout.write(`build: ${flags.mode} ${id} -> ${flags.outdir} (${meta.files.length} files)\n`);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    const detail = e.errors?.length ? e.errors.map((m) => `${m.location?.file ?? ''}:${m.location?.line ?? ''} ${m.text}`).join('; ') : e.message;
    die(`the build failed, so nothing was written: ${detail}`);
  }
}

/** Validate configuration before it reaches a URL or a CSP directive. */
export function gpuUrl(value) {
  if (value === '') return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname.includes('*')) throw new Error('GPU URL must be an HTTP(S) base URL without credentials, query or fragment.');
  return url.href.replace(/\/$/, '');
}

/** Keep the source policy closed; admit only the configured service origin. */
export function gpuHeaders(contract, gpu) {
  const all = { ...contract.all };
  if (gpu !== '') {
    const origin = new URL(gpuUrl(gpu)).origin;
    all['Content-Security-Policy'] = all['Content-Security-Policy'].split(';').map((directive) => directive.trim().startsWith('connect-src ') ? `${directive} ${origin}` : directive).join(';');
  }
  return { ...contract, all };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
