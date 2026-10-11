import { Component, createRef } from 'preact';
import type { ComponentChildren, JSX } from 'preact';
import type { RemixBrush, RemixPadActions, RemixPadSample, RemixParam, RemixParamOwner } from './remix-model.ts';

type PadProps = { readonly brush: RemixBrush; readonly pad: RemixPadActions };
type Stroke = {
  readonly pointer: number;
  readonly canvas: HTMLCanvasElement;
  readonly actions: RemixPadActions;
  /** Pencil or mouse: a touch during the stroke is a resting palm, not a second pointer. */
  readonly pen: boolean;
  // A refused or cancelled pointer remains owned until it lifts.
  token: symbol | null;
};

const stop = (event: Event): void => { event.stopPropagation(); };

class Pad extends Component<PadProps, { trying: boolean }> {
  state = { trying: false };
  private readonly canvas = createRef<HTMLCanvasElement>();
  private readonly pointers = new Set<number>();
  private stroke: Stroke | null = null;
  private observer: ResizeObserver | null = null;
  private detach: (() => void) | null = null;

  private resize = (): void => {
    const canvas = this.canvas.current;
    if (canvas === null) return;
    const box = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width * window.devicePixelRatio));
    const height = Math.max(1, Math.round(box.height * window.devicePixelRatio));
    // Assigning an unchanged dimension would erase the renderer's preview.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };

  componentDidMount(): void {
    const canvas = this.canvas.current;
    if (canvas === null) return;
    this.resize();
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.detach = this.props.pad.attach(canvas);
    window.addEventListener('pointerdown', this.secondPointer, true);
    window.addEventListener('pointerup', this.up, true);
    window.addEventListener('pointercancel', this.interrupted, true);
    window.addEventListener('keydown', this.escape, true);
    window.addEventListener('blur', this.blur);
  }

  componentWillUnmount(): void {
    window.removeEventListener('pointerdown', this.secondPointer, true);
    window.removeEventListener('pointerup', this.up, true);
    window.removeEventListener('pointercancel', this.interrupted, true);
    window.removeEventListener('keydown', this.escape, true);
    window.removeEventListener('blur', this.blur);
    this.blur();
    this.observer?.disconnect();
    this.detach?.();
  }

  private release(stroke: Stroke): void {
    if (stroke.canvas.hasPointerCapture(stroke.pointer)) stroke.canvas.releasePointerCapture(stroke.pointer);
  }

  private cancel = (): void => {
    const stroke = this.stroke;
    if (stroke === null) return;
    const token = stroke.token;
    stroke.token = null;
    if (token !== null) stroke.actions.cancel(token);
    this.release(stroke);
  };

  private secondPointer = (event: PointerEvent): void => {
    if (this.stroke?.pen === true && event.pointerType === 'touch') return;
    this.pointers.add(event.pointerId);
    if (this.stroke !== null && this.stroke.pointer !== event.pointerId) this.cancel();
  };

  private up = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    const stroke = this.stroke;
    if (stroke?.pointer !== event.pointerId) return;
    // Clear ownership before capture is lost, so pointerup can never cancel a completed stroke.
    this.stroke = null;
    if (stroke.token !== null) stroke.actions.end(stroke.token);
    this.release(stroke);
  };

  private interrupted = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.stroke?.pointer !== event.pointerId) return;
    this.cancel();
    this.stroke = null;
  };

  private lost = (event: PointerEvent): void => {
    event.stopPropagation();
    if (this.stroke?.pointer === event.pointerId) this.cancel();
  };

  private escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.stroke === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  private blur = (): void => {
    this.cancel();
    this.stroke = null;
    this.pointers.clear();
  };

  private sample(event: PointerEvent, canvas: HTMLCanvasElement): RemixPadSample {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width))),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height))),
      pressure: event.pointerType === 'pen' ? event.pressure : null,
      time: event.timeStamp,
      pointer: event.pointerType === 'pen' ? 'pen' : 'finger',
    };
  }

  private down = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    const pen = event.pointerType === 'pen' || event.pointerType === 'mouse';
    if (!this.state.trying || !event.isPrimary || event.button !== 0 || this.stroke !== null || (!pen && this.pointers.size > 1)) return;
    const canvas = event.currentTarget;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic input has no native capture. */ }
    const actions = this.props.pad;
    this.stroke = { pointer: event.pointerId, canvas, actions, pen, token: actions.begin(this.sample(event, canvas)) };
  };

  private move = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
    event.stopPropagation();
    const stroke = this.stroke;
    if (stroke?.pointer !== event.pointerId || stroke.token === null) return;
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = (coalesced.length === 0 ? [event] : coalesced).map((sample) => this.sample(sample, stroke.canvas));
    stroke.actions.extend(stroke.token, samples);
  };

  private toggle = (): void => {
    if (this.state.trying) this.cancel();
    this.setState(({ trying }) => ({ trying: !trying }));
  };

  private reset = (): void => {
    this.cancel();
    this.setState({ trying: false });
    this.props.pad.reset();
  };

  render(): JSX.Element {
    const { brush } = this.props;
    return <div class="remix-pad" data-backdrop={brush.backdrop}
      onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); }}
      onPointerMove={stop} onPointerUp={stop} onPointerCancel={stop}
      onPointerOver={stop} onPointerOut={stop} onPointerEnter={stop} onPointerLeave={stop}
      onGotPointerCapture={stop} onLostPointerCapture={stop}
      onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onTouchCancel={stop}>
      <canvas ref={this.canvas} aria-label="Brush preview" onPointerDown={this.down}
        onPointerMove={this.move} onLostPointerCapture={this.lost} />
      <div class="remix-pad-bar">
        <span>{this.state.trying ? 'Draw to test' : 'Canonical stroke'}</span>
        <div>
          <button type="button" aria-pressed={this.state.trying} onClick={this.toggle}>Try</button>
          <button type="button" onClick={this.reset}>Reset</button>
        </div>
      </div>
    </div>;
  }
}

export function RemixPad(props: PadProps): JSX.Element {
  return <Pad {...props} />;
}

export function RemixBrushBasics({ brush, pad, paramControl }: PadProps & {
  readonly paramControl: (param: RemixParam, owner: RemixParamOwner) => ComponentChildren;
}): JSX.Element {
  return <div class="remix-basics">
    <div class="remix-pad-help">
      <div>Each stroke stays at the depth where it starts.</div>
      {/* Nathan, 2026-10-11 (MRX0 S11): a brush change affects only future strokes; completed marks keep their pixels. */}
      <div>Changes apply to new strokes.</div>
      {brush.drawing.kind === 'unavailable' && <div>{brush.drawing.reason}</div>}
    </div>
    <div class="remix-color-row">
      <span>Color</span>
      <button type="button" aria-label={`Ink color, ${brush.colorLabel}`} onClick={() => pad.openColor()}>
        <span class="color-dot" style={{ background: brush.color }} aria-hidden="true" />{brush.colorLabel}
      </button>
    </div>
    {paramControl(brush.size, { kind: 'brush' })}
    {paramControl(brush.opacity, { kind: 'brush' })}
    {brush.pressure !== null && <div class="remix-switch-row">
      <span>Pressure changes size</span>
      <label class="enable-switch" title="Pressure changes size on or off">
        <input type="checkbox" aria-label="Pressure changes size" checked={brush.pressure}
          onChange={(event) => pad.setPressure(event.currentTarget.checked)} />
      </label>
    </div>}
  </div>;
}
