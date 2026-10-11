import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { initialPolicy, nextWake, transition, type Policy, type PolicyEvent, type Stage } from '../src/session/policy.ts';
import { createProducts, productAsset } from '../src/session/products.ts';
import { createDriver, warmDecoder } from '../src/session/driver.ts';
import type { AnalysisError, AnalysisService, Decoder, SequenceListener } from '../src/analysis/service.ts';
import type { SamEmbeddings } from '../src/analysis/protocol.ts';
import { isAssetId, isBuildId, isModelId, isObjectId, isSceneId } from '../src/core/ids.ts';
import { newDocument, newObject } from '../src/core/defaults.ts';
import { linkedRemoval } from '../src/core/reduce.ts';
import { photoStats } from '../src/photo/stats.ts';
import type { Plane } from '../src/core/raster.ts';
import type { Produce } from '../src/core/edits.ts';
import type { PerspectiveGeometry } from '../src/core/perspective.ts';
import { createEmbeddingCache, type EmbeddingCache } from '../src/session/embedding-cache.ts';
import type { SceneDocument } from '../src/core/types.ts';
import type { Rgb8 } from '../src/core/raster.ts';
import type { createProjectSession } from '../src/session/projects.ts';
import type { GestureStart, GestureUpdate } from '../src/session/authoring.ts';
import type { PublishReadiness } from '../src/session/publish.ts';
import { parseLock } from '../src/analysis/lock.ts';
import { plateNeeded, renderingPrerequisites } from '../src/core/derive.ts';
import type { injectAnalysisService } from '../src/session/driver.ts';
import { deserializeCompositionScene, serializeCompositionScene } from '../src/projects/serialize.ts';
import { HEIC_MESSAGE, LONG_EDGE_MESSAGE } from '../src/photo/limits.ts';

