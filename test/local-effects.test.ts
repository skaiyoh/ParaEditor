// Opt-in real WebGL protection gate and local renderer workflow.
// The common non-Chrome floor skips the GPU tests. Run explicitly with:
// NOISY_C2R_GPU=1 node --test --test-timeout=60000 test/local-effects.test.ts
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { z } from '../src/core/zod.ts';
import type { SceneDocument } from '../src/core/types.ts';
import { prepareLocalEffects, resolveLocalEffects } from '../src/render/local-effects.ts';
import type { RenderLocalEffect } from '../src/render/local-effects.ts';
import { localEffect } from './fixtures/composition.ts';
import { fiveClusterDocument } from './fixtures/documents.ts';
import { DEFAULT_CHROME, launchChrome } from './browser/driver/chrome.ts';
import { createCleanup } from './browser/driver/processes.ts';

const size = { width: 96, height: 64 };
const split = 43; // Crosses both an 8px luma block and a 16px chroma block.
const template = fiveClusterDocument();
const object = template.objects[0];
assert.ok(object);
const doc = {
  ...template, seed: 37,
  frame: { ...template.frame, master: { ...template.frame.master, size } },
  analysis: { ...template.analysis, plate: null, depth: null },
  objects: [{ ...object, recolor: { kind: 'none' }, subject: false,
    produced: { ...object.produced, mask: { ...object.produced.mask, size },
      bounds: { x: split, y: 0, width: size.width - split, height: size.height } } }],
  style: { ...template.style, simplify: .7, crunch: .85, outline: 0, grain: 0, colorNoise: 0,
    clipping: 0, subjectClarity: 0, paletteTargets: [], saturation: .2, colors: 5, bands: 6 },
  symbols: { ...template.symbols, enabled: false },
  surface: { enabled: true, pattern: 'bars', relief: 1, refraction: 1, shine: .35, scale: .41 },
  motion: { ...template.motion, enabled: false },
} satisfies SceneDocument;

