import { z } from '../../../src/core/zod.ts';
import { grainHash } from '../../../src/render/grain.ts';
import { clipLightness } from '../../../src/render/clip.ts';
import type { Scenario } from '../scenario.ts';
import { installRenderFixtures } from './render.scenario.ts';

const Camera = z.object({
  status: z.string(), size: z.array(z.number()), zeroEqual: z.boolean(), grainDifferent: z.boolean(), grainRepeated: z.boolean(),
  hashes: z.array(z.number()), cells: z.array(z.array(z.array(z.number()))),
  clipping: z.array(z.object({ before: z.number(), after: z.number(), unchanged: z.boolean(), maxL: z.number() })),
  crunchDifferent: z.boolean(), boundaryMean: z.number(), interiorMean: z.number(), samples: z.array(z.number()), median: z.number(),
  passes: z.record(z.string(), z.number()),
  sliders: z.array(z.object({ field: z.string(), expected: z.number(), actual: z.number(), changed: z.boolean() })),
});

async function cameraStage(): Promise<unknown> {
  const demo = window.__noisyTest?.demo, fixtures = window.__renderFixtures;
  if (demo === undefined || fixtures === undefined) throw new Error('Render test surface is missing.');
  const settle = async (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const bytes = async (): Promise<Uint8Array> => new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
  const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
  const read = async (): Promise<Uint8ClampedArray> => fixtures.readPng(await demo.downloadPng());
  const zero = { grain: 0, colorNoise: 0, clipping: 0, crunch: 0 };
  await demo.importFile(await fixtures.gradientFile(false));
  demo.setStyle({ ...zero, simplify: 0, outline: 0, colors: 12, bands: 6 });
  // All camera passes are skipped: this captures the D2a chain before enabling them.
  const d2a = await bytes();
  demo.setStyle({ ...zero });
  const zeroEqual = equal(d2a, await bytes());
  const render = demo.render;
  if (render === null) throw new Error('No renderer.');
  const hashes = render.hashCells();
  demo.setStyle({ grain: 0.5 });
  const grainA = await bytes(), grainB = await bytes();
  const grainDifferent = !equal(d2a, grainA), grainRepeated = equal(grainA, grainB);
  demo.setStyle({ ...zero, crunch: 1 });
  const crunchDifferent = !equal(d2a, await bytes());
  const crunched = await read();
  let boundaryTotal = 0, interiorTotal = 0, boundaryCount = 0, interiorCount = 0;
  const width = 2048, height = 1536;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1]] satisfies readonly (readonly [number, number])[]) {
      if (x + dx >= width || y + dy >= height) continue;
      const boundary = dx === 1 ? (x + 1) % 8 === 0 : (y + 1) % 8 === 0;
      let diff = 0;
      for (let c = 0; c < 3; c++) diff += Math.abs((crunched[(y*width+x)*4+c] ?? 0) - (crunched[((y+dy)*width+x+dx)*4+c] ?? 0)) / 3;
      if (boundary) { boundaryTotal += diff; boundaryCount++; }
      else { interiorTotal += diff; interiorCount++; }
    }
  }
  // Explicitly restore all zeros after a nonzero pass to check both skip paths.
  demo.setStyle(zero);
  const restoredEqual = equal(d2a, await bytes());
  demo.setStyle({ grain: 0.5, colorNoise: 0.3, clipping: 0.7, crunch: 0.8 });
  const stage = document.querySelector<HTMLCanvasElement>('[data-testid=stage]');
  if (stage === null) throw new Error('No stage.');
  for (let i = 0; i < 2; i++) demo.setStyle({ grain: i % 2 === 0 ? 0.51 : 0.5 });
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    demo.setStyle({ grain: i % 2 === 0 ? 0.51 : 0.5 }); samples.push(render.timings().lastMs);
  }
  const passes = render.profileCamera();
  const median = [...samples].sort((a, b) => a - b)[2] ?? Infinity;

  await demo.importFile(await fixtures.flatFile([120, 120, 120]));
  demo.setStyle({ ...zero, simplify: 0, outline: 0, saturation: 0, grain: 0.5, grainSize: 4 });
  const flatGrain = await read();
  const cells = [[100, 100], [204, 208], [508, 504]].map(([x = 0, y = 0]) =>
    [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx = 0, dy = 0]) => {
      const i = ((y+dy)*width+x+dx)*4; return [...flatGrain.subarray(i, i+4)];
    }));
  const lightness = (pixel: ArrayLike<number>): number => {
    const linear = (byte: number): number => {
      const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const r = linear(pixel[0] ?? 0), g = linear(pixel[1] ?? 0), b = linear(pixel[2] ?? 0);
    return 0.2104542553*Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b)
      + .793617785*Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b)
      - .0040720468*Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  };
  const clipping: { before: number; after: number; unchanged: boolean; maxL: number }[] = [];
  for (const byte of [100, 245, 255]) {
    await demo.importFile(await fixtures.flatFile([byte, byte, byte]));
    demo.setStyle({ ...zero, simplify: 0, outline: 0, saturation: 0 });
    const before = await read(); demo.setStyle({ clipping: 1 }); const after = await read();
    let maxL = 0;
    for (let i = 0; i < after.length; i += 4) maxL = Math.max(maxL, lightness(after.subarray(i, i+4)));
    clipping.push({ before: lightness(before), after: lightness(after), maxL,
      unchanged: before.length === after.length && before.every((v, i) => v === after[i]) });
  }
  // Range events use the real page controls and their document-backed outputs.
  await demo.importFile(await fixtures.gradientFile(false));
  demo.setStyle({ ...zero, grainSize: 1, simplify: 0, outline: 0, colors: 12, bands: 6 });
  const sliders: { field: string; expected: number; actual: number; changed: boolean }[] = [];
  for (const [field, expected] of [['grain', 0.5], ['colorNoise', 0.4], ['grainSize', 4], ['crunch', 1], ['clipping', 1]] satisfies readonly (readonly [string, number])[]) {
    if (field !== 'grainSize') demo.setStyle({ ...zero, grainSize: 1 });
    const before = await bytes();
    const input = document.querySelector<HTMLInputElement>(`[data-testid=style-${field}]`);
    if (input === null) throw new Error(`Missing ${field} slider.`);
    input.value = String(expected); input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    sliders.push({ field, expected, actual: Number(document.querySelector(`[data-testid=value-${field}]`)?.textContent), changed: !equal(before, await bytes()) });
  }
  return { status: demo.scene().status, size: [stage.width, stage.height], zeroEqual: zeroEqual && restoredEqual,
    grainDifferent, grainRepeated, hashes, cells, clipping, crunchDifferent,
    boundaryMean: boundaryTotal / boundaryCount, interiorMean: interiorTotal / interiorCount, samples, median, passes, sliders };
}

