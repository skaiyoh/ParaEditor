import type { AssetId, ObjectId } from '../core/ids.ts';
import type { Plane } from '../core/raster.ts';
import type { LocalEffect } from '../core/types.ts';

/** C2a effect metadata with its immutable scope asset resolved by the session. */
export type RenderLocalEffect = Omit<LocalEffect, 'scope'> & {
  readonly scope: { readonly kind: 'whole' } | { readonly kind: 'mask'; readonly plane: Plane<'u8'> };
};
export type PreparedLocalEffect = {
  readonly id: LocalEffect['id'];
  readonly label: number;
  readonly kind: 0 | 1 | 2;
  readonly color: readonly [number, number, number];
  readonly amount: number;
  readonly plane: Plane<'u8'> | null;
};

// Eight mask samplers plus color/label/UV fit WebGL2's minimum 16 texture units.
// Longer ordered lists are evaluated in successive batches at this same stage.
export const LOCAL_EFFECT_BATCH = 8;

export function resolveLocalEffects(effects: readonly LocalEffect[], masks: ReadonlyMap<AssetId, Plane<'u8'>>): readonly RenderLocalEffect[] {
  return effects.map((effect): RenderLocalEffect => {
    if (effect.scope.kind === 'whole') return { ...effect, scope: effect.scope };
    const ref = effect.scope.mask.plane;
    const plane = masks.get(ref.asset);
    if (plane === undefined || plane.size.width !== ref.size.width || plane.size.height !== ref.size.height) {
      throw new Error(`The local selection asset ${ref.asset} is missing or has the wrong size.`);
    }
    return { ...effect, scope: { kind: 'mask', plane } };
  });
}

/** Resolve ownership once; an absent/hidden owner never becomes a Scene edit. */
export function prepareLocalEffects(effects: readonly RenderLocalEffect[], objects: readonly { readonly id: ObjectId; readonly hidden?: boolean }[]): readonly PreparedLocalEffect[] {
  return effects.flatMap((effect): readonly PreparedLocalEffect[] => {
    if (!effect.enabled) return [];
    const owner = effect.owner;
    const index = owner.kind === 'background' ? -1 : objects.findIndex((object) => object.id === owner.id);
    if (owner.kind === 'layer' && index < 0) throw new Error('The local operation owner is no longer available.');
    if (index >= 0 && objects[index]?.hidden === true) return [];
    const plane = effect.scope.kind === 'whole' ? null : effect.scope.plane;
    if (plane !== null && (!Number.isSafeInteger(plane.size.width) || !Number.isSafeInteger(plane.size.height) ||
      plane.size.width < 1 || plane.size.height < 1 || plane.data.length !== plane.size.width * plane.size.height)) {
      throw new Error('The frozen local selection has an invalid size.');
    }
    const base = { id: effect.id, label: index + 1, plane };
    const operation = effect.operation;
    switch (operation.kind) {
      case 'recolor':
      case 'fill': {
        const { l, c, h } = operation.color;
        if (![l, c, h].every(Number.isFinite) || l < 0 || l > 1 || c < 0 || c > .4 || h < 0 || h > 360) {
          throw new Error('The local operation color is invalid.');
        }
        return [{ ...base, kind: operation.kind === 'recolor' ? 0 : 1, color: [l, c, h * Math.PI / 180], amount: 0 }];
      }
      case 'clipping': {
        if (!Number.isFinite(operation.amount) || operation.amount < 0 || operation.amount > 1) throw new Error('The local clipping amount is invalid.');
        return [{ ...base, kind: 2, color: [0, 0, 0], amount: operation.amount }];
      }
      default: { const exhaustive: never = operation; return exhaustive; }
    }
  });
}
