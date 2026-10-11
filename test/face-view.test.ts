import assert from 'node:assert/strict';
import test from 'node:test';
import { createFaceView, faceCaptureTransform, faceFromCapture, FACE_LATERAL_GAIN } from '../src/core/face-view.ts';

const face = (x = .5, y = .5, confidence = .95) => ({ center: { x, y }, size: .2, confidence });
function calibrated() {
  const view = createFaceView();
  for (let id = 0; id <= 6; id++) view.observe(face(), id * 70, id);
  return view;
}
test('wide video letterboxes vertically; inverse maps center and box before mirroring once', () => {
  const transform = faceCaptureTransform(1920, 1080);
  assert.deepEqual(transform, { width: 1920, height: 1080, x: 0, y: 30, drawWidth: 320, drawHeight: 180 });
  const result = faceFromCapture({ ...face(.25, .375), box: { x0: .2, x1: .3, y0: .3, y1: .45 } }, transform);
  assert.ok(result !== null && result.box !== undefined);
  assert.deepEqual(result.center, { x: .75, y: 1 / 3 });
  assert.equal(result.box.x0, .7); assert.equal(result.box.x1, .8);
  assert.ok(Math.abs(result.size - .2) < 1e-12);
});
test('portrait video letterboxes horizontally and inverts without stretching', () => {
  const transform = faceCaptureTransform(1080, 1920);
  assert.equal(transform.drawWidth, 135); assert.equal(transform.x, 92.5);
  const result = faceFromCapture(face((92.5 + .2 * 135) / 320, .4), transform);
  assert.ok(result !== null); assert.ok(Math.abs(result.center.x - .8) < 1e-12); assert.equal(result.center.y, .4);
  assert.equal(faceFromCapture(face(.1, .5), transform), null);
});
test('clipped face and box crossing the actual video aperture cannot drive the view', () => {
  const transform = faceCaptureTransform(1920, 1080);
  assert.equal(faceFromCapture({ ...face(), clipped: true }, transform), null);
  assert.equal(faceFromCapture({ ...face(), box: { x0: .4, x1: .6, y0: .05, y1: .6 } }, transform), null);
  assert.throws(() => faceCaptureTransform(0, 100));
});
test('calibration requires stable high-confidence samples spanning time, not one frame', () => {
  const view = createFaceView();
  assert.equal(view.observe(face(.5, .5, .7), 0, 0)?.state, 'lost');
  for (let id = 1; id <= 5; id++) assert.equal(view.observe(face(.5 + id % 2 * .002), id * 70, id)?.state, 'calibrating');
  assert.equal(view.observe(face(.5), 420, 6)?.state, 'tracking');
});
test('calibrated travel uses named lateral gain and does not drift while held', () => {
  const view = calibrated();
  const expected = .5 + .1 * FACE_LATERAL_GAIN;
  for (let id = 7; id < 100; id++) {
    const sample = view.observe(face(.6), id * 70, id);
    assert.equal(sample?.state, 'tracking'); assert.ok(Math.abs((sample?.center.x ?? 0) - expected) < 1e-12);
  }
});
test('small face noise stays bounded after a robust neutral estimate', () => {
  const view = calibrated();
  let square = 0;
  for (let id = 7; id < 107; id++) {
    const sample = view.observe(face(.5 + Math.sin(id) * .001), id * 70, id);
    square += ((sample?.center.x ?? 0) - .5) ** 2;
  }
  assert.ok(Math.sqrt(square / 100) < .0015);
});
test('loss retains the last view with an explicit lost state and rejects abrupt viewer takeover', () => {
  const view = calibrated();
  const moved = view.observe(face(.6), 490, 7);
  const lost = view.observe(null, 560, 8);
  assert.equal(lost?.state, 'lost'); assert.deepEqual(lost?.center, moved?.center);
  assert.equal(view.observe(face(.2), 630, 9)?.state, 'lost');
  assert.equal(view.observe({ ...face(.6), size: .4 }, 700, 10)?.state, 'lost');
  assert.equal(view.observe(face(.59), 770, 11)?.state, 'tracking');
});
test('recenter resets viewer association and requires fresh stable calibration', () => {
  const view = calibrated(); view.recenter();
  assert.equal(view.observe(face(.2), 490, 7)?.state, 'calibrating');
  for (let id = 8; id <= 12; id++) view.observe(face(.2), id * 70, id);
  assert.deepEqual(view.observe(face(.2), 910, 13)?.center, { x: .5, y: .5 });
});
test('obsolete capture timestamps and sample ids cannot replace new observations', () => {
  const view = calibrated();
  assert.equal(view.observe(face(.7), 10, 8), null);
  assert.equal(view.observe(face(.7), 500, 6), null);
  assert.equal(view.observe(face(.55), 500, 7)?.capturedAt, 500);
});
test('a capture gap cannot turn sparse observations into a stable calibration window', () => {
  const view = createFaceView();
  for (const [id, at] of [0, 70, 140, 10_000].entries()) assert.equal(view.observe(face(), at, id)?.state, 'calibrating');
});
test('association keeps a smaller acquired viewer when a larger passerby enters', () => {
  const view = calibrated();
  const viewer = face(.51), passerby = { ...face(.8), size: .4 };
  assert.equal(view.select([passerby, viewer]), viewer);
  assert.equal(view.select([passerby]), null);
  view.recenter(); assert.equal(view.select([passerby, viewer]), passerby);
});
