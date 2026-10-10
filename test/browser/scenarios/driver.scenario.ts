// The driver's own operations on the shell page. Its input operations, on
// controls the scenario adds: typing and a named key, a click, and a file
// input's files; the app has no text or file input yet, so this keeps those
// operations proven until the app's own controls exercise them. And crash and
// reopen: a renderer killed with storage written, a Web Lock held, a worker
// running, and emulation set, then a page opened again in the same browser
// context. And lifecycle: a page frozen is hidden and runs no task, and a
// page made active again is visible, with the emulated viewport kept.

import { z } from '../../../src/core/zod.ts';
import { CRASHED_PAGE } from '../driver/browser.ts';
import type { BrowserPage, Scenario } from '../scenario.ts';

function addControls(): boolean {
  const text = document.createElement('input');
  text.type = 'text';
  text.dataset['testid'] = 'driver-text';
  const file = document.createElement('input');
  file.type = 'file';
  file.dataset['testid'] = 'driver-file';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'driver button';
  button.dataset['testid'] = 'driver-button';
  button.dataset['clicks'] = '0';
  button.addEventListener('click', (event) => {
    button.dataset['clicks'] = String(Number(button.dataset['clicks']) + 1);
    button.dataset['trusted'] = String(event.isTrusted);
  });
  document.body.append(text, file, button);
  return true;
}

function readControls(): Promise<unknown> {
  const text = document.querySelector<HTMLInputElement>('[data-testid=driver-text]');
  const button = document.querySelector<HTMLButtonElement>('[data-testid=driver-button]');
  const file = document.querySelector<HTMLInputElement>('[data-testid=driver-file]')?.files?.[0];
  const read = file === undefined ? Promise.resolve(null) : file.text().then((contents) => ({ name: file.name, size: file.size, contents }));
  return read.then((picked) => ({
    text: text?.value ?? null,
    clicks: button?.dataset['clicks'] ?? null,
    trusted: button?.dataset['trusted'] ?? null,
    file: picked,
  }));
}

const Controls = z.object({
  text: z.string().nullable(),
  clicks: z.string().nullable(),
  trusted: z.string().nullable(),
  file: z.object({ name: z.string(), size: z.number(), contents: z.string() }).nullable(),
});

const CRASH_KEY = 'noisy.driver.crash';
const PAGEHIDE_KEY = 'noisy.driver.pagehide';
const CRASH_LOCK = 'noisy-driver-crash';
const CRASH_WORKER = 'driver-crash';
const BUSY_END_KEY = 'noisy.driver.busy-end';
const BUSY_MS = 4000;

/** Writes a storage key, records any pagehide in storage, and takes a Web Lock it never releases; resolves with the held locks' names once it is granted. */
function writeAndLock(key: string, pagehideKey: string, lock: string): Promise<unknown> {
  localStorage.setItem(key, 'kept');
  addEventListener('pagehide', () => localStorage.setItem(pagehideKey, 'fired'));
  return new Promise((granted) => {
    void navigator.locks.request(lock, () => {
      granted(true);
      return new Promise(() => undefined);
    });
  })
    .then(() => navigator.locks.query())
    .then((snapshot) => (snapshot.held ?? []).map((held) => held.name ?? null));
}

/** Starts, in a task of its own, a block that keeps the main thread busy for `ms` and marks storage if it ever ends. */
function startBusyBlock(endKey: string, ms: number): boolean {
  setTimeout(() => {
    const end = Date.now() + ms;
    while (Date.now() < end);
    localStorage.setItem(endKey, 'ran');
  }, 0);
  return true;
}

function startWorker(url: string, name: string): boolean {
  Reflect.set(window, 'driverWorker', new Worker(url, { type: 'module', name }));
  return true;
}

