import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { minimalDocument } from './fixtures/documents.ts';
import { parallaxClamp } from '../src/core/derive.ts';
import { createViewDriver, fuseTargets, type ViewAttempt } from '../src/session/view-driver.ts';
import { screenTilt } from '../src/session/tilt.ts';

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

for (const type of ['portrait-primary', 'portrait-secondary', 'landscape-primary', 'landscape-secondary'] satisfies readonly OrientationType[]) {
  test(`PH3 axis mapping is retained for ${type}, independent of the device's natural orientation`, () => {
    for (const [angle, expected] of [[0, { x: 8, y: 35 }], [90, { x: 35, y: -8 }],
      [180, { x: -8, y: -35 }], [270, { x: -35, y: 8 }]] satisfies readonly (readonly [number, { x: number; y: number }])[]) {
      assert.deepEqual(screenTilt(35, 8, angle, type), expected);
    }
  });
}

test('Parallax adds centered source targets, clamps each input, then clamps their sum', () => {
  const sum = fuseTargets({ x: .6, y: .4 }, { x: .7, y: .3 });
  assert.ok(Math.abs(sum.x - .8) < 1e-12 && Math.abs(sum.y - .2) < 1e-12);
  assert.deepEqual(fuseTargets({ x: 1, y: 0 }, { x: 1, y: 0 }), { x: 1, y: 0 });
  assert.deepEqual(fuseTargets({ x: 2, y: -1 }, { x: 0, y: 1 }), { x: .5, y: .5 });
  assert.deepEqual(fuseTargets({ x: .8, y: .2 }, { x: .5, y: .5 }), { x: .8, y: .2 });
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

test('one Parallax clock fuses inputs and keeps tilt alive when the running camera fails', async (t) => {
  const clock = viewClock(t), doc = minimalDocument();
  const camera: { attempt: ViewAttempt | null } = { attempt: null };
  const tilt: { attempt: ViewAttempt | null } = { attempt: null };
  let cameraDisposed = 0, tiltDisposed = 0, draws = 0;
  const failures: string[] = [];
  const view = createViewDriver({ read: () => doc, generation: () => 1,
    draw: () => { draws++; }, changed: () => {}, failed: (status) => failures.push(status) }, {
    camera: async (attempt) => { camera.attempt = attempt; attempt.dispose(() => cameraDisposed++); return () => {}; },
    tilt: async (attempt) => { tilt.attempt = attempt; attempt.dispose(() => tiltDisposed++); return () => {}; },
  });
  await view.start(); t.after(view.stop);
  assert.equal(view.status(), 'Parallax: camera and tilt');
  assert.equal(clock.pending(), 1);
  camera.attempt?.target({ x: .6, y: .4 }); tilt.attempt?.target({ x: .7, y: .3 });
  clock.tick();
  assert.equal(draws, 1);
  assert.ok(Math.abs(view.camera().x + .6 * parallaxClamp(doc)) < 1e-12);
  assert.ok(Math.abs(view.camera().y - .6 * parallaxClamp(doc)) < 1e-12);
  camera.attempt?.failed('Camera unavailable');
  assert.equal(view.enabled(), true); assert.equal(view.ready('camera'), false); assert.equal(view.ready('tilt'), true);
  assert.equal(view.status(), 'Parallax: tilt');
  assert.equal(cameraDisposed, 1); assert.equal(tiltDisposed, 0);
  assert.deepEqual(view.targets().faceTarget, { x: .5, y: .5 });
  assert.deepEqual(failures, []);
  view.stop();
  assert.equal(clock.pending(), 0); assert.equal(tiltDisposed, 1); assert.equal(cameraDisposed, 1);
  assert.deepEqual(view.camera(), { x: 0, y: 0 });
});

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
  assert.equal(view.status(), 'Parallax: tilt');
  view.stop();
  camera.attempt?.target({ x: 1, y: 1 });
  camera.attempt?.dispose(() => disposed++);
  camera.resolve?.(() => {}); await starting;
  assert.equal(disposed, 1); assert.equal(view.enabled(), false); assert.equal(view.ready('camera'), false);
  assert.equal(clock.pending(), 0); assert.deepEqual(view.targets().faceTarget, { x: .5, y: .5 });
});
