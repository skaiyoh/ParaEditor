import { parallaxClamp } from '../core/derive.ts';
import { frameCount, type Vec2 } from '../core/motion.ts';
import type { SceneDocument } from '../core/types.ts';
import { LOOP_FPS } from '../render/loop.ts';

const SMOOTH_MS = 120;
const CENTER: Vec2 = { x: .5, y: .5 };
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
type SourceName = 'camera' | 'tilt';
type SourceState =
  | { kind: 'pending' }
  | { kind: 'running'; poll(now: number): void }
  | { kind: 'unavailable'; status: string };

/** Center-relative inputs each clamp to [-.5,.5], then their sum clamps again. */
export function fuseTargets(face: Vec2, tilt: Vec2): Vec2 {
  const clamp = (n: number): number => Math.max(-.5, Math.min(.5, n));
  return { x: .5 + clamp(clamp(face.x - .5) + clamp(tilt.x - .5)),
    y: .5 + clamp(clamp(face.y - .5) + clamp(tilt.y - .5)) };
}

/** Sources own input and cleanup; one clock owns fusion, smoothing and drawing. */
export function createViewDriver(host: ViewHost, sources: Readonly<Record<SourceName, ViewSource>>) {
  type Input = { state: SourceState; target: Vec2; dispose: (() => void)[] };
  type Attempt = { generation: number; inputs: Record<SourceName, Input>; request: number };
  let attempt: Attempt | null = null;
  let center: Vec2 = CENTER, camera: Vec2 = { x: 0, y: 0 }, frame = 0;
  let status = 'Ready';
  const names: readonly SourceName[] = ['camera', 'tilt'];
  const dispose = (input: Input): void => {
    for (const action of input.dispose.splice(0).toReversed()) action();
    input.target = CENTER;
  };
  function stop(): void {
    const previous = attempt; attempt = null;
    if (previous !== null) { cancelAnimationFrame(previous.request); names.forEach((name) => dispose(previous.inputs[name])); }
    center = CENTER; camera = { x: 0, y: 0 }; frame = 0; status = 'Ready';
  }
  async function start(): Promise<void> {
    if (attempt !== null || host.read() === null) return;
    const input = (): Input => ({ state: { kind: 'pending' }, target: CENTER, dispose: [] });
    const current: Attempt = { generation: host.generation(), inputs: { camera: input(), tilt: input() }, request: 0 };
    attempt = current;
    const valid = (): boolean => attempt === current && host.generation() === current.generation;
    const changed = (): void => {
      if (!valid()) return;
      const running = names.filter((name) => current.inputs[name].state.kind === 'running');
      status = running.length > 0 ? `Parallax: ${running.join(' and ')}` : 'Parallax: starting';
      if (names.every((name) => current.inputs[name].state.kind === 'unavailable')) {
        const details = names.map((name) => {
          const state = current.inputs[name].state;
          return state.kind === 'unavailable' ? state.status : '';
        }).join('; ');
        stop(); host.failed(details); return;
      }
      host.changed();
    };
    status = 'Parallax: starting'; host.changed();
    if (!valid()) return;
    let last = performance.now(), motionOrigin: number | null = null;
    const tick = (now: number): void => {
      if (!valid()) return;
      const doc = host.read(); if (doc === null) { stop(); host.changed(); return; }
      const target = fuseTargets(current.inputs.camera.target, current.inputs.tilt.target);
      const alpha = 1 - Math.exp(-Math.max(0, now - last) / SMOOTH_MS); last = now;
      center = { x: center.x + (target.x - center.x) * alpha, y: center.y + (target.y - center.y) * alpha };
      const gain = 2 * parallaxClamp(doc);
      camera = { x: -(center.x - .5) * gain, y: -(center.y - .5) * gain };
      if (doc.motion.enabled) {
        motionOrigin ??= now;
        frame = Math.floor((now - motionOrigin) * LOOP_FPS / 1000) % frameCount(doc.motion, LOOP_FPS);
      } else { motionOrigin = null; frame = 0; }
      try {
        host.draw(camera, frame);
        for (const name of names) {
          const state = current.inputs[name].state;
          if (state.kind === 'running') state.poll(now);
        }
      } catch (error) { stop(); host.failed(error instanceof Error ? error.message : String(error)); return; }
      if (valid()) current.request = requestAnimationFrame(tick);
    };
    current.request = requestAnimationFrame(tick);
    // Both sources are invoked before yielding, preserving iOS's click gesture.
    await Promise.all(names.map(async (name) => {
      const input = current.inputs[name];
      const sourceValid = (): boolean => valid() && input.state.kind !== 'unavailable';
      const failed = (message: string): void => {
        if (!sourceValid()) return;
        input.state = { kind: 'unavailable', status: message }; dispose(input); changed();
      };
      const context: ViewAttempt = {
        valid: sourceValid, failed,
        dispose(action) { if (sourceValid()) input.dispose.push(action); else action(); },
        target(next) { if (sourceValid()) input.target = next; },
      };
      try {
        const poll = await sources[name](context);
        if (sourceValid()) { input.state = { kind: 'running', poll }; changed(); }
      } catch (error) { failed(error instanceof Error ? error.message : String(error)); }
    }));
  }
  return {
    start, stop,
    enabled: (): boolean => attempt !== null,
    ready: (name: SourceName): boolean => attempt?.inputs[name].state.kind === 'running',
    status: (): string => status,
    targets: () => ({ faceTarget: attempt?.inputs.camera.target ?? CENTER, tilt: attempt?.inputs.tilt.target ?? CENTER }),
    camera: (): Vec2 => camera,
    frame: (): number => host.read()?.motion.enabled === true ? frame : 0,
  };
}
