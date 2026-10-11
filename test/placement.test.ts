import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitAuthoringView, sourceToView, viewToSource } from '../src/core/authoring-view.ts';
import { artworkDepth, artworkHome, createPlacement, identityPlacement, normalizeRotation,
  placementBounds, placementMapping, resetPlacement, validatePlacement } from '../src/core/placement.ts';
import type { AffinePlacement } from '../src/core/types.ts';

const space = { source: { width: 13, height: 7 }, master: { width: 1024, height: 768 } };
const placement: AffinePlacement = { pivot: { x: 6.5, y: 3.5 }, translate: { x: 101, y: -23 }, scale: 2, rotation: 90 };
function near(a: number, b: number): void { assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`); }

test('placement uses clockwise degrees around a fixed local pivot and master pixel translation', () => {
  const map = placementMapping({ space, placement });
  assert.deepEqual(map.sourceToScene(placement.pivot), { x: 107.5, y: -19.5 });
  const corner = map.sourceToScene({ x: 0, y: 0 });
  near(corner.x, 114.5); near(corner.y, -32.5);
  const bounds = placementBounds({ space, placement });
  near(bounds.x, 100.5); near(bounds.y, -32.5); near(bounds.width, 14); near(bounds.height, 26);
});

test('a transformed grid shares color/alpha/mask/depth coordinates, including different plane resolutions', () => {
  const size = { width: 8, height: 6 }, gridSpace = { source: size, master: space.master };
  const color = Uint8Array.from({ length: 8 * 6 }, (_, i) => i * 5);
  const mask = Uint8Array.from({ length: 4 * 3 }, (_, i) => i * 21);
  const depth = Float32Array.from({ length: 2 * 3 }, (_, i) => i / 5);
  for (const rotation of [-180, -137.25, -90, 0, 23.5, 90, 179.999]) {
    for (const scale of [1 / 64, 0.7, 1, 64]) {
      const map = placementMapping({ space: gridSpace, placement: { ...placement, scale, rotation, pivot: { x: 4, y: 3 } } });
      for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const local = { x: x + .5, y: y + .5 }, scene = map.sourceToScene(local), restored = map.sceneToSource(scene);
        near(restored.x, local.x); near(restored.y, local.y);
        assert.equal(color[Math.floor(restored.y) * 8 + Math.floor(restored.x)], color[y * 8 + x]);
        assert.equal(mask[Math.floor(restored.y / 2) * 4 + Math.floor(restored.x / 2)], mask[Math.floor(y / 2) * 4 + Math.floor(x / 2)]);
        assert.equal(depth[Math.floor(restored.y / 2) * 2 + Math.floor(restored.x / 4)], depth[Math.floor(y / 2) * 2 + Math.floor(x / 4)]);
      }
    }
  }
});

test('source/scene inverse composes with desktop, phone and high-DPR authoring views', () => {
  const map = placementMapping({ space, placement }), local = { x: 4.5, y: 1.5 };
  const scene = map.sourceToScene(local);
  for (const viewport of [{ x: 170, y: 80, width: 1200, height: 900 }, { x: 0, y: 40, width: 390, height: 600 }]) {
    for (const dpr of [1, 2, 3]) for (const kind of ['css', 'device'] satisfies ('css' | 'device')[]) {
      const view = { ...fitAuthoringView({ source: space.master, viewport, dpr }), zoom: 3, pan: { x: 71, y: -45 } };
      const restored = map.sceneToSource(viewToSource(view, sourceToView(view, scene, kind)));
      near(restored.x, local.x); near(restored.y, local.y);
    }
  }
});

test('artwork homes center a fit, preserve small graphics, and reset to the captured value', () => {
  const home = artworkHome(space);
  assert.equal(home.scale, 1);
  assert.deepEqual(placementMapping({ space, placement: home }).sourceToScene(home.pivot), { x: 512, y: 384 });
  const larger = { source: { width: 2048, height: 1024 }, master: { width: 1024, height: 768 } };
  const fit = artworkHome(larger);
  assert.equal(fit.scale, .5);
  assert.deepEqual(placementBounds({ space: larger, placement: fit }), { x: 0, y: 128, width: 1024, height: 512 });
  const before = structuredClone(home);
  assert.deepEqual(resetPlacement({ home, space }), before);
  assert.deepEqual(home, before);
  assert.deepEqual(identityPlacement({ space, pivot: { x: 3, y: 4 } }), {
    pivot: { x: 3, y: 4 }, translate: { x: 0, y: 0 }, scale: 1, rotation: 0,
  });
});

test('rotation wraps without losing already normalized precision, while persisted invalid rotation refuses', () => {
  for (const [input, expected] of [[180, -180], [540, -180], [-540, -180], [360, 0], [-360, 0], [0.000000000000001, 0.000000000000001], [-181, 179]]) {
    assert.equal(normalizeRotation(input ?? 0), expected);
  }
  assert.equal(createPlacement({ space, placement: { ...placement, rotation: 450 } }).rotation, 90);
  assert.throws(() => validatePlacement({ space, placement: { ...placement, rotation: 180 } }));
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => normalizeRotation(value));
});

test('centered homes remain representable on narrow masters by choosing the nearest admissible pivot', () => {
  for (const narrow of [
    { source: { width: 2048, height: 64 }, master: { width: 64, height: 2048 } },
    { source: { width: 64, height: 2048 }, master: { width: 2048, height: 64 } },
    { source: { width: 2048, height: 2048 }, master: { width: 32, height: 2048 } },
  ]) {
    const home = artworkHome(narrow), bounds = placementBounds({ placement: home, space: narrow });
    near(bounds.x + bounds.width / 2, narrow.master.width / 2);
    near(bounds.y + bounds.height / 2, narrow.master.height / 2);
    assert.ok(bounds.width <= narrow.master.width && bounds.height <= narrow.master.height);
    assert.deepEqual(resetPlacement({ home, space: narrow }), home);
  }
});

test('nonfinite/singular/out-of-range placement refuses; exact scale, pivot and translation boundaries pass', () => {
  for (const scale of [0, -1, 1 / 128, 64.0001, NaN, Infinity]) assert.throws(() => createPlacement({ space, placement: { ...placement, scale } }));
  for (const pivot of [{ x: -1, y: 0 }, { x: 14, y: 0 }, { x: 0, y: 8 }, { x: Infinity, y: 0 }]) {
    assert.throws(() => createPlacement({ space, placement: { ...placement, pivot } }));
  }
  for (const translate of [{ x: 4096.1, y: 0 }, { x: 0, y: -3072.1 }, { x: 0, y: NaN }]) {
    assert.throws(() => createPlacement({ space, placement: { ...placement, translate } }));
  }
  for (const scale of [1 / 64, 64]) assert.doesNotThrow(() => createPlacement({ space, placement: {
    ...placement, scale, translate: { x: -4096, y: 3072 }, pivot: { x: 13, y: 7 },
  } }));
  for (const width of [0, -1, 1.5, 2049, Infinity]) assert.throws(() => artworkHome({ ...space, source: { width, height: 1 } }));
  assert.throws(() => artworkHome({ source: { width: 2048, height: 2048 }, master: { width: 1, height: 1 } }));
  const map = placementMapping({ space, placement });
  assert.throws(() => map.sourceToScene({ x: NaN, y: 0 }));
  assert.throws(() => map.sceneToSource({ x: Infinity, y: 0 }));
  // Finite out-of-footprint points remain invertible, never clamped to image edges.
  const outside = { x: -500, y: 800 }, restored = map.sceneToSource(map.sourceToScene(outside));
  near(restored.x, outside.x); near(restored.y, outside.y);
});

test('artwork gets a physical plane at selected depth, scene anchor, or exactly .5', () => {
  assert.deepEqual(artworkDepth({ selectedLayerDepth: 0, sceneAnchor: .8 }), { kind: 'plane', disparity: 0 });
  assert.deepEqual(artworkDepth({ selectedLayerDepth: null, sceneAnchor: 1 }), { kind: 'plane', disparity: 1 });
  assert.deepEqual(artworkDepth({ selectedLayerDepth: null, sceneAnchor: null }), { kind: 'plane', disparity: .5 });
  for (const value of [NaN, Infinity, -.001, 1.001]) {
    assert.throws(() => artworkDepth({ selectedLayerDepth: value, sceneAnchor: .5 }));
    assert.throws(() => artworkDepth({ selectedLayerDepth: .5, sceneAnchor: value }));
  }
});
