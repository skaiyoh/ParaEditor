import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { galleryCreatedSchema, galleryDraftSchema, galleryListSchema, galleryManifestSchema } from '../src/core/gallery.ts';
import { fiveClusterDocument } from './fixtures/documents.ts';
import { startServer, tempDir } from './support/cli.ts';

// Complete baseline JPEG encoding one gray pixel, including its entropy-coded scan.
const jpeg = new Uint8Array([255,216,255,219,0,67,0,...Array<number>(64).fill(1),255,192,0,11,8,0,1,0,1,1,1,17,0,
  255,196,0,20,0,1,...Array<number>(15).fill(0),0,255,196,0,20,16,1,...Array<number>(15).fill(0),0,
  255,218,0,8,1,1,0,0,63,0,63,255,217]);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('real dev HTTP publishes JPEG, u8 mask, little-endian f32 depth, RGB8 plate and poster byte for byte, then deletes', async () => {
  const scratch = await tempDir('gallery-http');
  const server = await startServer(['--mode', 'dev', '--results', path.join(scratch, 'results'), '--request-log', path.join(scratch, 'requests.jsonl')]);
  const size = { width: 2, height: 2 }, mask = new Uint8Array([0, 127, 128, 255]);
  const depth = new Uint8Array(16), values = new DataView(depth.buffer);
  [0, 0.25, 0.75, 1].forEach((value, index) => values.setFloat32(index * 4, value, true));
  const plate = new Uint8Array([255,0,0,0,255,0,0,0,255,127,128,129]);
  const assets = [
    { kind: 'source', id: hash(jpeg), size: { width: 1, height: 1 }, mediaType: 'image/jpeg', byteLength: jpeg.length },
    { kind: 'mask', id: hash(mask), size, format: 'u8', byteLength: mask.length },
    { kind: 'depth', id: hash(depth), size, format: 'f32', byteLength: depth.length },
    { kind: 'plate', id: hash(plate), size, format: 'rgb8', byteLength: plate.length },
  ];
  const source = fiveClusterDocument(), first = source.objects[0]; assert.ok(first); assert.ok(source.analysis.depth); assert.ok(source.analysis.plate);
  const draft = galleryDraftSchema.parse({
    document: { ...source, frame: { ...source.frame, source: { asset: hash(jpeg), mediaType: 'image/jpeg', byteLength: jpeg.length },
      original: { name: 'gray.jpg', mediaType: 'image/jpeg', size: { width: 1, height: 1 } } },
      analysis: { ...source.analysis, depth: { ...source.analysis.depth, map: { asset: hash(depth), size, format: 'f32' } },
        plate: { ...source.analysis.plate, image: { asset: hash(plate), size }, forMasks: [hash(mask)] } },
      objects: [{ ...first, produced: { ...first.produced, mask: { asset: hash(mask), size, format: 'u8' } } }] },
    assets, poster: { kind: 'poster', id: hash(jpeg), size: { width: 1, height: 1 }, mediaType: 'image/jpeg', byteLength: jpeg.length },
  });
  const request = async (route: string, init?: RequestInit) => { const response = await fetch(new URL(route, server.url), init); assert.equal(response.headers.get('Cache-Control'), 'no-cache'); return response; };
  try {
    const created = await request('/api/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
    assert.equal(created.status, 201, await created.clone().text()); const { id, token } = galleryCreatedSchema.parse(await created.json());
    const route = `/api/gallery/${id}`, auth = { Authorization: `Bearer ${token}` };
    try {
      assert.equal((await request(route)).status, 404);
      assert.ok(!galleryListSchema.parse(await (await request('/api/gallery')).json()).pieces.some((piece) => piece.id === id));
      assert.equal((await request(`${route}/publish`, { method: 'POST', headers: auth })).status, 409);
      const resources = [[`assets/${hash(jpeg)}`, jpeg, 'image/jpeg'], [`assets/${hash(mask)}`, mask, 'application/octet-stream'],
        [`assets/${hash(depth)}`, depth, 'application/octet-stream'], [`assets/${hash(plate)}`, plate, 'application/octet-stream'], ['poster', jpeg, 'image/jpeg']] satisfies [string, Uint8Array<ArrayBuffer>, string][];
      for (const [part, bytes, type] of resources) {
        const uploaded = await request(`${route}/${part}`, { method: 'PUT', headers: { ...auth, 'Content-Type': type }, body: bytes });
        assert.equal(uploaded.status, 200, await uploaded.clone().text()); assert.deepEqual(await uploaded.json(), { ok: true });
        assert.equal((await request(`${route}/${part}`)).status, 404, 'draft upload remains private');
      }
      const corruptDepth = depth.slice(); corruptDepth[0] = 1;
      await writeFile(path.join(scratch, 'results', 'gallery', 'pieces', id, 'assets', hash(depth)), corruptDepth);
      const refused = await request(`${route}/publish`, { method: 'POST', headers: auth });
      assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: 'The gallery asset bytes do not match their id.' });
      assert.ok(!galleryListSchema.parse(await (await request('/api/gallery')).json()).pieces.some((piece) => piece.id === id));
      const repaired = await request(`${route}/assets/${hash(depth)}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: depth });
      assert.equal(repaired.status, 200); await repaired.arrayBuffer();
      const published = await request(`${route}/publish`, { method: 'POST', headers: auth }); assert.equal(published.status, 200, await published.clone().text());
      const manifest = galleryManifestSchema.parse(await published.json()); assert.deepEqual(manifest.document, draft.document);
      assert.deepEqual(await (await request(route)).json(), manifest);
      assert.ok(galleryListSchema.parse(await (await request('/api/gallery')).json()).pieces.some((piece) => piece.id === id));
      for (const [part, bytes, type] of resources) {
        const response = await request(`${route}/${part}`); assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), type);
        assert.equal(response.headers.get('ETag'), `"${hash(bytes)}"`); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
        for (const condition of [`"${hash(bytes)}"`, `W/"${hash(bytes)}"`, '*']) {
          const unchanged = await request(`${route}/${part}`, { headers: { 'If-None-Match': condition } });
          assert.equal(unchanged.status, 304); assert.equal(unchanged.headers.get('ETag'), `"${hash(bytes)}"`);
          assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
        }
      }
      for (const jsonRoute of [route, '/api/gallery']) {
        const current = await request(jsonRoute), etag = current.headers.get('ETag');
        assert.ok(etag); await current.arrayBuffer();
        const unchanged = await request(jsonRoute, { headers: { 'If-None-Match': `W/${etag}` } });
        assert.equal(unchanged.status, 304); assert.equal(unchanged.headers.get('ETag'), etag);
        assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
      }
      assert.equal((await request(route, { method: 'DELETE', headers: { Authorization: 'Bearer wrong' } })).status, 403);
      assert.equal((await request(route, { method: 'DELETE', headers: auth })).status, 200);
      for (const [part] of resources) assert.equal((await request(`${route}/${part}`, { headers: { 'If-None-Match': '*' } })).status, 404);
      assert.equal((await request(route, { headers: { 'If-None-Match': '*' } })).status, 404);
      assert.ok(!galleryListSchema.parse(await (await request('/api/gallery')).json()).pieces.some((piece) => piece.id === id));
      for (const part of ['draft', 'manifest', 'poster', ...assets.map((asset) => `assets/${asset.id}`)]) {
        await assert.rejects(stat(path.join(scratch, 'results', 'gallery', 'pieces', id, part)), { code: 'ENOENT' });
      }
    } finally { const cleanup = await request(route, { method: 'DELETE', headers: auth }); assert.equal(cleanup.status, 200); await cleanup.arrayBuffer(); }
  } finally { await server.stop(); await rm(scratch, { recursive: true, force: true }); }
});
