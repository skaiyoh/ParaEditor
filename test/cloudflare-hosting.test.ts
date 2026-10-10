import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from '../src/core/zod.ts';
import { createHandler } from '../tools/cloudflare/worker.ts';
import type { HostingConfig, HostingEnv } from '../tools/cloudflare/worker.ts';

const contract = z.object({ all: z.record(z.string(), z.string()), errors: z.record(z.string(), z.string()) }).parse(
  JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')),
);
const modelHeaders = { ...contract.all, 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' };
const config = {
  routes: {
    '/': { kind: 'asset', headers: { ...contract.all, 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' } },
    '/index.html': { kind: 'asset', headers: { ...contract.all, 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' } },
    '/models/test-12345678.onnx': { kind: 'model', key: 'test-12345678.onnx', bytes: 10, headers: modelHeaders },
  },
  errors: { ...contract.all, ...contract.errors, 'Content-Type': 'text/plain; charset=utf-8' },
} satisfies HostingConfig;
const handler = createHandler(config);
const bytes = new TextEncoder().encode('0123456789');
const info = { size: 10, httpEtag: '"locked"', uploaded: new Date('2026-10-10T12:00:00Z') };
const env: HostingEnv = {
  ASSETS: { async fetch(request) { return new Response(`asset:${new URL(request.url).pathname}`); } },
  MODELS: {
    async head() { return info; },
    async get(_key, options) {
      const range = options?.range;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(range === undefined ? bytes : bytes.slice(range.offset, range.offset + range.length));
        controller.close();
      } });
      return { ...info, body };
    },
  },
};
const request = (path: string, init?: RequestInit, environment = env): Promise<Response> => handler.fetch(new Request(`https://example.test${path}`, init), environment);
function headers(response: Response, expected: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(expected)) assert.equal(response.headers.get(name), value, name);
}

for (const gpu of ['', 'https://gpu.nathan.fish/base']) test(`prepared hosting verifier uses the configured GPU policy: ${JSON.stringify(gpu)}`, async () => {
  // Execute the dependency-free JS verifier at its real boundary, then parse
  // the returned policy before giving it to the TypeScript hosting handler.
  const script = `
    import assert from 'node:assert/strict';
    import { gpuHeaders } from './tools/build.mjs';
    import { loadHeaderContract, expectedHeaders } from './tools/headers.mjs';
    import { preparedHeaderContract } from './tools/cloudflare/verify.mjs';
    const source = await loadHeaderContract('headers.json'), gpu = ${JSON.stringify(gpu)};
    const prepared = { gpu, headers: gpuHeaders(source, gpu) };
    const checked = preparedHeaderContract(prepared, source);
    assert.throws(() => preparedHeaderContract({ ...prepared, headers: { ...checked, all: { ...checked.all, 'Content-Security-Policy': 'connect-src *' } } }, source), /Prepared build header contract/);
    console.log(JSON.stringify({ all: checked.all, headers: expectedHeaders(checked, '/'), errors: expectedHeaders(checked, '/', { status: 404 }), source: source.all }));
  `;
  const stringMap = z.record(z.string(), z.string());
  const checked = z.object({ all: stringMap, headers: stringMap, errors: stringMap, source: stringMap }).parse(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('../', import.meta.url) }).toString()));
  const hosted = createHandler({ routes: { '/': { kind: 'asset', headers: checked.headers } }, errors: checked.errors });
  for (const url of ['/', '/missing']) {
    const response = await hosted.fetch(new Request(`https://example.test${url}`), env);
    assert.equal(response.headers.get('Content-Security-Policy'), checked.all['Content-Security-Policy']);
  }
  assert.equal(checked.all['Content-Security-Policy'], `${contract.all['Content-Security-Policy']}${gpu === '' ? '' : ' https://gpu.nathan.fish'}`);
  assert.deepEqual(checked.source, contract.all);
});

