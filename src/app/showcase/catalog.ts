import { createLandscapeRenderer } from './landscape-render.ts';
import { landscapeMatrix, landscapeWindow, loadLandscape, parseLandscapeMesh, type LandscapeMesh } from './landscape.ts';
import { loadImportedScene } from '../scene-store.ts';
import { createShowcaseRenderer } from './render.ts';
import { loadScene, project, viewMatrix, windowProjection, type Eye } from './scene.ts';

export type SceneId = 'highland-field' | 'lantern-court' | `imported:${string}`;
export type SceneSummary = Readonly<{ id: SceneId; title: string; poster: string; description: string }>;
export function isSceneId(id: string): id is SceneId {
  return id === 'highland-field' || id === 'lantern-court' || (id.startsWith('imported:') && id.length > 9);
}
export const scenes = [
  { id: 'highland-field', title: 'Highland Field', poster: '/assets-static/scenes/highland-field/highland-field.png', description: 'Lean to look past the foreground stones.' },
  { id: 'lantern-court', title: 'Lantern Court', poster: '/assets-static/scenes/lantern-court/lantern-court.png', description: 'Lean to look through the courtyard opening.' },
] satisfies readonly SceneSummary[];

export type PreparedView = Readonly<{
  aspect: number | null;
  travel: Eye;
  draw(eye: Eye): void;
  dispose(): void;
  metrics(): { triangles: number; drawCount: number; submissionMs: number; width: number; height: number; actualGeometry: boolean; depthReferences: number };
  inspect(eye: Eye): { window: ReturnType<typeof windowProjection>; landmarks: { lantern: ReturnType<typeof project>; pavilion: ReturnType<typeof project> } };
  visibility?: (eye: Eye) => readonly { id: number; name: string; pixels: number }[];
}>;

/** Two authored lighting paths share one viewer and input lifecycle. */
export async function openPreparedView(id: SceneId, canvas: HTMLCanvasElement, signal: AbortSignal): Promise<PreparedView> {
  if (id.startsWith('imported:')) {
    const pkg = await loadImportedScene(id.slice(9)); signal.throwIfAborted();
    if (pkg === null) throw new Error('This scene is no longer stored on this device. Upload its .noisyscene file again.');
    return openLandscapeView(canvas, parseLandscapeMesh(pkg.field, pkg.mesh));
  }
  const base = new URL(`/assets-static/scenes/${id}/`, location.origin);
  if (id === 'highland-field') {
    const mesh = await loadLandscape(base, signal); signal.throwIfAborted();
    return openLandscapeView(canvas, mesh);
  }
  const { scene, vertices } = await loadScene(base, signal); signal.throwIfAborted();
  const renderer = await createShowcaseRenderer(canvas, scene, vertices, base, signal);
  if (signal.aborted) { renderer.dispose(); signal.throwIfAborted(); }
  return { ...renderer, aspect: scene.size[0] / scene.size[1], travel: { x: scene.camera.travel[0], y: scene.camera.travel[1] },
    inspect: eye => ({ window: windowProjection(scene, eye), landmarks: {
      lantern: project(viewMatrix(scene, eye), scene.landmarks.lantern), pavilion: project(viewMatrix(scene, eye), scene.landmarks.pavilion) } }) };
}

function openLandscapeView(canvas: HTMLCanvasElement, mesh: LandscapeMesh): PreparedView {
  const near = mesh.scene.objects.find(object => object.kind === 1), far = mesh.scene.objects.find(object => object.kind === 3);
  if (near === undefined || far === undefined) throw new Error('The landscape depth landmarks are missing.');
  const renderer = createLandscapeRenderer(canvas, mesh);
  return { ...renderer, aspect: null, travel: { x: mesh.scene.travel.x, y: mesh.scene.travel.z },
    inspect: eye => { const aspect = canvas.width / canvas.height, matrix = landscapeMatrix(mesh.scene, eye, aspect);
      return { window: landscapeWindow(mesh.scene, eye, aspect), landmarks: { lantern: project(matrix, near.center), pavilion: project(matrix, far.center) } }; } };
}
