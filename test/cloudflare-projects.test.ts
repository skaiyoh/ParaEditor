import { encodeRaster } from '../src/core/asset-codec.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { hashAsset, compositionInventory } from '../src/projects/assets.ts';
import { serializeCompositionScene, deserializeCompositionScene } from '../src/projects/serialize.ts';
import { newComposition, artworkLayer, rasterSource, repairProduct } from './fixtures/composition.ts';
import { DEPTH_MODEL, assetId } from './fixtures/documents.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { z } from '../src/core/zod.ts';
import { isAssetId, isSceneId } from '../src/core/ids.ts';
import { serializeScene } from '../src/projects/serialize.ts';
import type { Plane } from '../src/core/raster.ts';
import { legacyMinimalDocument as minimalDocument, legacyFiveClusterDocument as fiveClusterDocument, uuid } from './fixtures/documents.ts';
import { createHandler, type HostingConfig, type HostingEnv } from '../tools/cloudflare/worker.ts';
import type { ProjectsEnv } from '../tools/cloudflare/projects.ts';

const contract = z.object({ all: z.record(z.string(), z.string()), errors: z.record(z.string(), z.string()) })
  .parse(JSON.parse(await readFile(new URL('../headers.json', import.meta.url), 'utf8')));
const config = {
  routes: { '/': { kind: 'asset', headers: { ...contract.all, 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' } } },
  errors: { ...contract.all, ...contract.errors, 'Content-Type': 'text/plain; charset=utf-8' },
} satisfies HostingConfig;
const handler = createHandler(config);
const photo = new Uint8Array([0, 1, 255, 0, 128, 7]);
const jpeg = new Uint8Array([255, 216, 1, 2, 255, 217]);
const mask = new Uint8Array([0, 1, 127, 128, 254, 255]);
const asset = createHash('sha256').update(mask).digest('hex');
assert.ok(isAssetId(asset));
const source = fiveClusterDocument(), first = source.objects[0];
assert.ok(first !== undefined);
const plane = { format: 'u8', size: { width: 3, height: 2 }, data: mask } satisfies Plane<'u8'>;
const document = { ...source, objects: [{ ...first, produced: { ...first.produced, mask: { asset, format: plane.format, size: plane.size } } }], analysis: { ...source.analysis, plate: null } };
const wire = serializeScene(document, new Map([[asset, plane]]), 0);
const base = `/api/projects/${document.id}`;
const querySchema = z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) });
type Row = { id: string; name: string; scene: unknown; masks: Record<string, { width: number; height: number }>; revision: number; updated_at: string };

