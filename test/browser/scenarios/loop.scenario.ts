import type { Scenario } from '../scenario.ts';
import { z } from 'zod';
import { LOOP_ZOOM, PARALLAX_MARGIN, cameraOffset, parallaxDisplacement, loopPhase, frameCount } from '../../../src/core/motion.ts';

const resultSchema = z.object({ moved: z.boolean(), wrap: z.boolean(), still: z.boolean(), edges: z.boolean(),
  offSamples: z.array(z.number()), onSamples: z.array(z.number()), stopped: z.boolean(), controls: z.boolean(), noObjects: z.boolean(), zeroOrbit: z.boolean(),
  landscape: z.object({ width: z.number(), height: z.number() }).nullable(), portrait: z.object({ width: z.number(), height: z.number() }).nullable() });

const loopScenario: Scenario = {
  id: 'render.loop', title: 'Parallax loop, still and borders', covers: ['D6'], target: 'dev', timeoutMs: 300_000,
  async run(context) {
    const { page } = context;
    await page.goto(context.baseUrl);
    const result = await page.evaluate(resultSchema, async () => {
      const demo = window.__noisyTest?.demo;
      if (demo === undefined) throw new Error('The dev surface is missing.');
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const wait = async (ready: () => boolean) => { const start = performance.now(); while (!ready()) {
        if (performance.now() - start > 150_000) throw new Error(`Depth/decoder not ready: ${demo.analysis().status}`);
        await sleep(100);
      } };
      const file = async (portrait: boolean) => {
        const canvas = document.createElement('canvas');
        canvas.width = portrait ? 3024 : 4032; canvas.height = portrait ? 4032 : 3024;
        const ctx = canvas.getContext('2d'); if (ctx === null) throw new Error('No fixture context.');
        ctx.fillStyle = '#a0a0a0'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        // A saturated disc on gray, with frame-space stripes on the back to
        // make motion observable even with a flat background depth estimate.
        ctx.fillStyle = '#989898';
        for (let x = 0; x < canvas.width; x += 170) ctx.fillRect(x, 0, 50, canvas.height);
        ctx.fillStyle = '#ed382d'; ctx.beginPath(); ctx.arc(canvas.width * .5, canvas.height * .5, Math.min(canvas.width, canvas.height) * .16, 0, 2 * Math.PI); ctx.fill();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob === null ? reject(new Error('No fixture PNG.')) : resolve(blob), 'image/png'));
        return new File([blob], portrait ? 'loop-portrait.png' : 'loop-disc.png', { type: 'image/png' });
      };
      const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
      const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
      const png = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); if (ctx === null) throw new Error('No PNG context.');
        ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const border = async (blob: Blob) => {
        const { width, height, data } = await png(blob);
        const covered = (x: number, y: number) => { const i = (y * width + x) * 4;
          return data[i + 3] === 255 && !(data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0);
        };
        for (let x = 0; x < width; x++) if (!covered(x, 0) || !covered(x, height - 1)) return false;
        for (let y = 0; y < height; y++) if (!covered(0, y) || !covered(width - 1, y)) return false;
        return true;
      };
      await demo.importFile(await file(false)); await wait(() => demo.analysis().depth);
      demo.setStyle({ grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 }); demo.setSymbols({ enabled: false });
      const landscape = demo.scene().master;
      const noObjects = demo.objects().length === 0;
      const stillOff = await bytes(await demo.downloadPng());
      const toggle = document.querySelector('[data-testid="motion-enabled"]');
      if (!(toggle instanceof HTMLInputElement)) throw new Error('No Motion toggle.');
      toggle.click();
      const setSliders = (values: readonly (readonly [string, string])[]) => { for (const [field, value] of values) {
        const input = document.querySelector(`[data-testid="motion-${field}"]`);
        if (!(input instanceof HTMLInputElement)) throw new Error(`No ${field} input.`);
        input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      } };
      setSliders([['orbit', '0.4'], ['loopSeconds', '2.6']]);
      const changedSliders = demo.document()?.motion.orbit === .4 && demo.document()?.motion.loopSeconds === 2.6;
      setSliders([['orbit', '0.6'], ['loopSeconds', '3']]);
      const controls = changedSliders && demo.document()?.motion.enabled === true && demo.document()?.motion.orbit === .6 && demo.document()?.motion.loopSeconds === 3;
      const count = Math.round((demo.document()?.motion.loopSeconds ?? 3) * 30);
      demo.setMotion({ orbit: 0 });
      const zeroOrbit = equal(stillOff, await bytes(await demo.exportFrame(0)));
      demo.setMotion({ orbit: .6 });
      const zero = await demo.exportFrame(0), quarter = await demo.exportFrame(Math.floor(count / 4));
      const moved = !equal(await bytes(zero), await bytes(quarter));
      let wrap = equal(await bytes(zero), await bytes(await demo.exportFrame(count)));
      let still = equal(stillOff, await bytes(await demo.downloadPng()));
      let edges = true;
      for (const frame of [0, Math.floor(count / 4), Math.floor(count / 2), Math.floor(count * 3 / 4)]) edges = await border(await demo.exportFrame(frame)) && demo.render?.geometryEdgesCovered() === true && edges;
      const samples = async () => {
        await demo.renderFrameAt(0); await demo.renderFrameAt(1);
        const samples: number[] = [];
        for (let i = 2; i < 7; i++) { await demo.renderFrameAt(i); samples.push(demo.render?.timings().lastMs ?? Infinity); }
        return samples;
      };
      const offSamples = await samples();
      demo.setStyle({ grain: .6, colorNoise: .3, clipping: .5, crunch: .6 }); demo.setSymbols({ enabled: true, cellSize: 12, amount: .6 });
      const onSamples = await samples();
      wrap = wrap && equal(await bytes(await demo.exportFrame(0)), await bytes(await demo.exportFrame(count)));
      const stillOnEffects = await bytes(await demo.downloadPng());
      toggle.click(); const stoppedAt = demo.frame(); await sleep(150); const stopped = stoppedAt === demo.frame() && demo.document()?.motion.enabled === false;
      still = still && equal(stillOnEffects, await bytes(await demo.downloadPng()));
      await demo.importFile(await file(true)); await wait(() => demo.analysis().depth);
      demo.setStyle({ grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 }); demo.setSymbols({ enabled: false });
      demo.setMotion({ enabled: true, orbit: .6, loopSeconds: 3 });
      for (const frame of [0, Math.floor(count / 4), Math.floor(count / 2), Math.floor(count * 3 / 4)]) edges = await border(await demo.exportFrame(frame)) && demo.render?.geometryEdgesCovered() === true && edges;
      return { moved, wrap, still, edges, offSamples, onSamples, stopped, controls, noObjects, zeroOrbit, landscape, portrait: demo.scene().master };
    });
    const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[2] ?? Infinity;
    await page.screenshot('loop');
    const stepMotion = { enabled: true, orbit: 1, loopSeconds: 4, focus: 0 };
    const count = frameCount(stepMotion, 30);
    const frames = [count / 4, count * 3 / 4];
    const expected = frames.map((frame, i) => {
      const displacement = parallaxDisplacement(cameraOffset(PARALLAX_MARGIN, loopPhase(frame, count)), .8, 0);
      const edge = i === 0 ? .75 : .25;
      return ((edge + displacement.y - .5) * LOOP_ZOOM + .5) * 1536;
    });
    const cuts = await page.evaluate(z.object({ step: z.array(z.number()), folds: z.array(z.number()), nearExtents: z.array(z.number()) }), async ({ motion, frames, expected }) => {
      const demo = window.__noisyTest?.demo;
      if (demo === undefined) throw new Error('The dev surface is missing.');
      const source = document.createElement('canvas'); source.width = 2048; source.height = 1536;
      const context = source.getContext('2d'); if (context === null) throw new Error('No step fixture context.');
      context.fillStyle = '#a0a0a0'; context.fillRect(0, 0, source.width, source.height);
      context.fillStyle = '#ed382d'; context.fillRect(512, 384, 1024, 768);
      const blob = await new Promise<Blob>((resolve, reject) => source.toBlob((value) => value === null ? reject(new Error('No step PNG.')) : resolve(value), 'image/png'));
      await demo.importFile(new File([blob], 'loop-depth-step.png', { type: 'image/png' }));
      const start = performance.now();
      while (!demo.analysis().depth) {
        if (performance.now() - start > 60_000) throw new Error('No depth metadata for the injected step.');
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      demo.setStyle({ simplify: 0, outline: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0 });
      demo.setSymbols({ enabled: false }); demo.setMotion(motion);
      const width = 2048, height = 1536;
      const cutWidths = async (disc: boolean) => {
        const data = new Float32Array(width * height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const near = disc ? x >= 512 && x < 1536 && y >= 384 && y < 1152 : x >= width / 2;
          data[y * width + x] = near ? .8 : .2;
        }
        demo.injectDepth({ format: 'f32', size: { width, height }, data });
        const cuts: number[] = [], extents: number[] = [];
        for (const [index, frame] of [0, ...frames].entries()) {
          const bitmap = await createImageBitmap(await demo.exportFrame(frame));
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d'); if (context === null) throw new Error('No step capture context.');
          context.drawImage(bitmap, 0, 0); bitmap.close();
          // In the right half, the disparity is .8. Compare its lower leading
          // edge moving down with its upper leading edge moving up.
          const column = context.getImageData(1280, 0, 1, height).data;
          let first = -1, last = -1;
          for (let y = 0; y < height; y++) {
            const i = y * 4;
            if ((column[i] ?? 0) <= (column[i + 1] ?? 0) + 30) continue;
            if (first < 0) first = y;
            last = y;
          }
          if (first < 0) throw new Error('The near rectangle has no colored edge.');
          extents.push(last - first + 1);
          if (index === 0) continue;
          const observed = index === 1 ? last + 1 : first;
          cuts.push(Math.abs((expected[index - 1] ?? 0) - observed));
        }
        return { cuts, extents };
      };
      // The left/right step is the requested fixture. A bounded near rectangle
      // additionally creates actual folded cells perpendicular to the camera
      // at these phases, catching the review's direction-dependent overpaint.
      const step = await cutWidths(false), folds = await cutWidths(true);
      return { step: step.cuts, folds: folds.cuts, nearExtents: step.extents };
    }, { motion: stepMotion, frames, expected });
    await context.file('loop.json', JSON.stringify({ ...result, offMedian: median(result.offSamples), onMedian: median(result.onSamples), cutWidths: cuts, quarterFarSideCut: cuts.step[0] }, null, 2));
    await page.screenshot('loop-folds');
    context.ok('the scene moves', result.moved);
    context.ok('the loop wraps byte for byte', result.wrap);
    context.ok('motion leaves the still export untouched', result.still);
    context.ok('landscape and portrait borders are covered', result.edges);
    context.ok('Motion controls edit the document', result.controls);
    context.ok('Motion off stops the frame index', result.stopped);
    context.ok('no objects in the back-layer motion check', result.noObjects);
    context.ok('orbit zero retains the identity still', result.zeroOrbit);
    context.ok('landscape timing is at 2048x1536', result.landscape?.width === 2048 && result.landscape.height === 1536);
    context.ok('portrait coverage is at 1536x2048', result.portrait?.width === 1536 && result.portrait.height === 2048);
    context.ok('warmed loop below 33 ms without camera effects or symbols', median(result.offSamples) < 33);
    context.ok('warmed loop below 50 ms with camera effects and symbols', median(result.onSamples) < 50);
    context.ok('left/right step near region remains unoccluded at quarter and three quarters', cuts.nearExtents.length === 3 && cuts.nearExtents.slice(1).every((extent) => extent >= (cuts.nearExtents[0] ?? Infinity) - 1));
    context.ok('folded near-rectangle cuts are symmetric within 4 px at quarter and three quarters', cuts.folds.length === 2 && Math.abs((cuts.folds[0] ?? Infinity) - (cuts.folds[1] ?? 0)) <= 4);
  },
};

