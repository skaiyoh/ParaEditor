import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createViewerMotionClock, resolveViewerAssets, tiltNeedsPermission, type ViewerPiece } from '../src/session/viewer.ts';
import { createTiltSource } from '../src/session/tilt.ts';
import type { ViewObservation } from '../src/session/view-driver.ts';
import type { Vec2 } from '../src/core/motion.ts';
import type { AssetId } from '../src/core/ids.ts';
import type { Plane, Rgb8 } from '../src/core/raster.ts';
import { fiveClusterDocument, minimalDocument, assetId } from './fixtures/documents.ts';
import { bootstrapGallery, parseGalleryRoute } from '../src/app/gallery-bootstrap.ts';

test('viewer Motion starts at the first frame timestamp and clamps an earlier timestamp', () => {
  const clock = createViewerMotionClock(minimalDocument().motion);
  assert.equal(clock.frame(1000), 0);
  assert.equal(clock.frame(950), 0, 'an earlier callback cannot submit frame -1');
  assert.equal(clock.frame(1034), 1);
  assert.equal(clock.frame(1010), 1, 'a late callback cannot reverse submitted Motion');
  for (const timestamp of [1000.5, 950.25, 1067.1, 1500, 4000.25]) {
    const frame = clock.frame(timestamp);
    assert.ok(Number.isInteger(frame) && frame >= 0 && frame < 90, `invalid frame ${frame}`);
  }
  assert.throws(() => clock.frame(NaN), /timestamp must be finite/);
});

test('viewer Motion pause retains the last frame and resumes from a new frame timestamp', () => {
  const clock = createViewerMotionClock(minimalDocument().motion);
  clock.frame(1000);
  assert.equal(clock.frame(1100), 3);
  clock.stop(); clock.stop();
  assert.equal(clock.frame(5000), 3, 'paused wall time does not advance Motion');
  assert.equal(clock.frame(4970), 3, 'an earlier resume callback remains nonnegative');
  assert.equal(clock.frame(5034), 4);
});

test('gallery bootstrap parses only list and UUID piece routes', () => {
  assert.deepEqual(parseGalleryRoute('/gallery'), { kind: 'list' });
  assert.deepEqual(parseGalleryRoute('/gallery/'), { kind: 'list' });
  assert.deepEqual(parseGalleryRoute('/gallery/00000000-0000-4000-8000-000000000001'), { kind: 'piece', id: '00000000-0000-4000-8000-000000000001' });
  for (const path of ['/gallery.html', '/gallery/nope', '/gallery/00000000-0000-4000-8000-000000000001/extra', '/api/gallery']) assert.equal(parseGalleryRoute(path), null);
  assert.equal(typeof bootstrapGallery, 'function');
});

function piece() {
  const base = fiveClusterDocument(), size = { width: 4, height: 4 };
  const masks = base.objects.map((object) => ({ ...object, produced: { ...object.produced, mask: { ...object.produced.mask, size } } }));
  if (base.analysis.depth === null || base.analysis.plate === null) throw new Error('Incomplete test document.');
  const doc = { ...base, frame: { ...base.frame, master: { ...base.frame.master, size } }, objects: masks,
    analysis: { ...base.analysis, depth: { ...base.analysis.depth, map: { ...base.analysis.depth.map, size } }, plate: { ...base.analysis.plate, image: { ...base.analysis.plate.image, size } } } };
  const planes = new Map<AssetId, Plane<'u8'> | Plane<'f32'> | Rgb8>();
  for (const object of doc.objects) planes.set(object.produced.mask.asset, { format: 'u8', size, data: new Uint8Array(16).fill(255) });
  const depth: Plane<'f32'> = { format: 'f32', size, data: new Float32Array(16).fill(.5) };
  planes.set(doc.analysis.depth.map.asset, depth);
  const plate = { size, data: new Uint8Array(48).fill(127) };
  planes.set(doc.analysis.plate.image.asset, plate);
  return { document: doc, source: new Blob(), planes } satisfies ViewerPiece;
}

test('published assets map by object id and retain the supplied depth and plate identities', () => {
  const input = piece(), assets = resolveViewerAssets(input);
  assert.equal(assets.masks.size, input.document.objects.length);
  for (const object of input.document.objects) assert.equal(assets.masks.get(object.id), input.planes.get(object.produced.mask.asset));
  assert.equal(assets.depth, input.planes.get(input.document.analysis.depth.map.asset));
  assert.equal(assets.plate, input.planes.get(input.document.analysis.plate.image.asset));
});

