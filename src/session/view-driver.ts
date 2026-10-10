import { parallaxClamp } from '../core/derive.ts';
import { frameCount, type Vec2 } from '../core/motion.ts';
import type { SceneDocument } from '../core/types.ts';
import { LOOP_FPS } from '../render/loop.ts';

const SMOOTH_MS = 120;
export type ViewHost = {
  read(): SceneDocument | null;
  generation(): number;
  draw(camera: Vec2, frame: number): void;
  changed(): void;
  failed(status: string): void;
};
export type ViewAttempt = {
  valid(): boolean;
  dispose(action: () => void): void;
  target(center: Vec2): void;
  failed(status: string): void;
};
export type ViewSource = (attempt: ViewAttempt) => Promise<(now: number) => void>;

/** A target source owns its input; this driver owns smoothing, drawing and cancellation. */
export function createViewDriver(host: ViewHost, source: ViewSource) {
  type Attempt = { generation: number; dispose: (() => void)[] };
  let attempt: Attempt | null = null;
  let ready = false;
  let target: Vec2 = { x: .5, y: .5 }, center = target;
  let camera: Vec2 = { x: 0, y: 0 }, frame = 0;

  function stop(): void {
    const previous = attempt; attempt = null; ready = false;
    for (const dispose of previous?.dispose.toReversed() ?? []) dispose();
    target = { x: .5, y: .5 }; center = target; camera = { x: 0, y: 0 }; frame = 0;
  }
  async function start(): Promise<void> {
    if (attempt !== null || host.read() === null) return;
    const current: Attempt = { generation: host.generation(), dispose: [] }; attempt = current;
    const valid = (): boolean => attempt === current && host.generation() === current.generation;
    const failed = (status: string): void => { if (valid()) { stop(); host.failed(status); } };
    const context: ViewAttempt = {
      valid, failed,
      dispose(action) { if (valid()) current.dispose.push(action); else action(); },
      target(next) { if (valid()) target = next; },
    };
    host.changed();
    if (!valid()) return;
    try {
      // Call the source before yielding: iOS permission must remain in the click gesture.
      const poll = await source(context);
      if (!valid()) return;
      ready = true;
      let request = 0, last = performance.now();
      let motionOrigin: number | null = null;
      context.dispose(() => cancelAnimationFrame(request));
      const tick = (now: number): void => {
        if (!valid()) return;
        const doc = host.read(); if (doc === null) { stop(); host.changed(); return; }
        const alpha = 1 - Math.exp(-Math.max(0, now - last) / SMOOTH_MS); last = now;
        center = { x: center.x + (target.x - center.x) * alpha, y: center.y + (target.y - center.y) * alpha };
        const gain = 2 * parallaxClamp(doc);
        camera = { x: -(center.x - .5) * gain, y: -(center.y - .5) * gain };
        if (doc.motion.enabled) {
          motionOrigin ??= now;
          frame = Math.floor((now - motionOrigin) * LOOP_FPS / 1000) % frameCount(doc.motion, LOOP_FPS);
        } else { motionOrigin = null; frame = 0; }
        try { host.draw(camera, frame); poll(now); }
        catch (error) { failed(error instanceof Error ? error.message : String(error)); return; }
        if (valid()) request = requestAnimationFrame(tick);
      };
      request = requestAnimationFrame(tick); host.changed();
    } catch (error) { failed(error instanceof Error ? error.message : String(error)); }
  }
  return {
    start, stop,
    enabled: (): boolean => attempt !== null,
    ready: (): boolean => ready,
    camera: (): Vec2 => camera,
    frame: (): number => host.read()?.motion.enabled === true ? frame : 0,
  };
}
