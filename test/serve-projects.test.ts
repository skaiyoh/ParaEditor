import { encodeRaster } from '../src/core/asset-codec.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { migrateV5ToV6, withDerivedGrainStyle } from '../src/core/remix-schema.ts';
import { hashAsset, compositionInventory } from '../src/projects/assets.ts';
import { serializeCompositionScene, deserializeCompositionScene } from '../src/projects/serialize.ts';
import { newComposition, artworkLayer, rasterSource, repairProduct } from './fixtures/composition.ts';
import { DEPTH_MODEL, assetId } from './fixtures/documents.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { z } from '../src/core/zod.ts';
import { isAssetId, isSceneId } from '../src/core/ids.ts';
import { deserializeScene, serializeScene } from '../src/projects/serialize.ts';
import type { Plane } from '../src/core/raster.ts';
import * as store from '../src/projects/store.ts';
import { createProjectSession } from '../src/session/projects.ts';
import { legacyFiveClusterDocument as fiveClusterDocument, legacyMinimalDocument as minimalDocument, minimalDocument as activeDocument, uuid } from './fixtures/documents.ts';
import { startServer, tempDir, type Server } from './support/cli.ts';

const projectList = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), updatedAt: z.iso.datetime(), thumbnail: z.string() })) });
const document = minimalDocument();
const base = `/api/projects/${document.id}`;
const photo = new Uint8Array([0, 1, 255, 0, 128, 7]);
const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
let scratch = '';
let server: Server;
let contract: { all: Record<string, string>; errors: Record<string, string> };

