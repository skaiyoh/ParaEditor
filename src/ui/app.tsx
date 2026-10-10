import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoScene, DemoSession } from '../session/scene.ts';
import type { SceneDocument, Style } from '../core/types.ts';
import { applyEdit } from '../core/reduce.ts';
import { RANGES } from '../core/ranges.ts';
import { Swatches } from './swatches.tsx';
import { EnableSwitch, Node, RangeControl } from './controls.tsx';
import { Layers } from './layers.tsx';
import { PhoneFrame } from './phone.tsx';
import { Projects } from './projects.tsx';

const PHONE_QUERY = '(max-width: 760px), (max-height: 500px), (max-width: 1100px) and (orientation: portrait)';

function usePhoneFrame(): boolean {
  const [query] = useState(() => window.matchMedia(PHONE_QUERY));
  const [phone, setPhone] = useState(query.matches);
  useLayoutEffect(() => {
    const changed = (): void => setPhone(query.matches);
    query.addEventListener('change', changed);
    changed();
    return () => query.removeEventListener('change', changed);
  }, [query]);
  return phone;
}

/** A fresh node, never given a 2D context. The session owns its renderer. */
function Stage({ scene, session, onFit, contained = false, visible = true }: {
  readonly scene: DemoScene | null; readonly session: DemoSession; readonly onFit: (percent: number) => void;
  readonly contained?: boolean;
  readonly visible?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  type Gesture = {
    readonly pointer: number; readonly x: number; readonly y: number; readonly node: HTMLCanvasElement;
    phase: 'holding' | 'refining' | 'moved'; timer: number | null;
  };
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Set<number>());
  const suppressClick = useRef(false);
  const [refining, setRefining] = useState(false);
  const pointAt = (node: HTMLCanvasElement, clientX: number, clientY: number) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    // The phone's canvas contains the bitmap; letterbox presses are ignored.
    const scale = contained ? Math.min(box.width / node.width, box.height / node.height) : 1;
    const width = contained ? node.width * scale : box.width;
    const height = contained ? node.height * scale : box.height;
    const x = (clientX - box.left - (box.width - width) / 2) / width;
    const y = (clientY - box.top - (box.height - height) / 2) / height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };
  const clearGesture = (): void => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.timer !== null && current?.timer !== undefined) clearTimeout(current.timer);
    if (current !== null && current.node.hasPointerCapture(current.pointer)) current.node.releasePointerCapture(current.pointer);
    setRefining(false);
  };
  useLayoutEffect(() => {
    if (canvas.current !== null) return session.attachCanvas(canvas.current);
  }, [session]);
  useLayoutEffect(() => {
    const node = canvas.current;
    if (node === null || scene === null) return;
    const observer = new ResizeObserver(() => onFit(Math.round(100 * node.getBoundingClientRect().width / scene.master.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [scene?.master, onFit]);
  useLayoutEffect(() => {
    const ended = (event: PointerEvent): void => { pointers.current.delete(event.pointerId); };
    const second = (event: PointerEvent): void => {
      if (gesture.current !== null && event.pointerId !== gesture.current.pointer) {
        pointers.current.add(event.pointerId);
        suppressClick.current = true; clearGesture(); session.cancelRefinement();
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && gesture.current !== null) {
        if (gesture.current.phase === 'refining') event.preventDefault();
        suppressClick.current = true; clearGesture(); session.cancelRefinement();
      }
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('pointerdown', second, true);
    window.addEventListener('pointerup', ended, true);
    window.addEventListener('pointercancel', ended, true);
    const unsubscribe = session.subscribe((next) => {
      if (gesture.current?.phase === 'refining' && next.refiningObject === null) { suppressClick.current = true; clearGesture(); }
    });
    return () => {
      window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', second, true);
      window.removeEventListener('pointerup', ended, true); window.removeEventListener('pointercancel', ended, true);
      unsubscribe(); clearGesture(); session.cancelRefinement(); pointers.current.clear();
    };
  }, [session]);
  useLayoutEffect(() => {
    // Imports and Reset abandon a hold even before its timer has fired.
    clearGesture();
  }, [scene?.doc.id, scene?.doc.frame.master.asset, scene?.doc.objects.length]);
  return <canvas key="webgl-stage" ref={canvas} data-testid="stage" class={`stage-canvas${refining ? ' is-refining' : ''}`} hidden={scene === null || !visible} aria-label="Rendered photo"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      pointers.current.add(event.pointerId);
      if (pointers.current.size > 1) { suppressClick.current = true; clearGesture(); session.cancelRefinement(); return; }
      clearGesture(); suppressClick.current = false;
      const node = event.currentTarget;
      // Synthesized events have no native active pointer; real input is captured.
      try { node.setPointerCapture(event.pointerId); } catch { /* No native pointer to capture. */ }
      const current: Gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, node, phase: 'holding', timer: null };
      gesture.current = current;
      const point = pointAt(node, event.clientX, event.clientY);
      const id = point === null ? null : session.objectAt(point);
      if (id !== null) current.timer = window.setTimeout(() => {
        current.timer = null;
        if (gesture.current !== current || current.phase !== 'holding') return;
        if (session.beginRefinement(id)) { current.phase = 'refining'; suppressClick.current = true; setRefining(true); }
      }, 350);
    }}
    onPointerMove={(event) => {
      const current = gesture.current;
      if (current === null || current.pointer !== event.pointerId) return;
      const travel = event.clientX - current.x;
      if (current.phase === 'refining') { session.moveRefinement(travel); return; }
      if (Math.hypot(travel, event.clientY - current.y) > 8) {
        current.phase = 'moved'; suppressClick.current = true;
        if (current.timer !== null) { clearTimeout(current.timer); current.timer = null; }
      }
    }}
    onPointerUp={(event) => {
      pointers.current.delete(event.pointerId);
      const current = gesture.current;
      if (current === null || current.pointer !== event.pointerId) return;
      if (current.phase === 'refining') { session.moveRefinement(event.clientX - current.x); void session.commitRefinement(); }
      clearGesture();
    }}
    onPointerCancel={(event) => {
      pointers.current.delete(event.pointerId);
      if (gesture.current?.pointer === event.pointerId) { suppressClick.current = true; clearGesture(); session.cancelRefinement(); }
    }}
    onLostPointerCapture={(event) => {
      if (gesture.current?.pointer === event.pointerId) { suppressClick.current = true; clearGesture(); session.cancelRefinement(); }
    }}
    onContextMenu={(event) => event.preventDefault()}
    onClick={(event) => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      const point = pointAt(event.currentTarget, event.clientX, event.clientY);
      if (point !== null) void session.tap(point);
    }} />;
}

