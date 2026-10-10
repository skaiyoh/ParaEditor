import { z } from '../../../src/core/zod.ts';
import { srgbToOklab } from '../../../src/core/color.ts';
import type { Scenario } from '../scenario.ts';

/** 4032 x 3024 source; discs have radius 500 in the 2048 x 1536 master. */
async function fixture(two: boolean): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('Missing object hooks.');
  const source = new OffscreenCanvas(4032, 3024);
  const context = source.getContext('2d');
  if (context === null) throw new Error('No fixture context.');
  const scale = 4032 / 2048;
  context.scale(scale, scale);
  context.fillStyle = '#808080'; context.fillRect(0, 0, 2048, 1536);
  const centers = two ? [{ x: 515, y: 768 }, { x: 1533, y: 768 }] : [{ x: 600, y: 680 }];
  centers.forEach((center, i) => {
    context.fillStyle = i === 0 ? '#ed2637' : '#284af1';
    context.beginPath(); context.arc(center.x, center.y, 500, 0, Math.PI * 2); context.fill();
  });
  const file = new File([await source.convertToBlob({ type: 'image/png' })], 'objects.png', { type: 'image/png' });
  const master = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default',
    resizeWidth: 2048, resizeHeight: 1536, resizeQuality: 'high' });
  const copy = new OffscreenCanvas(2048, 1536), ctx = copy.getContext('2d', { alpha: false, colorSpace: 'srgb', willReadFrequently: true });
  if (ctx === null) throw new Error('No master comparison context.');
  ctx.drawImage(master, 0, 0); master.close();
  const patches = centers.map(({ x, y }) => ({ x: x - 16, y: y - 16, w: 32, h: 32,
    bytes: [...ctx.getImageData(x - 16, y - 16, 32, 32).data] }));
  // Inspect actual flat-background pixels near the first disc's boundary.
  // The antialiased edge gives simplification something to change without
  // replacing the specified flat background with a texture fixture.
  const background = { x: 451, y: 232, w: 128, h: 128, bytes: [...ctx.getImageData(451, 232, 128, 128).data] };
  document.body.dataset['objectsPatches'] = JSON.stringify({ patches, background });
  await demo.importFile(file);
  await demo.tap(600 / 2048, 680 / 1536);
  const earlyStatus = demo.scene().status, earlyObjects = demo.objects().length;
  return { earlyStatus, earlyObjects };
}

const Early = z.object({ earlyStatus: z.string(), earlyObjects: z.number() });
const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const TapResult = z.object({
  elapsedMs: z.number(), count: z.number(), selected: z.boolean(), subject: z.boolean(), boundsWithinDiscMargin: z.boolean(),
  actualBounds: Bounds, expectedDiscBox: Bounds, boundsMargin: z.number(),
  mean: z.object({ L: z.number(), a: z.number(), b: z.number() }),
  edgeDifferences: z.number(), insideScreenEqualsExport: z.boolean(), overlayRestored: z.boolean(),
  deselectedExportEqual: z.boolean(), swatchesVisible: z.boolean(), swatchesHidden: z.boolean(),
  keyboardFocus: z.boolean(), nativeSwatch: z.boolean(), escapeDeselects: z.boolean(),
  changedPoints: z.array(z.boolean()), backgroundUnchanged: z.array(z.boolean()), retapCount: z.number(),
  originalRestored: z.boolean(), capCount: z.number(), capStatus: z.string(), resetCount: z.number(),
  resetProducts: z.object({ masks: z.number(), plates: z.number() }), resetSelected: z.boolean(), resetStatus: z.string(), resetDepth: z.boolean(), resetBytesEqual: z.boolean(),
});

