// The single closure walker for checkpoints and all client retention roots.
// Provenance originalDigest/selectedMask/parent/model hashes are NOT assets.
// Repair union/hole ARE actual u8 planes, even though their refs live in a key.
import { sameValue } from './equal.ts';
import type { AssetId, SourceId } from './ids.ts';
import type { Size } from './raster.ts';
import { err, ok, type Result } from './result.ts';
import type { ActiveSelection, CompositionDocument, CompositionEdit, DepthAttachment, LocalEffect, RasterSource, RepairProduct, SceneLayer } from './types.ts';

export type CompositionAssetRef =
  | { readonly asset: AssetId; readonly kind: 'raster'; readonly format: 'u8' | 'f32' | 'rgba8-srgb-straight'; readonly size: Size; readonly byteLength: number }
  // Encoded PNG length is not derivable from dimensions. Resolve from bytes
  // before admission; never invent a compressed size from a pixel count.
  | { readonly asset: AssetId; readonly kind: 'png'; readonly size: Size; readonly byteLength: null }
  | { readonly asset: AssetId; readonly kind: 'original'; readonly mediaType: string; readonly byteLength: number };
export type CompositionAssetRoot =
  | { readonly kind: 'document'; readonly document: CompositionDocument }
  | { readonly kind: 'edits'; readonly edits: readonly CompositionEdit[] }
  | { readonly kind: 'selection'; readonly selection: ActiveSelection }
  | { readonly kind: 'repair'; readonly repair: RepairProduct }
  | { readonly kind: 'depth'; readonly depth: Extract<DepthAttachment, { kind: 'source' }> };
export type AssetClosureError = { readonly path: (string | number)[]; readonly detail: string };
/** A retained original PNG may be the exact same bytes as the master PNG. */
export type CompositionAssetInventory = ReadonlyMap<AssetId, readonly CompositionAssetRef[]>;

