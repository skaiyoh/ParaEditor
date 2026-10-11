import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createHandler } from '../tools/cloudflare/worker.ts';
import type { GalleryEnv } from '../tools/cloudflare/gallery.ts';
import { GALLERY_LIMITS, galleryCreatedSchema, galleryDraftSchema, galleryListSchema, galleryManifestSchema } from '../src/core/gallery.ts';
import { z } from '../src/core/zod.ts';
import { fiveClusterDocument, minimalDocument, setAt, uuid } from './fixtures/documents.ts';

// Complete baseline JPEG: a single gray pixel, one quantizer and two Huffman tables.
const jpeg = new Uint8Array([255,216,255,219,0,67,0,...Array<number>(64).fill(1),255,192,0,11,8,0,1,0,1,1,1,17,0,
  255,196,0,20,0,1,...Array<number>(15).fill(0),0,255,196,0,20,16,1,...Array<number>(15).fill(0),0,
  255,218,0,8,1,1,0,0,63,0,63,255,217]);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const indexKey = (id: string, publishedAt: string): string => `gallery/index/${String(8_640_000_000_000_000 - Date.parse(publishedAt)).padStart(16, '0')}-${id}`;
const source = { kind: 'source', id: hash(jpeg), mediaType: 'image/jpeg', size: { width: 1, height: 1 }, byteLength: jpeg.length };
const document = minimalDocument();
const draft = galleryDraftSchema.parse({ document: { ...document, frame: { ...document.frame,
  source: { asset: source.id, mediaType: source.mediaType, byteLength: source.byteLength },
  original: { name: 'gray.jpg', mediaType: source.mediaType, size: source.size } } }, assets: [source], poster: { ...source, kind: 'poster' } });
const errorSchema = z.object({ error: z.string() });
type Stored = { bytes: ArrayBuffer; contentType: string };
function harness(admin?: string, galleryPage = false) {
  const objects = new Map<string, Stored>();
  const calls: { method: string; key: string; limit: number | null }[] = [];
  let putHook: (key: string) => Promise<void> = async () => {};
  let fail = false;
  const bucket: GalleryEnv['PROJECTS'] = {
    async head(key) { calls.push({ method: 'head', key, limit: null }); if (fail) throw new Error('private upstream details'); const value = objects.get(key); return value === undefined ? null : { size: value.bytes.byteLength }; },
    async get(key) { calls.push({ method: 'get', key, limit: null }); if (fail) throw new Error('private upstream details'); const value = objects.get(key); if (value === undefined) return null;
      const body = new Response(value.bytes).body; assert.ok(body); return { size: value.bytes.byteLength, body, httpMetadata: { contentType: value.contentType } }; },
    async put(key, bytes, options) { await putHook(key); if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      objects.set(key, { bytes: bytes.slice(0), contentType: options.httpMetadata.contentType }); return { key }; },
    async delete(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
    async list({ prefix, cursor, limit }) { calls.push({ method: 'list', key: prefix, limit: limit ?? null });
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor)).sort();
      const page = keys.slice(0, limit ?? 2), last = page.at(-1); return { objects: page.map((key) => ({ key })), truncated: keys.length > page.length, ...(last === undefined ? {} : { cursor: last }) }; },
  };
  const handler = createHandler({ routes: { '/': { kind: 'asset', headers: { 'X-Gallery-Test': 'root', 'Cache-Control': 'immutable' } },
    ...(galleryPage ? { '/gallery.html': { kind: 'asset', headers: { 'X-Gallery-Test': 'page', 'Cache-Control': 'no-cache' } } } : {}) }, errors: { 'Cache-Control': 'no-store' } });
  const fetched: string[] = [];
  const env = { PROJECTS: bucket, ...(admin === undefined ? {} : { GALLERY_ADMIN_KEY: admin }),
    ASSETS: { async fetch(request: Request) {
      const url = new URL(request.url); fetched.push(url.pathname);
      // Pages redirects explicit .html fetches to the pretty path.
      if (url.pathname.endsWith('.html')) { url.pathname = url.pathname.slice(0, -5); return Response.redirect(url, 308); }
      return new Response('gallery page');
    } },
    MODELS: { async head() { return null; }, async get() { return null; } } };
  const request = (route: string, init?: RequestInit) => handler.fetch(new Request(`https://gallery.example${route}`, init), env);
  const create = async (body: unknown = draft) => {
    const response = await request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 201, await response.clone().text()); return galleryCreatedSchema.parse(await response.json());
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const upload = (id: string, token: string, part = `assets/${source.id}`, bytes: BodyInit = jpeg) => request(`/api/gallery/${id}/${part}`, { method: 'PUT', headers: { ...auth(token), 'Content-Type': 'image/jpeg' }, body: bytes });
  const publish = (id: string, token: string) => request(`/api/gallery/${id}/publish`, { method: 'POST', headers: auth(token) });
  const remove = (id: string, token: string) => request(`/api/gallery/${id}`, { method: 'DELETE', headers: auth(token) });
  const ready = async () => { const created = await create(); await ack(await upload(created.id, created.token)); await ack(await upload(created.id, created.token, 'poster')); return created; };
  return { objects, calls, request, create, auth, upload, publish, remove, ready, fetched, holdPut(fn: typeof putHook) { putHook = fn; }, failStorage() { fail = true; } };
}
async function ack(response: Response): Promise<void> { assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('Cache-Control'), 'no-cache'); assert.deepEqual(await response.json(), { ok: true }); }
async function failure(response: Response, status: number, sentence?: string): Promise<void> {
  assert.equal(response.status, status, await response.clone().text()); assert.equal(response.headers.get('Cache-Control'), 'no-cache');
  const body = errorSchema.parse(await response.json()); assert.match(body.error, /^[A-Z].*\.$/); if (sentence !== undefined) assert.equal(body.error, sentence);
}

