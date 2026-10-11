import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { setImmediate } from 'node:timers/promises';
import type { SceneDocument } from '../src/core/types.ts';
import type { Plane } from '../src/core/raster.ts';
import { isAssetId, isSceneId, type AssetId } from '../src/core/ids.ts';
import { serializeCompositionScene, deserializeCompositionScene } from '../src/projects/serialize.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { compositionInventory } from '../src/projects/assets.ts';
import { encodeRaster, RASTER_HEADER_BYTES } from '../src/core/asset-codec.ts';
import { holeRadius, plateKeyMatches, plateNeeded, repairHole, sourceRemovalUnion } from '../src/core/derive.ts';
import { effectiveOrbit } from '../src/core/motion.ts';
import { createProjectSession, PROJECT_SAVE_BYTE_BUDGET, PROJECT_SAVE_JOB_LIMIT, PROJECT_SAVE_METADATA_BUDGET, PROJECT_UNDO_MS, type ProjectBegin } from '../src/session/projects.ts';
import { INPAINT_MODEL, minimalDocument, uuid } from './fixtures/documents.ts';
import { captureCommitted, createAuthoring, type GestureValue } from '../src/session/authoring.ts';
import { EMPTY_HISTORY, recordEdit } from '../src/core/history.ts';
import { applyProduce } from '../src/core/produce.ts';
import { depthProduct } from './fixtures/products.ts';
import { fiveClusterDocument } from './fixtures/documents.ts';
import { rasterSource } from './fixtures/composition.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 100; i++) await setImmediate(); };
function gate() {
  let release = (): void => { throw new Error('Gate not initialized'); };
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
function project(n: number): SceneDocument {
  const id = uuid(n);
  if (!isSceneId(id)) throw new Error('Invalid fixture id');
  return materialize({ ...minimalDocument(), id, title: `Photo ${n}` }, new Map());
}

const fixtureAssets = new Map<AssetId, Uint8Array>();
function digest(bytes: Uint8Array): AssetId {
  const asset = createHash('sha256').update(bytes).digest('hex'); assert.ok(isAssetId(asset));
  return asset;
}
function png(size: { readonly width: number; readonly height: number }): Uint8Array {
  function chunk(name: string, payload: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(payload.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, payload.length); bytes.set(new TextEncoder().encode(name), 4); bytes.set(payload, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, bytes.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
    return bytes;
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, size.width); view.setUint32(4, size.height); header[8] = 8; header[9] = 6;
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', header),
    ...chunk('IDAT', deflateSync(new Uint8Array(size.height * (size.width * 4 + 1)))), ...chunk('IEND', new Uint8Array())]);
}
/** Real self-describing bytes replace only fake fixture digests. */
function materialize(document: SceneDocument, assets: Map<AssetId, Uint8Array>): SceneDocument {
  const replacements = new Map<string, AssetId>();
  for (const [asset, refs] of compositionInventory(document)) {
    const existing = assets.get(asset) ?? fixtureAssets.get(asset);
    if (existing !== undefined) { assets.set(asset, existing); continue; }
    const ref = refs[0]; assert.ok(ref);
    const marker = Number.parseInt(asset.slice(-2), 16) / 255;
    const bytes = ref.kind === 'png' ? png(ref.size) : ref.kind === 'original' ? new Uint8Array(ref.byteLength) :
      ref.format === 'f32' ? encodeRaster({ format: ref.format, size: ref.size, data: new Float32Array(ref.size.width * ref.size.height).fill(marker) }) :
        encodeRaster({ format: ref.format, size: ref.size, data: new Uint8Array(ref.size.width * ref.size.height * (ref.format === 'u8' ? 1 : 4)).fill(Math.round(marker * 255)) });
    const encoded = digest(bytes);
    replacements.set(asset, encoded); assets.set(encoded, bytes); fixtureAssets.set(encoded, bytes);
  }
  const rewritten: unknown = JSON.parse(JSON.stringify(document), (_key, value: unknown) => typeof value === 'string' ? replacements.get(value) ?? value : value);
  const materialized = compositionDocumentSchema.parse(rewritten);
  return materialized.analysis.plate !== null || plateNeeded(materialized) ? readyRepair(materialized, assets) : materialized;
}
/** A renderer-ready fixture has the actual source union and dilated hole. */
function readyRepair(document: SceneDocument, assets: Map<AssetId, Uint8Array>): SceneDocument {
  const masks = new Map<AssetId, Plane<'u8'>>();
  for (const removal of document.removals) {
    const ref = removal.mask.plane, bytes = assets.get(ref.asset); assert.ok(bytes);
    masks.set(ref.asset, { format: 'u8', size: ref.size, data: bytes.subarray(RASTER_HEADER_BYTES) });
  }
  const union = sourceRemovalUnion(document, masks), hole = repairHole(document, union);
  const retain = (bytes: Uint8Array): AssetId => {
    const asset = digest(bytes); assets.set(asset, bytes); fixtureAssets.set(asset, bytes); return asset;
  };
  const backgroundDepth = document.analysis.plate?.backgroundDepth ?? document.analysis.depth?.map ?? {
    asset: retain(encodeRaster({ format: 'f32', size: document.frame.master.size,
      data: new Float32Array(document.frame.master.size.width * document.frame.master.size.height) })),
    format: 'f32' as const, size: document.frame.master.size,
  };
  return compositionDocumentSchema.parse({ ...document, analysis: { ...document.analysis, plate: {
    key: { algorithm: 'photo-repair-v2', source: document.frame.master.asset, size: document.frame.master.size,
      removalUnion: retain(encodeRaster(union)), hole: retain(encodeRaster(hole)),
      depth: document.analysis.depth?.map.asset ?? null, radius: holeRadius(document, document.frame.master.size),
      purpose: document.motion.enabled ? { kind: 'loop', parallax: document.motion.parallax, reach: effectiveOrbit(document.motion) } : { kind: 'still' },
      model: document.analysis.plate?.key.model ?? INPAINT_MODEL },
    image: document.analysis.plate?.image ?? document.frame.master, backgroundDepth,
  } } });
}
async function thumbnailStamp(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new TextDecoder().decode(bytes.subarray(2, -2));
}

