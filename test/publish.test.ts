import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createPublishSession, type PublishInput, type PublishProgress } from '../src/session/publish.ts';
import { createProducts, productAsset } from '../src/session/products.ts';
import { galleryDraftSchema, galleryIdSchema, type GalleryDraft } from '../src/core/gallery.ts';
import { currentDocumentSchema } from '../src/core/schema.ts';
import { sortedMasks } from '../src/core/produce.ts';
import * as client from '../src/projects/gallery.ts';
import { createGalleryTokenStore } from '../src/projects/gallery-tokens.ts';
import { createGalleryDevice } from '../src/projects/gallery-device.ts';
import { GalleryLoadError, loadGallery, listGallery } from '../src/app/gallery-bootstrap.ts';
import { minimalDocument, fiveClusterDocument, assetId, uuid, DEPTH_MODEL, INPAINT_MODEL } from './fixtures/documents.ts';
import { startServer, tempDir, type Server } from './support/cli.ts';

const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD109TSUp6mkr1D48//2Q==', 'base64');

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const nativeFetch = globalThis.fetch;
let server: Server, scratch = '';
let requests: { path: string; method: string }[] = [];
let drafts: GalleryDraft[] = [];
let fault: (url: string, init?: RequestInit) => Promise<Response | null> = async () => null;
before(async () => {
  scratch = await tempDir('publish');
  server = await startServer(['--mode', 'dev', '--results', path.join(scratch, 'results'), '--request-log', path.join(scratch, 'requests.jsonl')]);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? new URL(input, server.url).href : String(input);
    requests.push({ path: new URL(url).pathname, method: init?.method ?? 'GET' });
    if (new URL(url).pathname === '/api/gallery' && init?.method === 'POST' && typeof init.body === 'string') drafts.push(galleryDraftSchema.parse(JSON.parse(init.body)));
    return await fault(url, init) ?? nativeFetch(url, init);
  };
});
after(async () => { globalThis.fetch = nativeFetch; await server?.stop(); await rm(scratch, { recursive: true, force: true }); });
function value<T>(result: client.GalleryResult<T>): T { assert.ok(result.ok, result.ok ? '' : result.error.message); return result.value; }
async function fixture(type = 'image/jpeg') {
  requests = []; drafts = []; fault = async () => null;
  const products = createProducts(), base = minimalDocument(), rich = fiveClusterDocument();
  const source = new File([jpeg], 'source.jpg', { type }), sourceId = await productAsset(jpeg);
  const size = { width: 2, height: 2 };
  // Nonzero offsets expose accidental copies of the whole backing buffer.
  const mask = new Uint8Array([99, 255, 0, 255, 0, 88]).subarray(1, 5);
  const depth = new Float32Array([99, .1, .3, .7, .9, 88]).subarray(1, 5);
  const plate = new Uint8Array([99, 8, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 88]).subarray(1, 13);
  const [maskId, depthId, plateId] = await Promise.all([productAsset(mask), productAsset(depth), productAsset(plate)]);
  products.putMask(maskId, { format: 'u8', size, data: mask });
  products.putMask(assetId(900), { format: 'u8', size, data: new Uint8Array(4) });
  products.putDepth(depthId, { format: 'f32', size, data: depth });
  products.putPlate(plateId, { size, data: plate });
  const objects = rich.objects.map((object) => ({ ...object, produced: { ...object.produced,
    mask: { asset: maskId, format: 'u8', size }, bounds: { x: 0, y: 0, ...size } } }));
  const document = currentDocumentSchema.parse({ ...base, objects,
    frame: { ...base.frame, source: { asset: sourceId, mediaType: type, byteLength: source.size }, original: { name: source.name, mediaType: type, size: { width: 2, height: 1 } } },
    analysis: { ...base.analysis, autoSubject: 'done', depth: { model: DEPTH_MODEL, map: { asset: depthId, format: 'f32', size }, stats: { p10: .1, median: .5, p90: .9 } },
      plate: { model: INPAINT_MODEL, image: { asset: plateId, size }, forMasks: [maskId, maskId] } } });
  const store = new MemoryStorage();
  let input: PublishInput = { document, source, products, gesture: false, exporting: false };
  const captures: typeof document[] = [];
  const tokens = createGalleryTokenStore(() => store);
  const host = { read: () => input, tokens,
    renderStill(doc: typeof document) { captures.push(doc); return Promise.resolve(new Blob([jpeg], { type: 'image/jpeg' })); },
    async encodePoster(still: Promise<Blob>) { return { blob: await still, size: { width: 2, height: 1 } }; } };
  return { host, session: createPublishSession(host), store, tokens, document, products, source, captures, mask, depth, plate,
    set(patch: Partial<PublishInput>) { input = { ...input, ...patch }; } };
}
async function assertGone(id: Parameters<typeof client.manifest>[0]['id']) {
  const missing = await client.manifest({ id }); assert.ok(!missing.ok); assert.equal(missing.error.status, 404);
  assert.ok(!value(await client.list()).some((piece) => piece.id === id));
}