async function tapChecks(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('Missing object hooks.');
  const read = async (blob: Blob): Promise<Uint8ClampedArray> => {
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (context === null) throw new Error('No PNG readback context.');
    context.drawImage(bitmap, 0, 0); bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const hash = async (blob: Blob): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
  // The caller has observed Ready to tap; capture depth outlines before any object tap or edit.
  document.body.dataset['objectsBaseline'] = await hash(await demo.downloadPng());
  const started = performance.now();
  await demo.tap(600 / 2048, 680 / 1536);
  const elapsedMs = performance.now() - started;
  const objects = demo.objects(), object = objects[0], produced = demo.document()?.objects[0]?.produced;
  if (object === undefined || produced === undefined) throw new Error(`Tap created no object: ${demo.scene().status}`);
  const count = objects.length, selected = object.selected, subject = object.subject;
  const b = object.bounds;
  const expectedDiscBox = { x: 100, y: 180, width: 1000, height: 1000 };
  const boundsMargin = 500 * 0.03;
  const right = expectedDiscBox.x + expectedDiscBox.width, bottom = expectedDiscBox.y + expectedDiscBox.height;
  const boundsWithinDiscMargin = b.x <= expectedDiscBox.x + boundsMargin && b.y <= expectedDiscBox.y + boundsMargin
    && b.x + b.width >= right - boundsMargin && b.y + b.height >= bottom - boundsMargin
    && b.x >= expectedDiscBox.x - boundsMargin && b.y >= expectedDiscBox.y - boundsMargin
    && b.x + b.width <= right + boundsMargin && b.y + b.height <= bottom + boundsMargin;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const swatchesVisible = document.querySelector('[data-testid=swatches]') !== null;
  const green = document.querySelector('[data-testid="swatches"] button[aria-label="Green"]');
  const original = document.querySelector('[data-testid="swatches"] button[aria-pressed="true"]');
  if (!(green instanceof HTMLButtonElement) || !(original instanceof HTMLButtonElement)) throw new Error('Missing native swatch buttons.');
  green.focus();
  const keyboardFocus = document.activeElement === green && green.tabIndex === 0;
  const nativeSwatch = green.type === 'button' && !green.disabled;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const escapeDeselects = demo.objects().every((item) => !item.selected) && document.querySelector('[data-testid="swatches"]') === null;
  demo.select(object.id);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const selectedBlob = await demo.downloadPng(), selectedHash = await hash(selectedBlob);
  const exported = await read(selectedBlob);
  const stage = document.querySelector<HTMLCanvasElement>('[data-testid=stage]');
  if (stage === null) throw new Error('Missing stage.');
  const capture = new OffscreenCanvas(stage.width, stage.height), ctx = capture.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (ctx === null) throw new Error('No screen capture context.');
  // Repaint and capture in one task, so WebGL buffer clearing cannot race us.
  demo.select(object.id); ctx.drawImage(stage, 0, 0);
  const screen = ctx.getImageData(0, 0, stage.width, stage.height).data;
  let edgeDifferences = 0;
  for (let y = 150; y <= 1210; y++) for (let x = 70; x <= 1130; x++) {
    const radius = Math.hypot(x - 600, y - 680);
    if (Math.abs(radius - 500) > 30) continue;
    const i = (y * 2048 + x) * 4;
    if (screen[i] !== exported[i] || screen[i + 1] !== exported[i + 1] || screen[i + 2] !== exported[i + 2]) edgeDifferences++;
  }
  const points = [{ x: 600, y: 680 }, { x: 400, y: 680 }, { x: 600, y: 880 }];
  const background = [{ x: 1600, y: 100 }, { x: 1800, y: 1000 }, { x: 200, y: 1450 }];
  const samePixel = (a: Uint8ClampedArray, b: Uint8ClampedArray, p: { x: number; y: number }): boolean => {
    const i = (p.y * 2048 + p.x) * 4;
    return a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3];
  };
  const insideScreenEqualsExport = points.every((p) => samePixel(screen, exported, p));
  // Read again immediately after export to prove that export restored the overlay.
  const pendingExport = demo.downloadPng();
  ctx.drawImage(stage, 0, 0);
  const restored = ctx.getImageData(0, 0, stage.width, stage.height).data;
  const again = await pendingExport;
  const overlayRestored = await hash(again) === selectedHash && screen.every((v, i) => v === restored[i]);
  demo.select(null);
  const deselectedExportEqual = await hash(await demo.downloadPng()) === selectedHash;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const swatchesHidden = document.querySelector('[data-testid=swatches]') === null;
  demo.select(object.id); demo.setRecolor({ l: 0.7, c: 0.18, h: 145 });
  const recolored = await read(await demo.downloadPng());
  const changedPoints = points.map((p) => !samePixel(exported, recolored, p));
  const backgroundUnchanged = background.map((p) => samePixel(exported, recolored, p));
  await demo.tap(600 / 2048, 680 / 1536);
  const retapCount = demo.objects().length;
  demo.setRecolor(null);
  const originalRestored = await hash(await demo.downloadPng()) === selectedHash;
  // Cheap dev masks exercise the ninth-object limit without seven more model decodes.
  for (let i = 0; i < 7; i++) {
    const data = new Uint8Array(1024 * 768);
    for (let y = 20; y < 40; y++) for (let x = 700 + i * 30; x < 720 + i * 30; x++) data[y * 1024 + x] = 255;
    demo.injectMask({ width: 1024, height: 768, data }); await demo.requestPlate();
  }
  await demo.tap(1800 / 2048, 1400 / 1536);
  const capCount = demo.objects().length, capStatus = demo.scene().status;
  demo.reset();
  const resetCount = demo.objects().length, resetStatus = demo.scene().status;
  const resetSelected = demo.objects().some((item) => item.selected);
  const resetProducts = { masks: demo.products().masks, plates: demo.products().plates };
  const resetDepth = demo.analysis().depth;
  const resetBytesEqual = await hash(await demo.downloadPng()) === document.body.dataset['objectsBaseline'];
  return { elapsedMs, count, selected, subject, boundsWithinDiscMargin, actualBounds: b, expectedDiscBox, boundsMargin,
    mean: produced.color.mean, edgeDifferences, insideScreenEqualsExport,
    overlayRestored, deselectedExportEqual, swatchesVisible, swatchesHidden, changedPoints, backgroundUnchanged,
    keyboardFocus, nativeSwatch, escapeDeselects, retapCount, originalRestored, capCount, capStatus, resetCount, resetProducts, resetSelected, resetStatus, resetDepth, resetBytesEqual };
}

