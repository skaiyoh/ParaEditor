import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { RANGES } from '../core/ranges.ts';
import type { Motion } from '../core/types.ts';
import type { DemoSession } from '../session/scene.ts';
import { Node, RangeControl } from './controls.tsx';

export function PhoneFrame({ state, session, status, preparing, busy, touch, modelsReady, projectsOpen, projects, inspector, onProjects, onOpen, onSample, onDownload, onMotion, onSymbols, onParallax, children }: {
  readonly state: ReturnType<DemoSession['snapshot']>; readonly session: DemoSession;
  readonly status: string; readonly busy: boolean; readonly touch: boolean; readonly modelsReady: boolean;
  readonly preparing: string | null;
  readonly onOpen: (file: File | undefined) => void; readonly onSample: () => void;
  readonly onDownload: () => void; readonly onMotion: () => void; readonly onSymbols: () => void;
  readonly onParallax: () => void; readonly children: ComponentChildren; readonly inspector: ComponentChildren;
  readonly projectsOpen: boolean; readonly projects: (onImport: () => void) => ComponentChildren; readonly onProjects: () => void;
}) {
  const { scene, parallaxEnabled } = state;
  const cameraInput = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const sceneId = scene?.doc.id;
  useLayoutEffect(() => { setExpanded(sceneId !== undefined); }, [sceneId]);
  useLayoutEffect(() => {
    if (parallaxEnabled) setExpanded(false);
  }, [parallaxEnabled]);
  const motionEnabled = scene?.doc.motion.enabled ?? false;
  useLayoutEffect(() => {
    if (motionEnabled) setExpanded(true);
  }, [sceneId, motionEnabled]);
  const takePhoto = (): void => cameraInput.current?.click();
  return <>
    <header class="top-bar phone-strip">
      <span class="photo-name" title={scene?.doc.frame.original.name}>{scene?.doc.frame.original.name ?? 'No photo open'}</span>
      <div class="action-rail" aria-label="Photo actions">
        <button type="button" data-testid="projects-toggle" aria-pressed={projectsOpen} onClick={onProjects}>Projects</button>
        <button type="button" data-testid={touch ? 'take-photo' : 'open-photo'} onClick={takePhoto}>{touch ? 'Take a photo' : 'Open'}</button>
        {!projectsOpen && <button type="button" disabled={scene === null || busy} onClick={() => session.reset()}>Reset</button>}
      </div>
      <input ref={cameraInput} type="file" accept="image/*" capture={touch ? 'environment' : undefined} hidden onChange={(event) => {
        onOpen(event.currentTarget.files?.[0]); event.currentTarget.value = '';
      }} />
    </header>
    <section class="phone-stage" aria-label="Photo viewer" aria-busy={busy}>
      {children}
      {!projectsOpen && preparing !== null && <p class="preparing" data-testid="preparing">{preparing}</p>}
      {projectsOpen && projects(takePhoto)}
      {scene === null && !projectsOpen && <div class="empty-stage"><div class="empty-actions">
        <button type="button" onClick={takePhoto}>{touch ? 'Take a photo' : 'Open'}</button>
        <button type="button" onClick={onSample}>Try a sample</button>
      </div></div>}
    </section>
    <section class="phone-sheet" aria-label="Photo controls" hidden={projectsOpen}>
      <div class="phone-sheet-heading"><button class="sheet-handle" type="button" aria-expanded={expanded} aria-controls="phone-tools"
        aria-label={expanded ? 'Hide photo controls' : 'Show photo controls'} onClick={() => setExpanded((open) => !open)}>
        <span class="status-line" data-testid="status" role="status">{status}</span>
      </button>
      {parallaxEnabled && <button type="button" data-testid="parallax-recenter-quick" onClick={() => session.recenterParallax()}>Recenter</button>}
      </div>
      <div id="phone-tools" class="phone-tools" hidden={!expanded || projectsOpen}>
        {inspector}
      </div>
    </section>
    {scene !== null && !projectsOpen && <div class="mode-rail phone-toolbar" role="group" aria-label="Viewer modes">
      <button type="button" data-testid="motion-enabled" aria-pressed={scene.doc.motion.enabled}
        onClick={onMotion}>Motion</button>
      <button type="button" data-testid="symbols-enabled" aria-pressed={scene.doc.symbols.enabled} onClick={onSymbols}>Symbols</button>
      <button type="button" data-testid="parallax-enabled" aria-pressed={parallaxEnabled} disabled={!modelsReady}
        onClick={onParallax}>Parallax</button>
      <button class="primary-action" type="button" disabled={busy} onClick={onDownload}>Download</button>
    </div>}
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
      value={strength} onInput={(parallax) => session.setMotion({ parallax })} />
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
      value={motion.parallax} onInput={(parallax) => session.setMotion({ parallax })} />
    <div class="motion-drift" role="group" aria-label="Drift">
      <span class="motion-drift-label">Drift</span>
      <div class="motion-directions">
        {([['side', 'Side to side'], ['vertical', 'Up and down'], ['circle', 'Circle']] satisfies readonly (readonly [Motion['drift']['direction'], string])[]).map(([direction, label]) =>
          <button type="button" key={direction} data-testid={`motion-drift-${direction}`} aria-pressed={motion.drift.direction === direction}
            onClick={() => session.setMotion({ drift: { ...motion.drift, direction } })}>{label}</button>)}
      </div>
    </div>
    <RangeControl id="motion-drift-amount" label="Amount" min={RANGES['motion.drift.amount'].min} max={RANGES['motion.drift.amount'].max} step={0.01}
      value={motion.drift.amount} onInput={(amount) => session.setMotion({ drift: { ...motion.drift, amount } })} />
    <RangeControl id="motion-loopSeconds" label="Loop seconds" min={2} max={6} step={0.1}
      value={motion.loopSeconds} onInput={(loopSeconds) => session.setMotion({ loopSeconds })} />
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