const controls = [
  { field: 'fry', label: 'Fry', max: 1, min: 0, step: 0.01, group: 'Fry' },
  { field: 'colors', label: 'Colors', max: 12, min: 2, step: 1, group: 'Palette' },
  { field: 'bands', label: 'Bands', max: 6, min: 2, step: 1, group: 'Palette' },
  { field: 'saturation', label: 'Saturation', max: 1, min: 0, step: 0.01, group: 'Palette' },
  { field: 'simplify', label: 'Simplify', max: 1, min: 0, step: 0.01, group: 'Palette' },
  { field: 'outline', label: 'Outline', max: 1, min: 0, step: 0.01, group: 'Palette' },
  { field: 'subjectClarity', label: 'Subject clarity', max: 1, min: 0, step: 0.01, group: 'Palette' },
  { field: 'grain', label: 'Grain', max: 1, min: 0, step: 0.01, group: 'Camera' },
  { field: 'colorNoise', label: 'Color noise', max: 1, min: 0, step: 0.01, group: 'Camera' },
  { field: 'grainSize', label: 'Grain size', max: 4, min: 1, step: 1, group: 'Camera' },
  { field: 'crunch', label: 'Crunch', max: 1, min: 0, step: 0.01, group: 'Camera' },
  { field: 'clipping', label: 'Clipping', max: 1, min: 0, step: 0.01, group: 'Camera' },
] satisfies readonly { field: keyof Style; label: string; max: number; min: number; step: number; group: string }[];

type NodeName = 'Fry' | 'Motion' | 'Symbols' | 'Surface' | 'Palette' | 'Camera';

const surfaceControls = [
  { field: 'relief', label: 'Relief' },
  { field: 'refraction', label: 'Refraction' },
  { field: 'shine', label: 'Shine' },
  { field: 'scale', label: 'Scale' },
] satisfies readonly { field: keyof Omit<SceneDocument['surface'], 'enabled' | 'pattern'>; label: string }[];

