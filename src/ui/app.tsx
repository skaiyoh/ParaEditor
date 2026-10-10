import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoScene, DemoSession } from '../session/scene.ts';
import type { SceneDocument, Style } from '../core/types.ts';
import { applyEdit } from '../core/reduce.ts';
import { RANGES } from '../core/ranges.ts';
import { Swatches } from './swatches.tsx';
import { EnableSwitch, Node, RangeControl } from './controls.tsx';
import { Layers } from './layers.tsx';
import { PhoneFrame } from './phone.tsx';

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
function Stage({ scene, session, onFit, contained = false }: {
  readonly scene: DemoScene | null; readonly session: DemoSession; readonly onFit: (percent: number) => void;
  readonly contained?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
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
  return <canvas key="webgl-stage" ref={canvas} data-testid="stage" class="stage-canvas" hidden={scene === null} aria-label="Rendered photo"
    onClick={(event) => {
      const box = event.currentTarget.getBoundingClientRect();
      const node = event.currentTarget;
      if (box.width <= 0 || box.height <= 0) return;
      // The phone canvas fills the stage; object-fit contains its bitmap.
      // Map taps to that bitmap and ignore the surrounding letterbox.
      const scale = contained ? Math.min(box.width / node.width, box.height / node.height) : 1;
      const width = contained ? node.width * scale : box.width;
      const height = contained ? node.height * scale : box.height;
      const x = (event.clientX - box.left - (box.width - width) / 2) / width;
      const y = (event.clientY - box.top - (box.height - height) / 2) / height;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) void session.tap({ x, y });
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
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') session.select(null); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [session]);
  const open = (file: File | undefined): void => { if (file !== undefined) void session.importFile(file); };
  const sample = (): void => { void session.importUrl('/assets-static/sample.jpg', 'sample.jpg'); };
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
      onOpen={open} onSample={sample} onDownload={() => { void download(); }}
      onMotion={toggleMotion} onSymbols={toggleSymbols} onWindow={toggleWindow} onTilt={toggleTilt}>
      <Stage scene={scene} session={session} onFit={setFit} contained />
    </PhoneFrame>
  </main>;
  return (
    <main class="editor" aria-label="Photo editor" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(event) => { event.preventDefault(); open(event.dataTransfer?.files[0]); }}>
      <header class="top-bar">
        <span class="photo-name" title={scene?.doc.frame.original.name}>{scene?.doc.frame.original.name ?? 'No photo open'}</span>
        <div class="action-rail" aria-label="Photo actions">
          <button type="button" onClick={() => input.current?.click()}>Open</button>
          <button type="button" onClick={sample}>Try a sample</button>
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
