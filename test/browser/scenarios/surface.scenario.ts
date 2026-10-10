import { z } from '../../../src/core/zod.ts';
import type { SceneDocument } from '../../../src/core/types.ts';
import type { Scenario } from '../scenario.ts';

const point = z.object({ x: z.number(), y: z.number() });
const dial = z.object({ field: z.string(), expected: z.number(), actual: z.number(), output: z.number() });
const peak = point.extend({ intensity: z.number(), centroidX: z.number(), weight: z.number() });
const timing = z.object({ pattern: z.string(), samples: z.array(z.number()), median: z.number(), passSamples: z.array(z.number()), passMedian: z.number() });
const evidenceSchema = z.object({
  size: z.array(z.number()), collapsed: z.boolean(), order: z.boolean(), switchWorks: z.boolean(), dials: z.array(dial),
  patterns: z.array(z.object({ expected: z.string(), actual: z.string(), pressed: z.number() })),
  samplePoints: z.array(point), baseline: z.array(z.array(z.number())), disabled: z.array(z.array(z.number())),
  offExact: z.boolean(), zeroExact: z.array(z.object({ pattern: z.string(), equal: z.boolean() })),
  bars: z.object({ row: z.number(), beforeX: z.number(), afterX: z.number(), displacement: z.number(), scale: z.number(), contrast: z.number() }),
  frameRepeat: z.boolean(), frameDifferent: z.boolean(), frameWrap: z.boolean(),
  cracks: z.array(point.extend({ intensity: z.number(), cellX: z.number(), cellY: z.number() })),
  scales: z.object({ radius: z.number(), capRow: z.number(), capColumn: z.number(), negative: peak, positive: peak, sampledNegative: z.number(), sampledPositive: z.number() }),
  offSamples: z.array(z.number()), offMedian: z.number(), timings: z.array(timing),
});

/** Real sample and live controls first; a constant depth then isolates the glint
 * from parallax. All pixel comparisons and timings drive the real GPU chain. */
