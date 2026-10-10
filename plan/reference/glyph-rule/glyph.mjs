// Throwaway (round 4, FRESH-3): evaluates the round-3 glyph rule and the round-4 rule on the P5 gradient fixture by arithmetic.
// Fixture: a gray ramp of 256 cells, lightness 0..1, one neutral palette entry. Rules quoted from design.md section 10.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function run({ bands, amount, entryL, label }) {
  const cells = Array.from({ length: 256 }, (_, i) => i / 255);
  const p01 = 0.01, p99 = 0.99;
  const band = (L) => clamp(Math.floor(((L - entryL) / 0.45 + 0.55) * bands), 0, bands - 1);
  const tone = (L) => clamp((L - p01) / (p99 - p01), 0, 1);
  let old = { glyphs: 0, invisible: 0 }, neu = { glyphs: 0, invisible: 0 };
  for (const L of cells) {
    const t = tone(L), b = band(L), side = t < 0.5 ? -1 : 1;
    // round 3: glyph when abs(tone - 0.5) >= 0.5 (1 - amount); ink = one band toward the extreme, paper = the cell's own variant
    if (Math.abs(t - 0.5) >= 0.5 * (1 - amount)) { old.glyphs++; const ink = clamp(b + side, 0, bands - 1); if (ink === b) old.invisible++; }
    // round 4: glyph when amount > 0 and the same test; ink and paper are adjacent bands, ink the one nearer the extreme
    if (amount > 0 && Math.abs(t - 0.5) >= 0.5 * (1 - amount)) { neu.glyphs++; const ink = side < 0 ? Math.max(b - 1, 0) : Math.min(b + 1, bands - 1); const paper = ink - side; if (ink === paper || paper < 0 || paper > bands - 1) neu.invisible++; }
  }
  console.log(`${label}: bands ${bands}, amount ${amount}, entry L ${entryL} | round 3: ${old.glyphs} glyph cells, ${old.invisible} with ink equal to paper | round 4: ${neu.glyphs} glyph cells, ${neu.invisible} with ink equal to paper`);
}
run({ bands: 4, amount: 0.3, entryL: 0.5, label: 'default symbols' });
run({ bands: 3, amount: 0.3, entryL: 0.5, label: 'fry 1 bands' });
run({ bands: 6, amount: 1, entryL: 0.5, label: 'every cell' });
run({ bands: 2, amount: 0.5, entryL: 0.5, label: 'minimum bands' });
run({ bands: 4, amount: 0, entryL: 0.5, label: 'amount 0' });
