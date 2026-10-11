import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apertureFromRect, containedImageRect, constrainEye, createPerspectiveGeometry, inverseSource, lateralEnvelope,
  perspectiveFactor, projectPoint, projectSource, reconstructPoint, sourceToScreen,
  type PerspectiveGeometry,
} from '../src/core/perspective.ts';

const close = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
};
const make = (patch: Partial<PerspectiveGeometry> = {}): PerspectiveGeometry => createPerspectiveGeometry({
  aperture: { center: { x: 0, y: 0 }, width: 1, height: .75 }, crop: .04,
  neutralDistance: 1, nearFactor: 1.1, farFactor: 2, ...patch,
});

test('CSS aperture uses one viewport-width unit and preserves off-center and portrait geometry', () => {
  assert.deepEqual(apertureFromRect({ x: 100, y: 50, width: 400, height: 600 }, { width: 1000, height: 800 }),
    { center: { x: -.2, y: .05 }, width: .4, height: .6 });
  assert.deepEqual(apertureFromRect({ x: 200, y: 100, width: 800, height: 400 }, { width: 1200, height: 800 }),
    { center: { x: 0, y: 1 / 12 }, width: 2 / 3, height: 1 / 3 });
});

test('neutral reconstruction preserves the declared crop for every depth and off-center aperture', () => {
  for (const aperture of [
    { center: { x: 0, y: 0 }, width: 1, height: .75 },
    { center: { x: .3, y: -.2 }, width: .35, height: .7 },
  ]) for (const crop of [0, .04, .12]) {
    const geometry = make({ aperture, crop });
    const eye = { x: 0, y: 0, z: geometry.neutralDistance };
    for (const d of [0, .1, .5, .9, 1]) for (const u of [crop, .5, 1 - crop]) for (const v of [crop, .5, 1 - crop]) {
      const actual = projectSource({ x: u, y: v }, d, geometry, eye);
      close(actual.x, aperture.center.x + (u - .5) * aperture.width / (1 - 2 * crop));
      close(actual.y, aperture.center.y + (.5 - v) * aperture.height / (1 - 2 * crop));
    }
    const corner = projectSource({ x: crop, y: crop }, .73, geometry, eye);
    close(corner.x, aperture.center.x - aperture.width / 2);
    close(corner.y, aperture.center.y + aperture.height / 2);
  }
});

test('ray reconstruction and non-neutral distance projection match hand-computed points', () => {
  const geometry = make({ crop: 0, nearFactor: 1, farFactor: 3, neutralDistance: 2 });
  assert.deepEqual(reconstructPoint({ x: .75, y: .5 }, .5, geometry), { x: .5, y: 0, z: -2 });
  const projected = projectPoint({ x: .5, y: 0, z: -2 }, { x: .3, y: -.6, z: 4 });
  close(projected.x, 13 / 30);
  close(projected.y, -.2);
  assert.deepEqual(projectPoint({ x: .12, y: -.2, z: 0 }, { x: 100, y: -100, z: .01 }), { x: .12, y: -.2 });
});

test('rightward eye travel moves behind-screen points right, with farther features moving more', () => {
  const geometry = make({ nearFactor: 1.25, farFactor: 2 });
  const eye = { x: .1, y: -.2, z: 1 };
  const uv = { x: .5, y: .5 };
  const near = projectSource(uv, 1, geometry, eye), far = projectSource(uv, 0, geometry, eye);
  close(near.x, .02); close(near.y, -.04);
  close(far.x, .05); close(far.y, -.1);
  let previous = Infinity;
  for (let i = 0; i <= 100; i++) {
    const projected = projectSource(uv, i / 100, geometry, eye);
    assert.ok(projected.x <= previous);
    previous = projected.x;
  }
});

test('flat disparity does not invent differential motion between different photo features', () => {
  const geometry = make(), neutral = { x: 0, y: 0, z: 1 }, eye = { x: .04, y: -.03, z: 1 };
  for (const depth of [0, .5, 1]) {
    const a = { x: .1, y: .2 }, b = { x: .75, y: .8 };
    const a0 = projectSource(a, depth, geometry, neutral), a1 = projectSource(a, depth, geometry, eye);
    const b0 = projectSource(b, depth, geometry, neutral), b1 = projectSource(b, depth, geometry, eye);
    close(a1.x - a0.x, b1.x - b0.x); close(a1.y - a0.y, b1.y - b0.y);
  }
  const plane = make({ nearFactor: 1, farFactor: 1 });
  assert.deepEqual(projectSource({ x: .2, y: .7 }, .4, plane, eye), sourceToScreen({ x: .2, y: .7 }, plane));
});

test('known-depth inverse roundtrips source UV across dimensions, offsets, eye distances and edge eyes', () => {
  for (const aperture of [
    { center: { x: 0, y: 0 }, width: 1, height: .75 },
    { center: { x: -.25, y: .12 }, width: .4, height: .8 },
  ]) {
    const geometry = make({ aperture });
    const envelope = lateralEnvelope(geometry);
    for (const x of [envelope.min.x, 0, envelope.max.x]) for (const y of [envelope.min.y, 0, envelope.max.y]) {
      for (const z of [.5, 1, 2]) for (const d of [0, .25, .5, 1]) for (const uv of [
        { x: 0, y: 0 }, { x: .17, y: .69 }, { x: 1, y: 1 },
      ]) {
        const eye = { x, y, z };
        const inverse = inverseSource(projectSource(uv, d, geometry, eye), d, geometry, eye);
        close(inverse.x, uv.x); close(inverse.y, uv.y);
      }
    }
  }
  assert.ok(inverseSource({ x: 10, y: 0 }, .5, make(), { x: 0, y: 0, z: 1 }).x > 1,
    'a point beyond the original image remains a miss');
});