async function harness(t: TestContext) {
  const rows = new Map<string, Row>(), tombstones = new Set<string>();
  const objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  const calls: { query: string; params: (string | number)[] }[] = [];
  let clock = 0, fail = false, malformed = false;
  let beforePut: () => Promise<void> = async () => undefined;
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
  function execute({ query, params }: z.infer<typeof querySchema>) {
    calls.push({ query, params });
    const id = String(params[0]);
    if (query.startsWith('SELECT pg_advisory_xact_lock')) return result([{}]);
    if (query.startsWith('SELECT EXISTS')) return result([{ deleted: tombstones.has(id), masks: rows.get(id)?.masks ?? null, revision: rows.get(id)?.revision ?? null }]);
    if (query.startsWith('SELECT id, name')) return result([...rows.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
      .map(({ id, name, updated_at }) => ({ id, name, updated_at })));
    if (query.startsWith('SELECT scene')) {
      const row = rows.get(id);
      return result(row === undefined ? [] : [{ scene: row.scene, masks: row.masks, revision: String(row.revision) }]);
    }
    if (query.startsWith('WITH saved')) {
      assert.match(query, /WHERE projects.revision < EXCLUDED.revision/);
      assert.match(query, /NOT EXISTS \(SELECT 1 FROM tombstones/);
      if (tombstones.has(id)) return result([{ status: 'deleted' }]);
      const previous = rows.get(id), revision = Number(params[4]);
      if (previous !== undefined && revision <= previous.revision) return result([{ status: 'conflict' }]);
      rows.set(id, { id, name: String(params[1]), scene: JSON.parse(String(params[2])),
        masks: z.record(z.string(), z.object({ width: z.number(), height: z.number() })).parse(JSON.parse(String(params[3]))),
        revision, updated_at: new Date(1_790_000_000_000 + ++clock).toISOString() });
      return result([{ status: 'saved' }]);
    }
    if (query.startsWith('INSERT INTO tombstones')) { tombstones.add(id); return result([]); }
    if (query.startsWith('DELETE FROM projects')) { const existed = rows.delete(id); return result(existed ? [{ id }] : []); }
    if (query.startsWith('UPDATE projects')) {
      const row = rows.get(id);
      if (row !== undefined && !tombstones.has(id)) row.updated_at = new Date(1_790_000_000_000 + ++clock).toISOString();
      return result([]);
    }
    throw new Error('Unexpected SQL in test.');
  }
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/sql');
      assert.equal(req.headers['neon-connection-string'], 'postgresql://test:private@neon.example/test');
      assert.equal(req.headers['content-type'], 'application/json');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (fail) { res.writeHead(500); res.end('private database detail'); return; }
      if (malformed) { res.writeHead(200); res.end('{}'); return; }
      const batch = z.object({ queries: z.array(querySchema) }).safeParse(body);
      let response;
      if (batch.success) {
        assert.equal(req.headers['neon-batch-isolation-level'], 'ReadCommitted');
        assert.ok(batch.data.queries.length >= 2);
        assert.match(batch.data.queries[0]?.query ?? '', /^SELECT pg_advisory_xact_lock/);
        response = { results: batch.data.queries.map(execute) };
      } else response = execute(querySchema.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input) === 'https://neon.example/sql' ? `http://127.0.0.1:${address.port}/sql` : input, init);
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const bucket: ProjectsEnv['PROJECTS'] = {
    async head(key) { const object = objects.get(key); return object === undefined ? null : { size: object.bytes.byteLength }; },
    async get(key) {
      const object = objects.get(key);
      if (object === undefined) return null;
      return { size: object.bytes.byteLength, httpMetadata: { contentType: object.contentType },
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(object.bytes.slice(0))); controller.close(); } }) };
    },
    async put(key, value, options) { await beforePut(); objects.set(key, { bytes: value.slice(0), contentType: options.httpMetadata.contentType }); },
    async list({ prefix, cursor }) {
      // Small pages exercise continuation while the returned objects are deleted.
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor)).sort();
      const page = keys.slice(0, 2);
      return { objects: page.map((key) => ({ key })), truncated: keys.length > page.length, ...(keys.length > page.length ? { cursor: page.at(-1) ?? '' } : {}) };
    },
    async delete(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  };
  const env: HostingEnv = { PROJECTS: bucket, NEON_DATABASE_URL: 'postgresql://test:private@neon.example/test',
    ASSETS: { async fetch() { throw new Error('API must precede static dispatch.'); } },
    MODELS: { async head() { throw new Error('API must not use MODELS.'); }, async get() { throw new Error('API must not use MODELS.'); } } };
  const request = async (route: string, init?: RequestInit) => {
    const response = await createHandler(config).fetch(new Request(`https://hosting.example${route}`, init), env);
    for (const [name, value] of Object.entries(contract.all)) assert.equal(response.headers.get(name), value, name);
    assert.equal(response.headers.get('Cache-Control'), response.status >= 400 ? 'no-store' : 'no-cache');
    return response;
  };
  const put = (route: string, body: BodyInit, type = 'application/json') => request(route, { method: 'PUT', headers: { 'Content-Type': type }, body });
  return { rows, tombstones, objects, calls, request, put,
    failNeon: () => { fail = true; }, malformedNeon: () => { malformed = true; },
    holdPut: (callback: () => Promise<void>) => { beforePut = callback; } };
}
async function acknowledgement(response: Response) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); }
async function failure(response: Response, status: number, sentence?: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  const error = z.object({ error: z.string() }).parse(await response.json()).error;
  assert.match(error, /^[^\n]+\.$/);
  if (sentence !== undefined) assert.equal(error, sentence);
}

