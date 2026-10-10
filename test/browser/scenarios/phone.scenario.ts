import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const resultSchema = z.object({
  center: z.number(), positive: z.number(), negative: z.number(),
  positiveY: z.number(), negativeY: z.number(), centerY: z.number(), clamped: z.boolean(),
  stillMatches: z.boolean(), windowExcludesTilt: z.boolean(), tiltExcludesWindow: z.boolean(),
  tracksStopped: z.boolean(), timedOut: z.boolean(), timeoutMs: z.number(),
  motionAdvances: z.boolean(), motionOffZero: z.boolean(), loopResumes: z.boolean(),
  deniedSafe: z.boolean(), stalePermissionSafe: z.boolean(), permissionInGesture: z.boolean(),
  recentered: z.boolean(), cameraInput: z.boolean(), cameraImported: z.boolean(), desktopUnchanged: z.boolean(),
  plateJoined: z.boolean(), sampleTimings: z.record(z.string(), z.number()),
});

export const scenarios: readonly Scenario[] = [{
  id: 'phone.tilt', title: 'Touch photo capture and orientation share the Window view driver', target: 'dev', covers: ['PH1'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    await page.goto('/');
    const desktopUnchanged = await page.evaluate(z.boolean(), () => {
      const untouched = navigator.maxTouchPoints === 0 && document.querySelector('[data-testid="take-photo"]') === null;
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
      document.addEventListener('phone-scenario-cleanup', () => {
        if (descriptor === undefined) Reflect.deleteProperty(navigator, 'maxTouchPoints');
        else Object.defineProperty(navigator, 'maxTouchPoints', descriptor);
      }, { once: true });
      return untouched;
    });
    try {
      await page.click('.action-rail button:nth-child(2)');
      await page.waitFor('sample depth and decoder', z.literal(true), () => {
        const analysis = window.__noisyTest?.demo.analysis();
        return analysis?.depth && analysis.decoderReady && !analysis.alive.heavy ? true : null;
      }, { timeoutMs: 180_000 });
      const result = await page.evaluate(resultSchema, async (desktopUnchanged: boolean) => {
        const test = window.__noisyTest, renderer = test?.session?.renderer(), demo = test?.demo;
        if (renderer === null || renderer === undefined || demo === undefined) throw new Error('No renderer or dev surface.');
        const tilt = document.querySelector('[data-testid="tilt-enabled"]');
        const windowButton = document.querySelector('[data-testid="window-enabled"]');
        const takePhoto = document.querySelector('[data-testid="take-photo"]');
        const stage = document.querySelector('[data-testid="stage"]');
        if (!(tilt instanceof HTMLButtonElement) || !(windowButton instanceof HTMLButtonElement) ||
            !(takePhoto instanceof HTMLButtonElement) || !(stage instanceof HTMLCanvasElement)) throw new Error('No phone controls or stage.');
        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        const next = <T>(read: () => T): Promise<T> => new Promise((resolve) => requestAnimationFrame(() => resolve(read())));
        const wait = async (ready: () => boolean, timeoutMs = 60_000): Promise<void> => {
          const start = performance.now();
          while (!ready()) {
            if (performance.now() - start > timeoutMs) throw new Error('Phone scenario timed out: ' + document.querySelector('[data-testid="status"]')?.textContent);
            await sleep(20);
          }
        };
        const on = (button: HTMLButtonElement): boolean => button.getAttribute('aria-pressed') === 'true';
        const size = { width: 128, height: 96 }, mask = new Uint8Array(size.width * size.height), depth = new Float32Array(mask.length).fill(.25);
        for (let y = 36; y < 60; y++) for (let x = 48; x < 80; x++) { const i = y * size.width + x; mask[i] = 255; depth[i] = 1; }
        const sampleTimings = demo.analysis().timings;
        const desktopModes = Array.from(document.querySelectorAll('.bottom-bar .mode-rail button')).map((button) => button.textContent);
        desktopUnchanged &&= desktopModes.join(',') === 'Motion,Symbols,Window,Tilt';
        demo.injectMask({ ...size, data: mask });
        await wait(() => demo.objects().length > 0, 10_000);
        demo.injectDepth({ format: 'f32', size, data: depth }); demo.select(null);
        demo.setMotion({ enabled: false }); demo.setSymbols({ enabled: false });
        demo.setStyle({ simplify: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0, outline: 0 });
        const centroid = () => {
          const labels = renderer.debug?.readGeometryPatch?.(0, 0, stage.width, stage.height);
          if (labels === undefined) throw new Error('No geometry probe.');
          let x = 0, y = 0, count = 0;
          for (let i = 0; i < labels.length; i += 4) if (labels[i] === 1 && labels[i + 3] === 255) {
            x += (i / 4) % stage.width; y += Math.floor(i / 4 / stage.width); count++;
          }
          if (count === 0) throw new Error('No injected object pixels.');
          return { x: x / count, y: y / count };
        };
        const permissionDescriptor = Object.getOwnPropertyDescriptor(DeviceOrientationEvent, 'requestPermission');
        let permissionInGesture = false;
        const permission = (request: () => Promise<string>): void => {
          Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: request });
        };
        const rest = { beta: 35, gamma: 8 };
        try {
          permission(() => { permissionInGesture = true; return Promise.resolve('granted'); });
          tilt.click();
          // The permission call must already have run in the click stack, before yielding.
          const calledSynchronously = permissionInGesture;
          await sleep(0); window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', rest));
          await wait(() => on(tilt) && demo.analysis().plate && !demo.products().plateNeeded);
          await sleep(700); const center = await next(centroid);
          demo.injectOrientation({ beta: rest.beta, gamma: rest.gamma + 15 });
          await sleep(700); const positive = await next(centroid);
          demo.injectOrientation({ beta: rest.beta, gamma: rest.gamma - 15 });
          await sleep(700); const negative = await next(centroid);
          demo.injectOrientation({ beta: rest.beta + 15, gamma: rest.gamma });
          await sleep(700); const positiveY = await next(centroid);
          demo.injectOrientation({ beta: rest.beta - 15, gamma: rest.gamma });
          await sleep(700); const negativeY = await next(centroid);
          demo.injectOrientation({ beta: rest.beta, gamma: rest.gamma + 20 });
          await sleep(900); const reach = await next(centroid);
          demo.injectOrientation({ beta: rest.beta, gamma: rest.gamma + 100 });
          await sleep(900); const beyond = await next(centroid);
          const clamped = Math.abs(reach.x - beyond.x) < 1;
          demo.setMotion({ enabled: true }); const before = demo.frame(); await sleep(120);
          const motionAdvances = demo.frame() !== before;
          demo.setMotion({ enabled: false }); await next(() => undefined); const motionOffZero = demo.frame() === 0;
          const plateJoined = demo.analysis().plate;
          tilt.click();
          const canvas = document.createElement('canvas'); canvas.width = stage.width; canvas.height = stage.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No capture context.');
          const points = [[.125, .125], [.875, .875], [.375, .5], [.625, .5]];
          const sample = () => {
            ctx.drawImage(stage, 0, 0);
            return points.flatMap(([x = 0, y = 0]) => Array.from(ctx.getImageData(Math.floor(x * stage.width), Math.floor(y * stage.height), 1, 1).data));
          };
          const restored = sample(); renderer.renderFrame(0); const reference = sample();
          const stillMatches = restored.every((v, i) => v === reference[i]) && restored.filter((_, i) => i % 4 === 3).every((v) => v === 255);
          await next(() => undefined);
          demo.setMotion({ enabled: true }); await sleep(100); const loopAt = demo.frame(); await sleep(100);
          const loopResumes = demo.frame() !== loopAt; demo.setMotion({ enabled: false });

          tilt.click(); await sleep(0); demo.injectOrientation({ beta: 60, gamma: -12 });
          await sleep(700); const freshCenter = await next(centroid);
          const recentered = Math.abs(freshCenter.x - center.x) < 1 && Math.abs(freshCenter.y - center.y) < 1;
          windowButton.click();
          await wait(() => on(windowButton) && !on(tilt) && demo.windowReady());
          const windowExcludesTilt = !on(tilt);
          const tracks = demo.windowTracks();
          tilt.click(); await sleep(0); demo.injectOrientation(rest);
          await wait(() => on(tilt) && !on(windowButton));
          const tiltExcludesWindow = !on(windowButton), tracksStopped = tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
          tilt.click(); await next(() => undefined);
          const timeoutStart = performance.now(); tilt.click();
          await wait(() => !on(tilt) && document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Tilt unavailable') === true, 5000);
          const timeoutMs = performance.now() - timeoutStart, timedOut = timeoutMs >= 1900 && timeoutMs < 5000;

          permission(() => Promise.resolve('denied')); tilt.click();
          await next(() => undefined);
          await wait(() => !on(tilt) && document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Tilt unavailable') === true);
          const deniedSafe = !on(tilt);
          let allow = (_: string): void => {};
          permission(() => new Promise<string>((resolve) => { allow = resolve; }));
          tilt.click(); await next(() => undefined); tilt.click(); allow('granted'); await sleep(50);
          demo.injectOrientation(rest); await next(() => undefined); const stalePermissionSafe = !on(tilt);
          permission(() => Promise.resolve('granted'));

          const camera = document.querySelector('input[capture="environment"]');
          if (!(camera instanceof HTMLInputElement)) throw new Error('No capture input.');
          let opened = false;
          const ownClick = Object.getOwnPropertyDescriptor(camera, 'click');
          Object.defineProperty(camera, 'click', { configurable: true, value: () => { opened = true; } });
          try { takePhoto.click(); }
          finally { if (ownClick === undefined) Reflect.deleteProperty(camera, 'click'); else Object.defineProperty(camera, 'click', ownClick); }
          const cameraInput = opened && camera.accept === 'image/*' && camera.type === 'file' && camera.getAttribute('capture') === 'environment';
          const data = new DataTransfer();
          data.items.add(new File([await (await fetch('/assets-static/sample.jpg')).blob()], 'phone-camera.jpg', { type: 'image/jpeg' }));
          camera.files = data.files; camera.dispatchEvent(new Event('change', { bubbles: true }));
          await wait(() => demo.document()?.frame.original.name === 'phone-camera.jpg' && demo.analysis().decoderReady && demo.analysis().depth && !demo.analysis().alive.heavy, 180_000);
          const cameraImported = demo.scene().status === 'Ready' && camera.value === '';
          // Removing touch capability must restore the existing desktop controls.
          Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
          // An empty patch is UNCHANGED in the reducer and publishes nothing; a real grain change makes the rails re-render.
          demo.setStyle({ grain: (demo.document()?.style.grain ?? 0) > 0.5 ? 0.25 : 0.75 }); await next(() => undefined);
          desktopUnchanged &&= document.querySelector('[data-testid="take-photo"]') === null &&
            document.querySelector('[data-testid="tilt-enabled"]') === null &&
            Array.from(document.querySelectorAll('.bottom-bar .mode-rail button')).map((button) => button.textContent).join(',') === 'Motion,Symbols,Window';
          return { center: center.x, centerY: center.y, positive: positive.x, negative: negative.x, positiveY: positiveY.y, negativeY: negativeY.y,
            clamped, stillMatches, windowExcludesTilt, tiltExcludesWindow, tracksStopped, timedOut, timeoutMs,
            motionAdvances, motionOffZero, loopResumes, deniedSafe, stalePermissionSafe, permissionInGesture: calledSynchronously,
            recentered, cameraInput, cameraImported, desktopUnchanged, plateJoined, sampleTimings };
        } finally {
          if (permissionDescriptor === undefined) Reflect.deleteProperty(DeviceOrientationEvent, 'requestPermission');
          else Object.defineProperty(DeviceOrientationEvent, 'requestPermission', permissionDescriptor);
        }
      }, desktopUnchanged);
      await t.file('phone.json', JSON.stringify(result, null, 2));
      await page.screenshot('phone-desktop');
      await page.evaluate(z.literal(true), async () => {
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
        const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No dev surface.');
        demo.setStyle({ grain: (demo.document()?.style.grain ?? 0) > 0.5 ? 0.25 : 0.75 });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return true;
      });
      await page.screenshot('phone');
      t.ok('gamma +15 moves the near object left and -15 moves it right around the rest pose', result.positive - result.center < -2 && result.negative - result.center > 2, result);
      t.ok('beta moves in opposite vertical directions and travel clamps at 20 degrees', (result.positiveY - result.centerY) * (result.negativeY - result.centerY) < 0 && result.clamped, result);
      t.ok('Tilt off restores frame zero at four opaque sampled points', result.stillMatches, result);
      t.ok('Window and Tilt exclude each other and the stopped camera tracks end', result.windowExcludesTilt && result.tiltExcludesWindow && result.tracksStopped, result);
      t.ok('no orientation within two seconds reports Tilt unavailable and turns off', result.timedOut, result);
      t.ok('Tilt uses the shared motion clock, plate request and stop path', result.motionAdvances && result.motionOffZero && result.loopResumes && result.plateJoined, result);
      t.ok('permission runs in the click stack, denial stays off and late grants cannot restart', result.permissionInGesture && result.deniedSafe && result.stalePermissionSafe, result);
      t.ok('each enable captures a fresh rest pose', result.recentered, result);
      t.ok('Take a photo opens an environment capture input and its JPEG imports through the change event', result.cameraInput && result.cameraImported, result);
      t.ok('without touch the action and mode rails retain their existing desktop controls', result.desktopUnchanged, result);
    } finally {
      await page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('phone-scenario-cleanup')); return true; });
    }
  },
}];
