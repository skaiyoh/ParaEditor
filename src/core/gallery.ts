import { isAssetId, type AssetId, type Brand } from './ids.ts';
import type { Size } from './raster.ts';
import { MAX_ASSET_BYTES, MAX_RASTER_PAYLOAD_BYTES, RASTER_HEADER_BYTES } from './asset-codec.ts';
import { collectCompositionAssets } from './asset-refs.ts';
import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import { compositionDocumentSchema } from './composition-schema.ts';
import { remixDocumentSchema } from './remix-schema.ts';
import { parseLegacyDocument } from './schema.ts';
import { z } from './zod.ts';

export const GALLERY_VERSION = 3;
export const GALLERY_COMPOSITION_VERSION = 2;
export const GALLERY_LEGACY_VERSION = 1;
const MiB = 1024 * 1024;
export const GALLERY_LIMITS = {
  document: MiB, draft: MiB + 32 * 1024, source: 24 * MiB, mask: 16 * MiB,
  plane: 17 * MiB, png: MAX_ASSET_BYTES, raster: RASTER_HEADER_BYTES + MAX_RASTER_PAYLOAD_BYTES,
  poster: 2 * MiB, assets: 40, remixAssets: 4_136, piece: 96 * MiB,
};
export type GalleryId = Brand<string, 'GalleryId'>;
export function isGalleryId(value: string): value is GalleryId {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export const galleryIdSchema = z.custom<GalleryId>((value) => typeof value === 'string' && isGalleryId(value));
const assetIdSchema = z.custom<AssetId>((value) => typeof value === 'string' && isAssetId(value));
const sizeSchema = z.strictObject({ width: z.int().positive(), height: z.int().positive() }).readonly();
const maskSizeSchema = z.strictObject({ width: z.int().min(1).max(4096), height: z.int().min(1).max(4096) }).readonly();
const posterSizeSchema = z.strictObject({ width: z.int().min(1).max(1280), height: z.int().min(1).max(1280) }).readonly();
const sourceSchema = z.strictObject({
  kind: z.literal('source'), id: assetIdSchema, size: sizeSchema,
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/heic', 'image/heif', 'application/octet-stream']),
  byteLength: z.int().min(1).max(GALLERY_LIMITS.source),
});
const legacyAssetShape = z.discriminatedUnion('kind', [
  sourceSchema,
  z.strictObject({ kind: z.literal('mask'), id: assetIdSchema, format: z.literal('u8'), size: maskSizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.mask) }),
  z.strictObject({ kind: z.literal('depth'), id: assetIdSchema, format: z.literal('f32'), size: sizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.plane) }),
  z.strictObject({ kind: z.literal('plate'), id: assetIdSchema, format: z.literal('rgb8'), size: sizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.plane) }),
]);
const compositionSizeSchema = z.strictObject({ width: z.int().min(1).max(COMPOSITION_LIMITS.rasterSide), height: z.int().min(1).max(COMPOSITION_LIMITS.rasterSide) }).readonly();
export const galleryCompositionAssetSchema = z.discriminatedUnion('kind', [
  sourceSchema,
  z.strictObject({ kind: z.literal('png'), id: assetIdSchema, mediaType: z.literal('image/png'), size: compositionSizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.png) }),
  z.strictObject({ kind: z.literal('raster'), id: assetIdSchema, format: z.enum(['u8', 'f32', 'rgba8-srgb-straight']), size: compositionSizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.raster) }),
]).readonly().superRefine((asset, ctx) => {
  if (asset.kind !== 'raster') return;
  const channels = asset.format === 'u8' ? 1 : 4;
  if (asset.byteLength !== RASTER_HEADER_BYTES + asset.size.width * asset.size.height * channels) {
    ctx.addIssue({ code: 'custom', path: ['byteLength'], message: 'The raster length must include its NSRA header and match its format and size.' });
  }
});
export const galleryLegacyAssetSchema = legacyAssetShape.readonly().superRefine((asset, ctx) => {
  if (asset.kind === 'source') return;
  const channels = asset.kind === 'depth' ? 4 : asset.kind === 'plate' ? 3 : 1;
  if (asset.byteLength !== asset.size.width * asset.size.height * channels) {
    ctx.addIssue({ code: 'custom', path: ['byteLength'], message: 'The plane length must match its format and size.' });
  }
});
export const galleryAssetSchema = z.union([galleryLegacyAssetSchema, galleryCompositionAssetSchema]);
export const galleryPosterSchema = z.strictObject({
  kind: z.literal('poster'), id: assetIdSchema, mediaType: z.literal('image/jpeg'),
  size: posterSizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.poster),
}).readonly();
export type GalleryAsset = z.infer<typeof galleryAssetSchema>;
export type GalleryCompositionAsset = z.infer<typeof galleryCompositionAssetSchema>;
export type GalleryLegacyAsset = z.infer<typeof galleryLegacyAssetSchema>;
export type GalleryPoster = z.infer<typeof galleryPosterSchema>;

