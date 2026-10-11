import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { z } from '../src/core/zod.ts';
import { isModelId, isSceneId, type NonEmpty, type SceneId, type ModelId } from '../src/core/ids.ts';
import { err, ok } from '../src/core/result.ts';
import type { Rgb8 } from '../src/core/raster.ts';
import type { AnalysisError, DecodeResult, HeavyStage, SamEmbeddings } from '../src/analysis/protocol.ts';
import type { AnalysisService, SequenceInput, SequenceListener } from '../src/analysis/service.ts';
import { createRemoteAnalysisService, REMOTE_TIMEOUTS, type RemoteDeps } from '../src/analysis/remote.ts';
import { createComposedAnalysisService } from '../src/analysis/composed.ts';
import { initialPolicy, transition, type Policy, type PolicyEvent } from '../src/session/policy.ts';
import { createDriver } from '../src/session/driver.ts';
import { createProducts } from '../src/session/products.ts';
import { fiveClusterDocument, minimalDocument } from './fixtures/documents.ts';
import { startServer, tempDir, writeTree } from './support/cli.ts';

function sceneId(value: string): SceneId { if (!isSceneId(value)) throw new Error('Invalid scene id.'); return value; }
function modelId(value: string): ModelId { if (!isModelId(value)) throw new Error('Invalid model id.'); return value; }
const scene = sceneId('00000000-0000-4000-8000-000000000001');
const otherScene = sceneId('00000000-0000-4000-8000-000000000002');
const model = modelId(`encoder@${'0'.repeat(64)}`);
const size = { width: 2, height: 2 };
const guide: Rgb8 = { size, data: new Uint8Array(12) };
const token = (): SamEmbeddings => ({ model, tensors: [
  { name: 'a', dims: [1], data: new Float32Array(1) }, { name: 'b', dims: [1], data: new Float32Array(1) }, { name: 'c', dims: [1], data: new Float32Array(1) },
] });
// Ordinary loopback calls get scheduling headroom while build tests copy ORT.
// Timeout cases override the relevant deadline and still use real HTTP stalls.
const timeouts = { health: 5_000, sessions: 5_000, depth: 5_000, taps: 500, inpaint: 500 };
function device() {
  const fetches: string[][] = [], sequences: string[][] = [], decodes: unknown[] = [], decoderInputs: unknown[] = [];
  let decoderAlive = false;
  const embeddings = token();
  const local: AnalysisService = {
    fetchModels: async (ops) => { fetches.push([...ops]); return ok(undefined); },
    runSequence(_scene, stages, _input, on) {
      sequences.push(stages.map((s) => s.kind));
      for (const stage of stages) {
        on.onPhase(stage.kind, 'session', null); on.onPhase(stage.kind, 'infer', null);
        switch (stage.kind) {
          case 'depth': on.onDepth({ format: 'f32', size, data: new Float32Array(4) }, { p10: 0, median: 0, p90: 0 }); break;
          case 'encode': on.onEmbeddings(embeddings); break;
          case 'inpaint': on.onPlate(guide); break;
          default: { const exhaustive: never = stage; throw new Error(String(exhaustive)); }
        }
      }
      on.onDone();
    },
    cancelHeavy() {},
    openDecoder(input) {
      assert.equal(input.embeddings, embeddings, 'The decoder must receive the actual device embeddings.');
      decoderInputs.push(input); decoderAlive = true;
      let released = false;
      return { scene: input.scene, release() { released = true; decoderAlive = false; }, async decode(points) {
        if (released) return err({ kind: 'cancelled' } satisfies AnalysisError);
        decodes.push(points);
        const candidate = (value: number): DecodeResult['candidates'][number] => ({ score: value / 255, mask: { format: 'u8', size, data: new Uint8Array(4).fill(value) } });
        return ok({ candidates: [candidate(255), candidate(128), candidate(64)] } satisfies DecodeResult);
      } };
    },
    openFaceTracker: () => ({ ready: Promise.resolve(), track: async (frame) => { frame.close(); return null; }, release() {} }),
    get alive() { return { heavy: false, decoder: decoderAlive }; }, lastHeavyTermination: null,
  };
  return { local, fetches, sequences, decodes, decoderInputs, embeddings };
}

