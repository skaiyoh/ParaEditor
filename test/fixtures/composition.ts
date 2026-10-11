import assert from 'node:assert/strict';
import { migrateV4ToV5 } from '../../src/core/composition.ts';
import { compositionDocumentSchema, effectIdSchema, removalIdSchema, sceneLayerSchema, sourceIdSchema } from '../../src/core/composition-schema.ts';
import type { CompositionDocument, LocalEffect, RasterSource, RepairProduct, SceneLayer, SourceRemoval } from '../../src/core/types.ts';
import { assetId, legacyFiveClusterDocument, INPAINT_MODEL, legacyMinimalDocument, uuid } from './documents.ts';

export function legacyComposition(): CompositionDocument {
  const result = migrateV4ToV5(legacyFiveClusterDocument());
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
export function newComposition(): CompositionDocument {
  const migrated = migrateV4ToV5(legacyMinimalDocument());
  assert.ok(migrated.ok, JSON.stringify(migrated));
  // Explicit fixture policy only; C3 owns the production new-scene default.
  return compositionDocumentSchema.parse({ ...migrated.value, compositing: 'scene-depth' });
}
export function rasterSource(n = 1): RasterSource {
  return { id: sourceIdSchema.parse(uuid(0x500 + n)), image: { asset: assetId(0x500 + n), encoding: 'rgba8-srgb-straight', size: { width: 13, height: 7 } },
    provenance: { kind: 'import', name: 'icon.png', mediaType: 'image/png', originalSize: { width: 13, height: 7 }, originalDigest: assetId(0x900 + n) } };
}
export function artworkLayer(n = 1): SceneLayer {
  const template = legacyComposition().objects[0];
  assert.ok(template);
  const source = rasterSource(n);
  return sceneLayerSchema.parse({ ...template, id: uuid(0x600 + n), name: `Artwork ${n}`, subject: false,
    content: { kind: 'source', source: { kind: 'raster', id: source.id } }, origin: { kind: 'artwork', source: source.id },
    produced: { ...template.produced, mask: { asset: assetId(0x700), format: 'u8', size: { width: 1, height: 1 } },
      sampling: 'coverage', provenance: { kind: 'full' }, bounds: { x: 0, y: 0, width: 13, height: 7 } },
    placement: { translate: { x: 0, y: 0 }, pivot: { x: 6.5, y: 3.5 }, scale: 1, rotation: 0 },
    home: { translate: { x: 0, y: 0 }, pivot: { x: 6.5, y: 3.5 }, scale: 1, rotation: 0 },
    depthAttachment: { kind: 'plane', disparity: .42 }, opacity: .67 });
}
export function localEffect(n = 1): LocalEffect {
  return { id: effectIdSchema.parse(uuid(0x800 + n)), enabled: true, owner: { kind: 'background' },
    scope: { kind: 'mask', mask: { plane: { asset: assetId(0xa00 + n), format: 'u8', size: { width: 17, height: 9 } }, provenance: { kind: 'manual', operation: 'rectangle' } } },
    operation: { kind: 'fill', color: { l: .63, c: .18, h: 241 } } };
}
export function liftRemoval(n = 1): SourceRemoval {
  return { id: removalIdSchema.parse(uuid(0xb00 + n)), source: { kind: 'photo' }, threshold: 1, ownership: { kind: 'lift' },
    mask: { plane: { asset: assetId(0xb00 + n), format: 'u8', size: { width: 31, height: 19 } }, provenance: { kind: 'manual', operation: 'freehand' } } };
}
export function repairProduct(doc = legacyComposition()): RepairProduct {
  return { key: { algorithm: 'photo-repair-v2', source: doc.frame.master.asset, size: doc.frame.master.size,
    removalUnion: assetId(0xc01), hole: assetId(0xc02), depth: doc.analysis.depth?.map.asset ?? null,
    radius: 31, purpose: { kind: 'loop', parallax: 1.7, reach: 30 }, model: INPAINT_MODEL },
    image: { asset: assetId(0xc03), size: doc.frame.master.size },
    backgroundDepth: { asset: assetId(0xc04), format: 'f32', size: doc.frame.master.size } };
}
export function fullComposition(): CompositionDocument {
  const doc = legacyComposition();
  return compositionDocumentSchema.parse({ ...doc, objects: [...doc.objects, artworkLayer()], sources: [rasterSource()],
    removals: [...doc.removals, liftRemoval()], localEffects: [localEffect()], analysis: { ...doc.analysis, plate: repairProduct(doc) } });
}
