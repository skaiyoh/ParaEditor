// Smoke test: headers.json names the isolation headers and the CSP
// (docs/ARCHITECTURE.md, "Response-header contract"). The dev server's
// behavior against the same file is checked end to end in serve.test.ts.

import { readFile, rm } from 'node:fs/promises';
import { runTool, startServer, tempDir } from './support/cli.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { foreignRequests } from './browser/driver/run.ts';

const Contract = z.object({ all: z.record(z.string(), z.string()) });
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com; worker-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self' https://cloudflareinsights.com";

test('headers.json names COOP, COEP, and the CSP', async () => {
  const contract = Contract.parse(JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')));
  assert.equal(contract.all['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(contract.all['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(contract.all['Content-Security-Policy'], CSP);
});

for (const mode of ['dev', 'production']) test(`gallery page aliases use HTML, no-cache and the unchanged CSP in ${mode}`, async () => {
  const dir = await tempDir('gallery-headers');
  try {
    const built = await runTool('tools/build.mjs', ['--mode', mode, '--outdir', `${dir}/build`, '--gpu', '']);
    assert.equal(built.code, 0, built.stderr);
    const server = await startServer(['--mode', mode, '--root', `${dir}/build`]);
    try {
      const html = await readFile(`${dir}/build/gallery.html`, 'utf8');
      for (const page of ['gallery', 'gallery/', 'gallery.html', 'gallery/00000000-0000-4000-8000-000000000001']) {
        const response = await fetch(`${server.url}${page}`);
        assert.equal(response.status, 200, page);
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.equal(response.headers.get('cache-control'), 'no-cache');
        assert.equal(response.headers.get('content-security-policy'), CSP);
        assert.equal(await response.text(), html);
      }
      for (const page of ['gallery/not-a-piece', 'gallery/00000000-0000-4000-8000-000000000001/extra']) {
        assert.equal((await fetch(`${server.url}${page}`)).status, 404);
      }
    } finally { await server.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser foreign-request guard admits only the configured GPU origin and analytics', () => {
  const origin = 'http://127.0.0.1:8790';
  const requests = [origin, 'https://static.cloudflareinsights.com', 'https://cloudflareinsights.com', 'https://gpu.nathan.fish', 'https://other.nathan.fish'].map((url) => ({
    url: `${url}/v1/health`, method: 'GET', resourceType: 'Fetch', context: 'page' as const, status: 200, failed: null,
  }));
  assert.deepEqual(foreignRequests(requests, origin).map((r) => r.url), requests.slice(3).map((r) => r.url));
  assert.deepEqual(foreignRequests(requests, origin, 'https://gpu.nathan.fish/base').map((r) => r.url), [requests[4]?.url]);
  assert.deepEqual(foreignRequests(requests, origin, '/dev/gpu').map((r) => r.url), requests.slice(3).map((r) => r.url));
});

test('deployment workflow tests a GPU-free build and carries the public GPU Actions variable into the deployed build', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const step = (name: string): string => workflow.split(`- name: ${name}\n`)[1]?.split('\n      - ')[0] ?? '';
  // The tests check the GPU-free header contract, so the tested builds carry no GPU URL.
  assert.doesNotMatch(step('Build development and production'), /NOISY_GPU_URL/);
  // The deployed production build and its preparation both carry the configured URL.
  for (const name of ['Build production with the GPU URL', 'Deploy and verify Cloudflare']) {
    assert.match(step(name), /NOISY_GPU_URL: \$\{\{ vars\.NOISY_GPU_URL \}\}/);
  }
  assert.ok(workflow.indexOf('- name: Build production with the GPU URL') > workflow.indexOf('- name: Test without Chrome'), 'the GPU build follows the tests');
  assert.ok(workflow.indexOf('- name: Build production with the GPU URL') < workflow.indexOf('- name: Deploy and verify Cloudflare'), 'the GPU build precedes the deploy');
  assert.doesNotMatch(workflow, /secrets\.NOISY_GPU_URL/);
});

// Exercise the build and serving policy together; a URL path never widens CSP
// beyond its origin, and an empty GPU keeps the source policy byte-for-byte.

for (const gpu of ['', 'https://gpu.nathan.fish/base']) test(`built CSP and HTTP headers with gpu=${JSON.stringify(gpu)}`, async () => {
  const dir = await tempDir('gpu-headers');
  try {
    const built = await runTool('tools/build.mjs', ['--mode', 'production', '--outdir', `${dir}/build`, '--gpu', gpu]);
    assert.equal(built.code, 0, built.stderr);
    const meta = z.object({ gpu: z.string(), headers: Contract }).parse(JSON.parse(await readFile(`${dir}/build/build.json`, 'utf8')));
    const expected = gpu === '' ? CSP : `${CSP} https://gpu.nathan.fish`;
    assert.equal(meta.gpu, gpu);
    assert.equal(meta.headers.all['Content-Security-Policy'], expected);
    const server = await startServer(['--mode', 'production', '--root', `${dir}/build`]);
    try {
      const response = await fetch(server.url);
      assert.equal(response.headers.get('Content-Security-Policy'), expected);
      assert.equal((await fetch(`${server.url}dev/gpu/v1/health`)).status, 404);
    } finally { await server.stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GPU configuration rejects CSP injection and non-HTTP URLs before writing', async () => {
  const dir = await tempDir('gpu-invalid');
  try {
    for (const gpu of ['https://gpu.nathan.fish/; connect-src *', 'data:text/plain,gpu', 'https://user:password@gpu.nathan.fish', 'https://*.nathan.fish']) {
      const built = await runTool('tools/build.mjs', ['--outdir', `${dir}/build`, '--gpu', gpu]);
      // A semicolon in a URL path is valid, but only its origin enters CSP.
      if (gpu.startsWith('https://gpu.nathan.fish/')) {
        assert.equal(built.code, 0, built.stderr);
        const meta = z.object({ headers: Contract }).parse(JSON.parse(await readFile(`${dir}/build/build.json`, 'utf8')));
        assert.equal(meta.headers.all['Content-Security-Policy'], `${CSP} https://gpu.nathan.fish`);
      } else assert.equal(built.code, 1, built.stderr);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
