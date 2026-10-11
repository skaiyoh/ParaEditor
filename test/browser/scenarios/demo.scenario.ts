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

const Probe = z.object({ x: z.number(), y: z.number(), rgba: z.array(z.number()) });
const Fixture = z.object({ bytes: z.string(), probes: z.array(Probe) });
const Replacement = z.object({
  id: z.string(), asset: z.string(), name: z.string(), generation: z.number(),
  objects: z.number(), masks: z.number(), plates: z.number(), pixels: z.array(z.array(z.number())),
});

/** Same dimensions, different pixels and subject locations: size alone cannot prove replacement. */
async function replacementFixture(kind: 'jpeg' | 'png' | 'sample'): Promise<unknown> {
  let blob: Blob;
  if (kind === 'sample') {
    const response = await fetch('/assets-static/sample.jpg');
    if (!response.ok) throw new Error(`Sample fixture failed: ${response.status}`);
    blob = await response.blob();
  } else {
    const canvas = new OffscreenCanvas(2048, 1536), context = canvas.getContext('2d');
    if (context === null) throw new Error('No replacement fixture context.');
    context.fillStyle = '#808080'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = kind === 'jpeg' ? '#ed2637' : '#284af1';
    context.beginPath(); context.arc(kind === 'jpeg' ? 600 : 1448, 768, 500, 0, Math.PI * 2); context.fill();
    blob = await canvas.convertToBlob({ type: `image/${kind}` });
  }
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (context === null) throw new Error('No source comparison context.');
    context.drawImage(bitmap, 0, 0);
    const probes = [{ x: 600, y: 768 }, { x: 1448, y: 768 }, { x: 100, y: 100 }]
      .map(({ x, y }) => ({ x, y, rgba: Array.from(context.getImageData(x, y, 1, 1).data) }));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')), probes };
  } finally { bitmap.close(); }
}

