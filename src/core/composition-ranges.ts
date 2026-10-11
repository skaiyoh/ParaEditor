// Staged composition bounds. These do not change the active v4 writer.
export const COMPOSITION_LIMITS = {
  rasterSide: 2048,
  readableLayers: 32,
  createdLayers: 8,
  scaleMin: 1 / 64,
  scaleMax: 64,
  rotationMin: -180,
  rotationMaxExclusive: 180,
  translationDimensions: 4,
  activeAssetBytes: 64 * 1024 * 1024,
  historyAssetBytes: 64 * 1024 * 1024,
  dirtyStrokeBytes: 16 * 1024 * 1024,
} as const;

/** New compositions resolve per-pixel depth; later array entries break ties. */
export const NEW_COMPOSITING_POLICY = 'scene-depth';
/** Migration never opts an existing document into physical overlap. */
export const LEGACY_COMPOSITING_POLICY = 'legacy-order';
