import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const resultSchema = z.object({
  status: z.string(), live: z.boolean(), ended: z.boolean(), pressedOff: z.boolean(), trackedFrames: z.number(),
  center: z.number(), rightHead: z.number(), leftHead: z.number(), stillMatches: z.boolean(),
  stillComparedPixels: z.number(), stillMismatchedPixels: z.number(),
  motionAdvances: z.boolean(), motionOffZero: z.boolean(), loopResumes: z.boolean(),
  preparing: z.boolean(), plateJoined: z.boolean(), savedUnchanged: z.boolean(), noToggleFetch: z.boolean(),
  deniedSafe: z.boolean(), deniedCameraTilt: z.boolean(), cameraAuthority: z.boolean(), fallback: z.boolean(), recovered: z.boolean(),
  recentered: z.boolean(), stalePermissionSafe: z.boolean(), debugMatches: z.boolean(), debugExportSafe: z.boolean(),
  transitionTrace: z.string(), unchangedSceneAllocations: z.number(), unchangedSceneUpdates: z.number(), statusSceneUpdates: z.number(),
  statusDraws: z.number(), statusPerspectiveDraws: z.number(), statusDrawFrames: z.number(),
  phases: z.array(z.object({ name: z.string(), passed: z.boolean(), elapsedMs: z.number(), source: z.string(),
    center: z.object({ x: z.number(), y: z.number() }), preclamp: z.object({ x: z.number(), y: z.number() }),
    tiltTarget: z.object({ x: z.number(), y: z.number() }), faceTarget: z.object({ x: z.number(), y: z.number() }),
    cameraState: z.string().nullable(), tiltState: z.string().nullable(), cameraAgeMs: z.number().nullable(), tiltAgeMs: z.number().nullable() })),
});

