import { z } from '../../../src/core/zod.ts';
import { HEIC_MESSAGE, LONG_EDGE_MESSAGE } from '../../../src/photo/limits.ts';
import type { Scenario } from '../scenario.ts';

const View = z.object({
  status: z.string(), master: z.object({ width: z.number(), height: z.number() }).nullable(),
  clusters: z.number(), path: z.enum(['resize', 'fallback']).nullable(),
  canvas: z.object({ width: z.number(), height: z.number() }).nullable(),
  statusLine: z.string().nullable(),
});
const Imported = View.extend({ elapsedMs: z.number() });

function view(): unknown {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) return null;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid=stage]');
  return { ...demo.scene(), canvas: canvas === null ? null : { width: canvas.width, height: canvas.height }, statusLine: document.querySelector('[data-testid=status]')?.textContent ?? null };
}

/** Self-contained because the driver serializes this function into the page. */
async function importJpeg(width: number, height: number): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('The demo test surface is missing.');
  const fixture = new OffscreenCanvas(width, height);
  const context = fixture.getContext('2d');
  if (context === null) throw new Error('No JPEG fixture context.');
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#ef2637');
  gradient.addColorStop(0.5, '#28de91');
  gradient.addColorStop(1, '#284af1');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  const blob = await fixture.convertToBlob({ type: 'image/jpeg' });
  const file = new File([blob], 'judge.jpg', { type: 'image/jpeg' });
  const start = performance.now();
  await demo.importFile(file);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid=stage]');
  return { ...demo.scene(), canvas: canvas === null ? null : { width: canvas.width, height: canvas.height }, elapsedMs: performance.now() - start, statusLine: document.querySelector('[data-testid=status]')?.textContent ?? null };
}

