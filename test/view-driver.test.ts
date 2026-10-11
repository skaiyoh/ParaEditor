import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createViewDriver, type ViewAttempt, type SourceName } from '../src/session/view-driver.ts';
import { minimalDocument } from './fixtures/documents.ts';

function rig(t: TestContext, drawMs = 0) {
  let now = 0, id = 0, generation = 1, draws = 0, releases = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  let cleanup = (): void => {};
  for (const name of ['requestAnimationFrame', 'cancelAnimationFrame']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => { cleanup(); if (previous === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, previous); });
  }
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (key: number) => callbacks.delete(key) });
  t.mock.method(performance, 'now', () => now);
  const sources: Partial<Record<SourceName, ViewAttempt>> = {};
  const seq = { camera: 0, tilt: 0 };
  const source = (name: SourceName) => async (attempt: ViewAttempt) => {
    sources[name] = attempt; attempt.dispose(() => releases++); return () => {};
  };
  const view = createViewDriver({ read: minimalDocument, generation: () => generation,
    draw: () => { draws++; now += drawMs; }, changed: () => {}, failed: () => {} }, { camera: source('camera'), tilt: source('tilt') });
  cleanup = view.stop;
  return { view, sources, pending: () => callbacks.size, draws: () => draws, releases: () => releases,
    replace: () => generation++, now: () => now, advance: (ms: number) => { now += ms; },
    sample(name: SourceName, x: number, state: 'tracking' | 'lost' | 'calibrating' = 'tracking') {
      sources[name]?.target({ x, y: .5 }, { capturedAt: now, sequence: ++seq[name], state });
    },
    tick(ms = 16, rafLag = 0) { now += ms; const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((fn) => fn(now - rafLag)); },
  };
}

test('fresh camera owns the viewpoint despite an opposing tilt and one clock polls both', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 40; i++) { r.sample('camera', .8); r.sample('tilt', .2); r.tick(); }
  assert.equal(r.view.diagnostics().source, 'camera');
  assert.ok(r.view.diagnostics().center.x > .799);
  assert.equal(r.pending(), 1);
  assert.equal(r.draws(), 40);
});

test('transient face miss holds, then tilt takes over continuously; reacquisition is blended', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 30; i++) { r.sample('camera', .8); r.sample('tilt', .2); r.tick(); }
  r.sample('camera', .5, 'lost'); r.tick(100);
  assert.equal(r.view.diagnostics().source, 'camera');
  r.sample('tilt', .2); r.tick(160);
  const before = r.view.diagnostics().center.x;
  assert.equal(r.view.diagnostics().source, 'tilt');
  assert.ok(before > .79, 'handoff begins at the currently displayed view');
  for (let i = 0; i < 30; i++) { r.sample('tilt', .2); r.tick(); }
  assert.ok(r.view.diagnostics().center.x < .201);
  r.sample('camera', .8); r.tick();
  assert.ok(r.view.diagnostics().center.x < .21);
});

test('old sequence, old capture time and future capture are refused', async (t) => {
  const r = rig(t); await r.view.start(); r.tick(100);
  r.sample('camera', .6);
  r.sources.camera?.target({ x: 1, y: 1 }, { capturedAt: 100, sequence: 1, state: 'tracking' });
  r.sources.camera?.target({ x: 1, y: 1 }, { capturedAt: 99, sequence: 2, state: 'tracking' });
  r.sources.camera?.target({ x: 1, y: 1 }, { capturedAt: 200, sequence: 3, state: 'tracking' });
  assert.equal(r.view.targets().faceTarget.x, .6);
});

test('recenter invokes sources, isolation chooses tilt, and generation replacement disposes everything', async (t) => {
  const r = rig(t); await r.view.start(); let resets = 0;
  r.sources.camera?.onRecenter?.(() => resets++); r.sources.tilt?.onRecenter?.(() => resets++);
  r.sample('camera', .8); r.sample('tilt', .2); r.view.setSourceMode('tilt'); r.tick();
  assert.equal(r.view.diagnostics().source, 'tilt');
  r.view.recenter(); assert.equal(resets, 2); assert.equal(r.view.diagnostics().samples.camera, null);
  r.replace(); r.tick();
  assert.equal(r.view.enabled(), false); assert.equal(r.releases(), 2); assert.equal(r.pending(), 0);
  r.sources.camera?.target({ x: 1, y: 1 }); assert.equal(r.view.targets().faceTarget.x, .5);
  r.sources.camera?.dispose(() => resets++); assert.equal(resets, 3);
});

