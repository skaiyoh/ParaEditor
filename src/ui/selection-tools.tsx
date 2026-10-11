import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoSession } from '../session/scene.ts';
import type { SelectionSpace } from '../core/types.ts';
import type { CommandResult } from '../session/authoring.ts';
import { Icon } from './icons.tsx';

export type SelectionMode = 'replace' | 'add' | 'remove';
export type SelectionTool = 'rectangle' | 'freehand';
export const isSelectionTool = (tool: string): tool is SelectionTool => tool === 'rectangle' || tool === 'freehand';
export function selectionSpace(session: DemoSession): SelectionSpace {
  const selected = session.snapshot().scene?.selected;
  return selected == null ? { kind: 'photo' } : { kind: 'layer', id: selected };
}
export function selectionResult(session: DemoSession, result: CommandResult): void {
  if (result.kind === 'refused') session.reportError(new Error(result.reason));
}

/** Selection pixels remain owned by the session; this bar owns only input gestures. */
export function SelectionTools({ session, tool, mode, onMode, onTool }: {
  readonly session: DemoSession; readonly tool: SelectionTool; readonly mode: SelectionMode;
  readonly onMode: (mode: SelectionMode) => void; readonly onTool: (tool: SelectionTool) => void;
}) {
  const state = session.selectionState(), doc = session.snapshot().scene?.doc;
  const space = state.selection?.space ?? selectionSpace(session);
  const name = space.kind === 'photo' ? 'Photo' : doc?.objects.find(layer => layer.id === space.id)?.name ?? 'Layer';
  const feather = useRef<{ token: symbol; pointer: number; node: HTMLInputElement } | null>(null);
  const [radius, setRadius] = useState(0);
  const clipping = useRef<{ pointer: number; node: HTMLInputElement; before: number; value: number } | null>(null);
  const mask = state.selection?.mask.plane.asset;
  const effect = doc?.localEffects.findLast(effect => effect.operation.kind === 'clipping' && effect.scope.kind === 'mask' && effect.scope.mask.plane.asset === mask);
  const committedClip = effect?.operation.kind === 'clipping' ? effect.operation.amount : 0;
  const [clip, setClip] = useState(committedClip);
  useLayoutEffect(() => { if (clipping.current === null) setClip(committedClip); }, [committedClip, mask]);
  const cancel = (): boolean => {
    const f = feather.current, c = clipping.current;
    feather.current = null; clipping.current = null;
    if (f !== null) { session.cancelSelection(f.token); setRadius(0); if (f.node.hasPointerCapture(f.pointer)) f.node.releasePointerCapture(f.pointer); }
    if (c !== null) { setClip(c.before); if (c.node.hasPointerCapture(c.pointer)) c.node.releasePointerCapture(c.pointer); }
    return f !== null || c !== null;
  };
  const finish = (pointer: number): void => {
    const f = feather.current, c = clipping.current;
    if (f?.pointer === pointer) {
      feather.current = null;
      void session.endSelection({ token: f.token, pointerId: pointer }).then(result => selectionResult(session, result));
      if (f.node.hasPointerCapture(pointer)) f.node.releasePointerCapture(pointer);
    }
    if (c?.pointer === pointer) {
      clipping.current = null;
      selectionResult(session, session.setLocalOperation({ target: { kind: 'selection' }, operation: { kind: 'clipping', amount: c.value } }));
      if (c.node.hasPointerCapture(pointer)) c.node.releasePointerCapture(pointer);
    }
  };
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && cancel()) event.preventDefault(); };
    const second = (event: PointerEvent): void => {
      const pointer = feather.current?.pointer ?? clipping.current?.pointer;
      if (pointer !== undefined && pointer !== event.pointerId) cancel();
    };
    const up = (event: PointerEvent): void => finish(event.pointerId);
    const interrupted = (): void => { cancel(); };
    window.addEventListener('keydown', escape, true); window.addEventListener('pointerdown', second, true);
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', interrupted); window.addEventListener('blur', interrupted);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('pointerdown', second, true);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', interrupted); window.removeEventListener('blur', interrupted); cancel(); };
  }, [session]);
  return <section class="context-bar selection-bar" data-testid="selection-bar" aria-label="Selection tools" aria-busy={state.pending}>
    <div class="selection-choices">
    <div class="selection-shapes selection-segment" role="group" aria-label="Selection shape">
      {(['rectangle', 'freehand'] satisfies readonly SelectionTool[]).map(value => <button type="button" data-testid={`selection-${value}`} aria-pressed={tool === value} onClick={() => onTool(value)}>{value === 'rectangle' ? 'Rectangle' : 'Freehand'}</button>)}
    </div>
    <div class="selection-modes selection-segment" role="group" aria-label="Selection mode">
      {(['replace', 'add', 'remove'] satisfies readonly SelectionMode[]).map(value => <button type="button" data-testid={`selection-${value}`} aria-pressed={mode === value} onClick={() => onMode(value)}>{value === 'replace' ? 'Replace' : value === 'add' ? 'Add' : 'Remove'}</button>)}
    </div>
    </div>
    <div class="selection-options">
      <button type="button" class="icon-button" data-testid="selection-invert" aria-label="Invert selection" title="Invert" disabled={mask === undefined || state.pending}
        onClick={() => { void session.invertSelection().then(result => selectionResult(session, result)); }}><Icon name="invert" /></button>
      <label class="selection-range"><span>Feather <output>{radius} px</output></span>
        <input type="range" data-testid="selection-feather" aria-label="Feather in pixels" min="0" max="64" step="1" value={radius} style={{ '--fill': `${radius / 64 * 100}%` }} disabled={mask === undefined || state.pending}
          onPointerDown={event => {
            if (event.button !== 0) return;
            const began = session.beginSelection({ space, pointerId: event.pointerId, kind: 'feather' });
            if (!began.ok) { session.reportError(new Error(began.error)); return; }
            feather.current = { token: began.value, pointer: event.pointerId, node: event.currentTarget };
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input. */ }
          }} onInput={event => {
            const radius = Number(event.currentTarget.value), current = feather.current; setRadius(radius);
            if (current !== null) selectionResult(session, session.extendSelection({ token: current.token, pointerId: current.pointer, kind: 'feather', radius }));
            else void session.featherSelection(radius).then(result => selectionResult(session, result));
          }} onPointerUp={event => finish(event.pointerId)} onPointerCancel={cancel}
          onLostPointerCapture={() => { if (feather.current !== null) cancel(); }} />
      </label>
      <button type="button" data-testid="selection-clear" disabled={mask === undefined || state.pending} onClick={() => { void session.clearSelection().then(result => selectionResult(session, result)); }}>Clear</button>
      <label class="selection-range selection-clip"><span>Clip <output>{clip.toFixed(2)}</output></span>
        <input type="range" data-testid="selection-clip" aria-label="Selection clipping" min="0" max="1" step="0.01" value={clip} style={{ '--fill': `${clip * 100}%` }} disabled={mask === undefined || state.pending}
          onPointerDown={event => {
            if (event.button !== 0) return;
            clipping.current = { pointer: event.pointerId, node: event.currentTarget, before: clip, value: clip };
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input. */ }
          }} onInput={event => {
            const value = Number(event.currentTarget.value); setClip(value);
            if (clipping.current !== null) clipping.current.value = value;
            else selectionResult(session, session.setLocalOperation({ target: { kind: 'selection' }, operation: { kind: 'clipping', amount: value } }));
          }} onPointerUp={event => finish(event.pointerId)} onPointerCancel={cancel}
          onLostPointerCapture={() => { if (clipping.current !== null) cancel(); }} />
      </label>
      <span class="selection-space" data-testid="selection-space" title={`Selection space: ${name}`}><span class="selection-space-prefix">on </span>{name}</span>
      <button class="primary-action selection-done" type="button" data-testid="selection-done" onClick={() => session.setTool('select')}><Icon name="check" />Done</button>
    </div>
  </section>;
}