// This bundle uses the actual renderer and treatment shaders. The two candidate
// boundaries are experiments, never installed into the production evaluator.
const probeSource = String.raw`
import { createRenderer } from './src/render/renderer.ts';
import { parseHex } from './src/core/color.ts';
import { createGl } from './src/render/gl.ts';
import { surface, surfaceLookup } from './src/render/shaders/surface.ts';
import { head } from './src/render/shaders/shared.ts';
import { crunchExtract, crunchRowDct, crunchColumnDct, crunchColumnIdct, crunchRowIdct, crunchCombine } from './src/render/shaders/crunch.ts';
import { LUMA_TABLE, CHROMA_TABLE, crunchQuality, qualityTable } from './src/render/crunch.ts';

export async function run() {
  const doc = ${JSON.stringify(doc)}, { width, height } = doc.frame.master.size, split = ${split};
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const masterCanvas = document.createElement('canvas'); masterCanvas.width = width; masterCanvas.height = height;
  const ctx = masterCanvas.getContext('2d');
  const image = ctx.createImageData(width, height), mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const foreground = x >= split, tone = ((x * 7 + y * 13) % 39);
    image.data.set(foreground ? [35 + tone, 65 + tone, 175 + tone, 255] : [195 + tone, 65 + tone, 30 + tone, 255], (y * width + x) * 4);
    mask[y * width + x] = foreground ? 255 : 0;
  }
  ctx.putImageData(image, 0, 0);
  const master = await createImageBitmap(masterCanvas), renderer = createRenderer(canvas);
  const scene = { doc, master, masks: new Map([[doc.objects[0].id, { format: 'u8', size: { width, height }, data: mask }]]), depth: null, plate: null, selected: null };
  const readCanvas = () => {
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    const c = out.getContext('2d'); c.drawImage(canvas, 0, 0);
    return new Uint8Array(c.getImageData(0, 0, width, height).data);
  };
  let baseline, treated, finalStage;
  try {
    renderer.setScene(scene); renderer.renderStill(); baseline = readCanvas();
    const color = parseHex('#0cd6b0').color.oklch;
    const effect = { id:'00000000-0000-4000-8000-000000000801', enabled:true, owner:{kind:'background'},scope:{kind:'whole'},operation:{kind:'fill',color} };
    renderer.setScene({...scene,localEffects:[effect]}); renderer.renderStill();
    const actual=renderer.debug.readLocalEffectPatch(0,0,width,height), weight=renderer.debug.readLocalCoveragePatch(effect.id,0,0,width,height);
    let max=0,changed=0,targetChanged=0,preMax=0,checked=0;
    for(let p=0;p<width*height;p++) {
      let delta=0;
      for(let c=0;c<3;c++) { delta=Math.max(delta,Math.abs(actual.after[p*4+c]-baseline[p*4+c])); preMax=Math.max(preMax,Math.abs(actual.before[p*4+c]-baseline[p*4+c])); }
      if(weight[p*4]===0) { checked++;max=Math.max(max,delta);if(delta>0)changed++; }
      else if(delta>0)targetChanged++;
    }
    finalStage={outside:{checked,changed,max},targetChanged,preMax,samples:[43,45].map(x=>({x,y:0,before:Array.from(baseline.slice(x*4,x*4+3)),after:Array.from(actual.after.slice(x*4,x*4+3)),coverage:weight[x*4],owner:actual.owners[x*4]}))};
    // Capture the already Simplified/palette-treated owner colors immediately
    // before Surface. Both candidate camera recipes below stay held fixed.
    renderer.setScene({ ...scene, doc: { ...doc, style: { ...doc.style, crunch: 0 }, surface: { ...doc.surface, enabled: false } } });
    renderer.renderStill(); treated = readCanvas();
  } finally { renderer.dispose(); master.close(); }

  const gpuCanvas = document.createElement('canvas'); gpuCanvas.width = width; gpuCanvas.height = height;
  const gpu = createGl(gpuCanvas), { gl } = gpu;
  const tex = value => ({ kind: 'texture', value }), int = value => ({ kind: 'int', value }), float = value => ({ kind: 'float', value });
  const read = target => { const out = new Uint8Array(width * height * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out); return out; };
  try {
    const src = gpu.texture(width, height, 'rgba8', treated);
    const coating = gpu.program(surface), warp = gpu.program(surfaceLookup);
    const programs = [crunchExtract, crunchRowDct, crunchColumnDct, crunchColumnIdct, crunchRowIdct, crunchCombine].map(s => gpu.program(s));
    const fill = gpu.program(head + 'uniform sampler2D src; uniform int boundary; void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = p.x < boundary ? vec4(12./255.,214./255.,176./255.,1.) : texelFetch(src,p,0); }');
    // Extend each half-plane by its nearest valid texel. No transparent black
    // or foreign-owner color can enter Surface, 4:2:0 or an 8x8 DCT block.
    const isolate = gpu.program(head + 'uniform sampler2D src; uniform int boundary; uniform int owner; void main() { ivec2 p = ivec2(gl_FragCoord.xy); p.x = owner == 1 ? max(p.x,boundary) : min(p.x,boundary-1); o = texelFetch(src,p,0); }');
    const identity = gpu.program('#version 300 es\nprecision highp float; precision highp int; layout(location=0) out vec4 label; layout(location=1) out vec4 uv; uniform int boundary; uniform ivec2 size; void main() { label=vec4(gl_FragCoord.x >= float(boundary) ? 1./255. : 0.,1.,0.,1.); uvec2 q=uvec2(round(gl_FragCoord.xy/vec2(size)*65535.)); uv=vec4(float(q.x>>8u),float(q.x&255u),float(q.y>>8u),float(q.y&255u))/255.; }');
    const resolve = gpu.program(head + 'uniform sampler2D fg; uniform sampler2D bg; uniform sampler2D labels; uniform int effect; void main() { ivec2 p=ivec2(gl_FragCoord.xy); o=texelFetch(labels,p,0).r>0. ? texelFetch(fg,p,0) : effect==1 ? vec4(12./255.,214./255.,176./255.,1.) : texelFetch(bg,p,0); }');
    const uniforms = { seed: { kind: 'uint', value: doc.seed }, pattern: int(0), relief: float(doc.surface.relief), refraction: float(doc.surface.refraction), shine: float(doc.surface.shine), scale: float(doc.surface.scale), phase: float(0), cameraDirection: { kind: 'vec3', value: [0, 0, 1] } };
    const labels = gpu.target(width,height), uv = gpu.target(width,height); gpu.attach(labels,uv);
    gpu.draw(identity,labels,{ boundary:int(split),size:{ kind:'ivec2',value:[width,height] } });
    const mapped = gpu.target(width,height), mappedUV = gpu.target(width,height); gpu.attach(mapped,mappedUV);
    gpu.draw(warp,mapped,{ ...uniforms, labels:tex(labels),sourceMap:tex(uv) });
    const ownerBytes = read(mapped), uvBytes = read(mappedUV);
    const recipe = input => {
      const surfaced = gpu.target(width,height); gpu.draw(coating,surfaced,{ ...uniforms,src:tex(input) });
      const ys = [gpu.target(width,height,'r16f'),gpu.target(width,height,'r16f')];
      const cs = [gpu.target(width/2,height/2,'rg16f'),gpu.target(width/2,height/2,'rg16f')];
      for (const [targets,table,chroma] of [[ys,LUMA_TABLE,0],[cs,CHROMA_TABLE,1]]) {
        const [a,b]=targets;
        gpu.draw(programs[0],a,{src:tex(surfaced),chroma:int(chroma)});
        gpu.draw(programs[1],b,{src:tex(a)});
        gpu.draw(programs[2],a,{src:tex(b),table:{kind:'floatArray',value:qualityTable(table,crunchQuality(doc.style.crunch))}});
        gpu.draw(programs[3],b,{src:tex(a)}); gpu.draw(programs[4],a,{src:tex(b)});
      }
      const final=gpu.target(width,height); gpu.draw(programs[5],final,{luma:tex(ys[0]),chroma:tex(cs[0])});
      for (const target of [surfaced,...ys,...cs]) gpu.release(target);
      return final;
    };
    const repeated = recipe(src);
    const early = gpu.target(width,height); gpu.draw(fill,early,{src:tex(src),boundary:int(split)});
    const earlyResult = recipe(early);
    const ownerInputs = [gpu.target(width,height),gpu.target(width,height)];
    ownerInputs.forEach((target,owner) => gpu.draw(isolate,target,{src:tex(src),boundary:int(split),owner:int(owner)}));
    const owners = ownerInputs.map(recipe), isolated = gpu.target(width,height), isolatedFill = gpu.target(width,height);
    for (const [target,effect] of [[isolated,0],[isolatedFill,1]]) gpu.draw(resolve,target,{fg:tex(owners[1]),bg:tex(owners[0]),labels:tex(mapped),effect:int(effect)});
    const pixels = { baseline, repeated:read(repeated), early:read(earlyResult), isolated:read(isolated), isolatedFill:read(isolatedFill) };
    const stats = (candidate, include) => {
      let count=0,changed=0,max=0,sumBefore=0,sumAfter=0,sample=null;
      for(let p=0;p<width*height;p++) {
        if(!include(p)) continue; count++; let pixelMax=0;
        for(let c=0;c<3;c++) { const a=baseline[p*4+c],b=candidate[p*4+c]; sumBefore+=a;sumAfter+=b;pixelMax=Math.max(pixelMax,Math.abs(a-b)); }
        if(pixelMax>0) changed++;
        if(pixelMax>max) {max=pixelMax;sample={x:p%width,y:Math.floor(p/width),before:Array.from(baseline.slice(p*4,p*4+3)),after:Array.from(candidate.slice(p*4,p*4+3)),owner:ownerBytes[p*4],lookupValidAlpha:ownerBytes[p*4+3],uv:[(uvBytes[p*4]*256+uvBytes[p*4+1])/65535,(uvBytes[p*4+2]*256+uvBytes[p*4+3])/65535]};}
      }
      return {count,changed,max,sumBefore,sumAfter,sample};
    };
    const foreground = p => ownerBytes[p*4] === 1;
    const interior = p => foreground(p) && (uvBytes[p*4]*256+uvBytes[p*4+1])/65535*width >= split+2.5;
    const bg = p => ownerBytes[p*4] === 0;
    const summarize = candidate => ({foreground:stats(candidate,foreground),interior:stats(candidate,interior),background:stats(candidate,bg)});
    const result = {size:{width,height},split,finalStage,settings:{simplify:doc.style.simplify,surface:doc.surface,crunch:doc.style.crunch},
      legacyReproduction:stats(pixels.repeated,()=>true),early:summarize(pixels.early),isolated:summarize(pixels.isolated),isolatedFill:summarize(pixels.isolatedFill),glError:gl.getError()};
    document.body.replaceChildren(); document.body.style.cssText='display:grid;grid-template-columns:repeat(3,384px);gap:12px;background:white;color:black';
    for (const [name,bytes] of Object.entries(pixels)) {
      const title=document.createElement('div');title.textContent=name;const c=document.createElement('canvas');c.width=width;c.height=height;c.style.width='384px';c.style.height='256px';c.style.imageRendering='pixelated';
      const panel=document.createElement('div');c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes),width,height),0,0);panel.append(title,c);document.body.append(panel);
    }
    return result;
  } finally { gpu.dispose(); }
}
`;

