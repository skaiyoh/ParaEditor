import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { GALLERY_LIMITS, galleryDraftSchema, galleryLegacyDraftSchema, galleryCompositionDraftSchema, galleryIdSchema, galleryManifestSchema, type GalleryLegacyDraft } from '../src/core/gallery.ts';
import { isAssetId, type AssetId } from '../src/core/ids.ts';
import { encodeRaster } from '../src/core/asset-codec.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { migrateV4ToV5 } from '../src/core/composition.ts';
import { z } from '../src/core/zod.ts';
import * as gallery from '../src/projects/gallery.ts';
import { assetId, legacyFiveClusterDocument as fiveClusterDocument, legacyMinimalDocument as minimalDocument, uuid } from './fixtures/documents.ts';
import { localEffect, newComposition } from './fixtures/composition.ts';
import { startServer, tempDir, type Server } from './support/cli.ts';

// JavaScript verifier exports cross into this test through a checked boundary.
const verifierModule: unknown = await import(new URL('../tools/cloudflare/verify.mjs', import.meta.url).href);
const { withGalleryDraft } = z.object({
  withGalleryDraft: z.function({ input: [z.unknown()], output: z.promise(z.void()) }),
}).parse(verifierModule);

// A genuine 2 x 1 JPEG reduced from the repository's sample photo.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD109TSUp6mkr1D48//2Q==', 'base64');
function hash(bytes: Uint8Array): AssetId {
  const id = createHash('sha256').update(bytes).digest('hex');
  assert.ok(isAssetId(id));
  return id;
}
function fixture(): GalleryLegacyDraft {
  const original = minimalDocument(), id = hash(jpeg), size = { width: 2, height: 1 };
  return galleryLegacyDraftSchema.parse({
    document: { ...original, frame: { ...original.frame,
      source: { asset: id, mediaType: 'image/jpeg', byteLength: jpeg.length },
      original: { name: 'tiny.jpg', mediaType: 'image/jpeg', size },
    } },
    assets: [{ id, kind: 'source', mediaType: 'image/jpeg', size, byteLength: jpeg.length }],
    poster: { id, kind: 'poster', mediaType: 'image/jpeg', size, byteLength: jpeg.length },
  });
}
let scratch = '';
let server: Server;
const nativeFetch = globalThis.fetch;
before(async () => {
  scratch = await tempDir('gallery-client');
  server = await startServer(['--mode', 'dev', '--results', path.join(scratch, 'results'), '--request-log', path.join(scratch, 'requests.jsonl')]);
  globalThis.fetch = (input, init) => nativeFetch(typeof input === 'string' && input.startsWith('/') ? new URL(input, server.url) : input, init);
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await server?.stop();
  await rm(scratch, { recursive: true, force: true });
});
function value<T>(result: gallery.GalleryResult<T>): T { assert.ok(result.ok, result.ok ? '' : result.error.message); return result.value; }
function failure(result: gallery.GalleryResult<unknown>, kind: gallery.GalleryError['kind']): gallery.GalleryError {
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error.kind, kind);
  assert.match(result.error.message, /^[^\n]+\.$/);
  return result.error;
}

test('all gallery client functions complete a real HTTP publish, read and unpublish round trip', async () => {
  const draft = fixture(), asset = draft.assets[0]; assert.ok(asset);
  const created = value(await gallery.createDraft({ draft }));
  try {
    assert.equal(failure(await gallery.manifest({ id: created.id }), 'http').status, 404);
    assert.ok(!value(await gallery.list()).some((piece) => piece.id === created.id));
    value(await gallery.uploadAsset({ ...created, asset, bytes: jpeg }));
    value(await gallery.uploadPoster({ ...created, poster: draft.poster, bytes: new Blob([jpeg]) }));
    const published = value(await gallery.publishDraft(created));
    assert.deepEqual(published.document, draft.document);
    assert.equal(published.version, 1);
    assert.deepEqual(value(await gallery.manifest({ id: created.id })), published);
    const item = value(await gallery.list()).find((piece) => piece.id === created.id);
    assert.ok(item);
    assert.deepEqual(item.size, draft.poster.size);
    const url = value(gallery.assetUrl({ id: created.id, asset: asset.id }));
    assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), jpeg);
    assert.deepEqual(Buffer.from(await (await fetch(item.poster)).arrayBuffer()), jpeg);
    assert.equal(failure(await gallery.unpublish({ id: created.id, token: 'wrong-token' }), 'http').status, 403);
    value(await gallery.unpublish(created));
    assert.equal(failure(await gallery.manifest({ id: created.id }), 'http').status, 404);
    assert.ok(!value(await gallery.list()).some((piece) => piece.id === created.id));
  } finally { await gallery.unpublish(created); }
});

