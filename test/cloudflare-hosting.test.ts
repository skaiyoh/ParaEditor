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

test('an offline store answers the editor probe with 204, refuses every other store and gallery request with 404, and never reads the environment', async () => {
  // Any binding read, PROJECTS and NEON_DATABASE_URL included, would mean a handler was reached.
  const untouched = new Proxy({}, { get(_target, key) { throw new Error(`The offline store read env.${String(key)}.`); } }) as HostingEnv;
  const { 'Content-Type': _html, ...probeHeaders } = config.routes['/'].headers;
  for (const path of ['/api/projects', '/api/%70rojects']) {
    const probe = await request(path, undefined, untouched);
    assert.equal(probe.status, 204, path); assert.equal(await probe.text(), ''); headers(probe, probeHeaders);
    assert.equal(probe.headers.get('Content-Type'), null);
  }
  const id = '00000000-0000-4000-8000-000000000001';
  const projects = ['/api/projects', `/api/projects/${id}`, `/api/projects/${id}/scene`, `/api/projects/${id}/photo`, `/api/%70rojects/${id}/scene`, '/api/projects%ZZ', '/api/projectsX'];
  const gallery = ['/api/gallery', `/api/gallery/${id}`, `/api/gallery/${id}/poster`, `/api/gallery/${id}/publish`, '/api/%67allery', '/api/gallery/%ZZ'];
  for (const path of [...projects, ...gallery]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      if (method === 'GET' && path === '/api/projects') continue;
      const response = await request(path, { method, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) }, untouched);
      assert.equal(response.status, 404, `${method} ${path}`);
      headers(response, { ...config.errors, 'Content-Type': 'application/json' });
      const sentence = gallery.includes(path) ? 'The gallery is offline.' : 'The project store is offline.';
      assert.equal(await response.text(), method === 'HEAD' ? '' : `${JSON.stringify({ error: sentence })}\n`, `${method} ${path}`);
    }
  }
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

// A fake ASSETS binding that validates like Pages: a stored strong ETag, 304 when
// If-None-Match matches (weakly) or is "*", and 304 for any If-Modified-Since.
function validatingAssets(etag: string, seen: Request[] = []): HostingEnv['ASSETS'] {
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  return {
    async fetch(request) {
      seen.push(request);
      const none = request.headers.get('If-None-Match');
      const matches = none !== null && none.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
      if (matches || request.headers.has('If-Modified-Since')) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(request.method === 'HEAD' ? null : 'asset-body', { headers: { ETag: etag, 'Cache-Control': 'public, max-age=0' } });
    },
  };
}
const policyHeaders: Readonly<Record<string, string>> = { ...contract.all, 'Cache-Control': 'no-cache', 'Content-Type': 'image/jpeg' };
const policyHandler = createHandler({
  routes: {
    '/a.jpg': { kind: 'asset', headers: policyHeaders },
    '/same.jpg': { kind: 'asset', headers: { ...policyHeaders } },
    '/other.jpg': { kind: 'asset', headers: { ...policyHeaders, 'Content-Security-Policy': `${policyHeaders['Content-Security-Policy']} https://gpu.nathan.fish` } },
  },
  errors: config.errors,
});
const policyRequest = (path: string, init?: RequestInit, assets: HostingEnv['ASSETS'] = validatingAssets('"abc123"')): Promise<Response> =>
  policyHandler.fetch(new Request(`https://example.test${path}`, init), { ...env, ASSETS: assets });
const tagOf = (response: Response): string => {
  const match = /^"abc123-([0-9a-f]+)"$/.exec(response.headers.get('ETag') ?? '');
  assert.ok(match?.[1] !== undefined, `tagged ETag, got ${response.headers.get('ETag')}`);
  return match[1];
};

