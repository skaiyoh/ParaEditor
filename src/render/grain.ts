/** MurmurHash3's published 32-bit fmix finalizer; all arithmetic wraps uint32. */
export function fmix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export const CHANNEL_SALTS = [0x243f6a88, 0x85a308d3, 0x13198a2e] as const;

export function grainHash(seed: number, hold: number, cellX: number, cellY: number, channel: number): number {
  const salt = CHANNEL_SALTS[channel];
  if (salt === undefined) throw new RangeError('Grain has three channels.');
  return fmix32(fmix32(fmix32(fmix32(seed ^ salt) ^ hold) ^ cellX) ^ cellY);
}

/** Top 24 bits fit exactly in a GLSL highp float, including both endpoints. */
export function grainNoise(seed: number, hold: number, cellX: number, cellY: number, channel: number): number {
  return (grainHash(seed, hold, cellX, cellY, channel) >>> 8) / 0xffffff * 2 - 1;
}

export function holdIndex(frame: number, frameCount: number, grainHold: number): number {
  if (!Number.isInteger(frame) || !Number.isInteger(frameCount) || frameCount < 1 || !Number.isInteger(grainHold) || grainHold < 1) {
    throw new RangeError('Grain needs an integer frame and positive integer count and hold.');
  }
  const wrapped = ((frame % frameCount) + frameCount) % frameCount;
  return Math.floor(wrapped / grainHold) % Math.ceil(frameCount / grainHold);
}
