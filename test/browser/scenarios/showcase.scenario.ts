import { z } from '../../../src/core/zod.ts';
import type {} from '../../../src/app/showcase.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const projectedPoint = z.object({ x: z.number(), y: z.number() });
const snapshot = z.object({ ready: z.boolean(), eye: z.object({ x: z.number(), y: z.number() }),
  camera: z.object({ active: z.boolean(), frames: z.number(), state: z.string(), liveTracks: z.number() }),
  renderer: z.object({ triangles: z.number(), drawCount: z.number(), actualGeometry: z.boolean(), depthReferences: z.number(), submissionMs: z.number() }),
  frameMedianMs: z.number(), landmarks: z.object({ lantern: z.object({ x: z.number(), y: z.number() }), pavilion: z.object({ x: z.number(), y: z.number() }) }),
  window: z.object({ corners: z.array(projectedPoint).length(4), rightBack: projectedPoint, leftBack: projectedPoint, topBack: projectedPoint, bottomBack: projectedPoint }),
});
async function move(t: ScenarioContext, x: number, y: number): Promise<z.infer<typeof snapshot>> {
  await t.page.evaluate(z.literal(true), (x, y) => {
    const canvas = document.querySelector('#stage');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing scene canvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', bubbles: true, clientX: r.x + r.width * x, clientY: r.y + r.height * y }));
    return true;
  }, x, y);
  await t.page.evaluate(z.literal(true), async () => { await new Promise<void>(resolve => setTimeout(resolve, 1000)); return true; });
  return t.page.evaluate(snapshot, () => window.__noisyShowcase?.snapshot());
}
async function layout(t: ScenarioContext, width: number, height: number, name: string): Promise<void> {
  await t.page.emulate({ width, height, deviceScaleFactor: 1, mobile: width < 650, colorScheme: 'dark' });
  await t.page.evaluate(z.literal(true), async () => { await new Promise<void>(resolve => setTimeout(resolve, 150)); return true; });
  t.ok(`${name}: all controls are visible, uncovered 44px targets`, await t.page.evaluate(z.boolean(), () => {
    return ['#camera', '#recenter', '#fullscreen', '.showcase-back'].every(selector => {
      const e = document.querySelector(selector); if (!(e instanceof HTMLElement)) return false;
      const r = e.getBoundingClientRect();
      return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }) && document.documentElement.scrollWidth === innerWidth;
  }));
  t.ok(`${name}: contained 4:3 scene and controls do not overlap`, await t.page.evaluate(z.boolean(), () => {
    const stage = document.querySelector('#stage')?.getBoundingClientRect(), footer = document.querySelector('footer')?.getBoundingClientRect();
    return stage !== undefined && footer !== undefined && Math.abs(stage.width / stage.height - 4 / 3) < .002 && stage.width > 250 && stage.top >= 52 && stage.bottom <= footer.top + .1;
  }));
  await t.page.screenshot(name);
}