// Manifest v1 owns raw mask/depth/RGB bytes and frozen v4 plate metadata.
// Manifest v2 carries only complete, encoded v5 composition assets.
// Manifest v3 carries v6 recipes and paint tiles under its separate descriptor cap.
const legacyDocumentSchema = z.unknown().transform((value, ctx) => {
  const parsed = parseLegacyDocument(value);
  if (parsed.ok) return parsed.value;
  ctx.addIssue({ code: 'custom', message: 'The gallery scene document is invalid.' });
  return z.NEVER;
});
const legacyDraftShape = {
  document: legacyDocumentSchema,
  assets: z.array(galleryLegacyAssetSchema).min(1).max(GALLERY_LIMITS.assets).readonly(),
  poster: galleryPosterSchema,
};
const compositionDraftShape = {
  version: z.literal(GALLERY_COMPOSITION_VERSION), document: compositionDocumentSchema,
  assets: z.array(galleryCompositionAssetSchema).min(1).max(GALLERY_LIMITS.assets).readonly(),
  poster: galleryPosterSchema,
};
const remixDraftShape = {
  version: z.literal(GALLERY_VERSION), document: remixDocumentSchema,
  assets: z.array(galleryCompositionAssetSchema).min(1).max(GALLERY_LIMITS.remixAssets).readonly(),
  poster: galleryPosterSchema,
};
type LegacyDraftFields = z.infer<z.ZodObject<typeof legacyDraftShape>>;
type CompositionDraftFields = z.infer<z.ZodObject<typeof compositionDraftShape>>;
type RemixDraftFields = z.infer<z.ZodObject<typeof remixDraftShape>>;
const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;

function validateLimits(draft: LegacyDraftFields | CompositionDraftFields | RemixDraftFields, ctx: z.RefinementCtx): void {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const bytes = new TextEncoder().encode(JSON.stringify(draft.document)).byteLength;
  if (bytes > GALLERY_LIMITS.document) issue('The gallery scene document exceeds 1 MiB.');
  const total = bytes + draft.poster.byteLength + draft.assets.reduce((sum, asset) => sum + asset.byteLength, 0);
  if (total > GALLERY_LIMITS.piece) issue('The gallery piece exceeds 96 MiB.');
}
function validateLegacyDraft(draft: LegacyDraftFields, ctx: z.RefinementCtx): void {
  validateLimits(draft, ctx);
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const descriptors = new Map(draft.assets.map((asset) => [asset.id, asset]));
  if (descriptors.size !== draft.assets.length) issue('Every asset must be declared exactly once.');
  const referenced = new Set<AssetId>();
  const requireAsset = (id: AssetId, kind: GalleryLegacyAsset['kind'], size?: Size): GalleryLegacyAsset | undefined => {
    referenced.add(id);
    const asset = descriptors.get(id);
    if (asset === undefined || asset.kind !== kind || (size !== undefined && !sameSize(asset.size, size))) {
      issue('Every referenced asset must have a descriptor with its document kind and size.');
      return undefined;
    }
    return asset;
  };
  const { document } = draft;
  const source = document.frame.source;
  if (source === null) issue('The gallery piece needs its original source photo.');
  else {
    const asset = requireAsset(source.asset, 'source', document.frame.original.size);
    if (asset?.kind === 'source' && (asset.byteLength !== source.byteLength || asset.mediaType !== source.mediaType)) {
      issue('The source descriptor must match the document media type and byte length.');
    }
  }
  for (const object of document.objects) requireAsset(object.produced.mask.asset, 'mask', object.produced.mask.size);
  if (document.analysis.depth !== null) requireAsset(document.analysis.depth.map.asset, 'depth', document.analysis.depth.map.size);
  if (document.analysis.plate !== null) {
    requireAsset(document.analysis.plate.image.asset, 'plate', document.analysis.plate.image.size);
    // forMasks is comparison metadata, not a byte reference (core/derive.assetRefs).
  }
  if (draft.assets.some((asset) => !referenced.has(asset.id))) issue('The gallery piece contains an unreferenced asset.');
}

