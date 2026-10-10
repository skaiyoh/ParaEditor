import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

/** Self-contained recipes installed inside the browser, shared by both render packages. */
export function installRenderFixtures(): null {
  const color = (bytes: readonly number[]): string => `rgb(${bytes[0] ?? 0} ${bytes[1] ?? 0} ${bytes[2] ?? 0})`;
  const splitFile = async (left: readonly number[], right: readonly number[]): Promise<File> => {
    const canvas = new OffscreenCanvas(2048, 1536);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No flat fixture context.');
    context.fillStyle = color(left); context.fillRect(0, 0, 1024, 1536);
    context.fillStyle = color(right); context.fillRect(1024, 0, 1024, 1536);
    return new File([await canvas.convertToBlob({ type: 'image/png' })], 'flat.png', { type: 'image/png' });
  };
  window.__renderFixtures = {
    async gradientFile(different) {
      const canvas = new OffscreenCanvas(4032, 3024);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('No JPEG fixture context.');
      const gradient = context.createLinearGradient(0, 0, 4032, 3024);
      gradient.addColorStop(0, different ? '#1721ed' : '#ef2637');
      gradient.addColorStop(0.5, different ? '#fdac28' : '#28de91');
      gradient.addColorStop(1, different ? '#ac1dc4' : '#284af1');
      context.fillStyle = gradient; context.fillRect(0, 0, 4032, 3024);
      return new File([await canvas.convertToBlob({ type: 'image/jpeg' })], 'judge.jpg', { type: 'image/jpeg' });
    },
    flatFile: (bytes) => splitFile(bytes, bytes), splitFile,
    async readPng(blob) {
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
        if (context === null) throw new Error('No PNG readback context.');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      } finally { bitmap.close(); }
    },
  };
  return null;
}

const FirstLook = z.object({
  status: z.string(), stage: z.object({ width: z.number(), height: z.number(), visible: z.boolean() }),
  identityError: z.number(), repeatedBytesEqual: z.boolean(), bandsChangedBytes: z.boolean(), cacheChanged: z.boolean(),
  stageExportError: z.number(),
  png: z.object({ type: z.string(), width: z.number(), height: z.number() }),
  lastMs: z.number(), simplifyMs: z.number(), bandsSamples: z.array(z.number()), simplifySamples: z.array(z.number()),
  sliders: z.array(z.object({ field: z.string(), expected: z.number(), actual: z.number() })),
  fry: z.array(z.object({ field: z.string(), expected: z.number(), actual: z.number() })), clamped: z.array(z.number()),
});

/** Self-contained page code, with the same gradient JPEG fixture as demo.import.
 * That scenario's helper is private and its file is outside D2a's write scope. */
