// The scene derivations: the draw order of the layers, the label of a frame
// point by the bilinear rule at texel centers, the hole mask, whether a plate
// is needed, the anchor disparity, and every asset a document references.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorDisparity, assetRefs, holeMask, labelAt, layers, maskCovers, plateNeeded } from '../src/core/derive.ts';
import type { AssetId, ObjectId } from '../src/core/ids.ts';
import { isAssetId } from '../src/core/ids.ts';
import { sortedMasks } from '../src/core/produce.ts';
import type { Plane, Rect, Size } from '../src/core/raster.ts';
import { currentDocumentSchema } from '../src/core/schema.ts';
import type { ObjectMotion, SceneDocument, SceneObject } from '../src/core/types.ts';
import { z } from '../src/core/zod.ts';
import { assetId, fiveClusterDocument, getAt, minimalDocument, type Key } from './fixtures/documents.ts';
import { objectId, tappedObject } from './fixtures/edits.ts';
import { depthProduct, plateProduct } from './fixtures/products.ts';

type ObjectSpec = {
  readonly bounds: Rect;
  readonly median: number | null;
  readonly motion?: ObjectMotion;
  readonly subject?: boolean;
};

/** Object `n` with its own mask asset (0x300 + n), the given bounds, depth median, and motion. */
function object(n: number, spec: ObjectSpec): SceneObject {
  const base = tappedObject(objectId(n));
  const { median } = spec;
  return {
    ...base,
    subject: spec.subject ?? false,
    motion: spec.motion ?? { kind: 'none' },
    produced: {
      ...base.produced,
      mask: { ...base.produced.mask, asset: assetId(0x300 + n) },
      bounds: spec.bounds,
      depth: median === null ? null : { p10: Math.max(0, median - 0.05), median, p90: Math.min(1, median + 0.05) },
    },
  };
}

function withObjects(objects: readonly SceneObject[], base: SceneDocument = fiveClusterDocument()): SceneDocument {
  return { ...base, objects: [...objects] };
}

function box(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** The ids of the object layers, in draw order; the plate's layer must come first. */
function order(doc: SceneDocument): readonly ObjectId[] {
  const [first, ...rest] = layers(doc);
  assert.equal(first.kind, 'plate');
  return rest.map((layer) => {
    assert.equal(layer.kind, 'object');
    return layer.kind === 'object' ? layer.object.id : objectId(-1);
  });
}

function plane(size: Size, value: (x: number, y: number) => number): Plane<'u8'> {
  const data = new Uint8Array(size.width * size.height);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) data[y * size.width + x] = value(x, y);
  return { format: 'u8', size, data };
}

/** A one-row mask holding `values`. */
function row(values: readonly number[]): Plane<'u8'> {
  return plane({ width: values.length, height: 1 }, (x) => values[x] ?? 0);
}

// ---------------------------------------------------------------------------
// layers

test('layers puts the plate first, then the objects far to near by depth median', () => {
  const doc = withObjects([
    object(0, { bounds: box(0, 0, 10, 10), median: 0.7 }),
    object(1, { bounds: box(100, 0, 10, 10), median: 0.2 }),
    object(2, { bounds: box(200, 0, 10, 10), median: 0.5 }),
  ]);
  assert.deepEqual(order(doc), [objectId(1), objectId(2), objectId(0)]);
  assert.deepEqual(layers(minimalDocument()), [{ kind: 'plate' }]);
});

test('layers sorts an object without depth statistics nearest, and keeps document order among ties', () => {
  const doc = withObjects([
    object(0, { bounds: box(0, 0, 10, 10), median: null }),
    object(1, { bounds: box(100, 0, 10, 10), median: 1 }),
    object(2, { bounds: box(200, 0, 10, 10), median: 0.4 }),
    object(3, { bounds: box(300, 0, 10, 10), median: null }),
    object(4, { bounds: box(400, 0, 10, 10), median: 0.4 }),
  ]);
  assert.deepEqual(order(doc), [objectId(2), objectId(4), objectId(1), objectId(0), objectId(3)]);
});

