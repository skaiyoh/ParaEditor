// Direct HTTP verification of a prepared deployment, including every model byte.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpuHeaders, gpuUrl } from '../build.mjs';
import { expectedHeaders, loadHeaderContract } from '../headers.mjs';
import { ROOT, STATE, OUTPUT, lockedFiles } from './prepare.mjs';

/** Recompute the configured policy and verify the prepared build carries it. */
export function preparedHeaderContract(build, source) {
  const contract = gpuHeaders(source, gpuUrl(build.gpu ?? ''));
  assert.deepEqual(build.headers, contract, 'Prepared build header contract');
  return contract;
}

async function verify() {
  const base = new URL(process.argv[2]);
  assert.equal(base.protocol, 'https:');
  base.pathname = '/'; base.search = ''; base.hash = '';
  const prepared = JSON.parse(await readFile(path.join(STATE, 'prepared.json'), 'utf8'));
  const build = JSON.parse(await readFile(path.join(OUTPUT, 'build.json'), 'utf8'));
  const contract = preparedHeaderContract(build, await loadHeaderContract(path.join(ROOT, 'headers.json')));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  async function transport(urlPath, init = {}) {
    return await fetch(new URL(urlPath, base), { ...init, redirect: 'manual', signal: AbortSignal.timeout(180_000) });
  }
  function checkHeaders(urlPath, response) {
    for (const [name, value] of Object.entries(expectedHeaders(contract, urlPath, { status: response.status }))) {
      if ((response.status >= 400 || urlPath.startsWith('/api/projects') || urlPath.startsWith('/api/gallery')) && name === 'Content-Type') continue;
      assert.equal(response.headers.get(name), value, `${urlPath}: ${name}`);
    }
  }
  async function request(urlPath, init = {}) {
    const response = await transport(urlPath, init);
    checkHeaders(urlPath, response);
    return response;
  }

  // The shared project store and the public gallery are offline: the editor's probe
  // gets a bodiless 204 and nothing else under either prefix reaches a handler.
  async function storeOffline() {
    const probe = await request('/api/projects');
    assert.equal(probe.status, 204, 'GET /api/projects');
    assert.equal((await probe.arrayBuffer()).byteLength, 0, 'GET /api/projects body');
    const id = '00000000-0000-4000-8000-000000000000';
    const refused = [
      ['HEAD', '/api/projects'], ['POST', '/api/projects'], ['GET', `/api/projects/${id}/scene`], ['GET', `/api/projects/${id}/photo`],
      ['PUT', `/api/projects/${id}/photo`], ['DELETE', `/api/projects/${id}`], ['GET', `/api/%70rojects/${id}/scene`],
      ['GET', '/api/gallery'], ['POST', '/api/gallery'], ['GET', `/api/gallery/${id}`], ['GET', `/api/gallery/${id}/poster`],
      ['PUT', `/api/gallery/${id}/poster`], ['POST', `/api/gallery/${id}/publish`], ['DELETE', `/api/gallery/${id}`], ['GET', '/api/gallery/%ZZ'],
    ];
    for (const [method, urlPath] of refused) {
      const response = await request(urlPath, { method, ...(method === 'PUT' || method === 'POST' ? { body: new Uint8Array([1]) } : {}) });
      assert.equal(response.status, 404, `${method} ${urlPath}`);
      if (method === 'HEAD') assert.equal((await response.arrayBuffer()).byteLength, 0);
      else assert.deepEqual(await response.json(), { error: urlPath.startsWith('/api/gallery') ? 'The gallery is offline.' : 'The project store is offline.' }, `${method} ${urlPath}`);
    }
    console.log(`PASS store and gallery offline: GET /api/projects 204 with no body; ${refused.length} store and gallery requests 404.`);
  }
  await storeOffline();
  for (const file of ['/', '/index.html', ...build.files.map((name) => `/${name}`)]) {
    const response = await request(file);
    assert.equal(response.status, 200, file);
    const bytes = Buffer.from(await response.arrayBuffer());
    const local = file === '/' ? 'index.html' : file.slice(1);
    assert.equal(digest(bytes), prepared.files[local], `${file}: SHA-256`);
  }
  console.log(`PASS ${base.origin}: all ${build.files.length} production assets, direct index.html, SHA-256 and header contract.`);
  for (const file of await lockedFiles()) {
    const head = await request(file.served, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(file.bytes));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const full = await request(file.served);
    assert.equal(full.status, 200);
    const bytes = Buffer.from(await full.arrayBuffer());
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256);
    for (const [range, start, end] of [['bytes=0-31', 0, 31], [`bytes=${file.bytes - 4096}-`, file.bytes - 4096, file.bytes - 1], ['bytes=-64', file.bytes - 64, file.bytes - 1]]) {
      const partial = await request(file.served, { headers: { Range: range } });
      assert.equal(partial.status, 206); assert.equal(partial.headers.get('Content-Range'), `bytes ${start}-${end}/${file.bytes}`);
      assert.equal(partial.headers.get('Content-Length'), String(end - start + 1));
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    const invalid = await request(file.served, { headers: { Range: `bytes=${file.bytes}-` } });
    assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('Content-Range'), `bytes */${file.bytes}`); await invalid.arrayBuffer();
    console.log(`PASS ${file.served}: ${file.bytes} bytes, SHA-256 ${file.sha256}, HEAD and three resumed ranges, 416.`);
  }
  for (const file of ['/dev/fault', '/dev/checklist.html', '/api/log', '/%64ev/fault', '/models/not-locked.onnx', '/.local/cloudflare.env', '/src/main.tsx', '/_worker.js', '/_routes.json', '/missing']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await request(file, { method });
      assert.equal(response.status, 404, `${method} ${file}`);
      if (method === 'HEAD') assert.equal((await response.arrayBuffer()).byteLength, 0);
      else await response.arrayBuffer();
    }
  }
  const post = await request('/', { method: 'POST' }); assert.equal(post.status, 405); await post.arrayBuffer();
  console.log('PASS dev, source, credential, unknown-model and reserved routes: 404; unsupported method: 405; error headers preserved.');
  const result = { baseUrl: base.href, checkedAt: new Date().toISOString(), prepared, ok: true };
  let name = 'verified-root.json';
  for (const environment of ['preview', 'production']) {
    try {
      const deployed = JSON.parse(await readFile(path.join(STATE, `${environment}.json`), 'utf8'));
      if (new URL(deployed.url).origin === base.origin) name = `verified-${environment}.json`;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path.join(STATE, name), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`PASS verification recorded in .local/cloudflare/${name}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await verify();
