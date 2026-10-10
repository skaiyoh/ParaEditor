import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoSession } from '../session/scene.ts';
import { RangeControl } from './controls.tsx';
import { Swatches } from './swatches.tsx';

export function PhoneFrame({ state, session, status, busy, touch, modelsReady, projectsOpen, projects, onProjects, onOpen, onSample, onDownload, onMotion, onSymbols, onWindow, onTilt, children }: {
  readonly state: ReturnType<DemoSession['snapshot']>; readonly session: DemoSession;
  readonly status: string; readonly busy: boolean; readonly touch: boolean; readonly modelsReady: boolean;
  readonly onOpen: (file: File | undefined) => void; readonly onSample: () => void;
  readonly onDownload: () => void; readonly onMotion: () => void; readonly onSymbols: () => void;
  readonly onWindow: () => void; readonly onTilt: () => void; readonly children: ComponentChildren;
  readonly projectsOpen: boolean; readonly projects: ComponentChildren; readonly onProjects: () => void;
}) {
  const { scene, windowEnabled, tiltEnabled } = state;
  const cameraInput = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const sceneId = scene?.doc.id;
  useLayoutEffect(() => { setExpanded(sceneId !== undefined); }, [sceneId]);
  useLayoutEffect(() => {
    if (windowEnabled || tiltEnabled) setExpanded(false);
  }, [windowEnabled, tiltEnabled]);
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
          {selected !== undefined && <section class="object-node" aria-label="Object">
            <h3 class="object-heading" title={selected.name}>{selected.name}</h3>
            <Swatches session={session} recolor={selected.recolor} />
          </section>}
        </>}
      </div>
    </section>
    {scene !== null && <div class="mode-rail phone-toolbar" role="group" aria-label="Viewer modes">
      <button type="button" data-testid="motion-enabled" aria-pressed={scene.doc.motion.enabled}
        onClick={onMotion}>Motion</button>
      <button type="button" data-testid="symbols-enabled" aria-pressed={scene.doc.symbols.enabled} onClick={onSymbols}>Symbols</button>
      <button type="button" data-testid="window-enabled" aria-pressed={windowEnabled} disabled={!modelsReady}
        onClick={onWindow}>Window</button>
      {touch && <button type="button" data-testid="tilt-enabled" aria-pressed={tiltEnabled} disabled={!modelsReady}
        onClick={onTilt}>Tilt</button>}
      <button class="primary-action" type="button" disabled={busy} onClick={onDownload}>Download</button>
    </div>}
  </>;
}
