import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFaceReply } from '../src/analysis/protocol.ts';

const basic = { center: { x: .5, y: .5 }, size: .2 };
const reply = (face: unknown) => parseFaceReply({ type: 'tracked', jobId: 1, face });
test('face boundary preserves legacy fixtures and validates optional detector evidence', () => {
  assert.equal(reply(basic).ok, true);
  assert.equal(reply({ ...basic, confidence: .92, clipped: false, box: { x0: .4, y0: .4, x1: .6, y1: .6 } }).ok, true);
  assert.equal(reply({ ...basic, confidence: 1.2 }).ok, false);
  assert.equal(reply({ ...basic, box: { x0: .7, y0: .4, x1: .6, y1: .6 } }).ok, false);
  assert.equal(reply({ ...basic, box: { x0: -.1, y0: .4, x1: .6, y1: .6 } }).ok, false);
  assert.equal(reply({ ...basic, candidates: [basic] }).ok, true);
  assert.equal(reply({ ...basic, candidates: Array.from({ length: 9 }, () => basic) }).ok, false);
  assert.equal(reply({ ...basic, candidates: [{ ...basic, confidence: -1 }] }).ok, false);
});
