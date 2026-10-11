import { isAssetId, type AssetId, type Brand } from './ids.ts';
import type { Size } from './raster.ts';
import { parseDocument } from './schema.ts';
import { z } from './zod.ts';

export const GALLERY_VERSION = 1;
const MiB = 1024 * 1024;
export const GALLERY_LIMITS = {
  document: MiB, draft: MiB + 32 * 1024, source: 24 * MiB, mask: 16 * MiB,
  plane: 17 * MiB, poster: 2 * MiB, assets: 40, piece: 96 * MiB,
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
export const galleryAssetSchema = z.discriminatedUnion('kind', [
  sourceSchema,
  z.strictObject({ kind: z.literal('mask'), id: assetIdSchema, format: z.literal('u8'), size: maskSizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.mask) }),
  z.strictObject({ kind: z.literal('depth'), id: assetIdSchema, format: z.literal('f32'), size: sizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.plane) }),
  z.strictObject({ kind: z.literal('plate'), id: assetIdSchema, format: z.literal('rgb8'), size: sizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.plane) }),
]).readonly().superRefine((asset, ctx) => {
  if (asset.kind === 'source') return;
  const channels = asset.kind === 'depth' ? 4 : asset.kind === 'plate' ? 3 : 1;
  if (asset.byteLength !== asset.size.width * asset.size.height * channels) {
    ctx.addIssue({ code: 'custom', path: ['byteLength'], message: 'The plane length must match its format and size.' });
  }
});
export const galleryPosterSchema = z.strictObject({
  kind: z.literal('poster'), id: assetIdSchema, mediaType: z.literal('image/jpeg'),
  size: posterSizeSchema, byteLength: z.int().min(1).max(GALLERY_LIMITS.poster),
}).readonly();
export type GalleryAsset = z.infer<typeof galleryAssetSchema>;
export type GalleryPoster = z.infer<typeof galleryPosterSchema>;

const documentSchema = z.unknown().transform((value, ctx) => {
  const parsed = parseDocument(value);
  if (parsed.ok) return parsed.value;
  ctx.addIssue({ code: 'custom', message: 'The gallery scene document is invalid.' });
  return z.NEVER;
});
const draftShape = {
  document: documentSchema,
  assets: z.array(galleryAssetSchema).min(1).max(GALLERY_LIMITS.assets).readonly(),
  poster: galleryPosterSchema,
};
type DraftFields = z.infer<z.ZodObject<typeof draftShape>>;
const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;

function validateDraft(draft: DraftFields, ctx: z.RefinementCtx): void {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const bytes = new TextEncoder().encode(JSON.stringify(draft.document)).byteLength;
  if (bytes > GALLERY_LIMITS.document) issue('The gallery scene document exceeds 1 MiB.');
  const total = bytes + draft.poster.byteLength + draft.assets.reduce((sum, asset) => sum + asset.byteLength, 0);
  if (total > GALLERY_LIMITS.piece) issue('The gallery piece exceeds 96 MiB.');
  const descriptors = new Map(draft.assets.map((asset) => [asset.id, asset]));
  if (descriptors.size !== draft.assets.length) issue('Every asset must be declared exactly once.');
  const referenced = new Set<AssetId>();
  const requireAsset = (id: AssetId, kind: GalleryAsset['kind'], size?: Size): GalleryAsset | undefined => {
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

export const galleryDraftSchema = z.strictObject(draftShape).readonly().superRefine(validateDraft);
export const galleryManifestSchema = z.strictObject({
  version: z.literal(GALLERY_VERSION), id: galleryIdSchema, publishedAt: z.iso.datetime(), ...draftShape,
}).readonly().superRefine(validateDraft);
export const galleryListItemSchema = z.strictObject({
  id: galleryIdSchema, publishedAt: z.iso.datetime(), poster: z.string(), size: posterSizeSchema,
}).readonly().refine((piece) => piece.poster === `/api/gallery/${piece.id}/poster`, { message: 'The gallery poster URL is invalid.' });
export const galleryListSchema = z.strictObject({ pieces: z.array(galleryListItemSchema).max(60).readonly() }).readonly();
export const galleryCreatedSchema = z.strictObject({ id: galleryIdSchema, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).readonly();
export const galleryAckSchema = z.strictObject({ ok: z.literal(true) }).readonly();
export type GalleryDraft = z.infer<typeof galleryDraftSchema>;
export type GalleryManifest = z.infer<typeof galleryManifestSchema>;
export type GalleryListItem = z.infer<typeof galleryListItemSchema>;
export type GalleryCreated = z.infer<typeof galleryCreatedSchema>;