test('v2 client publishes a zero-object manual Recolor with encoded PNG and NSRA assets, then reads it unchanged', async () => {
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4zwAE/xnqQeR/bh7e/wAuSQWfwB0i9wAAAABJRU5ErkJggg==', 'base64'));
  const size = { width: 2, height: 2 }, coverage = encodeRaster({ format: 'u8', size, data: new Uint8Array([0, 127, 128, 255]) });
  const original = newComposition(), effect = localEffect(), sourceId = hash(jpeg), masterId = hash(png), maskId = hash(coverage);
  const document = compositionDocumentSchema.parse({ ...original, compositing: 'legacy-order', frame: { ...original.frame,
    source: { asset: sourceId, mediaType: 'image/jpeg', byteLength: jpeg.length }, master: { asset: masterId, size },
    original: { name: 'tiny.jpg', mediaType: 'image/jpeg', size: { width: 2, height: 1 } } }, localEffects: [{ ...effect,
      scope: { kind: 'mask', mask: { plane: { asset: maskId, format: 'u8', size }, provenance: { kind: 'manual', operation: 'rectangle' } } },
      operation: { kind: 'recolor', color: { l: .63, c: .18, h: 241 } } }] });
  const draft = galleryCompositionDraftSchema.parse({ version: 2, document, assets: [
    { kind: 'source', id: sourceId, mediaType: 'image/jpeg', size: document.frame.original.size, byteLength: jpeg.length },
    { kind: 'png', id: masterId, mediaType: 'image/png', size, byteLength: png.length },
    { kind: 'raster', id: maskId, format: 'u8', size, byteLength: coverage.length },
  ], poster: fixture().poster });
  const bytes = new Map([[sourceId, jpeg], [masterId, png], [maskId, coverage]]);
  assert.equal(document.objects.length, 0);
  assert.equal(document.analysis.plate, null);
  const created = value(await gallery.createDraft({ draft }));
  try {
    for (const asset of draft.assets) {
      const encoded = bytes.get(asset.id); assert.ok(encoded);
      value(await gallery.uploadAsset({ ...created, asset, bytes: encoded }));
    }
    value(await gallery.uploadPoster({ ...created, poster: draft.poster, bytes: jpeg }));
    const published = value(await gallery.publishDraft(created));
    assert.equal(published.version, 2);
    assert.deepEqual(published.document, document);
    assert.deepEqual(value(await gallery.manifest(created)), published);
    for (const asset of draft.assets) {
      const response = await fetch(value(gallery.assetUrl({ id: created.id, asset: asset.id })));
      assert.equal(response.headers.get('Content-Type'), 'mediaType' in asset ? asset.mediaType : 'application/octet-stream');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bytes.get(asset.id) ?? []));
    }
    value(await gallery.unpublish(created));
    failure(await gallery.manifest(created), 'http');
  } finally { await gallery.unpublish(created); }
});

