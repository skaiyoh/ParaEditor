import type { Renderer } from '../render/types.ts';

export function renderPng(renderer: Renderer): Promise<Blob> {
  return renderer.exportStill();
}

/** Encode the canonical master for its asset identity, before any rendering. */
export async function encodePng(pixels: ImageData): Promise<Blob> {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  if (context === null) throw new Error('The PNG canvas could not be created.');
  context.putImageData(pixels, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export function savePng(blob: Blob, title: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title}.png`;
  link.click();
  // Let the browser consume the URL before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