const workflowSource = String.raw`
import { createRenderer } from './src/render/renderer.ts';
import { parseHex, srgbToOklab, oklabToSrgb, oklchToOklab, oklabToOklch } from './src/core/color.ts';
import { clipLightness } from './src/render/clip.ts';
import { clipGamut } from './src/render/gamut.ts';
import { liveCoverage } from './src/core/live-coverage.ts';
import { createPerspectiveGeometry } from './src/core/perspective.ts';

export async function run() {
  const original = ${JSON.stringify(doc)}, size=original.frame.master.size, {width,height}=size, split=${split};
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const source=document.createElement('canvas');source.width=width;source.height=height;
  const ctx=source.getContext('2d'), image=ctx.createImageData(width,height);
  const mask={format:'u8',size,data:new Uint8Array(width*height)}, depth={format:'f32',size,data:new Float32Array(width*height)}, plate={size,data:new Uint8Array(width*height*3)}, hole={format:'u8',size,data:new Uint8Array(width*height).fill(255)};
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=y*width+x,fg=x>=split,tone=(x*5+y*7)%45;
    image.data.set(fg?[130+tone,175+tone,200+tone,255]:[170+tone,95+tone,30+tone,255],p*4);
    mask.data[p]=fg?255:0;depth.data[p]=fg?.8:.2;plate.data.set([170+tone,95+tone,30+tone],p*3);
  }
  ctx.putImageData(image,0,0);const master=await createImageBitmap(source),renderer=createRenderer(canvas);
  const shape={...original,analysis:{...original.analysis,depth:{...${JSON.stringify(template.analysis.depth)},map:{...${JSON.stringify(template.analysis.depth?.map)},size},stats:{p10:.2,median:.5,p90:.8}},plate:{...${JSON.stringify(template.analysis.plate)},image:{...${JSON.stringify(template.analysis.plate?.image)},size},key:{...${JSON.stringify(template.analysis.plate?.key)},size,radius:Math.ceil(Math.ceil(Math.max(width,height)/100)*original.motion.parallax),purpose:{kind:'loop',parallax:original.motion.parallax,reach:.4}}}},motion:{...original.motion,enabled:true,focus:.5,drift:{direction:'circle',amount:.4}},style:{...original.style,grain:.12,colorNoise:.08}};
  const geometry=createPerspectiveGeometry({aperture:{center:{x:.12,y:-.06},width:.8,height:.6},crop:.04,neutralDistance:1,nearFactor:1.1,farFactor:2});
  const coverage=liveCoverage(shape,geometry);
  if(coverage===null)throw new Error('No fixture perspective coverage.');
  const base={doc:shape,master,masks:new Map([[shape.objects[0].id,mask]]),depth,plate,selected:null,livePlate:{key:coverage.key,image:plate,hole,depth}};
  const request={geometry,eye:{x:.02,y:0,z:1},sceneGeneration:41,viewId:73,frame:17,showSelection:false};
  const color=parseHex('#d173e8').color.oklch, saturated={l:.8,c:.4,h:142};
  const operations=[{kind:'recolor',color:saturated},{kind:'fill',color},{kind:'clipping',amount:1}];
  const effect=(operation,owner,scope,n=1)=>({id:'00000000-0000-4000-8000-'+(0x800+n).toString(16).padStart(12,'0'),enabled:true,owner,scope,operation});
  const sceneFor=(view,effects=[],selected=null)=>({...base,selected,localEffects:effects,doc:{...shape,surface:{...shape.surface,enabled:view==='surface'||view==='perspective'}}});
  const draw=(view)=>{
    if(view==='motion')renderer.renderFrame(17);
    else if(view==='perspective'){const result=renderer.renderPerspective(request);if(result.kind!=='rendered')throw new Error('Perspective was limited: '+result.reason);}
    else renderer.renderStill();
  };
  const compare=(a,b)=>{let max=0;for(let p=0;p<a.length;p++)max=Math.max(max,Math.abs(a[p]-b[p]));return max;};
  const patch=()=>renderer.debug.readLocalEffectPatch(0,0,width,height);
  const scopes=(name,owner,lookup=null)=>{
    if(name==='whole')return{kind:'whole'};
    const maskSize=name==='fractional'?{width:48,height:32}:size;
    const data=new Uint8Array(maskSize.width*maskSize.height);
    if(name==='full')data.fill(255);
    if(name==='one-pixel') {
      let x=owner.kind==='background'?20:70,y=32;
      if(lookup!==null) {
        const label=owner.kind==='background'?0:1;
        let nearest=-1,best=Infinity;
        for(let p=0;p<width*height;p++)if(lookup.owners[p*4]===label&&lookup.owners[p*4+3]!==0){const distance=Math.hypot(p%width-x,Math.floor(p/width)-y);if(distance<best){nearest=p;best=distance;}}
        if(nearest<0)throw new Error('No visible owner for one-pixel fixture');
        x=Math.min(width-1,Math.floor((lookup.sourceUV[nearest*4]*256+lookup.sourceUV[nearest*4+1])/65535*width));
        y=Math.min(height-1,Math.floor((lookup.sourceUV[nearest*4+2]*256+lookup.sourceUV[nearest*4+3])/65535*height));
      }
      data[y*width+x]=255;
    }
    if(name==='fractional')for(let y=0;y<maskSize.height;y++)for(let x=0;x<maskSize.width;x++)data[y*maskSize.width+x]=[0,64,128,192,255][x%5];
    return{kind:'mask',plane:{format:'u8',size:maskSize,data}};
  };
  const changedColor=(bytes,p,operation)=>{
    const rgb={r:bytes[p*4]/255,g:bytes[p*4+1]/255,b:bytes[p*4+2]/255},lab=srgbToOklab(rgb);
    if(operation.kind==='fill')return oklabToSrgb(oklchToOklab(operation.color));
    if(operation.kind==='recolor')return oklabToSrgb(oklchToOklab(clipGamut({l:lab.L,c:operation.color.c,h:operation.color.h})));
    const L=clipLightness(lab.L,operation.amount);return L===lab.L?rgb:oklabToSrgb({...lab,L});
  };
  const rows=[];let maxOutside=0,maxExpected=0,maxL=0,totalChanged=0,moved=0,refracted=0,captures=0;
  const checks=(before,after,e,view,scopeName)=>{
    const weights=renderer.debug.readLocalCoveragePatch(e.id,0,0,width,height);
    if(compare(before.after,after.before)!==0)throw new Error('Local baseline changed '+view);
    if(compare(before.owners,after.owners)!==0||compare(before.sourceUV,after.sourceUV)!==0)throw new Error('Lookup changed with effect '+view);
    let outside=0,expectedMax=0,weightMax=0,changed=0,covered=0,fractional=0;
    for(let p=0;p<width*height;p++) {
      const owner=after.owners[p*4],valid=after.owners[p*4+3]!==0;
      const uv=[(after.sourceUV[p*4]*256+after.sourceUV[p*4+1])/65535,(after.sourceUV[p*4+2]*256+after.sourceUV[p*4+3])/65535];
      let expectedWeight=valid&&owner===(e.owner.kind==='background'?0:1)?255:0;
      if(expectedWeight>0&&e.scope.kind==='mask') {
        const {size,data}=e.scope.plane,x=Math.min(size.width-1,Math.floor(uv[0]*size.width)),y=Math.min(size.height-1,Math.floor(uv[1]*size.height));expectedWeight=data[y*size.width+x];
      }
      weightMax=Math.max(weightMax,Math.abs(weights[p*4]-expectedWeight));
      if(expectedWeight>0)covered++;if(expectedWeight>0&&expectedWeight<255)fractional++;
      const target=changedColor(before.after,p,e.operation),channels=[target.r,target.g,target.b];let delta=0;
      for(let c=0;c<3;c++) {
        delta=Math.max(delta,Math.abs(after.after[p*4+c]-before.after[p*4+c]));
        const expected=Math.round(before.after[p*4+c]+(Math.max(0,Math.min(1,channels[c]))*255-before.after[p*4+c])*expectedWeight/255);
        expectedMax=Math.max(expectedMax,Math.abs(after.after[p*4+c]-expected));
      }
      if(expectedWeight===0)outside=Math.max(outside,delta);if(delta>0)changed++;
      if(e.operation.kind==='recolor'&&expectedWeight===255) {
        const a=srgbToOklab({r:before.after[p*4]/255,g:before.after[p*4+1]/255,b:before.after[p*4+2]/255}).L;
        const b=srgbToOklab({r:after.after[p*4]/255,g:after.after[p*4+1]/255,b:after.after[p*4+2]/255}).L;maxL=Math.max(maxL,Math.abs(a-b));
      }
      if(valid&&Math.abs(uv[0]*width-(p%width+.5))>.5){if(view==='motion')moved++;if(view==='surface')refracted++;}
    }
    const label=[view,e.operation.kind,e.owner.kind,scopeName].join('/');
    if(outside!==0||expectedMax>1||weightMax!==0)throw new Error(label+' outside='+outside+' expected='+expectedMax+' coverage='+weightMax);
    if(scopeName==='empty'&&changed!==0)throw new Error(label+' empty scope wrote pixels');
    if(scopeName!=='empty'&&covered===0)throw new Error(label+' fixture had no covered pixel');
    if(scopeName==='fractional'&&fractional===0)throw new Error(label+' fixture had no fractional pixel');
    if(e.operation.kind!=='clipping'&&scopeName!=='empty'&&changed===0)throw new Error(label+' had no visible edit');
    rows.push({view,operation:e.operation.kind,owner:e.owner.kind,scope:scopeName,outside,expectedMax,weightMax,covered,fractional,changed});
    maxOutside=Math.max(maxOutside,outside);maxExpected=Math.max(maxExpected,expectedMax);totalChanged+=changed;
  };
  const decode=async blob=>{const b=await createImageBitmap(blob),out=document.createElement('canvas');out.width=b.width;out.height=b.height;const c=out.getContext('2d');c.drawImage(b,0,0);b.close();return new Uint8Array(c.getImageData(0,0,out.width,out.height).data);};
  const capture=async view=>{
    const before=patch();let bytes;
    if(view==='motion') {const out=document.createElement('canvas');out.width=width;out.height=height;renderer.exportStill({frame:17,canvas:out});bytes=new Uint8Array(out.getContext('2d').getImageData(0,0,width,height).data);}
    else if(view==='perspective')bytes=await decode(await new Promise(resolve=>canvas.toBlob(resolve,'image/png')));
    else bytes=await decode(await renderer.exportStill());
    if(compare(bytes,before.after)!==0||compare(patch().after,before.after)!==0)throw new Error('Capture mismatch/restoration '+view);captures++;
  };
  try {
    for(const view of ['still','motion','surface','perspective'])for(const owner of [{kind:'background'},{kind:'layer',id:shape.objects[0].id}])for(const operation of operations)for(const name of ['whole','empty','full','one-pixel','fractional']) {
      renderer.setScene(sceneFor(view));renderer.setCompare('edited');draw(view);const baseline=patch();
      const e=effect(operation,owner,scopes(name,owner,baseline));renderer.setScene(sceneFor(view,[e]));draw(view);checks(baseline,patch(),e,view,name);
      if(name==='whole')await capture(view);
    }
    if(moved===0||refracted===0)throw new Error('Fixture did not exercise moved and refracted UV');
    // More than eight effects crosses the bounded sampler batch boundary.
    const list=Array.from({length:10},(_,index)=>effect(index===9?{kind:'fill',color:parseHex('#2b7dc9').color.oklch}:{kind:'clipping',amount:0},{kind:'background'},{kind:'whole'},index+1));
    renderer.setScene(sceneFor('motion',list));const frames=new Map();
    for(const frame of [0,17,4,17,0]) {renderer.renderFrame(frame);const bytes=patch().after;if(frames.has(frame)&&compare(bytes,frames.get(frame))!==0)throw new Error('Frame order was nondeterministic');frames.set(frame,bytes);}
    renderer.renderView({x:.02,y:0},17,false);const viewPixels=patch().after;
    if(compare(await decode(await renderer.exportView({x:.02,y:0},17)),viewPixels)!==0)throw new Error('View export mismatch');captures++;
    // Selection decoration cannot overwrite either dev snapshot or sample pixels.
    renderer.setScene(sceneFor('still',list,shape.objects[0].id));renderer.renderStill();const selected=patch();
    if(compare(await decode(await renderer.exportStill()),selected.after)!==0||compare(patch().before,selected.before)!==0)throw new Error('Decoration corrupted dev snapshots');captures++;
    const sampled=renderer.sampleColor({at:{x:.2,y:.5},source:'edited'}),p=(32*width+19)*4;
    if(sampled.kind!=='sampled'||compare([sampled.color.srgb.r,sampled.color.srgb.g,sampled.color.srgb.b],selected.after.slice(p,p+3))!==0)throw new Error('Edited sample contains decoration');
    // Content edits survive Treatments Off; local Clipping does not.
    renderer.setScene(sceneFor('still'));renderer.setCompare('treatments-off');const raw=patch();
    const fillEffect=effect(operations[1],{kind:'layer',id:shape.objects[0].id},{kind:'whole'});
    renderer.setScene(sceneFor('still',[fillEffect,effect(operations[2],{kind:'layer',id:shape.objects[0].id},{kind:'whole'},2)]));renderer.renderStill();
    checks(raw,patch(),fillEffect,'treatments-off','whole');const offWithClip=patch().after;
    renderer.setScene(sceneFor('still',[fillEffect]));renderer.renderStill();if(compare(offWithClip,patch().after)!==0)throw new Error('Local Clipping survived Treatments Off');
    const recolorEffect=effect(operations[0],{kind:'layer',id:shape.objects[0].id},{kind:'whole'});
    renderer.setScene(sceneFor('still',[recolorEffect]));renderer.renderStill();checks(raw,patch(),recolorEffect,'treatments-off','whole');
    renderer.setCompare('source-photo');if(compare(patch().after,image.data)!==0)throw new Error('Source Photo contains local effects');
    // Captures explicitly use Edited, restore comparisons and preserve live identity.
    renderer.setCompare('edited');renderer.renderStill();const editedStill=await decode(await renderer.exportStill());
    for(const comparison of ['source-photo','treatments-off']) {renderer.setCompare(comparison);const comparisonPixels=patch().after;if(compare(await decode(await renderer.exportStill()),editedStill)!==0||compare(patch().after,comparisonPixels)!==0)throw new Error('Comparison capture mismatch '+comparison);captures++;}
    renderer.setCompare('edited');renderer.setScene(sceneFor('perspective',[fillEffect]));renderer.renderPerspective(request);const liveBefore=patch().after,hit=renderer.hitTest({x:.7,y:.5});
    await renderer.exportStill();if(compare(patch().after,liveBefore)!==0||JSON.stringify(hit)!==JSON.stringify(renderer.hitTest({x:.7,y:.5})))throw new Error('Export changed perspective identity');
    // Background edits also reach generated repair pixels while Source still refuses them.
    const bgEffect=effect(operations[1],{kind:'background'},{kind:'whole'});renderer.setScene(sceneFor('perspective',[bgEffect]));renderer.renderPerspective(request);const generated=renderer.sampleColor({at:{x:.1,y:.5},source:'source'});
    if(generated.kind!=='refused')throw new Error('Generated Source pixels did not refuse');
    // Frozen GPU plane bytes survive mutations of the caller's transient array.
    const frozenScope=scopes('fractional',{kind:'background'}),frozen=effect(operations[1],{kind:'background'},frozenScope);
    renderer.setScene(sceneFor('still',[frozen]));renderer.renderStill();const frozenBefore=patch().after;frozenScope.plane.data.fill(0);renderer.renderStill();if(compare(frozenBefore,patch().after)!==0)throw new Error('Scope was not frozen after upload');
    renderer.setScene(sceneFor('still'));renderer.renderStill();if(renderer.debug.localResources().textures!==0)throw new Error('Removed local masks retained GPU textures');
    const old=patch().after;let status='';try{renderer.setScene({...sceneFor('still'),compositing:'scene-depth'});}catch(error){status=error.message;}
    if(!status.includes('physical layer depth requires C3')||compare(patch().after,old)!==0)throw new Error('scene-depth did not refuse before mutation');
    let docStatus='';try{renderer.setScene({...base,doc:{...shape,compositing:'scene-depth'}});}catch(error){docStatus=error.message;}
    if(docStatus!==status)throw new Error('scene-depth document was not refused');
    // Invalid GPU-sized selections must refuse without invalidating the current draw.
    const gl=canvas.getContext('webgl2'),oversize=gl.getParameter(gl.MAX_TEXTURE_SIZE)+1;
    const oversized=effect(operations[1],{kind:'background'},{kind:'mask',plane:{format:'u8',size:{width:oversize,height:1},data:new Uint8Array(oversize)}});
    let sizeStatus='';try{renderer.setScene({...sceneFor('surface',[oversized]),doc:{...shape,style:{...shape.style,simplify:.1}}});}catch(error){sizeStatus=error.message;}
    if(!sizeStatus.includes('selection exceeds this device')||compare(patch().after,old)!==0)throw new Error('Oversized scope invalidated the preceding draw');
    renderer.renderStill();if(compare(patch().after,old)!==0)throw new Error('Oversized scope changed the preceding scene');
    // Explicit disabled and empty scopes preserve baseline bytes.
    renderer.setScene({...sceneFor('still'),localEffects:[{...fillEffect,enabled:false}]});renderer.renderStill();if(compare(patch().after,old)!==0)throw new Error('Disabled operation changed output');
    const pictures=[];
    for(const view of ['still','motion','surface','perspective']) {renderer.setScene(sceneFor(view,[effect(operations[1],{kind:'background'},scopes('fractional',{kind:'background'}))]));draw(view);pictures.push({view,bytes:Array.from(patch().after)});}
    const resources=renderer.debug.localResources();renderer.dispose();if(renderer.debug.localResources().targets!==0||renderer.debug.localResources().textures!==0)throw new Error('Dispose retained local resources');
    document.body.replaceChildren();document.body.style.cssText='display:grid;grid-template-columns:repeat(2,384px);gap:12px;background:white;color:black';
    for(const {view,bytes} of pictures){const panel=document.createElement('div'),title=document.createElement('div'),c=document.createElement('canvas');title.textContent=view;c.width=width;c.height=height;c.style.cssText='width:384px;height:256px;image-rendering:pixelated';c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes),width,height),0,0);panel.append(title,c);document.body.append(panel);}
    return{cases:rows.length,rows,maxOutside,maxExpected,maxLightnessError:maxL,totalChanged,moved,refracted,captures,resources,status,docStatus,sizeStatus,deterministic:true,comparisonsRestored:true,frozen:true,generatedRefused:true,disposed:true};
  } finally {renderer.dispose();master.close();}
}
`;

