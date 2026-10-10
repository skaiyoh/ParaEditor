import type { Scenario } from '../scenario.ts';
import { z } from 'zod';
import { LOOP_ZOOM, PARALLAX_MARGIN, cameraOffset, parallaxDisplacement, loopPhase, frameCount, loopZoom } from '../../../src/core/motion.ts';

const travelSchema = z.object({ x: z.number(), y: z.number() });
const parallaxSchema = z.object({ orientation: z.enum(['landscape', 'portrait']), one: travelSchema, two: travelSchema,
  borders: z.boolean(), plateCovered: z.boolean(), still: z.boolean(), restored: z.boolean() });

const resultSchema = z.object({ moved: z.boolean(), wrap: z.boolean(), still: z.boolean(), edges: z.boolean(),
  offSamples: z.array(z.number()), onSamples: z.array(z.number()), stopped: z.boolean(), controls: z.boolean(), noObjects: z.boolean(), zeroOrbit: z.boolean(),
  parallaxControl: z.boolean(), parallax: z.array(parallaxSchema),
  landscape: z.object({ width: z.number(), height: z.number() }).nullable(), portrait: z.object({ width: z.number(), height: z.number() }).nullable() });

const loopScenario: Scenario = {
  id: 'render.loop', title: 'Parallax loop, still and borders', covers: ['D6', 'PH3'], target: 'dev', timeoutMs: 300_000,
  async run(context) {
    const { page } = context;
    await page.goto(context.baseUrl);
    const result = await page.evaluate(resultSchema, async ({ oneZoom, twoZoom }) => {
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
      const parallaxInput = document.querySelector('#motion-parallax');
      const inputs = Array.from(document.querySelectorAll('.inspector .node[aria-label="Motion"] input[type="range"]'));
      const orbitIndex = inputs.findIndex((input) => input.id === 'motion-orbit');
      const parallaxControl = parallaxInput instanceof HTMLInputElement && parallaxInput.min === '0.5' && parallaxInput.max === '3' &&
        parallaxInput.step === '0.1' && parallaxInput.value === '2' && parallaxInput.labels?.[0]?.textContent?.includes('Parallax') === true &&
        orbitIndex >= 0 && inputs[orbitIndex + 1] === parallaxInput && inputs[orbitIndex + 2]?.id === 'motion-loopSeconds';
      const toggle = document.querySelector('[data-testid="motion-enabled"]');
      if (!(toggle instanceof HTMLInputElement)) throw new Error('No Motion toggle.');
      toggle.click();
      const setSliders = (values: readonly (readonly [string, string])[]) => { for (const [field, value] of values) {
        const input = document.querySelector(`[data-testid="motion-${field}"]`);
        if (!(input instanceof HTMLInputElement)) throw new Error(`No ${field} input.`);
        input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      } };
      setSliders([['orbit', '0.4'], ['parallax', '2'], ['loopSeconds', '2.6']]);
      const changedSliders = demo.document()?.motion.orbit === .4 && demo.document()?.motion.parallax === 2 && demo.document()?.motion.loopSeconds === 2.6;
      setSliders([['orbit', '0.6'], ['parallax', '1'], ['loopSeconds', '3']]);
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
      const checkParallax = async (orientation: 'landscape' | 'portrait') => {
        await wait(() => demo.analysis().decoderReady);
        demo.setMotion({ enabled: false, orbit: 1, parallax: 1, loopSeconds: 4, focus: 0 });
        demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 }); demo.setSymbols({ enabled: false });
        const size = orientation === 'landscape' ? { width: 128, height: 96 } : { width: 96, height: 128 };
        const mask = new Uint8Array(size.width * size.height), depth = new Float32Array(mask.length).fill(.2);
        for (let y = size.height * .375; y < size.height * .625; y++) for (let x = size.width * .375; x < size.width * .625; x++) {
          const i = y * size.width + x; mask[i] = 255; depth[i] = 1;
        }
        demo.injectMask({ ...size, data: mask }); await wait(() => demo.objects().length === 1);
        demo.injectDepth({ format: 'f32', size, data: depth }); demo.select(null);
        demo.setMotion({ enabled: true }); await wait(() => demo.analysis().plate && !demo.products().plateNeeded);
        const stage = document.querySelector('[data-testid="stage"]'), renderer = window.__noisyTest?.session?.renderer();
        if (!(stage instanceof HTMLCanvasElement) || renderer === undefined || renderer === null) throw new Error('No Parallax stage or renderer.');
        const geometry = () => {
          const pixels = demo.render?.readGeometryPatch?.(0, 0, stage.width, stage.height);
          if (pixels === undefined) throw new Error('No Parallax geometry probe.');
          return pixels;
        };
        const centroid = () => {
          const pixels = geometry(); let x = 0, y = 0, count = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 1 && pixels[i + 3] === 255) {
            x += (i / 4) % stage.width; y += Math.floor(i / 4 / stage.width); count++;
          }
          if (count === 0) throw new Error('No near object in the Parallax fixture.');
          return { x: x / count, y: y / count };
        };
        const travel = async (parallax: number, zoom: number) => {
          demo.setMotion({ parallax }); renderer.renderView({ x: 0, y: 0 }, 0, false); const center = centroid();
          await demo.renderFrameAt(0); const moved = centroid();
          // Geometry zoom grows with the margin; compare camera travel in the stored frame.
          return { x: (moved.x - center.x) / zoom, y: (moved.y - center.y) / zoom };
        };
        const reference = await bytes(await demo.downloadPng());
        const one = await travel(1, oneZoom), firstFrame = await bytes(await demo.exportFrame(0));
        const two = await travel(2, twoZoom);
        let borders = true, plateCovered = true;
        for (const frame of [0, 30, 60, 90]) {
          borders = await border(await demo.exportFrame(frame)) && demo.render?.geometryEdgesCovered() === true && borders;
          await demo.renderFrameAt(frame); const pixels = geometry();
          // Every interior texel, including the vacated object edge, has an opaque back layer.
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) { plateCovered = false; break; }
        }
        let still = true;
        for (const parallax of [.5, 1, 1.7, 2, 3]) {
          demo.setMotion({ parallax }); still = equal(reference, await bytes(await demo.downloadPng())) && still;
        }
        demo.setMotion({ parallax: 1 });
        const restored = equal(firstFrame, await bytes(await demo.exportFrame(0)));
        return { orientation, one, two, borders, plateCovered, still, restored };
      };
      const parallax = [await checkParallax('landscape')];
      await demo.importFile(await file(true)); await wait(() => demo.analysis().depth);
      demo.setStyle({ grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 }); demo.setSymbols({ enabled: false });
      demo.setMotion({ enabled: true, orbit: .6, loopSeconds: 3 });
      for (const frame of [0, Math.floor(count / 4), Math.floor(count / 2), Math.floor(count * 3 / 4)]) edges = await border(await demo.exportFrame(frame)) && demo.render?.geometryEdgesCovered() === true && edges;
      parallax.push(await checkParallax('portrait'));
      return { moved, wrap, still, edges, offSamples, onSamples, stopped, controls, noObjects, zeroOrbit, parallaxControl, parallax, landscape, portrait: demo.scene().master };
    }, { oneZoom: loopZoom(1), twoZoom: loopZoom(2) });
    const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[2] ?? Infinity;
    await page.screenshot('loop');
    const stepMotion = { enabled: true, orbit: 1, parallax: 1, loopSeconds: 4, focus: 0 };
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
    context.ok('desktop Parallax row follows Orbit in Motion, defaults to 2 and ranges from 0.5 to 3 by 0.1', result.parallaxControl);
    for (const check of result.parallax) {
      context.ok(`${check.orientation}: Parallax 2 doubles the near object's frame-space displacement at frame 0`,
        Math.abs(check.one.x) > 10 && Math.abs(check.two.x - 2 * check.one.x) < 2 && Math.abs(check.one.y) < 1 && Math.abs(check.two.y) < 1, check);
      context.ok(`${check.orientation}: Parallax 2 keeps every border and the exposed plate covered`, check.borders && check.plateCovered, check);
      context.ok(`${check.orientation}: every tested amount keeps the identity still, and returning to 1 restores exact loop bytes`, check.still && check.restored, check);
    }
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



