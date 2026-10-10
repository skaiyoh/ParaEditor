import { readFile } from 'node:fs/promises';
import { z } from '../../../src/core/zod.ts';
import { HEIC_MESSAGE, LONG_EDGE_MESSAGE } from '../../../src/photo/limits.ts';
import type { Scenario } from '../scenario.ts';

// Inspected in the bundled 2048 x 1536 placeholder: the red sphere's center.
// Revisit this point when Nathan replaces sample.jpg with the demo photograph.
const SUBJECT = { x: 0.38, y: 0.585 };
const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), viewportWidth: z.number(), viewportHeight: z.number() });
type StageRect = z.infer<typeof Rect>;

function ready(): true | null {
  return document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap' ? true : null;
}

function status(): string | null {
  return document.querySelector('[data-testid="status"]')?.textContent ?? null;
}

async function frame(): Promise<StageRect> {
  const stage = document.querySelector<HTMLCanvasElement>('[data-testid="stage"]');
  if (stage === null) throw new Error('The rendered photo is missing.');
  stage.scrollIntoView({ block: 'start' });
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const box = stage.getBoundingClientRect();
  const x = Math.max(0, box.left), y = Math.max(0, box.top);
  return { x, y, width: Math.min(innerWidth, box.right) - x, height: Math.min(innerHeight, box.bottom) - y,
    viewportWidth: innerWidth, viewportHeight: innerHeight };
}

/** Decode browser screenshots in a separate 2D canvas, never read the WebGL canvas. */
async function stageDifference(before: string, after: string, rect: StageRect): Promise<unknown> {
  const read = async (url: string): Promise<ImageData> => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const surface = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = surface.getContext('2d');
    if (context === null) throw new Error('No screenshot comparison context.');
    context.drawImage(image, 0, 0);
    const scaleX = image.naturalWidth / rect.viewportWidth, scaleY = image.naturalHeight / rect.viewportHeight;
    return context.getImageData(Math.ceil(rect.x * scaleX), Math.ceil(rect.y * scaleY),
      Math.floor(rect.width * scaleX), Math.floor(rect.height * scaleY));
  };
  const left = await read(before), right = await read(after);
  if (left.width !== right.width || left.height !== right.height) throw new Error('Screenshot sizes changed.');
  let changed = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    if (left.data[i] !== right.data[i] || left.data[i + 1] !== right.data[i + 1] || left.data[i + 2] !== right.data[i + 2]) changed++;
  }
  return { changed, pixels: left.width * left.height };
}

/** Observe and forward the actual save anchor, including detached anchors. */
function observeDownload(): true {
  const original = HTMLAnchorElement.prototype.click;
  let unloads = 0;
  const beforeUnload = (): void => { unloads++; document.body.dataset['storyUnloads'] = String(unloads); };
  document.body.dataset['storyUnloads'] = '0';
  window.addEventListener('beforeunload', beforeUnload);
  HTMLAnchorElement.prototype.click = function (): void {
    if (this.download !== '') {
      document.body.dataset['storyDownloadName'] = this.download;
      document.body.dataset['storyDownloadUrl'] = this.href;
      document.body.dataset['storyDownloadCount'] = String(Number(document.body.dataset['storyDownloadCount'] ?? '0') + 1);
    }
    original.call(this);
  };
  document.addEventListener('story-cleanup', () => {
    HTMLAnchorElement.prototype.click = original;
    window.removeEventListener('beforeunload', beforeUnload);
  }, { once: true });
  return true;
}

