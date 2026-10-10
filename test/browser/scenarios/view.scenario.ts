import { z } from 'zod';
import type { Scenario } from '../scenario.ts';
import { currentDocumentSchema } from '../../../src/core/schema.ts';
import { cameraRadius, parallaxClamp } from '../../../src/core/derive.ts';

const centroidSchema = z.object({ object: z.number(), background: z.number(), pixels: z.number() });
const resultSchema = z.object({
  centers: z.object({ zero: centroidSchema, positive: centroidSchema, negative: centroidSchema }),
  motionOffSamples: z.boolean(), independentCamera: z.boolean(), clamp: z.boolean(), deterministic: z.boolean(),
  pngType: z.string(), size: z.boolean(), pngSamples: z.boolean(), pngAllPixels: z.boolean(),
  restored: z.array(z.object({ mode: z.string(), immediate: z.boolean(), encoded: z.boolean() })),
  noDepthStill: z.boolean(),
  noDepthEvidence: z.object({ stillSamples: z.array(z.number()), viewSamples: z.array(z.number()),
    stillBytes: z.number(), viewBytes: z.number(), mismatchedBytes: z.number() }),
  samplePoints: z.array(z.object({ x: z.number(), y: z.number() })),
});

const viewScenario: Scenario = {
  id: 'render.view', title: 'Supplied camera, PNG pixels and restored stage', covers: ['R1'], target: 'dev', timeoutMs: 300_000,
  async run(context) {
    const { page } = context;
    await page.goto(context.baseUrl);
    const doc = await page.evaluate(currentDocumentSchema, async () => {
      const test = window.__noisyTest;
      if (test === undefined) throw new Error('The dev surface is missing.');
      if (test.session === undefined) throw new Error('R1 requires the dev surface to expose session.renderer().');
      const { demo } = test;
      const wait = async (ready: () => boolean) => {
        const start = performance.now();
        while (!ready()) {
          if (performance.now() - start > 150_000) throw new Error(`View fixture timeout: ${demo.analysis().status}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      };
      const source = document.createElement('canvas'); source.width = 4032; source.height = 3024;
      const ctx = source.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No fixture context.');
      ctx.fillStyle = '#a0a0a0'; ctx.fillRect(0, 0, source.width, source.height);
      ctx.fillStyle = '#ed382d'; ctx.fillRect(source.width * .375, source.height * .375, source.width * .25, source.height * .25);
      const blob = await new Promise<Blob>((resolve, reject) => source.toBlob((value) => {
        if (value === null) reject(new Error('No fixture PNG.')); else resolve(value);
      }, 'image/png'));
      await demo.importFile(new File([blob], 'view-sample.png', { type: 'image/png' }));
      await wait(() => demo.analysis().depth && demo.analysis().decoderReady && !demo.analysis().alive.heavy);
      const size = { width: 128, height: 96 }, mask = new Uint8Array(size.width * size.height);
      const depth = new Float32Array(mask.length).fill(.25);
      for (let y = 36; y < 60; y++) for (let x = 48; x < 80; x++) {
        const i = y * size.width + x; mask[i] = 255; depth[i] = 1;
      }
      demo.injectMask({ ...size, data: mask });
      await wait(() => demo.objects().length === 1);
      demo.injectDepth({ format: 'f32', size, data: depth });
      demo.select(null);
      demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 });
      demo.setSymbols({ enabled: false });
      demo.setMotion({ enabled: true, drift: { direction: 'circle', amount: 1 }, focus: 0, loopSeconds: 3 });
      await demo.requestPlate();
      await wait(() => demo.analysis().plate && !demo.products().plateNeeded);
      demo.setMotion({ enabled: false });
      // Return the document with orbit enabled solely to calculate the scene's
      // loop radius with core, without letting playback replace our views.
      const sceneDoc = demo.document();
      if (sceneDoc === null) throw new Error('No view document.');
      return { ...sceneDoc, motion: { ...sceneDoc.motion, enabled: true } };
    });
    const result = await page.evaluate(resultSchema, async ({ radius, reach }) => {
      const test = window.__noisyTest, renderer = test?.session?.renderer();
      if (test === undefined || renderer === null || renderer === undefined) throw new Error('No view renderer.');
      const { demo } = test;
      const stage = document.querySelector('[data-testid="stage"]');
      if (!(stage instanceof HTMLCanvasElement)) throw new Error('No stage.');
      const captureCanvas = document.createElement('canvas'); captureCanvas.width = stage.width; captureCanvas.height = stage.height;
      const ctx = captureCanvas.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No capture context.');
      const capture = () => { ctx.drawImage(stage, 0, 0); return ctx.getImageData(0, 0, stage.width, stage.height).data; };
      const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && a.every((v, i) => v === b[i]);
      const samplePoints = [
        { x: Math.floor(stage.width / 8), y: Math.floor(stage.height / 8) },
        { x: Math.floor(stage.width * 7 / 8), y: Math.floor(stage.height / 8) },
        { x: Math.floor(stage.width / 8), y: Math.floor(stage.height * 7 / 8) },
        { x: Math.floor(stage.width * 7 / 8), y: Math.floor(stage.height * 7 / 8) },
      ];
      const samples = (data: Uint8ClampedArray) => samplePoints.flatMap(({ x, y }) => {
        const i = (y * stage.width + x) * 4; return Array.from(data.subarray(i, i + 4));
      });
      const sameSamples = (a: Uint8ClampedArray, b: Uint8ClampedArray) => samples(a).every((v, i) => v === samples(b)[i]);
      const png = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No PNG context.');
        context.drawImage(bitmap, 0, 0); bitmap.close();
        return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const centroid = () => {
        const labels = renderer.debug?.readGeometryPatch?.(0, 0, stage.width, stage.height);
        if (labels === undefined) throw new Error('No geometry id patch.');
        let objectX = 0, backgroundX = 0, objectCount = 0, backgroundCount = 0;
        for (let i = 0; i < labels.length; i += 4) {
          if (labels[i + 3] !== 255) continue;
          const x = (i / 4) % stage.width;
          if (labels[i] === 1) { objectX += x; objectCount++; }
          else if (labels[i] === 0) { backgroundX += x; backgroundCount++; }
        }
        if (objectCount === 0 || backgroundCount === 0) throw new Error('The geometry centroid has no object or background pixels.');
        return { object: objectX / objectCount, background: backgroundX / backgroundCount, pixels: objectCount };
      };
      renderer.renderView({ x: 0, y: 0 }); const zero = centroid(), centerPixels = capture();
      renderer.renderFrame(0); const motionOffSamples = sameSamples(centerPixels, capture());
      renderer.renderView({ x: radius, y: 0 }); const positive = centroid(), positivePixels = capture();
      renderer.renderView({ x: -radius, y: 0 }); const negative = centroid();
      demo.setMotion({ drift: { direction: 'circle', amount: 0 } });
      renderer.renderView({ x: radius, y: 0 });
      const independentCamera = equal(positivePixels, capture()) && centroid().object === positive.object;
      renderer.renderView({ x: reach, y: -reach }); const bounded = capture();
      renderer.renderView({ x: reach * 100, y: -reach * 100 }); const clamp = equal(bounded, capture());
      demo.setStyle({ grain: .6, colorNoise: .3, grainHold: 1 });
      const camera = { x: radius, y: -radius / 2 };
      renderer.renderView(camera, 17, false); const viewPixels = capture();
      renderer.renderView({ x: -radius, y: 0 }, 42);
      renderer.renderView(camera, 17, false); const deterministic = equal(viewPixels, capture());
      const still = await png(await renderer.exportStill());
      const object = demo.objects()[0]; if (object === undefined) throw new Error('No fixture object.');
      demo.select(object.id);
      const restored = [];
      let exported: Blob | null = null;
      for (const mode of ['still', 'loop', 'view-selected', 'view-unselected']) {
        if (mode === 'still') renderer.renderStill();
        else if (mode === 'loop') renderer.renderFrame(31);
        else renderer.renderView({ x: -radius, y: radius / 3 }, 31, mode === 'view-selected');
        const before = capture(), pending = renderer.exportView(camera, 17), immediate = equal(before, capture());
        exported = await pending;
        restored.push({ mode, immediate, encoded: equal(before, capture()) });
      }
      if (exported === null) throw new Error('No exported view.');
      const decoded = await png(exported);
      demo.injectDepth(null);
      // The injection hook's empty style patch is unchanged. Selection
      // publishes a scene afterward, uploading the null depth override.
      demo.select(null);
      renderer.renderStill(); const noDepthPixels = capture();
      renderer.renderView(camera, 17); const noDepthViewPixels = capture();
      const noDepthStill = equal(noDepthPixels, noDepthViewPixels);
      const noDepthEvidence = { stillSamples: samples(noDepthPixels), viewSamples: samples(noDepthViewPixels),
        stillBytes: noDepthPixels.length, viewBytes: noDepthViewPixels.length,
        mismatchedBytes: noDepthPixels.reduce((count, value, i) => count + (value === noDepthViewPixels[i] ? 0 : 1), 0) };
      return { centers: { zero, positive, negative }, motionOffSamples, independentCamera, clamp, deterministic,
        pngType: exported.type, size: decoded.width === still.width && decoded.height === still.height && decoded.width === stage.width && decoded.height === stage.height,
        pngSamples: sameSamples(viewPixels, decoded.data), pngAllPixels: equal(viewPixels, decoded.data), restored, noDepthStill, noDepthEvidence, samplePoints };
    }, { radius: cameraRadius(doc), reach: parallaxClamp(doc) });
    await page.screenshot('view');
    await context.file('view.json', JSON.stringify({ radius: cameraRadius(doc), ...result }, null, 2));
    const { zero, positive, negative } = result.centers;
    const right = positive.object - zero.object, left = negative.object - zero.object;
    context.ok('supplied cameras move the mask in opposite horizontal directions by more than two pixels', right > 2 && left < -2, result.centers);
    context.ok('background centroids move less than the object', Math.abs(positive.background - zero.background) < Math.abs(right) && Math.abs(negative.background - zero.background) < Math.abs(left), result.centers);
    context.ok('center view and Motion-off frame zero match at four flat-background points', result.motionOffSamples, result.samplePoints);
    context.ok('Motion off and orbit zero do not disable the supplied camera or crop', result.independentCamera);
    context.ok('camera offsets clamp per axis to core parallax reach', result.clamp);
    context.ok('same view and grain frame give identical pixels', result.deterministic);
    context.equal('view export is image/png', result.pngType, 'image/png');
    context.ok('view and still exports have the same master dimensions', result.size);
    context.ok('view PNG matches the four sampled canvas pixels', result.pngSamples);
    context.ok('view PNG matches all unselected canvas pixels', result.pngAllPixels);
    for (const restoration of result.restored) context.ok(`export restores ${restoration.mode} immediately and after encoding`, restoration.immediate && restoration.encoded);
    context.ok('without depth, view draws the still including frame-zero grain', result.noDepthStill,
      { noDepthStill: result.noDepthStill, samplePoints: result.samplePoints, ...result.noDepthEvidence });
    // The driver adds the no-console-errors invariant after this run.
  },
};

export const scenarios: readonly Scenario[] = [viewScenario];
