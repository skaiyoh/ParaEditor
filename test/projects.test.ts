import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { SceneDocument } from '../src/core/types.ts';
import { isSceneId } from '../src/core/ids.ts';
import { serializeScene, deserializeScene } from '../src/projects/serialize.ts';
import { createProjectSession, PROJECT_UNDO_MS } from '../src/session/projects.ts';
import { minimalDocument, uuid } from './fixtures/documents.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function gate() {
  let release = (): void => { throw new Error('Gate not initialized'); };
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
function project(n: number): SceneDocument {
  const id = uuid(n);
  if (!isSceneId(id)) throw new Error('Invalid fixture id');
  return { ...minimalDocument(), id, title: `Photo ${n}` };
}

/** The store wire contract and thumbnail boundary are isolated; browser tests
 * exercise the same ownership transitions against the real renderer and HTTP. */
function rig(t: TestContext, documents: readonly SceneDocument[]) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stored = new Map(documents.map((doc) => [doc.id, { doc, revision: 0 }]));
  const tombstones = new Set<string>();
  const calls: { method: string; path: string; body: BodyInit | null | undefined }[] = [];
  const exports: string[] = [];
  let renderer = documents[0]?.title ?? '';
  let failExport = false;
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
        toBlob(done: (blob: Blob) => void) { done(new Blob([stamp], { type: 'image/jpeg' })); },
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
        const wire = deserializeScene(JSON.parse(init.body));
        stored.set(id, { doc: wire.document, revision: wire.revision });
      }
      return Response.json({ ok: true });
    }
    const saved = stored.get(id);
    if (saved === undefined) return Response.json({ error: 'Missing.' }, { status: 404 });
    if (resource === 'scene') return Response.json(serializeScene(saved.doc, new Map(), saved.revision));
    if (resource === 'photo') return new Response(new Blob(['photo'], { type: 'image/png' }));
    throw new Error(`Unexpected GET ${path}`);
  });
  const session = createProjectSession(async () => {
    exports.push(renderer);
    if (failExport) { failExport = false; throw new Error('Transient export failure'); }
    return new Blob([renderer]);
  });
  t.after(() => session.cancelPendingRemovals());
  return { session, stored, calls, exports, page,
    renderer(name: string) { renderer = name; },
    failNextExport() { failExport = true; },
    fault(rule: typeof fault) { fault = rule; },
    begin(doc: SceneDocument) { renderer = doc.title; session.begin(new File(['photo'], 'photo.png'), doc, new Map(), 0); },
    edit(doc: SceneDocument, fry: number) { session.observe({ ...doc, style: { ...doc.style, fry } }, new Map()); },
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
  for (const call of thumbnails) { assert.ok(call.body instanceof Blob); assert.equal(await call.body.text(), a.title); }
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
