// Pure owner resolution. A selected row never silently retargets a stencil.
import { compositionObjectIdSchema, maskRefSchema } from './composition-schema.ts';
import type { Size } from './raster.ts';
import { err, ok, type Result } from './result.ts';
import type { ActiveSelection, CompositionDocument, EffectOwner, EffectScope, OperationTarget, SelectionSpace } from './types.ts';
import { z } from './zod.ts';

export const selectionSpaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('photo') }),
  z.strictObject({ kind: z.literal('layer'), id: compositionObjectIdSchema }),
]).readonly();
export const activeSelectionSchema = z.strictObject({ space: selectionSpaceSchema, mask: maskRefSchema }).readonly().nullable();
export const operationTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scene') }),
  z.strictObject({ kind: z.literal('background') }),
  z.strictObject({ kind: z.literal('layer'), id: compositionObjectIdSchema }),
  z.strictObject({ kind: z.literal('selection') }),
]).readonly();
export type ResolvedOperationTarget =
  | { readonly kind: 'scene' }
  | { readonly kind: 'local'; readonly owner: EffectOwner; readonly scope: EffectScope };

export function selectionOwnerSize(doc: CompositionDocument, space: SelectionSpace): Result<Size, string> {
  if (space.kind === 'photo') return ok(doc.frame.master.size);
  const layer = doc.objects.find((item) => item.id === space.id);
  if (layer === undefined) return err('The selection layer no longer exists.');
  const source = layer.content.source;
  if (source.kind === 'photo') return ok(doc.frame.master.size);
  const raster = doc.sources.find((item) => item.id === source.id);
  return raster === undefined ? err('The layer source no longer exists.') : ok(raster.image.size);
}

/** Resolves only the requested target; absence is a refusal, never Scene. */
export function resolveOperationTarget(input: {
  readonly document: CompositionDocument; readonly target: OperationTarget; readonly selection: ActiveSelection;
}): Result<ResolvedOperationTarget, string> {
  const { document, target, selection } = input;
  switch (target.kind) {
    case 'scene': return ok({ kind: 'scene' });
    case 'background': return ok({ kind: 'local', owner: { kind: 'background' }, scope: { kind: 'whole' } });
    case 'layer':
      return document.objects.some((layer) => layer.id === target.id)
        ? ok({ kind: 'local', owner: target, scope: { kind: 'whole' } }) : err('The target layer no longer exists.');
    case 'selection': {
      if (selection === null) return err('Create a selection before applying an operation to Selection.');
      const size = selectionOwnerSize(document, selection.space);
      if (!size.ok) return size;
      return ok({ kind: 'local', owner: selection.space.kind === 'photo' ? { kind: 'background' } : selection.space,
        scope: { kind: 'mask', mask: selection.mask } });
    }
    default: { const unhandled: never = target; return unhandled; }
  }
}