type Fault = 'http503' | 'stall' | 'invalid-size' | 'invalid-length' | 'invalid-depth' | 'invalid-scores';
async function loopback() {
  const faults = new Map<string, { kind: Fault; remaining: number }>();
  const requests: { path: string; method: string; body: Buffer; headers: IncomingMessage['headers'] }[] = [];
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  let nextSession = 0;
  const server = createServer(async (req, res) => {
    const path = req.url ?? '', parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    requests.push({ path, method: req.method ?? '', body: Buffer.concat(parts), headers: req.headers });
    const key = req.method === 'DELETE' ? 'delete' : path.endsWith('/taps') ? 'taps' : path.endsWith('/inpaint') ? 'inpaint' : path.endsWith('/depth') ? 'depth' : path === '/v1/health' ? 'health' : 'sessions';
    const fault = faults.get(key);
    const kind = fault !== undefined && fault.remaining-- > 0 ? fault.kind : null;
    if (kind === 'http503') return json(res, 503, { error: 'The GPU is busy.' });
    if (kind === 'stall') { res.writeHead(key === 'sessions' ? 201 : 200, { 'Content-Type': key === 'inpaint' ? 'image/png' : ['sessions', 'health'].includes(key) ? 'application/json' : 'application/octet-stream', 'X-Width': '2', 'X-Height': '2', 'X-Guide-Width': '2', 'X-Guide-Height': '2', 'X-Scores': '0.9,0.8,0.7' }); res.flushHeaders(); return; }
    if (path === '/v1/health') return json(res, 200, { ok: true, gpu: 'Loopback Radeon', models: { depth: 'depth', segment: 'sam', inpaint: 'inpaint' } });
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
    if (path === '/v1/sessions') return json(res, 201, { id: `session-${++nextSession}`, master: size, expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    if (path.endsWith('/depth')) {
      const data = Buffer.alloc(16); [0, 0.25, 0.5, kind === 'invalid-depth' ? NaN : 1].forEach((v, i) => data.writeFloatLE(v, i * 4));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Width': kind === 'invalid-size' ? '3' : '2', 'X-Height': '2' }); return res.end(kind === 'invalid-length' ? data.subarray(0, 12) : data);
    }
    if (path.endsWith('/taps')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Guide-Width': kind === 'invalid-size' ? '3' : '2', 'X-Guide-Height': '2', 'X-Scores': kind === 'invalid-scores' ? ',0.5,no' : '0.8,0.9,0.7' });
      return res.end(Buffer.from(kind === 'invalid-length' ? [1] : [255, 0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0]));
    }
    if (path.endsWith('/inpaint')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from([137, 80, 78, 71])); }
    json(res, 404, { error: 'Unknown session.' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback address.');
  return { base: `http://127.0.0.1:${address.port}`, requests,
    fault(key: string, kind: Fault, remaining = Infinity) { faults.set(key, { kind, remaining }); },
    clear() { faults.clear(); },
    async stop() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
function fixture() {
  let closed = 0;
  const input: SequenceInput = { master: async () => ({ width: 2, height: 2, close() { closed++; } }) };
  return { input, closed: () => closed };
}
function run(service: Pick<AnalysisService, 'runSequence'>, stages: NonEmpty<HeavyStage> = [{ kind: 'depth' }, { kind: 'encode' }], signal = new AbortController().signal, id = scene) {
  const events: string[] = [], embeddings: SamEmbeddings[] = [], errors: AnalysisError[] = [];
  const depths: number[][] = [], plates: Rgb8[] = [];
  const photo = fixture();
  const done = new Promise<void>((resolve) => {
    const on: SequenceListener = {
      onPhase: (stage, phase) => events.push(`${stage}.${phase}`),
      onDepth(map, stats) { depths.push([...map.data]); assert.equal(stats.median, map.data.length === 4 && map.data[1] === 0.25 ? 0.25 : 0); events.push('depth'); },
      onEmbeddings(value) { embeddings.push(value); events.push('embeddings'); },
      onPlate(value) { plates.push(value); events.push('plate'); },
      onDone() { events.push('done'); resolve(); },
      onFailed(stage, error) { errors.push(error); events.push(`failed.${stage}`); resolve(); },
    };
    service.runSequence(id, stages, photo.input, on, signal);
  });
  return { done, events, embeddings, errors, depths, plates, photo };
}
function dependencies(base: string, local: AnalysisService): RemoteDeps & { readonly local: AnalysisService } {
  return { base, local, fetch, encode: async () => new Blob(['JPEG'], { type: 'image/jpeg' }), decode: async () => guide, timeouts, failed() {} };
}
async function waitFor(test: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!test()) { if (Date.now() > end) throw new Error('Timed out waiting for HTTP evidence.'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test('contract timeouts match the binding contract', () => assert.deepEqual(REMOTE_TIMEOUTS, { health: 5000, sessions: 20000, depth: 10000, taps: 5000, inpaint: 30000 }));
test('hybrid callback order, GPU JPEG/depth/plate and actual device embeddings, decoder and face', async () => {
  const http = await loopback(), local = device();
  const service = createComposedAnalysisService({ ...dependencies(http.base, local.local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    assert.deepEqual(await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined), ok(undefined));
    assert.deepEqual(local.fetches, [['encode', 'decode', 'face']]);
    await service.openFaceTracker().ready;
    const imported = run(service); await imported.done;
    assert.deepEqual(imported.errors, []); assert.equal(imported.photo.closed(), 1);
    assert.deepEqual(imported.events, ['depth.session', 'depth.infer', 'depth', 'encode.session', 'encode.infer', 'embeddings', 'done']);
    assert.deepEqual(imported.depths, [[0, 0.25, 0.5, 1]]);
    const upload = http.requests.find((r) => r.path === '/v1/sessions');
    assert.equal(upload?.headers['content-type'], 'image/jpeg'); assert.equal(upload?.headers['x-width'], '2'); assert.equal(upload?.body.toString(), 'JPEG');
    const embeddings = imported.embeddings[0]; assert.ok(embeddings);
    const decoder = service.openDecoder({ scene, embeddings, guide });
    const decoded = await decoder.decode([{ at: { x: 0.25, y: 0.75 }, label: 'include' }, { at: { x: 1, y: 0 }, label: 'exclude' }], new AbortController().signal);
    assert.ok(decoded.ok); if (decoded.ok) { assert.equal(decoded.value.candidates.length, 3); assert.equal(local.decodes.length, 1); }
    assert.equal(http.requests.filter((r) => r.path.endsWith('/taps')).length, 0);
    assert.equal(embeddings, local.embeddings);
    assert.deepEqual(local.sequences, [['encode']]);
    assert.deepEqual(service.routing, { depth: 'gpu', encoder: 'device', taps: 'device', plate: 'gpu' });
    assert.ok((service.remoteTimings.session ?? 0) > 0);
    const plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array([0, 255, 0, 0]) } }]); await plate.done;
    assert.deepEqual(plate.events, ['inpaint.session', 'inpaint.infer', 'plate', 'done']); assert.equal(plate.plates.length, 1);
    assert.equal(http.requests.filter((r) => r.path === '/v1/sessions').length, 1);
    decoder.release(); assert.equal(service.alive.decoder, false);
    service.releaseImport(); await waitFor(() => http.requests.some((r) => r.method === 'DELETE'));
    assert.equal((await decoder.decode([{ at: { x: 0, y: 0 }, label: 'include' }], new AbortController().signal)).ok, false);
  } finally { service.releaseImport(); await http.stop(); }
});

test('two inpaint 503s followed by driver cleanup leave the resident device decoder and GPU plate lease usable', async () => {
  const http = await loopback(), service = createComposedAnalysisService({ ...dependencies(http.base, device().local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    const imported = run(service); await imported.done;
    const embeddings = imported.embeddings[0]; assert.ok(embeddings);
    const decoder = service.openDecoder({ scene, embeddings, guide });
    http.fault('inpaint', 'http503', 2);
    const errors: AnalysisError[] = [];
    await new Promise<void>((resolve) => service.runSequence(scene, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }], fixture().input, {
      onPhase() {}, onDepth() {}, onEmbeddings() {}, onPlate() { assert.fail('A failed plate cannot be published.'); }, onDone() { assert.fail('Both plate attempts must fail.'); },
      onFailed(_stage, error) { errors.push(error); service.cancelHeavy(); resolve(); },
    }, new AbortController().signal));
    assert.equal(errors[0]?.kind, 'worker');
    assert.equal(http.requests.filter((r) => r.path.endsWith('/inpaint')).length, 2);
    assert.equal(service.alive.decoder, true);
    const before = http.requests.length;
    const tap = await decoder.decode([{ at: { x: 0.5, y: 0.5 }, label: 'include' }], new AbortController().signal);
    assert.equal(tap.ok, true);
    assert.equal(http.requests.slice(before).filter((r) => r.path.endsWith('/taps')).length, 0);
    assert.equal(http.requests.filter((r) => r.method === 'DELETE').length, 0);
    const probes = http.requests.filter((r) => r.path === '/v1/health').length;
    const plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }]); await plate.done;
    assert.deepEqual(plate.errors, []);
    assert.equal(http.requests.filter((r) => r.path === '/v1/health').length, probes, 'A plate retry stays on the import backend.');
    service.cancelHeavy();
    decoder.release(); service.releaseImport(); await waitFor(() => http.requests.some((r) => r.method === 'DELETE'));
    assert.equal(service.alive.decoder, false);
    const reopened = run(service); await reopened.done;
    assert.deepEqual(reopened.errors, []);
    assert.equal(http.requests.filter((r) => r.path === '/v1/health').length, probes + 1, 'Reopening the same scene is a new import and must recover health.');
    assert.equal(http.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sessions').length, 2);
  } finally { service.cancelHeavy(); await http.stop(); }
});

test('a GPU plate queued before warming can fail without losing the pending device decoder or plate lease', async () => {
  const bitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const development = Object.getOwnPropertyDescriptor(globalThis, 'NOISY_DEV');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: fixture().input.master });
  Object.defineProperty(globalThis, 'NOISY_DEV', { configurable: true, value: false });
  const http = await loopback();
  const service = createComposedAnalysisService({ ...dependencies(http.base, device().local), gpu: Promise.resolve(http.base), changed() {} });
  const base = minimalDocument(), object = fiveClusterDocument().objects[0]; assert.ok(object);
  const doc = { ...base, id: scene, motion: { ...base.motion, enabled: true }, objects: [{ ...object,
    produced: { ...object.produced, mask: { ...object.produced.mask, size }, bounds: { x: 0, y: 0, ...size } },
  }] };
  const master = { ...size, colorSpace: 'srgb', data: new Uint8ClampedArray(16) } satisfies ImageData;
  const products = createProducts(); products.putMask(object.produced.mask.asset, { format: 'u8', size, data: new Uint8Array(4).fill(255) });
  const driver = createDriver({ read: () => ({ doc, masterPixels: master }), products, produce() {}, changed() {}, windowEnabled: () => true }, {
    clock: { now: () => performance.now() }, diag: { events: [], log() {} }, service, threads: 2, prepareGuide: async () => guide,
    models: { kind: 'ready', ids: [model], depth: model, inpaint: model, count: 1 },
  });
  try {
    await waitFor(() => driver.snapshot().modelsReady);
    http.fault('inpaint', 'http503', 2);
    await driver.sceneReady(driver.beginImport(), master);
    const rejected = assert.rejects(driver.requestPlateIfNeeded(), /Analysis failed at inpaint/);
    await rejected;
    await waitFor(() => driver.snapshot().decoderReady || driver.snapshot().status.startsWith('Tapping unavailable'));
    assert.equal(driver.snapshot().decoderReady, true, JSON.stringify(driver.snapshot()));
    assert.match(driver.snapshot().status, /^Analysis failed at inpaint/);
    assert.equal(http.requests.filter((r) => r.path.endsWith('/inpaint')).length, 2);
    assert.equal(http.requests.filter((r) => r.method === 'DELETE').length, 0);
    const decoder = driver.decoder(); assert.ok(decoder);
    const before = http.requests.filter((r) => r.path.endsWith('/taps')).length;
    assert.equal((await decoder.decode([{ at: { x: 0.5, y: 0.5 }, label: 'include' }], new AbortController().signal)).ok, true);
    assert.equal(http.requests.filter((r) => r.path.endsWith('/taps')).length, before);
    const probes = http.requests.filter((r) => r.path === '/v1/health').length;
    const plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }]); await plate.done;
    assert.deepEqual(plate.errors, []);
    assert.equal(http.requests.filter((r) => r.path === '/v1/health').length, probes, 'The queued plate failure cannot change this import\'s backend selection.');
    assert.equal(http.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sessions').length, 1);
  } finally {
    driver.beginImport(); service.cancelHeavy(); await http.stop();
    if (bitmap === undefined) Reflect.deleteProperty(globalThis, 'createImageBitmap'); else Object.defineProperty(globalThis, 'createImageBitmap', bitmap);
    if (development === undefined) Reflect.deleteProperty(globalThis, 'NOISY_DEV'); else Object.defineProperty(globalThis, 'NOISY_DEV', development);
  }
});

