// Throwaway (round 5, AUDIT-1 claim 2): which glyph each cell of the P5 gradient fixture takes under three readings of
// "glyph density ranks . - + * # by distance from the nearer extreme". Fixture: a gray ramp of 256 cells, tone 0..1.
// e = abs(tone - 0.5) is the cell's distance from mid-tone (0 at mid-tone, 0.5 at either extreme); the slider makes a cell a
// glyph when amount > 0 and e >= 0.5 (1 - amount), so the slider's window in e is [0.5 (1 - amount), 0.5], 0.5 * amount wide.
const GLYPHS = ['.', '-', '+', '*', '#'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const absolute = (e) => clamp(Math.floor(5 * (e / 0.5)), 0, 4);                                   // five equal bins of e over the whole tone range
const windowed = (e, amount) => amount > 0 ? clamp(Math.floor(5 * (e - 0.5 * (1 - amount)) / (0.5 * amount)), 0, 4) : 0;   // five equal bins over the slider's window; below it, the sparsest
function tally(amount, pick) {
  const n = [0, 0, 0, 0, 0];
  for (let i = 0; i < 256; i++) { const e = Math.abs(i / 255 - 0.5); if (amount > 0 && e >= 0.5 * (1 - amount)) n[pick(e, amount)]++; }
  return GLYPHS.map((g, k) => `${g} ${n[k]}`).join('  ');
}
for (const amount of [0.3, 0.6, 1]) {
  console.log(`amount ${amount}: absolute bins        ${tally(amount, absolute)}`);
  console.log(`amount ${amount}: window-relative bins ${tally(amount, windowed)}`);
}
for (const amount of [0, 0.3, 1]) {
  const at = (tone) => GLYPHS[windowed(Math.abs(tone - 0.5), amount)];
  console.log(`an 'always' cell at amount ${amount}: tone 0.50 -> ${at(0.5)}, tone 0.30 -> ${at(0.3)}, tone 0.10 -> ${at(0.1)}, tone 0.00 -> ${at(0)}`);
}
// Round 5 removes the single neutral entry (FRESH-1): a gray ramp now has several gray entries. The ink and paper rule is per
// entry, so the round-4 result must still hold: no glyph cell has ink equal to paper. Seven entries at equal spacing, bands 4.
{
  const entries = Array.from({ length: 7 }, (_, k) => (k + 0.5) / 7); const bands = 4; let glyphs = 0, invisible = 0;
  for (let i = 0; i < 256; i++) { const L = i / 255; const tone = clamp((L - 0.01) / 0.98, 0, 1); if (Math.abs(tone - 0.5) < 0.5 * (1 - 0.3)) continue;
    const entry = entries.reduce((a, b) => Math.abs(b - L) < Math.abs(a - L) ? b : a);
    const band = clamp(Math.floor(((L - entry) / 0.45 + 0.55) * bands), 0, bands - 1); const side = tone < 0.5 ? -1 : 1;
    const ink = side < 0 ? Math.max(band - 1, 0) : Math.min(band + 1, bands - 1); const paper = ink === band ? band - side : band;
    glyphs++; if (ink === paper || paper < 0 || paper > bands - 1) invisible++; }
  console.log(`seven gray entries, bands 4, amount 0.3: ${glyphs} glyph cells, ${invisible} with ink equal to paper`);
}
