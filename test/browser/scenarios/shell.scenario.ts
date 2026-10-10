// The app shell on the dev server: isolation, the build id, that each worker
// entry loads, and the isolation switch.

import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

const Shell = z.object({
  isolation: z.string().nullable(),
  build: z.string().nullable(),
  crossOriginIsolated: z.boolean(),
  sharedArrayBuffer: z.string(),
});

function readShell(): unknown {
  const isolation = document.querySelector('[data-testid=isolation]')?.textContent ?? null;
  if (isolation === null) return null;
  return {
    isolation,
    build: document.querySelector('[data-testid=build-id]')?.textContent ?? null,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
  };
}

/** Starts `url` as a module worker, posts one message, and resolves with the first reply or the failure. */
function askWorker(url: string): Promise<unknown> {
  return new Promise((resolve) => {
    const worker = new Worker(url, { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      resolve({ error: 'no reply within 5000 ms' });
    }, 5000);
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      window.clearTimeout(timer);
      worker.terminate();
      resolve({ reply: event.data });
    });
    worker.addEventListener('error', (event) => {
      window.clearTimeout(timer);
      resolve({ error: event.message || 'the worker did not load' });
    });
    worker.postMessage('ping');
  });
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'shell.isolated',
    title: 'the shell reads "isolated: yes" with the served build id',
    target: 'dev',
    covers: ['B4', 'C6'],
    async run(t) {
      await t.page.goto('/');
      const shell = await t.page.waitFor('the shell to render', Shell, readShell);
      t.equal('crossOriginIsolated is true', shell.crossOriginIsolated, true);
      t.equal('the shell reads isolated: yes', shell.isolation, 'isolated: yes');
      t.equal('the shell shows the served build id', shell.build, `build ${t.build.buildId}`);
      t.equal('SharedArrayBuffer exists', shell.sharedArrayBuffer, 'function');
      await t.page.screenshot('shell-isolated');
    },
  },
  {
    id: 'shell.workers',
    title: 'each worker entry loads as a module worker: the gif stub answers with its name and the build id, and the sequence, decode and face workers throw a message they cannot parse',
    target: 'dev',
    covers: ['B3'],
    async run(t) {
      await t.page.goto('/');
      const names = Object.keys(t.build.workers).sort();
      t.equal('the build has the four worker entries', names, ['decode', 'face', 'gif', 'sequence']);
      t.expectMessage({ because: 'the sequence worker throws the message it cannot parse, which the page receives as an error event', text: /the sequence worker cannot read a request/ });
      t.expectMessage({ because: 'the decode worker throws the message it cannot parse, which the page receives as an error event', text: /the decode worker cannot read a request/ });
      t.expectMessage({ because: 'the face worker throws the message it cannot parse, which the page receives as an error event', text: /The face worker cannot read a request/ });
      for (const [name, url] of Object.entries(t.build.workers)) {
        const answer = await t.page.evaluate(z.unknown(), askWorker, url);
        if (name === 'sequence' || name === 'decode' || name === 'face') {
          // The analysis workers parse every message, and a string is not one of their requests.
          const article = name === 'face' ? 'The' : 'the';
          t.equal(`the ${name} worker loads and throws the message it cannot parse`, answer, { error: `Uncaught Error: ${article} ${name} worker cannot read a request: (message): Invalid input: expected object, received string` }, { url });
        } else {
          t.equal(`the ${name} worker answers as a stub`, answer, { reply: { kind: 'stub', worker: name, buildId: t.build.buildId } }, { url });
        }
      }
    },
  },
  {
    id: 'shell.no-isolation',
    title: 'the no-isolation fault and a reload show "isolated: no"; clearing it and a reload restore isolation',
    target: 'dev',
    covers: ['F26'],
    async run(t) {
      await t.page.goto('/');
      const before = await t.page.waitFor('the shell to render', Shell, readShell);
      t.equal('the shell starts isolated', before.isolation, 'isolated: yes');

      await t.server.setFaults(['no-isolation']);
      await t.page.reload();
      const off = await t.page.waitFor('the shell to render', Shell, readShell);
      t.equal('after no-isolation and a reload the shell reads isolated: no', off.isolation, 'isolated: no');
      t.equal('crossOriginIsolated is false', off.crossOriginIsolated, false);
      t.equal('SharedArrayBuffer is not exposed', off.sharedArrayBuffer, 'undefined');
      await t.page.screenshot('shell-not-isolated');

      await t.server.clearFaults();
      await t.page.reload();
      const back = await t.page.waitFor('the shell to render', Shell, readShell);
      t.equal('after clearing the fault and a reload the shell reads isolated: yes', back.isolation, 'isolated: yes');
    },
  },
];