for (const fault of ['http503', 'stall'] satisfies Fault[]) test(`composed ${fault} session creation falls back to the device and the next import re-probes`, async () => {
  const http = await loopback(), local = device();
  const deadlines = { ...timeouts, sessions: 40 };
  const service = createComposedAnalysisService({ ...dependencies(http.base, local.local), timeouts: deadlines, gpu: Promise.resolve(http.base), changed() {} });
  try {
    await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined);
    assert.deepEqual(local.fetches, [['encode', 'decode', 'face']]); http.fault('sessions', fault);
    const start = Date.now(), fallback = run(service); await fallback.done;
    assert.deepEqual(fallback.errors, []); assert.deepEqual(service.backend, { kind: 'device' }); assert.equal(local.sequences.length, 1); assert.ok(Date.now() - start < 10_000);
    http.clear(); deadlines.sessions = timeouts.sessions;
    const recovered = run(service, undefined, undefined, otherScene); await recovered.done;
    assert.deepEqual(recovered.errors, []); assert.deepEqual(service.backend, { kind: 'gpu', name: 'Loopback Radeon' });
    assert.equal(http.requests.filter((r) => r.path === '/v1/health').length, 2);
  } finally { service.cancelHeavy(); await http.stop(); }
});

test('cold device fallback downloads models before publishing any worker phase', async () => {
  const http = await loopback(), deviceService = device();
  let release = () => {}, fetching = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const local: AnalysisService = { ...deviceService.local, async fetchModels(ops, signal, progress) {
    if (ops.includes('depth')) { fetching = true; await held; }
    return deviceService.local.fetchModels(ops, signal, progress);
  } };
  const waiting: string[] = [];
  const service = createComposedAnalysisService({ ...dependencies(http.base, local), gpu: Promise.resolve(http.base), changed() {}, waiting: (stage) => waiting.push(stage) });
  try {
    await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined);
    assert.deepEqual(deviceService.fetches, [['encode', 'decode', 'face']]);
    http.fault('sessions', 'http503');
    const fallback = run(service);
    await waitFor(() => fetching);
    assert.deepEqual(waiting, ['depth']);
    assert.deepEqual(fallback.events, [], 'No session phase may start the depth watchdog while device models are cold.');
    assert.deepEqual(deviceService.sequences, []);
    release(); await fallback.done;
    assert.deepEqual(fallback.events, ['depth.session', 'depth.infer', 'depth', 'encode.session', 'encode.infer', 'embeddings', 'done']);
    assert.deepEqual(fallback.errors, []);
  } finally { release(); service.cancelHeavy(); await http.stop(); }
});