test('status recovery copy excludes stale timings while ordinary progress keeps dev timings', async (t) => {
  for (const development of [true, false]) await t.test(development ? 'development' : 'production', async () => {
    const compiled = await bundle({ stdin: { contents: "export { formatStatusLine } from './src/ui/app.tsx';", resolveDir: new URL('..', import.meta.url).pathname },
      bundle: true, format: 'esm', platform: 'node', write: false, define: { NOISY_DEV: String(development) } });
    const timing = { stage: 'warmup', ms: 129.4 };
    const built: { formatStatusLine(input: { readonly status: string; readonly timing: typeof timing | null }): string } =
      await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0]!.text).toString('base64')}`);
    for (const status of [HEIC_MESSAGE, LONG_EDGE_MESSAGE, 'Tapping unavailable - try another photo',
      'Analysis failed at depth: retry the photo.', 'Analysis timed out at encode', 'GIF export failed: The loop background is still preparing; try Export again when it is ready.',
      'This project changed while it was opening, so it has stayed open with your latest changes.', 'Camera permission was denied.',
      'Finishing your work before switching', 'Importing…', 'An unexpected recovery sentence.', `${HEIC_MESSAGE} - preparing`]) {
      assert.equal(built.formatStatusLine({ status, timing }), status, 'a previous stage cannot decorate recovery or unrelated work');
    }
    for (const status of ['Ready', 'Ready to tap', 'Warming decoder', 'Analyzing: depth', 'Analyzing: encoder', 'preparing', 'Fetching models 60%', 'Waiting to analyze',
      'Ready - preparing', 'Parallax: tracking face - preparing', 'Parallax: calibrating - preparing']) {
      assert.equal(built.formatStatusLine({ status, timing }), development ? `${status} (warmup: 129 ms)` : status);
      assert.equal(built.formatStatusLine({ status, timing: null }), status);
    }
  });
});

type SwitchSession = {
  snapshot(): { readonly scene: { readonly doc: SceneDocument; readonly plate: Rgb8 | null } | null; readonly status: string };
  projects: ReturnType<typeof createProjectSession>;
  analysis: { dispose(): void };
  attachCanvas(canvas: HTMLCanvasElement): () => void;
  openProject(id: SceneDocument['id']): Promise<boolean>;
  importFile(file: File): Promise<void>;
  setFry(fry: number): void;
  setMotion(patch: Partial<SceneDocument['motion']>): void;
  sampleColor(at: { readonly x: number; readonly y: number }): unknown;
  requestPlateIfNeeded(): Promise<void>;
  cancelProjectSwitch(): boolean;
  projectSwitchState(): { readonly kind: 'idle' } | { readonly kind: 'finishing'; readonly project: SceneDocument['id'] };
  subscribe(listener: (state: ReturnType<SwitchSession['snapshot']>) => void): () => void;
  historyState(): { readonly undoDepth: number; readonly redoDepth: number };
  undo(): void;
};

async function until(check: () => boolean, detail: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(check(), detail);
}
function switchGate() {
  let release = (): void => {}, started = (): void => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  return { wait, release, began, started };
}

/** Keep scene, inference ownership and the HTTP checkpoint path real. Only native
 * image/GL operations and the remote store are replaced at their boundaries. */
async function projectSwitchRig(t: TestContext) {
  const size = { width: 2, height: 2 }, prepared = createProducts();
  const [master, mask, depth] = await Promise.all([
    prepared.admitRgb({ size, data: new Uint8Array(12).fill(96) }),
    prepared.admitPlane({ format: 'u8', size, data: new Uint8Array([255, 0, 0, 0]) }),
    prepared.admitPlane({ format: 'f32', size, data: new Float32Array([.1, .3, .7, .9]) }),
  ]);
  const png = prepared.assets.get(master); assert.ok(png);
  const importAsset = await prepared.admitRgb({ size: { width: 512, height: 512 }, data: new Uint8Array(512 * 512 * 3).fill(96) });
  const importPng = prepared.assets.get(importAsset); assert.ok(importPng);
  const lock: unknown = JSON.parse(await readFile(new URL('../models.lock.json', import.meta.url), 'utf8'));
  const checked = parseLock(lock); assert.ok(checked.ok);
  const id = '00000000-0000-4000-8000-000000000001', otherId = '00000000-0000-4000-8000-000000000002';
  const writer = 'e916dc300000-20261011'; assert.ok(isSceneId(id) && isObjectId(id) && isSceneId(otherId) && isBuildId(writer));
  const color = { L: .5, a: 0, b: 0 };
  const object = newObject({ id, existing: [], produced: { sampling: 'legacy-threshold', provenance: { kind: 'ai', model: checked.value.ops.decode.model,
    selection: { kind: 'taps', points: [{ at: { x: .5, y: .5 }, label: 'include' }], candidate: 0, size: .5 } },
    mask: { asset: mask, format: 'u8', size }, bounds: { x: 0, y: 0, ...size }, depth: null,
    color: { mean: color, clusters: [{ lab: color, weight: .5 }, { lab: color, weight: .5 }] } } });
  const document: SceneDocument = { ...newDocument({ id, title: 'Waiting repair', seed: 1, now: '2026-10-11T08:00:00.000Z', writer, importedOn: 'node',
    frame: { source: { asset: master, mediaType: 'image/png', byteLength: png.byteLength }, master: { asset: master, size },
      original: { name: 'repair.png', mediaType: 'image/png', size } },
    analysis: { colors: [{ lab: color, weight: 1 }], tone: { p01: .2, p05: .2, p50: .5, p95: .8, p99: .8 },
      depth: { model: checked.value.ops.depth.model, map: { asset: depth, size, format: 'f32' }, stats: { p10: .1, median: .5, p90: .9 } }, plate: null, autoSubject: 'done' } }),
    objects: [object], removals: [linkedRemoval(object)] };
  const other = { ...document, id: otherId, title: 'Other project', objects: [], removals: [] };
  const stored = new Map<SceneDocument['id'], { doc: SceneDocument; revision: number }>([[id, { doc: document, revision: 1 }], [otherId, { doc: other, revision: 1 }]]);
  const assets = new Map(prepared.assets), writes: SceneDocument[] = [], requests: SequenceListener[] = [];
  let failSave = false, heavy = false, cancellations = 0;
  let staging: ReturnType<typeof switchGate> | null = null, saving: ReturnType<typeof switchGate> | null = null;
  let decoding: ReturnType<typeof switchGate> | null = null, holdNextDecode = false;
  const pixels = (width: number, height: number) => ({ width, height, colorSpace: 'srgb',
    data: Uint8ClampedArray.from({ length: width * height * 4 }, (_value, i) => i % 4 === 3 ? 255 : 96) });
  const page = Object.assign(new EventTarget(), { setTimeout, clearTimeout, performance, devicePixelRatio: 1, innerWidth: 2, innerHeight: 2 });
  const restoreGlobals: (() => void)[] = [];
  for (const [name, value] of Object.entries({
    window: page, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    Image: class { naturalWidth = 512; naturalHeight = 512; onload: (() => void) | null = null; onerror = null;
      set src(_value: string) { const gate = staging; gate?.started(); void (gate?.wait ?? Promise.resolve()).then(() => this.onload?.()); } removeAttribute() {} },
    OffscreenCanvas: class { readonly width: number; readonly height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { drawImage() {}, clearRect() {}, putImageData() {}, getImageData: (_x: number, _y: number, width: number, height: number) => pixels(width, height) }; }
      async convertToBlob() { return new Blob([new Uint8Array(this.width === 2 ? png : importPng)], { type: 'image/png' }); } },
    createImageBitmap: async (input: Blob | ImageData, options?: ImageBitmapOptions) => {
      if (holdNextDecode && decoding !== null) {
        holdNextDecode = false; decoding.started(); await decoding.wait;
      }
      const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : null;
      const dimensions = input instanceof Blob ? bytes !== null && bytes.length > 24 ? { width: new DataView(bytes.buffer).getUint32(16), height: new DataView(bytes.buffer).getUint32(20) } : size : input;
      return { width: options?.resizeWidth ?? dimensions.width, height: options?.resizeHeight ?? dimensions.height, close() {} };
    },
    document: { createElement() { return { width: 2, height: 2, getContext: () => ({ drawImage() {} }),
      toBlob(done: (blob: Blob) => void) { done(new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' })); } }; } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    restoreGlobals.push(() => { if (previous === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, previous); });
  }
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    if (path === '/api/projects') return Response.json({ projects: [...stored.values()].map(({ doc }) => ({
      id: doc.id, name: doc.title, updatedAt: doc.updatedAt, thumbnail: `/api/projects/${doc.id}/thumbnail`,
    })) });
    const [, project, resource] = /^\/api\/projects\/([^/]+)\/(.+)$/.exec(path) ?? [];
    assert.ok(project && resource && isSceneId(project), `Unexpected project request ${path}`);
    if (method === 'GET' && project === otherId && resource === 'scene' && staging !== null) { staging.started(); await staging.wait; }
    if (method === 'PUT') {
      if (failSave && project === id) return Response.json({ error: 'Save refused.' }, { status: 500 });
      if (resource === 'scene') {
        if (project === id && saving !== null) { saving.started(); await saving.wait; }
        assert.equal(typeof init?.body, 'string');
        if (typeof init?.body !== 'string') throw new Error('Expected scene JSON');
        const saved = deserializeCompositionScene(JSON.parse(init.body));
        const previous = stored.get(project);
        if (previous !== undefined && saved.revision <= previous.revision) return Response.json({ error: 'The project revision is stale.' }, { status: 409 });
        stored.set(project, { doc: saved.document, revision: saved.revision }); writes.push(saved.document);
      } else if (resource.startsWith('assets/')) {
        const asset = resource.slice(7); assert.ok(isAssetId(asset) && init?.body instanceof Blob);
        assets.set(asset, new Uint8Array(await init.body.arrayBuffer()));
      }
      return Response.json({ ok: true });
    }
    if (resource === 'scene') { const saved = stored.get(project); assert.ok(saved); return Response.json(serializeCompositionScene(saved.doc, saved.revision)); }
    if (resource.startsWith('assets/')) { const asset = resource.slice(7); assert.ok(isAssetId(asset)); const bytes = assets.get(asset); assert.ok(bytes); return new Response(new Uint8Array(bytes)); }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const compiled = await bundle({ stdin: { contents: "export { createDemoSession } from './src/session/scene.ts'; export { injectAnalysisService } from './src/session/driver.ts';",
    resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, format: 'esm', platform: 'node', write: false,
    define: { NOISY_DEV: 'false', NOISY_BUILD_ID: JSON.stringify(writer), NOISY_MODEL_LOCK: JSON.stringify(lock) },
    plugins: [{ name: 'native-renderer-boundary', setup(build) { build.onLoad({ filter: /\/render\/renderer\.ts$/ }, () => ({ loader: 'ts',
      contents: `export function createRenderer() { return { setScene() {}, setCompare() {}, renderStill() {}, preparePhotoRack() { return { ok: true, value: Object.freeze({ handle: Symbol('photo-rack') }) }; }, activatePhotoRack() {}, setPaintPlanes() { return { kind: 'accepted' }; }, capturePaintDepth() { return { kind: 'refused', reason: 'No native depth.' }; }, renderFrame() {}, endPerspective() {}, dispose() {}, sampleColor() { return { kind: 'refused', reason: 'No native sample.' }; }, async exportStill() { return new Blob([new Uint8Array(${JSON.stringify([...png])})], {type:'image/png'}); } }; }` })); } }],
  });
  const directory = await mkdtemp(join(tmpdir(), 'noisy-project-switch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'session.mjs'); await writeFile(entry, compiled.outputFiles[0]!.text);
  const built = await import(pathToFileURL(entry).href) as {
    createDemoSession(): SwitchSession; injectAnalysisService: typeof injectAnalysisService;
  };
  built.injectAnalysisService(() => ({ backend: { kind: 'device' }, routing: { depth: 'device', encoder: 'device', taps: 'device', plate: 'device' }, remoteTimings: {},
    fetchModels: async () => ({ ok: true, value: undefined }), cancelHeavy() { heavy = false; cancellations++; }, releaseImport() {},
    get alive() { return { heavy, decoder: false }; }, lastHeavyTermination: null,
    runSequence(_scene, stages, _input, on) { if (stages[0].kind === 'inpaint') requests.push(on); heavy = true; on.onPhase(stages[0].kind, 'session', 0); },
    openDecoder() { throw new Error('Unexpected decoder request.'); }, openFaceTracker() { throw new Error('Unexpected tracker request.'); },
  }));
  const session = built.createDemoSession();
  const canvas = Object.assign(new EventTarget(), { style: { transform: '' }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 2, height: 2 }) });
  const detach = session.attachCanvas(canvas as unknown as HTMLCanvasElement);
  const transitions: Promise<boolean>[] = [];
  t.after(async () => {
    staging?.release(); saving?.release(); decoding?.release(); session.cancelProjectSwitch?.(); session.projects.suspend(); detach(); session.analysis.dispose(); await Promise.allSettled(transitions);
    // Drain detached checkpoint work before restoring its HTTP/native boundaries.
    const deadline = performance.now() + 5_000;
    while (session.projects.retention().some(root => root.kind === 'active') && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    await flush(); for (const restore of restoreGlobals) restore();
  });
  assert.equal(await session.openProject(id), true, session.snapshot().status);
  const read = () => { const scene = session.snapshot().scene; assert.ok(scene); return scene; };
  session.setFry(.73); session.setMotion({ enabled: true });
  const deadline = performance.now() + 5_000;
  while (requests.length === 0 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(requests.length, 1); assert.equal(plateNeeded(read().doc), true);
  return { session, document, other, read, stored, writes, requests, page, cancellations: () => cancellations,
    failSave() { failSave = true; },
    holdStaging() { staging = switchGate(); return staging; },
    holdSave() { saving = switchGate(); return saving; },
    holdDecoding() { decoding = switchGate(); holdNextDecode = true; return decoding; },
    reopen() { const pending = session.openProject(document.id); transitions.push(pending); return pending; },
    finishRepair() { heavy = false; requests.at(-1)!.onPlate({ size, data: new Uint8Array(12).fill(144) }); requests.at(-1)!.onDone(); },
    failRepair() { heavy = false; requests.at(-1)!.onFailed('inpaint', { kind: 'worker', op: 'inpaint', message: 'Repair refused.' }); },
    switch(kind: 'import' | 'open') { const pending = kind === 'open' ? session.openProject(other.id) : session.importFile(new File([new Uint8Array(importPng)], 'new.png', { type: 'image/png' })).then(() => read().doc.id !== id);
      transitions.push(pending); return pending; },
  };
}

test('same-project reopen keeps newer edits, history and save revisions made while its candidate decodes', async (t) => {
  const r = await projectSwitchRig(t), ready = r.session.requestPlateIfNeeded(); r.finishRepair(); await ready;
  assert.equal((await r.session.projects.flushCurrent()).kind, 'saved');
  const initial = r.stored.get(r.document.id); assert.ok(initial);
  const beforeCancel = r.cancellations(), oldParallax = initial.doc.motion.parallax, decoding = r.holdDecoding(), reopened = r.reopen();
  await decoding.began;
  r.session.setMotion({ parallax: 3 });
  assert.notEqual(oldParallax, 3);
  assert.equal(r.read().doc.motion.parallax, 3);
  const history = r.session.historyState(); assert.ok(history.undoDepth > 0);
  await until(() => r.requests.length === 2, 'the edit during candidate decoding requests its exact repair');
  decoding.release();
  await until(() => r.session.projectSwitchState().kind === 'finishing', 'same-project reopen drains the newer repair');
  assert.equal(r.read().doc.id, r.document.id); assert.equal(r.session.projects.snapshot().current, r.document.id);
  r.finishRepair(); const accepted = await reopened;
  const saved = r.stored.get(r.document.id); assert.ok(saved);
  assert.ok(saved.revision > initial.revision, 'the final drain durably saves a newer revision than the decoded candidate');
  assert.equal(saved.doc.motion.parallax, 3); assert.equal(plateNeeded(saved.doc), false);
  assert.equal(r.read().doc.motion.parallax, 3, 'the older candidate cannot replace the newer document');
  assert.equal(accepted, false, 'reopening refuses the stale same-project candidate');
  assert.equal(r.session.snapshot().status, 'This project changed while it was opening, so it has stayed open with your latest changes.');
  assert.deepEqual(r.session.historyState(), history, 'refusal keeps the current Undo and Redo history');
  assert.equal(r.cancellations(), beforeCancel, 'refusal never starts a replacement import');
  assert.deepEqual(r.session.projectSwitchState(), { kind: 'idle' });
  r.session.undo(); assert.equal(r.read().doc.motion.parallax, oldParallax, 'Undo still reaches the edit made during decoding');
  assert.equal(r.session.historyState().undoDepth, history.undoDepth - 1);
  assert.equal(r.session.historyState().redoDepth, history.redoDepth + 1);
  assert.equal((await r.session.projects.flushCurrent()).kind, 'saved');
  const undone = r.stored.get(r.document.id); assert.ok(undone);
  assert.equal(undone.doc.motion.parallax, oldParallax); assert.equal(undone.revision, saved.revision + 1);
  r.session.setFry(.89);
  assert.equal((await r.session.projects.flushCurrent()).kind, 'saved');
  const edited = r.stored.get(r.document.id); assert.ok(edited);
  assert.equal(edited.doc.style.fry, .89); assert.equal(edited.revision, undone.revision + 1);
  assert.equal(r.session.projects.snapshot().state, 'saved', 'later saves avoid the store\'s HTTP 409 stale-revision refusal');
});

for (const kind of ['import', 'open'] as const) {
  test(`project ${kind} switch saves the held repair before replacing the current scene`, async (t) => {
    const r = await projectSwitchRig(t), beforeCancel = r.cancellations();
    const switched = r.switch(kind);
    await until(() => r.session.snapshot().status === 'Finishing your work before switching' || r.read().doc.id !== r.document.id, 'the switch reaches its preparation boundary');
    assert.equal(r.read().doc.id, r.document.id, 'the old scene stays attached while its required repair is held');
    assert.equal(r.session.projects.snapshot().current, r.document.id);
    assert.equal(r.session.snapshot().status, 'Finishing your work before switching');
    assert.equal(r.cancellations(), beforeCancel, 'switching does not cancel the current repair');
    r.session.sampleColor({ x: .5, y: .5 });
    assert.equal(r.session.snapshot().status, 'Finishing your work before switching', 'direct status updates cannot hide the wait');
    r.session.setFry(.81); r.finishRepair();
    assert.equal(await switched, true, r.session.snapshot().status);
    const saved = r.stored.get(r.document.id); assert.ok(saved);
    assert.equal(saved.doc.style.fry, .81); assert.equal(saved.doc.motion.enabled, true);
    assert.notEqual(saved.doc.analysis.plate, null); assert.equal(plateNeeded(saved.doc), false);
    assert.equal(r.writes.at(-1)?.id, r.document.id, 'the complete old checkpoint reaches the store before replacement');
    assert.equal(await r.session.openProject(r.document.id), true, r.session.snapshot().status);
    assert.equal(r.read().doc.style.fry, .81); assert.equal(r.read().doc.motion.enabled, true);
    assert.equal(plateNeeded(r.read().doc), false); assert.notEqual(r.read().plate, null);
    assert.equal(r.requests.length, 1, 'reopening uses the saved exact repair without repeating inference');
  });
  test(`project ${kind} switch can be cancelled while repair continues on the current scene`, async (t) => {
    const r = await projectSwitchRig(t), beforeCancel = r.cancellations();
    // The UI's existing Escape listener may prevent default before the session's.
    r.page.addEventListener('keydown', event => event.preventDefault());
    const switched = r.switch(kind); await flush();
    assert.deepEqual(r.session.projectSwitchState(), { kind: 'finishing', project: r.document.id });
    if (kind === 'open') {
      r.page.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
    } else assert.equal(r.session.cancelProjectSwitch(), true);
    assert.equal(await switched, false);
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.session.projects.snapshot().current, r.document.id);
    assert.equal(r.session.snapshot().status, 'Switch cancelled.'); assert.deepEqual(r.session.projectSwitchState(), { kind: 'idle' });
    assert.equal(r.cancellations(), beforeCancel, 'cancelling the switch leaves repair inference running');
    assert.equal(r.session.cancelProjectSwitch(), false);
    const ready = r.session.requestPlateIfNeeded(); r.finishRepair(); await ready;
    assert.equal((await r.session.projects.flushCurrent()).kind, 'saved');
    assert.equal(r.stored.get(r.document.id)?.doc.style.fry, .73);
    assert.equal(await r.session.openProject(r.document.id), true, r.session.snapshot().status);
    assert.equal(r.read().doc.style.fry, .73); assert.notEqual(r.read().plate, null);
  });
  test(`project ${kind} switch refuses a failed repair and keeps the edited scene attached`, async (t) => {
    const r = await projectSwitchRig(t), switched = r.switch(kind); await flush(); r.failRepair();
    assert.equal(await switched, false);
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.read().doc.style.fry, .73);
    assert.equal(r.session.projects.snapshot().current, r.document.id);
    assert.equal(r.session.snapshot().status, 'The background repair could not finish, so this project is still open.');
    assert.equal(r.session.projects.waitingForPreparation(), true);
    assert.deepEqual(r.session.projectSwitchState(), { kind: 'idle' }); assert.equal(r.writes.length, 0);
  });
  test(`project ${kind} switch refuses a failed save and retains the ready unsaved checkpoint`, async (t) => {
    const r = await projectSwitchRig(t); r.failSave();
    const switched = r.switch(kind); await flush(); r.finishRepair();
    assert.equal(await switched, false);
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.read().doc.style.fry, .73); assert.notEqual(r.read().plate, null);
    assert.equal(r.session.projects.snapshot().current, r.document.id); assert.equal(r.session.projects.snapshot().state, 'failed');
    assert.equal(r.session.snapshot().status, 'Your changes could not be saved, so this project is still open.');
    assert.ok(r.session.projects.retention().some(root => root.kind === 'pending' && root.complete));
    assert.equal(r.stored.get(r.document.id)?.doc.motion.enabled, false);
    assert.deepEqual(r.session.projectSwitchState(), { kind: 'idle' });
  });
  test(`project ${kind} switch checks edits made while its candidate is staging`, async (t) => {
    const r = await projectSwitchRig(t), ready = r.session.requestPlateIfNeeded(); r.finishRepair(); await ready;
    assert.equal((await r.session.projects.flushCurrent()).kind, 'saved');
    const staged = r.holdStaging(), switched = r.switch(kind); await staged.began;
    r.session.setMotion({ parallax: 3 });
    assert.equal(r.read().doc.motion.parallax, 3, r.session.snapshot().status);
    await until(() => r.requests.length === 2, 'the staging edit starts its own repair'); staged.release();
    await until(() => r.session.projectSwitchState().kind === 'finishing', 'the final switch boundary waits for the staging edit');
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.session.projects.snapshot().current, r.document.id);
    r.finishRepair(); assert.equal(await switched, true, r.session.snapshot().status);
    const saved = r.stored.get(r.document.id); assert.ok(saved);
    assert.equal(saved.doc.motion.parallax, 3); assert.equal(plateNeeded(saved.doc), false);
    assert.equal(await r.session.openProject(r.document.id), true, r.session.snapshot().status);
    assert.equal(r.read().doc.motion.parallax, 3); assert.equal(r.requests.length, 2);
  });
  test(`project ${kind} switch saves a newer repair required during the first checkpoint upload`, async (t) => {
    const r = await projectSwitchRig(t), saving = r.holdSave(), switched = r.switch(kind); await flush();
    r.finishRepair(); await saving.began; r.session.setMotion({ parallax: 3 });
    assert.equal(r.read().doc.motion.parallax, 3, r.session.snapshot().status);
    await until(() => r.requests.length === 2, 'the edit during save starts its next repair'); saving.release();
    await flush(); assert.equal(r.read().doc.id, r.document.id);
    assert.equal(r.session.snapshot().status, 'Finishing your work before switching');
    r.finishRepair(); assert.equal(await switched, true, r.session.snapshot().status);
    assert.equal(r.stored.get(r.document.id)?.doc.motion.parallax, 3);
    assert.equal(r.writes.filter(doc => doc.id === r.document.id).length, 2);
  });
  test(`project ${kind} switch can cancel the wait for an active checkpoint upload`, async (t) => {
    const r = await projectSwitchRig(t), saving = r.holdSave(), switched = r.switch(kind); await flush();
    r.finishRepair(); await saving.began;
    assert.equal(r.session.cancelProjectSwitch(), true); assert.equal(await switched, false);
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.session.projects.snapshot().current, r.document.id);
    saving.release(); assert.equal((await r.session.projects.flushCurrent()).kind, 'saved');
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.stored.get(r.document.id)?.doc.style.fry, .73);
  });
  test(`project ${kind} switch notices a ready Undo without waiting for obsolete repair`, async (t) => {
    const r = await projectSwitchRig(t), switched = r.switch(kind); await flush();
    r.session.undo(); assert.equal(plateNeeded(r.read().doc), false);
    assert.equal(await switched, true, r.session.snapshot().status);
    assert.equal(r.stored.get(r.document.id)?.doc.motion.enabled, false);
    assert.equal(r.stored.get(r.document.id)?.doc.style.fry, .73);
    r.failRepair(); await flush();
    assert.notEqual(r.read().doc.id, r.document.id, 'a late obsolete repair failure cannot undo the completed switch');
  });
  test(`project ${kind} switch rechecks a ready checkpoint invalidated by a later listener`, async (t) => {
    const r = await projectSwitchRig(t), switched = r.switch(kind); await flush();
    let edited = false;
    const unsubscribe = r.session.subscribe(state => {
      if (!edited && state.scene?.doc.analysis.plate !== null) { edited = true; r.session.setMotion({ parallax: 3 }); }
    });
    t.after(unsubscribe); r.finishRepair();
    await until(() => r.requests.length === 2, 'the later listener starts the next required repair');
    assert.equal(r.session.snapshot().status, 'Finishing your work before switching');
    assert.equal(r.read().doc.id, r.document.id); assert.equal(r.session.projects.snapshot().current, r.document.id);
    r.finishRepair(); assert.equal(await switched, true, r.session.snapshot().status);
    assert.equal(r.stored.get(r.document.id)?.doc.motion.parallax, 3);
    assert.equal(plateNeeded(r.stored.get(r.document.id)!.doc), false);
  });
}

Object.defineProperty(globalThis, 'NOISY_DEV', { value: false, configurable: true });

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function driverRig(failures: readonly string[] = [], options: {
  readonly fetchModels?: AnalysisService['fetchModels'];
  readonly models?: Parameters<typeof createDriver>[1]['models'];
  readonly serviceUnavailable?: boolean;
  readonly prepareGuide?: Parameters<typeof createDriver>[1]['prepareGuide'];
  readonly commitProducts?: boolean;
  readonly embeddingCache?: EmbeddingCache;
} = {}) {
  const id = '00000000-0000-4000-8000-000000000001';
  const asset = 'a'.repeat(64);
  const model = `depth-anything-v2-small@${'a'.repeat(64)}`;
  const build = '671d30a4605d-20261010';
  if (!isSceneId(id) || !isObjectId(id) || !isAssetId(asset) || !isModelId(model) || !isBuildId(build)) throw new Error('Invalid driver fixture ids.');
  const master = { width: 2, height: 2, colorSpace: 'srgb', data: new Uint8ClampedArray(16) } satisfies ImageData;
  const guide = { size: { width: 2, height: 2 }, data: new Uint8Array(12) };
  const stats = photoStats(master, 1);
  const color = { L: 0.5, a: 0, b: 0 };
  const object = newObject({ id, existing: [], produced: { sampling: 'legacy-threshold', provenance: { kind: 'ai', model,
    selection: { kind: 'taps', points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }], candidate: 0, size: .5 } },
    mask: { asset, format: 'u8', size: guide.size }, bounds: { x: 0, y: 0, ...guide.size }, depth: null,
    color: { mean: color, clusters: [{ lab: color, weight: 0.5 }, { lab: color, weight: 0.5 }] } } });
  let doc = newDocument({ id, title: 'fixture', seed: 1, now: '2026-10-10T18:00:00.000Z', writer: build, importedOn: 'node',
    frame: { source: { asset, mediaType: 'image/png', byteLength: 1 }, master: { asset, size: guide.size },
      original: { name: 'fixture.png', mediaType: 'image/png', size: guide.size } },
    analysis: { ...stats, depth: null, plate: null, autoSubject: 'pending' } });
  const events: string[] = [];
  const sequences: string[][] = [];
  const cancellations: Parameters<AnalysisService['cancelHeavy']>[0][] = [];
  let now = 0, heavy = false, decoderAlive = false, opens = 0, heavyReleases = 0;
  let listener: SequenceListener | null = null;
  let sequenceSignal: AbortSignal | null = null;
  let plateWanted = false, guidePreparations = 0;
  let changed = (): void => {};
  const service: AnalysisService = {
    runSequence(_scene, stages, _input, on, signal) { sequenceSignal = signal; if (stages[0].kind !== 'inpaint') assert.equal(decoderAlive, false); heavy = true; listener = on; sequences.push(stages.map((stage) => stage.kind)); events.push(`sequence.spawn:${stages[0].kind}`); },
    cancelHeavy(reason) { cancellations.push(reason); heavyReleases++; if (heavy) events.push('sequence.cancel'); heavy = false; },
    openDecoder(input) {
      assert.equal(heavy, false, 'sequence terminated before decoder opens');
      assert.equal(decoderAlive, false, 'previous decoder released before another opens');
      decoderAlive = true; const attempt = opens++; events.push('decoder.open');
      const decoder: Decoder = { scene: input.scene,
        async decode() {
          const message = failures[attempt];
          if (message !== undefined) return { ok: false, error: { kind: 'worker', op: 'decode', message } };
          const mask = { format: 'u8', size: guide.size, data: new Uint8Array(4) } satisfies Plane<'u8'>;
          const candidate = { mask, score: 1 };
          return { ok: true, value: { candidates: [candidate, candidate, candidate] } };
        },
        release() { if (decoderAlive) { events.push('decoder.release'); decoderAlive = false; } },
      };
      return decoder;
    },
    fetchModels: options.fetchModels ?? (async () => ({ ok: true, value: undefined })),
    openFaceTracker() { throw new Error('No face tracker in driver fixture.'); },
    get alive() { return { heavy, decoder: decoderAlive }; },
    lastHeavyTermination: null,
  };
  const products = createProducts(), produced: Produce[] = [];
  const diagnostics: (Parameters<Parameters<typeof createDriver>[1]['diag']['log']>[0] & { readonly t: number })[] = [];
  const driver = createDriver({ read: () => ({ doc: { ...doc, objects: plateWanted ? [object] : doc.objects, removals: plateWanted ? [linkedRemoval(object)] : doc.removals, motion: { ...doc.motion, enabled: plateWanted } }, masterPixels: master }),
    products, produce: (product) => {
      produced.push(product);
      if (options.commitProducts && product.kind === 'plate') doc = { ...doc, analysis: { ...doc.analysis, plate: product.plate } };
    }, changed: () => changed() }, {
    clock: { now: () => now }, diag: { events: diagnostics, log: (event) => diagnostics.push({ ...event, t: now }) }, service: options.serviceUnavailable ? null : service, threads: 2,
    prepareGuide: async (pixels) => { guidePreparations++; return options.prepareGuide === undefined ? guide : options.prepareGuide(pixels); }, models: options.models ?? { kind: 'ready', ids: [model], depth: model, encode: model, inpaint: model, count: 1 },
    ...(options.embeddingCache === undefined ? {} : { embeddingCache: options.embeddingCache }),
  });
  return {
    driver, events, sequences, cancellations, master, products, produced,
    document: () => doc,
    sequenceSignal: () => sequenceSignal,
    guidePreparations: () => guidePreparations,
    masterAsset(hex: string) {
      if (!isAssetId(hex)) throw new Error('Invalid master asset.');
      doc = { ...doc, frame: { ...doc.frame, master: { ...doc.frame.master, asset: hex } } };
    },
    liveSubject(withSubject = true) {
      doc = { ...doc, objects: withSubject ? [object] : [], removals: withSubject ? [linkedRemoval(object)] : [], analysis: { ...doc.analysis, depth: { model,
        map: { asset, format: 'f32', size: guide.size }, stats: { p10: .1, median: .5, p90: .9 } } } };
      products.putDepth(asset, { format: 'f32', size: guide.size, data: new Float32Array([0, .2, .8, 1]) });
      products.putMask(asset, { format: 'u8', size: guide.size, data: new Uint8Array([255, 0, 0, 0]) });
    },
    finishLive() { if (listener === null) throw new Error('No live sequence.'); const on = listener; heavy = false; on.onPlate(guide); on.onDone(); },
    staleListener: () => listener,
    heavyReleases: () => heavyReleases,
    onChange(callback: () => void) { changed = callback; },
    advance(ms: number) { now += ms; },
    setParallax(parallax: number) { doc = { ...doc, motion: { ...doc.motion, parallax } }; },
    wantPlate(value: boolean) {
      plateWanted = value;
      if (value) products.putMask(asset, { format: 'u8', size: guide.size, data: new Uint8Array([255, 0, 0, 0]) });
    },
    complete() {
      if (listener === null) throw new Error('No sequence running.');
      const on = listener;
      heavy = false; events.push('sequence.terminate');
      if (sequences.at(-1)?.includes('encode')) on.onEmbeddings({ model, tensors: [
        { name: 'image_embeddings.0', dims: [1, 32, 256, 256], data: new Float32Array(32 * 256 * 256) },
        { name: 'image_embeddings.1', dims: [1, 64, 128, 128], data: new Float32Array(64 * 128 * 128) },
        { name: 'image_embeddings.2', dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64) },
      ] });
      on.onDone();
    },
    finishPlate() { if (listener === null) throw new Error('No plate running.'); heavy = false; plateWanted = false; events.push('sequence.terminate'); listener.onDone(); },
    failPlate() { if (listener === null) throw new Error('No plate running.'); heavy = false; events.push('sequence.terminate'); listener.onFailed('inpaint', { kind: 'worker', op: 'inpaint', message: 'background error' }); },
  };
}

test('every model failure kind has short recovery copy and retains its full detail once', async (t) => {
  const model = `depth-anything-v2-small@${'a'.repeat(64)}`;
  assert.ok(isModelId(model));
  const cases = {
    download: { error: { kind: 'download', model, status: 503 }, sentence: 'Models unavailable: the download stopped; reload to try again.' },
    integrity: { error: { kind: 'integrity', model }, sentence: 'Models unavailable: a model failed its check; reload to fetch it again.' },
    timeout: { error: { kind: 'timeout', op: 'depth', visibleMs: 60_000 }, sentence: 'Models unavailable: loading took too long; reload to try again.' },
    worker: { error: { kind: 'worker', op: 'depth', message: JSON.stringify({ model, cause: 'runtime failed' }) }, sentence: 'Models unavailable: loading failed; reload to try again.' },
    quota: { error: { kind: 'quota' }, sentence: 'Models unavailable: free some device storage, then reload.' },
    cancelled: { error: { kind: 'cancelled' }, sentence: 'Models unavailable: loading was cancelled; reload to try again.' },
  } satisfies { [Kind in AnalysisError['kind']]: { error: Extract<AnalysisError, { kind: Kind }>; sentence: string } };
  const downloads = [
    { error: { kind: 'download', model, status: 'offline' }, sentence: 'Models unavailable: check your connection and reload to download them.' },
    { error: { kind: 'download', model, status: 'stalled' }, sentence: cases.download.sentence },
  ] satisfies { error: AnalysisError; sentence: string }[];
  for (const { error, sentence } of [...Object.values(cases), ...downloads]) {
    await t.test(`${error.kind}${'status' in error ? `:${error.status}` : ''}`, async () => {
      const r = driverRig([], { fetchModels: async () => ({ ok: false, error }) });
      await flush();
      assert.equal(r.driver.snapshot().status, sentence);
      assert.equal(r.driver.snapshot().modelsReady, false);
      assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
      assert.deepEqual(r.events, []);
      const logged = r.driver.diagnostics().events;
      assert.equal(logged.length, 1);
      assert.equal(logged[0]?.event, 'fetch.failed');
      assert.ok(logged[0]?.event === 'fetch.failed');
      assert.equal(logged[0].error, error, 'original detail is retained, including the digest');
    });
  }
});

test('five project opens restore master embeddings without another encoder session', async () => {
  const held = new Map<string, Parameters<EmbeddingCache['put']>[1]>();
  const cache: EmbeddingCache = {
    async get(master, model) { const value = held.get(master); return value?.model === model ? value : null; },
    async put(master, value) { held.set(master, value); },
  };
  const r = driverRig([], { embeddingCache: cache }); await flush();
  const assets = ['1', '2', '3', '4', '5'].map((hex) => hex.repeat(64));
  for (const asset of assets) {
    r.advance(2001); r.masterAsset(asset);
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    assert.deepEqual(r.sequences.at(-1), ['depth', 'encode']);
    r.complete(); await flush();
    assert.equal(r.driver.snapshot().decoderReady, true);
  }
  assert.equal(held.size, 5);
  for (const asset of assets) {
    r.advance(2001); r.masterAsset(asset);
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    assert.deepEqual(r.sequences.at(-1), ['depth'], 'reopening an encoded master never requests encode');
    r.complete(); await flush();
    assert.equal(r.driver.snapshot().decoderReady, true, 'cached embeddings still warm the decoder');
  }
  assert.equal(r.sequences.filter((stages) => stages.includes('encode')).length, 5);
  r.driver.beginImport();
});

test('stalled embedding persistence does not gate decoder readiness or later photos', async () => {
  const write = Promise.withResolvers<void>();
  let writes = 0;
  const cache: EmbeddingCache = {
    async get() { return null; },
    put() { writes++; return write.promise; },
  };
  const r = driverRig([], { embeddingCache: cache });
  try {
    await flush();
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    r.complete(); await flush();
    assert.equal(writes, 1, 'persistence started but is still pending');
    assert.equal(r.driver.snapshot().decoderReady, true, 'completed inference warms before the optional write settles');
    assert.equal(r.driver.snapshot().status, 'Ready to tap');
    r.advance(2001);
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    r.complete(); await flush();
    assert.equal(writes, 2);
    assert.equal(r.driver.snapshot().decoderReady, true, 'another photo can complete with persistence pending');
  } finally {
    r.driver.beginImport();
    write.resolve(); await flush();
  }
  assert.equal(r.driver.snapshot().decoderReady, false, 'late write completion cannot restore a replaced decoder');
});

test('an unusable or rejected cache hit re-encodes and warms the reopened photo', async (t) => {
  for (const failure of ['shape', 'type', 'nonfinite', 'detached', 'model', 'rejected']) {
    await t.test(failure, async () => {
      let cached: SamEmbeddings | null = null;
      const cache: EmbeddingCache = {
        async get() {
          if (failure === 'rejected' && cached !== null) throw new Error('Cache Storage read failed');
          return cached;
        },
        async put(_master, value) { cached = value; },
      };
      const r = driverRig([], { embeddingCache: cache });
      try {
        await flush();
        await r.driver.sceneReady(r.driver.beginImport(), r.master);
        r.complete(); await flush();
        assert.equal(r.driver.snapshot().decoderReady, true);
        if (cached === null) assert.fail('No encoded cache fixture.');
        const value: SamEmbeddings = cached;
        switch (failure) {
          case 'shape': Object.defineProperty(value.tensors[0], 'dims', { value: [1, 64, 128, 256] }); break;
          case 'type': Object.defineProperty(value.tensors[0], 'data', { value: new Uint8Array(value.tensors[0].data.length) }); break;
          case 'nonfinite': value.tensors[0].data[0] = Number.NaN; break;
          case 'detached': structuredClone(value.tensors[0].data.buffer, { transfer: [value.tensors[0].data.buffer] }); break;
          case 'model': Object.defineProperty(value, 'model', { value: `sam@${'b'.repeat(64)}` }); break;
        }
        r.advance(2001);
        await r.driver.sceneReady(r.driver.beginImport(), r.master);
        assert.deepEqual(r.sequences.at(-1), ['depth', 'encode'], 'unusable cache contents must not suppress encode');
        r.complete(); await flush();
        assert.equal(r.driver.snapshot().decoderReady, true);
        assert.equal(r.driver.snapshot().status, 'Ready to tap');
      } finally { r.driver.beginImport(); }
    });
  }
});

test('a finite corrupted cache payload makes the opened photo encode again', async () => {
  const master = 'a'.repeat(64), model = `depth-anything-v2-small@${'a'.repeat(64)}`;
  if (!isAssetId(master) || !isModelId(model)) throw new Error('Invalid cache fixture identities.');
  const value: SamEmbeddings = { model, tensors: [
    { name: 'image_embeddings.0', dims: [1, 32, 256, 256], data: new Float32Array(32 * 256 * 256).fill(1) },
    { name: 'image_embeddings.1', dims: [1, 64, 128, 128], data: new Float32Array(64 * 128 * 128).fill(1) },
    { name: 'image_embeddings.2', dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64).fill(1) },
  ] };
  let stored: Uint8Array<ArrayBuffer> | null = null;
  const storage = { async open() { return {
    async match() { return stored === null ? undefined : new Response(stored.slice()); },
    async put(_key: RequestInfo | URL, response: Response) { stored = new Uint8Array(await response.arrayBuffer()); },
  }; } };
  await createEmbeddingCache(storage).put(master, value);
  if (stored === null) assert.fail('The embedding fixture was not persisted.');
  const bytes: Uint8Array<ArrayBuffer> = stored;
  const headerLength = new DataView(bytes.buffer).getUint32(0, true);
  const tensorStart = Math.ceil((4 + headerLength) / 4) * 4;
  new DataView(bytes.buffer).setFloat32(tensorStart, 1.5, true);
  const r = driverRig([], { embeddingCache: createEmbeddingCache(storage) });
  try {
    await flush();
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    assert.deepEqual(r.sequences.at(-1), ['depth', 'encode'], 'corruption is a miss, so the real driver requests a fresh encoding');
    r.complete(); await flush();
    assert.equal(r.driver.snapshot().decoderReady, true);
  } finally { r.driver.beginImport(); }
});

test('throwing or rejected optional persistence leaves the completed photo ready', async (t) => {
  for (const failure of ['throw', 'reject'] as const) {
    await t.test(failure, async () => {
      const cache: EmbeddingCache = {
        async get() { return null; },
        put() {
          if (failure === 'throw') throw new Error('optional storage threw');
          return Promise.reject(new Error('optional storage rejected'));
        },
      };
      const r = driverRig([], { embeddingCache: cache });
      try {
        await flush();
        await r.driver.sceneReady(r.driver.beginImport(), r.master);
        assert.doesNotThrow(() => r.complete());
        await flush();
        assert.equal(r.driver.snapshot().decoderReady, true);
        assert.equal(r.driver.snapshot().status, 'Ready to tap');
      } finally { r.driver.beginImport(); }
    });
  }
});

test('a decoder deadline retries warmup once on a replacement', async () => {
  const timeout = { kind: 'timeout', op: 'decode', visibleMs: 30_000 } satisfies AnalysisError;
  const diagnostics: unknown[] = [];
  let opens = 0, releases = 0, heavyReleases = 0, ready = false;
  const id = '00000000-0000-4000-8000-000000000001';
  if (!isSceneId(id)) throw new Error('Invalid decoder fixture id.');
  const mask = { format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array([255]) } satisfies Plane<'u8'>;
  const candidate = { mask, score: 1 };
  const result = await warmDecoder({
    open() {
      const attempt = opens++;
      return { scene: id, async decode() {
        return attempt === 0 ? { ok: false, error: timeout }
          : { ok: true, value: { candidates: [candidate, candidate, candidate] } };
      }, release() { releases++; } };
    },
    releaseHeavy: () => { heavyReleases++; }, signal: new AbortController().signal,
    now: () => 0, report: (error) => diagnostics.push(error), onReady: () => { ready = true; },
  });
  assert.deepEqual(result, { kind: 'ready' });
  assert.deepEqual([opens, releases, heavyReleases, ready], [2, 1, 1, true]);
  assert.deepEqual(diagnostics, [timeout]);
});

test('unknown model fetch throws and rejections stay generic and are logged once without serialization', async () => {
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  for (const error of [new Error('private model@digest'), '{"kind":"integrity","model":"private@digest"}', null, undefined, 1n, cyclic]) {
    for (const fetchModels of [() => { throw error; }, async () => { throw error; }]) {
      const r = driverRig([], { fetchModels });
      await flush();
      assert.equal(r.driver.snapshot().status, 'Models unavailable: reload to try loading the models again.');
      assert.equal(r.driver.snapshot().modelsReady, false);
      const logged = r.driver.diagnostics().events;
      assert.equal(logged.length, 1);
      assert.ok(logged[0]?.event === 'fetch.failed');
      assert.equal(logged[0].error, error);
    }
  }
});

test('unavailable model configuration and service use recovery copy and retain details', async () => {
  const message = '{"model":"depth@private-digest","reason":"invalid lock"}';
  for (const options of [{ models: { kind: 'unavailable', message } } satisfies Parameters<typeof driverRig>[1], { serviceUnavailable: true }]) {
    const r = driverRig([], options); await flush();
    assert.equal(r.driver.snapshot().status, 'Models unavailable: reload to try loading the models again.');
    const logged = r.driver.diagnostics().events;
    assert.equal(logged.length, 1);
    assert.ok(logged[0]?.event === 'fetch.failed');
    assert.equal(logged[0].error, 'models' in options ? message : 'service unavailable');
  }
});

test('restoring a Project leaves analysis dormant until a decoder is requested', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true });
  await flush();
  assert.equal(r.guidePreparations(), 0);
  assert.equal(r.driver.guide(), null);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.produced, []);
  const requested = r.driver.requestDecoder();
  assert.equal(r.driver.requestDecoder(), requested, 'concurrent decoder requests share one demand');
  await flush();
  assert.equal(r.guidePreparations(), 1);
  assert.deepEqual(r.events, ['sequence.spawn:encode']);
  r.complete(); await requested;
  assert.deepEqual(r.events, ['sequence.spawn:encode', 'sequence.terminate', 'decoder.open']);
  assert.equal(r.driver.snapshot().decoderReady, true);
  assert.equal(r.guidePreparations(), 1);
  r.driver.dispose();
});

test('a cached v5 restore warms tapping and settles its decoder demand without an analysis sequence', async (t) => {
  let cached: SamEmbeddings | null = null;
  const cache: EmbeddingCache = {
    async get() { return cached; },
    async put(_master, value) { cached = value; },
  };
  const r = driverRig([], { embeddingCache: cache }); t.after(() => r.driver.dispose());
  await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.complete(); await flush();
  assert.ok(cached);
  const sequences = r.sequences.length, produced = [...r.produced];
  await r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true });
  await Promise.all([r.driver.requestDecoder(), r.driver.waitForImport()]);
  assert.equal(r.driver.snapshot().decoderReady, true);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: true });
  assert.equal(r.sequences.length, sequences, 'saved v5 products do not request depth or encoding');
  assert.deepEqual(r.produced, produced, 'cache warming cannot replace saved products');
  assert.equal(r.guidePreparations(), 2, 'each decoder receives the current photo guide');
});

test('a cached photo with complete depth warms even when no heavy stages are needed', async (t) => {
  let cached: SamEmbeddings | null = null;
  const cache: EmbeddingCache = {
    async get() { return cached; },
    async put(_master, value) { cached = value; },
  };
  const r = driverRig([], { embeddingCache: cache }); t.after(() => r.driver.dispose());
  await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.complete(); await flush();
  const generation = r.driver.beginImport(); r.liveSubject(false); r.advance(2001);
  const sequences = r.sequences.length;
  await r.driver.sceneReady(generation, r.master);
  await r.driver.requestDecoder();
  assert.equal(r.sequences.length, sequences, 'a cache hit bypasses the null-stage sequence');
  assert.equal(r.driver.snapshot().decoderReady, true);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: true });
});

test('an invalid or rejected restored cache stays dormant and encodes on decoder demand', async (t) => {
  for (const failure of ['shape', 'rejected']) await t.test(failure, async (t) => {
    let cached: SamEmbeddings | null = null, rejectRead = false;
    const cache: EmbeddingCache = {
      async get() { if (rejectRead) throw new Error('Cache Storage read failed'); return cached; },
      async put(_master, value) { cached = value; },
    };
    const r = driverRig([], { embeddingCache: cache }); t.after(() => r.driver.dispose());
    await flush(); await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush();
    if (cached === null) assert.fail('No encoded cache fixture.');
    const value: SamEmbeddings = cached;
    if (failure === 'shape') Object.defineProperty(value.tensors[0], 'dims', { value: [1, 64, 128, 256] });
    else rejectRead = true;
    r.liveSubject(false); r.advance(2001);
    const produced = [...r.produced], sequences = r.sequences.length, guides = r.guidePreparations();
    await r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true }); await flush();
    assert.equal(r.driver.snapshot().embeddings, false);
    assert.equal(r.driver.snapshot().decoderReady, false);
    assert.equal(r.driver.snapshot().status, 'Ready');
    assert.equal(r.guidePreparations(), guides, 'a restored miss still waits for tapping intent');
    assert.equal(r.sequences.length, sequences);
    await r.driver.waitForImport();
    const requested = r.driver.requestDecoder(); await flush();
    assert.deepEqual(r.sequences.at(-1), ['encode'], 'saved depth and repair products are preserved');
    r.complete(); await requested;
    assert.equal(r.driver.snapshot().decoderReady, true);
    assert.equal(r.driver.snapshot().status, 'Ready to tap');
    assert.deepEqual(r.produced, produced, 'a bad cache read cannot replace saved products');
  });
});

test('decoder demand made during a restored cache read survives a miss or rejected read', async (t) => {
  for (const outcome of ['miss', 'rejected']) await t.test(outcome, async (t) => {
    const read = Promise.withResolvers<SamEmbeddings | null>();
    const r = driverRig([], { embeddingCache: { get: () => read.promise, async put() {} } });
    const pending: Promise<void>[] = [];
    t.after(async () => { read.resolve(null); r.driver.dispose(); await Promise.allSettled(pending); });
    await flush(); r.liveSubject(false);
    const restored = r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true }); pending.push(restored);
    await flush();
    const requested = r.driver.requestDecoder(); pending.push(requested); await flush();
    assert.equal(r.guidePreparations(), 1, 'the tap prepares its guide while the optional read is pending');
    assert.equal(r.sequences.length, 0); assert.equal(r.driver.snapshot().decoderReady, false);
    if (outcome === 'miss') read.resolve(null); else read.reject(new Error('Cache Storage read failed'));
    await restored; await flush();
    assert.deepEqual(r.sequences, [['encode']], 'finishing restore must keep the demand made during its cache read');
    r.complete(); await requested; await r.driver.waitForImport();
    assert.equal(r.driver.snapshot().decoderReady, true);
    assert.equal(r.driver.snapshot().status, 'Ready to tap');
    assert.equal(r.guidePreparations(), 1);
    assert.deepEqual(r.produced, [], 'saved depth and repair products stay authoritative');
    assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: true });
  });
});

test('a restored cache hit can finish warming before an earlier decoder request prepares its guide', async (t) => {
  let cached: SamEmbeddings | null = null, holdRead = false, holdGuide = false;
  const read = Promise.withResolvers<SamEmbeddings | null>(), guideRead = Promise.withResolvers<Rgb8>();
  const guide = { size: { width: 2, height: 2 }, data: new Uint8Array(12) };
  const r = driverRig([], {
    embeddingCache: { get: () => holdRead ? read.promise : Promise.resolve(cached), async put(_master, value) { cached = value; } },
    prepareGuide: async () => { if (holdGuide) { holdGuide = false; return guideRead.promise; } return guide; },
  });
  const pending: Promise<void>[] = [];
  t.after(async () => { read.resolve(null); guideRead.resolve(guide); r.driver.dispose(); await Promise.allSettled(pending); });
  await flush(); await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush();
  assert.ok(cached); r.advance(2001); holdRead = true; holdGuide = true;
  const sequences = r.sequences.length, produced = [...r.produced];
  const restored = r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true }); pending.push(restored);
  await flush();
  const requested = r.driver.requestDecoder(); pending.push(requested); await flush();
  read.resolve(cached); await restored; await flush();
  assert.equal(r.driver.snapshot().decoderReady, true, 'the cache warms while the tap\'s guide is held');
  assert.equal(r.sequences.length, sequences);
  guideRead.resolve(guide); await flush();
  assert.equal(r.sequences.length, sequences, 'a delayed guide must reuse the decoder that became ready in the meantime');
  assert.equal(r.driver.snapshot().embeddings, true, 'a delayed guide cannot discard the ready cached encoder');
  await requested;
  assert.equal(r.driver.snapshot().decoderReady, true);
  assert.equal(r.driver.snapshot().status, 'Ready to tap');
  assert.deepEqual(r.produced, produced);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: true });
});

test('an analysis deadline cancels the reused worker with the timeout reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = driverRig(); t.after(() => r.driver.dispose()); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  const listener = r.staleListener(); assert.ok(listener);
  listener.onPhase('depth', 'session', 0);
  r.advance(60_000); t.mock.timers.tick(60_000); await flush();
  assert.equal(r.driver.snapshot().status, 'Analysis timed out at depth');
  assert.equal(r.cancellations.at(-1), 'timeout', 'MEM2 retires a timed-out worker instead of reusing it');
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
});

test('cached decoder warming cannot outlive its failed or timed-out source attempt', async (t) => {
  for (const terminal of ['failure', 'timeout'] as const) await t.test(terminal, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let cached: SamEmbeddings | null = null;
    const cache: EmbeddingCache = {
      async get() { return cached; },
      async put(_master, value) { cached = value; },
    };
    const r = driverRig([], { embeddingCache: cache }); t.after(() => r.driver.dispose());
    await flush();
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    r.complete(); await flush();
    r.advance(2001);
    await r.driver.sceneReady(r.driver.beginImport(), r.master);
    assert.deepEqual(r.sequences.at(-1), ['depth'], 'cached encoding waits behind current depth');
    const opens = r.events.filter(event => event === 'decoder.open').length;
    const listener = r.staleListener(); assert.ok(listener);
    if (terminal === 'failure') listener.onFailed('depth', { kind: 'worker', op: 'depth', message: 'failed source attempt' });
    else { listener.onPhase('depth', 'session', 0); r.advance(60_000); t.mock.timers.tick(60_000); }
    await flush();
    assert.equal(r.driver.snapshot().decoderReady, false, 'the aborted attempt cannot adopt a decoder');
    assert.equal(r.events.filter(event => event === 'decoder.open').length, opens, 'cancelled source warming never allocates a decoder');
    assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
    assert.match(r.driver.snapshot().status, terminal === 'failure' ? /^Analysis failed at depth:/ : /^Analysis timed out at depth$/);
    r.advance(2001);
    const sequences = r.sequences.length, retry = r.driver.requestDecoder();
    void retry.catch(() => undefined);
    await flush();
    assert.equal(r.sequences.length, sequences + 1, 'a new decoder demand cannot wait on the cancelled warmup');
    r.complete(); await retry;
    assert.equal(r.driver.snapshot().decoderReady, true, 'only the new attempt may warm the decoder');
  });
});

test('committed v5 repair-key changes prepare a resident repair through setters, gestures and history', async (t) => {
  // Scene is a build entry. Exercise its actual owner without leaking build globals
  // into the node source graph; only imaging and inference cross fake boundaries.
  type Session = {
    snapshot(): { scene: { doc: SceneDocument; plate: Rgb8 | null } | null; status: string };
    projects: { load: ReturnType<typeof createProjectSession>['load']; suspend(): void };
    analysis: { dispose(): void };
    products: ReturnType<typeof createProducts>;
    gallery: { canPublish(): PublishReadiness };
    openProject(id: SceneDocument['id']): Promise<boolean>;
    setObjectHidden(id: SceneDocument['objects'][number]['id'], hidden: boolean): void;
    setMotion(patch: Partial<SceneDocument['motion']>): void;
    requestPlateIfNeeded(): Promise<void>;
    beginGesture(start: GestureStart): symbol | null;
    updateGesture(update: GestureUpdate): unknown;
    commitGesture(token: symbol): unknown;
    undo(): void;
    redo(): void;
  };
  const size = { width: 2, height: 2 };
  const pixels = (width: number, height: number) => ({ width, height, colorSpace: 'srgb',
    data: Uint8ClampedArray.from({ length: width * height * 4 }, (_value, i) => i % 4 === 3 ? 255 : 96) });
  const replacements: Record<string, unknown> = {
    window: Object.assign(new EventTarget(), { setTimeout, clearTimeout, performance }),
    OffscreenCanvas: class {
      readonly width: number;
      readonly height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { drawImage() {}, clearRect() {}, getImageData: (_x: number, _y: number, width: number, height: number) => pixels(width, height) }; }
    },
    createImageBitmap: async () => ({ ...size, close() {} }),
    fetch: async () => new Response('', { status: 404 }),
  };
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Object.defineProperty(globalThis, key, previous); });
  }
  const lock: unknown = JSON.parse(await readFile(new URL('../models.lock.json', import.meta.url), 'utf8'));
  const checked = parseLock(lock); assert.ok(checked.ok);
  const compiled = await bundle({ stdin: { contents: "export { createDemoSession } from './src/session/scene.ts'; export { injectAnalysisService } from './src/session/driver.ts';",
    resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, format: 'esm', platform: 'node', write: false,
    define: { NOISY_DEV: 'false', NOISY_BUILD_ID: JSON.stringify('e916dc300000-20261011'), NOISY_MODEL_LOCK: JSON.stringify(lock) } });
  const built = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0]!.text).toString('base64')}`) as {
    createDemoSession(): Session; injectAnalysisService: typeof injectAnalysisService;
  };
  const requests: SequenceListener[] = [];
  let heavy = false, cancellations = 0;
  built.injectAnalysisService(() => ({ backend: { kind: 'device' }, routing: { depth: 'device', encoder: 'device', taps: 'device', plate: 'device' }, remoteTimings: {},
    fetchModels: async () => ({ ok: true, value: undefined }), cancelHeavy() { heavy = false; cancellations++; }, releaseImport() {},
    get alive() { return { heavy, decoder: false }; }, lastHeavyTermination: null,
    runSequence(_scene, stages, _input, on) {
      assert.equal(stages[0].kind, 'inpaint', 'restored assets require no import analysis');
      requests.push(on); heavy = true; on.onPhase('inpaint', 'session', 0);
    },
    openDecoder() { throw new Error('Unexpected decoder request.'); },
    openFaceTracker() { throw new Error('Unexpected tracker request.'); },
  }));
  const prepared = createProducts();
  const [master, mask, depth] = await Promise.all([
    prepared.admitRgb({ size, data: new Uint8Array(12).fill(96) }),
    prepared.admitPlane({ format: 'u8', size, data: new Uint8Array([255, 0, 0, 0]) }),
    prepared.admitPlane({ format: 'f32', size, data: new Float32Array([.1, .3, .7, .9]) }),
  ]);
  const id = '00000000-0000-4000-8000-000000000001'; assert.ok(isSceneId(id) && isObjectId(id));
  const color = { L: .5, a: 0, b: 0 }, model = checked.value.ops.depth.model;
  const object = newObject({ id, existing: [], produced: { sampling: 'legacy-threshold', provenance: { kind: 'ai', model: checked.value.ops.decode.model,
    selection: { kind: 'taps', points: [{ at: { x: .5, y: .5 }, label: 'include' }], candidate: 0, size: .5 } },
    mask: { asset: mask, format: 'u8', size }, bounds: { x: 0, y: 0, ...size }, depth: null,
    color: { mean: color, clusters: [{ lab: color, weight: .5 }, { lab: color, weight: .5 }] } } });
  const writer = 'e916dc300000-20261011'; assert.ok(isBuildId(writer));
  const document: SceneDocument = { ...newDocument({ id, title: 'repair', seed: 1, now: '2026-10-11T08:00:00.000Z', writer, importedOn: 'node',
    frame: { source: { asset: master, mediaType: 'image/png', byteLength: prepared.assets.get(master)!.byteLength }, master: { asset: master, size },
      original: { name: 'repair.png', mediaType: 'image/png', size } },
    analysis: { ...photoStats(pixels(2, 2), 1), depth: { model, map: { asset: depth, size, format: 'f32' }, stats: { p10: .1, median: .5, p90: .9 } }, plate: null, autoSubject: 'done' } }),
    objects: [object], removals: [linkedRemoval(object)] };
  const session = built.createDemoSession();
  t.after(() => { session.analysis.dispose(); session.projects.suspend(); });
  session.projects.load = async () => ({ kind: 'composition', document, assets: new Map(prepared.assets), revision: 1 });
  assert.equal(await session.openProject(document.id), true, session.snapshot().status);
  const read = () => { const scene = session.snapshot().scene; assert.ok(scene); return scene; };
  async function finish(expected: number, metadataReady = false) {
    await flush();
    // Native digest completion drains through the event loop before a superseded
    // worker can be replaced; a missing request still fails at this exact count.
    const deadline = performance.now() + 1000;
    while (requests.length < expected && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(requests.length, expected, 'the committed change starts its required repair without another Motion toggle');
    assert.equal(plateNeeded(read().doc), !metadataReady);
    assert.equal(read().plate, null);
    assert.equal(session.gallery.canPublish().kind, 'ready', 'Publish can await the held background preparation');
    const done = session.requestPlateIfNeeded(), on = requests.at(-1)!;
    heavy = false; on.onPlate({ size, data: new Uint8Array(12).fill(expected * 16) }); on.onDone();
    await done;
    assert.equal(plateNeeded(read().doc), false);
    assert.notEqual(read().plate, null);
    assert.equal(session.products.forScene(read().doc).plate, read().plate);
    assert.equal(renderingPrerequisites(read().doc, session.products.assets).kind, 'ready');
    assert.equal(session.gallery.canPublish().kind, 'ready');
    return read().doc.analysis.plate;
  }
  session.setObjectHidden(object.id, true); await flush();
  assert.equal(requests.length, 1, 'hiding starts a still-purpose repair');
  const still = requests[0]!, beforeCancel = cancellations;
  session.setObjectHidden(object.id, false);
  session.setMotion({ enabled: true }); await finish(2);
  assert.equal(cancellations, beforeCancel + 1, 'obsolete still inference is cancelled before the loop repair starts');
  const readyLoop = read().doc.analysis.plate;
  still.onPlate({ size, data: new Uint8Array(12).fill(255) }); still.onDone(); await flush();
  assert.deepEqual(read().doc.analysis.plate, readyLoop, 'late still completion cannot replace the loop repair');
  session.setMotion({ parallax: 3 }); const prior = await finish(3);
  const token = session.beginGesture({ target: { kind: 'scene' }, operation: 'motion' }); assert.ok(token);
  session.updateGesture({ token, value: { kind: 'motion', patch: { drift: { direction: 'side', amount: .4 } } } });
  assert.equal(requests.length, 3, 'preview does not change committed repair ownership');
  session.commitGesture(token); const latest = await finish(4);
  session.undo(); await flush();
  assert.deepEqual(read().doc.analysis.plate, prior, 'Undo restores exact retained ready pixels');
  assert.equal(requests.length, 4);
  session.redo(); await flush();
  assert.deepEqual(read().doc.analysis.plate, latest);
  assert.equal(requests.length, 4);
  session.setMotion({ loopSeconds: 4 }); await flush();
  assert.equal(requests.length, 4, 'duration does not change the repair key');
  // A physically missing ready raster must be prepared even when metadata/cache exists.
  session.products.retain(new Set(session.products.assets.keys()), new Set(session.products.repairs.keys()));
  session.products.putPlate(master, { size, data: new Uint8Array(12) });
  session.setMotion({ focus: .5 }); await finish(5, true);
});

