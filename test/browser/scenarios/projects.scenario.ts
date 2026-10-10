import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const listing = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), updatedAt: z.string(), thumbnail: z.string() })) });
const savedSchema = z.object({ id: z.string(), revision: z.number(), json: z.string(), objects: z.number(), masksMatch: z.boolean(),
  thumbnailJpeg: z.boolean(), thumbnailBytes: z.number(), thumbnailLongEdge: z.number(), photoMatches: z.boolean() });

async function savedChecks(): Promise<unknown> {
  const demo = window.__noisyTest?.demo, doc = demo?.document();
  if (demo === undefined || doc === null || doc === undefined) throw new Error('No project document.');
  const response = await fetch(`/api/projects/${doc.id}/scene`);
  if (!response.ok) throw new Error('No saved scene.');
  const scene: unknown = await response.json();
  if (scene === null || typeof scene !== 'object' || !('document' in scene) || !('masks' in scene) || !('revision' in scene) || typeof scene.revision !== 'number') throw new Error('Invalid scene response.');
  const metadata = scene.masks;
  if (metadata === null || typeof metadata !== 'object') throw new Error('Invalid mask metadata.');
  let masksMatch = Object.keys(metadata).length === demo.projectMasks().length;
  for (const mask of demo.projectMasks()) {
    const size: unknown = Reflect.get(metadata, mask.asset);
    const response = await fetch(`/api/projects/${doc.id}/masks/${mask.asset}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    masksMatch &&= response.ok && size !== null && typeof size === 'object' && 'width' in size && 'height' in size &&
      size.width === mask.width && size.height === mask.height && bytes.length === mask.bytes.length && bytes.every((value, i) => value === mask.bytes[i]);
  }
  const thumb = await fetch(`/api/projects/${doc.id}/thumbnail`);
  const blob = await thumb.blob(), bytes = new Uint8Array(await blob.arrayBuffer());
  const bitmap = await createImageBitmap(blob), thumbnailLongEdge = Math.max(bitmap.width, bitmap.height); bitmap.close();
  const photo = await fetch(`/api/projects/${doc.id}/photo`);
  const sample = await fetch('/assets-static/sample.jpg');
  const original = new Uint8Array(await photo.arrayBuffer()), expected = new Uint8Array(await sample.arrayBuffer());
  return { id: doc.id, revision: scene.revision, json: JSON.stringify(scene.document), objects: doc.objects.length, masksMatch,
    thumbnailJpeg: thumb.ok && blob.type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216,
    thumbnailBytes: bytes.length, thumbnailLongEdge,
    photoMatches: photo.ok && original.length === expected.length && original.every((value, i) => value === expected[i]) };
}

export const scenarios: readonly Scenario[] = [{
  id: 'projects.autosave', title: 'Autosave, Projects on both frames, exact restore, edits, recoverable failure and deletion',
  target: 'dev', covers: ['PS1a'], timeoutMs: 360_000,
  async run(t) {
    const { page } = t;
    const clickAction = async (label: string): Promise<void> => {
      const selector = await page.evaluate(z.string(), (label) => {
        const button = Array.from(document.querySelectorAll('.top-bar .action-rail button')).find((button) => button.textContent === label);
        if (!(button instanceof HTMLButtonElement)) throw new Error(`No ${label} action.`);
        button.dataset['projectsAction'] = label;
        return `[data-projects-action="${label}"]`;
      }, label);
      await page.click(selector);
    };
    const clearFixture = async (): Promise<void> => {
      await t.server.clearFaults();
      await page.evaluate(z.literal(true), async () => {
        const demo = window.__noisyTest?.demo;
        const current = demo?.projects().current;
        if (demo !== undefined && current != null && !await demo.deleteProject(current)) throw new Error('Could not remove the current project.');
        return true;
      });
      const stored = await page.evaluate(listing, async () => (await fetch('/api/projects')).json());
      for (const project of stored.projects) await page.evaluate(z.literal(true), async (id) => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined || !await demo.deleteProject(id)) throw new Error('Could not clear the project fixture.');
        return true;
      }, project.id);
    };
    const addFixtureRows = (count: number): Promise<string[]> => page.evaluate(z.array(z.string()), async (count) => {
      const doc = window.__noisyTest?.demo.document();
      if (doc == null) throw new Error('No project to copy for the list.');
      const scene: unknown = await (await fetch(`/api/projects/${doc.id}/scene`)).json();
      if (scene === null || typeof scene !== 'object' || !('masks' in scene)) throw new Error('No saved mask metadata.');
      const thumbnail = await (await fetch(`/api/projects/${doc.id}/thumbnail`)).blob();
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const id = crypto.randomUUID();
        for (const [resource, body, type] of [
          ['thumbnail', thumbnail, 'image/jpeg'],
          ['scene', JSON.stringify({ document: { ...doc, id, title: `${doc.title} ${index + 1}` }, masks: scene.masks, revision: 0 }), 'application/json'],
        ] satisfies readonly [string, BodyInit, string][]) {
          const response = await fetch(`/api/projects/${id}/${resource}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
          if (!response.ok) throw new Error('Could not create a project row.');
          await response.json();
        }
        ids.push(id);
      }
      return ids;
    }, count);
    const removeFixtureRows = (ids: readonly string[]): Promise<true> => page.evaluate(z.literal(true), async (ids) => {
      const demo = window.__noisyTest?.demo;
      if (demo === undefined) throw new Error('No project hooks.');
      for (const id of ids) if (!await demo.deleteProject(id)) throw new Error('Could not remove a project row.');
      return true;
    }, ids);
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto('/');
    await page.waitFor('project hooks', z.literal(true), () => window.__noisyTest?.demo === undefined ? null : true);
    try {
      await clearFixture();
      const initial = await page.evaluate(listing, async () => (await fetch('/api/projects')).json());
      t.equal('fixture cleared before autosave checks', initial.projects, []);
      await clickAction('Try a sample');
      await page.waitFor('Ready to tap', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 180_000 });
      await page.evaluate(z.literal(true), async () => { await window.__noisyTest?.demo.tap(.38, .585); return true; });
      await page.waitFor('object swatches', z.literal(true), () => document.querySelector('[data-testid="swatches"]') === null ? null : true);
      await page.click('[data-testid="swatches"] button[aria-label="Green"]');
      await page.click('[data-testid="layer-rename"]');
      await page.press('Backspace');
      await page.type('[data-testid="layer-name-input"]', 'Saved ball');
      await page.press('Enter');
      await page.click('[data-testid="object-hide"]');
      await page.waitFor('hidden project plate ready', z.literal(true), () => {
        const demo = window.__noisyTest?.demo;
        return demo?.objects()[0]?.hidden && demo.products().plateSize !== null && !demo.products().plateNeeded ? true : null;
      }, { timeoutMs: 180_000 });
      await page.evaluate(z.literal(true), () => {
        const range = document.querySelector('[data-testid="style-fry"]');
        if (!(range instanceof HTMLInputElement)) throw new Error('No Fry slider.');
        range.value = '0.73'; range.dispatchEvent(new Event('input', { bubbles: true })); return true;
      });
      await page.click('[data-testid="projects-toggle"]');
      await page.waitFor('latest scene saved', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' &&
        document.querySelector('[data-testid="projects-state"]')?.textContent === 'Saved just now' ? true : null, { timeoutMs: 30_000 });
      const saved = await page.evaluate(savedSchema, savedChecks);
      const docJson = await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document()));
      t.equal('scene is the whole page document', saved.json, docJson);
      const list = await page.evaluate(listing, async () => (await fetch('/api/projects')).json());
      t.equal('list contains exactly the imported project', list.projects.map((project) => project.id), [saved.id]);
      t.ok('every object mask matches products byte for byte', saved.objects > 0 && saved.masksMatch, saved);
      t.ok('thumbnail is JPEG at 256 px, under 60 KB; photo bytes are original', saved.thumbnailJpeg && saved.thumbnailBytes < 60_000 && saved.thumbnailLongEdge === 256 && saved.photoMatches, saved);
      const desktop = await page.evaluate(z.object({ selected: z.boolean(), rows: z.number(), rowHeight: z.number(), thumbSize: z.array(z.number()), timeSize: z.string(), native: z.boolean() }), () => {
        const row = document.querySelector('[data-testid="project-row"]'), thumb = row?.querySelector('img'), time = row?.querySelector('.project-time');
        return { selected: row?.classList.contains('is-selected') ?? false, rows: document.querySelectorAll('[data-testid="project-row"]').length,
          rowHeight: row?.getBoundingClientRect().height ?? 0, thumbSize: [thumb?.width ?? 0, thumb?.height ?? 0],
          timeSize: time == null ? '' : getComputedStyle(time).fontSize,
          native: row?.querySelector('.project-open') instanceof HTMLButtonElement && row?.querySelector('[data-testid="project-delete"]') instanceof HTMLButtonElement };
      });
      t.ok('desktop reuses the 64 px row, 48 px thumbnail, 11 px time and selected native controls', desktop.selected && desktop.rows === 1 && desktop.rowHeight === 64 && desktop.thumbSize.join(',') === '48,48' && desktop.timeSize === '11px' && desktop.native, desktop);
      await page.waitFor('desktop thumbnail loaded', z.literal(true), () => {
        const image = document.querySelector('[data-testid="project-row"] img');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 ? true : null;
      });
      await page.screenshot('projects-panel-1440');
      const scrollRows = await addFixtureRows(12);
      await page.click('[data-testid="projects-toggle"]');
      await page.click('[data-testid="projects-toggle"]');
      await page.waitFor('scrolling project rows loaded', z.literal(true), () => document.querySelectorAll('[data-testid="project-row"]').length === 13 ? true : null);
      await page.evaluate(z.literal(true), () => { Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 }); return true; });
      await page.emulate({ width: 402, height: 874, deviceScaleFactor: 1, mobile: true, colorScheme: 'dark' });
      await page.waitFor('phone Projects panel', z.literal(true), () => document.querySelector('.phone-stage [data-testid="projects-panel"]') === null ? null : true);
      const phone = await page.evaluate(z.object({ fits: z.boolean(), stageFilled: z.boolean(), toggleBeforeCapture: z.boolean(), controlsHidden: z.boolean(), sheetHidden: z.boolean(), aboveToolbar: z.boolean(), lastTappable: z.boolean(), scrolled: z.boolean() }), () => {
        const panel = document.querySelector('[data-testid="projects-panel"]')?.getBoundingClientRect(), stage = document.querySelector('.phone-stage')?.getBoundingClientRect();
        const sheet = document.querySelector('.phone-sheet'), toolbar = document.querySelector('.phone-toolbar')?.getBoundingClientRect();
        const list = document.querySelector('.projects-list');
        if (!(list instanceof HTMLElement)) throw new Error('No scrolling project list.');
        list.scrollTop = list.scrollHeight;
        const last = list.querySelector('[data-testid="project-row"]:last-child .project-open'), bounds = last?.getBoundingClientRect();
        const hit = bounds === undefined ? null : document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const buttons = Array.from(document.querySelectorAll('.phone-strip .action-rail button'), (button) => button.textContent);
        return { fits: document.documentElement.scrollWidth === innerWidth && panel !== undefined && panel.left >= 0 && panel.right <= innerWidth,
          stageFilled: panel !== undefined && stage !== undefined && panel.width === stage.width && panel.height === stage.height,
          toggleBeforeCapture: buttons[0] === 'Projects' && buttons[1] === 'Take a photo', controlsHidden: document.querySelector('.phone-tools')?.hasAttribute('hidden') ?? false,
          sheetHidden: sheet instanceof HTMLElement && sheet.hidden && getComputedStyle(sheet).display === 'none',
          aboveToolbar: panel !== undefined && toolbar !== undefined && panel.bottom <= toolbar.top,
          scrolled: list.scrollHeight > list.clientHeight && list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1,
          lastTappable: last instanceof HTMLButtonElement && !last.disabled && hit !== null && last.contains(hit) };
      });
      t.ok('phone panel fills the stage, fits, and keeps Projects left of capture', phone.fits && phone.stageFilled && phone.toggleBeforeCapture && phone.controlsHidden, phone);
      t.ok('the whole phone sheet is hidden and the last row centre is tappable at maximum scroll above the toolbar', phone.sheetHidden && phone.aboveToolbar && phone.scrolled && phone.lastTappable, phone);
      await page.waitFor('phone thumbnail loaded', z.literal(true), () => {
        const image = document.querySelector('[data-testid="project-row"]:last-child img');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 ? true : null;
      });
      await page.screenshot('projects-panel-phone-402');

      await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
      await removeFixtureRows(scrollRows);
      await page.reload();
      await page.waitFor('fresh session without a scene', z.literal(true), () => window.__noisyTest?.demo.document() === null ? true : null);
      await page.click('[data-testid="projects-toggle"]');
      await page.waitFor('saved project row after reload', z.literal(true), () => document.querySelector('[data-testid="project-row"]') === null ? null : true);
      await page.click('.project-open');
      await page.waitFor('restored scene and closed panel', z.literal(true), () => window.__noisyTest?.demo.document()?.objects.length && document.querySelector('[data-testid="projects-panel"]') === null ? true : null, { timeoutMs: 30_000 });
      const restored = await page.evaluate(z.object({ equal: z.boolean(), selectionCleared: z.boolean(), layerPresent: z.boolean(), masksMatch: z.boolean() }), async (json) => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No restore hooks.');
        const doc = demo.document(), object = doc?.objects[0];
        let masksMatch = true;
        for (const mask of demo.projectMasks()) {
          const bytes = new Uint8Array(await (await fetch(`/api/projects/${doc?.id}/masks/${mask.asset}`)).arrayBuffer());
          masksMatch &&= bytes.length === mask.bytes.length && bytes.every((value, i) => value === mask.bytes[i]);
        }
        return { equal: JSON.stringify(doc) === json, selectionCleared: demo.objects().every((object) => !object.selected),
          layerPresent: object !== undefined && Array.from(document.querySelectorAll('.layer-name')).some((node) => node.textContent === object.name), masksMatch };
      }, saved.json);
      t.ok('opening restores the whole document, masks and object layers and clears selection', restored.equal && restored.masksMatch && restored.layerPresent && restored.selectionCleared, restored);
      t.equal('restored project keeps the layer name and hidden flag', await page.evaluate(z.object({ name: z.string(), hidden: z.boolean() }), () => {
        const object = window.__noisyTest?.demo.objects()[0]; return { name: object?.name, hidden: object?.hidden };
      }), { name: 'Saved ball', hidden: true });
      await page.waitFor('restored analysis is ready', z.literal(true), () => window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 180_000 });
      const refusedRows = await addFixtureRows(1), refusedId = refusedRows[0];
      if (refusedId === undefined) throw new Error('No refusal fixture.');
      await page.click('[data-testid="projects-toggle"]');
      await page.waitFor('refusal project row loaded', z.literal(true), () => document.querySelectorAll('[data-testid="project-row"]').length === 2 ? true : null, { timeoutMs: 30_000 });
      await page.evaluate(z.literal(true), () => {
        const demo = window.__noisyTest?.demo, object = demo?.document()?.objects[0];
        if (demo === undefined || object === undefined) throw new Error('No object to retain during the failed open.');
        demo.select(object.id); return true;
      });
      const activeSchema = z.object({ document: z.string(), objects: z.string(), masks: z.string(), products: z.string(), analysis: z.string(), current: z.string().nullable() });
      const activeBefore = await page.evaluate(activeSchema, () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No active project.');
        return { document: JSON.stringify(demo.document()), objects: JSON.stringify(demo.objects()), masks: JSON.stringify(demo.projectMasks()),
          products: JSON.stringify(demo.products()), analysis: JSON.stringify(demo.analysis()), current: demo.projects().current };
      });
      t.expectMessage({ because: 'a refused project open deliberately fails its scene GET', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/projects/${refusedId}/scene`) });
      await t.server.setFaults([`path:/api/projects/${refusedId}/scene:http500:times=1`]);
      await page.click(`[data-project-id="${refusedId}"] .project-open`);
      await page.waitFor('open error leaves the original project ready', z.literal(true), () => document.querySelector('[data-testid="status"]')?.textContent?.includes('HTTP 500') && window.__noisyTest?.demo.analysis().decoderReady ? true : null, { timeoutMs: 30_000 });
      const activeAfter = await page.evaluate(activeSchema, () => {
        const demo = window.__noisyTest?.demo;
        if (demo === undefined) throw new Error('No active project.');
        return { document: JSON.stringify(demo.document()), objects: JSON.stringify(demo.objects()), masks: JSON.stringify(demo.projectMasks()),
          products: JSON.stringify(demo.products()), analysis: JSON.stringify(demo.analysis()), current: demo.projects().current };
      });
      t.equal('a failed open preserves the exact document, objects, selection, products, readiness and autosave owner', activeAfter, activeBefore);
      await t.server.clearFaults();
      await removeFixtureRows(refusedRows);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.42); return true; });
      await page.waitFor('edit saved under original id', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' ? true : null, { timeoutMs: 30_000 });
      const edited = await page.evaluate(savedSchema, savedChecks);
      t.equal('opening and editing keep the id', edited.id, saved.id);
      t.equal('next saved scene equals current document', edited.json, await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document())));
      t.ok('edit changes the saved look', edited.json !== saved.json);
      t.ok('the edit after a refused open saves above the loaded revision', edited.revision > saved.revision, { saved: saved.revision, edited: edited.revision });

      t.expectMessage({ because: 'the project scene fault deliberately answers one PUT with 500', channel: 'log', source: 'network', level: 'error', url: /\/api\/projects\/.+\/scene/ });
      await t.server.setFaults([`path:/api/projects/${saved.id}/scene:http500:times=1`]);
      const beforeStatus = await page.evaluate(z.string(), () => document.querySelector('[data-testid="status"]')?.textContent ?? '');
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.57); return true; });
      await page.waitFor('failed save is contained in Projects', z.literal(true), () => document.querySelector('[data-testid="projects-state"]')?.textContent === 'Not saved' ? true : null, { timeoutMs: 30_000 });
      const failure = await page.evaluate(z.object({ editingWorks: z.boolean(), status: z.string(), rowFailure: z.boolean(), savedFry: z.number() }), async () => {
        const demo = window.__noisyTest?.demo;
        const stored: unknown = await (await fetch(`/api/projects/${demo?.document()?.id}/scene`)).json();
        let savedFry = -1;
        if (stored !== null && typeof stored === 'object' && 'document' in stored && stored.document !== null && typeof stored.document === 'object' && 'style' in stored.document && stored.document.style !== null && typeof stored.document.style === 'object' && 'fry' in stored.document.style && typeof stored.document.style.fry === 'number') savedFry = stored.document.style.fry;
        return { editingWorks: demo?.document()?.style.fry === .57 && demo.analysis().decoderReady,
          status: document.querySelector('[data-testid="status"]')?.textContent ?? '', rowFailure: document.querySelector('.project-time')?.textContent === 'Not saved', savedFry };
      });
      t.ok('500 leaves editing and analysis status working, marks the row and preserves the previous scene', failure.editingWorks && failure.rowFailure && failure.savedFry === .42 && failure.status === beforeStatus, failure);
      await t.server.clearFaults();
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.61); return true; });
      await page.waitFor('next edit recovers saving', z.literal(true), () => document.querySelector('[data-testid="projects-state"]')?.textContent === 'Saved just now' ? true : null, { timeoutMs: 30_000 });
      const recovered = await page.evaluate(savedSchema, savedChecks);
      t.equal('recovered scene equals current document', recovered.json, await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document())));

      await t.server.setFaults([`path:/api/projects/${saved.id}/scene:corrupt:times=1`]);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.62); return true; });
      await page.waitFor('corrupt acknowledgement reports Not saved', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'failed' ? true : null, { timeoutMs: 30_000 });
      t.ok('accepted corruption changes the acknowledgement and cannot report save success', await page.evaluate(z.boolean(), () => window.__noisyTest?.demo.document()?.style.fry === .62 && window.__noisyTest.demo.analysis().decoderReady));
      await t.server.clearFaults();
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.63); return true; });
      await page.waitFor('a newer edit recovers after corrupt acknowledgement', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' ? true : null, { timeoutMs: 30_000 });

      await t.server.setFaults([`path:/api/projects/${saved.id}/scene:stall:times=1`]);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.64); return true; });
      await page.waitFor('stalled scene has sent its 200 headers', z.literal(true), async () => {
        const value: unknown = await (await fetch('/dev/fault')).json();
        if (value === null || typeof value !== 'object' || !('rules' in value) || !Array.isArray(value.rules)) return null;
        return value.rules.some((rule: unknown) => rule !== null && typeof rule === 'object' && 'hits' in rule && rule.hits === 1) ? true : null;
      }, { timeoutMs: 30_000 });
      t.equal('200 headers without a body keep the project Saving', await page.evaluate(z.string(), () => window.__noisyTest?.demo.projects().state ?? ''), 'saving');
      await page.waitFor('stalled acknowledgement fails at its request timeout', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'failed' ? true : null, { timeoutMs: 30_000 });
      const stalled = await page.evaluate(savedSchema, savedChecks);
      t.ok('a stalled PUT cannot report Saved or replace the stored look', stalled.json !== await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document())) &&
        await page.evaluate(z.boolean(), () => window.__noisyTest?.demo.document()?.style.fry === .64 && window.__noisyTest.demo.analysis().decoderReady), stalled);
      await t.server.clearFaults();
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.65); return true; });
      await page.waitFor('saving recovers after stalled acknowledgement', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' ? true : null, { timeoutMs: 30_000 });

      await page.evaluate(z.literal(true), async () => {
        const doc = window.__noisyTest?.demo.document();
        if (doc == null) throw new Error('No current project.');
        const scene: unknown = await (await fetch(`/api/projects/${doc.id}/scene`)).json();
        if (scene === null || typeof scene !== 'object' || !('revision' in scene) || typeof scene.revision !== 'number') throw new Error('No scene revision.');
        const response = await fetch(`/api/projects/${doc.id}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, revision: scene.revision + 1 }) });
        if (!response.ok) throw new Error('Could not advance the scene revision.');
        await response.json(); return true;
      });
      t.expectMessage({ because: 'the client snapshot conflicts with an already stored scene revision', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/projects/${saved.id}/scene`) });
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.66); return true; });
      await page.waitFor('409 refuses the snapshot', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'failed' ? true : null, { timeoutMs: 30_000 });
      t.equal('a terminal 409 does not retain the refused snapshot for retry', await page.evaluate(z.number(), () => window.__noisyTest?.demo.projects().pendingSaves ?? -1), 0);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.67); return true; });
      await page.waitFor('a newer snapshot succeeds after 409', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' ? true : null, { timeoutMs: 30_000 });
      t.equal('the newer accepted scene equals the edited document', (await page.evaluate(savedSchema, savedChecks)).json,
        await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document())));

      await t.server.setFaults([`path:/api/projects/${saved.id}/scene:slow=1500:times=1`]);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.31); return true; });
      await page.waitFor('scene PUT is in flight', z.literal(true), async () => {
        const value: unknown = await (await fetch('/dev/fault')).json();
        if (value === null || typeof value !== 'object' || !('rules' in value) || !Array.isArray(value.rules)) return null;
        return value.rules.some((rule: unknown) => rule !== null && typeof rule === 'object' && 'hits' in rule && rule.hits === 1) ? true : null;
      }, { timeoutMs: 30_000 });
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.81); return true; });
      await page.waitFor('newest edit wins after an in-flight save', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' ? true : null, { timeoutMs: 30_000 });
      t.equal('an older PUT cannot overwrite the queued edit', (await page.evaluate(savedSchema, savedChecks)).json,
        await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document())));
      await t.server.clearFaults();
      await clickAction('Reset');
      await page.waitFor('Reset autosaved', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'saved' ? true : null, { timeoutMs: 30_000 });
      const reset = await page.evaluate(savedSchema, savedChecks);
      t.ok('Reset keeps the project id and saves cleared objects and masks', reset.id === saved.id && reset.objects === 0 && reset.masksMatch, reset);
      t.equal('Reset scene equals the page document', reset.json, await page.evaluate(z.string(), () => JSON.stringify(window.__noisyTest?.demo.document())));

      await page.click('[data-testid="project-delete"]');
      t.equal('first delete click asks for confirmation', await page.evaluate(z.string(), () => document.querySelector('[data-testid="project-delete"]')?.textContent ?? ''), 'Really delete');
      await page.click('[data-testid="project-delete"]');
      await page.waitFor('project removed from panel', z.literal(true), () => document.querySelector('[data-testid="project-row"]') === null && document.querySelector('[data-testid="projects-panel"]')?.textContent?.includes('No projects yet') ? true : null);
      t.equal('deletion empties the store', (await page.evaluate(listing, async () => (await fetch('/api/projects')).json())).projects, []);
      t.equal('successful deletion releases the retained photo and mask job', await page.evaluate(z.number(), () => window.__noisyTest?.demo.projects().retainedJobs ?? -1), 0);
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.22); return true; });
      await page.evaluate(z.literal(true), async () => { await new Promise((resolve) => setTimeout(resolve, 1800)); return true; });
      t.equal('editing a deleted scene cannot resurrect it', (await page.evaluate(listing, async () => (await fetch('/api/projects')).json())).projects, []);

      t.expectMessage({ because: 'a never-saved import deliberately fails its first photo PUT', channel: 'log', source: 'network', level: 'error', url: /\/api\/projects\/.+\/photo/ });
      await t.server.setFaults(['path:/api/projects/:http500:times=1']);
      await clickAction('Try a sample');
      await page.waitFor('first photo upload failed before the first scene save', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'failed' ? true : null, { timeoutMs: 30_000 });
      const unsavedId = await page.evaluate(z.string(), () => {
        const id = window.__noisyTest?.demo.document()?.id ?? '';
        document.documentElement.dataset['unsavedProjectId'] = id;
        return id;
      });
      t.expectMessage({ because: 'deleting a never-saved project returns an idempotent 404', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/projects/${unsavedId}$`) });
      const removedUnsaved = await page.evaluate(z.boolean(), async (id) => window.__noisyTest?.demo.deleteProject(id) ?? false, unsavedId);
      t.ok('a never-saved project is removed successfully on DELETE 404', removedUnsaved && unsavedId !== saved.id && unsavedId !== '');
      t.equal('DELETE 404 drops the unsaved job and its row', await page.evaluate(z.object({ jobs: z.number(), rows: z.number() }), () => ({ jobs: window.__noisyTest?.demo.projects().retainedJobs ?? -1, rows: document.querySelectorAll('[data-testid="project-row"]').length })), { jobs: 0, rows: 0 });
      await t.server.clearFaults();
      await clickAction('Try a sample');
      const second = await page.waitFor('second import publishes a different document id', z.string(), () => {
        const id = window.__noisyTest?.demo.document()?.id;
        return id !== undefined && id !== document.documentElement.dataset['unsavedProjectId'] ? id : null;
      }, { timeoutMs: 30_000 });
      await page.evaluate(z.literal(true), (id) => { document.documentElement.dataset['expectedProjectId'] = id; return true; }, second);
      await page.waitFor('second import autosaves its own id', z.literal(true), () => {
        const projects = window.__noisyTest?.demo.projects(), id = document.documentElement.dataset['expectedProjectId'];
        return id !== undefined && projects?.current === id && projects.states.get(id) === 'saved' ? true : null;
      }, { timeoutMs: 30_000 });
      t.ok('a second successful import creates a second id', second !== '' && second !== saved.id && second !== unsavedId, { first: saved.id, unsavedId, second });
      t.equal('second import is the only listed project', (await page.evaluate(listing, async () => (await fetch('/api/projects')).json())).projects.map((project) => project.id), [second]);

      await page.evaluate(z.literal(true), async (id) => {
        const response = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Could not create the remote deletion.');
        await response.json(); return true;
      }, second);
      t.expectMessage({ because: 'a remotely deleted project refuses its next thumbnail PUT with 410', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/projects/${second}/thumbnail`) });
      await page.evaluate(z.literal(true), () => { window.__noisyTest?.demo.setFry(.27); return true; });
      await page.waitFor('410 refuses a remotely deleted project save', z.literal(true), () => window.__noisyTest?.demo.projects().state === 'failed' ? true : null, { timeoutMs: 30_000 });
      t.equal('a terminal 410 does not retain the refused snapshot for retry', await page.evaluate(z.number(), () => window.__noisyTest?.demo.projects().pendingSaves ?? -1), 0);
      t.expectMessage({ because: 'removing the already deleted local project receives DELETE 404', channel: 'log', source: 'network', level: 'error', url: new RegExp(`/api/projects/${second}$`) });
      t.ok('removing the remotely deleted project succeeds and releases its job', await page.evaluate(z.boolean(), async (id) => {
        const demo = window.__noisyTest?.demo;
        return demo !== undefined && await demo.deleteProject(id) && demo.projects().retainedJobs === 0;
      }, second));
      await t.file('projects.json', JSON.stringify({ saved, desktop, phone, restored, failure, firstId: saved.id, secondId: second }, null, 2));
    } finally {
      await clearFixture();
    }
    t.equal('fixture empty after autosave checks', (await page.evaluate(listing, async () => (await fetch('/api/projects')).json())).projects, []);
  },
}];
