import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const pointSchema = z.object({ x: z.number(), y: z.number() });
const resultSchema = z.object({
  center: z.number(), positive: z.number(), negative: z.number(),
  positiveY: z.number(), negativeY: z.number(), centerY: z.number(), clamped: z.boolean(),
  stillMatches: z.boolean(), windowExcludesTilt: z.boolean(), tiltExcludesWindow: z.boolean(),
  tracksStopped: z.boolean(), timedOut: z.boolean(), timeoutMs: z.number(),
  motionAdvances: z.boolean(), motionOffZero: z.boolean(), loopResumes: z.boolean(),
  deniedSafe: z.boolean(), stalePermissionSafe: z.boolean(), permissionInGesture: z.boolean(),
  recentered: z.boolean(), cameraInput: z.boolean(), cameraImported: z.boolean(), desktopUnchanged: z.boolean(),
  plateJoined: z.boolean(), sampleTimings: z.record(z.string(), z.number()),
  rotations: z.array(z.object({ angle: z.number(), center: pointSchema, gamma: pointSchema, beta: pointSchema })),
  activeRotation: pointSchema,
});

const phoneBoxSchema = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number(), width: z.number(), height: z.number() });
const layoutSchema = z.object({
  viewport: z.object({ width: z.number(), height: z.number() }),
  scrollWidth: z.number(), scrollHeight: z.number(), scrollX: z.number(), scrollY: z.number(),
  stage: phoneBoxSchema, status: phoneBoxSchema, toolbar: phoneBoxSchema,
  buttons: z.array(z.object({ label: z.string(), box: phoneBoxSchema, background: z.string(), pressed: z.string().nullable() })),
  accent: z.string(), desktopAbsent: z.boolean(), touchAction: z.string(),
});

/** Sent to the page without closures; schema validation happens on return. */
function phoneLayout(): unknown {
  const stage = document.querySelector('[data-testid="stage"]');
  const status = document.querySelector('[data-testid="status"]');
  const toolbar = document.querySelector('.phone-toolbar');
  if (stage === null || status === null || toolbar === null) throw new Error('Missing phone stage, status or toolbar.');
  const box = (element: Element) => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  window.scrollTo(100, 100);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, scrollX, scrollY,
    stage: box(stage), status: box(status), toolbar: box(toolbar),
    buttons: Array.from(toolbar.querySelectorAll('button'), (button) => ({
      label: button.textContent?.trim() ?? '', box: box(button), background: getComputedStyle(button).backgroundColor,
      pressed: button.getAttribute('aria-pressed'),
    })),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    desktopAbsent: document.querySelector('.scene-sidebar, .inspector, .viewer-toolbar') === null,
    touchAction: getComputedStyle(stage).touchAction,
  };
}