export const scenarios: readonly Scenario[] = [{
  id: 'showcase.geometry', title: 'Prepared Blender geometry, continuous perspective, camera lifecycle and responsive controls', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await t.page.emulate({ width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.goto('/scenes.html?scene=lantern-court');
    await t.page.waitFor('geometry renderer and face model ready', z.literal(true), () => window.__noisyShowcase?.snapshot().ready && document.querySelector('#camera') instanceof HTMLButtonElement && !document.querySelector<HTMLButtonElement>('#camera')?.disabled ? true : null, { timeoutMs: 120_000 });
    const neutral = await move(t, .5, .5);
    t.ok('draws courtyard and recessed window geometry', neutral.renderer.triangles > 90_000, neutral.renderer.triangles);
    t.equal('uses actual geometry', neutral.renderer.actualGeometry, true);
    t.equal('visibility buffers for all baked lighting views', neutral.renderer.depthReferences, 5);
    await layout(t, 1440, 1000, 'desktop');
    const left = await move(t, .15, .5); await t.page.screenshot('left');
    const right = await move(t, .85, .5); await t.page.screenshot('right');
    const separation = Math.abs((right.landmarks.lantern.x - right.landmarks.pavilion.x) - (left.landmarks.lantern.x - left.landmarks.pavilion.x)) * 1920;
    t.ok('near/far separation exceeds 180 master pixels', separation > 180, { separation, left: left.eye, right: right.eye });
    const diagonal = await move(t, .7, .25); await t.page.screenshot('diagonal');
    t.ok('continuous intermediate viewpoint on both axes', Math.abs(diagonal.eye.x - 1.8) < .003 && Math.abs(diagonal.eye.y - 1.75) < .003, diagonal.eye);
    const thresholdBelow = await move(t, (3.90 / 4.5 + 1) / 2, .5); await t.page.screenshot('right-wall-below');
    const thresholdAbove = await move(t, (4.0 / 4.5 + 1) / 2, .5); await t.page.screenshot('right-wall-above');
    const extreme = await move(t, 1, 0); await t.page.screenshot('right-up-extreme');
    t.ok('right wall projects into the opening below threshold', thresholdBelow.window.rightBack.x < (thresholdBelow.window.corners[1]?.x ?? NaN), thresholdBelow.window);
    t.ok('right wall projects beyond the frame above threshold', thresholdAbove.window.rightBack.x > (thresholdAbove.window.corners[1]?.x ?? NaN), thresholdAbove.window);
    t.ok('extreme diagonal removes right and top walls through projection', extreme.window.rightBack.x > (extreme.window.corners[1]?.x ?? NaN) && extreme.window.topBack.y < (extreme.window.corners[2]?.y ?? NaN), extreme.window);
    t.ok('all four glass corners remain fixed at every tested eye', [left, right, diagonal, thresholdBelow, thresholdAbove, extreme].every(s => s.window.corners.every((point, i) => Math.abs(point.x - (neutral.window.corners[i]?.x ?? NaN)) + Math.abs(point.y - (neutral.window.corners[i]?.y ?? NaN)) < 1e-6)));
    await t.page.click('#recenter');
    t.ok('Recenter restores neutral view', await t.page.evaluate(z.boolean(), () => { const e = window.__noisyShowcase?.snapshot().eye; return e !== undefined && Math.abs(e.x) + Math.abs(e.y) < .001; }));
    await t.page.evaluate(z.literal(true), () => { document.querySelector('#stage')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; });
    await t.page.waitFor('keyboard moves view', z.literal(true), () => (window.__noisyShowcase?.snapshot().eye.x ?? 0) > .1 ? true : null);
    await t.page.click('#recenter');
    await layout(t, 1024, 768, 'tablet');
    await layout(t, 390, 844, 'mobile');
    await t.page.click('#camera');
    await t.page.waitFor('browser media track opens', z.literal(true), () => window.__noisyShowcase?.snapshot().camera.liveTracks === 1 ? true : null);
    // The harness has a fake video device with no human face. Live FaceTime tracking is checked separately.
    await t.page.waitFor('no-face state is communicated', z.literal(true), () => document.querySelector('#status')?.textContent?.includes('Face out of view') ? true : null, { timeoutMs: 30_000 });
    t.ok('face loss returns the view to neutral', await t.page.evaluate(z.boolean(), () => { const s = window.__noisyShowcase?.snapshot(); return s !== undefined && s.camera.state === 'lost' && Math.abs(s.eye.x) + Math.abs(s.eye.y) < .001; }));
    await t.page.click('#camera');
    t.ok('Stop camera releases media and changes action', await t.page.evaluate(z.boolean(), () => window.__noisyShowcase?.snapshot().camera.liveTracks === 0 && document.querySelector('#camera')?.textContent === 'Head tracking'));
    await t.page.click('#camera');
    await t.page.waitFor('camera restarts', z.literal(true), () => window.__noisyShowcase?.snapshot().camera.liveTracks === 1 ? true : null);
    await t.page.lifecycle('frozen'); await t.page.lifecycle('active');
    t.ok('backgrounding releases camera without restarting it', await t.page.evaluate(z.boolean(), () => window.__noisyShowcase?.snapshot().camera.active === false && window.__noisyShowcase.snapshot().camera.liveTracks === 0));
    const after = await move(t, .35, .6);
    t.ok('pointer fallback remains available after camera stop', after.eye.x < -1.34 && after.eye.y < -.699, after.eye);
    await t.page.goto('/');
    await t.page.evaluate(z.literal(true), () => { history.back(); return true; });
    await t.page.waitFor('browser Back restores a working showcase', z.literal(true), () => location.pathname === '/scenes.html' && window.__noisyShowcase?.snapshot().ready ? true : null, { timeoutMs: 30_000 });
    const restored = await move(t, .7, .4);
    t.ok('navigation restoration has working interaction', restored.eye.x > 1.79 && restored.eye.y > .699, restored.eye);
    await t.file('geometry-observations.json', JSON.stringify({ neutral, left, right, diagonal, thresholdBelow, thresholdAbove, extreme, after, restored, separation }, null, 2));
  },
}, {
  id: 'showcase.errors', title: 'Scene loading, actionable failure and reload recovery', target: 'dev', covers: [], timeoutMs: 60_000,
  async run(t) {
    const path = '/assets-static/scenes/lantern-court/scene.json';
    await t.page.intercept([{ method: 'GET', path, action: { kind: 'hold' } }]);
    await t.page.goto('/scenes.html?scene=lantern-court');
    await t.page.waitFor('viewer module starts the held courtyard load', z.literal(true), () => document.querySelector('#loading')?.textContent === 'Opening Lantern Court.' ? true : null);
    t.ok('loading state is visible while geometry is pending', await t.page.evaluate(z.boolean(), () => document.querySelector('#loading')?.textContent === 'Opening Lantern Court.'));
    await t.page.intercept([]);
    await t.page.waitFor('held load resumes normally', z.literal(true), () => window.__noisyShowcase?.snapshot().ready ? true : null, { timeoutMs: 30_000 });
    t.expectMessage({ because: 'deliberate scene manifest failure', channel: 'log', source: 'network', level: 'error', url: /\/scene\.json$/ });
    await t.page.intercept([{ method: 'GET', path, action: { kind: 'respond', status: 503, body: 'Scene temporarily unavailable' } }]);
    await t.page.reload();
    await t.page.waitFor('scene failure explains recovery', z.literal(true), () => document.querySelector('#status')?.textContent?.includes('could not load (503)') && document.querySelector('#status')?.textContent?.includes('Retry') ? true : null);
    await t.page.intercept([]); await t.page.reload();
    await t.page.waitFor('reload recovers actual geometry', z.literal(true), () => window.__noisyShowcase?.snapshot().ready ? true : null, { timeoutMs: 30_000 });
    t.ok('recovered stage hides the error', await t.page.evaluate(z.boolean(), () => document.querySelector<HTMLElement>('#loading')?.hidden === true));
  },
}];
