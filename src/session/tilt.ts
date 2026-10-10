import { createViewDriver, type ViewHost } from './view-driver.ts';

export type Orientation = Pick<DeviceOrientationEvent, 'beta' | 'gamma'>;
const TRAVEL_DEGREES = 20;
const FIRST_EVENT_MS = 2000;

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
        let rest: { beta: number; gamma: number } | null = null;
        const clamp = (delta: number): number => Math.max(0, Math.min(1, .5 + delta / (2 * TRAVEL_DEGREES)));
        const timer = window.setTimeout(() => attempt.failed('Tilt unavailable'), FIRST_EVENT_MS);
        const receive = ({ beta, gamma }: Orientation): void => {
          if (!attempt.valid() || beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return;
          if (rest === null) { rest = { beta, gamma }; clearTimeout(timer); resolve(); }
          attempt.target({ x: clamp(gamma - rest.gamma), y: clamp(beta - rest.beta) });
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