test('v2 schema admits shared original/master PNG once and rejects wrong, absent and extra composition descriptors', () => {
  const original = newComposition(), effect = localEffect(), master = assetId(90), mask = assetId(91), size = { width: 2, height: 2 };
  const document = compositionDocumentSchema.parse({ ...original, compositing: 'legacy-order', frame: { ...original.frame,
    source: { asset: master, mediaType: 'image/png', byteLength: 79 }, master: { asset: master, size } }, localEffects: [{ ...effect,
      scope: { kind: 'mask', mask: { plane: { asset: mask, format: 'u8', size }, provenance: { kind: 'manual', operation: 'rectangle' } } } }] });
  const draft = galleryCompositionDraftSchema.parse({ version: 2, document, assets: [
    { kind: 'source', id: master, mediaType: 'image/png', size, byteLength: 79 },
    { kind: 'raster', id: mask, format: 'u8', size, byteLength: 20 },
  ], poster: fixture().poster });
  assert.equal(draft.assets.length, 2, 'one immutable descriptor satisfies original and master references');
  assert.deepEqual(galleryDraftSchema.parse(draft), draft);
  for (const invalid of [
    { ...draft, version: 1 },
    { ...draft, document: { ...document, version: 4 } },
    { ...draft, assets: draft.assets.slice(0, 1) },
    { ...draft, assets: [...draft.assets, draft.assets[0]] },
    { ...draft, assets: [...draft.assets, { kind: 'png', id: assetId(92), size, byteLength: 79, mediaType: 'image/png' }] },
    { ...draft, assets: draft.assets.map((asset) => asset.kind === 'raster' ? { ...asset, byteLength: 4 } : asset) },
    { ...draft, assets: draft.assets.map((asset) => asset.kind === 'raster' ? { ...asset, format: 'f32' } : asset) },
    { ...draft, assets: draft.assets.map((asset) => asset.kind === 'raster' ? { ...asset, kind: 'mask', byteLength: 4 } : asset) },
    { ...draft, assets: draft.assets.map((asset) => asset.kind === 'source' ? { ...asset, mediaType: 'image/jpeg' } : asset) },
  ]) assert.equal(galleryDraftSchema.safeParse(invalid).success, false);
  const manifest = { ...draft, id: galleryIdSchema.parse(uuid(451)), publishedAt: new Date().toISOString() };
  assert.ok(galleryManifestSchema.safeParse(manifest).success);
  assert.equal(galleryManifestSchema.safeParse({ ...manifest, version: 1 }).success, false);
});

test('every HTTP client function returns typed HTTP failure with the server sentence', async () => {
  const draft = fixture(), asset = draft.assets[0]; assert.ok(asset);
  const created = value(await gallery.createDraft({ draft }));
  const clientFetch = globalThis.fetch;
  // Node has no origin; route these real requests to a malformed gallery route.
  globalThis.fetch = (_input, init) => nativeFetch(new URL('/api/gallery/not-an-id', server.url), init);
  try {
    const operations = [
      () => gallery.createDraft({ draft }),
      () => gallery.uploadAsset({ ...created, asset, bytes: jpeg }),
      () => gallery.uploadPoster({ ...created, poster: draft.poster, bytes: jpeg }),
      () => gallery.publishDraft(created), () => gallery.list(),
      () => gallery.manifest(created), () => gallery.unpublish(created),
    ];
    for (const operation of operations) assert.equal(failure(await operation(), 'http').status, 400);
    // @ts-expect-error The public boundary also refuses untyped callers' malformed ids.
    failure(gallery.assetUrl({ id: 'not-an-id', asset: asset.id }), 'invalid');
  } finally { globalThis.fetch = clientFetch; await gallery.unpublish(created); }
});

test('client validates draft and upload boundaries without throwing or writing', async () => {
  const draft = fixture(), asset = draft.assets[0]; assert.ok(asset);
  const absent = { id: galleryIdSchema.parse(uuid(400)), token: 'valid-token' };
  failure(await gallery.createDraft({ draft: { ...draft, assets: [] } }), 'invalid');
  failure(await gallery.uploadAsset({ ...absent, asset, bytes: new Uint8Array(0) }), 'invalid');
  failure(await gallery.uploadPoster({ ...absent, poster: draft.poster, bytes: new ArrayBuffer(0) }), 'invalid');
  failure(await gallery.publishDraft({ ...absent, token: 'bad\ntoken' }), 'invalid');
  failure(await gallery.unpublish({ ...absent, token: '' }), 'invalid');
});

