import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseLock } from '../src/analysis/lock.ts';
import { createAnalysisService } from '../src/analysis/service.ts';
import { err } from '../src/core/result.ts';
import { createWindowSource } from '../src/session/window.ts';
import type { FaceDetection } from '../src/analysis/protocol.ts';
import type { ViewAttempt } from '../src/session/view-driver.ts';

test('camera source retains capture time, bounds inference and discards recentered/obsolete results', async (t) => {
  let now = 0, alive = true, trackStops = 0, releases = 0, pauses = 0, calls = 0;
  const draws: unknown[][] = [], targets: Parameters<ViewAttempt['target']>[] = [];
  const disposal: (() => void)[] = [], recenters: (() => void)[] = [];
  let finish: ((value: FaceDetection | null) => void) | null = null;
  const globals = (name: string, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (descriptor === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, descriptor); });
  };
  t.mock.method(performance, 'now', () => now);
  const context = { fillStyle: '', fillRect() {}, drawImage(...args: unknown[]) { draws.push(args); } };
  const video = { muted: false, playsInline: false, srcObject: null, readyState: 4, videoWidth: 1920, videoHeight: 1080, play: async () => {}, pause() { pauses++; } };
  const track = { stop() { trackStops++; }, addEventListener() {}, removeEventListener() {} };
  globals('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  globals('document', { createElement: (name: string) => name === 'video' ? video : { width: 0, height: 0, getContext: () => context } });
  globals('window', { setTimeout, clearTimeout });
  globals('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  globals('createImageBitmap', async () => ({ close() {} }));
  const source = createWindowSource({ openTracker: () => ({ ready: Promise.resolve(), release() { releases++; }, track: async () => {
    calls++; return new Promise<FaceDetection | null>((resolve) => { finish = resolve; });
  } }) });
  const attempt: ViewAttempt = { valid: () => alive, dispose: (fn) => disposal.push(fn), onRecenter: (fn) => recenters.push(fn), target: (...args) => targets.push(args), failed: (status) => assert.fail(status) };
  const poll = await source.source(attempt);
  const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const complete = async (value: FaceDetection | null): Promise<void> => {
    const resolve = finish; assert.ok(resolve !== null); finish = null; resolve(value); await flush();
  };
  now = 10; poll(now); await flush();
  now = 100; poll(now); await flush(); assert.equal(calls, 1);
  assert.deepEqual(draws[0]?.slice(1), [0, 30, 320, 180]);
  now = 130; await complete({ center: { x: .5, y: .5 }, size: .2, confidence: .95 });
  assert.equal(targets[0]?.[1]?.capturedAt, 10);
  assert.equal(targets[0]?.[1]?.state, 'calibrating');
  now = 200; poll(now); await flush();
  now = 250; recenters.forEach((fn) => fn()); const count = targets.length;
  now = 300; await complete({ center: { x: .6, y: .5 }, size: .2, confidence: .95 });
  assert.equal(targets.length, count, 'pre-recenter inference cannot establish the new neutral');
  now = 400; poll(now); await flush(); alive = false;
  disposal.toReversed().forEach((fn) => fn()); await flush();
  await complete(null);
  assert.equal(targets.length, count); assert.equal(trackStops, 1); assert.equal(releases, 1); assert.equal(pauses, 1);
  assert.equal(source.preview().frame, null);
});