/** What the reopened page finds: the storage keys, whether the lock is held and can be taken at once, and its viewport and color scheme. */
function readAfterReopen(key: string, pagehideKey: string, lock: string, busyEndKey: string): Promise<unknown> {
  return navigator.locks.query().then((snapshot) =>
    navigator.locks
      .request(lock, { ifAvailable: true }, (taken) => taken !== null)
      .then((takenAtOnce) => ({
        key: localStorage.getItem(key),
        pagehide: localStorage.getItem(pagehideKey),
        busyEnd: localStorage.getItem(busyEndKey),
        heldBefore: (snapshot.held ?? []).some((held) => held.name === lock),
        takenAtOnce,
        viewport: [innerWidth, innerHeight, devicePixelRatio],
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      })),
  );
}

const AfterReopen = z.object({
  key: z.string().nullable(),
  pagehide: z.string().nullable(),
  busyEnd: z.string().nullable(),
  heldBefore: z.boolean(),
  takenAtOnce: z.boolean(),
  viewport: z.tuple([z.number(), z.number(), z.number()]),
  dark: z.boolean(),
});

/** Records every visibilitychange and counts a timer's ticks, so a freeze shows as ticks that stop. */
function watchLifecycle(): true {
  const seen: string[] = [];
  let ticks = 0;
  document.addEventListener('visibilitychange', () => seen.push(document.visibilityState));
  setInterval(() => (ticks += 1), 50);
  Object.assign(window, { lifecycleRead: () => ({ visibility: document.visibilityState, seen: [...seen], ticks, width: innerWidth }) });
  return true;
}

function readLifecycle(): unknown {
  const read: unknown = Reflect.get(window, 'lifecycleRead');
  return typeof read === 'function' ? read() : null;
}

const Lifecycle = z.object({ visibility: z.string(), seen: z.array(z.string()), ticks: z.number(), width: z.number() });