/** Capture real download intent and decode its GIF bytes inside the page. */
function installLoopCapture(): null {
  const assert = { equal(a: unknown, b: unknown) { if (a !== b) throw new Error(`GIF decode: ${a} != ${b}`); } };
  function decodeGif(bytes: Uint8Array) {
  let p = 0;
  const byte = () => { const value = bytes[p++]; if (value === undefined) throw new Error('Truncated GIF.'); return value; };
  const word = () => byte() | byte() << 8;
  const text = (n: number) => Array.from({ length: n }, byte).map((v) => String.fromCharCode(v)).join('');
  const signature = text(6); if (signature !== 'GIF89a') throw new Error('No GIF89a header.');
  const width = word(), height = word(), flags = byte(); byte(); byte();
  const table = (flags: number) => Uint8Array.from(Array.from({ length: 3 * (1 << ((flags & 7) + 1)) }, byte));
  const global = flags & 128 ? table(flags) : null;
  const blocks = () => { const result: number[] = []; for (let n = byte(); n !== 0; n = byte()) for (let i = 0; i < n; i++) result.push(byte()); return result; };
  const frames: { width: number; height: number; delay: number; rgba: Uint8ClampedArray }[] = [];
  let delay = 0, loop: number | null = null;
  for (let marker = byte(); marker !== 0x3b; marker = byte()) {
    if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) { assert.equal(byte(), 4); byte(); delay = word(); byte(); assert.equal(byte(), 0); }
      else if (label === 0xff) { const name = text(byte()), data = blocks(); if (name === 'NETSCAPE2.0' && data[0] === 1) loop = (data[1] ?? 0) | (data[2] ?? 0) << 8; }
      else blocks();
      continue;
    }
    assert.equal(marker, 0x2c); assert.equal(word(), 0); assert.equal(word(), 0);
    const w = word(), h = word(), local = byte(), palette = local & 128 ? table(local) : global;
    if (palette === null || local & 64) throw new Error('Missing palette or interlaced frame.');
    const minimum = byte(), packed = blocks(), clear = 1 << minimum, end = clear + 1;
    let bit = 0, widthBits = minimum + 1, next = end + 1, previous: number[] | null = null;
    let dictionary: number[][] = [];
    const reset = () => { dictionary = Array.from({ length: clear }, (_, i) => [i]); widthBits = minimum + 1; next = end + 1; previous = null; };
    const pixels: number[] = []; reset();
    for (;;) {
      if (bit + widthBits > packed.length * 8) throw new Error('Truncated LZW.');
      let code = 0;
      for (let i = 0; i < widthBits; i++, bit++) code |= (((packed[bit >> 3] ?? 0) >> (bit & 7)) & 1) << i;
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      const entry: number[] | undefined = dictionary[code] ?? (code === next && previous !== null ? [...previous, previous[0] ?? 0] : undefined);
      if (entry === undefined) throw new Error(`Invalid LZW code ${code} at ${next}.`);
      pixels.push(...entry);
      if (previous !== null && next < 4096) {
        dictionary[next++] = [...previous, entry[0] ?? 0];
        if (next === 1 << widthBits && widthBits < 12) widthBits++;
      }
      previous = entry;
    }
    assert.equal(pixels.length, w * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (const [i, index] of pixels.entries()) { rgba.set(palette.subarray(index * 3, index * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
    frames.push({ width: w, height: h, delay, rgba });
  }
  assert.equal(p, bytes.length);
  return { signature, width, height, loop, frames };
}

  const entries: { name: string; blob: Blob }[] = [], progress: string[] = [], blobs = new Map<string, Blob>();
  const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    const url = create.call(URL, blob); if (blob instanceof Blob) blobs.set(url, blob); return url;
  };
  HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href);
    if (blob === undefined) throw new Error('No loop download blob.');
    entries.push({ name: this.download, blob });
  };
  const observer = new MutationObserver(() => {
    const text = document.querySelector('[data-testid="preparing"]')?.textContent ?? '';
    if (text.startsWith('Exporting:') && progress.at(-1) !== text) progress.push(text);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  window.__loopExport = { entries, progress, decode: decodeGif, restore() {
    observer.disconnect(); URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click;
    for (const url of blobs.keys()) URL.revokeObjectURL(url);
    delete window.__loopExport;
  } };
  return null;
}

const exportScenario: Scenario = {
  id: 'export.loop', title: 'GIF and movie loop downloads, cancellation and phone controls', covers: ['EXP1'], target: 'dev', timeoutMs: 450_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto(t.baseUrl);
    await page.click('[data-testid="try-sample"]');
    await page.waitFor('sample ready for loop export', z.literal(true), () => {
      const a = window.__noisyTest?.demo.analysis(); return a?.decoderReady && a.depth && !a.alive.heavy ? true : null;
    }, { timeoutMs: 180_000 });
    await page.evaluate(z.null(), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No loop test surface.');
      const size = { width: 128, height: 96 }, mask = new Uint8Array(128 * 96);
      for (let y = 30; y < 66; y++) for (let x = 40; x < 88; x++) mask[y * 128 + x] = 255;
      demo.injectMask({ ...size, data: mask }); await demo.requestPlate();
      demo.setMotion({ enabled: true, loopSeconds: 2 }); await demo.requestPlate();
      const id = demo.objects()[0]?.id; if (id === undefined) throw new Error('No selected export fixture.');
      demo.select(id);
      const motion = document.querySelector('[aria-label="Motion"] .node-disclosure');
      if (motion instanceof HTMLButtonElement && motion.getAttribute('aria-expanded') === 'false') motion.click();
      return null;
    });
    await page.waitFor('Motion export row', z.literal(true), () => {
      const button = document.querySelector('[data-testid="export-gif"]');
      return button instanceof HTMLButtonElement && button.getBoundingClientRect().height > 0 ? true : null;
    });
    await page.screenshot('export-row-1440');
    await page.evaluate(z.null(), installLoopCapture);
    try {
      await page.click('[data-testid="export-gif"]');
      await page.waitFor('GIF progress on the live session', z.literal(true), () => window.__noisyTest?.demo.exportProgress() !== null ? true : null);
      await page.screenshot('export-progress-1440');
      await page.waitFor('GIF downloaded', z.literal(true), () => window.__loopExport?.entries.length === 1 ? true : null, { timeoutMs: 120_000 });
      const gif = await page.evaluate(z.object({ signature: z.string(), loop: z.number().nullable(), width: z.number(), height: z.number(), frames: z.number(), delays: z.array(z.number()), name: z.string(), bytes: z.number(), error: z.number(), selectionIgnored: z.boolean(), progress: z.array(z.string()) }), async () => {
        const capture = window.__loopExport, demo = window.__noisyTest?.demo;
        const entry = capture?.entries[0];
        if (capture === undefined || entry === undefined || demo === undefined) throw new Error('No GIF download.');
        const decoded = capture.decode(new Uint8Array(await entry.blob.arrayBuffer()));
        let error = 0;
        for (const frame of [0, Math.floor(decoded.frames.length / 2), decoded.frames.length - 1]) {
          const loopFrames = Math.round((demo.document()?.motion.loopSeconds ?? 2) * 30);
          const expected = demo.exportLoopFrame(Math.floor(frame * loopFrames / decoded.frames.length)), actual = decoded.frames[frame];
          if (actual === undefined) throw new Error('No decoded GIF frame.');
          let difference = 0;
          for (let i = 0; i < expected.data.length; i++) if (i % 4 !== 3) difference += Math.abs((expected.data[i] ?? 0) - (actual.rgba[i] ?? 0));
          error = Math.max(error, difference / (expected.width * expected.height * 3));
        }
        // Equality of the entire animation excludes selection dim on every frame.
        demo.select(null); await demo.saveLoop('gif');
        const unselected = capture.entries[1]; if (unselected === undefined) throw new Error('No unselected GIF.');
        const a = new Uint8Array(await entry.blob.arrayBuffer()), b = new Uint8Array(await unselected.blob.arrayBuffer());
        return { signature: decoded.signature, loop: decoded.loop, width: decoded.width, height: decoded.height,
          frames: decoded.frames.length, delays: decoded.frames.map((frame) => frame.delay), name: entry.name, bytes: entry.blob.size,
          error, selectionIgnored: a.length === b.length && a.every((value, i) => value === b[i]), progress: capture.progress };
      });
      t.equal('GIF89a and infinite NETSCAPE loop extension', [gif.signature, gif.loop], ['GIF89a', 0]);
      const expected = await page.evaluate(z.object({ width: z.number(), height: z.number(), frames: z.number(), seconds: z.number(), title: z.string() }), () => {
        const doc = window.__noisyTest?.demo.document(); if (doc === null || doc === undefined) throw new Error('No export document.');
        const size = doc.frame.master.size, scale = 640 / Math.max(size.width, size.height);
        return { width: Math.round(size.width * scale), height: Math.round(size.height * scale), frames: Math.round(doc.motion.loopSeconds * 15), seconds: doc.motion.loopSeconds, title: doc.title };
      });
      t.equal('GIF dimensions, frame count and filename', [gif.width, gif.height, gif.frames, gif.name], [expected.width, expected.height, expected.frames, `${expected.title}-loop.gif`]);
      t.equal('GIF delays follow 15 fps cumulative rounding for exactly one period', gif.delays, Array.from({ length: expected.frames }, (_, i) => Math.round((i + 1) * expected.seconds * 100 / expected.frames) - Math.round(i * expected.seconds * 100 / expected.frames)));
      t.ok('first, middle and last GIF frames match exact renderer frames within 12 RGB levels mean error', gif.error < 12, gif.error);
      t.ok('every GIF byte ignores the selected object dim', gif.selectionIgnored);
      t.ok('Preparing pill shows per-frame export progress', gif.progress.length > 2, gif.progress.slice(0, 5));

      const movieLabel = await page.evaluate(z.string(), () => {
        if (window.__loopExport !== undefined) window.__loopExport.progress.length = 0;
        return document.querySelector('[data-testid="export-movie"]')?.textContent ?? '';
      });
      await page.click('[data-testid="export-movie"]');
      await page.waitFor('movie finished', z.literal(true), () => window.__noisyTest?.demo.exportProgress() === null ? true : null, { timeoutMs: 120_000 });
      const movie = await page.evaluate(z.object({ type: z.string(), bytes: z.number(), name: z.string(), duration: z.number(), width: z.number(), height: z.number(), status: z.string() }), async () => {
        const entry = window.__loopExport?.entries[2];
        if (entry === undefined) return { type: '', bytes: 0, name: '', duration: 0, width: 0, height: 0, status: window.__noisyTest?.demo.scene().status ?? '' };
        const video = document.createElement('video'), url = URL.createObjectURL(entry.blob);
        try {
          video.muted = true; video.src = url;
          await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error('The movie cannot be decoded.')); });
          // WebM from MediaRecorder may omit its duration header; decode to the end.
          let duration = video.duration;
          if (!Number.isFinite(duration)) {
            await new Promise<void>((resolve, reject) => {
              video.onended = () => { duration = video.currentTime; resolve(); };
              void video.play().catch(reject);
            });
          }
          return { type: entry.blob.type, bytes: entry.blob.size, name: entry.name, duration, width: video.videoWidth, height: video.videoHeight, status: window.__noisyTest?.demo.scene().status ?? '' };
        } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
      });
      const movieProgress = await page.evaluate(z.array(z.string()), () => window.__loopExport?.progress ?? []);
      t.ok('Movie shows per-frame progress in the Preparing pill', movieProgress.length > 2, movieProgress.slice(0, 5));
      t.ok('movie saves advertised WebM type above 50 KB', movieLabel.includes('WebM') && movie.type.startsWith('video/webm') && movie.name === `${expected.title}-loop.webm` && movie.bytes > 50_000, { movieLabel, ...movie });
      t.ok('movie decodes at capped master size and one period within one frame', Math.max(movie.width, movie.height) === 1080 && Math.abs(movie.duration - expected.seconds) < 1 / 30 + .01, movie);

      const lifecycle = await page.evaluate(z.object({ second: z.boolean(), reset: z.boolean(), edit: z.boolean(), imported: z.boolean(), failure: z.boolean(), disabled: z.boolean() }), async () => {
        const demo = window.__noisyTest?.demo, capture = window.__loopExport;
        if (demo === undefined || capture === undefined) throw new Error('No cancellation surface.');
        let count = capture.entries.length;
        const first = demo.saveLoop('gif'), second = demo.saveLoop('gif'); await Promise.all([first, second]);
        const secondOnly = capture.entries.length === count + 1; count = capture.entries.length;
        const resetting = demo.saveLoop('gif'); demo.reset(); await resetting;
        const reset = capture.entries.length === count && demo.exportProgress() === null;
        demo.setMotion({ enabled: true });
        const editing = demo.saveLoop('gif'); demo.setFry(.4); await editing;
        const edit = capture.entries.length === count && demo.exportProgress() === null;
        const documentBefore = JSON.stringify(demo.document()), originalWorker = window.Worker;
        try {
          window.Worker = class extends originalWorker { constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.terminate(); throw new Error('Encoder unavailable.'); } };
          await demo.saveLoop('gif');
        } finally { window.Worker = originalWorker; }
        const failure = capture.entries.length === count && demo.exportProgress() === null && JSON.stringify(demo.document()) === documentBefore && demo.scene().status === 'GIF export failed: Encoder unavailable.';
        const recorder = window.MediaRecorder;
        Reflect.deleteProperty(window, 'MediaRecorder');
        demo.setMotion({ orbit: .51 }); await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const button = document.querySelector('[data-testid="export-movie"]');
        const disabled = button instanceof HTMLButtonElement && button.disabled && button.title.includes('unavailable');
        window.MediaRecorder = recorder;
        const importing = demo.saveLoop('gif');
        const response = await fetch('/assets-static/sample.jpg'), blob = await response.blob();
        await demo.importFile(new File([blob], 'replacement.jpg', { type: blob.type })); await importing;
        const imported = capture.entries.length === count && demo.exportProgress() === null;
        return { second: secondOnly, reset, edit, imported, failure, disabled };
      });
      for (const [name, passed] of Object.entries(lifecycle)) t.ok(`export lifecycle: ${name}`, passed);
      await page.emulate({ width: 402, height: 874, mobile: true, deviceScaleFactor: 1, colorScheme: 'dark' });
      await page.evaluate(z.null(), () => { window.__noisyTest?.demo.setMotion({ enabled: true }); return null; });
      await page.waitFor('phone Motion export row', z.literal(true), () => {
        const row = document.querySelector('.phone-sheet .motion-export'); return row !== null && row.getBoundingClientRect().height > 0 ? true : null;
      });
      const phone = await page.evaluate(z.boolean(), () => {
        const buttons = [...document.querySelectorAll('.phone-sheet .motion-export button')];
        return buttons.length === 2 && buttons.every((button) => { const r = button.getBoundingClientRect(); return r.height >= 44 && r.width >= 44 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
      });
      t.ok('phone sheet shows both exports at 402 x 874 with 44 px targets', phone);
      await page.screenshot('export-phone-402');
      await t.file('export-loop.json', JSON.stringify({ gif, movieLabel, movie, movieProgress, lifecycle, phone }, null, 2));
    } finally { await page.evaluate(z.null(), () => { window.__loopExport?.restore(); return null; }); }
  },
};

export const scenarios: readonly Scenario[] = [loopScenario, objectScenario, exportScenario];
