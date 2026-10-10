/** Integer playback time only. Rendering receives the resulting frame, never time. */
export const LOOP_FPS = 30;

export function wrapFrame(frame: number, count: number): number {
  if (!Number.isFinite(frame) || !Number.isInteger(count) || count < 1) throw new RangeError('Invalid loop frame or count.');
  return ((Math.floor(frame) % count) + count) % count;
}

export function frameAtElapsed(elapsedMs: number, count: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('Elapsed loop time must be finite and nonnegative.');
  return wrapFrame(Math.floor(elapsedMs * LOOP_FPS / 1000), count);
}
