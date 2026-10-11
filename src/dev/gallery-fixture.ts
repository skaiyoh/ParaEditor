import type { GalleryContent, GalleryLoader } from '../app/gallery-page.ts';
import { newDocument, newObject } from '../core/defaults.ts';
import { isAssetId, isBuildId, isModelId, isObjectId, isSceneId } from '../core/ids.ts';
import type { AssetId } from '../core/ids.ts';
import type { Plane, Rgb8 } from '../core/raster.ts';
import type { SceneDocument } from '../core/types.ts';
import { currentDocumentSchema } from '../core/schema.ts';

async function hash(bytes: Uint8Array): Promise<AssetId> {
  const buffer = new Uint8Array(bytes.length); buffer.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const text = [...digest].map((v) => v.toString(16).padStart(2, '0')).join('');
  if (!isAssetId(text)) throw new Error('Invalid fixture hash.');
  return text;
}

/** Analytic rasters over the real sample, with fixed seed and ids. Never shipped in production. */
async function piece(signal: AbortSignal): Promise<Awaited<ReturnType<GalleryContent['loadPiece']>>> {
  const response = await fetch('/assets-static/sample.jpg', { signal });
  if (!response.ok) throw new Error('Fixture photo is unavailable.');
  const source = await response.blob(), original = await createImageBitmap(source);
  // Keep browser verification inexpensive; the fixture's source is a deterministic 640 px sample derivative.
  const size = { width: 640, height: 480 }, canvas = new OffscreenCanvas(size.width, size.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) { original.close(); throw new Error('Fixture canvas unavailable.'); }
  context.drawImage(original, 0, 0, size.width, size.height); original.close();
  const rgba = context.getImageData(0, 0, size.width, size.height).data;
  const master = await canvas.convertToBlob({ type: 'image/png' });
  const mask: Plane<'u8'> = { format: 'u8', size, data: new Uint8Array(size.width * size.height) };
  const depth: Plane<'f32'> = { format: 'f32', size, data: new Float32Array(size.width * size.height) };
  const plate: Rgb8 = { size, data: new Uint8Array(size.width * size.height * 3) };
  // A rectangular test layer intentionally tests raster plumbing, not inferred subject segmentation.
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const i = y * size.width + x;
    const subject = x >= 260 && x < 380 && y >= 150 && y < 330;
    mask.data[i] = subject ? 255 : 0;
    depth.data[i] = subject ? .8 : .18 + .16 * y / size.height;
    const px = x >= 220 && x < 420 && y >= 110 && y < 370 ? 200 : x;
    const from = (y * size.width + px) * 4;
    plate.data.set(rgba.subarray(from, from + 3), i * 3);
  }
  const [sourceId, maskId, depthId, plateId] = await Promise.all([
    master.arrayBuffer().then((bytes) => hash(new Uint8Array(bytes))), hash(mask.data),
    hash(new Uint8Array(depth.data.buffer)), hash(plate.data),
  ]);
  const id = '00000000-0000-4000-8000-000000000001', objectId = '00000000-0000-4000-8000-000000000002';
  const writer = 'nocommit-20261010', model = `fixture@${'a'.repeat(64)}`;
  if (!isSceneId(id) || !isObjectId(objectId) || !isBuildId(writer) || !isModelId(model)) throw new Error('Invalid fixture identity.');
  const colors: SceneDocument['analysis']['colors'] = [
    { lab: { L: .7, a: -.02, b: -.1 }, weight: .4 }, { lab: { L: .5, a: -.08, b: .06 }, weight: .25 },
    { lab: { L: .3, a: .01, b: .02 }, weight: .15 }, { lab: { L: .62, a: .1, b: .12 }, weight: .12 },
    { lab: { L: .9, a: 0, b: .01 }, weight: .08 },
  ];
  const doc = newDocument({ id, title: 'Gallery sample', seed: 410, writer, importedOn: 'deterministic gallery fixture', now: '2026-10-10T00:00:00.000Z',
    frame: { source: { asset: sourceId, mediaType: 'image/png', byteLength: master.size }, master: { asset: sourceId, size }, original: { name: 'gallery-sample.png', mediaType: 'image/png', size } },
    analysis: { colors, tone: { p01: .08, p05: .15, p50: .52, p95: .88, p99: .95 }, autoSubject: 'done',
      depth: { model, map: { asset: depthId, format: 'f32', size }, stats: { p10: .18, median: .3, p90: .8 } },
      plate: { model, image: { asset: plateId, size }, forMasks: [maskId] } },
  });
  const object = newObject({ id: objectId, existing: [], produced: { model,
    mask: { asset: maskId, format: 'u8', size }, bounds: { x: 260, y: 150, width: 120, height: 180 },
    depth: { p10: .8, median: .8, p90: .8 }, color: { mean: { L: .5, a: 0, b: 0 },
      clusters: [{ lab: { L: .65, a: .03, b: .04 }, weight: .6 }, { lab: { L: .3, a: -.03, b: -.04 }, weight: .4 }] },
    selection: { kind: 'auto-subject', seed: { at: { x: .5, y: .5 }, label: 'include' }, candidate: 0, size: .5 },
  } });
  const params = new URLSearchParams(location.search);
  const document = currentDocumentSchema.parse({ ...doc, objects: [object], style: { ...doc.style, crunch: 0 }, motion: { ...doc.motion, enabled: params.get('motion') !== 'off' } });
  const planes = new Map<AssetId, Plane<'u8'> | Plane<'f32'> | Rgb8>([[maskId, mask], [depthId, depth], [plateId, plate]]);
  if (params.get('asset') === 'missing') planes.delete(maskId);
  return { document, source: params.get('source') === 'broken' ? new Blob(['broken'], { type: 'image/png' }) : master, planes };
}

const load: GalleryLoader = async () => ({ title: 'Gallery sample', posterUrl: '/assets-static/sample.jpg', loadPiece: piece });
if (NOISY_DEV) window.__noisyGalleryFixture = load;
