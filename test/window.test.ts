import assert from 'node:assert/strict';
import test from 'node:test';
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