test('layers draws an object more than half inside a larger one after it, whatever their depths', () => {
  const container = object(0, { bounds: box(0, 0, 100, 100), median: 0.9 });
  const inside = object(1, { bounds: box(10, 10, 20, 20), median: 0.1 });
  const halfOut = object(2, { bounds: box(90, 50, 20, 10), median: 0.1 }); // exactly half its area inside
  const mostlyIn = object(3, { bounds: box(89, 70, 20, 10), median: 0.1 }); // 55% inside
  assert.deepEqual(order(withObjects([container, inside])), [objectId(0), objectId(1)]);
  assert.deepEqual(order(withObjects([inside, container])), [objectId(0), objectId(1)]);
  assert.deepEqual(order(withObjects([container, halfOut])), [objectId(2), objectId(0)]);
  assert.deepEqual(order(withObjects([container, mostlyIn])), [objectId(0), objectId(3)]);
});

test('layers keeps depth order for two boxes that each lie more than half inside the other, whatever their areas', () => {
  const pairs: readonly (readonly [Rect, Rect])[] = [
    [box(0, 0, 100, 100), box(5, 5, 100, 100)], // equal areas
    [box(0, 0, 100, 100), box(0, 0, 100, 101)], // one row apart
    [box(0, 0, 100, 100), box(0, 0, 100, 190)], // nearly twice the area: 10000 of 19000 is still more than half
  ];
  for (const [first, second] of pairs) {
    for (const [farBox, nearBox] of [[first, second], [second, first]] as const) {
      const far = object(0, { bounds: farBox, median: 0.3 });
      const near = object(1, { bounds: nearBox, median: 0.8 });
      const label = `far ${farBox.width} x ${farBox.height}, near ${nearBox.width} x ${nearBox.height}`;
      assert.deepEqual(order(withObjects([far, near])), [objectId(0), objectId(1)], label);
      assert.deepEqual(order(withObjects([near, far])), [objectId(0), objectId(1)], label);
    }
  }
});

test('layers orders a chain of containers outermost first', () => {
  const outer = object(0, { bounds: box(0, 0, 400, 400), median: 0.9 });
  const middle = object(1, { bounds: box(50, 50, 200, 200), median: 0.5 });
  const inner = object(2, { bounds: box(60, 60, 50, 50), median: 0.1 });
  const apart = object(3, { bounds: box(1000, 0, 50, 50), median: 0.3 });
  // Each step places the farthest object no unplaced object contains, so the unrelated `apart` goes ahead of the farther `inner`, which waits on its containers.
  assert.deepEqual(order(withObjects([inner, apart, middle, outer])), [objectId(3), objectId(0), objectId(1), objectId(2)]);
});

