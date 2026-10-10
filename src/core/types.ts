// The scene document's types, every one inferred from core/schema.ts, which
// owns the shape; nothing here is written by hand. The primitives the document
// is built from (Size, Rect, ImagePoint, Oklab, Oklch, PlaneRef, ImageRef) are
// core/raster.ts's, and test/schema.test.ts checks that the document's fields
// of those types equal them.
// Pure: no browser global, no Node API, no I/O.

import type {
  analysisSchema,
  colorClusterSchema,
  currentDocumentSchema,
  depthProductSchema,
  depthStatsSchema,
  frameSchema,
  harmonySchema,
  harmonyTemplateSchema,
  lightingSchema,
  lightSchema,
  motionSchema,
  objectColorSchema,
  objectMotionSchema,
  objectProducedSchema,
  paletteTargetSchema,
  plateProductSchema,
  recolorSchema,
  sceneDocumentSchema,
  sceneObjectSchema,
  selectionSchema,
  sourceRefSchema,
  styleSchema,
  symbolsSchema,
  surfaceSchema,
  tapPointSchema,
  toneStatsSchema,
} from './schema.ts';
import type { z } from './zod.ts';

/** The document at the current version, SCENE_VERSION. */
export type SceneDocument = z.infer<typeof currentDocumentSchema>;
/** The document at version `V`, which a parse chain of `V` migrations yields. */
export type SceneDocumentAt<V extends number> = z.infer<ReturnType<typeof sceneDocumentSchema<V>>>;

export type Frame = z.infer<typeof frameSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type ColorCluster = z.infer<typeof colorClusterSchema>;
export type ToneStats = z.infer<typeof toneStatsSchema>;
export type DepthProduct = z.infer<typeof depthProductSchema>;
export type DepthStats = z.infer<typeof depthStatsSchema>;
export type PlateProduct = z.infer<typeof plateProductSchema>;
export type Style = z.infer<typeof styleSchema>;
export type HarmonyTemplate = z.infer<typeof harmonyTemplateSchema>;
export type Harmony = z.infer<typeof harmonySchema>;
export type PaletteTarget = z.infer<typeof paletteTargetSchema>;
export type Symbols = z.infer<typeof symbolsSchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type Motion = z.infer<typeof motionSchema>;
export type Lighting = z.infer<typeof lightingSchema>;
export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type ObjectProduced = z.infer<typeof objectProducedSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type TapPoint = z.infer<typeof tapPointSchema>;
export type ObjectColor = z.infer<typeof objectColorSchema>;
export type Recolor = z.infer<typeof recolorSchema>;
export type ObjectMotion = z.infer<typeof objectMotionSchema>;
export type Light = z.infer<typeof lightSchema>;
