import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';
import { currentDocumentSchema } from '../../../src/core/schema.ts';
import { colorInputFromOklch } from '../../../src/core/color.ts';
import { fiveClusterDocument } from '../../fixtures/documents.ts';
import { createPerspectiveGeometry, constrainEye } from '../../../src/core/perspective.ts';
import { liveCoverage } from '../../../src/core/live-coverage.ts';

const rowsSchema = z.array(z.object({ name: z.string(), pass: z.boolean(), evidence: z.string() }));
const stateSchema = z.object({ document: z.string(), timestamp: z.string(), undo: z.number(), redo: z.number(), uploads: z.number() });
const frames = [{ width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 1440, height: 900 }];

async function setup(t: ScenarioContext): Promise<void> {
  await t.page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await t.page.goto('/');
  await t.page.evaluate(z.literal(true), async () => {
    const demo = window.__noisyTest?.demo;
    if (demo === undefined) throw new Error('C1 requires the dev session surface.');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d'); if (ctx === null) throw new Error('No fixture canvas.');
    const data = ctx.createImageData(640, 480);
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      data.data.set([Math.floor(x * 255 / 640), Math.floor(y * 255 / 480), 80 + (Math.floor((x + y) / 16) % 100), 255], i);
    }
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob === null ? reject(new Error('No fixture PNG.')) : resolve(blob), 'image/png'));
    demo.setCompare('source-photo');
    await demo.importFile(new File([blob], 'C1 color study.png', { type: 'image/png' }));
    const deadline = performance.now() + 180_000;
    while (!demo.analysis().depth || !demo.analysis().decoderReady || demo.analysis().alive.heavy) {
      if (performance.now() > deadline) throw new Error(`C1 analysis timed out: ${demo.analysis().status}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const dataMask = new Uint8Array(128 * 96);
    for (let y = 30; y < 66; y++) for (let x = 42; x < 86; x++) dataMask[y * 128 + x] = 255;
    demo.injectMask({ width: 128, height: 96, data: dataMask });
    while (demo.objects().length === 0) {
      if (performance.now() > deadline) throw new Error('C1 fixture mask timed out.');
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const object = demo.objects().at(-1); if (object === undefined) throw new Error('No fixture object.');
    demo.select(object.id); demo.setMotion({ enabled: false });
    demo.setStyle({ fry: 0, simplify: 0, outline: 0, grain: 0, colorNoise: 0, clipping: 0, crunch: 0 });
    demo.setSymbols({ enabled: false });
    return true;
  });
  t.equal('photo import returns comparison to Edited', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.authoringState().compare ?? ''), 'edited');
  await saved(t);
  await t.page.evaluate(z.literal(true), () => {
    const original = window.fetch;
    document.documentElement.dataset['c1Uploads'] = '0';
    window.fetch = (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const url = input instanceof Request ? input.url : new URL(input, location.href).href;
      if (method.toUpperCase() === 'PUT' && url.includes('/api/projects/')) {
        document.documentElement.dataset['c1Uploads'] = String(Number(document.documentElement.dataset['c1Uploads']) + 1);
      }
      return original.call(window, input, init);
    };
    return true;
  });
}
async function saved(t: ScenarioContext): Promise<void> {
  await t.page.waitFor('C1 current project and analysis saved', z.literal(true), () => {
    const demo = window.__noisyTest?.demo;
    return demo?.projects().state === 'saved' && demo.projects().pendingSaves === 0 && !demo.analysis().alive.heavy ? true : null;
  }, { timeoutMs: 90_000 });
}
async function state(t: ScenarioContext): Promise<z.infer<typeof stateSchema>> {
  return t.page.evaluate(stateSchema, () => {
    const demo = window.__noisyTest?.demo, doc = demo?.document(), history = demo?.historyState();
    if (doc == null || history === undefined) throw new Error('No C1 state.');
    return { document: JSON.stringify(doc), timestamp: doc.updatedAt, undo: history.undoDepth, redo: history.redoDepth,
      uploads: Number(document.documentElement.dataset['c1Uploads'] ?? 0) };
  });
}
async function hex(t: ScenarioContext, value: string): Promise<void> {
  await t.page.evaluate(z.literal(true), (value) => {
    const input = document.querySelector('[data-testid="color-hex"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('No hex input.');
    input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, value);
  await t.page.press('Enter');
}
async function reopened(t: ScenarioContext, id: string): Promise<void> {
  await t.page.waitFor('opened project installed and Projects closed', z.literal(true), () => {
    const demo = window.__noisyTest?.demo;
    return demo !== undefined && demo.document() !== null && demo.scene().status !== 'Importing…' &&
      !document.querySelector('[data-testid="projects-panel"]')?.checkVisibility() ? true : null;
  }, { timeoutMs: 90_000 });
  t.equal('completed open installs the requested project', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.document()?.id ?? ''), id);
}
async function settleCapture(t: ScenarioContext): Promise<void> {
  await t.page.evaluate(z.literal(true), async () => {
    const deadline = performance.now() + 1000;
    const animating = (): boolean => document.getAnimations().some((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
    });
    while (animating()) {
      if (performance.now() > deadline) throw new Error('Finite C1 panel animation did not settle before capture.');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  });
}
async function captures(t: ScenarioContext, name: string): Promise<void> {
  for (const frame of frames) {
    await t.page.emulate({ ...frame, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.evaluate(z.literal(true), async ({ width, height }) => {
      const deadline = performance.now() + 10_000;
      while (innerWidth !== width || innerHeight !== height || document.querySelector('.full-editor') === null) {
        if (performance.now() > deadline) throw new Error('C1 capture viewport did not settle.');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return true;
    }, frame);
    await settleCapture(t);
    const presentation = await t.page.evaluate(rowsSchema, (name) => {
      if (name === 'c1-color') {
        const panel = document.querySelector('[data-testid="panel-color"]'), square = panel?.querySelector('[data-testid="color-sv"]');
        const hexRow = panel?.querySelector('.color-input-row'), channels = panel?.querySelector('.color-channels');
        const sampleRow = panel?.querySelector('.color-sample-row'), label = sampleRow?.querySelector('span');
        const source = sampleRow?.querySelector('[aria-label="Sample source"]'), sampler = sampleRow?.querySelector('[data-testid="color-sampler"]');
        if (square === null || square === undefined || hexRow === null || hexRow === undefined || channels === null || channels === undefined ||
          label === null || label === undefined || source === null || source === undefined || sampler === null || sampler === undefined) throw new Error('Incomplete Color presentation.');
        const channelWidths = Array.from(channels.children).map((node) => node.getBoundingClientRect().width);
        const sample = { label: label.textContent, labelRight: label.getBoundingClientRect().right, sourceLeft: source.getBoundingClientRect().left,
          sourceRight: source.getBoundingClientRect().right, samplerLeft: sampler.getBoundingClientRect().left };
        const bounds = square.getBoundingClientRect();
        const swatches = Array.from(panel?.querySelectorAll('.color-swatches') ?? []).map((group) => {
          const buttons = Array.from(group.querySelectorAll('button')), first = buttons[0]?.getBoundingClientRect(), last = buttons.at(-1)?.getBoundingClientRect();
          return { count: buttons.length, left: first?.left, right: last?.right, top: first?.top, lastTop: last?.top,
            sizes: buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) };
        });
        return [
          { name: 'RGB spans equal columns immediately after hex, before sampling', pass: channelWidths.length === 3 && Math.max(...channelWidths) - Math.min(...channelWidths) < 1 &&
            channels.getBoundingClientRect().top >= hexRow.getBoundingClientRect().bottom && source.getBoundingClientRect().top >= channels.getBoundingClientRect().bottom, evidence: JSON.stringify(channelWidths) },
          { name: 'Sample from visibly labels the source segment beside the sampler', pass: label.checkVisibility() && sample.label === 'Sample from' &&
            sample.labelRight <= sample.sourceLeft && sample.sourceRight <= sample.samplerLeft && sample.samplerLeft - sample.sourceRight <= 8, evidence: JSON.stringify(sample) },
          { name: 'Recent and preset circles align with SV edges and retain 36 px targets', pass: swatches.length > 0 && swatches.every((row) => row.left !== undefined &&
            Math.abs(row.left - bounds.left) < 1 && (row.count !== 8 || (row.right !== undefined && Math.abs(row.right - bounds.right) < 1 && row.top === row.lastTop)) &&
            row.sizes.every((size) => size.width >= 36 && size.height >= 36)), evidence: JSON.stringify(swatches) },
        ];
      }
      if (name === 'c1-compare') {
        const button = document.querySelector('[data-testid="compare-treatments-off"]');
        if (button === null) throw new Error('No Treatments off segment.');
        const text = document.createRange(); text.selectNodeContents(button);
        const lines = Array.from(text.getClientRects()).map((rect) => ({ top: rect.top, height: rect.height }));
        const foreground = getComputedStyle(button).color;
        const marks = Array.from(document.querySelectorAll('.panel-actions .fact-ready')).map((node) => getComputedStyle(node, '::before').backgroundColor);
        return [
          { name: 'Treatments off stays on one line in Actions', pass: lines.length === 1, evidence: JSON.stringify(lines) },
          { name: 'Actions readiness marks use the neutral text color', pass: marks.length > 0 && marks.every((color) => color === foreground), evidence: JSON.stringify({ foreground, marks }) },
        ];
      }
      return [];
    }, name);
    for (const row of presentation) t.ok(`${frame.width}x${frame.height}: ${row.name}`, row.pass, row.evidence);
    await t.page.screenshot(`${name}-${frame.width}x${frame.height}`);
  }
}

/** Read every pixel with a controlled render scene, then restore the editor's
 * own scene by selecting its current object. No fixture enters autosave. */
async function rendererChecks(t: ScenarioContext, section: 'color' | 'compare'): Promise<void> {
  const base = fiveClusterDocument(), object = base.objects[0];
  if (object === undefined || base.analysis.depth === null || base.analysis.plate === null) throw new Error('Missing C1 renderer fixture metadata.');
  const size = { width: 640, height: 480 }, mapSize = { width: 128, height: 96 };
  const doc = currentDocumentSchema.parse({ ...base, frame: { ...base.frame, master: { ...base.frame.master, size } },
    analysis: { ...base.analysis, depth: { ...base.analysis.depth, map: { ...base.analysis.depth.map, size: mapSize } },
      plate: { ...base.analysis.plate, image: { ...base.analysis.plate.image, size }, forMasks: [object.produced.mask.asset] } },
    style: { ...base.style, fry: 0, simplify: .4, outline: .5, grain: .6, colorNoise: .4, clipping: .4, crunch: .5 },
    symbols: { ...base.symbols, enabled: true, amount: .7 },
    surface: { enabled: true, pattern: 'bars', relief: 1, refraction: 1, shine: .4, scale: .5 },
    motion: { ...base.motion, enabled: false, focus: .2, parallax: 2 },
    objects: [{ ...object, motion: { kind: 'none' }, produced: { ...object.produced,
      bounds: { x: 210, y: 150, width: 220, height: 180 }, mask: { ...object.produced.mask, size: mapSize },
      depth: { p10: .9, median: .9, p90: .9 } } }] });
  const geometry = createPerspectiveGeometry({ aperture: { center: { x: 0, y: 0 }, width: .8, height: .6 },
    crop: .04, neutralDistance: 1, nearFactor: 1.1, farFactor: 2 });
  const eye = constrainEye({ x: .6, y: .1 }, geometry), coverage = liveCoverage(doc, geometry);
  if (coverage === null) throw new Error('No C1 live coverage.');
  const rows = await t.page.evaluate(rowsSchema, async ({ section, documentJson, geometry, eye, key }) => {
    const doc: import('../../../src/core/types.ts').SceneDocument = JSON.parse(documentJson);
    const demo = window.__noisyTest?.demo, renderer = window.__noisyTest?.session?.renderer();
    const stage = document.querySelector('[data-testid="stage"]');
    if (demo === undefined || renderer == null || !(stage instanceof HTMLCanvasElement)) throw new Error('No C1 renderer.');
    const rows: { name: string; pass: boolean; evidence: string }[] = [];
    const check = (name: string, pass: boolean, evidence: unknown = null): void => { rows.push({ name, pass, evidence: JSON.stringify(evidence) }); };
    const originalDocument = JSON.stringify(demo.document()), selected = demo.objects().find((object) => object.selected)?.id ?? null;
    const size = doc.frame.master.size, object = doc.objects[0]; if (object === undefined) throw new Error('No C1 object.');
    const source = document.createElement('canvas'); source.width = size.width; source.height = size.height;
    const ctx = source.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No C1 readback.');
    const raw = ctx.createImageData(size.width, size.height);
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) raw.data.set([
      Math.floor(x * 255 / size.width), Math.floor(y * 255 / size.height), 80 + (Math.floor((x + y) / 16) % 100), 255,
    ], (y * size.width + x) * 4);
    ctx.putImageData(raw, 0, 0);
    const bitmap = await createImageBitmap(source), depthSize = { width: 128, height: 96 };
    const mask = { format: 'u8', size: depthSize, data: new Uint8Array(128 * 96) } satisfies import('../../../src/core/raster.ts').Plane<'u8'>;
    const depth = { format: 'f32', size: depthSize, data: new Float32Array(128 * 96).fill(.2) } satisfies import('../../../src/core/raster.ts').Plane<'f32'>;
    for (let y = 30; y < 66; y++) for (let x = 42; x < 86; x++) { mask.data[y * 128 + x] = 255; depth.data[y * 128 + x] = .9; }
    const hole = { format: 'u8', size, data: new Uint8Array(size.width * size.height) } satisfies import('../../../src/core/raster.ts').Plane<'u8'>;
    const plate = { size, data: new Uint8Array(size.width * size.height * 3) };
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const i = y * size.width + x; plate.data.set([7, 199, 33], i * 3);
      if (x >= 190 && x < 450 && y >= 130 && y < 350) hole.data[i] = 255;
    }
    const scene = { doc, master: bitmap, masks: new Map([[object.id, mask]]), depth, plate, selected: object.id,
      livePlate: { key, image: plate, hole, depth } };
    const request = { geometry, eye, sceneGeneration: 71, viewId: 83, frame: 17, showSelection: true };
    const capture = (): Uint8ClampedArray => { ctx.drawImage(stage, 0, 0); return ctx.getImageData(0, 0, size.width, size.height).data; };
    const rgb = (data: Uint8ClampedArray, at: { x: number; y: number }): number[] => {
      const i = (Math.min(size.height - 1, Math.floor(at.y * size.height)) * size.width + Math.min(size.width - 1, Math.floor(at.x * size.width))) * 4;
      return Array.from(data.subarray(i, i + 3));
    };
    const same = (a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 0): boolean => a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - (b[i] ?? -1000)) <= tolerance);
    const decoded = async (blob: Blob): Promise<Uint8ClampedArray> => {
      const image = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No PNG readback.');
      context.drawImage(image, 0, 0); image.close(); return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const sample = (at: { x: number; y: number }, source: 'edited' | 'source'): number[] | null => {
      const result = renderer.sampleColor({ at, source }); return result.kind === 'sampled' ? [result.color.srgb.r, result.color.srgb.g, result.color.srgb.b] : null;
    };
    const ordinary = { ...scene, doc: { ...doc, surface: { ...doc.surface, enabled: false } } };
    try {
      renderer.setCompare('edited'); renderer.setScene(ordinary); renderer.renderStill();
      if (section === 'color') {
        for (const mode of ['still', 'motion', 'surface', 'perspective']) {
          const active = mode === 'surface' ? scene : mode === 'motion'
            ? { ...ordinary, doc: { ...ordinary.doc, motion: { ...doc.motion, enabled: true } } } : ordinary;
          const draw = (): void => {
            if (mode === 'perspective') renderer.renderPerspective(request);
            else if (mode === 'motion') renderer.renderFrame(17);
            else renderer.renderStill();
          };
          renderer.setScene(active); draw();
          const points = [{ x: .12, y: .23 }, { x: 210 / 640, y: .5 }];
          const entries = points.map((at) => ({ at, value: sample(at, 'edited'), decorated: demo.render?.selectionPixel(Math.floor(at.x * 640), Math.floor(at.y * 480)) }));
          const identity = JSON.stringify(renderer.hitTest(points[0] ?? { x: 0, y: 0 }));
          renderer.setScene({ ...active, selected: null }); draw(); const plain = capture();
          check(`${mode}: Edited samples match selection-free pixels within one byte`, entries.every((item) => item.value !== null && same(item.value, rgb(plain, item.at), 1)), entries);
          check(`${mode}: sample excludes visible selection dimming`, entries.some((item) => item.decorated !== undefined && !same(item.decorated.color, item.decorated.undimmed)) &&
            entries.every((item) => item.decorated !== undefined && item.value !== null && same(item.value, item.decorated.undimmed, 1)), entries);
          renderer.setScene(active); draw();
          check(`${mode}: sampling preserves scene generation and view identity`, JSON.stringify(renderer.hitTest(points[0] ?? { x: 0, y: 0 })) === identity);
          if (mode === 'still') {
            const png = await decoded(await renderer.exportStill());
            check('still: Edited agrees with the decoded PNG', entries.every((item) => item.value !== null && same(item.value, rgb(png, item.at), 1)));
            check('canonical Source equals imported master', points.every((at) => { const value = sample(at, 'source'); return value !== null && same(value, rgb(raw.data, at), 1); }));
          } else if (mode === 'motion') {
            const points = [{ x: .15, y: .2 }, { x: .8, y: .75 }, { x: .5, y: .5 }];
            renderer.setCompare('treatments-off');
            check('Motion Source equals raw geometry away from feather boundaries', points.every((at) => {
              const value = sample(at, 'source'), geometry = demo.render?.geometryPixel(Math.floor(at.x * 640), Math.floor(at.y * 480));
              return value !== null && geometry !== undefined && same(value, geometry.color, 1);
            }));
            renderer.setCompare('edited');
          } else if (mode === 'perspective') {
            check('perspective Source equals master at hitTest sourceUV', points.every((at) => {
              const hit = renderer.hitTest(at), value = sample(at, 'source');
              return hit.kind === 'original' && value !== null && same(value, rgb(raw.data, hit.sourceUV), 1) && hit.sceneGeneration === 71 && hit.viewId === 83;
            }));
          } else {
            const hash = (input: number): number => { let h = input >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
            let moved = 0, count = 0, exact = true;
            for (let px = 45; px < 600; px += 17) {
              const x = px + .5, pitch = (640 * (1 / 60 + (1 / 8 - 1 / 60) * .5)) / .65, cell = Math.floor(x / pitch);
              const widths = hash(doc.seed ^ Math.imul(cell, 0x9e3779b9) ^ 0x243f6a88), motion = hash(doc.seed ^ Math.imul(cell, 0x9e3779b9) ^ 0x13198a2e);
              const width = pitch * (.5 + .3 * (widths & 65535) / 65535) * (1 + (.08 + .12 * (motion >>> 16) / 65535) * Math.sin(2 * Math.PI * (widths >>> 16) / 65535));
              const position = (x - (cell + .5) * pitch) / (width / 2);
              const gradient = Math.abs(position) >= 1 ? 0 : -.35 * position / Math.sqrt(1.125 - position * position);
              const sx = Math.max(0, Math.min(639, Math.floor(x + .02 * 640 * gradient)));
              if (sx !== px) moved++;
              const at = { x: x / 640, y: .2 }, expected = rgb(raw.data, { x: (sx + .5) / 640, y: .2 }), value = sample(at, 'source');
              exact &&= value !== null && same(value, expected, 1); count++;
            }
            check('bars Source follows independently calculated refraction, including moved coordinates', exact && moved > 0, { count, moved, exact });
          }
        }
        const hidden = { ...ordinary, selected: null, doc: { ...ordinary.doc, objects: [{ ...object, hidden: true }] } };
        for (const mode of ['still', 'perspective']) {
          demo.setSampleMode('source');
          renderer.setScene(hidden); if (mode === 'still') renderer.renderStill(); else renderer.renderPerspective(request);
          const before = JSON.stringify(demo.document()), history = JSON.stringify(demo.historyState()), uploads = document.documentElement.dataset['c1Uploads'];
          const result = demo.sampleColor({ x: .5, y: .5 });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          check(`${mode}: generated Source is a typed refusal with visible status`, result.kind === 'refused' && demo.scene().status.includes(result.reason) &&
            document.querySelector('[data-testid="status"]')?.textContent?.includes(result.reason) === true, result);
          const edited = sample({ x: .5, y: .5 }, 'edited');
          check(`${mode}: Edited samples generated visible color`, edited !== null && same(edited, rgb(capture(), { x: .5, y: .5 }), 1), edited);
          check(`${mode}: refusal does not edit, record Undo or upload`, before === JSON.stringify(demo.document()) && history === JSON.stringify(demo.historyState()) && uploads === document.documentElement.dataset['c1Uploads']);
        }
        check('out-of-image sampling is refused', renderer.sampleColor({ at: { x: -1, y: .5 }, source: 'edited' }).kind === 'refused');
        renderer.setScene(scene);
        check('sampling between setScene and draw is refused', renderer.sampleColor({ at: { x: .5, y: .5 }, source: 'edited' }).kind === 'refused');
        renderer.renderPerspective(request); renderer.endPerspective();
        check('sampling between endPerspective and draw is refused', renderer.sampleColor({ at: { x: .5, y: .5 }, source: 'source' }).kind === 'refused');
        const sampleColor = renderer.sampleColor, unchanged = JSON.stringify(demo.document()), history = JSON.stringify(demo.historyState());
        try {
          renderer.sampleColor = () => { throw new Error('C1 injected GPU sample failure.'); };
          const result = demo.sampleColor({ x: .5, y: .5 });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          check('session sampling converts GPU failure into a typed refusal and visible status', result.kind === 'refused' && result.reason === 'C1 injected GPU sample failure.' && demo.scene().status === result.reason &&
            document.querySelector('[data-testid="status"]')?.textContent?.includes(result.reason) === true, result);
          check('sample error leaves document/history unchanged', unchanged === JSON.stringify(demo.document()) && history === JSON.stringify(demo.historyState()));
        } finally { renderer.sampleColor = sampleColor; }
      } else {
        renderer.setScene(scene); renderer.renderStill();
        for (const compare of ['source-photo', 'treatments-off'] satisfies readonly import('../../../src/render/types.ts').CompareMode[]) {
          renderer.setCompare(compare); const pixels = capture();
          let error = 0; for (let i = 0; i < pixels.length; i++) error = Math.max(error, Math.abs((pixels[i] ?? 0) - (raw.data[i] ?? 0)));
          check(`${compare}: every master byte survives all treatments, including Fry zero`, error <= 1, { error, bytes: pixels.length });
        }
        renderer.setScene({ ...scene, doc: { ...doc, motion: { ...doc.motion, enabled: true } } }); renderer.setCompare('source-photo'); renderer.renderFrame(17);
        check('Source photo retains canonical framing during Motion', same(capture(), raw.data, 1));
        renderer.renderPerspective(request);
        check('Source photo retains canonical framing during perspective', same(capture(), raw.data, 1));
        const hidden = { ...scene, selected: null, doc: { ...doc, objects: [{ ...object, hidden: true }] } };
        renderer.setScene(hidden); renderer.setCompare('edited'); renderer.renderPerspective(request); const edited = capture();
        renderer.setCompare('treatments-off'); const treatments = capture(), hiddenHit = renderer.hitTest({ x: .5, y: .5 });
        check('Treatments off keeps moved geometry, hidden silhouette and raw repair', hiddenHit.kind === 'generated' && same(rgb(treatments, { x: .5, y: .5 }), [7, 199, 33], 1), hiddenHit);
        renderer.setCompare('source-photo');
        check('Source photo restores hidden content and original framing', same(capture(), raw.data, 1));
        renderer.setCompare('edited'); check('Edited returns to preceding frame/view pixels exactly', same(edited, capture()));
        renderer.setScene(scene); renderer.setCompare('edited'); renderer.renderPerspective(request);
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
        const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new Error('No loop capture.');
        const captures = async (): Promise<Uint8ClampedArray[]> => {
          const still = await decoded(await renderer.exportStill()), view = await decoded(await renderer.exportView({ x: .02, y: 0 }, 17));
          renderer.exportStill({ frame: 17, canvas }); const loop = context.getImageData(0, 0, 320, 240).data;
          const thumbnailInput = await decoded(await renderer.exportStill()); return [still, view, loop, thumbnailInput];
        };
        const baseline = await captures();
        for (const compare of ['source-photo', 'treatments-off'] satisfies readonly import('../../../src/render/types.ts').CompareMode[]) {
          renderer.setCompare(compare); const before = capture(), identity = JSON.stringify(renderer.hitTest({ x: .2, y: .2 }));
          const exported = await captures();
          for (let i = 0; i < baseline.length; i++) check(`${compare}: ${['still PNG', 'view PNG frame 17', 'loop frame 17', 'Projects thumbnail input'][i]} excludes comparison`, same(baseline[i] ?? [], exported[i] ?? []));
          check(`${compare}: exports restore exact preview and live identity`, same(before, capture()) && identity === JSON.stringify(renderer.hitTest({ x: .2, y: .2 })));
          const original = HTMLCanvasElement.prototype.toBlob;
          let refused = false;
          try {
            HTMLCanvasElement.prototype.toBlob = function (callback): void { callback(null); };
            try { await renderer.exportStill(); } catch { refused = true; }
          } finally { HTMLCanvasElement.prototype.toBlob = original; }
          check(`${compare}: encoding failure restores prior frame/view/pixels`, refused && same(before, capture()) && identity === JSON.stringify(renderer.hitTest({ x: .2, y: .2 })));
          refused = false;
          try { await renderer.exportView({ x: Number.NaN, y: 0 }, 17); } catch { refused = true; }
          check(`${compare}: invalid view capture restores prior frame/view/pixels`, refused && same(before, capture()) && identity === JSON.stringify(renderer.hitTest({ x: .2, y: .2 })));
        }
      }
      check('renderer probes leave serialized session document unchanged', originalDocument === JSON.stringify(demo.document()));
    } finally {
      renderer.setCompare('edited'); renderer.endPerspective(); demo.setSampleMode('edited'); demo.select(null); demo.select(selected); bitmap.close();
    }
    return rows;
  }, { section, documentJson: JSON.stringify(doc), geometry, eye, key: coverage.key });
  for (const row of rows) t.ok(row.name, row.pass, row.evidence);
  await t.file(`c1-${section}-pixels.json`, JSON.stringify(rows, null, 2));
}

async function tapSample(t: ScenarioContext): Promise<void> {
  await t.page.click('[data-testid="color-sampler"]');
  await t.page.evaluate(z.literal(true), async () => {
    const stage = document.querySelector('[data-testid="stage"]');
    if (!(stage instanceof HTMLCanvasElement)) throw new Error('Missing sample stage.');
    const box = stage.getBoundingClientRect(), scale = Math.min(box.width / stage.width, box.height / stage.height);
    const width = stage.width * scale, height = stage.height * scale;
    const x = box.left + (box.width - width) / 2 + width * .12, y = box.top + (box.height - height) / 2 + height * .2;
    if (document.elementFromPoint(x, y) !== stage) throw new Error(`Sampler canvas is covered at ${x}, ${y}.`);
    for (const type of ['pointerdown', 'pointerup', 'click']) stage.dispatchEvent(new PointerEvent(type, {
      pointerId: 991, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, button: 0,
      buttons: type === 'pointerdown' ? 1 : 0, clientX: x, clientY: y,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  });
  await t.page.waitFor('sample waits for explicit Apply', z.literal(true), () => document.querySelector('[data-testid="color-apply"]') !== null ? true : null);
}

const color: Scenario = {
  id: 'creative.c1-color', title: 'Full picker, non-preset round trip and source-aware sampling', target: 'dev', covers: ['C1u', 'C1b-1', 'C1b-2', 'C1b-3', 'C1b-4'], timeoutMs: 300_000,
  async run(t) {
    await setup(t);
    await t.page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setRecolor({ l: .7, c: .4, h: 145 }); return true; });
    await saved(t);
    const before = await state(t);
    await t.page.click('[data-testid="tool-color"]');
    t.equal('opening Color clips only its display, leaving out-of-gamut OKLCH/document/history/uploads unchanged', await state(t), before);
    t.ok('Color exposes its layer target, full controls and all eight named presets', await t.page.evaluate(z.boolean(), () => {
      const panel = document.querySelector('[data-testid="panel-color"]');
      return panel !== null && document.querySelector('[data-testid="tool-color"]')?.getAttribute('aria-expanded') === 'true' &&
        (panel.querySelector('[data-testid="color-target"]')?.textContent?.length ?? 0) > 0 &&
        ['color-sv', 'color-hue', 'color-hex', 'color-sampler', 'sample-mode-edited', 'sample-mode-source', 'color-channel-r', 'color-channel-g', 'color-channel-b'].every((id) => panel.querySelector(`[data-testid="${id}"]`) !== null) &&
        ['Coral', 'Orange', 'Gold', 'Green', 'Turquoise', 'Blue', 'Violet', 'Pink'].every((name) => panel.querySelector(`[aria-label="${name}"]`) !== null);
    }));
    await hex(t, '#2B7DC9');
    const applied = await t.page.evaluate(currentDocumentSchema, () => window.__noisyTest?.demo.document());
    const picked = applied.objects.find((object) => object.recolor.kind === 'target')?.recolor;
    if (picked?.kind !== 'target') throw new Error('Color did not reach the document.');
    const displayed = colorInputFromOklch(picked.color);
    t.ok('non-preset hex keeps exact sRGB channels', displayed.kind === 'valid' && displayed.color.hex === '#2b7dc9' &&
      displayed.color.srgb.r === 43 && displayed.color.srgb.g === 125 && displayed.color.srgb.b === 201, displayed);
    t.equal('hex normalizes to lowercase in the real field', await t.page.evaluate(z.string(), () => {
      const input = document.querySelector('[data-testid="color-hex"]'); return input instanceof HTMLInputElement ? input.value : '';
    }), '#2b7dc9');
    t.equal('current sRGB fields show all three exact bytes', await t.page.evaluate(z.array(z.number()), () => ['r', 'g', 'b'].map((channel) => {
      const input = document.querySelector(`[data-testid="color-channel-${channel}"]`); return input instanceof HTMLInputElement ? Number(input.value) : -1;
    })), [43, 125, 201]);
    await t.page.click('[data-testid="history-undo"]');
    t.equal('Undo restores the preceding recolor', await t.page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document()?.objects.map((object) => object.recolor))),
      JSON.stringify(currentDocumentSchema.parse(JSON.parse(before.document)).objects.map((object) => object.recolor)));
    await t.page.click('[data-testid="history-redo"]');
    t.equal('Redo preserves stored OKLCH without approximation', await t.page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document()?.objects.map((object) => object.recolor))), JSON.stringify(applied.objects.map((object) => object.recolor)));
    await saved(t);
    for (const value of ['#12', '#1234', '#ggg', '2b7dc9', '#2b7dc9 ']) {
      const baseline = await state(t);
      await hex(t, value);
      t.ok(`invalid ${JSON.stringify(value)} displays its reason`, await t.page.evaluate(z.boolean(), () => {
        const error = document.querySelector('[data-testid="color-error"]'); return error !== null && (error.textContent?.length ?? 0) > 0;
      }));
      t.equal(`invalid ${JSON.stringify(value)} changes no document/history/autosave state`, await state(t), baseline);
    }
    await hex(t, '#2b7dc9');
    await captures(t, 'c1-color');
    await t.page.click('[data-testid="projects-toggle"]');
    await t.page.waitFor('saved project row appears', z.literal(true), () => document.querySelector('[data-testid="project-row"] .project-open') !== null ? true : null);
    await t.page.click(`[data-testid="project-row"][data-project-id="${applied.id}"] .project-open`);
    await reopened(t, applied.id);
    t.equal('save/reopen retains exact OKLCH', await t.page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document()?.objects.map((object) => object.recolor))), JSON.stringify(applied.objects.map((object) => object.recolor)));
    await t.page.evaluate(z.literal(true), () => { const demo = window.__noisyTest?.demo, object = demo?.objects().at(-1); if (object === undefined || demo === undefined) throw new Error('No reopened layer.'); demo.select(object.id); return true; });
    await t.page.click('[data-testid="tool-color"]');
    for (const value of ['#102030', '#213141', '#324252', '#435363', '#546474', '#657585', '#768696', '#8797a7', '#98a8b8']) await hex(t, value);
    t.ok('Recent retains the last eight applied session colors', await t.page.evaluate(z.boolean(), () => {
      const labels = Array.from(document.querySelectorAll('[aria-label="Recent colors"] button')).map((button) => button.getAttribute('aria-label'));
      return labels.length === 8 && !labels.includes('Recent #102030') && labels.includes('Recent #98a8b8');
    }));
    await saved(t);
    const beforeUntouchedSample = await state(t);
    await tapSample(t);
    t.ok('sampling returns to Select and leaves an explicit Apply', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.authoringState().tool === 'select' && document.querySelector('[data-testid="color-apply"]') !== null));
    const pending = await t.page.evaluate(z.string(), () => {
      const input = document.querySelector('[data-testid="color-hex"]'); if (!(input instanceof HTMLInputElement)) throw new Error('No sampled hex field.');
      input.focus(); return input.value;
    });
    t.equal('untouched sampled hex stays pending before Enter', await state(t), beforeUntouchedSample);
    await t.page.press('Enter');
    t.ok('Enter applies the untouched sampled hex and clears pending state', await t.page.evaluate(z.boolean(), (expected) => {
      const input = document.querySelector('[data-testid="color-hex"]'); return input instanceof HTMLInputElement && input.value === expected && document.querySelector('[data-testid="color-apply"]') === null;
    }, pending));
    t.equal('Enter on untouched sample records exactly one action', (await state(t)).undo, beforeUntouchedSample.undo + 1);
    await t.page.click('[data-testid="sample-mode-source"]');
    await tapSample(t);
    await t.page.click('[data-testid="panel-color"] [aria-label="Coral"]');
    t.ok('a preset applies directly and clears the pending sample', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.objects().some((object) => object.selected && object.recolor.kind === 'target' && object.recolor.color.h === 25) === true && document.querySelector('[data-testid="color-apply"]') === null));
    await saved(t);
    const beforePendingHex = await state(t);
    await tapSample(t);
    await t.page.evaluate(z.literal(true), () => {
      const input = document.querySelector('[data-testid="color-hex"]'); if (!(input instanceof HTMLInputElement)) throw new Error('No pending hex field.');
      input.focus(); input.value = '#AbC'; input.dispatchEvent(new Event('input', { bubbles: true })); return true;
    });
    t.equal('pending sample and typed valid hex remain uncommitted until Enter', await state(t), beforePendingHex);
    await t.page.press('Enter');
    t.equal('hex Enter applies pending color input with three-digit normalization', await t.page.evaluate(z.string(), () => {
      const input = document.querySelector('[data-testid="color-hex"]'); return input instanceof HTMLInputElement ? input.value : '';
    }), '#aabbcc');
    await t.page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.waitFor('phone Color opener', z.literal(true), () => document.querySelector('.phone-editor [data-testid="tool-color"]') !== null ? true : null);
    await t.page.click('[data-testid="tool-color"]');
    await settleCapture(t);
    await t.page.evaluate(z.literal(true), () => { document.querySelector('[data-testid="color-sv"]')?.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; });
    await settleCapture(t);
    await t.page.screenshot('c1-color-390x844');
    await t.page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.waitFor('full editor restored', z.literal(true), () => document.querySelector('.full-editor') !== null ? true : null);
    await saved(t);
    await rendererChecks(t, 'color');
    await t.page.click('[data-testid="context-bar"] [aria-label="Original"]');
    await saved(t);
    const original = await state(t);
    t.ok('Original layer shows a hollow slash dot and Original picker, without borrowed color values', await t.page.evaluate(z.boolean(), () => {
      const dot = document.querySelector('[data-testid="tool-color"] .color-dot'), current = document.querySelector('[data-testid="color-current"]');
      const input = document.querySelector('[data-testid="color-hex"]');
      return dot instanceof HTMLElement && dot.getAttribute('aria-label') === 'Original color' && dot.querySelector('svg') !== null &&
        getComputedStyle(dot).backgroundColor === 'rgba(0, 0, 0, 0)' && current?.getAttribute('aria-label') === 'Original color' && current.querySelector('svg') !== null &&
        input instanceof HTMLInputElement && input.value === '' && input.placeholder === 'Original' && ['r', 'g', 'b'].every((channel) => {
          const field = document.querySelector(`[data-testid="color-channel-${channel}"]`); return field instanceof HTMLInputElement && field.value === '';
        });
    }));
    await t.page.click('[data-testid="tool-color"]');
    await t.page.click('[data-testid="tool-color"]');
    t.equal('opening Original color adds no document/history/autosave mutation', await state(t), original);
    t.ok('deselecting uses the last applied color only for the unselected dot', await t.page.evaluate(z.boolean(), async () => {
      window.__noisyTest?.demo.select(null); await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const dot = document.querySelector('[data-testid="tool-color"] .color-dot');
      return dot instanceof HTMLElement && dot.querySelector('svg') === null && getComputedStyle(dot).backgroundColor === 'rgb(170, 187, 204)';
    }));
    t.equal('deselecting preserves Original document/history/autosave state', await state(t), original);
  },
};

const compare: Scenario = {
  id: 'creative.c1-compare', title: 'Visible comparisons, full treatment bypass and committed export restoration', target: 'dev', covers: ['C1u', 'C1b-5', 'C1b-6', 'C1b-7', 'C1b-8'], timeoutMs: 300_000,
  async run(t) {
    await setup(t);
    const baseline = await state(t);
    await t.page.click('[data-testid="tool-actions"]');
    await t.page.click('[data-testid="compare-treatments-off"]');
    t.ok('Actions names active Treatments off comparison and Done', await t.page.evaluate(z.boolean(), () => document.querySelector('[data-testid="compare-notice"]')?.textContent?.includes('Comparing: Treatments off') === true && document.querySelector('[data-testid="compare-done"]') !== null && document.querySelector('[data-testid="compare-treatments-off"]')?.getAttribute('aria-pressed') === 'true'));
    await t.page.evaluate(z.literal(true), () => {
      const button = document.querySelector('[data-testid="compare-hold"]'); if (!(button instanceof HTMLButtonElement)) throw new Error('No Compare rail button.');
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 994, isPrimary: true, pointerType: 'touch', button: 0, buttons: 1 })); return true;
    });
    t.equal('holding Compare shows Source photo', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.authoringState().compare ?? ''), 'source-photo');
    await t.page.evaluate(z.literal(true), () => {
      const button = document.querySelector('[data-testid="compare-hold"]'); if (!(button instanceof HTMLButtonElement)) throw new Error('No Compare rail button.');
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 994, isPrimary: true, pointerType: 'touch', button: 0, buttons: 0 })); return true;
    });
    t.equal('release restores preceding persistent comparison', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.authoringState().compare ?? ''), 'treatments-off');
    const holdRows = await t.page.evaluate(rowsSchema, async () => {
      const button = document.querySelector('[data-testid="compare-hold"]'), demo = window.__noisyTest?.demo;
      if (!(button instanceof HTMLButtonElement) || demo === undefined) throw new Error('No Compare hold cue probe.');
      const event = (type: string): void => { button.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 995,
        isPrimary: true, pointerType: 'touch', button: 0, buttons: type === 'pointerdown' ? 1 : 0 })); };
      const before = demo.scene().status;
      event('pointerdown'); await new Promise<void>((resolve) => setTimeout(resolve, 320)); event('pointerup');
      const longHold = { status: demo.scene().status, compare: demo.authoringState().compare };
      event('pointerdown'); event('pointerup');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const shortHold = { status: demo.scene().status, visible: document.querySelector('[data-testid="status"]')?.textContent, compare: demo.authoringState().compare };
      return [
        { name: 'a sustained touch hold restores comparison without replacing status', pass: longHold.status === before && longHold.compare === 'treatments-off', evidence: JSON.stringify(longHold) },
        { name: 'a brief touch release visibly teaches Hold to see the source photo and restores comparison', pass: shortHold.status === 'Hold to see the source photo' &&
          shortHold.visible?.includes(shortHold.status) === true && shortHold.compare === 'treatments-off', evidence: JSON.stringify(shortHold) },
      ];
    });
    for (const row of holdRows) t.ok(row.name, row.pass, row.evidence);
    await t.page.click('[data-testid="compare-source-photo"]');
    await captures(t, 'c1-compare');
    t.equal('comparing never edits, timestamps, records history or uploads', await state(t), baseline);
    await t.page.click('[data-testid="compare-done"]');
    t.ok('Done restores Edited and clears comparison notice', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.authoringState().compare === 'edited' && document.querySelector('[data-testid="compare-notice"]') === null));
    await rendererChecks(t, 'compare');
    // Real Projects thumbnail encoding must use Edited while Source stays visible.
    const thumbnail = await t.page.evaluate(z.object({ exact: z.boolean(), compare: z.string(), id: z.string() }), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No Projects probe.');
      demo.setCompare('source-photo'); demo.setFry(.79);
      const image = await createImageBitmap(await demo.downloadPng()), canvas = document.createElement('canvas');
      const scale = 256 / Math.max(image.width, image.height); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext('2d', { alpha: false }); if (ctx === null) throw new Error('No thumbnail context.');
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
      const expected = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob === null ? reject(new Error('No expected JPEG.')) : resolve(blob), 'image/jpeg', .8));
      const deadline = performance.now() + 60_000;
      while (demo.projects().state !== 'saved' || demo.projects().pendingSaves !== 0) { if (performance.now() > deadline) throw new Error('Thumbnail save timed out.'); await new Promise<void>((resolve) => setTimeout(resolve, 50)); }
      const id = demo.document()?.id; if (id === undefined) throw new Error('No thumbnail project.');
      const actual = await (await fetch(`/api/projects/${id}/thumbnail`)).arrayBuffer(), wanted = new Uint8Array(await expected.arrayBuffer()), got = new Uint8Array(actual);
      return { exact: wanted.length === got.length && wanted.every((value, i) => value === got[i]), compare: demo.authoringState().compare, id };
    });
    t.ok('Projects JPEG bytes contain Edited content while Source remains active', thumbnail.exact && thumbnail.compare === 'source-photo', thumbnail);
    await t.page.click('[data-testid="projects-toggle"]');
    await t.page.waitFor('comparison project row', z.literal(true), () => document.querySelector('[data-testid="project-row"] .project-open') !== null ? true : null);
    await t.page.click(`[data-testid="project-row"][data-project-id="${thumbnail.id}"] .project-open`);
    await reopened(t, thumbnail.id);
    t.ok('save/reopen preserves treatment and resets transient comparison', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.document()?.style.fry === .79 && window.__noisyTest?.demo.authoringState().compare === 'edited'));
    await saved(t);
    // Exercise the user-facing download error boundary, then restore the browser API.
    await t.page.evaluate(z.literal(true), () => {
      const original = HTMLCanvasElement.prototype.toBlob;
      document.addEventListener('c1-restore-encoder', () => { HTMLCanvasElement.prototype.toBlob = original; }, { once: true });
      HTMLCanvasElement.prototype.toBlob = function (callback): void { callback(null); };
      window.__noisyTest?.demo.setCompare('source-photo'); return true;
    });
    try {
      await t.page.click('.top-bar .primary-action');
      await t.page.waitFor('download encoding failure becomes visible status', z.literal(true), () => {
        const status = window.__noisyTest?.demo.scene().status ?? '';
        return /encode|PNG|image|export/i.test(status) && status !== 'Ready' && document.querySelector('[data-testid="status"]')?.textContent?.includes(status) === true ? true : null;
      });
      t.equal('Download shows the existing one-sentence PNG encoding error', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.scene().status ?? ''), 'The rendered PNG could not be encoded.');
      t.equal('failed download preserves active comparison', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.authoringState().compare ?? ''), 'source-photo');
    } finally {
      await t.page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('c1-restore-encoder')); return true; });
    }
  },
};

const history: Scenario = {
  id: 'creative.c1-history', title: 'Explicit gestures, cancellation, keyboard parity and no-mutation sampling', target: 'dev', covers: ['C1u', 'C1b-9'], timeoutMs: 300_000,
  async run(t) {
    await setup(t);
    await t.page.click('[data-testid="tool-color"]');
    t.ok('sample mode starts visibly Edited', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.authoringState().sampleMode === 'edited' && document.querySelector('[data-testid="sample-mode-edited"]')?.getAttribute('aria-pressed') === 'true'));
    await hex(t, '#2b7dc9'); await saved(t);
    const beforeSamples = await state(t);
    for (const mode of ['source', 'edited']) {
      await t.page.click(`[data-testid="sample-mode-${mode}"]`);
      await tapSample(t);
      t.ok(`${mode} stays visibly labeled while sampled color is pending`, await t.page.evaluate(z.boolean(), (mode) => document.querySelector(`[data-testid="sample-mode-${mode}"]`)?.getAttribute('aria-pressed') === 'true', mode));
      t.equal(`${mode} sample is pending without document/history/upload mutation`, await state(t), beforeSamples);
    }
    await t.page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setCompare('source-photo'); window.__noisyTest?.demo.setCompare('treatments-off'); window.__noisyTest?.demo.setCompare('edited'); return true; });
    t.equal('repeated comparisons keep serialized scene/timestamp/history/uploads unchanged', await state(t), beforeSamples);
    await t.page.click('[data-testid="color-apply"]');
    t.equal('Apply records exactly one color action', (await state(t)).undo, beforeSamples.undo + 1);
    await saved(t);
    const gestureRows = await t.page.evaluate(rowsSchema, async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No gesture state.');
      const rows: { name: string; pass: boolean; evidence: string }[] = [];
      const check = (name: string, pass: boolean, evidence: unknown = null): void => { rows.push({ name, pass, evidence: JSON.stringify(evidence) }); };
      const settle = async (): Promise<void> => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const applyHex = async (value: string): Promise<void> => {
        const input = document.querySelector('[data-testid="color-hex"]');
        if (!(input instanceof HTMLInputElement)) throw new Error('No gesture starting-color field.');
        input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await settle();
      };
      const currentColor = () => {
        const recolor = demo.document()?.objects.find((object) => object.id === demo.authoringState().activeLayer)?.recolor;
        return recolor?.kind === 'target' ? recolor.color : null;
      };
      for (const id of ['color-sv', 'color-hue']) {
        if (id === 'color-hue') await applyHex('#2b7dc9');
        let node = document.querySelector(`[data-testid="${id}"]`); if (!(node instanceof HTMLElement)) throw new Error(`Missing ${id}.`);
        check(`${id}: slider exposes name and current/min/max values`, node.getAttribute('role') === 'slider' &&
          (node.getAttribute('aria-label')?.length ?? 0) > 0 && ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].every((attr) => node?.hasAttribute(attr)));
        const initial = demo.historyState().undoDepth, original = JSON.stringify(demo.document());
        const beforeColor = currentColor(), beforeHue = Number(node.getAttribute('aria-valuenow'));
        const box = node.getBoundingClientRect();
        check(`${id}: pointer drag starts on a visible control`, node.checkVisibility() && box.width > 0 && box.height > 0,
          { width: box.width, height: box.height, panelOpen: document.querySelector('[data-testid="tool-color"]')?.getAttribute('aria-expanded') });
        const pointer = (type: string, fraction: number, id = 997): void => { node?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 997, buttons: type === 'pointerup' ? 0 : 1, button: 0, clientX: box.left + box.width * fraction, clientY: box.top + box.height * .4 })); };
        pointer('pointerdown', .2); pointer('pointermove', .4); pointer('pointermove', .7);
        check(`${id}: drag preview changes no committed scene/history`, JSON.stringify(demo.document()) === original && demo.historyState().undoDepth === initial && demo.authoringState().gesture !== null);
        pointer('pointerup', .7); await settle();
        const afterColor = currentColor(), afterHue = Number(node.getAttribute('aria-valuenow'));
        check(`${id}: multiple pointer moves commit exactly one Undo${id === 'color-hue' ? ' and change chromatic hue' : ''}`,
          demo.historyState().undoDepth === initial + 1 && demo.authoringState().gesture === null &&
          (id !== 'color-hue' || (beforeColor !== null && afterColor !== null && beforeColor.c > .01 && afterColor.c > .01 && beforeColor.h !== afterColor.h && beforeHue !== afterHue)),
          { beforeColor, afterColor, beforeHue, afterHue, undoBefore: initial, undoAfter: demo.historyState().undoDepth });
        for (const cancellation of ['Escape', 'pointercancel', 'lostpointercapture', 'second-pointer']) {
          node = document.querySelector(`[data-testid="${id}"]`); if (!(node instanceof HTMLElement)) throw new Error(`Missing ${id}.`);
          const before = JSON.stringify(demo.document()), undo = demo.historyState().undoDepth;
          pointer('pointerdown', .3); pointer('pointermove', .55);
          check(`${id}: ${cancellation} starts with a changed preview`, JSON.stringify(demo.previewDocument()) !== before && demo.authoringState().gesture !== null);
          if (cancellation === 'Escape') node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          else if (cancellation === 'second-pointer') pointer('pointerdown', .8, 998);
          else pointer(cancellation, .55);
          pointer('pointerup', .55); await settle();
          check(`${id}: ${cancellation} restores committed value without history`, JSON.stringify(demo.document()) === before && demo.historyState().undoDepth === undo && demo.authoringState().gesture === null);
          check(`${id}: ${cancellation} keeps Color open`, document.querySelector('[data-testid="tool-color"]')?.getAttribute('aria-expanded') === 'true' && node.checkVisibility());
        }
        for (const key of ['Home', 'ArrowRight', 'ArrowUp', 'End', 'ArrowLeft', 'ArrowDown']) {
          node = document.querySelector(`[data-testid="${id}"]`); if (!(node instanceof HTMLElement)) throw new Error(`Missing ${id}.`);
          const undo = demo.historyState().undoDepth;
          const previous = Number(node.getAttribute('aria-valuenow')), previousValue = Number(/value (\d+)%/.exec(node.getAttribute('aria-valuetext') ?? '')?.[1]);
          node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey: key === 'ArrowLeft' })); await settle();
          const now = Number(node.getAttribute('aria-valuenow')), min = Number(node.getAttribute('aria-valuemin')), max = Number(node.getAttribute('aria-valuemax'));
          check(`${id}: ${key} keyboard action ends its gesture and adds at most one Undo`, demo.authoringState().gesture === null && demo.historyState().undoDepth >= undo && demo.historyState().undoDepth <= undo + 1 && Number.isFinite(now));
          if (key === 'Home' || key === 'End') check(`${id}: ${key} reaches endpoint`, Math.abs(now - (key === 'Home' ? min : max)) < 1, { now, min, max });
          else if (id === 'color-hue' || key === 'ArrowRight' || key === 'ArrowLeft') {
            const delta = key === 'ArrowLeft' ? -10 : key === 'ArrowDown' ? -1 : 1;
            check(`${id}: ${key} honors its ${Math.abs(delta)}-unit step`, Math.abs(now - Math.max(min, Math.min(max, previous + delta))) < 1, { previous, now });
          } else {
            const value = Number(/value (\d+)%/.exec(node.getAttribute('aria-valuetext') ?? '')?.[1]), delta = key === 'ArrowUp' ? 1 : -1;
            check(`${id}: ${key} changes value by one point`, value === Math.max(0, Math.min(100, previousValue + delta)), { previousValue, value });
          }
        }
        if (id === 'color-sv') for (const key of ['Home', 'End']) {
          node.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true })); await settle();
          check(`color-sv: Shift ${key} reaches value endpoint`, node.getAttribute('aria-valuetext')?.includes(`value ${key === 'Home' ? 0 : 100}%`) === true);
        }
        if (id === 'color-hue') {
          await applyHex('#808080');
          const before = JSON.stringify(demo.document()), undo = demo.historyState().undoDepth, gray = currentColor();
          pointer('pointerdown', .2); pointer('pointermove', .4); pointer('pointermove', .7); pointer('pointerup', .7); await settle();
          check('color-hue: achromatic drag is a no-op without history', gray !== null && gray.c < .000001 &&
            JSON.stringify(demo.document()) === before && demo.historyState().undoDepth === undo && demo.authoringState().gesture === null,
            { beforeColor: gray, afterColor: currentColor(), undoBefore: undo, undoAfter: demo.historyState().undoDepth });
        }
      }
      return rows;
    });
    for (const row of gestureRows) t.ok(row.name, row.pass, row.evidence);
    await t.file('c1-gestures.json', JSON.stringify(gestureRows, null, 2));
    await saved(t);
    await t.page.click('[data-testid="tool-color"]');
    const fryRows = await t.page.evaluate(rowsSchema, async () => {
      const demo = window.__noisyTest?.demo, input = document.querySelector('[data-testid="style-fry"]');
      if (demo === undefined || !(input instanceof HTMLInputElement)) throw new Error('No Fry rail.');
      const undo = demo.historyState().undoDepth, doc = JSON.stringify(demo.document());
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 992, isPrimary: true, pointerType: 'touch', button: 0, buttons: 1 }));
      for (const value of ['.2', '.4', '.65']) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
      const preview = JSON.stringify(demo.document()) === doc && demo.historyState().undoDepth === undo;
      input.dispatchEvent(new Event('change', { bubbles: true })); input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 992, isPrimary: true, pointerType: 'touch', button: 0, buttons: 0 }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return [{ name: 'Fry native range keeps previews out of history and commits once across change/pointerup', pass: preview && demo.historyState().undoDepth === undo + 1 && demo.document()?.style.fry === .65, evidence: JSON.stringify(demo.historyState()) }];
    });
    for (const row of fryRows) t.ok(row.name, row.pass, row.evidence);
    t.ok('Escape restores native range value and ignores further input from the cancelled drag', await t.page.evaluate(z.boolean(), async () => {
      const demo = window.__noisyTest?.demo, input = document.querySelector('[data-testid="style-fry"]');
      if (demo === undefined || !(input instanceof HTMLInputElement)) throw new Error('No native range cancellation target.');
      const doc = JSON.stringify(demo.document()), undo = demo.historyState().undoDepth, committed = input.value;
      input.focus();
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 993, isPrimary: true, pointerType: 'touch', button: 0, buttons: 1 }));
      input.value = '.3'; input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      input.value = '.9'; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const ignored = input.value === committed && JSON.stringify(demo.document()) === doc && demo.historyState().undoDepth === undo;
      input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 993, isPrimary: true, pointerType: 'touch', button: 0, buttons: 0 }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ignored && input.value === committed && demo.authoringState().gesture === null;
    }));
    await t.page.click('[data-testid="tool-adjust"]');
    await t.page.click('.node[aria-label="Palette"] .node-disclosure');
    t.ok('RangeControl pointer drag and keyboard input each create one action', await t.page.evaluate(z.boolean(), () => {
      const demo = window.__noisyTest?.demo, input = document.querySelector('[data-testid="style-colors"]');
      if (demo === undefined || !(input instanceof HTMLInputElement)) throw new Error('No palette range.');
      const before = demo.historyState().undoDepth;
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 999, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
      for (const value of ['4', '8', '12']) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
      const preview = demo.historyState().undoDepth === before;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 999, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
      const oneDrag = demo.historyState().undoDepth === before + 1;
      input.value = '11'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      return preview && oneDrag && demo.historyState().undoDepth === before + 2 && demo.document()?.style.colors === 11;
    }));
    await captures(t, 'c1-target');
    t.ok('Adjustments keeps explicit Scene scope', await t.page.evaluate(z.boolean(), () => document.querySelector('[data-testid="panel-adjust"]')?.textContent?.includes('Scene') === true));
    await t.page.click('[data-testid="tool-color"]');
    const targetRows = await t.page.evaluate(rowsSchema, async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No target state.');
      const doc = JSON.stringify(demo.document()), undo = demo.historyState().undoDepth;
      const controls = Array.from(document.querySelectorAll('[data-testid="panel-color"] button')).filter((node) => node instanceof HTMLButtonElement && !node.matches(':disabled'));
      const targets = controls.map((node) => ({ label: node.getAttribute('aria-label') ?? node.textContent, minimum: node.classList.contains('swatch') ? 36 : 44,
        width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
      demo.select(null); await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const target = document.querySelector('[data-testid="color-target"]')?.textContent ?? '';
      const reason = document.querySelector('[data-testid="color-unavailable"]')?.textContent ?? '';
      const disabled = ['color-sv', 'color-hue', 'color-hex', 'color-sampler'].every((id) => {
        const node = document.querySelector(`[data-testid="${id}"]`); return node?.matches(':disabled') || node?.getAttribute('aria-disabled') === 'true';
      });
      return [
        { name: 'no selection shows Select an object, capability reason and disables color operations', pass: target.includes('Select an object') && disabled && reason.includes('requires a layer'), evidence: JSON.stringify({ target, disabled, reason }) },
        { name: 'unavailable target changes no document/history', pass: doc === JSON.stringify(demo.document()) && undo === demo.historyState().undoDepth, evidence: '' },
        { name: 'Color targets meet 44 px; swatches use RS1-design explicit 36 px exception', pass: targets.length >= 12 && targets.every((target) => target.width >= target.minimum && target.height >= target.minimum), evidence: JSON.stringify(targets) },
      ];
    });
    for (const row of targetRows) t.ok(row.name, row.pass, row.evidence);
  },
};

export const scenarios: readonly Scenario[] = [color, compare, history];