/** mulberry32: a small seeded generator of uniform numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

test('on 500 seeded random scenes layers is a deterministic order that puts every contained object after its container', () => {
  const random = seeded(0x1a7e_25);
  for (let scene = 0; scene < 500; scene++) {
    const count = 1 + Math.floor(random() * 10);
    const objects = Array.from({ length: count }, (_, n) =>
      object(n, {
        bounds: box(Math.floor(random() * 300), Math.floor(random() * 300), 1 + Math.floor(random() * 300), 1 + Math.floor(random() * 300)),
        median: random() < 0.2 ? null : Math.floor(random() * 5) / 4,
      }),
    );
    const doc = withObjects(objects);
    const drawn = order(doc);
    assert.deepEqual(order(doc), drawn, `scene ${scene}: the same order twice`);
    assert.deepEqual([...drawn].sort(), objects.map((o) => o.id).sort(), `scene ${scene}: every object once`);
    for (const inner of objects) {
      for (const outer of objects) {
        const a = inner.produced.bounds;
        const b = outer.produced.bounds;
        // Inner lies more than half inside outer, and outer does not lie more than half inside inner.
        if (2 * overlap(a, b) > a.width * a.height && 2 * overlap(a, b) <= b.width * b.height) {
          assert.ok(drawn.indexOf(inner.id) > drawn.indexOf(outer.id), `scene ${scene}: ${inner.name} draws after its container`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// the bilinear rule at texel centers

test('a point midway between texels of 120 and 136 reads 128 and is covered; between 120 and 134 it reads 127 and is not', () => {
  // On a 4-texel row, the centers of texels 0 and 1 lie at u 0.125 and 0.375, so 0.25 is midway.
  assert.equal(maskCovers(row([120, 136, 0, 0]), { x: 0.25, y: 0.5 }), true);
  assert.equal(maskCovers(row([120, 134, 0, 0]), { x: 0.25, y: 0.5 }), false);
  // The same in the other direction and on the other axis.
  assert.equal(maskCovers(row([0, 0, 136, 120]), { x: 0.75, y: 0.5 }), true);
  const column = plane({ width: 1, height: 4 }, (_, y) => [120, 134, 136, 120][y] ?? 0);
  assert.equal(maskCovers(column, { x: 0.5, y: 0.25 }), false);
  assert.equal(maskCovers(column, { x: 0.5, y: 0.75 }), true);
});

test('a point at u 0 reads the edge column, and a point past the frame reads the clamped edge', () => {
  assert.equal(maskCovers(row([200, 0, 0, 0]), { x: 0, y: 0.5 }), true);
  assert.equal(maskCovers(row([100, 255, 255, 255]), { x: 0, y: 0.5 }), false);
  assert.equal(maskCovers(row([0, 0, 0, 128]), { x: 1, y: 0.5 }), true);
  assert.equal(maskCovers(row([0, 0, 0, 128]), { x: 1.5, y: -3 }), true);
  assert.equal(maskCovers(row([255, 255, 255, 255]), { x: Number.NaN, y: 0.5 }), false);
  // A finite coordinate whose product with the width overflows to an infinity still reads the clamped edge.
  for (const x of [1e308, -1e308, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    assert.equal(maskCovers(row([255, 255, 255, 255]), { x, y: 0.5 }), true, `x ${x}`);
    assert.equal(maskCovers(row([255, 0, 0, 0]), { x, y: 0.5 }), x < 0, `x ${x}, one edge covered`);
  }
});

test('a midway point whose arithmetic rounds off the midpoint still reads the exact mean', () => {
  // On a 49-texel row the point midway between texels 0 and 1 is u = 1/49, and 1/49 * 49 is 0.9999999999999999 in doubles.
  assert.notEqual((1 / 49) * 49, 1);
  const values = Array.from({ length: 49 }, (_, x) => (x === 0 ? 120 : x === 1 ? 136 : 0));
  assert.equal(maskCovers(row(values), { x: 1 / 49, y: 0.5 }), true);
});

test('the bilinear value weighs all four texels, and 127.5 is not covered', () => {
  const checker = plane({ width: 2, height: 2 }, (x, y) => (x === y ? 0 : 255));
  assert.equal(maskCovers(checker, { x: 0.5, y: 0.5 }), false); // (0 + 255 + 255 + 0) / 4 = 127.5
  const three = plane({ width: 2, height: 2 }, (x, y) => (x === 0 && y === 0 ? 0 : 171));
  assert.equal(maskCovers(three, { x: 0.5, y: 0.5 }), true); // 3 * 171 / 4 = 128.25
});

// ---------------------------------------------------------------------------
// labelAt

test('labelAt returns the last layer whose mask covers the point, else null for the plate', () => {
  const size = { width: 10, height: 10 };
  const far = object(0, { bounds: box(0, 0, 1200, 1536), median: 0.2 });
  const near = object(1, { bounds: box(800, 0, 1248, 1536), median: 0.8 });
  const doc = withObjects([near, far]);
  const masks = new Map<ObjectId, Plane<'u8'>>([
    [far.id, plane(size, (x) => (x < 6 ? 255 : 0))],
    [near.id, plane(size, (x) => (x >= 4 ? 255 : 0))],
  ]);
  assert.equal(labelAt(doc, masks, { x: 0.15, y: 0.5 }), far.id);
  assert.equal(labelAt(doc, masks, { x: 0.55, y: 0.5 }), near.id); // both cover; the nearer draws last
  assert.equal(labelAt(doc, masks, { x: 0.95, y: 0.5 }), near.id);
  const onlyFar = new Map([[far.id, plane(size, () => 0)]]);
  assert.equal(labelAt(doc, onlyFar, { x: 0.55, y: 0.5 }), null); // a mask the map lacks covers nothing
  assert.equal(labelAt(withObjects([]), masks, { x: 0.5, y: 0.5 }), null);
});

test('labelAt gives a contained object over its container even when the container is nearer', () => {
  const size = { width: 8, height: 8 };
  const container = object(0, { bounds: box(0, 0, 2048, 1536), median: 0.9 });
  const inside = object(1, { bounds: box(512, 384, 512, 384), median: 0.1 });
  const masks = new Map<ObjectId, Plane<'u8'>>([
    [container.id, plane(size, () => 255)],
    [inside.id, plane(size, (x, y) => (x >= 2 && x < 4 && y >= 2 && y < 4 ? 255 : 0))],
  ]);
  const doc = withObjects([container, inside]);
  assert.equal(labelAt(doc, masks, { x: 3 / 8, y: 3 / 8 }), inside.id);
  assert.equal(labelAt(doc, masks, { x: 7 / 8, y: 7 / 8 }), container.id);
});

// ---------------------------------------------------------------------------
// holeMask

/** holeMask by brute force: maskCovers at every output texel's center, then every texel within the disc's radius of a covered one. */
function referenceHole(doc: SceneDocument, masks: ReadonlyMap<ObjectId, Plane<'u8'>>, size: Size): Uint8Array {
  const { width, height } = size;
  const union = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = { x: (x + 0.5) / width, y: (y + 0.5) / height };
      if (doc.objects.some((o) => { const mask = masks.get(o.id); return mask !== undefined && maskCovers(mask, at); })) union[y * width + x] = 1;
    }
  }
  const radius = Math.ceil(Math.max(width, height) / 100);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      search: for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height || dx * dx + dy * dy > radius * radius) continue;
          if (union[sy * width + sx] === 1) {
            out[y * width + x] = 255;
            break search;
          }
        }
      }
    }
  }
  return out;
}