const statsSchema = z.object({ count: z.number(), changed: z.number(), max: z.number(), sumBefore: z.number(), sumAfter: z.number(), sample: z.unknown() });
const regionSchema = z.object({ foreground: statsSchema, interior: statsSchema, background: statsSchema });
const resultSchema = z.object({ size: z.object({ width: z.number(), height: z.number() }), split: z.number(), settings: z.unknown(),
  finalStage: z.object({ outside: z.object({ checked:z.number(),changed:z.number(),max:z.number() }), targetChanged:z.number(),preMax:z.number(),samples:z.unknown() }),
  legacyReproduction: statsSchema, early: regionSchema, isolated: regionSchema, isolatedFill: regionSchema, glError: z.number() });

test('C2r WebGL gate: legacy neighborhood compatibility counterexamples', { skip: process.env.NOISY_C2R_GPU !== '1' }, async () => {
  const dir = path.resolve('.codex/work/c2r-protection');
  await mkdir(dir, { recursive: true });
  const bundle = await build({ stdin: { contents: probeSource, resolveDir: process.cwd(), sourcefile: 'c2r-probe.js' },
    bundle: true, write: false, format: 'esm', platform: 'browser', define: { NOISY_DEV: 'true' } });
  const output = bundle.outputFiles[0];
  assert.ok(output);
  await writeFile(path.join(dir, 'probe.js'), output.text);
  const cleanup = createCleanup();
  try {
    const browser = await launchChrome({ executable: DEFAULT_CHROME, headless: true, logFile: path.join(dir, 'chrome.log'), cleanup });
    const page = await browser.openPage({ baseUrl: 'http://127.0.0.1', dir });
    const result = await page.evaluate(resultSchema, async (source) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try { const probe = await import(url); return await probe.run(); }
      finally { URL.revokeObjectURL(url); }
    }, output.text);
    await writeFile(path.join(dir, 'protection.json'), JSON.stringify(result, null, 2) + '\n');
    await page.screenshot('protection');
    console.log(JSON.stringify(result));
    assert.equal(result.glError, 0);
    assert.equal(result.finalStage.preMax, 0);
    assert.equal(result.finalStage.outside.max, 0);
    assert.ok(result.finalStage.targetChanged > 0);
    assert.equal(result.legacyReproduction.max, 0, 'probe reproduces the actual renderer final pixels exactly');
    assert.ok(result.early.background.changed > 0, 'first background effect is visible');
    assert.ok(result.early.interior.max > 1, 'effect before shared neighborhoods contaminates protected foreground');
    assert.ok(result.isolated.interior.max > 1, 'isolation switch alone changes protected foreground');
    assert.ok(result.isolatedFill.background.changed > 0, 'isolated first background effect is visible');
    assert.equal(result.isolatedFill.foreground.max, result.isolated.foreground.max);
    console.log('C2r resume acceptance A PASS: final-stage outside-scope maximum RGB error 0; original counterexamples retained as evidence.');
  } finally { assert.deepEqual(await cleanup.run(), []); }
});

