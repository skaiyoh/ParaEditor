// Select once per import. An established GPU session keeps its decoder and
// plate on that backend; only an unsuccessful initial sequence falls back.
import { ok } from '../core/result.ts';
import type { SceneId } from '../core/ids.ts';
import type { ModelOp } from './lock.ts';
import type { AnalysisService, SequenceListener } from './service.ts';
import { createRemoteAnalysisService, HealthSchema, remoteRequest, REMOTE_TIMEOUTS, type RemoteDeps } from './remote.ts';

export type AnalysisBackend = { readonly kind: 'device' } | { readonly kind: 'gpu'; readonly name: string };
export type ComposedAnalysisService = AnalysisService & { readonly backend: AnalysisBackend };
export function createComposedAnalysisService(deps: Omit<RemoteDeps, 'base' | 'failed'> & {
  readonly gpu: Promise<string>;
  readonly changed: () => void;
  /** Display progress while choosing a backend, before a worker watchdog applies. */
  readonly waiting?: (stage: Parameters<SequenceListener['onPhase']>[0]) => void;
}): ComposedAnalysisService {
  let remote: AnalysisService | null = null;
  let healthy = false;
  let name = '';
  let backend: AnalysisBackend = { kind: 'device' };
  let scene: SceneId | null = null;
  let plateOnSelectedBackend = false;
  let selected: AnalysisService = deps.local;
  let choosing: AbortController | null = null;
  let bootProbe: Promise<boolean> | null = null;
  const localReady = new Set<ModelOp>();
  let modelFetchFailed = false;
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
  const choose = (service: AnalysisService): void => {
    selected = service;
    backend = service === remote ? { kind: 'gpu', name } : { kind: 'device' };
    deps.changed();
  };
  const service: ComposedAnalysisService = {
    get backend() { return backend; },
    runSequence(id, stages, input, on, signal) {
      if (scene === id && stages[0].kind === 'inpaint') { plateOnSelectedBackend = true; selected.runSequence(id, stages, input, on, signal); return; }
      service.cancelHeavy();
      // A cancellation callback can synchronously start another import.
      if (choosing !== null || selected.alive.heavy || signal.aborted) { on.onFailed(stages[0].kind, { kind: 'cancelled' }); return; }
      scene = id;
      plateOnSelectedBackend = false;
      const controller = new AbortController(); choosing = controller;
      const combined = AbortSignal.any([signal, controller.signal]);
      let ended = false;
      const finish = (error: Parameters<SequenceListener['onFailed']>[1] | null, stage = stages[0].kind): void => {
        if (ended) return;
        ended = true; combined.removeEventListener('abort', abort);
        if (choosing === controller) choosing = null;
        if (error === null) on.onDone(); else on.onFailed(stage, error);
      };
      const abort = (): void => finish({ kind: 'cancelled' });
      combined.addEventListener('abort', abort, { once: true });
      void (async () => {
        const bootHealthy = await bootProbe; bootProbe = null;
        if (combined.aborted) return;
        if (!(healthy || bootHealthy)) await probe(combined);
        if (combined.aborted) return;
        choose(healthy && remote !== null ? remote : deps.local);
        const local = async (): Promise<void> => {
          const needed = (['depth', 'encode', 'decode', 'inpaint'] satisfies ModelOp[]).filter((op) => !localReady.has(op));
          const fetched = needed.length === 0 ? ok(undefined) : await deps.local.fetchModels(needed, combined, () => undefined);
          if (fetched.ok) for (const op of needed) localReady.add(op);
          if (combined.aborted) return;
          if (!fetched.ok) { finish(fetched.error); return; }
          deps.local.runSequence(id, stages, input, { ...on, onDone: () => finish(null), onFailed: (stage, error) => finish(error, stage) }, combined);
        };
        if (selected === deps.local) { await local(); return; }
        // No product is published until session creation and depth succeed.
        // These requests have their own deadlines. Hold their phase callbacks
        // until the first product, so a cold fallback's model downloads never
        // consume the driver's worker deadline. Preserve callback order.
        deps.waiting?.(stages[0].kind);
        let delivered = false;
        const phases: Parameters<SequenceListener['onPhase']>[] = [];
        const publish = (): void => {
          delivered = true;
          for (const phase of phases) on.onPhase(...phase);
          phases.length = 0;
        };
        selected.runSequence(id, stages, input, {
          ...on,
          onPhase(...phase) {
            if (delivered || stages[0].kind === 'inpaint') on.onPhase(...phase);
            else phases.push(phase);
          },
          onDepth(map, stats) { publish(); on.onDepth(map, stats); },
          onEmbeddings(value) { publish(); on.onEmbeddings(value); },
          onDone: () => finish(null),
          onFailed(stage, error) {
            if (ended) return;
            if (error.kind === 'cancelled' || delivered || stages.some((s) => s.kind === 'inpaint')) { finish(error, stage); return; }
            remote?.cancelHeavy(); healthy = false; choose(deps.local);
            void local().catch((error: unknown) => finish({ kind: 'worker', op: stage, message: error instanceof Error ? error.message : 'Device fallback failed.' }, stage));
          },
        }, combined);
      })().catch((error: unknown) => finish({ kind: 'worker', op: stages[0].kind, message: error instanceof Error ? error.message : 'Analysis selection failed.' }));
    },
    cancelHeavy() {
      const pending = choosing, previous = selected;
      choosing = null;
      // Keep the plate's backend while its decoder lives or is still queued.
      if (previous !== remote || (!previous.alive.decoder && !plateOnSelectedBackend)) scene = null;
      // Do all native cleanup before the pending choice's terminal callback,
      // which can synchronously start a new import.
      if (previous !== remote) remote?.cancelHeavy();
      previous.cancelHeavy(); pending?.abort();
    },
    openDecoder: (input) => selected.openDecoder(input),
    openFaceTracker: () => deps.local.openFaceTracker(),
    async fetchModels(ops, signal, progress) {
      await bootProbe;
      if (modelFetchFailed && !signal.aborted) { bootProbe = null; await probe(signal); }
      if (signal.aborted) return { ok: false, error: { kind: 'cancelled' } };
      const needed = healthy ? ops.filter((op) => op === 'face') : ops;
      const fetched = needed.length === 0 ? ok(undefined) : await deps.local.fetchModels(needed, signal, progress);
      modelFetchFailed = !fetched.ok;
      if (fetched.ok) for (const op of needed) localReady.add(op);
      return fetched;
    },
    get alive() { return { heavy: choosing !== null || selected.alive.heavy, decoder: selected.alive.decoder }; },
    get lastHeavyTermination() { return selected.lastHeavyTermination; },
  };
  return service;
}