test('gallery draft stays private; publish exposes the immutable manifest, source and poster with hash ETags', async () => {
  const h = harness(), { id, token } = await h.ready(), base = `/api/gallery/${id}`;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(token, 'base64url').length, 32);
  const stored = [...h.objects.values()].map((value) => new TextDecoder().decode(value.bytes)).join('');
  assert.ok(!stored.includes(token)); assert.ok(stored.includes(hash(new TextEncoder().encode(token))));
  assert.deepEqual(await (await h.request('/api/gallery')).json(), { pieces: [] });
  for (const route of [base, `${base}/poster`, `${base}/assets/${source.id}`]) await failure(await h.request(route), 404);
  const published = await h.publish(id, token); assert.equal(published.status, 200);
  const manifest = galleryManifestSchema.parse(await published.json()); assert.deepEqual(manifest.document, draft.document);
  assert.ok(h.objects.has(indexKey(id, manifest.publishedAt)), 'publication uses the timestamp-ordered index key');
  assert.deepEqual(await (await h.request(base)).json(), manifest);
  assert.deepEqual(await (await h.publish(id, token)).json(), manifest, 'retry preserves publication timestamp');
  const listed = galleryListSchema.parse(await (await h.request('/api/gallery')).json());
  assert.deepEqual(listed.pieces, [{ id, publishedAt: manifest.publishedAt, poster: `${base}/poster`, size: source.size }]);
  for (const part of ['poster', `assets/${source.id}`]) { const response = await h.request(`${base}/${part}`); assert.equal(response.status, 200);
    assert.equal(response.headers.get('ETag'), `"${source.id}"`); assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
    assert.equal(response.headers.get('Cache-Control'), 'no-cache'); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg); }
  await failure(await h.upload(id, token), 409); await failure(await h.request(`${base}/assets/${'a'.repeat(64)}`), 404);
  await ack(await h.remove(id, token)); await ack(await h.remove(id, token));
  assert.deepEqual([...h.objects.keys()], [`gallery/deleted/${id}`]);
  await failure(await h.request(base), 404); await failure(await h.upload(id, token), 410); await failure(await h.publish(id, token), 410);
  assert.deepEqual(await (await h.request('/api/gallery')).json(), { pieces: [] });
});

