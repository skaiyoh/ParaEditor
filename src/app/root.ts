// The page's composition: the objects of which a page has exactly one, made
// once at boot by main.tsx and handed to the modules that need them.

import type { BuildId, TabId } from '../core/ids.ts';
import { readBuildId } from '../platform/build-id.ts';
import { readCapabilities } from '../platform/capabilities.ts';
import { createBrowserClock, type Clock } from '../platform/clock.ts';
import { createDiagnostics, type Diagnostics } from '../platform/diagnostics.ts';
import { mintTabId } from '../platform/tab-id.ts';
import type { DiagnosticEvent, EnvironmentSnapshot } from './events.ts';

export type Root = {
  readonly clock: Clock;
  readonly diagnostics: Diagnostics<DiagnosticEvent>;
  readonly tab: TabId;
  readonly build: BuildId;
  /** Resolves with the snapshot once it has been read and logged as the `env` event; never rejects. */
  readonly environment: Promise<EnvironmentSnapshot>;
};

export function bootRoot(win: Window): Root {
  const clock = createBrowserClock(win);
  const diagnostics = createDiagnostics<DiagnosticEvent>(clock);
  // Listening first, so every violation from here on is logged.
  win.document.addEventListener('securitypolicyviolation', (e) => {
    diagnostics.log({ event: 'csp.violation', directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition });
  });
  const tab = mintTabId(win.crypto);
  const build = readBuildId();
  const environment = readCapabilities({ navigator: win.navigator, window: win, clock }).then((capabilities) => {
    const snapshot: EnvironmentSnapshot = { ...capabilities, build };
    diagnostics.log({ event: 'env', snapshot });
    return snapshot;
  });
  return { clock, diagnostics, tab, build, environment };
}
