import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createViewerMotionClock, resolveViewerAssets, tiltNeedsPermission, type CompositionViewerPiece, type ViewerPiece } from '../src/session/viewer.ts';
import { createTiltSource } from '../src/session/tilt.ts';
import type { ViewObservation } from '../src/session/view-driver.ts';
import type { Vec2 } from '../src/core/motion.ts';
import type { AssetId } from '../src/core/ids.ts';
import type { Plane, Rgb8 } from '../src/core/raster.ts';
import { legacyFiveClusterDocument as fiveClusterDocument, legacyMinimalDocument as minimalDocument, assetId } from './fixtures/documents.ts';
import { bootstrapGallery, parseGalleryRoute } from '../src/app/gallery-bootstrap.ts';
import { migrateV4ToV5 } from '../src/core/composition.ts';
import { compositionDocumentSchema } from '../src/core/composition-schema.ts';
import { encodeRaster } from '../src/core/asset-codec.ts';
import { holeRadius, repairHole, sourceRemovalUnion } from '../src/core/derive.ts';
import { createProducts } from '../src/session/products.ts';
import { localEffect } from './fixtures/composition.ts';

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

async function compositionPiece(objects = true) {
  const legacy = piece().document, size = legacy.frame.master.size, products = createProducts();
  const originalBytes = new TextEncoder().encode('Retained original bytes are never decoded for v5 playback.');
  const [source, master, depth, layerMask, selectionMask] = await Promise.all([
    products.admitBytes(originalBytes), products.admitRgb({ size, data: new Uint8Array(48).fill(127) }),
    products.admitPlane({ format: 'f32', size, data: new Float32Array(16).fill(.5) }),
    products.admitPlane({ format: 'u8', size, data: new Uint8Array(16).fill(255) }),
    products.admitPlane({ format: 'u8', size, data: Uint8Array.from({ length: 16 }, (_, index) => index % 4 === 0 ? 255 : index % 4 === 1 ? 128 : 0) }),
  ]);
  const migrated = migrateV4ToV5({ ...legacy, objects: objects ? legacy.objects.map((object) => ({ ...object,
    produced: { ...object.produced, bounds: { x: 0, y: 0, ...size } } })) : [], analysis: { ...legacy.analysis, plate: null } });
  assert.ok(migrated.ok, JSON.stringify(migrated));
  const base = migrated.value;
  assert.ok(base.analysis.depth);
  const mask = { asset: layerMask, format: 'u8' as const, size }, map = { asset: depth, format: 'f32' as const, size };
  const effect = localEffect();
  let document = compositionDocumentSchema.parse({ ...base, frame: { ...base.frame, master: { asset: master, size },
    source: { asset: source, mediaType: 'image/jpeg', byteLength: originalBytes.byteLength }, original: { ...base.frame.original, size } },
    analysis: { ...base.analysis, depth: { ...base.analysis.depth, map } }, motion: { ...base.motion, enabled: false, parallax: 1 },
    objects: base.objects.map((object) => ({ ...object, produced: { ...object.produced, mask, bounds: { x: 0, y: 0, ...size } },
      depthAttachment: { kind: 'source', model: base.analysis.depth?.model, map, offset: 0 } })),
    removals: base.removals.map((removal) => ({ ...removal, mask: { ...removal.mask, plane: mask } })),
    localEffects: [{ ...effect, scope: { ...effect.scope, mask: { plane: { asset: selectionMask, format: 'u8', size }, provenance: { kind: 'manual', operation: 'rectangle' } } },
      operation: { kind: 'recolor', color: { l: .63, c: .18, h: 241 } } },
      { ...localEffect(2), scope: { kind: 'whole' }, operation: { kind: 'fill', color: { l: .8, c: .13, h: 25 } } },
      { ...localEffect(3), scope: { kind: 'whole' }, operation: { kind: 'clipping', amount: .72 } }],
  });
  if (objects) {
    const union = sourceRemovalUnion(document, products.masks), hole = repairHole(document, union);
    const [removalUnion, holeAsset, image] = await Promise.all([products.admitPlane(union), products.admitPlane(hole),
      products.admitRgb({ size, data: new Uint8Array(48).fill(85) })]);
    document = compositionDocumentSchema.parse({ ...document, analysis: { ...document.analysis, plate: {
      key: { algorithm: 'photo-repair-v2', source: master, size, removalUnion, hole: holeAsset, depth,
        radius: holeRadius(document, size), purpose: { kind: 'still' }, model: legacy.analysis.plate.model },
      image: { asset: image, size }, backgroundDepth: map,
    } } });
  }
  const assets = new Map(products.assets);
  if (!objects) assets.delete(layerMask);
  return { document, assets } satisfies CompositionViewerPiece;
}

