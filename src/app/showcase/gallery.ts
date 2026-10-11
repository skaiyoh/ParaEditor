import { deleteImportedScene, importSceneFile, listImportedScenes } from '../scene-store.ts';
import { scenes, type SceneId, type SceneSummary } from './catalog.ts';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const value = document.getElementById(id);
  if (!(value instanceof type)) throw new Error(`The scene gallery is missing its ${id} control.`);
  return value;
}

export function createSceneGallery(choose: (id: SceneId) => Promise<void>, signal: AbortSignal) {
  const panel = element('scene-gallery', HTMLElement), list = element('scene-list', HTMLDivElement);
  const toggle = element('gallery-toggle', HTMLButtonElement), upload = element('upload', HTMLButtonElement);
  const input = element('scene-file', HTMLInputElement), status = element('upload-status', HTMLParagraphElement);
  const select = element('scene-choice', HTMLSelectElement);
  const posters = new Map<string, string>();
  let items: readonly SceneSummary[] = scenes, selected: SceneId = 'highland-field', busy = false;
  function close(): void { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  function mark(id: SceneId): void {
    selected = id; select.value = id;
    for (const button of list.querySelectorAll<HTMLButtonElement>('[data-open-scene]')) button.setAttribute('aria-pressed', String(button.dataset.openScene === id));
  }
  function render(): void {
    list.replaceChildren(); select.replaceChildren();
    for (const item of items) {
      const option = new Option(item.title, item.id); select.add(option);
      const entry = document.createElement('div'); entry.className = 'scene-entry';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'scene-open'; open.dataset.openScene = item.id;
      const image = document.createElement('img'); image.src = item.poster; image.alt = ''; image.loading = 'lazy';
      const title = document.createElement('span'); title.textContent = item.title;
      open.append(image, title); open.addEventListener('click', () => { close(); void choose(item.id); }, { signal }); entry.append(open);
      if (item.id.startsWith('imported:')) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.className = 'scene-delete';
        remove.setAttribute('aria-label', `Delete ${item.title} from this device`);
        remove.addEventListener('click', () => {
          if (busy) return;
          busy = true; remove.disabled = true;
          void (async () => {
            await deleteImportedScene(item.id.slice(9));
            if (signal.aborted) return;
            if (selected === item.id) await choose('highland-field');
            await refresh(); status.textContent = `${item.title} was deleted from this device.`;
          })().catch(error => { status.textContent = error instanceof Error ? error.message : 'The scene could not be deleted. Try again.'; })
            .finally(() => { busy = false; remove.disabled = false; });
        }, { signal }); entry.append(remove);
      }
      list.append(entry);
    }
    mark(selected);
  }
  async function refresh(): Promise<void> {
    const imported = await listImportedScenes(); if (signal.aborted) return;
    const live = new Set(imported.map(item => item.id));
    for (const [id, url] of posters) if (!live.has(id)) { URL.revokeObjectURL(url); posters.delete(id); }
    items = [...scenes, ...imported.map(item => {
      let poster = posters.get(item.id);
      if (poster === undefined) { poster = URL.createObjectURL(item.poster); posters.set(item.id, poster); }
      return { id: `imported:${item.id}`, title: item.title, poster, description: 'Lean to look past the foreground.' } satisfies SceneSummary;
    })];
    render();
  }
  toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); }, { signal });
  upload.addEventListener('click', () => { if (!busy) input.click(); }, { signal });
  input.addEventListener('change', () => {
    const file = input.files?.[0]; if (file === undefined || busy) return;
    busy = true; upload.disabled = true; status.textContent = 'Checking and saving the scene.';
    void (async () => {
      const result = await importSceneFile(file); if (signal.aborted) return;
      if (!result.ok) { status.textContent = result.reason; return; }
      await refresh(); status.textContent = `${result.value.title} is saved on this device. Select it to open.`;
    })().catch(error => { status.textContent = error instanceof Error ? error.message : 'The scene could not be saved. Try again.'; })
      .finally(() => { busy = false; upload.disabled = false; input.value = ''; });
  }, { signal });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { close(); toggle.focus(); } }, { signal });
  signal.addEventListener('abort', () => { for (const url of posters.values()) URL.revokeObjectURL(url); posters.clear(); }, { once: true });
  render();
  return { items: () => items, mark, close, async prepare(): Promise<void> {
    try { await refresh(); } catch { status.textContent = 'Saved scenes could not be read on this device. Prepared scenes are still available.'; }
  } };
}
