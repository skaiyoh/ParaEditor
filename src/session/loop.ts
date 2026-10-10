import { gifReplySchema } from '../export/gif.ts';
import { z } from '../core/zod.ts';
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

/** Size the export without changing the stage's master-size render targets. */
export function loopCanvas(master: { readonly width: number; readonly height: number }, edge: number, upscale = false): HTMLCanvasElement {
  const ratio = edge / Math.max(master.width, master.height);
  const scale = upscale ? ratio : Math.min(1, ratio);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(master.width * scale));
  canvas.height = Math.max(1, Math.round(master.height * scale));
  return canvas;
}

/** One request in flight: transferable frame storage is reclaimed before the next draw. */
export async function encodeLoopGif({ canvas, frames, fps, signal, render, progress }: {
  readonly canvas: HTMLCanvasElement; readonly frames: number; readonly fps: number;
  readonly signal: AbortSignal; readonly render: (frame: number) => void;
  readonly progress: (completed: number) => void;
}): Promise<Blob> {
  signal.throwIfAborted();
  const worker = new Worker(z.object({ gif: z.string().min(1) }).parse(NOISY_WORKER_URLS).gif, { type: 'module' });
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (context === null) { worker.terminate(); throw new Error('The GIF export canvas could not be created.'); }
  const exchange = (message: unknown, transfer: Transferable[] = []) => new Promise<z.infer<typeof gifReplySchema>>((resolve, reject) => {
    const finish = (error: unknown, reply?: z.infer<typeof gifReplySchema>) => {
      clearTimeout(timer); signal.removeEventListener('abort', aborted);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      if (reply === undefined) reject(error); else resolve(reply);
    };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('The GIF encoder timed out.')), 30_000);
    signal.addEventListener('abort', aborted, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new Error('The GIF worker failed.')); };
    worker.onmessageerror = () => finish(new Error('The GIF worker returned an unreadable frame.'));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const parsed = gifReplySchema.safeParse(event.data);
      if (!parsed.success) finish(new Error('The GIF worker returned an invalid reply.'));
      else if (parsed.data.kind === 'failed') finish(new Error(parsed.data.detail));
      else finish(null, parsed.data);
    };
    try { signal.throwIfAborted(); worker.postMessage(message, transfer); } catch (error) { finish(error); }
  });
  try {
    const ready = await exchange({ kind: 'start', width: canvas.width, height: canvas.height, frames, fps });
    if (ready.kind !== 'ready') throw new Error('The GIF encoder did not start.');
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted(); render(frame);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const reply = await exchange({ kind: 'frame', pixels }, [pixels.data.buffer]);
      if (reply.kind !== 'progress' || reply.completed !== frame + 1) throw new Error('The GIF encoder lost a frame.');
      progress(reply.completed);
    }
    const reply = await exchange({ kind: 'finish' });
    if (reply.kind !== 'done') throw new Error('The GIF encoder did not finish.');
    signal.throwIfAborted();
    return new Blob([new Uint8Array(reply.bytes)], { type: 'image/gif' });
  } finally { worker.terminate(); }
}
