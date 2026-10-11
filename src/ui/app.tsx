import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoScene, DemoSession } from '../session/scene.ts';
import type { SceneDocument, Style } from '../core/types.ts';
import { containedImageRect } from '../core/perspective.ts';
import { RANGES } from '../core/ranges.ts';
import { EnableSwitch, GestureRange, Node, RangeControl } from './controls.tsx';
import { ContextBar, Layers } from './layers.tsx';
import { MotionControls, MotionExport, ParallaxNode, PhoneFrame } from './phone.tsx';
import { Projects } from './projects.tsx';
import { Share } from './share.tsx';
import { Icon } from './icons.tsx';
import { installKeyTexture } from './key-texture.ts';
import { ColorPicker, displayColor, useColorPalette, type PendingColor } from './color-picker.tsx';
import { CompareControls, CompareHold, CompareNotice } from './target.tsx';
import type { InputColor } from '../core/color.ts';
import type { Oklch } from '../core/raster.ts';

const PHONE_QUERY = '(width < 744px), (max-height: 500px)';
type ActiveTool = 'select' | 'sample';
type PanelName = 'actions' | 'adjust' | 'layers' | 'projects' | 'color';

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
function Stage({ scene, session, onFit, refinementSize, contained = false, visible = true, notice, activeTool = 'select', onColorSample, onTap }: {
  readonly scene: DemoScene | null; readonly session: DemoSession; readonly onFit: (percent: number) => void;
  readonly refinementSize: number | null;
  readonly contained?: boolean;
  readonly visible?: boolean;
  readonly notice?: string | null;
  readonly activeTool?: ActiveTool;
  readonly onColorSample: (color: InputColor) => void;
  /** Compact frame handles the completion of its own selection action. */
  readonly onTap?: DemoSession['tap'];
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
  const meterSize = useRef(0);
  if (refinementSize !== null) meterSize.current = Math.round(refinementSize * 100);
  const meterActive = refining && refinementSize !== null && scene !== null && visible;
  const pointAt = (node: HTMLCanvasElement, clientX: number, clientY: number) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    // The phone's canvas contains the bitmap; letterbox presses are ignored.
    const aperture = contained ? containedImageRect(box, { width: node.width, height: node.height }) : box;
    const x = (clientX - aperture.x) / aperture.width;
    const y = (clientY - aperture.y) / aperture.height;
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
    const observer = new ResizeObserver(() => {
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || node.width <= 0 || node.height <= 0) return;
      onFit(Math.round(100 * containedImageRect(box, { width: node.width, height: node.height }).width / scene.master.width));
    });
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
      if (!event.defaultPrevented && event.key === 'Escape' && gesture.current !== null) {
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
  const meter = <div class="selection-meter" data-testid="selection-meter" data-active={meterActive} aria-hidden={!meterActive}
    role="meter" aria-label="Selection" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meterSize.current}
    style={{ '--fill': `${meterSize.current}%` }}>
    <span>Selection {meterSize.current}%</span><div class="selection-meter-track" aria-hidden="true" />
  </div>;
  return <><canvas key="webgl-stage" ref={canvas} data-testid="stage" class={`stage-canvas${refining ? ' is-refining' : ''}`} hidden={scene === null || !visible} aria-label="Rendered photo"
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
      const id = point === null || activeTool === 'sample' ? null : session.objectAt(point);
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
      if (point === null) return;
      if (activeTool === 'sample') {
        const sampled = session.sampleColor(point);
        if (sampled.kind === 'sampled') onColorSample(sampled.color);
      } else void (onTap ?? session.tap)(point);
    }} />
    <div class="notice-slot" data-testid="notice">
      {meter}
      {notice != null && <p class="preparing" data-testid="preparing">{notice}</p>}
      <CompareNotice session={session} />
      {activeTool === 'sample' && <div class="sample-notice"><span>Sampling: {session.authoringState().sampleMode === 'edited' ? 'Edited' : 'Source'}</span>
        <button type="button" onClick={() => session.setTool('select')}>Cancel</button></div>}
    </div>
  </>;
}