test('cold fallback outlasting the remote depth watchdog gets a full local worker deadline', async () => {
  const http = await loopback(), deviceService = device();
  let release = () => {}, fetching = false, now = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const local: AnalysisService = { ...deviceService.local, async fetchModels(ops, signal, progress) {
    if (ops.includes('depth')) { fetching = true; await held; }
    return deviceService.local.fetchModels(ops, signal, progress);
  } };
  const service = createComposedAnalysisService({ ...dependencies(http.base, local), gpu: Promise.resolve(http.base), timeouts: { ...timeouts, sessions: 40 }, changed() {} });
  let policy: Policy = initialPolicy();
  const controller = new AbortController(), statuses: string[] = [], deadlines: number[] = [];
  const dispatch = (event: PolicyEvent): void => {
    const next = transition(policy, event, now); policy = next.state;
    for (const effect of next.effects) {
      if (effect.kind === 'cancel-heavy') { controller.abort(); service.cancelHeavy(); }
      if (effect.kind === 'status') statuses.push(effect.text);
    }
  };
  try {
    await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], controller.signal, () => undefined);
    // Use the real policy with elapsed visible time, without waiting a minute.
    policy = transition(policy, { kind: 'import' }, now).state;
    dispatch({ kind: 'models-ready' }); dispatch({ kind: 'scene-ready', generation: policy.generation });
    http.fault('sessions', 'stall');
    const done = new Promise<void>((resolve) => service.runSequence(scene, [{ kind: 'depth' }, { kind: 'encode' }], fixture().input, {
      onPhase(stage, phase) {
        dispatch({ kind: 'phase', generation: policy.generation, stage, phase });
        if (stage === 'depth' && phase === 'session') deadlines.push((policy.deadline?.at ?? -1) - now);
      },
      onDepth() { dispatch({ kind: 'product', generation: policy.generation, stage: 'depth' }); },
      onEmbeddings() { dispatch({ kind: 'product', generation: policy.generation, stage: 'encode' }); }, onPlate() {},
      onDone() { dispatch({ kind: 'done', generation: policy.generation, plateNeeded: false }); resolve(); },
      onFailed(_stage, error) { assert.fail(JSON.stringify(error)); },
    }, controller.signal));
    await waitFor(() => fetching);
    now = 65_000; dispatch({ kind: 'tick' });
    assert.equal(controller.signal.aborted, false);
    assert.equal(policy.deadline, null);
    assert.deepEqual(deviceService.sequences, []);
    release(); await done;
    assert.deepEqual(deadlines, [60_000]);
    assert.ok(!statuses.some((status) => status.includes('timed out')));
    assert.deepEqual(deviceService.sequences, [['depth', 'encode']]);
  } finally { release(); service.cancelHeavy(); await http.stop(); }
});

