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

function savedProjectId(): string | null {
  const id = document.body.dataset['hostedProjectId'];
  const panel = document.querySelector('[data-testid="projects-panel"]');
  const state = document.querySelector('[data-testid="projects-state"]')?.textContent?.trim() ?? '';
  if (id === undefined || panel === null || state !== 'Current photo saved.') return null;
  const row = [...panel.querySelectorAll('[data-testid="project-row"]')].find((item) =>
    [...item.querySelectorAll<HTMLImageElement>('img')].some((image) => image.src.includes(`/api/projects/${id}/thumbnail`)));
  return row === undefined ? null : id;
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
}, {
  id: 'hosted.projects', target: 'production', timeoutMs: 600_000, covers: [],
  title: 'the hosted sample saves edits, reloads and opens exactly as left, and deletes through Projects',
  async run(t) {
    const Scene = z.object({ document: z.object({ id: z.string(), title: z.string(), style: z.object({ fry: z.number() }).passthrough() }).passthrough(), masks: z.record(z.string(), z.object({ width: z.number(), height: z.number() })), revision: z.number() });
    const List = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) });
    const clickText = async (text: string) => {
      const selector = await t.page.evaluate(z.string(), (label: string) => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
        if (button === undefined) throw new Error(`Missing hosted action: ${label}`);
        button.dataset['hostedAction'] = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return `[data-hosted-action="${button.dataset['hostedAction']}"]`;
      }, text);
      await t.page.click(selector);
    };
    const setProjectsPanel = async (open: boolean) => {
      const isOpen = await t.page.evaluate(z.boolean(), () => document.querySelector('[data-testid="projects-panel"]') !== null);
      if (isOpen !== open) await clickText('Projects');
    };
    const list = async () => t.page.evaluate(List, async () => {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      if (response.status !== 200) throw new Error(`Projects list HTTP ${response.status}`);
      return await response.json();
    });
    await t.page.goto('/');
    await t.page.waitFor('the hosted sample action', z.literal(true), () => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Try a sample') ? true : null);
    const before = await list();
    // Observe the real photo request to identify this import even while another
    // device is saving into the shared list. Responses and bodies are untouched.
    await t.page.evaluate(z.literal(true), () => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        const match = /^\/api\/projects\/([^/]+)\/photo$/.exec(pathname);
        if (method === 'PUT' && response.ok && match?.[1] !== undefined) document.body.dataset['hostedProjectId'] = match[1];
        return response;
      };
      return true;
    });
    await clickText('Try a sample');
    await t.page.waitFor('hosted sample analysis', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap' ? true : null, { timeoutMs: 240_000 });
    await setProjectsPanel(true);
    const id = await t.page.waitFor('the new hosted project row and Saved panel state', z.string(), savedProjectId, { timeoutMs: 30_000 });
    const initial = await t.page.evaluate(Scene, async (projectId: string) => (await fetch(`/api/projects/${projectId}/scene`, { cache: 'no-store' })).json(), id);
    await setProjectsPanel(false);
    const edit = initial.document.style.fry < 0.5 ? 0.8 : 0.2;
    const inputFry = await t.page.evaluate(z.number(), fryControl, edit);
    t.ok('the real Fry control accepts the edit', Math.abs(inputFry - edit) <= 0.005, { requestedFry: edit, inputFry, tolerance: 0.005 });
    await setProjectsPanel(true);
    t.equal('the edited project row reaches Saved', await t.page.waitFor('the edited project row and Saved panel state', z.string(), savedProjectId, { timeoutMs: 30_000 }), id);
    const saved = await t.page.evaluate(Scene, async (projectId: string) => (await fetch(`/api/projects/${projectId}/scene`, { cache: 'no-store' })).json(), id);
    const savedEvidence = { id, initialRevision: initial.revision, fetchedRevision: saved.revision, requestedFry: edit, fetchedFry: saved.document.style.fry, tolerance: 0.005 };
    t.equal('the edit is persisted under the original id', saved.document.id, id, savedEvidence);
    t.ok('the edited scene revision strictly increases', saved.revision > initial.revision, savedEvidence);
    t.ok('the persisted Fry matches the edit', Math.abs(saved.document.style.fry - edit) <= 0.005, savedEvidence);
    await t.page.screenshot('hosted-projects-saved');
    await t.page.goto('/');
    await t.page.waitFor('Projects after reload', z.literal(true), () => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Projects') ? true : null);
    await setProjectsPanel(true);
    await t.page.evaluate(z.literal(true), (projectId: string) => { document.body.dataset['hostedProjectId'] = projectId; return true; }, id);
    const open = await t.page.waitFor('the saved project row after reload', z.string(), () => {
      const projectId = document.body.dataset['hostedProjectId'];
      const thumbnail = [...document.querySelectorAll<HTMLImageElement>('img')].find((image) => image.src.includes(`/api/projects/${projectId}/thumbnail`));
      if (thumbnail === undefined) return null;
      let row = thumbnail.parentElement;
      while (row !== null) {
        const button = [...row.querySelectorAll('button')].find((item) => /open/i.test(item.getAttribute('aria-label') ?? '') || /^Open\b/.test(item.textContent?.trim() ?? ''));
        if (button !== undefined) { button.dataset['hostedAction'] = 'open-project'; return '[data-hosted-action="open-project"]'; }
        if (row instanceof HTMLButtonElement) { row.dataset['hostedAction'] = 'open-project'; return '[data-hosted-action="open-project"]'; }
        row = row.parentElement;
      }
      return null;
    }, { timeoutMs: 30_000 });
    await t.page.click(open);
    await t.page.waitFor('the reopened hosted project analysis', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent === 'Ready to tap' ? true : null, { timeoutMs: 240_000 });
    const restoredFry = await t.page.evaluate(z.number(), fryControl, null);
    const reopened = await t.page.evaluate(Scene, async (projectId: string) => (await fetch(`/api/projects/${projectId}/scene`, { cache: 'no-store' })).json(), id);
    const reopenedEvidence = { requestedFry: edit, restoredFry, savedFry: saved.document.style.fry, fetchedRevision: reopened.revision, fetchedFry: reopened.document.style.fry, tolerance: 0.005 };
    t.ok('reopening restores the visible edit', Math.abs(restoredFry - edit) <= 0.005, reopenedEvidence);
    t.ok('reopening preserves the saved Fry', Math.abs(reopened.document.style.fry - saved.document.style.fry) <= 0.005, reopenedEvidence);
    t.equal('reopening preserves the entire saved scene', {
      ...reopened, document: { ...reopened.document, style: { ...reopened.document.style, fry: saved.document.style.fry } },
    }, saved, reopenedEvidence);
    await t.page.screenshot('hosted-projects-reopened');
    await setProjectsPanel(true);
    const remove = await t.page.evaluate(z.string(), (projectId: string) => {
      const thumbnail = [...document.querySelectorAll<HTMLImageElement>('img')].find((image) => image.src.includes(`/api/projects/${projectId}/thumbnail`));
      let row = thumbnail?.parentElement ?? null;
      while (row !== null) {
        const button = [...row.querySelectorAll('button')].find((item) => /delete/i.test(item.getAttribute('aria-label') ?? item.textContent ?? ''));
        if (button !== undefined) { button.dataset['hostedAction'] = 'delete-project'; return '[data-hosted-action="delete-project"]'; }
        row = row.parentElement;
      }
      throw new Error('The saved project Delete action is missing.');
    }, id);
    // POL1b: one press deletes at once and offers Undo; the store's DELETE follows when the undo window closes.
    await t.page.click(remove);
    await t.page.waitFor('the project row is removed from the panel', z.literal(true), () => {
      const projectId = document.body.dataset['hostedProjectId'];
      const panel = document.querySelector('[data-testid="projects-panel"]');
      if (projectId === undefined || panel === null) return null;
      return [...panel.querySelectorAll<HTMLImageElement>('[data-testid="project-row"] img')].some((image) => image.src.includes(`/api/projects/${projectId}/thumbnail`)) ? null : true;
    }, { timeoutMs: 30_000 });
    const deadline = Date.now() + 30_000;
    let after = await list();
    while (after.projects.some((project) => project.id === id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      after = await list();
    }
    t.ok('the hosted store no longer lists the deleted project', !after.projects.some((project) => project.id === id), { id, projects: after.projects.map((project) => project.id) });
    t.equal('other shared projects survive the scenario', after.projects.filter((project) => before.projects.some((old) => old.id === project.id)).map((project) => project.id).sort(), before.projects.map((project) => project.id).sort());
    await t.page.screenshot('hosted-projects-deleted');
  },
}];
