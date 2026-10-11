import type { Vec2 } from './motion.ts';

export type FaceBox = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
export type FaceObservation = Readonly<{ center: Vec2; size: number; confidence?: number | undefined; box?: FaceBox | undefined; clipped?: boolean | undefined }>;
export type FaceCaptureTransform = Readonly<{ width: number; height: number; x: number; y: number; drawWidth: number; drawHeight: number }>;
const CENTER: Vec2 = { x: .5, y: .5 };
export const FACE_LATERAL_GAIN = 2;
export const FACE_CALIBRATION_MS = 350;

/** Letterbox the actual video aperture into the model's 320 x 240 input. */
export function faceCaptureTransform(width: number, height: number): FaceCaptureTransform {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Invalid camera dimensions.');
  const scale = Math.min(320 / width, 240 / height);
  const drawWidth = width * scale, drawHeight = height * scale;
  return { width, height, x: (320 - drawWidth) / 2, y: (240 - drawHeight) / 2, drawWidth, drawHeight };
}

/** Detector coordinates are unmirrored; control coordinates mirror exactly once. */
export function faceFromCapture(face: FaceObservation, transform: FaceCaptureTransform): FaceObservation | null {
  const x = (face.center.x * 320 - transform.x) / transform.drawWidth;
  const y = (face.center.y * 240 - transform.y) / transform.drawHeight;
  if (![x, y].every((n) => Number.isFinite(n) && n > 0 && n < 1) || face.clipped === true) return null;
  const box = face.box === undefined ? undefined : {
    x0: (face.box.x0 * 320 - transform.x) / transform.drawWidth,
    y0: (face.box.y0 * 240 - transform.y) / transform.drawHeight,
    x1: (face.box.x1 * 320 - transform.x) / transform.drawWidth,
    y1: (face.box.y1 * 240 - transform.y) / transform.drawHeight,
  };
  if (box !== undefined && (box.x0 <= 0 || box.y0 <= 0 || box.x1 >= 1 || box.y1 >= 1)) return null;
  return {
    ...face, center: { x: 1 - x, y },
    size: box === undefined ? face.size : Math.max(box.x1 - box.x0, box.y1 - box.y0),
    ...(box === undefined ? {} : { box: { x0: 1 - box.x1, x1: 1 - box.x0, y0: box.y0, y1: box.y1 } }),
  };
}

export type FaceViewSample = Readonly<{ center: Vec2; capturedAt: number; sequence: number; state: 'tracking' | 'lost' | 'calibrating'; quality: number }>;
type Sample = { face: FaceObservation; at: number };
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
function median(values: number[]): number { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)] ?? .5; }

/** Fixed-distance relative face proxy, with no adaptive baseline or metric eye claim. */
export function createFaceView() {
  let neutral: Vec2 | null = null, previous: Sample | null = null;
  let samples: Sample[] = [], sequence = -1, capturedAt = -Infinity;
  let center: Vec2 = CENTER;
  const compatible = (face: FaceObservation): boolean => previous === null || (distance(face.center, previous.face.center) <= .18 &&
    face.size / previous.face.size <= 1.6 && face.size / previous.face.size >= .625);
  return {
    recenter(): void { neutral = null; previous = null; samples = []; center = CENTER; },
    select(candidates: readonly FaceObservation[]): FaceObservation | null {
      const suitable = candidates.filter((face) => (face.confidence ?? 1) >= .8 && face.clipped !== true && compatible(face));
      const anchor = previous?.face.center;
      suitable.sort((a, b) => anchor === undefined ? b.size - a.size : distance(a.center, anchor) - distance(b.center, anchor));
      return suitable[0] ?? null;
    },
    observe(face: FaceObservation | null, at: number, id: number): FaceViewSample | null {
      if (!Number.isFinite(at) || at < capturedAt || !Number.isSafeInteger(id) || id <= sequence) return null;
      if (at - capturedAt > 250) samples = [];
      capturedAt = at; sequence = id;
      const quality = face?.confidence ?? (face === null ? 0 : 1);
      const result = (state: FaceViewSample['state']): FaceViewSample => ({ center, capturedAt: at, sequence: id, state, quality });
      if (face === null || quality < .8 || face.clipped === true) { samples = []; return result('lost'); }
      // Keep the acquired viewer through loss. A distant replacement must recenter.
      if (!compatible(face)) {
        samples = []; return result('lost');
      }
      previous = { face, at };
      if (neutral === null) {
        if (samples.some((sample) => distance(sample.face.center, face.center) > .018)) samples = [];
        samples.push({ face, at });
        if (samples.length > 32) samples.shift();
        if (samples.length < 4 || at - (samples[0]?.at ?? at) < FACE_CALIBRATION_MS) return result('calibrating');
        neutral = { x: median(samples.map((s) => s.face.center.x)), y: median(samples.map((s) => s.face.center.y)) };
        samples = [];
      }
      center = { x: .5 + (face.center.x - neutral.x) * FACE_LATERAL_GAIN, y: .5 + (face.center.y - neutral.y) * FACE_LATERAL_GAIN };
      return result('tracking');
    },
  };
}