test('failed boot probe uses local models, re-probes per import, and gpu empty uses no network', async () => {
  const http = await loopback(), local = device(); http.fault('health', 'http503');
  const service = createComposedAnalysisService({ ...dependencies(http.base, local.local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    await service.fetchModels(['depth', 'encode', 'face'], new AbortController().signal, () => undefined);
    assert.deepEqual(local.fetches[0], ['depth', 'encode', 'face']); http.clear(); const imported = run(service); await imported.done;
    assert.deepEqual(service.backend, { kind: 'gpu', name: 'Loopback Radeon' });
    const empty = createComposedAnalysisService({ ...dependencies(http.base, local.local), gpu: Promise.resolve(''), fetch: async () => { throw new Error('Empty GPU must not fetch.'); }, changed() {} });
    await empty.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined); const deviceImport = run(empty); await deviceImport.done;
    assert.deepEqual(deviceImport.errors, []); assert.deepEqual(empty.backend, { kind: 'device' });
    assert.deepEqual(local.fetches.at(-1), ['depth', 'encode', 'decode', 'inpaint', 'face']);
  } finally { service.cancelHeavy(); await http.stop(); }
});

test('failed boot health and local model download recover through the preparation retry', async () => {
  const http = await loopback(), deviceService = device(); http.fault('health', 'http503', 1);
  const local: AnalysisService = { ...deviceService.local, async fetchModels(ops, signal, progress) {
    if (ops.includes('depth')) return { ok: false, error: { kind: 'download', model, status: 503 } };
    return deviceService.local.fetchModels(ops, signal, progress);
  } };
  const service = createComposedAnalysisService({ ...dependencies(http.base, local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    const boot = await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined);
    assert.equal(boot.ok, false);
    const recovered = await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined);
    assert.equal(recovered.ok, true);
    assert.deepEqual(deviceService.fetches, [['encode', 'decode', 'face']]);
    assert.equal(http.requests.filter((r) => r.path === '/v1/health').length, 2);
    const imported = run(service); await imported.done;
    assert.deepEqual(imported.errors, []);
    assert.deepEqual(service.backend, { kind: 'gpu', name: 'Loopback Radeon' });
  } finally { service.cancelHeavy(); await http.stop(); }
});

for (const key of ['inpaint']) test(`${key}: one transient error retries; a stalled body retries once and settles; cancellation never retries`, async () => {
  const http = await loopback(), local = device(); let failed = 0;
  const service = createRemoteAnalysisService({ ...dependencies(http.base, local.local), failed: () => { failed++; } });
  try {
    const imported = run(service, [{ kind: 'depth' }]); await imported.done;
    const exercise = async (signal = new AbortController().signal): Promise<AnalysisError | null> => {
      const plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }], signal); await plate.done; return plate.errors[0] ?? null;
    };
    const count = () => http.requests.filter((r) => r.path.endsWith(`/${key}`)).length;
    http.fault(key, 'http503', 1); assert.equal(await exercise(), null); assert.equal(count(), 2);
    http.fault(key, 'stall'); const before = count(), began = Date.now(); const error = await exercise();
    assert.equal(error?.kind, 'worker'); assert.equal(count() - before, 2); assert.ok(Date.now() - began < 10_000); assert.ok(failed > 0);
    const controller = new AbortController(), cancelBefore = count(), pending = exercise(controller.signal);
    await waitFor(() => count() > cancelBefore); controller.abort(); assert.equal((await pending)?.kind, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(count() - cancelBefore, 1);
  } finally { service.releaseSession(); await http.stop(); }
});