test('readiness distinguishes no photo, gesture, export, missing depth/masks and missing or stale plate even with Motion off', async () => {
  const f = await fixture();
  assert.deepEqual(f.session.canPublish(), { kind: 'ready' });
  const reason = (expected: string) => { const state = f.session.canPublish(); assert.equal(state.kind, 'unavailable'); if (state.kind === 'unavailable') { assert.equal(state.reason, expected); assert.ok(state.sentence.length > 15); } };
  f.set({ document: null }); reason('no-photo'); f.set({ document: f.document, source: null }); reason('no-photo');
  f.set({ source: f.source, gesture: true }); reason('gesture');
  f.set({ gesture: false, exporting: true }); reason('export'); f.set({ exporting: false });
  f.set({ document: { ...f.document, analysis: { ...f.document.analysis, depth: null } } }); reason('depth');
  f.set({ document: { ...f.document, analysis: { ...f.document.analysis, plate: null } } }); reason('plate');
  const plate = f.document.analysis.plate; assert.ok(plate);
  f.set({ document: { ...f.document, analysis: { ...f.document.analysis, plate: { ...plate, forMasks: [assetId(4)] } } } }); reason('plate');
  f.set({ document: f.document });
  const mask = f.document.objects[0]?.produced.mask.asset; assert.ok(mask); f.products.dropMask(mask); reason('masks');
  const refused = await f.session.publish(); assert.equal(refused.kind, 'failed'); assert.equal(requests.length, 0);
});

test('zero-object readiness requires depth but no plate; objects still require a resident, matching plate', async () => {
  const f = await fixture();
  const empty = { ...f.document, objects: [], analysis: { ...f.document.analysis, plate: null } };
  f.set({ document: empty }); assert.deepEqual(f.session.canPublish(), { kind: 'ready' });
  f.set({ document: { ...empty, motion: { ...empty.motion, enabled: true } } });
  assert.deepEqual(f.session.canPublish(), { kind: 'ready' });
  f.set({ document: { ...empty, analysis: { ...empty.analysis, depth: null } } });
  assert.equal(f.session.canPublish().kind, 'unavailable');
  f.set({ document: empty });
  const depth = empty.analysis.depth; assert.ok(depth);
  f.set({ products: { ...f.products, depths: new Map() } });
  const unavailable = f.session.canPublish(); assert.ok(unavailable.kind === 'unavailable'); assert.equal(unavailable.reason, 'depth');
  f.set({ document: f.document, products: { ...f.products, plates: new Map() } });
  const plate = f.document.analysis.plate; assert.ok(plate);
  const missing = f.session.canPublish(); assert.ok(missing.kind === 'unavailable'); assert.equal(missing.reason, 'plate');
  assert.equal((await f.session.publish()).kind, 'failed'); assert.deepEqual(requests, []);
});

