import { z } from 'zod';
import type { Scenario, ScenarioContext } from '../scenario.ts';
import type {} from '../../../src/app/gallery-page.ts';

const PIECE = '/gallery/00000000-0000-4000-8000-000000000001';
const pixelsSchema = z.object({ hash: z.number(), range: z.number(), width: z.number(), height: z.number() });
const effectIdSchema = z.custom<import('../../../src/core/ids.ts').EffectId>((value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
function pixels() {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
  if (canvas === null) throw new Error('No gallery canvas.');
  const copy = new OffscreenCanvas(canvas.width, canvas.height), ctx = copy.getContext('2d');
  if (ctx === null) throw new Error('No pixel reader.');
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
  let hash = 2166136261, min = 255, max = 0;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue;
    const byte = data[i] ?? 0; min = Math.min(min, byte); max = Math.max(max, byte);
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return { hash, range: max - min, width: canvas.width, height: canvas.height };
}
async function ready(t: ScenarioContext): Promise<void> {
  await t.page.waitFor('gallery has drawn a live frame', z.literal(true), () => {
    const state = window.__noisyGallery?.viewer()?.status();
    if (state?.kind === 'failed') throw new Error(JSON.stringify(state));
    return state?.kind === 'running' ? true : null;
  }, { timeoutMs: 30_000 });
}
async function isolated(t: ScenarioContext): Promise<void> {
  t.equal('gallery requests no inference assets or workers', t.page.requests().filter((request) =>
    /\/models\/|\/vendor\/ort\/|(?:analysis|sequence|decode|face)-worker/.test(request.url)), []);
  t.equal('gallery opens no workers', t.page.workers(), []);
  t.equal('gallery never calls the camera API', await t.page.evaluate(z.number(), () => Number(document.body.dataset['cameraCalls'] ?? 0)), 0);
}
async function instrumentAndRemount(t: ScenarioContext): Promise<void> {
  await t.page.evaluate(z.literal(true), () => {
    document.body.dataset['cameraCalls'] = '0';
    if (navigator.mediaDevices !== undefined) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
      document.body.dataset['cameraCalls'] = String(Number(document.body.dataset['cameraCalls'] ?? 0) + 1);
      return Promise.reject(new Error('Gallery attempted camera access.'));
    } });
    if (window.__noisyGallery === undefined) throw new Error('Missing gallery test surface.');
    window.__noisyGallery.remount(); return true;
  });
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'gallery.viewer', title: 'Published fixture renders with Motion and no inference or camera', target: 'dev', covers: ['GAL1v-3'],
    async run(t) {
      await t.page.goto(`${t.baseUrl}${PIECE.slice(1)}?fixture=yes`);
      await ready(t); await instrumentAndRemount(t); await ready(t);
      const first = await t.page.evaluate(pixelsSchema, pixels);
      t.ok('real renderer produced a nonblank frame', first.range > 50 && first.width === 640 && first.height === 480, first);
      await t.page.screenshot('motion-first');
      const next = await t.page.waitFor('Motion advances visible pixels', pixelsSchema, () => {
        const stage = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
        if (stage === null) return null;
        // A temporal sample, independent from the renderer's internal frame counter.
        return new Promise((resolve) => setTimeout(() => {
          const copy = new OffscreenCanvas(stage.width, stage.height), ctx = copy.getContext('2d');
          if (ctx === null) { resolve(null); return; }
          ctx.drawImage(stage, 0, 0);
          const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
          let hash = 2166136261, min = 255, max = 0;
          for (let i = 0; i < data.length; i++) if (i % 4 !== 3) {
            const byte = data[i] ?? 0; hash = Math.imul(hash ^ byte, 16777619) >>> 0; min = Math.min(min, byte); max = Math.max(max, byte);
          }
          resolve({ hash, range: max - min, width: copy.width, height: copy.height });
        }, 180));
      });
      t.ok('two Motion frames differ', first.hash !== next.hash, { first, next });
      await t.page.screenshot('motion-second');
      t.equal('tilt button is shown only where permission is required', await t.page.evaluate(z.boolean(), () => {
        const viewer = window.__noisyGallery?.viewer(), button = document.querySelector<HTMLButtonElement>('[data-testid="gallery-tilt"]');
        return viewer !== null && viewer !== undefined && button !== null && button.hidden === !viewer.tiltNeedsPermission();
      }), true);
      await t.page.evaluate(z.literal(true), () => { window.__noisyGallery?.viewer()?.stop(); return true; });
      const stopped = await t.page.evaluate(pixelsSchema, pixels);
      await t.page.evaluate(z.literal(true), async () => { await new Promise((resolve) => setTimeout(resolve, 180)); return true; });
      t.equal('stop cancels rendering', await t.page.evaluate(pixelsSchema, pixels), stopped);
      await t.page.evaluate(z.literal(true), async () => { await window.__noisyGallery?.viewer()?.start(); return true; });
      await ready(t);
      await t.page.evaluate(z.literal(true), async () => { await new Promise((resolve) => setTimeout(resolve, 180)); return true; });
      const resumed = await t.page.evaluate(pixelsSchema, pixels);
      t.ok('resume advances visible Motion again', resumed.hash !== stopped.hash, { stopped, resumed });
      await t.page.screenshot('motion-resumed');
      await isolated(t);
      await t.page.evaluate(z.literal(true), async () => { const viewer = window.__noisyGallery?.viewer(); viewer?.dispose(); await viewer?.start(); return true; });
      t.equal('dispose is final', await t.page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.status().kind), 'disposed');
    },
  },
  {
    id: 'gallery.pointer', title: 'Pointer changes the live view; synthetic phone tilt follows gesture permission', target: 'dev', covers: ['GAL1v-3', 'GAL1v-4'],
    async run(t) {
      await t.page.goto(`${t.baseUrl}${PIECE.slice(1)}?fixture=yes&motion=off`);
      await ready(t); await instrumentAndRemount(t); await ready(t);
      const center = await t.page.evaluate(pixelsSchema, pixels);
      await t.page.evaluate(z.literal(true), async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
        if (canvas === null) throw new Error('No canvas.');
        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: rect.right - 2, clientY: rect.top + rect.height / 2 }));
        await new Promise((resolve) => setTimeout(resolve, 500)); return true;
      });
      const moved = await t.page.evaluate(pixelsSchema, pixels);
      t.ok('pointer changes pixels with Motion disabled', center.hash !== moved.hash, { center, moved });
      t.equal('pointer is the active input', await t.page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.input()), 'pointer');
      t.equal('live coverage permits Parallax', await t.page.evaluate(z.string().nullable(), () => {
        const state = window.__noisyGallery?.viewer()?.status(); return state?.kind === 'running' ? state.limitation : 'not running';
      }), null);
      await t.page.screenshot('pointer-right');
      await t.page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.evaluate(z.literal(true), () => {
        document.body.dataset['tiltPermissions'] = '0';
        Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: async () => {
          document.body.dataset['tiltPermissions'] = String(Number(document.body.dataset['tiltPermissions']) + 1); return 'granted';
        } });
        window.__noisyGallery?.remount(); return true;
      });
      await ready(t);
      t.equal('permission waits for the visitor', await t.page.evaluate(z.string(), () => document.body.dataset['tiltPermissions']), '0');
      t.equal('Tilt to look is visible where permission is needed', await t.page.evaluate(z.boolean(), () => document.querySelector<HTMLButtonElement>('[data-testid="gallery-tilt"]')?.hidden), false);
      await t.page.screenshot('phone-tilt-permission');
      await t.page.click('[data-testid="gallery-tilt"]');
      t.equal('one gesture requests permission once', await t.page.evaluate(z.string(), () => document.body.dataset['tiltPermissions']), '1');
      const neutral = await t.page.evaluate(pixelsSchema, pixels);
      await t.page.evaluate(z.literal(true), async () => {
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: null, beta: 20, gamma: 0 }));
        for (let i = 0; i < 15; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: null, beta: 20, gamma: 16 }));
        }
        return true;
      });
      t.equal('synthetic orientation selects tilt', await t.page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.input()), 'tilt');
      const tilted = await t.page.evaluate(pixelsSchema, pixels);
      t.ok('tilt changes the view with Motion disabled', neutral.hash !== tilted.hash, { neutral, tilted });
      await t.page.screenshot('phone-tilted');
      await isolated(t);
    },
  },
  {
    id: 'gallery.fallback', title: 'No WebGL2, missing assets and decode failures preserve the poster', target: 'dev', covers: ['GAL1v-3'],
    async run(t) {
      await t.page.goto(`${t.baseUrl}${PIECE.slice(1)}?fixture=yes`); await ready(t);
      await t.page.evaluate(z.literal(true), () => {
        const native = HTMLCanvasElement.prototype.getContext;
        Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: function(this: HTMLCanvasElement, name: string, ...args: unknown[]) {
          return name === 'webgl2' ? null : Reflect.apply(native, this, [name, ...args]);
        } });
        window.__noisyGallery?.remount(); return true;
      });
      await poster(t, 'no-webgl2');
      await t.page.screenshot('webgl-poster');
      await isolated(t);
      await t.page.goto(`${t.baseUrl}${PIECE.slice(1)}?fixture=yes&asset=missing`);
      await poster(t, 'missing-asset'); await t.page.screenshot('missing-asset-poster');
      await t.page.goto(`${t.baseUrl}${PIECE.slice(1)}?fixture=yes&source=broken`);
      await poster(t, 'decode-failure'); await t.page.screenshot('decode-poster');
      await isolated(t);
    },
  },
  {
    id: 'gallery.publish', title: 'Publish a committed snapshot, view its saved assets without inference, then unpublish',
    target: 'dev', covers: ['GAL1p-1', 'GAL1p-2', 'GAL1p-3', 'PUB2-1', 'PUB2-2', 'PUB2-3'], timeoutMs: 360_000,
    async run(t) {
      const { page } = t;
      await page.goto('/');
      await page.waitFor('gallery publish hook', z.literal(true), () => window.__noisyTest?.demo.gallery === undefined ? null : true);
      await page.evaluate(z.literal(true), async () => {
        const photo = await (await fetch('/assets-static/sample.jpg')).blob();
        await window.__noisyTest?.demo.importFile(new File([photo], 'gallery-sample.jpg', { type: 'image/jpeg' }));
        return true;
      });
      await page.waitFor('sample is ready to select', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 180_000 });
      await page.evaluate(z.literal(true), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No editor.');
        await demo.tap(.38, .585);
        demo.setMotion({ enabled: false });
        return true;
      });
      await page.waitFor('depth and masks enable Publish without Motion', z.literal(true), () => {
        return window.__noisyTest?.demo.gallery.canPublish().kind === 'ready' ? true : null;
      }, { timeoutMs: 180_000 });
      t.equal('ordinary editing leaves the plate absent with Motion off', await page.evaluate(z.boolean(), () => {
        const doc = window.__noisyTest?.demo.document();
        return doc != null && doc.objects.length > 0 && !doc.motion.enabled && doc.analysis.plate === null;
      }), true);
      const cancelled = await page.evaluate(z.object({ kind: z.string(), sentence: z.string(), phases: z.array(z.string()), pieces: z.number() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No editor.');
        const controller = new AbortController(), phases: string[] = [];
        const result = await demo.gallery.publish({ signal: controller.signal, onProgress(p) {
          phases.push(p.phase);
          if (p.phase === 'preparing') setTimeout(() => controller.abort(), 50);
        } });
        return { kind: result.kind, sentence: result.sentence, phases, pieces: demo.gallery.publishedHere().length };
      });
      t.equal('cancelling preparation publishes nothing', cancelled, {
        kind: 'failed', sentence: 'Publishing was cancelled.', phases: ['preparing'], pieces: 0,
      });
      await page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
      await page.click('[data-testid="tool-actions"]');
      await page.waitFor('Publish is enabled after cancellation', z.literal(true), () =>
        document.querySelector<HTMLButtonElement>('[data-testid="share-publish"]')?.disabled === false ? true : null);
      await page.click('[data-testid="share-publish"]');
      await page.waitFor('Publish confirmation opens', z.literal(true), () =>
        document.querySelector<HTMLDialogElement>('[data-testid="share-confirm"]')?.open ? true : null);
      await page.click('[data-testid="share-confirm"] .primary-action');
      await page.waitFor('Publish visibly prepares the background', z.literal(true), () =>
        document.querySelector('[data-testid="preparing"]')?.textContent?.includes('Preparing the background') ? true : null);
      await page.screenshot('publish-preparing-background');
      const preparedUrl = await page.waitFor('Publish completes without enabling Motion', z.string(), () =>
        document.querySelector<HTMLAnchorElement>('[data-testid="share-link"]')?.getAttribute('href'), { timeoutMs: 180_000 });
      t.equal('publication keeps authored Motion off and installs a saved plate', await page.evaluate(z.boolean(), () => {
        const doc = window.__noisyTest?.demo.document(); return doc != null && !doc.motion.enabled && doc.analysis.plate !== null;
      }), true);
      await page.screenshot('publish-prepared-background');
      await page.click('[data-testid="share-unpublish"]');
      await page.waitFor('Unpublish confirmation opens', z.literal(true), () =>
        document.querySelector<HTMLDialogElement>('[data-testid="share-confirm"]')?.open ? true : null);
      await page.click('[data-testid="share-confirm"] .primary-action');
      await page.waitFor('prepared publication is cleaned up', z.literal(true), () =>
        document.querySelector('[data-testid="share-link"]') === null ? true : null);
      t.expectMessage({ because: 'the scenario reads the just-unpublished prepared piece, whose manifest returns 404',
        channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api${preparedUrl}$`) });
      t.equal('cancelled and cleaned publications leave no public piece', await page.evaluate(z.number(), async (url) =>
        (await fetch(`/api${url}`)).status, preparedUrl), 404);
      const local = await page.evaluate(z.object({ id: effectIdSchema, mask: z.string(), objects: z.number() }), async () => {
        const demo = window.__noisyTest?.demo, doc = demo?.document();
        if (demo === undefined || doc == null) throw new Error('No editor for the manual local Recolor.');
        demo.setSelectionTool('rectangle');
        const { width, height } = doc.frame.master.size;
        const start = demo.beginSelection({ kind: 'shape', tool: 'rectangle', mode: 'replace', space: { kind: 'photo' }, pointerId: 93,
          at: { x: Math.floor(width * .07), y: Math.floor(height * .1) } });
        if (start.kind !== 'began') throw new Error(start.reason);
        const extend = demo.extendSelection({ kind: 'shape', token: start.token, pointerId: 93,
          at: { x: Math.floor(width * .65), y: Math.floor(height * .7) } });
        if (extend.kind === 'refused') throw new Error(extend.reason);
        const end = await demo.endSelection({ token: start.token, pointerId: 93 });
        if (end.kind === 'refused') throw new Error(end.reason);
        const applied = demo.localOperation({ target: { kind: 'selection' }, operation: { kind: 'recolor', color: { l: .7, c: .22, h: 305 } } });
        if (applied.kind !== 'applied') throw new Error('The manual local Recolor was not applied.');
        const effect = demo.document()?.localEffects.at(-1);
        if (effect === undefined || effect.scope.kind !== 'mask' || effect.operation.kind !== 'recolor') throw new Error('No frozen manual Recolor.');
        return { id: effect.id, mask: effect.scope.mask.plane.asset, objects: doc.objects.length };
      });
      t.ok('publication includes the manual selection local Recolor beside the protected foreground', local.objects > 0, local);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setStyle({ fry: .7 }); return true; });
      const captured = await page.evaluate(z.object({ document: z.string(), hash: z.string(), longEdge: z.number() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No editor.');
        const bitmap = await createImageBitmap(await demo.downloadPng());
        const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        const context = canvas.getContext('2d', { alpha: false });
        if (context === null) throw new Error('No poster canvas.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: .85 });
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await jpeg.arrayBuffer()))].map((n) => n.toString(16).padStart(2, '0')).join('');
        return { document: JSON.stringify(demo.document()), hash, longEdge: Math.max(canvas.width, canvas.height) };
      });
      const preview = await page.evaluate(z.object({ refused: z.boolean(), unchanged: z.boolean(), reason: z.string() }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No editor.');
        const before = JSON.stringify(demo.document()), gallery = demo.gallery;
        const token = gallery.beginGesture({ operation: 'fry', target: { kind: 'scene' } });
        if (token === null) throw new Error('Gesture refused.');
        gallery.updateGesture({ token, value: { kind: 'fry', fry: .95 } });
        try {
          const readiness = gallery.canPublish(), result = await gallery.publish();
          return { refused: result.kind === 'failed', unchanged: before === JSON.stringify(demo.document()), reason: readiness.kind === 'unavailable' ? readiness.reason : 'ready' };
        } finally { gallery.cancelGesture(token); }
      });
      t.equal('gesture preview is refused and never committed', preview, { refused: true, unchanged: true, reason: 'gesture' });
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.session?.renderer()?.setCompare('source-photo'); return true; });
      await page.screenshot('editor-comparison');
      const result = await page.evaluate(z.object({ id: z.string(), url: z.string(), device: z.string(), phases: z.array(z.string()) }), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No editor.');
        const phases: string[] = [];
        const result = await demo.gallery.publish({ onProgress(p) {
          phases.push(p.phase);
          // An edit during upload must not change either the captured document or poster.
          if (p.phase === 'snapshot') demo.setStyle({ fry: .2 });
        } });
        if (result.kind === 'failed') throw new Error(result.sentence);
        return { id: result.id, url: result.url, device: result.device, phases };
      });
      t.equal('device key was persisted', result.device, 'persistent');
      try {
        const saved = await page.evaluate(z.object({ document: z.string(), hash: z.string(), listed: z.boolean(), longEdge: z.number(), jpeg: z.boolean() }), async (id) => {
          const manifest: unknown = await (await fetch(`/api/gallery/${id}`)).json();
          if (manifest === null || typeof manifest !== 'object' || !('document' in manifest)) throw new Error('Missing manifest.');
          const listing: unknown = await (await fetch('/api/gallery')).json();
          if (listing === null || typeof listing !== 'object' || !('pieces' in listing) || !Array.isArray(listing.pieces)) throw new Error('Missing list.');
          const poster = await (await fetch(`/api/gallery/${id}/poster`)).blob(), bitmap = await createImageBitmap(poster);
          const longEdge = Math.max(bitmap.width, bitmap.height); bitmap.close();
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await poster.arrayBuffer()))].map((n) => n.toString(16).padStart(2, '0')).join('');
          return { document: JSON.stringify(manifest.document), hash, longEdge, jpeg: poster.type === 'image/jpeg',
            listed: listing.pieces.some((piece: unknown) => piece !== null && typeof piece === 'object' && 'id' in piece && piece.id === id) };
        }, result.id);
        const savedDocument: unknown = JSON.parse(saved.document), capturedDocument: unknown = JSON.parse(captured.document);
        t.equal('published document is the committed snapshot before the upload-time edit', savedDocument, capturedDocument);
        t.equal('comparison never reaches the committed poster', saved.hash, captured.hash);
        t.ok('poster is a bounded JPEG and piece is public in the list', saved.listed && saved.jpeg && saved.longEdge <= 1280, saved);
        const requestStart = page.requests().length;
        await page.goto(result.url); await ready(t);
        const frame = await page.evaluate(pixelsSchema, pixels);
        t.ok('real published assets draw a nonblank frame', frame.range > 50 && frame.width > 0 && frame.height > 0, frame);
        const localPixels = await page.evaluate(z.object({ inside: z.number(), changed: z.number(), outside: z.number(), protected: z.number(), maxOutside: z.number() }), (id) => {
          const viewer = window.__noisyGallery?.viewer(), debug = viewer?.debug(), canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
          if (canvas === null || debug?.readLocalEffectPatch === undefined || debug.readLocalCoveragePatch === undefined) throw new Error('No published local-effect pixel probe.');
          viewer?.stop();
          const pixels = debug.readLocalEffectPatch(0, 0, canvas.width, canvas.height), coverage = debug.readLocalCoveragePatch(id, 0, 0, canvas.width, canvas.height);
          let inside = 0, changed = 0, outside = 0, protectedPixels = 0, maxOutside = 0;
          for (let i = 0; i < pixels.after.length; i += 4) {
            const difference = Math.max(...[0, 1, 2].map((channel) => Math.abs((pixels.after[i + channel] ?? 0) - (pixels.before[i + channel] ?? 0))));
            if ((coverage[i] ?? 0) > 0) { inside++; if (difference > 0) changed++; }
            else { outside++; maxOutside = Math.max(maxOutside, difference); if ((pixels.owners[i] ?? 0) > 0) protectedPixels++; }
          }
          return { inside, changed, outside, protected: protectedPixels, maxOutside };
        }, local.id);
        t.ok('piece page evaluates the saved manual Recolor and leaves all outside/protected pixels unchanged',
          localPixels.inside > 100 && localPixels.changed > 100 && localPixels.outside > 100 && localPixels.protected > 100 && localPixels.maxOutside === 0, localPixels);
        await t.file('published-local-recolor.json', JSON.stringify({ local, localPixels, id: result.id, capturedDocument }, null, 2));
        await page.screenshot('published-manual-recolor');
        await page.evaluate(z.literal(true), async () => { await window.__noisyGallery?.viewer()?.start(); return true; });
        await page.screenshot('published-live');
        const pieceRequests = page.requests().slice(requestStart);
        t.equal('published page loads no models or ORT', pieceRequests.filter((r) => /\/models\/|\/vendor\/ort\//.test(r.url)), []);
        t.equal('published page opens no workers', page.workers(), []);
        t.ok('published page fetched its saved assets', pieceRequests.some((r) => r.url.includes(`/api/gallery/${result.id}/assets/`)));
        t.equal('piece page has no editor session', await page.evaluate(z.boolean(), () => window.__noisyTest === undefined), true);
        t.equal('piece page retains the device key', await page.evaluate(z.boolean(), (id) => window.__noisyGallery?.publishedHere().includes(id) ?? false, result.id), true);
        const listed = await page.evaluate(z.object({ id: z.string(), publishedAt: z.string(), posterUrl: z.string(), width: z.number(), height: z.number() }), async (id) => {
          const result = await window.__noisyGallery?.list(new AbortController().signal);
          if (result?.kind !== 'listed') throw new Error(result?.sentence ?? 'No gallery API.');
          return result.pieces.find((piece) => piece.id === id);
        }, result.id);
        t.equal('gallery UI adapter exposes the public poster URL', listed.posterUrl, `/api/gallery/${result.id}/poster`);
        t.ok('gallery UI adapter exposes the poster dimensions and publication time', listed.width <= 1280 && listed.height <= 1280 && Number.isFinite(Date.parse(listed.publishedAt)), listed);
        t.equal('gallery page unpublishes without an editor', await page.evaluate(z.object({ kind: z.literal('unpublished') }), async (id) => window.__noisyGallery?.unpublish(id), result.id), { kind: 'unpublished' });
        t.equal('unpublished piece is absent from the list', await page.evaluate(z.boolean(), async (id) => {
          const body: unknown = await (await fetch('/api/gallery')).json();
          if (body === null || typeof body !== 'object' || !('pieces' in body) || !Array.isArray(body.pieces)) throw new Error('Bad list.');
          return body.pieces.some((piece: unknown) => piece !== null && typeof piece === 'object' && 'id' in piece && piece.id === id);
        }, result.id), false);
        t.expectMessage({ because: 'the unpublished manifest returns 404', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/gallery/${result.id}$`) });
        await page.goto(result.url);
        await page.waitFor('unpublished URL shows unavailable state', z.literal(true), () =>
          document.querySelector('[data-testid="gallery-status"]')?.textContent === 'This piece is not available.' ? true : null);
        t.equal('unpublished URL never creates a live viewer', await page.evaluate(z.boolean(), () => window.__noisyGallery?.viewer() === null), true);
        await page.screenshot('unpublished-unavailable');
      } finally {
        await page.goto('/gallery');
        await page.waitFor('gallery cleanup API', z.literal(true), () => window.__noisyGallery === undefined ? null : true);
        await page.evaluate(z.literal(true), async (id) => {
          const gallery = window.__noisyGallery;
          if (gallery?.publishedHere().includes(id)) {
            const result = await gallery.unpublish(id);
            if (result.kind !== 'unpublished') throw new Error(result.sentence);
          }
          return true;
        }, result.id);
      }
    },
  },
  {
    id: 'gallery.publish-zero', title: 'A zero-object piece uses depth without a plate for playback, pointer and tilt',
    target: 'dev', covers: ['GAL1p-5', 'GAL1p-6', 'GAL1p-8', 'GAL1p-9'], timeoutMs: 360_000,
    async run(t) {
      const { page } = t;
      await page.goto('/');
      await page.waitFor('zero-object publishing hook', z.literal(true), () => window.__noisyTest?.demo.gallery === undefined ? null : true);
      await page.evaluate(z.literal(true), async () => {
        const photo = await (await fetch('/assets-static/sample.jpg')).blob();
        await window.__noisyTest?.demo.importFile(new File([photo], 'gallery-zero.jpg', { type: 'image/jpeg' }));
        return true;
      });
      await page.waitFor('depth alone makes the zero-object photo publishable', z.literal(true), () => {
        const demo = window.__noisyTest?.demo, doc = demo?.document();
        if (doc === null || doc === undefined) return null;
        if (doc.objects.length !== 0 || doc.analysis.plate !== null) throw new Error('Zero-object photo unexpectedly has subject products.');
        return demo?.gallery.canPublish().kind === 'ready' ? true : null;
      }, { timeoutMs: 180_000 });
      const pieces: { id: string; url: string }[] = [];
      try {
        // Playback and spatial inputs are tested separately so temporal grain cannot
        // masquerade as a pointer or tilt change.
        for (const motion of [true, false]) {
          const result = await page.evaluate(z.object({ id: z.string(), url: z.string() }), async (enabled) => {
            const demo = window.__noisyTest?.demo;
            if (demo === undefined) throw new Error('No editor.');
            demo.setStyle({ fry: .4, grain: enabled ? .4 : 0 }); demo.setMotion({ enabled });
            const result = await demo.gallery.publish();
            if (result.kind === 'failed') throw new Error(result.sentence);
            const manifest: unknown = await (await fetch(`/api/gallery/${result.id}`)).json();
            if (manifest === null || typeof manifest !== 'object' || !('assets' in manifest) || !Array.isArray(manifest.assets)) throw new Error('No saved assets.');
            const kinds = manifest.assets.map((asset: unknown) => asset !== null && typeof asset === 'object' && 'kind' in asset ? asset.kind : null);
            if (JSON.stringify(kinds) !== JSON.stringify(['source', 'png', 'raster'])) throw new Error(`Unexpected zero-object v5 assets: ${JSON.stringify(kinds)}`);
            return { id: result.id, url: result.url };
          }, motion);
          pieces.push(result);
        }
        const playing = pieces[0], spatial = pieces[1];
        if (playing === undefined || spatial === undefined) throw new Error('Missing published zero-object pieces.');
        const requestStart = page.requests().length;
        await page.goto(playing.url); await ready(t);
        const first = await page.evaluate(pixelsSchema, pixels);
        t.ok('depth-only Motion piece draws a nonblank frame', first.range > 50, first);
        await page.screenshot('zero-motion-first');
        await page.evaluate(z.literal(true), async () => { await new Promise((resolve) => setTimeout(resolve, 250)); return true; });
        const next = await page.evaluate(pixelsSchema, pixels);
        t.ok('depth-only Motion clock advances temporal grain', first.hash !== next.hash, { first, next });
        await page.screenshot('zero-motion-second');
        await page.goto(spatial.url); await ready(t);
        // Grain is zero and Motion is disabled, so a stationary view must stay fixed.
        const center = await page.evaluate(pixelsSchema, pixels);
        await page.evaluate(z.literal(true), async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return true; });
        t.equal('depth-only stationary view is stable before pointer input', await page.evaluate(pixelsSchema, pixels), center);
        await page.evaluate(z.literal(true), async () => {
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
          if (canvas === null) throw new Error('No canvas.');
          const rect = canvas.getBoundingClientRect();
          canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: rect.right - 2, clientY: rect.top + rect.height / 2 }));
          await new Promise((resolve) => setTimeout(resolve, 500)); return true;
        });
        const moved = await page.evaluate(pixelsSchema, pixels);
        t.ok('depth alone renders pointer Parallax', center.hash !== moved.hash && moved.range > 50, { center, moved });
        t.equal('zero-object pointer is active', await page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.input()), 'pointer');
        const limitation = await page.evaluate(z.string().nullable(), () => {
          const state = window.__noisyGallery?.viewer()?.status(); return state?.kind === 'running' ? state.limitation : 'not running';
        });
        t.ok('zero-object view renders without a plate limitation', limitation === null || limitation === 'Travel reduced to preserve depth edges', { limitation });
        await page.screenshot('zero-pointer');
        await page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
        await page.evaluate(z.literal(true), () => {
          Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: async () => 'granted' });
          window.__noisyGallery?.remount(); return true;
        });
        await ready(t); await page.click('[data-testid="gallery-tilt"]');
        const neutral = await page.evaluate(pixelsSchema, pixels);
        await page.evaluate(z.literal(true), async () => {
          window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: null, beta: 20, gamma: 0 }));
          for (let i = 0; i < 15; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: null, beta: 20, gamma: 16 }));
          }
          return true;
        });
        const tilted = await page.evaluate(pixelsSchema, pixels);
        t.ok('depth alone renders tilt Parallax', neutral.hash !== tilted.hash && tilted.range > 50, { neutral, tilted });
        t.equal('zero-object tilt is active', await page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.input()), 'tilt');
        await page.screenshot('zero-tilt');
        t.equal('zero-object piece pages request no models or ORT', page.requests().slice(requestStart).filter((r) => /\/models\/|\/vendor\/ort\//.test(r.url)), []);
        t.equal('zero-object piece pages open no workers', page.workers(), []);
        t.equal('gallery page has no editor session', await page.evaluate(z.boolean(), () => window.__noisyTest === undefined), true);
      } finally {
        await page.goto('/gallery');
        await page.waitFor('zero-object cleanup API', z.literal(true), () => window.__noisyGallery === undefined ? null : true);
        for (const piece of pieces) {
          await page.evaluate(z.literal(true), async (id) => {
            const gallery = window.__noisyGallery;
            if (gallery?.publishedHere().includes(id)) {
              const result = await gallery.unpublish(id);
              if (result.kind === 'failed') throw new Error(result.sentence);
            }
            return true;
          }, piece.id);
        }
      }
    },
  },
];

async function poster(t: ScenarioContext, kind: string): Promise<void> {
  await t.page.waitFor('poster fallback is decoded and visible', z.literal(true), () => {
    const image = document.querySelector<HTMLImageElement>('[data-testid="gallery-poster"]');
    return image !== null && !image.hidden && image.complete && image.naturalWidth > 0 && document.querySelector('[data-testid="gallery"]')?.getAttribute('data-state') === 'poster' ? true : null;
  });
  t.equal(`typed ${kind} failure`, await t.page.evaluate(z.string(), () => {
    const state = window.__noisyGallery?.viewer()?.status(); return state?.kind === 'failed' ? state.failure.kind : 'no failure';
  }), kind);
  t.equal('failed canvas is hidden', await t.page.evaluate(z.boolean(), () => document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]')?.hidden), true);
}
