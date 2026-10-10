// The store page (/dev/store.html, dev builds only). Write saves a test record
// in the `device` store through the store's connection over the page's real
// IndexedDB, with a reload as its onVersionChange, as the composition root
// will; the status says which write saved or failed, the page counts each
// `store.reconnect`, and every write is posted to the results sink. The page
// keeps its records in a database of its own, with the app's schema, and
// never opens the app's, which shares this origin when a phone sitting's dev
// server and the owner's own server are served at one address.
//
// `?levers=1` shows the levers the browser scenarios pull. The connection's
// opener is wrapped so that "Inject" makes the next transaction() calls throw
// InvalidStateError, as a lost connection's do; "Close handle" closes the
// connection's handle behind its back, so the next transaction() throws a
// real InvalidStateError; "Upgrade to version 2" opens the database at
// version 2 from a second connection, which sends a versionchange to an open
// handle and leaves the database newer than this build; "Add duplicate" adds
// one key twice in one transaction, awaiting each add, an operation's own
// ConstraintError; "Read many" stores a run of records, then reads them back
// one request at a time in one transaction, long enough for a scenario to
// make the browser close the handle while the read runs. The scene lock's
// levers hold a test scene's lock, release it by resolving or rejecting, ask
// for it from this page or from a same-origin frame standing in for a second
// tab, and run it with a function that throws.
//
// `?frame=1` is the frame: it asks for the lock when its parent says so and
// answers with what it got.

import { isSceneId, type SceneId } from '../core/ids.ts';
import { ok, type Result } from '../core/result.ts';
import { createBrowserClock } from '../platform/clock.ts';
import { createDiagnostics } from '../platform/diagnostics.ts';
import { createStoreConnection, describeError, type StoreError, type StoreEvent, type StoreOpener, type StoreOperation } from '../store/connection.ts';
import { idbOpener, requestDone, STORE_NAMES, transactionDone } from '../store/idb.ts';
import { createSceneLock, sceneLockName } from '../store/lock.ts';

/** A row the sink has not accepted by then is reported as not posted. */
const POST_TIMEOUT_MS = 10_000;
/** The page's own database, opened at the app's schema version with the app's schema. */
const PAGE_DB_NAME = 'noisy-dev-store';
/** The `device` store key of the test record Write saves. */
const TEST_KEY = 'dev-store-write';
/** The `device` store key Add duplicate adds twice. */
const DUPLICATE_KEY = 'dev-store-duplicate';
/** The `device` store keys Read many stores and reads are this prefix and a number below READ_COUNT. */
const READ_PREFIX = 'dev-store-read-';
const READ_COUNT = 4000;
/** Where the page notes a versionchange before it reloads, so the reloaded page can report it. */
const VERSION_CHANGE_KEY = 'noisy-dev-store-versionchange';
const SCENE: SceneId = (() => {
  const id = 'd0e1f2a3-b4c5-4d6e-8f70-819203a4b5c6';
  if (!isSceneId(id)) throw new Error('the page\'s scene id is not a scene id');
  return id;
})();

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n: number): string => ORDINALS[n - 1] ?? `number ${n}`;

type WriteEntry = { readonly n: number; readonly kind: 'write' | 'add-duplicate'; readonly result: Result<void, StoreError>; readonly ms: number };
/** One Read many: its phase, how many times the connection ran the read, and what it answered. */
type ReadEntry = {
  phase: 'storing' | 'reading' | 'done';
  attempts: number;
  result: Result<number, StoreError> | null;
};
type LockEntry = {
  readonly action: 'hold' | 'hold-ended' | 'ask' | 'throw';
  readonly from: 'page' | 'frame';
  readonly outcome: string;
  readonly ms: number;
  /** The scene lock's held and pending requests just after the action, from navigator.locks.query(). */
  readonly held: number;
  readonly pending: number;
};
type Report = {
  phase: 'starting' | 'ready' | 'failed';
  detail: string | null;
  levers: boolean;
  /** This load's navigation type, `navigate` or `reload`. */
  navigation: string;
  /** The versionchange the page before a reload saw, when it saw one. */
  previousVersionChange: unknown;
  injection: number;
  handlesOpened: number;
  versionChanges: number;
  writes: WriteEntry[];
  read: ReadEntry | null;
  reconnects: number;
  events: readonly unknown[];
  upgrade: string | null;
  frameReady: boolean;
  locks: LockEntry[];
  posts: { posted: number; notPosted: number };
};