test('zero-object snapshot keeps its null plate and uploads only source, depth and poster', async () => {
  const f = await fixture(), progress: PublishProgress[] = [];
  const empty = { ...f.document, objects: [], motion: { ...f.document.motion, enabled: true }, analysis: { ...f.document.analysis, plate: null } };
  f.set({ document: empty });
  const result = await f.session.publish({ onProgress: (p) => progress.push(p) }); assert.ok(result.kind === 'published');
  try {
    const manifest = value(await client.manifest({ id: result.id }));
    assert.deepEqual(manifest.document, empty); assert.equal(manifest.document.analysis.plate, null);
    assert.deepEqual(manifest.assets.map((asset) => asset.kind), ['source', 'depth']);
    assert.equal(requests.filter((r) => r.method === 'PUT').length, 3);
    assert.ok(!requests.some((r) => r.path.endsWith(f.document.analysis.plate?.image.asset ?? 'invalid')));
    assert.deepEqual(progress.map((p) => p.phase), ['snapshot', 'creating', 'uploading', 'uploading', 'uploading', 'publishing', 'published']);
    assert.ok(progress.every((p) => p.total === 3)); assert.deepEqual(f.captures, [empty]);
    const content = await loadGallery(result.url, new AbortController().signal); assert.ok(content);
    const piece = await content.loadPiece(new AbortController().signal);
    assert.equal(piece.planes.size, 1); assert.deepEqual(piece.document, empty);
  } finally { await f.session.unpublish(result.id); }
});

test('zero-object documents retaining a plate are refused without normalizing the committed document', async () => {
  const f = await fixture(), empty = { ...f.document, objects: [] };
  f.set({ document: empty });
  const state = f.session.canPublish(); assert.ok(state.kind === 'unavailable');
  assert.equal(state.reason, 'plate'); assert.match(state.sentence, /retains a background plate/);
  assert.equal((await f.session.publish()).kind, 'failed'); assert.deepEqual(requests, []); assert.deepEqual(f.captures, []);
  assert.equal(empty.analysis.plate, f.document.analysis.plate);
});

test('publish freezes committed document, original File and exact referenced bytes before callbacks; progress is ordered and tokens survive a new session', async () => {
  const f = await fixture(), progress: PublishProgress[] = [];
  const expectedMask = f.mask.slice(), expectedDepth = new Uint8Array(f.depth.buffer, f.depth.byteOffset, f.depth.byteLength).slice(), expectedPlate = f.plate.slice();
  const result = await f.session.publish({ onProgress(update) {
    progress.push(update);
    if (update.phase === 'snapshot') {
      assert.equal(f.session.canPublish().kind, 'unavailable');
      f.mask.fill(1); f.depth.fill(0); f.plate.fill(2);
      f.set({ document: { ...f.document, title: 'Edited after publish', style: { ...f.document.style, fry: .9 } }, source: new File(['next'], 'next.jpg') });
    }
  } });
  assert.equal(result.kind, 'published'); assert.ok(result.kind === 'published');
  try {
    assert.equal(result.device, 'persistent'); assert.equal(result.url, `/gallery/${result.id}`);
    assert.deepEqual(progress.map((p) => p.phase), ['snapshot', 'creating', 'uploading', 'uploading', 'uploading', 'uploading', 'uploading', 'publishing', 'published']);
    assert.deepEqual(progress.filter((p) => p.phase === 'uploading').map((p) => p.completed), [1, 2, 3, 4, 5]);
    assert.ok(progress.every((p) => p.total === 5));
    assert.deepEqual(f.captures, [f.document]); assert.notEqual(f.captures[0], f.document);
    const manifest = value(await client.manifest({ id: result.id }));
    assert.deepEqual(manifest.document, f.document); assert.deepEqual(manifest.assets.map((a) => a.kind), ['source', 'mask', 'depth', 'plate']);
    assert.deepEqual(manifest.document.analysis.plate?.forMasks, sortedMasks(f.document));
    const bytes = new Map([['source', jpeg], ['mask', expectedMask], ['depth', expectedDepth], ['plate', expectedPlate]]);
    for (const asset of manifest.assets) { const expected = bytes.get(asset.kind); assert.ok(expected); assert.deepEqual(new Uint8Array(await (await fetch(value(client.assetUrl({ id: result.id, asset: asset.id })))).arrayBuffer()), new Uint8Array(expected)); }
    assert.deepEqual(new Uint8Array(await (await fetch(`/api/gallery/${result.id}/poster`)).arrayBuffer()), new Uint8Array(jpeg));
    const reloaded = createPublishSession({ ...f.host, tokens: createGalleryTokenStore(() => f.store) });
    assert.deepEqual(reloaded.publishedHere(), [result.id]);
    assert.equal(f.store.length, 1); assert.equal(f.store.key(0), `noisy.gallery.token.${result.id}`);
    assert.deepEqual(await reloaded.unpublish(result.id), { kind: 'unpublished', id: result.id });
    assert.deepEqual(reloaded.publishedHere(), []); assert.equal(f.store.length, 0); await assertGone(result.id);
  } finally { await f.session.unpublish(result.id); }
});

