import { createViewDriver, type ViewHost } from './view-driver.ts';
import type { Vec2 } from '../core/motion.ts';

export type Orientation = Pick<DeviceOrientationEvent, 'beta' | 'gamma'>;
const TRAVEL_DEGREES = 20;
const FIRST_EVENT_MS = 2000;
let injectedScreenAngle: number | null = null;

/** Device tilt in screen axes, with exact quarter turns to preserve portrait travel. */
export function screenTilt(beta: number, gamma: number, angle: number): Vec2 {
  switch ((angle % 360 + 360) % 360) {
    case 90: return { x: beta, y: -gamma };
    case 180: return { x: -gamma, y: -beta };
    case 270: return { x: -beta, y: gamma };
    default: return { x: gamma, y: beta };
  }
}

function screenAngle(): number {
  if (NOISY_DEV && injectedScreenAngle !== null) return injectedScreenAngle;
  const angle = window.screen.orientation?.angle;
  if (Number.isFinite(angle)) return angle;
  return typeof window.orientation === 'number' && Number.isFinite(window.orientation) ? window.orientation : 0;
}

/** Dev-only screen rotation override; null restores the device's angle. */
export function injectScreenAngle(angle: number | null): void {
  if (!NOISY_DEV) throw new Error('Screen angle injection is available only in dev builds.');
  if (angle !== null && (!Number.isFinite(angle) || angle % 90 !== 0)) throw new Error('Invalid injected screen angle.');
  injectedScreenAngle = angle;
}

export function createTiltDriver(host: ViewHost) {
  let inject: ((orientation: Orientation) => void) | null = null;
  const view = createViewDriver(host, async (attempt) => {
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
        let rest: Vec2 | null = null;
        let restAngle = 0;
        const clamp = (delta: number): number => Math.max(0, Math.min(1, .5 + delta / (2 * TRAVEL_DEGREES)));
        const timer = window.setTimeout(() => attempt.failed('Tilt unavailable'), FIRST_EVENT_MS);
        const receive = ({ beta, gamma }: Orientation): void => {
          if (!attempt.valid() || beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;
          const angle = screenAngle(), tilt = screenTilt(beta, gamma, angle);
          if (rest === null) { rest = tilt; restAngle = angle; clearTimeout(timer); resolve(); }
          else if (angle !== restAngle) {
            // Keep the captured physical rest in the current screen basis after a rotation.
            rest = screenTilt(rest.y, rest.x, angle - restAngle); restAngle = angle;
          }
          attempt.target({ x: clamp(tilt.x - rest.x), y: clamp(tilt.y - rest.y) });
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
  });
  return {
    ...view,
    injectOrientation(orientation: Orientation): void {
      if (!NOISY_DEV) throw new Error('Orientation injection is available only in dev builds.');
      if (![orientation.beta, orientation.gamma].every((v) => v === null || Number.isFinite(v))) throw new Error('Invalid injected orientation.');
      inject?.(orientation);
    },
  };
}