function validateCompositionDraft(draft: CompositionDraftFields | RemixDraftFields, ctx: z.RefinementCtx): void {
  validateLimits(draft, ctx);
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (draft.document.version === 6 && draft.document.remix.drafts.length > 0) {
    issue('Publish the applied recipe without recoverable source drafts.');
  }
  const inventory = collectCompositionAssets([{ kind: 'document', document: draft.document }]);
  if (!inventory.ok) { issue(inventory.error.detail); return; }
  const descriptors = new Map(draft.assets.map((asset) => [asset.id, asset]));
  if (descriptors.size !== draft.assets.length) issue('Every asset must be declared exactly once.');
  if (draft.document.frame.source === null) issue('The gallery piece needs its original source photo.');
  let activeBytes = 0;
  for (const [id, refs] of inventory.value) {
    const descriptor = descriptors.get(id);
    if (descriptor === undefined) { issue('Every referenced asset must have its composition descriptor.'); continue; }
    const original = refs.find((ref) => ref.kind === 'original');
    for (const ref of refs) {
      if (ref.kind === 'original') {
        if (descriptor.kind !== 'source' || descriptor.mediaType !== ref.mediaType || descriptor.byteLength !== ref.byteLength || !sameSize(descriptor.size, draft.document.frame.original.size)) {
          issue('The source descriptor must match the document media type, size and byte length.');
        }
      } else if (ref.kind === 'png') {
        // The retained original PNG may have the same digest as its master.
        // Keep one source descriptor and validate both uses against the bytes.
        if (original === undefined ? descriptor.kind !== 'png' || !sameSize(descriptor.size, ref.size) : descriptor.kind !== 'source' || descriptor.mediaType !== 'image/png') {
          issue('Every referenced PNG must have a matching image descriptor.');
        }
        if (descriptor.byteLength > GALLERY_LIMITS.png) issue('The composition PNG exceeds its asset limit.');
      } else if (descriptor.kind !== 'raster' || descriptor.format !== ref.format || !sameSize(descriptor.size, ref.size) || descriptor.byteLength !== ref.byteLength) {
        issue('Every referenced raster must have its document format, size and encoded length.');
      }
    }
    if (refs.some((ref) => ref.kind !== 'original')) activeBytes += descriptor.byteLength;
  }
  if (activeBytes > COMPOSITION_LIMITS.activeAssetBytes) issue('The composition exceeds its 64 MiB asset budget.');
  if (draft.assets.some((asset) => !inventory.value.has(asset.id))) issue('The gallery piece contains an unreferenced asset.');
}

export const galleryLegacyDraftSchema = z.strictObject(legacyDraftShape).readonly().superRefine(validateLegacyDraft);
export const galleryCompositionDraftSchema = z.strictObject(compositionDraftShape).readonly().superRefine(validateCompositionDraft);
export const galleryRemixDraftSchema = z.strictObject(remixDraftShape).readonly().superRefine(validateCompositionDraft);
export const galleryDraftSchema = z.union([galleryLegacyDraftSchema, galleryCompositionDraftSchema, galleryRemixDraftSchema]);
export const galleryLegacyManifestSchema = z.strictObject({
  version: z.literal(GALLERY_LEGACY_VERSION), id: galleryIdSchema, publishedAt: z.iso.datetime(), ...legacyDraftShape,
}).readonly().superRefine(validateLegacyDraft);
export const galleryCompositionManifestSchema = z.strictObject({
  ...compositionDraftShape, id: galleryIdSchema, publishedAt: z.iso.datetime(),
}).readonly().superRefine(validateCompositionDraft);
export const galleryRemixManifestSchema = z.strictObject({
  ...remixDraftShape, id: galleryIdSchema, publishedAt: z.iso.datetime(),
}).readonly().superRefine(validateCompositionDraft);
export const galleryManifestSchema = z.discriminatedUnion('version', [galleryLegacyManifestSchema, galleryCompositionManifestSchema, galleryRemixManifestSchema]);
export const galleryListItemSchema = z.strictObject({
  id: galleryIdSchema, publishedAt: z.iso.datetime(), poster: z.string(), size: posterSizeSchema,
}).readonly().refine((piece) => piece.poster === `/api/gallery/${piece.id}/poster`, { message: 'The gallery poster URL is invalid.' });
export const galleryListSchema = z.strictObject({ pieces: z.array(galleryListItemSchema).max(60).readonly() }).readonly();
export const galleryCreatedSchema = z.strictObject({ id: galleryIdSchema, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).readonly();
export const galleryAckSchema = z.strictObject({ ok: z.literal(true) }).readonly();
export type GalleryDraft = z.infer<typeof galleryDraftSchema>;
export type GalleryManifest = z.infer<typeof galleryManifestSchema>;
export type GalleryLegacyDraft = z.infer<typeof galleryLegacyDraftSchema>;
export type GalleryCompositionDraft = z.infer<typeof galleryCompositionDraftSchema>;
export type GalleryRemixDraft = z.infer<typeof galleryRemixDraftSchema>;
export type GalleryLegacyManifest = z.infer<typeof galleryLegacyManifestSchema>;
export type GalleryCompositionManifest = z.infer<typeof galleryCompositionManifestSchema>;
export type GalleryRemixManifest = z.infer<typeof galleryRemixManifestSchema>;
export type GalleryListItem = z.infer<typeof galleryListItemSchema>;
export type GalleryCreated = z.infer<typeof galleryCreatedSchema>;
