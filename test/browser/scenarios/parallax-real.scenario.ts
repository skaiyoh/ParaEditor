import { z } from '../../../src/core/zod.ts';
import type { Scenario } from '../scenario.ts';

export const scenarios: readonly Scenario[] = [{
  id: 'parallax.real-photo', title: 'Actual sample analysis, tapped subject and prepared perspective travel', target: 'dev', covers: ['P9', 'P10'], timeoutMs: 300_000,
  async run(t) {
    const { page } = t;
    await page.emulate({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, colorScheme: 'dark' });
    await page.goto('/'); await page.click('[data-testid="try-sample"]');
    await page.waitFor('real depth and selection decoder', z.literal(true), () => {
      const a = window.__noisyTest?.demo.analysis(); return a?.depth && a.decoderReady && !a.alive.heavy ? true : null;
    }, { timeoutMs: 180_000 });
    await page.evaluate(z.literal(true), async () => {
      const demo = window.__noisyTest?.demo; if (!demo) throw new Error('No demo.');
      await demo.tap(.5, .6); demo.select(null); return true;
    });
    await page.waitFor('real selected subject', z.literal(true), () => (window.__noisyTest?.demo.objects().length ?? 0) > 0 ? true : null);
    await page.click('[data-testid="parallax-enabled"]');
    await page.waitFor('live camera and independently prepared background', z.literal(true), () => {
      const demo = window.__noisyTest?.demo;
      return demo?.windowReady() && demo.parallaxDebug().preparation === 'ready' ? true : null;
    }, { timeoutMs: 90_000 });
    const positions: number[] = [];
    for (const [index, target] of [.5, .8, .2].entries()) {
      positions.push(await page.evaluate(z.number(), async (target: number) => {
        const demo = window.__noisyTest?.demo, renderer = window.__noisyTest?.session?.renderer();
        const stage = document.querySelector('[data-testid="stage"]');
        if (!demo || !renderer || !(stage instanceof HTMLCanvasElement)) throw new Error('No live scene.');
        const timer = setInterval(() => demo.injectFace({ x: target, y: .5 }), 60);
        try {
          demo.injectFace({ x: target, y: .5 });
          await new Promise<void>((resolve) => setTimeout(resolve, 600));
          const bytes = renderer.debug?.readGeometryPatch?.(0, 0, stage.width, stage.height);
          if (!bytes) throw new Error('No live geometry.');
          let sum = 0, count = 0;
          for (let i = 0; i < bytes.length; i += 4) if (bytes[i] === 1 && bytes[i + 3] === 255) { sum += i / 4 % stage.width; count++; }
          if (count === 0) throw new Error('Selected subject disappeared.');
          return sum / count;
        } finally { clearInterval(timer); }
      }, target));
      await page.screenshot(['parallax-real-neutral', 'parallax-real-right', 'parallax-real-left'][index] ?? 'parallax-real-photo');
    }
    const result = await page.evaluate(z.object({ coverage: z.string(), travelScale: z.number(), reason: z.string().nullable(), cssScale: z.number(), tracksEnded: z.boolean(), targetsReleased: z.boolean(), trace: z.string() }), () => {
      const demo = window.__noisyTest?.demo, renderer = window.__noisyTest?.session?.renderer();
      const stage = document.querySelector('[data-testid="stage"]');
      if (!demo || !renderer || !(stage instanceof HTMLCanvasElement)) throw new Error('No live scene.');
      const debug = demo.parallaxDebug(), coverage = debug.coverage.kind === 'rendered' ? 'rendered' : debug.coverage.reason;
      const travelScale = debug.coverage.kind === 'rendered' ? debug.coverage.travelScale : 0;
      const trace = JSON.stringify(demo.parallaxTrace()), tracks = [...demo.windowTracks()];
      const button = document.querySelector('[data-testid="parallax-enabled"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('No Parallax switch.');
      button.click();
      const resources = renderer.debug?.perspectiveResources?.();
      return { coverage, travelScale, reason: debug.coverage.reason, cssScale: stage.getBoundingClientRect().width / stage.width, trace,
        tracksEnded: tracks.every((track) => track.readyState === 'ended'),
        targetsReleased: resources !== undefined && resources.targets === 0 && resources.textures === 0 };
    });
    const [neutral = 0, right = 0, left = 0] = positions;
    const { trace, ...observed } = result;
    await t.file('real-photo.json', JSON.stringify({ ...observed, neutral, right, left }, null, 2));
    await t.file('real-photo-trace.json', trace);
    t.ok('real analyzed photo has supported prepared perspective', result.coverage === 'rendered', result.coverage);
    t.ok('real selected subject moves on both sides of neutral', right > neutral + .5 && left < neutral - .5,
      { neutral, right, left, travelScale: result.travelScale, cssTravelRight: (right - neutral) * result.cssScale, cssTravelLeft: (left - neutral) * result.cssScale });
    t.ok('disable releases camera and live GPU resources', result.tracksEnded && result.targetsReleased, observed);
    await page.screenshot('parallax-real-photo');
  },
}];
