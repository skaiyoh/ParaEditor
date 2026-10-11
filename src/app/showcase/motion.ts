import type { Eye } from './scene.ts';

export type Spring = Readonly<{ position: Eye; velocity: Eye }>;
const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

/** The approved Highland mapping: calibrated face coordinates, gain applied once. */
export function headTarget(center: Eye, gain: number): Eye {
  return { x: clamp((center.x - .5) * 2 * gain), y: clamp((.5 - center.y) * 2 * gain) };
}

/** Exact critically damped spring, interpolating the 15 Hz detector at display rate. */
export function advanceSpring(spring: Spring, target: Eye, milliseconds: number, camera: boolean, reduced: boolean): Spring {
  if (reduced) return { position: target, velocity: { x: 0, y: 0 } };
  const dt = Math.max(0, Math.min(50, milliseconds)) / 1000, omega = camera ? 12 : 15, decay = Math.exp(-omega * dt);
  const axis = (position: number, velocity: number, next: number) => {
    const offset = position - next, j = velocity + omega * offset;
    const p = next + (offset + j * dt) * decay, v = (velocity - omega * j * dt) * decay;
    return Math.abs(p - next) < .0002 && Math.abs(v) < .001 ? { p: next, v: 0 } : { p, v };
  };
  const x = axis(spring.position.x, spring.velocity.x, target.x), y = axis(spring.position.y, spring.velocity.y, target.y);
  return { position: { x: x.p, y: y.p }, velocity: { x: x.v, y: y.v } };
}
