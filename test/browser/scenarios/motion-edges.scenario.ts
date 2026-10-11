import { z } from 'zod';
import type { Scenario } from '../scenario.ts';
import { fiveClusterDocument } from '../../fixtures/documents.ts';

const metricsSchema = z.object({
  beforeSteps: z.number(), afterSteps: z.number(), beforeHard: z.number(), afterHard: z.number(),
  beforeMax: z.number(), afterMax: z.number(), changed: z.number(), outside: z.number(),
  stillChanged: z.number(), stillOutside: z.number(), labelsChanged: z.number(), wrap: z.boolean(),
  paths: z.array(z.object({ direction: z.string(), offsets: z.array(z.object({ x: z.number(), y: z.number() })) })),
  beforeCrop: z.string(), afterCrop: z.string(), symbolsSoft: z.boolean(), overlapSoft: z.boolean(),
});

export const scenarios: readonly Scenario[] = [{
  id: 'render.motion-edges', title: 'Master-pixel coverage and meaningful Drift controls', target: 'dev', covers: ['MOT1'], timeoutMs: 240_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto(t.baseUrl);
    await page.click('[data-testid="tool-actions"]');
    await page.click('[data-testid="try-sample"]');
    await page.waitFor('sample and analysis ready', z.literal(true), () => {
      const demo = window.__noisyTest?.demo;
      return demo?.analysis().depth && demo.analysis().decoderReady && demo.render !== null ? true : null;
    }, { timeoutMs: 150_000 });
    await page.click('[data-testid="tool-adjust"]');
    await page.click('.inspector .node[aria-label="Motion"] .node-disclosure');
    const controls = await page.evaluate(z.boolean(), async () => {
      const demo = window.__noisyTest?.demo;
      if (demo === undefined) throw new Error('No demo.');
      const next = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (const direction of ['vertical', 'circle', 'side'] as const) {
        const button = document.querySelector(`[data-testid="motion-drift-${direction}"]`);
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click(); await next();
        if (demo.document()?.motion.drift.direction !== direction || button.getAttribute('aria-pressed') !== 'true' || button.getBoundingClientRect().height < 44) return false;
      }
      const amount = document.querySelector('[data-testid="motion-drift-amount"]');
      if (!(amount instanceof HTMLInputElement)) return false;
      amount.value = '.37'; amount.dispatchEvent(new Event('input', { bubbles: true })); await next();
      const labels = Array.from(document.querySelectorAll('.node[aria-label="Motion"] .range-row')).map((row) => row.textContent);
      return demo.document()?.motion.drift.amount === .37 && demo.document()?.motion.drift.direction === 'side' &&
        labels[0]?.startsWith('Depth') === true && labels[1]?.startsWith('Amount') === true && labels[2]?.startsWith('Loop seconds') === true;
    });
    t.ok('Depth, three 44px Drift choices, Amount and Loop seconds update the document', controls);
    await page.click('[data-testid="motion-enabled"]');
    await page.screenshot('motion-node-1440');
    const base = fiveClusterDocument();
    // The bridge accepts JSON, whose members cannot be undefined. Materialize
    // the optional selection-size field without weakening the document's types.
    const fixture = { ...base, objects: base.objects.map((object) => ({ ...object, produced: { ...object.produced,
      selection: { ...object.produced.selection, size: object.produced.selection.size ?? .5 } } })) };
    const result = await page.evaluate(metricsSchema, async (fixture) => {
      const demo = window.__noisyTest?.demo, renderer = window.__noisyTest?.session?.renderer();
      const probe = demo?.render;
      if (demo === undefined || renderer == null || probe == null) throw new Error('No renderer or probe.');
      demo.setMotion({ enabled: false });
      const size = { width: 512, height: 512 };
      const makeMask = (shift = 0) => {
        const data = new Uint8Array(512 * 512);
        for (let y = 64; y < 448; y++) for (let x = 190 + Math.floor((y - 64) / 8) + shift; x < 420; x++) data[y * 512 + x] = 255;
        return { format: 'u8', size, data } as const;
      };
      const mask = makeMask();
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (ctx === null) throw new Error('No canvas.');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 512, 512);
      const master = await createImageBitmap(canvas);
      const first = fixture.objects[0], second = fixture.objects[1], plateRef = fixture.analysis.plate;
      if (first === undefined || second === undefined || plateRef === null) throw new Error('Incomplete fixture.');
      const object = { ...first, recolor: { kind: 'none' } as const, motion: { kind: 'none' } as const, symbols: 'slider' as const,
        produced: { ...first.produced, bounds: { x: 190, y: 64, width: 230, height: 384 }, mask: { ...first.produced.mask, size } } };
      const doc = { ...fixture, frame: { ...fixture.frame, master: { ...fixture.frame.master, size } },
        analysis: { ...fixture.analysis, colors: [{ lab: { L: 0, a: 0, b: 0 }, weight: .5 }, { lab: { L: 1, a: 0, b: 0 }, weight: .5 }] as const,
          plate: { ...plateRef, image: { ...plateRef.image, size }, forMasks: [object.produced.mask.asset] } },
        objects: [object], surface: { ...fixture.surface, enabled: false }, symbols: { enabled: false, cellSize: 12, amount: 0 },
        motion: { enabled: true, drift: { direction: 'circle', amount: 1 } as const, parallax: 1, loopSeconds: 4, focus: 0 },
        style: { ...fixture.style, simplify: 0, grain: 0, colorNoise: 0, outline: 0, crunch: 0, clipping: 0, saturation: 0,
          colors: 2, bands: 2, harmony: { kind: 'auto', strength: 0 } as const, paletteTargets: [] } };
      // Flat near geometry isolates mask coverage from mesh/depth interpolation.
      const scene = { doc, master, masks: new Map([[object.id, mask]]), depth: { format: 'f32', size, data: new Float32Array(512 * 512).fill(1) } as const,
        plate: { size, data: new Uint8Array(512 * 512 * 3) }, selected: null };
      const read = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return ctx.getImageData(0, 0, 512, 512).data;
      };
      const capture = async (feather: boolean, frame = 30) => {
        probe.setMotionFeather(feather); renderer.renderFrame(frame);
        return read(await probe.exportFrame(frame));
      };
      renderer.setScene(scene);
      const before = await capture(false), labelsBefore = probe.readGeometryPatch?.(0, 0, 512, 512);
      const after = await capture(true), labels = probe.readGeometryPatch?.(0, 0, 512, 512);
      if (labels === undefined || labelsBefore === undefined) throw new Error('No geometry labels.');
      const rim = (x: number, y: number, radius: number) => {
        const id = labels[(y * 512 + x) * 4];
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
          const nx = Math.max(0, Math.min(511, x + dx)), ny = Math.max(0, Math.min(511, y + dy));
          if (labels[(ny * 512 + nx) * 4] !== id) return true;
        }
        return false;
      };
      let changed = 0, outside = 0, labelsChanged = 0;
      for (let i = 0; i < before.length; i += 4) {
        if (labels[i] !== labelsBefore[i]) labelsChanged++;
        if (before[i] === after[i] && before[i + 1] === after[i + 1] && before[i + 2] === after[i + 2]) continue;
        changed++; if (!rim((i / 4) % 512, Math.floor(i / 4 / 512), 3)) outside++;
      }
      let low = 255, high = 0;
      for (let y = 132; y < 356; y++) for (let x = 190; x < 254; x++) {
        const value = before[(y * 512 + x) * 4] ?? 0; low = Math.min(low, value); high = Math.max(high, value);
      }
      const measure = (pixels: Uint8ClampedArray) => {
        let hard = 0, max = 0; const rows = new Set<number>();
        for (let y = 132; y < 356; y++) for (let x = 190; x < 254; x++) {
          const step = Math.round(255 * Math.abs((pixels[(y * 512 + x) * 4] ?? 0) - (pixels[((y - 1) * 512 + x) * 4] ?? 0)) / Math.max(1, high - low));
          max = Math.max(max, step);
          if (step === 255) { hard++; rows.add(y); }
        }
        return { hard, max, steps: rows.size };
      };
      const oldJag = measure(before), newJag = measure(after);
      const crop = (pixels: Uint8ClampedArray) => {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), 512, 512), 0, 0);
        const crop = document.createElement('canvas'); crop.width = 200; crop.height = 200;
        const c = crop.getContext('2d'); if (c === null) throw new Error('No crop.');
        c.drawImage(canvas, 140, 150, 200, 200, 0, 0, 200, 200);
        return crop.toDataURL('image/png').split(',')[1] ?? '';
      };
      const beforeCrop = crop(before), afterCrop = crop(after);
      probe.setMotionFeather(false); const stillBefore = await read(await renderer.exportStill());
      probe.setMotionFeather(true); const stillAfter = await read(await renderer.exportStill());
      let stillChanged = 0, stillOutside = 0;
      for (let i = 0; i < stillBefore.length; i += 4) if (stillBefore[i] !== stillAfter[i] || stillBefore[i + 1] !== stillAfter[i + 1] || stillBefore[i + 2] !== stillAfter[i + 2]) {
        stillChanged++;
        const x = (i / 4) % 512, y = Math.floor(i / 4 / 512), id = mask.data[y * 512 + x];
        let near = false;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (mask.data[Math.max(0, Math.min(511, y + dy)) * 512 + Math.max(0, Math.min(511, x + dx))] !== id) near = true;
        if (!near) stillOutside++;
      }
      const paths = [];
      for (const direction of ['side', 'vertical', 'circle'] as const) {
        renderer.setScene({ ...scene, doc: { ...doc, motion: { ...doc.motion, drift: { direction, amount: 1 } } } });
        const offsets = [];
        for (const frame of [0, 30, 60, 90, 120]) { renderer.renderFrame(frame); offsets.push(probe.motionCamera()); }
        paths.push({ direction, offsets });
      }
      renderer.setScene(scene);
      const zero = await capture(true, 0), wrapped = await capture(true, 120);
      const wrap = zero.every((value, i) => value === wrapped[i]);
      renderer.setScene({ ...scene, doc: { ...doc, symbols: { ...doc.symbols, enabled: true } } });
      const symbolPixels = await capture(true);
      // Glyph boundaries inside a layer intentionally stay crisp. Check the
      // mask rim itself has partial coverage after the cell coloring pass.
      let symbolsSoft = false;
      for (let y = 132; y < 356; y++) for (let x = 190; x < 254; x++) {
        const value = symbolPixels[(y * 512 + x) * 4] ?? 0;
        if (rim(x, y, 2) && value > low && value < high) symbolsSoft = true;
      }
      const overlap = { ...object, id: second.id, subject: false, produced: { ...object.produced, mask: second.produced.mask } };
      renderer.setScene({ ...scene, masks: new Map([[object.id, mask], [overlap.id, makeMask(24)]]), doc: { ...doc,
        objects: [object, overlap], analysis: { ...doc.analysis, plate: { ...doc.analysis.plate, forMasks: [object.produced.mask.asset, overlap.produced.mask.asset].sort() } } } });
      const overlapPixels = await capture(true);
      const overlapSoft = measure(overlapPixels).hard === 0;
      probe.setMotionFeather(true);
      return { beforeSteps: oldJag.steps, afterSteps: newJag.steps, beforeHard: oldJag.hard, afterHard: newJag.hard,
        beforeMax: oldJag.max, afterMax: newJag.max, changed, outside, stillChanged, stillOutside, labelsChanged, wrap, paths,
        beforeCrop, afterCrop, symbolsSoft, overlapSoft };
    }, fixture);
    const { beforeCrop, afterCrop, ...metrics } = result;
    await t.file('metrics.json', JSON.stringify(metrics, null, 2));
    await t.file('motion-edge-crop-before.png', Buffer.from(beforeCrop, 'base64'));
    await t.file('motion-edge-crop.png', Buffer.from(afterCrop, 'base64'));
    t.ok('vertical edge has fewer distinct rows with hard coverage steps', result.beforeSteps > result.afterSteps, metrics);
    t.ok('no column jumps straight from 0 to 255 in the composite', result.beforeHard > 0 && result.afterHard === 0, metrics);
    t.ok('moving changes are confined to the two-master-pixel rim after zoom/rasterization', result.changed > 0 && result.outside === 0, metrics);
    t.equal('hard labels are unchanged', result.labelsChanged, 0);
    t.equal('still export differs only within two pixels of the mask boundary', result.stillOutside, 0, { differingPixels: result.stillChanged });
    t.ok('coverage closes exactly at the loop seam', result.wrap);
    t.ok('Symbols keeps the composite edge soft', result.symbolsSoft);
    t.ok('overlapping objects keep the composite edge soft', result.overlapSoft);
    for (const path of result.paths) {
      const expected = [0, .25, .5, .75, 1].map((phase) => {
        const a = 2 * Math.PI * (phase % 1);
        return { x: path.direction === 'vertical' ? 0 : .02 * Math.cos(a), y: path.direction === 'side' ? 0 : .02 * Math.sin(a) };
      });
      t.equal(`${path.direction} camera follows only its selected axes and closes`, path.offsets, expected);
    }
  },
}];