/** A soft-edged ellipse: 255 inside, falling to 0 across its rim. */
function ellipse(size: Size, cx: number, cy: number, rx: number, ry: number): Plane<'u8'> {
  return plane(size, (x, y) => {
    const r = Math.hypot((x + 0.5 - cx * size.width) / (rx * size.width), (y + 0.5 - cy * size.height) / (ry * size.height));
    return Math.max(0, Math.min(255, Math.round((1.2 - r) * 5 * 255)));
  });
}

function ellipseScene(maskSizes: readonly Size[]): { doc: SceneDocument; masks: Map<ObjectId, Plane<'u8'>> } {
  const placements = [
    [0.3, 0.4, 0.15, 0.2],
    [0.7, 0.6, 0.1, 0.25],
    [0.5, 0.15, 0.3, 0.06],
    [0.05, 0.9, 0.12, 0.12],
  ] as const;
  const objects = maskSizes.map((_, n) => object(n, { bounds: box(n * 300, 0, 200, 200), median: n / 4 }));
  const masks = new Map<ObjectId, Plane<'u8'>>();
  maskSizes.forEach((size, n) => {
    const [cx, cy, rx, ry] = placements[n % placements.length] ?? placements[0];
    const id = objects[n]?.id;
    if (id !== undefined) masks.set(id, ellipse(size, cx, cy, rx, ry));
  });
  return { doc: withObjects(objects), masks };
}

test('holeMask is the union by the bilinear rule at each output texel center, dilated by a disc of 1% of the long edge', () => {
  const { doc, masks } = ellipseScene([
    { width: 64, height: 48 },
    { width: 37, height: 29 },
    { width: 157, height: 83 },
    { width: 420, height: 300 },
  ]);
  for (const size of [
    { width: 157, height: 83 },
    { width: 420, height: 300 },
    { width: 64, height: 48 },
  ]) {
    const hole = holeMask(doc, masks, size);
    assert.equal(hole.format, 'u8');
    assert.deepEqual(hole.size, size);
    const expected = referenceHole(doc, masks, size);
    const covered = expected.filter((v) => v === 255).length;
    assert.ok(covered > 0 && covered < size.width * size.height, `${size.width} x ${size.height}: a hole that is neither empty nor everything`);
    assert.deepEqual(hole.data, expected, `${size.width} x ${size.height}`);
  }
});

