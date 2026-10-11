// Depth and plates may use the GPU; SAM embeddings and the resident decoder
// always use the device. Backend selection belongs to one imported photo.
import { ok } from '../core/result.ts';
import type { SceneId } from '../core/ids.ts';
import type { ModelOp } from './lock.ts';
import type { AnalysisService, SequenceListener } from './service.ts';
import { createRemoteAnalysisService, HealthSchema, remoteRequest, REMOTE_TIMEOUTS, type RemoteDeps, type RemoteAnalysisService } from './remote.ts';

export type AnalysisBackend = { readonly kind: 'device' } | { readonly kind: 'gpu'; readonly name: string };
export type AnalysisRouting = { readonly depth: 'device' | 'gpu'; readonly encoder: 'device'; readonly taps: 'device'; readonly plate: 'device' | 'gpu' };
export type ComposedAnalysisService = AnalysisService & {
  readonly backend: AnalysisBackend;
  readonly routing: AnalysisRouting;
  readonly remoteTimings: RemoteAnalysisService['timings'];
  /** Photo replacement, distinct from cancelling a plate or warmup. */
  readonly releaseImport: () => void;
};
export function createComposedAnalysisService(deps: Omit<RemoteDeps, 'base' | 'failed'> & {
  readonly local: AnalysisService;
  readonly gpu: Promise<string>;
  readonly changed: () => void;
  /** Display progress before a worker watchdog applies. */
  readonly waiting?: (stage: Parameters<SequenceListener['onPhase']>[0]) => void;
}): ComposedAnalysisService {
  let remote: RemoteAnalysisService | null = null;
  let healthy = false;
  let name = '';
  let backend: AnalysisBackend = { kind: 'device' };
  let scene: SceneId | null = null;
  let gpuPlate = false;
  let choosing: AbortController | null = null;
  let bootProbe: Promise<boolean> | null = null;
  const localReady = new Set<ModelOp>();
  let modelFetchFailed = false;
  let cleaning = false;
  const deferred: (() => void)[] = [];
  const terminal = (notify: () => void): void => { if (cleaning) deferred.push(notify); else notify(); };
  const cleanup = (release: boolean): void => {
    const pending = choosing; choosing = null;
    if (release) { scene = null; gpuPlate = false; backend = { kind: 'device' }; }
    // Both transports must stop before a callback can start another sequence.
    cleaning = true;
    if (release) remote?.releaseSession(); else remote?.cancelHeavy();
    deps.local.cancelHeavy(); pending?.abort();
    cleaning = false;
    const callbacks = deferred.splice(0);
    for (const notify of callbacks) notify();
  };
  const timeouts = deps.timeouts ?? REMOTE_TIMEOUTS;
  const probe = async (signal: AbortSignal): Promise<boolean> => {
    const base = await deps.gpu;
    if (base === '' || signal.aborted) return false;
    try {
      const health = await remoteRequest(deps.fetch, `${base.replace(/\/$/, '')}/v1/health`, {}, signal, timeouts.health, async (r) => HealthSchema.parse(await r.json()));
      if (signal.aborted) return false;
      name = health.gpu; healthy = true;
      remote ??= createRemoteAnalysisService({ ...deps, base, failed: () => { healthy = false; } });
      return true;
    } catch { if (!signal.aborted) healthy = false; return false; }
  };
  bootProbe = probe(new AbortController().signal);
  const fetchLocal = async (ops: readonly ModelOp[], signal: AbortSignal) => {
    const needed = ops.filter((op) => !localReady.has(op));
    const fetched = needed.length === 0 ? ok(undefined) : await deps.local.fetchModels(needed, signal, () => undefined);
    if (fetched.ok) for (const op of needed) localReady.add(op);
    return fetched;
  };
  const service: ComposedAnalysisService = {
    get backend() { return backend; },
    get routing(): AnalysisRouting { return { depth: backend.kind === 'gpu' ? 'gpu' : 'device', encoder: 'device', taps: 'device', plate: gpuPlate ? 'gpu' : 'device' }; },
    get remoteTimings() { return backend.kind === 'gpu' ? remote?.timings ?? {} : {}; },
    runSequence(id, stages, input, on, signal) {
      if (scene === id && stages[0].kind === 'inpaint') {
        (gpuPlate && remote !== null ? remote : deps.local).runSequence(id, stages, input, { ...on,
          onDone: () => terminal(on.onDone), onFailed: (stage, error) => terminal(() => on.onFailed(stage, error)),
        }, signal); return;
      }
      service.releaseImport();
      // Cancellation callbacks may synchronously start another import.
      if (choosing !== null || deps.local.alive.heavy || remote?.alive.heavy || signal.aborted) { on.onFailed(stages[0].kind, { kind: 'cancelled' }); return; }
      scene = id;
      const controller = new AbortController(); choosing = controller;
      const combined = AbortSignal.any([signal, controller.signal]);
      let ended = false;
      const active = (): boolean => !ended && !combined.aborted;
      const finish = (error: Parameters<SequenceListener['onFailed']>[1] | null, stage = stages[0].kind): void => {
        if (ended) return;
        ended = true; combined.removeEventListener('abort', abort);
        if (choosing === controller) choosing = null;
        terminal(() => { if (error === null) on.onDone(); else on.onFailed(stage, error); });
      };
      const abort = (): void => { if (!cleaning) service.cancelHeavy(); finish({ kind: 'cancelled' }); };
      combined.addEventListener('abort', abort, { once: true });
      const local = async (): Promise<void> => {
        const fetched = await fetchLocal(['depth', 'encode', 'decode', 'inpaint'], combined);
        if (!active()) return;
        if (!fetched.ok) { finish(fetched.error); return; }
        deps.local.runSequence(id, stages, input, { ...on, onDone: () => finish(null), onFailed: (stage, error) => finish(error, stage) }, combined);
      };
      // After GPU depth, run the actual local encoder on the same master.
      // The driver still owns warming, decoder retry and background ordering.
      const remaining = async (): Promise<void> => {
        for (const stage of stages.slice(1)) {
          if (!active()) return;
          if (stage.kind === 'encode') {
            const fetched = await fetchLocal(['encode', 'decode'], combined);
            if (!active()) return;
            if (!fetched.ok) { finish(fetched.error, 'encode'); return; }
          }
          await new Promise<void>((resolve) => {
            const selected = stage.kind === 'inpaint' && remote !== null ? remote : deps.local;
            selected.runSequence(id, [stage], input, { ...on,
              onDone: resolve, onFailed: (kind, error) => { finish(error, kind); resolve(); },
            }, combined);
          });
        }
        if (active()) finish(null);
      };
      void (async () => {
        await bootProbe; bootProbe = null;
        if (!active()) return;
        if (!healthy) await probe(combined);
        if (!active()) return;
        const selected = healthy ? remote : null;
        if (selected === null || stages[0].kind !== 'depth') { await local(); return; }
        deps.waiting?.('depth');
        // HTTP has its own deadlines; don't spend the local depth watchdog
        // on the remote attempt or on fallback model downloads.
        const phases: Parameters<SequenceListener['onPhase']>[] = [];
        let delivered = false;
        selected.runSequence(id, [{ kind: 'depth' }], input, {
          ...on,
          onPhase(...phase) { phases.push(phase); },
          onDepth(map, stats) {
            if (!active()) return;
            delivered = true; gpuPlate = true; backend = { kind: 'gpu', name }; deps.changed();
            for (const phase of phases) if (active()) on.onPhase(...phase);
            if (active()) on.onDepth(map, stats);
          },
          onDone() { if (active()) void remaining().catch((error: unknown) => finish({ kind: 'worker', op: 'encode', message: error instanceof Error ? error.message : 'Device encoder failed.' }, 'encode')); },
          onFailed(stage, error) {
            if (!active()) return;
            if (error.kind === 'cancelled' || delivered) { finish(error, stage); return; }
            selected.releaseSession(); healthy = false;
            void local().catch((error: unknown) => finish({ kind: 'worker', op: stage, message: error instanceof Error ? error.message : 'Device fallback failed.' }, stage));
          },
        }, combined);
      })().catch((error: unknown) => finish({ kind: 'worker', op: stages[0].kind, message: error instanceof Error ? error.message : 'Analysis selection failed.' }));
    },
    cancelHeavy() {
      cleanup(false);
    },
    releaseImport() {
      // Retire native work and the remote lease before terminal callbacks.
      cleanup(true);
    },
    openDecoder: (input) => deps.local.openDecoder(input),
    openFaceTracker: () => deps.local.openFaceTracker(),
    async fetchModels(ops, signal, progress) {
      await bootProbe;
      if (modelFetchFailed && !signal.aborted) { bootProbe = null; await probe(signal); }
      if (signal.aborted) return { ok: false, error: { kind: 'cancelled' } };
      const needed = healthy ? ops.filter((op) => op !== 'depth' && op !== 'inpaint') : ops;
      const fetched = needed.length === 0 ? ok(undefined) : await deps.local.fetchModels(needed, signal, progress);
      modelFetchFailed = !fetched.ok;
      if (fetched.ok) for (const op of needed) localReady.add(op);
      return fetched;
    },
    get alive() { return { heavy: choosing !== null || deps.local.alive.heavy || remote?.alive.heavy === true, decoder: deps.local.alive.decoder }; },
    get lastHeavyTermination() { return deps.local.lastHeavyTermination; },
  };
  return service;
}
