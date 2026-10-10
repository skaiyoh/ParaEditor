import type { Rect, Size } from '../core/raster.ts';

export type GridMesh = { readonly vertices: Float32Array; readonly indices: Uint16Array };

/** Frame-space vertices, y down as in every stored texture. Positive winding. */
export function gridMesh(columns: number, rows: number, bounds: Rect = { x: 0, y: 0, width: 1, height: 1 }): GridMesh {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || (columns + 1) * (rows + 1) > 65536) {
    throw new RangeError('The grid must fit unsigned-short indices.');
  }
  const vertices = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
    const i = (y * (columns + 1) + x) * 2;
    vertices[i] = bounds.x + bounds.width * x / columns;
    vertices[i + 1] = bounds.y + bounds.height * y / rows;
  }
  const indices = new Uint16Array(columns * rows * 6);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const a = y * (columns + 1) + x, b = a + 1, c = a + columns + 1, d = c + 1;
    indices.set([a, b, c, b, d, c], (y * columns + x) * 6);
  }
  return { vertices, indices };
}

export const backGrid = (): GridMesh => gridMesh(192, 144);

export function objectGrid(bounds: Rect, frame: Size, clamp: number): GridMesh {
  const x = Math.max(0, bounds.x / frame.width - clamp), y = Math.max(0, bounds.y / frame.height - clamp);
  const right = Math.min(1, (bounds.x + bounds.width) / frame.width + clamp);
  const bottom = Math.min(1, (bounds.y + bounds.height) / frame.height + clamp);
  return gridMesh(64, 64, { x, y, width: right - x, height: bottom - y });
}