test('holeMask rounds the dilation radius up to whole texels and grows by a disc', () => {
  const count = (size: Size): number => {
    // One covered texel at the mask's own size, which reads exactly at its own center.
    const single = object(0, { bounds: box(0, 0, 10, 10), median: 0.5 });
    const cx = Math.floor(size.width / 2);
    const cy = Math.floor(size.height / 2);
    const masks = new Map([[single.id, plane(size, (x, y) => (x === cx && y === cy ? 255 : 0))]]);
    return holeMask(withObjects([single]), masks, size).data.filter((v) => v === 255).length;
  };
  assert.equal(count({ width: 300, height: 20 }), 29); // radius 3: the 29 lattice points of a disc of radius 3
  assert.equal(count({ width: 301, height: 20 }), 49); // 3.01 rounds up to 4: 49 lattice points
  assert.equal(count({ width: 20, height: 100 }), 5); // radius 1: the texel and its four neighbors
});

test('holeMask of no objects, or of objects whose masks are absent, is empty', () => {
  const size = { width: 50, height: 40 };
  assert.ok(holeMask(minimalDocument(), new Map(), size).data.every((v) => v === 0));
  assert.ok(holeMask(fiveClusterDocument(), new Map(), size).data.every((v) => v === 0));
});

test('holeMask over four master-size masks at 2048 x 1536 runs in under two seconds', () => {
  const master = { width: 2048, height: 1536 };
  const { doc, masks } = ellipseScene([master, master, master, master]);
  holeMask(doc, masks, { width: 64, height: 48 }); // warm the functions up
  const runs = 3;
  const times: number[] = [];
  let covered = 0;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const hole = holeMask(doc, masks, master);
    times.push(performance.now() - start);
    covered = hole.data.filter((v) => v === 255).length;
  }
  const best = Math.min(...times);
  console.log(`holeMask 2048 x 1536, four masks: ${times.map((t) => t.toFixed(0)).join(', ')} ms (best ${best.toFixed(0)} ms), ${covered} texels in the hole`);
  assert.ok(covered > 0);
  // A bound against a quadratic dilation or sampling, loose enough for a machine busy with the rest of npm test.
  assert.ok(best < 2000, `best of ${runs}: ${best.toFixed(0)} ms`);
});

// ---------------------------------------------------------------------------
// plateNeeded

const moving: ObjectMotion = { kind: 'wobble', amount: 0.5 };

function plateScene(spec: { readonly enabled: boolean; readonly orbit: number; readonly motion: ObjectMotion; readonly plate: 'none' | 'current' | 'stale' }): SceneDocument {
  const objects = [object(1, { bounds: box(0, 0, 10, 10), median: 0.5, motion: spec.motion }), object(0, { bounds: box(50, 0, 10, 10), median: 0.6 })];
  const doc = withObjects(objects);
  const forMasks = spec.plate === 'current' ? sortedMasks(doc) : [assetId(0x300)];
  return {
    ...doc,
    motion: { ...doc.motion, enabled: spec.enabled, orbit: spec.orbit },
    analysis: { ...doc.analysis, plate: spec.plate === 'none' ? null : plateProduct(0, forMasks) },
  };
}

test('no plate is needed without objects, without anything moving, or when forMasks equals the sorted mask ids', () => {
  const noObjects = { ...minimalDocument(), motion: { enabled: true, orbit: 1, loopSeconds: 3, focus: null } };
  assert.equal(plateNeeded(noObjects), false);
  assert.equal(plateNeeded(plateScene({ enabled: false, orbit: 1, motion: { kind: 'none' }, plate: 'none' })), false, 'motion off, no object motion');
  assert.equal(plateNeeded(plateScene({ enabled: true, orbit: 0, motion: { kind: 'none' }, plate: 'none' })), false, 'orbit 0, no object motion');
  assert.equal(plateNeeded(plateScene({ enabled: true, orbit: 1, motion: moving, plate: 'current' })), false, 'forMasks current');
  assert.equal(plateNeeded(plateScene({ enabled: true, orbit: 0, motion: moving, plate: 'current' })), false, 'forMasks current, object motion');
});

test('with motion off no plate is needed, whatever motion an object keeps', () => {
  for (const plate of ['none', 'stale'] as const) {
    for (const kind of ['wobble', 'bob', 'sway'] as const) {
      for (const orbit of [0, 1]) {
        assert.equal(plateNeeded(plateScene({ enabled: false, orbit, motion: { kind, amount: 1 }, plate })), false, `${kind}, orbit ${orbit}, plate ${plate}`);
      }
    }
  }
});