test('local effects resolve C2a assets and refuse missing or mismatched planes', () => {
  const effect = localEffect();
  assert.equal(effect.scope.kind, 'mask');
  if (effect.scope.kind !== 'mask') return;
  const ref = effect.scope.mask.plane;
  const plane = { format: 'u8', size: ref.size, data: new Uint8Array(ref.size.width * ref.size.height) } satisfies import('../src/core/raster.ts').Plane<'u8'>;
  const resolved = resolveLocalEffects([effect], new Map([[ref.asset,plane]]));
  assert.equal(resolved[0]?.scope.kind, 'mask');
  assert.throws(() => resolveLocalEffects([effect], new Map()), /missing or has the wrong size/);
  assert.throws(() => resolveLocalEffects([effect], new Map([[ref.asset,{ ...plane,size:{width:1,height:1} }]])), /wrong size/);
});

test('local effect ownership never falls back to Scene and disabled/hidden operations are inactive', () => {
  const effect = localEffect();
  const id = template.objects[0]?.id;
  assert.ok(id);
  const whole = { ...effect, scope:{kind:'whole'},owner:{kind:'layer',id} } satisfies RenderLocalEffect;
  assert.throws(() => prepareLocalEffects([whole],[]), /owner is no longer available/);
  assert.deepEqual(prepareLocalEffects([{...whole,enabled:false}],[]),[]);
  assert.deepEqual(prepareLocalEffects([whole],[{id,hidden:true}]),[]);
  assert.equal(prepareLocalEffects([whole],[{id}])[0]?.label,1);
  assert.equal(prepareLocalEffects([{...whole,owner:{kind:'background'}}],[{id}])[0]?.label,0);
});