test('publication refuses missing and wrong-length stored assets; uploads refuse hash, length, type and JPEG dimensions', async () => {
  const h = harness(), { id, token } = await h.create();
  await failure(await h.publish(id, token), 409, 'The gallery assets are missing or incomplete.');
  await failure(await h.upload(id, token, `assets/${source.id}`, jpeg.slice(1)), 400);
  const wrong = jpeg.slice(); wrong[10] = 4; await failure(await h.upload(id, token, `assets/${source.id}`, wrong), 400, 'The gallery asset bytes do not match their id.');
  await failure(await h.upload(id, token, `assets/${source.id}`, new Uint8Array(jpeg.length + 1)), 413);
  await failure(await h.request(`/api/gallery/${id}/assets/${source.id}`, { method: 'PUT', headers: { ...h.auth(token), 'Content-Type': 'text/html' }, body: jpeg }), 400);
  await failure(await h.upload(id, token, `assets/${'a'.repeat(64)}`), 400);
  await ack(await h.upload(id, token)); await ack(await h.upload(id, token, 'poster'));
  h.objects.set(`gallery/pieces/${id}/assets/${source.id}`, { bytes: new ArrayBuffer(1), contentType: 'image/jpeg' });
  await failure(await h.publish(id, token), 409);
  const mismatch = await h.create({ ...draft, poster: { ...draft.poster, size: { width: 2, height: 1 } } });
  await failure(await h.upload(mismatch.id, mismatch.token, 'poster'), 400, 'The gallery poster must be a JPEG no larger than 1280 pixels.');
  const notJpeg = new Uint8Array(jpeg.length); const invalid = await h.create({ ...draft, poster: { ...draft.poster, id: hash(notJpeg) } });
  await failure(await h.upload(invalid.id, invalid.token, 'poster', notJpeg), 400);
});

test('device and configured admin authorize deletion; wrong, absent and unset admin tokens fail closed', async () => {
  for (const admin of [undefined, 'admin-test-secret']) {
    const h = harness(admin), { id, token } = await h.ready(); assert.equal((await h.publish(id, token)).status, 200);
    for (const wrong of ['wrong-token', 'undefined', 'admin-test-secret']) {
      if (wrong !== admin) await failure(await h.remove(id, wrong), 403);
    }
    await failure(await h.request(`/api/gallery/${id}`, { method: 'DELETE' }), 403);
    await failure(await h.upload(id, 'admin-test-secret'), 403);
    await ack(await h.remove(id, admin ?? token));
    await failure(await h.request(`/api/gallery/${id}/poster`), 404);
  }
});

test('listing 500 pieces reads the newest 60 with a bounded R2 list limit and call count', async () => {
  const h = harness();
  for (let i = 0; i < 500; i++) { const id = uuid(i), publishedAt = new Date(Date.UTC(2026, 9, 10, 0, 0, i)).toISOString();
    h.objects.set(indexKey(id, publishedAt), { bytes: new TextEncoder().encode(JSON.stringify({ id, publishedAt, poster: `/api/gallery/${id}/poster`, size: source.size })).buffer, contentType: 'application/json' }); }
  const result = galleryListSchema.parse(await (await h.request('/api/gallery')).json());
  assert.equal(result.pieces.length, 60); assert.deepEqual(result.pieces.map((piece) => piece.id), Array.from({ length: 60 }, (_, i) => uuid(499 - i)));
  assert.deepEqual(h.calls.filter((call) => call.method === 'list'), [{ method: 'list', key: 'gallery/index/', limit: 60 }]);
  assert.equal(h.calls.length, 121, 'one list, sixty entry reads and sixty tombstone checks');
  h.calls.length = 0;
  h.objects.set(`gallery/deleted/${uuid(499)}`, { bytes: new ArrayBuffer(0), contentType: 'application/json' });
  const filtered = galleryListSchema.parse(await (await h.request('/api/gallery')).json());
  assert.deepEqual(filtered.pieces.map((piece) => piece.id), Array.from({ length: 60 }, (_, i) => uuid(498 - i)));
  assert.ok(h.calls.length <= 124);
  assert.ok(h.calls.filter((call) => call.method === 'list').every((call) => call.limit !== null && call.limit <= 60));
  h.calls.length = 0;
  for (let i = 0; i < 500; i++) h.objects.set(`gallery/deleted/${uuid(i)}`, { bytes: new ArrayBuffer(0), contentType: 'application/json' });
  assert.deepEqual(await (await h.request('/api/gallery')).json(), { pieces: [] });
  assert.equal(h.calls.filter((call) => call.method === 'get').length, 120, 'deletion backlog cannot extend the scan budget');
  assert.equal(h.calls.filter((call) => call.method === 'head').length, 120);
  assert.equal(h.calls.length, 242, 'two bounded pages and only their tombstone checks');
});

test('equal publication times sort by UUID regardless of insertion order', async () => {
  const h = harness(), publishedAt = '2026-10-10T12:00:00.000Z';
  for (const id of [uuid(20), uuid(19)]) h.objects.set(indexKey(id, publishedAt), {
    bytes: new TextEncoder().encode(JSON.stringify({ id, publishedAt, poster: `/api/gallery/${id}/poster`, size: source.size })).buffer, contentType: 'application/json',
  });
  assert.deepEqual(galleryListSchema.parse(await (await h.request('/api/gallery')).json()).pieces.map((piece) => piece.id), [uuid(19), uuid(20)]);
});