test('a cancelled saved repair keeps one native hash allocation until draining after its former deadline', async (t) => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true });
  r.wantPlate(true);
  const digest = crypto.subtle.digest.bind(crypto.subtle), descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
  const held: (() => void)[] = [], requests: Promise<void>[] = [];
  Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value(algorithm: AlgorithmIdentifier, bytes: BufferSource): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => { let released = false; held.push(() => {
      if (released) return;
      released = true; void digest(algorithm, bytes).then(resolve, reject);
    }); });
  } });
  const restore = () => { if (descriptor === undefined) Reflect.deleteProperty(crypto.subtle, 'digest'); else Object.defineProperty(crypto.subtle, 'digest', descriptor); };
  t.after(async () => { restore(); for (const release of held) release(); r.driver.dispose(); await Promise.allSettled(requests); });
  const request = () => { const pending = r.driver.requestPlateIfNeeded(); requests.push(pending); void pending.catch(() => undefined); };
  request();
  const stale = r.staleListener(); assert.ok(stale);
  stale.onPhase('inpaint', 'session', 0);
  assert.equal(held.length, 2);
  r.setParallax(3); request(); await flush();
  assert.equal(r.events.filter(event => event === 'sequence.spawn:inpaint').length, 1);
  assert.equal(r.events.at(-1), 'sequence.cancel');
  r.advance(60_001); request();
  await new Promise(resolve => setTimeout(resolve, 10));
  request(); await flush();
  assert.equal(r.driver.snapshot().status, 'preparing', 'a cancelled worker has no inference deadline');
  assert.equal(r.events.filter(event => event === 'sequence.spawn:inpaint').length, 1, 'retry waits for native snapshots owned by the cancelled request');
  assert.equal(held.length, 2, 'a repeated request cannot allocate another union/hole pair during the drain');
  restore(); for (const release of held) release();
  const deadline = performance.now() + 1000;
  while (r.events.filter(event => event === 'sequence.spawn:inpaint').length < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(r.events.filter(event => event === 'sequence.spawn:inpaint').length, 2, 'the current repair begins after the obsolete native work drains');
  assert.notEqual(r.staleListener(), stale);
  assert.equal(held.length, 2);
});