test('every missing declared asset is rejected before GL or decoding', () => {
  for (const id of piece().planes.keys()) {
    const input = piece(); input.planes.delete(id);
    assert.throws(() => resolveViewerAssets(input), new RegExp(`missing asset ${id}`));
  }
  const input = piece();
  assert.throws(() => resolveViewerAssets({ ...input, document: { ...input.document, analysis: { ...input.document.analysis, plate: null } } }), /background plate/);
});

test('wrong dimensions, formats, lengths, depth values and stale plates are refused', () => {
  const change = (value: Plane<'f32'> | Rgb8): void => {
    const input = piece(); input.planes.set(input.document.analysis.depth.map.asset, value);
    assert.throws(() => resolveViewerAssets(input), /dimensions|finite f32/);
  };
  change({ format: 'f32', size: { width: 4, height: 4 }, data: new Float32Array(15) });
  change({ format: 'f32', size: { width: 4, height: 4 }, data: new Float32Array(16).fill(NaN) });
  change({ format: 'f32', size: { width: 4, height: 4 }, data: new Float32Array(16).fill(1.1) });
  change({ format: 'f32', size: { width: 5, height: 4 }, data: new Float32Array(20) });
  change({ size: { width: 4, height: 4 }, data: new Uint8Array(48) });
  const input = piece();
  assert.throws(() => resolveViewerAssets({ ...input, document: { ...input.document, analysis: { ...input.document.analysis,
    plate: { ...input.document.analysis.plate, forMasks: [assetId(999)] } } } }), /different masks/);
});

function orientationEnvironment(t: TestContext, permission: (() => Promise<string>) | null) {
  const events = new EventTarget(); let count = 0;
  const fakeWindow = { screen: { orientation: { angle: 0, type: 'portrait-primary' } }, setTimeout,
    addEventListener(name: string, listener: EventListener) { count++; events.addEventListener(name, listener); },
    removeEventListener(name: string, listener: EventListener) { count--; events.removeEventListener(name, listener); } };
  for (const [name, value] of Object.entries({ window: fakeWindow, NOISY_DEV: false,
    DeviceOrientationEvent: permission === null ? class extends Event {} : Object.assign(class extends Event {}, { requestPermission: permission }) })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, original); });
  }
  return { count: () => count, emit(beta: number, gamma: number, time: number) {
    const event = new Event('deviceorientation');
    Object.defineProperties(event, { alpha: { value: null }, beta: { value: beta }, gamma: { value: gamma }, timeStamp: { value: time } });
    events.dispatchEvent(event);
  } };
}

test('gallery tilt uses actual synthetic orientation events and releases the sensor listener', async (t) => {
  const env = orientationEnvironment(t, null), source = createTiltSource();
  const cleanup: (() => void)[] = [], samples: { target: Vec2; observation: ViewObservation | undefined }[] = [];
  let valid = true;
  const ready = source.source({ valid: () => valid, dispose: (fn) => cleanup.push(fn), failed: assert.fail,
    target: (target, observation) => samples.push({ target, observation }) });
  assert.equal(tiltNeedsPermission(), false); assert.equal(env.count(), 1);
  const now = performance.now();
  env.emit(20, 0, now); env.emit(20, 12, now + 20);
  await ready;
  assert.equal(samples[0]?.observation?.state, 'calibrating');
  assert.equal(samples[1]?.observation?.state, 'tracking');
  assert.ok((samples[1]?.target.x ?? .5) > .5);
  valid = false; cleanup.forEach((fn) => fn());
  assert.equal(env.count(), 0);
  env.emit(20, -12, now + 40); assert.equal(samples.length, 2);
});

test('gesture-gated tilt calls permission synchronously and cannot register after cancellation', async (t) => {
  let called = 0, valid = true;
  const permission = Promise.withResolvers<string>();
  const env = orientationEnvironment(t, () => { called++; return permission.promise; });
  const source = createTiltSource();
  assert.equal(tiltNeedsPermission(), true);
  const ready = source.source({ valid: () => valid, dispose: () => assert.fail('late listener'), failed: assert.fail, target: () => assert.fail('late sample') });
  assert.equal(called, 1); assert.equal(env.count(), 0);
  valid = false; permission.resolve('granted'); await ready;
  assert.equal(env.count(), 0);
});

test('denied tilt permission never installs a sensor listener', async (t) => {
  const env = orientationEnvironment(t, async () => 'denied');
  let failure = '';
  await createTiltSource().source({ valid: () => true, dispose: () => assert.fail('denied listener'), failed: (text) => { failure = text; }, target: () => assert.fail('denied sample') });
  assert.equal(failure, 'Tilt unavailable'); assert.equal(env.count(), 0);
});