/** The store wire contract and thumbnail boundary are isolated; browser tests
 * exercise the same ownership transitions against the real renderer and HTTP. */
function rig(t: TestContext, documents: readonly SceneDocument[]) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const assets = new Map(fixtureAssets);
  const stored = new Map(documents.map((doc) => [doc.id, { doc, revision: 0 }]));
  const tombstones = new Set<string>();
  const calls: { method: string; path: string; body: BodyInit | null | undefined }[] = [];
  const exports: string[] = [];
  let renderer = documents[0]?.title ?? '';
  let failExport = false;
  let exporter: ((document: SceneDocument) => Promise<Blob>) | null = null;
  let fault: (method: string, path: string) => Promise<Response | null> = async () => null;
  const page = new EventTarget();
  for (const [name, value] of Object.entries({
    window: page,
    createImageBitmap: async (blob: Blob) => ({ width: 2, height: 2, stamp: await blob.text(), close() {} }),
    document: { createElement(name: string) {
      assert.equal(name, 'canvas');
      let stamp = '';
      return { width: 0, height: 0,
        getContext() { return { drawImage(bitmap: { stamp: string }) { stamp = bitmap.stamp; } }; },
        toBlob(done: (blob: Blob) => void) { done(new Blob([new Uint8Array([255, 216]), stamp, new Uint8Array([255, 217])], { type: 'image/jpeg' })); },
      };
    } },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, original); });
  }
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body });
    const refusal = await fault(method, path);
    if (refusal !== null) return refusal;
    if (path === '/api/projects') return Response.json({ projects: [...stored.values()].map(({ doc }) => ({
      id: doc.id, name: doc.title, updatedAt: doc.updatedAt, thumbnail: `/api/projects/${doc.id}/thumbnail`,
    })) });
    const [, id, resource] = /^\/api\/projects\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
    if (id === undefined || !isSceneId(id)) throw new Error(`Unexpected ${path}`);
    if (method === 'DELETE') { stored.delete(id); tombstones.add(id); return Response.json({ ok: true }); }
    if (method === 'PUT') {
      if (tombstones.has(id)) return Response.json({ error: 'Deleted.' }, { status: 410 });
      if (resource === 'scene') {
        assert.equal(typeof init?.body, 'string');
        if (typeof init?.body !== 'string') throw new Error('Expected scene JSON');
        const wire = deserializeCompositionScene(JSON.parse(init.body));
        stored.set(id, { doc: wire.document, revision: wire.revision });
      } else if (resource?.startsWith('assets/')) {
        const asset = resource.slice('assets/'.length); assert.ok(isAssetId(asset));
        assert.ok(init?.body instanceof Blob); assets.set(asset, new Uint8Array(await init.body.arrayBuffer()));
      } else if (resource === 'photo') {
        const asset = new Headers(init?.headers).get('X-Project-Asset'); assert.ok(isAssetId(asset ?? ''));
        if (asset === null || !isAssetId(asset)) throw new Error('Expected immutable photo digest');
        assert.ok(init?.body instanceof Blob); assets.set(asset, new Uint8Array(await init.body.arrayBuffer()));
      }
      return Response.json({ ok: true });
    }
    if (resource?.startsWith('assets/')) {
      const asset = resource.slice('assets/'.length);
      const bytes = isAssetId(asset) ? assets.get(asset) : undefined;
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes));
    }
    const saved = stored.get(id);
    if (saved === undefined) return Response.json({ error: 'Missing.' }, { status: 404 });
    if (resource === 'scene') return Response.json(serializeCompositionScene(saved.doc, saved.revision));
    if (resource === 'photo') return new Response(new Blob(['photo'], { type: 'image/png' }));
    throw new Error(`Unexpected GET ${path}`);
  });
  const session = createProjectSession(async (document) => {
    if (exporter !== null) return exporter(document);
    exports.push(renderer);
    if (failExport) { failExport = false; throw new Error('Transient export failure'); }
    return new Blob([renderer]);
  });
  t.after(() => session.cancelPendingRemovals());
  return { session, stored, calls, exports, page, assets,
    async settled() {
      const deadline = Date.now() + 50_000;
      while (session.snapshot().state === 'saving' && Date.now() < deadline) await setImmediate();
    },
    async saved() {
      const deadline = Date.now() + 50_000;
      while ((session.snapshot().state !== 'saved' || session.retention().length !== 0) && Date.now() < deadline) await setImmediate();
      assert.equal(session.snapshot().state, 'saved', 'complete v5 asset validation and checkpoint must finish');
      assert.deepEqual(session.retention(), [], 'completed checkpoint releases every queued byte root');
    },
    exporter(next: (document: SceneDocument) => Promise<Blob>) { exporter = next; },
    renderer(name: string) { renderer = name; },
    failNextExport() { failExport = true; },
    fault(rule: typeof fault) { fault = rule; },
    begin(doc: SceneDocument) { renderer = doc.title; session.begin({ document: doc, assets, checkpoint: { kind: 'restored', revision: 0 } }); },
    edit(doc: SceneDocument, fry: number) { session.observe({ ...doc, style: { ...doc.style, fry } }, assets); },
    deletes() { return calls.filter((call) => call.method === 'DELETE'); },
  };
}

