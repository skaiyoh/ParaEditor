import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { minimalDocument } from './fixtures/documents.ts';
import { createViewDriver, type ViewAttempt } from '../src/session/view-driver.ts';
import { createTiltSource, screenTilt } from '../src/session/tilt.ts';

// The application build supplies this constant; the pure rotation checks never read it.
declare global { const NOISY_DEV: boolean; }

test('screen tilt rotates device axes with the screen at every quarter turn', () => {
  assert.deepEqual(screenTilt(35, 8, 0), { x: 8, y: 35 });
  assert.deepEqual(screenTilt(35, 8, 90), { x: 35, y: -8 });
  assert.deepEqual(screenTilt(35, 8, 180), { x: -8, y: -35 });
  assert.deepEqual(screenTilt(35, 8, 270), { x: -35, y: 8 });
  assert.deepEqual(screenTilt(35, 8, -90), screenTilt(35, 8, 270));
  assert.deepEqual(screenTilt(35, 8, 360), screenTilt(35, 8, 0));
});

test('screen-axis rest deltas preserve portrait signs and swap landscape axes', () => {
  for (const angle of [0, 90, 180, 270]) {
    const rest = screenTilt(35, 8, angle);
    for (const [beta, gamma] of [[35, 23], [50, 8], [20, -7]]) {
      if (beta === undefined || gamma === undefined) throw new Error('Missing tilt sample.');
      const moved = screenTilt(beta, gamma, angle);
      const delta = screenTilt(beta - 35, gamma - 8, angle);
      assert.ok(moved.x - rest.x === delta.x && moved.y - rest.y === delta.y);
    }
  }
});

function viewClock(t: TestContext) {
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    callbacks.set(++id, callback); return id;
  } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (key: number) => callbacks.delete(key) });
  t.after(() => {
    if (requestDescriptor === undefined) Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    else Object.defineProperty(globalThis, 'requestAnimationFrame', requestDescriptor);
    if (cancelDescriptor === undefined) Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
    else Object.defineProperty(globalThis, 'cancelAnimationFrame', cancelDescriptor);
  });
  return { pending: () => callbacks.size, tick() {
    const current = [...callbacks.values()]; callbacks.clear();
    current.forEach((callback) => callback(performance.now() + 10_000));
  } };
}

test('both sources start synchronously; cancelling a pending source rejects stale input and disposes late resources', async (t) => {
  const clock = viewClock(t), order: string[] = [];
  const camera: { attempt: ViewAttempt | null; resolve: ((poll: (now: number) => void) => void) | null } = { attempt: null, resolve: null };
  let disposed = 0;
  const view = createViewDriver({ read: minimalDocument, generation: () => 1,
    draw: () => {}, changed: () => {}, failed: () => {} }, {
    camera: (attempt) => { order.push('camera'); camera.attempt = attempt;
      return new Promise((resolve) => { camera.resolve = resolve; }); },
    tilt: async () => { order.push('tilt'); return () => {}; },
  });
  const starting = view.start(); t.after(view.stop);
  assert.deepEqual(order, ['camera', 'tilt']);
  await Promise.resolve();
  assert.equal(view.ready('tilt'), true); assert.equal(view.ready('camera'), false);
  assert.equal(view.status(), 'Parallax: calibrating');
  view.stop();
  camera.attempt?.target({ x: 1, y: 1 });
  camera.attempt?.dispose(() => disposed++);
  camera.resolve?.(() => {}); await starting;
  assert.equal(disposed, 1); assert.equal(view.enabled(), false); assert.equal(view.ready('camera'), false);
  assert.equal(clock.pending(), 0); assert.deepEqual(view.targets().faceTarget, { x: .5, y: .5 });
});


test('tilt source exposes preclamp evidence, supports recenter and removes disposed listeners', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDev = Object.getOwnPropertyDescriptor(globalThis, 'NOISY_DEV');
  const events = new EventTarget();
  let listenerCount = 0;
  Object.defineProperty(globalThis, 'NOISY_DEV', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    screen: { orientation: { angle: 0, type: 'landscape-primary' } }, orientation: 90,
    setTimeout, addEventListener(type: string, listener: EventListener) { listenerCount++; events.addEventListener(type, listener); },
    removeEventListener(type: string, listener: EventListener) { listenerCount--; events.removeEventListener(type, listener); },
  } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (originalDev) Object.defineProperty(globalThis, 'NOISY_DEV', originalDev); else Reflect.deleteProperty(globalThis, 'NOISY_DEV');
  });
  let valid = true;
  const disposers: (() => void)[] = [], recenter: (() => void)[] = [];
  const targets: { center: { x: number; y: number }; metadata: Parameters<ViewAttempt['target']>[1] }[] = [];
  const tilt = createTiltSource();
  const starting = tilt.source({ valid: () => valid, dispose: (action) => disposers.push(action),
    onRecenter: (action) => recenter.push(action), failed: (message) => assert.fail(message),
    target: (center, metadata) => targets.push({ center, metadata }) });
  tilt.injectOrientation({ beta: 1.04, gamma: -86.02 }); await starting;
  tilt.injectOrientation({ beta: 179.49, gamma: 84.84 });
  const reading = tilt.readings();
  assert.equal(reading.effectiveAngle, 90); assert.equal(reading.basisProvenance, 'legacy-aligned-native');
  assert.equal(reading.sequence, 2); assert.equal(reading.pose, 'gravity'); assert.equal(reading.yawLimited, true);
  assert.ok(Math.abs(reading.preclamp.x) < 10 && Math.abs(reading.preclamp.y) < 10);
  assert.equal(targets.at(-1)?.metadata?.state, 'tracking');
  assert.ok((targets.at(-1)?.metadata?.capturedAt ?? 0) > 0);
  recenter.forEach((action) => action());
  tilt.injectOrientation({ beta: 179.49, gamma: 84.84 });
  assert.deepEqual(targets.at(-1)?.center, { x: .5, y: .5 });
  valid = false; disposers.forEach((action) => action());
  assert.equal(listenerCount, 0);
  const count = targets.length;
  tilt.injectOrientation({ beta: 40, gamma: 40 });
  assert.equal(targets.length, count);
});
