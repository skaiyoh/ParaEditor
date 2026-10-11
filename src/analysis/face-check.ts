import { err, ok, type Result } from '../core/result.ts';
import type { FaceDetection } from './protocol.ts';
import type { RgbaBytes, TensorMap } from './stage-math.ts';

export const FACE_SIZE = { width: 320, height: 240 };
export const FACE_ROWS = 4420;

/** UltraFace's RGB CHW input: (byte - 127) / 128, alpha ignored. */
export function faceInput(rgba: RgbaBytes): Float32Array {
  const pixels = FACE_SIZE.width * FACE_SIZE.height;
  if (rgba.length !== pixels * 4) throw new Error('Face input must be 320 x 240 RGBA.');
  const data = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) data[c * pixels + i] = ((rgba[4 * i + c] ?? 127) - 127) / 128;
  return data;
}

function faceOutputs(outputs: TensorMap): Result<{ scores: Float32Array; boxes: Float32Array }, string> {
  const scores = outputs['scores'], boxes = outputs['boxes'];
  if (scores?.dims.join(',') !== `1,${FACE_ROWS},2` || !(scores.data instanceof Float32Array) || scores.data.length !== FACE_ROWS * 2) {
    return err('UltraFace scores must be float32 [1, 4420, 2].');
  }
  if (boxes?.dims.join(',') !== `1,${FACE_ROWS},4` || !(boxes.data instanceof Float32Array) || boxes.data.length !== FACE_ROWS * 4) {
    return err('UltraFace boxes must be float32 [1, 4420, 4].');
  }
  if (!scores.data.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || !boxes.data.every(Number.isFinite)) return err('UltraFace returned invalid scores or boxes.');
  return ok({ scores: scores.data, boxes: boxes.data });
}

/** Warm-up on RGB 127 (zero tensor): stable shape, probabilities and raw box range. */
export function checkFaceKnownAnswer(outputs: TensorMap): Result<{ pass: boolean; scoreRange: readonly [number, number]; boxRange: readonly [number, number] }, string> {
  const parsed = faceOutputs(outputs);
  if (!parsed.ok) return parsed;
  const { scores, boxes } = parsed.value;
  let scoreMin = Infinity, scoreMax = -Infinity, boxMin = Infinity, boxMax = -Infinity;
  for (const value of scores) { scoreMin = Math.min(scoreMin, value); scoreMax = Math.max(scoreMax, value); }
  for (const value of boxes) { boxMin = Math.min(boxMin, value); boxMax = Math.max(boxMax, value); }
  const pass = scores.every((v, i) => i % 2 === 0 || v < 0.1)
    && scoreMin > .001 && scoreMin < .01 && scoreMax > .99
    && boxMin > -.5 && boxMin < 0 && boxMax > 1 && boxMax < 1.5;
  return ok({ pass, scoreRange: [scoreMin, scoreMax], boxRange: [boxMin, boxMax] });
}

type Box = { score: number; x0: number; y0: number; x1: number; y1: number; area: number };
const unit = (v: number): number => Math.max(0, Math.min(1, v));
function iou(a: Box, b: Box): number {
  const intersection = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return intersection / (a.area + b.area - intersection);
}

/** Confidence 0.7, hard NMS at IoU 0.3; the largest surviving face is the viewer. */
export function decodeFace(outputs: TensorMap): Result<FaceDetection | null, string> {
  const parsed = faceOutputs(outputs);
  if (!parsed.ok) return parsed;
  const { scores, boxes } = parsed.value;
  const candidates: Box[] = [];
  for (let i = 0; i < FACE_ROWS; i++) {
    const score = scores[i * 2 + 1] ?? 0;
    if (score < 0.7) continue;
    // Raw normalized predictions may extend beyond the image.
    const x0 = unit(boxes[i * 4] ?? 0), y0 = unit(boxes[i * 4 + 1] ?? 0);
    const x1 = unit(boxes[i * 4 + 2] ?? 0), y1 = unit(boxes[i * 4 + 3] ?? 0);
    if (x1 <= x0 || y1 <= y0) continue;
    candidates.push({ score, x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept: Box[] = [];
  for (const box of candidates) if (!kept.some((other) => iou(box, other) > 0.3)) kept.push(box);
  const detections = kept.sort((a, b) => b.area - a.area).slice(0, 8).map((viewer) => ({
    center: { x: (viewer.x0 + viewer.x1) / 2, y: (viewer.y0 + viewer.y1) / 2 },
    size: Math.max(viewer.x1 - viewer.x0, viewer.y1 - viewer.y0), confidence: viewer.score,
    box: { x0: viewer.x0, y0: viewer.y0, x1: viewer.x1, y1: viewer.y1 },
    clipped: viewer.x0 === 0 || viewer.y0 === 0 || viewer.x1 === 1 || viewer.y1 === 1,
  }));
  const viewer = detections[0];
  return ok(viewer === undefined ? null : { ...viewer, candidates: detections });
}