test('restoring and unsaved edits preserve the stored save time until a checkpoint succeeds', async (t) => {
  const doc = project(309), r = rig(t, [doc]);
  await r.session.refresh(); r.begin(doc);
  assert.equal(r.session.snapshot().projects[0]?.updatedAt, doc.updatedAt);
  r.edit(doc, .71);
  assert.equal(r.session.snapshot().projects[0]?.updatedAt, doc.updatedAt);
  r.fault(async (method) => method === 'PUT' ? Response.json({ error: 'Refused.' }, { status: 500 }) : null);
  t.mock.timers.tick(1500); await settle();
  assert.equal(r.session.snapshot().states.get(doc.id), 'failed');
  assert.equal(r.session.snapshot().projects[0]?.updatedAt, doc.updatedAt);
  r.fault(async () => null);
  await r.session.load(doc.id, new AbortController().signal);
  assert.equal(r.session.snapshot().states.get(doc.id), 'saved');
  assert.notEqual(r.session.snapshot().projects[0]?.updatedAt, doc.updatedAt);
});

test('immediate deletion survives refresh; Undo followed by Open flushes the pending debounce', async (t) => {
  const doc = project(310), r = rig(t, [doc]);
  await r.session.refresh(); r.begin(doc); r.edit(doc, .73);
  assert.equal(r.session.requestRemove(doc.id), true);
  assert.deepEqual(r.session.snapshot().projects, []);
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'undoable');
  await r.session.refresh(); assert.deepEqual(r.session.snapshot().projects, []);
  assert.equal(r.session.undoRemove(doc.id), true);
  const loaded = await r.session.load(doc.id, new AbortController().signal);
  assert.equal(loaded.document.style.fry, .73);
  assert.equal(loaded.revision, 1);
  t.mock.timers.tick(PROJECT_UNDO_MS); await settle();
  assert.equal(r.deletes().length, 0);
  assert.equal(r.session.snapshot().current, doc.id);
});

test('multiple current and non-current deletions have independent session-owned Undo windows', async (t) => {
  const a = project(311), b = project(312), r = rig(t, [a, b]);
  await r.session.refresh(); r.begin(a);
  const unsubscribe = r.session.subscribe(() => undefined);
  r.session.requestRemove(a.id); r.session.requestRemove(b.id); unsubscribe();
  assert.deepEqual(r.session.snapshot().projects, []);
  assert.equal(r.session.undoRemove(a.id), true);
  t.mock.timers.tick(PROJECT_UNDO_MS); await settle();
  assert.deepEqual(r.deletes().map((call) => call.path), [`/api/projects/${b.id}`]);
  assert.deepEqual(r.session.snapshot().projects.map((row) => row.id), [a.id]);
  assert.equal(r.session.snapshot().current, a.id);
  assert.equal(r.session.undoRemove(b.id), false);
});

test('expiry waits for queued saves and a failed DELETE retains edits made while writes were frozen', async (t) => {
  const doc = project(313), r = rig(t, [doc]), write = gate();
  await r.session.refresh(); r.begin(doc);
  let started = false;
  r.fault(async (method, path) => {
    if (method === 'PUT' && path.endsWith('/scene')) { started = true; await write.wait; }
    return method === 'DELETE' ? Response.json({ error: 'Refused.' }, { status: 500 }) : null;
  });
  r.edit(doc, .6); t.mock.timers.tick(1500); await settle(); assert.equal(started, true);
  r.session.requestRemove(doc.id); t.mock.timers.tick(PROJECT_UNDO_MS); await settle();
  assert.equal(r.deletes().length, 0);
  r.edit(doc, .91); write.release(); await settle();
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'failed');
  assert.equal(r.session.snapshot().projects[0]?.id, doc.id);
  r.fault(async () => null);
  assert.equal((await r.session.load(doc.id, new AbortController().signal)).document.style.fry, .91);
  await r.session.refresh();
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'failed', 'save/list success cannot erase the named deletion failure');
});

test('pagehide cancels expiry even while it awaits a save and the BFCache session stays usable', async (t) => {
  const doc = project(314), r = rig(t, [doc]), write = gate();
  await r.session.refresh(); r.begin(doc);
  r.fault(async (method, path) => { if (method === 'PUT' && path.endsWith('/scene')) await write.wait; return null; });
  r.edit(doc, .4); t.mock.timers.tick(1500); await settle();
  r.session.requestRemove(doc.id); t.mock.timers.tick(PROJECT_UNDO_MS); await settle();
  r.page.dispatchEvent(new Event('pagehide')); write.release(); await settle();
  assert.equal(r.deletes().length, 0);
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'restored');
  r.edit(doc, .88);
  assert.equal((await r.session.load(doc.id, new AbortController().signal)).document.style.fry, .88);
  r.session.requestRemove(doc.id); assert.equal(r.session.undoRemove(doc.id), true);
});