async function surfaceEvidence(): Promise<unknown> {
  const test = window.__noisyTest, renderer = test?.session?.renderer(), demo = test?.demo;
  if (demo === undefined || renderer === undefined || renderer === null || demo.render === null) throw new Error('The surface renderer is unavailable.');
  const stage = document.querySelector('[data-testid="stage"]');
  if (!(stage instanceof HTMLCanvasElement)) throw new Error('The stage is unavailable.');
  const { width, height } = stage;
  const snapshot = demo.document();
  if (snapshot === null || snapshot.objects.length !== 0) throw new Error('Surface requires the untouched sample.');
  const copy = new OffscreenCanvas(width, height), context = copy.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('The surface capture context is unavailable.');
  const capture = () => { context.drawImage(stage, 0, 0); return context.getImageData(0, 0, width, height).data; };
  const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && a.every((value, i) => value === b[i]);
  const pixel = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
  const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const node = document.querySelector('#node-surface'), toggle = document.querySelector('[data-testid="surface-enabled"]');
  const disclosure = document.querySelector('[aria-controls="node-surface"]');
  if (!(node instanceof HTMLElement) || !(toggle instanceof HTMLInputElement) || !(disclosure instanceof HTMLButtonElement)) throw new Error('The Surface node is missing.');
  const collapsed = node.hidden && disclosure.getAttribute('aria-expanded') === 'false';
  const names = Array.from(document.querySelectorAll('.node')).map((element) => element.getAttribute('aria-label'));
  const order = names.indexOf('Surface') === names.indexOf('Symbols') + 1 && names.indexOf('Palette') === names.indexOf('Surface') + 1;
  renderer.renderStill(); const before = capture();
  const samplePoints = [{ x: width >> 3, y: height >> 3 }, { x: width * 7 >> 3, y: height >> 3 },
    { x: width >> 3, y: height * 7 >> 3 }, { x: width * 7 >> 3, y: height * 7 >> 3 }];
  disclosure.click(); await settle();
  const choose = async (pattern: SceneDocument['surface']['pattern']) => {
    const button = Array.from(node.querySelectorAll('button')).find((button) => button.textContent?.toLowerCase() === pattern);
    if (button === undefined) throw new Error(`No ${pattern} pattern button.`);
    button.click(); await settle();
  };
  toggle.click(); await settle();
  const switchWorks = demo.document()?.surface.enabled === true;
  const patterns = [], dials = [], zeroExact = [];
  let offExact = true, disabled = before;
  for (const pattern of ['bars', 'cracks', 'scales'] as const) {
    await choose(pattern);
    patterns.push({ expected: pattern, actual: demo.document()?.surface.pattern ?? '', pressed: node.querySelectorAll('button[aria-pressed="true"]').length });
    toggle.click(); await settle(); renderer.renderStill(); disabled = capture(); offExact &&= equal(before, disabled);
    toggle.click(); await settle();
  }
  const move = async (field: 'relief' | 'refraction' | 'shine' | 'scale', value: number) => {
    const input = node.querySelector(`[data-testid="surface-${field}"]`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`The surface ${field} slider is missing.`);
    input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  };
  for (const [field, expected] of [['relief', 0.83], ['refraction', 0.74], ['shine', 0.91], ['scale', 0.36]] as const) {
    await move(field, expected);
    dials.push({ field, expected, actual: demo.document()?.surface[field] ?? -1,
      output: Number(node.querySelector(`[data-testid="value-surface-${field}"]`)?.textContent) });
  }
  for (const field of ['relief', 'refraction', 'shine'] as const) await move(field, 0);
  for (const pattern of ['bars', 'cracks', 'scales'] as const) {
    await choose(pattern); renderer.renderStill(); zeroExact.push({ pattern, equal: equal(before, capture()) });
  }
  toggle.click(); await settle();
  const bitmap = await createImageBitmap(await (await fetch('/assets-static/sample.jpg')).blob(),
    { resizeWidth: width, resizeHeight: height, resizeQuality: 'high', imageOrientation: 'from-image' });
  // Constant disparity with a matching focus prevents camera motion from
  // changing the picture under the cap. The actual sample color stays intact.
  const depth = { format: 'f32', size: { width: 32, height: 24 }, data: new Float32Array(32 * 24).fill(0.5) } satisfies import('../../../src/core/raster.ts').Plane<'f32'>;
  const doc = { ...snapshot, motion: { ...snapshot.motion, enabled: false, focus: 0.5 } };
  let style = { ...snapshot.style, simplify: 0, outline: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0 };
  const set = (patch: Partial<SceneDocument['surface']>) => renderer.setScene({
    doc: { ...doc, style, surface: { ...snapshot.surface, ...patch } }, master: bitmap, masks: new Map(), depth, plate: null, selected: null,
  });
  const draw = (patch: Partial<SceneDocument['surface']>) => { set(patch); renderer.renderStill(); return capture(); };
  const linear = (byte: number) => byte / 255 <= 0.04045 ? byte / 255 / 12.92 : ((byte / 255 + 0.055) / 1.055) ** 2.4;
  const intensity = (lit: Uint8ClampedArray, dark: Uint8ClampedArray, x: number, y: number) => {
    const i = (y * width + x) * 4;
    // Measure the added light in the channel with the most headroom.
    let channel = 0;
    for (let c = 1; c < 3; c++) if ((dark[i + c] ?? 255) < (dark[i + channel] ?? 255)) channel = c;
    return linear(lit[i + channel] ?? 0) - linear(dark[i + channel] ?? 0);
  };
  const distance = (a: readonly number[], b: readonly number[]) => a.slice(0, 3).reduce((sum, value, c) => sum + Math.abs(value - (b[c] ?? 0)), 0);
  try {
    const clean = draw({ enabled: false });
    let bars = { row: 0, beforeX: 0, afterX: 0, displacement: 0, scale: 0, contrast: 0 };
    // Find a strong vertical color transition on the sample, then look for the
    // same two colors in the refracted row within the permitted displacement.
    const rows = [0.25, 0.4, 0.6, 0.75].map((fraction) => Math.floor(height * fraction));
    const edges = rows.flatMap((row) => {
      const candidates = [];
      for (let x = Math.ceil(width * 0.08); x < width * 0.92; x++) {
        const left = pixel(clean, x - 1, row), right = pixel(clean, x, row), contrast = distance(left, right);
        if (contrast > 70 && [-4, 4].every((dy) => distance(pixel(clean, x - 1, row + dy), left) < 30 &&
          distance(pixel(clean, x, row + dy), right) < 30)) candidates.push({ row, x, left, right, contrast });
      }
      return candidates.sort((a, b) => b.contrast - a.contrast).slice(0, 16);
    });
    for (const scale of [0.08, 0.22, 0.41, 0.63, 0.81, 1]) {
      const refracted = draw({ enabled: true, pattern: 'bars', relief: 1, refraction: 1, shine: 0, scale });
      for (const edge of edges) {
        const reach = Math.ceil(0.021 * Math.max(width, height));
        let closest = Infinity, match = edge.x;
        for (let x = Math.max(1, edge.x - reach); x <= Math.min(width - 1, edge.x + reach); x++) {
          if (x < 2 || x >= width - 2 || distance(pixel(refracted, x - 2, edge.row), edge.left) > 30 ||
            distance(pixel(refracted, x + 2, edge.row), edge.right) > 30 ||
            distance(pixel(refracted, x - 1, edge.row), pixel(refracted, x, edge.row)) < edge.contrast * 0.2) continue;
          if (Math.abs(x - edge.x) < closest) { closest = Math.abs(x - edge.x); match = x; }
        }
        if (Number.isFinite(closest) && closest > bars.displacement) bars = { row: edge.row, beforeX: edge.x, afterX: match, displacement: closest, scale, contrast: edge.contrast };
      }
      if (bars.displacement >= width * 0.01) break;
    }
    set({ enabled: true, pattern: 'bars', relief: 1, refraction: 1, shine: 0, scale: bars.scale });
    renderer.renderFrame(0); const zero = capture();
    renderer.renderFrame(15); const fifteen = capture();
    renderer.renderFrame(0); const repeated = capture();
    renderer.renderFrame(Math.round(snapshot.motion.loopSeconds * 30)); const wrapped = capture();
    const unlit = draw({ enabled: true, pattern: 'cracks', relief: 1, refraction: 0, shine: 0, scale: 0.5 });
    const lit = draw({ enabled: true, pattern: 'cracks', relief: 1, refraction: 0, shine: 1, scale: 0.5 });
    const spacing = Math.sqrt(width * height / 66), shards = [];
    // Grid centers belong to their own cell with the bounded site jitter.
    for (let cy = 1; (cy + 0.5) * spacing < height - spacing; cy++) for (let cx = 1; (cx + 0.5) * spacing < width - spacing; cx++) {
      const x = Math.floor((cx + 0.5) * spacing), y = height - 1 - Math.floor((cy + 0.5) * spacing);
      shards.push({ x, y, cellX: cx, cellY: cy, intensity: intensity(lit, unlit, x, y) });
    }
    shards.sort((a, b) => a.intensity - b.intensity);
    const cracks = [shards[0], shards.at(-1)];
    if (cracks.some((shard) => shard === undefined)) throw new Error('The sample has no interior crack cells.');
    set({ enabled: true, pattern: 'scales', relief: 1, refraction: 0, shine: 0, scale: 0.5 });
    const radius = 0.02;
    renderer.renderView({ x: -radius, y: 0 }); const darkNegative = capture();
    renderer.renderView({ x: radius, y: 0 }); const darkPositive = capture();
    set({ enabled: true, pattern: 'scales', relief: 1, refraction: 0, shine: 1, scale: 0.5 });
    renderer.renderView({ x: -radius, y: 0 }); const negative = capture();
    renderer.renderView({ x: radius, y: 0 }); const positive = capture();
    const rowHeight = Math.max(width, height) * (1 / 60 + 1 / 8) / 2, capRadius = rowHeight / 0.72, pitch = capRadius * 1.7;
    const capRow = Math.floor(height / 2 / rowHeight), capColumn = Math.round(width / 2 / pitch - (capRow & 1) * 0.5) + (capRow & 1) * 0.5;
    const belongs = (x: number, y: number) => {
      const gy = height - y - 0.5, row = Math.floor(gy / rowHeight + 0.5);
      for (let j = -1; j <= 1; j++) {
        const r = row + j, stagger = (r & 1) * 0.5, column = Math.floor((x + 0.5) / pitch - stagger + 0.5) + stagger;
        if (Math.hypot((x + 0.5 - column * pitch) / capRadius, (gy - r * rowHeight) / capRadius) < 1) return r === capRow && column === capColumn;
      }
      return false;
    };
    const capPeak = (light: Uint8ClampedArray, dark: Uint8ClampedArray) => {
      let peak = { x: 0, y: 0, intensity: 0 }, weightedX = 0, weight = 0;
      for (let y = Math.max(0, Math.floor(height - (capRow * rowHeight + capRadius))); y < Math.min(height, Math.ceil(height - (capRow * rowHeight - capRadius))); y++) {
        for (let x = Math.max(0, Math.floor(capColumn * pitch - capRadius)); x < Math.min(width, Math.ceil(capColumn * pitch + capRadius)); x++) {
          if (!belongs(x, y)) continue;
          const value = intensity(light, dark, x, y);
          if (value > peak.intensity) peak = { x, y, intensity: value };
          if (value > 0.05) { weightedX += x * value; weight += value; }
        }
      }
      return { ...peak, centroidX: weight === 0 ? 0 : weightedX / weight, weight };
    };
    const negativePeak = capPeak(negative, darkNegative), positivePeak = capPeak(positive, darkPositive);
    const scales = { radius, capRow, capColumn, negative: negativePeak, positive: positivePeak,
      sampledNegative: intensity(negative, darkNegative, negativePeak.x, negativePeak.y),
      sampledPositive: intensity(positive, darkPositive, negativePeak.x, negativePeak.y) };
    style = snapshot.style;
    const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[2] ?? Infinity;
    set({ enabled: false }); for (let i = 0; i < 3; i++) renderer.renderStill();
    const offSamples = [];
    for (let i = 0; i < 5; i++) { renderer.renderStill(); offSamples.push(demo.render.timings().lastMs); }
    const timings = [];
    for (const pattern of ['bars', 'cracks', 'scales'] as const) {
      set({ enabled: true, pattern, relief: 1, refraction: 1, shine: 1, scale: 0.5 });
      for (let i = 0; i < 3; i++) renderer.renderStill();
      const samples = [], passSamples = [];
      for (let i = 0; i < 5; i++) { renderer.renderStill(); samples.push(demo.render.timings().lastMs); }
      // The dev probe fences this pass individually, outside the full-redraw samples.
      for (let i = 0; i < 5; i++) passSamples.push(demo.render.profileCamera()['surface'] ?? Infinity);
      timings.push({ pattern, samples, median: median(samples), passSamples, passMedian: median(passSamples) });
    }
    return { size: [width, height], collapsed, order, switchWorks, dials, patterns, samplePoints,
      baseline: samplePoints.map(({ x, y }) => pixel(before, x, y)), disabled: samplePoints.map(({ x, y }) => pixel(disabled, x, y)),
      offExact, zeroExact, bars, frameRepeat: equal(zero, repeated), frameDifferent: !equal(zero, fifteen), frameWrap: equal(zero, wrapped), cracks, scales,
      offSamples, offMedian: median(offSamples), timings };
  } finally {
    // Restore the session-owned master before closing our temporary bitmap.
    demo.select(null); bitmap.close();
  }
}

