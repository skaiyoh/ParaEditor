import { landscapeAperture, landscapeEye, landscapeMatrix, type LandscapeMesh } from './landscape.ts';
import { multiply, type Eye } from './scene.ts';

// Shader source preserved from the user-approved assets/scenes/highland-field/viewer.js.
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


/** Retains the user-approved Highland shaders, sun, shadow map and tone curve. */
export function createLandscapeRenderer(canvas: HTMLCanvasElement, mesh: LandscapeMesh) {
  const {scene, vertices, indices} = mesh;
  const gl = canvas.getContext('webgl2', {alpha:false, antialias:true, preserveDrawingBuffer:true, powerPreference:'high-performance'});
  if (gl === null) throw new Error('WebGL2 is unavailable. Try a browser with hardware acceleration.');
  const programs: WebGLProgram[] = [], buffers: WebGLBuffer[] = [], arrays: WebGLVertexArrayObject[] = [], textures: WebGLTexture[] = [], frames: WebGLFramebuffer[] = [];
  let disposed = false, drawCount = 0, submissionMs = 0;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    programs.forEach(value => gl.deleteProgram(value)); buffers.forEach(value => gl.deleteBuffer(value)); arrays.forEach(value => gl.deleteVertexArray(value));
    textures.forEach(value => gl.deleteTexture(value)); frames.forEach(value => gl.deleteFramebuffer(value));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindVertexArray(null); gl.activeTexture(gl.TEXTURE0);
  };
  const allocate = <T>(value: T | null, collection: T[]): T => {
    if (value === null) throw new Error('The scene graphics resources could not be allocated.');
    collection.push(value); return value;
  };
  const program = (vertex: string, fragment: string): WebGLProgram => {
    const result = allocate(gl.createProgram(), programs), shaders: WebGLShader[] = [];
    try {
      for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] satisfies readonly (readonly [number, string])[]) {
        const shader = gl.createShader(kind); if (shader === null) throw new Error('The scene shader could not be allocated.');
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Scene shader: ${gl.getShaderInfoLog(shader) ?? 'Compilation failed.'}`);
        gl.attachShader(result, shader);
      }
      gl.linkProgram(result);
      if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(`Scene program: ${gl.getProgramInfoLog(result) ?? 'Linking failed.'}`);
      return result;
    } finally { shaders.forEach(shader => gl.deleteShader(shader)); }
  };
  const matrix = (p: WebGLProgram, name: string, value: Float32Array<ArrayBuffer>) => gl.uniformMatrix4fv(gl.getUniformLocation(p, name), false, value);
  const vec = (p: WebGLProgram, name: string, value: readonly number[]) => gl.uniform3fv(gl.getUniformLocation(p, name), new Float32Array(value));
  const normalized = (a: readonly number[]): number[] => {const length=Math.hypot(...a);return a.map(value=>value/length);};
  const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum,value,i)=>sum+value*(b[i]??0),0);
  const cross = (a: readonly number[],b: readonly number[]): number[] => [(a[1]??0)*(b[2]??0)-(a[2]??0)*(b[1]??0),(a[2]??0)*(b[0]??0)-(a[0]??0)*(b[2]??0),(a[0]??0)*(b[1]??0)-(a[1]??0)*(b[0]??0)];
  const lookAt = (eye: readonly number[],target: readonly number[]): Float32Array<ArrayBuffer> => {
    const z=normalized(eye.map((value,i)=>value-(target[i]??0))),x=normalized(cross([0,0,1],z)),y=cross(z,x);
    return new Float32Array([x[0]??0,y[0]??0,z[0]??0,0,x[1]??0,y[1]??0,z[1]??0,0,x[2]??0,y[2]??0,z[2]??0,0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
  };
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.drawBuffers([gl.BACK]); gl.readBuffer(gl.BACK);
    gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true); gl.depthFunc(gl.LESS); gl.activeTexture(gl.TEXTURE0); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    const surface=program(vertexSource,fragmentSource),sky=program(skyVertex,skyFragment);
    const depth=program(vertexSource,'#version 300 es\nprecision highp float;\nvoid main(){}');
    const vao=allocate(gl.createVertexArray(),arrays),skyVao=allocate(gl.createVertexArray(),arrays);
    gl.bindVertexArray(vao);
    const vertexBuffer=allocate(gl.createBuffer(),buffers); gl.bindBuffer(gl.ARRAY_BUFFER,vertexBuffer); gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
    for(const [location,size,offset] of [[0,3,0],[1,3,12],[2,3,24],[3,1,36],[4,1,40]]) {
      if(location===undefined||size===undefined||offset===undefined)throw new Error('Invalid scene vertex layout.');
      gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,44,offset);
    }
    const indexBuffer=allocate(gl.createBuffer(),buffers); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
    const sun=scene.sunDirection, lightEye=sun.map((value,i)=>value*95+(i===1?10:0));
    const light=multiply(new Float32Array([1/42,0,0,0,0,1/42,0,0,0,0,-2/190,0,0,0,-1,1]),lookAt(lightEye,[0,10,0]));
    const shadow=allocate(gl.createTexture(),textures);gl.bindTexture(gl.TEXTURE_2D,shadow);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,2048,2048,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
    for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,axis,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    const fbo=allocate(gl.createFramebuffer(),frames);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,shadow,0);gl.drawBuffers([gl.NONE]);gl.readBuffer(gl.NONE);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('The scene shadow target is unavailable.');
    gl.viewport(0,0,2048,2048);gl.clearDepth(1);gl.clear(gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1.8,4);
    gl.useProgram(depth);matrix(depth,'uVP',light);matrix(depth,'uLight',light);vec(depth,'uWindow',[scene.window.width,scene.window.height,scene.window.centerZ]);
    gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_INT,0);gl.disable(gl.POLYGON_OFFSET_FILL);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.drawBuffers([gl.BACK]);gl.readBuffer(gl.BACK);
    const draw = (eye: Eye, mode=0): void => {
      if(disposed||gl.isContextLost())throw new Error('The scene graphics stopped. Reload to recover.');
      const started=performance.now(), box=canvas.getBoundingClientRect();
      const dpr=Math.min(devicePixelRatio,1.5,Math.sqrt(2400000/Math.max(1,box.width*box.height)));
      const width=Math.max(1,Math.round(box.width*dpr)),height=Math.max(1,Math.round(box.height*dpr));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      const actualEye=landscapeEye(scene,eye),aperture=landscapeAperture(scene,canvas.width/canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.drawBuffers([gl.BACK]);gl.readBuffer(gl.BACK);
      gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.disable(gl.POLYGON_OFFSET_FILL);gl.depthMask(true);gl.depthFunc(gl.LESS);
      gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,1);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);gl.bindVertexArray(skyVao);gl.useProgram(sky);
      vec(sky,'uEye',actualEye);vec(sky,'uWindow',aperture);vec(sky,'uSun',sun);gl.uniform1i(gl.getUniformLocation(sky,'uMode'),mode);gl.drawArrays(gl.TRIANGLES,0,3);
      gl.enable(gl.DEPTH_TEST);gl.bindVertexArray(vao);gl.useProgram(surface);
      matrix(surface,'uVP',landscapeMatrix(scene,eye,canvas.width/canvas.height));matrix(surface,'uLight',light);
      vec(surface,'uEye',actualEye);vec(surface,'uWindow',aperture);vec(surface,'uSun',sun);gl.uniform1i(gl.getUniformLocation(surface,'uMode'),mode);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,shadow);gl.uniform1i(gl.getUniformLocation(surface,'uShadow'),0);
      gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_INT,0);
      submissionMs=performance.now()-started;drawCount++;
      if(drawCount===1&&gl.getError()!==gl.NO_ERROR)throw new Error('The device could not render the landscape.');
    };
    return {draw,dispose,metrics:()=>({triangles:scene.triangleCount,drawCount,submissionMs,width:canvas.width,height:canvas.height,actualGeometry:true,depthReferences:0}),
      visibility:(eye: Eye)=>{
        draw(eye,1);const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        const counts=new Map<number,number>();for(let i=0;i<pixels.length;i+=4){const id=(pixels[i]??0)+(pixels[i+1]??0)*256+(pixels[i+2]??0)*65536;counts.set(id,(counts.get(id)??0)+1);}
        draw(eye);return scene.objects.map(object=>({id:object.id,name:object.name,pixels:counts.get(object.id)??0}));
      }};
  } catch(error) {dispose();throw error;}
}
