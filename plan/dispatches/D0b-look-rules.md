# D0b: the look, distilled from the design (read-only)

Your sandbox is read-only: do not modify any file and do not try to.
Your final message IS the deliverable; the CLI saves it to `plan/evidence/look-rules.md`.
Write it as one Markdown document of at most 300 lines, then stop.
Do not propose follow-up work and do not start a second pass.

## Mission

`plan/reference/design.md` is the full architecture of the product.
Its sections 9 and 10 define the renderer and the look rules, `plan/reference/simplify-cost/` is a working WebGL2 experiment of the simplification stage (read its `README.md` and `index.html`), and `plan/reference/glyph-rule/` is the arithmetic of the symbol rule.
A 48-hour demo must reproduce the look in a reduced form on a Mac in Chrome: simplification, quantize and bands, grain, crunch, outline, cells and symbols, object recolor, and a parallax camera loop. No lights, no video export.

Extract, with section references, exactly what a shader author needs and nothing else.

1. The pass list and order (section 9.3): what each pass consumes and produces, the resolution of each (master, working grid, present), and which passes the demo keeps under the reduced form above.
2. For each kept pass, the formulas, parameter names, defaults and ranges (from the ranges table and section 10): simplification (radius, working-grid divisor, clarity, the label-aware rule), quantization (band count, color space, the harmony or palette rule in brief), grain (the hash, amplitude, per-frame versus held), crunch (what it is, its precision), outline (sigmas, threshold, width), and saturation and tone rules.
3. Cells and symbols: how cells are formed (size, placement, alignment), the ink and paper rule, the density mapping, the glyph set and how a glyph is chosen, and what the glyph-rule experiment settles numerically.
4. Objects and recolor: how a SAM mask becomes a label texture, how recolor is applied per object (hue shift, palette slot, or other), and how a label edge stays sharp through the simplification.
5. Motion and the camera stage: the parallax loop, how depth displaces, the inpainted plate's role, loop length and easing, and what must be deterministic frame to frame.
6. Export: the PNG master export rule (size, color, grain seed).

Label each item with its section number.
Where the design leaves a value to the owner's taste (Q12 and similar), say so instead of inventing a value.
Where the experiment's shader code already implements a rule, name the pass in `plan/reference/simplify-cost/index.html` that does.
Quote parameter names and values exactly as the design writes them.

## Stop condition

Your final message is the document. No edits. Stop.
