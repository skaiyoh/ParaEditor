import { z } from '../../../src/core/zod.ts';
import { srgbToOklab } from '../../../src/core/color.ts';
import type { Scenario } from '../scenario.ts';
import { exportThroughSession } from './stereo.scenario.ts';

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
  outsideBefore: z.array(z.number()), outsideSelected: z.array(z.number()), outsideUndimmed: z.array(z.number()), insideSelectionEqual: z.boolean(),
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
  if (demo.render === null) throw new Error('Missing selection probe.');
  const outside = demo.render.selectionPixel(1600, 100);
  const inside = demo.render.selectionPixel(600, 680);
  const insideSelectionEqual = inside.color.every((value, i) => value === inside.undimmed[i]);
  // Read again immediately after export to prove that export restored the overlay.
  const pendingExport = demo.downloadPng();
  ctx.drawImage(stage, 0, 0);
  const restored = ctx.getImageData(0, 0, stage.width, stage.height).data;
  const again = await pendingExport;
  const overlayRestored = await hash(again) === selectedHash && screen.every((v, i) => v === restored[i]);
  demo.select(null);
  const outsideBefore = demo.render.selectionPixel(1600, 100).color;
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
    outsideBefore, outsideSelected: outside.color, outsideUndimmed: outside.undimmed, insideSelectionEqual,
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

const Meter = z.object({
  visible: z.boolean(), text: z.string(), percent: z.number(), expected: z.number().nullable(), fill: z.string(),
  width: z.number(), topInset: z.number(), centerError: z.number(), trackHeight: z.number(), pointerEvents: z.string(),
});
const DimGrowth = z.object({
  x: z.number(), y: z.number(), before: z.array(z.number()), beforeUndimmed: z.array(z.number()),
  after: z.array(z.number()), afterUndimmed: z.array(z.number()),
});
const RefineResult = z.object({
  area: z.number(), asset: z.string(), size: z.number(), maskCount: z.number(), count: z.number(), selected: z.boolean(),
  plateNeeded: z.boolean(), document: z.string(), status: z.string(), candidateAreas: z.array(z.object({ candidate: z.number(), area: z.number() })),
  originalRank: z.number().nullable(), previewArea: z.number().nullable(), previewAsset: z.string().nullable(), refining: z.boolean(), cursor: z.string(),
  unchangedDuringPreview: z.boolean(), cancelledDocumentEqual: z.boolean(), cancelledProductsEqual: z.boolean(),
  meter: Meter, meterOnHold: Meter.nullable(), dimGrowth: DimGrowth.nullable(),
});