test('lateral envelope covers all exterior edges for every depth and reaches the far-layer coverage limit', () => {
  for (const crop of [0, .02, .06]) for (const aperture of [
    { center: { x: 0, y: 0 }, width: 1, height: .75 },
    { center: { x: .28, y: -.14 }, width: .3, height: .7 },
  ]) {
    const geometry = make({ crop, aperture });
    const envelope = lateralEnvelope(geometry);
    const bound = aperture.width * crop / (1 - 2 * crop) * 2;
    close(envelope.max.x, bound);
    for (const x of [envelope.min.x, envelope.max.x]) for (const y of [envelope.min.y, envelope.max.y]) {
      for (let i = 0; i <= 100; i++) {
        const eye = { x, y, z: geometry.neutralDistance };
        const leftTop = projectSource({ x: 0, y: 0 }, i / 100, geometry, eye);
        const rightBottom = projectSource({ x: 1, y: 1 }, i / 100, geometry, eye);
        assert.ok(leftTop.x <= aperture.center.x - aperture.width / 2 + 1e-12);
        assert.ok(leftTop.y >= aperture.center.y + aperture.height / 2 - 1e-12);
        assert.ok(rightBottom.x >= aperture.center.x + aperture.width / 2 - 1e-12);
        assert.ok(rightBottom.y <= aperture.center.y - aperture.height / 2 + 1e-12);
      }
    }
    const beyond = projectSource({ x: 0, y: .5 }, 0, geometry, { x: envelope.max.x + .001, y: 0, z: 1 });
    assert.ok(beyond.x > aperture.center.x - aperture.width / 2);
    assert.deepEqual(constrainEye({ x: 1000, y: -1000 }, geometry), { x: envelope.max.x, y: envelope.min.y, z: 1 });
  }
});

test('finite interaction budgets also bound screen-plane-only scenes and narrower explicit travel', () => {
  const plane = make({ nearFactor: 1, farFactor: 1, crop: 0 });
  assert.deepEqual(lateralEnvelope(plane), { min: { x: -1, y: -.75 }, max: { x: 1, y: .75 } });
  assert.deepEqual(constrainEye({ x: -4, y: 4 }, plane, { x: .03, y: .02 }), { x: -.03, y: .02, z: 1 });
  assert.deepEqual(lateralEnvelope(make(), { x: 0, y: 0 }), { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
});

test('invalid and overflowing geometry, eye, source, and travel values are rejected', () => {
  for (const crop of [-.1, .5, 1, NaN, Infinity]) assert.throws(() => make({ crop }), RangeError);
  for (const neutralDistance of [0, -1, NaN, Infinity]) assert.throws(() => make({ neutralDistance }), RangeError);
  for (const nearFactor of [0, .99, NaN, Infinity, 3]) assert.throws(() => make({ nearFactor }), RangeError);
  assert.throws(() => make({ farFactor: .5 }), RangeError);
  assert.throws(() => make({ neutralDistance: Number.MAX_VALUE, farFactor: 2 }), RangeError);
  assert.throws(() => make({ aperture: { center: { x: Infinity, y: 0 }, width: 1, height: 1 } }), RangeError);
  assert.throws(() => apertureFromRect({ x: 0, y: 0, width: 0, height: 1 }, { width: 1, height: 1 }), RangeError);
  const geometry = make();
  for (const d of [-.1, 1.1, NaN, Infinity]) assert.throws(() => perspectiveFactor(d, geometry), RangeError);
  assert.throws(() => sourceToScreen({ x: -.01, y: .5 }, geometry), RangeError);
  assert.throws(() => reconstructPoint({ x: .5, y: NaN }, .5, geometry), RangeError);
  assert.throws(() => projectPoint({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 2 }), RangeError);
  assert.throws(() => projectPoint({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), RangeError);
  assert.throws(() => inverseSource({ x: NaN, y: 0 }, .5, geometry, { x: 0, y: 0, z: 1 }), RangeError);
  assert.throws(() => lateralEnvelope(geometry, { x: -1, y: 1 }), RangeError);
  assert.throws(() => constrainEye({ x: Infinity, y: 0 }, geometry), RangeError);
});


test('phone letterbox and desktop native aspect use the same actual image aperture as picking', () => {
  const phone = containedImageRect({ x: 0, y: 44, width: 390, height: 690 }, { width: 2048, height: 1536 });
  assert.deepEqual(phone, { x: 0, y: 242.75, width: 390, height: 292.5 });
  const aperture = apertureFromRect(phone, { width: 390, height: 844 });
  close(aperture.width, 1); close(aperture.height, .75);
  close(aperture.center.y, (422 - 389) / 390);
  assert.deepEqual(containedImageRect({ x: 200, y: 100, width: 800, height: 600 }, { width: 4, height: 3 }),
    { x: 200, y: 100, width: 800, height: 600 });
});