const TwoResult = z.object({ count: z.number(), subjects: z.array(z.boolean()), selected: z.array(z.boolean()),
  patchErrors: z.array(z.number()), backgroundPixelsChanged: z.number(), backgroundMaxError: z.number() });

async function twoChecks(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined || demo.render === null) throw new Error('Missing renderer/hooks.');
  await demo.tap(515 / 2048, 0.5); await demo.tap(1533 / 2048, 0.5);
  demo.setStyle({ simplify: 1, subjectClarity: 1 });
  const raw: unknown = JSON.parse(document.body.dataset['objectsPatches'] ?? 'null');
  // The fixture was written by this scenario, but validate before consuming it.
  if (typeof raw !== 'object' || raw === null || !('patches' in raw) || !Array.isArray(raw.patches) || !('background' in raw)) throw new Error('Missing comparison patches.');
  const patchError = (patch: unknown): { max: number; changedGray: number } => {
    if (typeof patch !== 'object' || patch === null || !('x' in patch) || typeof patch.x !== 'number' || !('y' in patch) || typeof patch.y !== 'number'
      || !('w' in patch) || typeof patch.w !== 'number' || !('h' in patch) || typeof patch.h !== 'number' || !('bytes' in patch) || !Array.isArray(patch.bytes)) throw new Error('Invalid patch.');
    const actual = demo.render?.readSimplifiedPatch(patch.x, patch.y, patch.w, patch.h);
    if (actual === undefined) throw new Error('Missing simplified patch.');
    let max = 0, changedGray = 0;
    for (let i = 0; i < actual.length; i += 4) {
      const expected: unknown[] = patch.bytes.slice(i, i + 3);
      if (!expected.every((v) => typeof v === 'number')) throw new Error('Invalid patch bytes.');
      let difference = 0;
      expected.forEach((v, c) => { if (typeof v === 'number') difference = Math.max(difference, Math.abs((actual[i + c] ?? 0) - v)); });
      max = Math.max(max, difference);
      if (expected.every((v) => v === 128) && difference > 0) changedGray++;
    }
    return { max, changedGray };
  };
  const patchErrors = raw.patches.map((patch: unknown) => patchError(patch).max);
  const bg = patchError(raw.background), objects = demo.objects();
  return { count: objects.length, subjects: objects.map((o) => o.subject), selected: objects.map((o) => o.selected),
    patchErrors, backgroundPixelsChanged: bg.changedGray, backgroundMaxError: bg.max };
}

