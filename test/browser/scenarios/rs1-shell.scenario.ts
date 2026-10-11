import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const frames = [
  { name: 'ipad', width: 1180, height: 820 },
  { name: 'portrait', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const fullFrames = frames.slice(0, 3);
const Surface = z.object({ selector: z.string(), top: z.boolean(), width: z.number(), height: z.number(), hit: z.string() });
const Snapshot = z.object({ fry: z.string(), colors: z.string(), selected: z.string(), motion: z.boolean(), sameCanvas: z.boolean() });

async function resize(t: ScenarioContext, frame: { readonly width: number; readonly height: number }): Promise<void> {
  await t.page.emulate({ ...frame, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await t.page.evaluate(z.literal(true), async ({ width, height }) => {
    const full = width >= 744 && height > 500, deadline = performance.now() + 10_000;
    const settled = (): boolean => innerWidth === width && innerHeight === height &&
      (document.querySelector('.full-editor') !== null) === full &&
      (document.querySelector('.phone-editor') !== null) === !full;
    while (!settled()) {
      if (performance.now() > deadline) throw new Error(`Tier did not settle at ${width} x ${height}; viewport ${innerWidth} x ${innerHeight}, full ${document.querySelector('.full-editor') !== null}.`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    // Let the new layout's ResizeObserver and Preact update complete as well.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!settled()) throw new Error('Tier changed after its layout settled.');
    return true;
  }, frame);
}

async function capture(t: ScenarioContext, name: string): Promise<void> {
  await t.page.evaluate(z.literal(true), async () => {
    const deadline = performance.now() + 1000;
    const animating = (): boolean => document.getAnimations().some((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
    });
    while (animating()) {
      if (performance.now() > deadline) throw new Error('Finite shell animation did not settle before capture.');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  });
  await t.page.screenshot(name);
}

/** Synthetic touch activation uses the same hit target as a physical tap. */
async function touch(t: ScenarioContext, selector: string): Promise<void> {
  const result = await t.page.evaluate(Surface, async (selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`Missing touch target: ${selector}`);
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y), top = hit !== null && node.contains(hit);
    const result = { selector, top, width: box.width, height: box.height, hit: hit?.outerHTML.slice(0, 220) ?? 'null' };
    if (!top) throw new Error(`Touch target is covered: ${JSON.stringify(result)}`);
    if ((node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.disabled) throw new Error(`Disabled touch target: ${selector}`);
    node.focus({ preventScroll: true });
    for (const type of ['pointerdown', 'pointerup', 'click']) node.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 71, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: x, clientY: y,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return result;
  }, selector);
  t.ok(`touch reaches ${selector}`, result.top, result);
}

async function expand(t: ScenarioContext, name: string): Promise<void> {
  const selector = `.node[aria-label="${name}"] .node-disclosure`;
  const open = await t.page.evaluate(z.boolean(), (selector) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true', selector);
  if (!open) await touch(t, selector);
}

/** Native ranges do not execute their default drag for untrusted PointerEvents.
 * The pointer route and native input route are both exercised; actual native
 * thumb tracking remains a physical-iPad check, not a claim of this scenario. */
async function range(t: ScenarioContext, selector: string, value: number, vertical = false): Promise<void> {
  await t.page.evaluate(z.literal(true), async ({ selector, value, vertical }) => {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLInputElement) || input.type !== 'range') throw new Error(`Missing range ${selector}`);
    input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = input.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (document.elementFromPoint(x, y) !== input) throw new Error(`Range is covered: ${selector}`);
    const fraction = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
    const targetX = vertical ? x : box.left + box.width * fraction;
    const targetY = vertical ? box.bottom - box.height * fraction : y;
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 73, pointerType: 'touch', isPrimary: true, buttons: 1, clientX: x, clientY: y }));
    input.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 73, pointerType: 'touch', isPrimary: true, buttons: 1, clientX: targetX, clientY: targetY }));
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 73, pointerType: 'touch', isPrimary: true, buttons: 0, clientX: targetX, clientY: targetY }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return true;
  }, { selector, value, vertical });
}