type FrameAnswer = { readonly type: 'answer'; readonly outcome: string; readonly ms: number; readonly held: number; readonly pending: number };

const withSceneLock = createSceneLock(navigator.locks);

async function lockState(): Promise<{ held: number; pending: number }> {
  const state = await navigator.locks.query();
  const name = sceneLockName(SCENE);
  return { held: (state.held ?? []).filter((l) => l.name === name).length, pending: (state.pending ?? []).filter((l) => l.name === name).length };
}

/** Asks for the scene's lock and answers what came back, how long it took, and the lock's state after. */
async function ask(): Promise<Omit<FrameAnswer, 'type'>> {
  const began = performance.now();
  const result = await withSceneLock(SCENE, async () => 'granted');
  const ms = performance.now() - began;
  return { outcome: result.ok ? result.value : result.error.kind, ms, ...(await lockState()) };
}

async function postRow(row: object): Promise<boolean> {
  try {
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readVersionChangeNote(): unknown {
  try {
    const text = sessionStorage.getItem(VERSION_CHANGE_KEY);
    sessionStorage.removeItem(VERSION_CHANGE_KEY);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function navigationType(): string {
  const entry = performance.getEntriesByType('navigation')[0];
  return entry instanceof PerformanceNavigationTiming ? entry.type : 'unknown';
}

function button(id: string): HTMLButtonElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`the page has no button #${id}`);
  return el;
}

function startPage(out: HTMLElement): void {
  const params = new URLSearchParams(window.location.search);
  const levers = params.get('levers') === '1';
  const diagnostics = createDiagnostics<StoreEvent>(createBrowserClock(window));
  const report: Report = {
    phase: 'starting',
    detail: null,
    levers,
    navigation: navigationType(),
    previousVersionChange: readVersionChangeNote(),
    injection: 0,
    handlesOpened: 0,
    versionChanges: 0,
    writes: [],
    read: null,
    reconnects: 0,
    events: [],
    upgrade: null,
    frameReady: false,
    locks: [],
    posts: { posted: 0, notPosted: 0 },
  };
  const status = document.getElementById('status');
  const reconnects = document.getElementById('reconnects');
  const render = (): void => {
    report.events = diagnostics.events;
    report.reconnects = diagnostics.events.filter((e) => e.event === 'store.reconnect').length;
    if (reconnects !== null) reconnects.textContent = `store.reconnect: ${report.reconnects}`;
    out.dataset['phase'] = report.phase;
    out.textContent = JSON.stringify(report, null, 2);
  };

  // The opener, wrapped: it remembers the latest handle for Close handle and
  // makes each handle's transaction() throw while an injection is armed.
  const realOpen = idbOpener(indexedDB, PAGE_DB_NAME);
  let latest: IDBDatabase | null = null;
  const open: StoreOpener<IDBDatabase> = async (listeners) => {
    const opened = await realOpen(listeners);
    if (!opened.ok) return opened;
    const db = opened.value.db;
    const transaction = db.transaction.bind(db);
    db.transaction = (storeNames, mode, options) => {
      if (report.injection > 0) {
        report.injection -= 1;
        throw new DOMException('Injected by the store page: the connection is lost.', 'InvalidStateError');
      }
      return transaction(storeNames, mode, options);
    };
    latest = db;
    report.handlesOpened += 1;
    return opened;
  };

  // The upgrade the page itself started, which a reload waits for so that it
  // does not abort the second connection's upgrade.
  let upgrading: Promise<void> = Promise.resolve();
  const connection = createStoreConnection<IDBDatabase>({
    open,
    diag: diagnostics,
    onVersionChange: () => {
      report.versionChanges += 1;
      render();
      try {
        sessionStorage.setItem(VERSION_CHANGE_KEY, JSON.stringify({ at: new Date().toISOString(), reconnects: report.reconnects }));
      } catch {
        // The reloaded page then reports no previous versionchange.
      }
      void upgrading.then(() => window.location.reload());
    },
  });

  const write: StoreOperation<IDBDatabase, void> = async (db) => {
    const tx = db.transaction(STORE_NAMES.device, 'readwrite');
    tx.objectStore(STORE_NAMES.device).put({ write: report.writes.filter((w) => w.kind === 'write').length + 1, at: new Date().toISOString() }, TEST_KEY);
    await transactionDone(tx);
    return ok(undefined);
  };
  const addDuplicate: StoreOperation<IDBDatabase, void> = async (db) => {
    const tx = db.transaction(STORE_NAMES.device, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.device);
    await requestDone(store.add({ duplicate: 1 }, DUPLICATE_KEY));
    await requestDone(store.add({ duplicate: 2 }, DUPLICATE_KEY));
    await transactionDone(tx);
    return ok(undefined);
  };

  const storeMany: StoreOperation<IDBDatabase, void> = async (db) => {
    const tx = db.transaction(STORE_NAMES.device, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.device);
    for (let i = 0; i < READ_COUNT; i += 1) store.put(new Uint8Array(2000), `${READ_PREFIX}${i}`);
    await transactionDone(tx);
    return ok(undefined);
  };
  /** Reads the records back one request at a time, as the operations built on the connection await their requests. */
  const readMany = (entry: ReadEntry): StoreOperation<IDBDatabase, number> => async (db) => {
    entry.attempts += 1;
    const store = db.transaction(STORE_NAMES.device, 'readonly').objectStore(STORE_NAMES.device);
    let found = 0;
    for (let i = 0; i < READ_COUNT; i += 1) {
      if ((await requestDone(store.get(`${READ_PREFIX}${i}`))) !== undefined) found += 1;
    }
    return ok(found);
  };

  const writeButton = button('write');
  writeButton.addEventListener('click', () => {
    const n = report.writes.filter((w) => w.kind === 'write').length + 1;
    writeButton.disabled = true;
    const began = performance.now();
    void connection.run(write).then(async (result) => {
      const entry: WriteEntry = { n, kind: 'write', result, ms: performance.now() - began };
      report.writes.push(entry);
      if (status !== null) {
        status.textContent = result.ok ? `${ordinal(n)} write saved` : `${ordinal(n)} write failed: ${result.error.kind}${'detail' in result.error ? ` (${result.error.detail})` : ''}`;
        status.dataset['write'] = String(n);
        status.dataset['outcome'] = result.ok ? 'saved' : result.error.kind;
      }
      writeButton.disabled = false;
      render();
      const posted = await postRow({
        kind: 'store-write',
        buildId: NOISY_BUILD_ID,
        userAgent: navigator.userAgent,
        navigation: report.navigation,
        write: entry,
        reconnects: report.reconnects,
        events: report.events,
      });
      if (posted) report.posts.posted += 1;
      else report.posts.notPosted += 1;
      render();
    });
  });

  if (levers) {
    document.getElementById('levers')?.removeAttribute('hidden');
    const frame = document.createElement('iframe');
    frame.title = 'second context';
    frame.src = '/dev/store.html?frame=1';
    let answerFrame: ((answer: FrameAnswer) => void) | null = null;
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (typeof data !== 'object' || data === null || !('type' in data)) return;
      if (data.type === 'ready') {
        report.frameReady = true;
        render();
      } else if (data.type === 'answer' && 'outcome' in data && 'ms' in data && 'held' in data && 'pending' in data) {
        const { outcome, ms, held, pending } = data;
        if (typeof outcome === 'string' && typeof ms === 'number' && typeof held === 'number' && typeof pending === 'number') answerFrame?.({ type: 'answer', outcome, ms, held, pending });
      }
    });
    document.getElementById('levers')?.append(frame);

    button('add-duplicate').addEventListener('click', () => {
      const began = performance.now();
      void connection.run(addDuplicate).then((result) => {
        report.writes.push({ n: report.writes.filter((w) => w.kind === 'add-duplicate').length + 1, kind: 'add-duplicate', result, ms: performance.now() - began });
        render();
      });
    });
    button('read-many').addEventListener('click', () => {
      const entry: ReadEntry = { phase: 'storing', attempts: 0, result: null };
      report.read = entry;
      render();
      void connection.run(storeMany).then(async (stored) => {
        if (!stored.ok) {
          entry.phase = 'done';
          entry.result = stored;
          render();
          return;
        }
        entry.phase = 'reading';
        render();
        entry.result = await connection.run(readMany(entry));
        entry.phase = 'done';
        render();
      });
    });
    button('inject-1').addEventListener('click', () => {
      report.injection = 1;
      render();
    });
    button('inject-2').addEventListener('click', () => {
      report.injection = 2;
      render();
    });
    button('clear-injection').addEventListener('click', () => {
      report.injection = 0;
      render();
    });
    button('close-handle').addEventListener('click', () => {
      latest?.close();
      render();
    });
    button('upgrade').addEventListener('click', () => {
      report.upgrade = 'opening';
      render();
      upgrading = new Promise<void>((resolve) => {
        const request = indexedDB.open(PAGE_DB_NAME, 2);
        request.onsuccess = () => {
          request.result.close();
          report.upgrade = 'upgraded';
          render();
          resolve();
        };
        request.onerror = () => {
          report.upgrade = `failed: ${describeError(request.error)}`;
          render();
          resolve();
        };
        request.onblocked = () => {
          report.upgrade = 'blocked';
          render();
        };
      });
    });

    const recordLock = async (entry: Omit<LockEntry, 'held' | 'pending'>): Promise<void> => {
      report.locks.push({ ...entry, ...(await lockState()) });
      render();
    };
    let release: { readonly resolve: () => void; readonly reject: (e: unknown) => void } | null = null;
    button('hold').addEventListener('click', () => {
      const began = performance.now();
      let entered = false;
      const held = withSceneLock(SCENE, () => {
        entered = true;
        void recordLock({ action: 'hold', from: 'page', outcome: 'granted', ms: performance.now() - began });
        return new Promise<string>((resolve, reject) => {
          release = { resolve: () => resolve('released'), reject };
        });
      });
      held.then(
        (result) => {
          if (!entered) void recordLock({ action: 'hold', from: 'page', outcome: result.ok ? 'granted' : result.error.kind, ms: performance.now() - began });
          else void recordLock({ action: 'hold-ended', from: 'page', outcome: result.ok ? result.value : result.error.kind, ms: performance.now() - began });
        },
        (e: unknown) => void recordLock({ action: 'hold-ended', from: 'page', outcome: `rejected: ${describeError(e)}`, ms: performance.now() - began }),
      );
    });
    button('release').addEventListener('click', () => {
      release?.resolve();
      release = null;
    });
    button('release-reject').addEventListener('click', () => {
      release?.reject(new Error('the holder failed'));
      release = null;
    });
    button('ask-page').addEventListener('click', () => {
      void ask().then((answer) => {
        report.locks.push({ action: 'ask', from: 'page', ...answer });
        render();
      });
    });
    button('ask-frame').addEventListener('click', () => {
      answerFrame = (answer) => {
        answerFrame = null;
        report.locks.push({ action: 'ask', from: 'frame', outcome: answer.outcome, ms: answer.ms, held: answer.held, pending: answer.pending });
        render();
      };
      frame.contentWindow?.postMessage({ type: 'ask' }, window.location.origin);
    });
    button('throw').addEventListener('click', () => {
      const began = performance.now();
      withSceneLock(SCENE, () => {
        throw new Error('thrown inside the lock');
      }).then(
        (result) => void recordLock({ action: 'throw', from: 'page', outcome: result.ok ? 'resolved' : result.error.kind, ms: performance.now() - began }),
        (e: unknown) => void recordLock({ action: 'throw', from: 'page', outcome: `rejected: ${describeError(e)}`, ms: performance.now() - began }),
      );
    });
  }

  report.phase = 'ready';
  writeButton.disabled = false;
  render();
}

/** The frame: asks for the scene lock when its parent says so. */
function startFrame(): void {
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const data = event.data;
    if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'ask') return;
    void ask().then((answer) => window.parent.postMessage({ type: 'answer', ...answer }, window.location.origin));
  });
  window.parent.postMessage({ type: 'ready' }, window.location.origin);
}

const out = document.getElementById('report');
if (new URLSearchParams(window.location.search).get('frame') === '1') {
  const main = document.querySelector('main');
  if (main !== null) main.textContent = 'The store page\'s second context.';
  startFrame();
} else if (out !== null) {
  // Wrap long lines at phone width; set through the CSSOM, which the CSP allows.
  out.style.whiteSpace = 'pre-wrap';
  out.style.overflowWrap = 'anywhere';
  try {
    startPage(out);
  } catch (e) {
    out.dataset['phase'] = 'failed';
    out.textContent = JSON.stringify({ phase: 'failed', detail: describeError(e) });
  }
}
