import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

/** Reveal controls inside the shared inspector without moving its ancestors. */
function revealInspectorControl(selector: string): true {
  const control = document.querySelector(selector);
  const body = control?.closest('.phone-tools, .inspector .node-stack');
  if (control !== null && body instanceof HTMLElement) {
    const box = control.getBoundingClientRect(), bounds = body.getBoundingClientRect();
    if (box.top < bounds.top + 8) body.scrollTop += box.top - bounds.top - 8;
    else if (box.bottom > bounds.bottom - 8) body.scrollTop += box.bottom - bounds.bottom + 8;
  }
  return true;
}

export const scenarios: readonly Scenario[] = [{
  id: 'parallax.controls', title: 'Parallax recenter, shared strength and diagnostics preserve the live stage', target: 'dev', covers: ['P8'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    for (const size of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'phone', width: 390, height: 844, mobile: true }]) {
      await page.emulate({ width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile, colorScheme: 'dark' });
      await page.goto('/');
      await page.evaluate(z.literal(true), () => { const sample = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try a sample'); if (sample === undefined) throw new Error('Sample action unavailable.'); sample.click(); return true; });
      await page.waitFor('sample analysis', z.literal(true), () => {
        const analysis = window.__noisyTest?.demo.analysis();
        return analysis?.depth && analysis.decoderReady && !analysis.alive.heavy ? true : null;
      }, { timeoutMs: 180_000 });
      await page.click('[data-testid="parallax-enabled"]');
      await page.waitFor('running camera', z.literal(true), () => window.__noisyTest?.demo.windowReady() ? true : null, { timeoutMs: 60_000 });
      if (size.mobile) await page.click('.sheet-handle');
      await page.evaluate(z.literal(true), revealInspectorControl, '[aria-controls="node-parallax"]');
      await page.click('[aria-controls="node-parallax"]');
      await page.evaluate(z.literal(true), revealInspectorControl, '[data-testid="parallax-recenter"]');
      const result = await page.evaluate(z.object({ sameStage: z.boolean(), sameTracks: z.boolean(), strength: z.boolean(), recenterSize: z.boolean(), debugControls: z.boolean(), overflow: z.boolean() }), async () => {
        const demo = window.__noisyTest?.demo;
        const stage = document.querySelector('[data-testid="stage"]');
        const debug = document.querySelector('[data-testid="parallax-debug-toggle"]');
        const recenter = document.querySelector('[data-testid="parallax-recenter"]');
        const strength = document.querySelector('#parallax-strength');
        if (demo === undefined || !(debug instanceof HTMLButtonElement) || !(recenter instanceof HTMLButtonElement) || !(strength instanceof HTMLInputElement)) throw new Error('Parallax controls unavailable.');
        const tracks = [...demo.windowTracks()];
        const frames = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
        strength.value = '1.5'; strength.dispatchEvent(new Event('input', { bubbles: true }));
        await frames();
        const sharedStrength = demo.document()?.motion.parallax === 1.5;
        debug.click(); await frames();
        debug.click(); await frames();
        debug.click(); await frames();
        recenter.click(); await frames();
        const rect = recenter.getBoundingClientRect();
        const currentTracks = demo.windowTracks();
        return { sameStage: stage === document.querySelector('[data-testid="stage"]'),
          sameTracks: tracks.length > 0 && tracks.every((track, i) => track === currentTracks[i] && track.readyState === 'live'),
          strength: sharedStrength, recenterSize: rect.width >= 44 && rect.height >= 44,
          debugControls: document.querySelector('[data-testid="parallax-trace-download"]') instanceof HTMLButtonElement,
          overflow: document.documentElement.scrollWidth <= window.innerWidth };
      });
      for (const [check, value] of Object.entries(result)) t.ok(`${size.name}: ${check}`, value, result);
      if (size.mobile) await page.click('.sheet-handle');
      await page.click('[data-testid="parallax-source-tilt"]');
      await page.waitFor('tilt source isolation selected', z.literal(true), () => document.querySelector('[data-testid="parallax-source-tilt"]')?.getAttribute('aria-pressed') === 'true' ? true : null);
      await page.click('[data-testid="parallax-source-auto"]');
      await page.waitFor('automatic source restored', z.literal(true), () => document.querySelector('[data-testid="parallax-source-auto"]')?.getAttribute('aria-pressed') === 'true' ? true : null);
      const controls = await page.evaluate(z.object({ sourceButtons: z.boolean(), recenterVisible: z.boolean(), debugFits: z.boolean() }), () => {
        const controls = [...document.querySelectorAll('.parallax-source-controls button')];
        const recenter = document.querySelector('[data-testid="parallax-recenter-quick"]') ?? document.querySelector('[data-testid="parallax-recenter"]');
        const rect = recenter?.getBoundingClientRect(), debug = document.querySelector('[data-testid="parallax-debug"]')?.getBoundingClientRect();
        return { sourceButtons: controls.length === 3 && controls.every((button) => { const rect = button.getBoundingClientRect(); return rect.height >= 44 && rect.width >= 44; }),
          recenterVisible: rect !== undefined && rect.width >= 44 && rect.height >= 44,
          debugFits: debug !== undefined && debug.left >= 0 && debug.right <= innerWidth && debug.top >= 0 && debug.bottom <= innerHeight };
      });
      for (const [check, value] of Object.entries(controls)) t.ok(`${size.name}: ${check}`, value, controls);
      await page.screenshot(`parallax-controls-${size.name}`);
      await page.click('[data-testid="parallax-enabled"]');
    }
  },
}];