function editSymbols(session: DemoSession, patch: Partial<SceneDocument['symbols']>): void {
  const scene = session.snapshot().scene;
  if (scene === null) return;
  const result = applyEdit(scene.doc, { kind: 'symbols', patch }, new Date().toISOString());
  if (result.kind === 'applied') session.setDocument(result.doc);
}

function Inspector({ scene, session }: { readonly scene: DemoScene | null; readonly session: DemoSession }) {
  const [expanded, setExpanded] = useState<Readonly<Record<NodeName, boolean>>>({
    Fry: true, Motion: false, Symbols: false, Surface: false, Palette: true, Camera: true,
  });
  const selected = scene?.doc.objects.find((object) => object.id === scene.selected);
  const expand = (name: NodeName): void => setExpanded((current) => ({ ...current, [name]: !current[name] }));
  return <aside class="inspector" aria-label="Inspector">
    <h2 class="scope-heading">Scene</h2>
    {scene !== null && <div class="node-stack">
      {selected !== undefined && <section class="object-node" aria-label="Object"><h3 class="object-heading" title={selected.name}>{selected.name}</h3><Swatches session={session} recolor={selected.recolor} /></section>}
      <Node name="Fry" expanded={expanded.Fry} onExpand={() => expand('Fry')}>
        {controls.filter((control) => control.group === 'Fry').map(({ field, label, min, max, step }) =>
          <RangeControl key={field} id={`style-${field}`} label={label} min={min} max={max} step={step} value={scene.doc.style[field]} onInput={(value) => session.setFry(value)} />)}
      </Node>
      <Node name="Motion" expanded={expanded.Motion} onExpand={() => expand('Motion')}
        toggle={<EnableSwitch name="Motion" checked={scene.doc.motion.enabled} onChange={(enabled) => session.setMotion({ enabled })} />}>
        <RangeControl id="motion-orbit" label="Orbit" min={0} max={1} step={0.01} value={scene.doc.motion.orbit} onInput={(orbit) => session.setMotion({ orbit })} />
        <RangeControl id="motion-parallax" label="Parallax" min={RANGES['motion.parallax'].min} max={RANGES['motion.parallax'].max} step={0.1}
          value={scene.doc.motion.parallax} onInput={(parallax) => session.setMotion({ parallax })} />
        <RangeControl id="motion-loopSeconds" label="Loop seconds" min={2} max={6} step={0.1} value={scene.doc.motion.loopSeconds} onInput={(loopSeconds) => session.setMotion({ loopSeconds })} />
      </Node>
      <Node name="Symbols" expanded={expanded.Symbols} onExpand={() => expand('Symbols')}
        toggle={<EnableSwitch name="Symbols" checked={scene.doc.symbols.enabled} onChange={(enabled) => editSymbols(session, { enabled })} />}>
        <RangeControl id="symbols-cellSize" label="Cell size" min={6} max={48} step={2} value={scene.doc.symbols.cellSize} onInput={(cellSize) => editSymbols(session, { cellSize })} />
        <RangeControl id="symbols-amount" label="Amount" min={0} max={1} step={0.01} value={scene.doc.symbols.amount} onInput={(amount) => editSymbols(session, { amount })} />
      </Node>
      <Node name="Surface" expanded={expanded.Surface} onExpand={() => expand('Surface')}
        toggle={<label class="enable-switch" title="Surface on or off">
          <input data-testid="surface-enabled" type="checkbox" aria-label="Surface" checked={scene.doc.surface.enabled}
            onChange={(event) => session.setSurface({ enabled: event.currentTarget.checked })} />
        </label>}>
        <div class="mode-rail" role="group" aria-label="Surface pattern">
          {([
            { pattern: 'bars', label: 'Bars' }, { pattern: 'cracks', label: 'Cracks' }, { pattern: 'scales', label: 'Scales' },
          ] satisfies readonly { pattern: SceneDocument['surface']['pattern']; label: string }[]).map(({ pattern, label }) =>
            <button key={pattern} type="button" aria-pressed={scene.doc.surface.pattern === pattern}
              onClick={() => session.setSurface({ pattern })}>{label}</button>)}
        </div>
        {surfaceControls.map(({ field, label }) => <RangeControl key={field} id={`surface-${field}`} label={label}
          min={RANGES[`surface.${field}`].min} max={RANGES[`surface.${field}`].max} step={0.01} value={scene.doc.surface[field]}
          onInput={(value) => session.setSurface({ [field]: value })} />)}
      </Node>
      {(['Palette', 'Camera'] satisfies readonly NodeName[]).map((name) => <Node key={name} name={name} expanded={expanded[name]} onExpand={() => expand(name)}>
        {controls.filter((control) => control.group === name).map(({ field, label, min, max, step }) =>
          <RangeControl key={field} id={`style-${field}`} label={label} min={min} max={max} step={step} value={scene.doc.style[field]} onInput={(value) => session.setStyle({ [field]: value })} />)}
      </Node>)}
    </div>}
  </aside>;
}

