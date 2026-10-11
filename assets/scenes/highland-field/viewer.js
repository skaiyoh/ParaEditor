// Authored geometry through a fixed screen-plane aperture, not an orbit camera.
const $ = (id) => document.getElementById(id);
const canvas = $('scene'), stage = $('window'), status = $('status');
const buttons = ['recenter', 'head', 'tilt', 'auto', 'fullscreen'].map($).filter(Boolean);
const clamp = (x, limit = 1) => Math.max(-limit, Math.min(limit, x));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = { ready: false, source: 'pointer', target: [0, 0], current: [0, 0], velocity: [0, 0], frames: 0, lastMs: 0, frameIntervals: [],
  auto: false, tilt: false, tiltBase: null, head: null, headAbort: null, gain: 2, error: null, renderTimes: [] };
let gl, metadata, sceneProgram, skyProgram, shadowProgram, vao, skyVao, indexCount, lightMatrix, shadowMap;
let raf = 0, lastTime = 0;
const setStatus = (text) => { status.textContent = text; };

function fail(error) {
  state.ready = false;
  state.error = error instanceof Error ? error.message : String(error);
  stopInputs(); cancelAnimationFrame(raf); raf = 0;
  canvas.hidden = true; $('poster').hidden = false;
  $('loading').hidden = false; $('loading').textContent = 'The 3D view could not continue.';
  setStatus(`${state.error} Reload the scene to try again.`);
  $('reload').hidden = false;
  for (const button of buttons) if (button.id !== 'fullscreen') button.disabled = true;
}
$('reload').onclick = () => location.reload();
canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); fail(new Error('The graphics context stopped.')); });

const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aKind;
layout(location=4) in float aId;
uniform mat4 uVP;
uniform mat4 uLight;
uniform vec3 uWindow;
out vec3 vPosition;
out vec3 vNormal;
out vec3 vColor;
out vec4 vShadow;
flat out int vKind;
flat out int vId;
void main() {
  vec3 p = aPosition;
  if (aKind > 4.5) {
    p.x *= uWindow.x / (26.0 / 3.0);
    p.z = uWindow.z + (p.z - 2.8) * uWindow.y / 6.5;
  }
  vPosition = p; vNormal = aNormal; vColor = aColor;
  vKind = int(aKind + .5); vId = int(aId + .5);
  vShadow = uLight * vec4(p, 1.0);
  gl_Position = uVP * vec4(p, 1.0);
}`;

const noiseSource = `
float hash(vec3 p) {
  p = fract(p * .1031); p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p) {
  float total=0.0, amp=.5;
  for(int i=0;i<4;i++){total+=noise3(p)*amp;p=p*2.03+vec3(1.7,9.2,3.4);amp*=.5;}
  return total;
}
vec3 displayColor(vec3 c) {
  return pow(max(vec3(0), 1.0-exp(-c*1.35)), vec3(1.0/2.2));
}
`;

const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
in vec3 vPosition;
in vec3 vNormal;
in vec3 vColor;
in vec4 vShadow;
flat in int vKind;
flat in int vId;
uniform vec3 uEye;
uniform vec3 uSun;
uniform sampler2D uShadow;
uniform int uMode;
layout(location=0) out vec4 color;
${noiseSource}
float visibility(vec3 normal) {
  vec3 p=vShadow.xyz/vShadow.w*.5+.5;
  if(any(lessThan(p,vec3(0))) || any(greaterThan(p,vec3(1)))) return 1.0;
  float bias=max(.00018,.0007*(1.0-max(dot(normal,uSun),0.0)));
  float result=0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
    float d=texture(uShadow,p.xy+vec2(x,y)/2048.0).r;
    result+=p.z-bias<=d?1.0:0.0;
  }
  return result/9.0;
}
void main() {
  if(uMode==1) {
    color=vec4(float(vId&255)/255.0,float((vId>>8)&255)/255.0,float((vId>>16)&255)/255.0,1);
    return;
  }
  vec3 normal=normalize(vNormal);
  if(!gl_FrontFacing)normal=-normal;
  vec3 albedo=vColor;
  float detail=noise3(vPosition*(vKind==1?13.0:1.8));
  if(vKind==1 || vKind==3) {
    float mineral=fbm(vPosition*4.5);
    albedo*=.76+mineral*.5;
    vec3 dpdx=dFdx(vPosition),dpdy=dFdy(vPosition);
    vec3 tangent=cross(dpdy,normal),bitangent=cross(normal,dpdx);
    float denom=max(.000001,abs(dot(dpdx,tangent)));
    normal=normalize(normal-(dFdx(detail)*tangent+dFdy(detail)*bitangent)*(.025/denom));
  }
  if(vKind==0) albedo*=.83+fbm(vPosition*.75)*.38;
  float diffuse=max(dot(normal,uSun),0.0);
  float shadow=visibility(normal);
  vec3 ambient=vec3(.51,.58,.64)*(.72+.28*max(normal.z,0.0));
  vec3 radiance=albedo*(ambient+vec3(1.30,1.16,.93)*diffuse*shadow);
  if(vKind==2) radiance+=albedo*vec3(.29,.32,.19)*pow(max(dot(-normal,uSun),0.0),.7);
  if(vKind==5) radiance=albedo*(vec3(.35,.40,.42)+diffuse*vec3(.28,.25,.20));
  float distanceToEye=length(vPosition-uEye);
  float haze=1.0-exp(-max(0.0,distanceToEye-25.0)*.0017);
  if(vKind==5)haze=0.0;
  radiance=mix(radiance,vec3(.55,.65,.69),haze);
  color=vec4(displayColor(radiance),1);
}`;

