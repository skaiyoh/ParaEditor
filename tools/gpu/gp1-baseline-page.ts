/// <reference path="../../src/app-env.d.ts" />
/// <reference path="../../src/build-env.d.ts" />
// Temporary browser capture using the production analysis service and real workers.
import { z } from '../../src/core/zod.ts';
import { bundledLock } from '../../src/analysis/bundled-lock.ts';
import { openModelLoader, webLocks } from '../../src/analysis/models.ts';
import { createAnalysisService, type AnalysisEvent } from '../../src/analysis/service.ts';
import { parseSequenceReply, parseDecodeReply, type SamEmbeddings, type HeavyStage } from '../../src/analysis/protocol.ts';
import { isSceneId, type NonEmpty } from '../../src/core/ids.ts';
import type { Plane, Rgb8 } from '../../src/core/raster.ts';
import { createBrowserClock } from '../../src/platform/clock.ts';
import { createDiagnostics } from '../../src/platform/diagnostics.ts';

const Photo = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), width: z.int().min(2).max(2048), height: z.int().min(2).max(2048), subjects: z.array(z.object({ id: z.string(), point: z.tuple([z.number(), z.number()]), box: z.tuple([z.number(), z.number(), z.number(), z.number()]) })).min(1).max(3) });
export const CaptureFile = z.object({ name: z.string(), file: z.string(), bytes: z.int(), sha256: z.string() });
export const CaptureResult = z.object({ id: z.string(), files: z.array(CaptureFile) });
declare global { interface Window { __gp1Capture?: (photo: unknown) => Promise<z.infer<typeof CaptureResult>> } }