test('a non-current failed save retries its captured preview rather than exporting the new renderer', async (t) => {
  const a = project(315), b = project(316), r = rig(t, [a, b]);
  await r.session.refresh(); r.begin(a);
  let failed = false;
  r.fault(async (method, path) => {
    if (!failed && method === 'PUT' && path === `/api/projects/${a.id}/scene`) { failed = true; return Response.json({ error: 'Refused.' }, { status: 500 }); }
    return null;
  });
  r.edit(a, .3); r.session.suspend(); r.begin(b); await settle();
  assert.equal(r.session.snapshot().states.get(a.id), 'failed');
  assert.equal((await r.session.load(a.id, new AbortController().signal)).document.style.fry, .3);
  assert.deepEqual(r.exports, [a.title]);
  const thumbnails = r.calls.filter((call) => call.path === `/api/projects/${a.id}/thumbnail`);
  assert.equal(thumbnails.length, 2);
  for (const call of thumbnails) { assert.ok(call.body instanceof Blob); assert.equal(await thumbnailStamp(call.body), a.title); }
});

test('Open also flushes edits observed while an older queued save was in flight', async (t) => {
  const doc = project(317), r = rig(t, [doc]), write = gate();
  await r.session.refresh(); r.begin(doc);
  r.fault(async (method, path) => { if (method === 'PUT' && path.endsWith('/scene')) await write.wait; return null; });
  r.edit(doc, .2);
  const loaded = r.session.load(doc.id, new AbortController().signal); await settle();
  r.edit(doc, .87); write.release();
  assert.equal((await loaded).document.style.fry, .87);
  assert.equal(r.stored.get(doc.id)?.revision, 2);
});

test('an ambiguous DELETE acknowledgement stays unconfirmed and freezes writes until idempotent retry', async (t) => {
  const doc = project(318), r = rig(t, [doc]);
  await r.session.refresh(); r.begin(doc);
  let corrupted = false;
  r.fault(async (method) => {
    if (method === 'DELETE' && !corrupted) { corrupted = true; r.stored.delete(doc.id); return Response.json({ ok: 'bad' }); }
    return null;
  });
  r.session.requestRemove(doc.id); t.mock.timers.tick(PROJECT_UNDO_MS); await settle();
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'unconfirmed');
  const writes = r.calls.filter((call) => call.method === 'PUT').length;
  r.edit(doc, .92); t.mock.timers.tick(1500); await settle();
  assert.equal(r.calls.filter((call) => call.method === 'PUT').length, writes);
  assert.equal(r.session.requestRemove(doc.id), true); await settle();
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'deleted');
  assert.deepEqual(r.session.diagnostics(), { retainedJobs: 0, pendingSaves: 0 });
});

test('an unconfirmed non-current deletion blocks Open even without a retained save job', async (t) => {
  const a = project(319), b = project(320), r = rig(t, [a, b]);
  await r.session.refresh(); r.begin(a);
  r.fault(async (method) => { if (method === 'DELETE') throw new DOMException('No acknowledgement', 'TimeoutError'); return null; });
  r.session.requestRemove(b.id); t.mock.timers.tick(PROJECT_UNDO_MS); await settle();
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'unconfirmed');
  assert.ok(r.stored.has(b.id));
  await assert.rejects(r.session.load(b.id, new AbortController().signal), /being deleted/);
  assert.equal(r.session.snapshot().current, a.id);
  r.fault(async () => null);
  r.session.requestRemove(b.id); await settle();
  assert.equal(r.session.snapshot().deletions[0]?.phase, 'deleted');
});

test('a current project can retry a transient preview failure without another document edit', async (t) => {
  const doc = project(321), r = rig(t, [doc]);
  await r.session.refresh(); r.begin(doc); r.edit(doc, .7); r.failNextExport();
  await assert.rejects(r.session.load(doc.id, new AbortController().signal), /latest project changes could not be saved/);
  assert.equal((await r.session.load(doc.id, new AbortController().signal)).document.style.fry, .7);
  assert.deepEqual(r.exports, [doc.title, doc.title]);
});