const skyVertex = `#version 300 es
precision highp float;
out vec2 vUV;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vUV=p;gl_Position=vec4(p*2.0-1.0,1,1);}`;
const skyFragment = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec3 uEye;
uniform vec3 uWindow;
uniform vec3 uSun;
uniform int uMode;
layout(location=0) out vec4 color;
${noiseSource}
void main(){
  if(uMode==1){color=vec4(0,0,0,1);return;}
  vec3 aperture=vec3((vUV.x-.5)*uWindow.x,0,uWindow.z+(vUV.y-.5)*uWindow.y);
  vec3 ray=normalize(aperture-uEye);
  float height=pow(max(0.0,ray.z),.45);
  vec3 sky=mix(vec3(.55,.65,.69),vec3(.21,.37,.52),height);
  vec2 cloudPlane=ray.xy/max(.045,ray.z);
  float cloud=fbm(vec3(cloudPlane*.57,1.82));
  float wisps=smoothstep(.50,.68,cloud)*smoothstep(.015,.15,ray.z);
  sky=mix(sky,vec3(.89,.88,.79),wisps*.72);
  sky+=vec3(.36,.27,.15)*pow(max(dot(ray,uSun),0.0),18.0);
  color=vec4(displayColor(sky),1);
}`;

function program(vertex, fragment) {
  const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not allocate a shader.');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Scene shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  });
  const result = gl.createProgram();
  if (!result) throw new Error('Could not allocate a scene program.');
  for (const shader of shaders) gl.attachShader(result, shader);
  gl.linkProgram(result);
  for (const shader of shaders) gl.deleteShader(shader);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(`Scene program: ${gl.getProgramInfoLog(result)}`);
  return result;
}
const uniform = (p, name) => gl.getUniformLocation(p, name);
const matrix = (p, name, value) => gl.uniformMatrix4fv(uniform(p, name), false, value);
const vec = (p, name, value) => gl.uniform3fv(uniform(p, name), value);
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) out[c*4+r]+=a[k*4+r]*b[c*4+k];
  return out;
}
const normalize = (v) => { const d=Math.hypot(...v); return v.map(x=>x/d); };
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a.reduce((sum,x,i)=>sum+x*b[i],0);
function lookAt(eye, target) {
  const z=normalize(eye.map((x,i)=>x-target[i])),x=normalize(cross([0,0,1],z)),y=cross(z,x);
  return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
}
function aperture() {
  const aspect=canvas.width/canvas.height, width=metadata.window.width;
  return [Math.max(width,width*aspect/(4/3)),Math.max(metadata.window.height,width/aspect),metadata.window.centerZ];
}
function projection(eye) {
  const [w,h,centerZ]=aperture(), near=.1, far=4000, d=-eye[1];
  const l=(-w/2-eye[0])*near/d,r=(w/2-eye[0])*near/d;
  const b=(centerZ-h/2-eye[2])*near/d,t=(centerZ+h/2-eye[2])*near/d;
  const p=new Float32Array([2*near/(r-l),0,0,0,0,2*near/(t-b),0,0,(r+l)/(r-l),(t+b)/(t-b),-(far+near)/(far-near),-1,0,0,-2*far*near/(far-near),0]);
  const v=new Float32Array([1,0,0,0,0,0,-1,0,0,1,0,0,-eye[0],-eye[2],eye[1],1]);
  return multiply(p,v);
}
function eyePosition(value=state.current) {
  return [value[0]*metadata.travel.x, metadata.eye[1], metadata.eye[2]+value[1]*metadata.travel.z];
}
function project(point, control=state.current) {
  const eye=eyePosition(control),[w,h,c]=aperture(),d=-eye[1],z=point[1]-eye[1];
  return [.5+(d*(point[0]-eye[0])/z+eye[0])/w,.5+(d*(point[2]-eye[2])/z+eye[2]-c)/h];
}

function shadow() {
  const s=metadata.sunDirection,eye=s.map((x,i)=>x*95+(i===1?10:0));
  const ortho=new Float32Array([1/42,0,0,0,0,1/42,0,0,0,0,-2/190,0,0,0,-1,1]);
  lightMatrix=multiply(ortho,lookAt(eye,[0,10,0]));
  shadowMap=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,shadowMap);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,2048,2048,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
  for (const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,axis,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  const fbo=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,shadowMap,0);
  gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('The scene shadow target is unavailable.');
  gl.viewport(0,0,2048,2048);gl.clear(gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1.8,4);
  gl.useProgram(shadowProgram);matrix(shadowProgram,'uVP',lightMatrix);matrix(shadowProgram,'uLight',lightMatrix);
  vec(shadowProgram,'uWindow',[metadata.window.width,metadata.window.height,metadata.window.centerZ]);
  gl.bindVertexArray(vao);gl.drawElements(gl.TRIANGLES,indexCount,gl.UNSIGNED_INT,0);
  gl.disable(gl.POLYGON_OFFSET_FILL);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);
}

function render(mode=0) {
  if(!state.ready)return;
  const start=performance.now(),eye=eyePosition(),windowSize=aperture();
  gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);gl.bindVertexArray(skyVao);gl.useProgram(skyProgram);
  vec(skyProgram,'uEye',eye);vec(skyProgram,'uWindow',windowSize);vec(skyProgram,'uSun',metadata.sunDirection);
  gl.uniform1i(uniform(skyProgram,'uMode'),mode);gl.drawArrays(gl.TRIANGLES,0,3);
  gl.enable(gl.DEPTH_TEST);gl.bindVertexArray(vao);gl.useProgram(sceneProgram);
  matrix(sceneProgram,'uVP',projection(eye));matrix(sceneProgram,'uLight',lightMatrix);
  vec(sceneProgram,'uEye',eye);vec(sceneProgram,'uWindow',windowSize);vec(sceneProgram,'uSun',metadata.sunDirection);
  gl.uniform1i(uniform(sceneProgram,'uMode'),mode);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,shadowMap);gl.uniform1i(uniform(sceneProgram,'uShadow'),0);
  gl.drawElements(gl.TRIANGLES,indexCount,gl.UNSIGNED_INT,0);
  state.frames++;state.lastMs=performance.now()-start;
  if(mode===0){state.renderTimes.push(state.lastMs);if(state.renderTimes.length>120)state.renderTimes.shift();}
}

function resize() {
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio,1.5,Math.sqrt(2400000/Math.max(1,rect.width*rect.height)));
  const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
  if(width!==canvas.width||height!==canvas.height){canvas.width=width;canvas.height=height;render();}
}
new ResizeObserver(resize).observe(stage);
function animate(now) {
  raf=0;
  if(!state.ready||document.hidden)return;
  const interval=lastTime?now-lastTime:16;
  const dt=Math.min(50,interval)/1000;lastTime=now;
  if(interval<250){state.frameIntervals.push(interval);if(state.frameIntervals.length>180)state.frameIntervals.shift();}
  if(state.auto){state.target=[Math.sin(now*.00045)*.94,Math.sin(now*.00031)*.45];}
  // Exact critically damped spring, upsampling the 15 Hz detector at the display rate.
  const omega=state.source==='head'?12:15, decay=Math.exp(-omega*dt);
  for(let i=0;i<2;i++){
    if(reducedMotion.matches){state.current[i]=state.target[i];state.velocity[i]=0;continue;}
    const offset=state.current[i]-state.target[i],j=state.velocity[i]+omega*offset;
    state.current[i]=state.target[i]+(offset+j*dt)*decay;
    state.velocity[i]=(state.velocity[i]-omega*j*dt)*decay;
    if(Math.abs(state.current[i]-state.target[i])<.0002&&Math.abs(state.velocity[i])<.001){state.current[i]=state.target[i];state.velocity[i]=0;}
  }
  render();
  if(state.auto||state.current.some((x,i)=>x!==state.target[i]))requestFrame();
}
function requestFrame(){if(!raf&&state.ready&&!document.hidden)raf=requestAnimationFrame(animate);}
function move(x,y,immediate=false) {
  if(![x,y].every(Number.isFinite))return;
  state.target=[clamp(x),clamp(y)];
  if(immediate||reducedMotion.matches){state.current=[...state.target];state.velocity=[0,0];render();}else requestFrame();
}
function stopHead(){state.headAbort?.abort();state.headAbort=null;state.head?.stop();state.head=null;if($('head'))$('head').setAttribute('aria-pressed','false');}
function stopInputs() {
  state.auto=false;$('auto').setAttribute('aria-pressed','false');
  state.tilt=false;state.tiltBase=null;$('tilt').setAttribute('aria-pressed','false');
  window.removeEventListener('deviceorientation',onTilt);stopHead();
}
function recenter(){
  state.auto=false;$('auto').setAttribute('aria-pressed','false');
  state.tiltBase=null;state.head?.recenter();move(0,0,true);
  setStatus(state.head?'Hold still briefly to recenter head tracking.':'Centered. Lean or move to reveal the landscape behind the opening.');
}
$('recenter').onclick=recenter;
$('auto').onclick=()=>{
  const next=!state.auto;stopInputs();state.auto=next;state.source=next?'auto':'pointer';
  $('auto').setAttribute('aria-pressed',String(next));
  setStatus(next?'Automatic perspective preview. Move over the scene to take control.':'Automatic movement stopped.');requestFrame();
};
let drag=null;
canvas.addEventListener('pointerdown',event=>{
  if(!state.ready)return;stopInputs();state.source='pointer';canvas.focus({preventScroll:true});
  if(event.pointerType!=='mouse'){drag={id:event.pointerId,x:event.clientX,y:event.clientY,start:[...state.target]};canvas.setPointerCapture(event.pointerId);}
});
canvas.addEventListener('pointermove',event=>{
  if(!state.ready||state.headAbort||state.tilt)return;
  const r=canvas.getBoundingClientRect();
  if(event.pointerType==='mouse'){
    if(state.auto){stopInputs();state.source='pointer';}
    move((event.clientX-r.left)/r.width*2-1,1-(event.clientY-r.top)/r.height*2);
  }else if(drag?.id===event.pointerId){move(drag.start[0]+(event.clientX-drag.x)/r.width*2,drag.start[1]-(event.clientY-drag.y)/r.height*2);}
});
for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{drag=null;});
canvas.addEventListener('keydown',event=>{
  const delta={ArrowLeft:[-.15,0],ArrowRight:[.15,0],ArrowUp:[0,.15],ArrowDown:[0,-.15]}[event.key];
  if(delta){event.preventDefault();stopInputs();state.source='keyboard';move(state.target[0]+delta[0],state.target[1]+delta[1]);}
  if(event.key==='Home'){event.preventDefault();recenter();}
});
function onTilt(event){
  if(!state.tilt||event.beta===null||event.gamma===null)return;
  const angle=(screen.orientation?.angle??window.orientation??0)*Math.PI/180;
  const next=[event.gamma*Math.cos(angle)+event.beta*Math.sin(angle),event.beta*Math.cos(angle)-event.gamma*Math.sin(angle)];
  if(!state.tiltBase){state.tiltBase=next;setStatus('Tilt is on. Recenter sets a new resting position.');}
  move((next[0]-state.tiltBase[0])/16,-(next[1]-state.tiltBase[1])/16);
}
$('tilt').onclick=async()=>{
  if(state.tilt){stopInputs();state.source='pointer';setStatus('Tilt stopped. Drag the scene to look around.');return;}
  stopInputs();
  try{
    if(typeof DeviceOrientationEvent==='undefined')throw new Error('Tilt is unavailable in this browser.');
    if(typeof DeviceOrientationEvent.requestPermission==='function'&&await DeviceOrientationEvent.requestPermission()!=='granted')throw new Error('Tilt permission was denied.');
    state.tilt=true;state.source='tilt';$('tilt').setAttribute('aria-pressed','true');
    window.addEventListener('deviceorientation',onTilt);setStatus('Tilt is on. Hold your device still to set the resting position.');
  }catch(error){setStatus(`${error.message} Drag the scene or use arrow keys.`);}
};
screen.orientation?.addEventListener('change',()=>{state.tiltBase=null;});
$('head')?.addEventListener('click',async()=>{
  if(state.headAbort){stopHead();state.source='pointer';setStatus('Head tracking stopped. The camera is off.');return;}
  stopInputs();state.source='head';const abort=new AbortController();state.headAbort=abort;
  $('head').setAttribute('aria-pressed','true');setStatus('Opening the camera. Hold still briefly to center your view.');
  try{
    const {startHeadTracking}=await import('./tracking.js');
    const head=await startHeadTracking({signal:abort.signal,onTarget:({x,y})=>move(x*state.gain,y*state.gain),onState:sample=>{
      if(abort.signal.aborted)return;
      setStatus(sample.message);
      if(sample.kind==='failed'){stopHead();state.source='pointer';setStatus(`${sample.message} Use the pointer, touch, or tilt controls.`);}
    }});
    if(abort.signal.aborted){head.stop();return;}state.head=head;
  }catch(error){if(!abort.signal.aborted){stopHead();state.source='pointer';setStatus(`${error.message} Use the pointer, touch, or tilt controls.`);}}
});
$('gain')?.addEventListener('input',event=>{state.gain=Number(event.target.value);$('gain-value').textContent=`${state.gain.toFixed(1)}×`;});
$('fullscreen').onclick=async()=>{
  try{
    if(document.fullscreenElement){await document.exitFullscreen();return;}
    if(stage.requestFullscreen){await stage.requestFullscreen();return;}
  }catch{}
  const expanded=document.body.classList.toggle('expanded');$('fullscreen').textContent=expanded?'Exit full screen':'Full screen';resize();
};
document.addEventListener('visibilitychange',()=>{lastTime=0;if(document.hidden){stopHead();state.tiltBase=null;}else requestFrame();});
window.addEventListener('pagehide',()=>{stopInputs();cancelAnimationFrame(raf);raf=0;lastTime=0;});
window.addEventListener('pageshow',()=>{lastTime=0;requestFrame();});

async function init(){
  for(const button of buttons)if(button.id!=='fullscreen')button.disabled=true;
  const response=await fetch('field.json');if(!response.ok)throw new Error('Scene information could not load.');
  metadata=await response.json();
  if(metadata.version!==1||!Array.isArray(metadata.objects)||metadata.objects.length>4096||
    ![metadata.window?.width,metadata.window?.height,metadata.window?.centerZ,metadata.travel?.x,metadata.travel?.z,...(metadata.eye??[]),...(metadata.sunDirection??[])].every(Number.isFinite)||
    metadata.eye?.length!==3||metadata.sunDirection?.length!==3||metadata.window.width<=0||metadata.window.height<=0||metadata.eye[1]>=0)throw new Error('Scene information is invalid.');
  const mesh=await fetch('field.mesh');if(!mesh.ok)throw new Error('The landscape geometry could not load.');
  const bytes=await mesh.arrayBuffer();if(bytes.byteLength<16||bytes.byteLength>80*1024*1024)throw new Error('The landscape mesh has an invalid size.');
  const header=new DataView(bytes),count=header.getUint32(4,true);indexCount=header.getUint32(8,true);
  if(header.getUint32(0,true)!==0x31464c48||header.getUint32(12,true)!==44||count!==metadata.vertexCount||indexCount!==metadata.triangleCount*3||
    bytes.byteLength!==16+count*44+indexCount*4)throw new Error('The landscape mesh format is invalid.');
  const vertexData=new Float32Array(bytes,16,count*11),indexData=new Uint32Array(bytes,16+count*44,indexCount);
  if(!vertexData.every(Number.isFinite)||!indexData.every(i=>i<count))throw new Error('The landscape mesh contains invalid coordinates.');
  gl=canvas.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
  if(!gl)throw new Error('WebGL2 is unavailable in this browser.');
  gl.disable(gl.CULL_FACE);gl.disable(gl.DITHER);
  sceneProgram=program(vertexSource,fragmentSource);skyProgram=program(skyVertex,skyFragment);
  shadowProgram=program(vertexSource,`#version 300 es\nprecision highp float;\nvoid main(){}`);
  vao=gl.createVertexArray();skyVao=gl.createVertexArray();gl.bindVertexArray(vao);
  const vertices=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vertices);gl.bufferData(gl.ARRAY_BUFFER,vertexData,gl.STATIC_DRAW);
  for(const [location,size,offset]of [[0,3,0],[1,3,12],[2,3,24],[3,1,36],[4,1,40]]){
    gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,44,offset);
  }
  const indices=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indexData,gl.STATIC_DRAW);
  shadow();state.ready=true;resize();render();
  if(gl.getError()!==gl.NO_ERROR)throw new Error('The graphics driver could not render the landscape.');
  $('loading').hidden=true;$('poster').hidden=true;for(const button of buttons)button.disabled=false;
  setStatus('Lean to look past the stones. Start Head tracking for camera control.');
}

