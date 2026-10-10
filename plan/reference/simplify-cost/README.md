# simplify-cost: what a bounded simplification rerun costs on this Mac

> Owns: the round-4 measurement behind the simplification shape in `design.md` sections 9.2 and 10 (finding FRESH-2 in `reviews/round4.md`): timings of a label-aware anisotropic Kuwahara on reduced working grids, the full-resolution reference, and a visual proxy of each result; the round-5 rerun with a label-aware downsample (finding AUDIT-2 in `reviews/round5.md`); and the round-5 audit's rerun with every label lookup made an integer `texelFetch` (finding CA-6 in the same file).
> Does not own: the design decision (`../../design.md`), the phone's numbers (P1.5's simplification row), or the look's taste, which is the owner's (Q12).

Run 2026-09-30 on an Apple M3, headless Chrome 154, `ANGLE Metal Renderer: Apple M3`.
Throwaway: nothing here ships.

## Question

The round-3 design ran the Kuwahara at master size (2048 x 1536) with a radius of up to 24 master px.
The round-4 verifier measured one pass of that at 1.7 to 1.8 s on this Mac.
Which bounded shape costs little enough to rerun on a slider drag and on every object tap, and does its output still look like the same filter?

## Method

`index.html` runs one pipeline, parametrized by an integer divisor `div`:

1. `down`: the master is averaged to a working grid of `ceil(master / div)` over the master texels that carry the working texel's own label, which also goes into alpha (round 5).
   That label is the label of one named master texel, `p * div + div / 2`, read with `texelFetch` (round-5 audit); round 5 looked it up at the block's center, which for `div` 4 is the corner shared by four label texels.
   Round 4 averaged every texel of the box whatever its label; `down=box` still selects that, as the comparison.
2. `tensor`, `blur` twice: a Sobel structure tensor smoothed by a separable Gaussian (sigma 2 working texels).
3. `akf` three times: the eight-sector anisotropic Kuwahara with polynomial weights (Kyprianidis, Semmo, Kang, Doellner 2010), radius `r / div` working texels for a radius `r` given in master px, each tap weighted by label agreement with the center texel, and the weights windowed to zero at the kernel edge so the result is continuous in the radius.
   Texels whose label is the subject use the radius scaled by `1 - clarity` (0.6 here).
4. `dog`: a signed difference of Gaussians (sigma 1.0 and 1.6 working texels) of the result's luminance, biased into alpha.
5. `up`: back to master size with a four-tap bilinear over the working texels that carry the master texel's own label, plus `d` times the master's detail (the master minus the same bilinear of the unfiltered working grid), `d = max(0, 1 - r / 8)` outside subjects and `max(d, clarity)` inside.