test('hosting store persists each part byte for byte, upserts scenes, and lists only completed scenes in server order', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await (await h.request('/api/projects')).json(), { projects: [] });
  await acknowledgement(await h.put(`${base}/photo`, photo, 'image/png; charset=binary'));
  await acknowledgement(await h.put(`${base}/masks/${asset}`, mask, 'application/octet-stream'));
  await acknowledgement(await h.put(`${base}/thumbnail`, jpeg, 'image/jpeg'));
  assert.deepEqual(await (await h.request('/api/projects')).json(), { projects: [] });
  await acknowledgement(await h.put(`${base}/scene`, JSON.stringify(wire)));
  assert.deepEqual(await (await h.request(`${base}/scene`)).json(), wire);
  for (const [part, bytes, type] of [['photo', photo, 'image/png'], [`masks/${asset}`, mask, 'application/octet-stream'], ['thumbnail', jpeg, 'image/jpeg']] satisfies [string, Uint8Array<ArrayBuffer>, string][]) {
    const response = await h.request(`${base}/${part}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), type);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
  const secondId = uuid(88); assert.ok(isSceneId(secondId));
  const second = { ...minimalDocument(), id: secondId, title: 'Second project' };
  await acknowledgement(await h.put(`/api/projects/${secondId}/scene`, JSON.stringify(serializeScene(second, new Map(), 0))));
  const list = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), updatedAt: z.iso.datetime(), thumbnail: z.string() })) });
  assert.deepEqual(list.parse(await (await h.request('/api/projects')).json()).projects.map(({ id }) => id), [secondId, document.id]);
  await acknowledgement(await h.put(`${base}/scene`, JSON.stringify({ ...wire, document: { ...document, title: 'Updated project' }, revision: 1 })));
  assert.equal(h.rows.get(document.id)?.name, 'Updated project');
  const before = h.rows.get(document.id)?.updated_at;
  await acknowledgement(await h.put(`${base}/photo`, photo, 'image/png'));
  assert.notEqual(h.rows.get(document.id)?.updated_at, before);
  // Ties are deterministic by id, independently of insertion order.
  for (const row of h.rows.values()) row.updated_at = '2026-10-10T00:00:00.000Z';
  assert.deepEqual(list.parse(await (await h.request('/api/projects')).json()).projects.map(({ id }) => id), [document.id, secondId].sort());
});

test('scene-first masks validate metadata and bytes in either arrival order; invalid bodies never mutate storage', async (t) => {
  const h = await harness(t);
  await acknowledgement(await h.put(`${base}/scene`, JSON.stringify(wire)));
  await acknowledgement(await h.put(`${base}/masks/${asset}`, mask, 'application/octet-stream'));
  const cases: [string, BodyInit, string][] = [
    [`${base}/scene`, '{', 'application/json'], [`${base}/scene`, '{}', 'application/json'],
    [`${base}/scene`, JSON.stringify({ ...wire, revision: -1 }), 'application/json'],
    [`${base}/scene`, JSON.stringify({ ...wire, document: { ...document, id: uuid(23) } }), 'application/json'],
    [`${base}/scene`, JSON.stringify({ ...wire, masks: { [asset]: { width: 4097, height: 1 } } }), 'application/json'],
    [`${base}/scene`, JSON.stringify({ ...wire, masks: { [asset]: { width: 2, height: 3 } } }), 'application/json'],
    [`${base}/scene`, JSON.stringify(wire), 'text/plain'],
    [`${base}/photo`, photo, 'text/plain'], [`${base}/photo`, '', 'image/png'],
    [`${base}/thumbnail`, photo, 'image/jpeg'], [`${base}/thumbnail`, jpeg, 'image/png'],
    [`${base}/masks/${asset}`, new Uint8Array(2), 'application/octet-stream'],
    [`${base}/masks/${asset}`, new Uint8Array(6), 'application/octet-stream'],
    [`${base}/masks/${asset}`, mask, 'image/png'],
  ];
  for (const [route, body, type] of cases) await failure(await h.put(route, body, type), 400);
  assert.deepEqual(await (await h.request(`${base}/scene`)).json(), wire);
  const row = h.rows.get(document.id); assert.ok(row);
  // A stale checkpoint is terminal before checking its old mask dimensions.
  await failure(await h.put(`${base}/scene`, JSON.stringify({ ...wire,
    document: { ...document, objects: [{ ...first, produced: { ...first.produced, mask: { asset, format: 'u8', size: { width: 1, height: 5 } } } }] },
    masks: { [asset]: { width: 1, height: 5 } } })), 409, 'The project scene revision must increase.');
  row.masks = { [asset]: { width: 1, height: 5 } };
  await failure(await h.put(`${base}/scene`, JSON.stringify({ ...wire, revision: 1,
    document: { ...document, objects: [{ ...first, produced: { ...first.produced, mask: { asset, format: 'u8', size: { width: 1, height: 5 } } } }] },
    masks: { [asset]: { width: 1, height: 5 } } })), 400, 'The project mask size does not match its bytes.');
});

test('path validation, missing resources and all hosted body bounds carry the header contract', async (t) => {
  const h = await harness(t);
  for (const part of ['scene', 'photo', 'thumbnail', `masks/${asset}`]) await failure(await h.request(`${base}/${part}`), 404, 'The project was not found.');
  for (const route of ['/api/projects/', '/api/projects/UPPER/scene', `/api/projects/${document.id.toUpperCase()}/scene`, `${base}/masks/${asset.toUpperCase()}`, `${base}/scene/extra`, `${base}/unknown`, `${base}/masks/not-a-hash`]) {
    await failure(await h.request(route), 400, 'The project path is invalid.');
  }
  for (const [part, limit, type] of [['scene', 1024 * 1024, 'application/json'], ['photo', 24 * 1024 * 1024, 'image/png'], [`masks/${asset}`, 16 * 1024 * 1024, 'application/octet-stream'], ['thumbnail', 59_999, 'image/jpeg']] satisfies [string, number, string][]) {
    await failure(await h.put(`${base}/${part}`, new Uint8Array(limit + 1), type), 413, 'The project body is too large.');
    await failure(await h.request(`${base}/${part}`, { method: 'PUT', headers: { 'Content-Type': type, 'Content-Length': String(limit + 1) }, body: 'x' }), 413);
  }
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(59_999)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  const streaming = new Request(`https://hosting.example${base}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: stream, ...{ duplex: 'half' } });
  await failure(await handler.fetch(streaming, { PROJECTS: { async head() { return null; }, async get() { return null; }, async put() { throw new Error('No mutation'); }, async delete() {}, async list() { return { objects: [], truncated: false }; } },
    NEON_DATABASE_URL: 'postgresql://test:private@neon.example/test', ASSETS: { async fetch() { throw new Error(); } }, MODELS: { async head() { return null; }, async get() { return null; } } }), 413);
  assert.equal(h.objects.size, 0); assert.equal(h.rows.size, 0);
  assert.equal((await h.request('/api/projects', { method: 'POST' })).status, 405);
  assert.equal((await h.request(`${base}/scene`, { method: 'POST' })).status, 405);
});