const Depth = z.object({ status: z.string(), baseline: z.array(z.array(z.number())), edge: z.array(z.array(z.number())), ink: z.number(), nullEqual: z.boolean() });

async function depthEdge(): Promise<unknown> {
  const demo = window.__noisyTest?.demo, fixtures = window.__renderFixtures;
  if (demo === undefined || fixtures === undefined) throw new Error('Render test surface is missing.');
  await demo.importFile(await fixtures.flatFile([180, 180, 180]));
  demo.setStyle({ simplify: 0, outline: 0, grain: 0, colorNoise: 0, crunch: 0, clipping: 0, saturation: 0, colors: 2, bands: 4 });
  const width = 2048, height = 1536, data = new Float32Array(width*height);
  for (let y = 0; y < height; y++) { data.fill(0.2, y*width, y*width+width/2); data.fill(0.8, y*width+width/2, (y+1)*width); }
  demo.injectDepth({ format: 'f32', size: { width, height }, data });
  const samples = (bytes: Uint8ClampedArray): number[][] => [-12, -2, -1, 0, 1, 12].map((dx) => {
    const i = (512*width+width/2+dx)*4; return [...bytes.subarray(i, i+4)];
  });
  const baseline = samples(await fixtures.readPng(await demo.downloadPng()));
  demo.setStyle({ outline: 0.4 });
  const edge = samples(await fixtures.readPng(await demo.downloadPng()));
  demo.injectDepth(null); demo.setStyle({ outline: 0 });
  const a = await fixtures.readPng(await demo.downloadPng());
  demo.setStyle({ outline: 1 }); const b = await fixtures.readPng(await demo.downloadPng());
  const v = 180/255;
  const L = Math.cbrt(v <= .04045 ? v/12.92 : ((v+.055)/1.055) ** 2.4);
  const inkL = Math.min(Math.max(L-.25, 0), .55) + .45*.5/4;
  const linear = inkL ** 3;
  const ink = Math.round(255 * (linear <= .0031308 ? 12.92*linear : 1.055*linear**(1/2.4)-.055));
  return { status: demo.scene().status, baseline, edge, ink, nullEqual: a.length === b.length && a.every((v, i) => v === b[i]) };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'render.camera-stage', title: 'deterministic grain, exact hash readback, clipping knee, real JPEG blocking, sliders and full-chain timings', target: 'dev', covers: [],
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('render demo boot', z.boolean(), () => window.__noisyTest?.demo !== undefined);
      await t.page.evaluate(z.null(), installRenderFixtures);
      const result = await t.page.evaluate(Camera, cameraStage);
      await t.file('camera-stage.json', JSON.stringify(result, null, 2));
      t.equal('camera fixture Ready', result.status, 'Ready');
      t.equal('full-chain master dimensions', result.size, [2048, 1536]);
      t.ok('zero camera effects preserve D2a PNG bytes before and after enabling', result.zeroEqual);
      t.ok('grain changes export', result.grainDifferent);
      t.ok('same scene gives byte-identical grain exports', result.grainRepeated);
      t.equal('four GLSL uint cells match the TypeScript hash including all three fixed vectors', result.hashes, [
        grainHash(0, 0, 0, 0, 0), grainHash(123456789, 7, 123, 456, 1), grainHash(0xffffffff, 34, 2047, 1535, 2), grainHash(123456789, 7, 1, 1, 0),
      ]);
      for (const [i, cell] of result.cells.entries()) for (const pixel of cell) t.equal(`grain size 4 cell ${i} has constant offset`, pixel, cell[0]);
      for (const [i, sample] of result.clipping.entries()) {
        t.ok(`clipping fixture ${i} stays within white`, sample.maxL <= 1 + 1e-6);
        t.ok(`clipping fixture ${i} follows the CPU knee`, Math.abs(sample.after - clipLightness(sample.before, 1)) < 0.004, sample);
        if (sample.before <= 0.6) t.ok(`clipping fixture ${i} below knee preserves all bytes`, sample.unchanged);
        else t.ok(`clipping fixture ${i} above knee is lighter`, sample.after > sample.before, sample);
      }
      t.ok('crunch changes export', result.crunchDifferent);
      t.ok('8x8 block boundary difference exceeds within-block difference', result.boundaryMean > result.interiorMean, { boundary: result.boundaryMean, interior: result.interiorMean });
      for (const slider of result.sliders) {
        t.equal(`${slider.field} input updates document`, slider.actual, slider.expected);
        t.ok(`${slider.field} input changes rendered export`, slider.changed);
      }
      t.ok('warmed full-chain median stays below 50 ms', result.median < 50, { samples: result.samples, median: result.median, passes: result.passes });
      await t.page.screenshot('camera-stage');
    },
  },
  {
    id: 'render.depth-edge', title: 'synthetic depth adds an outline only at its discontinuity and null depth is an exact negative control', target: 'dev', covers: [],
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('render demo boot', z.boolean(), () => window.__noisyTest?.demo !== undefined);
      await t.page.evaluate(z.null(), installRenderFixtures);
      const result = await t.page.evaluate(Depth, depthEdge);
      await t.file('depth-edge.json', JSON.stringify(result, null, 2));
      t.equal('depth fixture Ready', result.status, 'Ready');
      for (const i of [0, 1, 4, 5]) t.equal(`outside half width depth sample ${i} unchanged`, result.edge[i], result.baseline[i]);
      for (const i of [2, 3]) {
        const before = result.baseline[i], after = result.edge[i];
        t.ok(`depth sample ${i} darkens all RGB channels`, before !== undefined && after !== undefined && after.slice(0, 3).every((v, c) => v < (before[c] ?? 0)), { before, after });
        t.ok(`depth sample ${i} mixes the darkest variant at alpha 0.4`, before !== undefined && after !== undefined && after.slice(0, 3).every((v, c) => Math.abs(v - Math.round(.6*(before[c] ?? 0) + .4*result.ink)) <= 2), { before, after, ink: result.ink });
      }
      t.ok('null depth makes outline zero and one byte-identical', result.nullEqual);
      await t.page.screenshot('depth-negative-control');
    },
  },
];
