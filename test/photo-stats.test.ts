import assert from 'node:assert/strict';
import { test } from 'node:test';
import { srgbToOklab } from '../src/core/color.ts';
import { analysisSchema } from '../src/core/schema.ts';
import { photoStats } from '../src/photo/stats.ts';

function fixture(colors: readonly { readonly rgb: readonly number[]; readonly count: number }[]) {
  const width = colors.reduce((sum, color) => sum + color.count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const color of colors) for (let i = 0; i < color.count; i++) {
    data.set([color.rgb[0] ?? 0, color.rgb[1] ?? 0, color.rgb[2] ?? 0, 255], offset);
    offset += 4;
  }
  return { data, width, height: 1 };
}

test('three flat regions produce their weighted colors deterministically', () => {
  const input = fixture([{ rgb: [255, 0, 0], count: 500 }, { rgb: [0, 255, 0], count: 300 }, { rgb: [0, 0, 255], count: 200 }]);
  const { colors, tone } = photoStats(input, 123456);
  const stats = analysisSchema.parse({ colors, tone, depth: null, plate: null, autoSubject: 'pending' });
  assert.deepEqual({ colors: stats.colors, tone: stats.tone }, photoStats(input, 123456));
  assert.equal(stats.colors.length, 3);
  const expected = [{ rgb: { r: 1, g: 0, b: 0 }, weight: 0.5 }, { rgb: { r: 0, g: 1, b: 0 }, weight: 0.3 }, { rgb: { r: 0, g: 0, b: 1 }, weight: 0.2 }];
  expected.forEach((entry, i) => {
    const cluster = stats.colors[i];
    assert.ok(cluster !== undefined);
    assert.ok(Math.abs(cluster.weight - entry.weight) < 0.02);
    const lab = srgbToOklab(entry.rgb);
    assert.ok(Math.hypot(cluster.lab.L - lab.L, cluster.lab.a - lab.a, cluster.lab.b - lab.b) < 0.01);
  });
  assert.ok(stats.tone.p01 <= stats.tone.p05 && stats.tone.p05 <= stats.tone.p50 && stats.tone.p50 <= stats.tone.p95 && stats.tone.p95 <= stats.tone.p99);
});
test('one color has one nonzero cluster and constant lightness percentiles', () => {
  const { colors, tone } = photoStats(fixture([{ rgb: [255, 255, 255], count: 100 }]), 0);
  const stats = analysisSchema.parse({ colors, tone, depth: null, plate: null, autoSubject: 'pending' });
  assert.equal(stats.colors.length, 1);
  assert.equal(stats.colors[0]?.weight, 1);
  for (const value of Object.values(stats.tone)) assert.ok(Math.abs(value - 1) < 1e-4);
});
test('a varied thumbnail caps clusters at 16 and normalizes weights', () => {
  const image = fixture(Array.from({ length: 64 }, (_, i) => ({ rgb: [i * 4, 255 - i * 4, (i * 17) % 256], count: i + 1 })));
  const { colors, tone } = photoStats(image, 0xffffffff);
  const stats = analysisSchema.parse({ colors, tone, depth: null, plate: null, autoSubject: 'pending' });
  assert.equal(stats.colors.length, 16);
  assert.deepEqual({ colors: stats.colors, tone: stats.tone }, photoStats(image, 0xffffffff));
});