/** Exercise Stage's actual handlers, never call the session's refinement methods. */
async function refineChecks(action: 'baseline' | 'grow' | 'finish' | 'shrink' | 'escape' | 'back' | 'second' | 'cancel' | 'quick' | 'tap'): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  const stage = document.querySelector<HTMLCanvasElement>('[data-testid=stage]');
  const renderer = window.__noisyTest?.session?.renderer();
  if (demo === undefined || stage === null || renderer === undefined || renderer === null) throw new Error('Missing refinement stage/hooks.');
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const wait = async (predicate: () => boolean): Promise<void> => {
    const deadline = performance.now() + 15_000;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(`Refinement timed out (${action}): ${JSON.stringify(demo.refinement())}`);
      await pause(20);
    }
  };
  const meter = () => {
    const node = document.querySelector('[data-testid="selection-meter"]');
    const area = document.querySelector('.stage-area, .phone-stage');
    const track = node?.querySelector('.selection-meter-track');
    if (node === null || area === null || track === null || track === undefined) throw new Error('Missing selection meter.');
    const style = getComputedStyle(node), box = node.getBoundingClientRect(), stageBox = area.getBoundingClientRect();
    const size = demo.refinement()?.size;
    return { visible: style.visibility === 'visible' && Number(style.opacity) > 0.99 && node.getAttribute('aria-hidden') === 'false',
      text: node.textContent?.trim() ?? '', percent: Number(node.getAttribute('aria-valuenow')),
      expected: size === undefined ? null : Math.round(100 * size), fill: style.getPropertyValue('--fill').trim(),
      width: box.width, topInset: box.top - stageBox.top, centerError: box.left + box.width / 2 - stageBox.left - stageBox.width / 2,
      trackHeight: track.getBoundingClientRect().height, pointerEvents: style.pointerEvents };
  };
  if (action === 'baseline') {
    await demo.tap(0.38, 0.58);
    demo.setMotion({ enabled: true, drift: { direction: 'circle', amount: 0.1 } });
    await demo.requestPlate();
  }
  const object = demo.document()?.objects[0];
  if (object === undefined) throw new Error('The sample ball was not selected.');
  const beforeDocument = JSON.stringify(demo.document());
  const beforeProducts = JSON.stringify(demo.projectMasks());
  const originalMask = demo.projectMasks().find((entry) => entry.asset === object.produced.mask.asset);
  const readStage = () => {
    const canvas = new OffscreenCanvas(stage.width, stage.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('No refinement screen readback.');
    renderer.renderStill(); ctx.drawImage(stage, 0, 0);
    return ctx.getImageData(0, 0, stage.width, stage.height).data;
  };
  const beforeScreen = action === 'grow' ? readStage() : null;
  const beforeUndimmed = action === 'grow' ? await (async () => {
    const bitmap = await createImageBitmap(await demo.downloadPng(), { colorSpaceConversion: 'none' });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx === null) throw new Error('No refinement export readback.');
      ctx.drawImage(bitmap, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } finally { bitmap.close(); }
  })() : null;
  const box = stage.getBoundingClientRect();
  const contained = getComputedStyle(stage).objectFit === 'contain';
  const scale = Math.min(box.width / stage.width, box.height / stage.height);
  const width = contained ? stage.width * scale : box.width, height = contained ? stage.height * scale : box.height;
  const x = box.left + (box.width - width) / 2 + width * 0.38, y = box.top + (box.height - height) / 2 + height * 0.58;
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
  let meterOnHold: ReturnType<typeof meter> | null = null;
  let dimGrowth: z.infer<typeof DimGrowth> | null = null;
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
      await wait(() => meter().visible);
      meterOnHold = meter();
      await wait(() => demo.refinement()?.candidateAreas.length === 3);
      const held = demo.refinement();
      candidateAreas = [...(held?.candidateAreas ?? [])]; originalRank = held?.originalRank ?? null;
      const travel = action === 'shrink' ? -120 : action === 'grow' ? 120 : 50;
      pointer('pointermove', travel);
      await wait(() => demo.refinement()?.previewAsset !== null && demo.refinement()?.previewAsset !== undefined);
      previewArea = demo.refinement()?.previewArea ?? null; previewAsset = demo.refinement()?.previewAsset ?? null;
      await wait(() => meter().percent === meter().expected);
      unchangedDuringPreview = JSON.stringify(demo.document()) === beforeDocument;
      if (action === 'grow' && beforeScreen !== null && beforeUndimmed !== null && originalMask !== undefined) {
        const preview = demo.refinementMask();
        if (preview === null) throw new Error('Missing refinement preview mask.');
        renderer.renderStill();
        const marginX = Math.ceil(Math.max(1, Math.round(stage.width / box.width)) * preview.width / stage.width);
        const marginY = Math.ceil(Math.max(1, Math.round(stage.height / box.height)) * preview.height / stage.height);
        // A newly included patch, away from both old and new white boundaries.
        // Judge the real preview's mask, rather than assuming a sample contour.
        for (let my = marginY; my < preview.height - marginY && dimGrowth === null; my++) for (let mx = marginX; mx < preview.width - marginX && dimGrowth === null; mx++) {
          const p = my * preview.width + mx;
          if ((preview.bytes[p] ?? 0) < 128) continue;
          let included = true;
          for (let dy = -marginY; dy <= marginY && included; dy++) for (let dx = -marginX; dx <= marginX && included; dx++) {
            const nx = mx + dx, ny = my + dy;
            const ox = Math.floor((nx + .5) * originalMask.width / preview.width);
            const oy = Math.floor((ny + .5) * originalMask.height / preview.height);
            included = (preview.bytes[ny * preview.width + nx] ?? 0) >= 128 && (originalMask.bytes[oy * originalMask.width + ox] ?? 0) < 128;
          }
          if (!included) continue;
          const px = Math.floor((mx + .5) * stage.width / preview.width), py = Math.floor((my + .5) * stage.height / preview.height);
          const i = (py * stage.width + px) * 4;
          const base = Array.from(beforeUndimmed.subarray(i, i + 3));
          if (base.reduce((sum, value) => sum + value, 0) < 60) continue;
          const live = demo.render?.selectionPixel(px, py);
          if (live === undefined) throw new Error('Missing selection pixel probe.');
          dimGrowth = { x: px, y: py, before: Array.from(beforeScreen.subarray(i, i + 3)), beforeUndimmed: base,
            after: [...live.color], afterUndimmed: [...live.undimmed] };
        }
      }
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
  if (action !== 'grow') await pause(160);
  const mask = demo.projectMasks().find((entry) => entry.asset === updated?.produced.mask.asset);
  if (updated === undefined || mask === undefined) throw new Error('The committed object mask is missing.');
  return { area: mask.bytes.filter((value) => value >= 128).length, asset: updated.produced.mask.asset, size: updated.produced.selection.size ?? 0.5,
    maskCount: demo.products().masks, count: doc?.objects.length ?? 0, selected: demo.objects()[0]?.selected ?? false,
    plateNeeded: demo.products().plateNeeded, document: JSON.stringify(doc), status: demo.scene().status,
    candidateAreas, originalRank, previewArea, previewAsset, refining: demo.refinement() !== null, cursor: getComputedStyle(stage).cursor,
    unchangedDuringPreview, cancelledDocumentEqual: JSON.stringify(doc) === beforeDocument,
    cancelledProductsEqual: JSON.stringify(demo.projectMasks()) === beforeProducts, meter: meter(), meterOnHold, dimGrowth };
}

