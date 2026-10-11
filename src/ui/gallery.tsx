import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Viewer, ViewerPiece, ViewerStatus } from '../session/viewer.ts';
import { Icon } from './icons.tsx';
import { installKeyTexture } from './key-texture.ts';

// The composition root supplies these capabilities; the UI never imports app or projects.
type ListedPiece = { readonly id: string; readonly publishedAt: string; readonly posterUrl: string; readonly width: number; readonly height: number };
export type GalleryUiContext = {
  readonly root: HTMLElement;
  readonly route: { readonly kind: 'list' } | { readonly kind: 'piece'; readonly id: string } | null;
  load(path: string, signal: AbortSignal): Promise<{
    readonly title: string; readonly posterUrl: string; loadPiece(signal: AbortSignal): Promise<ViewerPiece>;
  } | null>;
  createViewer(options: { canvas: HTMLCanvasElement; piece: ViewerPiece }): Viewer;
  readonly status: { set(value: ViewerStatus | { kind: 'unavailable'; message: string }): void };
  list(signal: AbortSignal): Promise<{ kind: 'listed'; pieces: readonly ListedPiece[] } | { kind: 'failed'; sentence: string }>;
  publishedHere(): readonly string[];
  unpublish(id: string): Promise<{ kind: 'unpublished' } | { kind: 'failed'; sentence: string }>;
  readonly editorUrl: string;
};
const timeLabel = (time: string): string => new Date(time).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function MakeOne({ href }: { readonly href: string }) {
  return <a class="primary-action gallery-key" href={href}><Icon name="open" />Make one</a>;
}

type ListState = { kind: 'loading' } | { kind: 'listed'; pieces: readonly ListedPiece[] } | { kind: 'failed'; sentence: string };
function Grid({ context, ready }: { readonly context: GalleryUiContext; readonly ready: () => void }) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [touch, setTouch] = useState(() => navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches);
  useLayoutEffect(() => {
    const query = matchMedia('(any-pointer: coarse)');
    const update = (): void => setTouch(navigator.maxTouchPoints > 0 || query.matches);
    query.addEventListener('change', update); addEventListener('resize', update);
    return () => { query.removeEventListener('change', update); removeEventListener('resize', update); };
  }, []);
  const [attempt, setAttempt] = useState(0);
  const grid = useRef<HTMLUListElement>(null);
  const [columnWidth, setColumnWidth] = useState(170);
  useLayoutEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    context.root.dataset['state'] = 'loading';
    void context.list(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.kind === 'listed' ? { kind: 'listed', pieces: [...result.pieces]
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 60) } : result);
      context.root.dataset['state'] = result.kind;
    }).catch(() => {
      if (!controller.signal.aborted) setState({ kind: 'failed', sentence: 'The gallery could not be reached. Try again.' });
    }).finally(ready);
    return () => controller.abort();
  }, [context, attempt]);
  useLayoutEffect(() => {
    const node = grid.current;
    if (node === null) return;
    const resize = (): void => {
      const columns = innerWidth >= 1440 ? 5 : innerWidth >= 1180 ? 4 : 2;
      const style = getComputedStyle(node);
      setColumnWidth((node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12 * (columns - 1)) / columns);
    };
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => observer.disconnect();
  }, [state.kind]);
  return <main class="gallery-page" aria-label="Gallery">
    <header class="gallery-strip"><div><h1>Gallery</h1>{state.kind === 'listed' && <span>{state.pieces.length} {state.pieces.length === 1 ? 'piece' : 'pieces'}</span>}</div>
      {!(state.kind === 'listed' && state.pieces.length === 0) && <MakeOne href={context.editorUrl} />}</header>
    {state.kind === 'loading' && <p class="gallery-message" data-testid="gallery-status" role="status">Opening gallery…</p>}
    {state.kind === 'failed' && <div class="gallery-message"><p data-testid="gallery-status" role="status">{state.sentence}</p><button type="button" onClick={() => setAttempt(attempt + 1)}>Retry</button></div>}
    {state.kind === 'listed' && (state.pieces.length === 0
      ? <div class="gallery-message" data-testid="gallery-empty"><p role="status">Nothing published yet</p><MakeOne href={context.editorUrl} /></div>
      : <><ul ref={grid} class="gallery-grid" data-testid="gallery-grid" aria-label="Published pieces">{state.pieces.map((piece) =>
        <li key={piece.id} style={{ gridRowEnd: `span ${Math.ceil(columnWidth * piece.height / piece.width + 34)}` }}>
          <a class="gallery-piece-link" data-testid="gallery-piece-link" href={`/gallery/${piece.id}`}>
            <img src={piece.posterUrl} width={piece.width} height={piece.height} loading="lazy" decoding="async" alt={`Published piece, ${timeLabel(piece.publishedAt)}`} />
            <time dateTime={piece.publishedAt}>{timeLabel(piece.publishedAt)}</time>
          </a>
        </li>)}</ul>
        <p class="gallery-hint">{touch ? 'Tap a piece to step into it. Tilt your phone to look around.' : 'Click a piece to step into it.'}</p></>)}
  </main>;
}