test('pending saves capture committed color/parameters during long gestures, restore previews and retain arriving analysis', async (t) => {
  const initial = materialize(fiveClusterDocument(), new Map()), r = rig(t, [initial]);
  const assets = r.assets;
  let doc = initial, history = EMPTY_HISTORY, rendered = doc;
  const authoring = createAuthoring({ read: () => doc,
    changed: () => { rendered = authoring.previewDocument(doc); },
    record(edit) {
      const result = recordEdit({ doc, history, edit, now: '2026-10-11T01:00:00.000Z', at: 1 });
      if (result.kind === 'refused') return { kind: 'refused', reason: result.detail };
      if (result.kind === 'applied') { doc = result.doc; history = result.history; r.session.observe(doc, assets); }
      return { kind: result.kind };
    },
  });
  r.exporter((document) => captureCommitted({ document,
    render(saved) { rendered = saved; },
    capture: () => Promise.resolve(new Blob([JSON.stringify(rendered)])),
    restore() { rendered = authoring.previewDocument(doc); },
  }));
  await r.session.refresh(); r.session.begin({ document: doc, assets, checkpoint: { kind: 'restored', revision: 0 } });
  const layer = doc.objects[0]; assert.ok(layer);
  for (const value of [
    { kind: 'color', color: { l: .32, c: .11, h: 101 } },
    { kind: 'style', patch: { saturation: .11 } },
  ] satisfies GestureValue[]) {
    const pending = recordEdit({ doc, history, edit: { kind: 'symbols', patch: { amount: value.kind === 'color' ? .11 : .22 } }, now: '2026-10-11T00:30:00.000Z', at: 0 });
    assert.equal(pending.kind, 'applied'); doc = pending.doc; history = pending.history;
    r.session.observe(doc, assets);
    const before = doc, beforeHistory = history;
    const token = authoring.beginGesture({ operation: value.kind, target: value.kind === 'color' ? { kind: 'layer', id: layer.id } : { kind: 'scene' } }); assert.ok(token);
    assert.equal(authoring.updateGesture({ token, value }).kind, 'applied');
    assert.notDeepEqual(rendered, doc);
    // The debounce expires while the preview remains live.
    t.mock.timers.tick(1500); await r.saved();
    assert.deepEqual(r.stored.get(doc.id)?.doc, before);
    const firstThumbnail = r.calls.filter((call) => call.path.endsWith('/thumbnail')).at(-1)?.body;
    assert.ok(firstThumbnail instanceof Blob); assert.deepEqual(JSON.parse(await thumbnailStamp(firstThumbnail)), before);
    assert.deepEqual(rendered, authoring.previewDocument(doc)); assert.notDeepEqual(rendered, before);
    // Analysis is a real committed product and schedules its own snapshot, not a color commit.
    const arrived = applyProduce(doc, { kind: 'depth', depth: depthProduct(value.kind === 'color' ? 3 : 4) }, '2026-10-11T00:45:00.000Z');
    assert.equal(arrived.kind, 'applied'); doc = materialize(arrived.doc, assets); authoring.reconcile(doc, null);
    r.session.observe(doc, assets);
    t.mock.timers.tick(1500); await r.saved();
    assert.notDeepEqual(rendered, doc);
    const committed = doc;
    authoring.cancelGesture(token);
    assert.equal(doc, committed); assert.equal(history, beforeHistory); assert.equal(rendered, committed);
    assert.deepEqual(r.stored.get(doc.id)?.doc, committed);
    const thumbnail = r.calls.filter((call) => call.path.endsWith('/thumbnail')).at(-1)?.body;
    assert.ok(thumbnail instanceof Blob); assert.deepEqual(JSON.parse(await thumbnailStamp(thumbnail)), committed);
    const writes = r.calls.length;
    t.mock.timers.tick(5000); await settle(); assert.equal(r.calls.length, writes, 'cancellation schedules no save');
  }
});

test('v5 saves retain one active and one replaceable pending snapshot while preserving the newest revision', async (t) => {
  const doc = project(322), r = rig(t, [doc]), writing = gate(), entered = gate();
  await r.session.refresh(); r.begin(doc);
  let started = false;
  r.fault(async (method, path) => {
    if (!started && method === 'PUT' && path.endsWith('/scene')) { started = true; entered.release(); await writing.wait; }
    return null;
  });
  r.edit(doc, .1); t.mock.timers.tick(1500); await entered.wait; assert.equal(started, true);
  for (const fry of [.2, .3, .4, .5]) {
    r.edit(doc, fry); t.mock.timers.tick(1500); await settle();
    const retained = r.session.retention();
    assert.deepEqual(retained.map(({ kind }) => kind), ['active', 'pending']);
    assert.equal(retained[0]?.revision, 1);
    assert.equal(retained[1]?.bytes, r.assets.get(doc.frame.master.asset)?.byteLength);
    assert.equal(r.session.diagnostics().pendingSaves, 1);
  }
  writing.release(); await r.saved();
  assert.equal(r.stored.get(doc.id)?.doc.style.fry, .5);
  assert.equal(r.stored.get(doc.id)?.revision, 5);
  assert.deepEqual(r.session.retention(), []);
  assert.equal(r.calls.filter(({ path, method }) => path === `/api/projects/${doc.id}/scene` && method === 'PUT').length, 2);
});

test('new checkpoints own immutable committed bytes and upgrades advance the legacy revision', async (t) => {
  const doc = project(323), r = rig(t, [doc]);
  await r.session.refresh();
  const assets = new Map([...r.assets].map(([asset, bytes]) => [asset, new Uint8Array(bytes)]));
  r.session.begin({ document: doc, assets, checkpoint: { kind: 'upgrade', revision: 17 } });
  const retained = r.session.retention();
  assert.equal(retained[0]?.revision, 18); assert.equal(retained[0]?.complete, true);
  assets.get(doc.frame.master.asset)?.fill(0);
  t.mock.timers.tick(1500); await r.saved();
  assert.equal(r.stored.get(doc.id)?.revision, 18);
  const write = r.calls.find(({ method, path }) => method === 'PUT' && path.endsWith('/scene'));
  assert.ok(write); assert.equal(typeof write.body, 'string');
  if (typeof write.body !== 'string') throw new Error('Expected v2 JSON');
  assert.equal(deserializeCompositionScene(JSON.parse(write.body)).transportVersion, 2);
  assert.ok(!('masks' in JSON.parse(write.body)));
});

