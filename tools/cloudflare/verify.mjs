// Direct HTTP verification of a prepared deployment, including every model byte.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpuHeaders, gpuUrl } from '../build.mjs';
import { expectedHeaders, loadHeaderContract } from '../headers.mjs';
import { ROOT, STATE, OUTPUT, lockedFiles } from './prepare.mjs';
import { serializeScene } from '../../src/projects/serialize.ts';
import { fiveClusterDocument } from '../../test/fixtures/documents.ts';

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
  async function request(urlPath, init = {}) {
    const response = await fetch(new URL(urlPath, base), { ...init, redirect: 'manual', signal: AbortSignal.timeout(180_000) });
    for (const [name, value] of Object.entries(expectedHeaders(contract, urlPath, { status: response.status }))) {
      if ((response.status >= 400 || urlPath.startsWith('/api/projects')) && name === 'Content-Type') continue;
      assert.equal(response.headers.get(name), value, `${urlPath}: ${name}`);
    }
    return response;
  }

  // ci.mjs already runs this before promotion. Use a fresh id and remove only our
  // own project; preview and production share the real store with the editor.
  async function projectsRoundTrip() {
    const json = async (urlPath, init = {}, status = 200) => {
      const response = await request(urlPath, init);
      assert.equal(response.status, status, urlPath);
      assert.equal(response.headers.get('Content-Type'), 'application/json');
      return await response.json();
    };
    const before = await json('/api/projects');
    assert.ok(Array.isArray(before.projects));
    const id = randomUUID(), route = `/api/projects/${id}`;
    const photo = new Uint8Array([0, 1, 255, 0, 128, 7]);
    const mask = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const asset = digest(mask);
    const thumbnail = new Uint8Array([255, 216, 1, 2, 255, 217]);
    const source = fiveClusterDocument(), first = source.objects[0];
    assert.ok(first);
    const plane = { format: 'u8', size: { width: 3, height: 2 }, data: mask };
    const document = { ...source, id, title: 'Hosting verification', analysis: { ...source.analysis, plate: null },
      objects: [{ ...first, produced: { ...first.produced, mask: { asset, format: 'u8', size: plane.size } } }] };
    const scene = serializeScene(document, new Map([[asset, plane]]), 0);
    const put = async (part, body, type) => assert.deepEqual(await json(`${route}/${part}`, {
      method: 'PUT', headers: { 'Content-Type': type }, body,
    }), { ok: true });
    try {
      await put('photo', photo, 'image/png');
      await put(`masks/${asset}`, mask, 'application/octet-stream');
      await put('thumbnail', thumbnail, 'image/jpeg');
      await put('scene', JSON.stringify(scene), 'application/json');
      const listed = (await json('/api/projects')).projects.find((project) => project.id === id);
      assert.equal(listed?.name, document.title);
      assert.equal(listed?.thumbnail, `${route}/thumbnail`);
      assert.ok(Number.isFinite(Date.parse(listed.updatedAt)));
      assert.deepEqual(await json(`${route}/scene`), scene);
      for (const [part, expected, type] of [['photo', photo, 'image/png'], [`masks/${asset}`, mask, 'application/octet-stream'], ['thumbnail', thumbnail, 'image/jpeg']]) {
        const response = await request(`${route}/${part}`);
        assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), type);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
      }
      // Exercise the real database's lock/upsert protocol, not just the SQL stub.
      const write = (revision) => json(`${route}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, revision }) });
      await write(1);
      assert.deepEqual(await json(`${route}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scene) }, 409), { error: 'The project scene revision must increase.' });
      assert.equal((await json(`${route}/scene`)).revision, 1);
      const competing = await Promise.all([2, 3].map((revision) => request(`${route}/scene`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, revision }),
      })));
      for (const response of competing) {
        assert.ok(response.status === 200 || response.status === 409);
        assert.deepEqual(await response.json(), response.status === 200 ? { ok: true } : { error: 'The project scene revision must increase.' });
      }
      assert.equal((await json(`${route}/scene`)).revision, 3);
      const [removed, late] = await Promise.all([json(route, { method: 'DELETE' }), request(`${route}/scene`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, revision: 4 }),
      })]);
      assert.deepEqual(removed, { ok: true });
      assert.ok(late.status === 200 || late.status === 410);
      assert.deepEqual(await late.json(), late.status === 200 ? { ok: true } : { error: 'The project was deleted.' });
      assert.deepEqual(await json(`${route}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: photo }, 410), { error: 'The project was deleted.' });
      assert.deepEqual(await json(`${route}/scene`, {}, 404), { error: 'The project was not found.' });
      const after = await json('/api/projects');
      assert.ok(!after.projects.some((project) => project.id === id));
      console.log(`PASS projects: photo, mask, thumbnail and scene PUT/GET byte for byte; list, revision 409, concurrent saves/delete, tombstone 410; ${after.projects.length} projects remain (verification id absent).`);
      if (before.projects.length === 0 && after.projects.length === 0) console.log('PASS projects list empty before and after the round trip.');
    } finally {
      const cleanup = await request(route, { method: 'DELETE' });
      assert.ok(cleanup.status === 200 || cleanup.status === 404);
      assert.deepEqual(await cleanup.json(), cleanup.status === 200 ? { ok: true } : { error: 'The project was not found.' });
    }
  }
  await projectsRoundTrip();
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
