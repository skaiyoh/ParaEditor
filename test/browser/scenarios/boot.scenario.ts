// The composition root's boot: the env event in a dev build, and no test
// surface in a production build.

import { isBuildId } from '../../../src/core/ids.ts';
import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

/** Every diagnostic event once the environment snapshot has been read and logged. */
async function bootEvents(): Promise<unknown> {
  const surface = window.__noisyTest;
  if (surface === undefined) return { surface: false, events: [] };
  await surface.environment();
  return { surface: true, events: surface.diagnostics() };
}

function hasSurface(): boolean {
  return '__noisyTest' in window;
}

function readShell(): unknown {
  const isolation = document.querySelector('[data-testid=isolation]')?.textContent ?? null;
  if (isolation === null) return null;
  return { isolation, build: document.querySelector('[data-testid=build-id]')?.textContent ?? null };
}

const Booted = z.object({ surface: z.boolean(), events: z.array(z.object({ event: z.string(), t: z.number() }).loose()) });

const EnvSnapshot = z.object({
  userAgent: z.string(),
  deviceClass: z.enum(['phone', 'desktop']),
  crossOriginIsolated: z.boolean(),
  hardwareConcurrency: z.number(),
  standalone: z.boolean(),
  storage: z.object({ quota: z.number().nullable(), persisted: z.boolean() }),
  build: z.string(),
});

const Shell = z.object({ isolation: z.string(), build: z.string().nullable() });

export const scenarios: readonly Scenario[] = [
  {
    id: 'boot.env-event',
    title: 'the dev build\'s diagnostics hold exactly one env event, whose snapshot has every field with plausible values',
    target: 'dev',
    covers: ['B9'],
    async run(t) {
      await t.page.goto('/');
      const booted = await t.page.evaluate(Booted, bootEvents);
      t.equal('the dev build has the test surface', booted.surface, true);
      const envs = booted.events.filter((e) => e.event === 'env');
      t.equal('the diagnostics hold exactly one env event', envs.length, 1, { events: booted.events.map((e) => e.event) });
      const parsed = EnvSnapshot.safeParse(envs[0]?.['snapshot']);
      t.ok('the snapshot has every field with its type', parsed.success, { snapshot: envs[0]?.['snapshot'], error: parsed.error?.message });
      if (!parsed.success) return;
      const s = parsed.data;
      t.equal('deviceClass is desktop', s.deviceClass, 'desktop');
      t.equal('crossOriginIsolated is true', s.crossOriginIsolated, true);
      t.ok('more than one hardware thread', s.hardwareConcurrency > 1, { hardwareConcurrency: s.hardwareConcurrency });
      t.ok('a storage estimate above zero', s.storage.quota !== null && s.storage.quota > 0, { storage: s.storage });
      t.equal('not standalone', s.standalone, false);
      t.ok('the user agent is Chrome\'s', s.userAgent.includes('Chrome/'), { userAgent: s.userAgent });
      t.equal('the snapshot carries the served build id', s.build, t.build.buildId);
      t.ok('the build id has the build id\'s form', isBuildId(s.build), { build: s.build });
    },
  },
  {
    id: 'boot.production',
    title: 'the production build, served by the dev server, has no test surface and still renders the shell',
    target: 'dev-production-build',
    covers: ['R7', 'C6'],
    async run(t) {
      await t.page.goto('/');
      const shell = await t.page.waitFor('the shell to render', Shell, readShell);
      t.equal('the production page has no __noisyTest', await t.page.evaluate(z.boolean(), hasSurface), false);
      t.equal('the shell reads isolated: yes', shell.isolation, 'isolated: yes');
      t.equal('the shell shows the production build id', shell.build, `build ${t.build.buildId}`);
      await t.page.screenshot('shell-production');
    },
  },
];