test('disposing cancels model fetch and rejects a pending import without clearing products', async () => {
  let aborted = false;
  const r = driverRig([], { fetchModels: async (_ids, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ ok: false, error: { kind: 'cancelled' } }); }, { once: true });
  }) });
  await flush();
  r.driver.beginImport();
  r.liveSubject();
  const masks = [...r.products.masks], depths = [...r.products.depths];
  const rejected = assert.rejects(r.driver.waitForImport(), /analysis session was closed/);
  r.driver.dispose(); await rejected; await flush();
  assert.equal(aborted, true);
  assert.deepEqual([...r.products.masks], masks);
  assert.deepEqual([...r.products.depths], depths);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
  await assert.rejects(r.driver.requestDecoder(), /analysis session was closed/);
});

test('disposing settles pending heavy, decoder, and import waiters and ignores late completion', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.wantPlate(true);
  const rejected = [r.driver.requestPlateIfNeeded(), r.driver.requestDecoder(), r.driver.waitForImport()].map((pending) => assert.rejects(pending, /analysis session was closed/));
  const stale = r.staleListener();
  r.driver.dispose(); await Promise.all(rejected);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
  assert.ok(r.events.includes('sequence.cancel'));
  stale?.onDone(); await flush();
  assert.equal(r.events.filter((event) => event === 'decoder.open').length, 0);
  assert.equal(r.produced.length, 0);
  r.driver.dispose();
});