async function stageTouch(t: ScenarioContext, hold = false): Promise<void> {
  await t.page.evaluate(z.literal(true), async (hold) => {
    const canvas = document.querySelector('[data-testid="stage"]');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing stage canvas.');
    const box = canvas.getBoundingClientRect(), scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    const width = canvas.width * scale, height = canvas.height * scale;
    const x = box.left + (box.width - width) / 2 + width * .38, y = box.top + (box.height - height) / 2 + height * .585;
    const hit = document.elementFromPoint(x, y);
    if (hit !== canvas) throw new Error(`Stage touch is covered at ${x},${y}: ${hit?.outerHTML.slice(0, 220)}`);
    document.body.dataset['rs1TouchX'] = String(x); document.body.dataset['rs1TouchY'] = String(y);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 79, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }));
    await new Promise<void>((resolve) => setTimeout(resolve, hold ? 420 : 35));
    if (!hold) {
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 79, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0, clientX: x, clientY: y }));
      canvas.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerId: 79, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0, clientX: x, clientY: y }));
    }
    return true;
  }, hold);
  t.ok(`stage ${hold ? 'hold' : 'tap'} first hit-tests the canvas and uses touch PointerEvents`, true);
}

async function snapshot(t: ScenarioContext): Promise<z.infer<typeof Snapshot>> {
  return t.page.evaluate(Snapshot, () => {
    document.dispatchEvent(new Event('rs1-check-canvas'));
    const fry = document.querySelector('[data-testid="style-fry"]'), colors = document.querySelector('[data-testid="style-colors"]');
    const motion = document.querySelector('[data-testid="motion-enabled"]');
    return {
      fry: fry instanceof HTMLInputElement ? fry.value : '', colors: colors instanceof HTMLInputElement ? colors.value : '',
      selected: document.querySelector('.layer-row.is-selected[data-object-id]')?.getAttribute('data-object-id') ?? '',
      motion: motion instanceof HTMLInputElement ? motion.checked : motion?.getAttribute('aria-pressed') === 'true',
      sameCanvas: document.body.dataset['rs1SameCanvas'] === 'true',
    };
  });
}

async function surfaces(t: ScenarioContext, frame: string): Promise<void> {
  const results = await t.page.evaluate(z.array(Surface), () => [
    '[data-testid="fry-rail"]', '[data-testid="mode-pill"]', '[data-testid="context-bar"]',
    '.top-bar .primary-action', '[data-testid="panel-adjust"]',
  ].map((selector) => {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`Missing surface: ${selector}`);
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { selector, top: hit !== null && node.contains(hit), width: box.width, height: box.height, hit: hit?.outerHTML.slice(0, 220) ?? 'null' };
  }));
  for (const result of results) t.ok(`${frame}: floating surface wins the center hit test: ${result.selector}`, result.top && result.width > 0 && result.height > 0, result);
}

async function notice(t: ScenarioContext, label: string): Promise<void> {
  const result = await t.page.evaluate(z.object({ visible: z.boolean(), uncovered: z.boolean(), text: z.string(), hit: z.string() }), () => {
    const node = document.querySelector('[data-testid="notice"]');
    if (!(node instanceof HTMLElement)) throw new Error('Missing notice slot.');
    const content = node.querySelector('[data-testid="selection-meter"][data-active="true"], [data-testid="preparing"]');
    if (!(content instanceof HTMLElement)) throw new Error('Missing active notice.');
    const box = content.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    // Notices deliberately pass pointers through. A canvas hit is correct;
    // a panel/bar hit at this point reveals the forbidden geometric overlap.
    const surface = hit?.closest('[data-testid^="panel-"], [data-testid="fry-rail"], [data-testid="mode-pill"], [data-testid="context-bar"]');
    return { visible: box.width > 0 && box.height > 0 && box.top >= 52 && box.bottom <= innerHeight,
      uncovered: surface === null || surface === undefined || node.contains(surface), text: content.textContent ?? '', hit: hit?.outerHTML.slice(0, 180) ?? 'null' };
  });
  t.ok(`${label}: notice is visible and no floating surface covers its center`, result.visible && result.uncovered && result.text.length > 0, result);
}

async function pngHash(t: ScenarioContext): Promise<string> {
  await t.page.evaluate(z.literal(true), () => { delete document.body.dataset['rs1Png']; return true; });
  await touch(t, '.top-bar .primary-action');
  return t.page.waitFor('PNG download bytes', z.string(), () => document.body.dataset['rs1Png'] ?? null, { timeoutMs: 30_000 });
}