async function firstLook(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('The demo test surface is missing.');
  const settle = async (): Promise<void> => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
  const importJpeg = async (different: boolean): Promise<Uint8ClampedArray> => {
    const fixtures = window.__renderFixtures;
    if (fixtures === undefined) throw new Error('Render fixture recipes are missing.');
    const file = await fixtures.gradientFile(different);
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default', resizeWidth: 2048, resizeHeight: 1536, resizeQuality: 'high' });
    const masterCanvas = new OffscreenCanvas(2048, 1536);
    const masterContext = masterCanvas.getContext('2d', { alpha: false, colorSpace: 'srgb', willReadFrequently: true });
    if (masterContext === null) throw new Error('No comparison master context.');
    masterContext.drawImage(bitmap, 0, 0); bitmap.close();
    const patch = masterContext.getImageData(512, 512, 64, 64).data;
    await demo.importFile(file);
    // D2a checks need a clean chain before the later camera stage.
    demo.setStyle({ grain: 0, colorNoise: 0, crunch: 0, clipping: 0 });
    await settle();
    return patch;
  };
  const master = await importJpeg(false);
  const render = demo.render;
  const stage = document.querySelector<HTMLCanvasElement>('[data-testid=stage]');
  if (render === null || stage === null) throw new Error(`No renderer: ${demo.scene().status}`);
  demo.setStyle({ simplify: 0 });
  const originalPatch = render.readSimplifiedPatch(512, 512, 64, 64);
  let identityError = 0;
  for (let i = 0; i < master.length; i++) if (i % 4 !== 3) identityError = Math.max(identityError, Math.abs((originalPatch[i] ?? 0) - (master[i] ?? 0)));
  const a = await demo.downloadPng();
  const b = await demo.downloadPng();
  const ab = new Uint8Array(await a.arrayBuffer());
  const bb = new Uint8Array(await b.arrayBuffer());
  const repeatedBytesEqual = ab.length === bb.length && ab.every((v, i) => v === bb[i]);
  const png = await createImageBitmap(a);
  const pngInfo = { type: a.type, width: png.width, height: png.height };
  const capture = new OffscreenCanvas(stage.width, stage.height);
  const captureContext = capture.getContext('2d', { alpha: false, colorSpace: 'srgb', willReadFrequently: true });
  if (captureContext === null) throw new Error('No stage capture context.');
  captureContext.drawImage(stage, 0, 0);
  const stagePixels = captureContext.getImageData(0, 0, stage.width, stage.height).data;
  captureContext.drawImage(png, 0, 0); png.close();
  const pngPixels = captureContext.getImageData(0, 0, stage.width, stage.height).data;
  let stageExportError = 0;
  for (let i = 0; i < stagePixels.length; i++) stageExportError = Math.max(stageExportError, Math.abs((stagePixels[i] ?? 0) - (pngPixels[i] ?? 0)));
  demo.setStyle({ bands: 2 });
  const cb = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
  const bandsChangedBytes = cb.length !== ab.length || cb.some((v, i) => v !== ab[i]);
  await importJpeg(true);
  demo.setStyle({ simplify: 0 });
  const nextPatch = render.readSimplifiedPatch(512, 512, 64, 64);
  const cacheChanged = nextPatch.some((v, i) => i % 4 !== 3 && v !== originalPatch[i]);

  const sliders: { field: string; expected: number; actual: number }[] = [];
  const move = async (field: string, expected: number): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid=style-${field}]`);
    if (input === null) throw new Error(`Missing ${field} slider.`);
    input.value = String(expected); input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    sliders.push({ field, expected, actual: Number(document.querySelector(`[data-testid=value-${field}]`)?.textContent) });
  };
  for (const [field, value] of [['colors', 3], ['bands', 5], ['saturation', 0.2], ['simplify', 0.25], ['outline', 0.1], ['subjectClarity', 0.35]] satisfies readonly (readonly [string, number])[]) await move(field, value);
  await move('fry', 1);
  const fry = [['colors', 4], ['saturation', 0.9], ['simplify', 0.8], ['bands', 3], ['grain', 0.8], ['colorNoise', 0.5], ['crunch', 0.7], ['clipping', 0.5]]
    .map(([field, expected]) => ({ field: String(field), expected: Number(expected), actual: Number(document.querySelector(`[data-testid=value-${field}]`)?.textContent) }));
  demo.setStyle({ colors: 100, bands: -1 }); await settle();
  const clamped = ['colors', 'bands'].map((field) => Number(document.querySelector(`[data-testid=value-${field}]`)?.textContent));
  // Fry re-enables camera effects; isolate the D2a timing checks again.
  demo.setStyle({ simplify: 0.52, colors: 12, outline: 0.4, grain: 0, colorNoise: 0, crunch: 0, clipping: 0 });
  for (let i = 0; i < 2; i++) demo.setStyle({ bands: i % 2 === 0 ? 5 : 4 });
  const bandsSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    demo.setStyle({ bands: i % 2 === 0 ? 5 : 4 }); bandsSamples.push(render.timings().lastMs);
  }
  for (let i = 0; i < 2; i++) demo.setStyle({ simplify: i % 2 === 0 ? 0.53 : 0.52 });
  const simplifySamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    demo.setStyle({ simplify: i % 2 === 0 ? 0.53 : 0.52 }); simplifySamples.push(render.timings().simplifyMs);
  }
  const median = (values: readonly number[]): number => [...values].sort((x, y) => x - y)[2] ?? Infinity;
  return {
    status: demo.scene().status, stage: { width: stage.width, height: stage.height, visible: stage.getBoundingClientRect().width > 0 },
    identityError, repeatedBytesEqual, bandsChangedBytes, cacheChanged, stageExportError, png: pngInfo,
    lastMs: median(bandsSamples), simplifyMs: median(simplifySamples), bandsSamples, simplifySamples, sliders, fry, clamped,
  };
}

const Outline = z.object({
  status: z.string(), expectedSides: z.array(z.array(z.number())), ink: z.array(z.number()), baseline: z.array(z.array(z.number())),
  thin: z.array(z.array(z.number())), thick: z.array(z.array(z.number())), flatEqual: z.boolean(),
});

async function outlineFixture(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('The demo test surface is missing.');
  const width = 2048;
  const height = 1536;
  const edge = width / 2;
  const linearToSrgb = (v: number): number => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  const rgbByte = (L: number): number => Math.round(255 * linearToSrgb(L ** 3));
  const source = [rgbByte(0.3), rgbByte(0.8)];
  const importFixture = async (flat: boolean): Promise<void> => {
    const fixtures = window.__renderFixtures;
    if (fixtures === undefined) throw new Error('Render fixture recipes are missing.');
    const lo = source[0] ?? 0, hi = source[flat ? 0 : 1] ?? 0;
    const file = await fixtures.splitFile([lo, lo, lo], [hi, hi, hi]);
    await demo.importFile(file);
    // Exact outline colors assume a clean chain with no camera effects.
    demo.setStyle({ simplify: 0, colors: 2, saturation: 0, bands: 4, outline: 0, grain: 0, colorNoise: 0, crunch: 0, clipping: 0 });
  };
  const read = async (): Promise<Uint8ClampedArray> => {
    if (window.__renderFixtures === undefined) throw new Error('Render fixture recipes are missing.');
    return window.__renderFixtures.readPng(await demo.downloadPng());
  };
  const samples = (bytes: Uint8ClampedArray): number[][] => Array.from({ length: 33 }, (_, i) => {
    const offset = (512 * width + edge - 16 + i) * 4;
    return [...bytes.subarray(offset, offset + 4)];
  });
  const expectedSides = source.map((byte) => {
    const srgb = byte / 255;
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    const L = Math.cbrt(linear);
    const W = Math.min(Math.max(L - 0.25, 0), 0.55);
    const s = L - 0.25 - W;
    const band = Math.min(3, Math.max(0, Math.floor(Math.min(1, Math.max(0, s / 0.45 + 0.55)) * 4)));
    const color = rgbByte(W + 0.45 * (band + 0.5) / 4);
    return [color, color, color, 255];
  });
  const lowSource = source[0] ?? 0;
  const v = lowSource / 255;
  const L = Math.cbrt(v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const inkByte = rgbByte(Math.min(Math.max(L - 0.25, 0), 0.55) + 0.45 * 0.5 / 4);
  const ink = [inkByte, inkByte, inkByte, 255];
  await importFixture(false);
  const baseline = samples(await read());
  demo.setStyle({ outline: 0.4 }); const thin = samples(await read());
  demo.setStyle({ outline: 1 }); const thick = samples(await read());
  await importFixture(true);
  const flatBefore = await read();
  demo.setStyle({ outline: 1 }); const flatAfter = await read();
  return { status: demo.scene().status, expectedSides, ink, baseline, thin, thick,
    flatEqual: flatBefore.length === flatAfter.length && flatBefore.every((value, i) => value === flatAfter[i]) };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'render.first-look', title: 'master-size first look, identity, deterministic export, cache, sliders, and warmed 32-entry timings', target: 'dev', covers: [],
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('render demo boot', z.boolean(), () => window.__noisyTest?.demo !== undefined);
      await t.page.evaluate(z.null(), installRenderFixtures);
      const result = await t.page.evaluate(FirstLook, firstLook);
      t.equal('render status', result.status, 'Ready');
      t.equal('stage rendered at master size and visible', result.stage, { width: 2048, height: 1536, visible: true });
      t.equal('stage and rendered PNG match in every channel', result.stageExportError, 0);
      t.equal('simplify zero RGB patch equals independently decoded master', result.identityError, 0);
      t.ok('unchanged PNG exports are byte identical', result.repeatedBytesEqual);
      t.ok('bands changes PNG bytes', result.bandsChangedBytes);
      t.ok('second different JPEG rebuilds simplification', result.cacheChanged);
      t.equal('PNG MIME and master dimensions', result.png, { type: 'image/png', width: 2048, height: 1536 });
      for (const slider of result.sliders) t.equal(`${slider.field} slider updates document value`, slider.actual, slider.expected);
      for (const field of result.fry) t.equal(`Fry rewrites ${field.field}`, field.actual, field.expected);
      t.equal('applyEdit clamps colors and bands', result.clamped, [12, 2]);
      t.ok('32-distance bands render median below 50 ms', result.lastMs < 50, { samples: result.bandsSamples, median: result.lastMs });
      t.ok('simplify median below 60 ms', result.simplifyMs < 60, { samples: result.simplifySamples, median: result.simplifyMs });
      await t.file('first-look.json', JSON.stringify(result, null, 2));
      await t.page.screenshot('first-look');
    },
  },
  {
    id: 'render.outline', title: 'texture-edge crossing produces exact outline width and ink; flat image is a negative control', target: 'dev', covers: [],
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('render demo boot', z.boolean(), () => window.__noisyTest?.demo !== undefined);
      await t.page.evaluate(z.null(), installRenderFixtures);
      const result = await t.page.evaluate(Outline, outlineFixture);
      t.equal('fixture render status', result.status, 'Ready');
      for (let i = 0; i < result.baseline.length; i++) {
        const x = i - 16;
        const side = result.expectedSides[x < 0 ? 0 : 1];
        if (side === undefined) throw new Error('Missing expected side.');
        t.equal(`outline zero at edge offset ${x} is side quantization`, result.baseline[i], side);
        const distance = Math.abs(x + 0.5);
        const expectedThin = side.map((value, channel) => channel === 3 ? 255 : Math.round(0.6 * value + 0.4 * (result.ink[channel] ?? 0)));
        if (distance < 1) {
          const pixel = result.thin[i];
          t.ok(`outline 0.4 at ${x} mixes darkest variant`, pixel !== undefined && pixel.every((v, c) => Math.abs(v - (expectedThin[c] ?? 0)) <= 2), { actual: pixel, expected: expectedThin });
        } else t.equal(`outline 0.4 outside its band at ${x} is unchanged`, result.thin[i], result.baseline[i]);
        t.equal(`outline 1 at ${x} has exactly three pixels each side`, result.thick[i], distance < 3 ? result.ink : result.baseline[i]);
      }
      t.ok('flat fixture has no change in any pixel at outline 1', result.flatEqual);
      await t.file('outline.json', JSON.stringify(result, null, 2));
      await t.page.screenshot('flat-negative-control');
    },
  },
];
