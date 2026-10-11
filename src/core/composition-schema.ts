// Compatible v5 staging only. No production reader/writer imports this module yet.
import { collectCompositionAssets } from './asset-refs.ts';
import { COMPOSITION_LIMITS } from './composition-ranges.ts';
import { isAssetId, isEffectId, isModelId, isObjectId, isRemovalId, isSourceId } from './ids.ts';
import { legacyV4DocumentSchema } from './legacy-schema.ts';
import { createPerspectiveGeometry } from './perspective.ts';
import { z } from './zod.ts';

function id<T extends string>(check: (value: string) => value is T, message: string) {
  return z.custom<T>((value) => typeof value === 'string' && check(value), { message });
}
export const compositionAssetIdSchema = id(isAssetId, 'expected 64 lowercase hex digits');
export const compositionObjectIdSchema = id(isObjectId, 'expected a lowercase UUID v4');
export const sourceIdSchema = id(isSourceId, 'expected a lowercase UUID v4');
export const removalIdSchema = id(isRemovalId, 'expected a lowercase UUID v4');
export const effectIdSchema = id(isEffectId, 'expected a lowercase UUID v4');
const modelIdSchema = id(isModelId, 'expected a model id');
const unit = z.number().min(0).max(1);
const pixel = z.number().int().min(1).max(COMPOSITION_LIMITS.rasterSide);
export const compositionSizeSchema = z.strictObject({ width: pixel, height: pixel }).readonly();
const originalSizeSchema = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).readonly();
const pointSchema = z.strictObject({ x: z.number(), y: z.number() }).readonly();
const boundsSchema = z.strictObject({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().nonnegative(), height: z.number().nonnegative() }).readonly();
const colorSchema = z.strictObject({ l: unit, c: z.number().min(0).max(.4), h: z.number().min(0).max(360) }).readonly();
const v4 = legacyV4DocumentSchema.unwrap().shape;
const v4Layer = v4.objects.unwrap().element.unwrap().shape;
const v4Produced = v4Layer.produced.unwrap().shape;
const v4Analysis = v4.analysis.unwrap().shape;

export const compositionSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('photo') }),
  z.strictObject({ kind: z.literal('raster'), id: sourceIdSchema }),
]).readonly();
export const rgbaRefSchema = z.strictObject({ asset: compositionAssetIdSchema, encoding: z.literal('rgba8-srgb-straight'), size: compositionSizeSchema }).readonly();
export const coveragePlaneSchema = z.strictObject({ asset: compositionAssetIdSchema, format: z.literal('u8'), size: compositionSizeSchema }).readonly();
export const depthPlaneSchema = z.strictObject({ asset: compositionAssetIdSchema, format: z.literal('f32'), size: compositionSizeSchema }).readonly();
export const compositionImageRefSchema = z.strictObject({ asset: compositionAssetIdSchema, size: compositionSizeSchema }).readonly();
export const rasterSourceSchema = z.strictObject({
  id: sourceIdSchema,
  image: rgbaRefSchema,
  provenance: z.strictObject({
    kind: z.literal('import'), name: z.string().max(255), mediaType: z.string(),
    originalSize: originalSizeSchema, originalDigest: compositionAssetIdSchema,
  }).readonly(),
}).readonly();