async function runShell(t: ScenarioContext): Promise<void> {
  const { page } = t;
  await page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
  await page.goto('/');
  await page.waitFor('full-tier top bar', z.literal(true), () => document.querySelector('[data-testid="tool-actions"]') === null ? null : true);
  for (const frame of frames) {
    await resize(t, frame);
    await page.waitFor('empty frame settled', z.literal(true), () => document.querySelector('.empty-stage .empty-actions button') === null ? null : true);
    const empty = await page.evaluate(z.object({ actions: z.array(z.string()), disabled: z.boolean(), full: z.boolean() }), () => ({
      actions: [...document.querySelectorAll('.empty-stage .empty-actions button')].map((button) => button.textContent?.trim() ?? ''),
      disabled: [...document.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Download').every((button) => button.disabled),
      full: document.querySelector('.full-editor') !== null,
    }));
    t.ok(`${frame.name}: empty stage has capture/open and sample, with no enabled Download`, ['Open', 'Take a photo'].includes(empty.actions[0] ?? '') && empty.actions[1] === 'Try a sample' && empty.disabled, empty);
    t.equal(`${frame.name}: tier boundary`, empty.full, frame.width >= 744 && frame.height > 500);
    await capture(t, `${frame.name}-empty`);
  }
  await resize(t, { width: 1180, height: 820 });
  await touch(t, '.empty-stage .empty-actions button:last-child');
  await page.waitFor('sample Ready to tap', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Ready to tap') ? true : null, { timeoutMs: 240_000 });
  await page.evaluate(z.literal(true), () => {
    const canvas = document.querySelector('[data-testid="stage"]');
    document.addEventListener('rs1-check-canvas', () => { document.body.dataset['rs1SameCanvas'] = String(document.querySelector('[data-testid="stage"]') === canvas); });
    const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
    const blobs = new Map<string, Blob>();
    URL.createObjectURL = function (blob) {
      const url = create.call(URL, blob);
      if (blob instanceof Blob) blobs.set(url, blob);
      return url;
    };
    HTMLAnchorElement.prototype.click = function () {
      const blob = blobs.get(this.href);
      if (blob === undefined) { click.call(this); return; }
      if (this.download.endsWith('.png')) void blob.arrayBuffer().then((bytes) => crypto.subtle.digest('SHA-256', bytes)).then((hash) => {
        document.body.dataset['rs1Png'] = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      });
    };
    document.addEventListener('rs1-cleanup', () => { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; blobs.clear(); }, { once: true });
    return true;
  });
  const beforeFry = await pngHash(t);
  await range(t, '[data-testid="style-fry"]', .9, true);
  t.equal('Fry rises to .9 through its input after touch pointer drag', (await snapshot(t)).fry, '0.9');
  t.ok('Fry changes rendered PNG bytes', await pngHash(t) !== beforeFry);
  await touch(t, '[data-testid="tool-adjust"]');
  await expand(t, 'Palette');
  await range(t, '[data-testid="style-colors"]', 5);
  t.equal('Colors changes in Adjustments', (await snapshot(t)).colors, '5');
  await touch(t, '[data-testid="tool-layers"]');
  t.equal('Layers closes Adjustments', await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="panel-adjust"]')?.hasAttribute('hidden') === true && document.querySelector('[data-testid="panel-layers"]')?.hasAttribute('hidden') === false), true);
  await stageTouch(t);
  await page.waitFor('context bar after tap', z.literal(true), () => document.querySelector('[data-testid="context-bar"]') === null ? null : true, { timeoutMs: 30_000 });
  t.equal('stage tap leaves Layers open', await page.evaluate(z.string(), () => document.querySelector('[data-testid="tool-layers"]')?.getAttribute('aria-expanded')), 'true');
  await page.press('Escape');
  t.equal('Escape closes Layers and returns focus to its opener', await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="tool-layers"]') === document.activeElement && document.activeElement?.getAttribute('aria-expanded') === 'false'), true);
  await page.press('Escape');
  t.equal('next Escape deselects', await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="context-bar"]') === null), true);
  await stageTouch(t);
  await page.waitFor('object selected again', z.literal(true), () => document.querySelector('[data-testid="context-bar"]') === null ? null : true);
  const original = await pngHash(t);
  await touch(t, '[data-testid="context-bar"] button[aria-label="Green"]');
  t.equal('Green pressed state', await page.evaluate(z.string(), () => document.querySelector('[data-testid="context-bar"] button[aria-label="Green"]')?.getAttribute('aria-pressed')), 'true');
  t.ok('Green recolors the rendered image', await pngHash(t) !== original);
  await touch(t, '[data-testid="context-bar"] .swatch-actions button:first-child');
  t.equal('Original restores rendered image', await pngHash(t), original);
  await touch(t, '[data-testid="context-bar"] [data-testid="object-rename"]');
  await page.waitFor('touch rename input', z.literal(true), () => document.querySelector('[data-testid="layer-name-input"]') === null ? null : true);
  await page.press('Backspace');
  await page.type('[data-testid="layer-name-input"]', 'Shell ball');
  await page.press('Enter');
  t.ok('touch name commits rename', await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="context-bar"]')?.textContent?.includes('Shell ball') === true));
  await touch(t, '[data-testid="object-hide"]');
  t.ok('Hide updates the selected layer and offers Show', await page.evaluate(z.boolean(), () => document.querySelector('.layer-row.is-selected.is-hidden') !== null && document.querySelector('[data-testid="object-hide"]')?.getAttribute('aria-label') === 'Show Shell ball'));
  await touch(t, '[data-testid="object-hide"]');
  await touch(t, '[data-testid="context-bar"] button[aria-label="Deselect"]');
  t.equal('Deselect removes context bar', await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="context-bar"]') === null), true);
  await stageTouch(t);
  await page.waitFor('selection for Delete', z.literal(true), () => document.querySelector('[data-testid="context-bar"]') === null ? null : true);
  await touch(t, '[data-testid="object-delete"]');
  t.equal('Delete removes object', await page.evaluate(z.number(), () => document.querySelectorAll('.layer-row[data-object-id]').length), 0);
  await touch(t, '[data-testid="history-undo"]');
  t.equal('rail Undo restores object', await page.evaluate(z.number(), () => document.querySelectorAll('.layer-row[data-object-id]').length), 1);
  await touch(t, '[data-testid="history-redo"]');
  t.equal('rail Redo removes it again', await page.evaluate(z.number(), () => document.querySelectorAll('.layer-row[data-object-id]').length), 0);
  await page.evaluate(z.literal(true), () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })); return true; });
  t.equal('Cmd-Z restores object', await page.evaluate(z.number(), () => document.querySelectorAll('.layer-row[data-object-id]').length), 1);
  await stageTouch(t);
  await page.waitFor('selected restored object', z.literal(true), () => document.querySelector('[data-testid="context-bar"]') === null ? null : true);
  await touch(t, '[data-testid="mode-pill"] button:first-child');
  t.equal('Motion pill turns Motion on', (await snapshot(t)).motion, true);
  await touch(t, '[data-testid="parallax-enabled"]');
  await page.waitFor('Parallax quick recenter', z.literal(true), () => document.querySelector('[data-testid="parallax-recenter-quick"]') === null ? null : true, { timeoutMs: 30_000 });
  t.equal('Parallax pill is pressed', await page.evaluate(z.string(), () => document.querySelector('[data-testid="parallax-enabled"]')?.getAttribute('aria-pressed')), 'true');
  await touch(t, '[data-testid="parallax-recenter-quick"]');
  await touch(t, '[data-testid="parallax-enabled"]');
  const preserved = await snapshot(t);
  for (const frame of [fullFrames[1], fullFrames[0]]) {
    if (frame === undefined) throw new Error('Missing full-tier frame.');
    await resize(t, frame);
    await page.waitFor('full frame resized', z.literal(true), () => document.querySelector('[data-testid="tool-adjust"]') === null ? null : true);
    t.equal(`${frame.name}: rotation keeps canvas and Fry, Colors, selection, Motion`, await snapshot(t), preserved);
  }
  for (const frame of fullFrames) {
    await resize(t, frame);
    await touch(t, '[data-testid="tool-adjust"]');
    t.equal(`${frame.name}: opening Adjustments preserves state and canvas`, await snapshot(t), preserved);
    await surfaces(t, frame.name);
    await capture(t, `${frame.name}-selected-adjustments`);
    await touch(t, '[data-testid="projects-toggle"]');
    t.equal(`${frame.name}: Projects is the sole panel`, await page.evaluate(z.boolean(), () => document.querySelector('[data-testid="panel-adjust"]')?.hasAttribute('hidden') === true && document.querySelector('[data-testid="projects-toggle"]')?.getAttribute('aria-expanded') === 'true'), true);
    await capture(t, `${frame.name}-projects`);
    await touch(t, '[data-testid="tool-layers"]');
    await stageTouch(t, true);
    await page.waitFor('held refinement notice', z.literal(true), () => {
      const meter = document.querySelector('[data-testid="selection-meter"]');
      return meter instanceof HTMLElement && meter.getBoundingClientRect().height > 0 && getComputedStyle(meter).opacity !== '0' ? true : null;
    }, { timeoutMs: 30_000 });
    await notice(t, `${frame.name} refinement with Layers open`);
    await page.evaluate(z.literal(true), () => {
      document.querySelector('[data-testid="stage"]')?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 79, pointerType: 'touch', isPrimary: true, buttons: 0,
        clientX: Number(document.body.dataset['rs1TouchX']), clientY: Number(document.body.dataset['rs1TouchY']) })); return true;
    });
    await touch(t, '[data-testid="tool-adjust"]');
    await expand(t, 'Motion');
    await touch(t, '[data-testid="export-gif"]');
    await page.waitFor('GIF export notice', z.literal(true), () => document.querySelector('[data-testid="preparing"]')?.textContent?.startsWith('Exporting:') ? true : null, { timeoutMs: 30_000 });
    await notice(t, `${frame.name} GIF with Adjustments open`);
    await capture(t, `${frame.name}-export-adjustments`);
    await page.waitFor('GIF export finished', z.literal(true), () => document.querySelector('[data-testid="preparing"]') === null ? true : null, { timeoutMs: 180_000 });
    await touch(t, '[data-testid="tool-adjust"]');
    t.equal(`${frame.name}: panel cycle keeps canvas and edit values`, await snapshot(t), preserved);
  }
  await resize(t, { width: 390, height: 844 });
  await page.waitFor('compact sheet', z.literal(true), () => document.querySelector('.phone-sheet') === null ? null : true);
  if (await page.evaluate(z.boolean(), () => document.querySelector('.sheet-handle')?.getAttribute('aria-expanded') !== 'true')) await touch(t, '.sheet-handle');
  await expand(t, 'Motion');
  await capture(t, 'phone-selected-adjustments');
  await touch(t, '[data-testid="projects-toggle"]');
  await capture(t, 'phone-projects');
  await touch(t, '[data-testid="projects-return"]');
  await touch(t, '[data-testid="export-gif"]');
  await page.waitFor('compact GIF export notice', z.literal(true), () => document.querySelector('[data-testid="preparing"]')?.textContent?.startsWith('Exporting:') ? true : null, { timeoutMs: 30_000 });
  await capture(t, 'phone-export-adjustments');
  await page.waitFor('compact GIF export complete', z.literal(true), () => document.querySelector('[data-testid="preparing"]') === null ? true : null, { timeoutMs: 180_000 });
  await page.evaluate(z.literal(true), () => { document.dispatchEvent(new Event('rs1-cleanup')); return true; });
  await t.file('input-limitations.txt', 'Touch interactions use hit-tested synthetic PointerEvents. Native range dragging additionally dispatches the native input event because untrusted PointerEvents do not invoke browser default thumb tracking. Physical iPad native vertical dragging remains LEAD.\n');
}

