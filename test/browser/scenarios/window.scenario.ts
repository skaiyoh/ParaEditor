import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const resultSchema = z.object({
  status: z.string(), tracks: z.number(), live: z.boolean(), ended: z.boolean(), pressedOff: z.boolean(),
  center: z.number(), rightHead: z.number(), leftHead: z.number(), stillMatches: z.boolean(),
  motionAdvances: z.boolean(), motionOffZero: z.boolean(), loopResumes: z.boolean(),
  preparing: z.boolean(), plateJoined: z.boolean(), noToggleFetch: z.boolean(),
  deniedSafe: z.boolean(), trackedFrames: z.number(),
  deniedCameraTilt: z.boolean(), sumMatches: z.boolean(), debugMatches: z.boolean(), debugExportSafe: z.boolean(),
  faceOnly: z.number(), tiltOnly: z.number(), fused: z.number(), fusedCenter: z.number(),
});

export const scenarios: readonly Scenario[] = [{
  id: 'window.track', title: 'Parallax fuses camera and tilt, shows diagnostics and restores still/loop', target: 'dev', covers: ['H1'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto('/');
    await page.evaluate(z.literal(true), () => { performance.setResourceTimingBufferSize(2000); return true; });
    await page.click('[data-testid="try-sample"]');
    await page.waitFor('sample depth and decoder', z.literal(true), () => {
      const analysis = window.__noisyTest?.demo.analysis();
      return analysis?.depth && analysis.decoderReady && !analysis.alive.heavy ? true : null;
    }, { timeoutMs: 180_000 });
    await page.evaluate(z.literal(true), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No dev surface.');
      const size = { width: 128, height: 96 }, mask = new Uint8Array(size.width * size.height), depth = new Float32Array(mask.length).fill(.25);
      for (let y = 36; y < 60; y++) for (let x = 48; x < 80; x++) { const i = y * size.width + x; mask[i] = 255; depth[i] = 1; }
      demo.injectMask({ ...size, data: mask });
      const start = performance.now();
      while (demo.objects().length === 0) {
        if (performance.now() - start > 10_000) throw new Error('Injected object did not land.');
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      demo.injectDepth({ format: 'f32', size, data: depth }); demo.select(null);
      demo.setMotion({ enabled: false }); demo.setSymbols({ enabled: false });
      demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 });
      document.body.dataset['windowPreparing'] = 'false';
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="status"]')?.textContent?.includes('preparing')) document.body.dataset['windowPreparing'] = 'true';
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      document.addEventListener('window-scenario-cleanup', () => observer.disconnect(), { once: true });
      return true;
    });
    const modelRequestsBefore = await page.evaluate(z.number(), () => performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.startsWith('/models/')).length);
    await page.click('[data-testid="parallax-enabled"]');
    const result = await page.evaluate(resultSchema, async (modelRequestsBefore: number) => {
      const test = window.__noisyTest, renderer = test?.session?.renderer(), demo = test?.demo;
      if (renderer === null || renderer === undefined || demo === undefined) throw new Error('No renderer.');
      const button = document.querySelector('[data-testid="parallax-enabled"]');
      const stage = document.querySelector('[data-testid="stage"]');
      if (!(button instanceof HTMLButtonElement) || !(stage instanceof HTMLCanvasElement)) throw new Error('No Window button or stage.');
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const wait = async (ready: () => boolean) => { const start = performance.now(); while (!ready()) {
        if (performance.now() - start > 60_000) throw new Error(`Window timeout: ${document.querySelector('[data-testid="status"]')?.textContent}`);
        await sleep(20);
      } };
      await wait(() => demo.windowReady() && demo.windowFrames() > 0 && demo.analysis().plate && !demo.products().plateNeeded);
      const trackedFrames = demo.windowFrames();
      const preparing = document.body.dataset['windowPreparing'] === 'true';
      document.dispatchEvent(new Event('window-scenario-cleanup'));
      demo.injectFace(null); // Real bitmap transfer/inference happened before injection replaces it.
      const status = document.querySelector('[data-testid="status"]')?.textContent ?? '';
      const tracks = demo.windowTracks();
      const live = tracks.length > 0 && tracks.every((track) => track.readyState === 'live');
      const centroid = () => {
        const labels = renderer.debug?.readGeometryPatch?.(0, 0, stage.width, stage.height);
        if (labels === undefined) throw new Error('No geometry probe.');
        let sum = 0, count = 0;
        for (let i = 0; i < labels.length; i += 4) if (labels[i] === 1 && labels[i + 3] === 255) { sum += (i / 4) % stage.width; count++; }
        if (count === 0) throw new Error('No injected object pixels.');
        return sum / count;
      };
      // Sample in a frame callback, after the driver's draw, before canvas clearing.
      const next = <T>(read: () => T): Promise<T> => new Promise((resolve) => requestAnimationFrame(() => resolve(read())));
      await sleep(700); const center = await next(centroid);
      demo.injectFace({ x: .7, y: .5 }); await sleep(700); const rightHead = await next(centroid);
      demo.injectFace({ x: .3, y: .5 }); await sleep(700); const leftHead = await next(centroid);
      demo.setMotion({ enabled: true }); const before = demo.frame(); await sleep(120); const motionAdvances = demo.frame() !== before;
      demo.setMotion({ enabled: false }); await next(() => undefined); const motionOffZero = demo.frame() === 0;
      button.click();
      const ended = tracks.every((track) => track.readyState === 'ended');
      const canvas = document.createElement('canvas'); canvas.width = stage.width; canvas.height = stage.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No capture context.');
      const points = [[.125, .125], [.875, .125], [.125, .875], [.875, .875], [.375, .5], [.625, .5]];
      const sample = () => {
        ctx.drawImage(stage, 0, 0);
        return points.flatMap(([x = 0, y = 0]) => Array.from(ctx.getImageData(Math.floor(x * stage.width), Math.floor(y * stage.height), 1, 1).data));
      };
      // Window-off publishes and draws synchronously. Compare that draw before
      // an explicit frame-zero reference can hide a failed restoration.
      const restored = sample(); renderer.renderFrame(0); const reference = sample();
      const stillMatches = restored.every((v, i) => v === reference[i]) && restored.filter((_, i) => i % 4 === 3).every((v) => v === 255);
      await next(() => undefined); const pressedOff = button.getAttribute('aria-pressed') === 'false';
      demo.setMotion({ enabled: true }); await sleep(100); const loopAt = demo.frame(); await sleep(100); const loopResumes = demo.frame() !== loopAt;
      demo.setMotion({ enabled: false });
      const media = navigator.mediaDevices, getUserMedia = media.getUserMedia;
      let deniedSafe = false;
      try {
        media.getUserMedia = () => Promise.reject(new DOMException('Scenario denied camera.', 'NotAllowedError'));
        button.click();
        await wait(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Camera unavailable') === true);
        await next(() => undefined);
        deniedSafe = button.getAttribute('aria-pressed') === 'false' && demo.windowTracks().length === 0;
      } finally { media.getUserMedia = getUserMedia; }
      // Camera denial removes only its input: orientation still drives this view.
      let deniedCameraTilt = false;
      try {
        media.getUserMedia = () => Promise.reject(new DOMException('Scenario denied camera.', 'NotAllowedError'));
        button.click();
        // Native requestPermission is asynchronous, including in desktop Chrome.
        // Deliver the rest sample after the source has installed its listener.
        await wait(() => {
          demo.injectOrientation({ beta: 35, gamma: 8 });
          return demo.parallaxDebug().tiltRunning && document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Parallax: tilt') === true;
        });
        await sleep(700); const rest = await next(centroid);
        demo.injectOrientation({ beta: 35, gamma: 23 }); await sleep(700); const moved = await next(centroid);
        deniedCameraTilt = moved - rest < -2 && button.getAttribute('aria-pressed') === 'true' && demo.windowTracks().length === 0;
        button.click();
        await next(() => undefined);
      } finally { media.getUserMedia = getUserMedia; }
      // Both inputs use the same render clock and contribute their centered sum.
      button.click();
      await wait(() => {
        demo.injectOrientation({ beta: 35, gamma: 8 });
        return demo.windowReady() && demo.parallaxDebug().tiltRunning;
      });
      demo.injectFace(null); await sleep(900); const fusedCenter = await next(centroid);
      demo.injectFace({ x: .6, y: .5 }); await sleep(900); const faceOnly = await next(centroid);
      demo.injectFace(null); demo.injectOrientation({ beta: 35, gamma: 12 });
      await sleep(900); const tiltOnly = await next(centroid);
      const pixels = new ImageData(320, 240);
      for (let i = 0; i < pixels.data.length; i += 4) { pixels.data[i] = 80; pixels.data[i + 1] = 120; pixels.data[i + 2] = 160; pixels.data[i + 3] = 255; }
      demo.injectCameraFrame(pixels, { center: { x: .4, y: .5 }, size: .25 });
      await sleep(900); const fused = await next(centroid);
      demo.select(null);
      const sourcesNamedAfterSelection = demo.scene().status === 'Parallax: camera and tilt';
      const sumMatches = Math.abs((fused - fusedCenter) - ((faceOnly - fusedCenter) + (tiltOnly - fusedCenter))) < 1;
      const debugToggle = document.querySelector('[data-testid="parallax-debug-toggle"]');
      if (!(debugToggle instanceof HTMLButtonElement)) throw new Error('No Debug toggle.');
      const exportBefore = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
      debugToggle.click(); await sleep(250);
      const debug = demo.parallaxDebug(), preview = document.querySelector('[data-testid="parallax-debug-frame"]');
      const panel = document.querySelector('[data-testid="parallax-debug"]');
      const box = panel?.getBoundingClientRect(), area = document.querySelector('.stage-area')?.getBoundingClientRect();
      const context = preview instanceof HTMLCanvasElement ? preview.getContext('2d') : null;
      const pixel = context?.getImageData(0, 0, 1, 1).data;
      const edge = context?.getImageData(88, 120, 1, 1).data;
      const text = (id: string) => document.querySelector(`[data-testid="parallax-${id}"]`)?.textContent;
      const debugMatches = box?.width === 200 && area !== undefined && Math.abs(area.right - box.right - 12) < 1 && Math.abs(area.bottom - box.bottom - 12) < 1 &&
        sourcesNamedAfterSelection && text('beta') === '35.00' && text('gamma') === '12.00' && text('screen-type') === (debug.type ?? 'Unavailable') &&
        text('screen-angle') === (debug.angle === null ? 'Unavailable' : debug.angle.toFixed(2)) &&
        text('window-angle') === (debug.legacy === null ? 'Unavailable' : debug.legacy.toFixed(2)) &&
        text('tilt-target') === '0.600, 0.500' && text('face-target') === '0.600, 0.500' &&
        text('fused-offset') === `${debug.offset.x.toFixed(3)}, ${debug.offset.y.toFixed(3)}` &&
        pixel?.[0] === 80 && pixel[3] === 255 && edge?.[0] === 255 && edge[1] === 61 && edge[2] === 127;
      const exportAfter = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
      const debugExportSafe = exportBefore.length === exportAfter.length && exportBefore.every((value, i) => value === exportAfter[i]);
      const modelRequestsAfter = performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.startsWith('/models/')).length;
      // The face file was cached at boot; toggles add no face-model requests.
      return { status, tracks: tracks.length, live, ended, pressedOff, center, rightHead, leftHead, stillMatches,
        motionAdvances, motionOffZero, loopResumes, preparing, plateJoined: demo.analysis().plate, noToggleFetch: modelRequestsAfter === modelRequestsBefore, deniedSafe, trackedFrames, deniedCameraTilt, sumMatches, debugMatches, debugExportSafe, faceOnly, tiltOnly, fused, fusedCenter };
    }, modelRequestsBefore);
    await t.file('window.json', JSON.stringify(result, null, 2));
    await page.screenshot('parallax-debug-1440');
    t.ok('fake getUserMedia resolves with live tracks and a non-error status', result.live && !/unavailable|failed|error/i.test(result.status), result);
    t.ok('the real face worker consumes a transferred webcam frame before injection', result.trackedFrames > 0, result);
    t.ok('leaning right moves the near object left by more than two pixels', result.rightHead - result.center < -2, result);
    t.ok('leaning left moves the near object right by more than two pixels', result.leftHead - result.center > 2, result);
    t.ok('Parallax off ends every track and clears aria-pressed', result.ended && result.pressedOff, result);
    t.ok('Parallax off restores frame zero at four opaque sampled points', result.stillMatches, result);
    t.ok('Motion advances in Parallax, stops at zero, and resumes the existing loop', result.motionAdvances && result.motionOffZero && result.loopResumes, result);
    t.ok('Parallax requests its missing plate and it joins the view', result.preparing && result.plateJoined, result);
    t.ok('Parallax does not fetch its face model at toggle time', result.noToggleFetch, result);
    t.ok('both sources move the centroid by their sum', result.sumMatches, result);
    t.ok('Debug shows injected readings, the matching camera frame and the accent face box', result.debugMatches, result);
    t.ok('Debug never enters the still export', result.debugExportSafe, result);
    t.ok('camera denial leaves tilt driving Parallax and names tilt alone', result.deniedCameraTilt, result);
    t.ok('a denied camera reports Camera unavailable and leaves Parallax off', result.deniedSafe, result);
  },
}];
