import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const frames = [{ width: 390, height: 844 }, { width: 844, height: 390 }];

async function resize(t: ScenarioContext, frame: { width: number; height: number }): Promise<void> {
  await t.page.emulate({ ...frame, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
  await t.page.evaluate(z.literal(true), async ({ width, height }) => {
    const deadline = performance.now() + 10_000;
    while (innerWidth !== width || innerHeight !== height || document.querySelector('.phone-editor') === null) {
      if (performance.now() > deadline) throw new Error('Compact viewport did not settle');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return true;
  }, frame);
  await t.page.evaluate(z.literal(true), async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); return true; });
}

/** Synthetic touch checks routing; native thumb tracking is a physical-device check. */
async function touch(t: ScenarioContext, selector: string): Promise<void> {
  await t.page.evaluate(z.literal(true), async (selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
    const scroller = node.closest('.phone-tools');
    if (scroller instanceof HTMLElement) {
      const box = node.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      if (box.top < bounds.top || box.bottom > bounds.bottom) scroller.scrollTop += box.top - bounds.top;
    }
    const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (!node.checkVisibility() || !node.contains(document.elementFromPoint(x, y))) throw new Error(`Covered touch target ${selector}: ${document.elementFromPoint(x, y)?.outerHTML}`);
    node.focus({ preventScroll: true });
    for (const type of ['pointerdown', 'pointerup', 'click']) node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 91, isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: x, clientY: y }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  }, selector);
}

async function select(t: ScenarioContext): Promise<void> {
  await t.page.evaluate(z.literal(true), () => {
    const canvas = document.querySelector('[data-testid="stage"]');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing stage');
    const box = canvas.getBoundingClientRect(), scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    const width = canvas.width * scale, height = canvas.height * scale;
    const x = box.left + (box.width - width) / 2 + width * .38, y = box.top + (box.height - height) / 2 + height * .585;
    if (document.elementFromPoint(x, y) !== canvas) throw new Error('Stage selection is covered');
    for (const type of ['pointerdown', 'pointerup', 'click']) canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 93, isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: x, clientY: y }));
    return true;
  });
  await t.page.waitFor('selection collapses sheet', z.literal(true), () => document.querySelector('[data-testid="context-bar"]') !== null && document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false' ? true : null, { timeoutMs: 30_000 });
}

async function surfaces(t: ScenarioContext, label: string): Promise<void> {
  const results = await t.page.evaluate(z.array(z.object({ selector: z.string(), pass: z.boolean(), detail: z.string() })), () => [
    '[data-testid="fry-rail"]', '[data-testid="mode-pill"]', '[data-testid="context-bar"]', '.phone-strip .primary-action', '.phone-sheet-heading',
  ].map((selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`Missing surface ${selector}`);
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { selector, pass: node.contains(hit) && box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth, detail: JSON.stringify({ box: box.toJSON(), hit: hit?.outerHTML.slice(0, 120) }) };
  }));
  for (const result of results) t.ok(`${label}: ${result.selector} wins its center hit test`, result.pass, result.detail);
  t.ok(`${label}: context uses orientation-appropriate rows, Original plus eight 36 px circles with 4 px gaps`, await t.page.evaluate(z.boolean(), () => {
    const name = document.querySelector('.context-name')?.getBoundingClientRect(), swatches = [...document.querySelectorAll('.context-bar .swatch-actions button, .context-bar .swatch')];
    const boxes = swatches.map((node) => node.getBoundingClientRect());
    const landscape = matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    return name !== undefined && boxes.length === 9 && boxes.every((box, i) => (landscape ? Math.abs(box.top + box.height / 2 - name.top - name.height / 2) < .5 : box.top >= name.bottom) && box.top === boxes[0]?.top && box.width === 36 && box.height === 36 && (i === 0 || Math.abs(box.left - (boxes[i - 1]?.right ?? 0) - 4) < .5)) && swatches.every((node) => getComputedStyle(node).borderRadius === '50%');
  }));
}