test('revisions strictly increase, deletion paginates the entire prefix, and tombstones survive new handlers', async (t) => {
  const h = await harness(t);
  await acknowledgement(await h.put(`${base}/scene`, JSON.stringify({ ...wire, revision: 2 })));
  for (const revision of [0, 1, 2]) await failure(await h.put(`${base}/scene`, JSON.stringify({ ...wire, revision })), 409, 'The project scene revision must increase.');
  assert.equal(h.rows.get(document.id)?.revision, 2);
  const prefix = `projects/${document.id}/`;
  for (const name of ['photo', 'thumbnail', `masks/${asset}`, 'old/one', 'old/two', 'old/three']) h.objects.set(`${prefix}${name}`, { bytes: photo.buffer.slice(0), contentType: 'image/png' });
  h.objects.set('projects/other/photo', { bytes: photo.buffer.slice(0), contentType: 'image/png' });
  await acknowledgement(await h.request(base, { method: 'DELETE' }));
  assert.deepEqual([...h.objects.keys()], ['projects/other/photo']);
  assert.equal(h.rows.size, 0); assert.ok(h.tombstones.has(document.id));
  for (const [part, body, type] of [['scene', JSON.stringify({ ...wire, revision: 3 }), 'application/json'], ['photo', photo, 'image/png'], ['thumbnail', jpeg, 'image/jpeg'], [`masks/${asset}`, mask, 'application/octet-stream']] satisfies [string, BodyInit, string][]) {
    await failure(await h.put(`${base}/${part}`, body, type), 410, 'The project was deleted.');
  }
  for (const part of ['scene', 'photo', 'thumbnail', `masks/${asset}`]) await failure(await h.request(`${base}/${part}`), 404);
  await failure(await h.request(base, { method: 'DELETE' }), 404, 'The project was not found.');
  const absent = `/api/projects/${uuid(299)}`;
  await failure(await h.request(absent, { method: 'DELETE' }), 404, 'The project was not found.');
  await failure(await h.put(`${absent}/photo`, photo, 'image/png'), 410);
  assert.deepEqual(await (await h.request('/api/projects')).json(), { projects: [] });
  const staged = `/api/projects/${uuid(300)}`;
  await acknowledgement(await h.put(`${staged}/photo`, photo, 'image/png'));
  await acknowledgement(await h.request(staged, { method: 'DELETE' }));
  await failure(await h.put(`${staged}/photo`, photo, 'image/png'), 410);
});

test('DELETE wins a delayed R2 PUT and the late writer cleans its bytes without touching other ids', async (t) => {
  const h = await harness(t);
  await acknowledgement(await h.put(`${base}/scene`, JSON.stringify(wire)));
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.holdPut(async () => { entered(); await gate; });
  const pending = h.put(`${base}/photo`, photo, 'image/png');
  await started;
  await acknowledgement(await h.request(base, { method: 'DELETE' }));
  release();
  await failure(await pending, 410, 'The project was deleted.');
  assert.equal(h.objects.size, 0); assert.equal(h.rows.size, 0);
  await failure(await h.request(`${base}/photo`), 404);
});

