import type { FaceTracker } from '../analysis/service.ts';
import { createFaceView, faceCaptureTransform, faceFromCapture } from '../core/face-view.ts';
import type { Vec2 } from '../core/motion.ts';
import type { ViewAttempt, ViewSource } from './view-driver.ts';
import { parseFaceReply, type FaceDetection } from '../analysis/protocol.ts';

const CAPTURE_MS = 1000 / 15;
const WORKER_TIMEOUT_MS = 15_000;

/** Keep the actionable sentence separate from the browser/worker's exact error. */
class CameraFailure extends Error {
  readonly reason: string;
  constructor(reason: string, cause: unknown) {
    super(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), { cause });
    this.reason = reason;
  }
}

function cameraFailure(error: unknown): CameraFailure {
  const name = error instanceof Error ? error.name : '';
  const reason = name === 'NotAllowedError' || name === 'SecurityError' ? 'Camera permission was denied'
    : name === 'NotFoundError' ? 'No camera was found'
    : name === 'NotReadableError' || name === 'AbortError' ? 'Camera could not start or is in use'
    : name === 'OverconstrainedError' ? 'Camera does not support the requested video settings'
    : 'Camera could not start';
  return new CameraFailure(reason, error);
}

/** Face tracking supplies mirrored selfie targets to the shared view clock. */
export function createWindowSource(host: { openTracker(): FaceTracker }) {
  type FaceInput = { injected: boolean; trackedFrames: number; tracks: readonly MediaStreamTrack[]; target: ViewAttempt['target']; receive(face: FaceDetection | null, width: number, height: number, capturedAt: number): void; sequence: number; frame: HTMLCanvasElement | null; face: FaceDetection | null };
  let input: FaceInput | null = null;
  const source: ViewSource = async (attempt) => {
    const calibration = createFaceView();
    let calibrationGeneration = 0, dimensions = '';
    const current: FaceInput = { injected: false, trackedFrames: 0, tracks: [], target: attempt.target, sequence: 0, frame: null, face: null,
      receive(face, width, height, capturedAt) {
        const nextDimensions = `${width}x${height}`;
        if (dimensions !== nextDimensions) { calibration.recenter(); dimensions = nextDimensions; }
        const transform = faceCaptureTransform(width, height);
        const candidates = (face?.candidates ?? (face === null ? [] : [face])).flatMap((raw) => {
          const mapped = faceFromCapture(raw, transform); return mapped === null ? [] : [{ raw, mapped }];
        });
        const mapped = calibration.select(candidates.map((candidate) => candidate.mapped));
        current.face = candidates.find((candidate) => candidate.mapped === mapped)?.raw ?? null;
        const sample = calibration.observe(mapped, capturedAt, ++current.sequence);
        if (sample !== null) attempt.target(sample.center, sample);
      },
    };
    input = current;
    attempt.onRecenter?.(() => {
      calibrationGeneration++; calibration.recenter();
      attempt.target({ x: .5, y: .5 }, { capturedAt: performance.now(), sequence: ++current.sequence, state: 'calibrating' });
    });
    attempt.dispose(() => { if (input === current) input = null; });
    try {
      if (navigator.mediaDevices?.getUserMedia === undefined) throw new CameraFailure('Camera access is unavailable in this browser', 'getUserMedia is unavailable');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } });
      if (!attempt.valid()) { stream.getTracks().forEach((track) => track.stop()); return () => {}; }
      current.tracks = stream.getTracks();
      attempt.dispose(() => stream.getTracks().forEach((track) => track.stop()));
      for (const track of current.tracks) {
        const ended = (): void => attempt.failed('Camera stopped sending video');
        track.addEventListener('ended', ended);
        attempt.dispose(() => track.removeEventListener('ended', ended));
      }
      const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
      attempt.dispose(() => { video.pause(); video.srcObject = null; });
      let tracker: FaceTracker;
      try { tracker = host.openTracker(); }
      catch (error) { throw new CameraFailure('Face tracking could not start', error); }
      attempt.dispose(() => tracker.release());
      const pending = new Set<() => void>();
      attempt.dispose(() => { for (const cancel of pending) cancel(); });
      const within = async <T>(job: Promise<T>, reason: string, timeout: string): Promise<T> => {
        let timer = 0;
        let cancel = (): void => {};
        try {
          return await Promise.race([job, new Promise<never>((_, reject) => {
            cancel = () => reject(new Error('Face tracking stopped.')); pending.add(cancel);
            timer = window.setTimeout(() => reject(new CameraFailure(timeout, new Error(`Timed out after ${WORKER_TIMEOUT_MS} ms`))), WORKER_TIMEOUT_MS);
          })]);
        } catch (error) {
          throw error instanceof CameraFailure ? error : new CameraFailure(reason, error);
        } finally { clearTimeout(timer); pending.delete(cancel); }
      };
      await Promise.all([
        within(video.play(), 'Camera video could not play', 'Camera video did not start within 15 seconds'),
        within(tracker.ready, 'Face tracking could not start', 'Face tracking did not start within 15 seconds'),
      ]);
      if (!attempt.valid()) return () => {};
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const context = canvas.getContext('2d', { willReadFrequently: true }); if (context === null) throw new CameraFailure('Camera frame could not be read', 'Camera canvas unavailable');
      let lastCapture = -Infinity, inFlight = false;
      const capture = async (): Promise<void> => {
        inFlight = true;
        const capturedAt = performance.now(), captureGeneration = calibrationGeneration;
        const width = video.videoWidth, height = video.videoHeight;
        try {
          const transform = faceCaptureTransform(width, height);
          context.fillStyle = 'rgb(127,127,127)'; context.fillRect(0, 0, 320, 240);
          context.drawImage(video, transform.x, transform.y, transform.drawWidth, transform.drawHeight);
          const bitmap = await createImageBitmap(canvas);
          if (!attempt.valid() || current.injected) { bitmap.close(); return; }
          const face = await within(tracker.track(bitmap), 'Face tracking failed', 'Face tracking stopped responding for 15 seconds');
          if (attempt.valid()) current.trackedFrames++;
          if (attempt.valid() && !current.injected && captureGeneration === calibrationGeneration) {
            current.frame ??= document.createElement('canvas');
            current.frame.width = canvas.width; current.frame.height = canvas.height;
            current.frame.getContext('2d', { willReadFrequently: true })?.drawImage(canvas, 0, 0); current.face = face;
            current.receive(face, width, height, capturedAt);
          }
        } catch (error) {
          if (attempt.valid()) {
            const failure = error instanceof CameraFailure ? error : new CameraFailure('Camera frame could not be read', error);
            attempt.failed(failure.reason, failure.message);
          }
        }
        finally { inFlight = false; }
      };
      return (now) => {
        if (!current.injected && !inFlight && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0 && now - lastCapture >= CAPTURE_MS) {
          lastCapture = now; void capture();
        }
      };
    } catch (error) {
      if (attempt.valid()) {
        const failure = error instanceof CameraFailure ? error : cameraFailure(error);
        attempt.failed(failure.reason, failure.message);
      }
      return () => {};
    }
  };
  return {
    source,
    preview: () => ({ frame: input?.frame ?? null, face: input?.face ?? null }),
    trackedFrames: (): number => input?.trackedFrames ?? 0,
    tracks: (): readonly MediaStreamTrack[] => input?.tracks ?? [],
    injectCameraFrame(frame: ImageData, face: FaceDetection | null): void {
      if (!NOISY_DEV) throw new Error('Camera frame injection is available only in dev builds.');
      if (!parseFaceReply({ type: 'tracked', jobId: 1, face }).ok) throw new Error('Invalid injected face.');
      if (input === null) return;
      const canvas = document.createElement('canvas'); canvas.width = frame.width; canvas.height = frame.height;
      const context = canvas.getContext('2d'); if (context === null) throw new Error('Camera canvas unavailable.');
      context.putImageData(frame, 0, 0);
      input.injected = true; input.frame = canvas; input.face = face;
      input.receive(face, frame.width, frame.height, performance.now());
    },
    injectFace(next: Vec2 | null): void {
      if (!NOISY_DEV) throw new Error('Face injection is available only in dev builds.');
      if (next !== null && ![next.x, next.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid injected face center.');
      if (input !== null) {
        // Compatibility fixture: this is an already calibrated control target.
        input.injected = true;
        input.target(next ?? { x: .5, y: .5 }, { capturedAt: performance.now(), sequence: ++input.sequence, state: next === null ? 'lost' : 'tracking', quality: next === null ? 0 : 1 });
      }
    },
  };
}
