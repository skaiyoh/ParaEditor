import { useLayoutEffect, useState } from 'preact/hooks';
import type { SceneId } from '../core/ids.ts';
import type { DemoSession } from '../session/scene.ts';

function savedTime(at: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(at));
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function Projects({ session, onOpened }: { readonly session: DemoSession; readonly onOpened: () => void }) {
  const [state, setState] = useState(session.projects.snapshot());
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState<SceneId | null>(null);
  const [working, setWorking] = useState<SceneId | null>(null);
  useLayoutEffect(() => {
    const unsubscribe = session.projects.subscribe(setState);
    void session.projects.refresh();
    const timer = setInterval(() => { setNow(Date.now()); void session.projects.refresh(); }, 15_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [session]);
  useLayoutEffect(() => {
    if (confirm === null) return;
    const timer = setTimeout(() => setConfirm(null), 3000);
    return () => clearTimeout(timer);
  }, [confirm]);
  const open = async (id: SceneId): Promise<void> => {
    setWorking(id);
    if (await session.openProject(id)) onOpened();
    setWorking(null);
  };
  const remove = async (id: SceneId): Promise<void> => {
    if (confirm !== id) { setConfirm(id); return; }
    setConfirm(null); setWorking(id);
    await session.projects.remove(id);
    setWorking(null);
  };
  return <section class="projects-panel" data-testid="projects-panel" aria-label="Projects" aria-busy={working !== null}>
    <p class="scope-heading projects-state" data-testid="projects-state" aria-live="polite">
      {state.state === 'absent' ? 'No project store on this server' : state.state === 'failed' ? 'Not saved' : state.state === 'saving' ? 'Saving…' : 'Saved just now'}
    </p>
    <div class="layer-list projects-list">
      {state.projects.map((project) => <div key={project.id} class={`layer-row project-row${state.current === project.id ? ' is-selected' : ''}`}
        data-testid="project-row" data-project-id={project.id}>
        <button class="project-open" type="button" aria-pressed={state.current === project.id} disabled={working !== null}
          onClick={() => { void open(project.id); }}>
          {state.thumbnails.has(project.id) ? <img class="layer-thumbnail" src={`${project.thumbnail}?v=${encodeURIComponent(project.updatedAt)}`} width="48" height="48" alt="" loading="lazy" /> : <span class="layer-thumbnail" aria-hidden="true" />}
          <span class="project-copy"><span class="layer-name" title={project.name}>{project.name}</span>
            <span class="project-time">{state.states.get(project.id) === 'failed' ? 'Not saved' : savedTime(project.updatedAt, now)}</span>
          </span>
        </button>
        <button type="button" class="project-delete" data-testid="project-delete" disabled={working !== null}
          aria-label={`${confirm === project.id ? 'Really delete' : 'Delete'} ${project.name}`} onClick={() => { void remove(project.id); }}>
          {confirm === project.id ? 'Really delete' : 'Delete'}
        </button>
      </div>)}
      {state.projects.length === 0 && state.state !== 'absent' && <p class="layer-hint">No projects yet</p>}
    </div>
  </section>;
}