const RefineResult = z.object({
  area: z.number(), asset: z.string(), size: z.number(), maskCount: z.number(), count: z.number(), selected: z.boolean(),
  plateNeeded: z.boolean(), document: z.string(), status: z.string(), candidateAreas: z.array(z.object({ candidate: z.number(), area: z.number() })),
  originalRank: z.number().nullable(), previewArea: z.number().nullable(), previewAsset: z.string().nullable(), refining: z.boolean(), cursor: z.string(),
  unchangedDuringPreview: z.boolean(), cancelledDocumentEqual: z.boolean(), cancelledProductsEqual: z.boolean(),
});

/** Exercise Stage's actual handlers, never call the session's refinement methods. */
async function refineChecks(action: 'baseline' | 'grow' | 'finish' | 'shrink' | 'escape' | 'back' | 'second' | 'cancel' | 'quick' | 'tap'): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  const stage = document.querySelector<HTMLCanvasElement>('[data-testid=stage]');
  if (demo === undefined || stage === null) throw new Error('Missing refinement stage/hooks.');
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const wait = async (predicate: () => boolean): Promise<void> => {
    const deadline = performance.now() + 15_000;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(`Refinement timed out (${action}): ${JSON.stringify(demo.refinement())}`);
      await pause(20);
    }
  };
  if (action === 'baseline') {
    await demo.tap(0.38, 0.58);
    demo.setMotion({ enabled: true, orbit: 0.1 });
    await demo.requestPlate();
  }
  const object = demo.document()?.objects[0];
  if (object === undefined) throw new Error('The sample ball was not selected.');
  const beforeDocument = JSON.stringify(demo.document());
  const beforeProducts = JSON.stringify(demo.projectMasks());
  const box = stage.getBoundingClientRect();
  const x = box.left + box.width * 0.38, y = box.top + box.height * 0.58;
  const primary = action === 'finish' ? Number(document.body.dataset['refinePointer']) : Number(document.body.dataset['refinePointer'] ?? '90') + 2;
  document.body.dataset['refinePointer'] = String(primary);
  const pointer = (type: string, dx = 0, pointerId = primary, target: EventTarget = stage) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: pointerId === primary,
    button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: x + dx, clientY: y,
  }));
  const click = (dx = 0) => stage.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + dx, clientY: y }));
  let candidateAreas: { candidate: number; area: number }[] = [];
  let originalRank: number | null = null;
  let previewArea: number | null = null, previewAsset: string | null = null;
  let unchangedDuringPreview = true;
  if (action === 'finish') {
    pointer('pointerup', 120); click(120);
    await wait(() => demo.refinement() === null);
  } else if (action !== 'baseline') {
    if (action === 'tap') demo.select(null);
    pointer('pointerdown');
    if (action === 'tap') {
      await pause(40); pointer('pointerup'); click(); await pause(50);
    } else if (action === 'quick') {
      pointer('pointermove', 40); await pause(400); pointer('pointerup', 40); click(40); await pause(50);
    } else {
      await pause(390);
      await wait(() => demo.refinement()?.candidateAreas.length === 3);
      const held = demo.refinement();
      candidateAreas = [...(held?.candidateAreas ?? [])]; originalRank = held?.originalRank ?? null;
      const travel = action === 'shrink' ? -120 : action === 'grow' ? 120 : 50;
      pointer('pointermove', travel);
      await wait(() => demo.refinement()?.previewAsset !== null && demo.refinement()?.previewAsset !== undefined);
      previewArea = demo.refinement()?.previewArea ?? null; previewAsset = demo.refinement()?.previewAsset ?? null;
      unchangedDuringPreview = JSON.stringify(demo.document()) === beforeDocument;
      if (action !== 'grow') {
        if (action === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        if (action === 'back') pointer('pointermove');
        if (action === 'second') { pointer('pointerdown', 20, primary + 1, window); pointer('pointerup', 20, primary + 1, window); }
        if (action === 'cancel') pointer('pointercancel', travel);
        pointer('pointerup', action === 'back' ? 0 : travel, primary, action === 'escape' ? window : stage); click(action === 'back' ? 0 : travel);
        await wait(() => demo.refinement() === null);
      }
    }
  }
  const doc = demo.document(), updated = doc?.objects[0];
  const mask = demo.projectMasks().find((entry) => entry.asset === updated?.produced.mask.asset);
  if (updated === undefined || mask === undefined) throw new Error('The committed object mask is missing.');
  return { area: mask.bytes.filter((value) => value >= 128).length, asset: updated.produced.mask.asset, size: updated.produced.selection.size ?? 0.5,
    maskCount: demo.products().masks, count: doc?.objects.length ?? 0, selected: demo.objects()[0]?.selected ?? false,
    plateNeeded: demo.products().plateNeeded, document: JSON.stringify(doc), status: demo.scene().status,
    candidateAreas, originalRank, previewArea, previewAsset, refining: demo.refinement() !== null, cursor: getComputedStyle(stage).cursor,
    unchangedDuringPreview, cancelledDocumentEqual: JSON.stringify(doc) === beforeDocument,
    cancelledProductsEqual: JSON.stringify(demo.projectMasks()) === beforeProducts };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'objects.refine', title: 'hold and drag real sample selection with transient preview, commit and cancellation', target: 'dev', covers: [], timeoutMs: 300_000,
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('object hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
      await t.page.evaluate(z.literal(true), () => {
        const button = document.querySelector('[data-testid=try-sample]');
        if (!(button instanceof HTMLButtonElement)) throw new Error('Missing sample button.');
        button.click(); return true;
      });
      await t.page.waitFor('sample Ready to tap', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady &&
        document.querySelector('[data-testid=status]')?.textContent?.startsWith('Ready to tap') ? true : null, { timeoutMs: 240_000 });
      const before = await t.page.evaluate(RefineResult, refineChecks, 'baseline');
      t.ok('sample ball has one mask and its plate is fresh', before.count === 1 && before.maskCount === 1 && before.area > 0 && !before.plateNeeded, before);
      await t.page.screenshot('refine-before');
      const live = await t.page.evaluate(RefineResult, refineChecks, 'grow');
      t.ok('held move grows resident preview before lift', live.refining && live.previewArea !== null && live.previewArea > before.area && live.previewAsset !== before.asset, live);
      t.equal('preview retains the saved document and fresh plate', [live.unchangedDuringPreview, live.asset, live.plateNeeded], [true, before.asset, false]);
      t.equal('refinement cursor', live.cursor, 'ew-resize');
      t.ok('exactly three area-ordered candidates and an original rank are exposed', live.candidateAreas.length === 3 && live.originalRank !== null &&
        live.candidateAreas.every((entry, i, all) => i === 0 || entry.area >= (all[i - 1]?.area ?? 0)), live);
      const grown = await t.page.evaluate(RefineResult, refineChecks, 'finish');
      t.ok('lift commits a larger mask, new asset and size above .5', grown.area > before.area && grown.asset !== before.asset && grown.size > 0.5, grown);
      t.equal('commit leaves the plate stale and drops the original mask', [grown.plateNeeded, grown.maskCount, grown.refining], [true, 1, false]);
      t.equal('gesture introduces no status sentence', [live.status, grown.status], [before.status, before.status]);
      await t.page.screenshot('refine-grown');
      await t.page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.requestPlate(); return true; });
      const shrunk = await t.page.evaluate(RefineResult, refineChecks, 'shrink');
      t.ok('second gesture shrinks below the original ball area', shrunk.area < before.area && shrunk.size < before.size, shrunk);
      await t.page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.requestPlate(); return true; });
      const cancellations = [];
      for (const action of ['escape', 'back', 'second', 'cancel'] satisfies readonly ('escape' | 'back' | 'second' | 'cancel')[]) {
        const result = await t.page.evaluate(RefineResult, refineChecks, action);
        t.ok(`${action} restores exact document, asset, products and plate`, result.cancelledDocumentEqual && result.cancelledProductsEqual && !result.refining && !result.plateNeeded && result.maskCount === 1, result);
        cancellations.push({ action, result });
      }
      const quick = await t.page.evaluate(RefineResult, refineChecks, 'quick');
      t.ok('movement before hold adds no behavior', quick.cancelledDocumentEqual && quick.cancelledProductsEqual && !quick.refining && quick.count === 1, quick);
      const tapped = await t.page.evaluate(RefineResult, refineChecks, 'tap');
      t.ok('plain tap still selects the existing object', tapped.selected && tapped.count === 1 && tapped.cancelledDocumentEqual && !tapped.refining, tapped);
      await t.file('objects-refine.json', JSON.stringify({ before, live, grown, shrunk, cancellations, quick, tapped,
        sampleChoice: live.originalRank === 1 ? 'decoder candidate 0 is the middle by area' : `decoder candidate 0 has area rank ${live.originalRank}; preserved at imported size ${before.size}` }, null, 2));
    },
  },
  {
    id: 'objects.tap', title: 'real tap, subject products, screen-only selection, recolor, limit and baseline reset', target: 'dev', covers: [], timeoutMs: 300_000,
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('object hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
      const early = await t.page.evaluate(Early, fixture, false);
      t.equal('tap before warming says Still analyzing…', early.earlyStatus, 'Still analyzing…');
      t.equal('early tap is ignored', early.earlyObjects, 0);
      await t.page.waitFor('Ready to tap on screen', z.literal(true), () => {
        const demo = window.__noisyTest?.demo;
        return demo?.analysis().decoderReady && document.querySelector('[data-testid=status]')?.textContent?.startsWith('Ready to tap') ? true : null;
      }, { timeoutMs: 240_000 });
      const result = await t.page.evaluate(TapResult, tapChecks);
      await t.file('objects-tap.json', JSON.stringify(result, null, 2));
      t.ok('first selected object within one second', result.elapsedMs <= 1000 && result.count === 1 && result.selected, result);
      t.equal('every tap creates a subject', result.subject, true);
      t.equal('bounds contain disc shrunk by 3% and stay within disc grown by 3%', result.boundsWithinDiscMargin, true,
        { actualBounds: result.actualBounds, expectedDiscBox: result.expectedDiscBox, boundsMargin: result.boundsMargin });
      const expected = srgbToOklab({ r: 237 / 255, g: 38 / 255, b: 55 / 255 });
      const error = Math.hypot(result.mean.L - expected.L, result.mean.a - expected.a, result.mean.b - expected.b);
      t.ok('masked mean within 0.05 Oklab of disc', error <= 0.05, { error, mean: result.mean, expected });
      t.ok('disc edge has screen-only white selection', result.edgeDifferences > 0, result.edgeDifferences);
      t.equal('well inside the disc screen equals export', result.insideScreenEqualsExport, true);
      t.equal('export restores visible selection overlay', result.overlayRestored, true);
      t.equal('selected and deselected export bytes equal', result.deselectedExportEqual, true);
      t.ok('Green is a focusable native keyboard button and Escape removes selection', result.keyboardFocus && result.nativeSwatch && result.escapeDeselects);
      t.equal('swatch row follows selection', [result.swatchesVisible, result.swatchesHidden], [true, true]);
      t.equal('green swatch changes three disc points', result.changedPoints, [true, true, true]);
      t.equal('three background points unchanged', result.backgroundUnchanged, [true, true, true]);
      t.equal('existing object retap adds no object', result.retapCount, 1);
      t.equal('Original restores object export', result.originalRestored, true);
      t.equal('ninth object tap is refused with prescribed sentence', [result.capCount, result.capStatus], [8, 'That is enough objects for one photo']);
      t.equal('Reset drops objects, masks, plate and selection', [result.resetCount, result.resetProducts, result.resetSelected], [0, { masks: 0, plates: 0 }, false]);
      t.equal('Reset status', result.resetStatus, 'Reset');
      t.equal('Reset retains depth analysis', result.resetDepth, true);
      t.equal('Reset PNG byte-identical to Ready to tap baseline', result.resetBytesEqual, true);
    },
  },
  {
    id: 'objects.two-subjects', title: 'two real-model subjects both keep the master through the label clarity table', target: 'dev', covers: [], timeoutMs: 300_000,
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('object hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
      await t.page.evaluate(Early, fixture, true);
      await t.page.waitFor('warmed decoder', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 240_000 });
      const result = await t.page.evaluate(TwoResult, twoChecks);
      await t.file('objects-two-subjects.json', JSON.stringify(result, null, 2));
      t.equal('two distinct subjects with second selected', [result.count, result.subjects, result.selected], [2, [true, true], [false, true]]);
      t.equal('both subject patches equal master RGB exactly', result.patchErrors, [0, 0]);
      t.ok('flat background pixels in boundary patch change under simplification', result.backgroundPixelsChanged > 0, result);
    },
  },
];
