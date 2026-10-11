import { bundledLock } from '../../analysis/bundled-lock.ts';
import { openModelLoader, webLocks } from '../../analysis/models.ts';
import { createAnalysisService, type AnalysisEvent } from '../../analysis/service.ts';
import type { Vec2 } from '../../core/motion.ts';
import { createBrowserClock } from '../../platform/clock.ts';
import { createDiagnostics } from '../../platform/diagnostics.ts';
import { createWindowSource } from '../../session/window.ts';
import type { ViewObservation } from '../../session/view-driver.ts';

type Run = { valid: boolean; poll: (now: number) => void; cleanup: (() => void)[]; recenter: (() => void)[] };

/** Reuse the actual calibrated camera and verified face model, without photo analysis. */
export function createShowcaseCamera(changed: (message: string) => void) {
  const lock = bundledLock();
  if (!lock.ok) throw new Error(lock.error);
  const clock = createBrowserClock(window), diag = createDiagnostics<AnalysisEvent>(clock);
  const service = createAnalysisService({ clock, diag, lock: lock.value, threads: 'default', ortBase: NOISY_ORT_DIR,
    spawn: () => new Worker(NOISY_WORKER_URLS.sequence, { type: 'module', name: 'sequence' }),
    spawnDecoder: () => new Worker(NOISY_WORKER_URLS.decode, { type: 'module', name: 'decode' }),
    spawnFaceTracker: () => new Worker(NOISY_WORKER_URLS.face, { type: 'module', name: 'face' }),
    loader: openModelLoader({ lock: lock.value, origin: location.origin, caches, fetch: window.fetch.bind(window),
      subtle: crypto.subtle, locks: webLocks(navigator.locks), clock }),
  });
  const source = createWindowSource({ openTracker: () => service.openFaceTracker() });
  let current: Run | null = null, center: Vec2 = { x: .5, y: .5 }, observation: ViewObservation | null = null;
  let lastMessage = '';
  const say = (message: string): void => { if (message !== lastMessage) { lastMessage = message; changed(message); } };
  const stop = (message = 'Camera off. Move the pointer or drag to explore.'): void => {
    const old = current; current = null; observation = null; center = { x: .5, y: .5 };
    if (old !== null) { old.valid = false; old.cleanup.splice(0).toReversed().forEach(action => action()); }
    say(message);
  };
  const start = (): void => {
    if (current !== null) return;
    const run: Run = { valid: true, poll: () => undefined, cleanup: [], recenter: [] };
    current = run; observation = null;
    say('Camera starting. Look straight at the screen.');
    // Calling source synchronously retains the user's permission gesture.
    void source.source({
      valid: () => current === run && run.valid,
      dispose: action => { if (run.valid) run.cleanup.push(action); else action(); },
      onRecenter: action => run.recenter.push(action),
      target: (target, sample) => { if (current === run) { center = target; observation = sample ?? null; } },
      failed: reason => { if (current === run) stop(`${reason}. Try Start camera again, or drag to explore.`); },
    }).then(poll => { if (current === run) run.poll = poll; }).catch(error => {
      if (current === run) stop(`Camera could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const tick = (now: number): Vec2 | null => {
    if (current === null) return null;
    current.poll(now);
    if (observation === null) { say('Look straight at the screen to calibrate.'); return { x: .5, y: .5 }; }
    if (now - observation.capturedAt > 400 || observation.state === 'lost') {
      say('Face out of view. Look toward the camera to continue.'); return { x: .5, y: .5 };
    }
    if (observation.state === 'calibrating') { say('Hold still briefly to set your viewing position.'); return { x: .5, y: .5 }; }
    say('Camera tracking. Lean sideways or up and down to look past the foreground.');
    return center;
  };
  return {
    async prepare(signal: AbortSignal): Promise<void> {
      const result = await service.fetchModels(['face'], signal, () => undefined);
      if (!result.ok) throw new Error('The camera model could not load. Check your connection and reload the showcase.');
    },
    start, stop, tick,
    recenter(): void {
      if (current === null) return;
      observation = null; center = { x: .5, y: .5 }; current.recenter.forEach(action => action());
      say('Look straight ahead and hold still briefly to recenter.');
    },
    active: () => current !== null,
    snapshot: () => ({ active: current !== null, frames: source.trackedFrames(), state: observation?.state ?? 'off',
      sampleSequence: observation?.sequence ?? 0, center, liveTracks: source.tracks().filter(track => track.readyState === 'live').length }),
  };
}