test('disposing releases an active decoder without clearing the saved products', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush(); r.liveSubject();
  const masks = [...r.products.masks], depths = [...r.products.depths];
  r.driver.dispose();
  assert.equal(r.events.at(-1), 'decoder.release');
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
  assert.deepEqual([...r.products.masks], masks);
  assert.deepEqual([...r.products.depths], depths);
});

test('a new import retries failed model loading and can recover without duplicate failure logs', async () => {
  let attempts = 0;
  const r = driverRig([], { fetchModels: async () => ++attempts === 1 ? { ok: false, error: { kind: 'quota' } } : { ok: true, value: undefined } });
  await flush(); assert.equal(r.driver.snapshot().modelsReady, false);
  r.driver.beginImport(); await flush();
  assert.equal(attempts, 2);
  assert.equal(r.driver.snapshot().modelsReady, true);
  assert.equal(r.driver.snapshot().status, 'Waiting to analyze');
  assert.equal(r.driver.diagnostics().events.length, 1);
});

test('analysis failures show recovery copy and preserve the exact iPad encoder error in diagnostics', async (t) => {
  const model = `depth-anything-v2-small@${'a'.repeat(64)}`;
  assert.ok(isModelId(model));
  const ipadError = { kind: 'worker', op: 'encode', message: 'the encoder session could not be created: Error: no available backend found. ERR: [wasm] RangeError: Out of memory' } satisfies AnalysisError;
  const cases = [
    { stage: 'encode', error: ipadError, recovery: 'Reload this page to try again.' },
    { stage: 'depth', error: { kind: 'download', model, status: 'offline' }, recovery: 'Check your connection and reopen this photo.' },
    { stage: 'depth', error: { kind: 'download', model, status: 503 }, recovery: 'Reload this page to load the models and try again.' },
    { stage: 'encode', error: { kind: 'integrity', model }, recovery: 'Reload this page to load a fresh copy of the models.' },
    { stage: 'encode', error: { kind: 'quota' }, recovery: 'Free some device storage and reload this page.' },
    { stage: 'depth', error: { kind: 'timeout', op: 'depth', visibleMs: 60_000 }, recovery: 'Reopen this photo to try again.' },
    { stage: 'inpaint', error: { kind: 'cancelled' }, recovery: 'Reopen this photo to try again.' },
  ] satisfies { stage: Stage; error: AnalysisError; recovery: string }[];
  for (const { stage, error, recovery } of cases) {
    await t.test(`${stage}:${error.kind}`, async () => {
      const r = driverRig(); await flush();
      await r.driver.sceneReady(r.driver.beginImport(), r.master);
      const listener = r.staleListener(); assert.ok(listener);
      listener.onFailed(stage, error);
      assert.equal(r.driver.snapshot().status, `Analysis failed at ${stage}: ${recovery}`);
      assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
      const logged = r.driver.diagnostics().events.filter((event) => event.event === 'analysis.failed');
      assert.equal(logged.length, 1);
      assert.equal(logged[0]?.op, stage);
      assert.equal(logged[0]?.error, error, 'the original error stays in diagnostics without serialization');
    });
  }
});