test('empty source MIME is normalized consistently without changing original bytes', async () => {
  const f = await fixture(''), result = await f.session.publish(); assert.ok(result.kind === 'published');
  try {
    const manifest = value(await client.manifest({ id: result.id }));
    assert.equal(manifest.document.frame.source?.mediaType, 'application/octet-stream');
    assert.equal(manifest.assets.find((a) => a.kind === 'source')?.mediaType, 'application/octet-stream');
  } finally { await f.session.unpublish(result.id); }
});

test('open gesture is refused before capture or network; abort before start is side effect free', async () => {
  const f = await fixture(); f.set({ gesture: true }); assert.equal((await f.session.publish()).kind, 'failed');
  f.set({ gesture: false }); const controller = new AbortController(); controller.abort();
  assert.deepEqual(await f.session.publish({ signal: controller.signal }), { kind: 'failed', sentence: 'Publishing was cancelled.' });
  assert.deepEqual(f.captures, []); assert.deepEqual(requests, []);
});

test('abort while poster encoding is pending returns without creating a draft', async () => {
  const f = await fixture(), controller = new AbortController();
  const encoding = Promise.withResolvers<{ blob: Blob; size: { width: number; height: number } }>();
  const session = createPublishSession({ ...f.host, encodePoster: () => encoding.promise });
  const result = session.publish({ signal: controller.signal }); controller.abort();
  assert.deepEqual(await result, { kind: 'failed', sentence: 'Publishing was cancelled.' });
  assert.deepEqual(requests, []);
  encoding.reject(new Error('A late encoder failure is observed.'));
  assert.deepEqual(session.canPublish(), { kind: 'ready' });
});

for (const mode of ['abort', 'upload-failure', 'lost-publish-response'] as const) test(`${mode} cleans up its private or uncertain draft without leaving a published piece`, async () => {
  const f = await fixture(), controller = new AbortController();
  fault = async (url, init) => {
    if (mode === 'upload-failure' && init?.method === 'PUT') return new Response(JSON.stringify({ error: 'Upload refused.' }), { status: 502 });
    if (mode === 'lost-publish-response' && url.endsWith('/publish')) { await nativeFetch(url, init); throw new Error('Lost response'); }
    return null;
  };
  const result = await f.session.publish({ signal: controller.signal, onProgress(p) { if (mode === 'abort' && p.phase === 'uploading') controller.abort(); } });
  assert.equal(result.kind, 'failed'); assert.ok(result.kind === 'failed');
  if (mode === 'abort') assert.match(result.sentence, /cancelled/);
  const deletion = requests.find((r) => r.method === 'DELETE'); assert.ok(deletion);
  const id = galleryIdSchema.parse(deletion.path.split('/').at(-1));
  await assertGone(id); assert.deepEqual(f.session.publishedHere(), []); assert.equal(f.store.length, 0);
  if (mode !== 'lost-publish-response') assert.ok(!requests.some((r) => r.path.endsWith('/publish')));
});

