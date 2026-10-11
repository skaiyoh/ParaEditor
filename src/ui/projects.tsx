import { useLayoutEffect, useState } from 'preact/hooks';
import type { SceneId } from '../core/ids.ts';
import type { DemoSession } from '../session/scene.ts';

function savedTime(at: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(at));
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function Projects({ session, onOpened, onImport, onSample, importLabel = 'Open', status }: {
  readonly session: DemoSession; readonly onOpened: () => void;
  readonly onImport: () => void; readonly onSample: () => void;
  readonly importLabel?: string; readonly status?: string;
}) {
  const [state, setState] = useState(session.projects.snapshot());
  const [now, setNow] = useState(Date.now());
  const [working, setWorking] = useState<SceneId | null>(null);
  useLayoutEffect(() => {
    const unsubscribe = session.projects.subscribe(setState);
    void session.projects.refresh();
    const timer = setInterval(() => { setNow(Date.now()); void session.projects.refresh(); }, 15_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [session]);
  const open = async (id: SceneId): Promise<void> => {
    setWorking(id);
    if (await session.openProject(id)) onOpened();
    setWorking(null);
  };
  const currentDeletion = state.deletions.find((deletion) => deletion.id === state.current);
  const currentState = state.current === null ? undefined : state.states.get(state.current);
  const feedback = state.state === 'absent' ? 'No project store on this server'
    : state.error === 'list' ? 'Projects could not be refreshed.'
    : state.error === 'open' ? 'Project could not be opened.'
    : currentDeletion?.phase === 'undoable' || currentDeletion?.phase === 'deleting' ? 'Deletion pending.'
    : currentState === 'failed' ? 'Current photo not saved.'
    : state.state === 'saving' && state.current === null ? 'Preparing photo…'
    : currentState === 'saving' || state.state === 'saving' ? 'Saving current photo…'
    : currentState === 'saved' ? 'Current photo saved.'
    : state.projects.length === 0 ? 'No projects yet' : 'Choose a project to open.';
  return <section class="projects-panel" data-testid="projects-panel" aria-label="Projects" aria-busy={working !== null}>
    <div class="projects-heading"><h2 class="scope-heading">Projects</h2>
      <button type="button" data-testid="scenes-open" title="Open prepared 3D scenes in a new tab"
        onClick={() => { window.open('/scenes.html', '_blank', 'noopener'); }}>3D scenes</button>
      <button type="button" data-testid="projects-return" onClick={onOpened}>Return to editor</button>
    </div>
    <p class="projects-state" data-testid="projects-state" role="status">
      {feedback}
    </p>
    {state.deletions.map((deletion) => <div key={deletion.id} class="project-notice" data-testid="project-deletion" data-project-id={deletion.id} data-phase={deletion.phase}>
      <p role="status">{deletion.phase === 'undoable' || deletion.phase === 'deleted' ? `Deleted ${deletion.name}.`
        : deletion.phase === 'deleting' ? `Deleting ${deletion.name}…`
        : deletion.phase === 'restored' ? `Restored ${deletion.name}.`
        : deletion.phase === 'failed' ? `Could not delete ${deletion.name}. Project restored.`
        : `Deletion of ${deletion.name} could not be confirmed.`}</p>
      {deletion.phase === 'undoable' && <button type="button" data-testid="project-undo" aria-label={`Undo deletion of ${deletion.name}`}
        onClick={() => session.projects.undoRemove(deletion.id)}>Undo</button>}
      {(deletion.phase === 'failed' || deletion.phase === 'unconfirmed') && <button type="button" data-testid="project-delete-retry"
        onClick={() => session.projects.requestRemove(deletion.id)}>Retry</button>}
      {(deletion.phase === 'restored' || deletion.phase === 'deleted') && <button type="button" aria-label={`Dismiss message for ${deletion.name}`}
        onClick={() => session.projects.dismissDeletion(deletion.id)}>Dismiss</button>}
    </div>)}
    <div class="layer-list projects-list">
      {state.projects.map((project) => <div key={project.id} class={`layer-row project-row${state.current === project.id ? ' is-selected' : ''}`}
        data-testid="project-row" data-project-id={project.id}>
        <button class="project-open" type="button" aria-pressed={state.current === project.id}
          disabled={working !== null || state.deletions.some((deletion) => deletion.id === project.id && deletion.phase === 'unconfirmed')}
          onClick={() => { void open(project.id); }}>
          {state.thumbnails.has(project.id) ? <img class="layer-thumbnail" src={`${project.thumbnail}?v=${encodeURIComponent(project.updatedAt)}`} width="48" height="48" alt="" loading="lazy" /> : <span class="layer-thumbnail" aria-hidden="true" />}
          <span class="project-copy"><span class="layer-name" title={project.name}>{project.name}</span>
            <span class="project-time">{state.states.get(project.id) === 'failed' ? 'Not saved' : state.states.get(project.id) === 'saving' ? 'Saving…' : savedTime(project.updatedAt, now)}</span>
          </span>
        </button>
        <button type="button" class="project-delete" data-testid="project-delete" disabled={working !== null}
          aria-label={`Delete ${project.name}`} onClick={() => session.projects.requestRemove(project.id)}>
          Delete
        </button>
      </div>)}
      {state.projects.length === 0 && state.state !== 'absent' && <div class="projects-empty">
        <p class="layer-hint">{importLabel === 'Take a photo' ? 'Take a photo or try a sample to start a project.' : 'Open a photo or try a sample to start a project.'}</p>
        <div class="empty-actions"><button type="button" onClick={onImport}>{importLabel}</button><button type="button" onClick={onSample}>Try a sample</button></div>
      </div>}
    </div>
    {status !== undefined && <p class="projects-editor-status status-line" data-testid="status" role="status">{status}</p>}
  </section>;
}
