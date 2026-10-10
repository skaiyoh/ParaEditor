// Temporary, uncommitted: finish-review screenshots at the two demo sizes.
import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

function modelsReady(): true | null {
  const text = document.querySelector('[data-testid="status"]')?.textContent ?? '';
  return /drop a photo/i.test(text) ? true : null;
}
function readyToTap(): true | null {
  return (document.querySelector('[data-testid="status"]')?.textContent ?? '').startsWith('Ready to tap') ? true : null;
}
function swatchesShown(): true | null { return document.querySelector('[data-testid="swatches"]') !== null ? true : null; }
function plateReady(): true | null {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('No dev surface.');
  return demo.analysis().plate && !demo.products().plateNeeded ? true : null;
}

export const scenarios: readonly Scenario[] = [{
  id: 'review.shots', title: 'Finish-review screenshots at 1440 x 900 and 1280 x 800', covers: ['D7'], target: 'dev', timeoutMs: 400_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto(t.baseUrl);
    await page.waitFor('models ready', z.literal(true), modelsReady, { timeoutMs: 180_000 });
    await page.screenshot('empty-1440');
    await page.evaluate(z.literal(true), () => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Try a sample');
      if (button === undefined) throw new Error('No sample button.');
      button.click(); return true;
    });
    await page.waitFor('ready to tap', z.literal(true), readyToTap, { timeoutMs: 240_000 });
    await page.screenshot('ready-1440');
    await page.evaluate(z.literal(true), async (x: number, y: number) => { await window.__noisyTest!.demo.tap(x, y); return true; }, 0.38, 0.585);
    await page.waitFor('swatches', z.literal(true), swatchesShown, { timeoutMs: 30_000 });
    await page.screenshot('selected-1440');
    await page.click('[data-testid="swatches"] button[aria-label="Green"]');
    await page.click('[data-testid="motion-enabled"]');
    await page.waitFor('plate ready', z.literal(true), plateReady, { timeoutMs: 120_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    await page.screenshot('motion-1440');
    await page.emulate({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    await page.screenshot('motion-1280');
    await page.press('Escape');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await page.screenshot('ready-1280');
    t.ok('screenshots taken', true);
  },
}];
