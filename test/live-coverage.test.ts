import assert from 'node:assert/strict';
import test from 'node:test';
import { liveCoverage } from '../src/core/live-coverage.ts';
import { lateralEnvelope, projectSource, type PerspectiveGeometry } from '../src/core/perspective.ts';
import { assetId, minimalDocument } from './fixtures/documents.ts';
import { depthProduct } from './fixtures/products.ts';

const geometry: PerspectiveGeometry = { aperture: { center: { x: .1, y: -.05 }, width: .8, height: .6 }, crop: .04, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 };
const base = minimalDocument();
const doc = { ...base, frame: { ...base.frame, master: { ...base.frame.master, size: { width: 1600, height: 1200 } } }, analysis: { ...base.analysis, depth: depthProduct(1) } };
test('live coverage disc bounds analytical relative near/far sweep including diagonal extremes', () => {
  const coverage = liveCoverage(doc, geometry); assert.ok(coverage !== null);
  const envelope = lateralEnvelope(geometry);
  for (const x of [envelope.min.x, 0, envelope.max.x]) for (const y of [envelope.min.y, 0, envelope.max.y]) {
    const eye = { x, y, z: geometry.neutralDistance }, uv = { x: .5, y: .5 };
    const near = projectSource(uv, 1, geometry, eye), far = projectSource(uv, 0, geometry, eye);
    const dx = (near.x - far.x) * (1 - 2 * geometry.crop) / geometry.aperture.width * 1600;
    const dy = (near.y - far.y) * (1 - 2 * geometry.crop) / geometry.aperture.height * 1200;
    assert.ok(Math.hypot(dx, dy) + 2 <= coverage.radius + 1e-9);
  }
});
test('provenance invalidates photo/depth/geometry while style-only edits keep identity', () => {
  const original = liveCoverage(doc, geometry); assert.ok(original !== null);
  assert.equal(liveCoverage({ ...doc, style: { ...doc.style, grain: .5 } }, geometry)?.key, original.key);
  assert.notEqual(liveCoverage({ ...doc, frame: { ...doc.frame, master: { ...doc.frame.master, asset: assetId(9) } } }, geometry)?.key, original.key);
  assert.notEqual(liveCoverage({ ...doc, analysis: { ...doc.analysis, depth: depthProduct(2) } }, geometry)?.key, original.key);
  const smaller = liveCoverage(doc, { ...geometry, crop: .02 }); assert.ok(smaller !== null);
  assert.notEqual(smaller.key, original.key); assert.ok(smaller.radius < original.radius);
  assert.equal(liveCoverage(base, geometry), null);
});
