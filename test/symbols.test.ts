import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_SIZE, GLYPHS, cellGrid, glyphAtlas, glyphDistance, normalizedTone, symbolDecision } from '../src/render/symbols.ts';

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
// These are glyph.mjs and density.mjs's own 256-cell ramps, not image samples.
function inkFixture(bands: number, amount: number, entries = [0.5]) {
  let glyphs = 0, invisible = 0;
  for (let i = 0; i < 256; i++) {
    const L = i / 255;
    const entry = entries.reduce((a, b) => Math.abs(b - L) < Math.abs(a - L) ? b : a);
    const band = clamp(Math.floor(((L - entry) / 0.45 + 0.55) * bands), 0, bands - 1);
    const d = symbolDecision({ tone: normalizedTone(L, 0.01, 0.99), band, bands, amount, mode: 'slider' });
    if (d.glyphIndex < 0) continue;
    glyphs++;
    if (d.inkBand === d.paperBand || d.paperBand < 0 || d.paperBand >= bands) invisible++;
  }
  return { glyphs, invisible };
}

test('glyph-rule recorded ink/paper fixture counts, including seven gray entries', () => {
  assert.deepEqual(inkFixture(4, 0.3), { glyphs: 82, invisible: 0 });
  assert.deepEqual(inkFixture(3, 0.3), { glyphs: 82, invisible: 0 });
  assert.deepEqual(inkFixture(6, 1), { glyphs: 256, invisible: 0 });
  assert.deepEqual(inkFixture(2, 0.5), { glyphs: 132, invisible: 0 });
  assert.deepEqual(inkFixture(4, 0), { glyphs: 0, invisible: 0 });
  assert.deepEqual(inkFixture(4, 0.3, Array.from({ length: 7 }, (_, k) => (k + 0.5) / 7)), { glyphs: 82, invisible: 0 });
});

test('density fixture uses five equal bins of the slider window', () => {
  const fixtures = [[0.3, [16, 16, 14, 16, 16]], [0.6, [30, 32, 30, 30, 32]], [1, [52, 50, 50, 52, 52]]] satisfies readonly (readonly [number, readonly number[]])[];
  for (const [amount, expected] of fixtures) {
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 256; i++) {
      const { glyphIndex } = symbolDecision({ tone: i / 255, band: 2, bands: 4, amount, mode: 'slider' });
      if (glyphIndex >= 0) counts[glyphIndex] = (counts[glyphIndex] ?? 0) + 1;
    }
    assert.deepEqual(counts, expected);
  }
});

test('always/never modes, tonal boundary and adjacent bands across every band count', () => {
  assert.deepEqual(GLYPHS, ['.', '-', '+', '*', '#']);
  for (const amount of [0, 0.3, 1]) for (const tone of [0, 0.1, 0.3, 0.5, 0.7, 1]) {
    assert.equal(symbolDecision({ tone, band: 1, bands: 4, amount, mode: 'never' }).glyphIndex, -1);
    const always = symbolDecision({ tone, band: 1, bands: 4, amount, mode: 'always' });
    assert.ok(always.glyphIndex >= 0);
    if (amount === 0 || Math.abs(tone - 0.5) < 0.5 * (1 - amount)) assert.equal(always.glyphIndex, 0);
  }
  for (let bands = 2; bands <= 6; bands++) for (let band = 0; band < bands; band++) for (const tone of [0, 0.5, 1]) {
    const d = symbolDecision({ tone, band, bands, amount: 1, mode: 'slider' });
    assert.equal(d.inkBand - d.paperBand, tone < 0.5 ? -1 : 1);
    assert.ok(d.inkBand >= 0 && d.inkBand < bands && d.paperBand >= 0 && d.paperBand < bands);
    assert.equal(d.paperBand === band || d.inkBand === band, true);
  }
  assert.equal(normalizedTone(-1, 0.01, 0.99), 0);
  assert.equal(normalizedTone(2, 0.01, 0.99), 1);
  assert.equal(normalizedTone(0.5, 0.5, 0.5), 0);
});

test('centered grid covers all pixel centers once, including partial and odd-size edges', () => {
  for (const [width, height] of [[2048, 1536], [13, 17], [1, 1], [24, 24]]) for (const size of [6, 12, 24, 48]) {
    if (width === undefined || height === undefined) throw new Error('Missing fixture dimension.');
    const grid = cellGrid(width, height, size);
    for (const [extent, origin, count] of [[width, grid.originX, grid.width], [height, grid.originY, grid.height]]) {
      if (extent === undefined || origin === undefined || count === undefined) throw new Error('Missing grid dimension.');
      const center = Math.round((extent / 2 - size / 2 - origin) / size);
      assert.equal(origin + (center + 0.5) * size, extent / 2);
      for (let p = 0; p < extent; p++) {
        const cell = Math.floor((p + 0.5 - origin) / size);
        assert.ok(cell >= 0 && cell < count);
        const first = Math.ceil(origin - 0.5) + cell * size;
        assert.ok(p >= first && p < first + size);
      }
    }
  }
});

test('procedural atlas is deterministic with bounded, symmetric signed distances', () => {
  const atlas = glyphAtlas();
  assert.equal(atlas.length, 5 * ATLAS_SIZE * ATLAS_SIZE);
  assert.deepEqual(glyphAtlas(), atlas);
  for (let glyph = 0; glyph < 5; glyph++) {
    assert.ok(glyphDistance(glyph, 0.49, 0.49) > 0);
    assert.ok(glyphDistance(glyph, 0.14, 0) < 0 || glyph === 0);
    for (const [x, y] of [[0, 0], [0.12, 0.07], [0.4, 0.2]]) {
      if (x === undefined || y === undefined) throw new Error('Missing distance coordinate.');
      assert.ok(Math.abs(glyphDistance(glyph, x, y) - glyphDistance(glyph, -x, -y)) < 1e-12);
    }
  }
  assert.ok(glyphDistance(0, 0, 0) < 0);
  // Even-size pixel centers are half a pixel from the geometric center.
  // The default-size dot must contain an ink interior after 1px AA.
  assert.ok(glyphDistance(0, 0.5 / 12, 0.5 / 12) < -0.5 / 12);
  assert.ok(glyphDistance(4, 0, 0) > 0);
});
