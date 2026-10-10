export type MovieFormat = { readonly mime: string; readonly extension: 'mp4' | 'webm'; readonly label: string };

export function movieFormat(): MovieFormat | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  // Safari's native movie is MP4; Chromium's native capture is WebM.
  const safari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
  const mp4 = [{ mime: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', label: 'MP4' }, { mime: 'video/mp4', extension: 'mp4', label: 'MP4' }] satisfies MovieFormat[];
  const webm = [{ mime: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM' }, { mime: 'video/webm;codecs=vp8', extension: 'webm', label: 'WebM' }, { mime: 'video/webm', extension: 'webm', label: 'WebM' }] satisfies MovieFormat[];
  return (safari ? [...mp4, ...webm] : [...webm, ...mp4]).find(({ mime }) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

export function exportWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Preparation holds compressed PNGs, never a period of uncompressed 1080p frames. */
export async function recordMovie({ canvas, frames, fps, format, signal, progress }: {
  readonly canvas: HTMLCanvasElement; readonly frames: readonly Blob[]; readonly fps: number;
  readonly format: MovieFormat; readonly signal: AbortSignal; readonly progress: (completed: number) => void;
}): Promise<Blob> {
  signal.throwIfAborted();
  if (frames.length === 0) throw new Error('The movie has no frames.');
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new Error('The movie canvas could not be created.');
  let stream: MediaStream | null = null;
  let requestFrame: (() => unknown) | null = null;
  let recorder: MediaRecorder | null = null;
  let periodTimer: ReturnType<typeof setTimeout> | null = null;
  const queue = new Map<number, Promise<ImageBitmap>>();
  const chunks: Blob[] = [];
  let failure: unknown = null;
  const aborted = () => { if (recorder !== null && recorder.state !== 'inactive') recorder.stop(); };
  const waitEvent = (target: EventTarget, event: string, start: () => void) => new Promise<void>((resolve, reject) => {
    const clear = () => { clearTimeout(timer); target.removeEventListener(event, done); signal.removeEventListener('abort', abort); };
    const done = () => { clear(); resolve(); };
    const abort = () => { clear(); reject(signal.reason); };
    const timer = setTimeout(() => { clear(); reject(new Error(`The movie recorder did not ${event}.`)); }, 10_000);
    target.addEventListener(event, done, { once: true }); signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); start(); } catch (error) { clear(); reject(error); }
  });
  const prepare = (index: number) => {
    const frame = frames[index];
    if (frame === undefined || queue.has(index)) return;
    const pending = createImageBitmap(frame); queue.set(index, pending);
    void pending.catch(() => undefined);
  };
  const draw = async (index: number) => {
    const pending = queue.get(index);
    if (pending === undefined) throw new Error('A movie frame is missing.');
    const bitmap = await pending;
    signal.throwIfAborted(); context.drawImage(bitmap, 0, 0); bitmap.close(); queue.delete(index);
    requestFrame?.(); prepare(index + 3);
  };
  try {
    for (let index = 0; index < Math.min(3, frames.length); index++) prepare(index);
    await Promise.all(queue.values()); signal.throwIfAborted();
    const first = queue.get(0);
    if (first === undefined) throw new Error('The movie has no first frame.');
    // Seed frame zero before captureStream can sample its initial canvas image.
    context.drawImage(await first, 0, 0);
    stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (track !== undefined && 'requestFrame' in track && typeof track.requestFrame === 'function') {
      const captureFrame = track.requestFrame;
      requestFrame = () => captureFrame.call(track);
    } else {
      for (const oldTrack of stream.getTracks()) oldTrack.stop();
      stream = canvas.captureStream(fps);
    }
    recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 8_000_000 });
    const active = recorder;
    active.ondataavailable = ({ data }) => { if (data.size > 0) chunks.push(data); };
    active.onerror = () => { failure = new Error('The browser could not record the movie.'); };
    signal.addEventListener('abort', aborted, { once: true });
    // Chromium may wait for encoded data before emitting start: submit frame zero immediately.
    const stopped = waitEvent(active, 'stop', () => active.start());
    void stopped.catch(() => undefined);
    const origin = performance.now();
    // A decode can remain pending past the period, so stopping cannot depend on it.
    periodTimer = setTimeout(() => { if (active.state !== 'inactive') active.stop(); }, frames.length * 1000 / fps);
    const deadline = async (index: number) => {
      const at = origin + index * 1000 / fps;
      await exportWait(Math.max(0, at - performance.now()), signal);
      if (failure !== null) throw failure;
    };
    await draw(0); progress(1);
    let index = 1;
    while (index < frames.length) {
      await deadline(index);
      const due = Math.max(index, Math.floor((performance.now() - origin) * fps / 1000));
      if (due >= frames.length) break;
      index = due;
      // A slow browser skips to the current loop time instead of stretching the period.
      for (const [oldIndex, pending] of queue) if (oldIndex < index) {
        queue.delete(oldIndex); void pending.then((bitmap) => bitmap.close(), () => undefined);
      }
      for (let ahead = index; ahead < index + 3; ahead++) prepare(ahead);
      const pending = queue.get(index);
      if (pending === undefined) throw new Error('A movie frame is missing.');
      const ready = await Promise.race([pending.then(() => true), stopped.then(() => false)]);
      signal.throwIfAborted();
      if (!ready || active.state === 'inactive') break;
      const afterDecode = Math.floor((performance.now() - origin) * fps / 1000);
      if (afterDecode > index) { index = afterDecode; continue; }
      await draw(index); progress(index + 1); index++;
    }
    await stopped; signal.throwIfAborted();
    if (failure !== null) throw failure;
    const blob = new Blob(chunks, { type: active.mimeType });
    if (blob.size === 0) throw new Error('The browser returned an empty movie.');
    return blob;
  } finally {
    if (periodTimer !== null) clearTimeout(periodTimer);
    signal.removeEventListener('abort', aborted);
    if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
    for (const track of stream?.getTracks() ?? []) track.stop();
    for (const pending of queue.values()) void pending.then((bitmap) => bitmap.close(), () => undefined);
    queue.clear();
  }
}