export const scenarios: readonly Scenario[] = [{
  id: 'phone.tilt', title: 'Touch photo capture and orientation share the Window view driver', target: 'dev', covers: ['PH1', 'PH3'], timeoutMs: 300_000,
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
      await page.click('[data-testid="try-sample"]');
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
          demo.injectScreenAngle(0);
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
          demo.injectScreenAngle(90); demo.injectOrientation(rest);
          await sleep(700); const activeRotation = await next(centroid);
          demo.injectScreenAngle(0); demo.injectOrientation(rest);
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

          const rotations: { angle: number; center: { x: number; y: number }; gamma: { x: number; y: number }; beta: { x: number; y: number } }[] = [];
          for (const angle of [90, 180, 270]) {
            demo.injectScreenAngle(angle);
            tilt.click(); await sleep(0); demo.injectOrientation(rest);
            await sleep(700); const rotatedCenter = await next(centroid);
            demo.injectOrientation({ beta: rest.beta, gamma: rest.gamma + 15 });
            await sleep(700); const gamma = await next(centroid);
            demo.injectOrientation({ beta: rest.beta + 15, gamma: rest.gamma });
            await sleep(700); const beta = await next(centroid);
            rotations.push({ angle, center: rotatedCenter, gamma, beta });
            tilt.click(); await next(() => undefined);
          }
          demo.injectScreenAngle(0);

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
            recentered, cameraInput, cameraImported, desktopUnchanged, plateJoined, sampleTimings, rotations, activeRotation };
        } finally {
          demo.injectScreenAngle(null);
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
      for (const rotation of result.rotations) {
        const { angle, center, gamma, beta } = rotation;
        const expectedGammaX = angle === 180 ? result.negative : result.center;
        const expectedGammaY = angle === 90 ? result.negativeY : angle === 270 ? result.positiveY : result.centerY;
        const expectedBetaX = angle === 90 ? result.positive : angle === 270 ? result.negative : result.center;
        const expectedBetaY = angle === 180 ? result.negativeY : result.centerY;
        t.ok(`${angle} degrees: rest stays centered and device axes move with the screen`,
          Math.abs(center.x - result.center) < 1 && Math.abs(center.y - result.centerY) < 1 &&
          Math.abs(gamma.x - expectedGammaX) < 1 && Math.abs(gamma.y - expectedGammaY) < 1 &&
          Math.abs(beta.x - expectedBetaX) < 1 && Math.abs(beta.y - expectedBetaY) < 1, rotation);
      }
      t.ok('rotating an active Tilt session preserves its physical rest pose', Math.abs(result.activeRotation.x - result.center) < 1 &&
        Math.abs(result.activeRotation.y - result.centerY) < 1, result.activeRotation);
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
}, {
  id: 'phone.layout', title: 'Full-screen phone stage, essentials toolbar and two-position tool sheet at both iPhone sizes',
  target: 'dev', covers: ['PH2'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 402, height: 874, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
    await page.goto('/');
    await page.evaluate(z.literal(true), () => {
      const touchDescriptor = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
      const permissionDescriptor = Object.getOwnPropertyDescriptor(DeviceOrientationEvent, 'requestPermission');
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
      Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: () => Promise.resolve('granted') });
      document.addEventListener('phone-layout-cleanup', () => {
        if (touchDescriptor === undefined) Reflect.deleteProperty(navigator, 'maxTouchPoints');
        else Object.defineProperty(navigator, 'maxTouchPoints', touchDescriptor);
        if (permissionDescriptor === undefined) Reflect.deleteProperty(DeviceOrientationEvent, 'requestPermission');
        else Object.defineProperty(DeviceOrientationEvent, 'requestPermission', permissionDescriptor);
      }, { once: true });
      return true;
    });
    try {
      // Re-enter the tier so touch gating is deterministic even if model
      // startup finished before maxTouchPoints was stubbed.
      await page.emulate({ width: 1200, height: 800, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('desktop frame above the phone tier', z.literal(true), () => document.querySelector('.scene-sidebar') !== null && document.querySelector('.phone-sheet') === null ? true : null);
      await page.emulate({ width: 402, height: 874, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('touch-gated phone empty frame', z.literal(true), () => document.querySelector('.phone-editor [data-testid="take-photo"]') !== null &&
        document.querySelector('.empty-actions button')?.textContent === 'Take a photo' ? true : null);
      const empty = await page.evaluate(z.object({ name: z.string(), actions: z.array(z.string()), toolbarAbsent: z.boolean(), statusVisible: z.boolean() }), () => {
        const status = document.querySelector('[data-testid="status"]')?.getBoundingClientRect();
        return {
          name: document.querySelector('.photo-name')?.textContent ?? '',
          actions: Array.from(document.querySelectorAll('.empty-actions button'), (button) => button.textContent ?? ''),
          toolbarAbsent: document.querySelector('.phone-toolbar') === null,
          statusVisible: status !== undefined && status.width > 0 && status.top >= 0 && status.bottom <= innerHeight,
        };
      });
      t.equal('empty strip names no photo', empty.name, 'No photo open');
      t.ok('empty stage offers capture and the sample, with visible status and no toolbar', empty.actions.join(',') === 'Take a photo,Try a sample' && empty.toolbarAbsent && empty.statusVisible, empty);
      await page.screenshot('phone-402-empty');
      await page.click('.empty-actions button:last-child');
      await page.waitFor('sample depth and decoder in phone frame', z.literal(true), () => {
        const analysis = window.__noisyTest?.demo.analysis();
        return analysis?.depth && analysis.decoderReady && !analysis.alive.heavy ? true : null;
      }, { timeoutMs: 180_000 });

      const checkLayout = async (label: string): Promise<void> => {
        const result = await page.evaluate(layoutSchema, phoneLayout);
        const { viewport, stage, status, toolbar, buttons } = result;
        const inside = (box: z.infer<typeof phoneBoxSchema>): boolean => box.width > 0 && box.height > 0 &&
          box.left >= 0 && box.top >= 0 && box.right <= viewport.width && box.bottom <= viewport.height;
        t.ok(`${label}: no horizontal overflow or page scroll`, result.scrollWidth === viewport.width && result.scrollHeight === viewport.height && result.scrollX === 0 && result.scrollY === 0, result);
        t.ok(`${label}: stage spans the viewport width and at least half its height`, stage.left === 0 && stage.width === viewport.width && stage.height >= viewport.height / 2, stage);
        t.ok(`${label}: five toolbar buttons stay inside the viewport and are at least 44 px tall`, inside(toolbar) && buttons.length === 5 && buttons.every((button) => inside(button.box) && button.box.height >= 44), result);
        t.equal(`${label}: modes precede Download`, buttons.map((button) => button.label), ['Motion', 'Symbols', 'Window', 'Tilt', 'Download']);
        t.ok(`${label}: modes are toggles and Download is accent-filled`, buttons.slice(0, 4).every((button) => button.pressed === 'true' || button.pressed === 'false') &&
          buttons[4]?.background === 'rgb(255, 61, 127)' && result.accent.toUpperCase() === '#FF3D7F', buttons);
        t.ok(`${label}: the status sentence is visible`, inside(status), status);
        t.ok(`${label}: desktop panels are absent and the stage suppresses browser gestures`, result.desktopAbsent && result.touchAction === 'none', result);
      };

      await page.waitFor('the sheet opens on import', z.literal(true), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' ? true : null);
      t.ok('Fry is visible inside the open sheet with manipulation touch handling', await page.evaluate(z.boolean(), () => {
        const range = document.querySelector('.phone-sheet [data-testid="style-fry"]');
        return range !== null && range.getBoundingClientRect().height >= 44 && getComputedStyle(range).touchAction === 'manipulation';
      }));
      await checkLayout('402 ready');
      await page.screenshot('phone-402-ready');
      await page.click('.sheet-handle');
      await page.waitFor('handle collapses the sheet', z.literal(true), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false' ? true : null);
      await checkLayout('402 handle collapsed');
      await page.click('.sheet-handle');
      await page.waitFor('handle reopens the sheet', z.literal(true), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' ? true : null);
      await page.evaluate(z.literal(true), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No phone dev surface.');
        await demo.tap(.38, .585);
        return true;
      });
      await page.waitFor('selected object swatches in the sheet', z.literal(true), () => document.querySelector('.phone-sheet [data-testid="swatches"]') === null ? null : true, { timeoutMs: 30_000 });
      const swatches = await page.evaluate(z.object({ count: z.number(), oneRow: z.boolean(), contained: z.boolean(), sizes: z.array(z.object({ width: z.number(), height: z.number() })) }), () => {
        const sheet = document.querySelector('.phone-sheet');
        if (sheet === null) throw new Error('No phone sheet.');
        const bounds = sheet.getBoundingClientRect();
        const boxes = Array.from(sheet.querySelectorAll('[data-testid="swatches"] .swatch'), (button) => button.getBoundingClientRect());
        return { count: boxes.length, oneRow: boxes.every((box) => box.top === boxes[0]?.top),
          contained: boxes.every((box) => box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom),
          sizes: boxes.map((box) => ({ width: box.width, height: box.height })) };
      });
      t.ok('selection puts eight 40 px swatches in one row inside the sheet', swatches.count === 8 && swatches.oneRow && swatches.contained && swatches.sizes.every((size) => size.width === 40 && size.height === 40), swatches);
      await checkLayout('402 selected');
      await page.screenshot('phone-402-selected');

      await page.click('[data-testid="tilt-enabled"]');
      await page.evaluate(z.literal(true), () => { window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: 35, gamma: 8 })); return true; });
      await page.waitFor('Tilt turns on and collapses the sheet', z.literal(true), () => document.querySelector('[data-testid="tilt-enabled"]')?.getAttribute('aria-pressed') === 'true' &&
        document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false' ? true : null);
      await checkLayout('402 Tilt collapsed');
      await page.screenshot('phone-402-collapsed');
      await page.click('[data-testid="tilt-enabled"]');
      await page.waitFor('Tilt turns off without reopening the sheet', z.literal(true), () => document.querySelector('[data-testid="tilt-enabled"]')?.getAttribute('aria-pressed') === 'false' &&
        document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false' ? true : null);
      await page.click('.sheet-handle');
      await page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('390 viewport and open sheet', z.literal(true), () => innerWidth === 390 && innerHeight === 844 && document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' ? true : null);
      await checkLayout('390 ready');
      await page.screenshot('phone-390-ready');
      // A tablet held upright takes the phone frame too (an 11-inch iPad Pro is 834 px wide in portrait).
      await page.emulate({ width: 834, height: 1194, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('834 portrait viewport and open sheet', z.literal(true), () => innerWidth === 834 && innerHeight === 1194 && document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' ? true : null);
      await checkLayout('834 tablet portrait ready');
      await page.screenshot('tablet-834-ready');
    } finally {
      await page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('phone-layout-cleanup')); return true; });
    }
  },
}];