const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether a worker titled `title` is attached under the page within 10 seconds. */
async function attached(page: BrowserPage, title: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (!page.workers().some((w) => w.title === title)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

const harnessScenarios: readonly Scenario[] = [
  {
    id: 'driver.lifecycle',
    title: 'lifecycle frozen hides the page and stops its tasks, and active resumes it visible again with the emulated viewport kept',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.emulate({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true, colorScheme: 'light' });
      await t.page.goto('/');
      await t.page.evaluate(z.literal(true), watchLifecycle);
      await t.page.lifecycle('frozen');
      // A frozen page runs none of its own tasks, so its timer stops; the ticks are read once it is active again (an evaluation is still answered while it is frozen).
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await t.page.lifecycle('active');
      const after = await t.page.waitFor('the page to be visible again', Lifecycle, () => {
        const read: unknown = Reflect.get(window, 'lifecycleRead');
        const value: unknown = typeof read === 'function' ? read() : null;
        return typeof value === 'object' && value !== null && 'visibility' in value && value.visibility === 'visible' ? value : null;
      });
      t.equal('the page went hidden when frozen and visible when made active', after.seen, ['hidden', 'visible']);
      t.equal('the emulated viewport is kept', after.width, 393);
      t.ok('its timer stopped while frozen: under 1 s of 50 ms ticks', after.ticks < 15, { ticks: after.ticks });
      const later = await t.page.evaluate(Lifecycle, readLifecycle);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const resumed = await t.page.evaluate(Lifecycle, readLifecycle);
      t.ok('its timer runs again once active', resumed.ticks > later.ticks, { later: later.ticks, resumed: resumed.ticks });
    },
  },
  {
    id: 'driver.input',
    title: 'the driver types with key events, clicks with mouse events, and sets a file input\'s files',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto('/');
      await t.page.evaluate(z.literal(true), addControls);
      await t.page.type('[data-testid=driver-text]', 'noisy 1234');
      await t.page.press('Backspace');
      await t.page.click('[data-testid=driver-button]');
      const contents = 'a file the driver picked\n';
      const upload = await t.file('upload.txt', contents);
      await t.page.setFiles('[data-testid=driver-file]', [upload]);
      const read = await t.page.evaluate(Controls, readControls);
      t.equal('typing and Backspace leave the text', read.text, 'noisy 123');
      t.equal('one click arrived', read.clicks, '1');
      t.equal('the click is a trusted input event', read.trusted, 'true');
      t.equal('the file input holds the file', read.file, { name: 'upload.txt', size: contents.length, contents });
    },
  },
  {
    id: 'driver.crash-reopen',
    title: 'crash kills the renderer mid-task with no pagehide, evaluate, waitFor, goto, and intercept then reject until reopen, and reopen opens the page again in the same storage, with the dead page\'s lock released, the emulation repeated, workers attached, and the records continued',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto('/');
      // The scheme the host does not already report, so the check after reopen can tell the emulation from the default.
      const hostDark = await t.page.evaluate(z.boolean(), () => matchMedia('(prefers-color-scheme: dark)').matches);
      const colorScheme = hostDark ? 'light' : 'dark';
      await t.page.emulate({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true, colorScheme });
      const held = await t.page.evaluate(z.array(z.string().nullable()), writeAndLock, CRASH_KEY, PAGEHIDE_KEY, CRASH_LOCK);
      t.ok('the page holds the lock before the crash', held.includes(CRASH_LOCK), { held });
      const gif = t.build.workers['gif'] ?? '';
      await t.page.evaluate(z.literal(true), startWorker, gif, CRASH_WORKER);
      t.ok('the worker is attached before the crash', await attached(t.page, CRASH_WORKER), { workers: t.page.workers() });
      const requestsBefore = t.page.requests().length;

      await t.page.evaluate(z.literal(true), startBusyBlock, BUSY_END_KEY, BUSY_MS);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const crashStarted = Date.now();
      await t.page.crash();
      const crashMs = Date.now() - crashStarted;
      t.ok('crash lands mid-task: it does not wait for the page\'s busy block to end', crashMs < BUSY_MS / 2, { crashMs, busyMs: BUSY_MS });
      const crashEntries = t.page.console().filter((e) => e.source === 'crash');
      t.equal('the crash left one console entry, the one crash declares', crashEntries.map((e) => [e.channel, e.text]), [['exception', 'the renderer crashed, as the scenario asked']]);
      const evaluated = await t.page.evaluate(z.unknown(), () => 1).then(() => null, failure);
      const waitStarted = Date.now();
      const waited = await t.page.waitFor('anything', z.unknown(), () => true, { timeoutMs: 5000 }).then(() => null, failure);
      const waitMs = Date.now() - waitStarted;
      const navigated = await t.page.goto('/').then(() => null, failure);
      // Were this rule kept, reopen would install it and the reopened page's fetch of / would answer 503.
      const intercepted = await t.page.intercept([{ method: 'GET', path: '/', action: { kind: 'respond', status: 503, body: 'refused' } }]).then(() => null, failure);
      t.ok(
        'evaluate, waitFor, goto, and intercept each reject naming the crash, waitFor at once',
        [evaluated, waited, navigated, intercepted].every((m) => m !== null && m.includes(CRASHED_PAGE)) && waitMs < 1000,
        { evaluated, waited, navigated, intercepted, waitMs },
      );

      await t.page.reopen('/');
      t.equal('no worker of the dead page is listed after reopen', t.page.workers().filter((w) => w.title === CRASH_WORKER), []);
      const after = await t.page.evaluate(AfterReopen, readAfterReopen, CRASH_KEY, PAGEHIDE_KEY, CRASH_LOCK, BUSY_END_KEY);
      t.equal('the reopened page reads the key the dead page wrote, so it shares its storage', after.key, 'kept');
      t.equal('the dead page got no pagehide, and its busy block never ended', [after.pagehide, after.busyEnd], [null, null]);
      t.equal('the dead page\'s lock is not held, and the reopened page takes it at once', [after.heldBefore, after.takenAtOnce], [false, true]);
      t.equal('the emulation set before the crash, the scheme the host does not report, holds on the reopened page', [after.viewport, after.dark], [[393, 852, 3], colorScheme === 'dark']);
      t.equal('the rejected intercept installed no rule: the reopened page fetches / as served', await t.page.evaluate(z.number(), () => fetch('/').then((r) => r.status)), 200);
      await t.page.evaluate(z.literal(true), startWorker, gif, CRASH_WORKER);
      t.ok('a worker the reopened page starts is attached', await attached(t.page, CRASH_WORKER), { workers: t.page.workers() });
      const requests = t.page.requests();
      const documents = requests.filter((r) => r.resourceType === 'Document' && new URL(r.url).pathname === '/');
      t.ok('the request list goes on across the two pages: both pages\' loads of / are in it', requests.length > requestsBefore && documents.length === 2, { requestsBefore, requests: requests.length, documents });
    },
  },
];

