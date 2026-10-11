import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const pointSchema = z.object({ x: z.number(), y: z.number() });
const resultSchema = z.object({
  center: z.number(), positive: z.number(), negative: z.number(),
  positiveY: z.number(), negativeY: z.number(), centerY: z.number(), clamped: z.boolean(),
  stillMatches: z.boolean(), bothSources: z.boolean(),
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

/** Scroll only the inspector body; overflow-hidden ancestors must not move. */
function revealInspectorControl(selector: string): true {
  const control = document.querySelector(selector);
  const body = control?.closest('.phone-tools, .inspector .node-stack');
  if (control !== null && body instanceof HTMLElement) {
    const box = control.getBoundingClientRect(), bounds = body.getBoundingClientRect();
    if (box.top < bounds.top + 8) body.scrollTop += box.top - bounds.top - 8;
    else if (box.bottom > bounds.bottom - 8) body.scrollTop += box.bottom - bounds.bottom + 8;
  }
  return true;
}

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
  id: 'phone.tilt', title: 'Touch photo capture, Parallax orientation, fusion and source cancellation', target: 'dev', covers: ['PH1', 'PH3', 'POL1b-5'], timeoutMs: 300_000,
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
      // Touch capability adds a header action and shifts the sample button.
      // Wait for that render before the driver samples its click coordinates.
      await page.waitFor('touch controls rendered', z.literal(true), () =>
        document.querySelector('[data-testid="take-photo"]') instanceof HTMLButtonElement ? true : null);
      await page.click('[data-testid="try-sample"]');
      await page.waitFor('sample depth and decoder', z.literal(true), () => {
        const analysis = window.__noisyTest?.demo.analysis();
        return analysis?.depth && analysis.decoderReady && !analysis.alive.heavy ? true : null;
      }, { timeoutMs: 180_000 });
      const result = await page.evaluate(resultSchema, async (desktopUnchanged: boolean) => {
        const test = window.__noisyTest, renderer = test?.session?.renderer(), demo = test?.demo;
        if (renderer === null || renderer === undefined || demo === undefined) throw new Error('No renderer or dev surface.');
        const tilt = document.querySelector('[data-testid="parallax-enabled"]');
        const takePhoto = document.querySelector('[data-testid="take-photo"]');
        const stage = document.querySelector('[data-testid="stage"]');
        if (!(tilt instanceof HTMLButtonElement) ||
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
        desktopUnchanged &&= desktopModes.join(',') === 'Motion,Symbols,Parallax';
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
        const media = navigator.mediaDevices, getUserMedia = media.getUserMedia;
        media.getUserMedia = () => Promise.reject(new DOMException('Scenario isolates tilt.', 'NotAllowedError'));
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
          tilt.click(); await next(() => undefined);
          media.getUserMedia = getUserMedia;
          tilt.click(); await sleep(0); demo.injectOrientation(rest);
          await wait(() => on(tilt) && demo.windowReady() && demo.parallaxDebug().tiltRunning);
          const bothSources = document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Parallax: camera and tilt') === true;
          const tracks = demo.windowTracks();
          tilt.click(); await next(() => undefined);
          const tracksStopped = tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
          media.getUserMedia = () => Promise.reject(new DOMException('Scenario isolates tilt.', 'NotAllowedError'));
          const timeoutStart = performance.now(); tilt.click();
          await wait(() => !on(tilt) && document.querySelector('[data-testid="status"]')?.textContent?.includes('Tilt unavailable') === true, 5000);
          const timeoutMs = performance.now() - timeoutStart, timedOut = timeoutMs >= 1900 && timeoutMs < 5000;

          permission(() => Promise.resolve('denied')); tilt.click();
          await next(() => undefined);
          await wait(() => !on(tilt) && document.querySelector('[data-testid="status"]')?.textContent?.includes('Tilt unavailable') === true);
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
            Array.from(document.querySelectorAll('.bottom-bar .mode-rail button')).map((button) => button.textContent).join(',') === 'Motion,Symbols,Parallax';
          return { center: center.x, centerY: center.y, positive: positive.x, negative: negative.x, positiveY: positiveY.y, negativeY: negativeY.y,
            clamped, stillMatches, bothSources, tracksStopped, timedOut, timeoutMs,
            motionAdvances, motionOffZero, loopResumes, deniedSafe, stalePermissionSafe, permissionInGesture: calledSynchronously,
            recentered, cameraInput, cameraImported, desktopUnchanged, plateJoined, sampleTimings, rotations, activeRotation };
        } finally {
          media.getUserMedia = getUserMedia;
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
      t.ok('rotating an active Parallax session preserves its physical rest pose', Math.abs(result.activeRotation.x - result.center) < 1 &&
        Math.abs(result.activeRotation.y - result.centerY) < 1, result.activeRotation);
      t.ok('Parallax off restores frame zero at four opaque sampled points', result.stillMatches, result);
      t.ok('camera and tilt run together and Parallax off ends the camera tracks', result.bothSources && result.tracksStopped, result);
      t.ok('no orientation within two seconds reports Tilt unavailable and turns off', result.timedOut, result);
      t.ok('Parallax uses the shared motion clock, plate request and stop path', result.motionAdvances && result.motionOffZero && result.loopResumes && result.plateJoined, result);
      t.ok('permission runs in the click stack, denial stays off and late grants cannot restart', result.permissionInGesture && result.deniedSafe && result.stalePermissionSafe, result);
      t.ok('each enable captures a fresh rest pose', result.recentered, result);
      t.ok('Take a photo opens an environment capture input and its JPEG imports through the change event', result.cameraInput && result.cameraImported, result);
      t.ok('without touch the action and mode rails retain their existing desktop controls', result.desktopUnchanged, result);
    } finally {
      await page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('phone-scenario-cleanup')); return true; });
    }
  },
}, {
  id: 'phone.layout', title: 'Full-screen portrait stage, complete inspector and a two-position tool sheet',
  target: 'dev', covers: ['PH2', 'POL1b-4', 'POL1b-5'], timeoutMs: 300_000,
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
      t.equal('the phone status describes capture and sample actions', await page.evaluate(z.string(), () => document.querySelector('[data-testid="status"]')?.textContent ?? ''), 'Take a photo or try a sample');
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
        t.ok(`${label}: stage spans the viewport width with room for the picture above the inspector`, stage.left === 0 && stage.width === viewport.width && stage.height >= viewport.height / 4, stage);
        t.ok(`${label}: four toolbar buttons stay inside the viewport and are at least 44 px tall`, inside(toolbar) && buttons.length === 4 && buttons.every((button) => inside(button.box) && button.box.height >= 44), result);
        t.equal(`${label}: modes precede Download`, buttons.map((button) => button.label), ['Motion', 'Symbols', 'Parallax', 'Download']);
        t.ok(`${label}: modes are toggles and Download is accent-filled`, buttons.slice(0, 3).every((button) => button.pressed === 'true' || button.pressed === 'false') &&
          buttons[3]?.background === 'rgb(255, 61, 127)' && result.accent.toUpperCase() === '#FF3D7F', buttons);
        t.ok(`${label}: the status sentence is visible`, inside(status), status);
        t.ok(`${label}: desktop panels are absent and the stage suppresses browser gestures`, result.desktopAbsent && result.touchAction === 'none', result);
      };

      const checkProjects = async (label: string): Promise<void> => {
        // Object selection can still be finishing its plate after the worker
        // exits. Compare the return task after that product is committed.
        await page.waitFor(`${label}: analysis settled before the Projects snapshot`, z.literal(true), () => {
          const demo = window.__noisyTest?.demo;
          if (demo === undefined) return null;
          const analysis = demo.analysis();
          return analysis.depth && analysis.decoderReady && !analysis.alive.heavy &&
            (demo.products().masks === 0 || analysis.plate) ? true : null;
        }, { timeoutMs: 180_000 });
        const before = await page.evaluate(z.string(), () => JSON.stringify({ document: window.__noisyTest?.demo.document(), selected: window.__noisyTest?.demo.objects().filter((object) => object.selected) }));
        await page.click('[data-testid="projects-toggle"]');
        const projects = await page.evaluate(z.object({ railAbsent: z.boolean(), resetAbsent: z.boolean(), returnVisible: z.boolean(), statusVisible: z.boolean(), stageFills: z.boolean() }), () => {
          const stage = document.querySelector('.phone-stage')?.getBoundingClientRect();
          const button = document.querySelector('[data-testid="projects-return"]')?.getBoundingClientRect();
          const status = document.querySelector('.projects-editor-status')?.getBoundingClientRect();
          return {
            railAbsent: document.querySelector('.phone-toolbar') === null,
            resetAbsent: !Array.from(document.querySelectorAll('.phone-strip button')).some((button) => button.textContent === 'Reset'),
            returnVisible: button !== undefined && button.height >= 44 && button.top >= 44 && button.right <= innerWidth,
            statusVisible: status !== undefined && status.height >= 44 && status.bottom <= innerHeight,
            stageFills: stage?.top === 44 && stage.bottom === innerHeight,
          };
        });
        t.ok(`${label}: Projects presents return and status in place of hidden-photo controls`, Object.values(projects).every(Boolean), projects);
        await page.screenshot(`projects-task-${label}`);
        await page.click('[data-testid="projects-return"]');
        t.equal(`${label}: returning keeps the scene, edits and selection`, await page.evaluate(z.string(), () => JSON.stringify({ document: window.__noisyTest?.demo.document(), selected: window.__noisyTest?.demo.objects().filter((object) => object.selected) })), before);
        await checkLayout(`${label} after returning`);
      };
      await page.waitFor('the sheet opens on import', z.literal(true), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' ? true : null);
      t.ok('Fry is visible inside the open sheet with manipulation touch handling', await page.evaluate(z.boolean(), () => {
        const range = document.querySelector('.phone-sheet [data-testid="style-fry"]');
        return range !== null && range.getBoundingClientRect().height >= 44 && getComputedStyle(range).touchAction === 'manipulation';
      }));
      await checkLayout('402 ready');
      await page.screenshot('phone-402-ready');
      await checkProjects('402');
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
      await page.evaluate(z.literal(true), revealInspectorControl, '.phone-sheet .object-node');
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

      await page.click('[data-testid="parallax-enabled"]');
      await page.evaluate(z.literal(true), () => { window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: 35, gamma: 8 })); return true; });
      await page.waitFor('Tilt turns on and collapses the sheet', z.literal(true), () => document.querySelector('[data-testid="parallax-enabled"]')?.getAttribute('aria-pressed') === 'true' &&
        document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false' ? true : null);
      t.ok('portrait Parallax node and rail share the active state', await page.evaluate(z.boolean(), () => {
        const node = document.querySelector('[data-testid="parallax-node-enabled"]');
        return node instanceof HTMLInputElement && node.checked;
      }));
      await checkLayout('402 Tilt collapsed');
      await page.screenshot('phone-402-collapsed');
      await page.waitFor('camera and tilt are running together on the phone', z.literal(true), () => {
        const debug = window.__noisyTest?.demo.parallaxDebug();
        return debug?.cameraRunning && debug.tiltRunning ? true : null;
      }, { timeoutMs: 60_000 });
      await page.evaluate(z.literal(true), () => {
        const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No phone dev surface.');
        const pixels = new ImageData(320, 240);
        for (let i = 0; i < pixels.data.length; i += 4) { pixels.data[i] = 80; pixels.data[i + 1] = 120; pixels.data[i + 2] = 160; pixels.data[i + 3] = 255; }
        demo.injectScreenAngle(0); demo.injectOrientation({ beta: 35, gamma: 12 });
        demo.injectCameraFrame(pixels, { center: { x: .4, y: .5 }, size: .25 });
        return true;
      });
      await page.click('.sheet-handle');
      await page.evaluate(z.literal(true), revealInspectorControl, '.phone-sheet [aria-controls="node-parallax"]');
      await page.click('.phone-sheet [aria-controls="node-parallax"]');
      await page.click('[data-testid="parallax-debug-toggle"]');
      await page.click('.sheet-handle');
      await page.waitFor('phone debug numbers and frame are visible', z.literal(true), () => {
        const panel = document.querySelector('[data-testid="parallax-debug"]');
        const frame = document.querySelector('[data-testid="parallax-debug-frame"]');
        if (!(panel instanceof HTMLElement) || !(frame instanceof HTMLCanvasElement)) return null;
        const box = panel.getBoundingClientRect(), status = document.querySelector('.sheet-handle')?.getBoundingClientRect();
        const pixel = frame.getContext('2d')?.getImageData(0, 0, 1, 1).data;
        return box.width === 200 && box.left >= 0 && box.right === innerWidth - 12 && status !== undefined &&
          Math.abs(status.top - box.bottom - 12) < 1 && document.querySelector('[data-testid="parallax-beta"]')?.textContent === '35.00' &&
          document.querySelector('[data-testid="parallax-gamma"]')?.textContent === '12.00' && pixel?.[0] === 80 && pixel[3] === 255 ? true : null;
      });
      await page.screenshot('parallax-phone-402');
      await page.click('.sheet-handle');
      await page.click('[data-testid="parallax-debug-toggle"]');
      await page.click('.sheet-handle');
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.injectScreenAngle(null); return true; });

      await page.click('[data-testid="parallax-enabled"]');
      await page.waitFor('Tilt turns off without reopening the sheet', z.literal(true), () => document.querySelector('[data-testid="parallax-enabled"]')?.getAttribute('aria-pressed') === 'false' &&
        document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false' ? true : null);
      t.ok('portrait Parallax node and rail share the off state', await page.evaluate(z.boolean(), () => {
        const node = document.querySelector('[data-testid="parallax-node-enabled"]');
        return node instanceof HTMLInputElement && !node.checked;
      }));
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
      await checkProjects('834');
      for (const name of ['motion', 'symbols']) {
        await page.click(`[data-testid="${name}-enabled"]`);
        t.ok(`portrait ${name} rail updates its inspector toggle`, await page.evaluate(z.boolean(), (name) => {
          const node = document.querySelector(`[data-testid="${name}-node-enabled"]`);
          return node instanceof HTMLInputElement && String(node.checked) === document.querySelector(`[data-testid="${name}-enabled"]`)?.getAttribute('aria-pressed');
        }, name));
        await page.evaluate(z.literal(true), revealInspectorControl, `[data-testid="${name}-node-enabled"]`);
        await page.click(`[data-testid="${name}-node-enabled"]`);
        t.ok(`portrait ${name} inspector toggle updates its rail`, await page.evaluate(z.boolean(), (name) => {
          const node = document.querySelector(`[data-testid="${name}-node-enabled"]`);
          return node instanceof HTMLInputElement && String(node.checked) === document.querySelector(`[data-testid="${name}-enabled"]`)?.getAttribute('aria-pressed');
        }, name));
      }
      await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
      await page.waitFor('desktop frame after portrait mode changes', z.literal(true), () =>
        document.querySelector('.inspector') !== null && document.querySelectorAll('.bottom-bar .mode-rail button').length === 3 ? true : null);
      const desktopModes = await page.evaluate(z.object({ names: z.array(z.string()), matches: z.array(z.boolean()) }), () => {
        const modes = Array.from(document.querySelectorAll('.bottom-bar .mode-rail button'));
        return { names: modes.map((button) => button.textContent ?? ''), matches: ['motion-enabled', 'symbols-enabled', 'parallax-node-enabled'].map((id, index) => {
          const input = document.querySelector(`[data-testid="${id}"]`);
          return input instanceof HTMLInputElement && String(input.checked) === modes[index]?.getAttribute('aria-pressed');
        }) };
      });
      t.ok('desktop exposes the same three mode concepts and matching inspector states', desktopModes.names.join(',') === 'Motion,Symbols,Parallax' && desktopModes.matches.every(Boolean), desktopModes);
    } finally {
      await page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('phone-layout-cleanup')); return true; });
    }
  },
}, {
  id: 'phone.inspector', title: 'The complete portrait inspector retains edits, selection and keyboard reachability',
  target: 'dev', covers: ['POL1b-1', 'POL1b-2', 'POL1b-6'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 402, height: 874, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
    await page.goto('/');
    await page.click('.empty-actions button:last-child');
    await page.waitFor('sample ready for inspector edits', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 180_000 });
    await page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.tap(.38, .585); return true; });
    await page.waitFor('selected object', z.literal(true), () => window.__noisyTest?.demo.objects().some((object) => object.selected) ? true : null);
    const click = async (selector: string): Promise<void> => {
      await page.evaluate(z.literal(true), revealInspectorControl, selector);
      await page.click(selector);
      const moved = await page.evaluate(z.array(z.string()), (selector) => {
        const moved: string[] = [];
        for (let node = document.querySelector(selector)?.parentElement; node !== null && node !== undefined; node = node.parentElement) {
          if (!node.matches('.phone-tools, .inspector .node-stack') && (node.scrollTop !== 0 || node.scrollLeft !== 0)) moved.push(`${node.tagName}.${node.className}: ${node.scrollTop},${node.scrollLeft}`);
        }
        return moved;
      }, selector);
      t.equal(`only the inspector body scrolls when reaching ${selector}`, moved, []);
    };
    const changeRange = async (id: string): Promise<void> => {
      const initial = await page.evaluate(z.number(), (id) => {
        const input = document.querySelector(`[data-testid="${id}"]`);
        if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${id}`);
        return input.valueAsNumber;
      }, id);
      await click(`[data-testid="${id}"]`);
      const change = await page.evaluate(z.object({ before: z.number(), after: z.number(), expected: z.number(), documentChanged: z.boolean() }), async ({ id, initial }) => {
        const input = document.querySelector(`[data-testid="${id}"]`);
        if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${id}`);
        const before = initial, min = Number(input.min), max = Number(input.max), step = Number(input.step);
        const previous = JSON.stringify(window.__noisyTest?.demo.document());
        const expected = min + Math.round((max - min) * (before < (min + max) / 2 ? .8 : .2) / step) * step;
        input.value = String(expected);
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return { before, after: input.valueAsNumber, expected, documentChanged: JSON.stringify(window.__noisyTest?.demo.document()) !== previous };
      }, { id, initial });
      t.ok(`${id}: a value away from the current one changes the scene`, change.after !== change.before && Math.abs(change.after - change.expected) < .00001 && change.documentChanged, change);
    };
    for (const size of [{ width: 402, height: 874 }, { width: 834, height: 1194 }]) {
      await page.emulate({ ...size, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('portrait inspector', z.literal(true), () => document.querySelector('.sheet-inspector') === null ? null : true);
      const initial = await page.evaluate(z.object({ names: z.array(z.string()), first: z.string(), closed: z.boolean() }), () => ({
        names: Array.from(document.querySelectorAll('.sheet-inspector .node'), (node) => node.getAttribute('aria-label') ?? ''),
        first: document.querySelector('.sheet-inspector .node')?.getAttribute('aria-label') ?? '',
        closed: Array.from(document.querySelectorAll('.sheet-inspector .node:not([aria-label="Fry"]) .node-disclosure')).every((button) => button.getAttribute('aria-expanded') === 'false'),
      }));
      t.equal(`${size.width}: Fry is visibly named first`, initial.first, 'Fry');
      t.equal(`${size.width}: all nodes and Layers are present`, initial.names, ['Fry', 'Layers', 'Motion', 'Parallax', 'Symbols', 'Surface', 'Palette', 'Camera']);
      t.ok(`${size.width}: secondary groups start collapsed`, initial.closed, initial);
      await click('[aria-controls="node-layers"]');
      await click('.phone-tools .layer-row:first-child');
      t.ok(`${size.width}: Plate deselects the object`, await page.evaluate(z.boolean(), () => !window.__noisyTest?.demo.objects().some((object) => object.selected)));
      await click('.phone-tools .layer-row:last-child .layer-select');
      const color = await page.evaluate(z.string(), () => document.querySelector('.phone-tools .swatch[aria-label="Green"]')?.getAttribute('aria-pressed') === 'true' ? 'Coral' : 'Green');
      await click(`.phone-tools .swatch[aria-label="${color}"]`);
      t.ok(`${size.width}: the selected layer's color changes`, await page.evaluate(z.boolean(), (color) => document.querySelector(`.phone-tools .swatch[aria-label="${color}"]`)?.getAttribute('aria-pressed') === 'true', color));
      await click('[aria-controls="node-layers"]');
      await changeRange('style-fry');
      await page.click('.sheet-handle');
      await page.click('.phone-toolbar [data-testid="motion-enabled"]');
      await page.waitFor(`${size.width}: enabling Motion reopens the sheet and its export node`, z.literal(true), () =>
        document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' &&
        document.querySelector('[aria-controls="node-motion"]')?.getAttribute('aria-expanded') === 'true' &&
        (document.querySelector('.phone-sheet .motion-export')?.getBoundingClientRect().height ?? 0) > 0 ? true : null);
      await changeRange('motion-parallax');
      const originalDirection = await page.evaluate(z.enum(['side', 'vertical', 'circle']), () => window.__noisyTest?.demo.document()?.motion.drift.direction ?? null);
      const directions = ['side', 'vertical', 'circle'] as const;
      for (const direction of [...directions.filter((direction) => direction !== originalDirection), originalDirection]) {
        const before = await page.evaluate(z.string().nullable(), () => window.__noisyTest?.demo.document()?.motion.drift.direction ?? null);
        await click(`[data-testid="motion-drift-${direction}"]`);
        const changed = await page.evaluate(z.object({ direction: z.string().nullable(), pressed: z.array(z.string()) }), () => ({
          direction: window.__noisyTest?.demo.document()?.motion.drift.direction ?? null,
          pressed: Array.from(document.querySelectorAll('.motion-directions [aria-pressed="true"]'), (button) => button.getAttribute('data-testid') ?? ''),
        }));
        t.ok(`${size.width}: ${direction} changes Drift with exactly one pressed choice`, before !== direction && changed.direction === direction && changed.pressed.join(',') === `motion-drift-${direction}`, { before, ...changed });
      }
      await changeRange('motion-drift-amount');
      await page.click('.phone-toolbar [data-testid="motion-enabled"]');
      for (const [name, control] of [
        ['Symbols', 'symbols-cellSize'], ['Surface', 'surface-relief'],
        ['Palette', 'style-colors'], ['Camera', 'style-grain'],
      ]) {
        await click(`[aria-controls="node-${name?.toLowerCase()}"]`);
        if (control === undefined) throw new Error('Missing node control');
        await changeRange(control);
      }
      await click('[aria-controls="node-parallax"]');
      await click('[data-testid="parallax-debug-toggle"]');
      t.ok(`${size.width}: Parallax node works`, await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="parallax-debug"]') !== null));
      await click('[data-testid="parallax-debug-toggle"]');
      // Native Tab must reveal each lower Camera control inside the one body.
      await click('[data-testid="style-grain"]');
      for (let i = 0; i < 4; i++) await page.press('Tab');
      const focused = await page.evaluate(z.object({ last: z.boolean(), visible: z.boolean(), oneScroll: z.boolean(), noOverflow: z.boolean(), ancestorsStill: z.boolean(), anchored: z.boolean(), imageAbove: z.boolean() }), async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const active = document.activeElement, body = document.querySelector('.phone-tools'), sheet = document.querySelector('.phone-sheet');
        const box = active?.getBoundingClientRect(), bounds = body?.getBoundingClientRect();
        const stage = document.querySelector('[data-testid="stage"]')?.getBoundingClientRect();
        let ancestorsStill = true;
        for (let node = active?.parentElement; node !== null && node !== undefined; node = node.parentElement) if (node !== body) ancestorsStill &&= node.scrollTop === 0 && node.scrollLeft === 0;
        const header = document.querySelector('.phone-strip')?.getBoundingClientRect(), toolbar = document.querySelector('.phone-toolbar')?.getBoundingClientRect();
        return {
          last: active?.getAttribute('data-testid') === 'style-clipping',
          visible: box !== undefined && bounds !== undefined && box.top >= bounds.top && box.bottom <= bounds.bottom,
          oneScroll: body instanceof HTMLElement && body.scrollHeight > body.clientHeight &&
            Array.from(body.querySelectorAll('*')).every((node) => getComputedStyle(node).overflowY !== 'auto'),
          noOverflow: scrollX === 0 && scrollY === 0 && document.documentElement.scrollWidth === innerWidth && document.documentElement.scrollHeight === innerHeight,
          ancestorsStill,
          anchored: header?.top === 0 && header.bottom === 44 && toolbar !== undefined && Math.abs(toolbar.bottom - (innerHeight - 12)) < 1,
          imageAbove: stage !== undefined && sheet !== null && stage.bottom <= sheet.getBoundingClientRect().top + 1 && stage.height > 200,
        };
      });
      t.ok(`${size.width}: tab reaches the last control in one scrolling body, with the picture unobscured`, Object.values(focused).every(Boolean), focused);
      await page.screenshot(`inspector-last-${size.width}`);
      const before = await page.evaluate(z.string(), () => JSON.stringify({ doc: window.__noisyTest?.demo.document(), selected: window.__noisyTest?.demo.objects().filter((object) => object.selected) }));
      await page.click('.sheet-handle');
      await page.click('.sheet-handle');
      const after = await page.evaluate(z.string(), () => JSON.stringify({ doc: window.__noisyTest?.demo.document(), selected: window.__noisyTest?.demo.objects().filter((object) => object.selected) }));
      t.equal(`${size.width}: collapse and reopen retain control values and selection`, after, before);
      t.ok(`${size.width}: collapse and reopen retain disclosure choices`, await page.evaluate(z.boolean(), () => document.querySelector('[aria-controls="node-camera"]')?.getAttribute('aria-expanded') === 'true'));
      for (const name of ['Motion', 'Parallax', 'Symbols', 'Surface', 'Palette', 'Camera']) await click(`[aria-controls="node-${name.toLowerCase()}"]`);
      await page.evaluate(z.literal(true), async () => {
        document.querySelector('.phone-tools')?.scrollTo(0, 0);
        await new Promise((resolve) => setTimeout(resolve, 160));
        return true;
      });
      await page.screenshot(size.width === 402 ? 'inspector-phone-402' : 'inspector-ipad-834');
      await page.click('[data-testid="projects-toggle"]');
      t.ok(`${size.width}: the hidden expanded sheet does not reserve space for Projects`, await page.evaluate(z.boolean(), () => {
        const stage = document.querySelector('.phone-stage')?.getBoundingClientRect();
        return stage !== undefined && stage.height > innerHeight * .75 && document.querySelector('.phone-sheet')?.hasAttribute('hidden') === true;
      }));
      await page.click('[data-testid="projects-toggle"]');
    }
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.waitFor('desktop inspector', z.literal(true), () => document.querySelector('.inspector') === null ? null : true);
    const hierarchy = () => page.evaluate(z.object({ fryTop: z.number(), names: z.array(z.string()), separate: z.boolean(), secondaryClosed: z.boolean() }), () => ({
      fryTop: document.querySelector('.inspector [aria-label="Fry"]')?.getBoundingClientRect().top ?? -1,
      names: Array.from(document.querySelectorAll('.inspector .node'), (node) => node.getAttribute('aria-label') ?? ''),
      separate: document.querySelector('.scene-nodes .object-node') === null && document.querySelector('.object-scope .object-node') !== null,
      secondaryClosed: ['palette', 'camera'].every((name) => document.querySelector(`[aria-controls="node-${name}"]`)?.getAttribute('aria-expanded') === 'false'),
    }));
    const selected = await hierarchy();
    t.ok('desktop: selected-object controls have their own scope and Palette/Camera default closed', selected.separate && selected.secondaryClosed, selected);
    await click('.inspector .swatch[aria-label="Coral"]');
    await page.press('Escape');
    const deselected = await hierarchy();
    await click('.scene-sidebar .layer-row:last-child .layer-select');
    const reselected = await hierarchy();
    t.ok('desktop: Fry and the scene node order never move on recolor, deselection or reselection', selected.fryTop === deselected.fryTop && selected.fryTop === reselected.fryTop && selected.names.join(',') === reselected.names.join(','), { selected, deselected, reselected });
    await click('[aria-controls="node-palette"]');
    await click('[aria-controls="node-camera"]');
    await click('[data-testid="style-grain"]');
    for (let i = 0; i < 4; i++) await page.press('Tab');
    const lowerFocus = await page.evaluate(z.object({ id: z.string().nullable(), top: z.number(), bottom: z.number(), boundsTop: z.number(), boundsBottom: z.number(), scrollY: z.number(), ancestorsStill: z.boolean() }), async () => {
      // Native focus scrolling settles at the next rendering opportunity.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const active = document.activeElement?.getBoundingClientRect(), bounds = document.querySelector('.inspector .node-stack')?.getBoundingClientRect();
      let ancestorsStill = true;
      for (let node = document.activeElement?.parentElement; node !== null && node !== undefined; node = node.parentElement) if (!node.matches('.inspector .node-stack')) ancestorsStill &&= node.scrollTop === 0 && node.scrollLeft === 0;
      return { id: document.activeElement?.getAttribute('data-testid') ?? null, top: active?.top ?? -1, bottom: active?.bottom ?? -1, boundsTop: bounds?.top ?? -1, boundsBottom: bounds?.bottom ?? -1, scrollY, ancestorsStill };
    });
    t.ok('desktop: lower node keyboard focus scrolls inside the inspector without moving the page', lowerFocus.id === 'style-clipping' && lowerFocus.top >= lowerFocus.boundsTop && lowerFocus.bottom <= lowerFocus.boundsBottom && lowerFocus.scrollY === 0 && lowerFocus.ancestorsStill, lowerFocus);
    await page.press('Escape');
    await click('.scene-sidebar .layer-row:last-child .layer-select');
    t.ok('desktop: disclosure choices survive selection changes', await page.evaluate(z.boolean(), () => ['palette', 'camera'].every((name) => document.querySelector(`[aria-controls="node-${name}"]`)?.getAttribute('aria-expanded') === 'true')));
    await page.screenshot('inspector-desktop-1440');
    await click('[data-testid="motion-enabled"]');
    const selectionBefore = await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.objects().filter((object) => object.selected)));
    const focusSchema = z.object({ focused: z.boolean(), visible: z.boolean(), width: z.string(), color: z.string(), offset: z.string(), pressed: z.string().nullable() });
    const focusedControl = () => page.evaluate(focusSchema, () => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) throw new Error('No active control');
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return { focused: element.matches(':focus-visible'), visible: box.top >= 0 && box.bottom <= innerHeight,
        width: style.outlineWidth, color: style.outlineColor, offset: style.outlineOffset, pressed: element.getAttribute('aria-pressed') };
    });
    const tabTo = async (selector: string): Promise<void> => {
      for (let i = 0; i < 120; i++) {
        await page.press('Tab');
        if (await page.evaluate(z.boolean(), (selector) => document.activeElement?.matches(selector) === true, selector)) return;
      }
      throw new Error(`Tab did not reach ${selector}`);
    };
    const pinkFocus = async (label: string): Promise<void> => {
      const focus = await focusedControl();
      t.ok(`${label}: keyboard focus is a separate inset 2 px accent ring`, focus.focused && focus.visible && focus.width === '2px' && focus.color === 'rgb(255, 61, 127)' && focus.offset === '-2px', focus);
    };
    await page.click('[data-testid="projects-toggle"]');
    await page.click('[data-testid="projects-return"]');
    await tabTo('.scene-sidebar .layer-select[aria-pressed="true"]');
    await pinkFocus('selected object layer');
    t.equal('Tab focus never changes the selected layer', await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.objects().filter((object) => object.selected))), selectionBefore);
    await tabTo('[data-testid="style-fry"]');
    await pinkFocus('Fry range');
    await tabTo('.bottom-bar .mode-rail button:first-child');
    await pinkFocus('pressed Motion mode');
    t.equal('Motion retains its pressed state while focused', (await focusedControl()).pressed, 'true');
    await tabTo('[data-testid="projects-toggle"]');
    await page.press('Enter');
    await pinkFocus('active Projects toggle');
    t.equal('Projects retains its pressed state while focused', (await focusedControl()).pressed, 'true');
    await tabTo('.top-bar .primary-action');
    const downloadFocus = await focusedControl();
    t.ok('Download retains the contrasting text ring inset 4 px', downloadFocus.focused && downloadFocus.width === '2px' && downloadFocus.color === 'rgb(230, 230, 230)' && downloadFocus.offset === '-4px', downloadFocus);
    await page.click('[data-testid="projects-return"]');
    await tabTo('.inspector .swatch[aria-label="Coral"]');
    const swatchFocus = await focusedControl();
    t.ok('swatches retain the contrasting ground ring inset 5 px', swatchFocus.focused && swatchFocus.width === '2px' && swatchFocus.color === 'rgb(26, 26, 26)' && swatchFocus.offset === '-5px', swatchFocus);
    // Plate is a selected button itself, the original specificity regression.
    await page.click('.scene-sidebar .layer-row:first-child');
    const unfocused = await page.evaluate(z.string(), () => {
      const plate = document.querySelector('.scene-sidebar .layer-row:first-child');
      return plate === null ? '' : getComputedStyle(plate).outlineWidth;
    });
    await tabTo('.scene-sidebar button.layer-row.is-selected');
    await pinkFocus('selected Plate layer');
    t.equal('pointer selection stays 1 px', unfocused, '1px');
    await page.screenshot('focus-1440');
    await page.emulate({ width: 1440, height: 550, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    t.ok('short desktop height keeps the status and mode rail visible without page scrolling', await page.evaluate(z.boolean(), () => {
      const footer = document.querySelector('.bottom-bar')?.getBoundingClientRect();
      return footer !== undefined && footer.height === 44 && footer.bottom === innerHeight &&
        document.querySelectorAll('.bottom-bar .mode-rail button').length === 3 &&
        scrollY === 0 && document.documentElement.scrollHeight === innerHeight;
    }));
  },
}];