test('failed cleanup reports uncertainty, retains authority and permits retry', async () => {
  const f = await fixture();
  fault = async (_url, init) => init?.method === 'PUT' || init?.method === 'DELETE' ? new Response('{"error":"Store unavailable."}', { status: 502 }) : null;
  const result = await f.session.publish(); assert.ok(result.kind === 'failed'); assert.match(result.sentence, /Cleanup could not be confirmed/);
  const [id] = f.session.publishedHere(); assert.ok(id);
  fault = async () => null;
  assert.equal((await f.session.unpublish(id)).kind, 'unpublished'); await assertGone(id);
});

test('blocked localStorage publishes with an explicit warning and gallery-side in-memory unpublish', async () => {
  const f = await fixture(), tokens = createGalleryTokenStore(() => { throw new Error('Storage denied'); });
  const session = createPublishSession({ ...f.host, tokens }), gallery = createGalleryDevice(tokens);
  const result = await session.publish({ onProgress() { throw new Error('UI observer failed'); } }); assert.ok(result.kind === 'published');
  assert.equal(result.device, 'session'); assert.match(result.sentence, /cannot unpublish.*after leaving/);
  assert.deepEqual(session.publishedHere(), [result.id]); assert.deepEqual(gallery.publishedHere(), [result.id]);
  assert.deepEqual(await gallery.unpublish(result.id), { kind: 'unpublished' }); assert.deepEqual(session.publishedHere(), []); await assertGone(result.id);
});

test('every storage method may throw; malformed/unrelated keys are ignored; no-token unpublish makes no request', async () => {
  const f = await fixture();
  f.store.setItem('unrelated', 'not a token'); f.store.setItem(`noisy.gallery.token.${uuid(17)}`, 'malformed');
  assert.deepEqual(f.session.publishedHere(), []);
  assert.equal((await f.session.unpublish(uuid(17))).kind, 'failed'); assert.equal((await f.session.unpublish('bad')).kind, 'failed'); assert.deepEqual(requests, []);
  const result = await f.session.publish(); assert.ok(result.kind === 'published');
  f.store.getItem = () => { throw new Error('get blocked'); }; f.store.key = () => { throw new Error('key blocked'); }; f.store.removeItem = () => { throw new Error('remove blocked'); };
  assert.deepEqual(f.session.publishedHere(), [result.id]); assert.equal((await f.session.unpublish(result.id)).kind, 'unpublished');
  assert.deepEqual(f.session.publishedHere(), []); await assertGone(result.id);
  const blocked = new MemoryStorage(); blocked.setItem = () => { throw new Error('quota'); };
  const other = createPublishSession({ ...f.host, tokens: createGalleryTokenStore(() => blocked) }), published = await other.publish(); assert.ok(published.kind === 'published');
  assert.equal(published.device, 'session'); await other.unpublish(published.id);
});