test('session retries and the store share one immutable Blob for an unchanged encoded asset', async (t) => {
  const doc = project(325), r = rig(t, [doc]), entered = gate(), writing = gate();
  const master = r.assets.get(doc.frame.master.asset); assert.ok(master);
  const input: Uint8Array = master;
  const NativeBlob = Blob, captured: Blob[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Blob');
  class TrackedBlob extends NativeBlob {
    constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
      super(parts, options);
      if (parts.some((part) => part instanceof Uint8Array && part.buffer === input.buffer && part.byteOffset === input.byteOffset && part.byteLength === input.byteLength)) captured.push(this);
    }
  }
  Object.defineProperty(globalThis, 'Blob', { configurable: true, value: TrackedBlob });
  t.after(() => {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'Blob');
    else Object.defineProperty(globalThis, 'Blob', descriptor);
  });
  await r.session.refresh(); r.begin(doc);
  assert.equal(captured.length, 0, 'a restored checkpoint owns no queued byte copy');
  let blocked = false;
  r.fault(async (method, path) => {
    if (!blocked && method === 'PUT' && path.endsWith('/scene')) { blocked = true; entered.release(); await writing.wait; }
    return null;
  });
  r.edit(doc, .1); t.mock.timers.tick(1500); await entered.wait;
  assert.equal(captured.length, 1);
  const upload = r.calls.find(({ method, path }) => method === 'PUT' && path.endsWith(`/assets/${doc.frame.master.asset}`));
  assert.equal(upload?.body, captured[0], 'the store uploads the session-owned Blob without copying');
  for (const fry of [.2, .3, .4]) {
    r.edit(doc, fry); t.mock.timers.tick(1500); await settle();
    assert.equal(captured.length, 1, 'pending replacements reuse the unchanged immutable digest');
    assert.deepEqual(r.session.retention().map(({ kind }) => kind), ['active', 'pending']);
  }
  writing.release(); await r.saved();
  assert.equal(r.stored.get(doc.id)?.revision, 4);
  assert.equal(captured.length, 1);
});

test('incomplete v5 assets keep Saving and issue no checkpoint until encoded bytes arrive', async (t) => {
  const doc = project(324), r = rig(t, [doc]);
  await r.session.refresh();
  r.session.begin({ document: doc, assets: new Map(), checkpoint: { kind: 'new' } });
  t.mock.timers.tick(1500); await settle();
  assert.equal(r.session.snapshot().state, 'saving');
  assert.equal(r.session.retention()[0]?.complete, false);
  assert.equal(r.calls.filter(({ method }) => method === 'PUT').length, 0);
  assert.deepEqual(r.exports, []);
  await assert.rejects(r.session.load(doc.id, new AbortController().signal), /still being prepared/);
  r.session.observe(doc, r.assets); t.mock.timers.tick(1500); await r.saved();
  assert.equal(r.stored.get(doc.id)?.revision, 1);
});

test('required repairs hold the durable checkpoint until the exact union and hole arrive', async (t) => {
  const initial = materialize(fiveClusterDocument(), new Map()), r = rig(t, [initial]);
  await r.session.refresh(); r.begin(initial);
  const preparing: SceneDocument = { ...initial, analysis: { ...initial.analysis, plate: null } };
  assert.equal(plateNeeded(preparing), true);
  assert.deepEqual(r.session.observe(preparing, r.assets), { kind: 'admitted' });
  t.mock.timers.tick(1500); await settle();
  assert.equal(r.session.snapshot().state, 'saving');
  assert.equal(r.session.retention()[0]?.complete, false);
  assert.equal(r.calls.filter(({ method }) => method === 'PUT').length, 0);
  assert.deepEqual(r.exports, []);
  assert.deepEqual(r.stored.get(initial.id), { doc: initial, revision: 0 });
  await assert.rejects(r.session.load(initial.id, new AbortController().signal), /still being prepared/);

  const ready = readyRepair(preparing, r.assets);
  assert.equal(plateNeeded(ready), false);
  assert.deepEqual(r.session.observe(ready, r.assets), { kind: 'admitted' });
  t.mock.timers.tick(1500); await r.saved();
  assert.deepEqual(r.stored.get(initial.id), { doc: ready, revision: 2 });
  const writes = r.calls.filter(({ method }) => method === 'PUT').length;
  const plate = ready.analysis.plate; assert.ok(plate);

  for (const field of ['removalUnion', 'hole'] as const) {
    const incorrect = new Uint8Array(r.assets.get(plate.key[field]) ?? []);
    assert.ok(incorrect.length > RASTER_HEADER_BYTES); incorrect[RASTER_HEADER_BYTES] = 255;
    const asset = digest(incorrect); r.assets.set(asset, incorrect);
    const stale: SceneDocument = { ...ready, analysis: { ...ready.analysis,
      plate: { ...plate, key: { ...plate.key, [field]: asset } } } };
    assert.equal(plateKeyMatches(stale, stale.analysis.plate!.key), true, 'metadata alone cannot prove a repair is current');
    assert.equal(plateNeeded(stale), false);
    assert.deepEqual(r.session.observe(stale, r.assets), { kind: 'admitted' });
    t.mock.timers.tick(1500); await settle();
    assert.equal(r.session.retention()[0]?.complete, false);
    assert.equal(r.calls.filter(({ method }) => method === 'PUT').length, writes);
    assert.deepEqual(r.stored.get(initial.id), { doc: ready, revision: 2 }, 'stale repair bytes cannot replace the prior durable checkpoint');
  }
  r.session.observe(ready, r.assets); t.mock.timers.tick(1500); await r.saved();
  assert.deepEqual(r.stored.get(initial.id)?.doc, ready);
});