test('hosting serves direct index.html and limits paths and methods before calling storage', async () => {
  const index = await request('/index.html');
  assert.equal(index.status, 200); assert.equal(await index.text(), 'asset:/'); headers(index, config.routes['/index.html'].headers);
  for (const path of ['/dev/fault', '/%64ev/fault', '/api/log', '/models/unknown.onnx', '/.local/cloudflare.env', '/toString']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await request(path, { method });
      assert.equal(response.status, 404); headers(response, config.errors);
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
  }
  const method = await request('/', { method: 'POST' });
  assert.equal(method.status, 405); assert.equal(method.headers.get('Allow'), 'GET, HEAD'); headers(method, config.errors);
});

test('hosting streams full and resumed model bytes, with HEAD and inclusive ranges', async () => {
  const full = await request('/models/test-12345678.onnx');
  assert.equal(full.status, 200); assert.equal(await full.text(), '0123456789'); headers(full, modelHeaders);
  for (const [range, body, contentRange] of [
    ['bytes=3-', '3456789', 'bytes 3-9/10'], ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10'],
  ]) {
    const response = await request('/models/test-12345678.onnx', { headers: { Range: range ?? '' } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(body?.length)); assert.equal(await response.text(), body); headers(response, modelHeaders);
  }
  let reads = 0;
  const head = await request('/models/test-12345678.onnx', { method: 'HEAD', headers: { Range: 'bytes=3-' } }, {
    ...env, MODELS: { ...env.MODELS, async get() { reads++; throw new Error('HEAD must not read a body'); } },
  });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), '10'); assert.equal(await head.text(), ''); assert.equal(reads, 0);
});

test('hosting returns 416 without model reads and safely ignores malformed or multiple ranges', async () => {
  for (const value of ['bytes=10-', 'bytes=5-3', 'bytes=-0']) {
    const response = await request('/models/test-12345678.onnx', { headers: { Range: value } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */10'); headers(response, config.errors);
  }
  for (const value of ['bytes=abc', 'bytes=0-1,3-4', 'bytes=-', 'bytes=999999999999999999999-']) {
    const response = await request('/models/test-12345678.onnx', { headers: { Range: value } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  }
  for (const ifRange of ['"other"', 'W/"locked"', 'Sat, 10 Oct 2026 11:00:00 GMT', 'Sat, 10 Oct 2026 13:00:00 GMT']) {
    const response = await request('/models/test-12345678.onnx', { headers: { Range: 'bytes=3-', 'If-Range': ifRange } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  }
  const unchanged = await request('/models/test-12345678.onnx', { headers: { Range: 'bytes=3-', 'If-Range': info.httpEtag } });
  assert.equal(unchanged.status, 206); assert.equal(await unchanged.text(), '3456789');
  const sameSecond = await request('/models/test-12345678.onnx', { headers: { Range: 'bytes=3-', 'If-Range': info.uploaded.toUTCString() } }, {
    ...env, MODELS: { ...env.MODELS, async head() { return { ...info, uploaded: new Date('2026-10-10T12:00:00.500Z') }; } },
  });
  assert.equal(sameSecond.status, 206); assert.equal(await sameSecond.text(), '3456789');
});

test('hosting handles missing, wrong-sized, changing and failed R2 objects with safe error headers', async () => {
  const cases: readonly { status: number; bucket: HostingEnv['MODELS'] }[] = [
    { status: 404, bucket: { ...env.MODELS, async head() { return null; } } },
    { status: 404, bucket: { ...env.MODELS, async get() { return null; } } },
    { status: 503, bucket: { ...env.MODELS, async head() { return { ...info, size: 9 }; } } },
    { status: 503, bucket: { ...env.MODELS, async head() { throw new Error('private storage detail'); } } },
    { status: 503, bucket: { ...env.MODELS, async get() { throw new Error('private storage detail'); } } },
    { status: 503, bucket: { ...env.MODELS, async get() { return { ...info, httpEtag: '"changed"', body: new ReadableStream<Uint8Array>() }; } } },
  ];
  for (const item of cases) {
    const response = await request('/models/test-12345678.onnx', undefined, { ...env, MODELS: item.bucket });
    assert.equal(response.status, item.status); headers(response, config.errors);
    assert.ok(!(await response.text()).includes('private storage detail'));
  }
  const failedAsset = await request('/', { method: 'HEAD' }, { ...env, ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } } });
  assert.equal(failedAsset.status, 404); assert.equal(await failedAsset.text(), ''); headers(failedAsset, config.errors);
});
