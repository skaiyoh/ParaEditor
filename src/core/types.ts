// Scene types inferred from the active composition schema and the frozen
// legacy schema; no document shape is written by hand. The primitives the document
// is built from (Size, Rect, ImagePoint, Oklab, Oklch, PlaneRef, ImageRef) are
// core/raster.ts's, and test/schema.test.ts checks that the document's fields
// of those types equal them.
// Pure: no browser global, no Node API, no I/O.

import type {
  colorClusterSchema,
  depthStatsSchema,
  frameSchema,
  harmonySchema,
  harmonyTemplateSchema,
  lightingSchema,
  lightSchema,
  motionSchema,
  objectColorSchema,
  objectMotionSchema,
  paletteTargetSchema,
  recolorSchema,
  sceneDocumentSchema,
  selectionSchema,
  sourceRefSchema,
  styleSchema,
  symbolsSchema,
  surfaceSchema,
  tapPointSchema,
  toneStatsSchema,
} from './schema.ts';
import type { z } from './zod.ts';

/** Version-preserving read documents expose the legacy Grain control values. */
export type SceneDocument = FrozenCompositionDocument | import('./remix-schema.ts').RemixReadDocument;
/** The document at version `V`, which a parse chain of `V` migrations yields. */
export type SceneDocumentAt<V extends number> = z.infer<ReturnType<typeof sceneDocumentSchema<V>>>;

export type Frame = z.infer<typeof frameSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type Analysis = CompositionAnalysis;
export type ColorCluster = z.infer<typeof colorClusterSchema>;
export type ToneStats = z.infer<typeof toneStatsSchema>;
export type DepthProduct = NonNullable<CompositionAnalysis['depth']>;
export type DepthStats = z.infer<typeof depthStatsSchema>;
export type PlateProduct = RepairProduct;
export type Style = z.infer<typeof styleSchema>;
export type HarmonyTemplate = z.infer<typeof harmonyTemplateSchema>;
export type Harmony = z.infer<typeof harmonySchema>;
export type PaletteTarget = z.infer<typeof paletteTargetSchema>;
export type Symbols = z.infer<typeof symbolsSchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type Motion = z.infer<typeof motionSchema>;
export type Lighting = z.infer<typeof lightingSchema>;
export type SceneObject = SceneLayer;
export type ObjectProduced = LayerCoverage;
/** Legacy producers may omit size; the versioned document parser supplies .5. */
export type Selection = z.infer<typeof selectionSchema>;
export type TapPoint = z.infer<typeof tapPointSchema>;
export type ObjectColor = z.infer<typeof objectColorSchema>;
export type Recolor = z.infer<typeof recolorSchema>;
export type ObjectMotion = z.infer<typeof objectMotionSchema>;
export type Light = z.infer<typeof lightSchema>;

/** Frozen v4 types used only by old envelopes and gallery manifest version 1. */
export type LegacySceneDocument = z.infer<typeof import('./legacy-schema.ts').legacyV4DocumentSchema>;
export type LegacySceneObject = LegacySceneDocument['objects'][number];
export type LegacyObjectProduced = LegacySceneObject['produced'];
export type LegacyAnalysis = LegacySceneDocument['analysis'];
export type LegacyPlateProduct = NonNullable<LegacyAnalysis['plate']>;

// Frozen v5 contracts, retained unchanged by the version-preserving reader.
export type FrozenCompositionDocument = z.infer<typeof import('./composition-schema.ts').compositionDocumentShapeSchema>;
/** Composition queries read the shared photo fields of either supported document. */
export type CompositionDocument = SceneDocument;
export type CompositionSourceRef = z.infer<typeof import('./composition-schema.ts').compositionSourceRefSchema>;
export type RgbaRef = z.infer<typeof import('./composition-schema.ts').rgbaRefSchema>;
export type RasterSource = z.infer<typeof import('./composition-schema.ts').rasterSourceSchema>;
export type AiSelection = z.infer<typeof import('./composition-schema.ts').aiSelectionSchema>;
export type MaskOperation = z.infer<typeof import('./composition-schema.ts').maskOperationSchema>;
export type MaskProvenance = z.infer<typeof import('./composition-schema.ts').maskProvenanceSchema>;
export type MaskRef = z.infer<typeof import('./composition-schema.ts').maskRefSchema>;
export type LayerCoverage = z.infer<typeof import('./composition-schema.ts').layerCoverageSchema>;
export type AffinePlacement = z.infer<typeof import('./composition-schema.ts').affinePlacementSchema>;
export type DepthAttachment = z.infer<typeof import('./composition-schema.ts').depthAttachmentSchema>;
export type LayerOrigin = z.infer<typeof import('./composition-schema.ts').layerOriginSchema>;
export type LayerContent = z.infer<typeof import('./composition-schema.ts').layerContentSchema>;
export type SceneLayer = z.infer<typeof import('./composition-schema.ts').sceneLayerSchema>;
export type EffectOwner = z.infer<typeof import('./composition-schema.ts').effectOwnerSchema>;
export type EffectScope = z.infer<typeof import('./composition-schema.ts').effectScopeSchema>;
export type LocalEffect = z.infer<typeof import('./composition-schema.ts').localEffectSchema>;
export type SourceRemoval = z.infer<typeof import('./composition-schema.ts').sourceRemovalSchema>;
export type CompositingPolicy = z.infer<typeof import('./composition-schema.ts').compositingPolicySchema>;
export type RepairRequestKey = z.infer<typeof import('./composition-schema.ts').repairRequestKeySchema>;
export type RepairProduct = z.infer<typeof import('./composition-schema.ts').repairProductSchema>;
export type CompositionAnalysis = z.infer<typeof import('./composition-schema.ts').compositionAnalysisSchema>;
export type SelectionSpace = z.infer<typeof import('./selection.ts').selectionSpaceSchema>;
export type ActiveSelection = z.infer<typeof import('./selection.ts').activeSelectionSchema>;
export type OperationTarget = z.infer<typeof import('./selection.ts').operationTargetSchema>;
export type CompositionEdit = z.infer<typeof import('./composition.ts').compositionEditSchema>;
