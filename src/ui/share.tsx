import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DemoSession } from '../session/scene.ts';
import { Icon } from './icons.tsx';

type Published = Extract<Awaited<ReturnType<DemoSession['gallery']['publish']>>, { kind: 'published' }>;
type ShareState = { kind: 'idle' } | { kind: 'publishing' } | { kind: 'published'; piece: Published } | { kind: 'unpublishing'; piece: Published };

export function Share({ session, onNotice, onStatus }: {
  readonly session: DemoSession;
  readonly onNotice: (sentence: string | null) => void;
  readonly onStatus: (sentence: string | null) => void;
}) {
  const [availability, setAvailability] = useState(session.gallery.canPublish());
  const [state, setState] = useState<ShareState>({ kind: 'idle' });
  const [confirmation, setConfirmation] = useState<'publish' | 'unpublish' | null>(null);
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const busy = state.kind === 'publishing' || state.kind === 'unpublishing';
  const piece = state.kind === 'published' || state.kind === 'unpublishing' ? state.piece : null;
  useLayoutEffect(() => {
    mounted.current = true;
    const unsubscribe = session.subscribe(() => setAvailability(session.gallery.canPublish()));
    return () => { mounted.current = false; controller.current?.abort(); unsubscribe(); onNotice(null); };
  }, [session]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (confirmation !== null && node !== null && !node.open) node.showModal();
  }, [confirmation]);
  const close = (): void => { dialog.current?.close(); setConfirmation(null); opener.current?.focus(); };
  const publish = async (): Promise<void> => {
    if (controller.current !== null) return;
    const available = session.gallery.canPublish();
    if (available.kind !== 'ready') { onStatus(available.sentence); close(); return; }
    close(); setState({ kind: 'publishing' }); setCopied(false); onStatus(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await session.gallery.publish({ signal: abort.signal, onProgress(progress) {
        if (mounted.current) onNotice(`${progress.sentence} ${progress.completed} of ${progress.total}.`);
      } });
      if (!mounted.current) return;
      if (result.kind === 'published') { setState({ kind: 'published', piece: result }); onStatus(result.sentence); }
      else { setState({ kind: 'idle' }); onStatus(result.sentence); }
    } catch {
      if (mounted.current) { setState({ kind: 'idle' }); onStatus('The piece could not be published. Try again.'); }
    } finally {
      controller.current = null;
      if (mounted.current) { onNotice(null); setAvailability(session.gallery.canPublish()); }
    }
  };
  const unpublish = async (): Promise<void> => {
    if (state.kind !== 'published') return;
    const current = state.piece;
    close(); setState({ kind: 'unpublishing', piece: current });
    try {
      const result = await session.gallery.unpublish(current.id);
      if (!mounted.current) return;
      if (result.kind === 'unpublished') { setState({ kind: 'idle' }); onStatus('The piece was unpublished.'); }
      else { setState({ kind: 'published', piece: current }); onStatus(result.sentence); }
    } catch {
      if (mounted.current) { setState({ kind: 'published', piece: current }); onStatus('The piece could not be unpublished. Try again.'); }
    }
  };
  const copy = async (): Promise<void> => {
    if (piece === null) return;
    try {
      await navigator.clipboard.writeText(new URL(piece.url, location.href).href);
      if (mounted.current) { setCopied(true); onStatus('Link copied.'); }
    } catch { if (mounted.current) onStatus('The link could not be copied. Select the piece link to copy it.'); }
  };
  return <section class="share-group" aria-labelledby="share-heading">
    <h3 class="panel-heading" id="share-heading">Share</h3>
    {piece === null ? <>
      <button type="button" data-testid="share-publish" disabled={availability.kind !== 'ready' || busy}
        aria-describedby={availability.kind === 'unavailable' ? 'share-availability' : undefined}
        onClick={(event) => { opener.current = event.currentTarget; setConfirmation('publish'); }}><Icon name="share" />{state.kind === 'publishing' ? 'Publishing…' : 'Publish'}</button>
      {availability.kind === 'unavailable' && <p class="share-sentence" id="share-availability">{availability.sentence}</p>}
    </> : <>
      <a class="share-piece-link" data-testid="share-link" href={piece.url}><Icon name="link" /><span>{new URL(piece.url, location.href).href}</span></a>
      <div class="share-actions"><button type="button" onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy link'}</button>
        <button type="button" data-testid="share-unpublish" disabled={busy} onClick={(event) => {
          opener.current = event.currentTarget; setConfirmation('unpublish');
        }}>{state.kind === 'unpublishing' ? 'Unpublishing…' : 'Unpublish'}</button></div>
    </>}
    {state.kind === 'publishing' && <button type="button" onClick={() => controller.current?.abort()}>Cancel publishing</button>}
    <a class="share-gallery-link" href="/gallery"><Icon name="projects" />Open gallery</a>
    {confirmation !== null && <dialog class="share-confirm" ref={dialog} data-testid="share-confirm" aria-label={confirmation === 'unpublish' ? 'Unpublish piece' : 'Publish piece'}
      onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => setConfirmation(null)}>
      <p>{confirmation === 'unpublish' ? 'Remove this piece from the gallery?' : 'Anyone can see this at nathan.fish/gallery.'}</p>
      <div><button class="primary-action" type="button" onClick={() => { if (confirmation === 'unpublish') void unpublish(); else void publish(); }}>
        {confirmation === 'unpublish' ? 'Unpublish' : 'Publish'}</button><button type="button" onClick={close}>Cancel</button></div>
    </dialog>}
  </section>;
}
