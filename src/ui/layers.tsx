import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoScene, DemoSession } from '../session/scene.ts';
import type { SceneObject } from '../core/types.ts';
import { LENGTHS } from '../core/ranges.ts';
import { Swatches } from './swatches.tsx';

function Thumbnail({ scene, bounds }: {
  readonly scene: DemoScene; readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context === undefined || context === null) return;
    const side = Math.max(bounds.width, bounds.height);
    const x = bounds.x + (bounds.width - side) / 2, y = bounds.y + (bounds.height - side) / 2;
    context.clearRect(0, 0, 48, 48);
    context.drawImage(scene.master, x, y, side, side, 0, 0, 48, 48);
  }, [scene.master, bounds.x, bounds.y, bounds.width, bounds.height]);
  return <canvas ref={canvas} class="layer-thumbnail" width="48" height="48" aria-hidden="true" />;
}

function NameInput({ object, session, onFinish }: {
  readonly object: SceneObject; readonly session: DemoSession; readonly onFinish: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState(object.name);
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (commit: boolean, blur = false): void => {
    if (finished.current) return;
    const name = input.current?.value.trim() ?? '';
    if (commit && name.length === 0 && !blur) { setInvalid(true); return; }
    finished.current = true;
    if (commit && name.length > 0) session.renameObject(object.id, name);
    onFinish();
  };
  return <input ref={input} class="layer-name-input" data-testid="layer-name-input" aria-label="Layer name"
    aria-invalid={invalid} title={invalid ? 'Enter a name' : undefined} value={name}
    maxLength={LENGTHS['objects[].name'].max} onInput={(event) => { setName(event.currentTarget.value); setInvalid(false); }}
    onBlur={() => finish(true, true)} onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter');
      }
    }} />;
}

function Eye({ hidden }: { readonly hidden: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path d="M1 8s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z" /><circle cx="8" cy="8" r="2" />
    {hidden && <path d="m2 2 12 12" />}
  </svg>;
}

export function ObjectInspector({ object, session }: { readonly object: SceneObject; readonly session: DemoSession }) {
  const [renaming, setRenaming] = useState(false);
  return <section class="object-node" aria-label="Object">
    <div class="object-name-row">
      {renaming ? <NameInput object={object} session={session} onFinish={() => setRenaming(false)} />
        : <h3 class="object-heading" title={object.name}>{object.name}</h3>}
      {!renaming && <button type="button" data-testid="layer-rename" onClick={() => setRenaming(true)}>Rename</button>}
    </div>
    <Swatches session={session} recolor={object.recolor} />
    <div class="object-actions">
      <button type="button" data-testid="layer-hide" aria-label={`${object.hidden ? 'Show' : 'Hide'} ${object.name}`}
        onClick={() => session.setObjectHidden(object.id, !object.hidden)}>{object.hidden ? 'Show' : 'Hide'}</button>
      <button type="button" data-testid="layer-delete" aria-label={`Delete ${object.name}`}
        onClick={() => session.deleteObject(object.id)}>Delete</button>
    </div>
  </section>;
}

function ObjectRow({ object, scene, session }: { readonly object: SceneObject; readonly scene: DemoScene; readonly session: DemoSession }) {
  const [renaming, setRenaming] = useState(false);
  const selected = scene.selected === object.id;
  return <div class={`layer-row${selected ? ' is-selected' : ''}${object.hidden ? ' is-hidden' : ''}`} data-object-id={object.id}>
    <button class="layer-select" type="button" aria-pressed={selected} aria-label={`Select ${object.name}`}
      onClick={() => session.select(object.id)} onDblClick={() => setRenaming(true)}>
      <Thumbnail scene={scene} bounds={object.produced.bounds} />
      {!renaming && <span class="layer-name" title={object.name}>{object.name}</span>}
    </button>
    {renaming && <NameInput object={object} session={session} onFinish={() => setRenaming(false)} />}
    <div class="layer-actions">
      <button class="layer-icon" type="button" data-testid="layer-hide" aria-label={`${object.hidden ? 'Show' : 'Hide'} ${object.name}`}
        onClick={() => session.setObjectHidden(object.id, !object.hidden)}><Eye hidden={object.hidden} /></button>
      <button class="layer-icon" type="button" data-testid="layer-delete" aria-label={`Delete ${object.name}`}
        onClick={() => session.deleteObject(object.id)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M6.5 6v5M9.5 6v5" />
        </svg>
      </button>
    </div>
  </div>;
}

export function Layers({ scene, session }: { readonly scene: DemoScene | null; readonly session: DemoSession }) {
  const history = session.historyState();
  return <section class="layers" aria-labelledby="layers-heading">
    <div class="layers-header"><h2 id="layers-heading" class="panel-heading">Layers</h2>
      <div class="history-actions">
        <button type="button" data-testid="history-undo" disabled={!history.canUndo} onClick={() => session.undo()}>Undo</button>
        <button type="button" data-testid="history-redo" disabled={!history.canRedo} onClick={() => session.redo()}>Redo</button>
      </div>
    </div>
    {scene !== null && <div class="layer-list">
      <button class={`layer-row${scene.selected === null ? ' is-selected' : ''}`} type="button" aria-pressed={scene.selected === null} onClick={() => session.select(null)}>
        <Thumbnail scene={scene} bounds={{ x: 0, y: 0, ...scene.doc.frame.master.size }} />
        <span class="layer-name">Plate</span>
      </button>
      {scene.doc.objects.map((object) => <ObjectRow key={object.id} object={object} scene={scene} session={session} />)}
    </div>}
    {scene !== null && scene.doc.objects.length === 0 && <p class="layer-hint">Tap the picture to add a layer</p>}
  </section>;
}