test('aborted requests and unreachable servers return typed failures', async () => {
  const controller = new AbortController(); controller.abort();
  const error = failure(await gallery.list({ signal: controller.signal }), 'aborted');
  assert.equal(error.status, null);
  const clientFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => nativeFetch('http://127.0.0.1:1/api/gallery', init);
  try { assert.equal(failure(await gallery.list(), 'network').status, null); }
  finally { globalThis.fetch = clientFetch; }
});

test('a successful HTTP response with another endpoint shape is a typed invalid response', async () => {
  const clientFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => nativeFetch(new URL('/api/projects', server.url), init);
  try { assert.equal(failure(await gallery.list(), 'invalid').status, 200); }
  finally { globalThis.fetch = clientFetch; }
});

const verificationCredentials = { id: 'd85237b1-9dce-4a8a-9938-d8b676f768d1', token: 'x'.repeat(43) };
const verificationHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' };
function checkVerificationHeaders(route: string, response: Response): void {
  assert.equal(response.headers.get('Cache-Control'), 'no-cache', `${route}: Cache-Control`);
}

for (const creation of [
  { name: 'cache header', credentials: verificationCredentials, status: 201, cache: 'public, max-age=60', expected: /Cache-Control/ },
  { name: 'status', credentials: verificationCredentials, status: 200, cache: 'no-cache', expected: /\/api\/gallery/ },
  { name: 'id', credentials: { ...verificationCredentials, id: verificationCredentials.id.toUpperCase() }, status: 201, cache: 'no-cache', expected: /regular expression/ },
  { name: 'token', credentials: { ...verificationCredentials, token: 'x'.repeat(42) }, status: 201, cache: 'no-cache', expected: /regular expression/ },
]) {
  test(`gallery verifier cleans up after creation ${creation.name} validation fails`, async () => {
    const calls: { route: string; init: RequestInit }[] = [];
    await assert.rejects(withGalleryDraft({
      draft: fixture(),
      transport: async (route: string, init: RequestInit) => {
        calls.push({ route, init });
        return init.method === 'POST'
          ? new Response(JSON.stringify(creation.credentials), { status: creation.status,
            headers: { ...verificationHeaders, 'Cache-Control': creation.cache } })
          : new Response(JSON.stringify({ ok: true }), { headers: verificationHeaders });
      },
      checkHeaders: checkVerificationHeaders,
      run: () => assert.fail('Creation validation must stop the publication.'),
    }), creation.expected);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.route, '/api/gallery');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[1]?.route, `/api/gallery/${encodeURIComponent(creation.credentials.id)}`);
    assert.equal(calls[1]?.init.method, 'DELETE');
    assert.equal(new Headers(calls[1]?.init.headers).get('Authorization'), `Bearer ${creation.credentials.token}`);
  });
}

test('gallery verifier preserves the original creation failure when cleanup also fails', async () => {
  const original = new Error('Creation headers were incorrect.'), cleanup = new Error('Cleanup connection failed.');
  let removed = false;
  await assert.rejects(withGalleryDraft({
    draft: fixture(),
    transport: async (_route: string, init: RequestInit) => {
      if (init.method === 'DELETE') { removed = true; throw cleanup; }
      return new Response(JSON.stringify(verificationCredentials), { status: 201, headers: verificationHeaders });
    },
    checkHeaders: () => { throw original; },
    run: () => assert.fail('Creation validation must stop the publication.'),
  }), (error: unknown) => { assert.equal(error, original); return true; });
  assert.ok(removed);
});

test('gallery verifier reports cleanup failure after an otherwise successful round trip', async () => {
  const cleanup = new Error('Cleanup connection failed.');
  let ran = false;
  await assert.rejects(withGalleryDraft({
    draft: fixture(),
    transport: async (_route: string, init: RequestInit) => {
      if (init.method === 'DELETE') throw cleanup;
      return new Response(JSON.stringify(verificationCredentials), { status: 201, headers: verificationHeaders });
    },
    checkHeaders: checkVerificationHeaders,
    run: async () => { ran = true; },
  }), (error: unknown) => { assert.equal(error, cleanup); return true; });
  assert.ok(ran);
});

