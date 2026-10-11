import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BrowserPage, Scenario, ScenarioContext } from '../scenario.ts';
import { DEFAULT_CHROME, launchChrome } from '../driver/chrome.ts';
import { createCleanup } from '../driver/processes.ts';
import type {} from '../../../src/app/gallery-page.ts';

const sizes = [{ width: 390, height: 844 }, { width: 1180, height: 820 }, { width: 1440, height: 900 }];
const pieceSizes = [
  { width: 1180, height: 820 }, { width: 820, height: 1180 },
  { width: 1180, height: 740 }, { width: 820, height: 1100 }, { width: 390, height: 844 },
];
async function pieceScreen(t: ScenarioContext, name: 'piece-running' | 'piece-fallback', aspect: number): Promise<void> {
  const { page } = t;
  const rect = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number(), width: z.number(), height: z.number() });
  for (const size of pieceSizes) {
    const label = `${name}-${size.width}-${size.height}`;
    await page.emulate({ ...size, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
    await page.evaluate(z.literal(true), async () => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
      dispatchEvent(new Event('resize'));
      await document.fonts.ready;
      await document.querySelector<HTMLImageElement>('[data-testid="gallery-poster"]')?.decode();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return true;
    });
    const layout = await page.evaluate(z.object({
      stage: rect, picture: rect, media: rect, top: rect, controls: rect, notice: rect,
      rowEdges: z.array(z.number()), scrollWidth: z.number(), scrollHeight: z.number(),
      width: z.number(), height: z.number(), locked: z.boolean(), inFlow: z.boolean(),
      framed: z.boolean(), stagePadding: z.number(), posterAspect: z.number(),
    }), () => {
      const element = (selector: string): HTMLElement => {
        const node = document.querySelector<HTMLElement>(selector);
        if (node === null) throw new Error(`Missing ${selector}`);
        return node;
      };
      const bounds = (node: HTMLElement) => {
        const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
        return { left, top, right, bottom, width, height };
      };
      const piece = element('.gallery-piece'), stage = element('.gallery-piece-stage'), picture = element('.gallery-picture');
      const top = element('.gallery-piece-top'), controls = element('.gallery-piece-controls');
      const poster = document.querySelector<HTMLImageElement>('[data-testid="gallery-poster"]');
      const scroll = document.scrollingElement;
      if (poster === null || scroll === null) throw new Error('Missing poster or scrolling element');
      const style = getComputedStyle(piece), frame = getComputedStyle(picture);
      const rowEdges = [piece.getBoundingClientRect().top + parseFloat(style.paddingTop)];
      for (const row of style.gridTemplateRows.split(' ')) rowEdges.push((rowEdges.at(-1) ?? 0) + parseFloat(row));
      return {
        stage: bounds(stage), picture: bounds(picture), top: bounds(top), controls: bounds(controls),
        notice: bounds(element('[data-testid="gallery-status"]')),
        media: bounds(poster.hidden ? element('[data-testid="gallery-canvas"]') : poster), rowEdges,
        scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight, width: innerWidth, height: innerHeight,
        locked: [document.documentElement, document.body].every((node) => {
          const css = getComputedStyle(node);
          return css.overflow === 'hidden' && css.overscrollBehavior === 'none';
        }),
        inFlow: style.display === 'grid' && [top, controls].every((node) => getComputedStyle(node).position === 'static'),
        framed: frame.borderTopWidth === '1px' && frame.borderTopColor === 'rgb(58, 58, 58)' && frame.borderRadius === '8px' && frame.overflow === 'hidden',
        stagePadding: parseFloat(getComputedStyle(stage).paddingTop), posterAspect: poster.naturalWidth / poster.naturalHeight,
      };
    });
    const { stage, picture, media, top, controls, rowEdges } = layout;
    t.ok(`${label}: document fits the viewport and disables bounce`, layout.scrollHeight <= layout.height && layout.scrollWidth <= layout.width && layout.locked, layout);
    t.ok(`${label}: picture is centered in the stage within 1 px`, Math.abs(picture.left + picture.width / 2 - stage.left - stage.width / 2) <= 1 && Math.abs(picture.top + picture.height / 2 - stage.top - stage.height / 2) <= 1, layout);
    t.ok(`${label}: frame and media preserve the published aspect within 1 percent`, Math.abs(picture.width / picture.height / aspect - 1) <= .01 && Math.abs(media.width / media.height / aspect - 1) <= .01 && Math.abs(layout.posterAspect / aspect - 1) <= .01, layout);
    t.ok(`${label}: media fills the clipped hairline frame`, layout.framed && Math.abs(media.width - (picture.width - 2)) < .1 && Math.abs(media.height - (picture.height - 2)) < .1 && Math.abs(media.left - picture.left - 1) < .1 && Math.abs(media.top - picture.top - 1) < .1, layout);
    const [start, first, second, end] = rowEdges;
    t.ok(`${label}: top line and controls occupy rows 1 and 3 without picture overlap`, layout.inFlow && rowEdges.length === 4 && start !== undefined && first !== undefined && second !== undefined && end !== undefined && top.top >= start - .1 && top.bottom <= first + .1 && controls.top >= second - .1 && controls.bottom <= end + .1 && top.bottom <= picture.top && picture.bottom <= controls.top && controls.bottom <= layout.height, layout);
    t.ok(`${label}: picture stays inside the padded stage`, layout.stagePadding === (size.width >= 744 ? 24 : 16) && picture.left >= stage.left + layout.stagePadding - .1 && picture.right <= stage.right - layout.stagePadding + .1 && picture.top >= stage.top + layout.stagePadding - .1 && picture.bottom <= stage.bottom - layout.stagePadding + .1, layout);
    if (name === 'piece-fallback') t.ok(`${label}: status overlays the stage top inside row 2`, Math.abs(layout.notice.top - stage.top) < .1 && layout.notice.bottom <= stage.bottom, layout);
    await page.screenshot(label);
  }
}
async function captures(t: ScenarioContext, name: string): Promise<void> {
  const { page } = t;
  for (const size of sizes) {
    await page.emulate({ ...size, deviceScaleFactor: 1, mobile: size.width === 390, colorScheme: 'dark' });
    await page.evaluate(z.literal(true), async (touch) => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touch ? 5 : 0 });
      dispatchEvent(new Event('resize'));
      await document.fonts.ready;
      await Promise.all([...document.images].filter((image) => image.getBoundingClientRect().top < innerHeight)
        .map((image) => image.decode().catch(() => {})));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return true;
    }, size.width === 390);
    if (name === 'grid-with-pieces') {
      t.equal(`${size.width}: grid hint matches the input device`, await page.evaluate(z.string(), () => {
        const hint = document.querySelector<HTMLElement>('.gallery-hint');
        return hint?.innerText ?? '';
      }), size.width === 390 ? 'Tap a piece to step into it. Tilt your phone to look around.' : 'Click a piece to step into it.');
      t.ok(`${size.width}: grid hint is centered 11 px secondary text after the grid`, await page.evaluate(z.boolean(), () => {
        const hint = document.querySelector('.gallery-hint');
        if (hint === null) return false;
        const style = getComputedStyle(hint);
        return hint.previousElementSibling?.matches('.gallery-grid') === true && style.fontSize === '11px' && style.textAlign === 'center' && style.color === 'rgb(163, 163, 163)';
      }));
    } else if (name === 'grid-empty') {
      t.equal(`${size.width}: empty gallery has no piece hint`, await page.evaluate(z.boolean(), () => document.querySelector('.gallery-hint') === null), true);
    } else if (name === 'piece-running') {
      t.ok(`${size.width}: quiet piece controls have a hairline`, await page.evaluate(z.boolean(), () => {
        const controls = [...document.querySelectorAll('.gallery-piece-controls button:not(.primary-action)')];
        return controls.length > 0 && controls.every((node) => {
          const style = getComputedStyle(node);
          return style.borderTopWidth === '1px' && style.borderTopStyle === 'solid' && style.borderTopColor === 'rgb(58, 58, 58)';
        });
      }));
      t.ok(`${size.width}: piece timestamp aligns with its 44 px neighbors`, await page.evaluate(z.boolean(), () => {
        const time = document.querySelector('.gallery-piece-top time'), back = document.querySelector('[data-testid="gallery-back"]');
        if (time === null || back === null) return false;
        const box = time.getBoundingClientRect(), neighbor = back.getBoundingClientRect();
        return box.height === 44 && Math.abs(box.top - neighbor.top) < .5 && getComputedStyle(time).alignItems === 'center';
      }));
    } else if (name === 'piece-fallback') {
      t.equal(`${size.width}: piece status uses the floating radius`, await page.evaluate(z.string(), () => {
        const status = document.querySelector('.gallery-piece-status');
        return status === null ? '' : getComputedStyle(status).borderRadius;
      }), '12px');
    }
    await page.screenshot(`${name}-${size.width}`);
  }
}
async function running(page: BrowserPage): Promise<void> {
  await page.waitFor('live published piece', z.literal(true), () => window.__noisyGallery?.viewer()?.status().kind === 'running' ? true : null);
}
async function canvasHash(page: BrowserPage): Promise<number> {
  return page.evaluate(z.number(), () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
    if (canvas === null) throw new Error('No live canvas');
    const copy = new OffscreenCanvas(canvas.width, canvas.height), context = copy.getContext('2d');
    if (context === null) throw new Error('No pixel reader');
    context.drawImage(canvas, 0, 0);
    let hash = 2166136261;
    for (const byte of context.getImageData(0, 0, copy.width, copy.height).data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
  });
}
async function actions(page: BrowserPage): Promise<void> {
  // Full tier today; the compact Actions host is being delivered in parallel.
  await page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await page.click('[data-testid="tool-actions"]');
}
async function noInference(t: ScenarioContext, start: number): Promise<void> {
  const requests = t.page.requests().slice(start);
  t.equal('gallery fetches no models, ORT or inference workers', requests.filter((request) => /\/models\/|\/vendor\/ort\/|(?:analysis|sequence|decode|face)-worker/.test(request.url)), []);
  t.equal('gallery has no workers', t.page.workers(), []);
}