test('a plate is needed with objects, something moving, and a missing or stale plate', () => {
  for (const plate of ['none', 'stale'] as const) {
    assert.equal(plateNeeded(plateScene({ enabled: true, orbit: 0.6, motion: { kind: 'none' }, plate })), true, `orbit above 0, plate ${plate}`);
    assert.equal(plateNeeded(plateScene({ enabled: true, orbit: 0, motion: moving, plate })), true, `orbit 0 and object motion, plate ${plate}`);
    for (const kind of ['wobble', 'bob', 'sway'] as const) {
      assert.equal(plateNeeded(plateScene({ enabled: true, orbit: 0, motion: { kind, amount: 0.1 }, plate })), true, `${kind}, plate ${plate}`);
    }
  }
  // The five-cluster fixture's plate was made for its two masks, sorted.
  assert.equal(plateNeeded(fiveClusterDocument()), false);
  const doc = fiveClusterDocument();
  const [first, second] = doc.objects;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(plateNeeded({ ...doc, objects: [second, first] }), false, 'object order does not matter');
  assert.equal(plateNeeded({ ...doc, objects: [first] }), true, 'one mask removed');
});

// ---------------------------------------------------------------------------
// anchorDisparity

test('anchorDisparity falls back from focus to the subject, the frame, and null', () => {
  const subject = object(0, { bounds: box(0, 0, 10, 10), median: 0.7, subject: true });
  const other = object(1, { bounds: box(0, 0, 10, 10), median: 0.2 });
  const depth = depthProduct(0, { p10: 0.1, median: 0.35, p90: 0.9 });
  const base: SceneDocument = { ...withObjects([other, subject]), analysis: { ...fiveClusterDocument().analysis, depth } };
  assert.equal(anchorDisparity({ ...base, motion: { ...base.motion, focus: 0.5 } }), 0.5);
  assert.equal(anchorDisparity({ ...base, motion: { ...base.motion, focus: 0 } }), 0, 'a focus of 0 is a focus');
  const unfocused = { ...base, motion: { ...base.motion, focus: null } };
  assert.equal(anchorDisparity(unfocused), 0.7, "the subject's median");
  const subjectWithoutDepth = withObjects([other, object(0, { bounds: box(0, 0, 10, 10), median: null, subject: true })], unfocused);
  assert.equal(anchorDisparity(subjectWithoutDepth), 0.35, "the frame's median when the subject has no depth");
  assert.equal(anchorDisparity(withObjects([other], unfocused)), 0.35, "the frame's median with no subject");
  assert.equal(anchorDisparity({ ...unfocused, objects: [], analysis: { ...unfocused.analysis, depth: null } }), null);
  assert.equal(anchorDisparity(minimalDocument()), null);
});

// ---------------------------------------------------------------------------
// assetRefs

/** A plate's forMasks names mask ids for comparison; it is the one AssetId field that is not a reference. */
const NOT_REFERENCES = new Set(['analysis.plate.forMasks[]']);

/** The JSON Schema keywords customPaths follows into subschemas. */
const FOLLOWED = new Set(['properties', 'items', 'prefixItems', 'anyOf', 'oneOf', 'allOf']);

/** True when `value` is, or is a list holding, a JSON object: something a keyword the walk does not follow could hide a subschema in. */
function holdsObject(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsObject);
  return typeof value === 'object' && value !== null;
}

/**
 * Every schema path of a field zod checks with a custom check, which every id
 * of the document is: a JSON Schema node with no keys. The walk throws on a
 * reference or on any other keyword holding an object, such as a record's
 * `additionalProperties` schema, so no subschema is passed over silently.
 */