test('asset validators carry the header policy, so a policy change forces a full response', async () => {
  const first = await policyRequest('/a.jpg');
  assert.equal(first.status, 200); assert.equal(await first.text(), 'asset-body'); headers(first, policyHeaders);
  const tag = tagOf(first);
  // An edge entry stored before the policy existed holds the untagged ETag from ASSETS.
  const stale = await policyRequest('/a.jpg', { headers: { 'If-None-Match': '"abc123"' } });
  assert.equal(stale.status, 200); assert.equal(await stale.text(), 'asset-body'); headers(stale, policyHeaders); assert.equal(tagOf(stale), tag);
  // An entry for a different policy is stale too.
  const other = await policyRequest('/a.jpg', { headers: { 'If-None-Match': `"abc123-${tagOf(await policyRequest('/other.jpg'))}"` } });
  assert.equal(other.status, 200); assert.equal(await other.text(), 'asset-body');
  const current = await policyRequest('/a.jpg', { headers: { 'If-None-Match': `"abc123-${tag}"` } });
  assert.equal(current.status, 304); assert.equal(await current.text(), ''); headers(current, policyHeaders); assert.equal(current.headers.get('ETag'), `"abc123-${tag}"`);
});

test('asset policy tags are deterministic per header map and differ between maps', async () => {
  const [a, same, other, again] = await Promise.all(['/a.jpg', '/same.jpg', '/other.jpg', '/a.jpg'].map(async (path) => tagOf(await policyRequest(path))));
  assert.equal(a, same); assert.equal(a, again); assert.notEqual(a, other);
});

test('asset validators keep W/ and translate only the current tag out of a list', async () => {
  const tag = tagOf(await policyRequest('/a.jpg'));
  const weak = await policyRequest('/a.jpg', { headers: { 'If-None-Match': `W/"abc123-${tag}"` } }, validatingAssets('W/"abc123"'));
  assert.equal(weak.status, 304); assert.equal(weak.headers.get('ETag'), `W/"abc123-${tag}"`); headers(weak, policyHeaders);
  const seen: Request[] = [];
  const list = await policyRequest('/a.jpg', { headers: { 'If-None-Match': `"old", W/"abc123-${tag}", "abc123-ffffffff"` } }, validatingAssets('"abc123"', seen));
  assert.equal(list.status, 304); assert.equal(seen[0]?.headers.get('If-None-Match'), 'W/"abc123"');
});

test('asset requests drop If-Modified-Since, pass * and translate If-Range for the current tag only', async () => {
  const tag = tagOf(await policyRequest('/a.jpg'));
  const seen: Request[] = [];
  const since = await policyRequest('/a.jpg', { headers: { 'If-Modified-Since': 'Sat, 10 Oct 2026 12:00:00 GMT' } }, validatingAssets('"abc123"', seen));
  assert.equal(since.status, 200); assert.equal(await since.text(), 'asset-body'); assert.equal(seen[0]?.headers.has('If-Modified-Since'), false);
  const star = await policyRequest('/a.jpg', { headers: { 'If-None-Match': '*' } }, validatingAssets('"abc123"', seen));
  assert.equal(star.status, 304); assert.equal(seen[1]?.headers.get('If-None-Match'), '*'); headers(star, policyHeaders);
  await policyRequest('/a.jpg', { headers: { Range: 'bytes=0-1', 'If-Range': `"abc123-${tag}"` } }, validatingAssets('"abc123"', seen));
  assert.equal(seen[2]?.headers.get('If-Range'), '"abc123"');
  await policyRequest('/a.jpg', { headers: { Range: 'bytes=0-1', 'If-Range': '"abc123-ffffffff"' } }, validatingAssets('"abc123"', seen));
  assert.equal(seen[3]?.headers.get('If-Range'), '"abc123-ffffffff"');
  await policyRequest('/a.jpg', { headers: { Range: 'bytes=0-1', 'If-Range': 'Sat, 10 Oct 2026 12:00:00 GMT' } }, validatingAssets('"abc123"', seen));
  assert.equal(seen[4]?.headers.get('If-Range'), 'Sat, 10 Oct 2026 12:00:00 GMT');
});

test('asset HEAD keeps the route headers and tagged ETag without a body', async () => {
  const tag = tagOf(await policyRequest('/a.jpg'));
  const head = await policyRequest('/a.jpg', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); headers(head, policyHeaders); assert.equal(tagOf(head), tag);
  const stale = await policyRequest('/a.jpg', { method: 'HEAD', headers: { 'If-None-Match': '"abc123"' } });
  assert.equal(stale.status, 200); assert.equal(await stale.text(), '');
  const current = await policyRequest('/a.jpg', { method: 'HEAD', headers: { 'If-None-Match': `"abc123-${tag}"` } });
  assert.equal(current.status, 304); assert.equal(await current.text(), '');
});