export function DemoApp({ session, isolated, buildId, bootError }: {
  readonly session: DemoSession; readonly isolated: boolean; readonly buildId: string; readonly bootError: string | null;
}) {
  const phone = usePhoneFrame();
  const [state, setState] = useState(session.snapshot());
  const [fit, setFit] = useState(0);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const observedTiming = useRef(state.analysisTiming);
  const timingCache = useRef<{ sceneId: SceneDocument['id'] | null; stages: Map<string, number> }>({ sceneId: null, stages: new Map() });
  useLayoutEffect(() => session.subscribe((next) => {
    const sceneId = next.scene?.doc.id ?? null;
    if (timingCache.current.sceneId !== sceneId) timingCache.current = { sceneId, stages: new Map() };
    const timing = next.analysisTiming;
    if (sceneId !== null && timing !== null && (timing.stage !== observedTiming.current?.stage || timing.ms !== observedTiming.current?.ms)) {
      timingCache.current.stages.set(timing.stage, timing.ms);
    }
    observedTiming.current = timing;
    setState(next);
  }), [session]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && !session.cancelRefinement()) session.select(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [session]);
  const open = (file: File | undefined): void => { if (file !== undefined) { setProjectsOpen(false); void session.importFile(file); } };
  const sample = (): void => { setProjectsOpen(false); void session.importUrl('/assets-static/sample.jpg', 'sample.jpg'); };
  const download = async (): Promise<void> => {
    try { await session.savePng(); }
    catch (error) { session.reportError(error); }
  };
  const scene = state.scene;
  const analysis = session.analysis.snapshot();
  const elapsed = (stage: string): string => {
    const ms = timingCache.current.stages.get(stage);
    return ms === undefined ? '' : `${Math.round(ms)} ms`;
  };
  const busy = state.status === 'Importing…';
  const status = bootError ?? (state.status === 'Ready' || state.status === 'Drop a photo' ? state.analysisStatus : state.status);
  const touch = navigator.maxTouchPoints > 0;
  const toggleMotion = (): void => { if (scene !== null) session.setMotion({ enabled: !scene.doc.motion.enabled }); };
  const toggleSymbols = (): void => { if (scene !== null) editSymbols(session, { enabled: !scene.doc.symbols.enabled }); };
  const toggleWindow = (): void => { void session.setWindow(!state.windowEnabled); };
  const toggleTilt = (): void => { void session.setTilt(!state.tiltEnabled); };
  if (phone) return <main class={`editor phone-editor${scene === null ? '' : ' has-photo'}`} aria-label="Photo editor"
    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={(event) => { event.preventDefault(); open(event.dataTransfer?.files[0]); }}>
    <PhoneFrame state={state} session={session} status={status} busy={busy} touch={touch} modelsReady={analysis.modelsReady}
      projectsOpen={projectsOpen} onProjects={() => setProjectsOpen((open) => !open)}
      projects={<Projects session={session} onOpened={() => setProjectsOpen(false)} />}
      onOpen={open} onSample={sample} onDownload={() => { void download(); }}
      onMotion={toggleMotion} onSymbols={toggleSymbols} onWindow={toggleWindow} onTilt={toggleTilt}>
      <Stage scene={scene} session={session} onFit={setFit} contained visible={!projectsOpen} />
    </PhoneFrame>
  </main>;
  return (
    <main class="editor" aria-label="Photo editor" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(event) => { event.preventDefault(); open(event.dataTransfer?.files[0]); }}>
      <header class="top-bar">
        <span class="photo-name" title={scene?.doc.frame.original.name}>{scene?.doc.frame.original.name ?? 'No photo open'}</span>
        <div class="action-rail" aria-label="Photo actions">
          <button type="button" data-testid="projects-toggle" aria-pressed={projectsOpen} onClick={() => setProjectsOpen((open) => !open)}>Projects</button>
          <button type="button" onClick={() => input.current?.click()}>Open</button>
          <button type="button" data-testid="try-sample" onClick={sample}>Try a sample</button>
          {touch && <button type="button" data-testid="take-photo" onClick={() => cameraInput.current?.click()}>Take a photo</button>}
          <button type="button" disabled={scene === null || busy} onClick={() => session.reset()}>Reset</button>
          <button class="primary-action" type="button" disabled={scene === null || busy} onClick={() => { void download(); }}>Download</button>
        </div>
        <input ref={input} type="file" accept="image/*,.heic,.heif" hidden onChange={(event) => {
          open(event.currentTarget.files?.[0]); event.currentTarget.value = '';
        }} />
        {touch && <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => {
          open(event.currentTarget.files?.[0]); event.currentTarget.value = '';
        }} />}
      </header>
      <div class="workspace">
        <aside class="scene-sidebar" aria-label="Layers and scene">
          {projectsOpen ? <Projects session={session} onOpened={() => setProjectsOpen(false)} /> : <>
          <Layers scene={scene} session={session} />
          <section class="scene-info" aria-labelledby="scene-heading">
            <h2 id="scene-heading" class="panel-heading">Scene</h2>
            <dl class="scene-facts">
              <div><dt>Master</dt><dd>{scene === null ? 'No photo' : `${scene.master.width} × ${scene.master.height}`}</dd></div>
              <div><dt>Depth</dt><dd class={scene?.depth != null ? 'fact-ready' : ''}>{scene?.depth != null ? 'Ready' : 'Pending'}<span class="fact-time">{elapsed('depth')}</span></dd></div>
              <div><dt>Encoder</dt><dd class={analysis.decoderReady ? 'fact-ready' : ''}>{analysis.decoderReady ? 'Ready' : 'Pending'}<span class="fact-time">{elapsed('encode')}</span></dd></div>
              <div><dt>Plate</dt><dd class={scene?.plate != null ? 'fact-ready' : ''}>{scene?.plate != null ? 'Ready' : 'Not prepared'}<span class="fact-time">{elapsed('inpaint')}</span></dd></div>
            </dl>
            <span class="local-models">{session.analysis.modelCount()} models local</span>
          </section>
          </>}
        </aside>
        <section class="viewer" aria-label="Photo viewer">
          <div class="viewer-toolbar"><span>Fit{scene !== null ? ` ${fit}%` : ''}</span></div>
          <div class="stage-area" aria-busy={busy}>
            <Stage scene={scene} session={session} onFit={setFit} />
            {scene === null && <div class="empty-stage"><p>Drop a photo</p><div class="empty-actions">
              <button type="button" onClick={() => input.current?.click()}>Open</button>
              <button type="button" onClick={sample}>Try a sample</button>
            </div></div>}
          </div>
        </section>
        <Inspector scene={scene} session={session} />
      </div>
      <footer class="bottom-bar">
        <p class="status-line" data-testid="status" role="status">{status}{NOISY_DEV && state.analysisTiming !== null ? ` (${state.analysisTiming.stage}: ${Math.round(state.analysisTiming.ms)} ms)` : ''}</p>
        <div class="mode-rail" aria-label="Viewer modes">
          {scene !== null && <>
            <button type="button" aria-pressed={scene.doc.motion.enabled} onClick={toggleMotion}>Motion</button>
            <button type="button" aria-pressed={scene.doc.symbols.enabled} onClick={toggleSymbols}>Symbols</button>
            <button type="button" data-testid="window-enabled" aria-pressed={state.windowEnabled} disabled={!analysis.modelsReady} onClick={toggleWindow}>Window</button>
            {touch && <button type="button" data-testid="tilt-enabled" aria-pressed={state.tiltEnabled} disabled={!analysis.modelsReady} onClick={toggleTilt}>Tilt</button>}
          </>}
        </div>
        <div class="build-meta"><small data-testid="isolation" title="Cross-origin isolation">{isolated ? 'isolated: yes' : 'isolated: no'}</small><small data-testid="build-id">build {buildId}</small></div>
      </footer>
    </main>
  );
}