test('publication rejects same-length corruption in the source asset and poster before indexing', async () => {
  for (const part of [`assets/${source.id}`, 'poster']) {
    const h = harness(), { id, token } = await h.ready();
    const bytes = jpeg.slice(); bytes[10] = (bytes[10] ?? 0) ^ 1;
    h.objects.set(`gallery/pieces/${id}/${part}`, { bytes: bytes.buffer, contentType: 'image/jpeg' });
    await failure(await h.publish(id, token), 409, 'The gallery asset bytes do not match their id.');
    assert.equal([...h.objects.keys()].filter((key) => key.startsWith('gallery/index/')).length, 0);
    assert.ok(!h.objects.has(`gallery/pieces/${id}/manifest`));
    assert.deepEqual(await (await h.request('/api/gallery')).json(), { pieces: [] });
    await failure(await h.request(`/api/gallery/${id}`), 404);
  }
});

test('published resources honor strong, weak, wildcard and list validators only while live and present', async () => {
  const h = harness(), { id, token } = await h.ready();
  const base = `/api/gallery/${id}`, etag = `"${source.id}"`;
  const conditions = [etag, `W/${etag}`, '*', `"${'a'.repeat(64)}", W/${etag}`];
  for (const part of ['poster', `assets/${source.id}`]) {
    for (const condition of conditions) await failure(await h.request(`${base}/${part}`, { headers: { 'If-None-Match': condition } }), 404);
  }
  assert.equal((await h.publish(id, token)).status, 200);
  for (const part of ['poster', `assets/${source.id}`]) {
    for (const condition of conditions) {
      const response = await h.request(`${base}/${part}`, { headers: { 'If-None-Match': condition } });
      assert.equal(response.status, 304); assert.equal(response.headers.get('ETag'), etag);
      assert.equal(response.headers.get('Cache-Control'), 'no-cache'); assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    const changed = await h.request(`${base}/${part}`, { headers: { 'If-None-Match': `"${'a'.repeat(64)}"` } });
    assert.equal(changed.status, 200); assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), jpeg);
  }
  await failure(await h.request(`${base}/assets/${'a'.repeat(64)}`, { headers: { 'If-None-Match': '*' } }), 404);
  h.objects.delete(`gallery/pieces/${id}/poster`);
  await failure(await h.request(`${base}/poster`, { headers: { 'If-None-Match': '*' } }), 404);
  await ack(await h.remove(id, token));
  for (const part of ['poster', `assets/${source.id}`]) for (const condition of conditions) await failure(await h.request(`${base}/${part}`, { headers: { 'If-None-Match': condition } }), 404);
});

test('draft resource limits, malformed paths, unsupported methods and unavailable storage return sentences', async () => {
  const h = harness();
  const changes: readonly (readonly [readonly (string | number)[], unknown])[] = [
    [['assets', 0, 'byteLength'], GALLERY_LIMITS.source + 1], [['poster', 'byteLength'], GALLERY_LIMITS.poster + 1],
    [['poster', 'size', 'width'], 1281], [['assets'], Array.from({ length: 41 }, () => source)], [['document', 'provenance', 'importedOn'], 'x'.repeat(GALLERY_LIMITS.document + 1)],
    [['assets', 0, 'mediaType'], 'text/html'], [['assets', 0, 'kind'], 'other'],
  ];
  for (const [key, value] of changes) { const response = await h.request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setAt(draft, key, value)) }); assert.ok([400, 413].includes(response.status), await response.text()); }
  await failure(await h.request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(GALLERY_LIMITS.draft + 1) }, body: '{}' }), 413);
  await failure(await h.request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400);
  await failure(await h.request('/api/gallery', { method: 'POST', body: '{}' }), 400);
  for (const route of ['/api/gallery/', '/api/gallery/nope', `/api/gallery/${uuid(9)}/extra`, `/api/gallery/${uuid(9)}/poster/extra`, `/api/gallery/${uuid(9)}/assets/nope`]) await failure(await h.request(route), 400);
  await failure(await h.request('/api/gallery/%FF'), 400);
  await failure(await h.request(`/api/gallery/${uuid(9)}`), 404);
  await failure(await h.request('/api/gallery', { method: 'PUT' }), 405);
  h.failStorage(); await failure(await h.request(`/api/gallery/${uuid(9)}`), 502, 'The gallery store is unavailable.');
});

