// The bundle guard: a production build of src/ carries no dev-only surface,
// no dev page or dev route, and no console reference in any bundle esbuild wrote,
// and its vendored runtime files are the pinned package's own bytes. Each
// check is shown failing on output that breaks it.

import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as esbuild from 'esbuild';
import { z } from 'zod';
import { checkBundle, checkProductionBuild } from './support/bundle-guard.ts';
import { REPO, runTool, tempDir, writeTree } from './support/cli.ts';

let scratch = '';
before(async () => {
  scratch = await tempDir('guard');
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test('a production build of src/ passes the bundle guard', async () => {
  const outdir = path.join(scratch, 'production');
  const run = await runTool('tools/build.mjs', ['--mode', 'production', '--outdir', outdir]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(await checkProductionBuild(outdir), []);
  assert.deepEqual(await readFile(path.join(outdir, 'assets-static/sample.jpg')), await readFile(path.join(REPO, 'src/assets/sample.jpg')),
    'production carries the sample at its stable URL, byte for byte');
});

test('both build modes copy nested static assets unchanged at stable paths', async () => {
  const src = path.join(scratch, 'static-source');
  await writeTree(src, {
    'main.tsx': 'export const app = true;',
    'analysis/sequence-worker.ts': 'export const sequence = true;',
    'analysis/decode-worker.ts': 'export const decode = true;',
    'analysis/face-worker.ts': 'export const face = true;',
    'export/gif-worker.ts': 'export const gif = true;',
    'index.html': '<script type="module" src="%NOISY_APP%"></script>',
    'manifest.webmanifest': '{}',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/nested/font.woff2': 'placeholder font bytes',
    'assets/look.css': 'body { color: red; }',
  });
  for (const mode of ['dev', 'production']) {
    const outdir = path.join(scratch, `static-${mode}`);
    const run = await runTool('tools/build.mjs', ['--mode', mode, '--src', src, '--outdir', outdir]);
    assert.equal(run.code, 0, run.stderr);
    for (const file of ['nested/font.woff2', 'look.css']) {
      assert.deepEqual(await readFile(path.join(outdir, 'assets-static', file)), await readFile(path.join(src, 'assets', file)));
    }
    const { files } = z.object({ files: z.array(z.string()) }).parse(JSON.parse(await readFile(path.join(outdir, 'build.json'), 'utf8')));
    assert.ok(files.includes('assets-static/nested/font.woff2'));
    assert.ok(files.includes('assets-static/look.css'));
  }
});

test('the same source built for dev carries the test surface, so the guard is looking at something real', async () => {
  const outdir = path.join(scratch, 'dev');
  const run = await runTool('tools/build.mjs', ['--mode', 'dev', '--outdir', outdir]);
  assert.equal(run.code, 0, run.stderr);
  const { app } = z.object({ app: z.string() }).parse(JSON.parse(await readFile(path.join(outdir, 'build.json'), 'utf8')));
  const text = await readFile(path.join(outdir, app), 'utf8');
  assert.ok(text.includes('__noisyTest'), 'the dev bundle installs window.__noisyTest');
  const problems = (await checkProductionBuild(outdir)).map((f) => `${f.file}: ${f.problem}`);
  assert.ok(problems.some((p) => p.startsWith(`${app.slice(1)}: names the dev-only "__noisyTest"`)), problems.join('\n'));
  assert.ok(problems.some((p) => p === 'dev/threads.html: a dev page in a production build'), problems.join('\n'));
});

test("the guard reports a bundle of mediabunny made without drop: ['console']", async (t) => {
  // The probe bundles the pinned package as the production build would, minified, but without the drop.
  const outdir = path.join(scratch, 'mediabunny-probe');
  const result = await esbuild.build({
    stdin: { contents: 'import * as mediabunny from "mediabunny";\nObject.assign(globalThis, { mediabunny });\n', resolveDir: REPO, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    minify: true,
    outfile: path.join(outdir, 'assets', 'probe.js'),
    logLevel: 'silent',
  });
  assert.deepEqual(result.errors, []);
  const text = await readFile(path.join(outdir, 'assets', 'probe.js'), 'utf8');
  const findings = checkBundle('assets/probe.js', text);
  const consoleFinding = findings.find((f) => /^\d+ console references: /.test(f.problem));
  assert.ok(consoleFinding !== undefined, JSON.stringify(findings));
  assert.ok(Number.parseInt(consoleFinding.problem, 10) >= 1);
  t.diagnostic(`${consoleFinding.file}: ${consoleFinding.problem}`);
  // The same check over a whole output directory finds it too.
  assert.deepEqual(await checkProductionBuild(outdir), findings);
});

test("the guard reports console references that drop: ['console'] leaves in place", async () => {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export function report(e: unknown): void { const { log } = console; log("e", e); }',
        'export function warn(e: unknown): void { console?.warn("w", e); }',
        'export function dropped(e: unknown): void { console.error(e); }',
        'export const notTheGlobal = (o: { console: number }): number => o.console;',
      ].join('\n'),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    minify: true,
    drop: ['console', 'debugger'],
    write: false,
    logLevel: 'silent',
  });
  const text = result.outputFiles[0]?.text ?? '';
  // esbuild drops `console?.warn(...)` and `console.error(...)` but keeps the destructuring.
  assert.deepEqual(checkBundle('probe.js', text), [{ file: 'probe.js', problem: '1 console references: console' }], text);
  // Every form, as an undropped bundle would carry it.
  assert.deepEqual(checkBundle('qualified.js', 'window.console.log(1);globalThis?.console.warn(2);self.console["info"](3);x.window.console;'), [
    { file: 'qualified.js', problem: '3 console references: window.console.log, globalThis?.console.warn, self.console[' },
  ]);
  assert.deepEqual(checkBundle('raw.js', 'console?.warn(1);console . log(2);console["info"](3);(0,console.debug)(4);x.console;consoleLike();'), [
    { file: 'raw.js', problem: '4 console references: console?.warn, console.log, console[, console.debug' },
  ]);
});

test('the guard reports a vendored runtime file that is not the pinned bytes, and a dev route named in any file', async () => {
  const outdir = path.join(scratch, 'tampered');
  const run = await runTool('tools/build.mjs', ['--mode', 'production', '--outdir', outdir]);
  assert.equal(run.code, 0, run.stderr);
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(path.join(REPO, 'node_modules/onnxruntime-web/package.json'), 'utf8')));
  const entry = path.join(outdir, 'vendor/ort', version, 'ort.wasm.min.mjs');
  await writeFile(entry, `${await readFile(entry, 'utf8')}\n// edited\n`);
  await writeTree(outdir, { 'vendor/ort/0.0.0/ort.wasm.min.mjs': '', 'index.html': '<a href="/api/log">sink</a>\n' });
  assert.deepEqual(await checkProductionBuild(outdir), [
    { file: 'index.html', problem: 'names the dev-only "/api/log"' },
    { file: 'vendor/ort/0.0.0/ort.wasm.min.mjs', problem: `vendored outside vendor/ort/${version}/, the installed onnxruntime-web's directory` },
    { file: `vendor/ort/${version}/ort.wasm.min.mjs`, problem: 'differs from node_modules/onnxruntime-web/dist/' },
  ]);
});