test('opening a durable v5 scene rejects a missing or stale concrete repair with a sentence', async (t) => {
  const ready = materialize(fiveClusterDocument(), new Map());
  const missing = { ...ready, analysis: { ...ready.analysis, plate: null } };
  const r = rig(t, [missing]); await r.session.refresh();
  await assert.rejects(r.session.load(missing.id, new AbortController().signal), /required background repair is still preparing/);
  assert.equal(r.session.snapshot().current, null);
  const plate = ready.analysis.plate; assert.ok(plate);
  const stale = new Uint8Array(r.assets.get(plate.key.hole) ?? []);
  stale[RASTER_HEADER_BYTES] = 255; const asset = digest(stale); r.assets.set(asset, stale);
  const incorrect = { ...ready, analysis: { ...ready.analysis, plate: { ...plate, key: { ...plate.key, hole: asset } } } };
  r.stored.set(ready.id, { doc: incorrect, revision: 7 });
  await assert.rejects(r.session.load(ready.id, new AbortController().signal), /exact source removal and hole/);
  assert.deepEqual(r.stored.get(ready.id), { doc: incorrect, revision: 7 });
});

test('capturing a pending preview during an original upload preserves synchronous import admission', async (t) => {
  const base = project(390), r = rig(t, []), writing = gate(), entered = gate();
  const master = r.assets.get(base.frame.master.asset); assert.ok(master);
  const document = compositionDocumentSchema.parse({ ...base, frame: { ...base.frame,
    source: { asset: base.frame.master.asset, mediaType: 'image/png', byteLength: master.byteLength } } });
  r.fault(async (method, path) => {
    if (method === 'PUT' && path.endsWith('/photo')) { entered.release(); await writing.wait; }
    return method === 'PUT' ? Response.json({ error: 'Refused.' }, { status: 500 }) : null;
  });
  await r.session.refresh(); r.renderer(document.title);
  assert.equal(r.session.begin({ document, assets: r.assets, checkpoint: { kind: 'new' } }).kind, 'admitted');
  await entered.wait;
  const candidate = { document: project(391), assets: r.assets, checkpoint: { kind: 'new' } as const };
  const admission = r.session.preflight(candidate), usage = r.session.queuedUsage();
  assert.equal(admission.kind, 'admitted');
  r.session.suspend();
  assert.deepEqual(r.session.retention().map(({ kind }) => kind), ['active', 'pending']);
  assert.deepEqual(r.session.queuedUsage(), usage, 'the original-only active root cannot reserve a second thumbnail for the same document');
  assert.deepEqual(r.session.preflight(candidate), admission);
  writing.release(); await settle();
});

test('twelve failing new-project cycles refuse before scene replacement at the session byte limit', async (t) => {
  const seed = project(400), r = rig(t, [seed]);
  await r.session.refresh(); r.begin(seed);
  r.fault(async (method) => method === 'PUT' ? Response.json({ error: 'Refused.' }, { status: 500 }) : null);
  const master = r.assets.get(seed.frame.master.asset); assert.ok(master);
  let admitted = 0, refused = 0;
  let current = seed;
  let currentAssets: ReadonlyMap<AssetId, Uint8Array> = new Map([[seed.frame.master.asset, master]]);
  for (let cycle = 0; cycle < 12; cycle++) {
    const original = new Uint8Array(20 * 1024 * 1024).fill(cycle + 1), asset = digest(original);
    const base = project(401 + cycle);
    const candidate = compositionDocumentSchema.parse({ ...base, frame: { ...base.frame,
      source: { asset, mediaType: 'image/jpeg', byteLength: original.byteLength },
      original: { ...base.frame.original, name: `${cycle}.jpg`, mediaType: 'image/jpeg' } } });
    const assets: ReadonlyMap<AssetId, Uint8Array> = new Map<AssetId, Uint8Array>([[candidate.frame.master.asset, master], [asset, original]]);
    const input: ProjectBegin = { document: candidate, assets, checkpoint: { kind: 'new' } };
    const before = r.session.retention(), beforeUsage = r.session.queuedUsage(), writes = r.calls.length;
    const admission = r.session.preflight(input);
    if (admission.kind === 'refused') {
      refused++;
      assert.match(admission.reason, /save memory limit/);
      assert.equal(r.session.snapshot().current, current.id);
      assert.deepEqual(r.session.retention(), before);
      assert.deepEqual(r.session.queuedUsage(), beforeUsage);
      assert.equal(r.calls.length, writes, 'preflight performs no request or export');
      assert.deepEqual(r.session.begin(input), admission, 'the mutation boundary independently refuses the same candidate');
      assert.equal(r.session.snapshot().current, current.id);
      assert.deepEqual(r.session.retention(), before);
    } else {
      admitted++;
      r.session.suspend(); r.renderer(candidate.title);
      assert.deepEqual(r.session.begin(input), { kind: 'admitted' });
      current = candidate; currentAssets = assets;
      t.mock.timers.tick(1500);
      const deadline = Date.now() + 50_000;
      while ((r.session.snapshot().state !== 'failed' || r.session.retention().some(({ kind }) => kind === 'active')) && Date.now() < deadline) await setImmediate();
      assert.equal(r.session.snapshot().state, 'failed');
      assert.ok(r.session.retention().every(({ kind }) => kind === 'pending'));
    }
    assert.ok(r.session.queuedBytes() <= PROJECT_SAVE_BYTE_BUDGET);
  }
  assert.equal(admitted, 8); assert.equal(refused, 4);
  assert.equal(r.session.retention().length, 8, 'every unsaved project survives refusal');
  assert.equal(r.session.queuedUsage().assets, 9, 'eight original Blobs and one physically shared master are owned');
  assert.equal(r.session.queuedBytes(), 8 * 20 * 1024 * 1024 + master.byteLength);
  assert.deepEqual([...r.stored.keys()], [seed.id]);

  const image = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 2048, height: 2048 },
    data: new Uint8Array(2048 * 2048 * 4) });
  const source = rasterSource(400), imageAsset = digest(image);
  const larger = compositionDocumentSchema.parse({ ...current, sources: [{ ...source,
    image: { ...source.image, asset: imageAsset, size: { width: 2048, height: 2048 } } }] });
  const largerAssets = new Map(currentAssets); largerAssets.set(imageAsset, image);
  const before = r.session.retention(), usage = r.session.queuedUsage(), writes = r.calls.length;
  assert.equal(r.session.preflightObserve(larger, largerAssets).kind, 'refused');
  assert.equal(r.session.observe(larger, largerAssets).kind, 'refused');
  assert.deepEqual(r.session.retention(), before, 'a refused copied snapshot cannot replace the current pending slot');
  assert.deepEqual(r.session.queuedUsage(), usage);
  assert.equal(r.calls.length, writes);
  assert.equal(r.session.preflightObserve(current, currentAssets).kind, 'admitted', 'unchanged notifications reserve no extra snapshot');

  const oldest = r.session.retention()[0]; assert.ok(oldest);
  assert.equal(await r.session.remove(oldest.id), true);
  assert.equal(r.session.retention().length, 7);
  assert.equal(r.session.queuedBytes(), 7 * 20 * 1024 * 1024 + master.byteLength, 'confirmed deletion releases its immutable original');
  r.fault(async () => null);
  await r.session.load(current.id, new AbortController().signal);
  assert.equal(r.stored.get(current.id)?.revision, 0, 'retry persists the retained current snapshot');
  assert.equal(r.session.retention().length, 6);
});