One rerun is steps 1 to 5 for one source texture, forced to completion by a one-pixel `readPixels`.
`div = 1` is the round-3 shape (the filter at master size) and serves as the reference.
The input is the synthetic bench scene (`master.jpg`, made from the bench's test photo with `sips -Z 2048`) plus procedural noise, hatching, and blotches added in the page, with a 1024 x 768 label texture marking the sphere as a subject.
The "scissor" rows restrict every pass to a rectangle of 40% x 50% of the frame, the size of an object's bounds plus the filter's reach.
`mode=look` writes crops to `out/`: the simplified texture, and a proxy of the look (five luminance bands, and a dark line where the difference of Gaussians crosses zero within 1.2 px).
The proxy is not the renderer's quantizer; it only shows where band boundaries and texture-edge lines would fall.

Rerun: `node drive.mjs <empty profile dir> 'mode=time&reps=8'`, add `ref=1` for the master-size reference, `'mode=look&r=12.5&divs=4,2&ref=1'` for the images, or `'mode=dirty'` for the dirty-rectangle check (`margin=0.3` for its negative control).
The driver starts headless Chrome on the `file://` page, prints the page's text, saves the images, and kills Chrome; no server is involved and nothing is left running.

## Results

All VERIFIED on this Mac by the runs in `results.txt`, which also holds the earlier runs of the same commands copied from the terminal; each range covers every run.

| Working grid | r = 6 px | r = 12.5 px (the default) | r = 24 px (the maximum) | Object-sized scissor at r = 24 |
| --- | --- | --- | --- | --- |
| quarter, `div` 4, 512 x 384 | 3.0 to 9.0 ms | 5.0 to 8.4 ms | 12 to 42 ms | 4.7 to 8.0 ms |
| third, `div` 3, 683 x 512 | 4.7 to 15 ms | 12 to 36 ms | 36 to 109 ms | 11 to 20 ms |
| half, `div` 2, 1024 x 768 | 31 to 46 ms | 88 to 132 ms | 313 to 422 ms | 51 to 79 ms |
| master, `div` 1 (round-3 shape) | 365 to 508 ms | 1.58 to 1.71 s | not run (the verifier measured 1.7 to 1.8 s per pass, three passes per rerun) | not run |

- Dirty rectangle (`mode=dirty`, runs 5 to 7 in `results.txt`): the sphere's label shrinks to 80%, and the quarter-grid stage reruns with every pass scissored to the sphere's bounds dilated by the combined reach of the passes after it (1.5 kernel radii per Kuwahara iteration, four working texels for the tensor blur and for the difference of Gaussians, one for the upsample), after unrelated contents were deliberately left in every working-grid target.
  The result equals a whole-frame rerun with the new label byte for byte at `r` = 6, 12.5, and 24: 0 of 12,582,912 bytes differ, where the label change itself altered 462,079 to 644,258 bytes.
  Negative control: with the margins cut to 30%, 597 to 24,333 bytes differ, so the comparison does detect a margin that is too small.
  Timed with the stale-content step forced to completion first (run 7): 2.2 to 5.3 ms at `r` = 12.5 and 5.7 to 8.6 ms at `r` = 24, for an object whose bounds are 614 master px square.
- Identity: at `r = 0` with `d = 1` the quarter-grid pipeline returns the master exactly (maximum absolute difference 0 of 255 over a 64 x 64 patch).
- The quarter grid's kernel at the maximum radius is 6 working texels, 113 taps per texel over 0.2 MP; the master-size kernel at the default radius is 489 taps over 3.1 MP.
- Look (`out/`): at `r = 12.5` the quarter-grid band boundaries in the background have the same blobby, painterly shape as the master-size reference (`div4-r12.5-bands-lines.png` against `ref-div1-r12.5-bands-lines.png`), and the label edge of the sphere stays one pixel sharp in both.
  The simplified texture itself is softer on the quarter grid (region borders are four-pixel ramps before quantization), which is why the texture-edge lines are taken from the difference of Gaussians on the working grid and not at master-pixel sigmas.
  Inside the subject the re-injected detail carries the input's noise, so its band boundaries are speckled where the reference's are clean; the noise added here is far heavier than a daylight phone photo's (INFERRED), so how this reads on real photos is for P3b and the owner to judge.

## Round 5: the label-aware downsample (AUDIT-2)

Run 2026-09-30 on the same Mac and browser, runs R5-1 to R5-7 in `results.txt`.
The round-4 downsample was a plain box average, so a working texel on an object's edge carried up to half background color under the object's label, and nothing downstream could remove it.

- Ring check (`mode=ring`): a white sphere (label 1) on a black background, two flat colors, `clarity` 0.
  With the round-4 box downsample, 5,070 of 296,472 object texels moved toward the background by more than 2 of 255 at `r` = 8 px (the first radius at which the detail weight is 0), the worst by 116, and 2,077 at the default `r` = 12.5 px, the worst by 49; the background moved toward the object by about as much.
  With the label-aware downsample, 0 texels moved on either side at `r` = 8, 12.5, and 24, the worst difference 0.
- Identity: at `r = 0` with `d = 1` the pipeline still returns the master exactly (0 of 255).
- Timing (`mode=time&divs=4`, two runs): 4.4 to 6.4 ms at `r` = 6, 8.4 to 11.3 ms at the default, 14.5 to 40.2 ms at the maximum, and 4.1 to 11.6 ms for the object-sized scissor at the maximum.
  The round-4 box downsample in the same session (`down=box`): 4.9 to 7.3 ms, 8.9 to 13.2 ms, 18.0 to 22.6 ms, and 4.5 to 6.1 ms.
  The sixteen extra label fetches per working texel are not measurable; the session itself ran a few milliseconds slower at the default radius than the round-4 session did (5.0 to 8.4 ms), so the default-radius figure across both sessions is 5 to 11 ms per source.
- Dirty rectangle (`mode=dirty`): 0 of 12,582,912 bytes differ from the whole-frame rerun at `r` = 6, 12.5, and 24; with the margins cut to 30%, 1,073 to 24,659 bytes differ; the dirty rerun took 1.8 to 2.9 ms at the default radius and 5.5 to 7.1 ms at the maximum.

Labels: VERIFIED for this Mac and Chrome; INFERRED for the phone, which P1.5 measures with these shaders.
The images in `out/` are the round-4 run's and were not regenerated.

## What this does and does not show

- VERIFIED: on this Mac a quarter-grid rerun is about 40 to 340 times cheaper than the master-size one at the same radius and fits inside one 60 Hz frame at the default radius.
- VERIFIED: the half grid, the round-3 contingency, does not fit: 88 to 132 ms per source at the default radius.
- INFERRED: the phone's GPU is two to three times slower, so one source is about 10 to 35 ms at the default radius (from 5 to 11 ms here across the round-4 and round-5 sessions) and up to about 125 ms at the maximum; P1.5 measures it with these shaders.
- Not measured: Safari's WebGL2 on this Mac (no remote automation here), the real quantizer, real photos.

## Round-5 audit: integer label lookups (CA-6)

Run 2026-09-30 on the same Mac and browser, runs CA6-1 to CA6-10 in `results.txt`.
Round 5's downsample read the working texel's own label with a `NEAREST` lookup at the center of its block.
For `div` 4 over a label texture at half the master's size, that center is label coordinate `2p + 1` exactly, the corner shared by four label texels, so which of the four answered was decided by float rounding in the GPU.
Every label lookup in `index.html` is now a `texelFetch` at an integer coordinate computed in integer arithmetic: master texel `m` reads label texel `floor((2m + 1) * labelSize / (2 * masterSize))` per axis, and a working texel takes the label of master texel `p * div + div / 2`.

- Ring check (`mode=ring`, run CA6-1): unchanged, 0 texels moved on either side at `r` = 8, 12.5, and 24 with the label-aware downsample, and the box downsample's counts as in round 5.
- Identity: 0 of 255 at `r = 0`.
- Dirty rectangle (`mode=dirty`, runs CA6-2 and CA6-3): 0 of 12,582,912 bytes differ from the whole-frame rerun at `r` = 6, 12.5, and 24; with the margins cut to 30%, 1,073 to 24,659 differ.
  The count of bytes the label change altered is the same as in round 5 at each radius (493,750, 567,795, 657,334), which is consistent with this Mac's GPU having answered the old lookup with the texel now named, and does not prove it.
- Timing under load (`mode=time&divs=4`, runs CA6-4 to CA6-8): taken with other work running on this Mac (load average 3.5 to 4.2), so noisy.
  Label-aware: 3.1 to 13.2 ms at `r` = 6, 6.2 to 29.8 ms at the default, 16.4 to 61.6 ms at the maximum, 4.3 to 10.5 ms for the object-sized scissor.
  The box downsample in the same session: 4.8 to 6.5 ms, 9.5 to 17.3 ms, 27.5 to 45.0 ms, and 6.5 to 8.5 ms, against 18.0 to 22.6 ms at the maximum in round 5's session.
  The two least disturbed runs (CA6-4 and CA6-5) were at or below round 5's figures at `r` = 6 and at the default radius (3.1 to 4.3 ms and 6.2 to 8.9 ms), so the integer lookups show no cost there; the session's upper figures follow the machine's load and not the downsample, since the box control rose as well.
- Timing with the load down (runs CA6-9 and CA6-10, load average 2.2 to 2.3): 2.9 to 4.2 ms at `r` = 6, 5.3 to 10.3 ms at the default, 12.4 to 30.4 ms at the maximum, and 3.6 to 8.0 ms for the object-sized scissor: inside the round-4 and round-5 sessions' ranges at the default and the maximum radius, and at or just below them at `r` = 6 and for the scissor.
  The ranges above are left as they are: they are the round-4 and round-5 sessions' figures, and the audit's runs are recorded here and not folded into the table.

Labels: VERIFIED for this Mac and Chrome that the ring, identity, and dirty-rectangle results hold with the integer lookups; INFERRED that two GPUs answered the old lookup differently, which was the finding's premise and was not measured; the runs under load exceed the quiet sessions' upper figures and the two runs with the load down do not, so the ranges are unchanged; the phone's figures are P1.5's.