// Scalar inspection and actual GPU visibility, for the isolated demo's verification.
window.highland={
  snapshot:()=>({ready:state.ready,source:state.source,eye:metadata?eyePosition():null,target:[...state.target],current:[...state.current],
    frames:state.frames,lastSubmitMs:state.lastMs,averageSubmitMs:state.renderTimes.reduce((a,b)=>a+b,0)/Math.max(1,state.renderTimes.length),
    triangles:metadata?.triangleCount,canvas:[canvas.width,canvas.height],head:state.head?.snapshot()??null,error:state.error,
    auto:state.auto,tilt:state.tilt,gain:state.gain,aperture:metadata?aperture():null,
    frameTiming:state.frameIntervals.length?{samples:state.frameIntervals.length,medianMs:[...state.frameIntervals].sort((a,b)=>a-b)[Math.floor(state.frameIntervals.length/2)],p95Ms:[...state.frameIntervals].sort((a,b)=>a-b)[Math.floor(state.frameIntervals.length*.95)]}:null}),
  project,objects:()=>metadata?.objects??[],
  visibility:()=>{
    if(!state.ready)throw new Error('The scene is not ready.');
    render(1);const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    const counts=new Map();for(let i=0;i<pixels.length;i+=4){const id=pixels[i]+pixels[i+1]*256+pixels[i+2]*65536;counts.set(id,(counts.get(id)??0)+1);}
    render();return metadata.objects.map(o=>({id:o.id,name:o.name,pixels:counts.get(o.id)??0}));
  },
};
init().catch(fail);