test('C2r real renderer local operations across scopes, views, comparisons and captures', { skip: process.env.NOISY_C2R_GPU !== '1' }, async () => {
  const dir=path.resolve('.codex/work/c2r-resume-workflow');
  await mkdir(dir,{recursive:true});
  const bundle=await build({stdin:{contents:workflowSource,resolveDir:process.cwd(),sourcefile:'c2r-workflow.js'},bundle:true,write:false,format:'esm',platform:'browser',define:{NOISY_DEV:'true'}});
  const output=bundle.outputFiles[0];assert.ok(output);await writeFile(path.join(dir,'probe.js'),output.text);
  const cleanup=createCleanup();
  try {
    const browser=await launchChrome({executable:DEFAULT_CHROME,headless:true,logFile:path.join(dir,'chrome.log'),cleanup});
    const page=await browser.openPage({baseUrl:'http://127.0.0.1',dir});
    const schema=z.object({cases:z.number(),rows:z.array(z.unknown()),maxOutside:z.number(),maxExpected:z.number(),maxLightnessError:z.number(),totalChanged:z.number(),moved:z.number(),refracted:z.number(),captures:z.number(),resources:z.unknown(),status:z.string(),docStatus:z.string(),sizeStatus:z.string(),deterministic:z.boolean(),comparisonsRestored:z.boolean(),frozen:z.boolean(),generatedRefused:z.boolean(),disposed:z.boolean()});
    const result=await page.evaluate(schema,async source=>{const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));try{const module=await import(url);return await module.run();}finally{URL.revokeObjectURL(url);}},output.text);
    await writeFile(path.join(dir,'workflow.json'),JSON.stringify(result,null,2)+'\n');await page.screenshot('local-effects');
    assert.equal(result.maxOutside,0);assert.ok(result.maxExpected<=1);assert.ok(result.maxLightnessError<.004);
    assert.equal(result.cases,122);assert.ok(result.captures>=26);
    const {rows,...summary}=result;console.log('C2r workflow '+JSON.stringify(summary));
  } finally {assert.deepEqual(await cleanup.run(),[]);}
});