const Analysis = z.object({
  status: z.string(), modelsReady: z.boolean(), depth: z.boolean(), embeddings: z.boolean(), decoderReady: z.boolean(), plate: z.boolean(),
  alive: z.object({ heavy: z.boolean(), decoder: z.boolean() }), timings: z.record(z.string(), z.number()),
});
const Products = z.object({
  generation: z.number(), depth: z.number(), masks: z.number(), plates: z.number(),
  plateSize: z.object({ width: z.number(), height: z.number() }).nullable(),
  guideSize: z.object({ width: z.number(), height: z.number() }).nullable(), plateNeeded: z.boolean(),
});
const DriverView = z.object({
  analysis: Analysis, products: Products, depthDocument: z.boolean(), sceneId: z.string().nullable(),
  masterAsset: z.string().nullable(), masterSize: z.object({ width: z.number(), height: z.number() }).nullable(),
  elapsedMs: z.number(), statuses: z.array(z.string()), statusLine: z.string(),
});

function readDriver(): unknown {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) return null;
  const doc = demo.document();
  return {
    analysis: demo.analysis(), products: demo.products(), depthDocument: doc?.analysis.depth !== null && doc?.analysis.depth !== undefined,
    sceneId: doc?.id ?? null, masterAsset: doc?.frame.master.asset ?? null, masterSize: doc?.frame.master.size ?? null,
    elapsedMs: performance.now() - Number(document.body.dataset['analysisImportStart'] ?? performance.now()),
    statuses: JSON.parse(document.body.dataset['analysisStatuses'] ?? '[]'), statusLine: document.querySelector('[data-testid=status]')?.textContent ?? '',
  };
}

const PlateView = z.object({
  status: z.string().nullable(), statusLine: z.string().nullable(), analysis: Analysis.nullable(), products: Products.nullable(),
  plateNeeded: z.boolean().nullable(), request: z.string().nullable(), elapsedMs: z.number(),
  masterSize: z.object({ width: z.number(), height: z.number() }).nullable(),
});

function readPlate(): unknown {
  const demo = window.__noisyTest?.demo;
  const analysis = demo?.analysis() ?? null;
  const products = demo?.products() ?? null;
  return {
    status: analysis?.status ?? null, statusLine: document.querySelector('[data-testid=status]')?.textContent ?? null,
    analysis, products, plateNeeded: products?.plateNeeded ?? null, request: document.body.dataset['plateRequest'] ?? null,
    elapsedMs: performance.now() - Number(document.body.dataset['analysisImportStart'] ?? performance.now()),
    masterSize: demo?.document()?.frame.master.size ?? null,
  };
}

function traceDriver(): true | null {
  const line = document.querySelector('[data-testid=status]');
  if (line === null || window.__noisyTest?.demo === undefined) return null;
  const statuses: string[] = [];
  const record = (): void => {
    const text = line.textContent ?? '';
    if (statuses.at(-1) !== text) statuses.push(text);
    document.body.dataset['analysisStatuses'] = JSON.stringify(statuses);
  };
  record();
  new MutationObserver(record).observe(line, { childList: true, characterData: true, subtree: true });
  return true;
}

/** Self-contained JPEG fixture and import: only the production import path is used. */
async function driverImport(width: number, height: number, variant: number): Promise<boolean> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('The analysis hooks are missing.');
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('No fixture context.');
  context.fillStyle = variant === 0 ? '#27678a' : variant === 1 ? '#d75439' : '#598638';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#f6cf83'; context.fillRect(width / 4, height / 4, width / 2, height / 2);
  context.fillStyle = '#301d35'; context.beginPath(); context.arc(width / 2, height / 2, height / 5, 0, Math.PI * 2); context.fill();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  document.body.dataset['analysisImportStart'] = String(performance.now());
  await demo.importFile(new File([blob], `driver-${variant}.jpg`, { type: 'image/jpeg' }));
  return true;
}

