import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateV5ToV6, remixDocumentSchema } from '../src/core/remix-schema.ts';
import { transitionLegacyPolicy } from '../src/core/remix.ts';
import { minimalDocument, OBJECT_IDS, assetId } from './fixtures/documents.ts';
import { build } from 'esbuild';
import { snapshotPaintPatch, snapshotPaintRaster } from '../src/core/paint.ts';
import { createAuthoring, pushAuthoringHistory, recipeState, stepAuthoringHistory, type AuthoringHistoryEntry } from '../src/session/authoring.ts';
import { z } from '../src/core/zod.ts';
import type { BrushPreviewFrame } from '../src/session/paint.ts';
import type { Size } from '../src/core/raster.ts';
import type { SceneDocument } from '../src/core/types.ts';
import type { PaintPlane } from '../src/render/types.ts';
import type { AssetId } from '../src/core/ids.ts';
import { encodeRaster } from '../src/core/asset-codec.ts';
import { productAsset } from '../src/session/products.ts';
import { withDerivedGrainStyle } from '../src/core/remix-schema.ts';

// The session imports the build-owned id. Exercise its pure canvas adapter from
// an actual bundle, keeping node's source-import guard intact.
const bundled = await build({ stdin: { contents: "export { brushPreviewPixels } from './src/session/scene.ts'; export { resolvePaintPlanes } from './src/session/viewer.ts';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false, define: { NOISY_DEV: 'false', NOISY_BUILD_ID: '"nocommit-20261011"' } });
const entry = bundled.outputFiles[0];
assert.ok(entry);
const module: unknown = await import(`data:text/javascript;base64,${Buffer.from(entry.text).toString('base64')}`);
const exports = z.object({ brushPreviewPixels: z.custom<(frame: BrushPreviewFrame, size: Size) => Uint8ClampedArray>(value => typeof value === 'function'),
  resolvePaintPlanes: z.custom<(doc: SceneDocument, assets: ReadonlyMap<AssetId, Uint8Array>) => readonly PaintPlane[]>(value => typeof value === 'function') }).parse(module);
const { brushPreviewPixels, resolvePaintPlanes } = exports;

function previewPatch(id: string, bytes: number[]) {
  const patch = snapshotPaintPatch({ id, size: { width: 2, height: 1 },
    brush: { operation: 'draw', diameter: 1, opacity: 1, pressure: 'off', color: { l: 0, c: 0, h: 0 } },
    capture: { owner: 'preview', sceneGeneration: 0, viewGeneration: 0, brushRevision: 'brush@1', functionRevision: 'solid@1', seed: 1,
      start: { x: 0, y: 0 }, attachment: { depthSample: { x: 0, y: 0 }, disparity: .5 }, plane: { origin: { x: .5, y: .5 }, pixelScale: 1 } },
    tiles: [{ x: 0, y: 0, raster: snapshotPaintRaster({ size: { width: 2, height: 1 }, data: new Uint8Array(bytes) }) }] });
  assert.ok(patch.ok); return patch.value;
}

test('preview scales premultiplied linear samples without transparent-color fringes', () => {
  const patch = previewPatch('edge', [255, 0, 0, 255, 0, 0, 255, 0]);
  const bytes = brushPreviewPixels({ size: { width: 2, height: 1 }, patches: [patch] }, { width: 1, height: 1 });
  assert.deepEqual([...bytes], [255, 0, 0, 128]);
  assert.deepEqual([...brushPreviewPixels({ size: { width: 2, height: 1 }, patches: [] }, { width: 3, height: 2 })], Array(24).fill(0));
});

test('preview blends deposited straight-sRGB layers in linear color', () => {
  const red = previewPatch('red', [255, 0, 0, 128, 255, 0, 0, 128]);
  const blue = previewPatch('blue', [0, 0, 255, 128, 0, 0, 255, 128]);
  const bytes = brushPreviewPixels({ size: { width: 2, height: 1 }, patches: [red, blue] }, { width: 2, height: 1 });
  assert.deepEqual([...bytes], [156, 0, 213, 192, 156, 0, 213, 192]);
});

test('brush and eraser tools are readable and interrupt only actual tool changes', () => {
  const interruptions: string[] = [];
  const authoring = createAuthoring({ read: () => null, record: () => ({ kind: 'unchanged' }), changed: () => {},
    interrupt: reason => interruptions.push(reason) });
  assert.equal(authoring.setTool('brush').kind, 'applied');
  assert.equal(authoring.snapshot().tool, 'brush');
  assert.equal(authoring.setTool('brush').kind, 'unchanged');
  assert.equal(authoring.setTool('eraser').kind, 'applied');
  assert.equal(authoring.snapshot().tool, 'eraser');
  assert.deepEqual(interruptions, ['tool-change', 'tool-change']);
});

test('recipe undo and paint redo preserve session-owned paint history identity', () => {
  const migrated = migrateV5ToV6(minimalDocument());
  assert.ok(migrated.ok);
  const doc = withDerivedGrainStyle(migrated.value), recipe = recipeState(doc);
  const marker = { kind: 'selection', key: null, at: 0, selection: { before: null, after: null } } satisfies AuthoringHistoryEntry;
  const paint = new WeakMap<AuthoringHistoryEntry, string>([[marker, 'deposited pixels']]);
  const history = pushAuthoringHistory({ undo: [marker], redo: [] }, { kind: 'remix', key: null, at: 1, before: recipe, after: recipe }, doc);
  const recipeUndo = stepAuthoringHistory(history, 'undo');
  assert.ok(recipeUndo);
  const retainedPaint = recipeUndo.history.undo.at(-1);
  assert.ok(retainedPaint);
  assert.equal(paint.get(retainedPaint), 'deposited pixels');
  const paintUndo = stepAuthoringHistory(recipeUndo.history, 'undo');
  assert.ok(paintUndo);
  const paintRedo = stepAuthoringHistory(paintUndo.history, 'redo');
  assert.ok(paintRedo);
  const restoredPaint = paintRedo.history.undo.at(-1);
  assert.ok(restoredPaint);
  assert.equal(paint.get(restoredPaint), 'deposited pixels');
});

test('paint wiring requires the renderer preflight before changing legacy policy', () => {
  const migrated = migrateV5ToV6(minimalDocument());
  assert.ok(migrated.ok);
  const document = migrated.value;
  const result = transitionLegacyPolicy(document, { expected: 0,
    depthReady: true, repairReady: true, rendererReady: false });
  assert.equal(result.ok, false);
  assert.equal(document.compositing, 'legacy-order');
  assert.equal(document.policyTransition, null);
});

test('S13 admits persisted physical paint under unchanged legacy photo ordering', () => {
  const migrated = migrateV5ToV6(minimalDocument());
  assert.ok(migrated.ok);
  const document = remixDocumentSchema.parse({ ...migrated.value,
    paint: { ...migrated.value.paint, layers: [{ id: OBJECT_IDS[0], name: 'Paint', hidden: false, opacity: 1,
      patches: [{ id: 'stroke-1', owner: OBJECT_IDS[0], order: 0, disparity: .5,
        brush: { id: 'grain-texture', revision: 1 }, seed: 1, size: { width: 2, height: 2 },
        tiles: [{ x: 0, y: 0, rgba: { asset: assetId(900), encoding: 'rgba8-srgb-straight',
          size: { width: 2, height: 2 } } }] }] }] } });
  assert.equal(document.compositing, 'legacy-order');
  assert.equal(document.policyTransition, null);
  assert.equal(document.paint.layers[0]?.patches[0]?.disparity, .5);
  assert.deepEqual(remixDocumentSchema.parse(JSON.parse(JSON.stringify(document))).paint.layers, document.paint.layers);
});

test('renderer hydration preserves pixels and shares tiles across encoded product copies', async () => {
  const encoded = encodeRaster({ format: 'rgba8-srgb-straight', size: { width: 2, height: 2 }, data: new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 64, 0, 0, 0, 0]) });
  const asset = await productAsset(encoded), migrated = migrateV5ToV6(minimalDocument()); assert.ok(migrated.ok);
  const doc = withDerivedGrainStyle(remixDocumentSchema.parse({ ...migrated.value,
    paint: { ...migrated.value.paint, layers: [{ id: OBJECT_IDS[0], name: 'Paint', hidden: false, opacity: 1,
      patches: [{ id: 'identity', owner: OBJECT_IDS[0], order: 0, disparity: .25, brush: { id: 'grain-texture', revision: 1 }, seed: 1,
        size: { width: 2, height: 2 }, tiles: [{ x: 0, y: 0, rgba: { asset, encoding: 'rgba8-srgb-straight', size: { width: 2, height: 2 } } }] }] }] } }));
  const admitted = resolvePaintPlanes(doc, new Map([[asset, encoded]])), installed = resolvePaintPlanes(doc, new Map([[asset, encoded.slice()]]));
  assert.equal(admitted[0]?.disparity, .25);
  assert.equal(admitted[0]?.tiles[0]?.rgba, installed[0]?.tiles[0]?.rgba, 'GPU preflight and installed redraw share the immutable texture identity');
  const tile = admitted[0]?.tiles[0]; assert.ok(tile);
  assert.deepEqual([...tile.rgba], [255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 64, 0, 0, 0, 0]);
});
