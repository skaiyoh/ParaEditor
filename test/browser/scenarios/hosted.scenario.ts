import { readFile } from 'node:fs/promises';
import { parseLock } from '../../../src/analysis/lock.ts';
import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const Boundary = z.object({ isolated: z.boolean(), testSurface: z.boolean(), modelStatus: z.number(), modelBytes: z.number(), modelRange: z.string().nullable(), devStatus: z.number() });
async function boundary(modelPath: string): Promise<unknown> {
  const model = await fetch(modelPath, { headers: { Range: 'bytes=0-31' }, cache: 'no-store' });
  const modelBytes = (await model.arrayBuffer()).byteLength;
  const dev = await fetch('/dev/fault', { cache: 'no-store' });
  await dev.text();
  return { isolated: crossOriginIsolated, testSurface: '__noisyTest' in window, modelStatus: model.status, modelBytes, modelRange: model.headers.get('Content-Range'), devStatus: dev.status };
}

export const scenarios: readonly Scenario[] = [{
  id: 'hosted.production', target: 'production', timeoutMs: 300_000, covers: [],
  title: 'the hosted editor is isolated, serves resumed same-origin models, excludes dev routes, and imports the actual sample',
  async run(t) {
    const lock = parseLock(JSON.parse(await readFile(new URL('../../../models.lock.json', import.meta.url), 'utf8')));
    if (!lock.ok) throw new Error(lock.error);
    const model = lock.value.lock.models['face']?.files[0];
    if (model === undefined) throw new Error('Face model is absent from the lock.');
    t.expectMessage({ because: 'the hosted boundary deliberately probes a dev route', channel: 'log', source: 'network', level: 'error', url: /\/dev\/fault$/ });
    await t.page.goto('/');
    await t.page.waitFor('the hosted sample button', z.literal(true), () => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Try a sample') ? true : null);
    const facts = await t.page.evaluate(Boundary, boundary, model.served);
    t.equal('the hosted browser boundary', facts, { isolated: true, testSurface: false, modelStatus: 206, modelBytes: 32, modelRange: `bytes 0-31/${model.bytes}`, devStatus: 404 });
    const selector = await t.page.evaluate(z.string(), () => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Try a sample');
      if (button === undefined) throw new Error('Sample button is missing.');
      button.dataset['hostedAction'] = 'sample';
      return '[data-hosted-action="sample"]';
    });
    await t.page.click(selector);
    await t.page.waitFor('the real hosted sample analysis to finish', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap' ? true : null, { timeoutMs: 240_000 });
    t.equal('the hosted stage exists', await t.page.evaluate(z.boolean(), () => {
      const stage = document.querySelector<HTMLCanvasElement>('[data-testid="stage"]');
      return stage !== null && stage.width > 0 && stage.height > 0;
    }), true);
    await t.page.screenshot('hosted-sample');
  },
}];