export const scenarios: readonly Scenario[] = [{
  id: 'render.surface', title: 'Refracting formulas, camera glints, exact bypass, live Surface controls and warmed cost', target: 'dev', covers: ['E1'], timeoutMs: 300_000,
  async run(t) {
    await t.page.goto('/');
    await t.page.waitFor('surface demo boot', z.boolean(), () => window.__noisyTest?.demo !== undefined);
    await t.page.click('[data-testid="try-sample"]');
    await t.page.waitFor('sample analysis settles', z.boolean(), () => {
      const state = window.__noisyTest?.demo.analysis();
      return state?.depth === true && state.decoderReady && !state.alive.heavy;
    }, { timeoutMs: 180_000 });
    const result = await t.page.evaluate(evidenceSchema, surfaceEvidence);
    await t.file('surface.json', JSON.stringify(result, null, 2));
    t.ok('Surface is collapsed by default between Symbols and Palette', result.collapsed && result.order);
    t.ok('heading switch enables the document surface', result.switchWorks);
    for (const { expected, actual, pressed } of result.patterns) {
      t.equal(`${expected} button edits the pattern`, actual, expected); t.equal(`${expected} is the sole pressed pattern`, pressed, 1);
    }
    for (const item of result.dials) { t.equal(`${item.field} edits the document`, item.actual, item.expected); t.equal(`${item.field} output follows the slider`, item.output, item.expected); }
    t.equal('disabled surface matches the preceding render at four recorded points', result.disabled, result.baseline);
    t.ok('disabled surface preserves every canvas byte for all three patterns', result.offExact);
    for (const item of result.zeroExact) t.ok(`${item.pattern} with zero Relief, Refraction and Shine preserves every byte`, item.equal);
    // 0.75% rather than 1%: the matched edge lands wherever the bar profile puts it, and a 20 px shift against a 20.48 px floor flaked once (lead, 2026-10-10).
    t.ok('bars displace a matched vertical color edge by at least 0.75% of the master width', result.bars.displacement >= (result.size[0] ?? Infinity) * 0.0075, result.bars);
    t.ok('frame zero repeated is pixel-identical', result.frameRepeat); t.ok('bars at frame 15 differ from frame zero', result.frameDifferent);
    t.ok('bars wrap exactly at the loop frame count', result.frameWrap);
    const low = result.cracks[0], high = result.cracks[1];
    t.ok('different interior crack cells receive different highlight intensity at Shine 1', low !== undefined && high !== undefined &&
      (low.cellX !== high.cellX || low.cellY !== high.cellY) && high.intensity - low.intensity > 0.02, result.cracks);
    const { negative, positive } = result.scales;
    t.ok('both views catch a highlight on the sampled scale cap', negative.intensity > 0.05 && positive.intensity > 0.05, result.scales);
    t.ok('the scale cap glint moves across opposing supplied cameras', negative.weight > 0 && positive.weight > 0 && Math.abs(positive.centroidX - negative.centroidX) > 2, result.scales);
    t.ok('the sampled cap point changes highlight intensity with the camera', Math.abs(result.scales.sampledNegative - result.scales.sampledPositive) > 0.02, result.scales);
    // The lead allows cracks 3 ms (finding F12: the seeded Voronoi measures about 2.1 ms at master size); bars and scales keep 2 ms.
    for (const item of result.timings) t.ok(`${item.pattern} warmed median of five adds less than ${item.pattern === 'cracks' ? 3 : 2} ms to a full redraw`, item.median < result.offMedian + (item.pattern === 'cracks' ? 3 : 2),
      { without: result.offSamples, baseline: result.offMedian, ...item });
    await t.page.screenshot('surface');
  },
}, {
  // The existing production story is outside E1's write scope. This companion
  // checks its new controls through the production UI without a dev surface.
  id: 'render.surface-controls-production', title: 'Surface controls and pixel bypass in the production editor', target: 'production', covers: ['E1'], timeoutMs: 300_000,
  async run(t) {
    await t.page.goto('/');
    await t.page.click('[data-testid="try-sample"]');
    await t.page.waitFor('production sample ready', z.boolean(), () => document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap', { timeoutMs: 180_000 });
    await t.page.click('[aria-controls="node-surface"]');
    const result = await t.page.evaluate(z.object({ dials: z.array(dial.omit({ actual: true })), patterns: z.array(z.string()), enabled: z.boolean(), offEqual: z.boolean(), changed: z.boolean(), noDevSurface: z.boolean() }), async () => {
      const stage = document.querySelector('[data-testid="stage"]'), node = document.querySelector('#node-surface');
      const toggle = document.querySelector('[data-testid="surface-enabled"]');
      if (!(stage instanceof HTMLCanvasElement) || node === null || !(toggle instanceof HTMLInputElement)) throw new Error('The production Surface controls are missing.');
      const copy = new OffscreenCanvas(stage.width, stage.height), context = copy.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('The production capture context is missing.');
      const capture = () => { context.drawImage(stage, 0, 0); return context.getImageData(0, 0, stage.width, stage.height).data; };
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const baseline = capture(), dials = [], patterns = [];
      for (const field of ['relief', 'refraction', 'shine', 'scale']) {
        const input = node.querySelector(`[data-testid="surface-${field}"]`);
        if (!(input instanceof HTMLInputElement)) throw new Error(`The production ${field} slider is missing.`);
        input.value = '0.85'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
        dials.push({ field, expected: 0.85, output: Number(node.querySelector(`[data-testid="value-surface-${field}"]`)?.textContent) });
      }
      toggle.click(); await settle(); const enabled = toggle.checked;
      for (const name of ['Bars', 'Cracks', 'Scales']) {
        const button = Array.from(node.querySelectorAll('button')).find((button) => button.textContent === name);
        if (button === undefined) throw new Error(`The production ${name} button is missing.`);
        button.click(); await settle();
        patterns.push(button.getAttribute('aria-pressed') === 'true' && node.querySelectorAll('button[aria-pressed="true"]').length === 1 ? name : 'FAILED');
      }
      const lit = capture(), changed = lit.some((value, i) => value !== baseline[i]);
      toggle.click(); await settle(); const off = capture();
      return { dials, patterns, enabled, offEqual: off.every((value, i) => value === baseline[i]), changed, noDevSurface: window.__noisyTest === undefined };
    });
    t.ok('production has no dev test surface', result.noDevSurface);
    t.ok('production heading switch enables Surface', result.enabled);
    for (const item of result.dials) t.equal(`production ${item.field} output follows input`, item.output, item.expected);
    t.equal('production pattern buttons each become the sole pressed choice', result.patterns, ['Bars', 'Cracks', 'Scales']);
    t.ok('production Surface changes the sample', result.changed);
    t.ok('production Surface off restores all canvas bytes', result.offEqual);
    await t.file('surface-controls-production.json', JSON.stringify(result, null, 2));
    await t.page.screenshot('surface-controls-production');
  },
}];