const liveGeometry: PerspectiveGeometry = { aperture: { center: { x: 0, y: 0 }, width: 1, height: .75 }, crop: .04, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 };

test('publication requests a saved repair with Motion off while ordinary editing makes no request', async (t) => {
  const r = driverRig([], { commitProducts: true }); t.after(() => r.driver.dispose()); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true }); r.liveSubject();
  const mask = r.document().objects[0]?.produced.mask; assert.ok(mask);
  const plane = r.products.masks.get(mask.asset); assert.ok(plane);
  // The publication freshness gate compares the persisted removal bytes.
  const { encodeRaster } = await import('../src/core/asset-codec.ts');
  r.products.installEncoded(mask.asset, encodeRaster(plane));
  await r.driver.requestPlateIfNeeded(); assert.deepEqual(r.events, []);
  const pending = r.driver.preparePublicationPlate(new AbortController().signal);
  assert.deepEqual(r.events, ['sequence.spawn:inpaint']); r.finishLive(); await pending;
  assert.equal(r.produced.length, 1); assert.equal(r.document().motion.enabled, false);
  await r.driver.preparePublicationPlate(new AbortController().signal);
  assert.equal(r.events.filter(event => event === 'sequence.spawn:inpaint').length, 1, 'resident matching repair is reused');
});

