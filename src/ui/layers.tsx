import { useLayoutEffect, useRef } from 'preact/hooks';
import type { DemoScene, DemoSession } from '../session/scene.ts';

function Thumbnail({ scene, bounds }: {
  readonly scene: DemoScene; readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (context === undefined || context === null) return;
    const side = Math.max(bounds.width, bounds.height);
    const x = bounds.x + (bounds.width - side) / 2, y = bounds.y + (bounds.height - side) / 2;
    context.clearRect(0, 0, 48, 48);
    context.drawImage(scene.master, x, y, side, side, 0, 0, 48, 48);
  }, [scene.master, bounds.x, bounds.y, bounds.width, bounds.height]);
  return <canvas ref={canvas} class="layer-thumbnail" width="48" height="48" aria-hidden="true" />;
}

export function Layers({ scene, session }: { readonly scene: DemoScene | null; readonly session: DemoSession }) {
  return <section class="layers" aria-labelledby="layers-heading">
    <h2 id="layers-heading" class="panel-heading">Layers</h2>
    {scene !== null && <div class="layer-list">
      <button class={`layer-row${scene.selected === null ? ' is-selected' : ''}`} type="button" aria-pressed={scene.selected === null} onClick={() => session.select(null)}>
        <Thumbnail scene={scene} bounds={{ x: 0, y: 0, ...scene.doc.frame.master.size }} />
        <span class="layer-name">Plate</span>
      </button>
      {scene.doc.objects.map((object) => <button key={object.id} class={`layer-row${scene.selected === object.id ? ' is-selected' : ''}`}
        type="button" aria-pressed={scene.selected === object.id} onClick={() => session.select(object.id)}>
        <Thumbnail scene={scene} bounds={object.produced.bounds} />
        <span class="layer-name">{object.name}</span>
      </button>)}
    </div>}
    {scene !== null && scene.doc.objects.length === 0 && <p class="layer-hint">Tap the picture to add a layer</p>}
  </section>;
}
