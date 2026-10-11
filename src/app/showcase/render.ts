import { viewMatrix, type Eye, type ShowcaseScene } from './scene.ts';

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
uniform mat4 mvp;
out vec3 worldPosition;
out vec3 worldNormal;
void main(){ worldPosition=position; worldNormal=normal; gl_Position=mvp*vec4(position,1.0); }`;
const depthFragment = `#version 300 es
precision highp float;
void main(){}`;
const declarations = Array.from({ length: 5 }, (_, i) => `uniform mat4 reference${i}; uniform sampler2D color${i}; uniform sampler2D depth${i};`).join('\n');
const projections = Array.from({ length: 5 }, (_, i) => `{
  vec4 clip=reference${i}*vec4(worldPosition,1.0);
  vec3 p=clip.xyz/clip.w*.5+.5;
  // The reference depth sample is at its texel center. Account for this
  // surface's slope in reference texels, especially on grazing pool/ground.
  vec2 dx=dFdx(p.xy)*referenceSize,dy=dFdy(p.xy)*referenceSize;
  float det=dx.x*dy.y-dx.y*dy.x;
  float safeDet=(det<0.0?-1.0:1.0)*max(abs(det),.00000001);
  vec2 slope=vec2(dFdx(p.z)*dy.y-dFdy(p.z)*dx.y,dFdy(p.z)*dx.x-dFdx(p.z)*dy.x)/safeDet;
  float tolerance=max(.000002,.8*(abs(slope.x)+abs(slope.y)));
  if(clip.w>0.0 && p.x>0.001 && p.x<0.999 && p.y>0.001 && p.y<0.999 && p.z>0.0 && p.z<1.0){
    float stored=texture(depth${i},p.xy).r;
    float visible=1.0-smoothstep(tolerance*.5,tolerance,abs(stored-p.z));
    float weight=weights[${i}]*visible;
    sum+=texture(color${i},p.xy).rgb*weight;
    total+=weight;
  }
}`).join('\n');
const fragment = `#version 300 es
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
out vec4 result;
uniform float weights[5];
uniform vec2 referenceSize;
uniform vec3 materialColor;
uniform float emission;
uniform bool worldLighting;
${declarations}
vec3 lamp(vec3 position,vec3 normal,vec3 at,float strength){
  vec3 direction=at-position;
  return vec3(1.0,.58,.25)*strength*max(dot(normal,normalize(direction)),0.0)/(1.0+.055*dot(direction,direction));
}
void main(){
  vec3 n=normalize(worldNormal)*(gl_FrontFacing?1.0:-1.0);
  if(worldLighting){
    // The broad cavity is one continuous physical surface. Its lighting must
    // not inherit viewpoint-specific projected occlusion or triangle seams.
    vec3 lighting=vec3(.38,.55,.68);
    lighting+=lamp(worldPosition,n,vec3(-2.48,-1.35,3.22),3.6);
    lighting+=lamp(worldPosition,n,vec3(2.71,-.85,3.64),3.6);
    lighting+=lamp(worldPosition,n,vec3(0.0,18.0,4.3),4.8);
    vec3 color=materialColor*lighting;
    result=vec4(pow(color/(vec3(1.0)+color),vec3(1.0/2.2)),1.0);
    return;
  }
  vec3 sum=vec3(0.0);float total=0.0;
  ${projections}
  float light=.2+.65*max(0.0,dot(n,normalize(vec3(-.4,-.5,1.0))));
  vec3 fallback=materialColor*(light+emission*.8);
  fallback=pow(fallback/(vec3(1.0)+fallback),vec3(1.0/2.2));
  result=vec4(total>.00000001?sum/total:fallback,1.0);
}`;

/** The closed showcase renders real triangles; reference images supply baked lighting only. */
export async function createShowcaseRenderer(canvas: HTMLCanvasElement, scene: ShowcaseScene,
  vertices: Float32Array<ArrayBuffer>, base: URL, signal: AbortSignal) {
  // Complete all asynchronous work before touching a shared graphics context.
  const loaded = await Promise.allSettled(scene.references.map(async reference => {
    const response = await fetch(new URL(reference.image, base), { signal });
    if (!response.ok) throw new Error(`A scene lighting reference could not load (${response.status}).`);
    return createImageBitmap(await response.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
  }));
  const images = loaded.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const closeImages = (): void => { images.forEach(image => image.close()); };
  const failure = loaded.find(result => result.status === 'rejected');
  if (failure !== undefined) { closeImages(); const cause: unknown = failure.reason; throw cause; }
  if (signal.aborted) { closeImages(); signal.throwIfAborted(); }
  if (images.some(image => image.width !== scene.size[0] || image.height !== scene.size[1])) {
    closeImages(); throw new Error('A scene lighting reference has the wrong dimensions.');
  }
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' });
  if (gl === null) { closeImages(); throw new Error('This showcase needs WebGL2. Try a browser with hardware acceleration enabled.'); }
  const textures: WebGLTexture[] = [], framebuffers: WebGLFramebuffer[] = [], programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [], arrays: WebGLVertexArrayObject[] = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    textures.forEach(t => gl.deleteTexture(t)); framebuffers.forEach(f => gl.deleteFramebuffer(f));
    programs.forEach(p => gl.deleteProgram(p)); buffers.forEach(b => gl.deleteBuffer(b)); arrays.forEach(a => gl.deleteVertexArray(a));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindVertexArray(null); gl.activeTexture(gl.TEXTURE0);
  };
  const program = (fragmentSource: string): WebGLProgram => {
    const shaders: WebGLShader[] = [];
    const p = gl.createProgram();
    if (p === null) throw new Error('The scene renderer could not allocate a shader program.');
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragmentSource]] satisfies readonly (readonly [number, string])[]) {
        const shader = gl.createShader(type);
        if (shader === null) throw new Error('The scene renderer could not allocate a shader.');
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`The scene shader could not compile: ${gl.getShaderInfoLog(shader) ?? 'unknown error'}`);
        gl.attachShader(p, shader);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`The scene shader could not link: ${gl.getProgramInfoLog(p) ?? 'unknown error'}`);
      programs.push(p); return p;
    } catch (error) { gl.deleteProgram(p); throw error; }
    finally { shaders.forEach(s => gl.deleteShader(s)); }
  };
  const texture = (): WebGLTexture => {
    const t = gl.createTexture(); if (t === null) throw new Error('The scene renderer could not allocate a texture.');
    textures.push(t); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.drawBuffers([gl.BACK]); gl.readBuffer(gl.BACK);
    gl.activeTexture(gl.TEXTURE0); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.disable(gl.BLEND); gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.DITHER); gl.depthMask(true);
    const depthProgram = program(depthFragment), surfaceProgram = program(fragment);
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('The scene geometry could not be allocated.');
    arrays.push(vao);
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('The scene geometry could not be allocated.');
    buffers.push(buffer); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.disable(gl.CULL_FACE); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    const views: { color: WebGLTexture; depth: WebGLTexture }[] = [];
    for (const [i, reference] of scene.references.entries()) {
      const image = images[i];
      if (image === undefined) throw new Error('A scene lighting reference is missing.');
      const color = texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.generateMipmap(gl.TEXTURE_2D);
      const depth = texture();
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, scene.size[0], scene.size[1], 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      const framebuffer = gl.createFramebuffer();
      if (framebuffer === null) throw new Error('The scene visibility buffer could not be allocated.');
      framebuffers.push(framebuffer); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The scene visibility buffer is unavailable on this device.');
      gl.viewport(0, 0, scene.size[0], scene.size[1]); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(depthProgram); gl.uniformMatrix4fv(gl.getUniformLocation(depthProgram, 'mvp'), false, new Float32Array(reference.matrix));
      gl.drawArrays(gl.TRIANGLES, 0, scene.vertexCount);
      views.push({ color, depth });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.drawBuffers([gl.BACK]); gl.readBuffer(gl.BACK);
    gl.useProgram(surfaceProgram);
    gl.uniform2f(gl.getUniformLocation(surfaceProgram, 'referenceSize'), scene.size[0], scene.size[1]);
    for (const [i, reference] of scene.references.entries()) {
      const view = views[i];
      if (view === undefined) throw new Error('A scene lighting reference is missing.');
      gl.activeTexture(gl.TEXTURE0 + i * 2); gl.bindTexture(gl.TEXTURE_2D, view.color);
      gl.activeTexture(gl.TEXTURE0 + i * 2 + 1); gl.bindTexture(gl.TEXTURE_2D, view.depth);
      gl.uniform1i(gl.getUniformLocation(surfaceProgram, `color${i}`), i * 2);
      gl.uniform1i(gl.getUniformLocation(surfaceProgram, `depth${i}`), i * 2 + 1);
      gl.uniformMatrix4fv(gl.getUniformLocation(surfaceProgram, `reference${i}`), false, new Float32Array(reference.matrix));
    }
    const mvp = gl.getUniformLocation(surfaceProgram, 'mvp'), weightsLocation = gl.getUniformLocation(surfaceProgram, 'weights[0]');
    const colorLocation = gl.getUniformLocation(surfaceProgram, 'materialColor'), emissionLocation = gl.getUniformLocation(surfaceProgram, 'emission');
    const worldLighting = gl.getUniformLocation(surfaceProgram, 'worldLighting');
    const weights = new Float32Array(5);
    let lastDrawMs = 0, drawCount = 0;
    const draw = (eye: Eye): void => {
      if (disposed || gl.isContextLost()) throw new Error('The 3D renderer stopped. Reload the showcase to recover.');
      const started = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.drawBuffers([gl.BACK]); gl.readBuffer(gl.BACK);
      gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.DITHER);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
      for (const [i, view] of views.entries()) {
        gl.activeTexture(gl.TEXTURE0 + i * 2); gl.bindTexture(gl.TEXTURE_2D, view.color);
        gl.activeTexture(gl.TEXTURE0 + i * 2 + 1); gl.bindTexture(gl.TEXTURE_2D, view.depth);
      }
      const rect = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio, 1.5, 1600 / Math.max(1, rect.width));
      const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(.025, .045, .055, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.useProgram(surfaceProgram); gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(mvp, false, viewMatrix(scene, eye));
      for (const [i, reference] of scene.references.entries()) {
        const dx = (eye.x - reference.eye[0]) / scene.camera.travel[0];
        const dy = (eye.y - reference.eye[1]) / scene.camera.travel[1];
        weights[i] = Math.exp(-2.5 * (dx * dx + dy * dy));
      }
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      for (let i = 0; i < weights.length; i++) weights[i] = (weights[i] ?? 0) / totalWeight;
      gl.uniform1fv(weightsLocation, weights);
      for (const batch of scene.batches) {
        gl.uniform3fv(colorLocation, batch.color); gl.uniform1f(emissionLocation, batch.emission);
        gl.uniform1i(worldLighting, batch.lighting === 'world' ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
      }
      lastDrawMs = performance.now() - started; drawCount++;
      if (drawCount === 1 && gl.getError() !== gl.NO_ERROR) throw new Error('The device could not render the 3D scene.');
    };
    return { draw, dispose, metrics: () => ({ triangles: scene.vertexCount / 3, drawCount, submissionMs: lastDrawMs,
      width: canvas.width, height: canvas.height, actualGeometry: true, depthReferences: views.length }) };
  } catch (error) { dispose(); throw error; }
  finally { closeImages(); }
}