test('publication cancellation aborts inference, ignores late pixels, and immediate retry retains its demand', async (t) => {
  const r = driverRig(); t.after(() => r.driver.dispose()); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master, { restore: true }); r.liveSubject();
  const controller = new AbortController(), first = r.driver.preparePublicationPlate(controller.signal);
  const rejected = assert.rejects(first, /Publishing was cancelled/), stale = r.staleListener(), signal = r.sequenceSignal();
  controller.abort();
  const retryController = new AbortController(), retry = r.driver.preparePublicationPlate(retryController.signal);
  const retryRejected = assert.rejects(retry, /Publishing was cancelled/);
  await rejected; assert.equal(signal?.aborted, true);
  stale?.onPlate({ size: { width: 2, height: 2 }, data: new Uint8Array(12) }); stale?.onDone();
  const deadline = performance.now() + 1000;
  while (r.events.filter(event => event === 'sequence.spawn:inpaint').length < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(r.events.filter(event => event === 'sequence.spawn:inpaint').length, 2);
  assert.equal(r.produced.length, 0);
  retryController.abort(); await retryRejected;
  await r.driver.requestPlateIfNeeded();
  assert.equal(r.events.filter(event => event === 'sequence.spawn:inpaint').length, 2, 'cancelled publication does not opt editing into preparation');
});

test('live-only preparation leaves saved plate untouched and deduplicates requests', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush(); r.liveSubject();
  const savedAsset = 'f'.repeat(64); assert.ok(isAssetId(savedAsset));
  const saved = { size: { width: 2, height: 2 }, data: new Uint8Array(12).fill(42) };
  r.products.putPlate(savedAsset, saved);
  const first = r.driver.requestLivePlate(liveGeometry), second = r.driver.requestLivePlate(liveGeometry);
  assert.equal(r.driver.livePlate().kind, 'preparing');
  assert.equal(r.events.filter((e) => e === 'sequence.spawn:inpaint').length, 1);
  r.finishLive(); await Promise.all([first, second]);
  assert.equal(r.driver.livePlate().kind, 'ready'); assert.equal(r.produced.length, 0);
  assert.equal(r.products.plates.get(savedAsset), saved);
  await r.driver.requestLivePlate(null); assert.equal(r.products.livePlate, null);
  assert.equal(r.products.plates.get(savedAsset), saved);
});

test('changed live geometry discards the old completion and schedules exactly one replacement', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush(); r.liveSubject();
  const old = r.driver.requestLivePlate(liveGeometry);
  const next = r.driver.requestLivePlate({ ...liveGeometry, crop: .02 });
  r.finishLive(); await flush();
  assert.equal(r.products.livePlate, null);
  assert.equal(r.events.filter((e) => e === 'sequence.spawn:inpaint').length, 2);
  r.finishLive(); await Promise.all([old, next]); assert.equal(r.driver.livePlate().kind, 'ready');
});

test('disable and import invalidate pending live completion and release live products', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush(); r.liveSubject();
  const pending = r.driver.requestLivePlate(liveGeometry);
  const releases = r.heavyReleases();
  await r.driver.requestLivePlate(null); assert.equal(r.heavyReleases(), releases + 1); r.finishLive(); await pending;
  assert.equal(r.products.livePlate, null);
  const importing = r.driver.requestLivePlate(liveGeometry); const stale = r.staleListener();
  const rejected = assert.rejects(importing, /photo was replaced/);
  r.driver.beginImport(); stale?.onPlate({ size: { width: 2, height: 2 }, data: new Uint8Array(12) }); stale?.onDone();
  await rejected; assert.equal(r.products.livePlate, null); assert.equal(r.driver.livePlate().kind, 'off');
});

test('objectless depth needs no plate and disabling live mode does not cancel saved work', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush(); r.liveSubject(false);
  await r.driver.requestLivePlate(liveGeometry); assert.equal(r.driver.livePlate().kind, 'not-needed');
  assert.equal(r.events.filter((e) => e === 'sequence.spawn:inpaint').length, 0);
  r.wantPlate(true); const saved = r.driver.requestPlateIfNeeded(), releases = r.heavyReleases();
  await r.driver.requestLivePlate(null); assert.equal(r.heavyReleases(), releases);
  r.finishPlate(); await saved;
});

test('three imports release before sequence spawn and open only after sequence termination', async () => {
  const r = driverRig(); await flush();
  for (let i = 0; i < 3; i++) {
    r.advance(3000);
    const generation = r.driver.beginImport();
    assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
    await r.driver.sceneReady(generation, r.master);
    r.complete(); await flush();
    assert.equal(r.driver.snapshot().status, 'Ready to tap');
  }
  assert.deepEqual(r.events, ['sequence.spawn:depth', 'sequence.terminate', 'decoder.open',
    'decoder.release', 'sequence.spawn:depth', 'sequence.terminate', 'decoder.open',
    'decoder.release', 'sequence.spawn:depth', 'sequence.terminate', 'decoder.open']);
});

test('non-startup decoder failure is sanitized without a retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = driverRig(['internal path and raw error']); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush();
  assert.equal(r.driver.snapshot().status, 'Tapping unavailable - try another photo');
  t.mock.timers.tick(10_000); await flush();
  assert.equal(r.events.filter((e) => e === 'decoder.open').length, 1);
});

test('abort while a decoder is warming releases it and never reports ready', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  if (!isSceneId(id)) throw new Error('Invalid scene id.');
  const controller = new AbortController();
  let releases = 0;
  const decoder: Decoder = { scene: id,
    decode(_points, signal) { return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, error: { kind: 'cancelled' } }), { once: true })); },
    release() { releases++; },
  };
  const pending = warmDecoder({ open: () => decoder, releaseHeavy: () => assert.fail('abort is not a retry'),
    signal: controller.signal, now: () => 0, report: () => assert.fail('abort is not a failure'), onReady: () => assert.fail('abort is not ready') });
  controller.abort();
  assert.deepEqual(await pending, { kind: 'cancelled' });
  assert.equal(releases, 1);
});

for (const cancelledAt of ['result', 'open', 'decode']) {
  test(`cancelled ${cancelledAt} with a live signal is released without reporting or retrying`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const id = '00000000-0000-4000-8000-000000000001';
    if (!isSceneId(id)) throw new Error('Invalid scene id.');
    let opens = 0, releases = 0;
    const decoder: Decoder = { scene: id,
      async decode() {
        if (cancelledAt === 'decode') throw new DOMException('Out of memory', 'AbortError');
        return { ok: false, error: { kind: 'cancelled' } };
      },
      release() { releases++; },
    };
    const result = await warmDecoder({
      open() { opens++; if (cancelledAt === 'open') throw new DOMException('Out of memory', 'AbortError'); return decoder; },
      releaseHeavy: () => assert.fail('cancellation is not a retry'), signal: new AbortController().signal, now: () => 0,
      report: () => assert.fail('cancellation is not a startup failure'), onReady: () => assert.fail('cancelled startup is not ready'),
    });
    assert.deepEqual(result, { kind: 'cancelled' });
    t.mock.timers.tick(2000); await flush();
    assert.equal(opens, 1);
    assert.equal(releases, cancelledAt === 'open' ? 0 : 1);
  });
}

const wasmStartupFailure = 'the decoder did not start: the decoder session could not be created: Error: Aborted(CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 66 61 75 6c @+0)';
for (const message of ['RangeError: Out of memory', 'no available backend found',
  'the decoder did not start: the decoder session could not be created: Error: no available backend found. ERR: [wasm] RangeError: Out of memory',
  'the decoder session could not be created: TypeError: failed to fetch the wasm binary',
  'the decoder session could not be created: Error: Failed to load model', wasmStartupFailure]) {
  test(`${message} releases heavy work and retries once after 1500 ms`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = driverRig([message]); await flush();
    await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush();
    assert.equal(r.driver.snapshot().status, 'Warming decoder');
    assert.deepEqual(r.events.slice(-2), ['decoder.open', 'decoder.release']);
    assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
    assert.equal(r.heavyReleases(), 2, 'import release and retry release both cancel heavy work');
    t.mock.timers.tick(1499); await flush();
    assert.equal(r.events.filter((e) => e === 'decoder.open').length, 1);
    t.mock.timers.tick(1); await flush();
    assert.equal(r.events.filter((e) => e === 'decoder.open').length, 2);
    assert.equal(r.driver.snapshot().status, 'Ready to tap');
  });
}

