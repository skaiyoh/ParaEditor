// Build only the temporary capture module, with the existing build's worker URLs.
import { readFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';
const root='.local/gpu/GP1/build';
const html=await readFile(`${root}/index.html`,'utf8');
const ortDir=JSON.parse(await readFile(`${root}/build.json`,'utf8')).ort.dir;
const main=html.match(/src="([^"]+\.js)"/);
if(main===null)throw new Error('No main bundle');
const app=await readFile(`${root}/${main[1].replace(/^\//,'')}`,'utf8');
const urls={};
for(const kind of ['sequence','decode']){
 const matches=app.match(new RegExp(`"?${kind}"?:\\s*"([^"\\n]+\\.js)"`));
 if(matches===null)throw new Error(`No ${kind} worker URL`);urls[kind]=matches[1];
}
await esbuild.build({entryPoints:['tools/gpu/gp1-baseline-page.ts'],outfile:`${root}/gp1-capture.js`,bundle:true,format:'esm',target:'es2022',define:{NOISY_ORT_DIR:JSON.stringify(ortDir),NOISY_MODEL_LOCK:await readFile('models.lock.json','utf8'),NOISY_WORKER_URLS:JSON.stringify(urls)},logLevel:'warning'});
console.log('GP1 temporary capture module built',urls);