export const scenarios: readonly Scenario[] = [{
  id: 'window.track', title: 'Calibrated camera authority, continuous fallback, live preparation and export isolation', target: 'dev', covers: ['H1'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto('/');
    await page.evaluate(z.literal(true), () => { performance.setResourceTimingBufferSize(2000); return true; });
    await page.click('[data-testid="tool-actions"]');
    await page.click('[data-testid="try-sample"]');
    await page.click('[data-testid="tool-actions"]');
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
      // This analytical x-axis fixture is independent of the host screen's natural orientation.
      demo.injectScreenAngle(0);
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
      const button = document.querySelector('[data-testid="parallax-enabled"]'), stage = document.querySelector('[data-testid="stage"]');
      if (!(button instanceof HTMLButtonElement) || !(stage instanceof HTMLCanvasElement)) throw new Error('No Parallax controls.');
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const next = <T>(read: () => T): Promise<T> => new Promise((resolve) => requestAnimationFrame(() => resolve(read())));
      const wait = async (ready: () => boolean, timeout = 60_000): Promise<void> => {
        const start = performance.now(); while (!ready()) {
          if (performance.now() - start > timeout) throw new Error(`Parallax timeout: ${document.querySelector('[data-testid="status"]')?.textContent}`);
          await sleep(20);
        }
      };
      const savedBefore = JSON.stringify(demo.document()?.analysis.plate);
      await wait(() => {
        demo.injectOrientation({ alpha: 0, beta: 0, gamma: 0 });
        return demo.windowReady() && demo.windowFrames() > 0 && demo.parallaxDebug().preparation === 'ready';
      });
      const trackedFrames = demo.windowFrames(), tracks = demo.windowTracks();
      const live = tracks.length > 0 && tracks.every((track) => track.readyState === 'live');
      const plateJoined = demo.parallaxDebug().preparation === 'ready';
      const savedUnchanged = savedBefore === JSON.stringify(demo.document()?.analysis.plate);
      const preparing = document.body.dataset['windowPreparing'] === 'true';
      document.dispatchEvent(new Event('window-scenario-cleanup'));
      const centroid = () => {
        const labels = renderer.debug?.readGeometryPatch?.(0, 0, stage.width, stage.height);
        if (labels === undefined) throw new Error('No geometry probe.');
        let sum = 0, count = 0;
        for (let i = 0; i < labels.length; i += 4) if (labels[i] === 1 && labels[i + 3] === 255) { sum += (i / 4) % stage.width; count++; }
        if (count === 0) throw new Error('No rendered object.');
        return sum / count;
      };
      let face: { x: number; y: number } | null = { x: .5, y: .5 };
      let pose = { alpha: 0, beta: 0, gamma: 0 };
      let cameraFrame: ImageData | null = null;
      let frameFace = { center: { x: .4, y: .5 }, size: .25, confidence: .95 };
      const pump = (): void => {
        if (cameraFrame === null) demo.injectFace(face); else demo.injectCameraFrame(cameraFrame, frameFace);
        demo.injectOrientation(pose);
      };
      const timer = setInterval(pump, 60); pump();
      const phases: { name: string; passed: boolean; elapsedMs: number; source: string;
        center: { x: number; y: number }; preclamp: { x: number; y: number };
        tiltTarget: { x: number; y: number }; faceTarget: { x: number; y: number };
        cameraState: string | null; tiltState: string | null; cameraAgeMs: number | null; tiltAgeMs: number | null }[] = [];
      const settle = async (name: string, ready: () => boolean): Promise<boolean> => {
        const start = performance.now();
        while (!ready() && performance.now() - start < 2000) await sleep(20);
        const debug = demo.parallaxDebug(), now = performance.now(), passed = ready();
        phases.push({ name, passed, elapsedMs: now - start, source: debug.source, center: { ...debug.center },
          preclamp: { ...debug.preclamp }, tiltTarget: { ...debug.tilt }, faceTarget: { ...debug.faceTarget },
          cameraState: debug.samples.camera?.state ?? null, tiltState: debug.samples.tilt?.state ?? null,
          cameraAgeMs: debug.samples.camera === null ? null : now - debug.samples.camera.capturedAt,
          tiltAgeMs: debug.samples.tilt === null ? null : now - debug.samples.tilt.capturedAt });
        return passed;
      };
      const media = navigator.mediaDevices, getUserMedia = media.getUserMedia;
      const setScene = renderer.setScene, renderPerspective = renderer.renderPerspective;
      let statusSceneUpdates = 0, statusDraws = 0, statusPerspectiveDraws = 0, statusDrawFrames = 0;
      let drawsSinceFrame = 0, drawProbe = 0;
      let unchangedSceneAllocations = 0, unchangedSceneUpdates = 0;
      let deniedSafe = false, deniedCameraTilt = false, stalePermissionSafe = false;
      try {
        await sleep(500); const center = await next(centroid);
        // Reapplying unchanged input must retain the prepared live textures.
        const gl = stage.getContext('webgl2');
        if (gl === null) throw new Error('No stage WebGL context.');
        const createTexture = gl.createTexture;
        gl.createTexture = () => { unchangedSceneAllocations++; return createTexture.call(gl); };
        renderer.setScene = (scene) => { unchangedSceneUpdates++; setScene(scene); };
        try { demo.select(null); await next(centroid); }
        finally { gl.createTexture = createTexture; renderer.setScene = setScene; }
        renderer.setScene = (scene) => { statusSceneUpdates++; setScene(scene); };
        renderer.renderPerspective = (request) => { drawsSinceFrame++; statusPerspectiveDraws++; return renderPerspective(request); };
        // Only source observations change in this interval. The live clock owns one
        // draw per animation frame; a status callback drawing again is an extra draw.
        // This probe runs after the clock and keeps that order on subsequent frames.
        const probeDraws = (): void => {
          statusDraws += Math.max(0, drawsSinceFrame - 1); statusDrawFrames++; drawsSinceFrame = 0;
          drawProbe = requestAnimationFrame(probeDraws);
        };
        drawProbe = requestAnimationFrame(probeDraws);
        face = { x: .7, y: .5 }; await sleep(500); const rightHead = await next(centroid);
        face = { x: .3, y: .5 }; await sleep(500); const leftHead = await next(centroid);
        face = { x: .65, y: .5 }; pose = { alpha: 0, beta: 0, gamma: -15 };
        const cameraAuthority = await settle('camera-authority', () => demo.parallaxDebug().source === 'camera' && demo.parallaxDebug().center.x > .63);
        face = null;
        const fallback = await settle('face-loss-tilt-fallback', () => demo.parallaxDebug().source === 'tilt' && demo.parallaxDebug().center.x < .25);
        face = { x: .65, y: .5 };
        const recovered = await settle('camera-recovery', () => demo.parallaxDebug().source === 'camera' && demo.parallaxDebug().center.x > .63);
        await next(() => undefined); cancelAnimationFrame(drawProbe);
        renderer.setScene = setScene; renderer.renderPerspective = renderPerspective;
        // Exercise the real calibration path with a paired frame, then explicitly recenter off-neutral.
        cameraFrame = new ImageData(320, 240);
        for (let i = 0; i < cameraFrame.data.length; i += 4) { cameraFrame.data[i] = 80; cameraFrame.data[i + 1] = 120; cameraFrame.data[i + 2] = 160; cameraFrame.data[i + 3] = 255; }
        demo.recenterParallax();
        const calibrated = await settle('paired-frame-neutral', () => demo.parallaxDebug().source === 'camera' &&
          demo.parallaxDebug().samples.camera?.state === 'tracking' && Math.abs(demo.parallaxDebug().center.x - .5) < .015);
        frameFace = { ...frameFace, center: { x: .35, y: .5 } };
        const movedBeforeRecenter = await settle('paired-frame-relative-move', () => demo.parallaxDebug().source === 'camera' && demo.parallaxDebug().center.x > .58);
        demo.recenterParallax();
        const centeredAfter = await settle('explicit-recenter', () => demo.parallaxDebug().source === 'camera' &&
          demo.parallaxDebug().samples.camera?.state === 'tracking' && Math.abs(demo.parallaxDebug().center.x - .5) < .015);
        const recentered = calibrated && movedBeforeRecenter && centeredAfter;
        const toggle = document.querySelector('[data-testid="parallax-debug-toggle"]');
        if (!(toggle instanceof HTMLButtonElement)) throw new Error('No debug toggle.');
        const exportBefore = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
        toggle.click(); await sleep(200);
        const preview = document.querySelector('[data-testid="parallax-debug-frame"]');
        const pixel = preview instanceof HTMLCanvasElement ? preview.getContext('2d')?.getImageData(0, 0, 1, 1).data : null;
        const debug = demo.parallaxDebug();
        const debugMatches = document.querySelector('[data-testid="parallax-debug"]') !== null && pixel?.[0] === 80 && pixel[3] === 255 &&
          debug.samples.camera?.state === 'tracking' && debug.samples.camera.capturedAt <= performance.now() && debug.face !== null;
        const exportAfter = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
        const debugExportSafe = exportBefore.length === exportAfter.length && exportBefore.every((v, i) => v === exportAfter[i]);
        const transitionTrace = JSON.stringify(demo.parallaxTrace());
        const status = document.querySelector('[data-testid="status"]')?.textContent ?? '';
        demo.setMotion({ enabled: true }); const before = demo.frame();
        const motionAdvances = await settle('motion-first-advance', () => demo.frame() !== before);
        demo.setMotion({ enabled: false }); await next(() => undefined); const motionOffZero = demo.frame() === 0;
        button.click(); clearInterval(timer);
        const ended = tracks.every((track) => track.readyState === 'ended');
        const canvas = document.createElement('canvas'); canvas.width = stage.width; canvas.height = stage.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No capture context.');
        const capture = () => { ctx.drawImage(stage, 0, 0); return ctx.getImageData(0, 0, stage.width, stage.height).data; };
        const restored = capture(); renderer.renderFrame(0); const reference = capture();
        const stillComparedPixels = stage.width * stage.height;
        let stillMismatchedPixels = 0;
        for (let i = 0; i < reference.length; i += 4) {
          if (restored[i] !== reference[i] || restored[i + 1] !== reference[i + 1] ||
            restored[i + 2] !== reference[i + 2] || restored[i + 3] !== reference[i + 3]) stillMismatchedPixels++;
        }
        const stillMatches = restored.length === reference.length && stillMismatchedPixels === 0 && restored[3] === 255;
        await next(() => undefined); const pressedOff = button.getAttribute('aria-pressed') === 'false';
        demo.setMotion({ enabled: true }); await wait(() => !demo.products().plateNeeded && !demo.analysis().alive.heavy); await sleep(100); const loopAt = demo.frame(); await sleep(100); const loopResumes = demo.frame() !== loopAt;
        demo.setMotion({ enabled: false });
        media.getUserMedia = () => Promise.reject(new DOMException('Scenario denial.', 'NotAllowedError'));
        button.click();
        // Off is also the pre-click DOM state. Wait for the actual terminal result,
        // not a stale aria value before Preact commits the starting state.
        await wait(() => button.getAttribute('aria-pressed') === 'false' &&
          /Camera unavailable/.test(demo.scene().status) && /Tilt unavailable/.test(demo.scene().status), 5000);
        deniedSafe = demo.windowTracks().length === 0 && /Camera unavailable/.test(demo.scene().status);
        button.click();
        const tiltTimer = setInterval(() => demo.injectOrientation({ alpha: 0, beta: 0, gamma: 0 }), 60);
        try { await wait(() => demo.parallaxDebug().source === 'tilt', 5000); deniedCameraTilt = demo.windowTracks().length === 0; }
        finally { clearInterval(tiltTimer); button.click(); }
        await wait(() => button.getAttribute('aria-pressed') === 'false', 5000);
        // A permission result arriving after rapid off/on must not attach its obsolete stream.
        let grant = (_stream: MediaStream): void => { throw new Error('No pending permission.'); };
        media.getUserMedia = () => new Promise<MediaStream>((resolve) => { grant = resolve; });
        button.click(); await wait(() => button.getAttribute('aria-pressed') === 'true', 5000); button.click();
        await wait(() => button.getAttribute('aria-pressed') === 'false', 5000);
        const obsolete = await getUserMedia.call(media, { video: true });
        grant(obsolete);
        await sleep(100); stalePermissionSafe = obsolete.getTracks().every((track) => track.readyState === 'ended') && button.getAttribute('aria-pressed') === 'false';
        media.getUserMedia = getUserMedia;
        button.click(); await wait(() => demo.windowReady()); const reopened = demo.windowTracks(); button.click();
        stalePermissionSafe &&= reopened.length > 0 && reopened.every((track) => track.readyState === 'ended');
        const modelRequestsAfter = performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.startsWith('/models/')).length;
        return { status, live, ended, pressedOff, center, rightHead, leftHead, stillMatches, stillComparedPixels, stillMismatchedPixels, motionAdvances, motionOffZero, loopResumes,
          preparing, plateJoined, savedUnchanged, noToggleFetch: modelRequestsAfter === modelRequestsBefore, deniedSafe, trackedFrames,
          deniedCameraTilt, cameraAuthority, fallback, recovered, recentered, stalePermissionSafe, debugMatches, debugExportSafe, phases, transitionTrace, unchangedSceneAllocations, unchangedSceneUpdates, statusSceneUpdates, statusDraws, statusPerspectiveDraws, statusDrawFrames };
      } finally { clearInterval(timer); cancelAnimationFrame(drawProbe); renderer.setScene = setScene; renderer.renderPerspective = renderPerspective; media.getUserMedia = getUserMedia; demo.injectScreenAngle(null); }
    }, modelRequestsBefore);
    const { transitionTrace, ...observed } = result;
    await t.file('window.json', JSON.stringify(observed, null, 2));
    await t.file('transition-trace.json', transitionTrace);
    await page.screenshot('parallax-debug-1440');
    t.ok('unchanged live scene retains its prepared textures', result.unchangedSceneUpdates > 0 && result.unchangedSceneAllocations === 0, { updates: result.unchangedSceneUpdates, allocations: result.unchangedSceneAllocations });
    t.equal('source status transitions do not reinstall the scene', result.statusSceneUpdates, 0);
    t.ok('source status transitions do not draw outside the live clock', result.statusDraws === 0 && result.statusDrawFrames > 0 && result.statusPerspectiveDraws === result.statusDrawFrames,
      { extraDraws: result.statusDraws, perspectiveDraws: result.statusPerspectiveDraws, animationFrames: result.statusDrawFrames });
    t.ok('real webcam frame reaches inference before deterministic injection', result.live && result.trackedFrames > 0, observed);
    t.ok('screen-window camera travel moves foreground in opposite directions', result.rightHead - result.center > 2 && result.leftHead - result.center < -2, observed);
    t.ok('camera is authoritative over opposing tilt, with loss fallback and recovery', result.cameraAuthority && result.fallback && result.recovered, observed);
    t.ok('paired-frame calibration and explicit recenter establish neutral', result.recentered, observed);
    t.ok('live plate preparation joins without mutating saved plate', result.plateJoined && result.savedUnchanged, observed);
    t.ok('off restores the full still frame', result.stillMatches, { comparedPixels: result.stillComparedPixels, mismatchedPixels: result.stillMismatchedPixels });
    t.ok('off releases tracks; rapid restart discards old permission', result.ended && result.pressedOff && result.stalePermissionSafe, observed);
    t.ok('Motion uses the existing clock and resumes after Parallax', result.motionAdvances && result.motionOffZero && result.loopResumes, observed);
    t.ok('camera denial permits tilt; both unavailable leaves Parallax off', result.deniedCameraTilt && result.deniedSafe, observed);
    t.ok('debug shows matching camera pixels and timestamped observations without entering export', result.debugMatches && result.debugExportSafe, observed);
    t.ok('toggles reuse cached face model', result.noToggleFetch, observed);
  },
}];
