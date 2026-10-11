import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const WorkerMemory = z.object({ id: z.string(), worker: z.enum(['sequence', 'decode', 'face']),
  sessions: z.int().min(0), peakSessions: z.int().min(0), sessionsCreated: z.int().min(0), encoderSessionsCreated: z.int().min(0), wasmHighWaterBytes: z.int().min(0).nullable() });
type WorkerMemory = z.infer<typeof WorkerMemory>;
declare global {
  interface Window {
    __importMemory?: { workers: Map<string, WorkerMemory>; channel: BroadcastChannel;
      canvases: WeakRef<OffscreenCanvas>[]; messages: number };
  }
}

export function observe(): true {
  const channel = new BroadcastChannel('noisy-analysis-memory');
  const workers = new Map<string, WorkerMemory>();
  const canvases: WeakRef<OffscreenCanvas>[] = [];
  channel.onmessage = (event: MessageEvent<WorkerMemory>) => {
    if (window.__importMemory !== undefined) window.__importMemory.messages++;
    workers.set(event.data.id, event.data);
  };
  const NativeCanvas = OffscreenCanvas;
  window.OffscreenCanvas = class extends NativeCanvas {
    constructor(width: number, height: number) { super(width, height); canvases.push(new WeakRef(this)); }
  };
  window.__importMemory = { workers, channel, canvases, messages: 0 };
  return true;
}

export async function importPhoto(index: number): Promise<string> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('Missing demo surface.');
  // Distinct, repeatable high-resolution photo fixtures, with a stable master
  // size so retained growth cannot be confused with a larger current image.
  const canvas = new OffscreenCanvas(4032, 3024), context = canvas.getContext('2d');
  if (context === null) throw new Error('Missing fixture context.');
  const source = await createImageBitmap(await (await fetch('/assets-static/sample.jpg')).blob());
  try {
    context.drawImage(source, -index * 80, -index * 30, 4032 + index * 160, 3024 + index * 60);
    context.fillStyle = `hsla(${index * 67}, 80%, 50%, .18)`; context.fillRect(0, 0, canvas.width, canvas.height);
    const file = new File([await canvas.convertToBlob({ type: 'image/jpeg', quality: .9 })], `memory-${index}.jpg`, { type: 'image/jpeg' });
    await demo.importFile(file);
  } finally { source.close(); canvas.width = 1; canvas.height = 1; }
  return demo.document()?.frame.source?.asset ?? '';
}

const Snapshot = z.object({
  heap: z.number().nullable(), collectedHeap: z.number().nullable(), collected: z.boolean(),
  workers: z.array(WorkerMemory),
  gpu: z.object({ textures: z.number(), buffers: z.number(), framebuffers: z.number(), renderbuffers: z.number(), programs: z.number() }),
  perspective: z.object({ textures: z.number(), targets: z.number() }),
  products: z.object({ depth: z.number(), masks: z.number(), plates: z.number() }),
  history: z.object({ undoDepth: z.number(), redoDepth: z.number() }),
  projects: z.object({ retainedJobs: z.number(), pendingSaves: z.number(), states: z.number(), rows: z.number() }),
  canvases: z.object({ alive: z.number(), pixels: z.number() }),
  routing: z.object({ depth: z.string(), encoder: z.string(), taps: z.string(), plate: z.string() }),
});
export async function snapshot(): Promise<unknown> {
  const demo = window.__noisyTest?.demo, probe = window.__importMemory;
  if (demo === undefined || probe === undefined) throw new Error('Missing memory probe.');
  probe.channel.postMessage('sample');
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const heap = (): number | null => {
    if (!('memory' in performance)) return null;
    const memory = performance.memory;
    return typeof memory === 'object' && memory !== null && 'usedJSHeapSize' in memory && typeof memory.usedJSHeapSize === 'number'
      ? memory.usedJSHeapSize : null;
  };
  const before = heap();
  const collected = 'gc' in window && typeof window.gc === 'function';
  if ('gc' in window && typeof window.gc === 'function') window.gc();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  let alive = 0, pixels = 0;
  for (const ref of probe.canvases) { const canvas = ref.deref(); if (canvas !== undefined) { alive++; pixels += canvas.width * canvas.height; } }
  probe.canvases = probe.canvases.filter((ref) => ref.deref() !== undefined);
  const projects = demo.projects();
  return { heap: before, collectedHeap: heap(), collected, workers: [...probe.workers.values()], gpu: demo.render?.resources?.(),
    perspective: demo.render?.perspectiveResources?.(), products: demo.products(), history: demo.historyState(),
    projects: { retainedJobs: projects.retainedJobs, pendingSaves: projects.pendingSaves, states: projects.states.size, rows: document.querySelectorAll('[data-testid=project-row]').length },
    canvases: { alive, pixels }, routing: demo.analysisDiagnostics().routing };
}