for (const fault of ['invalid-size', 'invalid-length', 'invalid-depth'] satisfies Fault[]) test(`invalid depth ${fault} fails before publishing products`, async () => {
  const http = await loopback(); http.fault('depth', fault);
  const service = createRemoteAnalysisService(dependencies(http.base, device().local));
  try { const imported = run(service, [{ kind: 'depth' }]); await imported.done; assert.equal(imported.errors.length, 1); assert.deepEqual(imported.depths, []); assert.deepEqual(imported.embeddings, []); assert.equal(service.alive.heavy, false); }
  finally { service.releaseSession(); await http.stop(); }
});
test('cancel while session creation stalls settles once, closes bitmap and prevents fallback', async () => {
  const http = await loopback(), local = device(); http.fault('sessions', 'stall');
  const service = createComposedAnalysisService({ ...dependencies(http.base, local.local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    await service.fetchModels(['face'], new AbortController().signal, () => undefined);
    const controller = new AbortController(), imported = run(service, undefined, controller.signal);
    await waitFor(() => http.requests.some((r) => r.path === '/v1/sessions')); controller.abort(); await imported.done;
    await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(imported.errors.length, 1); assert.equal(imported.errors[0]?.kind, 'cancelled'); assert.equal(local.sequences.length, 0); assert.equal(imported.photo.closed(), 1); assert.equal(service.alive.heavy, false);
  } finally { service.cancelHeavy(); await http.stop(); }
});

test('GPU depth remains GPU when the device encoder fails, and its plate is still usable', async () => {
  const http = await loopback(), deviceService = device();
  const local: AnalysisService = { ...deviceService.local, runSequence(id, stages, input, on, signal) {
    if (stages[0].kind === 'encode') {
      on.onPhase('encode', 'session', null);
      on.onFailed('encode', { kind: 'worker', op: 'encode', message: 'Device encoder failed.' });
    } else deviceService.local.runSequence(id, stages, input, on, signal);
  } };
  const service = createComposedAnalysisService({ ...dependencies(http.base, local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    const imported = run(service); await imported.done;
    assert.equal(imported.errors[0]?.kind, 'worker'); assert.equal(imported.events.at(-1), 'failed.encode');
    assert.deepEqual(service.backend, { kind: 'gpu', name: 'Loopback Radeon' });
    assert.equal(imported.depths.length, 1); assert.equal(imported.embeddings.length, 0);
    assert.equal(http.requests.filter((r) => r.path.endsWith('/depth')).length, 1);
    assert.deepEqual(deviceService.sequences, []);
    const plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }]); await plate.done;
    assert.deepEqual(plate.errors, []);
  } finally { service.releaseImport(); await http.stop(); }
});

for (const external of [false, true]) test(`hybrid cancellation stops both transports before terminal callbacks: external=${external}`, async () => {
  const http = await loopback(), deviceService = device();
  let held: SequenceListener | null = null;
  const local: AnalysisService = { ...deviceService.local,
    runSequence(_id, stages, _input, on) { assert.equal(stages[0].kind, 'encode'); held = on; on.onPhase('encode', 'session', null); },
    cancelHeavy() { const previous = held; held = null; previous?.onFailed('encode', { kind: 'cancelled' }); },
    get alive() { return { heavy: held !== null, decoder: false }; },
  };
  const service = createComposedAnalysisService({ ...dependencies(http.base, local), gpu: Promise.resolve(http.base), changed() {} });
  const controller = new AbortController();
  try {
    const next = new Promise<ReturnType<typeof run>>((resolve) => {
      service.runSequence(scene, [{ kind: 'depth' }, { kind: 'encode' }], fixture().input, {
        onPhase() {}, onDepth() {}, onEmbeddings() {}, onPlate() {}, onDone() { assert.fail('Cancelled encoder cannot finish.'); },
        onFailed(_stage, error) {
          assert.equal(error.kind, 'cancelled'); assert.equal(service.alive.heavy, false, 'Native work must stop before the terminal callback.');
          resolve(run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }]));
        },
      }, controller.signal);
    });
    await waitFor(() => held !== null);
    if (external) controller.abort(); else service.cancelHeavy();
    const plate = await next; await plate.done;
    assert.deepEqual(plate.errors, [], 'A plate started by cancellation stands.'); assert.equal(plate.plates.length, 1);
  } finally { service.releaseImport(); await http.stop(); }
});