function readReplacement(probes: readonly { x: number; y: number }[]): unknown {
  const demo = window.__noisyTest?.demo, doc = demo?.document();
  if (demo === undefined || doc == null || demo.render === null) throw new Error('No replacement scene.');
  // With simplification off this render target must contain the new source pixels.
  demo.setStyle({ simplify: 0 });
  return { id: doc.id, asset: doc.frame.master.asset, name: doc.frame.original.name,
    generation: demo.products().generation, objects: demo.objects().length,
    masks: demo.products().masks, plates: demo.products().plates,
    pixels: probes.map(({ x, y }) => Array.from(demo.render?.readSimplifiedPatch(x, y, 1, 1) ?? [])) };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'demo.import-three', title: 'JPEG, PNG and sample each replace the picture and masks, become ready and accept a subject tap',
    target: 'dev', covers: [], timeoutMs: 600_000,
    async run(t) {
      await t.page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.goto('/');
      await t.page.waitFor('the demo to boot', View, view);
      // Viewport emulation does not set touch capability in this driver.
      await t.page.evaluate(z.literal(true), () => {
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
        return true;
      });
      // The touch fixture changed after boot; a panel toggle triggers the render
      // that observes it without remounting the full-tier stage on rotation.
      await t.page.click('[data-testid=tool-actions]');
      await t.page.click('[data-testid=tool-actions]');
      await t.page.emulate({ width: 820, height: 1180, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.waitFor('portrait full frame', z.literal(true), () => ['tool-actions', 'tool-adjust', 'tool-layers'].every((id) => document.querySelector(`[data-testid=${id}]`)?.checkVisibility() === true) && document.querySelector('.phone-editor') === null ? true : null);
      await t.page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.waitFor('landscape touch camera input', z.literal(true), () => document.querySelector('.editor .top-bar input[type=file][capture]') === null ? null : true);
      const inputs = await t.page.evaluate(z.array(z.object({ accept: z.string(), capture: z.string().nullable() })), () =>
        Array.from(document.querySelectorAll<HTMLInputElement>('input[type=file]'), (input) => ({ accept: input.accept, capture: input.getAttribute('capture') })));
      t.equal('iPad landscape picker and camera explicitly request JPEG/PNG', inputs, [
        { accept: 'image/jpeg,image/png', capture: null }, { accept: 'image/jpeg,image/png', capture: 'environment' },
      ]);
      let previous: z.infer<typeof Replacement> | null = null;
      let previousMask: string | null = null;
      let previousMaskHash: string | null = null;
      for (const kind of ['jpeg', 'png', 'sample'] as const) {
        const fixture = await t.page.evaluate(Fixture, replacementFixture, kind);
        const name = kind === 'sample' ? 'sample.jpg' : `three.${kind}`;
        if (kind === 'sample') {
          await t.page.click('[data-testid=tool-actions]');
          await t.page.click('[data-testid=try-sample]');
          await t.page.click('[data-testid=tool-actions]');
        }
        else await t.page.setFiles('input[type=file]:not([capture])', [await t.file(name, Buffer.from(fixture.bytes, 'base64'))]);
        await t.page.evaluate(z.literal(true), (expected: string) => { document.body.dataset['threeExpected'] = expected; return true; }, name);
        await t.page.waitFor(`${kind}: new photo Ready to tap`, z.literal(true), () => {
          const demo = window.__noisyTest?.demo, a = demo?.analysis();
          return demo?.document()?.frame.original.name === document.body.dataset['threeExpected'] && a?.decoderReady &&
            a.status === 'Ready to tap' && document.querySelector('[data-testid=status]')?.textContent?.startsWith('Ready to tap') ? true : null;
        }, { timeoutMs: 180_000 });
        const current = await t.page.evaluate(Replacement, readReplacement, fixture.probes);
        t.equal(`${kind}: no previous objects, masks or plates`, [current.objects, current.masks, current.plates], [0, 0, 0]);
        // This target stores detail in alpha; compare its source RGB only.
        t.ok(`${kind}: rendered source pixels match this image`, current.pixels.every((pixel, i) =>
          pixel.length === 4 && pixel.slice(0, 3).every((value, channel) => Math.abs(value - (fixture.probes[i]?.rgba[channel] ?? -1000)) <= 1)), { actual: current.pixels, expected: fixture.probes });
        if (previous !== null) {
          t.ok(`${kind}: new scene and master asset`, current.id !== previous.id && current.asset !== previous.asset, { previous, current });
          t.equal(`${kind}: exactly one new analysis generation`, current.generation, previous.generation + 1);
        }
        await t.page.screenshot(`three-${kind}-ready`);
        const point = kind === 'sample' ? { x: 0.38, y: 0.585 } : { x: (kind === 'jpeg' ? 600 : 1448) / 2048, y: 0.5 };
        await t.page.evaluate(z.literal(true), (at: { x: number; y: number }) => {
          const stage = document.querySelector<HTMLCanvasElement>('[data-testid=stage]');
          if (stage === null) throw new Error('No stage for subject tap.');
          const box = stage.getBoundingClientRect();
          stage.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + at.x * box.width, clientY: box.top + at.y * box.height }));
          return true;
        }, point);
        await t.page.waitFor(`${kind}: tap selects one object and shows swatches`, z.literal(true), () => {
          const objects = window.__noisyTest?.demo.objects();
          return objects?.length === 1 && objects[0]?.selected && document.querySelector('[data-testid=swatches]') !== null ? true : null;
        }, { timeoutMs: 30_000 });
        const mask = await t.page.evaluate(z.object({ asset: z.string(), hash: z.string(), nonempty: z.boolean(), containsTap: z.boolean(), masks: z.number() }), async (at: { x: number; y: number }) => {
          const demo = window.__noisyTest?.demo, mask = demo?.projectMasks()[0], object = demo?.objects()[0], master = demo?.scene().master;
          if (demo === undefined || mask === undefined || object === undefined || master == null) throw new Error('Missing tapped mask.');
          const b = object.bounds, x = at.x * master.width, y = at.y * master.height;
          return { asset: mask.asset, hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(mask.bytes)))).join(','),
            nonempty: mask.bytes.some((value) => value > 0), containsTap: x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height,
            masks: demo.products().masks };
        }, point);
        t.ok(`${kind}: fresh nonempty mask contains the tapped subject`, mask.nonempty && mask.containsTap && mask.masks === 1 &&
          mask.asset !== previousMask && mask.hash !== previousMaskHash, mask);
        await t.page.screenshot(`three-${kind}-selected`);
        await t.file(`three-${kind}.json`, JSON.stringify({ current, probes: fixture.probes, point, mask }, null, 2));
        previous = current; previousMask = mask.asset; previousMaskHash = mask.hash;
      }
      const header = new Uint8Array(32);
      new DataView(header.buffer).setUint32(0, header.length);
      header.set(new TextEncoder().encode('ftypheic'), 4);
      await t.page.setFiles('input[type=file]:not([capture])', [await t.file('three.heic', header)]);
      await t.page.waitFor('raw HEIC is refused', z.literal(true), () => window.__noisyTest?.demo.scene().status.includes('HEIC/HEIF') ? true : null);
      const refused = await t.page.evaluate(View, view);
      t.equal('raw HEIC shows the exact actionable recovery copy', [refused.status, refused.statusLine], [HEIC_MESSAGE, HEIC_MESSAGE]);
      t.ok('the full recovery text fits inside the visible footer', await t.page.evaluate(z.boolean(), () => {
        const status = document.querySelector('[data-testid=status]');
        if (status === null) return false;
        const range = document.createRange(); range.selectNodeContents(status);
        const text = range.getBoundingClientRect(), box = status.getBoundingClientRect();
        return text.top >= box.top && text.bottom <= Math.min(box.bottom, innerHeight) && text.left >= box.left && text.right <= box.right;
      }));
      await t.page.screenshot('three-heic-refused');
      await t.page.emulate({ width: 820, height: 1180, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.waitFor('portrait full top bar', z.literal(true), () => ['tool-actions', 'tool-adjust', 'tool-layers'].every((id) => document.querySelector(`[data-testid=${id}]`)?.checkVisibility() === true) && document.querySelector('.phone-editor') === null ? true : null);
      await t.page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.waitFor('phone camera input requests JPEG/PNG too', z.literal(true), () =>
        document.querySelector<HTMLInputElement>('.phone-strip input[type=file]')?.accept === 'image/jpeg,image/png' ? true : null);
      t.equal('portrait capture keeps rear camera hint', await t.page.evaluate(z.string().nullable(), () =>
        document.querySelector('.phone-strip input[type=file]')?.getAttribute('capture') ?? null), 'environment');
    },
  },
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