async function importHeif(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('The demo test surface is missing.');
  const header = new Uint8Array(32);
  new DataView(header.buffer).setUint32(0, 32);
  header.set(new TextEncoder().encode('ftypheic'), 4);
  header.set(new TextEncoder().encode('mif1'), 16);
  await demo.importFile(new File([header], 'judge.heic', { type: 'image/heic' }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return { status: demo.scene().status, statusLine: document.querySelector('[data-testid=status]')?.textContent ?? null };
}

async function compareDownload(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  const size = demo?.scene().master;
  if (demo === undefined || size === null || size === undefined) throw new Error('The master is missing.');
  // Independently decode the same JPEG recipe to encode a master PNG.
  // The stage belongs to WebGL and must never receive a 2D context.
  const fixture = new OffscreenCanvas(4032, 3024);
  const context = fixture.getContext('2d');
  if (context === null) throw new Error('No JPEG fixture context.');
  const gradient = context.createLinearGradient(0, 0, 4032, 3024);
  gradient.addColorStop(0, '#ef2637'); gradient.addColorStop(0.5, '#28de91'); gradient.addColorStop(1, '#284af1');
  context.fillStyle = gradient; context.fillRect(0, 0, 4032, 3024);
  const jpeg = await fixture.convertToBlob({ type: 'image/jpeg' });
  const masterBitmap = await createImageBitmap(jpeg, { imageOrientation: 'from-image', colorSpaceConversion: 'default',
    resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
  const masterCanvas = new OffscreenCanvas(size.width, size.height);
  const master = masterCanvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  if (master === null) { masterBitmap.close(); throw new Error('No master comparison context.'); }
  master.drawImage(masterBitmap, 0, 0); masterBitmap.close();
  const masterPng = new Uint8Array(await (await masterCanvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const blob = await demo.downloadPng();
  const a = new Uint8Array(await blob.arrayBuffer());
  const b = new Uint8Array(await (await demo.downloadPng()).arrayBuffer());
  const equal = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((v, i) => v === right[i]);
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  try {
    const renderedCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const rendered = renderedCanvas.getContext('2d', { colorSpace: 'srgb' });
    if (rendered === null) throw new Error('No rendered comparison context.');
    rendered.drawImage(bitmap, 0, 0);
    const masterPixels = master.getImageData(0, 0, size.width, size.height).data;
    const renderedPixels = rendered.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { type: blob.type, width: bitmap.width, height: bitmap.height,
      repeatedBytesEqual: equal(a, b), differsFromMasterPng: !equal(a, masterPng),
      lookPixelsDiffer: renderedPixels.some((v, i) => i % 4 !== 3 && v !== masterPixels[i]) };
  } finally { bitmap.close(); }
}

function visibleStatusMatches(statusLine: string | null, sceneStatus: string): boolean {
  return statusLine === sceneStatus || statusLine === 'Ready to tap' ||
    ['Fetching models', 'Waiting to analyze', 'Analyzing'].some((prefix) => statusLine?.startsWith(prefix) === true);
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'demo.import', title: 'the demo imports oriented landscape and portrait masters and refuses small JPEG and HEIF files', target: 'dev', covers: [],
    async run(t) {
      await t.page.goto('/');
      const initial = await t.page.waitFor('the demo to boot', View, view);
      t.equal('cross-origin isolated', await t.page.evaluate(z.boolean(), () => window.crossOriginIsolated), true);
      t.equal('initial status', [initial.status, initial.master], ['Drop a photo', null]);
      t.ok('initial visible status is scene or analysis status', visibleStatusMatches(initial.statusLine, initial.status), { statusLine: initial.statusLine });
      for (const [width, height, masterWidth, masterHeight] of [[4032, 3024, 2048, 1536], [3024, 4032, 1536, 2048]]) {
        if (width === undefined || height === undefined || masterWidth === undefined || masterHeight === undefined) throw new Error('Incomplete size fixture.');
        const imported = await t.page.evaluate(Imported, importJpeg, width, height);
        t.equal(`${width} x ${height}: ready`, imported.status, 'Ready');
        t.ok(`${width} x ${height}: visible status is scene or analysis status`, visibleStatusMatches(imported.statusLine, imported.status), { statusLine: imported.statusLine });
        t.ok(`${width} x ${height}: import and present within 3 s`, imported.elapsedMs <= 3000, imported);
        t.equal(`${width} x ${height}: scene and stage master size`, [imported.master, imported.canvas], [{ width: masterWidth, height: masterHeight }, { width: masterWidth, height: masterHeight }]);
        t.ok(`${width} x ${height}: 2 to 16 clusters`, imported.clusters >= 2 && imported.clusters <= 16, imported);
        t.ok(`${width} x ${height}: reports the decode path`, imported.path === 'resize' || imported.path === 'fallback', { path: imported.path });
        await t.file(`import-${width}x${height}.json`, JSON.stringify(imported, null, 2));
        await t.page.screenshot(`master-${width}x${height}`);
      }
      const small = await t.page.evaluate(Imported, importJpeg, 400, 300);
      t.equal('small JPEG names the long-edge limit', [small.status, small.statusLine], [LONG_EDGE_MESSAGE, LONG_EDGE_MESSAGE]);
      const heif = await t.page.evaluate(z.object({ status: z.string(), statusLine: z.string().nullable() }), importHeif);
      t.equal('HEIF gets the exact design sentence', [heif.status, heif.statusLine], [HEIC_MESSAGE, HEIC_MESSAGE]);
    },
  },
  {
    id: 'demo.download', title: 'rendered PNG download has master dimensions, repeatable bytes, and an applied look', target: 'dev', covers: [],
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('the demo to boot', View, view);
      const imported = await t.page.evaluate(Imported, importJpeg, 4032, 3024);
      t.equal('import ready before download', imported.status, 'Ready');
      const exported = await t.page.evaluate(z.object({
        type: z.string(), width: z.number(), height: z.number(),
        repeatedBytesEqual: z.boolean(), differsFromMasterPng: z.boolean(), lookPixelsDiffer: z.boolean(),
      }), compareDownload);
      t.equal('PNG type and master size', [exported.type, exported.width, exported.height], ['image/png', 2048, 1536]);
      t.ok('two PNG downloads are byte-identical', exported.repeatedBytesEqual);
      t.ok('the rendered download differs from the master PNG', exported.differsFromMasterPng);
      t.ok('the look changes decoded RGB pixels', exported.lookPixelsDiffer);
      await t.file('download.json', JSON.stringify(exported, null, 2));
    },
  },
];