test('trace is bounded and records numeric timings without camera frames', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 1500; i++) { r.sample('camera', .5); r.tick(60); }
  assert.equal(r.view.trace().samples.length, 1200);
  assert.equal(r.view.trace().samples.at(-1)?.cameraAge, 60);
  assert.equal(JSON.stringify(r.view.trace()).includes('Image'), false);
});


test('held face-loss samples still advance the ordering watermark', async (t) => {
  const r = rig(t); await r.view.start(); r.tick(100);
  r.sources.camera?.target({ x: .6, y: .5 }, { capturedAt: 100, sequence: 1, state: 'tracking' });
  r.tick(100);
  r.sources.camera?.target({ x: .5, y: .5 }, { capturedAt: 200, sequence: 3, state: 'lost' });
  r.sources.camera?.target({ x: 1, y: .5 }, { capturedAt: 150, sequence: 2, state: 'tracking' });
  assert.equal(r.view.targets().faceTarget.x, .6);
  assert.equal(r.view.diagnostics().samples.camera?.sequence, 1, 'displayed tracking sample holds until age expires');
  r.tick(60);
  const traced = r.view.trace().samples.at(-1);
  assert.equal(traced?.cameraSample?.sequence, 1);
  assert.equal(traced?.cameraEvent?.sequence, 3);
  assert.equal(traced?.cameraEvent?.state, 'lost');
  assert.equal(traced?.cameraEvent?.capturedAt, 200);
  assert.equal(traced?.cameraEvent?.receivedAt, 200);
});


test('hidden page releases sources and clock without automatic permission restart', async (t) => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = new EventTarget(); let visibility = 'visible';
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const r = rig(t); await r.view.start();
  visibility = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(r.view.enabled(), false); assert.equal(r.releases(), 2); assert.equal(r.pending(), 0);
  visibility = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(r.view.enabled(), false);
  if (prior === undefined) Reflect.deleteProperty(globalThis, 'document'); else Object.defineProperty(globalThis, 'document', prior);
});

// Submission timing includes synchronous render work instead of reusing the RAF timestamp.
test('trace separates frame start from render submission', async (t) => {
  const r = rig(t, 20); await r.view.start(); r.sample('camera', .5); r.tick(60);
  const sample = r.view.trace().samples.at(-1);
  assert.equal(sample?.now, 60);
  assert.equal(sample?.drawStartedAt, 60);
  assert.equal(sample?.submittedAt, 80);
  assert.equal((sample?.submittedAt ?? 0) - (sample?.cameraSample?.capturedAt ?? 0), 80);
});

test('alternating fresh and expired tilt cannot freeze the previous camera view', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 40; i++) { r.sample('camera', .65); r.sample('tilt', .125); r.tick(); }
  r.sample('camera', .5, 'lost'); r.tick(300);
  for (let i = 0; i < 8; i++) {
    r.sample('tilt', .125); r.tick();
    assert.equal(r.view.diagnostics().source, 'tilt');
    r.tick(300);
    assert.equal(r.view.diagnostics().source, 'none');
  }
  assert.ok(r.view.diagnostics().center.x < .25, `fallback remained at ${r.view.diagnostics().center.x}`);
  assert.equal(r.view.trace().holdMs, 250); assert.equal(r.view.trace().handoffMs, 200);
});

test('freshness uses decision time when RAF timestamp precedes callback execution', async (t) => {
  const r = rig(t); await r.view.start(); r.sample('camera', .65);
  r.advance(400); r.sample('tilt', .125); r.tick(0, 300);
  assert.equal(r.view.diagnostics().source, 'tilt');
  const latest = r.view.diagnostics().latest;
  assert.equal(latest?.now, 100); assert.equal(latest?.decisionAt, 400);
  assert.equal(latest?.cameraAge, 400); assert.equal(latest?.tiltAge, 0);
  assert.equal(latest?.frameInterval, 400);
});

test('source changes on every tick still advance within the target envelope', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 40; i++) { r.sample('camera', .8); r.tick(); }
  for (let i = 0; i < 100; i++) {
    r.sample('camera', .4); r.sample('tilt', .2);
    r.view.setSourceMode(i % 2 === 0 ? 'tilt' : 'camera'); r.tick();
    const center = r.view.diagnostics().center.x;
    assert.ok(Number.isFinite(center) && center >= .2 && center <= .8);
  }
  assert.ok(r.view.diagnostics().center.x < .65, 'retargeting must not discard every interval');
});

