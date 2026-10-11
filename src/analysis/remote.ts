// HTTP adapter for plan/gpu-contract.md. Browser media operations are injected
// so the transport, cancellation and deadlines run against real HTTP in node.
import { z } from '../core/zod.ts';
import type { SceneId } from '../core/ids.ts';
import type { Rgb8, Size } from '../core/raster.ts';
import { rank, nearestRank } from '../core/percentile.ts';
import type { AnalysisError, HeavyStage } from './protocol.ts';
import type { AnalysisService, SequenceListener } from './service.ts';

const SizeSchema = z.object({ width: z.int().min(1).max(2048), height: z.int().min(1).max(2048) });
const SessionSchema = z.object({ id: z.string().min(1).max(256), master: SizeSchema, expiresAt: z.union([z.string().datetime({ offset: true }), z.number().finite()]) });
export const HealthSchema = z.object({ ok: z.literal(true), gpu: z.string().min(1).max(256), models: z.object({ depth: z.string().min(1), segment: z.string().min(1), inpaint: z.string().min(1) }) });
export const REMOTE_TIMEOUTS = { health: 5_000, sessions: 20_000, depth: 10_000, taps: 5_000, inpaint: 30_000 };
export type RemoteTimeouts = typeof REMOTE_TIMEOUTS;
export type RemoteDeps = {
  readonly base: string;
  readonly fetch: typeof fetch;
  readonly encode: (bitmap: ImageBitmap) => Promise<Blob>;
  readonly decode: (png: Blob) => Promise<Rgb8>;
  readonly timeouts?: RemoteTimeouts;
  readonly now?: () => number;
  readonly failed: () => void;
};
export type RemoteAnalysisService = Pick<AnalysisService, 'runSequence' | 'cancelHeavy'> & {
  /** End the photo's plate lease, aborting requests and deleting its session. */
  readonly releaseSession: () => void;
  readonly alive: { readonly heavy: boolean };
  readonly timings: Readonly<Partial<Record<'session' | 'depth' | 'inpaint', number>>>;
};

export async function encodeMaster(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The analysis photo could not be encoded.');
  context.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

export async function decodePlate(png: Blob): Promise<Rgb8> {
  const bitmap = await createImageBitmap(png);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('The analysis plate could not be read.');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const data = new Uint8Array(bitmap.width * bitmap.height * 3);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) data.set(rgba.subarray(j, j + 3), i);
    return { size: { width: bitmap.width, height: bitmap.height }, data };
  } finally { bitmap.close(); }
}

function sameSize(a: Size, b: Size): boolean { return a.width === b.width && a.height === b.height; }
function dimensions(response: Response): Size {
  return SizeSchema.parse({ width: Number(response.headers.get('X-Width')), height: Number(response.headers.get('X-Height')) });
}
function media(response: Response, expected: string): void {
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim() !== expected) throw new Error(`The GPU returned an invalid ${expected} response.`);
}
function describe(error: unknown, op: 'depth' | 'encode' | 'decode' | 'inpaint', signal: AbortSignal): AnalysisError {
  if (signal.aborted) return { kind: 'cancelled' };
  return { kind: 'worker', op, message: `GPU analysis: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ') : 'the request failed'}` };
}

/** Includes reading the response body in the deadline, even after headers arrive. */
export async function remoteRequest<T>(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal, timeout: number, read: (response: Response) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(timeout);
  const combined = AbortSignal.any([signal, deadline]);
  // The race also bounds an injected fetch/media decoder that ignores abort.
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error(deadline.aborted && !signal.aborted ? `the request timed out after ${timeout} ms` : 'the request was cancelled'));
    if (combined.aborted) abort(); else combined.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetcher(url, { ...init, signal: combined, redirect: 'error', cache: 'no-store' });
      if (!response.ok) {
        const raw: unknown = await response.json().catch(() => null);
        const parsed = z.object({ error: z.string() }).safeParse(raw);
        throw new Error(`HTTP ${response.status}${parsed.success ? `: ${parsed.data.error}` : ''}`);
      }
      return read(response);
    })()]);
  } finally { combined.removeEventListener('abort', abort); }
}

type Import = { readonly scene: SceneId; readonly controller: AbortController; readonly id: string; readonly size: Size };
type Sequence = { readonly on: SequenceListener; readonly signal: AbortSignal; readonly controller: AbortController; readonly abort: () => void; stage: HeavyStage['kind'] };

