# glyph-rule: the symbol ink and paper rule on the gradient fixture

> Owns: the round-4 arithmetic behind `design.md` section 10 Symbols (finding FRESH-3 in `reviews/round4.md`), and the round-5 arithmetic behind its density mapping (finding AUDIT-1 in `reviews/round5.md`).
> Does not own: the rule itself (`../../design.md`) or the renderer.

Run 2026-09-30 with Node 25: `node glyph.mjs` (exits by itself; output in `results.txt`).

Question: on a gray ramp with one neutral palette entry, how many glyph cells does each rule draw with ink equal to paper, and does `amount` 0 draw any glyph?

- Round-3 rule: a cell is a glyph when `abs(tone - 0.5) >= 0.5 (1 - amount)`; the ink is one band toward the nearer extreme, the paper is the cell's own band.
- Round-4 rule: a cell is a glyph when `amount > 0` and the same test holds; ink and paper are two adjacent bands, the ink being the one nearer the extreme.

Result (VERIFIED by arithmetic on the rules as written): at the default `bands` 4 and `amount` 0.3 the round-3 rule draws 82 glyph cells and all 82 have ink equal to paper; at `amount` 1 and `bands` 6, 179 of 256; at `amount` 0 it still draws 6.
The round-4 rule draws the same cells with ink different from paper in every case, and none at `amount` 0.
The ramp stands in for P5's gradient fixture; a photo's share of extreme-band cells is INFERRED.

## Round 5: the density mapping (AUDIT-1)

`node density.mjs` (output in `density.txt`) tallies which of the five glyphs each glyph cell of the ramp takes.
With absolute bins of the distance from mid-tone, the default `amount` 0.3 shows only `*` and `#`, because the slider's window covers only the outer 30% of the tone range.
With five equal bins over the slider's own window, every `amount` shows all five in order, sparsest at the window's inner edge and densest at the extreme, which is the mapping `design.md` section 10 commits.
An `always` cell whose tone lies inside the window's inner edge takes the sparsest glyph, and at `amount` 0 every `always` cell does.
The last line reruns the ink and paper check with seven gray entries, because round 5 removes the single neutral entry (FRESH-1): no glyph cell has ink equal to paper.
VERIFIED by arithmetic on the rules as written.
