import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { build as bundle } from 'esbuild';
import { createProducts } from '../src/session/products.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import type { injectAnalysisService, AnalysisDriver } from '../src/session/driver.ts';
import type { createProjectSession } from '../src/session/projects.ts';
import type { Decoder, DecodeResult } from '../src/analysis/service.ts';
import type { Edit } from '../src/core/edits.ts';
import { applyEdits } from '../src/core/reduce.ts';
import { applyProduce } from '../src/core/produce.ts';
import { remixNodeGroups } from '../src/core/remix.ts';
import { mathRefKey } from '../src/core/math-definition.ts';
import { location, unwrapMath } from '../src/core/math-expression.ts';
import { serializeRemixDocument, withDerivedGrainStyle, type MathCheckpoint } from '../src/core/remix-schema.ts';
import type { SceneDocument } from '../src/core/types.ts';
import { parseDocument } from '../src/core/schema.ts';
import { createMathRemixSession, type MathRemixSession } from '../src/session/math-remix.ts';
import { createAuthoring, EMPTY_AUTHORING_HISTORY, isRecipeEntry, pushAuthoringHistory, recordAuthoringEdit,
  recordAuthoringSelection, restoreRecipe, stepAuthoringHistory, type AuthoringHistory, type RecipeState } from '../src/session/authoring.ts';
import { remixDocument, recipeState } from '../src/session/authoring.ts';
import type { PreparedPhotoRack, PhotoRackRenderer } from '../src/render/types.ts';
import type { MathPhotoRack } from '../src/render/math-program.ts';
import { minimalDocument, DEPTH_MODEL } from './fixtures/documents.ts';


const NOW = '2026-10-11T12:00:00.000Z';
const VALID = 'fn custom(n: coverage) -> coverage { return coverage(value(n) * value(n)); }';
const THRESHOLD = 'fn custom(n: coverage) -> coverage { return coverage(step(0.4, value(n))); }';
// The scene is compiled with its build constants; importing its type directly
// would make the node test project depend on build-env.d.ts.
type ObjectSession = {
  readonly remix: MathRemixSession; readonly analysis: AnalysisDriver; readonly projects: ReturnType<typeof createProjectSession>;
  snapshot(): { readonly scene: { readonly doc: SceneDocument } | null; readonly status: string };
  attachCanvas(canvas: HTMLCanvasElement): () => void;
  openProject(id: SceneDocument['id']): Promise<boolean>;
  tap(at: { readonly x: number; readonly y: number }): Promise<void>;
  beginRefinement(id: SceneDocument['objects'][number]['id']): boolean;
  moveRefinement(travel: number): void;
  commitRefinement(): Promise<void>;
  requestPlateIfNeeded(): Promise<void>;
};
function rig(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let document: SceneDocument | null = minimalDocument(), generation = 1;
  let history: AuthoringHistory = EMPTY_AUTHORING_HISTORY;
  let active: MathPhotoRack | null = null, failNext = false;
  let pending: { handle: PreparedPhotoRack; rack: MathPhotoRack } | null = null;
  let acknowledged: MathCheckpoint | null = null, saving: 'absent' | 'saving' | 'saved' | 'failed' = 'absent';
  const checkpoints: SceneDocument[] = [], preparations: MathPhotoRack[] = [];
  // Node has no WebGL context. Only GPU preparation is a port; all source,
  // graph, numerical proofs, GLSL generation, history and wire readers are real.
  const renderer: PhotoRackRenderer = {
    preparePhotoRack(rack) {
      preparations.push(rack); pending = null;
      if (failNext) { failNext = false; return { ok: false, error: { kind: 'context', ...location('gpu'), message: 'Second program failed to compile.' } }; }
      const handle = { handle: Symbol('prepared') }; pending = { handle, rack }; return { ok: true, value: handle };
    },
    activatePhotoRack(handle) {
      if (handle === null) { active = null; pending = null; return; }
      assert.equal(handle.handle, pending?.handle.handle); active = pending?.rack ?? null; pending = null;
    },
  };
  const remix = createMathRemixSession({ read: () => document, generation: () => generation, renderer: () => renderer,
    interrupt() {}, changed() {},
    preflight(doc, before) {
      if (before) assert.ok(restoreRecipe(doc, before).ok);
      return { kind: 'unchanged' };
    },
    install(doc) { document = doc; checkpoints.push(doc); if (saving !== 'absent' && saving !== 'failed') saving = 'saving'; },
    record(before, after) {
      assert.ok(document);
      history = pushAuthoringHistory(history, { kind: 'remix', key: null, at: performance.now(), before, after }, document);
    },
    saving: () => ({ state: saving, acknowledged }),
    async retrySave() { saving = 'saved'; acknowledged = remix.snapshot().document?.remix.checkpoint ?? null; return { kind: 'applied' }; },
  });
  function doc() { assert.ok(document); return document; }
  function recipe() { const value = remix.snapshot().document; assert.ok(value); return value; }
  function legacy(edit: Edit) {
    remix.finishEditing();
    const result = recordAuthoringEdit({ doc: doc(), history, edit, key: null, now: NOW, at: performance.now() });
    if (result.kind === 'applied') { history = result.history; document = result.doc; assert.ok(remix.synchronize(document).ok); }
    return result;
  }
  function step(direction: 'undo' | 'redo') {
    remix.finishEditing(); remix.invalidate();
    const step = stepAuthoringHistory(history, direction); assert.ok(step);
    if (step.kind === 'remix') document = unwrapMath(restoreRecipe(doc(), step.recipe, NOW));
    else if (step.kind === 'document') { const result = applyEdits(doc(), step.edits, NOW); assert.notEqual(result.kind, 'refused'); document = result.doc; }
    history = step.history; assert.ok(remix.synchronize(doc()).ok);
  }
  return { remix, renderer, preparations, checkpoints, recipe, doc, legacy, step,
    history: () => history, active: () => active,
    failCompile() { failNext = true; },
    replace(next: SceneDocument | null) { generation++; document = next; remix.reset(); history = EMPTY_AUTHORING_HISTORY; },
    updateAnalysis() { const result = applyProduce(doc(), { kind: 'auto-subject', found: null }, NOW); assert.equal(result.kind, 'applied'); document = result.doc; },
    saveState(state: typeof saving, checkpoint: MathCheckpoint | null = acknowledged) { saving = state; acknowledged = checkpoint; },
  };
}