function Piece({ context, register, ready }: {
  readonly context: GalleryUiContext; readonly register: (viewer: Viewer | null) => void; readonly ready: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [poster, setPoster] = useState('');
  const [posterAspect, setPosterAspect] = useState(1);
  const [masterAspect, setMasterAspect] = useState<number | null>(null);
  const [sentence, setSentence] = useState('Opening piece…');
  const [failed, setFailed] = useState(false);
  const [live, setLive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const wantsPlay = useRef(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [touch, setTouch] = useState(() => navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse), (width < 744px)').matches);
  useLayoutEffect(() => {
    const query = matchMedia('(pointer: coarse), (width < 744px)');
    const update = (): void => setTouch(navigator.maxTouchPoints > 0 || query.matches);
    query.addEventListener('change', update); addEventListener('resize', update);
    return () => { query.removeEventListener('change', update); removeEventListener('resize', update); };
  }, []);
  const [tilt, setTilt] = useState<'waiting' | 'asking' | 'on' | 'off'>('waiting');
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const id = context.route?.kind === 'piece' ? context.route.id : null;
  const [owned, setOwned] = useState(() => id !== null && context.publishedHere().includes(id));
  useLayoutEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);
  useLayoutEffect(() => {
    const refresh = (): void => setOwned(id !== null && context.publishedHere().includes(id));
    addEventListener('storage', refresh); addEventListener('focus', refresh);
    return () => { removeEventListener('storage', refresh); removeEventListener('focus', refresh); };
  }, [context, id]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    let unsubscribe = (): void => {};
    let hasPoster = false;
    const fallback = (message: string, kind: string): void => {
      setFailed(true); setLive(false); setSentence(message);
      context.root.dataset['state'] = 'poster'; context.root.dataset['failure'] = kind;
    };
    const update = (): void => {
      const current = viewer.current;
      if (controller.signal.aborted || current === null) return;
      const state = current.status(); context.status.set(state);
      context.root.dataset['state'] = state.kind; context.root.dataset['input'] = current.input();
      setPlaying(state.kind === 'running');
      if (state.kind === 'failed') fallback(state.failure.message.includes('poster') ? state.failure.message : `${state.failure.message} Showing its poster.`, state.failure.kind);
      else if (state.kind === 'running') { setLive(true); setSentence(''); }
    };
    // Metadata does not delay playback. Older direct links may fall outside the public list.
    if (id !== null) void context.list(controller.signal).then((result) => {
      if (!controller.signal.aborted && result.kind === 'listed') setPublishedAt(result.pieces.find((piece) => piece.id === id)?.publishedAt ?? null);
    }).catch(() => {});
    const open = async (): Promise<void> => {
      try {
        context.status.set({ kind: 'loading' });
        const content = id === null ? null : await context.load(`/gallery/${id}`, controller.signal);
        if (controller.signal.aborted) return;
        if (content === null) {
          context.status.set({ kind: 'unavailable', message: 'This piece is not available.' });
          fallback('This piece is not available.', 'unavailable'); return;
        }
        document.title = `${content.title} · noisy`;
        hasPoster = true; setPoster(content.posterUrl);
        const piece = await content.loadPiece(controller.signal);
        if (controller.signal.aborted || canvas.current === null) return;
        const { width, height } = piece.document.frame.master.size;
        setMasterAspect(width / height);
        const current = context.createViewer({ canvas: canvas.current, piece });
        viewer.current = current; register(current); unsubscribe = current.subscribe(update);
        setPermissionNeeded(current.tiltNeedsPermission());
        // Reduced motion starts on the poster. Play is the explicit opt-in to the viewer clock.
        if (wantsPlay.current && document.visibilityState !== 'hidden') await current.start();
        else setSentence('Motion is paused.');
        update();
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'The live piece could not be opened.';
        const failure = typeof error === 'object' && error !== null && 'failure' in error ? error.failure : null;
        const kind = typeof failure === 'object' && failure !== null && 'kind' in failure && typeof failure.kind === 'string' ? failure.kind : 'render-failure';
        context.status.set({ kind: 'failed', failure: { kind: 'render-failure', message } });
        fallback(hasPoster ? `${message} Showing its poster.` : message, kind);
      } finally { ready(); }
    };
    void open();
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') viewer.current?.stop();
      else if (wantsPlay.current) void viewer.current?.start();
    };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = (): void => { if (reduced.matches) { wantsPlay.current = false; viewer.current?.stop(); } };
    const hide = (): void => viewer.current?.stop();
    document.addEventListener('visibilitychange', visibility);
    addEventListener('pagehide', hide); addEventListener('pageshow', visibility); reduced.addEventListener('change', reduce);
    return () => {
      controller.abort(); unsubscribe(); viewer.current?.dispose(); viewer.current = null; register(null);
      document.removeEventListener('visibilitychange', visibility);
      removeEventListener('pagehide', hide); removeEventListener('pageshow', visibility); reduced.removeEventListener('change', reduce);
    };
  }, [context, id]);
  const requestTilt = async (): Promise<void> => {
    if (viewer.current === null || tilt === 'asking' || tilt === 'on') return;
    setTilt('asking');
    const result = await viewer.current.requestTilt();
    setTilt(result === 'granted' ? 'on' : 'off');
  };
  const unpublish = async (): Promise<void> => {
    if (id === null || removing) return;
    setRemoving(true);
    try {
      const result = await context.unpublish(id);
      if (result.kind === 'unpublished') location.assign('/gallery');
      else { setSentence(result.sentence); setRemoving(false); }
    } catch { setSentence('The piece could not be unpublished. Try again.'); setRemoving(false); }
  };
  return <main class="gallery-piece" data-touch={touch} aria-label="Published piece">
    <header class="gallery-piece-top"><a class="icon-button" href="/gallery" data-testid="gallery-back" aria-label="All pieces" title="All pieces"><Icon name="back" /></a>
      {publishedAt !== null && <time dateTime={publishedAt}>{timeLabel(publishedAt)}</time>}
      {owned && <button ref={removeButton} class="gallery-remove" type="button" data-testid="gallery-unpublish" onClick={() => setConfirm(true)}>Unpublish</button>}
    </header>
    <div class="gallery-piece-stage">
      <div class="gallery-picture" style={{ '--piece-aspect': masterAspect ?? posterAspect }}>
        <img class="gallery-media" data-testid="gallery-poster" src={poster || undefined} hidden={!poster || live} alt="Published piece"
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) setPosterAspect(image.naturalWidth / image.naturalHeight);
          }} />
        <canvas ref={canvas} class="gallery-media" data-testid="gallery-canvas" hidden={failed} style={{ visibility: live ? 'visible' : 'hidden' }} role="img" aria-label="Live published piece" />
      </div>
      <p class="gallery-piece-status" data-testid="gallery-status" role="status" hidden={!sentence}>{sentence}</p>
    </div>
    {confirm && <section class="gallery-confirm" aria-label="Unpublish piece" onKeyDown={(event) => {
      if (event.key === 'Escape' && !removing) { setConfirm(false); removeButton.current?.focus(); }
    }}><p>Remove this piece from the gallery?</p><div><button ref={confirmButton} type="button" disabled={removing} onClick={() => { void unpublish(); }}>{removing ? 'Unpublishing…' : 'Unpublish'}</button>
      <button type="button" disabled={removing} onClick={() => { setConfirm(false); removeButton.current?.focus(); }}>Cancel</button></div></section>}
    <div class="gallery-piece-controls">
      {!failed && <button class={tilt === 'on' || tilt === 'off' ? 'gallery-tilt-state' : 'primary-action'} type="button" data-testid="gallery-tilt"
        hidden={!touch && !permissionNeeded} disabled={tilt === 'asking' || viewer.current === null} aria-pressed={tilt === 'on'} onClick={() => { void requestTilt(); }}>
        <Icon name="parallax" />{tilt === 'on' ? 'Tilt on' : tilt === 'off' ? 'Tilt is off on this device' : tilt === 'asking' ? 'Waiting for permission…' : 'Tilt to look'}</button>}
      {!touch && <MakeOne href={context.editorUrl} />}
      {!failed && <button type="button" data-testid="gallery-play" disabled={viewer.current === null} aria-pressed={playing} onClick={() => {
        wantsPlay.current = !playing;
        if (playing) viewer.current?.stop(); else void viewer.current?.start();
      }}><Icon name="motion" />{playing ? 'Pause Motion' : 'Play Motion'}</button>}
    </div>
  </main>;
}

export function mountGalleryUi(context: GalleryUiContext): { ready: Promise<void>; viewer(): Viewer | null; dispose(): void } {
  if (document.querySelector('link[href="/assets-static/app.css"]') === null) {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/assets-static/app.css';
    document.head.append(style);
  }
  installKeyTexture();
  context.root.dataset['testid'] = 'gallery';
  delete context.root.dataset['failure']; delete context.root.dataset['input'];
  context.root.dataset['state'] = 'loading';
  let viewer: Viewer | null = null;
  let resolve = (): void => {};
  const ready = new Promise<void>((done) => { resolve = done; });
  render(context.route?.kind === 'list' ? <Grid context={context} ready={resolve} />
    : <Piece context={context} ready={resolve} register={(next) => { viewer = next; }} />, context.root);
  return { ready, viewer: () => viewer, dispose() { render(null, context.root); resolve(); } };
}