test('shared immutable images stay deduplicated while failed project jobs have a separate limit', async (t) => {
  const seed = project(500), r = rig(t, [seed]);
  await r.session.refresh(); r.begin(seed);
  r.fault(async (method) => method === 'PUT' ? Response.json({ error: 'Refused.' }, { status: 500 }) : null);
  const master = r.assets.get(seed.frame.master.asset); assert.ok(master);
  for (let index = 0; index < PROJECT_SAVE_JOB_LIMIT; index++) {
    const document = project(501 + index);
    const input: ProjectBegin = { document, assets: new Map<AssetId, Uint8Array>([[document.frame.master.asset, new Uint8Array(master)]]), checkpoint: { kind: 'new' } };
    assert.equal(r.session.preflight(input).kind, 'admitted');
    r.session.suspend(); r.renderer(document.title); assert.equal(r.session.begin(input).kind, 'admitted');
    t.mock.timers.tick(1500);
    // Hashing runs on the thread pool, so a loaded machine can need more than one settle.
    for (let turn = 0; turn < 50 && r.session.snapshot().state !== 'failed'; turn++) await settle();
    assert.equal(r.session.snapshot().state, 'failed');
    assert.equal(r.session.queuedBytes(), master.byteLength);
  }
  assert.equal(r.session.queuedUsage().jobs, PROJECT_SAVE_JOB_LIMIT);
  assert.equal(r.session.retention().length, PROJECT_SAVE_JOB_LIMIT);
  assert.equal(r.session.queuedUsage().assets, 1);
  const uploaded = r.calls.filter(({ method, path }) => method === 'PUT' && path.includes('/assets/')).map(({ body }) => body);
  assert.ok(uploaded.length >= PROJECT_SAVE_JOB_LIMIT);
  assert.equal(new Set(uploaded).size, 1, 'different input buffers share the actual immutable captured Blob');
  const extra = project(601), before = r.session.retention(), current = r.session.snapshot().current;
  const input = { document: extra, assets: r.assets, checkpoint: { kind: 'new' } as const };
  assert.equal(r.session.preflight(input).kind, 'refused');
  assert.equal(r.session.begin(input).kind, 'refused');
  assert.equal(r.session.snapshot().current, current);
  assert.deepEqual(r.session.retention(), before);
});

test('serialized scenes and preview allowances bound metadata even with one shared image', async (t) => {
  const seed = project(700), r = rig(t, [seed]);
  await r.session.refresh(); r.begin(seed);
  r.fault(async (method) => method === 'PUT' ? Response.json({ error: 'Refused.' }, { status: 500 }) : null);
  let refused = false, admitted = 0;
  for (let index = 0; index < 20; index++) {
    const base = project(701 + index);
    const document = compositionDocumentSchema.parse({ ...base, provenance: { ...base.provenance, importedOn: 'x'.repeat(512 * 1024) } });
    const input = { document, assets: r.assets, checkpoint: { kind: 'new' } as const };
    const current = r.session.snapshot().current, before = r.session.retention(), usage = r.session.queuedUsage();
    const admission = r.session.preflight(input);
    if (admission.kind === 'refused') {
      assert.match(admission.reason, /save memory limit/); refused = true;
      assert.equal(r.session.begin(input).kind, 'refused');
      assert.equal(r.session.snapshot().current, current);
      assert.deepEqual(r.session.retention(), before); assert.deepEqual(r.session.queuedUsage(), usage);
      break;
    }
    admitted++; r.session.suspend(); r.renderer(document.title); r.session.begin(input);
    t.mock.timers.tick(1500); await r.settled(); assert.equal(r.session.snapshot().state, 'failed');
    assert.ok(r.session.queuedUsage().metadataBytes <= PROJECT_SAVE_METADATA_BUDGET);
  }
  assert.equal(refused, true); assert.ok(admitted >= 12 && admitted < PROJECT_SAVE_JOB_LIMIT);
  assert.equal(r.session.retention().length, admitted);
  assert.equal(r.session.queuedUsage().assets, 1);
});