const tapSchema = z.strictObject({ at: z.strictObject({ x: unit, y: unit }).readonly(), label: z.enum(['include', 'exclude']) }).readonly();
export const aiSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('taps'), points: z.tuple([tapSchema], tapSchema).readonly(), candidate: z.number().int().min(0).max(2), size: unit }),
  z.strictObject({ kind: z.literal('auto-subject'), seed: tapSchema, candidate: z.number().int().min(0).max(2), size: unit }),
]).readonly();
export const maskOperationSchema = z.enum(['rectangle', 'freehand', 'add', 'remove', 'invert', 'feather']);
export const maskProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ai'), model: modelIdSchema, selection: aiSelectionSchema }),
  z.strictObject({ kind: z.literal('manual'), operation: maskOperationSchema }),
  z.strictObject({ kind: z.literal('ai-edited'), model: modelIdSchema, selection: aiSelectionSchema, operation: maskOperationSchema }),
  z.strictObject({ kind: z.literal('full') }),
]).readonly();
export const maskRefSchema = z.strictObject({ plane: coveragePlaneSchema, provenance: maskProvenanceSchema }).readonly();
export const layerCoverageSchema = z.strictObject({
  mask: coveragePlaneSchema, sampling: z.enum(['legacy-threshold', 'coverage']), provenance: maskProvenanceSchema,
  bounds: boundsSchema, color: v4Produced.color.nullable(), depth: v4Produced.depth,
}).readonly().superRefine((coverage, ctx) => {
  if (coverage.sampling === 'legacy-threshold' && coverage.provenance.kind !== 'ai') {
    ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'legacy-threshold requires unedited AI provenance' });
  }
  if (coverage.color === null && coverage.bounds.width > 0 && coverage.bounds.height > 0) {
    ctx.addIssue({ code: 'custom', path: ['color'], message: 'only empty coverage may omit color statistics' });
  }
});
export const affinePlacementSchema = z.strictObject({
  translate: pointSchema, pivot: pointSchema,
  scale: z.number().min(COMPOSITION_LIMITS.scaleMin).max(COMPOSITION_LIMITS.scaleMax),
  rotation: z.number().min(COMPOSITION_LIMITS.rotationMin).lt(COMPOSITION_LIMITS.rotationMaxExclusive),
}).readonly();
export const depthAttachmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), map: depthPlaneSchema, model: modelIdSchema, offset: z.number().min(-1).max(1) }),
  z.strictObject({ kind: z.literal('plane'), disparity: unit }),
]).readonly();
export const layerOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('photo-region') }),
  z.strictObject({ kind: z.literal('cutout'), operation: z.enum(['copy', 'lift']), source: compositionSourceRefSchema,
    parent: compositionObjectIdSchema.nullable(), selectedMask: compositionAssetIdSchema }),
  z.strictObject({ kind: z.literal('artwork'), source: sourceIdSchema }),
]).readonly();
export const layerContentSchema = z.strictObject({ kind: z.literal('source'), source: compositionSourceRefSchema }).readonly();
export const sceneLayerSchema = z.strictObject({
  ...v4Layer, hidden: z.boolean(), produced: layerCoverageSchema,
  content: layerContentSchema, origin: layerOriginSchema, placement: affinePlacementSchema, home: affinePlacementSchema,
  depthAttachment: depthAttachmentSchema, opacity: unit,
}).readonly();
export const effectOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('background') }),
  z.strictObject({ kind: z.literal('layer'), id: compositionObjectIdSchema }),
]).readonly();
export const effectScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('whole') }),
  z.strictObject({ kind: z.literal('mask'), mask: maskRefSchema }),
]).readonly();
export const localEffectSchema = z.strictObject({
  id: effectIdSchema, enabled: z.boolean(), owner: effectOwnerSchema, scope: effectScopeSchema,
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('recolor'), color: colorSchema }),
    z.strictObject({ kind: z.literal('fill'), color: colorSchema }),
    z.strictObject({ kind: z.literal('clipping'), amount: unit }),
  ]).readonly(),
}).readonly();
export const sourceRemovalSchema = z.strictObject({
  id: removalIdSchema, source: z.strictObject({ kind: z.literal('photo') }).readonly(), mask: maskRefSchema,
  threshold: z.union([z.literal(1), z.literal(128)]),
  ownership: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('legacy-layer'), layer: compositionObjectIdSchema }),
    z.strictObject({ kind: z.literal('lift') }),
  ]).readonly(),
}).readonly();
export const compositingPolicySchema = z.enum(['legacy-order', 'scene-depth']);

const geometrySchema = z.strictObject({
  aperture: z.strictObject({ center: pointSchema, width: z.number().positive(), height: z.number().positive() }).readonly(),
  crop: z.number().min(0).lt(.5), neutralDistance: z.number().positive(), nearFactor: z.number().min(1), farFactor: z.number().min(1),
}).readonly().superRefine((geometry, ctx) => {
  try { createPerspectiveGeometry(geometry); }
  catch { ctx.addIssue({ code: 'custom', message: 'invalid or overflowing perspective geometry' }); }
});
const envelopeSchema = z.strictObject({ min: pointSchema, max: pointSchema }).readonly().refine(
  (value) => value.min.x <= value.max.x && value.min.y <= value.max.y, 'envelope minimum must not exceed maximum',
);
export const repairRequestKeySchema = z.strictObject({
  algorithm: z.literal('photo-repair-v2'), source: compositionAssetIdSchema, size: compositionSizeSchema,
  removalUnion: compositionAssetIdSchema, hole: compositionAssetIdSchema, depth: compositionAssetIdSchema.nullable(),
  radius: z.number().int().nonnegative(),
  purpose: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('still') }),
    z.strictObject({ kind: z.literal('loop'), parallax: z.number().min(.5).max(3), reach: z.number().nonnegative() }),
    z.strictObject({ kind: z.literal('live'), geometry: geometrySchema, envelope: envelopeSchema }),
  ]).readonly(), model: modelIdSchema,
}).readonly();
export const repairProductSchema = z.strictObject({
  key: repairRequestKeySchema, image: compositionImageRefSchema, backgroundDepth: depthPlaneSchema,
}).readonly();
export const compositionAnalysisSchema = z.strictObject({
  ...v4Analysis,
  depth: z.strictObject({ model: modelIdSchema, map: depthPlaneSchema, stats: v4Analysis.depth.unwrap().unwrap().shape.stats }).readonly().nullable(),
  plate: repairProductSchema.nullable(),
}).readonly();

/** Structural shape for inference/walking only; boundary callers use compositionDocumentSchema. */
export const compositionDocumentShapeSchema = z.strictObject({
  ...v4, version: z.literal(5), analysis: compositionAnalysisSchema,
  objects: z.array(sceneLayerSchema).max(COMPOSITION_LIMITS.readableLayers).readonly(),
  sources: z.array(rasterSourceSchema).readonly(), removals: z.array(sourceRemovalSchema).readonly(),
  localEffects: z.array(localEffectSchema).readonly(), compositing: compositingPolicySchema,
}).readonly();