for (const failure of [
  { stage: 'permission', error: new DOMException('User denied camera access', 'NotAllowedError'), reason: 'Camera permission was denied' },
  { stage: 'permission', error: new DOMException('No device', 'NotFoundError'), reason: 'No camera was found' },
  { stage: 'permission', error: new DOMException('Device busy', 'NotReadableError'), reason: 'Camera could not start or is in use' },
  { stage: 'play', error: new DOMException('Playback blocked', 'NotAllowedError'), reason: 'Camera video could not play' },
  { stage: 'worker', error: new Error('wasm allocation failed'), reason: 'Face tracking could not start' },
  { stage: 'inference', error: new Error('ORT run failed'), reason: 'Face tracking failed' },
]) {
  test(`camera preserves ${failure.stage} failure reason and releases resources: ${failure.error.name}`, async (t) => {
    const globals = (name: string, value: unknown): void => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      t.after(() => { if (descriptor === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, descriptor); });
    };
    let alive = true, stops = 0, releases = 0, requested = false;
    const disposal: (() => void)[] = [], failures: Parameters<ViewAttempt['failed']>[] = [];
    const track = { stop() { stops++; }, addEventListener() {}, removeEventListener() {} };
    globals('navigator', { mediaDevices: { getUserMedia() {
      requested = true;
      return failure.stage === 'permission' ? Promise.reject(failure.error) : Promise.resolve({ getTracks: () => [track] });
    } } });
    const context = { fillRect() {}, drawImage() {} };
    globals('document', { createElement: (name: string) => name === 'video' ? {
      readyState: 4, videoWidth: 320, videoHeight: 240, pause() {},
      play: () => failure.stage === 'play' ? Promise.reject(failure.error) : Promise.resolve(),
    } : { getContext: () => context } });
    globals('window', { setTimeout, clearTimeout });
    globals('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    globals('createImageBitmap', async () => ({ close() {} }));
    const source = createWindowSource({ openTracker: () => ({
      ready: failure.stage === 'worker' ? Promise.reject(failure.error) : Promise.resolve(),
      release() { releases++; }, track: () => Promise.reject(failure.error),
    }) });
    const attempt: ViewAttempt = {
      valid: () => alive, dispose: (fn) => disposal.push(fn), target() {},
      failed(...args) { failures.push(args); alive = false; disposal.toReversed().forEach((fn) => fn()); },
    };
    const opening = source.source(attempt);
    assert.equal(requested, true, 'getUserMedia is invoked before the source yields');
    const poll = await opening;
    if (failure.stage === 'inference') { poll(performance.now()); for (let i = 0; i < 20; i++) await Promise.resolve(); }
    assert.deepEqual(failures, [[failure.reason, `${failure.error.name}: ${failure.error.message}`]]);
    assert.equal(stops, failure.stage === 'permission' ? 0 : 1);
    assert.equal(releases, failure.stage === 'permission' ? 0 : 1);
    assert.equal(source.tracks().length, 0);
  });
}

test('a real analysis-service face worker construction failure reaches the camera source and releases the stream', { timeout: 5000 }, async (t) => {
  const globals = (name: string, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (descriptor === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, descriptor); });
  };
  const parsed = parseLock(JSON.parse(await readFile(new URL('../models.lock.json', import.meta.url), 'utf8')));
  assert.ok(parsed.ok);
  let alive = true, stops = 0, spawns = 0;
  const disposal: (() => void)[] = [], failures: Parameters<ViewAttempt['failed']>[] = [];
  const track = { stop() { stops++; }, addEventListener() {}, removeEventListener() {} };
  globals('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  globals('document', { createElement: () => ({ pause() {}, play: async () => {} }) });
  globals('window', { setTimeout, clearTimeout });
  const service = createAnalysisService({
    clock: { now: () => 0 }, diag: { log() {} }, lock: parsed.value, threads: 2, ortBase: '/vendor/ort/1.30.0/',
    loader: Promise.resolve(err({ kind: 'quota' })),
    spawn: () => { throw new Error('No sequence worker expected.'); },
    spawnDecoder: () => { throw new Error('No decoder expected.'); },
    spawnFaceTracker: () => { spawns++; throw new Error('CAM2 worker startup fault'); },
  });
  const source = createWindowSource({ openTracker: () => service.openFaceTracker() });
  await source.source({
    valid: () => alive, dispose: (fn) => disposal.push(fn), target() {},
    failed(...args) { failures.push(args); alive = false; disposal.toReversed().forEach((fn) => fn()); },
  });
  assert.equal(spawns, 1);
  assert.deepEqual(failures, [['Face tracking could not start', 'Error: Error: CAM2 worker startup fault']]);
  assert.equal(stops, 1, 'startup failure releases the acquired camera stream');
  assert.equal(source.tracks().length, 0);
  assert.equal(source.trackedFrames(), 0);
});