/** Product diagnostics read the same session inputs used by the live camera. */
function ParallaxDebug({ session }: { readonly session: DemoSession }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [readings, setReadings] = useState(session.parallaxDebug());
  const [aperture, setAperture] = useState({ width: 0, height: 0, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
  useLayoutEffect(() => {
    let request = 0, last = -Infinity;
    const mark = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    const tick = (now: number): void => {
      if (now - last >= 100) {
        last = now;
        const next = session.parallaxDebug(); setReadings(next);
        const stage = document.querySelector('[data-testid="stage"]');
        const box = stage?.getBoundingClientRect();
        const image = stage instanceof HTMLCanvasElement && box !== undefined && box.width > 0 && box.height > 0
          ? containedImageRect(box, { width: stage.width, height: stage.height }) : null;
        setAperture({ width: image?.width ?? 0, height: image?.height ?? 0, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
        const context = canvas.current?.getContext('2d', { willReadFrequently: true });
        if (context !== null && context !== undefined) {
          context.clearRect(0, 0, 320, 240);
          if (next.frame !== null) {
            context.drawImage(next.frame, 0, 0, 320, 240);
            if (next.face !== null) {
              const { center, size, box } = next.face;
              context.strokeStyle = mark; context.lineWidth = 2;
              if (box !== undefined) context.strokeRect(box.x0 * 320, box.y0 * 240, (box.x1 - box.x0) * 320, (box.y1 - box.y0) * 240);
              else context.strokeRect((center.x - size / 2) * 320, (center.y - size / 2) * 240, size * 320, size * 240);
            }
          }
        }
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [session]);
  const number = (n: number | null | undefined): string => n === null || n === undefined || !Number.isFinite(n) ? 'Unavailable' : n.toFixed(2);
  const age = (capturedAt: number | undefined): string => capturedAt === undefined ? 'Unavailable' : `${Math.max(0, performance.now() - capturedAt).toFixed(0)} ms`;
  const modes = [{ value: 'auto', label: 'Auto' }, { value: 'camera', label: 'Camera' }, { value: 'tilt', label: 'Tilt' }] satisfies readonly { value: Parameters<DemoSession['setParallaxSource']>[0]; label: string }[];
  const pair = (value: { x: number; y: number }): string => `${value.x.toFixed(3)}, ${value.y.toFixed(3)}`;
  return <div class="parallax-debug-area"><section class="parallax-debug" id="parallax-debug-panel" data-testid="parallax-debug" aria-label="Parallax debug">
    <div class="parallax-source-controls" role="group" aria-label="Parallax input source">
      {modes.map(({ value, label }) => <button key={value} type="button" data-testid={`parallax-source-${value}`}
        aria-pressed={readings.sourceMode === value} onClick={() => session.setParallaxSource(value)}>{label}</button>)}
    </div>
    <canvas ref={canvas} width="320" height="240" data-testid="parallax-debug-frame" aria-label="Camera frame with detected face box" />
    <p class="parallax-camera-status" data-testid="parallax-camera-status">{readings.cameraStatus}</p>
    <dl>
      <div><dt>View coverage</dt><dd data-testid="parallax-coverage">{readings.coverage.reason ?? 'Ready'}</dd></div>
      <div><dt>Background preparation</dt><dd>{readings.preparation}</dd></div>
      <div><dt>View sample</dt><dd>{readings.viewId}</dd></div>
      <div><dt>Active source</dt><dd data-testid="parallax-active-source">{readings.source === 'none' ? 'Waiting' : readings.source}</dd></div>
      <div><dt>Camera state</dt><dd data-testid="parallax-camera-state">{readings.cameraState === 'lost' ? 'No clear face' : readings.cameraState}</dd></div>
      <div><dt>Camera age / sample</dt><dd>{age(readings.samples.camera?.capturedAt)} / {readings.samples.camera?.sequence ?? '-'}</dd></div>
      <div><dt>Camera quality</dt><dd>{number(readings.samples.camera?.quality)}</dd></div>
      <div><dt>Tilt state</dt><dd>{readings.state} ({readings.reason})</dd></div>
      <div><dt>Tilt age / sample</dt><dd>{age(readings.capturedAt)} / {readings.sequence}</dd></div>
      <div><dt>Orientation</dt><dd>{readings.pose}{readings.yawLimited ? ' (yaw unavailable)' : ''}</dd></div>
      <div><dt>Alpha</dt><dd>{number(readings.alpha)}</dd></div>
      <div><dt>Beta</dt><dd data-testid="parallax-beta">{number(readings.beta)}</dd></div>
      <div><dt>Gamma</dt><dd data-testid="parallax-gamma">{number(readings.gamma)}</dd></div>
      <div><dt>Screen type</dt><dd data-testid="parallax-screen-type">{readings.type ?? 'Unavailable'}</dd></div>
      <div><dt>Screen angle</dt><dd data-testid="parallax-screen-angle">{number(readings.angle)}</dd></div>
      <div><dt>Window angle</dt><dd data-testid="parallax-window-angle">{number(readings.legacy)}</dd></div>
      <div><dt>Mapped angle</dt><dd data-testid="parallax-mapped-angle">{number(readings.effectiveAngle)}</dd></div>
      <div><dt>Display basis</dt><dd>{readings.basisProvenance}</dd></div>
      <div><dt>Tilt before clamp</dt><dd data-testid="parallax-preclamp">{pair(readings.preclamp)}°</dd></div>
      <div><dt>Tilt target</dt><dd data-testid="parallax-tilt-target">{pair(readings.tilt)}</dd></div>
      <div><dt>Face target</dt><dd data-testid="parallax-face-target">{pair(readings.faceTarget)}</dd></div>
      <div><dt>View offset</dt><dd data-testid="parallax-fused-offset">{pair(readings.offset)}</dd></div>
      <div><dt>Stage CSS pixels</dt><dd>{Math.round(aperture.width)} × {Math.round(aperture.height)}</dd></div>
      <div><dt>Viewport / DPR</dt><dd>{aperture.viewportWidth} × {aperture.viewportHeight} / {window.devicePixelRatio}</dd></div>
    </dl>
    <button type="button" data-testid="parallax-trace-download" onClick={() => session.downloadParallaxTrace()}>Download numeric trace</button>
  </section></div>;
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

type NodeName = 'Fry' | 'Layers' | 'Motion' | 'Symbols' | 'Surface' | 'Palette' | 'Camera' | 'Color' | 'Actions';

const surfaceControls = [
  { field: 'relief', label: 'Relief' },
  { field: 'refraction', label: 'Refraction' },
  { field: 'shine', label: 'Shine' },
  { field: 'scale', label: 'Scale' },
] satisfies readonly { field: keyof Omit<SceneDocument['surface'], 'enabled' | 'pattern'>; label: string }[];

function Inspector({ scene, session, parallaxEnabled, modelsReady, onParallax, debug, onDebug, portrait = false }: {
  readonly scene: DemoScene | null; readonly session: DemoSession;
  readonly parallaxEnabled: boolean; readonly modelsReady: boolean; readonly onParallax: () => void;
  readonly debug: boolean; readonly onDebug: () => void;
  readonly portrait?: boolean;
  readonly color: (active: boolean) => ComponentChildren;
  readonly onColorApplied: (color: Oklch | null) => void;
}) {
  const [expanded, setExpanded] = useState<Readonly<Record<NodeName, boolean>>>({
    Fry: true, Layers: false, Motion: false, Symbols: false, Surface: false, Palette: false, Camera: false, Color: false, Actions: false,
  });
  const motionEnabled = scene?.doc.motion.enabled ?? false;
  useLayoutEffect(() => {
    if (portrait && motionEnabled) setExpanded((current) => current.Motion ? current : { ...current, Motion: true });
  }, [portrait, motionEnabled, scene?.doc.id]);
  const expand = (name: NodeName): void => setExpanded((current) => ({ ...current, [name]: !current[name] }));
  return <aside class={portrait ? 'sheet-inspector' : 'inspector'} aria-label="Inspector">
    {scene !== null && <div class="node-stack">
      <section class="scene-nodes" aria-label="Scene effects">
      <Node name="Motion" expanded={expanded.Motion} onExpand={() => expand('Motion')}
        toggle={<EnableSwitch name="Motion" portrait={portrait} checked={scene.doc.motion.enabled} onChange={(enabled) => session.setMotion({ enabled })} />}>
        <MotionControls motion={scene.doc.motion} session={session} />
        {scene.doc.motion.enabled && <MotionExport session={session} />}
      </Node>
      <ParallaxNode session={session} strength={scene.doc.motion.parallax} enabled={parallaxEnabled} available={modelsReady} onParallax={onParallax} debug={debug} onDebug={onDebug} />
      <Node name="Symbols" expanded={expanded.Symbols} onExpand={() => expand('Symbols')}
        toggle={<EnableSwitch name="Symbols" portrait={portrait} checked={scene.doc.symbols.enabled} onChange={(enabled) => session.setSymbols({ enabled })} />}>
        <RangeControl id="symbols-cellSize" label="Cell size" min={6} max={48} step={2} value={scene.doc.symbols.cellSize} session={session} valueFor={(cellSize) => ({ kind: 'symbols', patch: { cellSize } })} />
        <RangeControl id="symbols-amount" label="Amount" min={0} max={1} step={0.01} value={scene.doc.symbols.amount} session={session} valueFor={(amount) => ({ kind: 'symbols', patch: { amount } })} />
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
          session={session} valueFor={(value) => ({ kind: 'surface', patch: { [field]: value } })} />)}
      </Node>
      {(['Palette', 'Camera'] satisfies readonly NodeName[]).map((name) => <Node key={name} name={name} expanded={expanded[name]} onExpand={() => expand(name)}>
        {controls.filter((control) => control.group === name).map(({ field, label, min, max, step }) =>
          <RangeControl key={field} id={`style-${field}`} label={label} min={min} max={max} step={step} value={scene.doc.style[field]} session={session} valueFor={(value) => ({ kind: 'style', patch: { [field]: value } })} />)}
      </Node>)}
      </section>
    </div>}
  </aside>;
}

export function DemoApp({ session, isolated, buildId, bootError }: {
  readonly session: DemoSession; readonly isolated: boolean; readonly buildId: string; readonly bootError: string | null;
}) {
  const phone = usePhoneFrame();
  const [state, setState] = useState(session.snapshot());
  const [fit, setFit] = useState(0);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const projectsOpen = panel === 'projects';
  const activeTool = state.authoring.tool;
  const palette = useColorPalette();
  const [pendingColor, setPendingColor] = useState<PendingColor>(null);
  useLayoutEffect(() => { setPendingColor(null); }, [state.scene?.doc.id, state.scene?.selected]);
  const onColorApplied = (color: Oklch | null): void => { setPendingColor(null); if (color !== null) palette.remember(color); };
  const onColorSample = (color: InputColor): void => {
    const selected = session.snapshot().scene?.selected;
    if (selected != null) setPendingColor({ layer: selected, color });
  };
  const colorPanel = (active: boolean) => <ColorPicker session={session} palette={palette} pending={pendingColor} clearPending={() => setPendingColor(null)} active={active} />;
  const panelOpener = useRef<HTMLButtonElement | null>(null);
  const togglePanel = (name: PanelName, opener: HTMLButtonElement): void => {
    panelOpener.current = opener;
    opener.focus({ preventScroll: true });
    setPanel((current) => current === name ? null : name);
  };
  const closePanel = (): void => { setPanel(null); panelOpener.current?.focus(); };
  useLayoutEffect(() => { installKeyTexture(); }, []);
  useLayoutEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (phone || panel === null || event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]') !== null) return;
      if (session.authoringState().gesture !== null) return;
      event.preventDefault();
      // Cancel an inline edit before hiding the panel can trigger its blur.
      if (event.target instanceof HTMLInputElement) event.target.dispatchEvent(new Event('cancel'));
      setPanel(null);
      // Stage/global Escape listeners leave refinement and selection alone.
      queueMicrotask(() => panelOpener.current?.focus());
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [phone, panel]);
  const [debug, setDebug] = useState(false);
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
      if (event.defaultPrevented || document.querySelector('dialog[open]') !== null) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'file'].includes(target.type)))) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) session.redo(); else session.undo();
      } else if (event.key === 'Escape') {
        if (session.authoringState().tool === 'sample') session.setTool('select');
        else if (!session.cancelRefinement()) session.select(null);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [session]);
  const open = (file: File | undefined): void => { if (file !== undefined) { setPanel((current) => current === 'projects' ? null : current); void session.importFile(file); } };
  const sample = (): void => { setPanel((current) => current === 'projects' ? null : current); void session.importUrl('/assets-static/sample.jpg', 'sample.jpg'); };
  const download = async (): Promise<void> => {
    try { await session.savePng(); }
    catch (error) { session.reportError(error); }
  };
  const preview = session.previewDocument();
  const scene = state.scene === null || preview === null ? null : { ...state.scene, doc: preview };
  const analysis = session.analysis.snapshot();
  const elapsed = (stage: string): string => {
    const ms = timingCache.current.stages.get(stage);
    return ms === undefined ? '' : `${Math.round(ms)} ms`;
  };
  const busy = state.status === 'Importing…';
  const tapUnavailable = state.analysisStatus.startsWith('Tapping ');
  const touch = navigator.maxTouchPoints > 0;
  const status = bootError ?? shareStatus ?? (phone && scene === null && state.status === 'Drop a photo' && !state.analysisStatus.startsWith('Models unavailable:') ?
    touch ? 'Take a photo or try a sample' : 'Open a photo or try a sample'
    : state.parallaxEnabled && state.analysisStatus === 'preparing' ? `${state.status} - preparing` :
    tapUnavailable || state.status === 'Ready' || state.status === 'Drop a photo' ? state.analysisStatus : state.status);
  const preparing = shareNotice ?? state.exportProgress ?? (scene === null ? null : tapUnavailable ? state.analysisStatus
    : state.analysisStatus.startsWith('Analyzing: ') ? state.analysisStatus.replace('Analyzing: ', 'Preparing: ')
    : state.analysisStatus === 'preparing' ? 'Preparing: background'
    : state.analysisStatus === 'Warming decoder' ? state.analysisStatus
    : !analysis.decoderReady ? state.analysisStatus : null);
  const toggleMotion = (): void => { if (scene !== null) session.setMotion({ enabled: !scene.doc.motion.enabled }); };
  const toggleSymbols = (): void => { if (scene !== null) session.setSymbols({ enabled: !scene.doc.symbols.enabled }); };
  const toggleParallax = (): void => { void session.setParallax(!state.parallaxEnabled); };
  const toggleDebug = (): void => setDebug((shown) => !shown);
  if (phone) return <main class={`editor phone-editor${scene === null ? '' : ' has-photo'}`} aria-label="Photo editor"
    onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={(event) => { event.preventDefault(); open(event.dataTransfer?.files[0]); }}>
    <PhoneFrame state={{ ...state, scene }} session={session} status={status} preparing={preparing} busy={busy} touch={touch} modelsReady={analysis.modelsReady}
      projectsOpen={projectsOpen} onProjects={() => setPanel((current) => current === 'projects' ? null : 'projects')}
      projects={(onImport) => <Projects session={session} onOpened={() => setPanel(null)} onImport={onImport} onSample={sample}
        importLabel={touch ? 'Take a photo' : 'Open'} status={status} />}
      color={colorPanel} colorDot={(() => {
        const selected = scene?.doc.objects.find((object) => object.id === scene.selected);
        return <span class="color-dot" aria-label={selected?.recolor.kind === 'none' ? 'Original color' : undefined}
          style={selected?.recolor.kind === 'none' ? undefined : { background: displayColor(selected === undefined ? palette.last : selected.recolor.color).hex }}>
          {selected?.recolor.kind === 'none' && <Icon name="original" />}
        </span>;
      })()} onColorApplied={onColorApplied}
      share={<Share session={session} onNotice={setShareNotice} onStatus={setShareStatus} />}
      facts={<><h3 class="panel-heading">Scene</h3><dl class="scene-facts">
        <div><dt>Analysis</dt><dd data-testid="analysis-backend">{scene === null ? 'No photo' : analysis.backend.kind === 'gpu' ? `GPU · ${analysis.backend.name}` : 'on device'}</dd></div>
        <div><dt>Master</dt><dd>{scene === null ? 'No photo' : `${scene.master.width} × ${scene.master.height}`}</dd></div>
        <div><dt>Depth</dt><dd>{scene?.depth != null ? 'Ready' : 'Pending'} {elapsed('depth')}</dd></div>
        <div><dt>Encoder</dt><dd>{analysis.decoderReady ? 'Ready' : 'Pending'} {elapsed('encode')}</dd></div>
        <div><dt>Plate</dt><dd>{scene?.plate != null ? 'Ready' : 'Not prepared'} {elapsed('inpaint')}</dd></div>
      </dl><span class="local-models">{session.analysis.modelCount()} models local</span>
      <h3 class="panel-heading">Build</h3><div class="build-meta"><small data-testid="isolation">isolated: {isolated ? 'yes' : 'no'}</small><small data-testid="build-id">build {buildId}</small></div></>}
      inspector={<Inspector scene={scene} session={session} portrait parallaxEnabled={state.parallaxEnabled} modelsReady={analysis.modelsReady}
        onParallax={toggleParallax} debug={debug} onDebug={toggleDebug} color={colorPanel} onColorApplied={onColorApplied} />}
      onOpen={open} onSample={sample} onDownload={() => { void download(); }}
      onMotion={toggleMotion} onSymbols={toggleSymbols} onParallax={toggleParallax}>
      {(onTap) => <><Stage scene={scene} session={session} onFit={setFit} refinementSize={state.refinementSize} contained visible={!projectsOpen} activeTool={activeTool} onColorSample={onColorSample} onTap={onTap} />
      {debug && scene !== null && !projectsOpen && <ParallaxDebug session={session} />}</>}
    </PhoneFrame>
  </main>;
  const selected = scene?.doc.objects.find((object) => object.id === scene.selected);
  const history = session.historyState();
  const floatingPanel = (name: PanelName, label: string, children: ComponentChildren) =>
    <section id={`panel-${name}`} data-testid={`panel-${name}`} class={`floating-panel panel-${name}`} hidden={panel !== name} aria-label={label}>
      <div class="floating-panel-body">{children}</div>
    </section>;
  return (
    <main class={`editor full-editor${scene === null ? '' : ' has-photo'}`} aria-label="Photo editor" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(event) => { event.preventDefault(); open(event.dataTransfer?.files[0]); }}>
      <header class="top-bar">
        <div class="tool-cluster">
          <button type="button" data-testid="projects-toggle" aria-pressed={panel === 'projects'} aria-expanded={panel === 'projects'} aria-controls="panel-projects"
            onClick={(event) => togglePanel('projects', event.currentTarget)}>Projects</button>
          {floatingPanel('projects', 'Projects', <Projects session={session} onOpened={closePanel} onImport={() => input.current?.click()} onSample={sample} />)}
          <span class="tool-separator" />
          <button class="icon-button" type="button" data-testid="tool-actions" aria-label="Actions" title="Actions" aria-expanded={panel === 'actions'} aria-controls="panel-actions"
            onClick={(event) => togglePanel('actions', event.currentTarget)}><Icon name="actions" /></button>
          {floatingPanel('actions', 'Actions', <>
            <h2 class="scope-heading">Actions</h2>
            <h3 class="panel-heading">Photo</h3>
            <div class="photo-actions">
              <button type="button" onClick={() => input.current?.click()}><Icon name="open" />Open</button>
              <button type="button" data-testid="try-sample" onClick={sample}><Icon name="sample" />Try a sample</button>
              {touch && <button type="button" data-testid="take-photo" onClick={() => cameraInput.current?.click()}><Icon name="camera" />Take a photo</button>}
              <button type="button" disabled={scene === null || busy} onClick={() => session.reset()}><Icon name="reset" />Reset</button>
            </div>
            <CompareControls session={session} />
            <section class="scene-info" aria-labelledby="scene-heading">
              <h3 id="scene-heading" class="panel-heading">Scene</h3>
              <dl class="scene-facts">
                <div><dt>Analysis</dt><dd data-testid="analysis-backend">{scene === null ? 'No photo' : analysis.backend.kind === 'gpu' ? `GPU · ${analysis.backend.name}` : 'on device'}</dd></div>
                <div><dt>Master</dt><dd>{scene === null ? 'No photo' : `${scene.master.width} × ${scene.master.height}`}</dd></div>
                <div><dt>Depth</dt><dd class={scene?.depth != null ? 'fact-ready' : ''}>{scene === null ? 'No photo' : scene.depth != null ? 'Ready' : 'Pending'}<span class="fact-time">{elapsed('depth')}</span></dd></div>
                <div><dt>Encoder</dt><dd class={analysis.decoderReady ? 'fact-ready' : ''}>{scene === null ? 'No photo' : analysis.decoderReady ? 'Ready' : 'Pending'}<span class="fact-time">{elapsed('encode')}</span></dd></div>
                <div><dt>Plate</dt><dd class={scene?.plate != null ? 'fact-ready' : ''}>{scene === null ? 'No photo' : scene.plate != null ? 'Ready' : 'Not prepared'}<span class="fact-time">{elapsed('inpaint')}</span></dd></div>
              </dl>
              <span class="local-models">{session.analysis.modelCount()} models local</span>
            </section>
            <Share session={session} onNotice={setShareNotice} onStatus={setShareStatus} />
            <h3 class="panel-heading">Build</h3>
            <div class="build-meta"><small data-testid="isolation" title="Cross-origin isolation">{isolated ? 'isolated: yes' : 'isolated: no'}</small><small data-testid="build-id">build {buildId}</small></div>
          </>)}
          <button class="icon-button" type="button" data-testid="tool-adjust" aria-label="Adjustments" title="Adjustments" aria-expanded={panel === 'adjust'} aria-controls="panel-adjust"
            onClick={(event) => togglePanel('adjust', event.currentTarget)}><Icon name="adjust" /></button>
          {floatingPanel('adjust', 'Adjustments', <>
            <div class="panel-title"><h2>Adjustments</h2><span>Scene</span></div>
            <Inspector scene={scene} session={session} parallaxEnabled={state.parallaxEnabled} modelsReady={analysis.modelsReady}
              onParallax={toggleParallax} debug={debug} onDebug={toggleDebug} color={colorPanel} onColorApplied={onColorApplied} />
          </>)}
        </div>
        <p class="photo-name" title={scene?.doc.frame.original.name}>
          <span>{scene?.doc.frame.original.name ?? 'No photo open'}{selected === undefined ? '' : ` / ${selected.name}`}</span>
          {scene !== null && <span class="fit-readout">Fit {fit}%</span>}
        </p>
        <div class="tool-cluster tool-cluster-right">
          <button class="icon-button" type="button" data-testid="tool-layers" aria-label="Layers" title="Layers" aria-expanded={panel === 'layers'} aria-controls="panel-layers"
            onClick={(event) => togglePanel('layers', event.currentTarget)}><Icon name="layers" /></button>
          {floatingPanel('layers', 'Layers', <Layers scene={scene} session={session} full />)}
          <button class="icon-button" type="button" data-testid="tool-color" aria-label="Color" title="Color" aria-expanded={panel === 'color'} aria-controls="panel-color"
            onClick={(event) => togglePanel('color', event.currentTarget)}>
            <span class="color-dot" aria-label={selected?.recolor.kind === 'none' ? 'Original color' : undefined}
              style={selected?.recolor.kind === 'none' ? undefined : { background: displayColor(selected === undefined ? palette.last : selected.recolor.color).hex }}>
              {selected?.recolor.kind === 'none' && <Icon name="original" />}
            </span>
          </button>
          {floatingPanel('color', 'Color', colorPanel(panel === 'color'))}
          <span class="tool-separator" />
          <button class="primary-action" type="button" disabled={scene === null || busy} onClick={() => { void download(); }}><Icon name="download" />Download</button>
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png" hidden onChange={(event) => {
          open(event.currentTarget.files?.[0]); event.currentTarget.value = '';
        }} />
        {touch && <input ref={cameraInput} type="file" accept="image/jpeg,image/png" capture="environment" hidden onChange={(event) => {
          open(event.currentTarget.files?.[0]); event.currentTarget.value = '';
        }} />}
      </header>
      <section class="viewer" aria-label="Photo viewer">
        <div class="stage-area" aria-busy={busy}>
          <Stage scene={scene} session={session} onFit={setFit} refinementSize={state.refinementSize} contained notice={preparing} activeTool={activeTool} onColorSample={onColorSample} />
          {debug && scene !== null && <ParallaxDebug session={session} />}
          {scene === null && <div class="empty-stage"><p>Drop a photo</p><div class="empty-actions">
            <button class="primary-action" type="button" onClick={() => (touch ? cameraInput : input).current?.click()}><Icon name={touch ? 'camera' : 'open'} />{touch ? 'Take a photo' : 'Open'}</button>
            <button type="button" onClick={sample}><Icon name="sample" />Try a sample</button>
          </div></div>}
        </div>
      </section>
      <aside class="fry-rail" data-testid="fry-rail" aria-label="Fry">
        <label for="style-fry">Fry</label>
        <GestureRange session={session} valueFor={(fry) => ({ kind: 'fry', fry })} id="style-fry" data-testid="style-fry" min="0" max="1" step="0.01" value={scene?.doc.style.fry ?? 0.6} disabled={scene === null}
          style={{ '--fill': `${(scene?.doc.style.fry ?? 0.6) * 100}%` }} />
        <output for="style-fry" data-testid="value-fry">{(scene?.doc.style.fry ?? 0.6).toFixed(2)}</output>
        <span class="rail-rule" />
        <button class="icon-button" type="button" data-testid="history-undo" aria-label="Undo" title="Undo" disabled={!history.canUndo} onClick={() => session.undo()}><Icon name="undo" /></button>
        <button class="icon-button" type="button" data-testid="history-redo" aria-label="Redo" title="Redo" disabled={!history.canRedo} onClick={() => session.redo()}><Icon name="redo" /></button>
        <CompareHold session={session} />
      </aside>
      {scene !== null && selected !== undefined && <ContextBar key={selected.id} scene={scene} object={selected} session={session} onColorApplied={onColorApplied} />}
      <p class="status-line full-status" data-testid="status" role="status">{status}{NOISY_DEV && state.analysisTiming !== null ? ` (${state.analysisTiming.stage}: ${Math.round(state.analysisTiming.ms)} ms)` : ''}</p>
      {scene !== null && <div class="mode-rail mode-pill" data-testid="mode-pill" role="group" aria-label="Viewer modes">
        <button type="button" aria-pressed={scene.doc.motion.enabled} onClick={toggleMotion}><Icon name="motion" />Motion</button>
        <button type="button" aria-pressed={scene.doc.symbols.enabled} onClick={toggleSymbols}><Icon name="symbols" />Symbols</button>
        <button type="button" data-testid="parallax-enabled" aria-pressed={state.parallaxEnabled} disabled={!analysis.modelsReady} onClick={toggleParallax}><Icon name="parallax" />Parallax</button>
        {state.parallaxEnabled && <button class="icon-button" type="button" data-testid="parallax-recenter-quick" aria-label="Recenter" title="Recenter" onClick={() => session.recenterParallax()}><Icon name="recenter" /></button>}
      </div>}
    </main>
  );
}
