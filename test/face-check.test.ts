import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFace, FACE_ROWS } from '../src/analysis/face-check.ts';

test('decoder retains detector score, bounded box and clipping evidence', () => {
  const scores = new Float32Array(FACE_ROWS * 2), boxes = new Float32Array(FACE_ROWS * 4);
  scores[1] = .95; boxes.set([-.1, .2, .6, .7]);
  const result = decodeFace({ scores: { dims: [1, FACE_ROWS, 2], data: scores }, boxes: { dims: [1, FACE_ROWS, 4], data: boxes } });
  assert.ok(result.ok && result.value !== null);
  assert.equal(result.value.clipped, true); assert.equal(result.value.box?.x0, 0);
  assert.ok(Math.abs((result.value.confidence ?? 0) - .95) < 1e-6);
  assert.equal(result.value.candidates?.length, 1);
});