test('v5 publication resolves wrapped masks, saved master PNG, repaired depth and ordered local effects', async () => {
  const input = await compositionPiece(), assets = resolveViewerAssets(input);
  assert.equal(assets.kind, 'composition');
  assert.ok(assets.kind === 'composition');
  assert.deepEqual(new Uint8Array(await assets.masterPng.arrayBuffer()), input.assets.get(input.document.frame.master.asset));
  assert.notDeepEqual(new Uint8Array(await assets.masterPng.arrayBuffer()), input.assets.get(input.document.frame.source?.asset ?? assetId(999)));
  assert.equal(assets.compositing, 'legacy-order');
  assert.equal(assets.masks.size, input.document.objects.length);
  assert.deepEqual(assets.depth?.data, new Float32Array(16).fill(.5));
  assert.equal(assets.backgroundDepth, assets.depth, 'a shared immutable saved plane is resolved once');
  assert.ok(input.document.analysis.plate);
  assert.ok(assets.repairPng);
  assert.deepEqual(new Uint8Array(await assets.repairPng.arrayBuffer()), input.assets.get(input.document.analysis.plate.image.asset));
  assert.deepEqual(assets.localEffects.map((effect) => effect.operation), input.document.localEffects.map((effect) => effect.operation));
  const scoped = assets.localEffects[0], documentEffect = input.document.localEffects[0];
  assert.ok(scoped?.scope.kind === 'mask' && documentEffect?.scope.kind === 'mask');
  assert.equal(scoped.scope.plane, assets.masksByAsset.get(documentEffect.scope.mask.plane.asset));
  assert.deepEqual([...scoped.scope.plane.data.slice(0, 4)], [255, 128, 0, 0], 'manual coverage weights survive NSRA decoding');
});

test('v5 refuses every missing encoded closure asset before PNG decode or GL', async () => {
  const input = await compositionPiece();
  for (const asset of input.assets.keys()) {
    const assets = new Map(input.assets); assets.delete(asset);
    assert.throws(() => resolveViewerAssets({ ...input, assets }), new RegExp(`missing asset ${asset}`));
  }
});

test('v5 refuses payload-only planes, corrupt NSRA, nonfinite depth and corrupt PNG bytes', async () => {
  const input = await compositionPiece();
  assert.ok(input.document.analysis.depth);
  const asset = input.document.analysis.depth.map.asset, encoded = input.assets.get(asset);
  assert.ok(encoded);
  for (const bytes of [encoded.subarray(16), Uint8Array.from(encoded, (value, index) => index === 5 ? 1 : value),
    Uint8Array.from(encoded, (value, index) => index === 6 ? 1 : value)]) {
    const assets = new Map(input.assets); assets.set(asset, bytes);
    assert.throws(() => resolveViewerAssets({ ...input, assets }), /encoded byte length|raster header|descriptor|size/);
  }
  const nonfinite = new Uint8Array(encoded); new DataView(nonfinite.buffer).setFloat32(16, NaN, true);
  const depths = new Map(input.assets); depths.set(asset, nonfinite);
  assert.throws(() => resolveViewerAssets({ ...input, assets: depths }), /finite samples/);
  const master = input.assets.get(input.document.frame.master.asset);
  assert.ok(master);
  const badPng = new Uint8Array(master); badPng[20] = (badPng[20] ?? 0) ^ 1;
  const pngs = new Map(input.assets); pngs.set(input.document.frame.master.asset, badPng);
  assert.throws(() => resolveViewerAssets({ ...input, assets: pngs }), /checksum/);
});

test('v5 repair requires the source envelope and exact source-removal union and hole', async () => {
  const input = await compositionPiece(), repair = input.document.analysis.plate;
  assert.ok(repair);
  assert.throws(() => resolveViewerAssets({ ...input, document: { ...input.document, analysis: { ...input.document.analysis,
    plate: { ...repair, key: { ...repair.key, radius: repair.key.radius + 1 } } } } }), /different source, depth or reveal envelope/);
  const effect = input.document.localEffects[0]; assert.ok(effect?.scope.kind === 'mask');
  const selectionAsset = effect.scope.mask.plane.asset;
  for (const key of ['removalUnion', 'hole'] as const) {
    assert.throws(() => resolveViewerAssets({ ...input, document: { ...input.document, analysis: { ...input.document.analysis,
      plate: { ...repair, key: { ...repair.key, [key]: selectionAsset } } } } }), /different source removals or a different hole/);
  }
  assert.throws(() => resolveViewerAssets({ ...input, document: { ...input.document, analysis: { ...input.document.analysis, plate: null } },
    assets: new Map([...input.assets].filter(([asset]) => asset !== repair.image.asset)) }), /background plate/);
});

test('v5 zero-object local operations render without a plate and refuse scene-depth explicitly', async () => {
  const input = await compositionPiece(false), assets = resolveViewerAssets(input);
  assert.ok(assets.kind === 'composition');
  assert.equal(assets.plate, null); assert.equal(assets.repairPng, null); assert.equal(assets.backgroundDepth, null);
  assert.equal(assets.masks.size, 0); assert.ok(assets.depth);
  assert.equal(assets.localEffects.length, 3);
  assert.throws(() => resolveViewerAssets({ ...input, document: { ...input.document, compositing: 'scene-depth' } }), /Scene-depth composition requires C3/);
});

test('v5 permits the original and master to share the exact PNG digest without duplicate bytes', async () => {
  const input = await compositionPiece(false), master = input.assets.get(input.document.frame.master.asset);
  assert.ok(master && input.document.frame.source);
  const assets = new Map(input.assets); assets.delete(input.document.frame.source.asset);
  const document = { ...input.document, frame: { ...input.document.frame, source: {
    asset: input.document.frame.master.asset, mediaType: 'image/png', byteLength: master.byteLength,
  } } };
  assert.ok(resolveViewerAssets({ document, assets }).kind === 'composition');
  const extra = new Map(assets); extra.set(assetId(999), encodeRaster({ format: 'u8', size: { width: 1, height: 1 }, data: Uint8Array.of(255) }));
  assert.throws(() => resolveViewerAssets({ document, assets: extra }), /unreferenced asset/);
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