test('unmounted legacy synchronization permits repairs while v6 still requires GPU admission', t => {
  const r = rig(t);
  assert.equal(r.doc().version, 5);
  assert.deepEqual(r.remix.synchronize(r.doc(), null), { ok: true, value: undefined });
  const recipe = withDerivedGrainStyle(unwrapMath(remixDocument(r.doc())));
  const result = r.remix.synchronize(recipe, null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.message, 'The photo renderer is unavailable.');
  assert.deepEqual(r.checkpoints, [], 'synchronization alone never installs a document');
});

/** Exercise the scene's actual object/history boundary. Node replaces only
 * native image/GL operations, inference and HTTP storage, as driver tests do. */
async function objectScene(t: TestContext) {
  const size = { width: 2, height: 2 }, prepared = createProducts();
  const master = await prepared.admitRgb({ size, data: new Uint8Array(12).fill(96) });
  const depth = await prepared.admitPlane({ format: 'f32', size, data: new Float32Array([.1, .3, .7, .9]) });
  const png = prepared.assets.get(master); assert.ok(png);
  const fixture = minimalDocument();
  const doc = compositionDocumentSchema.parse({ ...fixture, frame: {
    source: { asset: master, mediaType: 'image/png', byteLength: png.byteLength }, master: { asset: master, size },
    original: { name: 'objects.png', mediaType: 'image/png', size } },
    analysis: { ...fixture.analysis, autoSubject: 'done', depth: { model: DEPTH_MODEL,
      map: { asset: depth, format: 'f32', size }, stats: { p10: .1, median: .5, p90: .9 } } } });
  const pixels = (width: number, height: number) => ({ width, height, colorSpace: 'srgb',
    data: Uint8ClampedArray.from({ length: width * height * 4 }, (_value, index) => index % 4 === 3 ? 255 : 96) });
  const context = { drawImage() {}, clearRect() {}, putImageData() {},
    getImageData: (_x: number, _y: number, width: number, height: number) => pixels(width, height) };
  const canvas = () => Object.assign(new EventTarget(), { width: 2, height: 2, style: { transform: '' },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 2, height: 2 }), getContext: () => context,
    toBlob(done: (blob: Blob) => void) { done(new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' })); } });
  const restores: (() => void)[] = [];
  let dispose = async (): Promise<void> => {};
  t.after(async () => { await dispose(); await setImmediate(); for (const restore of restores) restore(); });
  for (const [name, value] of Object.entries({
    window: Object.assign(new EventTarget(), { setTimeout, clearTimeout, performance, devicePixelRatio: 1, innerWidth: 2, innerHeight: 2 }),
    requestAnimationFrame: (): number => 1, cancelAnimationFrame() {}, document: { createElement: canvas },
    OffscreenCanvas: class { readonly width: number; readonly height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; } getContext() { return context; } },
    createImageBitmap: async () => ({ ...size, close() {} }),
    fetch: async () => Response.json({ projects: [], ok: true }),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    restores.push(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const lock: unknown = JSON.parse(await readFile(new URL('../models.lock.json', import.meta.url), 'utf8'));
  const compiled = await bundle({ stdin: { contents: "export { createDemoSession } from './src/session/scene.ts'; export { injectAnalysisService } from './src/session/driver.ts';",
    resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, format: 'esm', platform: 'node', write: false,
    define: { NOISY_DEV: 'false', NOISY_BUILD_ID: JSON.stringify('fceafe0d37a0-20261011'), NOISY_MODEL_LOCK: JSON.stringify(lock) },
    plugins: [{ name: 'native-photo-rack', setup(build) { build.onLoad({ filter: /\/render\/renderer\.ts$/ }, () => ({ loader: 'ts', contents: `
      export function createRenderer() { return {
        setScene() {}, setCompare() {}, renderStill() {}, renderFrame() {}, endPerspective() {}, dispose() {},
        preparePhotoRack() { return { ok: true, value: { handle: Symbol('rack') } }; }, activatePhotoRack() {},
        exportStill: async () => new Blob([new Uint8Array(${JSON.stringify([...png])})], {type:'image/png'})
      }; }` })); } }],
  });
  const built: { createDemoSession(): ObjectSession; injectAnalysisService: typeof injectAnalysisService } =
    await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0]?.text ?? assert.fail()).toString('base64')}`);
  built.injectAnalysisService(() => ({ backend: { kind: 'device' }, routing: { depth: 'device', encoder: 'device', taps: 'device', plate: 'device' },
    remoteTimings: {}, alive: { heavy: false, decoder: false }, lastHeavyTermination: null,
    fetchModels: async () => ({ ok: true, value: undefined }), cancelHeavy() {}, releaseImport() {},
    runSequence(_scene, stages, _input, on) {
      assert.equal(stages[0]?.kind, 'inpaint');
      queueMicrotask(() => { on.onPlate({ size, data: new Uint8Array(12).fill(96) }); on.onDone(); });
    },
    openDecoder() { throw new Error('Use the controlled inference boundary.'); },
    openFaceTracker() { throw new Error('No tracker.'); },
  }));
  const session = built.createDemoSession(), detach = session.attachCanvas(document.createElement('canvas'));
  dispose = async () => {
    session.projects.suspend(); await session.requestPlateIfNeeded(); await setImmediate(); session.analysis.dispose(); detach();
  };
  session.projects.load = async () => ({ kind: 'composition', document: doc, assets: new Map(prepared.assets), revision: 0 });
  assert.equal(await session.openProject(doc.id), true, session.snapshot().status);
  let hold: { wait: Promise<void>; started(): void } | null = null;
  const candidates: DecodeResult = { candidates: [
    { mask: { format: 'u8', size, data: new Uint8Array([255, 0, 0, 0]) }, score: .9 },
    { mask: { format: 'u8', size, data: new Uint8Array([255, 255, 0, 0]) }, score: .8 },
    { mask: { format: 'u8', size, data: new Uint8Array([255, 255, 255, 255]) }, score: .7 },
  ] };
  const signals: AbortSignal[] = [];
  const decoder: Decoder = { scene: doc.id, release() {}, async decode(_points, signal) {
    signals.push(signal); const pending = hold; hold = null; pending?.started(); await pending?.wait;
    return signal.aborted ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: candidates };
  } };
  t.mock.method(session.analysis, 'decoder', () => decoder);
  return { session, signals, holdDecode() {
    let release = (): void => {}, started = (): void => {};
    const wait = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
    hold = { wait, started }; return { release, began };
  } };
}

test('photo snapshot is read-only; full rack operations and failures preserve the active closure', async t => {
  const r = rig(t), before = r.doc();
  assert.equal(r.remix.snapshot().target, 'photo');
  assert.equal(r.doc(), before); assert.equal(before.version, 5);
  const add = await r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 1 } });
  assert.equal(add.kind, 'applied'); assert.equal(r.doc().version, 6);
  assert.equal(r.active()?.passes.length, 2); assert.equal(r.history().undo.length, 1);
  const active = r.active(), document = r.doc(), revision = r.remix.snapshot().appliedRevision;
  r.failCompile();
  const failed = await r.remix.perform({ expected: revision, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .4 } });
  assert.equal(failed.kind, 'refused'); assert.equal(r.doc(), document); assert.equal(r.active(), active);
  assert.equal(r.remix.snapshot().preview, 'last-valid');
  assert.match(r.remix.snapshot().diagnostics[0]?.message ?? '', /Second program/);
  const stale = await r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'remove', at: { kind: 'block', instance: 'photo-grain' } } });
  assert.equal(stale.kind, 'refused'); assert.equal(r.doc(), document);
});

test('newer actions, import, Undo and cancellation invalidate generation-tagged work', async t => {
  const r = rig(t);
  const a = r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .2 } });
  const b = r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .7 } });
  assert.equal((await a).kind, 'cancelled'); assert.equal((await b).kind, 'applied');
  const c = r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .1 } });
  r.step('undo'); assert.equal((await c).kind, 'cancelled');
  const d = r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .1 } });
  r.replace(minimalDocument()); assert.equal((await d).kind, 'cancelled');
  const token = r.remix.beginGesture('photo');
  assert.equal((await r.remix.updateGesture(token, { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .3 })).kind, 'applied');
  r.remix.cancelGesture(token); assert.equal(r.doc().style.grain, minimalDocument().style.grain);
  assert.equal((await r.remix.updateGesture(token, { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .8 })).kind, 'cancelled');
});

test('Undo clears the copy notice and Redo does not replay the transient notice', async t => {
  const r = rig(t), before = r.recipe().remix.instances[0]?.block;
  const result = await r.remix.perform({ expected: 0, target: 'photo', operation: {
    kind: 'replace', at: { kind: 'function', instance: 'photo-grain', node: 'remap' }, replacement: { id: 'grain-threshold', revision: 1 },
  } });
  assert.equal(result.kind, 'applied'); assert.ok(result.copied);
  assert.deepEqual(r.remix.snapshot().copied, result.copied);
  const applied = r.recipe().remix.instances[0]?.block;
  r.step('undo');
  assert.deepEqual(r.recipe().remix.instances[0]?.block, before);
  assert.equal(r.remix.snapshot().copied, null);
  r.step('redo');
  assert.deepEqual(r.recipe().remix.instances[0]?.block, applied);
  assert.equal(r.remix.snapshot().copied, null);
});

for (const action of ['undo', 'cancel'] as const) test(`${action} keeps valid source without a last-valid notice until its editor reopens`, async t => {
  const r = rig(t), before = r.recipe().remix.instances[0]?.block;
  const site = { kind: 'function', instance: 'photo-grain', node: 'remap' } as const;
  const edit = unwrapMath(r.remix.beginSourceEdit(site));
  unwrapMath(r.remix.writeSource({ ...edit, expected: r.remix.snapshot().draftRevision, source: VALID }));
  assert.equal(r.remix.snapshot().preview, 'last-valid', 'the checking candidate is not yet running');
  t.mock.timers.tick(400);
  assert.equal(r.remix.snapshot().preview, 'current');
  if (action === 'undo') { await r.remix.commitGesture(edit.gesture); r.step('undo'); }
  else r.remix.cancelGesture(edit.gesture);
  assert.deepEqual(r.recipe().remix.instances[0]?.block, before);
  assert.equal(r.remix.snapshot().copied, null);
  assert.equal(r.remix.snapshot().drafts[0]?.source, VALID);
  assert.equal(r.remix.snapshot().drafts[0]?.phase, 'valid');
  assert.equal(r.remix.snapshot().editing, null);
  assert.equal(r.remix.snapshot().preview, 'current');
  const reopened = unwrapMath(r.remix.beginSourceEdit(site));
  assert.equal(r.remix.snapshot().preview, 'last-valid', 'the reopened candidate differs from the running source');
  r.remix.cancelGesture(reopened.gesture);
  assert.equal(r.remix.snapshot().preview, 'current');
});

test('Edit to Done is one Undo while settled valid sources apply and autosave inside it', async t => {
  const r = rig(t), initial = r.recipe().remix.instances[0]?.block;
  const edit = unwrapMath(r.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  const write = (source: string) => unwrapMath(r.remix.writeSource({ ...edit, expected: r.remix.snapshot().draftRevision, source }));
  write(VALID); t.mock.timers.tick(399); assert.equal(r.remix.snapshot().appliedRevision, 0);
  t.mock.timers.tick(1);
  const first = r.recipe(); assert.equal(first.remix.checkpoint.appliedRevision, 1); assert.equal(r.history().undo.length, 0);
  assert.ok(r.checkpoints.some(doc => doc.version === 6 && doc.remix.functions.some(fn => fn.source === VALID)));
  write(THRESHOLD); t.mock.timers.tick(400);
  assert.equal(r.history().undo.length, 0); assert.equal(r.remix.snapshot().preview, 'current');
  assert.equal((await r.remix.commitGesture(edit.gesture)).kind, 'applied'); assert.equal(r.history().undo.length, 1);
  const applied = r.recipe().remix.instances[0]?.block; assert.notDeepEqual(applied, initial);
  r.step('undo'); assert.deepEqual(r.recipe().remix.instances[0]?.block, initial);
  assert.equal(r.remix.snapshot().preview, 'current');
  r.step('redo'); assert.deepEqual(r.recipe().remix.instances[0]?.block, applied);
  assert.equal(r.remix.snapshot().preview, 'current');
});

test('invalid drafts checkpoint and reopen without entering the executable closure, then recover', async t => {
  const r = rig(t), edit = unwrapMath(r.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  unwrapMath(r.remix.writeSource({ ...edit, expected: r.remix.snapshot().draftRevision, source: 'fn broken(' }));
  t.mock.timers.tick(400); await r.remix.commitGesture(edit.gesture);
  assert.equal(r.remix.snapshot().preview, 'last-valid'); assert.equal(r.remix.snapshot().appliedRevision, 0);
  assert.equal(r.history().undo.length, 0);
  const serialized = serializeRemixDocument(r.recipe()), reopened = parseDocument(JSON.parse(JSON.stringify(serialized)));
  assert.ok(reopened.ok); r.replace(reopened.value);
  assert.equal(r.remix.snapshot().drafts[0]?.source, 'fn broken('); assert.equal(r.remix.snapshot().drafts[0]?.phase, 'invalid');
  assert.ok(!r.recipe().remix.functions.some(fn => fn.source === 'fn broken('));
  const correction = unwrapMath(r.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  unwrapMath(r.remix.writeSource({ ...correction, expected: r.remix.snapshot().draftRevision, source: VALID }));
  await r.remix.commitGesture(correction.gesture);
  assert.equal(r.remix.snapshot().preview, 'current'); assert.equal(r.history().undo.length, 1);
});

test('a GPU-refused source retains last-valid pixels and persists only its diagnostic draft', async t => {
  const r = rig(t), edit = unwrapMath(r.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  const active = r.active(); r.failCompile();
  unwrapMath(r.remix.writeSource({ ...edit, expected: r.remix.snapshot().draftRevision, source: VALID }));
  t.mock.timers.tick(400);
  assert.equal(r.active(), active); assert.equal(r.remix.snapshot().appliedRevision, 0);
  assert.equal(r.remix.snapshot().drafts[0]?.phase, 'invalid');
  assert.match(r.remix.snapshot().drafts[0]?.diagnostics[0]?.message ?? '', /Second program/);
  assert.ok(!r.recipe().remix.functions.some(fn => fn.source === VALID));
});

test('source interleaving closes its history boundary before legacy edits and analysis can arrive during idle', async t => {
  const r = rig(t), edit = unwrapMath(r.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  unwrapMath(r.remix.writeSource({ ...edit, expected: r.remix.snapshot().draftRevision, source: VALID }));
  r.updateAnalysis(); t.mock.timers.tick(400);
  assert.equal(r.remix.snapshot().preview, 'current');
  assert.equal(r.legacy({ kind: 'style', patch: { saturation: .6 } }).kind, 'applied');
  assert.equal(r.history().undo.length, 2); assert.ok(isRecipeEntry(r.history().undo[0] ?? assert.fail()));
  assert.equal((await r.remix.commitGesture(edit.gesture)).kind, 'cancelled');
  const applied = r.recipe().remix.instances[0]?.block;
  r.step('undo'); assert.equal(r.doc().style.saturation, minimalDocument().style.saturation);
  assert.deepEqual(r.recipe().remix.instances[0]?.block, applied);
  r.step('undo'); assert.deepEqual(r.recipe().remix.instances[0]?.block, { id: 'authored-grain', revision: 1 });
  assert.equal(r.doc().analysis.autoSubject, 'done');
});

test('scene tap and refinement settle source before their candidates, so revision 3 never drops to 2', async t => {
  const { session } = await objectScene(t), remix = session.remix;
  for (const value of [.1, .2]) assert.equal((await remix.perform({ expected: remix.snapshot().appliedRevision,
    target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value } })).kind, 'applied');
  assert.equal(remix.snapshot().appliedRevision, 2);
  const editing = unwrapMath(remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  unwrapMath(remix.writeSource({ ...editing, expected: remix.snapshot().draftRevision, source: VALID }));
  await session.tap({ x: .25, y: .25 });
  assert.equal(remix.snapshot().appliedRevision, 3, session.snapshot().status);
  assert.equal(remix.snapshot().editing, null);
  assert.equal(remix.snapshot().drafts.find(value => value.id === editing.draft)?.phase, 'valid');
  assert.ok(remix.snapshot().functions.some(value => value.source === VALID));
  const object = session.snapshot().scene?.doc.objects[0]; assert.ok(object);
  const next = unwrapMath(remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  unwrapMath(remix.writeSource({ ...next, expected: remix.snapshot().draftRevision, source: THRESHOLD }));
  assert.equal(session.beginRefinement(object.id), true);
  await setImmediate(); session.moveRefinement(160); await session.commitRefinement();
  assert.equal(remix.snapshot().appliedRevision, 4, session.snapshot().status);
  assert.equal(remix.snapshot().drafts.find(value => value.id === next.draft)?.phase, 'valid');
  assert.equal(remix.snapshot().editing, null);
});

test('beginning source editing aborts a pending scene tap before it can publish', async t => {
  const { session, signals, holdDecode } = await objectScene(t), held = holdDecode();
  const pending = session.tap({ x: .25, y: .25 }); await held.began;
  const edit = unwrapMath(session.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  assert.equal(signals.at(-1)?.aborted, true); held.release(); await pending;
  assert.equal(session.snapshot().scene?.doc.objects.length, 0);
  unwrapMath(session.remix.writeSource({ ...edit, expected: session.remix.snapshot().draftRevision, source: VALID }));
  await session.remix.commitGesture(edit.gesture);
  assert.equal(session.remix.snapshot().appliedRevision, 1);
  assert.equal(session.snapshot().scene?.doc.objects.length, 0);
});

test('functions fork/package/borrow/insert/rename through the same reducers and one action boundaries', async t => {
  const r = rig(t);
  const fork = unwrapMath(await r.remix.forkFunction({ from: { id: 'grain-threshold', revision: 1 }, name: 'My threshold' }));
  const block = unwrapMath(await r.remix.forkBlock({ from: { id: 'authored-grain', revision: 1 }, name: 'My grain' }));
  assert.ok(r.recipe().remix.functions.some(value => mathRefKey(value) === mathRefKey(fork)));
  assert.equal((await r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'add', block, index: 1 } })).kind, 'applied');
  const instance = r.recipe().remix.instances[1]; assert.ok(instance);
  assert.equal((await r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'rename', instance: instance.id, name: 'Renamed grain' } })).kind, 'applied');
  const packaged = unwrapMath(await r.remix.packageBlock({ instance: 'photo-grain', name: 'Packaged grain' }));
  assert.deepEqual(r.recipe().remix.instances[0]?.block, packaged);
  await r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: {
    kind: 'replace', at: { kind: 'function', instance: 'photo-grain', node: 'remap' }, replacement: { id: 'grain-curve', revision: 1 } } });
  assert.equal((await r.remix.borrowFunction({ from: instance.block, node: 'remap', into: { kind: 'function', instance: 'photo-grain', node: 'remap' } })).kind, 'applied');
  const created = unwrapMath(r.remix.createFunction({ name: 'Square', source: VALID }));
  assert.ok(r.remix.snapshot().drafts.some(draft => draft.id === created));
  await r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 2 } });
  const contrast = r.recipe().remix.instances[2]; assert.ok(contrast);
  const at = unwrapMath(r.remix.newFunctionAt({ instance: contrast.id, slot: 'after-contrast' }));
  assert.ok(remixNodeGroups(r.recipe().remix.blocks.find(value => mathRefKey(value) === mathRefKey(r.recipe().remix.instances[2]?.block ?? assert.fail())) ?? assert.fail()).some(group => group.id === at.node));
  await r.remix.commitGesture(at.gesture);
  assert.ok(r.history().undo.length >= 8);
  const photo = r.recipe().remix.instances.filter(value => value.target === 'photo');
  const depth = r.history().undo.length;
  assert.equal((await r.remix.useInBrush('photo-grain')).kind, 'applied');
  assert.deepEqual(r.recipe().remix.instances.filter(value => value.target === 'photo'), photo);
  const texture = r.recipe().remix.instances.find(value => value.target === 'brush'); assert.ok(texture);
  assert.equal(r.recipe().remix.blocks.find(value => mathRefKey(value) === mathRefKey(texture.block))?.outputType, 'coverage');
  assert.equal(r.history().undo.length, depth + 1);
});

test('Undo createFunction removes its applied definition and ownership but checkpoints unapplied text', t => {
  const r = rig(t), before = recipeState(r.recipe());
  const draftId = unwrapMath(r.remix.createFunction({ name: 'Undo square', source: VALID }));
  const draft = r.recipe().remix.drafts.find(value => value.id === draftId); assert.ok(draft?.base);
  const created = mathRefKey(draft.base), revisions = r.remix.snapshot();
  const restored = unwrapMath(restoreRecipe(r.doc(), before, NOW)); assert.equal(restored.version, 6);
  if (restored.version !== 6) assert.fail('Expected a v6 restore.');
  assert.ok(!restored.remix.functions.some(value => mathRefKey(value) === created));
  assert.ok(!restored.remix.ownership.some(value => mathRefKey(value.ref) === created));
  assert.equal(restored.remix.drafts.find(value => value.id === draftId)?.base, null);
  assert.equal(restored.remix.drafts.find(value => value.id === draftId)?.source, VALID);
  assert.equal(restored.remix.checkpoint.draftRevision, revisions.draftRevision + 1);
  r.step('undo');
  const reopened = parseDocument(JSON.parse(JSON.stringify(serializeRemixDocument(r.recipe())))); assert.ok(reopened.ok);
  r.replace(reopened.value);
  assert.equal(r.remix.snapshot().preview, 'current');
  t.mock.timers.tick(1000);
  assert.ok(!r.recipe().remix.functions.some(value => mathRefKey(value) === created));
  assert.ok(!r.recipe().remix.ownership.some(value => mathRefKey(value.ref) === created));
});

test('one Undo of newFunctionAt removes the inserted node, function and ownership', async t => {
  const r = rig(t);
  await r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'add', block: { id: 'authored-contrast', revision: 1 }, index: 1 } });
  const instance = r.recipe().remix.instances[1]; assert.ok(instance);
  const before = recipeState(r.recipe()), depth = r.history().undo.length;
  const inserted = unwrapMath(r.remix.newFunctionAt({ instance: instance.id, slot: 'after-contrast' }));
  const draft = r.recipe().remix.drafts.find(value => value.id === inserted.draft); assert.ok(draft?.base);
  const created = mathRefKey(draft.base);
  await r.remix.commitGesture(inserted.gesture);
  assert.equal(r.history().undo.length, depth + 1);
  const restored = unwrapMath(restoreRecipe(r.doc(), before, NOW)); assert.equal(restored.version, 6);
  if (restored.version !== 6) assert.fail('Expected a v6 restore.');
  assert.ok(!restored.remix.functions.some(value => mathRefKey(value) === created));
  assert.ok(!restored.remix.ownership.some(value => mathRefKey(value.ref) === created));
  r.step('undo');
  assert.deepEqual(r.recipe().remix.instances, before.instances);
  assert.ok(!r.recipe().remix.functions.some(value => mathRefKey(value) === created));
  assert.equal(r.recipe().remix.drafts.find(value => value.id === inserted.draft)?.base, null);
  assert.equal(r.recipe().remix.drafts.find(value => value.id === inserted.draft)?.site, null);
  assert.equal(r.remix.snapshot().preview, 'current');
  r.step('redo');
  assert.ok(r.recipe().remix.functions.some(value => mathRefKey(value) === created));
  assert.ok(r.recipe().remix.ownership.some(value => mathRefKey(value.ref) === created));
});

test('legacy Grain and Fry are atomic, and unavailable bindings give a reason', async t => {
  const r = rig(t);
  await r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .2 } });
  const before = r.doc().style;
  assert.equal(r.legacy({ kind: 'fry', fry: .7 }).kind, 'applied');
  assert.notEqual(r.doc().style.grain, before.grain); assert.notEqual(r.doc().style.colorNoise, before.colorNoise);
  r.step('undo'); assert.deepEqual(r.doc().style, before);
  assert.equal(r.legacy({ kind: 'style', patch: { grain: .8, grainHold: 3 } }).kind, 'applied');
  assert.equal(r.doc().style.grain, .8); assert.equal(r.doc().style.grainHold, 3);
  await r.remix.perform({ expected: r.remix.snapshot().appliedRevision, target: 'photo', operation: { kind: 'remove', at: { kind: 'block', instance: 'photo-grain' } } });
  const current = r.doc();
  const unavailable = r.legacy({ kind: 'fry', fry: .4 }); assert.equal(unavailable.kind, 'refused');
  assert.equal(r.doc(), current); if (unavailable.kind === 'refused') assert.match(unavailable.detail, /Grain/);
});

test('existing synchronous GestureRange gets a remix-parameter value and one Undo per drag', t => {
  const r = rig(t);
  const authoring = createAuthoring({ read: r.doc, record: edit => ({ kind: r.legacy(edit).kind === 'applied' ? 'applied' : 'unchanged' }), changed() {},
    remix: { begin: () => r.remix.beginGesture('photo'), update: (token, value) => r.remix.updateGestureNow(token, {
      kind: 'parameter', instance: value.instance, name: value.name, value: value.value }), commit: r.remix.commitGestureNow, cancel: r.remix.cancelGesture } });
  const token = authoring.beginGesture({ operation: 'remix-parameter', target: { kind: 'scene' } }); assert.ok(token);
  for (const value of [.1, .4, .9]) assert.equal(authoring.updateGesture({ token, value: {
    kind: 'remix-parameter', target: 'photo', instance: 'photo-grain', name: 'amount', value } }).kind, 'applied');
  assert.equal(authoring.commitGesture(token).kind, 'applied'); assert.equal(r.history().undo.length, 1);
  r.step('undo'); assert.equal(r.doc().style.grain, minimalDocument().style.grain);
});

test('Saved requires the newest applied and draft checkpoint; failure and retry retain work', async t => {
  const r = rig(t);
  await r.remix.perform({ expected: 0, target: 'photo', operation: { kind: 'parameter', instance: 'photo-grain', name: 'amount', value: .2 } });
  assert.equal(r.remix.snapshot().status.kind, 'Applied');
  const old = r.recipe().remix.checkpoint; r.saveState('saved', old);
  assert.equal(r.remix.snapshot().status.kind, 'Saved');
  const edit = unwrapMath(r.remix.beginSourceEdit({ kind: 'function', instance: 'photo-grain', node: 'remap' }));
  unwrapMath(r.remix.writeSource({ ...edit, expected: r.remix.snapshot().draftRevision, source: 'bad text' }));
  t.mock.timers.tick(400); await r.remix.commitGesture(edit.gesture);
  r.saveState('saved', old); assert.equal(r.remix.snapshot().status.kind, 'Saving');
  r.saveState('failed'); assert.equal(r.remix.snapshot().status.kind, 'Save failed');
  const draft = r.remix.snapshot().drafts[0]?.source;
  assert.equal((await r.remix.retrySave()).kind, 'applied'); assert.equal(r.remix.snapshot().status.kind, 'Saved');
  assert.equal(r.remix.snapshot().drafts[0]?.source, draft); assert.equal(r.remix.snapshot().preview, 'last-valid');
});

test('ordinary history coalescing and selection boundaries survive an interspersed recipe action', () => {
  const doc = minimalDocument(), before: RecipeState = recipeState(unwrapMath(remixDocument(doc)));
  const first = recordAuthoringEdit({ doc, history: EMPTY_AUTHORING_HISTORY, edit: { kind: 'style', patch: { saturation: .2 } }, key: 'style:saturation', now: NOW, at: 1 });
  const changed = pushAuthoringHistory(first.history, { kind: 'remix', key: null, at: 2, before, after: before }, first.doc);
  const second = recordAuthoringEdit({ doc: first.doc, history: changed, edit: { kind: 'style', patch: { saturation: .5 } }, key: 'style:saturation', now: NOW, at: 3 });
  const third = recordAuthoringEdit({ doc: second.doc, history: second.history, edit: { kind: 'style', patch: { saturation: .7 } }, key: 'style:saturation', now: NOW, at: 4 });
  assert.equal(third.history.undo.length, 3);
  assert.equal(recordAuthoringSelection({ doc: third.doc, history: third.history, before: null, after: null, at: 5 }), third.history);
});

