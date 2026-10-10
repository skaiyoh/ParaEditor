import type { ViewSource } from './view-driver.ts';
import type { Vec2 } from '../core/motion.ts';

export type Orientation = Pick<DeviceOrientationEvent, 'beta' | 'gamma'>;
const TRAVEL_DEGREES = 20;
const FIRST_EVENT_MS = 2000;
let injectedScreenAngle: number | null = null;

type Axes = readonly [number, number, number, number];
// PH3's angle mapping is identical for all orientation types until measured on the iPad.
const PH3_AXES: Readonly<Record<number, Axes>> = {
  0: [0, 1, 1, 0], 90: [1, 0, 0, -1], 180: [0, -1, -1, 0], 270: [-1, 0, 0, 1],
};
const SCREEN_TILT_MAPPING: Readonly<Record<OrientationType, Readonly<Record<number, Axes>>>> = {
  'portrait-primary': PH3_AXES, 'portrait-secondary': PH3_AXES,
  'landscape-primary': PH3_AXES, 'landscape-secondary': PH3_AXES,
};

/** Pure device-to-screen mapping; rows can be corrected from the iPad readings. */
export function screenTilt(beta: number, gamma: number, angle: number, type: OrientationType = 'portrait-primary'): Vec2 {
  const [xb, xg, yb, yg] = SCREEN_TILT_MAPPING[type][(angle % 360 + 360) % 360] ?? [0, 1, 1, 0];
  return { x: xb * beta + xg * gamma, y: yb * beta + yg * gamma };
}

export function screenOrientation() {
  const native = window.screen.orientation;
  const angle = Number.isFinite(native?.angle) ? native.angle : null;
  const legacy = typeof window.orientation === 'number' && Number.isFinite(window.orientation) ? window.orientation : null;
  const effectiveAngle = NOISY_DEV && injectedScreenAngle !== null ? injectedScreenAngle : angle ?? legacy ?? 0;
  return { type: native?.type ?? null, effectiveType: native?.type ?? 'portrait-primary', angle, legacy, effectiveAngle };
}

/** Dev-only screen rotation override; null restores the device's angle. */
export function injectScreenAngle(angle: number | null): void {
  if (!NOISY_DEV) throw new Error('Screen angle injection is available only in dev builds.');
  if (angle !== null && (!Number.isFinite(angle) || angle % 90 !== 0)) throw new Error('Invalid injected screen angle.');
  injectedScreenAngle = angle;
}

export function createTiltSource() {
  let inject: ((orientation: Orientation) => void) | null = null;
  let raw: Orientation = { beta: null, gamma: null };
  const source: ViewSource = async (attempt) => {
    raw = { beta: null, gamma: null };
    try {
      const orientation = typeof DeviceOrientationEvent === 'undefined' ? null : DeviceOrientationEvent;
      if (orientation !== null && 'requestPermission' in orientation && typeof orientation.requestPermission === 'function') {
        // Invoke before the first await while transient user activation is still present.
        const permission: unknown = await orientation.requestPermission();
        if (!attempt.valid()) return () => {};
        if (permission !== 'granted') { attempt.failed('Tilt unavailable'); return () => {}; }
      }
      if (!attempt.valid()) return () => {};
      await new Promise<void>((resolve) => {
        let rest: { beta: number; gamma: number } | null = null;
        const clamp = (delta: number): number => Math.max(0, Math.min(1, .5 + delta / (2 * TRAVEL_DEGREES)));
        const timer = window.setTimeout(() => attempt.failed('Tilt unavailable'), FIRST_EVENT_MS);
        const receive = ({ beta, gamma }: Orientation): void => {
          if (!attempt.valid() || beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;
          raw = { beta, gamma };
          const screen = screenOrientation();
          if (rest === null) { rest = { beta, gamma }; clearTimeout(timer); resolve(); }
          const delta = screenTilt(beta - rest.beta, gamma - rest.gamma, screen.effectiveAngle, screen.effectiveType);
          attempt.target({ x: clamp(delta.x), y: clamp(delta.y) });
        };
        inject = receive;
        window.addEventListener('deviceorientation', receive);
        attempt.dispose(() => {
          clearTimeout(timer); window.removeEventListener('deviceorientation', receive);
          if (inject === receive) inject = null;
          resolve();
        });
      });
      return () => {};
    } catch { attempt.failed('Tilt unavailable'); return () => {}; }
  };
  return {
    source,
    readings: () => ({ ...raw, ...screenOrientation() }),
    injectOrientation(orientation: Orientation): void {
      if (!NOISY_DEV) throw new Error('Orientation injection is available only in dev builds.');
      if (![orientation.beta, orientation.gamma].every((v) => v === null || Number.isFinite(v))) throw new Error('Invalid injected orientation.');
      inject?.(orientation);
    },
  };
}