export const scenarios: readonly Scenario[] = [{
  id: 'gallery-ui', title: 'Publish, browse, view and unpublish through the designed gallery', target: 'dev', covers: ['GAL1u-2', 'GAL1u-4', 'GAL1u-6'], timeoutMs: 360_000,
  async run(t) {
    const { page } = t;
    await page.goto('/'); await actions(page);
    t.equal('Publish explains missing photo', await page.evaluate(z.boolean(), () => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="share-publish"]');
      return button?.disabled === true && !!document.getElementById('share-availability')?.textContent;
    }), true);
    await page.click('[data-testid="try-sample"]');
    await page.waitFor('sample ready to publish', z.literal(true), () => window.__noisyTest?.demo.gallery.canPublish().kind === 'ready' ? true : null, { timeoutMs: 180_000 });
    const pieceAspect = await page.evaluate(z.number(), () => {
      const size = window.__noisyTest?.demo.document()?.frame.master.size;
      if (size === undefined) throw new Error('No master size');
      return size.width / size.height;
    });
    // Freeze temporal effects so a later pixel change can only come from pointer input.
    await page.evaluate(z.literal(true), () => {
      window.__noisyTest?.demo.setMotion({ enabled: false }); window.__noisyTest?.demo.setStyle({ grain: 0 }); return true;
    });
    await page.click('[data-testid="share-publish"]');
    await page.waitFor('one-line confirmation opens', z.literal(true), () => document.querySelector<HTMLDialogElement>('[data-testid="share-confirm"]')?.open ? true : null);
    t.equal('confirmation states public visibility', await page.evaluate(z.string(), () => document.querySelector('[data-testid="share-confirm"] p')?.textContent), 'Anyone can see this at nathan.fish/gallery.');
    await page.screenshot('editor-confirmation-1180');
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.screenshot('editor-confirmation-1440');
    await page.press('Escape');
    t.equal('cancel restores Publish focus', await page.evaluate(z.string(), () => document.activeElement?.getAttribute('data-testid')), 'share-publish');
    await page.click('[data-testid="share-publish"]');
    await page.click('[data-testid="share-confirm"] .primary-action');
    const href = await page.waitFor('published link appears', z.string(), () => document.querySelector<HTMLAnchorElement>('[data-testid="share-link"]')?.getAttribute('href'));
    const id = href.split('/').at(-1);
    if (id === undefined) throw new Error('No published id');
    const seeded: string[] = [];
    try {
      await page.screenshot('editor-published-1440');
      await page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
      await page.screenshot('editor-published-1180');
      // The phone hosts the same Share group in its Actions tab.
      await page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('phone sheet', z.literal(true), () => document.querySelector('.phone-sheet') !== null ? true : null);
      await page.click('[data-testid="tool-actions"]');
      await page.waitFor('phone Share reachable', z.literal(true), () => {
        const share = document.querySelector<HTMLElement>('.phone-sheet #panel-actions [data-testid="share-publish"], .phone-sheet #panel-actions [data-testid="share-link"]');
        if (share === null) return null;
        share.scrollIntoView({ block: 'center' });
        const box = share.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.bottom <= innerHeight ? true : null;
      });
      t.ok('the phone Actions tab hosts the Share group', await page.evaluate(z.boolean(), () => {
        const group = document.querySelector('.phone-sheet #panel-actions .share-group');
        const opener = document.querySelector('[data-testid="tool-actions"]');
        return group !== null && group.getBoundingClientRect().height > 0 && opener?.getAttribute('aria-expanded') === 'true';
      }));
      await page.screenshot('editor-share-390');
      await page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
      // Real publications with varied source ratios make the masonry capture meaningful.
      for (const [width, height] of [[480, 640], [640, 480], [480, 640], [640, 480], [480, 640]]) {
        if (width === undefined || height === undefined) throw new Error('Missing fixture size');
        await page.evaluate(z.literal(true), async (w, h) => {
          const image = await createImageBitmap(await (await fetch('/assets-static/sample.jpg')).blob());
          const canvas = new OffscreenCanvas(w, h), context = canvas.getContext('2d');
          if (context === null) throw new Error('No fixture canvas');
          const scale = Math.max(w / image.width, h / image.height);
          context.drawImage(image, (w - image.width * scale) / 2, (h - image.height * scale) / 2, image.width * scale, image.height * scale);
          image.close();
          const photo = await canvas.convertToBlob({ type: 'image/jpeg' });
          await window.__noisyTest?.demo.importFile(new File([photo], 'gallery-grid.jpg', { type: 'image/jpeg' }));
          return true;
        }, width, height);
        await page.waitFor('grid fixture ready', z.literal(true), () => window.__noisyTest?.demo.gallery.canPublish().kind === 'ready' ? true : null, { timeoutMs: 60_000 });
        seeded.push(await page.evaluate(z.string(), async (index) => {
          const demo = window.__noisyTest?.demo;
          if (demo === undefined) throw new Error('No editor');
          demo.setStyle({ fry: .2 + index * .14 });
          const result = await demo.gallery.publish();
          if (result.kind !== 'published') throw new Error(result.sentence);
          return result.id;
        }, seeded.length));
      }
      const requestStart = page.requests().length;
      await page.click('.share-gallery-link');
      await page.waitFor('published piece in the grid', z.literal(true), () => document.querySelector('[data-testid="gallery-piece-link"]') ? true : null);
      t.ok('grid contains the published piece', await page.evaluate(z.boolean(), (url) => [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="gallery-piece-link"]')].some((link) => link.getAttribute('href') === url), href));
      t.equal('posters are lazy and have time alt text', await page.evaluate(z.boolean(), () => [...document.querySelectorAll<HTMLImageElement>('[data-testid="gallery-grid"] img')].every((image) => image.loading === 'lazy' && image.alt.startsWith('Published piece, '))), true);
      await captures(t, 'grid-with-pieces');
      await page.click(`[data-testid="gallery-piece-link"][href="${href}"]`); await running(page);
      const center = await canvasHash(page);
      await page.evaluate(z.literal(true), async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="gallery-canvas"]');
        if (canvas === null) throw new Error('No live canvas');
        const box = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: box.right - 2, clientY: box.top + box.height / 2 }));
        await new Promise((resolve) => setTimeout(resolve, 500)); return true;
      });
      t.ok('desktop pointer changes the rendered view', center !== await canvasHash(page));
      await captures(t, 'piece-running');
      await pieceScreen(t, 'piece-running', pieceAspect);
      await page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.evaluate(z.literal(true), () => {
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
        document.body.dataset['tiltRequests'] = '0';
        Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: async () => {
          document.body.dataset['tiltRequests'] = String(Number(document.body.dataset['tiltRequests']) + 1); return 'denied';
        } });
        window.__noisyGallery?.remount(); return true;
      });
      await running(page);
      t.equal('tilt permission waits for a gesture', await page.evaluate(z.string(), () => document.body.dataset['tiltRequests']), '0');
      await page.click('[data-testid="gallery-tilt"]');
      await page.waitFor('denied tilt remains explicit', z.literal(true), () => document.querySelector('[data-testid="gallery-tilt"]')?.textContent === 'Tilt is off on this device' ? true : null);
      t.equal('one gesture asks once', await page.evaluate(z.string(), () => document.body.dataset['tiltRequests']), '1');
      t.equal('denied tilt leaves viewer running', await page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.status().kind), 'running');
      // This is a separate Chrome profile, with none of the publisher's storage.
      const cleanup = createCleanup(), visitorDir = join(t.dir, 'visitor');
      await mkdir(visitorDir, { recursive: true });
      try {
        const browser = await launchChrome({ executable: DEFAULT_CHROME, headless: true, logFile: join(visitorDir, 'chrome.log'), cleanup });
        const visitor = await browser.openPage({ baseUrl: t.baseUrl, dir: visitorDir });
        try {
          await visitor.goto(href); await running(visitor);
          t.equal('second profile has no Unpublish', await visitor.evaluate(z.boolean(), () => document.querySelector('[data-testid="gallery-unpublish"]') === null), true);
          t.equal('second profile fetches no inference', visitor.requests().filter((request) => /\/models\/|\/vendor\/ort\//.test(request.url)), []);
          t.equal('second profile has no console errors', visitor.console().filter((entry) => entry.level === 'error'), []);
        } finally { await visitor.close(); }
      } finally { t.equal('second profile cleanup', await cleanup.run(), []); }
      await page.evaluate(z.literal(true), () => {
        const native = HTMLCanvasElement.prototype.getContext;
        Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: function(this: HTMLCanvasElement, name: string, ...args: unknown[]) {
          return name === 'webgl2' ? null : Reflect.apply(native, this, [name, ...args]);
        } });
        window.__noisyGallery?.remount(); return true;
      });
      await page.waitFor('viewer failure preserves poster and sentence', z.literal(true), () => {
        const poster = document.querySelector<HTMLImageElement>('[data-testid="gallery-poster"]');
        return poster !== null && !poster.hidden && poster.complete && poster.naturalWidth > 0 && document.querySelector('[data-testid="gallery-status"]')?.textContent?.includes('poster') ? true : null;
      });
      await captures(t, 'piece-fallback');
      await pieceScreen(t, 'piece-fallback', pieceAspect);
      await noInference(t, requestStart);
      await page.click('[data-testid="gallery-unpublish"]');
      await page.click('.gallery-confirm button');
      await page.waitFor('unpublish returns to grid', z.literal(true), () => location.pathname === '/gallery' && document.querySelector('[data-testid="gallery-empty"], [data-testid="gallery-grid"]') !== null ? true : null);
      t.ok('returning to the grid releases the piece scroll lock', await page.evaluate(z.boolean(), () => [document.documentElement, document.body].every((node) => getComputedStyle(node).overflow !== 'hidden')));
      t.equal('unpublished piece leaves grid', await page.evaluate(z.boolean(), (url) => [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="gallery-piece-link"]')].some((link) => link.getAttribute('href') === url), href), false);
      // Deterministic empty and failure cases even when another scenario left public pieces.
      await page.intercept([{ method: 'GET', path: '/api/gallery', action: { kind: 'respond', status: 200, body: JSON.stringify({ pieces: [] }) } }]);
      await page.reload();
      await page.waitFor('empty sentence', z.literal(true), () => document.querySelector('[data-testid="gallery-empty"]')?.textContent?.includes('Nothing published yet') ? true : null);
      await captures(t, 'grid-empty');
      t.expectMessage({ because: 'list failure is intentional', channel: 'log', source: 'network', level: 'error', url: /\/api\/gallery$/ });
      await page.intercept([{ method: 'GET', path: '/api/gallery', action: { kind: 'respond', status: 503, body: '{}' } }]);
      await page.reload();
      await page.waitFor('list error and Retry', z.literal(true), () => document.querySelector('[data-testid="gallery-status"]')?.textContent && [...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry') ? true : null);
      await page.intercept([{ method: 'GET', path: '/api/gallery', action: { kind: 'respond', status: 200, body: JSON.stringify({ pieces: [] }) } }]);
      await page.click('.gallery-message button');
      await page.waitFor('Retry recovers the list', z.literal(true), () => document.querySelector('[data-testid="gallery-empty"]') ? true : null);
    } finally {
      await page.intercept([]);
      await page.goto('/');
      await page.waitFor('publisher API for cleanup', z.literal(true), () => window.__noisyTest?.demo.gallery ? true : null);
      await page.evaluate(z.literal(true), async (pieceId) => {
        if (window.__noisyTest?.demo.gallery.publishedHere().some((piece) => piece === pieceId)) await window.__noisyTest.demo.gallery.unpublish(pieceId);
        return true;
      }, id);
      for (const pieceId of seeded) await page.evaluate(z.literal(true), async (value) => { await window.__noisyTest?.demo.gallery.unpublish(value); return true; }, pieceId);
    }
  },
}, {
  id: 'gallery-ui.motion', title: 'Reduced motion waits for Play; tilt and focus stay explicit', target: 'dev', covers: ['GAL1u-6'],
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
    await page.goto('/gallery/00000000-0000-4000-8000-000000000001?fixture=yes');
    await running(page);
    await page.evaluate(z.literal(true), () => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
      const native = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        const result = native(query);
        if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: true });
        return result;
      };
      document.body.dataset['cameraCalls'] = '0';
      if (navigator.mediaDevices !== undefined) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => {
        document.body.dataset['cameraCalls'] = String(Number(document.body.dataset['cameraCalls']) + 1);
        return Promise.reject(new Error('Unexpected camera access'));
      } });
      Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: async () => 'granted' });
      window.__noisyGallery?.remount(); return true;
    });
    await page.evaluate(z.literal(true), async () => { await window.__noisyGallery?.ready; return true; });
    t.equal('reduced motion does not autoplay', await page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.status().kind), 'idle');
    t.equal('reduced motion keeps poster visible', await page.evaluate(z.boolean(), () => document.querySelector<HTMLImageElement>('[data-testid="gallery-poster"]')?.hidden === false), true);
    await page.click('[data-testid="gallery-play"]'); await running(page);
    await page.click('[data-testid="gallery-tilt"]');
    await page.evaluate(z.literal(true), async () => {
      for (let frame = 0; frame < 20; frame++) {
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: null, beta: 20, gamma: 8 }));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return true;
    });
    await page.waitFor('Tilt on reports granted state', z.literal(true), () => document.querySelector('[data-testid="gallery-tilt"]')?.getAttribute('aria-pressed') === 'true' ? true : null);
    t.equal('granted control remains quiet and visible', await page.evaluate(z.string(), () => document.querySelector('[data-testid="gallery-tilt"]')?.textContent), 'Tilt on');
    await page.click('[data-testid="gallery-play"]');
    t.equal('Pause stops playback', await page.evaluate(z.string(), () => window.__noisyGallery?.viewer()?.status().kind), 'stopped');
    await page.evaluate(z.literal(true), () => { document.querySelector<HTMLAnchorElement>('[data-testid="gallery-back"]')?.focus(); return true; });
    await page.press('Tab');
    t.equal('keyboard focus has a visible outline', await page.evaluate(z.boolean(), () => document.activeElement instanceof HTMLElement && parseFloat(getComputedStyle(document.activeElement).outlineWidth) >= 2), true);
    t.equal('gallery never requests camera', await page.evaluate(z.string(), () => document.body.dataset['cameraCalls']), '0');
    await noInference(t, 0);
  },
}];