function customPaths(node: unknown, path: string, out: Set<string>): Set<string> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out;
  const record: Record<string, unknown> = { ...node };
  if (Object.keys(record).length === 0) out.add(path);
  for (const [keyword, value] of Object.entries(record)) {
    if (keyword === '$ref' || (!FOLLOWED.has(keyword) && holdsObject(value))) {
      throw new Error(`the walk does not follow ${keyword} at ${path === '' ? 'the root' : path}; extend customPaths and concrete for it`);
    }
  }
  const { properties, items, prefixItems, anyOf, oneOf, allOf } = record;
  if (typeof properties === 'object' && properties !== null) {
    for (const [key, child] of Object.entries(properties)) customPaths(child, path === '' ? key : `${path}.${key}`, out);
  }
  customPaths(items, `${path}[]`, out);
  for (const list of [prefixItems, anyOf, oneOf, allOf]) {
    if (Array.isArray(list)) for (const child of list) customPaths(child, list === prefixItems ? `${path}[]` : path, out);
  }
  return out;
}

/** The concrete key paths in `json` that a schema path names, `[]` standing for every element. */
function concrete(json: unknown, schemaPath: string): readonly (readonly Key[])[] {
  const steps = schemaPath.replaceAll('[]', '.[]').split('.').filter((step) => step !== '');
  let paths: (readonly Key[])[] = [[]];
  for (const step of steps) {
    paths = paths.flatMap((p) => {
      const here = getAt(json, p);
      if (step !== '[]') return here !== undefined && here !== null ? [[...p, step]] : [];
      return Array.isArray(here) ? here.map((_, i) => [...p, i]) : [];
    });
  }
  return paths.filter((p) => getAt(json, p) !== undefined && getAt(json, p) !== null);
}

test('assetRefs lists every asset the five-cluster fixture references and misses none', () => {
  const doc = fiveClusterDocument();
  assert.deepEqual(
    [...assetRefs(doc)].sort(),
    [0x10, 0x11, 0x20, 0x21, 0x31, 0x32].map(assetId).sort(),
    'the source, the master, the depth map, the plate, and both masks',
  );
  assert.deepEqual([...assetRefs(minimalDocument())], [assetId(1)], 'the master alone');
});

test('the schema walk refuses a keyword that can hold a subschema it does not follow', () => {
  const record = z.toJSONSchema(z.strictObject({ plates: z.record(z.string(), z.strictObject({ asset: z.string() })) }));
  assert.throws(() => customPaths(record, '', new Set()), /does not follow (propertyNames|additionalProperties) at plates/);
  const values = { properties: { plates: { type: 'object', additionalProperties: { properties: { asset: {} } } } } };
  assert.throws(() => customPaths(values, '', new Set()), /does not follow additionalProperties at plates/);
  assert.throws(() => customPaths({ properties: { a: { $ref: '#/$defs/x' } } }, '', new Set()), /does not follow \$ref at a/);
  assert.doesNotThrow(() => customPaths(z.toJSONSchema(currentDocumentSchema, { unrepresentable: 'any' }), '', new Set()));
});

test('every AssetId field the schema declares is either read by assetRefs or named as not a reference', () => {
  const doc = fiveClusterDocument();
  const ids = customPaths(z.toJSONSchema(currentDocumentSchema, { unrepresentable: 'any' }), '', new Set());
  assert.ok(ids.has('frame.master.asset') && ids.has('objects[].produced.mask.asset'), `the walk finds the id fields: ${[...ids].join(', ')}`);
  const assetPaths = new Set<string>();
  const referenced = new Set<AssetId>();
  for (const schemaPath of ids) {
    const instances = concrete(doc, schemaPath);
    // A field the fixture leaves null or empty would hide from this check, so the fixture must hold every one.
    assert.ok(instances.length > 0, `the five-cluster fixture holds a value at ${schemaPath}`);
    for (const path of instances) {
      const value = getAt(doc, path);
      if (typeof value !== 'string' || !isAssetId(value)) continue;
      assetPaths.add(schemaPath);
      if (!NOT_REFERENCES.has(schemaPath)) referenced.add(value);
    }
  }
  assert.deepEqual(
    [...assetPaths].sort(),
    [
      'analysis.depth.map.asset',
      'analysis.plate.forMasks[]',
      'analysis.plate.image.asset',
      'frame.master.asset',
      'frame.source.asset',
      'objects[].produced.mask.asset',
    ],
    'a new AssetId field is added to assetRefs, or to NOT_REFERENCES with the reason',
  );
  assert.deepEqual([...assetRefs(doc)].sort(), [...referenced].sort());
});
