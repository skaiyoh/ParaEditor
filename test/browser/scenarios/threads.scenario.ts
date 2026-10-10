// The thread probe page, /dev/threads.html, driven through its Run button.

import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const Settled = z.object({ state: z.string(), row: z.string() });

function runEnabled(): boolean {
  const button = document.querySelector('[data-testid=run]');
  return button instanceof HTMLButtonElement && !button.disabled;
}

/** The result's state and the row's fate, once both have settled. */
function settled(): unknown {
  const result = document.querySelector<HTMLElement>('[data-testid=result]');
  const state = result?.dataset['state'];
  const row = result?.dataset['row'];
  if (state === undefined || state === 'idle' || state === 'running' || row === undefined || row === 'posting') return null;
  return { state, row };
}

function hardwareConcurrency(): number {
  return navigator.hardwareConcurrency;
}

const ProbeRow = z.object({
  kind: z.literal('threads-probe'),
  buildId: z.string(),
  env: z.object({ crossOriginIsolated: z.boolean(), hardwareConcurrency: z.number() }),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('completed'), numThreads: z.number().nullable(), outputOk: z.boolean() }),
    z.object({ kind: z.literal('failed'), error: z.string(), numThreads: z.number().nullable() }),
    z.object({ kind: z.literal('timed-out'), afterMs: z.number() }),
  ]),
  pthreadWorkers: z.number(),
  csp: z.object({ count: z.number() }),
});

/** Clicks Run, waits for the outcome and the posted row, and returns the sink's threads-probe rows. */
async function runProbe(t: ScenarioContext, screenshot: string): Promise<{ readonly rows: readonly z.infer<typeof ProbeRow>[]; readonly hardwareConcurrency: number }> {
  await t.page.goto('/dev/threads.html');
  await t.page.waitFor('the Run button to be enabled', z.literal(true), runEnabled);
  await t.page.click('[data-testid=run]');
  const done = await t.page.waitFor('the probe to finish and post its row', Settled, settled, { timeoutMs: 140_000, intervalMs: 200 });
  t.equal('the probe completed', done.state, 'completed');
  t.equal('the probe posted its row', done.row, 'posted');
  await t.page.screenshot(screenshot);
  const lines = await t.server.sinkLines();
  const rows = lines.flatMap((line) => ('row' in line ? [ProbeRow.safeParse(line.row)] : [])).flatMap((p) => (p.success ? [p.data] : []));
  return { rows, hardwareConcurrency: await t.page.evaluate(z.number(), hardwareConcurrency) };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'threads.default',
    title: 'the thread probe completes at ORT\'s default thread count, with one fewer pthread worker, and posts its row',
    target: 'dev',
    covers: [],
    timeoutMs: 160_000,
    readsSinkFiles: true,
    async run(t) {
      const { rows, hardwareConcurrency } = await runProbe(t, 'threads-isolated');
      // ORT 1.30.0's default when cross-origin isolated: min(4, ceil(hardwareConcurrency / 2)).
      const threads = Math.min(4, Math.ceil(hardwareConcurrency / 2));
      const row = rows[0];
      t.equal('the sink holds one threads-probe row', rows.length, 1);
      t.equal('the row\'s outcome: completed at the default thread count, output correct', row?.outcome, { kind: 'completed', numThreads: threads, outputOk: true }, { hardwareConcurrency });
      t.equal('the probe started one pthread worker fewer than its threads', row?.pthreadWorkers, threads - 1);
      t.equal('the page was cross-origin isolated', row?.env.crossOriginIsolated, true);
      t.equal('the page and the probe worker saw no CSP violation', row?.csp.count, 0);
      t.equal('the row carries the served build id', row?.buildId, t.build.buildId);
    },
  },
  {
    id: 'threads.no-isolation',
    title: 'under the no-isolation fault the thread probe completes on one thread with no pthread worker',
    target: 'dev',
    covers: ['F26'],
    timeoutMs: 160_000,
    readsSinkFiles: true,
    async run(t) {
      await t.server.setFaults(['no-isolation']);
      const { rows } = await runProbe(t, 'threads-no-isolation');
      const row = rows[0];
      t.equal('the sink holds one threads-probe row', rows.length, 1);
      t.equal('the row\'s outcome: completed on one thread, output correct', row?.outcome, { kind: 'completed', numThreads: 1, outputOk: true });
      t.equal('the probe started no pthread worker', row?.pthreadWorkers, 0);
      t.equal('the page was not cross-origin isolated', row?.env.crossOriginIsolated, false);
    },
  },
];
