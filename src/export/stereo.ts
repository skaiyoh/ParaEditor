import type { Renderer } from '../render/types.ts';
import type { SceneDocument } from '../core/types.ts';
import type { Size } from '../core/raster.ts';
import { parallaxClamp } from '../core/derive.ts';
import { encodeMpo } from './mpo.ts';

export const STEREO_3DS_SIZE: Size = { width: 640, height: 480 };

async function jpegView(png: Blob, size: Size): Promise<Blob> {
  const bitmap = await createImageBitmap(png);
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (context === null) throw new Error('The stereo export canvas could not be created.');
    context.fillStyle = '#000'; context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    const scale = Math.min(size.width / bitmap.width, size.height / bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    context.drawImage(bitmap, (size.width - width) / 2, (size.height - height) / 2, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    if (jpeg.type !== 'image/jpeg') throw new Error('This browser could not encode a stereo JPEG.');
    return jpeg;
  } finally { bitmap.close(); }
}

/** Render both cameras before yielding so edits and playback cannot split the pair. */
export async function renderStereo(renderer: Renderer, doc: SceneDocument, size: Size) {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error('Stereo export needs positive integer dimensions.');
  }
  const s = 0.5 * parallaxClamp(doc);
  const leftPng = renderer.exportView({ x: -s, y: 0 });
  const rightPng = renderer.exportView({ x: s, y: 0 });
  const [left, right] = await Promise.all([
    leftPng.then((png) => jpegView(png, size)), rightPng.then((png) => jpegView(png, size)),
  ]);
  const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
  const mpo = new Blob([encodeMpo(new Uint8Array(leftBytes), new Uint8Array(rightBytes))], { type: 'image/mpo' });
  return { left, right, mpo };
}