/** The renderer owns dimming. This source-space boundary adds a screen-only dash. */
export function SelectionOutline({ session }: { readonly session: DemoSession }) {
  const state = session.selectionState(), plane = state.preview?.plane;
  if (!state.neutral || plane === undefined) return null;
  const { width, height } = plane.size;
  const inside = (x: number, y: number): boolean => x >= 0 && x < width && y >= 0 && y < height && (plane.data[y * width + x] ?? 0) > 0;
  const segments: string[] = [];
  // Merge consecutive edge pixels into runs before creating the SVG path.
  for (let y = 0; y <= height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const edge = x < width && inside(x, y - 1) !== inside(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { segments.push(`M${start} ${y}H${x}`); start = -1; }
    }
  }
  for (let x = 0; x <= width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const edge = y < height && inside(x - 1, y) !== inside(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { segments.push(`M${x} ${start}V${y}`); start = -1; }
    }
  }
  const from = session.selectionToView({ x: 0, y: 0 }), to = session.selectionToView({ x: width, y: height });
  return <svg class="selection-outline" data-testid="selection-outline" aria-hidden="true" viewBox={`0 0 ${width} ${height}`}
    style={{ left: from.x, top: from.y, width: to.x - from.x, height: to.y - from.y, '--selection-y': `${from.y}px` }}>
    <path class="selection-outline-base" d={segments.join('')} fill="none" vector-effect="non-scaling-stroke" />
    <path d={segments.join('')} fill="none" vector-effect="non-scaling-stroke" />
  </svg>;
}
