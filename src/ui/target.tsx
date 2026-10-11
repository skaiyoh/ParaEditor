import { useLayoutEffect, useRef } from 'preact/hooks';
import type { DemoSession } from '../session/scene.ts';
import type { CompareMode } from '../session/authoring.ts';
import { Icon } from './icons.tsx';

const COMPARISONS = [
  { mode: 'edited', label: 'Edited' },
  { mode: 'source-photo', label: 'Source photo' },
  { mode: 'treatments-off', label: 'Treatments off' },
] satisfies readonly { readonly mode: CompareMode; readonly label: string }[];

export function CompareControls({ session }: { readonly session: DemoSession }) {
  return <section aria-label="Compare">
    <h3 class="panel-heading">Compare</h3>
    <div class="color-segment compare-segment" role="group" aria-label="Comparison">
      {COMPARISONS.map(({ mode, label }) => <button type="button" key={mode} data-testid={`compare-${mode}`}
        disabled={session.snapshot().scene === null} aria-pressed={session.authoringState().compare === mode}
        onClick={() => session.setCompare(mode)}>{label}</button>)}
    </div>
  </section>;
}

export function CompareNotice({ session }: { readonly session: DemoSession }) {
  const mode = session.authoringState().compare;
  return mode === 'edited' ? null : <div class="compare-notice" data-testid="compare-notice" role="status">
    <span>Comparing: {mode === 'source-photo' ? 'Source photo' : 'Treatments off'}</span>
    <button type="button" data-testid="compare-done" onClick={() => session.setCompare('edited')}>Done</button>
  </div>;
}

export function CompareHold({ session }: { readonly session: DemoSession }) {
  const hold = useRef<{ previous: CompareMode; pointer: number | null; node: HTMLButtonElement; startedAt: number } | null>(null);
  const finish = (): void => {
    const current = hold.current;
    if (current === null) return;
    hold.current = null;
    session.setCompare(current.previous);
    if (current.pointer !== null && current.node.hasPointerCapture(current.pointer)) current.node.releasePointerCapture(current.pointer);
  };
  const release = (event: PointerEvent): void => {
    const current = hold.current;
    if (current === null || event.pointerId !== current.pointer) return;
    const shortHold = performance.now() - current.startedAt <= 250;
    finish();
    if (shortHold) session.reportError('Hold to see the source photo');
  };
  useLayoutEffect(() => {
    const other = (event: PointerEvent): void => { if (hold.current !== null && event.pointerId !== hold.current.pointer) finish(); };
    const end = (event: PointerEvent): void => { if (event.pointerId === hold.current?.pointer) finish(); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && hold.current !== null) { event.preventDefault(); finish(); } };
    window.addEventListener('pointerdown', other, true); window.addEventListener('pointerup', release); window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerdown', other, true); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', finish); finish();
    };
  }, [session]);
  return <button type="button" class="icon-button" data-testid="compare-hold" aria-label="Hold to compare source photo" title="Hold to compare source photo"
    aria-pressed={session.authoringState().compare === 'source-photo'} disabled={session.snapshot().scene === null}
    onPointerDown={(event) => {
      if (event.button !== 0 || hold.current !== null) return;
      hold.current = { previous: session.authoringState().compare, pointer: event.pointerId, node: event.currentTarget, startedAt: performance.now() };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input has no native capture. */ }
      session.setCompare('source-photo');
    }} onPointerUp={release} onPointerCancel={finish} onLostPointerCapture={finish} onBlur={finish}
    onKeyDown={(event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (hold.current !== null || event.repeat) return;
      hold.current = { previous: session.authoringState().compare, pointer: null, node: event.currentTarget, startedAt: performance.now() };
      session.setCompare('source-photo');
    }} onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); finish(); } }}>
    <Icon name="compare" />
  </button>;
}

/** The active operation target and the actual authoring magnification share one line. */
export function TargetReadout({ session, fit }: { readonly session: DemoSession; readonly fit: number }) {
  const scene = session.snapshot().scene, authoring = session.authoringState(), selection = session.selectionState();
  const layer = scene?.doc.objects.find(layer => layer.id === scene.selected);
  const name = authoring.target.kind === 'selection' && selection.selection !== null ? 'Selection' : layer?.name;
  return <div class="photo-name" data-testid="target-readout" title={scene?.doc.frame.original.name}>
    <span>{scene?.doc.frame.original.name ?? 'No photo open'}{name === undefined ? '' : ` / ${name}`}</span>
    {scene !== null && <button type="button" class="fit-readout" data-testid="authoring-fit" aria-label="Fit photo" title="Fit photo (0)" onClick={() => session.fitAuthoring()}>
      <Icon name="fit" />{Math.round(fit * (selection.neutral ? selection.view.zoom : 1))}%
    </button>}
  </div>;
}
