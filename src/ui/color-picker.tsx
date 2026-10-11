import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { colorInputFromOklch, parseHex, parseSrgbChannels, type InputColor } from '../core/color.ts';
import type { Oklch } from '../core/raster.ts';
import type { DemoSession } from '../session/scene.ts';
import type { OperationTarget } from '../session/authoring.ts';
import { useControlGesture } from './controls.tsx';
import { Icon } from './icons.tsx';
import { SWATCHES } from './swatches.tsx';

const INITIAL: Oklch = { l: .9, c: 0, h: 0 };
const WHITE: InputColor = { hex: '#ffffff', srgb: { r: 255, g: 255, b: 255 }, oklch: { l: 1, c: 0, h: 0 } };
export const displayColor = (color: Oklch): InputColor => {
  const display = colorInputFromOklch(color);
  return display.kind === 'valid' ? display.color : WHITE;
};
const sameColor = (a: Oklch, b: Oklch): boolean => a.l === b.l && a.c === b.c && a.h === b.h;

/** UI-only memory survives panel/tier changes, never enters the document or Projects. */
export function useColorPalette() {
  const [last, setLast] = useState<Oklch>(INITIAL);
  const [recent, setRecent] = useState<readonly Oklch[]>([]);
  return { last, recent, remember(color: Oklch): void {
    setLast(color); setRecent((colors) => [color, ...colors.filter((entry) => !sameColor(entry, color))].slice(0, 8));
  } };
}
export type ColorPalette = ReturnType<typeof useColorPalette>;
export type PendingColor = { readonly layer: string; readonly color: InputColor } | null;
type Hsv = { readonly h: number; readonly s: number; readonly v: number };
const clamp = (value: number, max = 1): number => Math.max(0, Math.min(max, value));
function hsvFrom({ srgb }: InputColor): Hsv {
  const r = srgb.r / 255, g = srgb.g / 255, b = srgb.b / 255;
  const v = Math.max(r, g, b), min = Math.min(r, g, b), d = v - min;
  const h = d === 0 ? 0 : v === r ? 60 * (((g - b) / d + 6) % 6) : v === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h, s: v === 0 ? 0 : d / v, v };
}
function colorFrom({ h, s, v }: Hsv): InputColor {
  const channel = (offset: number): number => {
    const k = (offset + h / 60) % 6;
    return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  const parsed = parseSrgbChannels({ r: channel(5), g: channel(3), b: channel(1) });
  return parsed.kind === 'valid' ? parsed.color : WHITE;
}

export function ColorPicker({ session, palette, pending, clearPending, active }: {
  readonly session: DemoSession; readonly palette: ColorPalette; readonly pending: PendingColor;
  readonly clearPending: () => void; readonly active: boolean;
}) {
  const state = session.snapshot(), doc = session.previewDocument();
  const selected = doc?.objects.find((object) => object.id === state.scene?.selected);
  const committed = state.scene?.doc.objects.find((object) => object.id === selected?.id)?.recolor;
  const target: OperationTarget = selected === undefined ? { kind: 'scene' } : { kind: 'layer', id: selected.id };
  const availability = session.capability({ operation: 'color', target });
  const disabled = availability.kind === 'unavailable';
  const previous = committed?.kind === 'target' ? committed.color : null;
  const sampled = pending?.layer === selected?.id ? pending?.color : undefined;
  const current = sampled ?? (selected === undefined ? displayColor(palette.last) : selected.recolor.kind === 'target' ? displayColor(selected.recolor.color) : null);
  const controlColor = current ?? displayColor(INITIAL);
  const currentHex = current?.hex ?? '';
  const [hsv, setHsv] = useState(() => hsvFrom(controlColor));
  const [hex, setHex] = useState(currentHex);
  const [error, setError] = useState<string | null>(null);
  const hexInput = useRef<HTMLInputElement>(null);
  const editedHex = useRef(false);
  const ownHex = useRef<string | null>(null);
  const latest = useRef({ current, selected, palette, clearPending });
  latest.current = { current, selected, palette, clearPending };
  const resetDisplay = (): void => {
    ownHex.current = null;
    const object = session.previewDocument()?.objects.find((object) => object.id === session.snapshot().scene?.selected);
    const display = object === undefined ? displayColor(latest.current.palette.last) : object.recolor.kind === 'target' ? displayColor(object.recolor.color) : null;
    setHsv(hsvFrom(display ?? displayColor(INITIAL))); setHex(display?.hex ?? ''); editedHex.current = false; setError(null);
  };
  useLayoutEffect(() => {
    if (ownHex.current !== currentHex) setHsv(hsvFrom(controlColor));
    if (!editedHex.current) setHex(currentHex);
  }, [currentHex]);
  useLayoutEffect(() => { editedHex.current = false; setHex(currentHex); setError(null); }, [selected?.id, active, sampled]);
  useLayoutEffect(() => {
    if (active && !disabled) session.setTarget(target);
  }, [session, active, selected?.id, disabled]);
  useLayoutEffect(() => {
    const input = hexInput.current;
    const cancel = (): void => { editedHex.current = false; setHex(latest.current.current?.hex ?? ''); setError(null); };
    input?.addEventListener('cancel', cancel);
    return () => input?.removeEventListener('cancel', cancel);
  }, []);
  const apply = (color: Oklch | null): void => {
    if (disabled) return;
    session.setTarget(target);
    const result = session.setColor({ target, color });
    if (result.kind === 'refused') { setError(result.reason); return; }
    if (result.kind === 'cancelled') return;
    if (color !== null) palette.remember(color);
    clearPending(); editedHex.current = false; setError(null);
    if (color !== null) { const display = displayColor(color); setHex(display.hex); setHsv(hsvFrom(display)); }
  };
  const applyHex = (confirmSample = false): void => {
    if (!editedHex.current && !(confirmSample && sampled !== undefined)) return;
    const parsed = parseHex(hexInput.current?.value ?? hex);
    if (parsed.kind === 'invalid') { setError(parsed.reason); return; }
    apply(parsed.color.oklch);
  };
  const gesture = useControlGesture({ session,
    start: () => ({ operation: 'color', target }),
    committed() {
      const object = session.snapshot().scene?.doc.objects.find((entry) => entry.id === session.snapshot().scene?.selected);
      if (object?.recolor.kind === 'target') latest.current.palette.remember(object.recolor.color);
      latest.current.clearPending(); editedHex.current = false;
    }, cancelled: resetDisplay,
  });
  useLayoutEffect(() => { if (!active) gesture.cancel(); }, [active]);
  const update = (value: Hsv): void => {
    const color = colorFrom(value); ownHex.current = color.hex;
    setHsv(value); setHex(color.hex); setError(null); editedHex.current = false;
    clearPending(); gesture.update({ kind: 'color', color: color.oklch });
  };
  const point = (event: JSX.TargetedPointerEvent<HTMLDivElement>, kind: 'sv' | 'hue'): void => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const x = clamp((event.clientX - box.left) / box.width);
    update(kind === 'hue' ? { ...hsv, h: x * 360 } : { ...hsv, s: x, v: 1 - clamp((event.clientY - box.top) / box.height) });
  };
  const key = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>, kind: 'sv' | 'hue'): void => {
    if (disabled) return;
    const step = event.shiftKey ? .1 : .01;
    let next = hsv;
    if (kind === 'hue') {
      const amount = event.shiftKey ? 10 : 1;
      switch (event.key) {
        case 'ArrowRight': case 'ArrowUp': next = { ...hsv, h: clamp(hsv.h + amount, 360) }; break;
        case 'ArrowLeft': case 'ArrowDown': next = { ...hsv, h: clamp(hsv.h - amount, 360) }; break;
        case 'Home': next = { ...hsv, h: 0 }; break;
        case 'End': next = { ...hsv, h: 360 }; break;
        default: return;
      }
    } else {
      switch (event.key) {
        case 'ArrowRight': next = { ...hsv, s: clamp(hsv.s + step) }; break;
        case 'ArrowLeft': next = { ...hsv, s: clamp(hsv.s - step) }; break;
        case 'ArrowUp': next = { ...hsv, v: clamp(hsv.v + step) }; break;
        case 'ArrowDown': next = { ...hsv, v: clamp(hsv.v - step) }; break;
        case 'Home': next = event.shiftKey ? { ...hsv, v: 0 } : { ...hsv, s: 0 }; break;
        case 'End': next = event.shiftKey ? { ...hsv, v: 1 } : { ...hsv, s: 1 }; break;
        default: return;
      }
    }
    event.preventDefault(); update(next);
  };
  const pointerProps = (kind: 'sv' | 'hue') => ({
    onPointerDown(event: JSX.TargetedPointerEvent<HTMLDivElement>) {
      if (disabled) return;
      event.preventDefault(); event.currentTarget.focus();
      if (gesture.begin(event)) point(event, kind);
    },
    onPointerMove(event: JSX.TargetedPointerEvent<HTMLDivElement>) { if (gesture.owns(event.pointerId)) point(event, kind); },
    onPointerUp(event: JSX.TargetedPointerEvent<HTMLDivElement>) { if (gesture.owns(event.pointerId)) { point(event, kind); gesture.commit(); } },
    onPointerCancel: () => gesture.cancel(), onLostPointerCapture: gesture.lost,
    onKeyDown: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => key(event, kind),
  });
  return <section class="color-picker" aria-label="Object color">
    <div class="panel-title"><h2>Color</h2><span data-testid="color-target">{selected?.name ?? 'Select an object'}</span></div>
    {availability.kind === 'unavailable' && <p class="color-help" data-testid="color-unavailable">{availability.reason}</p>}
    <fieldset class="color-controls" disabled={disabled}>
      <legend class="visually-hidden">Recolor {selected?.name ?? 'selected object'}</legend>
      <div class="color-sv" data-testid="color-sv" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
        aria-label="Saturation and value" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, value ${Math.round(hsv.v * 100)}%`}
        aria-describedby="color-keyboard-help" style={{ '--hue': hsv.h, '--saturation': `${hsv.s * 100}%`, '--value': `${(1 - hsv.v) * 100}%` }} {...pointerProps('sv')}>
        <span class="color-cursor" aria-hidden="true" />
      </div>
      <div class="color-hue" data-testid="color-hue" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
        aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} aria-valuetext={`${Math.round(hsv.h)} degrees`}
        style={{ '--position': `${hsv.h / 3.6}%` }} {...pointerProps('hue')}><span class="color-cursor" aria-hidden="true" /></div>
      <p id="color-keyboard-help" class="visually-hidden">Left and right adjust saturation; up and down adjust value. Shift increases the step. Home and End set saturation to its ends; Shift Home and Shift End set value to its ends.</p>
      <div class="color-input-row">
        <div class="color-pair">
          <span data-testid="color-current" title={current === null ? 'Original color' : `Current ${current.hex}`}
            aria-label={current === null ? 'Original color' : `Current color ${current.hex}`} style={current === null ? undefined : { background: current.hex }}>
            {current === null && <Icon name="original" />}
          </span>
          <button type="button" data-testid="color-previous" title={previous === null ? 'Restore original color' : 'Restore committed color'}
            aria-label={previous === null ? 'Restore original color' : `Restore committed color ${displayColor(previous).hex}`}
            style={previous === null ? undefined : { background: displayColor(previous).hex }} onClick={() => apply(previous)}>
            {previous === null && <Icon name="original" />}
          </button>
        </div>
        <label class="color-hex-label">Hex<input ref={hexInput} data-testid="color-hex" aria-label="Hex color" type="text"
          value={hex} placeholder={current === null ? 'Original' : undefined} spellcheck={false} autoComplete="off" autoCapitalize="off" aria-invalid={error !== null} aria-describedby={error === null ? undefined : 'color-error'}
          onInput={(event) => { editedHex.current = true; setHex(event.currentTarget.value); setError(null); }} onBlur={() => applyHex()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); applyHex(true); }
            if (event.key === 'Escape') { editedHex.current = false; setHex(currentHex); setError(null); }
          }} /></label>
      </div>
      {error !== null && <p id="color-error" class="color-help" data-testid="color-error" role="alert">{error}</p>}
      <div class="color-channels" role="group" aria-label="sRGB channels">
        {(['r', 'g', 'b'] satisfies readonly (keyof InputColor['srgb'])[]).map((channel) => <label key={channel}>{channel.toUpperCase()}
          <input type="number" data-testid={`color-channel-${channel}`} aria-label={`${channel.toUpperCase()} channel`} min={0} max={255} step={1}
            value={current?.srgb[channel] ?? ''} onChange={(event) => {
              const result = parseSrgbChannels({ ...controlColor.srgb, [channel]: event.currentTarget.value === '' ? NaN : Number(event.currentTarget.value) });
              if (result.kind === 'valid') apply(result.color.oklch); else setError(result.reason);
            }} />
        </label>)}
      </div>
      <div class="color-sample-row">
        <span>Sample from</span>
        <div class="color-segment" role="group" aria-label="Sample source">
          {(['edited', 'source'] satisfies readonly ('edited' | 'source')[]).map((mode) => <button type="button" key={mode} data-testid={`sample-mode-${mode}`}
            aria-pressed={state.authoring.sampleMode === mode} onClick={() => session.setSampleMode(mode)}>{mode === 'edited' ? 'Edited' : 'Source'}</button>)}
        </div>
        <button type="button" class="icon-button" data-testid="color-sampler" aria-label={`Sample color from ${state.authoring.sampleMode === 'edited' ? 'Edited' : 'Source'}`}
          title="Sample a color" aria-pressed={state.authoring.tool === 'sample'} onClick={() => { session.setTarget(target); session.setTool(state.authoring.tool === 'sample' ? 'select' : 'sample'); }}><Icon name="sampler" /></button>
      </div>
      {sampled !== undefined && <button type="button" class="color-apply" data-testid="color-apply" onClick={() => apply(sampled.oklch)}><Icon name="check" />Apply {sampled.hex}</button>}
      <h3 class="color-group-heading">Recent</h3>
      {palette.recent.length === 0 ? <p class="color-help">Colors you apply appear here.</p> : <div class="color-swatches" role="group" aria-label="Recent colors">
        {palette.recent.map((color) => <button class="swatch" type="button" key={`${color.l}/${color.c}/${color.h}`} aria-label={`Recent ${displayColor(color).hex}`}
          title={displayColor(color).hex} style={{ background: displayColor(color).hex }} aria-pressed={current !== null && sameColor(current.oklch, color)} onClick={() => apply(color)} />)}
      </div>}
      <h3 class="color-group-heading">Presets</h3>
      <div class="color-swatches" role="group" aria-label="Preset colors">
        {SWATCHES.map(({ name, color }) => <button class="swatch" type="button" key={name} aria-label={name} title={name}
          aria-pressed={selected?.recolor.kind === 'target' && sameColor(selected.recolor.color, color)}
          style={{ background: `oklch(${color.l * 100}% ${color.c} ${color.h})` }} onClick={() => apply(color)} />)}
      </div>
    </fieldset>
  </section>;
}
