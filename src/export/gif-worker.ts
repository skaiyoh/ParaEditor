import { finishGif, gifDelay, gifFrame, gifHeader, gifRequestSchema } from './gif.ts';

let job: { width: number; height: number; frames: number; fps: number; completed: number; parts: Uint8Array[] } | null = null;
self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const request = gifRequestSchema.parse(event.data);
    switch (request.kind) {
      case 'start':
        job = { ...request, completed: 0, parts: [gifHeader(request.width, request.height)] };
        self.postMessage({ kind: 'ready' }); break;
      case 'frame': {
        if (job === null || job.completed >= job.frames || request.pixels.width !== job.width || request.pixels.height !== job.height) throw new Error('The GIF frame does not match this loop.');
        job.parts.push(gifFrame(job.width, job.height, request.pixels.data, gifDelay(job.completed, job.fps)));
        job.completed++;
        self.postMessage({ kind: 'progress', completed: job.completed }); break;
      }
      case 'finish': {
        if (job === null || job.completed !== job.frames) throw new Error('The GIF loop is incomplete.');
        const bytes = finishGif(job.parts); job = null;
        self.postMessage({ kind: 'done', bytes }, [bytes.buffer]); break;
      }
    }
  } catch (error) {
    job = null;
    self.postMessage({ kind: 'failed', detail: error instanceof Error ? error.message : 'The GIF could not be encoded.' });
  }
};
