/** The 256 px long-edge analysis copy of the opaque sRGB master. */
export function makeThumbnail(master: ImageBitmap): ImageData {
  const scale = 256 / Math.max(master.width, master.height);
  const width = Math.max(1, Math.round(master.width * scale));
  const height = Math.max(1, Math.round(master.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb', willReadFrequently: true });
  if (context === null) throw new Error('The analysis thumbnail could not be created.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(master, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
