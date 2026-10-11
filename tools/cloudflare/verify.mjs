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
import { legacyFiveClusterDocument as fiveClusterDocument } from '../../test/fixtures/documents.ts';

/** Recompute the configured policy and verify the prepared build carries it. */
export function preparedHeaderContract(build, source) {
  const contract = gpuHeaders(source, gpuUrl(build.gpu ?? ''));
  assert.deepEqual(build.headers, contract, 'Prepared build header contract');
  return contract;
}

/** Capture draft credentials before validation and always attempt cleanup. */
export async function withGalleryDraft({ draft, transport, checkHeaders, run }) {
  const response = await transport('/api/gallery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
  });
  const { id, token } = await response.json();
  let failed = false;
  try {
    const route = `/api/gallery/${encodeURIComponent(id)}`, auth = { Authorization: `Bearer ${token}` };
    checkHeaders('/api/gallery', response);
    assert.equal(response.status, 201, '/api/gallery');
    assert.equal(response.headers.get('Cache-Control'), 'no-cache');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    await run({ id, token, route, auth });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      const route = `/api/gallery/${encodeURIComponent(id)}`, auth = { Authorization: `Bearer ${token}` };
      const cleanup = await transport(route, { method: 'DELETE', headers: auth });
      checkHeaders(route, cleanup);
      assert.equal(cleanup.status, 200, route);
      assert.equal(cleanup.headers.get('Cache-Control'), 'no-cache');
      assert.deepEqual(await cleanup.json(), { ok: true });
    } catch (error) {
      if (!failed) throw error;
    }
  }
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
      if (urlPath.startsWith('/api/gallery') && name === 'Cache-Control') { assert.equal(response.headers.get(name), 'no-cache', `${urlPath}: ${name}`); continue; }
      assert.equal(response.headers.get(name), value, `${urlPath}: ${name}`);
    }
  }
  async function request(urlPath, init = {}) {
    const response = await transport(urlPath, init);
    checkHeaders(urlPath, response);
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
      // Upgrade only this isolated verification id, using complete immutable v2 assets.
      const { encodeRaster } = await import('../../src/core/asset-codec.ts');
      const { serializeCompositionScene } = await import('../../src/projects/serialize.ts');
      const { compositionDocumentSchema } = await import('../../src/core/composition-schema.ts');
      const { newComposition, artworkLayer, rasterSource } = await import('../../test/fixtures/composition.ts');
      const { DEPTH_MODEL } = await import('../../test/fixtures/documents.ts');
      const master = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4zwAE/xnqQeR/bh7e/wAuSQWfwB0i9wAAAABJRU5ErkJggg==', 'base64'));
      const rgba = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 13, height: 7 }, data: Uint8Array.from({ length: 364 }, (_, i) => i % 256) });
      const soft = encodeRaster({ format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array([127]) });
      const depth = encodeRaster({ format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([.25]) });
      const blank = newComposition(), layer = artworkLayer(), raster = rasterSource();
      const composition = compositionDocumentSchema.parse({ ...blank, id, title: 'Hosting v2 verification',
        frame: { ...blank.frame, master: { ...blank.frame.master, asset: digest(master) }, source: { asset: digest(photo), mediaType: 'image/png', byteLength: photo.length } },
        sources: [{ ...raster, image: { ...raster.image, asset: digest(rgba) } }], objects: [{ ...layer,
          produced: { ...layer.produced, mask: { ...layer.produced.mask, asset: digest(soft) } },
          depthAttachment: { kind: 'source', map: { asset: digest(depth), format: 'f32', size: { width: 1, height: 1 } }, model: DEPTH_MODEL, offset: 0 } }] });
      const complete = serializeCompositionScene(composition, 4);
      await json(`${route}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(complete) }, 400);
      assert.equal((await json(`${route}/scene`)).revision, 3, 'missing v2 assets retain legacy checkpoint');
      for (const bytes of [master, rgba, soft, depth]) await put(`assets/${digest(bytes)}`, bytes, 'application/octet-stream');
      assert.deepEqual(await json(`${route}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/png', 'X-Project-Asset': digest(photo) }, body: photo }), { ok: true });
      await put('scene', JSON.stringify(complete), 'application/json');
      assert.deepEqual(await json(`${route}/scene`), complete);
      for (const bytes of [master, rgba, soft, depth, photo]) {
        const response = await request(`${route}/assets/${digest(bytes)}`);
        assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      }
      await put('photo', new Uint8Array(photo.length), 'image/png');
      assert.deepEqual(new Uint8Array(await (await request(`${route}/assets/${digest(photo)}`)).arrayBuffer()), photo, 'v2 original survives legacy-slot replacement');

      const [removed, late] = await Promise.all([json(route, { method: 'DELETE' }), request(`${route}/scene`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...complete, revision: 5 }),
      })]);
      assert.deepEqual(removed, { ok: true });
      assert.ok(late.status === 200 || late.status === 410);
      assert.deepEqual(await late.json(), late.status === 200 ? { ok: true } : { error: 'The project was deleted.' });
      assert.deepEqual(await json(`${route}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: photo }, 410), { error: 'The project was deleted.' });
      assert.deepEqual(await json(`${route}/scene`, {}, 404), { error: 'The project was not found.' });
      for (const bytes of [master, rgba, soft, depth, photo]) await json(`${route}/assets/${digest(bytes)}`, {}, 404);
      await json(`${route}/assets/${digest(rgba)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: rgba }, 410);
      const after = await json('/api/projects');
      assert.ok(!after.projects.some((project) => project.id === id));
      console.log(`PASS projects: legacy photo/mask/thumbnail and v2 RGBA/soft mask/f32/PNG/immutable original byte for byte; complete-checkpoint rejection; list, revision 409, concurrent saves/delete, tombstone 410; ${after.projects.length} projects remain (verification id absent).`);
      if (before.projects.length === 0 && after.projects.length === 0) console.log('PASS projects list empty before and after the round trip.');
    } finally {
      const cleanup = await request(route, { method: 'DELETE' });
      assert.ok(cleanup.status === 200 || cleanup.status === 404);
      assert.deepEqual(await cleanup.json(), cleanup.status === 200 ? { ok: true } : { error: 'The project was not found.' });
    }
  }
  // A server-assigned id and device token isolate this publication from every
  // existing gallery piece. Always remove this exact piece, even after failure.
  async function galleryRoundTrip() {
    const jpeg = new Uint8Array([255,216,255,219,0,67,0,...Array(64).fill(1),255,192,0,11,8,0,1,0,1,1,1,17,0,
      255,196,0,20,0,1,...Array(15).fill(0),0,255,196,0,20,16,1,...Array(15).fill(0),0,
      255,218,0,8,1,1,0,0,63,0,63,255,217]);
    const mask = new Uint8Array([0,127,128,255]), depth = new Uint8Array(16), size = { width: 2, height: 2 };
    [0,0.25,0.75,1].forEach((value, index) => new DataView(depth.buffer).setFloat32(index * 4, value, true));
    const plate = new Uint8Array([255,0,0,0,255,0,0,0,255,127,128,129]);
    const source = fiveClusterDocument(), first = source.objects[0]; assert.ok(first); assert.ok(source.analysis.depth); assert.ok(source.analysis.plate);
    const assets = [
      { kind: 'source', id: digest(jpeg), size: { width: 1, height: 1 }, mediaType: 'image/jpeg', byteLength: jpeg.length },
      { kind: 'mask', id: digest(mask), size, format: 'u8', byteLength: mask.length },
      { kind: 'depth', id: digest(depth), size, format: 'f32', byteLength: depth.length },
      { kind: 'plate', id: digest(plate), size, format: 'rgb8', byteLength: plate.length },
    ];
    const draft = { document: { ...source, title: 'Gallery hosting verification', frame: { ...source.frame,
      source: { asset: digest(jpeg), mediaType: 'image/jpeg', byteLength: jpeg.length },
      original: { name: 'gray.jpg', mediaType: 'image/jpeg', size: { width: 1, height: 1 } } },
      analysis: { ...source.analysis, depth: { ...source.analysis.depth, map: { asset: digest(depth), size, format: 'f32' } },
        plate: { ...source.analysis.plate, image: { asset: digest(plate), size }, forMasks: [digest(mask)] } },
      objects: [{ ...first, produced: { ...first.produced, mask: { asset: digest(mask), size, format: 'u8' } } }] }, assets,
      poster: { kind: 'poster', id: digest(jpeg), size: { width: 1, height: 1 }, mediaType: 'image/jpeg', byteLength: jpeg.length } };
    const json = async (route, init = {}, status = 200) => { const response = await request(route, init);
      assert.equal(response.status, status, route); assert.equal(response.headers.get('Cache-Control'), 'no-cache'); return await response.json(); };
    await withGalleryDraft({ draft, transport, checkHeaders, run: async ({ id, route, auth }) => {
      await json(route, {}, 404);
      assert.ok(!(await json('/api/gallery')).pieces.some((piece) => piece.id === id));
      await json(`${route}/publish`, { method: 'POST', headers: auth }, 409);
      const resources = [[`assets/${digest(jpeg)}`, jpeg, 'image/jpeg'], [`assets/${digest(mask)}`, mask, 'application/octet-stream'],
        [`assets/${digest(depth)}`, depth, 'application/octet-stream'], [`assets/${digest(plate)}`, plate, 'application/octet-stream'], ['poster', jpeg, 'image/jpeg']];
      for (const [part, bytes, type] of resources) assert.deepEqual(await json(`${route}/${part}`, {
        method: 'PUT', headers: { ...auth, 'Content-Type': type }, body: bytes,
      }), { ok: true });
      const manifest = await json(`${route}/publish`, { method: 'POST', headers: auth });
      assert.equal(manifest.id, id); assert.equal(manifest.version, 1); assert.deepEqual(manifest.document, draft.document);
      assert.deepEqual(await json(route), manifest);
      assert.deepEqual(await json(`${route}/publish`, { method: 'POST', headers: auth }), manifest);
      for (const [part, bytes, type] of resources) {
        const response = await request(`${route}/${part}`); assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), type); assert.equal(response.headers.get('ETag'), `"${digest(bytes)}"`);
        assert.equal(response.headers.get('Cache-Control'), 'no-cache'); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      }
      assert.deepEqual(await json(route, { method: 'DELETE', headers: auth }), { ok: true });
      await json(route, {}, 404); await json(`${route}/poster`, {}, 404);
      assert.ok(!(await json('/api/gallery')).pieces.some((piece) => piece.id === id));
      console.log('PASS gallery: private draft; source JPEG, u8 mask, f32 depth, RGB8 plate and poster byte for byte; immutable publication, no-cache, hash ETags; own piece deleted.');
    } });
  }
  await projectsRoundTrip();
  await galleryRoundTrip();
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
