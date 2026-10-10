import type { FaceTracker } from '../analysis/service.ts';
import { plateNeeded } from '../core/derive.ts';
import type { Vec2 } from '../core/motion.ts';
import type { SceneDocument } from '../core/types.ts';
import { createViewDriver, type ViewHost } from './view-driver.ts';

const CAPTURE_MS = 1000 / 15;
const WORKER_TIMEOUT_MS = 15_000;

/** A supplied view camera can uncover layers even when the loop is disabled. */
export function windowPlateNeeded(doc: SceneDocument): boolean {
  return plateNeeded({ ...doc, motion: { ...doc.motion, enabled: true, orbit: 1 } });
}

/** Face tracking supplies mirrored selfie targets to the shared view clock. */
export function createWindowDriver(host: ViewHost & { openTracker(): FaceTracker }) {
  type FaceInput = { injected: boolean; trackedFrames: number; tracks: readonly MediaStreamTrack[]; target(center: Vec2): void };
  let input: FaceInput | null = null;
  const view = createViewDriver(host, async (attempt) => {
    const current: FaceInput = { injected: false, trackedFrames: 0, tracks: [], target: attempt.target };
    input = current;
    attempt.dispose(() => { if (input === current) input = null; });
    let failureStatus = 'Camera unavailable';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } });
      if (!attempt.valid()) { stream.getTracks().forEach((track) => track.stop()); return () => {}; }
      failureStatus = 'Face tracking unavailable'; current.tracks = stream.getTracks();
      attempt.dispose(() => stream.getTracks().forEach((track) => track.stop()));
      for (const track of current.tracks) {
        const ended = (): void => attempt.failed('Camera unavailable');
        track.addEventListener('ended', ended);
        attempt.dispose(() => track.removeEventListener('ended', ended));
      }
      const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
      attempt.dispose(() => { video.pause(); video.srcObject = null; });
      const tracker = host.openTracker(); attempt.dispose(() => tracker.release());
      const pending = new Set<() => void>();
      attempt.dispose(() => { for (const cancel of pending) cancel(); });
      const within = async <T>(job: Promise<T>): Promise<T> => {
        let timer = 0;
        let cancel = (): void => {};
        try {
          return await Promise.race([job, new Promise<never>((_, reject) => {
            cancel = () => reject(new Error('Face tracking stopped.')); pending.add(cancel);
            timer = window.setTimeout(() => reject(new Error('Face tracking timed out.')), WORKER_TIMEOUT_MS);
          })]);
        } finally { clearTimeout(timer); pending.delete(cancel); }
      };
      await within(Promise.all([video.play(), tracker.ready]));
      if (!attempt.valid()) return () => {};
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const context = canvas.getContext('2d'); if (context === null) throw new Error('Camera canvas unavailable.');
      let lastCapture = -Infinity, lastFaceAt = performance.now(), inFlight = false;
      const capture = async (): Promise<void> => {
        inFlight = true;
        try {
          context.drawImage(video, 0, 0, 320, 240);
          const bitmap = await createImageBitmap(canvas);
          if (!attempt.valid() || current.injected) { bitmap.close(); return; }
          const face = await within(tracker.track(bitmap));
          if (attempt.valid()) current.trackedFrames++;
          if (attempt.valid() && !current.injected) {
            const now = performance.now();
            if (face !== null) {
              // Front-camera pixels are unmirrored; physical right becomes selfie right.
              attempt.target({ x: 1 - face.center.x, y: face.center.y }); lastFaceAt = now;
            } else if (now - lastFaceAt >= 500) attempt.target({ x: .5, y: .5 });
          }
        } catch { attempt.failed('Face tracking unavailable'); }
        finally { inFlight = false; }
      };
      return (now) => {
        if (!current.injected && !inFlight && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && now - lastCapture >= CAPTURE_MS) {
          lastCapture = now; void capture();
        }
      };
    } catch { attempt.failed(failureStatus); return () => {}; }
  });
  return {
    ...view,
    trackedFrames: (): number => input?.trackedFrames ?? 0,
    tracks: (): readonly MediaStreamTrack[] => input?.tracks ?? [],
    injectFace(next: Vec2 | null): void {
      if (!NOISY_DEV) throw new Error('Face injection is available only in dev builds.');
      if (next !== null && ![next.x, next.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid injected face center.');
      if (input !== null) { input.injected = true; input.target(next ?? { x: .5, y: .5 }); }
    },
  };
}