async function landscapePicture(t: ScenarioContext, state: string): Promise<void> {
  const result = await t.page.evaluate(z.object({ uncovered: z.boolean(), pillFits: z.boolean(), barHeight: z.number(), detail: z.string() }), () => {
    const canvas = document.querySelector('[data-testid="stage"]');
    const object = window.__noisyTest?.demo.objects().find((item) => item.selected);
    const size = window.__noisyTest?.demo.document()?.frame.master.size;
    const context = document.querySelector('.context-bar')?.getBoundingClientRect();
    const pill = document.querySelector('.mode-pill')?.getBoundingClientRect();
    const color = document.querySelector('[data-testid="tool-color"]')?.getBoundingClientRect();
    const download = document.querySelector('.phone-strip .primary-action')?.getBoundingClientRect();
    if (!(canvas instanceof HTMLCanvasElement) || object === undefined || size === undefined || context === undefined || pill === undefined || color === undefined || download === undefined) throw new Error('Missing landscape selection or controls');
    const box = canvas.getBoundingClientRect(), scale = Math.min(box.width / size.width, box.height / size.height);
    const x = box.left + (box.width - size.width * scale) / 2 + (object.bounds.x + object.bounds.width / 2) * scale;
    const y = box.top + (box.height - size.height * scale) / 2 + (object.bounds.y + object.bounds.height / 2) * scale;
    const hit = document.elementFromPoint(x, y);
    const controls = [...document.querySelectorAll('.mode-pill button')];
    const pillFits = pill.left >= color.right && pill.right <= download.left && pill.top >= 0 && pill.bottom <= 52 &&
      document.querySelector('[data-testid="parallax-enabled"]')?.getAttribute('aria-pressed') === 'true' &&
      document.querySelector('[data-testid="parallax-recenter-quick"]') !== null && controls.every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 44 && rect.height >= 44 && rect.left >= pill.left && rect.right <= pill.right && node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      });
    return { uncovered: hit === canvas, pillFits, barHeight: context.height, detail: JSON.stringify({ x, y, hit: hit?.outerHTML.slice(0, 120), context: context.toJSON(), pill: pill.toJSON() }) };
  });
  t.ok(`844x390 ${state}: selected object's center is the top element at its point`, result.uncovered, result.detail);
  t.ok(`844x390 ${state}: Parallax and Recenter fit between Color and Download`, result.pillFits, result.detail);
  t.ok(`844x390 ${state}: one context row covers at most 52 px of picture`, result.barHeight <= 52, result.detail);
}

async function motionOpen(t: ScenarioContext, label: string): Promise<void> {
  await t.page.waitFor(`${label}: Motion opens Adjust with its export row visible`, z.literal(true), () => {
    const body = document.querySelector('#panel-adjust'), row = body?.querySelector('.motion-export');
    if (!(body instanceof HTMLElement) || !(row instanceof HTMLElement) || !row.checkVisibility()) return null;
    const bounds = body.getBoundingClientRect(), box = row.getBoundingClientRect();
    return document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'true' &&
      document.querySelector('#phone-tab-adjust')?.getAttribute('aria-selected') === 'true' &&
      document.querySelector('[aria-controls="node-motion"]')?.getAttribute('aria-expanded') === 'true' &&
      row.querySelector('[data-testid="export-gif"]') !== null && row.querySelector('[data-testid="export-movie"]') !== null &&
      box.top >= bounds.top - .5 && box.bottom <= bounds.bottom + .5 ? true : null;
  });
  t.ok(`${label}: Motion enable opens Adjust, expands Motion and exposes GIF/Movie`, true);
}