export function collectCompositionAssets(roots: readonly CompositionAssetRoot[]): Result<CompositionAssetInventory, AssetClosureError> {
  const refs = new Map<AssetId, readonly CompositionAssetRef[]>();
  const sources = new Set<SourceId>();
  const sourceDepths = new Set<AssetId>();
  const sourceUses: { readonly id: SourceId; readonly path: (string | number)[] }[] = [];
  const depthUses: { readonly id: AssetId; readonly path: (string | number)[] }[] = [];
  let failure: AssetClosureError | null = null;
  function add(ref: CompositionAssetRef, path: (string | number)[]): void {
    const existing = refs.get(ref.asset) ?? [];
    if (existing.some((value) => sameValue(value, ref))) return;
    for (const previous of existing) {
      // An original PNG and a PNG raster descriptor complement each other;
      // two raster interpretations or disagreeing original lengths do not.
      const original = ref.kind === 'original' ? ref : previous.kind === 'original' ? previous : null;
      const raster = ref.kind === 'original' ? previous : ref;
      if (original?.mediaType === 'image/png' && raster.kind === 'png') continue;
      failure ??= { path, detail: `Conflicting asset descriptors for ${ref.asset}.` };
    }
    refs.set(ref.asset, [...existing, ref]);
  }
  function plane(value: { readonly asset: AssetId; readonly format: 'u8' | 'f32'; readonly size: Size }, path: (string | number)[]): void {
    add({ ...value, kind: 'raster', byteLength: 16 + value.size.width * value.size.height * (value.format === 'f32' ? 4 : 1) }, path);
  }
  function source(value: RasterSource, path: (string | number)[]): void {
    sources.add(value.id);
    add({ asset: value.image.asset, kind: 'raster', format: value.image.encoding, size: value.image.size,
      byteLength: 16 + value.image.size.width * value.image.size.height * 4 }, [...path, 'image']);
  }
  function depth(value: DepthAttachment, path: (string | number)[]): void {
    if (value.kind === 'source') {
      sourceDepths.add(value.map.asset);
      plane(value.map, [...path, 'map']);
    }
  }
  function layer(value: SceneLayer, path: (string | number)[]): void {
    plane(value.produced.mask, [...path, 'produced', 'mask']);
    depth(value.depthAttachment, [...path, 'depthAttachment']);
    if (value.content.source.kind === 'raster') sourceUses.push({ id: value.content.source.id, path: [...path, 'content', 'source'] });
  }
  function effect(value: LocalEffect, path: (string | number)[]): void {
    if (value.scope.kind === 'mask') plane(value.scope.mask.plane, [...path, 'scope', 'mask', 'plane']);
  }
  function repair(value: RepairProduct, path: (string | number)[]): void {
    add({ ...value.image, kind: 'png', byteLength: null }, [...path, 'image']);
    plane(value.backgroundDepth, [...path, 'backgroundDepth']);
    add({ asset: value.key.source, kind: 'png', size: value.key.size, byteLength: null }, [...path, 'key', 'source']);
    for (const key of ['removalUnion', 'hole'] as const) plane({ asset: value.key[key], format: 'u8', size: value.key.size }, [...path, 'key', key]);
    if (value.key.depth !== null) depthUses.push({ id: value.key.depth, path: [...path, 'key', 'depth'] });
  }
  function edit(value: CompositionEdit, path: (string | number)[]): void {
    switch (value.kind) {
      case 'layer.add': layer(value.layer, [...path, 'layer']); break;
      case 'layer.coverage': plane(value.value.mask, [...path, 'value', 'mask']); break;
      case 'layer.depth': depth(value.value, [...path, 'value']); break;
      case 'source.add': source(value.source, [...path, 'source']); break;
      case 'removal.set': if (value.value !== null) plane(value.value.mask.plane, [...path, 'value', 'mask', 'plane']); break;
      case 'effect.set': if (value.value !== null) effect(value.value, [...path, 'value']); break;
      case 'layer.remove': case 'layer.placement': case 'layer.opacity': case 'source.remove': case 'compositing': break;
      default: { const unhandled: never = value; return unhandled; }
    }
  }
  for (const root of roots) {
    switch (root.kind) {
      case 'document': {
        const doc = root.document;
        add({ ...doc.frame.master, kind: 'png', byteLength: null }, ['frame', 'master']);
        if (doc.frame.source !== null) add({ ...doc.frame.source, kind: 'original' }, ['frame', 'source']);
        if (doc.analysis.depth !== null) {
          sourceDepths.add(doc.analysis.depth.map.asset);
          plane(doc.analysis.depth.map, ['analysis', 'depth', 'map']);
        }
        if (doc.analysis.plate !== null) repair(doc.analysis.plate, ['analysis', 'plate']);
        doc.sources.forEach((value, i) => source(value, ['sources', i]));
        doc.objects.forEach((value, i) => layer(value, ['objects', i]));
        doc.localEffects.forEach((value, i) => effect(value, ['localEffects', i]));
        doc.removals.forEach((value, i) => plane(value.mask.plane, ['removals', i, 'mask', 'plane']));
        break;
      }
      case 'edits': root.edits.forEach((value, i) => edit(value, ['edits', i])); break;
      case 'selection': if (root.selection !== null) plane(root.selection.mask.plane, ['selection', 'mask', 'plane']); break;
      case 'repair': repair(root.repair, ['repair']); break;
      case 'depth': depth(root.depth, ['depth']); break;
      default: { const unhandled: never = root; return unhandled; }
    }
  }
  if (failure !== null) return err(failure);
  for (const use of sourceUses) if (!sources.has(use.id)) return err({ path: use.path, detail: `Missing raster source ${use.id}; include its document or source.add retention root.` });
  for (const use of depthUses) {
    if (!sourceDepths.has(use.id)) return err({ path: use.path, detail: `Repair depth ${use.id} needs an existing f32 descriptor from source depth, not a repair output.` });
  }
  return ok(refs);
}

/** Exact stored bytes counted once per digest across any union of roots.
 * PNG sizes come from the resident/uploaded bytes (or a matching original).
 * The caller still validates hashes, PNG dimensions and raw headers in C2b.
 */
export function measureCompositionAssets(inventory: CompositionAssetInventory, encodedByteLengths: ReadonlyMap<AssetId, number>): Result<{
  readonly bytes: number; readonly assets: number;
}, { readonly asset: AssetId; readonly detail: string }> {
  let bytes = 0;
  for (const [asset, descriptors] of inventory) {
    const declared = descriptors.find((ref) => ref.byteLength !== null)?.byteLength;
    const measured = encodedByteLengths.get(asset);
    const length = measured ?? declared;
    if (length === undefined || length === null) return err({ asset, detail: 'Encoded PNG byte length is required before asset admission.' });
    if (!Number.isSafeInteger(length) || length < 0) return err({ asset, detail: 'Asset byte length must be a nonnegative safe integer.' });
    if (descriptors.some((ref) => ref.byteLength !== null && ref.byteLength !== length)) return err({ asset, detail: 'Stored byte length conflicts with its asset descriptor.' });
    bytes += length;
    if (!Number.isSafeInteger(bytes)) return err({ asset, detail: 'Asset byte total exceeds safe integer accounting.' });
  }
  return ok({ bytes, assets: inventory.size });
}