function bounded(rows: readonly z.infer<typeof Snapshot>[]): boolean {
  const warm = rows[1]; if (warm === undefined || warm.collectedHeap === null) return false;
  const warmHeap = warm.collectedHeap;
  const allowance = 64 * 1024 * 1024;
  return rows.slice(1).every((row) => row.collectedHeap !== null && row.collectedHeap <= warmHeap + allowance
    && row.workers.every((worker) => {
      const first = rows[0]?.workers.find((entry) => entry.worker === worker.worker);
      return first?.wasmHighWaterBytes !== null && first?.wasmHighWaterBytes !== undefined
        && worker.wasmHighWaterBytes !== null && worker.wasmHighWaterBytes <= first.wasmHighWaterBytes + allowance;
    }));
}

function boundedSessions(workers: readonly WorkerMemory[]): boolean {
  return workers.length === 2 && workers.filter((worker) => worker.worker === 'sequence').length === 1
    && workers.filter((worker) => worker.worker === 'decode').length === 1
    && workers.every((worker) => worker.peakSessions === 1 && worker.sessions === (worker.worker === 'decode' ? 1 : 0));
}

export const scenarios: readonly Scenario[] = [{
  id: 'demo.import-memory', title: 'five different imports bound worker, renderer and session memory on both analysis routes',
  target: 'dev', covers: [], timeoutMs: 900_000,
  async run(t) {
    t.expectMessage({ because: 'the device run deliberately faults GPU health', channel: 'log', source: 'network', level: 'error', url: /\/dev\/gpu\/v1\/health$/ });
    await t.page.intercept([{ method: 'GET', path: '/build.json', action: { kind: 'respond', status: 200, body: JSON.stringify({ gpu: '/dev/gpu' }) } }]);
    for (const route of ['device', 'gpu']) {
      await t.server.setFaults(route === 'device' ? ['path:/dev/gpu/v1/health:http503:method=GET'] : []);
      await t.page.goto('/');
      await t.page.waitFor('models ready', z.literal(true), () => window.__noisyTest?.demo.analysis().modelsReady ? true : null, { timeoutMs: 120_000 });
      await t.page.evaluate(z.literal(true), observe);
      const rows: z.infer<typeof Snapshot>[] = [], assets = new Set<string>();
      for (let index = 0; index < 5; index++) {
        assets.add(await t.page.evaluate(z.string(), importPhoto, index + (route === 'gpu' ? 5 : 0)));
        await t.page.waitFor(`${route} import ${index + 1}: ready and saved`, z.literal(true), () => {
          const demo = window.__noisyTest?.demo;
          return demo?.analysis().decoderReady && !demo.analysis().alive.heavy && demo.projects().state === 'saved' ? true : null;
        }, { timeoutMs: 180_000 });
        const row = await t.page.evaluate(Snapshot, snapshot); rows.push(row);
        await t.file(`${route}-imports.json`, JSON.stringify(rows, null, 2));
        await t.file(`${route}-workers-${index + 1}.json`, JSON.stringify(t.page.workers(), null, 2));
        t.equal(`${route} ${index + 1}: chosen depth route`, row.routing.depth, route);
        t.equal(`${route} ${index + 1}: one current save job`, [row.projects.retainedJobs, row.projects.pendingSaves], [1, 0]);
        t.equal(`${route} ${index + 1}: current products and empty history`, [row.products, row.history], [{ depth: 1, masks: 0, plates: 0 }, { undoDepth: 0, redoDepth: 0 }]);
        t.equal(`${route} ${index + 1}: only the decoder is active`, await t.page.evaluate(z.object({ heavy: z.boolean(), decoder: z.boolean() }), () => window.__noisyTest?.demo.analysis().alive), { heavy: false, decoder: true });
        t.ok(`${route} ${index + 1}: actual ORT sessions bounded`, boundedSessions(row.workers), row.workers);
        const sequence = row.workers.find((worker) => worker.worker === 'sequence');
        t.equal(`${route} ${index + 1}: one sequence worker for the page`, row.workers.filter((worker) => worker.worker === 'sequence').map((worker) => worker.id), [rows[0]?.workers.find((worker) => worker.worker === 'sequence')?.id]);
        t.equal(`${route} ${index + 1}: one encoder session per new photo`, sequence?.encoderSessionsCreated, index + 1);
        t.equal(`${route} ${index + 1}: one decoder worker for the page`, row.workers.filter((worker) => worker.worker === 'decode').map((worker) => worker.id), [rows[0]?.workers.find((worker) => worker.worker === 'decode')?.id]);
        t.ok(`${route} ${index + 1}: JS heap measured`, row.heap !== null, row);
        if (index === 4) await t.page.screenshot(`${route}-fifth-import`);
      }
      t.equal(`${route}: five distinct source assets`, assets.size, 5);
      t.ok(`${route}: GPU allocations do not grow`, rows.every((row) => JSON.stringify(row.gpu) === JSON.stringify(rows[0]?.gpu)), rows.map((row) => row.gpu));
      t.ok(`${route}: JS and wasm stay within the warm allocation band`, bounded(rows), rows);
      const ids = await t.page.evaluate(z.array(z.string()), () => [...(window.__noisyTest?.demo.projects().states.keys() ?? [])]);
      const switches: z.infer<typeof Snapshot>[] = [];
      for (let index = 0; index < 5; index++) {
        const id = ids[index]; if (id === undefined) throw new Error('Missing saved project.');
        await t.page.evaluate(z.literal(true), async (project: string) => {
          if (!await window.__noisyTest?.demo.openProject(project)) throw new Error('Project did not open.');
          return true;
        }, id);
        await t.page.waitFor(`${route} switch ${index + 1}: ready and saved`, z.literal(true), () => {
          const demo = window.__noisyTest?.demo;
          return demo?.analysis().decoderReady && !demo.analysis().alive.heavy && demo.projects().state === 'saved' ? true : null;
        }, { timeoutMs: 180_000 });
        const row = await t.page.evaluate(Snapshot, snapshot); switches.push(row);
        await t.file(`${route}-switches.json`, JSON.stringify(switches, null, 2));
        await t.file(`${route}-switch-workers-${index + 1}.json`, JSON.stringify(t.page.workers(), null, 2));
        t.equal(`${route} switch ${index + 1}: current save payload only`, [row.projects.retainedJobs, row.projects.pendingSaves], [1, 0]);
        t.equal(`${route} switch ${index + 1}: current products and empty history`, [row.products, row.history], [{ depth: 1, masks: 0, plates: 0 }, { undoDepth: 0, redoDepth: 0 }]);
        t.ok(`${route} switch ${index + 1}: actual ORT sessions bounded`, boundedSessions(row.workers), row.workers);
        t.equal(`${route} switch ${index + 1}: same sequence worker`, row.workers.filter((worker) => worker.worker === 'sequence').map((worker) => worker.id), [rows[0]?.workers.find((worker) => worker.worker === 'sequence')?.id]);
        t.equal(`${route} switch ${index + 1}: cached photo opens without encoder`, row.workers.find((worker) => worker.worker === 'sequence')?.encoderSessionsCreated, 5);
      }
      t.ok(`${route}: switches do not grow GPU allocations`, switches.every((row) => JSON.stringify(row.gpu) === JSON.stringify(rows[0]?.gpu)), switches.map((row) => row.gpu));
      t.ok(`${route}: switches keep JS and wasm within the warm allocation band`, bounded(switches), switches);
      if (route === 'gpu') {
        await t.page.click('[data-testid="parallax-enabled"]');
        await t.page.waitFor('face worker tracking with the current decoder', z.literal(true), () =>
          (window.__noisyTest?.demo.windowFrames() ?? 0) > 0 ? true : null, { timeoutMs: 30_000 });
        const face = await t.page.evaluate(Snapshot, snapshot);
        await t.file('gpu-face.json', JSON.stringify(face, null, 2));
        t.equal('one live face session', face.workers.filter((worker) => worker.worker === 'face').map((worker) => [worker.sessions, worker.peakSessions]), [[1, 1]]);
        const messages = await t.page.evaluate(z.number(), async () => {
          const probe = window.__importMemory; if (probe === undefined) throw new Error('Missing probe.');
          const before = probe.messages;
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
          return probe.messages - before;
        });
        t.ok('two resident workers do not echo telemetry', messages < 100, { messages });
        await t.page.screenshot('gpu-face-tracking');
        await t.page.click('[data-testid="parallax-enabled"]');
        await t.page.click('[data-testid="parallax-enabled"]');
        await t.page.waitFor('reused face worker tracks after restart', z.literal(true), () =>
          (window.__noisyTest?.demo.windowFrames() ?? 0) > 0 ? true : null, { timeoutMs: 30_000 });
        const restarted = await t.page.evaluate(Snapshot, snapshot);
        t.equal('face worker is reused after camera restart', restarted.workers.filter((worker) => worker.worker === 'face').map((worker) => [worker.id, worker.sessionsCreated]), face.workers.filter((worker) => worker.worker === 'face').map((worker) => [worker.id, worker.sessionsCreated]));
        await t.page.click('[data-testid="parallax-enabled"]');
      }
    }
  },
}];
