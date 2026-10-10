// The dev-only test surface, `window.__noisyTest`, through which drivers and
// dev pages read the page's state. main.tsx installs it only when NOISY_DEV is
// true, so a production build drops this module, and the bundle guard
// (test/bundle-guard.test.ts) checks that no production bundle names it.
// Each module adds its members here once the types they name exist.

import type { DiagnosticEvent, EnvironmentSnapshot } from './events.ts';
import type { Root } from './root.ts';
import { demoTestHooks, type DemoTestSurface } from '../session/test-hooks.ts';
import type { DemoSession } from '../session/scene.ts';
import type { Renderer } from '../render/types.ts';

export type TestSurface = {
  readonly demo: DemoTestSurface;
  /** The live renderer, for scenarios that drive it directly (R1's `render.view`). */
  readonly session: { renderer(): Renderer | null };
  /** Every event the ring holds, oldest first, each with its `t`. */
  diagnostics(): readonly DiagnosticEvent[];
  /** The snapshot logged as the `env` event, once it has been read. */
  environment(): Promise<EnvironmentSnapshot>;
};

export function installTestSurface(win: Window, root: Root, session: DemoSession): void {
  const surface: TestSurface = {
    demo: demoTestHooks(session),
    session: { renderer: () => session.renderer() },
    diagnostics: () => root.diagnostics.events,
    environment: () => root.environment,
  };
  Object.defineProperty(win, '__noisyTest', { value: Object.freeze(surface), enumerable: false, writable: false, configurable: false });
}