async function replaceDriverTwice(): Promise<unknown> {
  const demo = window.__noisyTest?.demo;
  if (demo === undefined) throw new Error('The analysis hooks are missing.');
  const make = async (width: number, height: number, fill: string, name: string): Promise<File> => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No replacement fixture context.');
    context.fillStyle = fill; context.fillRect(0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
    return new File([blob], name, { type: 'image/jpeg' });
  };
  const second = await make(3024, 4032, '#b3315d', 'second.jpg');
  const third = await make(2048, 2048, '#307e40', 'third.jpg');
  const before = demo.products().generation;
  await demo.importFile(second);
  const during = demo.analysis();
  // The replacement has started its real sequence. Replace it immediately.
  document.body.dataset['analysisImportStart'] = String(performance.now());
  await demo.importFile(third);
  return { before, after: demo.products().generation, during };
}

const analysisScenarios: readonly Scenario[] = [
  {
    id: 'driver.import', title: 'real depth, encoder and warmed decoder survive immediate import replacement with one generation of products',
    target: 'dev', covers: [], timeoutMs: 300_000,
    async run(t) {
      await t.page.goto('/');
      await t.page.waitFor('analysis hooks and status trace', z.literal(true), traceDriver);
      const boot = await t.page.waitFor('all four model operations fetched and verified', Analysis, () => {
        const a = window.__noisyTest?.demo.analysis(); return a?.modelsReady ? a : null;
      }, { timeoutMs: 120_000 });
      t.equal('models ready before analysis', boot.modelsReady, true);
      await t.page.evaluate(z.literal(true), driverImport, 4032, 3024, 0);
      await t.page.waitFor('depth in the scene document', z.literal(true), () => {
        const d = window.__noisyTest?.demo; return d?.analysis().depth && d.document()?.analysis.depth !== null ? true : null;
      }, { timeoutMs: 60_000 });
      const depth = await t.page.evaluate(DriverView, readDriver);
      t.ok('depth lands within 60 seconds of import and has a document reference', depth.elapsedMs <= 60_000 && depth.depthDocument, depth);
      await t.page.waitFor('resident warmed decoder and terminated heavy worker', z.literal(true), () => {
        const a = window.__noisyTest?.demo.analysis(); return a?.decoderReady && a.alive.decoder && !a.alive.heavy ? true : null;
      }, { timeoutMs: Math.max(1, 150_000 - depth.elapsedMs) });
      const ready = await t.page.evaluate(DriverView, readDriver);
      t.ok('decoder ready within 150 seconds', ready.elapsedMs <= 150_000, ready);
      t.ok('warm-up timing is recorded', Number.isFinite(ready.analysis.timings['warmup']) && (ready.analysis.timings['warmup'] ?? -1) >= 0, ready.analysis.timings);
      t.equal('one depth product and one decoder, no heavy worker', [ready.products.depth, ready.products.masks, ready.products.plates, ready.analysis.alive], [1, 0, 0, { heavy: false, decoder: true }]);
      for (const text of ['Fetching models', 'Analyzing: depth', 'Analyzing: encoder', 'Ready to tap']) t.ok(`status passed through ${text}`, ready.statuses.some((status) => status.startsWith(text)), { statuses: ready.statuses });
      t.ok('dev status displays last timing', /warmup: \d+ ms/.test(ready.statusLine), ready);
      t.ok('real depth, encoder and decoder stages recorded timings', ['depth', 'encode', 'warmup'].every((stage) => (ready.analysis.timings[stage] ?? -1) >= 0), ready.analysis.timings);
      const modelRequests = t.page.requests().filter((request) => new URL(request.url).pathname.startsWith('/models/'));
      // A verified warm Cache Storage need not issue any model HTTP requests.
      await t.file('driver-initial-timeline.json', JSON.stringify({ depth, ready, modelRequests }, null, 2));
      await t.page.screenshot('driver-ready');
      const replacements = await t.page.evaluate(z.object({ before: z.number(), after: z.number(), during: Analysis }), replaceDriverTwice);
      t.equal('two replacement generations', replacements.after, replacements.before + 2);
      t.equal('second import started heavy work and released the old decoder', replacements.during.alive, { heavy: true, decoder: false });
      t.ok('replacement never claims the old decoder is ready', !replacements.during.decoderReady && replacements.during.status !== 'Ready to tap', replacements.during);
      await t.page.waitFor('only the third import warmed and complete', z.literal(true), () => {
        const d = window.__noisyTest?.demo; const a = d?.analysis();
        return a?.decoderReady && !a.alive.heavy && a.alive.decoder && d?.document()?.frame.master.size.width === 2048 && d.document()?.frame.master.size.height === 2048 ? true : null;
      }, { timeoutMs: 150_000 });
      const final = await t.page.evaluate(DriverView, readDriver);
      t.equal('third import owns the only product set', [final.products.generation, final.products.depth, final.products.masks, final.products.plates], [replacements.after, 1, 0, 0]);
      t.ok('the third document and asset replaced the first', final.sceneId !== ready.sceneId && final.masterAsset !== ready.masterAsset && final.depthDocument, final);
      t.equal('exactly one resident decoder, no heavy worker', final.analysis.alive, { heavy: false, decoder: true });
      t.ok('no browser console errors', t.page.console().every((entry) => !['error', 'exception'].includes(entry.channel)), t.page.console());
      // The browser driver also enforces same-origin requests and zero page/server CSP violations.
      await t.file('driver-replacement-timeline.json', JSON.stringify({ replacements, final }, null, 2));
      await t.page.screenshot('driver-replaced');
    },
  },
  {
    id: 'driver.plate', title: 'a guide-size injected disc produces a fresh master-size MI-GAN plate while Motion is enabled',
    target: 'dev', covers: [], timeoutMs: 200_000,
    async run(t) {
      const checkpoints: { step: string; snapshot: z.infer<typeof PlateView> }[] = [];
      let preparingObservation: 'preparing' | 'completed-between-polls' | null = null;
      let failure: string | null = null;
      const record = async (step: string): Promise<z.infer<typeof PlateView>> => {
        const snapshot = await t.page.evaluate(PlateView, readPlate);
        checkpoints.push({ step, snapshot });
        await t.file('driver-plate-timeline.json', JSON.stringify({ preparingObservation, failure, checkpoints }, null, 2));
        return snapshot;
      };
      try {
        await t.page.goto('/');
        await record('before-models-ready');
        await t.page.waitFor('models ready', Analysis, () => { const a = window.__noisyTest?.demo.analysis(); return a?.modelsReady ? a : null; }, { timeoutMs: 120_000 });
        await t.page.evaluate(z.literal(true), driverImport, 4032, 3024, 0);
        await record('before-initial-analysis-complete');
        await t.page.waitFor('initial analysis complete', z.literal(true), () => { const a = window.__noisyTest?.demo.analysis(); return a?.decoderReady && !a.alive.heavy ? true : null; }, { timeoutMs: 150_000 });
        await t.page.evaluate(z.literal(true), () => {
          const demo = window.__noisyTest?.demo;
          const size = demo?.products().guideSize;
          if (demo === undefined || size === null || size === undefined) throw new Error('The decoder guide is missing.');
          const data = new Uint8Array(size.width * size.height);
          for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) if ((x + 0.5 - size.width / 2) ** 2 + (y + 0.5 - size.height / 2) ** 2 <= 200 ** 2) data[y * size.width + x] = 255;
          demo.injectMask({ ...size, data }); demo.setMotion({ enabled: true });
          document.body.dataset['analysisImportStart'] = String(performance.now());
          document.body.dataset['plateRequest'] = 'pending';
          void demo.requestPlate().then(() => { document.body.dataset['plateRequest'] = 'done'; }, (error: unknown) => { document.body.dataset['plateRequest'] = error instanceof Error ? error.message : String(error); });
          return true;
        });
        await record('before-preparing-or-complete');
        preparingObservation = await t.page.waitFor('plate reports preparing or is already fresh', z.enum(['preparing', 'completed-between-polls']), () => {
          const demo = window.__noisyTest?.demo;
          const request = document.body.dataset['plateRequest'];
          if (request !== undefined && request !== 'pending' && request !== 'done') throw new Error(`Plate request failed: ${request}`);
          const analysis = demo?.analysis();
          if (analysis?.status === 'preparing' && document.querySelector('[data-testid=status]')?.textContent?.startsWith('preparing')) return 'preparing';
          if (analysis?.plate && demo?.products().plateNeeded === false) return 'completed-between-polls';
          return null;
        }, { timeoutMs: 5000 });
        const observed = await record('observed-preparing-or-complete');
        t.ok('preparing was seen or a fresh plate completed between polls', preparingObservation === 'preparing' || (observed.analysis?.plate === true && observed.plateNeeded === false), { preparingObservation, observed });
        t.equal('one injected mask is present', observed.products?.masks, 1);
        await record('before-plate-and-request-complete');
        await t.page.waitFor('plate and request complete', z.literal(true), () => {
          const request = document.body.dataset['plateRequest'];
          if (request !== undefined && request !== 'pending' && request !== 'done') throw new Error(`Plate request failed: ${request}`);
          return window.__noisyTest?.demo.analysis().plate && request === 'done' ? true : null;
        }, { timeoutMs: 90_000 });
        const plate = await record('plate-complete');
        t.ok('plate lands within 90 seconds', plate.elapsedMs <= 90_000, plate);
        t.equal('plate is at the master size', plate.products?.plateSize, plate.masterSize);
        t.equal('plate is fresh and the inpaint worker has terminated', [plate.plateNeeded, plate.analysis?.alive], [false, { heavy: false, decoder: true }]);
        t.ok('inpaint timing recorded', (plate.analysis?.timings['inpaint'] ?? -1) >= 0, plate.analysis?.timings);
        await t.page.screenshot('driver-plate');
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        // Earlier checkpoints survive even if a dead page prevents this final read.
        await record('failed').catch(() => undefined);
        throw error;
      }
    },
  },
  {
    id: 'driver.failure', title: 'a corrupt model served through the dev fault grammar reports the fetch failure without starting workers',
    target: 'dev', covers: [], timeoutMs: 120_000,
    async run(t) {
      // This example page constructs a service but does not fetch until Run.
      await t.page.goto('/dev/service.html');
      const configured = await t.page.evaluate(z.boolean(), async () => {
        for (const name of await caches.keys()) if (name.startsWith('noisy-models-')) await caches.delete(name);
        const response = await fetch('/dev/fault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: ['path:/models/:corrupt'] }) });
        return response.ok;
      });
      t.equal('corrupt model fault installed', configured, true);
      try {
        await t.page.goto('/');
        const failed = await t.page.waitFor('model verification failure sentence', Analysis, () => {
          const a = window.__noisyTest?.demo.analysis(); return a?.status.startsWith('Models unavailable:') ? a : null;
        }, { timeoutMs: 90_000 });
        t.equal('failed models never start workers', [failed.modelsReady, failed.alive], [false, { heavy: false, decoder: false }]);
        t.ok('status line reports the actual failure', await t.page.evaluate(z.boolean(), () => document.querySelector('[data-testid=status]')?.textContent?.startsWith('Models unavailable:') ?? false), failed);
        await t.file('driver-model-failure.json', JSON.stringify(failed, null, 2));
        await t.page.screenshot('driver-model-failure');
      } finally {
        await t.page.evaluate(z.boolean(), async () => (await fetch('/dev/fault', { method: 'DELETE' })).ok);
      }
    },
  },
];

export const scenarios: readonly Scenario[] = [...harnessScenarios, ...analysisScenarios];
