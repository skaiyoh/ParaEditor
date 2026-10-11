import type { Vec2 } from './motion.ts';

/** W3C intrinsic Z-X'-Y'' angles in degrees; absent alpha cannot describe yaw. */
export type OrientationSample = { alpha?: number | null; beta: number | null; gamma: number | null };
type Vector = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];
type Pose = { kind: 'full'; gravity: Vector; rotation: Quaternion } | { kind: 'gravity'; gravity: Vector };
export type DisplayBasis = { angle: number; provenance: 'native' | 'legacy-aligned-native' | 'type-aligned-native' | 'legacy' | 'type' };
const RAD = Math.PI / 180;
const clamp = (n: number): number => Math.max(-1, Math.min(1, n));
const quarter = (n: number | null): number | null => n !== null && Number.isFinite(n) && n % 90 === 0 ? (n % 360 + 360) % 360 : null;
const typeAngle: Record<OrientationType, number> = {
  'portrait-primary': 0, 'portrait-secondary': 180, 'landscape-primary': 90, 'landscape-secondary': 270,
};

/** ScreenOrientation.angle is natural-screen-relative; sensors/legacy use portrait device axes. */
export function resolveDisplayBasis(nativeAngle: number | null, type: OrientationType | null, legacyAngle: number | null): DisplayBasis {
  const native = quarter(nativeAngle), legacy = quarter(legacyAngle);
  if (native !== null) {
    if (type === null || native % 180 === typeAngle[type] % 180) return { angle: native, provenance: 'native' };
    if (legacy !== null && legacy % 180 === typeAngle[type] % 180) return { angle: legacy, provenance: 'legacy-aligned-native' };
    return { angle: typeAngle[type], provenance: 'type-aligned-native' };
  }
  if (legacy !== null) return { angle: legacy, provenance: 'legacy' };
  return { angle: type === null ? 0 : typeAngle[type], provenance: 'type' };
}

/** Device x rotation (beta) and y rotation (gamma) to display x/right, y/down control axes. */
export function rotateTilt(beta: number, gamma: number, displayAngle: number): Vec2 {
  switch (quarter(displayAngle)) {
    case 90: return { x: beta, y: -gamma };
    case 180: return { x: -gamma, y: -beta };
    case 270: return { x: -beta, y: gamma };
    default: return { x: gamma, y: beta };
  }
}

const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}

export function orientationPose(sample: OrientationSample): Pose | null {
  const { beta, gamma, alpha } = sample;
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = beta * RAD, g = gamma * RAD;
  const gravity: Vector = [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
  if (alpha === null || alpha === undefined || !Number.isFinite(alpha)) return { kind: 'gravity', gravity };
  const a = alpha * RAD;
  const q = multiply(multiply([0, 0, Math.sin(a / 2), Math.cos(a / 2)], [Math.sin(b / 2), 0, 0, Math.cos(b / 2)]),
    [0, Math.sin(g / 2), 0, Math.cos(g / 2)]);
  const length = Math.hypot(...q);
  return { kind: 'full', gravity, rotation: [q[0] / length, q[1] / length, q[2] / length, q[3] / length] };
}

/** Shortest relative rotation, expressed in neutral device axes, in degrees. */
export function relativeRotation(neutral: Pose, current: Pose): Vector {
  if (neutral.kind === 'full' && current.kind === 'full') {
    const n = neutral.rotation;
    const q = multiply([-n[0], -n[1], -n[2], n[3]], current.rotation);
    const sign = q[3] < 0 ? -1 : 1;
    const length = Math.hypot(q[0], q[1], q[2]);
    const scale = length < 1e-12 ? 0 : sign * 2 * Math.atan2(length, Math.abs(q[3])) / length / RAD;
    return [q[0] * scale, q[1] * scale, q[2] * scale];
  }
  const axis = cross(current.gravity, neutral.gravity), length = Math.hypot(...axis);
  const angle = Math.acos(clamp(dot(neutral.gravity, current.gravity)));
  // Antipodal gravity has no unique rotation axis; callers must recalibrate rather than invent one.
  if (length < 1e-12) return [0, 0, 0];
  const scale = angle / length / RAD;
  return [axis[0] * scale, axis[1] * scale, axis[2] * scale];
}

export type TiltObservation = {
  delta: Vec2; pose: 'full' | 'gravity' | 'unavailable'; yawLimited: boolean;
  state: 'tracking' | 'lost' | 'calibrating';
  reason: 'neutral' | 'sample' | 'invalid' | 'stale' | 'basis-change' | 'pose-change' | 'heading-reset' | 'antipodal';
};

/** Calibration is transient. Reference changes hold the last view until the next valid relative motion. */
export function createOrientationTracker() {
  let neutral: Pose | null = null, previous: Pose | null = null, lastTime = -Infinity, angle: number | null = null;
  let offset: Vec2 = { x: 0, y: 0 }, delta: Vec2 = offset;
  function recenter(): void { neutral = null; previous = null; lastTime = -Infinity; angle = null; offset = { x: 0, y: 0 }; delta = offset; }
  function observe(sample: OrientationSample, displayAngle: number, capturedAt: number): TiltObservation {
    const pose = orientationPose(sample);
    const result = (state: TiltObservation['state'], reason: TiltObservation['reason']): TiltObservation => ({ delta, pose: pose?.kind ?? 'unavailable', yawLimited: pose?.kind !== 'full', state, reason });
    if (pose === null || !Number.isFinite(capturedAt)) return result('lost', 'invalid');
    if (capturedAt <= lastTime) return result('lost', 'stale');
    let reset: TiltObservation['reason'] | null = null;
    if (neutral === null) reset = 'neutral';
    else if (angle !== displayAngle) reset = 'basis-change';
    else if (neutral.kind !== pose.kind) reset = 'pose-change';
    else if (dot(neutral.gravity, pose.gravity) < -.9999 && pose.kind === 'gravity') reset = 'antipodal';
    else if (previous !== null && previous.kind === 'full' && pose.kind === 'full'
      && capturedAt - lastTime < 100 && Math.hypot(...relativeRotation(previous, pose)) > 60
      && Math.acos(clamp(dot(previous.gravity, pose.gravity))) / RAD < 10) reset = 'heading-reset';
    if (reset !== null) { neutral = pose; offset = delta; }
    if (neutral !== null) {
      const rotation = relativeRotation(neutral, pose), mapped = rotateTilt(rotation[0], rotation[1], displayAngle);
      delta = { x: offset.x + mapped.x, y: offset.y + mapped.y };
    }
    previous = pose; lastTime = capturedAt; angle = displayAngle;
    return result(reset === null ? 'tracking' : 'calibrating', reset ?? 'sample');
  }
  return { observe, recenter };
}
