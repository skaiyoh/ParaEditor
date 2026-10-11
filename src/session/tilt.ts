import type { ViewSource } from './view-driver.ts';
import type { Vec2 } from '../core/motion.ts';
import { createOrientationTracker, resolveDisplayBasis, rotateTilt, type OrientationSample, type TiltObservation } from '../core/orientation.ts';

export type Orientation = OrientationSample;
const TRAVEL_DEGREES = 20;
const FIRST_EVENT_MS = 2000;
let injectedScreenAngle: number | null = null;

/** Accepts a resolved portrait-relative angle; type is retained for older callers. */
export function screenTilt(beta: number, gamma: number, angle: number, _type?: OrientationType): Vec2 {
  return rotateTilt(beta, gamma, angle);
}

export function screenOrientation() {
  const native = window.screen.orientation;
  const angle = Number.isFinite(native?.angle) ? native.angle : null;
  const legacy = typeof window.orientation === 'number' && Number.isFinite(window.orientation) ? window.orientation : null;
  const basis = resolveDisplayBasis(angle, native?.type ?? null, legacy);
  const injected = NOISY_DEV && injectedScreenAngle !== null;
  return { type: native?.type ?? null, effectiveType: native?.type ?? 'portrait-primary', angle, legacy,
    effectiveAngle: injected ? injectedScreenAngle ?? basis.angle : basis.angle, basisProvenance: injected ? 'injected' : basis.provenance };
}

/** Dev-only portrait-relative screen rotation override; null restores device metadata. */
export function injectScreenAngle(angle: number | null): void {
  if (!NOISY_DEV) throw new Error('Screen angle injection is available only in dev builds.');
  if (angle !== null && (!Number.isFinite(angle) || angle % 90 !== 0)) throw new Error('Invalid injected screen angle.');
  injectedScreenAngle = angle === null ? null : (angle % 360 + 360) % 360;
}

export function createTiltSource() {
  let inject: ((orientation: Orientation) => void) | null = null;
  let raw: Orientation = { alpha: null, beta: null, gamma: null };
  let corrected: TiltObservation = { delta: { x: 0, y: 0 }, pose: 'unavailable', yawLimited: true, state: 'calibrating', reason: 'neutral' };
  let sequence = 0, capturedAt = 0;
  const source: ViewSource = async (attempt) => {
    raw = { alpha: null, beta: null, gamma: null }; sequence = 0; capturedAt = 0;
    corrected = { delta: { x: 0, y: 0 }, pose: 'unavailable', yawLimited: true, state: 'calibrating', reason: 'neutral' };
    try {
      const orientation = typeof DeviceOrientationEvent === 'undefined' ? null : DeviceOrientationEvent;
      if (orientation !== null && 'requestPermission' in orientation && typeof orientation.requestPermission === 'function') {
        const permission: unknown = await orientation.requestPermission();
        if (!attempt.valid()) return () => {};
        if (permission !== 'granted') { attempt.failed('Tilt unavailable'); return () => {}; }
      }
      if (!attempt.valid()) return () => {};
      await new Promise<void>((resolve) => {
        const tracker = createOrientationTracker();
        const clamp = (delta: number): number => Math.max(0, Math.min(1, .5 + delta / (2 * TRAVEL_DEGREES)));
        const timer = window.setTimeout(() => attempt.failed('Tilt unavailable'), FIRST_EVENT_MS);
        const receive = (sample: Orientation, eventTime = performance.now()): void => {
          if (!attempt.valid()) return;
          raw = { alpha: sample.alpha ?? null, beta: sample.beta, gamma: sample.gamma };
          capturedAt = eventTime; sequence++;
          corrected = tracker.observe(raw, screenOrientation().effectiveAngle, capturedAt);
          if (corrected.state !== 'lost') { clearTimeout(timer); resolve(); }
          attempt.target({ x: clamp(corrected.delta.x), y: clamp(corrected.delta.y) },
            { capturedAt, sequence, state: corrected.state, quality: corrected.pose === 'full' ? 1 : .6 });
        };
        const event = (sample: DeviceOrientationEvent): void => {
          const now = performance.now();
          const timestamp = sample.timeStamp > now + 60_000 ? sample.timeStamp - performance.timeOrigin : sample.timeStamp;
          receive(sample, Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : now);
        };
        attempt.onRecenter?.(() => {
          tracker.recenter();
          corrected = { ...corrected, delta: { x: 0, y: 0 }, state: 'calibrating', reason: 'neutral' };
          attempt.target({ x: .5, y: .5 }, { capturedAt: performance.now(), sequence: ++sequence, state: 'calibrating' });
        });
        inject = receive;
        window.addEventListener('deviceorientation', event);
        attempt.dispose(() => {
          clearTimeout(timer); window.removeEventListener('deviceorientation', event);
          if (inject === receive) inject = null;
          resolve();
        });
      });
      return () => {};
    } catch { attempt.failed('Tilt unavailable'); return () => {}; }
  };
  return {
    source,
    readings: () => ({ ...raw, ...screenOrientation(), ...corrected, sequence, capturedAt, preclamp: corrected.delta }),
    injectOrientation(orientation: Orientation): void {
      if (!NOISY_DEV) throw new Error('Orientation injection is available only in dev builds.');
      if (![orientation.alpha, orientation.beta, orientation.gamma].every((v) => v === undefined || v === null || Number.isFinite(v))) throw new Error('Invalid injected orientation.');
      inject?.(orientation);
    },
  };
}
