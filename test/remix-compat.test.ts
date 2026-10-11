import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { compositionDocumentSchema, compositionObjectIdSchema } from '../src/core/composition-schema.ts';
import { encodeRaster } from '../src/core/asset-codec.ts';
import { TEXTURE_BLOCK_SOURCE } from '../src/core/math-graph.ts';
import { galleryCompositionDraftSchema, galleryCompositionManifestSchema, galleryDraftSchema,
  galleryManifestSchema, galleryRemixDraftSchema, galleryRemixManifestSchema,
  GALLERY_VERSION, GALLERY_COMPOSITION_VERSION, GALLERY_LIMITS } from '../src/core/gallery.ts';
import { migrateV5ToV6, remixDocumentSchema, serializeRemixDocument, withDerivedGrainStyle } from '../src/core/remix-schema.ts';
import { z } from '../src/core/zod.ts';
import { hashAsset } from '../src/projects/assets.ts';
import { deserializeCompositionScene, deserializeDocument, deserializeLegacyDocument, deserializeProjectEnvelope,
  serializeCompositionScene, serializeDocument, PROJECTS_TRANSPORT_VERSION } from '../src/projects/serialize.ts';
import { loadCompositionProject, saveComposition } from '../src/projects/store.ts';
import { handleProjects, type ProjectsEnv } from '../tools/cloudflare/projects.ts';
import { handleGallery, type GalleryEnv } from '../tools/cloudflare/gallery.ts';
import { loadGallery } from '../src/app/gallery-bootstrap.ts';
import { newComposition } from './fixtures/composition.ts';
import { uuid } from './fixtures/documents.ts';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4zwAE/xnqQeR/bh7e/wAuSQWfwB0i9wAAAABJRU5ErkJggg==', 'base64'));
const jpeg = new Uint8Array([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
const size = { width: 2, height: 2 };

async function fixture() {
  const master = await hashAsset(png), source = await hashAsset(jpeg);
  const base = newComposition();
  const v5 = compositionDocumentSchema.parse({ ...base, compositing: 'legacy-order', frame: { ...base.frame,
    source: { asset: source, mediaType: 'image/jpeg', byteLength: jpeg.length },
    master: { asset: master, size }, original: { name: 'tiny.jpg', mediaType: 'image/jpeg', size: { width: 2, height: 1 } } } });
  const migrated = migrateV5ToV6(v5);
  assert.ok(migrated.ok, JSON.stringify(migrated));
  return { v5, document: migrated.value, assets: new Map([[master, png], [source, jpeg]]),
    descriptors: [
      { kind: 'source', id: source, mediaType: 'image/jpeg', size: v5.frame.original.size, byteLength: jpeg.length },
      { kind: 'png', id: master, mediaType: 'image/png', size, byteLength: png.length },
    ], poster: { kind: 'poster', id: source, mediaType: 'image/jpeg', size: { width: 2, height: 1 }, byteLength: jpeg.length } };
}

async function paintedFixture() {
  const base = await fixture(), owner = compositionObjectIdSchema.parse(uuid(901));
  const tile = encodeRaster({ format: 'rgba8-srgb-straight', size, data: new Uint8Array(16).fill(127) });
  const asset = await hashAsset(tile);
  const document = remixDocumentSchema.parse({ ...base.document, compositing: 'scene-depth',
    policyTransition: { from: 'legacy-order', to: 'scene-depth', checkpoint: 0 },
    paint: { ...base.document.paint, layers: [{ id: owner, name: 'Paint', hidden: false, opacity: 1, patches: [{
      id: 'stroke-one', owner, order: 1, disparity: .37, brush: { id: TEXTURE_BLOCK_SOURCE.id, revision: TEXTURE_BLOCK_SOURCE.revision },
      seed: 17, size, tiles: [{ x: 0, y: 0, rgba: { asset, encoding: 'rgba8-srgb-straight', size } }],
    }] }] } });
  return { ...base, document, assets: new Map([...base.assets, [asset, tile]]),
    descriptors: [...base.descriptors, { kind: 'raster', id: asset, format: 'rgba8-srgb-straight', size, byteLength: tile.length }] };
}

function bucket() {
  const objects = new Map<string, { readonly bytes: ArrayBuffer; readonly contentType: string }>();
  const storage: GalleryEnv['PROJECTS'] = {
    async head(key) { const entry = objects.get(key); return entry === undefined ? null : { size: entry.bytes.byteLength }; },
    async get(key) {
      const entry = objects.get(key);
      return entry === undefined ? null : { size: entry.bytes.byteLength,
        httpMetadata: { contentType: entry.contentType }, body: new Blob([entry.bytes]).stream() };
    },
    async put(key, value, options) {
      if (options.onlyIf !== undefined && objects.has(key)) return;
      objects.set(key, { bytes: value.slice(0), contentType: options.httpMetadata.contentType });
    },
    async list({ prefix }) { return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
    async delete(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  };
  return { storage, objects };
}

function projectServer(t: TestContext) {
  const { storage, objects } = bucket();
  const env: ProjectsEnv = { NEON_DATABASE_URL: 'postgresql://test:private@neon.example/test', PROJECTS: storage };
  const rows = new Map<string, { readonly scene: unknown; readonly masks: unknown; readonly revision: number }>();
  const querySchema = z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number()])) });
  const saved: string[] = [];
  function query(input: z.infer<typeof querySchema>) {
    const id = String(input.params[0]), row = rows.get(id);
    if (input.query.startsWith('SELECT pg_advisory_xact_lock') || input.query.startsWith('UPDATE projects')) return { rows: [{}] };
    if (input.query.startsWith('SELECT EXISTS')) return { rows: [{ deleted: false, masks: row?.masks ?? null, revision: row?.revision ?? null }] };
    if (input.query.startsWith('SELECT scene')) return { rows: row === undefined ? [] : [row] };
    assert.ok(input.query.startsWith('WITH saved'), input.query);
    const revision = Number(input.params[4]);
    if (row !== undefined && revision <= row.revision) return { rows: [{ status: 'conflict' }] };
    rows.set(id, { scene: JSON.parse(String(input.params[2])), masks: JSON.parse(String(input.params[3])), revision });
    saved.push(id);
    return { rows: [{ status: 'saved' }] };
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://neon.example/sql') {
      assert.ok(typeof init?.body === 'string');
      const raw: unknown = JSON.parse(init.body);
      const batch = z.object({ queries: z.array(querySchema) }).safeParse(raw);
      return Response.json(batch.success ? { results: batch.data.queries.map(query) } : query(querySchema.parse(raw)));
    }
    const request = new Request(new URL(url, 'https://noisy.example'), init);
    return handleProjects(request, new URL(request.url).pathname, env, {},
      (status, error) => Response.json({ error }, { status }));
  });
  return { rows, objects, saved };
}

