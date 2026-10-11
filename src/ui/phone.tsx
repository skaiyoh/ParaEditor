import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { RANGES } from '../core/ranges.ts';
import type { Oklch } from '../core/raster.ts';
import type { Motion } from '../core/types.ts';
import type { DemoSession } from '../session/scene.ts';
import { GestureRange, Node, RangeControl } from './controls.tsx';
import { Icon } from './icons.tsx';
import { ContextBar, Layers } from './layers.tsx';
import { CompareControls } from './target.tsx';

type PhoneTab = 'adjust' | 'layers' | 'color' | 'actions';
const tabs = [
  { id: 'adjust', label: 'Adjust', name: 'Adjustments' },
  { id: 'layers', label: 'Layers', name: 'Layers' },
  { id: 'color', label: 'Color', name: 'Color' },
  { id: 'actions', label: 'Actions', name: 'Actions' },
] satisfies readonly { id: PhoneTab; label: string; name: string }[];

export function PhoneFrame({ state, session, status, preparing, busy, touch, modelsReady, projectsOpen, projects, inspector, color, colorDot, share, facts, onColorApplied, onProjects, onOpen, onSample, onDownload, onMotion, onSymbols, onParallax, children }: {
  readonly state: ReturnType<DemoSession['snapshot']>; readonly session: DemoSession;
  readonly status: string; readonly busy: boolean; readonly touch: boolean; readonly modelsReady: boolean;
  readonly preparing: string | null;
  readonly onOpen: (file: File | undefined) => void; readonly onSample: () => void;
  readonly onDownload: () => void; readonly onMotion: () => void; readonly onSymbols: () => void;
  readonly onParallax: () => void; readonly children: (onTap: DemoSession['tap']) => ComponentChildren; readonly inspector: ComponentChildren;
  readonly color: (active: boolean) => ComponentChildren; readonly colorDot: ComponentChildren;
  readonly share: ComponentChildren; readonly facts: ComponentChildren;
  readonly onColorApplied: (color: Oklch | null) => void;
  readonly projectsOpen: boolean; readonly projects: (onImport: () => void) => ComponentChildren; readonly onProjects: () => void;
}) {
  const { scene, parallaxEnabled } = state;
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<PhoneTab>('adjust');
  const sceneId = scene?.doc.id;
  const selected = scene?.doc.objects.find((object) => object.id === scene.selected);
  const history = session.historyState();
  useLayoutEffect(() => { setExpanded(sceneId !== undefined); setTab('adjust'); }, [sceneId]);
  const motionEnabled = scene?.doc.motion.enabled ?? false;
  const previousMotion = useRef(motionEnabled);
  useLayoutEffect(() => {
    let frame = 0;
    if (motionEnabled && !previousMotion.current) {
      setTab('adjust'); setExpanded(true);
      // The Inspector expands Motion in its layout effect; reveal its export row after that render.
      frame = requestAnimationFrame(() => {
        const body = sheet.current?.querySelector('.panel-adjust');
        const exports = body?.querySelector('.motion-export');
        if (body instanceof HTMLElement && exports instanceof HTMLElement) {
          const bounds = body.getBoundingClientRect(), box = exports.getBoundingClientRect();
          if (box.bottom > bounds.bottom) body.scrollTop += box.bottom - bounds.bottom;
          else if (box.top < bounds.top) body.scrollTop += box.top - bounds.top;
        }
      });
    }
    previousMotion.current = motionEnabled;
    return () => cancelAnimationFrame(frame);
  }, [motionEnabled]);
  useLayoutEffect(() => { if (parallaxEnabled) setExpanded(false); }, [parallaxEnabled]);
  const selectAt: DemoSession['tap'] = async (at) => {
    const before = session.snapshot().scene;
    await session.tap(at);
    const after = session.snapshot().scene;
    if (after !== null && after !== before && after.doc.id === before?.doc.id && after.selected !== null) setExpanded(false);
  };
  useLayoutEffect(() => {
    const node = sheet.current, editor = node?.closest<HTMLElement>('.phone-editor');
    if (node == null || editor == null) return;
    const measure = (): void => {
      if (!node.hidden) editor.style.setProperty('--phone-sheet-height', `${node.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, projectsOpen, status]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || !expanded || projectsOpen || document.querySelector('dialog[open]') !== null || session.authoringState().gesture !== null) return;
      event.preventDefault();
      if (event.target instanceof HTMLInputElement) event.target.dispatchEvent(new Event('cancel'));
      setExpanded(false);
      queueMicrotask(() => opener.current?.focus());
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [expanded, projectsOpen, session]);
  const takePhoto = (): void => (touch ? cameraInput : fileInput).current?.click();
  const openTab = (next: PhoneTab, button: HTMLButtonElement): void => {
    opener.current = button; button.focus({ preventScroll: true });
    if (projectsOpen) onProjects();
    setExpanded(projectsOpen || tab !== next || !expanded); setTab(next);
  };
  const tabKey = (event: KeyboardEvent, index: number): void => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (target !== undefined) { setTab(target.id); document.getElementById(`phone-tab-${target.id}`)?.focus(); }
  };
  return <>
    <header class="top-bar phone-strip">
      <span class="photo-name visually-hidden">{scene?.doc.frame.original.name ?? 'No photo open'}</span>
      <div class="tool-cluster" aria-label="Photo tools">
        <button class="icon-button" type="button" data-testid="projects-toggle" aria-label="Projects" title="Projects" aria-pressed={projectsOpen} aria-expanded={projectsOpen} aria-controls="phone-projects" onClick={onProjects}><Icon name="projects" /></button>
        {(['actions', 'adjust', 'layers'] satisfies readonly PhoneTab[]).map((name) => <button key={name} class="icon-button" type="button" data-testid={`tool-${name}`} aria-label={name === 'adjust' ? 'Adjustments' : name === 'actions' ? 'Actions' : 'Layers'} title={name === 'adjust' ? 'Adjustments' : name === 'actions' ? 'Actions' : 'Layers'} aria-expanded={!projectsOpen && expanded && tab === name} aria-controls={`panel-${name}`} onClick={(event) => openTab(name, event.currentTarget)}><Icon name={name} /></button>)}
        <button class="icon-button" type="button" data-testid="tool-color" aria-label="Color" title="Color" aria-expanded={!projectsOpen && expanded && tab === 'color'} aria-controls="panel-color" onClick={(event) => openTab('color', event.currentTarget)}>{colorDot}</button>
      </div>
      <button class="primary-action" type="button" disabled={scene === null || busy || projectsOpen} onClick={onDownload}><Icon name="download" />Download</button>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png" hidden onChange={(event) => { onOpen(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
      {touch && <input ref={cameraInput} type="file" accept="image/jpeg,image/png" capture="environment" hidden onChange={(event) => { onOpen(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />}
    </header>
    <section class="phone-stage" aria-label="Photo viewer" aria-busy={busy}>
      {children(selectAt)}
      {!projectsOpen && preparing !== null && <p class="preparing" data-testid="preparing">{preparing}</p>}
      {projectsOpen && <div id="phone-projects">{projects(takePhoto)}</div>}
      {scene === null && !projectsOpen && <div class="empty-stage"><div class="empty-actions">
        <button class="primary-action" type="button" onClick={takePhoto}>{touch ? 'Take a photo' : 'Open'}</button>
        <button type="button" onClick={onSample}>Try a sample</button>
      </div></div>}
    </section>
    {!projectsOpen && <aside class="fry-rail" data-testid="fry-rail" aria-label="Fry">
      <label for="style-fry">Fry</label>
      <GestureRange session={session} valueFor={(fry) => ({ kind: 'fry', fry })} id="style-fry" data-testid="style-fry" min="0" max="1" step="0.01" value={scene?.doc.style.fry ?? 0.6} disabled={scene === null}
        style={{ '--fill': `${(scene?.doc.style.fry ?? 0.6) * 100}%` }} />
      <output for="style-fry" data-testid="value-fry">{(scene?.doc.style.fry ?? 0.6).toFixed(2)}</output>
    </aside>}
    <section ref={sheet} class="phone-sheet" aria-label="Photo controls" hidden={projectsOpen} data-expanded={expanded}>
      <div class="phone-sheet-heading">
        <button class="sheet-handle" type="button" aria-expanded={expanded} aria-controls="phone-tools" aria-label={expanded ? 'Hide photo controls' : 'Show photo controls'} onClick={(event) => { opener.current = event.currentTarget; setExpanded((open) => !open); }}><span aria-hidden="true" /></button>
        <button class="icon-button" type="button" data-testid="history-undo" aria-label="Undo" title="Undo" disabled={!history.canUndo} onClick={() => session.undo()}><Icon name="undo" /></button>
        <button class="icon-button" type="button" data-testid="history-redo" aria-label="Redo" title="Redo" disabled={!history.canRedo} onClick={() => session.redo()}><Icon name="redo" /></button>
        <p class="status-line" data-testid="status" role="status">{status}</p>
      </div>
      <div id="phone-tools" class="phone-sheet-content" hidden={!expanded || projectsOpen}>
        <div class="phone-tabs" role="tablist" aria-label="Photo controls">
          {tabs.map(({ id, label }, index) => <button type="button" key={id} id={`phone-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => tabKey(event, index)} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        {tabs.map(({ id }) => <section key={id} id={`panel-${id}`} data-testid={`panel-${id}`} class={`phone-tools panel-${id}`} role="tabpanel" aria-labelledby={`phone-tab-${id}`} tabIndex={0} hidden={tab !== id} onClick={(event) => {
            // Shared Layers selects synchronously. Collapse only for its selection buttons.
            if (event.target instanceof Element && event.target.closest('button.layer-select, button.layer-name[aria-label^="Select "]') !== null) setExpanded(false);
          }}>
          {id === 'adjust' && inspector}
          {id === 'layers' && <Layers scene={scene} session={session} full />}
          {id === 'color' && color(expanded && !projectsOpen && tab === 'color')}
          {id === 'actions' && <>
            <h3 class="panel-heading">Photo</h3><div class="photo-actions">
              <button type="button" data-testid="open-photo" onClick={() => fileInput.current?.click()}><Icon name="open" />Open</button>
              <button type="button" data-testid="try-sample" onClick={onSample}><Icon name="sample" />Try a sample</button>
              {touch && <button type="button" data-testid="take-photo" onClick={takePhoto}><Icon name="camera" />Take a photo</button>}
              <button type="button" disabled={scene === null || busy} onClick={() => session.reset()}><Icon name="reset" />Reset</button>
            </div><CompareControls session={session} />{share}{facts}
          </>}
        </section>)}
      </div>
    </section>
    {scene !== null && !projectsOpen && <>
      {selected !== undefined && <ContextBar key={selected.id} scene={scene} object={selected} session={session} onColorApplied={onColorApplied} />}
      <div class="mode-rail mode-pill phone-toolbar" data-testid="mode-pill" role="group" aria-label="Viewer modes">
        <button type="button" data-testid="motion-enabled" aria-pressed={scene.doc.motion.enabled} onClick={onMotion}><Icon name="motion" />Motion</button>
        <button type="button" data-testid="symbols-enabled" aria-pressed={scene.doc.symbols.enabled} onClick={onSymbols}><Icon name="symbols" />Symbols</button>
        <button type="button" data-testid="parallax-enabled" aria-pressed={parallaxEnabled} disabled={!modelsReady} onClick={onParallax}><Icon name="parallax" />Parallax</button>
        {parallaxEnabled && <button class="icon-button" type="button" data-testid="parallax-recenter-quick" aria-label="Recenter" title="Recenter" onClick={() => session.recenterParallax()}><Icon name="recenter" /></button>}
      </div>
    </>}
  </>;
}

/** Same node and toggle state in the inspector and the phone's tool sheet. */
export function ParallaxNode({ session, strength, enabled, available, onParallax, debug, onDebug }: {
  readonly session: DemoSession; readonly strength: number;
  readonly enabled: boolean; readonly available: boolean; readonly onParallax: () => void;
  readonly debug: boolean; readonly onDebug: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <Node name="Parallax" expanded={expanded} onExpand={() => setExpanded((open) => !open)}
    toggle={<label class="enable-switch" title="Parallax on or off">
      <input data-testid="parallax-node-enabled" type="checkbox" aria-label="Parallax" checked={enabled} disabled={!available} onChange={onParallax} />
    </label>}>
    <RangeControl id="parallax-strength" label="Strength" min={RANGES['motion.parallax'].min} max={RANGES['motion.parallax'].max} step={0.1}
      value={strength} session={session} valueFor={(parallax) => ({ kind: 'motion', patch: { parallax } })} />
    <p class="parallax-help">{enabled ? 'Hold still to center, then move your head. Recenter after changing position.' : 'Move your head to look into the photo. Tilt is used when face tracking is unavailable.'}</p>
    <div class="parallax-actions"><button type="button" data-testid="parallax-recenter" disabled={!enabled}
      onClick={() => session.recenterParallax()}>Recenter</button><button type="button" data-testid="parallax-debug-toggle" aria-pressed={debug}
      aria-controls="parallax-debug-panel" onClick={onDebug}>Debug</button></div>
  </Node>;
}

/** The same motion controls in the desktop inspector and phone sheet. */
export function MotionControls({ motion, session }: { readonly motion: Motion; readonly session: DemoSession }) {
  return <>
    <RangeControl id="motion-parallax" label="Depth" min={RANGES['motion.parallax'].min} max={RANGES['motion.parallax'].max} step={0.1}
      value={motion.parallax} session={session} valueFor={(parallax) => ({ kind: 'motion', patch: { parallax } })} />
    <div class="motion-drift" role="group" aria-label="Drift">
      <span class="motion-drift-label">Drift</span>
      <div class="motion-directions">
        {([['side', 'Side to side'], ['vertical', 'Up and down'], ['circle', 'Circle']] satisfies readonly (readonly [Motion['drift']['direction'], string])[]).map(([direction, label]) =>
          <button type="button" key={direction} data-testid={`motion-drift-${direction}`} aria-pressed={motion.drift.direction === direction}
            onClick={() => session.setMotion({ drift: { ...motion.drift, direction } })}>{label}</button>)}
      </div>
    </div>
    <RangeControl id="motion-drift-amount" label="Amount" min={RANGES['motion.drift.amount'].min} max={RANGES['motion.drift.amount'].max} step={0.01}
      value={motion.drift.amount} session={session} valueFor={(amount) => ({ kind: 'motion', patch: { drift: { ...motion.drift, amount } } })} />
    <RangeControl id="motion-loopSeconds" label="Loop seconds" min={2} max={6} step={0.1}
      value={motion.loopSeconds} session={session} valueFor={(loopSeconds) => ({ kind: 'motion', patch: { loopSeconds } })} />
  </>;
}

/** One export row shared by the inspector and the phone's Motion node. */
export function MotionExport({ session }: { readonly session: DemoSession }) {
  const format = session.movieFormat();
  return <div class="motion-export" role="group" aria-label="Export loop">
    <span>Export</span>
    <button type="button" data-testid="export-gif" onClick={() => { void session.saveLoop('gif'); }}>GIF</button>
    <button type="button" data-testid="export-movie" disabled={format === null}
      title={format === null ? 'Movie recording is unavailable in this browser.' : `Export one loop as ${format.label}`}
      onClick={() => { void session.saveLoop('movie'); }}>Movie{format === null ? '' : ` (${format.label})`}</button>
  </div>;
}