export function createRemoteAnalysisService(deps: RemoteDeps): RemoteAnalysisService {
  const base = deps.base.replace(/\/$/, '');
  const timeouts = deps.timeouts ?? REMOTE_TIMEOUTS;
  let current: Import | null = null;
  let importController: AbortController | null = null;
  let sequence: Sequence | null = null;
  let timings: Partial<Record<'session' | 'depth' | 'inpaint', number>> = {};
  const now = deps.now ?? (() => performance.now());
  const request = async <T>(path: string, init: RequestInit, signal: AbortSignal, timeout: number, read: (r: Response) => Promise<T>): Promise<T> => {
    const started = now();
    const value = await remoteRequest(deps.fetch, `${base}/v1${path}`, init, signal, timeout, read);
    if (!signal.aborted) {
      if (path === '/sessions') timings.session = now() - started;
      else if (path.endsWith('/depth')) timings.depth = now() - started;
      else if (path.endsWith('/inpaint')) timings.inpaint = now() - started;
    }
    return value;
  };
  const discard = (): void => {
    importController?.abort(); importController = null;
    const old = current; current = null;
    if (old !== null) void request(`/sessions/${encodeURIComponent(old.id)}`, { method: 'DELETE' }, new AbortController().signal, timeouts.health, async () => undefined).catch(() => undefined);
  };
  const finish = (slot: Sequence, error: AnalysisError | null): void => {
    if (sequence !== slot) return;
    sequence = null; slot.signal.removeEventListener('abort', slot.abort);
    if (error === null) slot.on.onDone(); else slot.on.onFailed(slot.stage, error);
  };
  const retry = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) {
      if (signal.aborted) throw error;
      // The driver's inpaint watchdog can cancel the second 30 s attempt.
      // Invalidate health now, before that outer cancellation can win.
      deps.failed(); return run();
    }
  };
  const service: RemoteAnalysisService = {
    runSequence(scene, stages, input, on, signal) {
      if (sequence !== null) service.cancelHeavy();
      // A terminal callback is allowed to start its own sequence.
      if (sequence !== null || signal.aborted) { on.onFailed(stages[0].kind, { kind: 'cancelled' }); return; }
      if (current !== null && (current.scene !== scene || stages[0].kind === 'depth')) discard();
      importController ??= new AbortController();
      const controller = importController;
      if (stages[0].kind === 'depth') timings = {};
      const slot: Sequence = { on, signal, controller: new AbortController(), stage: stages[0].kind, abort: () => service.cancelHeavy() };
      const combined = AbortSignal.any([signal, controller.signal, slot.controller.signal]);
      sequence = slot; signal.addEventListener('abort', slot.abort, { once: true });
      const active = (): boolean => sequence === slot && !combined.aborted;
      void (async () => {
        on.onPhase(slot.stage, 'session', null);
        if (current === null) {
          const bitmap = await input.master();
          let photo: Blob;
          let size: Size;
          try { size = SizeSchema.parse({ width: bitmap.width, height: bitmap.height }); photo = await deps.encode(bitmap); }
          finally { bitmap.close(); }
          if (!active()) return;
          const session = await request('/sessions', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Width': String(size.width), 'X-Height': String(size.height) }, body: photo }, combined, timeouts.sessions, async (r) => {
            if (r.status !== 201) throw new Error('The GPU did not create a session.');
            media(r, 'application/json'); return SessionSchema.parse(await r.json());
          });
          // If cancellation races a successful creation, delete its session too.
          if (!active()) {
            void request(`/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }, new AbortController().signal, timeouts.health, async () => undefined).catch(() => undefined); return;
          }
          current = { scene, controller, id: session.id, size };
          if (!sameSize(session.master, size)) throw new Error('The GPU changed the master dimensions.');
        }
        const imported = current;
        const path = `/sessions/${encodeURIComponent(imported.id)}`;
        for (const stage of stages) {
          if (!active()) return;
          slot.stage = stage.kind;
          if (stage !== stages[0]) on.onPhase(stage.kind, 'session', null);
          on.onPhase(stage.kind, 'infer', null);
          switch (stage.kind) {
            case 'depth': {
              const data = await request(`${path}/depth`, {}, combined, timeouts.depth, async (r) => {
                media(r, 'application/octet-stream');
                if (!sameSize(dimensions(r), imported.size)) throw new Error('The GPU depth dimensions do not match the master.');
                const bytes = await r.arrayBuffer();
                if (bytes.byteLength !== imported.size.width * imported.size.height * 4) throw new Error('The GPU depth plane has the wrong length.');
                const values = new Float32Array(bytes.byteLength / 4), view = new DataView(bytes);
                for (let i = 0; i < values.length; i++) {
                  const value = view.getFloat32(i * 4, true);
                  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('The GPU depth plane is not normalized.');
                  values[i] = value;
                }
                return values;
              });
              const ranked = rank(data);
              if (!ranked.ok) throw new Error(ranked.error);
              const p10 = nearestRank(ranked.value, 0.1), median = nearestRank(ranked.value, 0.5), p90 = nearestRank(ranked.value, 0.9);
              if (!p10.ok || !median.ok || !p90.ok) throw new Error('The GPU depth statistics could not be read.');
              if (!active()) return;
              on.onDepth({ format: 'f32', size: imported.size, data }, { p10: p10.value, median: median.value, p90: p90.value });
              break;
            }
            case 'encode': throw new Error('The hybrid encoder runs on device.');
            case 'inpaint': {
              if (!sameSize(stage.hole.size, imported.size) || stage.hole.data.length !== imported.size.width * imported.size.height) throw new Error('The inpaint hole does not match the master.');
              const image = await retry(combined, () => request(`${path}/inpaint`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Width': String(imported.size.width), 'X-Height': String(imported.size.height) }, body: new Uint8Array(stage.hole.data) }, combined, timeouts.inpaint, async (r) => {
                media(r, 'image/png');
                const image = await deps.decode(await r.blob());
                if (!sameSize(image.size, imported.size) || image.data.length !== imported.size.width * imported.size.height * 3) throw new Error('The GPU plate does not match the master.');
                return image;
              }));
              if (!active()) return;
              on.onPlate(image); break;
            }
            default: { const exhaustive: never = stage; throw new Error(String(exhaustive)); }
          }
        }
        finish(slot, null);
      })().catch((error: unknown) => {
        if (!active()) return;
        deps.failed(); finish(slot, describe(error, slot.stage, combined));
      });
    },
    cancelHeavy() {
      const slot = sequence;
      slot?.controller.abort();
      if (slot !== null) finish(slot, { kind: 'cancelled' });
    },
    releaseSession() {
      // Delete before delivering cancellation: its callback may start a new photo.
      discard();
      service.cancelHeavy();
    },
    get alive() { return { heavy: sequence !== null }; },
    get timings() { return { ...timings }; },
  };
  return service;
}
