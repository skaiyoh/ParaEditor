import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPolicy, nextWake, transition, type Policy, type PolicyEvent, type Stage } from '../src/session/policy.ts';
import { createProducts, productAsset } from '../src/session/products.ts';
import { createDriver, warmDecoder } from '../src/session/driver.ts';
import type { AnalysisError, AnalysisService, Decoder, SequenceListener } from '../src/analysis/service.ts';
import { isAssetId, isBuildId, isModelId, isObjectId, isSceneId } from '../src/core/ids.ts';
import { newDocument, newObject } from '../src/core/defaults.ts';
import { photoStats } from '../src/photo/stats.ts';
import type { Plane } from '../src/core/raster.ts';
import type { Produce } from '../src/core/edits.ts';
import type { PerspectiveGeometry } from '../src/core/perspective.ts';

Object.defineProperty(globalThis, 'NOISY_DEV', { value: false, configurable: true });

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function driverRig(failures: readonly string[] = [], options: {
  readonly fetchModels?: AnalysisService['fetchModels'];
  readonly models?: Parameters<typeof createDriver>[1]['models'];
  readonly serviceUnavailable?: boolean;
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
  const object = newObject({ id, existing: [], produced: { model,
    selection: { kind: 'taps', points: [{ at: { x: 0.5, y: 0.5 }, label: 'include' }], candidate: 0 },
    mask: { asset, format: 'u8', size: guide.size }, bounds: { x: 0, y: 0, ...guide.size }, depth: null,
    color: { mean: color, clusters: [{ lab: color, weight: 0.5 }, { lab: color, weight: 0.5 }] } } });
  let doc = newDocument({ id, title: 'fixture', seed: 1, now: '2026-10-10T18:00:00.000Z', writer: build, importedOn: 'node',
    frame: { source: { asset, mediaType: 'image/png', byteLength: 1 }, master: { asset, size: guide.size },
      original: { name: 'fixture.png', mediaType: 'image/png', size: guide.size } },
    analysis: { ...stats, depth: null, plate: null, autoSubject: 'pending' } });
  const events: string[] = [];
  let now = 0, heavy = false, decoderAlive = false, opens = 0, heavyReleases = 0;
  let listener: SequenceListener | null = null;
  let plateWanted = false;
  let changed = (): void => {};
  const service: AnalysisService = {
    runSequence(_scene, stages, _input, on) { if (stages[0].kind !== 'inpaint') assert.equal(decoderAlive, false); heavy = true; listener = on; events.push(`sequence.spawn:${stages[0].kind}`); },
    cancelHeavy() { heavyReleases++; if (heavy) events.push('sequence.cancel'); heavy = false; },
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
  const driver = createDriver({ read: () => ({ doc: { ...doc, objects: plateWanted ? [object] : doc.objects, motion: { ...doc.motion, enabled: plateWanted } }, masterPixels: master }),
    products, produce: (product) => produced.push(product), changed: () => changed() }, {
    clock: { now: () => now }, diag: { events: diagnostics, log: (event) => diagnostics.push({ ...event, t: now }) }, service: options.serviceUnavailable ? null : service, threads: 2,
    prepareGuide: async () => guide, models: options.models ?? { kind: 'ready', ids: [model], depth: model, inpaint: model, count: 1 },
  });
  return {
    driver, events, master, products, produced,
    liveSubject(withSubject = true) {
      doc = { ...doc, objects: withSubject ? [object] : [], analysis: { ...doc.analysis, depth: { model,
        map: { asset, format: 'f32', size: guide.size }, stats: { p10: .1, median: .5, p90: .9 } } } };
      products.putDepth(asset, { format: 'f32', size: guide.size, data: new Float32Array([0, .2, .8, 1]) });
      products.putMask(asset, { format: 'u8', size: guide.size, data: new Uint8Array([255, 0, 0, 0]) });
    },
    finishLive() { if (listener === null) throw new Error('No live sequence.'); const on = listener; heavy = false; on.onPlate(guide); on.onDone(); },
    staleListener: () => listener,
    heavyReleases: () => heavyReleases,
    onChange(callback: () => void) { changed = callback; },
    advance(ms: number) { now += ms; },
    wantPlate(value: boolean) { plateWanted = value; },
    complete() {
      if (listener === null) throw new Error('No sequence running.');
      const on = listener;
      heavy = false; events.push('sequence.terminate');
      on.onEmbeddings({ model, tensors: [
        { name: 'image_embeddings.0', dims: [1, 32, 256, 256], data: new Float32Array(0) },
        { name: 'image_embeddings.1', dims: [1, 64, 128, 128], data: new Float32Array(0) },
        { name: 'image_embeddings.2', dims: [1, 256, 64, 64], data: new Float32Array(0) },
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

const liveGeometry: PerspectiveGeometry = { aperture: { center: { x: 0, y: 0 }, width: 1, height: .75 }, crop: .04, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 };

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