test('upstream Neon errors and malformed success responses become one-sentence 502s without private details', async (t) => {
  const h = await harness(t);
  h.malformedNeon();
  await failure(await h.request('/api/projects'), 502, 'The project store is unavailable.');
  h.failNeon();
  await failure(await h.request('/api/projects'), 502, 'The project store is unavailable.');
  await failure(await h.put(`${base}/photo`, photo, 'image/png'), 502, 'The project store is unavailable.');
  assert.equal(h.objects.size, 0);
});

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

test('v2 worker checkpoint validates all durable bytes, immutable original, descriptors and preserves last-good revision', async (t) => {
  const h = await harness(t), { doc, assets, photoId, rgbaId } = await compositionFixture(501), route = `/api/projects/${doc.id}`;
  const wire = serializeCompositionScene(doc, 1);
  await failure(await h.put(`${route}/scene`, JSON.stringify(wire)), 400);
  for (const [asset, bytes] of assets) {
    if (asset === photoId) await acknowledgement(await h.request(`${route}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'X-Project-Asset': asset }, body: new Uint8Array(bytes) }));
    else await acknowledgement(await h.put(`${route}/assets/${asset}`, new Uint8Array(bytes), 'application/octet-stream'));
  }
  await acknowledgement(await h.put(`${route}/scene`, JSON.stringify(wire)));
  assert.deepEqual(await (await h.request(`${route}/scene`)).json(), wire);
  assert.deepEqual(h.rows.get(doc.id)?.masks, {});
  for (const [asset, bytes] of assets) assert.deepEqual(new Uint8Array(await (await h.request(`${route}/assets/${asset}`)).arrayBuffer()), bytes);
  await acknowledgement(await h.put(`${route}/photo`, new Uint8Array(photo.length), 'image/jpeg'));
  assert.deepEqual(new Uint8Array(await (await h.request(`${route}/assets/${photoId}`)).arrayBuffer()), photo);
  const next = { ...wire, revision: 2 };
  const key = `projects/${doc.id}/assets/${rgbaId}`, saved = h.objects.get(key); assert.ok(saved);
  h.objects.delete(key);
  await failure(await h.put(`${route}/scene`, JSON.stringify(next)), 400);
  h.objects.set(key, { ...saved, bytes: new Uint8Array(saved.bytes.byteLength).buffer });
  await failure(await h.put(`${route}/scene`, JSON.stringify(next)), 400);
  h.objects.set(key, saved);
  assert.deepEqual(await (await h.request(`${route}/scene`)).json(), wire);
  const source = doc.sources[0]; assert.ok(source);
  await failure(await h.put(`${route}/scene`, JSON.stringify({ ...next, document: { ...doc, sources: [{ ...source, image: { ...source.image, size: { width: 7, height: 13 } } }] } })), 400);
  await acknowledgement(await h.put(`${route}/scene`, JSON.stringify(next)));
  await failure(await h.put(`${route}/scene`, JSON.stringify(wire)), 409);
  await failure(await h.put(`${route}/assets/${rgbaId}`, new Uint8Array([1]), 'application/octet-stream'), 400);
  await failure(await h.put(`${route}/assets/${rgbaId}`, new Uint8Array(20 * 1024 * 1024 + 1), 'application/octet-stream'), 413);
  await acknowledgement(await h.request(route, { method: 'DELETE' }));
  assert.equal(h.objects.size, 0); assert.equal(h.rows.size, 0);
  for (const asset of assets.keys()) await failure(await h.request(`${route}/assets/${asset}`), 404);
  await failure(await h.put(`${route}/assets/${rgbaId}`, new Uint8Array(saved.bytes), 'application/octet-stream'), 410);
});

test('v2 assets and immutable originals obey late-upload/delete cleanup without changing other prefixes', async (t) => {
  const h = await harness(t), { doc, assets, photoId, rgbaId } = await compositionFixture(502), route = `/api/projects/${doc.id}`;
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  h.holdPut(async () => { entered(); await gate; });
  const bytes = assets.get(rgbaId); assert.ok(bytes);
  const pending = h.put(`${route}/assets/${rgbaId}`, new Uint8Array(bytes), 'application/octet-stream');
  await started;
  await failure(await h.request(route, { method: 'DELETE' }), 404);
  release();
  await failure(await pending, 410);
  assert.equal(h.objects.size, 0);
  await failure(await h.request(`${route}/photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'X-Project-Asset': photoId }, body: photo }), 410);
});
