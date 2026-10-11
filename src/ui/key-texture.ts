/** The fixed crunchTile(1) from the RS1 composition, independent of scene Fry. */
function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function crunchTile(amount = 1): string {
  const n = 64, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d');
  if (g === null) return 'none';
  const im = g.createImageData(n, n), base = 242;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const bx = x >> 3, by = y >> 3;
    const blk = (hash(bx, by, 3) - 0.5) * 2, edge = (x & 7) === 0 || (y & 7) === 0 ? -1 : 0;
    const d = blk * 34 * amount + edge * 18 * amount, ch = (hash(bx, by, 11) - 0.5) * 16 * amount;
    const i = (y * n + x) * 4;
    im.data[i] = base + d + ch - 8 * amount; im.data[i + 1] = base + d - 8 * amount; im.data[i + 2] = base + d - ch - 8 * amount; im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  // Upscale with hard edges to the device's pixel ratio so the blocks stay crisp at background-size 64px.
  const scale = Math.min(3, Math.max(1, Math.round(globalThis.devicePixelRatio || 1)));
  if (scale === 1) return 'url(' + c.toDataURL() + ')';
  const big = document.createElement('canvas'); big.width = big.height = n * scale;
  const bg = big.getContext('2d');
  if (bg === null) return 'url(' + c.toDataURL() + ')';
  bg.imageSmoothingEnabled = false; bg.drawImage(c, 0, 0, n * scale, n * scale);
  return 'url(' + big.toDataURL() + ')';
}
let installed = false;
export function installKeyTexture(): void {
  if (installed) return;
  document.documentElement.style.setProperty('--key-texture', crunchTile(1));
  installed = true;
}