/** Layers are exercised through native controls; hooks only inspect renderer/document products. */
async function layerPixels(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo?.render == null) throw new Error('Missing layer renderer.');
  const pixel = demo.render.selectionPixel(1533, 768);
  const bitmap = await createImageBitmap(await demo.downloadPng(), { colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
  if (context === null) throw new Error('Missing export readback.');
  context.drawImage(bitmap, 0, 0); bitmap.close();
  const exported = [...context.getImageData(1533, 768, 1, 1).data];
  const restored = demo.render.selectionPixel(1533, 768);
  const second = demo.document()?.objects[1];
  return { screen: pixel.color, undimmed: pixel.undimmed, exported,
    exportMatches: exported[3] === 255 && exported.slice(0, 3).every((value, i) => value === pixel.undimmed[i]),
    overlayRestored: restored.color.every((value, i) => value === pixel.color[i]),
    plateLabel: second?.hidden ? demo.render.geometryPixel(1533, 768).label : null,
    plate: demo.products().plateSize === null ? null : demo.platePixel(1533, 768) };
}
const LayerPixels = z.object({ screen: z.array(z.number()), undimmed: z.array(z.number()), exported: z.array(z.number()),
  exportMatches: z.boolean(), overlayRestored: z.boolean(), plateLabel: z.number().nullable(), plate: z.array(z.number()).nullable() });

/** Reveal moved inspector controls without scrolling the editor's clipped ancestors. */
function revealLayerControl(selector: string): true {
  const control = document.querySelector(selector);
  if (!(control instanceof HTMLElement)) throw new Error(`Missing layer control: ${selector}`);
  const body = control.closest('.phone-tools, .floating-panel-body');
  if (body instanceof HTMLElement) {
    const box = control.getBoundingClientRect(), bounds = body.getBoundingClientRect();
    if (box.top < bounds.top + 8) body.scrollTop += box.top - bounds.top - 8;
    else if (box.bottom > bounds.bottom - 8) body.scrollTop += box.bottom - bounds.bottom + 8;
  }
  return true;
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'objects.layers', title: 'Layer names, visibility, deletion and history on desktop and phone', target: 'dev', covers: ['LAY1'], timeoutMs: 600_000,
    async run(t) {
      const { page } = t;
      for (const phone of [false, true]) {
        const frame = phone ? 'phone' : 'desktop';
        await page.emulate({ width: phone ? 402 : 1440, height: phone ? 874 : 900, deviceScaleFactor: 1, mobile: phone, colorScheme: 'dark' });
        await page.goto('/');
        await page.waitFor('layer hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
        if (phone) await page.evaluate(z.literal(true), () => { Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 }); return true; });
        await page.evaluate(Early, fixture, true);
        await page.waitFor('layer decoder ready', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 240_000 });
        await page.evaluate(z.literal(true), async () => {
          const demo = window.__noisyTest?.demo;
          await demo?.tap(515 / 2048, .5); await demo?.tap(1533 / 2048, .5); return true;
        });
        const ids = await page.evaluate(z.array(z.string()).length(2), () => window.__noisyTest?.demo.objects().map((object) => object.id));
        const first = `[data-object-id="${ids[0]}"]`, second = `[data-object-id="${ids[1]}"]`;
        const button = (row: string, action: string): string => `${row} [data-testid="layer-${action}"]`;
        const ancestorScrolls: number[][] = [];
        const clickControl = async (selector: string): Promise<void> => {
          if (!phone && await page.evaluate(z.boolean(), (selector) => {
            const panel = document.querySelector(selector)?.closest('[data-testid=panel-layers]');
            return panel instanceof HTMLElement && panel.hidden;
          }, selector)) await page.click('[data-testid=tool-layers]');
          await page.evaluate(z.literal(true), revealLayerControl, selector);
          await page.click(selector);
          if (phone) ancestorScrolls.push(await page.evaluate(z.array(z.number()), () => {
            const values = [scrollX, scrollY];
            let ancestor = document.querySelector('.phone-tools')?.parentElement;
            while (ancestor !== null && ancestor !== undefined) {
              values.push(ancestor.scrollLeft, ancestor.scrollTop); ancestor = ancestor.parentElement;
            }
            return values;
          }));
        };
        // Layers is a closed secondary node in the shared portrait inspector.
        if (phone) await clickControl('[aria-controls="node-layers"]');
        await clickControl(`${first} .layer-select`);
        const targets = await page.evaluate(z.object({ selects: z.array(z.object({ width: z.number(), height: z.number() })),
          icons: z.array(z.object({ width: z.number(), height: z.number() })), opacity: z.string(), hover: z.boolean() }), (selector) => {
          const row = document.querySelector(selector);
          const size = (element: Element) => {
            const { width, height } = element.getBoundingClientRect(); return { width, height };
          };
          const actions = row?.querySelector('.layer-actions');
          if (actions === undefined || actions === null) throw new Error('Missing row actions.');
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          return { selects: [...document.querySelectorAll('.layer-select')].map(size),
            icons: [...actions.querySelectorAll('button')].map(size), opacity: getComputedStyle(actions).opacity,
            hover: row?.matches(':hover') ?? false };
        }, first);
        t.ok(`${frame}: every layer select target has usable size`, targets.selects.length === 2 &&
          targets.selects.every(({ width, height }) => width >= 44 && height >= 64), targets.selects);
        t.ok(`${frame}: row icons have size and appear on pointer hover`, targets.icons.length === 2 &&
          targets.icons.every(({ width, height }) => width >= 24 && height >= 24) && targets.opacity === '1' && targets.hover, targets);
        t.equal(`${frame}: action ids distinguish row and inspector placements`, await page.evaluate(z.array(z.number()), () =>
          ['layer-hide', 'layer-delete', 'object-hide', 'object-delete'].map((id) => document.querySelectorAll(`[data-testid="${id}"]`).length)), [2, 2, 1, 1]);
        const beginRename = async (): Promise<void> => {
          if (phone) await clickControl('[data-testid="layer-rename"]');
          else await clickControl(`${first} [data-testid="layer-rename"]`);
          await page.waitFor('inline layer name', z.literal(true), () => document.querySelector('[data-testid="layer-name-input"]') === null ? null : true);
          await page.evaluate(z.literal(true), () => {
            const input = document.querySelector('[data-testid="layer-name-input"]');
            if (!(input instanceof HTMLInputElement)) throw new Error('No layer name input.');
            input.select(); return true;
          });
        };
        await beginRename(); await page.press('Backspace');
        await page.type('[data-testid="layer-name-input"]', 'First disc'); await page.press('Enter');
        t.equal(`${frame}: Enter commits the name`, await page.evaluate(z.string(), () => window.__noisyTest?.demo.objects()[0]?.name), 'First disc');
        await beginRename(); await page.press('Backspace');
        await page.type('[data-testid="layer-name-input"]', 'Cancelled'); await page.press('Escape');
        t.equal(`${frame}: Escape cancels without deselecting`, await page.evaluate(z.object({ name: z.string(), selected: z.boolean() }), () => {
          const object = window.__noisyTest?.demo.objects()[0]; return { name: object?.name, selected: object?.selected };
        }), { name: 'First disc', selected: true });
        await beginRename(); await page.press('Backspace'); await page.press('Enter');
        t.equal(`${frame}: empty name rejected`, await page.evaluate(z.literal(true), () =>
          document.querySelector('[data-testid="layer-name-input"]')?.getAttribute('aria-invalid') === 'true' && window.__noisyTest?.demo.objects()[0]?.name === 'First disc'), true);
        await page.press('Escape');
        await beginRename(); await page.press('Backspace'); await page.type('[data-testid="layer-name-input"]', 'Red disc');
        await clickControl(`${second} .layer-select`);
        t.equal(`${frame}: blur commits the name`, await page.evaluate(z.string(), () => window.__noisyTest?.demo.objects()[0]?.name), 'Red disc');
        const before = await page.evaluate(LayerPixels, layerPixels);
        // Observe the real Preparing sentence even when inpaint completes between driver polls.
        await page.evaluate(z.literal(true), () => {
          const observer = new MutationObserver(() => {
            if (document.querySelector('[data-testid="preparing"]')?.textContent === 'Preparing: background') document.body.dataset['layersPreparing'] = 'yes';
            if (document.body.dataset['layersPreparing'] === 'yes') observer.disconnect();
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true }); return true;
        });
        await clickControl(button(second, 'hide'));
        await page.waitFor('hidden layer plate prepared', z.literal(true), () => {
          const demo = window.__noisyTest?.demo;
          return demo?.objects()[1]?.hidden && demo.products().plateSize !== null && !demo.products().plateNeeded &&
            document.querySelector('[data-testid="preparing"]') === null ? true : null;
        }, { timeoutMs: 180_000 });
        const hidden = await page.evaluate(LayerPixels, layerPixels);
        t.ok(`${frame}: hiding prepares a plate, removes object geometry and changes its center`, hidden.plate !== null && hidden.plateLabel === 0 &&
          hidden.undimmed.some((value, i) => value !== before.undimmed[i]), hidden);
        t.equal(`${frame}: Preparing appeared then cleared`, await page.evaluate(z.boolean(), () => document.body.dataset['layersPreparing'] === 'yes'), true);
        t.ok(`${frame}: hidden PNG matches undimmed screen and restores selection overlay`, hidden.exportMatches && hidden.overlayRestored, hidden);
        await clickControl('[data-testid="object-hide"]');
        const shown = await page.evaluate(LayerPixels, layerPixels);
        t.equal(`${frame}: Show restores the center pixel`, shown.undimmed, before.undimmed);
        await clickControl(button(second, 'hide'));
        await clickControl(`${first} .layer-select`);
        // Focus exposes the same icons as hover, also keeping keyboard actions discoverable.
        await page.evaluate(z.literal(true), revealLayerControl, button(first, 'hide'));
        await page.evaluate(z.literal(true), (selector) => {
          const node = document.querySelector(selector); if (node instanceof HTMLButtonElement) node.focus({ preventScroll: true }); return true;
        }, button(first, 'hide'));
        await page.screenshot(phone ? 'layers-phone-402' : 'layers-1440');
        const maskBefore = await page.evaluate(z.string(), () => JSON.stringify([...(window.__noisyTest?.demo.projectMasks() ?? [])].sort((a, b) => a.asset.localeCompare(b.asset))));
        await clickControl(phone ? '[data-testid="object-delete"]' : button(first, 'delete'));
        const deleted = await page.evaluate(z.object({ rows: z.number(), selected: z.boolean(), swatches: z.boolean(), masks: z.number() }), () => ({
          rows: document.querySelectorAll('.layer-row[data-object-id]').length,
          selected: window.__noisyTest?.demo.objects().some((object) => object.selected) ?? true,
          swatches: document.querySelector('[data-testid="swatches"]') !== null, masks: window.__noisyTest?.demo.products().masks,
        }));
        t.equal(`${frame}: delete removes row, selects scene and retains history masks`, deleted, { rows: 1, selected: false, swatches: false, masks: 2 });
        await clickControl('[data-testid="history-undo"]'); await clickControl('[data-testid="history-undo"]');
        t.equal(`${frame}: undo twice restores first and shows second`, await page.evaluate(z.array(z.object({ name: z.string(), hidden: z.boolean() })), () =>
          window.__noisyTest?.demo.objects().map(({ name, hidden }) => ({ name, hidden }))), [{ name: 'Red disc', hidden: false }, { name: 'Object 2', hidden: false }]);
        t.equal(`${frame}: undo restores exact mask bytes`, await page.evaluate(z.string(), () => JSON.stringify([...(window.__noisyTest?.demo.projectMasks() ?? [])].sort((a, b) => a.asset.localeCompare(b.asset)))), maskBefore);
        await clickControl('[data-testid="history-redo"]');
        t.equal(`${frame}: redo hides second`, await page.evaluate(z.boolean(), () => window.__noisyTest?.demo.objects()[1]?.hidden), true);
        if (phone) {
          await clickControl(button(first, 'delete'));
          t.equal('phone: the layer row delete removes the first object', await page.evaluate(z.array(z.string()), () =>
            window.__noisyTest?.demo.objects().map(({ id }) => id)), [ids[1]]);
          await clickControl('[data-testid="history-undo"]');
          t.equal('phone: Undo restores the layer row deletion', await page.evaluate(z.array(z.string()), () =>
            window.__noisyTest?.demo.objects().map(({ id }) => id)), ids);
          t.ok('phone: ancestors stay at zero after every layer and object action', ancestorScrolls.length > 0 &&
            ancestorScrolls.every((values) => values.every((value) => value === 0)), ancestorScrolls);
        }
        if (!phone) {
          await page.evaluate(z.literal(true), () => {
            const range = document.querySelector('[data-testid="style-fry"]');
            if (!(range instanceof HTMLInputElement)) throw new Error('No Fry range.');
            range.focus(); range.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })); return true;
          });
          t.equal('desktop: Cmd-Z shows second', await page.evaluate(z.boolean(), () => window.__noisyTest?.demo.objects()[1]?.hidden), false);
          await page.evaluate(z.literal(true), () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true })); return true; });
          t.equal('desktop: Shift-Ctrl-Z redoes visibility', await page.evaluate(z.boolean(), () => window.__noisyTest?.demo.objects()[1]?.hidden), true);
        }
        await t.file(`layers-${frame}.json`, JSON.stringify({ before, hidden, shown, deleted }, null, 2));
      }
    },
  },
  {
    id: 'objects.refine', title: 'hold and drag real sample selection with transient preview, commit and cancellation', target: 'dev', covers: [], timeoutMs: 300_000,
    async run(t) {
      await t.page.emulate({ width: 402, height: 874, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await t.page.goto('/');
      await t.page.waitFor('object hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
      await t.page.waitFor('phone sample action', z.literal(true), () =>
        [...document.querySelectorAll('.phone-stage .empty-actions button')].some((button) =>
          button instanceof HTMLButtonElement && button.textContent?.trim() === 'Try a sample') ? true : null);
      await t.page.evaluate(z.literal(true), () => {
        const button = [...document.querySelectorAll('.phone-stage .empty-actions button')].find((button) => button.textContent?.trim() === 'Try a sample');
        if (!(button instanceof HTMLButtonElement)) throw new Error('Missing sample button.');
        button.click(); return true;
      });
      await t.page.waitFor('sample Ready to tap', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady &&
        document.querySelector('[data-testid=status]')?.textContent?.startsWith('Ready to tap') ? true : null, { timeoutMs: 240_000 });
      const before = await t.page.evaluate(RefineResult, refineChecks, 'baseline');
      t.ok('sample ball has one mask and its plate is fresh', before.count === 1 && before.maskCount === 1 && before.area > 0 && !before.plateNeeded, before);
      await t.page.screenshot('refine-before');
      const live = await t.page.evaluate(RefineResult, refineChecks, 'grow');
      t.ok('hold displays the starting refinement percentage', live.meterOnHold !== null && live.meterOnHold.visible &&
        live.meterOnHold.percent === Math.round(before.size * 100) && live.meterOnHold.text === `Selection ${live.meterOnHold.percent}%`, live.meterOnHold);
      t.ok('meter follows the right drag to 100%', live.meter.visible && live.meter.percent === 100 && live.meter.expected === 100 &&
        live.meter.text === 'Selection 100%' && live.meter.fill === '100%', live.meter);
      t.ok('phone meter uses the centered stage placement and range vocabulary', live.meter.width === 160 && Math.abs(live.meter.topInset - 12) < .5 &&
        Math.abs(live.meter.centerError) < .5 && live.meter.trackHeight === 6 && live.meter.pointerEvents === 'none', live.meter);
      t.ok('dim leaves a grown preview patch clear before release', live.dimGrowth !== null &&
        live.dimGrowth.before.reduce((sum, value) => sum + value, 0) < live.dimGrowth.beforeUndimmed.reduce((sum, value) => sum + value, 0) &&
        live.dimGrowth.after.every((value, i) => value === live.dimGrowth?.afterUndimmed[i]), live.dimGrowth);
      await t.page.screenshot('selection-meter-402');
      t.ok('held move grows resident preview before lift', live.refining && live.previewArea !== null && live.previewArea > before.area && live.previewAsset !== before.asset, live);
      t.equal('preview retains the saved document and fresh plate', [live.unchangedDuringPreview, live.asset, live.plateNeeded], [true, before.asset, false]);
      t.equal('refinement cursor', live.cursor, 'ew-resize');
      t.ok('exactly three area-ordered candidates and an original rank are exposed', live.candidateAreas.length === 3 && live.originalRank !== null &&
        live.candidateAreas.every((entry, i, all) => i === 0 || entry.area >= (all[i - 1]?.area ?? 0)), live);
      const grown = await t.page.evaluate(RefineResult, refineChecks, 'finish');
      t.equal('meter disappears after release', grown.meter.visible, false);
      t.ok('lift commits a larger mask, new asset and size above .5', grown.area > before.area && grown.asset !== before.asset && grown.size > 0.5, grown);
      t.equal('commit leaves the plate stale and retains the original history mask', [grown.plateNeeded, grown.maskCount, grown.refining], [true, 2, false]);
      t.equal('gesture introduces no status sentence', [live.status, grown.status], [before.status, before.status]);
      await t.page.screenshot('refine-grown');
      await t.page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.requestPlate(); return true; });
      const shrunk = await t.page.evaluate(RefineResult, refineChecks, 'shrink');
      t.ok('second gesture shrinks below the original ball area', shrunk.area < before.area && shrunk.size < before.size, shrunk);
      await t.page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.requestPlate(); return true; });
      const cancellations = [];
      for (const action of ['escape', 'back', 'second', 'cancel'] satisfies readonly ('escape' | 'back' | 'second' | 'cancel')[]) {
        const result = await t.page.evaluate(RefineResult, refineChecks, action);
        t.ok(`${action} restores exact document, asset, products and plate`, result.cancelledDocumentEqual && result.cancelledProductsEqual && !result.refining && !result.plateNeeded && result.maskCount === shrunk.maskCount, result);
        t.equal(`${action} hides the meter`, result.meter.visible, false);
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
      await t.page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
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
      const lab = (rgb: readonly number[]) => srgbToOklab({ r: (rgb[0] ?? 0) / 255, g: (rgb[1] ?? 0) / 255, b: (rgb[2] ?? 0) / 255 });
      const outsideBefore = lab(result.outsideBefore), outsideSelected = lab(result.outsideSelected);
      t.ok('outside selected object is darker and bluer', outsideSelected.L < outsideBefore.L && outsideSelected.b < outsideBefore.b,
        { outsideBefore, outsideSelected, bytes: [result.outsideBefore, result.outsideSelected] });
      t.equal('outside probe input is identical with and without selection', result.outsideUndimmed, result.outsideBefore);
      t.equal('selection probe interior is untouched', result.insideSelectionEqual, true);
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
      await t.page.evaluate(z.literal(true), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('Missing selection hooks.');
        await demo.tap(600 / 2048, 680 / 1536); return true;
      });
      const selectedStereo = await exportThroughSession(t);
      const loopIdentity = await t.page.evaluate(z.literal(true), async () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('Missing loop export hooks.');
        const hash = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
        const selected = await hash(await demo.exportFrame(7));
        demo.select(null);
        return await hash(await demo.exportFrame(7)) === selected;
      });
      t.equal('loop PNG bytes ignore selection', loopIdentity, true);
      const deselectedStereo = await exportThroughSession(t);
      t.equal('selected and deselected stereo left JPEG bytes equal', selectedStereo.leftBytes, deselectedStereo.leftBytes);
      t.equal('selected and deselected stereo right JPEG bytes equal', selectedStereo.rightBytes, deselectedStereo.rightBytes);
      t.equal('selected and deselected complete MPO bytes equal', selectedStereo.mpoBytes, deselectedStereo.mpoBytes);
      await t.page.evaluate(z.literal(true), () => {
        const demo = window.__noisyTest?.demo, id = demo?.objects()[0]?.id;
        if (demo === undefined || id === undefined) throw new Error('Missing selected object.');
        demo.select(id); return true;
      });
      await t.page.screenshot('selection-dim-1440');
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
