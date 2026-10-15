import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

function fryControl(value: number | null): number {
  const slider = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((input) => {
    if (/fry/i.test(input.getAttribute('aria-label') ?? '')) return true;
    const label = input.id ? [...document.querySelectorAll<HTMLLabelElement>('label')].find((item) => item.htmlFor === input.id) : undefined;
    if (/fry/i.test(label?.textContent ?? '')) return true;
    let parent = input.parentElement;
    for (let depth = 0; depth < 3 && parent !== null; depth++, parent = parent.parentElement) {
      if (/^Fry\b/i.test(parent.textContent?.trim() ?? '')) return true;
    }
    return false;
  });
  if (slider === undefined) throw new Error('The hosted Fry control is missing.');
  if (value !== null) {
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return Number(slider.value);
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
    await t.page.click('[data-testid=tool-actions]');
    const selector = await t.page.evaluate(z.string(), () => {
      const button = [...document.querySelectorAll('button')].find((item) => item.checkVisibility() && item.textContent === 'Try a sample');
      if (button === undefined) throw new Error('Sample button is missing.');
      button.dataset['hostedAction'] = 'sample';
      return '[data-hosted-action="sample"]';
    });
    await t.page.click(selector);
    await t.page.click('[data-testid=tool-actions]');
    await t.page.waitFor('the real hosted sample analysis to finish', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap' ? true : null, { timeoutMs: 240_000 });
    t.equal('the hosted stage exists', await t.page.evaluate(z.boolean(), () => {
      const stage = document.querySelector<HTMLCanvasElement>('[data-testid="stage"]');
      return stage !== null && stage.width > 0 && stage.height > 0;
    }), true);
    await t.page.screenshot('hosted-sample');
  },
}, {
  id: 'hosted.offline', target: 'production', timeoutMs: 600_000, covers: [],
  title: 'with the store and gallery offline, the hosted editor imports, edits and reloads on the device, the gallery says it is offline, and only the store probe reaches the API',
  async run(t) {
    const photo = fileURLToPath(new URL('../../../src/assets/sample.jpg', import.meta.url));
    const clickText = async (text: string) => {
      const selector = await t.page.evaluate(z.string(), (label: string) => {
        const button = [...document.querySelectorAll('button')].find((item) => item.checkVisibility() && (item.textContent?.trim() === label || item.getAttribute('aria-label') === label));
        if (button === undefined) throw new Error(`Missing hosted action: ${label}`);
        button.dataset['hostedAction'] = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return `[data-hosted-action="${button.dataset['hostedAction']}"]`;
      }, text);
      await t.page.click(selector);
    };
    const editor = async (what: string) => t.page.waitFor(what, z.literal(true), () => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Try a sample') ? true : null);
    await t.page.goto('/');
    await editor('the hosted editor');
    await t.page.setFiles('input[type="file"]:not([capture])', [photo]);
    await t.page.waitFor('the imported photo analysis', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap' ? true : null, { timeoutMs: 240_000 });
    const before = await t.page.evaluate(z.number(), fryControl, null);
    const edit = before < 0.5 ? 0.8 : 0.2;
    const edited = await t.page.evaluate(z.number(), fryControl, edit);
    t.ok('the real Fry control accepts the edit on the device', Math.abs(edited - edit) <= 0.005, { before, requestedFry: edit, edited });
    await t.page.click('[data-testid=tool-actions]');
    const tools = await t.page.waitFor('the open tools panel', z.object({ sample: z.literal(true), share: z.boolean(), publish: z.boolean() }), () => {
      const sample = [...document.querySelectorAll('button')].some((button) => button.checkVisibility() && button.textContent === 'Try a sample');
      return sample ? { sample, share: document.getElementById('share-heading') !== null, publish: document.querySelector('[data-testid="share-publish"]') !== null } : null;
    });
    t.equal('the open tools panel offers no Share or Publish', tools, { sample: true, share: false, publish: false });
    await t.page.screenshot('offline-tools');
    await t.page.click('[data-testid=tool-actions]');
    await clickText('Projects');
    t.equal('Projects reports the absent store', await t.page.waitFor('the Projects panel state', z.string(), () => document.querySelector('[data-testid="projects-state"]')?.textContent?.trim() || null), 'No project store on this server');
    await t.page.screenshot('offline-projects');
    await clickText('Return to editor');
    await t.page.screenshot('offline-editor');
    await t.page.reload();
    await editor('the reloaded editor');
    await t.page.screenshot('offline-reloaded');
    for (const path of ['/gallery', '/gallery/00000000-0000-4000-8000-000000000001']) {
      await t.page.goto(path);
      t.equal(`${path} says the gallery is offline`, await t.page.waitFor('the offline gallery page', z.string(), () => document.querySelector('[data-testid="gallery-offline"]')?.textContent?.trim() || null), 'The gallery is offline.');
    }
    await t.page.screenshot('offline-gallery');
    const origin = new URL(t.baseUrl).origin;
    const requests = t.page.requests().filter((request) => /^https?:/.test(request.url));
    const api = requests.filter((request) => new URL(request.url).pathname.startsWith('/api/')).map((request) => [request.method, new URL(request.url).pathname, request.status]);
    t.equal('the only API requests are one store probe per editor load, each answered 204', api, [['GET', '/api/projects', 204], ['GET', '/api/projects', 204]]);
    // Cloudflare Web Analytics, which the hosted CSP admits, loads its beacon on nathan.fish; the
    // local production server injects none. Nothing else may leave the origin.
    const analytics = new Set(['https://static.cloudflareinsights.com', 'https://cloudflareinsights.com']);
    t.equal('no request but Cloudflare Web Analytics leaves the origin', requests.filter((request) => {
      const requestOrigin = new URL(request.url).origin;
      return requestOrigin !== origin && !analytics.has(requestOrigin);
    }).map((request) => request.url), []);
  },
}];