export const scenarios: readonly Scenario[] = [{
  id: 'rs1-compact', title: 'Compact tabs, touch stacking, selection, stable rotation and captures', target: 'dev', covers: [], timeoutMs: 480_000,
  async run(t) {
    await t.page.emulate({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
    await t.page.goto('/');
    for (const frame of frames) {
      await resize(t, frame);
      t.equal(`${frame.width}x${frame.height}: disabled Fry rail is dimmed`, await t.page.evaluate(z.string(), () => {
        const rail = document.querySelector('.fry-rail:has(input:disabled)');
        return rail === null ? '' : getComputedStyle(rail).opacity;
      }), '0.5');
      await t.page.screenshot(`empty-${frame.width}x${frame.height}`);
    }
    await resize(t, { width: 390, height: 844 });
    await touch(t, '.empty-actions button:last-child');
    await t.page.waitFor('sample ready', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 180_000 });
    await t.page.waitFor('import opens Adjust', z.literal(true), () => document.querySelector('[data-testid="tool-adjust"]')?.getAttribute('aria-expanded') === 'true' ? true : null);
    await t.page.evaluate(z.literal(true), () => {
      const canvas = document.querySelector('[data-testid="stage"]');
      document.addEventListener('compact-canvas-check', () => { document.body.dataset['compactCanvas'] = String(document.querySelector('[data-testid="stage"]') === canvas); });
      const range = document.querySelector('[data-testid="style-fry"]');
      if (!(range instanceof HTMLInputElement)) throw new Error('Missing Fry');
      const box = range.getBoundingClientRect(), x = box.left + box.width / 2, y = box.bottom - box.height * .73;
      if (document.elementFromPoint(x, y) !== range) throw new Error('Fry is covered');
      range.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 95, button: 0, buttons: 1, clientX: x, clientY: y }));
      range.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', pointerId: 95, buttons: 1, clientX: x, clientY: y }));
      range.value = '.73'; range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 95, button: 0, buttons: 0, clientX: x, clientY: y }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    t.ok('Fry touch route changes the value without selecting an object', await t.page.evaluate(z.boolean(), () => window.__noisyTest?.demo.document()?.style.fry === .73 && document.querySelector('.context-bar') === null));
    await select(t);
    await touch(t, '.context-bar [aria-label="Green"]');
    const saved = await t.page.evaluate(z.string(), () => JSON.stringify({ style: window.__noisyTest?.demo.document()?.style, objects: window.__noisyTest?.demo.objects() }));
    await touch(t, '[data-testid="parallax-enabled"]');
    await t.page.waitFor('Parallax quick recenter', z.literal(true), () => document.querySelector('[data-testid="parallax-recenter-quick"]') !== null ? true : null, { timeoutMs: 30_000 });
    for (const frame of frames) {
      await resize(t, frame);
      const label = `${frame.width}x${frame.height}`;
      t.ok(`${label}: rotation keeps the exact canvas and values`, await t.page.evaluate(z.boolean(), (saved) => {
        document.dispatchEvent(new Event('compact-canvas-check'));
        return document.body.dataset['compactCanvas'] === 'true' && JSON.stringify({ style: window.__noisyTest?.demo.document()?.style, objects: window.__noisyTest?.demo.objects() }) === saved;
      }, saved));
      await surfaces(t, label);
      if (frame.width === 844) await landscapePicture(t, 'selected');
      await t.page.screenshot(`selected-${label}`);
      for (const id of ['adjust', 'layers', 'color', 'actions']) {
        await touch(t, `[data-testid="tool-${id}"]`);
        t.ok(`${label}: ${id} tab and opener select the same visible panel`, await t.page.evaluate(z.boolean(), (id) => document.querySelector(`#phone-tab-${id}`)?.getAttribute('aria-selected') === 'true' && document.querySelector(`#panel-${id}`)?.checkVisibility() === true && document.querySelector(`[data-testid="tool-${id}"]`)?.getAttribute('aria-expanded') === 'true', id));
        await touch(t, `[data-testid="tool-${id}"]`);
        t.equal(`${label}: second ${id} opener collapses`, await t.page.evaluate(z.string(), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded')), 'false');
      }
      await touch(t, '[data-testid="tool-adjust"]');
      for (const id of ['layers', 'color', 'actions', 'adjust']) await touch(t, `#phone-tab-${id}`);
      t.ok(`${label}: open sheet reserves at least 200 px of stage and 96 px of Fry track`, await t.page.evaluate(z.boolean(), () => (document.querySelector('.phone-stage')?.getBoundingClientRect().height ?? 0) >= 200 && (document.querySelector('[data-testid="style-fry"]')?.getBoundingClientRect().height ?? 0) >= 96));
      if (frame.width === 844) await landscapePicture(t, 'adjust');
      await t.page.screenshot(`adjust-${label}`);
      await t.page.press('Escape');
      t.ok(`${label}: Escape collapses and returns focus without deselecting`, await t.page.evaluate(z.boolean(), () => document.activeElement === document.querySelector('[data-testid="tool-adjust"]') && document.querySelector('.context-bar') !== null && document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') === 'false'));
      await touch(t, '[data-testid="projects-toggle"]');
      await t.page.screenshot(`projects-${label}`);
      await touch(t, '[data-testid="projects-return"]');
      await touch(t, '[data-testid="tool-layers"]');
      await touch(t, '.layer-row.is-selected .layer-select');
      t.equal(`${label}: selecting the same object also collapses`, await t.page.evaluate(z.string(), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded')), 'false');
      await touch(t, '.context-bar [aria-label="Deselect"]');
      await touch(t, '[data-testid="tool-adjust"]');
      await select(t);
    }
    await touch(t, '[data-testid="parallax-enabled"]');
    for (const frame of frames) {
      await resize(t, frame);
      await touch(t, '[data-testid="motion-enabled"]');
      await motionOpen(t, `${frame.width}x${frame.height} pill`);
      await t.page.waitFor('Motion ready', z.literal(true), () => !window.__noisyTest?.demo.products().plateNeeded && document.querySelector('[data-testid="export-gif"]')?.checkVisibility() === true ? true : null, { timeoutMs: 180_000 });
      await touch(t, '[data-testid="export-gif"]');
      await t.page.waitFor('export running', z.literal(true), () => document.querySelector('[data-testid="preparing"]')?.textContent?.startsWith('Exporting:') ? true : null);
      t.equal(`${frame.width}x${frame.height}: preparation notice uses the floating radius`, await t.page.evaluate(z.string(), () => {
        const notice = document.querySelector('[data-testid="preparing"]');
        return notice === null ? '' : getComputedStyle(notice).borderRadius;
      }), '12px');
      await t.page.screenshot(`export-${frame.width}x${frame.height}`);
      await t.page.waitFor('export complete', z.literal(true), () => document.querySelector('[data-testid="preparing"]') === null ? true : null, { timeoutMs: 180_000 });
      t.equal(`${frame.width}x${frame.height}: background preparation and export updates leave the sheet open`, await t.page.evaluate(z.string(), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded')), 'true');
      await touch(t, '[data-testid="motion-enabled"]');
      await touch(t, '[aria-controls="node-motion"]');
      await touch(t, '[data-testid="motion-node-enabled"]');
      await motionOpen(t, `${frame.width}x${frame.height} node switch`);
      await touch(t, '[data-testid="motion-enabled"]');
    }
  },
}, {
  id: 'rs1-compact.failure', title: 'Compact wrapped failure status at both phone orientations', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    t.expectMessage({ because: 'Deliberately corrupt model downloads.', level: 'error', source: 'network' });
    await t.server.setFaults(['path:/models/:corrupt']);
    try {
      await t.page.goto('/');
      await t.page.waitFor('model failure', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Models unavailable:') ? true : null, { timeoutMs: 120_000 });
      for (const frame of frames) {
        await resize(t, frame);
        t.ok(`${frame.width}x${frame.height}: whole failure sentence wraps inside the visible header`, await t.page.evaluate(z.boolean(), () => {
          const status = document.querySelector('[data-testid="status"]');
          if (!(status instanceof HTMLElement)) return false;
          const box = status.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight && status.scrollWidth <= status.clientWidth && status.scrollHeight <= status.clientHeight && getComputedStyle(status).whiteSpace === 'normal';
        }));
        await t.page.screenshot(`failure-${frame.width}x${frame.height}`);
      }
    } finally { await t.server.clearFaults(); }
  },
}];