test('replacement releases the GPU session even before its device decoder opened', async () => {
  const http = await loopback(), deviceService = device();
  let held: SequenceListener | null = null;
  const local: AnalysisService = { ...deviceService.local,
    runSequence(_id, _stages, _input, on) { held = on; },
    cancelHeavy() { const old = held; held = null; old?.onFailed('encode', { kind: 'cancelled' }); },
    get alive() { return { heavy: held !== null, decoder: false }; },
  };
  const service = createComposedAnalysisService({ ...dependencies(http.base, local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    const imported = run(service); await waitFor(() => held !== null);
    service.releaseImport(); await imported.done;
    await waitFor(() => http.requests.some((r) => r.method === 'DELETE'));
    assert.equal(imported.errors[0]?.kind, 'cancelled'); assert.equal(imported.embeddings.length, 0);
    assert.equal(http.requests.filter((r) => r.method === 'DELETE').length, 1);
    assert.deepEqual(service.routing, { depth: 'device', encoder: 'device', taps: 'device', plate: 'device' });
  } finally { service.releaseImport(); await http.stop(); }
});

// The actual dev server, not a test replacement: all contract routes, PNG,
// the no-store policy, fault grammar, and production isolation.
test('dev GPU stub serves the full contract from a JPEG and preserves pixels outside the hole', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await tempDir('gpu-stub');
  await writeTree(dir, { 'build.json': JSON.stringify({ mode: 'dev', gpu: '' }) });
  const server = await startServer(['--mode', 'dev', '--root', dir, '--gpu-stub', '--results', dir, '--request-log', `${dir}/requests.jsonl`]);
  const base = `${server.url}dev/gpu/v1`;
  try {
    assert.equal(z.object({ gpu: z.string() }).parse(await (await fetch(`${server.url}build.json`)).json()).gpu, '/dev/gpu');
    assert.equal((await fetch(`${base}/health`)).headers.get('Cache-Control'), 'no-store');
    const preflight = await fetch(`${base}/sessions`, { method: 'OPTIONS', headers: { Origin: 'https://preview.noisy-demo.pages.dev', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://preview.noisy-demo.pages.dev');
    assert.ok(preflight.headers.get('Access-Control-Allow-Headers')?.includes('X-Width'));
    const created = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Width': '2048', 'X-Height': '1536' }, body: await readFile(new URL('../src/assets/sample.jpg', import.meta.url)) });
    assert.equal(created.status, 201); const { id } = z.object({ id: z.string() }).parse(await created.json());
    const session = `${base}/sessions/${id}`, depth = await fetch(`${session}/depth`);
    assert.equal((await depth.arrayBuffer()).byteLength, 2048 * 1536 * 4);
    const taps = await fetch(`${session}/taps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: [{ x: 0.5, y: 0.5, label: 'include' }] }) });
    const masks = new Uint8Array(await taps.arrayBuffer()); assert.equal(masks.length, 1024 * 768 * 3);
    const areas = [0, 1, 2].map((c) => masks.subarray(c * 1024 * 768, (c + 1) * 1024 * 768).filter((v) => v >= 128).length);
    assert.ok((areas[0] ?? 0) < (areas[1] ?? 0) && (areas[1] ?? 0) < (areas[2] ?? 0));
    const hole = new Uint8Array(2048 * 1536); hole.fill(255, 100, 200);
    const plate = async (mask: Uint8Array<ArrayBuffer>) => Buffer.from(await (await fetch(`${session}/inpaint`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Width': '2048', 'X-Height': '1536' }, body: mask })).arrayBuffer());
    const rgb = (png: Buffer) => {
      assert.equal(png.readUInt32BE(16), 2048); assert.equal(png.readUInt32BE(20), 1536);
      const parts: Buffer[] = []; for (let at = 8; at < png.length;) { const length = png.readUInt32BE(at); if (png.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length)); at += length + 12; }
      const raw = inflateSync(Buffer.concat(parts)); assert.equal(raw.length, 1536 * (2048 * 3 + 1)); return raw;
    };
    const unchanged = rgb(await plate(new Uint8Array(hole.length))), painted = rgb(await plate(hole));
    let changed = 0;
    for (let i = 0; i < hole.length; i++) for (let c = 0; c < 3; c++) { const at = Math.floor(i / 2048) * (2048 * 3 + 1) + 1 + (i % 2048) * 3 + c; if (hole[i] === 0) assert.equal(painted[at], unchanged[at]); else if (painted[at] !== unchanged[at]) changed++; }
    assert.ok(changed > 0);
    const faults = await fetch(`${server.url}dev/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: ['path:/dev/gpu/v1/sessions:http503:times=1'] }) }); assert.equal(faults.status, 200);
    assert.equal((await fetch(`${session}/depth`)).status, 503);
    const availableDepth = await fetch(`${session}/depth`); assert.equal(availableDepth.status, 200);
    assert.equal((await availableDepth.arrayBuffer()).byteLength, 2048 * 1536 * 4);
    const postOnly = await fetch(`${server.url}dev/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: ['path:/dev/gpu/v1/sessions:http503:method=POST:times=1'] }) }); assert.equal(postOnly.status, 200);
    assert.equal((await fetch(session, { method: 'DELETE' })).status, 200, 'Session cleanup must not consume a POST-only creation fault.');
    const photo = await readFile(new URL('../src/assets/sample.jpg', import.meta.url));
    const create = () => fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Width': '2048', 'X-Height': '1536' }, body: photo });
    assert.equal((await create()).status, 503);
    const recovered = await create(); assert.equal(recovered.status, 201);
    const next = z.object({ id: z.string() }).parse(await recovered.json());
    assert.equal((await fetch(`${base}/sessions/${next.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${session}/depth`)).status, 404);
    const modelFault = await fetch(`${server.url}dev/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: ['path:/models/depth-:http503:method=GET:times=1'] }) }); assert.equal(modelFault.status, 200);
    const unavailable = await fetch(`${server.url}models/depth-fcf51f1b.onnx`);
    assert.equal(unavailable.status, 503, 'The failed-boot fixture must actually refuse the model file.'); await unavailable.text();
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

for (const key of ['health', 'depth']) test(`${key} stalled body reaches the device fallback within its deadline`, async () => {
  const http = await loopback(), local = device(); http.fault(key, 'stall');
  const service = createComposedAnalysisService({ ...dependencies(http.base, local.local), timeouts: { ...timeouts, health: 40, depth: 40 }, gpu: Promise.resolve(http.base), changed() {} });
  try {
    const before = Date.now();
    await service.fetchModels(['depth', 'encode', 'decode', 'inpaint', 'face'], new AbortController().signal, () => undefined);
    const imported = run(service); await imported.done;
    assert.equal(imported.errors.length, 0); assert.equal(local.sequences.length, 1); assert.equal(service.backend.kind, 'device'); assert.ok(Date.now() - before < 10_000);
  } finally { service.cancelHeavy(); await http.stop(); }
});

test('the inpaint deadline also bounds PNG decoding that ignores abort', async () => {
  const http = await loopback();
  const service = createRemoteAnalysisService({ ...dependencies(http.base, device().local), decode: () => new Promise(() => undefined) });
  try {
    const imported = run(service, [{ kind: 'depth' }]); await imported.done;
    const before = Date.now(), plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }]); await plate.done;
    assert.equal(plate.errors[0]?.kind, 'worker'); assert.equal(plate.plates.length, 0); assert.equal(http.requests.filter((r) => r.path.endsWith('/inpaint')).length, 2); assert.ok(Date.now() - before < 10_000);
  } finally { service.releaseSession(); await http.stop(); }
});