test('gallery verifier deletes its real local draft after a creation header failure', async () => {
  const original = new Error('Creation header validation failed.');
  let deletedRoute = '';
  let deletedHeaders: HeadersInit = {};
  await assert.rejects(withGalleryDraft({
    draft: fixture(),
    transport: async (route: string, init: RequestInit) => {
      if (init.method === 'DELETE') { deletedRoute = route; deletedHeaders = init.headers ?? {}; }
      return await nativeFetch(new URL(route, server.url), init);
    },
    checkHeaders: (route: string, response: Response) => {
      if (route === '/api/gallery') throw original;
      checkVerificationHeaders(route, response);
    },
    run: () => assert.fail('Creation validation must stop the publication.'),
  }), (error: unknown) => { assert.equal(error, original); return true; });
  assert.match(deletedRoute, /^\/api\/gallery\/[0-9a-f-]{36}$/);
  const deleted = await nativeFetch(new URL(`${deletedRoute}/publish`, server.url), { method: 'POST', headers: deletedHeaders });
  assert.equal(deleted.status, 410);
  assert.deepEqual(await deleted.json(), { error: 'The gallery piece was unpublished.' });
});

test('gallery schema enforces complete immutable asset graphs and resource limits', () => {
  const document = fiveClusterDocument(), source = document.frame.source, depth = document.analysis.depth, plate = document.analysis.plate;
  assert.ok(source && depth && plate);
  const draft = galleryDraftSchema.parse({
    document,
    assets: [
      { id: source.asset, kind: 'source', mediaType: source.mediaType, size: document.frame.original.size, byteLength: source.byteLength },
      ...document.objects.map(({ produced: { mask } }) => ({ id: mask.asset, kind: 'mask', format: 'u8', size: mask.size, byteLength: mask.size.width * mask.size.height })),
      { id: depth.map.asset, kind: 'depth', format: 'f32', size: depth.map.size, byteLength: depth.map.size.width * depth.map.size.height * 4 },
      { id: plate.image.asset, kind: 'plate', format: 'rgb8', size: plate.image.size, byteLength: plate.image.size.width * plate.image.size.height * 3 },
    ],
    poster: fixture().poster,
  });
  assert.deepEqual(draft.document, document, 'v1 preserves the frozen document, including raw-asset plate metadata');
  const v5 = migrateV4ToV5(document); assert.ok(v5.ok);
  assert.equal(galleryDraftSchema.safeParse({ ...draft, document: v5.value }).success, false,
    'a valid composition needs a different gallery manifest and asset protocol');
  for (const version of [0, 1, 2, 3]) {
    const { drift: _drift, parallax, ...motion } = document.motion;
    const { surface, ...rest } = document;
    const objects = document.objects.map((object) => {
      const { hidden, ...other } = object;
      return version < 3 ? other : { ...other, hidden };
    });
    const old = { ...rest, version, objects, ...(version > 0 ? { surface } : {}),
      motion: { ...motion, orbit: .37, ...(version > 1 ? { parallax } : {}) } };
    const restored = galleryDraftSchema.parse({ ...draft, document: old });
    assert.equal(restored.document.version, 4);
    assert.deepEqual(restored.document.analysis.plate, document.analysis.plate);
    assert.deepEqual(restored.assets, draft.assets);
    assert.deepEqual(restored.document.motion.drift, { direction: 'circle', amount: .37 });
    assert.equal(galleryDraftSchema.safeParse({ ...draft, document: { ...old, motion: { ...old.motion, orbit: 'bad' } } }).success, false,
      'historical fields are validated before legacy migrations overwrite them');
  }
  const rejects = (value: unknown, message: RegExp): void => {
    const result = galleryDraftSchema.safeParse(value);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
  };
  rejects({ ...draft, assets: draft.assets.slice(1) }, /referenced asset/);
  rejects({ ...draft, assets: [...draft.assets, draft.assets[0]] }, /exactly once/);
  rejects({ ...draft, assets: [...draft.assets, { id: assetId(999), kind: 'mask', format: 'u8', size: { width: 1, height: 1 }, byteLength: 1 }] }, /unreferenced/);
  rejects({ ...draft, assets: Array.from({ length: 41 }, () => draft.assets[0]) }, /40/);
  rejects({ ...draft, document: { ...document, unexpected: true } }, /document is invalid/);
  rejects({ ...draft, document: { ...document, version: document.version + 1 } }, /document is invalid/);
  rejects({ ...draft, document: { ...document, provenance: { ...document.provenance, importedOn: 'x'.repeat(GALLERY_LIMITS.document) } } }, /exceeds 1 MiB/);
  rejects({ ...draft, document: { ...document, frame: { ...document.frame, source: null } } }, /original source photo/);
  for (const change of [{ byteLength: source.byteLength + 1 }, { mediaType: 'image/png' }, { size: { width: 1, height: 1 } }]) {
    rejects({ ...draft, assets: draft.assets.map((asset) => asset.kind === 'source' ? { ...asset, ...change } : asset) }, /match|referenced/);
  }
  rejects({ ...draft, assets: draft.assets.map((asset) => asset.kind === 'depth' ? { ...asset, byteLength: asset.byteLength - 1 } : asset) }, /plane length/);
  rejects({ ...draft, assets: draft.assets.map((asset) => asset.kind === 'source' ? { ...asset, mediaType: 'image/svg\+xml' } : asset) }, /Invalid option/);
  rejects({ ...draft, poster: { ...draft.poster, size: { width: 1281, height: 1 } } }, /1280/);
  rejects({ ...draft, poster: { ...draft.poster, byteLength: GALLERY_LIMITS.poster + 1 } }, /2097152/);
  for (const kind of ['source', 'mask', 'depth', 'plate']) {
    const limit = kind === 'source' ? GALLERY_LIMITS.source : kind === 'mask' ? GALLERY_LIMITS.mask : GALLERY_LIMITS.plane;
    rejects({ ...draft, assets: draft.assets.map((asset) => asset.kind === kind ? { ...asset, byteLength: limit + 1 } : asset) }, new RegExp(String(limit)));
  }
  // forMasks preserves comparison ids whose historical bytes may be gone.
  const first = document.objects[0], second = document.objects[1]; assert.ok(first && second);
  const withoutSecondMask = draft.assets.filter((asset) => asset.id !== second.produced.mask.asset);
  assert.ok(galleryDraftSchema.safeParse({ ...draft, assets: withoutSecondMask, document: { ...document, objects: [first] } }).success);
  assert.ok(galleryDraftSchema.safeParse({ ...draft, assets: withoutSecondMask, document: { ...document, objects: [first, { ...second, produced: first.produced }] } }).success);
  rejects({ ...draft, document: { ...document, objects: [first] } }, /unreferenced/);
  const masks = Array.from({ length: 6 }, (_, i) => ({ id: assetId(500 + i), kind: 'mask', format: 'u8', size: { width: 4096, height: 4096 }, byteLength: GALLERY_LIMITS.mask }));
  rejects({ ...draft, document: { ...document, objects: masks.map((mask, i) => ({ ...first, id: uuid(500 + i), produced: { ...first.produced, mask: { asset: mask.id, format: mask.format, size: mask.size } } })) },
    assets: [...draft.assets.filter((asset) => asset.kind !== 'mask'), ...masks] }, /exceeds 96 MiB/);
  const published = { ...draft, version: 1, id: galleryIdSchema.parse(uuid(450)), publishedAt: new Date().toISOString() };
  assert.ok(galleryManifestSchema.safeParse(published).success);
  assert.equal(galleryManifestSchema.safeParse({ ...published, version: 2 }).success, false);
});
