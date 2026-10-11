import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';
import { protectedOperation } from './creative-c2.scenario.ts';

const summarySchema = z.object({ count: z.number(), soft: z.number(), asset: z.string().nullable(), space: z.string(), layer: z.string().nullable(), undo: z.number(), effects: z.string(), zoom: z.number(), pan: z.object({ x: z.number(), y: z.number() }) });
async function summary(t: ScenarioContext) {
  return t.page.evaluate(summarySchema, () => {
    const demo = window.__noisyTest?.demo;
    if (demo === undefined) throw new Error('Missing C2 session');
    const selection = demo.selectionState();
    return { count: selection.preview?.bytes.filter(v => v > 0).length ?? 0, soft: selection.preview?.bytes.filter(v => v > 0 && v < 255).length ?? 0,
      asset: selection.selection?.mask.plane.asset ?? null, space: selection.selection?.space.kind ?? '', layer: demo.authoringState().activeLayer,
      undo: demo.historyState().undoDepth, effects: JSON.stringify(demo.document()?.localEffects), zoom: selection.view.zoom, pan: selection.view.pan };
  });
}
async function settled(t: ScenarioContext): Promise<void> {
  await t.page.waitFor('selection hash and UI update', z.literal(true), () => window.__noisyTest?.demo.selectionState().pending === false ? true : null);
  await t.page.evaluate(z.literal(true), async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    return true;
  });
}
async function touch(t: ScenarioContext, selector: string): Promise<void> {
  await t.page.evaluate(z.literal(true), async selector => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (!node.checkVisibility() || !node.contains(document.elementFromPoint(x, y))) throw new Error(`Covered ${selector}: ${document.elementFromPoint(x, y)?.outerHTML}`);
    node.focus({ preventScroll: true });
    for (const type of ['pointerdown', 'pointerup', 'click']) node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 90, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: x, clientY: y }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); return true;
  }, selector);
}
async function setup(t: ScenarioContext): Promise<void> {
  await t.page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await t.page.goto('/');
  await touch(t, '[data-testid="tool-actions"]'); await touch(t, '[data-testid="try-sample"]');
  await t.page.waitFor('sample and real analysis ready', z.literal(true), () => {
    const demo = window.__noisyTest?.demo;
    return demo?.analysis().decoderReady && demo.analysis().depth && !demo.analysis().alive.heavy && demo.document() !== null ? true : null;
  }, { timeoutMs: 180_000 });
  await touch(t, '[data-testid="tool-actions"]');
  await t.page.evaluate(z.literal(true), () => { const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No session'); demo.select(null); demo.setMotion({ enabled: false }); return true; });
  await t.page.evaluate(z.literal(true), () => {
    const demo = window.__noisyTest?.demo, node = document.querySelector('[data-testid="stage"]'), size = demo?.document()?.frame.master.size;
    if (demo === undefined || !(node instanceof HTMLCanvasElement) || size === undefined) throw new Error('Missing sample stage');
    const at = demo.selectionToView({ x: size.width * .38, y: size.height * .585 });
    if (document.elementFromPoint(at.x, at.y) !== node) throw new Error('Sample object tap is covered');
    for (const type of ['pointerdown', 'pointerup', 'click']) node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 89, button: 0, clientX: at.x, clientY: at.y }));
    return true;
  });
  await t.page.waitFor('real UI tap creates the sample object', z.literal(true), () => (window.__noisyTest?.demo.objects().length ?? 0) > 0 ? true : null, { timeoutMs: 60_000 });
  await t.page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.select(null); return true; });
  await touch(t, '[data-testid="tool-selection"]'); await settled(t);
}
async function stroke(t: ScenarioContext, points: readonly (readonly [number, number])[], end: 'up' | 'cancel' | 'escape' | 'second' | 'lost' = 'up'): Promise<void> {
  await t.page.evaluate(z.literal(true), async (points, end) => {
    const demo = window.__noisyTest?.demo, node = document.querySelector('[data-testid="stage"]'), size = demo?.document()?.frame.master.size;
    if (demo === undefined || !(node instanceof HTMLCanvasElement) || size === undefined) throw new Error('No stage');
    const mapped = points.map(([x, y]) => demo.selectionToView({ x: (x ?? 0) * size.width, y: (y ?? 0) * size.height }));
    const first = mapped[0]; if (first === undefined) throw new Error('No points');
    const send = (type: string, point: typeof first, pointerId = 101) => node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: point.x, clientY: point.y }));
    for (const point of mapped) if (document.elementFromPoint(point.x, point.y) !== node) throw new Error(`Covered stroke: ${document.elementFromPoint(point.x, point.y)?.outerHTML}`);
    send('pointerdown', first);
    for (const point of mapped.slice(1)) { send('pointermove', point); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
    const last = mapped.at(-1) ?? first;
    if (end === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (end === 'second') { send('pointerdown', { ...last, x: last.x + 20 }, 102); send('pointerup', last, 102); }
    if (end === 'cancel') send('pointercancel', last);
    if (end === 'lost') send('lostpointercapture', last);
    send('pointerup', last); return true;
  }, points, end);
  await settled(t);
}
const SKY = [[.4, .10], [.65, .26]] satisfies readonly (readonly [number, number])[];
async function range(t: ScenarioContext, selector: string, values: readonly number[]): Promise<void> {
  await t.page.evaluate(z.literal(true), (selector, values) => {
    const node = document.querySelector(selector); if (!(node instanceof HTMLInputElement)) throw new Error(`No ${selector}`);
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (document.elementFromPoint(x, y) !== node) throw new Error(`Covered range ${selector}`);
    const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 103, button: 0, clientX: x, clientY: y };
    node.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    for (const value of values) { node.value = String(value); node.dispatchEvent(new Event('input', { bubbles: true })); }
    node.dispatchEvent(new PointerEvent('pointerup', init)); return true;
  }, selector, values);
  await settled(t);
}
async function hex(t: ScenarioContext, value: string): Promise<void> {
  await t.page.evaluate(z.literal(true), value => {
    const node = document.querySelector('[data-testid="color-hex"]'); if (!(node instanceof HTMLInputElement)) throw new Error('No hex input');
    node.focus(); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, value);
  await t.page.press('Enter'); await settled(t);
}
async function key(t: ScenarioContext, key: string): Promise<void> {
  await t.page.evaluate(z.literal(true), key => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); return true; }, key); await settled(t);
}
async function navigationDraw(t: ScenarioContext, label: string): Promise<void> {
  await settled(t);
  const visible = await t.page.evaluate(z.object({ transformError: z.number(), photoError: z.number(), outlineError: z.number(), readout: z.string(), expectedReadout: z.string() }), () => {
    const demo = window.__noisyTest?.demo, node = document.querySelector('[data-testid="stage"]'), view = demo?.selectionState().view;
    if (demo === undefined || !(node instanceof HTMLCanvasElement) || view === undefined) throw new Error('No rendered authoring view');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform), box = node.getBoundingClientRect();
    const scale = Math.min(box.width / node.width, box.height / node.height);
    const photo = { left: box.x + (box.width - node.width * scale) / 2, top: box.y + (box.height - node.height * scale) / 2, width: node.width * scale, height: node.height * scale };
    const from = demo.selectionToView({ x: 0, y: 0 }), to = demo.selectionToView({ x: view.layout.source.width, y: view.layout.source.height });
    const error = (rect: { left: number; top: number; width: number; height: number }) => Math.max(Math.abs(rect.left - from.x), Math.abs(rect.top - from.y), Math.abs(rect.width - (to.x - from.x)), Math.abs(rect.height - (to.y - from.y)));
    const outline = document.querySelector('[data-testid="selection-outline"]');
    const fit = Math.round(100 * Math.min(view.layout.viewport.width / view.layout.source.width, view.layout.viewport.height / view.layout.source.height));
    return { transformError: Math.max(Math.abs(matrix.a - view.zoom), Math.abs(matrix.e - view.pan.x), Math.abs(matrix.f - view.pan.y)), photoError: error(photo),
      outlineError: outline === null ? 0 : error(outline.getBoundingClientRect()), readout: document.querySelector('[data-testid="authoring-fit"]')?.textContent?.trim() ?? '', expectedReadout: `${Math.round(fit * view.zoom)}%` };
  });
  t.ok(`${label}: photo, outline and Fit agree before another edit`, visible.transformError < .001 && visible.photoError < .1 && visible.outlineError < .1 && visible.readout === visible.expectedReadout, visible);
}
async function compactSelection(t: ScenarioContext, label: string): Promise<void> {
  await settled(t);
  const layout = await t.page.evaluate(z.object({ fits: z.boolean(), rows: z.boolean(), doneVisible: z.boolean(), doneOnTop: z.boolean(), targets44: z.boolean(), ellipsis: z.boolean(), width: z.number(), height: z.number(), barWidth: z.number() }), () => {
    const bar = document.querySelector('[data-testid="selection-bar"]'), choices = bar?.querySelector('.selection-choices'), options = bar?.querySelector('.selection-options'), done = bar?.querySelector('[data-testid="selection-done"]'), space = bar?.querySelector('[data-testid="selection-space"]');
    if (!(bar instanceof HTMLElement) || !(choices instanceof HTMLElement) || !(options instanceof HTMLElement) || !(done instanceof HTMLButtonElement) || !(space instanceof HTMLElement)) throw new Error('No compact Selection controls');
    const box = bar.getBoundingClientRect(), first = choices.getBoundingClientRect(), second = options.getBoundingClientRect(), key = done.getBoundingClientRect();
    const controls = [...bar.querySelectorAll('button, input')].map(node => ({ node, box: node.getBoundingClientRect() }));
    const inView = (rect: DOMRect) => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    return { fits: inView(box) && controls.every(({ box }) => inView(box)) && bar.scrollWidth <= bar.clientWidth,
      rows: innerHeight > 500 ? second.top >= first.bottom && options.contains(space) && options.contains(done) : Math.abs((first.top + first.height / 2) - (second.top + second.height / 2)) < 1,
      doneVisible: done.checkVisibility() && inView(key), doneOnTop: document.elementFromPoint(key.x + key.width / 2, key.y + key.height / 2)?.closest('button') === done,
      targets44: controls.every(({ box }) => box.width >= 44 && box.height >= 44), ellipsis: space.clientWidth > 0 && getComputedStyle(space).textOverflow === 'ellipsis', width: innerWidth, height: innerHeight, barWidth: box.width };
  });
  t.ok(`${label}: Selection rows fit, space ellipsizes, Done is visible and topmost, controls are 44 px`, layout.fits && layout.rows && layout.doneVisible && layout.doneOnTop && layout.targets44 && layout.ellipsis, layout);
}
async function captureMatrix(t: ScenarioContext): Promise<void> {
  const baseline = (await summary(t)).effects;
  for (const frame of [{ width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await t.page.emulate({ ...frame, deviceScaleFactor: 1, mobile: frame.width === 390, colorScheme: 'dark' }); await settled(t);
    if (frame.width === 390) await touch(t, '.sheet-handle');
    await touch(t, '[data-testid="authoring-fit"]');
    await navigationDraw(t, `${frame.width} Selection`);
    if (frame.width === 390) await compactSelection(t, '390 x 844');
    await t.page.screenshot(`${frame.width}-selection`);
    await touch(t, '[data-testid="tool-color"]'); await touch(t, '[data-testid="selection-fill"]'); await hex(t, '#3ac79e');
    if (frame.width === 1180) await t.page.screenshot('1180-color-fill');
    await touch(t, '[data-testid="tool-color"]'); await settled(t); await t.page.screenshot(`${frame.width}-fill`);
    await key(t, '+'); await key(t, '+'); await navigationDraw(t, `${frame.width} zoom`);
    if (frame.width === 390) await compactSelection(t, '390 x 844 zoom');
    await t.page.screenshot(`${frame.width}-zoom`);
    await touch(t, '[data-testid="authoring-fit"]'); await touch(t, '[data-testid="tool-layers"]'); await settled(t);
    if (frame.width === 390) await compactSelection(t, '390 x 844 Layers open');
    await t.page.screenshot(`${frame.width}-overlap`);
    await touch(t, '[data-testid="tool-layers"]');
    if (frame.width === 390) {
      await touch(t, '[data-testid="tool-actions"]'); await settled(t); await t.page.screenshot('390-actions');
      await touch(t, '[data-testid="tool-actions"]');
    }
    await touch(t, '[data-testid="history-undo"]'); await settled(t);
    t.equal(`${frame.width} capture restores untreated selection for the next viewport`, (await summary(t)).effects, baseline);
  }
  await t.page.emulate({ width: 844, height: 390, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' }); await settled(t);
  await touch(t, '[data-testid="authoring-fit"]'); await compactSelection(t, '844 x 390'); await t.page.screenshot('844-selection');
  await touch(t, '[data-testid="tool-layers"]'); await compactSelection(t, '844 x 390 Layers open');
}
const region: Scenario = {
  id: 'creative.c2u-region', title: 'Touch Selection draws arbitrary sky, combines coverage and applies protected local treatment', target: 'dev', covers: ['C2u-2', 'C2u-6', 'C2u-7'], timeoutMs: 360_000,
  async run(t) {
    await setup(t); const before = await summary(t);
    await stroke(t, SKY); const rectangle = await summary(t);
    t.ok('sky rectangle is independent of object selection and one Undo', rectangle.count > 0 && rectangle.layer === null && rectangle.space === 'photo' && rectangle.undo === before.undo + 1, rectangle);
    await touch(t, '[data-testid="selection-freehand"]'); await stroke(t, [[.4, .1], [.63, .12], [.6, .27], [.45, .24], [.4, .1]]);
    const freehand = await summary(t); t.ok('Freehand replaces the sky rectangle', freehand.count > 0 && freehand.asset !== rectangle.asset, freehand);
    await touch(t, '[data-testid="selection-add"]'); await stroke(t, [[.61, .12], [.7, .15], [.65, .3], [.61, .12]]); const added = await summary(t);
    t.ok('Add increases coverage', added.count > freehand.count, added);
    await touch(t, '[data-testid="selection-remove"]'); await stroke(t, [[.44, .13], [.55, .14], [.5, .23], [.44, .13]]); const removed = await summary(t);
    t.ok('Remove decreases coverage', removed.count < added.count && removed.count > 0, removed);
    await touch(t, '[data-testid="selection-invert"]'); const inverted = await summary(t); t.ok('Invert changes to outside region', inverted.count > removed.count, inverted);
    await range(t, '[data-testid="selection-feather"]', [2, 4]); const feathered = await summary(t); t.ok('Feather adds fractional coverage in one Undo', feathered.soft > 0 && feathered.undo === inverted.undo + 1, feathered);
    await touch(t, '[data-testid="selection-clear"]'); await settled(t); t.equal('Clear removes active selection', (await summary(t)).count, 0);
    await touch(t, '[data-testid="selection-rectangle"]'); await touch(t, '[data-testid="selection-replace"]'); await stroke(t, SKY);
    await touch(t, '[data-testid="tool-color"]');
    t.equal('Color target names Selection', await t.page.evaluate(z.string(), () => document.querySelector('[data-testid="color-target"]')?.textContent ?? ''), 'Selection');
    await hex(t, '#e85226');
    const pixels = await t.page.evaluate(z.object({ outside: z.number(), changed: z.number(), maxError: z.number(), operation: z.string() }), () => {
      const demo = window.__noisyTest?.demo, renderer = window.__noisyTest?.session?.renderer(), doc = demo?.document(), effect = doc?.localEffects.at(-1), debug = demo?.render;
      if (renderer == null || doc == null || effect === undefined || debug?.readLocalEffectPatch === undefined || debug.readLocalCoveragePatch === undefined) throw new Error('Missing GPU local patch hooks');
      renderer.renderStill(); const size = doc.frame.master.size, patch = debug.readLocalEffectPatch(0, 0, size.width, size.height), weights = debug.readLocalCoveragePatch(effect.id, 0, 0, size.width, size.height);
      let outside = 0, changed = 0, maxError = 0;
      for (let i = 0; i < weights.length; i += 4) {
        const error = Math.max(...[0, 1, 2].map(c => Math.abs((patch.before[i + c] ?? 0) - (patch.after[i + c] ?? 0))));
        if (weights[i] === 0) { outside++; maxError = Math.max(maxError, error); } else if (error > 1) changed++;
      }
      return { outside, changed, maxError, operation: effect.operation.kind };
    });
    t.ok('real touch rectangle and UI Recolor preserve every weight-0 pixel and visibly change inside', pixels.outside > 0 && pixels.changed > 0 && pixels.maxError === 0 && pixels.operation === 'recolor', pixels);
    await touch(t, '[data-testid="selection-fill"]'); await hex(t, '#38cc98');
    t.ok('Fill uses a frozen selection scope', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.document()?.localEffects.some(effect => effect.operation.kind === 'fill' && effect.scope.kind === 'mask') ?? false));
    await touch(t, '[data-testid="tool-color"]'); await range(t, '[data-testid="selection-clip"]', [.2, .6]);
    t.ok('Clip commits a frozen selection effect', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.document()?.localEffects.some(effect => effect.operation.kind === 'clipping' && effect.operation.amount === .6 && effect.scope.kind === 'mask') ?? false));
    const beforeLayer = await summary(t);
    await touch(t, '[data-testid="tool-layers"]');
    await touch(t, '.layer-select');
    await touch(t, '[data-testid="tool-layers"]');
    /* Identity is observed after the real Layers selection. */
    await t.page.evaluate(z.literal(true), () => { const demo = window.__noisyTest?.demo, layer = demo?.objects()[0]; if (demo === undefined || layer === undefined) throw new Error('No sample object'); demo.select(layer.id); return true; });
    t.equal('selecting a layer leaves selection owner intact', (await summary(t)).asset, beforeLayer.asset);
    t.equal('selection space remains Photo after a layer row changes', await t.page.evaluate(z.string(), () => document.querySelector('[data-testid="selection-space"]')?.textContent ?? ''), 'on Photo');
    await t.page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.select(null); window.__noisyTest?.demo.setOperationTarget({ kind: 'selection' }); return true; });
    // The capture scenario owns the four-viewport evidence matrix.
    // Reuse C2i's exact protectedOperation evaluator without changing its behavior.
    const parity = await protectedOperation(t.page, { layer: false, operation: 'recolor', scoped: true });
    t.ok('C2i protectedOperation shares the same frozen UI selection path', parity.scopeFrozen && parity.rows[0]?.maxError === 0 && (parity.rows[0]?.changed ?? 0) > 0, parity.rows[0]);
    await t.file('region-pixels.json', JSON.stringify(pixels, null, 2));
  },
};
const history: Scenario = {
  id: 'creative.c2u-history', title: 'Touch gestures cancel cleanly, coalesce history, and preserve frozen effects through saved output', target: 'dev', covers: ['C2u-3'], timeoutMs: 300_000,
  async run(t) {
    await setup(t); await stroke(t, SKY); const selected = await summary(t);
    for (const end of ['escape', 'second', 'cancel', 'lost'] satisfies readonly ('escape' | 'second' | 'cancel' | 'lost')[]) {
      await stroke(t, [[.43, .12], [.58, .23]], end); const cancelled = await summary(t);
      t.equal(`${end} cancels without history or mask change`, [cancelled.undo, cancelled.asset], [selected.undo, selected.asset]);
    }
    await key(t, 'Escape'); t.equal('next Escape leaves Selection', await t.page.evaluate(z.string(), () => window.__noisyTest?.demo.authoringState().tool ?? ''), 'select');
    await touch(t, '[data-testid="tool-selection"]'); await touch(t, '[data-testid="tool-color"]'); await hex(t, '#a658e2');
    const colored = await summary(t); t.equal('one hex apply is one Undo', colored.undo, selected.undo + 1);
    await touch(t, '[data-testid="history-undo"]'); t.equal('Undo removes local treatment', (await summary(t)).effects, selected.effects);
    await touch(t, '[data-testid="history-redo"]'); t.equal('Redo restores frozen treatment', (await summary(t)).effects, colored.effects);
    const pickerBefore = await summary(t);
    await t.page.evaluate(z.literal(true), async () => {
      const node = document.querySelector('[data-testid="color-hue"]'); if (!(node instanceof HTMLElement)) throw new Error('No hue');
      const box = node.getBoundingClientRect(), init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 107, button: 0, buttons: 1, clientY: box.y + box.height / 2 };
      if (!node.contains(document.elementFromPoint(box.x + box.width / 2, init.clientY))) throw new Error('Covered picker');
      for (const [type, position] of [['pointerdown', .2], ['pointermove', .4], ['pointermove', .7], ['pointerup', .8]] satisfies readonly (readonly [string, number])[]) { node.dispatchEvent(new PointerEvent(type, { ...init, clientX: box.x + box.width * position })); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); } return true;
    });
    t.equal('picker drag is one Undo', (await summary(t)).undo, pickerBefore.undo + 1);
    await touch(t, '[data-testid="tool-color"]'); await range(t, '[data-testid="selection-clip"]', [.1, .3, .65]);
    const clipped = await summary(t); t.equal('Clip release is one Undo', clipped.undo, pickerBefore.undo + 2);
    await t.page.waitFor('saved frozen selection effects', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' && window.__noisyTest.demo.projects().pendingSaves === 0 ? true : null, { timeoutMs: 90_000 });
    const frozen = await t.page.evaluate(z.object({ id: z.string(), effects: z.string(), png: z.string() }), async () => {
      const demo = window.__noisyTest?.demo, doc = demo?.document(); if (demo === undefined || doc == null) throw new Error('No doc');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
      return { id: doc.id, effects: JSON.stringify(doc.localEffects), png: [...hash].join(',') };
    });
    await t.page.reload();
    t.ok('reopen succeeds', await t.page.evaluate(z.boolean(), async id => await window.__noisyTest?.demo.openProject(id) ?? false, frozen.id));
    const reopened = await t.page.evaluate(z.object({ effects: z.string(), png: z.string(), selection: z.boolean() }), async () => {
      const demo = window.__noisyTest?.demo; if (demo === undefined) throw new Error('No reopened doc');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await demo.downloadPng()).arrayBuffer()));
      return { effects: JSON.stringify(demo.document()?.localEffects), png: [...hash].join(','), selection: demo.selectionState().selection !== null };
    });
    t.equal('frozen local effects and exported PNG survive save/reopen; active selection is session-only', reopened, { effects: frozen.effects, png: frozen.png, selection: false });
  },
};
const navigate: Scenario = {
  id: 'creative.c2u-navigate', title: 'Two-pointer navigation, keyboard zoom and Fit preserve source-space editing', target: 'dev', covers: ['C2u-4'], timeoutMs: 240_000,
  async run(t) {
    await setup(t); const initial = await summary(t); await stroke(t, SKY); const drawn = await summary(t);
    t.equal('view remains fixed under a stroke', [drawn.zoom, drawn.pan], [initial.zoom, initial.pan]);
    await t.page.evaluate(z.literal(true), async () => {
      const node = document.querySelector('[data-testid="stage"]'); if (!(node instanceof HTMLCanvasElement)) throw new Error('No stage');
      const box = node.getBoundingClientRect(), y = box.y + box.height * .35, x = box.x + box.width * .55;
      const send = async (type: string, pointerId: number, cx: number, cy: number) => {
        if (type === 'pointerdown' && document.elementFromPoint(cx, cy) !== node) throw new Error('Covered pinch');
        node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId, button: 0, buttons: 1, clientX: cx, clientY: cy }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      };
      await send('pointerdown', 110, x - 60, y); await send('pointerdown', 111, x + 60, y);
      await send('pointermove', 110, x - 100, y + 24); await send('pointermove', 111, x + 100, y + 24);
      await send('pointerup', 110, x - 100, y + 24); await send('pointerup', 111, x + 100, y + 24); return true;
    });
    const pinched = await summary(t); t.ok('pinch zooms and pans without selection history', pinched.zoom > 1.5 && Math.abs(pinched.pan.y) > 0 && pinched.undo === drawn.undo, pinched);
    await navigationDraw(t, 'Pinch and pan');
    await key(t, '+'); const plus = await summary(t); t.ok('+ increases zoom', plus.zoom > pinched.zoom);
    await key(t, '-'); t.ok('- decreases zoom', (await summary(t)).zoom < plus.zoom);
    await key(t, '0'); t.equal('0 fits', [(await summary(t)).zoom, (await summary(t)).pan], [1, { x: 0, y: 0 }]);
    await navigationDraw(t, 'Keyboard Fit');
    await key(t, '+');
    await stroke(t, [[.45, .12], [.57, .23]]); const zoomDrawn = await summary(t);
    const sample = await t.page.evaluate(z.boolean(), () => {
      const demo = window.__noisyTest?.demo, selection = demo?.selectionState(), size = selection?.preview?.size, bytes = selection?.preview?.bytes;
      if (demo === undefined || size === undefined || bytes === undefined) return false;
      const x = size.width * .5, y = size.height * .18, view = demo.selectionToView({ x, y }), source = demo.selectionToSource(view);
      return Math.abs(source.x - x) < .001 && Math.abs(source.y - y) < .001 && (bytes[Math.floor(y) * size.width + Math.floor(x)] ?? 0) > 0;
    });
    t.ok('zoomed touch selection lands on the intended source point', sample && zoomDrawn.count > 0);
    await touch(t, '[data-testid="authoring-fit"]'); t.equal('Fit button restores center and scale', [(await summary(t)).zoom, (await summary(t)).pan], [1, { x: 0, y: 0 }]);
    await t.page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setSelectionTool('select'); return true; });
    await key(t, '+');
    await navigationDraw(t, 'Zoom before layer tap');
    const hit = await t.page.evaluate(z.boolean(), async () => {
      const demo = window.__noisyTest?.demo, layer = demo?.objects()[0], size = demo?.document()?.frame.master.size, node = document.querySelector('[data-testid="stage"]');
      if (demo === undefined || layer === undefined || size === undefined || !(node instanceof HTMLCanvasElement)) return false;
      const at = demo.selectionToView({ x: layer.bounds.x + layer.bounds.width / 2, y: layer.bounds.y + layer.bounds.height / 2 });
      if (document.elementFromPoint(at.x, at.y) !== node) throw new Error('Covered zoomed layer tap');
      for (const type of ['pointerdown', 'pointerup', 'click']) node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 112, button: 0, clientX: at.x, clientY: at.y }));
      // Neutral taps select through pendingMask's promise queue, then Preact renders.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return demo.authoringState().activeLayer === layer.id;
    });
    t.ok('tap after zoom picks the same source object', hit);
    const visible = await t.page.evaluate(z.object({ zoom: z.number(), rendered: z.number(), panX: z.number(), renderedX: z.number(), panY: z.number(), renderedY: z.number() }), () => {
      const node = document.querySelector('[data-testid="stage"]'), view = window.__noisyTest?.demo.selectionState().view;
      if (!(node instanceof HTMLElement) || view === undefined) throw new Error('No rendered navigation view');
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      return { zoom: view.zoom, rendered: matrix.a, panX: view.pan.x, renderedX: matrix.e, panY: view.pan.y, renderedY: matrix.f };
    });
    t.ok('displayed photo agrees with navigation source coordinates', Math.abs(visible.zoom - visible.rendered) < .001 && Math.abs(visible.panX - visible.renderedX) < .001 && Math.abs(visible.panY - visible.renderedY) < .001, visible);
  },
};
const captures: Scenario = { id: 'creative.c2u-captures', title: 'Selection, Fill, precision and overlap in all four required viewports', target: 'dev', covers: ['C2u-6'], timeoutMs: 300_000,
  async run(t) { await setup(t); await stroke(t, SKY); await captureMatrix(t); },
};
const selectionPixelSchema = z.object({ color: z.array(z.number()), undimmed: z.array(z.number()) });
const selectionReadbackSchema = z.object({ inside: selectionPixelSchema, outside: selectionPixelSchema, coverage: z.number() });
const firstDraw: Scenario = {
  id: 'creative.c2u-selection', title: 'The first Selection stroke dims outside during preview and after release at every supported size',
  target: 'dev', covers: ['SEL1'], timeoutMs: 360_000,
  async run(t) {
    for (const frame of [{ width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await setup(t);
      await t.page.emulate({ ...frame, deviceScaleFactor: 1, mobile: frame.width === 390, colorScheme: 'dark' });
      await settled(t);
      if (frame.width === 390) await touch(t, '.sheet-handle');
      await settled(t);
      await t.page.waitFor('sample autosave finishes before the first selection', z.literal(true), () => {
        const state = window.__noisyTest?.demo.projects();
        return state?.state === 'saved' && state.pendingSaves === 0 ? true : null;
      }, { timeoutMs: 90_000 });
      t.equal(`${frame.width}: fresh selection is empty`, (await summary(t)).count, 0);
      const preview = await t.page.evaluate(selectionReadbackSchema, async () => {
        const demo = window.__noisyTest?.demo, node = document.querySelector('[data-testid="stage"]'), size = demo?.document()?.frame.master.size;
        if (demo?.render == null || size === undefined || !(node instanceof HTMLCanvasElement)) throw new Error('No selection stage');
        const from = demo.selectionToView({ x: size.width * .4, y: size.height * .1 });
        const to = demo.selectionToView({ x: size.width * .65, y: size.height * .26 });
        for (const [type, point] of [['pointerdown', from], ['pointermove', to]] satisfies readonly (readonly [string, { x: number; y: number }])[]) {
          if (document.elementFromPoint(point.x, point.y) !== node) throw new Error('First stroke is covered');
          node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101, button: 0, buttons: 1, clientX: point.x, clientY: point.y }));
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        // Read existing offscreen pixels, without renderStill or a resize that could conceal a missed redraw.
        return { inside: demo.render.selectionPixel(Math.floor(size.width * .5), Math.floor(size.height * .18)),
          outside: demo.render.selectionPixel(Math.floor(size.width * .2), Math.floor(size.height * .15)),
          coverage: demo.selectionState().preview?.bytes.filter(value => value > 0).length ?? 0 };
      });
      await t.page.screenshot(`${frame.width}-first-preview`);
      await t.page.evaluate(z.literal(true), () => {
        const demo = window.__noisyTest?.demo, node = document.querySelector('[data-testid="stage"]'), size = demo?.document()?.frame.master.size;
        if (demo === undefined || size === undefined || !(node instanceof HTMLCanvasElement)) throw new Error('No selection stage');
        const to = demo.selectionToView({ x: size.width * .65, y: size.height * .26 });
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101, button: 0, buttons: 0, clientX: to.x, clientY: to.y }));
        return true;
      });
      await settled(t);
      const committed = await t.page.evaluate(selectionReadbackSchema, () => {
        const demo = window.__noisyTest?.demo, size = demo?.document()?.frame.master.size;
        if (demo?.render == null || size === undefined) throw new Error('No selection readback');
        return { inside: demo.render.selectionPixel(Math.floor(size.width * .5), Math.floor(size.height * .18)),
          outside: demo.render.selectionPixel(Math.floor(size.width * .2), Math.floor(size.height * .15)),
          coverage: demo.selectionState().preview?.bytes.filter(value => value > 0).length ?? 0 };
      });
      await t.page.screenshot(`${frame.width}-first-selection`);
      await t.file(`${frame.width}-first-draw.json`, JSON.stringify({ preview, committed }, null, 2));
      for (const [phase, pixels] of [['preview', preview], ['committed', committed]] satisfies readonly (readonly [string, typeof preview])[]) {
        const outsideDrop = pixels.outside.undimmed.reduce((sum, value, channel) => sum + value - (pixels.outside.color[channel] ?? 0), 0);
        t.ok(`${frame.width} x ${frame.height} first ${phase}: outside dims`, pixels.coverage > 0 && outsideDrop > 60, pixels);
        t.equal(`${frame.width} first ${phase}: inside remains undimmed`, pixels.inside.color, pixels.inside.undimmed);
      }
    }
  },
};
export const scenarios: readonly Scenario[] = [region, history, navigate, captures, firstDraw];