before(async () => {
  scratch = await tempDir('projects');
  contract = z.object({ all: z.record(z.string(), z.string()), errors: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')));
  server = await startServer(['--mode', 'dev', '--results', path.join(scratch, 'results'), '--request-log', path.join(scratch, 'requests.jsonl')]);
});
after(async () => { await server?.stop(); await rm(scratch, { recursive: true, force: true }); });

async function request(route: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(new URL(route, server.url), init);
  for (const [name, value] of Object.entries(contract.all)) assert.equal(response.headers.get(name), value, `${route} ${name}`);
  const cache = response.status >= 400 ? contract.errors['Cache-Control'] : 'no-cache';
  assert.equal(response.headers.get('Cache-Control'), cache);
  return response;
}
const put = (route: string, bytes: BodyInit, type: string) => request(route, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
const freshDocument = (number: number) => {
  const id = uuid(number); assert.ok(isSceneId(id));
  return { ...minimalDocument(), id };
};
async function withClient(run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? new URL(input, server.url) : input, init);
  try { await run(); }
  finally { globalThis.fetch = realFetch; await request('/dev/fault', { method: 'DELETE' }); }
}
const setFault = (rule: string) => request('/dev/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [rule] }) });
async function waitForLateResponse(route: string, status: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = z.array(z.object({ method: z.string(), path: z.string(), status: z.number() })).parse(await (await request('/dev/requests')).json());
    if (rows.some((row) => row.method === 'PUT' && row.path === route && row.status === status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`The late PUT did not finish with HTTP ${status}.`);
}

test('unknown resources answer 404 and malformed paths/bodies answer one-sentence 400s with the contract', async () => {
  for (const route of [`${base}/scene`, `${base}/photo`, `${base}/thumbnail`, `${base}/masks/${'a'.repeat(64)}`]) {
    const response = await request(route);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  for (const [route, body, type] of [
    [`${base}/scene`, '{', 'application/json'],
    [`${base}/scene`, '{}', 'application/json'],
    [`${base}/scene`, JSON.stringify({ ...serializeScene(document, new Map(), 0), document: { ...document, id: uuid(22) } }), 'application/json'],
    [`${base}/thumbnail`, 'not-jpeg', 'image/jpeg'],
    [`${base}/photo`, 'bytes', 'text/plain'],
    [`${base}/masks/${'b'.repeat(64)}`, 'wrong hash', 'application/octet-stream'],
    ['/api/projects/%2F../escape/scene', '{}', 'application/json'],
    [`${base}/masks/not-an-asset`, 'bytes', 'application/octet-stream'],
  ]) {
    assert.ok(route !== undefined && body !== undefined && type !== undefined);
    const response = await put(route, body, type);
    assert.equal(response.status, 400, route);
    const error = z.object({ error: z.string() }).parse(await response.json()).error;
    assert.match(error, /^[^\n]+\.$/);
  }
});

test('photo, scene and thumbnail survive byte-for-byte HTTP and a server restart, with newest-first listing', async () => {
  assert.equal((await put(`${base}/photo`, photo, 'image/png')).status, 200);
  assert.equal((await put(`${base}/thumbnail`, jpeg, 'image/jpeg')).status, 200);
  const wire = serializeScene(document, new Map(), 0);
  assert.equal((await put(`${base}/scene`, JSON.stringify(wire), 'application/json')).status, 200);
  assert.deepEqual(await (await request(`${base}/scene`)).json(), wire);
  const downloaded = await request(`${base}/photo`);
  assert.equal(downloaded.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), photo);
  assert.deepEqual(new Uint8Array(await (await request(`${base}/thumbnail`)).arrayBuffer()), jpeg);
  const nextId = uuid(88); assert.ok(isSceneId(nextId));
  const next = { ...document, id: nextId, title: 'Second photo' };
  assert.equal((await put(`/api/projects/${nextId}/scene`, JSON.stringify(serializeScene(next, new Map(), 0)), 'application/json')).status, 200);
  const listed = projectList.parse(await (await request('/api/projects')).json()).projects;
  assert.deepEqual(listed.map((project) => project.id), [nextId, document.id]);
  assert.equal(listed[1]?.name, document.title);
  assert.equal(listed[1]?.thumbnail, `${base}/thumbnail`);
  await server.stop();
  server = await startServer(['--mode', 'dev', '--results', path.join(scratch, 'results'), '--request-log', path.join(scratch, 'requests.jsonl')]);
  assert.deepEqual(await (await request(`${base}/scene`)).json(), wire);
  assert.deepEqual(new Uint8Array(await (await request(`${base}/photo`)).arrayBuffer()), photo);
});

test('raw soft masks can arrive before or after metadata; size and content id mismatches fail', async () => {
  const source = fiveClusterDocument(), first = source.objects[0]; assert.ok(first !== undefined);
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
  const asset = createHash('sha256').update(bytes).digest('hex'); assert.ok(isAssetId(asset));
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 3, height: 2 }, data: bytes };
  const doc = { ...source, objects: [{ ...first, produced: { ...first.produced, mask: { asset, format: mask.format, size: mask.size } } }], analysis: { ...source.analysis, plate: null } };
  const wire = serializeScene(doc, new Map([[asset, mask]]), 1);
  assert.equal((await put(`${base}/masks/${asset}`, bytes, 'application/octet-stream')).status, 200);
  assert.equal((await put(`${base}/scene`, JSON.stringify(wire), 'application/json')).status, 200);
  assert.deepEqual(deserializeScene(await (await request(`${base}/scene`)).json()).document, doc);
  assert.deepEqual(new Uint8Array(await (await request(`${base}/masks/${asset}`)).arrayBuffer()), bytes);
  assert.equal((await put(`${base}/masks/${asset}`, new Uint8Array(2), 'application/octet-stream')).status, 400);
  assert.equal((await put(`${base}/scene`, JSON.stringify({ ...wire, masks: { [asset]: { width: 2, height: 3 } } }), 'application/json')).status, 400);
});

test('the real client saves and loads the full scene, filename, content type and masks and rejects corrupt assets', async (t) => {
  // Node has no page origin. Resolve only relative URLs, keeping the real fetch and server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? new URL(input, server.url) : input, init);
  t.after(() => { globalThis.fetch = realFetch; });
  const source = fiveClusterDocument(), first = source.objects[0]; assert.ok(first !== undefined);
  const data = new Uint8Array([0, 1, 127, 128, 254, 255]);
  const asset = createHash('sha256').update(data).digest('hex'), photoAsset = createHash('sha256').update(photo).digest('hex');
  assert.ok(isAssetId(asset) && isAssetId(photoAsset));
  const mask: Plane<'u8'> = { format: 'u8', size: { width: 3, height: 2 }, data };
  const doc = { ...source, frame: { ...source.frame, source: { asset: photoAsset, mediaType: 'image/png', byteLength: photo.byteLength } },
    analysis: { ...source.analysis, plate: null }, objects: [{ ...first, produced: { ...first.produced, mask: { asset, format: mask.format, size: mask.size } } }] };
  const masks = new Map([[asset, mask]]), file = new File([photo], doc.frame.original.name, { type: 'image/png' });
  await store.savePhoto(doc.id, file);
  await store.saveMask(doc.id, asset, mask);
  await store.saveThumbnail(doc.id, new Blob([jpeg], { type: 'image/jpeg' }));
  await store.saveScene(doc, masks, 2);
  const loaded = await store.loadProject(doc.id, new AbortController().signal);
  assert.deepEqual(loaded.document, doc);
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.photo.name, doc.frame.original.name);
  assert.equal(loaded.photo.type, 'image/png');
  assert.deepEqual(new Uint8Array(await loaded.photo.arrayBuffer()), photo);
  assert.deepEqual(loaded.masks.get(asset), mask);
  assert.ok((await store.listProjects()).some((project) => project.id === doc.id));
  await store.savePhoto(doc.id, new File([new Uint8Array(photo.length)], file.name, { type: file.type }));
  await assert.rejects(store.loadProject(doc.id, new AbortController().signal), /asset bytes are invalid/);
  await store.savePhoto(doc.id, file);
});

test('one API fault fails a save without mutating it, the next save succeeds, and delete removes every file', async () => {
  const before = await (await request(`${base}/scene`)).json();
  await request('/dev/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: [`path:${base}/scene:http500:times=1`] }) });
  assert.equal((await put(`${base}/scene`, JSON.stringify(serializeScene(document, new Map(), 3)), 'application/json')).status, 500);
  assert.deepEqual(await (await request(`${base}/scene`)).json(), before);
  assert.equal((await put(`${base}/scene`, JSON.stringify(serializeScene(document, new Map(), 3)), 'application/json')).status, 200);
  assert.equal((await request(base, { method: 'DELETE' })).status, 200);
  for (const resource of ['scene', 'photo', 'thumbnail']) assert.equal((await request(`${base}/${resource}`)).status, 404);
  await assert.rejects(readFile(path.join(scratch, 'results', 'projects', document.id, 'scene.json')), { code: 'ENOENT' });
  const listed = projectList.parse(await (await request('/api/projects')).json()).projects;
  for (const project of listed) assert.equal((await request(`/api/projects/${project.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(projectList.parse(await (await request('/api/projects')).json()).projects, []);
});

test('production has a bodyless 204 absence probe with the contract, every other project request stays 404, and nothing is written', async () => {
  const production = await startServer(['--mode', 'production']);
  const absent = `/api/projects/${uuid(198)}`;
  const fixture = new URL(`../test-results/projects/${uuid(198)}/`, import.meta.url);
  try {
    await assert.rejects(stat(fixture), { code: 'ENOENT' });
    const probe = await fetch(new URL('/api/projects', production.url));
    assert.equal(probe.status, 204);
    assert.equal((await probe.arrayBuffer()).byteLength, 0);
    for (const [name, value] of Object.entries(contract.all)) assert.equal(probe.headers.get(name), value);
    assert.equal(probe.headers.get('Cache-Control'), 'no-cache');
    for (const [route, method] of [['/api/projects', 'PUT'], ['/api/projects', 'HEAD'], ['/api/projects', 'POST'], ['/api/projects', 'DELETE'],
      ['/api/projects/', 'GET'], [`${absent}/scene`, 'GET'], [`${absent}/scene`, 'PUT'], [`${absent}/photo`, 'GET'], [absent, 'DELETE']]) {
      const response = await fetch(new URL(route ?? '/', production.url), { method: method ?? 'GET' });
      assert.equal(response.status, 404);
      for (const [name, value] of Object.entries(contract.all)) assert.equal(response.headers.get(name), value);
      await response.arrayBuffer();
    }
    await assert.rejects(stat(fixture), { code: 'ENOENT' });
  } finally { await production.stop(); }
});

test('a production 204 probe disables every subsequent project request, including imports and delayed saves', async () => {
  const production = await startServer(['--mode', 'production']);
  const realFetch = globalThis.fetch;
  let origin = production.url;
  const calls: { method: string; path: string }[] = [];
  globalThis.fetch = (input, init) => {
    const target = typeof input === 'string' && input.startsWith('/') ? new URL(input, origin) : input;
    calls.push({ method: init?.method ?? 'GET', path: typeof target === 'string' ? new URL(target).pathname : target instanceof URL ? target.pathname : new URL(target.url).pathname });
    return realFetch(target, init);
  };
  let renders = 0;
  try {
    const projects = createProjectSession(() => { renders++; throw new Error('An absent store must not export thumbnails.'); });
    const { minimalDocument: currentDocument } = await import('./fixtures/documents.ts');
    const active = currentDocument();
    // Import and edit can begin before the boot probe's response arrives.
    projects.begin({ document: active, assets: new Map(), checkpoint: { kind: 'new' } });
    projects.observe({ ...active, style: { ...active.style, fry: 0.7 } }, new Map());
    await projects.refresh();
    assert.equal(projects.snapshot().state, 'absent');
    assert.deepEqual(projects.snapshot().projects, []);
    assert.equal(projects.snapshot().current, null);
    projects.begin({ document: active, assets: new Map(), checkpoint: { kind: 'new' } });
    projects.observe({ ...active, style: { ...active.style, fry: 0.3 } }, new Map());
    projects.suspend();
    await projects.refresh();
    assert.equal(await projects.remove(document.id), false);
    await assert.rejects(projects.load(document.id, new AbortController().signal), /No project store on this server/);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal(renders, 0);
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/projects' }]);
    // A deployed store does not undo the latch until the next page session.
    origin = server.url;
    await projects.refresh();
    assert.equal(calls.length, 1);
    const nextPage = createProjectSession(() => { throw new Error('No scene needs exporting.'); });
    await nextPage.refresh();
    assert.equal(nextPage.snapshot().state, 'saved');
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/projects' }, { method: 'GET', path: '/api/projects' }]);
  } finally {
    globalThis.fetch = realFetch;
    await production.stop();
  }
});

test('a non-404 probe failure reports Not saved and allows a later real list refresh', async () => {
  await request('/dev/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: ['path:/api/projects:http500:times=1'] }) });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (input, init) => {
    const target = typeof input === 'string' && input.startsWith('/') ? new URL(input, server.url) : input;
    calls.push(typeof target === 'string' ? new URL(target).pathname : target instanceof URL ? target.pathname : new URL(target.url).pathname);
    return realFetch(target, init);
  };
  try {
    const projects = createProjectSession(() => { throw new Error('No scene needs exporting.'); });
    await new Promise<void>((resolve) => {
      const unsubscribe = projects.subscribe((state) => {
        if (state.state !== 'failed') return;
        unsubscribe(); resolve();
      });
    });
    assert.equal(projects.snapshot().state, 'failed');
    await projects.refresh();
    assert.equal(projects.snapshot().state, 'saved');
    assert.deepEqual(calls, ['/api/projects', '/api/projects']);
  } finally {
    globalThis.fetch = realFetch;
    await request('/dev/fault', { method: 'DELETE' });
  }
});

test('the legacy 404 absence signal also latches with only one real HTTP probe', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (input, init) => {
    calls++;
    // An existing server route supplies a real 404, as the hosted server does before PS1b.
    return realFetch(typeof input === 'string' && input === '/api/projects' ? new URL(`/api/projects/${uuid(199)}/scene`, server.url) : input, init);
  };
  try {
    const projects = createProjectSession(() => { throw new Error('No scene needs exporting.'); });
    await projects.refresh();
    assert.equal(projects.snapshot().state, 'absent');
    await projects.refresh();
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('legacy fixture metadata starts at revision zero, and a loaded revision advances on the next save', async () => withClient(async () => {
  const doc = freshDocument(200), route = `/api/projects/${doc.id}/scene`;
  await store.saveScene(doc, new Map(), 0);
  const file = path.join(scratch, 'results', 'projects', doc.id, 'scene.json');
  const legacy = z.object({ document: z.unknown(), masks: z.unknown(), updatedAt: z.string() }).parse(JSON.parse(await readFile(file, 'utf8')));
  await writeFile(file, JSON.stringify(legacy));
  const loaded = deserializeScene(await (await request(route)).json());
  assert.equal(loaded.revision, 0);
  await store.saveScene(doc, new Map(), loaded.revision + 1);
  assert.equal(deserializeScene(await (await request(route)).json()).revision, 1);
  await store.deleteProject(doc.id);
}));

test('writes wait for the complete acknowledgement and a stalled 200 fails at the 15 second timeout', async () => withClient(async () => {
  const doc = freshDocument(201), route = `/api/projects/${doc.id}/scene`;
  await store.saveScene(doc, new Map(), 0);
  await setFault(`path:${route}:stall:times=1`);
  const clientFetch = globalThis.fetch;
  let headers: (status: number) => void = () => undefined;
  const receivedHeaders = new Promise<number>((resolve) => { headers = resolve; });
  globalThis.fetch = async (input, init) => {
    const response = await clientFetch(input, init);
    if (init?.method === 'PUT') headers(response.status);
    return response;
  };
  const started = Date.now();
  const write = store.saveScene({ ...doc, style: { ...doc.style, fry: 0.8 } }, new Map(), 1);
  let succeeded = false;
  void write.then(() => { succeeded = true; }, () => undefined);
  assert.equal(await receivedHeaders, 200);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(succeeded, false, '200 headers alone must not complete the write');
  assert.equal(deserializeScene(await (await request(route)).json()).document.style.fry, doc.style.fry);
  await assert.rejects(write, /aborted|timed out/i);
  assert.ok(Date.now() - started >= 14_000);
  await store.saveScene(doc, new Map(), 2);
  assert.equal(deserializeScene(await (await request(route)).json()).revision, 2);
  await store.deleteProject(doc.id);
}));

test('a timed-out scene PUT that survives on the server cannot overwrite a newer revision', async () => withClient(async () => {
  const doc = freshDocument(202), route = `/api/projects/${doc.id}/scene`;
  await store.saveScene(doc, new Map(), 0);
  await setFault(`path:${route}:slow=20000:times=1`);
  await assert.rejects(store.saveScene({ ...doc, style: { ...doc.style, fry: 0.3 } }, new Map(), 1), /aborted|timed out/i);
  const newest = { ...doc, style: { ...doc.style, fry: 0.9 } };
  await store.saveScene(newest, new Map(), 2);
  await waitForLateResponse(route, 409);
  assert.deepEqual(deserializeScene(await (await request(route)).json()).document, newest);
  await assert.rejects(store.saveScene(doc, new Map(), 2), (error: unknown) => error instanceof store.ProjectRequestError && error.status === 409 && error.terminal);
  await store.saveScene(newest, new Map(), 3);
  assert.equal(deserializeScene(await (await request(route)).json()).revision, 3);
  await store.deleteProject(doc.id);
}));

test('DELETE tombstones stop a surviving timed-out scene PUT and every binary PUT from recreating a project', async () => withClient(async () => {
  const doc = freshDocument(203), route = `/api/projects/${doc.id}/scene`;
  await store.saveScene(doc, new Map(), 0);
  await setFault(`path:${route}:slow=20000:times=1`);
  await assert.rejects(store.saveScene(doc, new Map(), 1), /aborted|timed out/i);
  await store.deleteProject(doc.id);
  await waitForLateResponse(route, 410);
  const asset = createHash('sha256').update(photo).digest('hex'); assert.ok(isAssetId(asset));
  const terminal = (error: unknown) => error instanceof store.ProjectRequestError && error.status === 410 && error.terminal;
  await assert.rejects(store.saveScene(doc, new Map(), 2), terminal);
  await assert.rejects(store.savePhoto(doc.id, new File([photo], 'photo.png', { type: 'image/png' })), terminal);
  await assert.rejects(store.saveThumbnail(doc.id, new Blob([jpeg], { type: 'image/jpeg' })), terminal);
  await assert.rejects(store.saveMask(doc.id, asset, { format: 'u8', size: { width: photo.length, height: 1 }, data: photo }), terminal);
  assert.equal((await request(route)).status, 404);
  await assert.rejects(stat(path.join(scratch, 'results', 'projects', doc.id)), { code: 'ENOENT' });
  assert.ok(!projectList.parse(await (await request('/api/projects')).json()).projects.some((project) => project.id === doc.id));
}));

test('a failed first photo upload can be deleted with 404, drops its job and cancels its pending save', async () => withClient(async () => {
  const original = createHash('sha256').update(photo).digest('hex'); assert.ok(isAssetId(original));
  const masterBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4zwAE/xnqQeR/bh7e/wAuSQWfwB0i9wAAAABJRU5ErkJggg==', 'base64'));
  const master = createHash('sha256').update(masterBytes).digest('hex'); assert.ok(isAssetId(master));
  const template = activeDocument(), id = uuid(204); assert.ok(isSceneId(id));
  const doc = { ...template, id, frame: { ...template.frame, master: { ...template.frame.master, asset: master },
    source: { asset: original, byteLength: photo.length, mediaType: 'image/png' } } };
  const assets = new Map([[master, masterBytes], [original, photo]]);
  const route = `/api/projects/${doc.id}`;
  await setFault(`path:${route}/photo:http500:times=1`);
  const clientFetch = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && init?.method === 'PUT') calls.push(input);
    return clientFetch(input, init);
  };
  let renders = 0;
  const projects = createProjectSession(() => { renders++; throw new Error('A removed project must not export.'); });
  await projects.refresh();
  const failed = new Promise<void>((resolve) => {
    const unsubscribe = projects.subscribe((state) => { if (state.states.get(doc.id) === 'failed') { unsubscribe(); resolve(); } });
  });
  projects.begin({ document: doc, assets, checkpoint: { kind: 'new' } });
  await failed;
  assert.equal(projects.diagnostics().retainedJobs, 1);
  assert.equal((await request(`${route}/scene`)).status, 404);
  assert.equal(await projects.remove(doc.id), true);
  assert.deepEqual(projects.diagnostics(), { retainedJobs: 0, pendingSaves: 0 });
  assert.ok(!projects.snapshot().projects.some((project) => project.id === doc.id));
  projects.observe({ ...doc, style: { ...doc.style, fry: 0.9 } }, assets);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(renders, 0);
  assert.deepEqual(calls, [`${route}/photo`]);
  await assert.rejects(store.savePhoto(doc.id, new File([photo], 'photo.png', { type: 'image/png' })), (error: unknown) => error instanceof store.ProjectRequestError && error.status === 410);
  projects.suspend();
  assert.equal(projects.snapshot().current, null);
  assert.equal(projects.snapshot().state, 'saving', 'an import in preparation is not a saved project');
  projects.openFailed();
  assert.equal(projects.snapshot().state, 'failed', 'a refused import clears its preparation state');
  const nextId = uuid(206); assert.ok(isSceneId(nextId));
  const next = { ...doc, id: nextId };
  projects.suspend();
  projects.begin({ document: next, assets, checkpoint: { kind: 'new' } });
  assert.equal(projects.snapshot().current, next.id);
  assert.equal(projects.snapshot().states.get(next.id), 'saving');
  assert.equal(await projects.remove(next.id), true);
  assert.deepEqual(projects.diagnostics(), { retainedJobs: 0, pendingSaves: 0 });
  assert.equal(renders, 0);
  assert.ok(calls.includes(`/api/projects/${next.id}/photo`), 'a fresh import uploads its photo after DELETE 404');
}));

test('accepted project corruption and truncation faults alter JSON, binary bytes and mutation acknowledgements', async () => withClient(async () => {
  const doc = freshDocument(205), route = `/api/projects/${doc.id}`;
  await store.saveScene(doc, new Map(), 0);
  await store.savePhoto(doc.id, new File([photo], 'photo.png', { type: 'image/png' }));
  await setFault(`path:${route}/scene:corrupt:times=1`);
  const corruptJson = await fetch(new URL(`${route}/scene`, server.url));
  assert.equal(corruptJson.status, 200);
  await assert.rejects(corruptJson.json(), SyntaxError);
  await setFault(`path:${route}/photo:corrupt:times=1`);
  assert.deepEqual(new Uint8Array(await (await fetch(new URL(`${route}/photo`, server.url))).arrayBuffer()), photo.map((value) => value ^ 0xff));
  await setFault(`path:${route}/scene:truncate=1:times=1`);
  const truncated = await fetch(new URL(`${route}/scene`, server.url));
  assert.equal(truncated.status, 200);
  assert.ok(Number(truncated.headers.get('Content-Length')) > 1);
  await assert.rejects(truncated.arrayBuffer());
  await setFault(`path:${route}/photo:corrupt:times=1`);
  await assert.rejects(store.savePhoto(doc.id, new File([photo], 'photo.png', { type: 'image/png' })), SyntaxError);
  await store.savePhoto(doc.id, new File([photo], 'photo.png', { type: 'image/png' }));
  await setFault(`path:${route}:corrupt:times=1`);
  await assert.rejects(store.deleteProject(doc.id), SyntaxError);
  await store.deleteProject(doc.id); // Its second DELETE is 404 and completes successfully.
}));

async function compositionFixture(number: number) {
  const original = newComposition(), id = uuid(number); assert.ok(isSceneId(id));
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4zwAE/xnqQeR/bh7e/wAuSQWfwB0i9wAAAABJRU5ErkJggg==', 'base64'));
  const rgba = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 13, height: 7 }, data: Uint8Array.from({ length: 364 }, (_, i) => i % 256) });
  const coverage = encodeRaster({ format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array([127]) });
  const depth = encodeRaster({ format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([.25]) });
  const union = encodeRaster({ format: 'u8', size: { width: 2, height: 2 }, data: new Uint8Array([0, 127, 128, 255]) });
  const hole = encodeRaster({ format: 'u8', size: { width: 2, height: 2 }, data: new Uint8Array([0, 255, 255, 255]) });
  const [masterId, rgbaId, maskId, depthId, unionId, holeId, photoId] = await Promise.all([png, rgba, coverage, depth, union, hole, photo].map(hashAsset));
  assert.ok(masterId && rgbaId && maskId && depthId && unionId && holeId && photoId);
  const layer = artworkLayer(), source = rasterSource();
  const partial = compositionDocumentSchema.parse({ ...original, id, frame: { ...original.frame,
    master: { ...original.frame.master, asset: masterId }, source: { asset: photoId, mediaType: 'image/jpeg', byteLength: photo.length } },
    sources: [{ ...source, image: { ...source.image, asset: rgbaId } }], objects: [{ ...layer,
      produced: { ...layer.produced, mask: { ...layer.produced.mask, asset: maskId } },
      depthAttachment: { kind: 'source', map: { asset: depthId, format: 'f32', size: { width: 1, height: 1 } }, model: DEPTH_MODEL, offset: 0 } }] });
  const template = repairProduct(partial);
  const doc = compositionDocumentSchema.parse({ ...partial, analysis: { ...partial.analysis, plate: { ...template,
    key: { ...template.key, removalUnion: unionId, hole: holeId, depth: depthId }, image: partial.frame.master,
    backgroundDepth: { asset: depthId, format: 'f32', size: { width: 1, height: 1 } } } } });
  return { doc, assets: new Map([[masterId, png], [rgbaId, rgba], [maskId, coverage], [depthId, depth], [unionId, union], [holeId, hole], [photoId, photo]]), photoId, rgbaId, maskId };
}

test('v2 real HTTP checkpoint retains RGBA alpha, fractional masks, depth, PNG, exact repair and immutable original bytes', async () => withClient(async () => {
  const { doc, assets, photoId, rgbaId } = await compositionFixture(401), route = `/api/projects/${doc.id}`;
  const wire = serializeCompositionScene(doc, 0);
  assert.equal((await put(`${route}/scene`, JSON.stringify(wire), 'application/json')).status, 400, 'missing assets cannot create a checkpoint');
  assert.equal((await request(`${route}/scene`)).status, 404);
  const input = { document: doc, revision: 0, assets, thumbnail: new Blob([jpeg], { type: 'image/jpeg' }) };
  assert.deepEqual(await store.saveComposition(input), { kind: 'saved', revision: 0 });
  assert.deepEqual(await (await request(`${route}/scene`)).json(), wire);
  for (const [asset, expected] of assets) {
    const response = await request(`${route}/assets/${asset}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
  }
  const loaded = await store.loadCompositionProject(doc.id, new AbortController().signal);
  assert.equal(loaded.kind, 'composition');
  assert.ok(loaded.kind === 'composition'); assert.deepEqual(loaded.document, doc); assert.deepEqual(loaded.assets, assets);
  // Changing the legacy slot cannot destroy an immutable original or last-good revision.
  assert.equal((await put(`${route}/photo`, new Uint8Array(photo.length), 'image/jpeg')).status, 200);
  const invalid = { ...wire, revision: 1, document: { ...doc, sources: doc.sources.map((source) => ({ ...source, image: { ...source.image, asset: assetId(999) } })) } };
  assert.equal((await put(`${route}/scene`, JSON.stringify(invalid), 'application/json')).status, 400);
  assert.deepEqual(await (await request(`${route}/scene`)).json(), wire);
  assert.deepEqual(new Uint8Array(await (await request(`${route}/assets/${photoId}`)).arrayBuffer()), photo);
  assert.equal((await put(`${route}/scene`, JSON.stringify(wire), 'application/json')).status, 409);
  await store.saveComposition({ ...input, revision: 2 });
  await setFault(`path:${route}/assets/${rgbaId}:corrupt:times=1`);
  await assert.rejects(store.loadCompositionProject(doc.id, new AbortController().signal), /asset bytes are invalid/);
  assert.equal((await store.loadCompositionProject(doc.id, new AbortController().signal)).revision, 2);
  await store.deleteProject(doc.id);
  for (const asset of assets.keys()) assert.equal((await request(`${route}/assets/${asset}`)).status, 404);
  const rgba = assets.get(rgbaId); assert.ok(rgba);
  assert.equal((await put(`${route}/assets/${rgbaId}`, new Uint8Array(rgba), 'application/octet-stream')).status, 410);
  await assert.rejects(stat(path.join(scratch, 'results', 'projects', doc.id)), { code: 'ENOENT' });
}));

test('v6 HTTP checkpoints persist wire documents and reopen older dev-server derived Grain fields', async () => withClient(async () => {
  const { doc, assets } = await compositionFixture(404);
  const migrated = migrateV5ToV6(doc); assert.ok(migrated.ok);
  const document = withDerivedGrainStyle(migrated.value), wire = serializeCompositionScene(document, 0);
  const route = `/api/projects/${doc.id}/scene`;
  assert.deepEqual(await store.saveComposition({ document, revision: 0, assets,
    thumbnail: new Blob([jpeg], { type: 'image/jpeg' }) }), { kind: 'saved', revision: 0 });
  assert.deepEqual(await (await request(route)).json(), wire);
  const file = path.join(scratch, 'results', 'projects', doc.id, 'scene.json');
  const stored = z.object({ document: z.unknown() }).parse(JSON.parse(await readFile(file, 'utf8')));
  assert.deepEqual(stored.document, wire.document, 'disk contains the serialized v6 shape');
  const reopened = await store.loadCompositionProject(doc.id, new AbortController().signal);
  assert.equal(reopened.kind, 'composition'); assert.deepEqual(reopened.document, document);
  // The frozen candidate wrote its derived read model to disk before this fix.
  await writeFile(file, JSON.stringify({ ...wire, document, updatedAt: doc.updatedAt }));
  assert.deepEqual(await (await request(route)).json(), wire);
  assert.deepEqual((await store.loadCompositionProject(doc.id, new AbortController().signal)).document, document);
}));

test('slow v2 store and Undo/Redo retain at most active + newest pending, release superseded bytes, and upload committed refs only', async () => withClient(async () => {
  const { doc, assets } = await compositionFixture(402), route = `/api/projects/${doc.id}`;
  const clientFetch = globalThis.fetch, uploads: string[] = [], revisions: number[] = [];
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PUT') {
      uploads.push(String(input));
      if (String(input).endsWith('/scene')) {
        const scene = deserializeCompositionScene(JSON.parse(String(init.body))); revisions.push(scene.revision);
        if (scene.revision === 0) { entered(); await gate; }
      }
    }
    return clientFetch(input, init);
  };
  const thumbnail = new Blob([jpeg], { type: 'image/jpeg' });
  const first = store.saveComposition({ document: doc, assets, revision: 0, thumbnail });
  await started;
  const retained = store.compositionSaveRetention(doc.id); assert.equal(retained.length, 1);
  assert.equal(retained[0]?.bytes, 542);
  const firstSource = doc.sources[0]; assert.ok(firstSource);
  const calls = [];
  for (let revision = 1; revision <= 30; revision++) {
    // Alternate Undo to the shared source and Redo to a unique replacement.
    const bytes = encodeRaster({ format: 'rgba8-srgb-straight', size: firstSource.image.size, data: new Uint8Array(364).fill(revision) });
    const asset = await hashAsset(bytes), entries = new Map(assets);
    entries.set(asset, bytes); entries.set(assetId(999), new Uint8Array([1, 2, 3])); // history/gesture only
    const next = revision % 2 === 0 ? doc : compositionDocumentSchema.parse({ ...doc, sources: [{ ...firstSource, image: { ...firstSource.image, asset } }] });
    calls.push(store.saveComposition({ document: next, assets: entries, revision, thumbnail }));
    bytes.fill(255); // Capture is owned, not a mutable view into the live products.
    const roots = store.compositionSaveRetention(doc.id);
    assert.deepEqual(roots.map(({ revision }) => revision), [0, revision]);
    assert.equal(roots.reduce((sum, root) => sum + root.bytes, 0), 1084);
    assert.ok(roots.every((root) => !root.assets.includes(assetId(999))));
  }
  await assert.rejects(store.saveComposition({ document: doc, assets, revision: 30, thumbnail }), (error: unknown) => error instanceof store.ProjectRequestError && error.status === 409);
  release();
  assert.deepEqual(await first, { kind: 'saved', revision: 0 });
  const results = await Promise.all(calls);
  assert.equal(results.filter((result) => result.kind === 'superseded').length, 29);
  assert.deepEqual(results.at(-1), { kind: 'saved', revision: 30 });
  assert.deepEqual(revisions, [0, 30]);
  assert.equal(uploads.filter((path) => path.includes('/assets/') || path.endsWith('/photo')).length, assets.size);
  assert.deepEqual(store.compositionSaveRetention(doc.id), []);
  assert.equal((await store.loadCompositionProject(doc.id, new AbortController().signal)).revision, 30);
  await store.deleteProject(doc.id);
}));

test('v2 malformed acknowledgements never report Saved and terminal errors discard pending saves', async () => withClient(async () => {
  const { doc, assets } = await compositionFixture(403), route = `/api/projects/${doc.id}`;
  const input = { document: doc, assets, revision: 0, thumbnail: new Blob([jpeg], { type: 'image/jpeg' }) };
  await setFault(`path:${route}/thumbnail:corrupt:times=1`);
  await assert.rejects(store.saveComposition(input));
  assert.equal((await request(`${route}/scene`)).status, 404);
  assert.deepEqual(store.compositionSaveRetention(doc.id), []);
  await store.saveComposition({ ...input, revision: 1 });
  await store.deleteProject(doc.id);
  const results = await Promise.allSettled([store.saveComposition({ ...input, revision: 2 }), store.saveComposition({ ...input, revision: 3 })]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason instanceof store.ProjectRequestError && result.reason.status === 410));
  assert.deepEqual(store.compositionSaveRetention(doc.id), []);
}));
