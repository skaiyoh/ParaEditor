import { BlobSource, CanvasSource, EncodedPacketSink, getFirstEncodableVideoCodec, Input, MP4, Mp4OutputFormat, Output, Quality, StreamTarget, WEBM, WebMOutputFormat } from 'mediabunny';
import { createMovieFile, MOVIE_BYTE_LIMIT } from './movie-file.ts';

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

/** Encode each rendered frame with exact timing, applying backpressure before rendering another. */
export async function recordLoopMovie({ canvas, frames, render, fps, format, signal, progress }: {
  readonly canvas: HTMLCanvasElement; readonly frames: number; readonly render: (frame: number) => void;
  readonly fps: number; readonly format: MovieFormat; readonly signal: AbortSignal;
  readonly progress: (completed: number) => void;
}): Promise<Blob> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('The movie timing is invalid.');
  const quality = new Quality({ bitrate: 8_000_000 });
  const codec = await getFirstEncodableVideoCodec(format.extension === 'mp4' ? ['avc'] : ['vp9', 'vp8'],
    { width: canvas.width, height: canvas.height, frameRate: fps, quality });
  signal.throwIfAborted();
  if (codec === null) {
    // Keep MediaRecorder-only browsers supported without retaining noisy, lossless PNGs.
    const prepared: Blob[] = [];
    let bytes = 0;
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted(); render(frame);
      const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
        if (value === null) reject(new Error('A movie frame could not be prepared.')); else resolve(value);
      }, 'image/jpeg', .92));
      signal.throwIfAborted(); bytes += image.size;
      if (bytes > MOVIE_BYTE_LIMIT) throw new Error('This movie needs too much memory; shorten the loop and try again.');
      prepared.push(image); progress(frame + 1);
      await exportWait(0, signal);
    }
    return recordMovie({ canvas, frames: prepared, fps, format, signal, progress });
  }
  const file = createMovieFile();
  const output = new Output({ target: new StreamTarget(file.stream),
    format: format.extension === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat() });
  let encodedFrames = 0;
  const source = new CanvasSource(canvas, { codec, quality, latencyMode: 'quality', alpha: 'discard',
    onEncodedPacket() { encodedFrames++; } });
  output.addVideoTrack(source, { frameRate: fps });
  const aborted = () => { void output.cancel().catch(() => undefined); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted(); await output.start();
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted(); render(frame);
      await source.add(frame / fps, 1 / fps);
      signal.throwIfAborted(); progress(frame + 1);
      await exportWait(0, signal);
    }
    await output.finalize(); signal.throwIfAborted();
    if (encodedFrames !== frames) throw new Error('The browser could not encode every movie frame; try Export again.');
    return file.blob(`video/${format.extension}`);
  } finally {
    signal.removeEventListener('abort', aborted);
    if (output.state !== 'finalized') await output.cancel();
  }
}

/** Compatibility recorder for prepared frames on browsers without a suitable WebCodecs encoder. */
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
  let bytes = 0;
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
    active.ondataavailable = ({ data }) => {
      bytes += data.size;
      if (bytes > MOVIE_BYTE_LIMIT) {
        failure = new Error('This movie needs too much memory; shorten the loop and try again.');
        if (active.state !== 'inactive') active.stop();
      } else if (data.size > 0) chunks.push(data);
    };
    active.onerror = () => { failure = new Error('The browser could not record the movie.'); };
    signal.addEventListener('abort', aborted, { once: true });
    // Chromium may wait for encoded data before emitting start: submit frame zero immediately.
    const stopped = waitEvent(active, 'stop', () => active.start(250));
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
      if (due > index) throw new Error('The browser could not record every movie frame; try Export again.');
      for (let ahead = index; ahead < index + 3; ahead++) prepare(ahead);
      const pending = queue.get(index);
      if (pending === undefined) throw new Error('A movie frame is missing.');
      const ready = await Promise.race([pending.then(() => true), stopped.then(() => false)]);
      signal.throwIfAborted();
      if (!ready || active.state === 'inactive') throw new Error('The browser could not record every movie frame; try Export again.');
      const afterDecode = Math.floor((performance.now() - origin) * fps / 1000);
      if (afterDecode > index) throw new Error('The browser could not record every movie frame; try Export again.');
      await draw(index); progress(index + 1); index++;
    }
    await stopped; signal.throwIfAborted();
    if (failure !== null) throw failure;
    const blob = new Blob(chunks, { type: active.mimeType });
    if (blob.size === 0) throw new Error('The browser returned an empty movie.');
    // Canvas capture can lose frames inside the browser even when every draw met its deadline.
    const input = new Input({ source: new BlobSource(blob), formats: [MP4, WEBM] });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (video === null) throw new Error('The movie has no video track.');
      let count = 0;
      for await (const _packet of new EncodedPacketSink(video).packets(undefined, undefined, { metadataOnly: true })) {
        signal.throwIfAborted(); count++;
      }
      if (count !== frames.length) throw new Error('The browser could not record every movie frame; try Export again.');
    } finally { input.dispose(); }
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
