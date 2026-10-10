import type { DemoSession } from '../session/scene.ts';
import type { Oklch } from '../core/raster.ts';
import type { Recolor } from '../core/types.ts';

export const SWATCHES = [
  { name: 'Coral', color: { l: 0.65, c: 0.19, h: 25 } },
  { name: 'Orange', color: { l: 0.72, c: 0.17, h: 55 } },
  { name: 'Gold', color: { l: 0.75, c: 0.15, h: 95 } },
  { name: 'Green', color: { l: 0.7, c: 0.18, h: 145 } },
  { name: 'Turquoise', color: { l: 0.7, c: 0.12, h: 190 } },
  { name: 'Blue', color: { l: 0.6, c: 0.18, h: 250 } },
  { name: 'Violet', color: { l: 0.6, c: 0.19, h: 295 } },
  { name: 'Pink', color: { l: 0.68, c: 0.2, h: 340 } },
] satisfies readonly { readonly name: string; readonly color: Oklch }[];

export function Swatches({ session, recolor }: { readonly session: DemoSession; readonly recolor: Recolor }) {
  return <fieldset class="swatches" data-testid="swatches"><legend class="visually-hidden">Object color</legend>
    <div class="swatch-actions">
      <button type="button" aria-pressed={recolor.kind === 'none'} onClick={() => session.setRecolor(null)}>Original</button>
      <button type="button" onClick={() => session.select(null)}>Deselect</button>
    </div>
    <div class="swatch-grid">
      {SWATCHES.map(({ name, color }) => <button key={name} class="swatch" type="button" aria-label={name} title={name}
        aria-pressed={recolor.kind === 'target' && recolor.color.l === color.l && recolor.color.c === color.c && recolor.color.h === color.h}
        style={{ background: `oklch(${color.l * 100}% ${color.c} ${color.h})` }}
        onClick={() => session.setRecolor(color)}><span class="visually-hidden">{name}</span></button>)}
    </div>
  </fieldset>;
}