test('gallery-side API lists the exact UI shape, reloads tokens, retains them on failed deletion and returns typed failures', async () => {
  const f = await fixture(), gallery = createGalleryDevice(f.tokens);
  assert.deepEqual(gallery.publishedHere(), []);
  assert.deepEqual(await gallery.unpublish('bad'), { kind: 'failed', sentence: 'This gallery link is invalid.' });
  assert.deepEqual(await gallery.unpublish(uuid(17)), { kind: 'failed', sentence: 'This device does not have the key to unpublish this piece.' });
  assert.deepEqual(requests, []);
  const published = await f.session.publish(); assert.ok(published.kind === 'published');
  try {
    assert.deepEqual(gallery.publishedHere(), [published.id]);
    assert.deepEqual(createGalleryDevice(createGalleryTokenStore(() => f.store)).publishedHere(), [published.id]);
    const result = await gallery.list(new AbortController().signal); assert.ok(result.kind === 'listed');
    const manifest = value(await client.manifest({ id: published.id }));
    assert.deepEqual(result.pieces.find((piece) => piece.id === published.id), { id: published.id, publishedAt: manifest.publishedAt,
      posterUrl: `/api/gallery/${published.id}/poster`, width: 2, height: 1 });
    fault = async (_url, init) => init?.method === 'DELETE' ? new Response('{"error":"Store unavailable."}', { status: 503 }) : null;
    assert.deepEqual(await gallery.unpublish(published.id), { kind: 'failed', sentence: 'Store unavailable.' });
    assert.deepEqual(gallery.publishedHere(), [published.id]);
    fault = async () => null;
    assert.deepEqual(await gallery.unpublish(published.id), { kind: 'unpublished' });
    assert.deepEqual(gallery.publishedHere(), []); assert.deepEqual(f.session.publishedHere(), []); await assertGone(published.id);
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await gallery.list(controller.signal), { kind: 'failed', sentence: 'The gallery request was cancelled.' });
    fault = async () => new Response('{"error":"List unavailable."}', { status: 503 });
    assert.deepEqual(await gallery.list(new AbortController().signal), { kind: 'failed', sentence: 'List unavailable.' });
  } finally { fault = async () => null; await f.session.unpublish(published.id); }
});

test('blocked storage length and stale entries after blocked removal cannot expose forgotten authority', async () => {
  const f = await fixture(), published = await f.session.publish(); assert.ok(published.kind === 'published');
  Object.defineProperty(f.store, 'length', { get() { throw new Error('length blocked'); } });
  assert.deepEqual(f.tokens.publishedHere(), [published.id]);
  f.store.removeItem = () => { throw new Error('remove blocked'); };
  assert.deepEqual(await createGalleryDevice(f.tokens).unpublish(published.id), { kind: 'unpublished' });
  assert.equal(f.tokens.tokenFor(published.id), null); assert.deepEqual(f.tokens.publishedHere(), []); await assertGone(published.id);
});

test('manifest loader returns exact source and little-endian planes; list and missing/corrupt asset failures retain poster metadata', async () => {
  const f = await fixture(), result = await f.session.publish(); assert.ok(result.kind === 'published');
  const signal = new AbortController().signal;
  try {
    const content = await loadGallery(result.url, signal); assert.ok(content);
    assert.equal(content.posterUrl, `/api/gallery/${result.id}/poster`);
    const piece = await content.loadPiece(signal); assert.deepEqual(piece.document, f.document);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(content.loadPiece(cancelled.signal), (e: unknown) => e instanceof GalleryLoadError && e.failure.kind === 'aborted');
    assert.deepEqual(new Uint8Array(await piece.source.arrayBuffer()), new Uint8Array(jpeg));
    const depth = f.document.analysis.depth; assert.ok(depth);
    assert.deepEqual(piece.planes.get(depth.map.asset)?.data, f.depth);
    assert.ok(value(await listGallery()).some((p) => p.id === result.id));
    fault = async (url) => url.includes('/assets/') ? new Response('missing', { status: 404 }) : null;
    await assert.rejects(content.loadPiece(signal), (e: unknown) => e instanceof GalleryLoadError && e.failure.kind === 'missing-asset');
    fault = async (url) => url.includes('/assets/') ? new Response(new Uint8Array(jpeg.length)) : null;
    await assert.rejects(content.loadPiece(signal), (e: unknown) => e instanceof GalleryLoadError && e.failure.kind === 'invalid-asset');
    fault = async () => null;
  } finally { fault = async () => null; await f.session.unpublish(result.id); }
  assert.equal(await loadGallery(result.url, signal), null);
});