test('v6 raw schema, derived reads and transport v2 share one serialized grain owner', async () => {
  const { document, v5 } = await fixture();
  const read = withDerivedGrainStyle(document);
  const raw = serializeRemixDocument(read);
  assert.equal(PROJECTS_TRANSPORT_VERSION, 2);
  assert.equal(raw.version, 6);
  for (const key of ['grain', 'colorNoise', 'grainSize', 'grainHold']) assert.equal(key in raw.style, false, key);
  assert.deepEqual(remixDocumentSchema.parse(raw), document);
  assert.deepEqual(deserializeDocument(serializeDocument(read)), read);
  assert.deepEqual(serializeCompositionScene(read, 12), { transportVersion: 2, document, revision: 12 });
  assert.deepEqual(deserializeCompositionScene(serializeCompositionScene(read, 12)).document, read);
  assert.equal(deserializeProjectEnvelope(serializeCompositionScene(read, 12)).kind, 'composition');
  assert.deepEqual(deserializeDocument(v5), v5, 'opening v5 preserves its policy and representation');
  assert.deepEqual(serializeCompositionScene(v5, 4).document, v5, 'reader staging does not activate a v6 writer');
  assert.equal(compositionDocumentSchema.safeParse(document).success, false);
  assert.throws(() => deserializeLegacyDocument(document), /The legacy project document is invalid or uses an unsupported version\./);
});

test('Projects client uploads v6 assets, checkpoints raw v6 on the server, then reopens through transport v2', async (t) => {
  const base = await paintedFixture(), assets = base.assets;
  const document = remixDocumentSchema.parse({ ...base.document, remix: { ...base.document.remix,
    drafts: [{ id: 'recoverable', base: null, revision: 1, source: 'fn unfinished(', phase: 'invalid', diagnostics: [], site: null }],
    checkpoint: { appliedRevision: 0, draftRevision: 1, checkpointRevision: 1 } } });
  const server = projectServer(t);
  const result = await saveComposition({ document: withDerivedGrainStyle(document), assets,
    thumbnail: new Blob([jpeg], { type: 'image/jpeg' }), revision: 20, probeMissing: false });
  assert.deepEqual(result, { kind: 'saved', revision: 20 });
  assert.deepEqual(server.saved, [document.id]);
  assert.deepEqual(server.rows.get(document.id)?.scene, document, 'server stores raw v6 without derived style fields');
  for (const asset of assets.keys()) assert.ok(server.objects.has(`projects/${document.id}/assets/${asset}`));
  const response = await fetch(`/api/projects/${document.id}/scene`);
  assert.equal(response.status, 200);
  const wire = deserializeCompositionScene(await response.json());
  assert.equal(wire.transportVersion, 2);
  assert.deepEqual(wire.document, withDerivedGrainStyle(document));
  const loaded = await loadCompositionProject(document.id, new AbortController().signal);
  assert.equal(loaded.kind, 'composition');
  if (loaded.kind !== 'composition') return;
  assert.deepEqual(loaded.document, withDerivedGrainStyle(document));
  assert.deepEqual(loaded.assets, assets);
});

