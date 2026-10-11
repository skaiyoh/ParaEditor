import type { DemoSession } from '../session/scene.ts';
import type { Oklch } from '../core/raster.ts';
import type { Recolor } from '../core/types.ts';
import { Icon } from './icons.tsx';

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

export function Swatches({ session, recolor, full = false, onColorApplied }: {
  readonly session: DemoSession; readonly recolor: Recolor; readonly full?: boolean; readonly onColorApplied: (color: Oklch | null) => void;
}) {
  const apply = (color: Oklch | null): void => {
    const id = session.snapshot().scene?.selected;
    if (id == null) return;
    const target = { kind: 'layer', id } satisfies Parameters<DemoSession['setTarget']>[0];
    session.setTarget(target);
    const result = session.setColor({ target, color });
    if (result.kind === 'applied' || result.kind === 'unchanged') onColorApplied(color);
  };
  return <fieldset class="swatches" data-testid="swatches"><legend class="visually-hidden">Object color</legend>
    <div class="swatch-actions">
      <button type="button" aria-label="Original" title="Original" aria-pressed={recolor.kind === 'none'} onClick={() => apply(null)}>{full ? <Icon name="original" /> : 'Original'}</button>
      {!full && <button type="button" onClick={() => session.select(null)}>Deselect</button>}
    </div>
    <div class="swatch-grid">
      {SWATCHES.map(({ name, color }) => <button key={name} class="swatch" type="button" aria-label={name} title={name}
        aria-pressed={recolor.kind === 'target' && recolor.color.l === color.l && recolor.color.c === color.c && recolor.color.h === color.h}
        style={{ background: `oklch(${color.l * 100}% ${color.c} ${color.h})` }}
        onClick={() => apply(color)}><span class="visually-hidden">{name}</span></button>)}
    </div>
  </fieldset>;
}