const objectSchema = z.object({ preparing: z.boolean(), pendingStill: z.boolean(), pendingStopped: z.boolean(),
  plate: z.boolean(), fresh: z.boolean(), exposed: z.boolean(), point: z.object({ x: z.number(), y: z.number() }).nullable(),
  geometry: z.array(z.number()), plateColor: z.array(z.number()), discColor: z.array(z.number()), plateError: z.number(), discError: z.number(), backgroundPixels: z.array(z.array(z.number())), backgroundReference: z.array(z.number()) });

const objectScenario: Scenario = {
  id: 'render.loop-objects', title: 'Plate exposed behind a displaced disc', covers: ['D6'], target: 'dev', timeoutMs: 300_000,
  async run(context) {
    const { page } = context;
    await page.goto(context.baseUrl);
    const result = await page.evaluate(objectSchema, async (zoom) => {
      const demo = window.__noisyTest?.demo;
      if (demo === undefined) throw new Error('The dev surface is missing.');
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const wait = async (ready: () => boolean, timeout: number) => { const start = performance.now(); while (!ready()) {
        if (performance.now() - start > timeout) throw new Error(`Loop object timeout: ${demo.analysis().status}`);
        await sleep(25);
      } };
      const source = document.createElement('canvas'); source.width = 4032; source.height = 3024;
      const ctx = source.getContext('2d'); if (ctx === null) throw new Error('No fixture context.');
      ctx.fillStyle = '#a0a0a0'; ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#ed382d'; ctx.beginPath(); ctx.arc(2016, 1512, 484, 0, 2 * Math.PI); ctx.fill();
      const blob = await new Promise<Blob>((resolve, reject) => source.toBlob((value) => value === null ? reject(new Error('No disc PNG.')) : resolve(value), 'image/png'));
      await demo.importFile(new File([blob], 'loop-object-disc.png', { type: 'image/png' }));
      await wait(() => demo.analysis().depth && demo.analysis().decoderReady, 150_000);
      const defaultSimplify = demo.document()?.style.simplify;
      if (defaultSimplify === undefined) throw new Error('No default simplify.');
      await demo.tap(.5, .5); demo.select(null);
      const object = demo.objects()[0]; if (object === undefined) throw new Error('The disc was not selected.');
      demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 });
      demo.setSymbols({ enabled: false }); demo.setMotion({ focus: 0, orbit: 1, loopSeconds: 3 });
      const capture = () => {
        const stage = document.querySelector('[data-testid="stage"]');
        if (!(stage instanceof HTMLCanvasElement)) throw new Error('No stage.');
        const canvas = document.createElement('canvas'); canvas.width = stage.width; canvas.height = stage.height;
        const context = canvas.getContext('2d'); if (context === null) throw new Error('No capture context.');
        context.drawImage(stage, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const before = capture();
      const toggle = document.querySelector('[data-testid="motion-enabled"]');
      if (!(toggle instanceof HTMLInputElement)) throw new Error('No Motion toggle.'); toggle.click();
      await wait(() => /preparing/i.test(document.querySelector('[data-testid="status"]')?.textContent ?? '') || demo.analysis().plate, 10_000);
      const preparing = /preparing/i.test(document.querySelector('[data-testid="status"]')?.textContent ?? '') && !demo.analysis().plate;
      const during = capture(), pendingFrame = demo.frame();
      const pendingStill = before.length === during.length && before.every((value, i) => value === during[i]);
      await sleep(100);
      const pendingStopped = !demo.analysis().plate && pendingFrame === demo.frame();
      await wait(() => demo.analysis().plate && !demo.products().plateNeeded, 90_000);
      const count = Math.round((demo.document()?.motion.loopSeconds ?? 3) * 30);
      const x = Math.round(object.bounds.x + object.bounds.width / 2);
      const startY = Math.max(0, Math.floor(object.bounds.y * zoom + (1 - zoom) * (demo.scene().master?.height ?? 1536) / 2) - 12);
      // Scan the upper silhouette at the same output points before and after
      // the quarter-loop displacement. This avoids assuming a perfect SAM edge.
      await demo.renderFrameAt(0);
      const original = Array.from({ length: 100 }, (_, i) => {
        const y = startY + i;
        return { y, pixel: demo.render?.geometryPixel(x, y) };
      });
      await demo.renderFrameAt(Math.floor(count / 4));
      let point: { x: number; y: number } | null = null;
      let geometry: readonly number[] = [], plateColor: readonly number[] = [], discColor: readonly number[] = [];
      let plateError = 255, discError = 0;
      const exposedPoints: { x: number; y: number }[] = [];
      for (const candidate of original) {
        if (candidate.pixel?.label !== 1) continue;
        const pixel = demo.render?.geometryPixel(x, candidate.y);
        if (pixel?.label !== 0) continue;
        exposedPoints.push({ x, y: candidate.y });
        // The plate fixture is flat gray. Compare the exposed G-buffer color
        // before palette quantization, with simplify exactly zero.
        const plate = demo.platePixel(x, candidate.y);
        const error = Math.max(...pixel.color.map((v, i) => Math.abs(v - (plate[i] ?? 0))));
        const contrast = Math.max(...pixel.color.map((v, i) => Math.abs(v - (candidate.pixel?.color[i] ?? 0))));
        if (error < plateError) {
          point = { x, y: candidate.y }; geometry = pixel.color; plateColor = plate; discColor = candidate.pixel.color;
          plateError = error; discError = contrast;
        }
      }
      const plate = demo.analysis().plate, fresh = !demo.products().plateNeeded;
      const readPng = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); if (context === null) throw new Error('No PNG context.');
        context.drawImage(bitmap, 0, 0); bitmap.close();
        return { width: canvas.width, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      demo.setStyle({ simplify: defaultSimplify });
      const simplifiedFrame = await readPng(await demo.exportFrame(Math.floor(count / 4)));
      const backgroundPixels = exposedPoints.map(({ x, y }) => {
        const offset = (y * simplifiedFrame.width + x) * 4;
        return Array.from(simplifiedFrame.data.subarray(offset, offset + 3));
      });
      // The flat background is sampled far from the disc in the same frame,
      // keeping the object's pinned palette clusters in the reference.
      const referenceOffset = (64 * simplifiedFrame.width + 64) * 4;
      const backgroundReference = Array.from(simplifiedFrame.data.subarray(referenceOffset, referenceOffset + 3));
      return { preparing, pendingStill, pendingStopped, plate, fresh,
        exposed: point !== null && plateError <= 8 && discError > 40, point, geometry: [...geometry], plateColor: [...plateColor], discColor: [...discColor], plateError, discError,
        backgroundPixels, backgroundReference };
    }, LOOP_ZOOM);
    await page.screenshot('loop-objects');
    const backgroundError = Math.max(0, ...result.backgroundPixels.flatMap((pixel) => pixel.map((value, i) => Math.abs(value - (result.backgroundReference[i] ?? 0)))));
    await context.file('loop-objects.json', JSON.stringify({ ...result, backgroundError }, null, 2));
    context.ok('Motion pending shows preparing', result.preparing);
    context.ok('the pending stage remains the still', result.pendingStill);
    context.ok('the pending loop does not advance', result.pendingStopped);
    context.ok('Motion produces a fresh plate', result.plate && result.fresh);
    context.ok('the vacated disc edge shows plate color', result.exposed);
    context.ok('default simplify treats exposed plate pixels as background within 2 levels', result.backgroundPixels.length > 0 && backgroundError <= 2);
  },
};

export const scenarios: readonly Scenario[] = [loopScenario, objectScenario];