for (const failures of [['Out of memory', 'second raw failure'], [wasmStartupFailure, wasmStartupFailure]]) {
  test(`second decoder failure after ${failures[0]} sets reload sentence, releases the worker, and never retries again`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = driverRig(failures); await flush();
    await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush();
    t.mock.timers.tick(1500); await flush();
    assert.equal(r.driver.snapshot().status, 'Tapping needs a reload on this device');
    assert.equal(r.driver.decoder(), null);
    assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
    t.mock.timers.tick(60_000); await flush();
    assert.equal(r.events.filter((e) => e === 'decoder.open').length, 2);
  });
}

test('replacement during retry wait prevents the old decoder from reopening', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = driverRig(['Out of memory']); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master); r.complete(); await flush();
  r.driver.beginImport();
  t.mock.timers.tick(2000); await flush();
  assert.equal(r.events.filter((e) => e === 'decoder.open').length, 1);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
});

test('a queued background sequence finishes before decoder warming begins', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.wantPlate(true); const plate = r.driver.requestPlateIfNeeded();
  r.complete(); await flush();
  assert.equal(r.driver.snapshot().alive.decoder, false);
  assert.equal(r.events.at(-1), 'sequence.spawn:inpaint');
  r.finishPlate(); await flush(); await plate;
  assert.equal(r.events.at(-1), 'decoder.open');
  assert.equal(r.driver.snapshot().status, 'Ready to tap');
});

test('a queued background failure still warms tapping after its worker terminates', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.wantPlate(true); const plate = r.driver.requestPlateIfNeeded();
  const refused = assert.rejects(plate, /Analysis failed at inpaint/);
  r.complete(); await flush(); r.failPlate(); await flush(); await refused;
  assert.equal(r.driver.snapshot().decoderReady, true);
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: true });
  assert.match(r.driver.snapshot().status, /^Analysis failed at inpaint/);
});

test('decoder reload sentence takes precedence when the background also failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = driverRig(['Out of memory', 'no available backend']); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.wantPlate(true); const refused = assert.rejects(r.driver.requestPlateIfNeeded(), /Analysis failed at inpaint/);
  r.complete(); await flush(); r.failPlate(); await flush(); await refused;
  t.mock.timers.tick(1500); await flush();
  assert.equal(r.driver.snapshot().status, 'Tapping needs a reload on this device');
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
});

test('replacement during ready publication releases the adopted decoder without a stale status', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  r.onChange(() => { if (r.driver.snapshot().decoderReady) r.driver.beginImport(); });
  r.complete(); await flush();
  assert.equal(r.events.at(-1), 'decoder.release');
  assert.deepEqual(r.driver.snapshot().alive, { heavy: false, decoder: false });
  assert.equal(r.driver.snapshot().status, 'Waiting to analyze');
});

test('a background request during ready publication keeps the preparing sentence', async () => {
  const r = driverRig(); await flush();
  await r.driver.sceneReady(r.driver.beginImport(), r.master);
  let requested = false, plate = Promise.resolve();
  r.onChange(() => {
    if (r.driver.snapshot().decoderReady && !requested) {
      requested = true; r.wantPlate(true); plate = r.driver.requestPlateIfNeeded();
    }
  });
  r.complete(); await flush();
  assert.equal(r.driver.snapshot().status, 'preparing');
  assert.equal(r.driver.snapshot().alive.heavy, true);
  r.finishPlate(); await flush(); await plate;
  assert.equal(r.driver.snapshot().status, 'Ready to tap');
});

function rig() {
  let state: Policy = initialPolicy();
  return {
    read: () => state,
    send(event: PolicyEvent, now = 0) { const result = transition(state, event, now); state = result.state; return result.effects; },
    start(now = 0) {
      this.send({ kind: 'models-ready' }, now);
      this.send({ kind: 'import' }, now);
      return this.send({ kind: 'scene-ready', generation: state.generation }, now);
    },
  };
}

test('replacement drops every stale stage, product, failure and done callback', () => {
  const r = rig(); r.start();
  const stale = r.read().generation;
  const replacement = r.send({ kind: 'import' }, 300);
  assert.deepEqual(replacement.map((effect) => effect.kind), ['cancel-heavy', 'release-decoder', 'drop-products']);
  const before = r.read();
  for (const event of [
    { kind: 'phase', stage: 'depth', phase: 'session', generation: stale },
    { kind: 'product', stage: 'depth', generation: stale },
    { kind: 'failed', stage: 'encode', reason: 'old failure', generation: stale },
    { kind: 'done', generation: stale, plateNeeded: true },
    { kind: 'scene-ready', generation: stale },
  ] satisfies PolicyEvent[]) {
    assert.deepEqual(r.send(event, 5000), []); assert.equal(r.read(), before);
  }
});

test('an import within two seconds starts at first start plus 2000 ms, with latest scene only', () => {
  const r = rig(); assert.deepEqual(r.start(100).map((e) => e.kind), ['start-import']);
  r.send({ kind: 'import' }, 300);
  assert.deepEqual(r.send({ kind: 'scene-ready', generation: 2 }, 600), []);
  assert.equal(nextWake(r.read()), 2100);
  assert.deepEqual(r.send({ kind: 'tick' }, 2099), []);
  assert.deepEqual(r.send({ kind: 'tick' }, 2100), [{ kind: 'start-import' }]);
  assert.equal(r.read().lastStart, 2100);
});

test('imports present before models are ready and start only after both prerequisites', () => {
  const r = rig(); r.send({ kind: 'import' });
  assert.deepEqual(r.send({ kind: 'scene-ready', generation: 1 }, 30), []);
  assert.equal(nextWake(r.read()), null);
  assert.deepEqual(r.send({ kind: 'models-ready' }, 4000), [{ kind: 'start-import' }]);
  assert.equal(r.read().lastStart, 4000);
});

test('a refused import clears pending work and cannot start later when models become ready', () => {
  const r = rig(); r.send({ kind: 'import' });
  r.send({ kind: 'import-failed', generation: 1 }, 100);
  assert.equal(r.read().pendingImport, false);
  assert.equal(r.read().sceneReady, false);
  assert.deepEqual(r.send({ kind: 'models-ready' }, 5000), []);
  assert.equal(nextWake(r.read()), null);
  r.send({ kind: 'import' }, 6000);
  assert.deepEqual(r.send({ kind: 'scene-ready', generation: 2 }, 6100), [{ kind: 'start-import' }]);
});

for (const [stage, timeout] of [['depth', 60_000], ['encode', 120_000], ['inpaint', 60_000]] satisfies [Stage, number][]) {
  test(`${stage} expires from session phase, cancels once and names the timed-out stage`, () => {
    const r = rig(); r.start();
    if (stage === 'inpaint') {
      r.send({ kind: 'done', generation: 1, plateNeeded: false });
      r.send({ kind: 'plate-request', generation: 1 });
      assert.equal(r.read().sequence, 'plate');
    }
    r.send({ kind: 'phase', generation: 1, stage, phase: 'session' }, 50);
    r.send({ kind: 'phase', generation: 1, stage, phase: 'session' }, 100);
    r.send({ kind: 'phase', generation: 1, stage, phase: 'infer' }, 200);
    assert.equal(nextWake(r.read()), 50 + timeout);
    assert.deepEqual(r.send({ kind: 'tick' }, 49 + timeout), []);
    assert.deepEqual(r.send({ kind: 'tick' }, 50 + timeout), [{ kind: 'cancel-heavy' }, { kind: 'status', text: `Analysis timed out at ${stage}` }]);
    assert.equal(r.read().sequence, 'idle');
    assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: false }, timeout + 100), []);
    assert.deepEqual(r.send({ kind: 'tick' }, timeout + 200), []);
  });
}

test('product delivery clears only its own watchdog, and failure reports the real stage', () => {
  const r = rig(); r.start();
  r.send({ kind: 'phase', generation: 1, stage: 'encode', phase: 'session' }, 100);
  r.send({ kind: 'product', generation: 1, stage: 'depth' }, 150);
  assert.equal(nextWake(r.read()), 120100);
  r.send({ kind: 'product', generation: 1, stage: 'encode' }, 1000);
  assert.equal(nextWake(r.read()), null);
  assert.deepEqual(r.send({ kind: 'failed', generation: 1, stage: 'encode', reason: 'missing bytes' }, 1000), [{ kind: 'cancel-heavy' }, { kind: 'status', text: 'Analysis failed at encode: missing bytes' }]);
});

test('plate requests during import wait for done and coalesce; they never cancel analysis', () => {
  const r = rig(); r.start();
  for (let i = 0; i < 2; i++) assert.deepEqual(r.send({ kind: 'plate-request', generation: 1 }, 100 + i), [{ kind: 'status', text: 'preparing' }]);
  assert.equal(r.read().sequence, 'import');
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: true }, 1000), [{ kind: 'start-plate' }]);
  assert.equal(r.read().sequence, 'plate');
  r.send({ kind: 'plate-request', generation: 1 }, 1001);
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: false }, 2000), []);
  assert.equal(r.read().sequence, 'idle');
});

test('a queued plate is discarded if no longer needed; an obsolete plate reruns for the latest masks', () => {
  const r = rig(); r.start(); r.send({ kind: 'plate-request', generation: 1 });
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: false }), []);
  assert.deepEqual(r.send({ kind: 'plate-request', generation: 1 }).map((e) => e.kind), ['status', 'start-plate']);
  assert.deepEqual(r.send({ kind: 'done', generation: 1, plateNeeded: true }), [{ kind: 'start-plate' }]);
});

test('a failed plate waits for an explicit new request before retrying', () => {
  const r = rig(); r.start(); r.send({ kind: 'done', generation: 1, plateNeeded: false });
  r.send({ kind: 'plate-request', generation: 1 });
  r.send({ kind: 'failed', generation: 1, stage: 'inpaint', reason: 'runtime failed' }, 100);
  assert.deepEqual(r.send({ kind: 'tick' }, 5000), []);
  assert.deepEqual(r.send({ kind: 'plate-request', generation: 1 }, 6000).map((e) => e.kind), ['status', 'start-plate']);
});

test('product ids hash actual view bytes and replacement clears every raster map', async () => {
  const backing = new Uint8Array([9, 1, 2, 3, 9]);
  const id = await productAsset(backing.subarray(1, 4));
  assert.equal(id, await productAsset(new Uint8Array([1, 2, 3])));
  assert.notEqual(id, await productAsset(backing));
  const p = createProducts();
  p.putDepth(id, { format: 'f32', size: { width: 1, height: 1 }, data: new Float32Array([0.5]) });
  p.putMask(id, { format: 'u8', size: { width: 1, height: 1 }, data: new Uint8Array([255]) });
  p.putPlate(id, { size: { width: 1, height: 1 }, data: new Uint8Array([1, 2, 3]) });
  const next = await productAsset(new Uint8Array([4, 5, 6]));
  p.putPlate(next, { size: { width: 1, height: 1 }, data: new Uint8Array([4, 5, 6]) });
  assert.equal(p.plates.size, 1); assert.equal(p.plates.has(id), false); assert.equal(p.plates.has(next), true);
  p.clear(); assert.deepEqual([p.depths.size, p.masks.size, p.plates.size], [0, 0, 0]);
});
