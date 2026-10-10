import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Scenario } from '../scenario.ts';
import { installRenderFixtures } from './render.scenario.ts';

const resultSchema = z.object({
  width: z.number(), height: z.number(), defaultOff: z.boolean(), offIdentical: z.boolean(),
  solidDiffers: z.boolean(), flatCells: z.number(), glyphCells: z.number(), adjacent: z.boolean(),
  twoToneCells: z.number(), within24: z.boolean(), next24Differs: z.boolean(),
  outlineIdentical: z.boolean(), controls: z.boolean(), deterministic: z.boolean(), cameraDiffers: z.boolean(),
  samples: z.array(z.object({ cx: z.number(), cy: z.number(), label: z.number(), entry: z.number(), band: z.number(),
    tone: z.number(), glyphIndex: z.number(), inkBand: z.number(), paperBand: z.number(),
    ink: z.array(z.number()), paper: z.array(z.number()), pureInk: z.boolean(), purePaper: z.boolean() })),
  timingMs: z.array(z.number()), medianMs: z.number(), passesMs: z.record(z.string(), z.number()),
});

export const scenarios: readonly Scenario[] = [{
  id: 'render.symbols',
  title: 'Centered cells, adjacent-band symbols, document controls and full-chain timings',
  covers: ['render.symbols.off', 'render.symbols.cells', 'render.symbols.ink-paper', 'render.symbols.period',
    'render.symbols.outline', 'render.symbols.controls', 'render.symbols.camera', 'render.symbols.timing'],
  target: 'dev',
  async run(context) {
    await context.page.goto(context.baseUrl);
    await context.page.evaluate(z.boolean(), async () => {
      const start = performance.now();
      while (window.__noisyTest?.demo === undefined) {
        if (performance.now()-start > 10000) throw new Error('The demo surface did not become ready.');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return true;
    });
    await context.page.evaluate(z.unknown(), installRenderFixtures);
    const report = await context.page.evaluate(resultSchema, async () => {
      const demo = window.__noisyTest?.demo, fixtures = window.__renderFixtures;
      if (demo === undefined || fixtures === undefined) throw new Error('The shared render fixtures and demo surface are required.');
      await demo.importFile(await fixtures.gradientFile(false));
      const master = demo.scene().master;
      if (master === null) throw new Error('The shared gradient did not open.');
      const { width, height } = master;
      const nextPaint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await nextPaint();
      const defaultOff = demo.document()?.symbols.enabled === false;
      demo.setStyle({ simplify: 0, outline: 0, grain: 0, colorNoise: 0, crunch: 0, clipping: 0 });
      demo.setSymbols({ enabled: false, cellSize: 12, amount: 0 });
      // Capture the existing off path before the first cells pass executes.
      // A prior-revision PNG, if required, must be captured by the lead.
      const off = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
      const bytes = async (): Promise<Uint8Array> => new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
      const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
      const rgb = (pixels: Uint8ClampedArray, x: number, y: number): number[] => Array.from(pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3));
      const grid = (size: number) => {
        const origin = (n: number): number => (n-size)/2 - Math.ceil((n-size)/2/size)*size;
        const ox = origin(width), oy = origin(height);
        const xs: number[] = [], ys: number[] = [];
        for (let cx=0; cx<Math.ceil(width/size)+1; cx++) {
          const start = Math.ceil(ox-.5)+cx*size;
          if (start >= 0 && start+size <= width) xs.push(cx);
        }
        for (let cy=0; cy<Math.ceil(height/size)+1; cy++) {
          const start = Math.ceil(oy-.5)+cy*size;
          if (start >= 0 && start+size <= height) ys.push(cy);
        }
        const at = (list: readonly number[], i: number, count: number): number => {
          const v = list[Math.floor((i+.5)*list.length/count)];
          if (v === undefined) throw new Error('The gradient has too few complete cells.');
          return v;
        };
        const samples = Array.from({ length: 20 }, (_, i) => {
          const cx = at(xs, i%5, 5), cy = at(ys, Math.floor(i/5), 4);
          return { cx, cy, x: Math.ceil(ox-.5)+cx*size, y: Math.ceil(oy-.5)+cy*size };
        });
        return { xs, ys, ox, oy, samples };
      };
      const input = (id: string): HTMLInputElement => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        if (!(element instanceof HTMLInputElement)) throw new Error(`Missing Symbols control ${id}.`);
        return element;
      };
      const slide = async (id: string, value: number): Promise<void> => {
        const element = input(id); element.value = String(value);
        element.dispatchEvent(new Event('input', { bubbles: true })); await nextPaint();
      };
      input('symbols-enabled').click(); await nextPaint();
      await slide('symbols-cellSize', 12); await slide('symbols-amount', 0);
      const enabledControl = demo.document()?.symbols.enabled === true && input('symbols-enabled').checked;
      const solidBlob = await demo.downloadPng(), solid = await fixtures.readPng(solidBlob);
      const solidDiffers = !same(off, new Uint8Array(await solidBlob.arrayBuffer()));
      const grid12 = grid(12);
      let flatCells = 0;
      for (const { x, y } of grid12.samples) {
        const first = rgb(solid, x, y);
        let flat = true;
        for (let dy=0; dy<12; dy++) for (let dx=0; dx<12; dx++) {
          if (!same(first, rgb(solid, x+dx, y+dy))) flat = false;
        }
        if (flat) flatCells++;
      }
      await slide('symbols-amount', 1);
      const amountControl = demo.document()?.symbols.amount === 1 && document.querySelector('[data-testid="value-amount"]')?.textContent === '1';
      const glyphBlob = await demo.downloadPng(), glyphPixels = await fixtures.readPng(glyphBlob);
      const debug = demo.render;
      if (debug === null) throw new Error('The cell debug surface is required.');
      const glyphSamples = [...grid12.samples];
      // At size 12 the thin bars can consist entirely of antialias pixels.
      // Include a dot, whose center has exact ink, to check the LUT bytes.
      if (!glyphSamples.some(({ cx, cy }) => debug.readCellTable(cx, cy).glyphIndex === 0)) {
        let found = false;
        for (const cy of grid12.ys) {
          for (const cx of grid12.xs) {
            if (debug.readCellTable(cx, cy).glyphIndex !== 0) continue;
            glyphSamples[19] = { cx, cy, x: Math.ceil(grid12.ox-.5)+cx*12, y: Math.ceil(grid12.oy-.5)+cy*12 };
            found = true; break;
          }
          if (found) break;
        }
      }
      let adjacent = true, glyphCells = 0, twoToneCells = 0;
      const samples = glyphSamples.map(({ cx, cy, x, y }) => {
        const cell = debug.readCellTable(cx, cy);
        if (cell.glyphIndex >= 0) glyphCells++;
        const side = cell.tone < .5 ? -1 : 1;
        if (cell.inkBand-cell.paperBand !== side || same(cell.ink, cell.paper) || !(cell.band === cell.inkBand || cell.band === cell.paperBand)) adjacent = false;
        let pureInk = false, purePaper = false;
        for (let dy=0; dy<12; dy++) for (let dx=0; dx<12; dx++) {
          const pixel = rgb(glyphPixels, x+dx, y+dy);
          if (same(pixel, cell.ink)) pureInk = true;
          if (same(pixel, cell.paper)) purePaper = true;
          for (let c=0; c<3; c++) {
            const a = cell.ink[c], b = cell.paper[c], value = pixel[c];
            if (a === undefined || b === undefined || value === undefined || value < Math.min(a,b) || value > Math.max(a,b)) adjacent = false;
          }
        }
        if (pureInk && purePaper) twoToneCells++;
        return { cx, cy, ...cell, ink: [...cell.ink], paper: [...cell.paper], pureInk, purePaper };
      });
      await slide('symbols-amount', 0); await slide('symbols-cellSize', 24);
      const sizeControl = demo.document()?.symbols.cellSize === 24 && document.querySelector('[data-testid="value-cellSize"]')?.textContent === '24';
      const blocks24 = await fixtures.readPng(await demo.downloadPng()), grid24 = grid(24);
      let within24 = true, next24Differs = false;
      for (const { x, y } of grid24.samples) for (let dx=0; dx<24; dx++) {
        if (!same(rgb(blocks24,x+dx,y+1), rgb(blocks24,x+dx,y+13))) within24 = false;
      }
      for (const cy of grid24.ys) for (const cx of grid24.xs) {
        const x = Math.ceil(grid24.ox-.5)+cx*24+1, y = Math.ceil(grid24.oy-.5)+cy*24+1;
        if (y+24 < height && !same(rgb(blocks24,x,y), rgb(blocks24,x,y+24))) next24Differs = true;
      }
      demo.setSymbols({ enabled: true, cellSize: 12, amount: 1 });
      demo.setStyle({ outline: 0 }); const noOutline = await bytes();
      demo.setStyle({ outline: 1 }); const fullOutline = await bytes();
      const outlineIdentical = same(noOutline, fullOutline);
      demo.setStyle({ outline: 0 });
      demo.setSymbols({ enabled: false }); const afterOff = await bytes();
      const offIdentical = same(off, afterOff);
      demo.setSymbols({ enabled: true, cellSize: 12, amount: 1 });
      const cleanSymbols = await bytes();
      // Timings exercise the entire chain with all three camera effects active.
      demo.setStyle({ grain: .3, colorNoise: .25, crunch: .25, clipping: .3 });
      const cameraSymbols = await bytes();
      const cameraDiffers = !same(cleanSymbols, cameraSymbols);
      const deterministic = same(cameraSymbols, await bytes());
      await bytes(); await bytes();
      const timingMs: number[] = [];
      for (let i=0; i<5; i++) { await bytes(); timingMs.push(debug.timings().lastMs); }
      const medianMs = [...timingMs].sort((a,b) => a-b)[2];
      if (medianMs === undefined) throw new Error('Five timing samples are required.');
      // Profile once on failure; these synchronized costs are diagnostic only.
      const passesMs = medianMs >= 50 ? { ...debug.profileCamera() } : {};
      return { width, height, defaultOff, offIdentical, solidDiffers, flatCells, glyphCells, adjacent, twoToneCells,
        within24, next24Differs, outlineIdentical, controls: enabledControl && amountControl && sizeControl,
        deterministic, cameraDiffers, samples, timingMs, medianMs, passesMs };
    });
    await context.file('symbols.json', JSON.stringify(report, null, 2));
    await context.page.screenshot('symbols');
    context.ok('render.symbols.off', report.defaultOff && report.offIdentical, report);
    context.ok('render.symbols.cells', report.solidDiffers && report.flatCells === 20, report);
    context.ok('render.symbols.ink-paper', report.glyphCells === 20 && report.adjacent && report.twoToneCells > 0, report.samples);
    context.ok('render.symbols.period', report.within24 && report.next24Differs, report);
    context.equal('render.symbols.outline', report.outlineIdentical, true);
    context.equal('render.symbols.controls', report.controls, true);
    context.ok('render.symbols.camera', report.deterministic && report.cameraDiffers, report);
    context.ok('render.symbols.timing', report.width === 2048 && report.height === 1536 && report.medianMs < 50,
      { samples: report.timingMs, median: report.medianMs, passes: report.passesMs });
    assert.equal(report.width, 2048); assert.equal(report.height, 1536);
    assert.equal(report.defaultOff, true); assert.equal(report.offIdentical, true, 'Symbols off changed after using the cells pass');
    assert.equal(report.solidDiffers, true); assert.equal(report.flatCells, 20, 'Every sampled solid cell must be flat');
    assert.equal(report.glyphCells, 20); assert.equal(report.adjacent, true); assert.ok(report.twoToneCells > 0, 'A sampled glyph must contain exact adjacent ink and paper variants');
    assert.equal(report.within24, true); assert.equal(report.next24Differs, true);
    assert.equal(report.outlineIdentical, true); assert.equal(report.controls, true);
    assert.equal(report.deterministic, true); assert.equal(report.cameraDiffers, true);
    assert.ok(report.medianMs < 50, `Symbols full-chain median ${report.medianMs} ms; passes ${JSON.stringify(report.passesMs)}`);
  },
}];