test('gallery v2 remains frozen while v3 carries v6 with its separate 4,136-descriptor limit', async () => {
  const { document, v5, descriptors, poster } = await fixture();
  assert.equal(GALLERY_VERSION, 3);
  assert.equal(GALLERY_COMPOSITION_VERSION, 2);
  const v2 = galleryCompositionDraftSchema.parse({ version: 2, document: v5, assets: descriptors, poster });
  const v3 = galleryRemixDraftSchema.parse({ version: 3, document, assets: descriptors, poster });
  const manifestFields = { id: uuid(900), publishedAt: '2026-10-11T12:00:00.000Z' };
  assert.deepEqual(galleryDraftSchema.parse(v2), v2);
  assert.deepEqual(galleryDraftSchema.parse(v3), v3);
  assert.deepEqual(galleryManifestSchema.parse({ ...v2, ...manifestFields }), galleryCompositionManifestSchema.parse({ ...v2, ...manifestFields }));
  assert.deepEqual(galleryManifestSchema.parse({ ...v3, ...manifestFields }), galleryRemixManifestSchema.parse({ ...v3, ...manifestFields }));
  assert.equal(galleryCompositionDraftSchema.safeParse(v3).success, false);
  const descriptor = v3.assets[0];
  assert.ok(descriptor);
  assert.equal(GALLERY_LIMITS.assets, 40);
  assert.equal(GALLERY_LIMITS.remixAssets, 4_136);
  assert.equal(galleryRemixDraftSchema.unwrap().shape.assets.safeParse(Array.from({ length: 4_136 }, () => descriptor)).success, true);
  assert.equal(galleryRemixDraftSchema.unwrap().shape.assets.safeParse(Array.from({ length: 4_137 }, () => descriptor)).success, false);
  assert.equal(galleryCompositionDraftSchema.unwrap().shape.assets.safeParse(Array.from({ length: 41 }, () => descriptor)).success, false);
  const withDraft = remixDocumentSchema.parse({ ...document, remix: { ...document.remix,
    drafts: [{ id: 'recoverable', base: null, revision: 1, source: 'fn unfinished(', phase: 'invalid', diagnostics: [], site: null }],
    checkpoint: { appliedRevision: 0, draftRevision: 1, checkpointRevision: 1 } } });
  const unpublished = galleryRemixDraftSchema.safeParse({ ...v3, document: withDraft });
  assert.equal(unpublished.success, false);
  if (!unpublished.success) assert.ok(unpublished.error.issues.some(issue => issue.message === 'Publish the applied recipe without recoverable source drafts.'));
});

test('gallery server and app reader accept, upload, publish and reopen a v3 piece', async (t) => {
  const { document, descriptors, assets, poster } = await paintedFixture();
  const { storage, objects } = bucket();
  const env: GalleryEnv = { PROJECTS: storage };
  const request = (path: string, init?: RequestInit) => handleGallery(new Request(`https://noisy.example${path}`, init), path, env, {});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'https://noisy.example').pathname;
    return request(path, init);
  });
  const draft = galleryRemixDraftSchema.parse({ version: 3, document, assets: descriptors, poster });
  const created = await request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
  assert.equal(created.status, 201, await created.clone().text());
  const { id, token } = z.object({ id: z.string(), token: z.string() }).parse(await created.json());
  for (const descriptor of [...draft.assets, draft.poster]) {
    const bytes = descriptor.kind === 'poster' ? jpeg : assets.get(descriptor.id);
    assert.ok(bytes);
    const type = 'mediaType' in descriptor ? descriptor.mediaType : 'application/octet-stream';
    const result = await request(`/api/gallery/${id}/${descriptor.kind === 'poster' ? 'poster' : `assets/${descriptor.id}`}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: new Blob([bytes]) });
    assert.equal(result.status, 200, await result.text());
  }
  const published = await request(`/api/gallery/${id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(published.status, 200, await published.clone().text());
  const manifest = galleryRemixManifestSchema.parse(await published.json());
  assert.deepEqual(manifest.document, document);
  const reopened = await request(`/api/gallery/${id}`);
  assert.equal(reopened.status, 200);
  assert.deepEqual(galleryManifestSchema.parse(await reopened.json()), manifest);
  assert.ok(objects.has(`gallery/pieces/${id}/manifest`));
  const content = await loadGallery(`/gallery/${id}`, new AbortController().signal);
  assert.ok(content);
  const piece = await content.loadPiece(new AbortController().signal);
  assert.deepEqual(piece.document, withDerivedGrainStyle(document));
  assert.ok('assets' in piece);
  assert.deepEqual(piece.assets, assets);
  const descriptor = draft.assets[0];
  assert.ok(descriptor);
  const refused = await request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...draft, assets: Array.from({ length: 4_137 }, () => descriptor) }) });
  assert.equal(refused.status, 400);
});