test('an import started by a cancellation callback survives the old import cleanup', async () => {
  const http = await loopback(); http.fault('sessions', 'stall', 1);
  const service = createComposedAnalysisService({ ...dependencies(http.base, device().local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    await service.fetchModels(['face'], new AbortController().signal, () => undefined);
    const next = new Promise<ReturnType<typeof run>>((resolve) => {
      service.runSequence(scene, [{ kind: 'depth' }, { kind: 'encode' }], fixture().input, {
        onPhase() {}, onDepth() {}, onEmbeddings() {}, onPlate() {}, onDone() { throw new Error('The cancelled import must fail.'); },
        onFailed(_stage, error) { assert.equal(error.kind, 'cancelled'); resolve(run(service, undefined, undefined, otherScene)); },
      }, new AbortController().signal);
    });
    await waitFor(() => http.requests.some((r) => r.path === '/v1/sessions')); service.cancelHeavy();
    const replacement = await next; await replacement.done;
    assert.deepEqual(replacement.errors, []); assert.equal(replacement.embeddings.length, 1); assert.equal(service.alive.heavy, false);
  } finally { service.cancelHeavy(); await http.stop(); }
});

test('a caller watchdog cancelling the second inpaint attempt still makes the next import re-probe', async () => {
  const http = await loopback();
  const service = createComposedAnalysisService({ ...dependencies(http.base, device().local), gpu: Promise.resolve(http.base), changed() {} });
  try {
    await service.fetchModels(['face'], new AbortController().signal, () => undefined);
    const imported = run(service); await imported.done;
    http.fault('inpaint', 'stall');
    const watchdog = new AbortController(), plate = run(service, [{ kind: 'inpaint', hole: { format: 'u8', size, data: new Uint8Array(4) } }], watchdog.signal);
    await waitFor(() => http.requests.filter((r) => r.path.endsWith('/inpaint')).length === 2); watchdog.abort(); await plate.done;
    assert.equal(plate.errors[0]?.kind, 'cancelled');
    service.cancelHeavy(); http.clear(); const recovered = run(service, undefined, undefined, otherScene); await recovered.done;
    assert.deepEqual(recovered.errors, []); assert.equal(http.requests.filter((r) => r.path === '/v1/health').length, 2);
  } finally { service.cancelHeavy(); await http.stop(); }
});
