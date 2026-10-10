import { frameAtElapsed } from '../render/loop.ts';
import type { ImagePoint } from '../core/raster.ts';

/** Convert a zoomed preview point to the stored frame, about its center. */
export function loopTapPoint(at: ImagePoint, zoom: number): ImagePoint {
  return { x: .5 + (at.x - .5) / zoom, y: .5 + (at.y - .5) / zoom };
}

/** The sole playback clock. A slow callback skips frames instead of stretching time. */
export function createLoopStepper(render: (frame: number) => void, failed: (error: unknown) => void) {
  let request: number | null = null;
  let origin: number | null = null;
  let count = 1;
  let frame = 0;
  let key: string | null = null;
  function stop(): void {
    if (request !== null) cancelAnimationFrame(request);
    request = null; origin = null; key = null;
  }
  function tick(now: number): void {
    request = null;
    if (origin === null) origin = now;
    const next = frameAtElapsed(Math.max(0, now - origin), count);
    try {
      if (next !== frame) { render(next); frame = next; }
      request = requestAnimationFrame(tick);
    } catch (error) { stop(); failed(error); }
  }
  return {
    start(nextCount: number, nextKey: string): void {
      if (request !== null && key === nextKey && count === nextCount) return;
      stop(); count = nextCount; key = nextKey; frame = 0;
      render(frame);
      request = requestAnimationFrame(tick);
    },
    stop,
    frame: (): number => frame,
    running: (): boolean => request !== null,
  };
}
