import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoSession } from '../session/scene.ts';
import { Node, RangeControl } from './controls.tsx';
import { Layers, ObjectInspector } from './layers.tsx';

export function PhoneFrame({ state, session, status, preparing, busy, touch, modelsReady, projectsOpen, projects, onProjects, onOpen, onSample, onDownload, onMotion, onSymbols, onParallax, debug, onDebug, children }: {
  readonly state: ReturnType<DemoSession['snapshot']>; readonly session: DemoSession;
  readonly status: string; readonly busy: boolean; readonly touch: boolean; readonly modelsReady: boolean;
  readonly preparing: string | null;
  readonly onOpen: (file: File | undefined) => void; readonly onSample: () => void;
  readonly onDownload: () => void; readonly onMotion: () => void; readonly onSymbols: () => void;
  readonly onParallax: () => void; readonly debug: boolean; readonly onDebug: () => void; readonly children: ComponentChildren;
  readonly projectsOpen: boolean; readonly projects: ComponentChildren; readonly onProjects: () => void;
}) {
  const { scene, parallaxEnabled } = state;
  const cameraInput = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const sceneId = scene?.doc.id;
  useLayoutEffect(() => { setExpanded(sceneId !== undefined); }, [sceneId]);
  useLayoutEffect(() => {
    if (parallaxEnabled) setExpanded(false);
  }, [parallaxEnabled]);
  const selected = scene?.doc.objects.find((object) => object.id === scene.selected);
  const takePhoto = (): void => cameraInput.current?.click();
  return <>
    <header class="top-bar phone-strip">
      <span class="photo-name" title={scene?.doc.frame.original.name}>{scene?.doc.frame.original.name ?? 'No photo open'}</span>
      <div class="action-rail" aria-label="Photo actions">
        <button type="button" data-testid="projects-toggle" aria-pressed={projectsOpen} onClick={onProjects}>Projects</button>
        {touch && <button type="button" data-testid="take-photo" onClick={takePhoto}>Take a photo</button>}
        <button type="button" disabled={scene === null || busy} onClick={() => session.reset()}>Reset</button>
      </div>
      {touch && <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => {
        onOpen(event.currentTarget.files?.[0]); event.currentTarget.value = '';
      }} />}
    </header>
    <section class="phone-stage" aria-label="Photo viewer" aria-busy={busy}>
      {children}
      {!projectsOpen && preparing !== null && <p class="preparing" data-testid="preparing">{preparing}</p>}
      {projectsOpen && projects}
      {scene === null && !projectsOpen && <div class="empty-stage"><div class="empty-actions">
        {touch && <button type="button" onClick={takePhoto}>Take a photo</button>}
        <button type="button" onClick={onSample}>Try a sample</button>
      </div></div>}
    </section>
    <section class="phone-sheet" aria-label="Photo controls" hidden={projectsOpen}>
      <button class="sheet-handle" type="button" aria-expanded={expanded} aria-controls="phone-tools"
        aria-label={expanded ? 'Hide photo controls' : 'Show photo controls'} onClick={() => setExpanded((open) => !open)}>
        <span class="status-line" data-testid="status" role="status">{status}</span>
      </button>
      <div id="phone-tools" class="phone-tools" hidden={!expanded || projectsOpen}>
        {scene !== null && <>
          <section class="node" aria-label="Fry">
            <RangeControl id="style-fry" label="Fry" min={0} max={1} step={0.01} value={scene.doc.style.fry} onInput={(value) => session.setFry(value)} />
          </section>
          <ParallaxNode enabled={parallaxEnabled} available={modelsReady} onParallax={onParallax} debug={debug} onDebug={onDebug} />
          {selected !== undefined && <ObjectInspector key={selected.id} object={selected} session={session} />}
          <Layers scene={scene} session={session} />
        </>}
      </div>
    </section>
    {scene !== null && <div class="mode-rail phone-toolbar" role="group" aria-label="Viewer modes">
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
export function ParallaxNode({ enabled, available, onParallax, debug, onDebug }: {
  readonly enabled: boolean; readonly available: boolean; readonly onParallax: () => void;
  readonly debug: boolean; readonly onDebug: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return <Node name="Parallax" expanded={expanded} onExpand={() => setExpanded((open) => !open)}
    toggle={<label class="enable-switch" title="Parallax on or off">
      <input data-testid="parallax-node-enabled" type="checkbox" aria-label="Parallax" checked={enabled} disabled={!available} onChange={onParallax} />
    </label>}>
    <div class="parallax-actions"><button type="button" data-testid="parallax-debug-toggle" aria-pressed={debug}
      aria-controls="parallax-debug-panel" onClick={onDebug}>Debug</button></div>
  </Node>;
}