test('Worker rejects otherwise consistent oversized masks, depth and plate planes and the aggregate piece limit', async () => {
  const h = harness(), full = fiveClusterDocument(), object = full.objects[0]; assert.ok(object); assert.ok(full.analysis.depth); assert.ok(full.analysis.plate);
  const post = (value: unknown) => h.request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  for (const [kind, channels, bytes] of [['mask', 1, GALLERY_LIMITS.mask + 1], ['depth', 4, GALLERY_LIMITS.plane + 4], ['plate', 3, GALLERY_LIMITS.plane + 1]] satisfies [string, number, number][]) {
    const id = 'a'.repeat(64), size = { width: bytes / channels, height: 1 };
    const descriptor = { kind, id, size, byteLength: bytes, format: kind === 'mask' ? 'u8' : kind === 'depth' ? 'f32' : 'rgb8' };
    const scene = { ...draft.document, objects: kind === 'mask' ? [{ ...object, produced: { ...object.produced, mask: { asset: id, format: 'u8', size } } }] : [],
      analysis: { ...draft.document.analysis, depth: kind === 'depth' ? { ...full.analysis.depth, map: { asset: id, format: 'f32', size } } : null,
        plate: kind === 'plate' ? { ...full.analysis.plate, image: { asset: id, size }, forMasks: [] } : null } };
    await failure(await post({ ...draft, document: scene, assets: [...draft.assets, descriptor] }), 400);
  }
  const masks = Array.from({ length: 7 }, (_, index) => ({ kind: 'mask', id: (index + 10).toString(16).padStart(64, '0'), format: 'u8', size: { width: 4096, height: 4096 }, byteLength: GALLERY_LIMITS.mask }));
  await failure(await post({ ...draft, assets: [...draft.assets, ...masks], document: { ...draft.document,
    objects: masks.map((mask, index) => ({ ...object, id: uuid(index + 100), produced: { ...object.produced, mask: { asset: mask.id, format: 'u8', size: mask.size } } })) } }), 400);
});

test('gallery page aliases use the prepared gallery route headers and only valid UUID paths', async () => {
  const present = harness(undefined, true), absent = harness();
  for (const route of ['/gallery', `/gallery/${uuid(1)}`]) {
    const response = await present.request(route); assert.equal(response.status, 200); assert.equal(response.headers.get('X-Gallery-Test'), 'page'); assert.equal(await response.text(), 'gallery page');
    assert.equal(response.headers.get('Location'), null, 'the alias serves in place, retaining the piece URL');
    assert.equal((await absent.request(route)).status, 404);
    const head = await present.request(route, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('Location'), null);
    assert.equal(head.headers.get('X-Gallery-Test'), 'page'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  assert.deepEqual(present.fetched, ['/gallery', '/gallery', '/gallery', '/gallery']);
  for (const route of ['/gallery/nope', `/gallery/${uuid(1)}/extra`]) assert.equal((await present.request(route)).status, 404);
});

test('DELETE wins delayed upload, manifest and index writes and cleans every late object', async () => {
  for (const phase of ['assets/', 'manifest', 'gallery/index/']) {
    const h = harness(), created = phase === 'assets/' ? await h.create() : await h.ready();
    let release = () => {}, entered = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
    h.holdPut(async (key) => { if (key.includes(phase)) { entered(); await gate; } });
    const pending = phase === 'assets/' ? h.upload(created.id, created.token) : h.publish(created.id, created.token);
    await started; await ack(await h.remove(created.id, created.token)); release();
    await failure(await pending, 410); assert.deepEqual([...h.objects.keys()], [`gallery/deleted/${created.id}`]);
    assert.deepEqual(await (await h.request('/api/gallery')).json(), { pieces: [] });
  }
});

test('concurrent publish writes preserve the first manifest and publication time', async () => {
  const h = harness(), { id, token } = await h.ready();
  let release = () => {}, entered = () => {}; let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  h.holdPut(async (key) => { if (key.endsWith('/manifest') && !held) { held = true; entered(); await gate; } });
  const first = h.publish(id, token); await started;
  const second = await h.publish(id, token); assert.equal(second.status, 200); const manifest = await second.json();
  release(); assert.deepEqual(await (await first).json(), manifest); assert.deepEqual(await (await h.request(`/api/gallery/${id}`)).json(), manifest);
  assert.equal([...h.objects.keys()].filter((key) => key.startsWith('gallery/index/')).length, 1);
});