test('long gap advances the retained trajectory before beginning the loss transition', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 40; i++) { r.sample('camera', .8); r.tick(); }
  r.view.setSourceMode('tilt'); r.sample('tilt', .125); r.tick();
  r.tick(300);
  assert.equal(r.view.diagnostics().source, 'none');
  assert.ok(r.view.diagnostics().center.x < .13, 'elapsed tilt handoff finishes before loss retargeting');
  r.tick(300);
  assert.ok(Math.abs(r.view.diagnostics().center.x - .5) < .001, 'continued loss returns toward neutral');
});

test('recenter during handoff resets its target and clock; restart cannot retain old travel', async (t) => {
  const r = rig(t); await r.view.start();
  for (let i = 0; i < 40; i++) { r.sample('camera', .8); r.tick(); }
  r.view.setSourceMode('tilt'); r.sample('tilt', .2); r.tick(); r.tick(60);
  const before = r.view.diagnostics().center.x;
  assert.ok(before > .5);
  r.advance(1000); r.view.recenter(); r.tick();
  const after = r.view.diagnostics().center.x;
  assert.ok(after < before && after > .5 && before - after < .003, 'recenter starts a fresh neutral trajectory without old elapsed time');
  r.tick(500); assert.ok(Math.abs(r.view.diagnostics().center.x - .5) < .001);
  r.view.stop(); await r.view.start(); r.tick(500);
  assert.equal(r.view.diagnostics().center.x, .5);
});

test('camera denial remains visible during tilt and its exact error survives stop in the trace', async (t) => {
  const r = rig(t); await r.view.start();
  r.sources.camera?.failed('Camera permission was denied', 'NotAllowedError: Permission denied');
  r.sample('tilt', .5); r.tick();
  assert.equal(r.view.status(), 'Parallax: Camera permission was denied; using tilt.');
  assert.deepEqual(r.view.trace().failures.camera, { reason: 'Camera permission was denied', detail: 'NotAllowedError: Permission denied' });
  r.view.stop();
  assert.equal(r.view.trace().failures.camera?.detail, 'NotAllowedError: Permission denied');
  await r.view.start(); assert.equal(r.view.trace().failures.camera, null);
});

test('fallback distinguishes absent faces, calibration, slow observations, worker failure and explicit tilt', async (t) => {
  const r = rig(t); await r.view.start();
  r.sample('tilt', .5); r.tick(); assert.match(r.view.status(), /waiting for its first frame; using tilt/);
  r.sample('camera', .5, 'calibrating'); r.sample('tilt', .5); r.tick();
  assert.match(r.view.status(), /Hold still to calibrate the camera; using tilt/);
  r.sample('camera', .5, 'lost'); r.sample('tilt', .5); r.tick();
  assert.match(r.view.status(), /No clear face is in view, or the scene is too dark; using tilt/);
  r.advance(300); r.sample('tilt', .5); r.tick();
  assert.match(r.view.status(), /too slow or has stalled; using tilt/);
  r.sources.camera?.failed('Face tracking could not start', 'Error: wasm allocation failed');
  r.sample('tilt', .5); r.tick(); assert.match(r.view.status(), /Face tracking could not start; using tilt/);
  r.view.setSourceMode('tilt'); r.tick(); assert.equal(r.view.status(), 'Parallax: using tilt by choice.');
});

test('stopping labels the camera off while retaining an isolated last-failure record', async (t) => {
  const r = rig(t); await r.view.start();
  r.sources.camera?.failed('Face tracking could not start', 'Error: wasm allocation failed');
  const diagnostic = r.view.diagnostics(), trace = r.view.trace();
  if (diagnostic.failures.camera !== null) diagnostic.failures.camera.reason = 'tampered';
  if (trace.failures.camera !== null) trace.failures.camera.detail = 'tampered';
  assert.equal(r.view.diagnostics().cameraStatus, 'Face tracking could not start.');
  assert.equal(r.view.trace().failures.camera?.detail, 'Error: wasm allocation failed');
  r.view.stop();
  assert.equal(r.view.diagnostics().cameraState, 'Off');
  assert.equal(r.view.diagnostics().cameraStatus, 'Parallax is off; last camera attempt: Face tracking could not start.');
});