function buttonSelector(label: string): string {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label);
  if (button === undefined) throw new Error(`The ${label} button is missing.`);
  button.dataset['storyAction'] = label;
  return `[data-story-action="${label}"]`;
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'story.production', target: 'production', timeoutMs: 300_000, covers: [],
    title: 'the judge imports the bundled sample, changes the look, taps, recolors, downloads and resets through the production interface',
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('the sample button', z.literal(true), () => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Try a sample') ? true : null);
      const click = async (label: string): Promise<void> => { await t.page.click(await t.page.evaluate(z.string(), buttonSelector, label)); };
      await click('Try a sample');
      await t.page.waitFor('Ready to tap without a dev timing suffix', z.literal(true), ready, { timeoutMs: 240_000 });
      t.equal('production status is exactly Ready to tap', await t.page.evaluate(z.string(), status), 'Ready to tap');
      const rect = await t.page.evaluate(Rect, frame);
      t.ok('the stage region is visible', rect.width > 0 && rect.height > 0, rect);
      const before = await t.page.screenshot('stage-before-slider');
      await t.page.evaluate(z.literal(true), () => {
        const slider = document.querySelector<HTMLInputElement>('[data-testid="style-grain"]');
        if (slider === null) throw new Error('The Grain slider is missing.');
        slider.value = '1';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      });
      await t.page.waitFor('the Grain input updates the visible output', z.literal(true), () => document.querySelector('[data-testid="value-grain"]')?.textContent === '1' ? true : null);
      const afterRect = await t.page.evaluate(Rect, frame);
      t.equal('the same stage region is captured', afterRect, rect);
      const after = await t.page.screenshot('stage-after-slider');
      const difference = await t.page.evaluate(z.object({ changed: z.number(), pixels: z.number() }), stageDifference,
        `data:image/png;base64,${(await readFile(before)).toString('base64')}`,
        `data:image/png;base64,${(await readFile(after)).toString('base64')}`, rect);
      t.ok('the real slider input changes stage RGB pixels', difference.changed > 0, difference);
      await t.file('stage-difference.json', JSON.stringify({ subject: SUBJECT, rect, ...difference }, null, 2));
      await t.page.evaluate(z.literal(true), (at: { x: number; y: number }) => {
        const stage = document.querySelector<HTMLCanvasElement>('[data-testid="stage"]');
        if (stage === null) throw new Error('The rendered photo is missing.');
        const box = stage.getBoundingClientRect();
        stage.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + at.x * box.width, clientY: box.top + at.y * box.height }));
        return true;
      }, SUBJECT);
      const swatch = await t.page.waitFor('the visible Green swatch after the subject tap', z.string(), () => {
        const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Green' || node.getAttribute('aria-label') === 'Green' || node.title === 'Green');
        if (button === undefined || button.getBoundingClientRect().width === 0) return null;
        button.dataset['storySwatch'] = 'green';
        return '[data-story-swatch="green"]';
      }, { timeoutMs: 30_000 });
      await t.page.click(swatch);
      await t.page.screenshot('subject-recolored');
      await t.page.evaluate(z.literal(true), observeDownload);
      try {
        await click('Download');
        const download = await t.page.waitFor('the actual PNG save anchor to click', z.object({ name: z.string(), url: z.string(), count: z.number() }), () => {
          const { storyDownloadName: name, storyDownloadUrl: url, storyDownloadCount: count } = document.body.dataset;
          return name === undefined || url === undefined ? null : { name, url, count: Number(count) };
        }, { timeoutMs: 30_000 });
        // Let navigation events surface before checking the page remains in place.
        await t.page.evaluate(z.literal(true), async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return true;
        });
        t.ok('the PNG download was requested through a blob anchor', download.url.startsWith('blob:') && download.name.endsWith('.png'), download);
        t.equal('one download anchor clicked', download.count, 1);
        t.equal('Download does not trigger beforeunload or leave the page', await t.page.evaluate(z.object({ unloads: z.number(), path: z.string() }), () => ({ unloads: Number(document.body.dataset['storyUnloads']), path: location.pathname })), { unloads: 0, path: '/' });
        await t.file('download-request.json', JSON.stringify({ ...download, assertion: 'forwarded native anchor click; driver has no download-event API' }, null, 2));
      } finally {
        await t.page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('story-cleanup')); return true; });
      }
      await click('Reset');
      await t.page.waitFor('Reset removes the swatch row', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === 'Reset' && document.querySelector('[data-story-swatch="green"]') === null ? true : null);
      await t.page.screenshot('reset');
      // The runner's undeclared console-error/exception and CSP invariants apply.
    },
  },
  {
    id: 'story.production-errors', target: 'production', timeoutMs: 60_000, covers: [],
    title: 'the production file input gives the HEIC and too-small JPEG sentences',
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('the real file input', z.literal(true), () => document.querySelector('input[type="file"]') === null ? null : true);
      const header = new Uint8Array(32);
      new DataView(header.buffer).setUint32(0, 32);
      header.set(new TextEncoder().encode('ftypheic'), 4);
      header.set(new TextEncoder().encode('mif1'), 16);
      const heic = await t.file('judge.heic', header);
      await t.page.setFiles('input[type="file"]', [heic]);
      await t.page.evaluate(z.literal(true), (expected: string) => { document.body.dataset['storyExpectedStatus'] = expected; return true; }, HEIC_MESSAGE);
      await t.page.waitFor('the HEIC refusal', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === document.body.dataset['storyExpectedStatus'] ? true : null);
      t.equal('the HEIC sentence is visible', await t.page.evaluate(z.string(), status), HEIC_MESSAGE);
      const small = await t.page.evaluate(z.string(), async () => {
        const canvas = new OffscreenCanvas(400, 300), context = canvas.getContext('2d');
        if (context === null) throw new Error('No small JPEG fixture context.');
        context.fillStyle = '#809090'; context.fillRect(0, 0, 400, 300);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
        return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
      });
      const jpeg = await t.file('small.jpg', Buffer.from(small, 'base64'));
      await t.page.setFiles('input[type="file"]', [jpeg]);
      await t.page.evaluate(z.literal(true), (expected: string) => { document.body.dataset['storyExpectedStatus'] = expected; return true; }, LONG_EDGE_MESSAGE);
      await t.page.waitFor('the long-edge refusal', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === document.body.dataset['storyExpectedStatus'] ? true : null);
      t.equal('the long-edge sentence is visible', await t.page.evaluate(z.string(), status), LONG_EDGE_MESSAGE);
      await t.page.screenshot('long-edge-refusal');
    },
  },
];
