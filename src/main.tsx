import { render } from 'preact';
import { bootRoot, type Root } from './app/root.ts';
import { installTestSurface } from './app/test-surface.ts';
import { err, ok, type Result } from './core/result.ts';
import { DemoApp } from './ui/app.tsx';
import { createDemoSession } from './session/scene.ts';

function boot(): Result<Root, string> {
  try {
    return ok(bootRoot(window));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

const session = createDemoSession();
const booted = boot();
if (booted.ok && NOISY_DEV) installTestSurface(window, booted.value, session);

const element = document.getElementById('app');
if (element !== null) {
  render(
    <DemoApp
      session={session}
      isolated={window.crossOriginIsolated}
      buildId={booted.ok ? booted.value.build : NOISY_BUILD_ID}
      bootError={booted.ok ? null : booted.error}
    />,
    element,
  );
}
