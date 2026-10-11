import { z } from '../../../src/core/zod.ts';
import { readFile } from 'node:fs/promises';
import { landscapeSchema } from '../../../src/app/showcase/landscape.ts';
import type {} from '../../../src/app/showcase.ts';
import type { Scenario, ScenarioContext } from '../scenario.ts';

const currentField = landscapeSchema.parse(JSON.parse(await readFile(new URL('../../../assets/scenes/highland-field/field.json', import.meta.url), 'utf8')));

const point = z.object({ x: z.number(), y: z.number() });
const snapshot = z.object({ ready: z.boolean(), scene: z.string(), source: z.string(), gain: z.number(), auto: z.boolean(), tilt: z.boolean(),
  target: point, current: point, eye: point, loading: z.boolean(), error: z.string().nullable(),
  camera: z.object({ active: z.boolean(), state: z.string(), liveTracks: z.number(), sampleSequence: z.number() }),
  renderer: z.object({ triangles: z.number(), drawCount: z.number(), actualGeometry: z.boolean(), depthReferences: z.number() }).nullable(),
  window: z.object({ corners: z.array(point) }).nullable(), frameMedianMs: z.number() });
const visibility = z.array(z.object({ id: z.number(), name: z.string(), pixels: z.number() }));
const pause = async (t: ScenarioContext, ms = 1000) => t.page.evaluate(z.literal(true), async ms => { await new Promise<void>(resolve => setTimeout(resolve, ms)); return true; }, ms);
async function ready(t: ScenarioContext, scene = 'highland-field'): Promise<void> {
  await t.page.waitFor(`selected ${scene} is ready`, z.literal(true), () => window.__noisyShowcase?.snapshot().ready ? true : null, { timeoutMs: 60_000 });
  t.equal('correct selected scene', await t.page.evaluate(z.string(), () => window.__noisyShowcase?.snapshot().scene), scene);
}
async function choose(t: ScenarioContext, id: string): Promise<void> {
  await t.page.evaluate(z.literal(true), id => {
    const select = document.querySelector('#scene-choice'); if (!(select instanceof HTMLSelectElement)) throw new Error('No scene selector');
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  }, id);
}
async function move(t: ScenarioContext, x: number, y: number) {
  await t.page.evaluate(z.literal(true), (x, y) => {
    const canvas = document.querySelector('#stage'); if (!(canvas instanceof HTMLCanvasElement)) throw new Error('No scene canvas');
    const box = canvas.getBoundingClientRect(); canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: box.x + box.width * x, clientY: box.y + box.height * y })); return true;
  }, x, y); await pause(t);
  return t.page.evaluate(snapshot, () => window.__noisyShowcase?.snapshot());
}
async function layout(t: ScenarioContext, width: number, height: number, name: string): Promise<void> {
  await t.page.emulate({ width, height, deviceScaleFactor: 1, mobile: width < 650, colorScheme: 'dark' }); await pause(t, 200); await t.page.click('#recenter'); await pause(t, 100);
  t.ok(`${name}: controls fit as unobstructed 44px targets`, await t.page.evaluate(z.boolean(), () => {
    return document.documentElement.scrollWidth === innerWidth && ['#scene-choice', '#camera', '#recenter', '#tilt', '#auto', '#fullscreen'].every(selector => {
      const element = document.querySelector(selector); if (!(element instanceof HTMLElement)) return false;
      const box = element.getBoundingClientRect(); return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
  }));
  t.ok(`${name}: scene has no frame and controls stay below it`, await t.page.evaluate(z.boolean(), () => {
    const canvas = document.querySelector('#stage'), frame = document.querySelector('#frame'), footer = document.querySelector('footer');
    if (!(canvas instanceof HTMLElement) || !(frame instanceof HTMLElement) || !(footer instanceof HTMLElement)) return false;
    const box = canvas.getBoundingClientRect(); return box.width > 250 && box.height > 150 && box.bottom <= footer.getBoundingClientRect().top + 1 && getComputedStyle(frame).borderTopWidth === '0px';
  })); await t.page.screenshot(name);
}

export const scenarios: readonly Scenario[] = [{
  id: 'scenes.viewer', title: 'Unified prepared scenes preserve approved landscape, motion, inputs and camera continuity', target: 'dev', covers: [], timeoutMs: 180_000,
  async run(t) {
    await t.page.emulate({ width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.goto('/dev/showcase.html'); await ready(t);
    t.equal('old URL redirects to the canonical viewer', await t.page.evaluate(z.string(), () => location.pathname), '/scenes.html');
    const neutral = await move(t, .5, .5); t.equal('approved gain defaults to 2x', neutral.gain, 2);
    const shippedField = await t.page.evaluate(landscapeSchema, async () => {
      const response = await fetch('/assets-static/scenes/highland-field/field.json');
      if (!response.ok) throw new Error(`Landscape metadata failed (${response.status})`);
      return response.json();
    });
    t.equal('shipped vertex count matches current authored metadata', shippedField.vertexCount, currentField.vertexCount);
    t.equal('shipped mesh size matches current authored metadata', shippedField.meshBytes, currentField.meshBytes);
    t.equal('shipped triangle count matches current authored metadata', shippedField.triangleCount, currentField.triangleCount);
    t.equal('renderer draws the current indexed geometry', neutral.renderer?.triangles, currentField.triangleCount);
    await layout(t, 1440, 1000, 'highland-desktop');
    const left = await move(t, 0, .5), leftVisibility = await t.page.evaluate(visibility, () => window.__noisyShowcase?.visibility()); await t.page.screenshot('highland-left');
    const right = await move(t, 1, .5), rightVisibility = await t.page.evaluate(visibility, () => window.__noisyShowcase?.visibility()); await t.page.screenshot('highland-right');
    t.ok('screen corners stay fixed under eye translation', left.window !== null && right.window !== null && left.window.corners.every((p, i) => Math.abs(p.x - (right.window?.corners[i]?.x ?? NaN)) + Math.abs(p.y - (right.window?.corners[i]?.y ?? NaN)) < 1e-6));
    const reveals = leftVisibility.filter(object => /Reveal|Beyond/i.test(object.name)).map(object => ({ name: object.name, left: object.pixels, right: rightVisibility.find(other => other.id === object.id)?.pixels ?? 0 }));
    t.ok('a physically hidden stone becomes visible in GPU ID pixels', reveals.some(object => Math.min(object.left, object.right) < 10 && Math.max(object.left, object.right) > 100), reveals);
    await t.page.click('#recenter');
    await t.page.evaluate(z.literal(true), () => { document.querySelector('#stage')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; }); await pause(t);
    t.ok('keyboard controls the same smooth view', await t.page.evaluate(z.boolean(), () => Math.abs((window.__noisyShowcase?.snapshot().current.x ?? 0) - .15) < .001));
    await t.page.click('#auto'); await pause(t, 500);
    t.ok('auto movement is explicit and active', await t.page.evaluate(z.boolean(), () => window.__noisyShowcase?.snapshot().auto === true)); await t.page.click('#recenter');
    await layout(t, 1180, 820, 'highland-tablet'); await layout(t, 390, 844, 'highland-mobile');
    await t.page.emulate({ width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.waitFor('face model prepared', z.literal(true), () => document.querySelector<HTMLButtonElement>('#camera')?.disabled === false ? true : null, { timeoutMs: 60_000 });
    await t.page.click('#camera'); await t.page.waitFor('camera track is live', z.literal(true), () => window.__noisyShowcase?.snapshot().camera.liveTracks === 1 ? true : null);
    const sequence = await t.page.evaluate(z.number(), () => window.__noisyShowcase?.snapshot().camera.sampleSequence);
    await t.page.waitFor('camera polling continues while motion is settled', z.literal(true), () => (window.__noisyShowcase?.snapshot().camera.sampleSequence ?? 0) > 3 ? true : null);
    await choose(t, 'lantern-court'); await ready(t, 'lantern-court'); await pause(t, 500);
    const lantern = await t.page.evaluate(snapshot, () => window.__noisyShowcase?.snapshot());
    t.ok('scene switch keeps a single camera capture active', lantern.camera.active && lantern.camera.liveTracks === 1 && lantern.camera.sampleSequence > sequence, lantern.camera);
    t.equal('courtyard keeps five lighting references', lantern.renderer?.depthReferences, 5);
    await t.page.click('#camera'); t.equal('stop releases camera', await t.page.evaluate(z.number(), () => window.__noisyShowcase?.snapshot().camera.liveTracks), 0);
    await t.page.click('#recenter'); await t.page.screenshot('lantern-desktop');
    await t.page.intercept([{ method: 'GET', path: '/assets-static/scenes/lantern-court/neutral.webp', action: { kind: 'hold' } }]);
    await choose(t, 'lantern-court'); await pause(t, 50); await choose(t, 'highland-field'); await ready(t);
    await t.page.intercept([]); await pause(t, 500);
    t.ok('late aborted scene construction cannot replace the chosen scene', await t.page.evaluate(z.boolean(), triangles => { const state = window.__noisyShowcase?.snapshot(); return state?.scene === 'highland-field' && state.renderer?.triangles === triangles && state.error === null; }, currentField.triangleCount));
    await t.page.click('#tilt');
    await t.page.waitFor('tilt input is enabled before synthetic samples', z.literal(true), () => window.__noisyShowcase?.snapshot().tilt === true ? true : null);
    await t.page.evaluate(z.literal(true), () => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 0 }));
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 8 })); return true;
    }); await pause(t);
    const tilted = await t.page.evaluate(snapshot, () => window.__noisyShowcase?.snapshot());
    t.ok('declared synthetic orientation drives the tilt fallback', tilted.tilt && Math.abs(Math.hypot(tilted.current.x, tilted.current.y) - .5) < .001, tilted);
    await t.page.lifecycle('frozen'); await t.page.lifecycle('active');
    t.ok('background stops sensor/camera/auto modes without restarting', await t.page.evaluate(z.boolean(), () => { const state = window.__noisyShowcase?.snapshot(); return state !== undefined && !state.tilt && !state.auto && state.camera.liveTracks === 0; }));
    const fallback = await move(t, .3, .6); t.ok('pointer fallback remains usable', fallback.current.x < -.39 && fallback.current.y < -.19);
    await t.file('observations.json', JSON.stringify({ neutral, left, right, reveals, lantern, fallback }, null, 2));
  },
}, {
  id: 'scenes.errors', title: 'Scene failures retain source poster, selected scene and retry recovery', target: 'dev', covers: [], timeoutMs: 90_000,
  async run(t) {
    const path = '/assets-static/scenes/highland-field/field.mesh.0';
    await t.page.intercept([{ method: 'GET', path, action: { kind: 'hold' } }]); await t.page.goto('/scenes.html');
    t.ok('real poster remains visible while geometry is pending', await t.page.evaluate(z.boolean(), () => { const poster = document.querySelector('#poster'); return poster instanceof HTMLImageElement && !poster.hidden && document.querySelector('#loading')?.textContent === 'Opening Highland Field.'; }));
    await t.page.intercept([]); await ready(t);
    t.expectMessage({ because: 'deliberate landscape chunk load failure', channel: 'log', source: 'network', level: 'error', url: /field\.mesh\.0$/ });
    await t.page.intercept([{ method: 'GET', path, action: { kind: 'respond', status: 503, body: 'Temporarily unavailable' } }]); await choose(t, 'highland-field');
    await t.page.waitFor('clear failure and retry', z.literal(true), () => document.querySelector('#status')?.textContent?.includes('(503)') && document.querySelector<HTMLButtonElement>('#retry')?.hidden === false ? true : null);
    await t.page.screenshot('load-failure'); await t.page.intercept([]); await t.page.click('#retry'); await ready(t);
    await t.page.evaluate(z.literal(true), () => { document.querySelector('canvas')?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); return true; });
    await t.page.waitFor('graphics failure recovery action', z.literal(true), () => document.querySelector('#status')?.textContent?.includes('graphics context stopped') ? true : null);
    await t.page.screenshot('context-loss'); await t.page.click('#retry'); await ready(t);
    t.equal('recovery retains approved default', await t.page.evaluate(z.number(), () => window.__noisyShowcase?.snapshot().gain), 2);
  },
}, {
  id: 'scenes.production', title: 'Production serves both prepared scenes and the real demo entry', target: 'production', covers: [], timeoutMs: 90_000,
  async run(t) {
    await t.page.emulate({ width: 1180, height: 820, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await t.page.goto('/'); await t.page.click('[data-testid="projects-toggle"]');
    t.ok('Projects exposes the prepared 3D demo entry', await t.page.evaluate(z.boolean(), () => document.querySelector('[data-testid="scenes-open"]')?.textContent === '3D scenes'));
    await t.page.goto('/scenes.html');
    await t.page.waitFor('production landscape draws', z.literal(true), () => document.querySelector<HTMLDivElement>('#loading')?.hidden === true && document.querySelector<HTMLCanvasElement>('#stage')?.hidden === false ? true : null, { timeoutMs: 60_000 });
    t.ok('production describes prepared geometry and preserves gain', await t.page.evaluate(z.boolean(), () => document.querySelector('#kind')?.textContent === 'Prepared 3D scenes' && document.querySelector<HTMLInputElement>('#gain')?.value === '2'));
    await t.page.screenshot('production-highland'); await choose(t, 'lantern-court');
    await t.page.waitFor('production courtyard draws', z.literal(true), () => document.querySelector<HTMLSelectElement>('#scene-choice')?.value === 'lantern-court' && document.querySelector<HTMLDivElement>('#loading')?.hidden === true ? true : null, { timeoutMs: 60_000 });
    await t.page.screenshot('production-lantern');
    t.equal('inspection hook is dev-only', await t.page.evaluate(z.boolean(), () => window.__noisyShowcase === undefined), true);
  },
}];
