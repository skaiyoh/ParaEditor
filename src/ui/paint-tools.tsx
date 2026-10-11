import { displayColor } from './color-picker.tsx';
import { Icon } from './icons.tsx';
import type { PaintModel, PaintTool } from './paint-model.ts';

export function PaintTools({ paint, disabled }: { readonly paint: PaintModel; readonly disabled: boolean }) {
  return <>{(['brush', 'eraser'] satisfies readonly PaintTool[]).map(tool => {
    const name = tool === 'brush' ? 'Brush' : 'Eraser';
    return <button key={tool} class="icon-button" type="button" data-testid={`tool-${tool}`} aria-label={name} title={name}
      aria-pressed={paint.tool === tool} disabled={disabled} onClick={() => paint.setTool(paint.tool === tool ? null : tool)}><Icon name={tool} /></button>;
  })}</>;
}

export function PaintSize({ paint }: { readonly paint: PaintModel }) {
  const { diameter, minDiameter, maxDiameter } = paint.brush;
  const fill = maxDiameter > minDiameter ? (diameter - minDiameter) / (maxDiameter - minDiameter) * 100 : 0;
  return <>
    <span class="rail-rule" />
    <label for="paint-size">Size</label>
    <input type="range" id="paint-size" data-testid="paint-size" min={minDiameter} max={maxDiameter} step="1" value={diameter}
      style={{ '--fill': `${fill}%` }} onInput={event => paint.setBrush({ diameter: Number(event.currentTarget.value) })} />
    <output for="paint-size">{diameter} px</output>
  </>;
}

export function PaintBar({ paint, onColor, onRemix }: {
  readonly paint: PaintModel;
  readonly onColor: (opener: HTMLButtonElement) => void;
  readonly onRemix: ((opener: HTMLButtonElement) => void) | null;
}) {
  return <section class="context-bar paint-bar" aria-label="Paint tools">
    <div class="paint-heading">
      <strong>{paint.tool === 'brush' ? 'Brush' : 'Eraser'}</strong>
      {paint.tool === 'brush' && <button class="icon-button" type="button" aria-label="Ink color" title="Ink color" onClick={event => onColor(event.currentTarget)}>
        <span class="color-dot" style={{ background: displayColor(paint.brush.color).hex }} />
      </button>}
      {paint.drawing.kind === 'unavailable' && <span class="paint-reason">{paint.drawing.reason}</span>}
      <button type="button" class="paint-done" onClick={() => paint.setTool(null)}>Done</button>
    </div>
    <div class="paint-options">
      <label class="paint-opacity"><span>Opacity <output>{Math.round(paint.brush.opacity * 100)}%</output></span>
        <input type="range" aria-label="Opacity" min="0" max="1" step="0.01" value={paint.brush.opacity}
          style={{ '--fill': `${paint.brush.opacity * 100}%` }} onInput={event => paint.setBrush({ opacity: Number(event.currentTarget.value) })} />
      </label>
      <button type="button" aria-pressed={paint.brush.pressure === 'size'} onClick={() => paint.setBrush({ pressure: paint.brush.pressure === 'size' ? 'off' : 'size' })}>Pressure</button>
      <button type="button" aria-pressed={paint.fingerDraw} onClick={() => paint.setFingerDraw(!paint.fingerDraw)}>Finger draws</button>
      {onRemix !== null && <button type="button" onClick={event => onRemix(event.currentTarget)}>Remix brush</button>}
    </div>
  </section>;
}
