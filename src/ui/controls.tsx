import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { DemoSession } from '../session/scene.ts';
import type { GestureStart, GestureToken, GestureValue } from '../session/authoring.ts';

/** Shared by native ranges and the color surfaces. Pointer identity stays in the UI. */
export function useControlGesture({ session, start, committed, cancelled }: {
  readonly session: DemoSession; readonly start: () => GestureStart;
  readonly committed?: () => void; readonly cancelled?: () => void;
}) {
  const active = useRef<{ pointer: number; node: HTMLElement; token: GestureToken | null } | null>(null);
  const callbacks = useRef({ start, committed, cancelled });
  callbacks.current = { start, committed, cancelled };
  const release = (): void => {
    const current = active.current;
    active.current = null;
    if (current?.node.hasPointerCapture(current.pointer)) current.node.releasePointerCapture(current.pointer);
  };
  const cancel = (): void => {
    const current = active.current;
    if (current?.token == null) return;
    const token = current.token; current.token = null;
    session.cancelGesture(token); callbacks.current.cancelled?.();
  };
  const commit = (): void => {
    const current = active.current;
    if (current?.token == null) return;
    const token = current.token; current.token = null;
    const result = session.commitGesture(token);
    if (result.kind === 'applied') callbacks.current.committed?.();
    else if (result.kind !== 'unchanged') callbacks.current.cancelled?.();
  };
  useLayoutEffect(() => {
    const second = (event: PointerEvent): void => {
      if (active.current !== null && active.current.pointer !== event.pointerId) cancel();
    };
    const up = (event: PointerEvent): void => {
      if (active.current?.pointer === event.pointerId) { commit(); release(); }
    };
    const interrupted = (event: PointerEvent): void => {
      if (active.current?.pointer === event.pointerId) { cancel(); release(); }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && active.current !== null) { event.preventDefault(); cancel(); }
    };
    const blurred = (): void => { cancel(); release(); };
    window.addEventListener('pointerdown', second, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', interrupted);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blurred);
    const unsubscribe = session.subscribe((state) => {
      if (state.authoring.gesture === null && active.current?.token != null) {
        active.current.token = null; callbacks.current.cancelled?.();
      }
    });
    return () => {
      window.removeEventListener('pointerdown', second, true); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', interrupted); window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blurred); unsubscribe(); blurred();
    };
  }, [session]);
  return {
    begin(event: JSX.TargetedPointerEvent<HTMLElement>): boolean {
      if (event.button !== 0 || active.current !== null) return false;
      const token = session.beginGesture(callbacks.current.start());
      if (token === null) return false;
      active.current = { pointer: event.pointerId, node: event.currentTarget, token };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic input has no native capture. */ }
      return true;
    },
    owns(pointer: number): boolean { return active.current?.pointer === pointer && active.current.token !== null; },
    update(value: GestureValue): boolean {
      if (active.current !== null) {
        if (active.current.token === null) return false;
        const result = session.updateGesture({ token: active.current.token, value });
        return result.kind === 'applied' || result.kind === 'unchanged';
      }
      // Native keyboard input is one complete action per step.
      const token = session.beginGesture(callbacks.current.start());
      if (token === null) return false;
      const result = session.updateGesture({ token, value });
      if (session.commitGesture(token).kind === 'applied') callbacks.current.committed?.();
      return result.kind === 'applied' || result.kind === 'unchanged';
    },
    commit, cancel,
    lost(event: JSX.TargetedPointerEvent<HTMLElement>): void {
      if (active.current?.pointer === event.pointerId) cancel();
    },
  };
}

export function GestureRange({ session, valueFor, ...props }: JSX.InputHTMLAttributes<HTMLInputElement> & {
  readonly session: DemoSession; readonly valueFor: (value: number) => GestureValue;
}) {
  const input = useRef<HTMLInputElement>(null);
  const initial = useRef(Number(props.value));
  const displayed = useRef(Number(props.value));
  displayed.current = Number(props.value);
  const gesture = useControlGesture({ session,
    start: () => ({ operation: valueFor(Number(props.value)).kind, target: { kind: 'scene' } }),
    cancelled() { displayed.current = initial.current; if (input.current !== null) input.current.value = String(initial.current); },
  });
  return <input {...props} ref={input} type="range" onPointerDown={(event) => { initial.current = Number(props.value); gesture.begin(event); }}
    onInput={(event) => { if (!gesture.update(valueFor(Number(event.currentTarget.value)))) event.currentTarget.value = String(displayed.current); }}
    onChange={() => gesture.commit()} onPointerUp={() => gesture.commit()}
    onPointerCancel={() => gesture.cancel()} onLostPointerCapture={gesture.lost} />;
}

export function RangeControl({ id, label, value, min, max, step, session, valueFor }: {
  readonly id: string; readonly label: string; readonly value: number;
  readonly min: number; readonly max: number; readonly step: number;
  readonly session: DemoSession; readonly valueFor: (value: number) => GestureValue;
}) {
  return <label class="range-row" for={id}>
    <span class={id === 'style-fry' ? 'range-label visually-hidden' : 'range-label'}>{label}</span>
    <GestureRange session={session} valueFor={valueFor} id={id} data-testid={id} min={min} max={max} step={step} value={value}
      style={{ '--fill': `${100 * (value - min) / (max - min)}%` }} />
    <output class="range-value" data-testid={`value-${id.replace(/^(style|symbols|motion)-/, '')}`} for={id}>{value}</output>
  </label>;
}

export function Node({ name, expanded, onExpand, toggle, children }: {
  readonly name: string; readonly expanded: boolean; readonly onExpand: () => void;
  readonly toggle?: ComponentChildren; readonly children: ComponentChildren;
}) {
  const id = `node-${name.toLowerCase()}`;
  return <section class="node" aria-label={name}>
    <div class="node-heading">
      <button class="node-disclosure" type="button" aria-expanded={expanded} aria-controls={id} onClick={onExpand}>
        <svg class="disclosure-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        {name}
      </button>
      {toggle}
    </div>
    <div id={id} class="node-controls" hidden={!expanded}>{children}</div>
  </section>;
}

export function EnableSwitch({ name, checked, onChange, portrait = false }: {
  readonly name: 'Motion' | 'Symbols'; readonly checked: boolean; readonly onChange: (enabled: boolean) => void;
  readonly portrait?: boolean;
}) {
  return <label class="enable-switch" title={`${name} on or off`}>
    <input data-testid={`${name.toLowerCase()}${portrait ? '-node' : ''}-enabled`} type="checkbox" aria-label={name} checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)} />
  </label>;
}