export const compositionDocumentSchema = compositionDocumentShapeSchema.superRefine((doc, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  for (const key of ['objects', 'sources', 'removals', 'localEffects', 'lights'] as const) {
    const seen = new Set<string>();
    doc[key].forEach((item, i) => {
      if (seen.has(item.id)) issue([key, i, 'id'], 'ids must be unique');
      seen.add(item.id);
    });
  }
  const sources = new Map(doc.sources.map((source) => [source.id, source]));
  const layers = new Map(doc.objects.map((layer) => [layer.id, layer]));
  doc.style.paletteTargets.forEach((target, i) => {
    if (target.cluster >= doc.analysis.colors.length) issue(['style', 'paletteTargets', i, 'cluster'], 'cluster must exist in analysis.colors');
  });
  doc.objects.forEach((layer, i) => {
    const source = layer.content.source;
    const size = source.kind === 'photo' ? doc.frame.master.size : sources.get(source.id)?.image.size;
    if (size === undefined) issue(['objects', i, 'content', 'source'], 'raster source must exist');
    else {
      const bounds = layer.produced.bounds;
      if (bounds.x + bounds.width > size.width || bounds.y + bounds.height > size.height) issue(['objects', i, 'produced', 'bounds'], 'coverage bounds must fit its source extent');
      for (const key of ['placement', 'home'] as const) {
        const placement = layer[key];
        if (placement.pivot.x < 0 || placement.pivot.y < 0 || placement.pivot.x > size.width || placement.pivot.y > size.height) issue(['objects', i, key, 'pivot'], 'pivot must lie within its source extent');
      }
    }
    for (const key of ['placement', 'home'] as const) {
      const { x, y } = layer[key].translate;
      if (Math.abs(x) > COMPOSITION_LIMITS.translationDimensions * doc.frame.master.size.width || Math.abs(y) > COMPOSITION_LIMITS.translationDimensions * doc.frame.master.size.height) issue(['objects', i, key, 'translate'], 'translation exceeds four master dimensions');
    }
    const origin = layer.origin;
    if (origin.kind === 'photo-region' && source.kind !== 'photo') issue(['objects', i, 'origin'], 'photo-region requires photo content');
    if (origin.kind === 'artwork' && (source.kind !== 'raster' || source.id !== origin.source)) issue(['objects', i, 'origin', 'source'], 'artwork origin must match content source');
    if (origin.kind === 'cutout' && (origin.source.kind !== source.kind || (origin.source.kind === 'raster' && source.kind === 'raster' && origin.source.id !== source.id))) issue(['objects', i, 'origin', 'source'], 'cutout origin must match content source');
    // parent is historical identity, selectedMask a historical digest. Neither
    // requires the original parent/mask to remain alive after Copy or Lift.
  });
  doc.localEffects.forEach((effect, i) => {
    if (effect.owner.kind === 'layer' && !layers.has(effect.owner.id)) issue(['localEffects', i, 'owner'], 'effect owner must exist');
  });
  const linked = new Set<string>();
  doc.removals.forEach((removal, i) => {
    if (removal.ownership.kind === 'lift') {
      if (removal.threshold !== 1) issue(['removals', i, 'threshold'], 'Lift uses nonzero authored support');
      return;
    }
    const layer = layers.get(removal.ownership.layer);
    if (layer === undefined || layer.origin.kind !== 'photo-region') issue(['removals', i, 'ownership'], 'legacy removal must own a photo-region layer');
    if (linked.has(removal.ownership.layer)) issue(['removals', i, 'ownership'], 'only one legacy removal may own a layer');
    linked.add(removal.ownership.layer);
    if (layer !== undefined) {
      if (removal.threshold !== (layer.produced.sampling === 'legacy-threshold' ? 128 : 1)) issue(['removals', i, 'threshold'], 'threshold must follow linked layer sampling');
      if (removal.mask.plane.asset !== layer.produced.mask.asset) issue(['removals', i, 'mask'], 'legacy removal must use its linked coverage');
    }
  });
  const plate = doc.analysis.plate;
  if (plate !== null) {
    if (plate.key.source !== doc.frame.master.asset) issue(['analysis', 'plate', 'key', 'source'], 'repair source must be the primary master');
    for (const [name, size] of [['key', plate.key.size], ['image', plate.image.size]] as const) {
      if (size.width !== doc.frame.master.size.width || size.height !== doc.frame.master.size.height) issue(['analysis', 'plate', name, 'size'], 'durable repair must match master extent');
    }
    if (plate.key.purpose.kind === 'live') issue(['analysis', 'plate', 'key', 'purpose'], 'live repair remains transient');
  }
  const assets = collectCompositionAssets([{ kind: 'document', document: doc }]);
  if (!assets.ok) issue(assets.error.path, assets.error.detail);
});