export const scenarios: readonly Scenario[] = [
  { id: 'rs1-shell', title: 'Neutral Room full-tier touch routes, stacking, rotation, object actions and history', target: 'dev', covers: [], timeoutMs: 900_000, run: runShell },
  { id: 'rs1-shell.production', title: 'Neutral Room shell through production UI without a dev test surface', target: 'production', covers: [], timeoutMs: 900_000, run: runShell },
  {
    id: 'rs1-shell.failure', title: 'Neutral Room failure status captures through the existing corrupt-model fault', target: 'dev', covers: [], timeoutMs: 180_000,
    async run(t) {
      t.expectMessage({ because: 'The scenario deliberately corrupts model downloads.', level: 'error', source: 'network' });
      await t.server.setFaults(['path:/models/:corrupt']);
      try {
        await t.page.goto('/');
        await t.page.waitFor('model failure status', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Models unavailable:') ? true : null, { timeoutMs: 120_000 });
        for (const frame of frames) {
          await resize(t, frame);
          await t.page.waitFor('failure survives tier change', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('Models unavailable:') ? true : null);
          await capture(t, `${frame.name}-failure`);
          // The compact status strip is RS1b's conversion; rs1-compact asserts the phone sentence there.
          if (frame.name === 'phone') continue;
          t.ok(`${frame.name}: actual model failure sentence remains visible`, await t.page.evaluate(z.boolean(), () => {
            const status = document.querySelector('[data-testid="status"]'), box = status?.getBoundingClientRect();
            return box !== undefined && box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
          }));
        }
      } finally { await t.server.clearFaults(); }
    },
  },
];