window.__gp1Capture = async (value) => {
  const photo = Photo.parse(value), clock = createBrowserClock(window);
  const lock = bundledLock(); if (!lock.ok) throw new Error(lock.error);
  const diag = createDiagnostics<AnalysisEvent>(clock, 5000), workerTimings: unknown[] = [];
  const spawn = (kind: 'sequence' | 'decode'): Worker => {
    const worker = new Worker(NOISY_WORKER_URLS[kind], { type: 'module', name: `gp1-${kind}` });
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const reply = kind === 'sequence' ? parseSequenceReply(event.data) : parseDecodeReply(event.data);
      if (reply.ok && 'timings' in reply.value) workerTimings.push({ stage: reply.value.type, timings: reply.value.timings });
    }); return worker;
  };
  const loader = openModelLoader({ lock: lock.value, origin: location.origin, caches, fetch: (url, init) => fetch(url, init), subtle: crypto.subtle, locks: webLocks(navigator.locks), clock });
  const service = createAnalysisService({ clock, diag, spawn: () => spawn('sequence'), spawnDecoder: () => spawn('decode'), ortBase: NOISY_ORT_DIR, threads: Math.max(2, Math.min(8, Math.floor(navigator.hardwareConcurrency || 2))), lock: lock.value, loader });
  const begin = performance.now(), signal = new AbortController().signal;
  const fetched = await service.fetchModels(['depth', 'encode', 'decode', 'inpaint'], signal, () => undefined);
  if (!fetched.ok) throw new Error(JSON.stringify(fetched.error));
  const fetchedMs = performance.now() - begin;
  const blob = await (await fetch(`/gp1/masters/${photo.id}.png`)).blob();
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width !== photo.width || bitmap.height !== photo.height) throw new Error('Master size changed');
  const size = { width: bitmap.width, height: bitmap.height }, canvas = document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
  const ctx = canvas.getContext('2d');if (ctx === null) throw new Error('No 2D context');ctx.drawImage(bitmap,0,0);
  const rgba = ctx.getImageData(0,0,size.width,size.height).data, master = new Uint8Array(size.width*size.height*3);
  for(let i=0;i<size.width*size.height;i++) {master[i*3]=rgba[i*4]??0;master[i*3+1]=rgba[i*4+1]??0;master[i*3+2]=rgba[i*4+2]??0;}
  const scene='00000000-0000-4000-8000-000000000001';if(!isSceneId(scene))throw new Error('Invalid scene');
  let depth: Plane<'f32'> | null = null, embeddings: SamEmbeddings | null = null, plate: Rgb8 | null = null;
  const sequence = (stages: NonEmpty<HeavyStage>): Promise<void> => new Promise((resolve,reject) => {
    service.runSequence(scene, stages, {master:()=>createImageBitmap(blob)}, {onPhase:()=>undefined,onDepth:(v)=>{depth=v;},onEmbeddings:(v)=>{embeddings=v;},onPlate:(v)=>{plate=v;},onDone:resolve,onFailed:(_stage,error)=>reject(new Error(JSON.stringify(error)))},signal);
  });
  const files: z.infer<typeof CaptureFile>[]=[];
  const save = async (name: string, data: Uint8Array): Promise<void> => {
    const response=await fetch(`/api/log?name=${photo.id}-${name}`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Blob([new Uint8Array(data)])});
    if(!response.ok)throw new Error(`Capture HTTP ${response.status}`);
    const saved=CaptureFile.parse({...await response.json(),name}); files.push(saved);
  };
  const preview = async(name: string,data: Uint8Array,w:number,h:number,channels:number):Promise<void>=>{
    const c=document.createElement('canvas');c.width=w;c.height=h;const context=c.getContext('2d');if(context===null)throw new Error('No preview context');
    const image=context.createImageData(w,h);
    for(let i=0;i<w*h;i++){image.data[i*4]=data[i*channels]??0;image.data[i*4+1]=data[i*channels+(channels===3?1:0)]??0;image.data[i*4+2]=data[i*channels+(channels===3?2:0)]??0;image.data[i*4+3]=255;}
    context.putImageData(image,0,0);const png=await new Promise<Blob>((resolve,reject)=>c.toBlob(b=>b===null?reject(new Error('PNG failed')):resolve(b),'image/png'));await save(name,new Uint8Array(await png.arrayBuffer()));
  };
  try {
    await save('master.rgb',master);
    await sequence([{kind:'depth'},{kind:'encode'}]);
    // TS cannot narrow assignments performed by service callbacks; validated accessors retain precise types.
    const getDepth=():Plane<'f32'>=>{if(depth===null)throw new Error('No depth');return depth;};
    const getEmbeddings=():SamEmbeddings=>{if(embeddings===null)throw new Error('No embeddings');return embeddings;};
    const d=getDepth();if(!d.data.every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new Error('Invalid depth');
    await save('depth.f32',new Uint8Array(d.data.buffer,d.data.byteOffset,d.data.byteLength));
    await preview('depth.png',Uint8Array.from(d.data,v=>Math.round(v*255)),d.size.width,d.size.height,1);
    // Masters have long edge 1024, so this guide is exactly the contract-sized master.
    const decoder=service.openDecoder({scene,embeddings:getEmbeddings(),guide:{size,data:master}}),union=new Uint8Array(size.width*size.height),masks=[];
    try {for(const [index,subject] of photo.subjects.entries()){
      const decoded=await decoder.decode([{at:{x:subject.point[0]/size.width,y:subject.point[1]/size.height},label:'include'}],signal);
      if(!decoded.ok)throw new Error(JSON.stringify(decoded.error));const chosen=decoded.value.candidates[0];const mask=chosen.mask;
      if(mask.size.width!==size.width||mask.size.height!==size.height)throw new Error('Mask size changed');
      await save(`mask-${index}.u8`,mask.data);await preview(`mask-${index}.png`,mask.data,size.width,size.height,1);
      masks.push({index,subject:subject.id,score:chosen.score});for(let i=0;i<union.length;i++)if((mask.data[i]??0)>=128)union[i]=255;
    }}finally{decoder.release();}
    // Exact Euclidean disc, matching core holeMask: union threshold 128, radius ceil(longEdge/100).
    const radius=Math.ceil(Math.max(size.width,size.height)/100),hole=new Uint8Array(union.length);
    for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++)if(union[y*size.width+x]===255){
      for(let dy=-radius;dy<=radius;dy++){const yy=y+dy;if(yy<0||yy>=size.height)continue;const dx=Math.floor(Math.sqrt(radius*radius-dy*dy));hole.fill(255,yy*size.width+Math.max(0,x-dx),yy*size.width+Math.min(size.width,x+dx+1));}
    }
    await save('hole.u8',hole);await preview('hole.png',hole,size.width,size.height,1);
    await sequence([{kind:'inpaint',hole:{format:'u8',size,data:hole}}]);
    const getPlate=():Rgb8=>{if(plate===null)throw new Error('No plate');return plate;};const p=getPlate();
    await save('plate.rgb',p.data);await preview('plate.png',p.data,size.width,size.height,3);
    await save('metadata.json',new TextEncoder().encode(JSON.stringify({photo:photo.id,size,depthSize:d.size,masks,promptMode:'point-only',fetchedMs,totalMs:performance.now()-begin,workerTimings,events:diag.events,models:lock.value.lock},null,2)));
    return {id:photo.id,files};
  }finally{service.cancelHeavy();bitmap.close();}
};
