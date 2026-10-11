export type Texture = { readonly texture: WebGLTexture; readonly width: number; readonly height: number };
export type Target = Texture & { readonly framebuffer: WebGLFramebuffer };
export type Mesh = { readonly vao: WebGLVertexArrayObject; readonly vertices: WebGLBuffer; readonly indices: WebGLBuffer; readonly count: number };
export type Program = { readonly program: WebGLProgram; readonly uniforms: ReadonlyMap<string, WebGLUniformLocation> };
export type Uniform =
  | { readonly kind: 'texture'; readonly value: Texture }
  | { readonly kind: 'int' | 'uint' | 'float'; readonly value: number }
  | { readonly kind: 'ivec2'; readonly value: readonly [number, number] }
  | { readonly kind: 'vec3'; readonly value: readonly [number, number, number] }
  | { readonly kind: 'floatArray' | 'vec3Array'; readonly value: Float32Array };

export function createGl(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
  if (context === null) throw new Error('This look requires WebGL2.');
  const gl: WebGL2RenderingContext = context;
  if (gl.getExtension('EXT_color_buffer_float') === null) throw new Error('This look requires WebGL2 EXT_color_buffer_float.');
  const programs = new Set<WebGLProgram>();
  const textures = new Set<WebGLTexture>();
  const framebuffers = new Set<WebGLFramebuffer>();
  const depths = new Map<WebGLFramebuffer, WebGLRenderbuffer>();
  const meshes = new Set<Mesh>();
  const vao = gl.createVertexArray();
  if (vao === null) throw new Error('The WebGL fullscreen vertex array could not be created.');
  gl.bindVertexArray(vao);
  gl.disable(gl.DITHER);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const vertex = `#version 300 es
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2. - 1., 0., 1.);
  }`;
  function shader(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('The WebGL shader could not be created.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`The render shader failed: ${message}`);
    }
    return shader;
  }
  function program(source: string, vertexSource = vertex): Program {
    const program = gl.createProgram();
    if (program === null) throw new Error('The WebGL program could not be created.');
    programs.add(program);
    try {
      const vs = shader(gl.VERTEX_SHADER, vertexSource);
      let fs: WebGLShader;
      try { fs = shader(gl.FRAGMENT_SHADER, source); }
      catch (error) { gl.deleteShader(vs); throw error; }
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`The render program failed: ${gl.getProgramInfoLog(program)}`);
      const uniforms = new Map<string, WebGLUniformLocation>();
      const count: unknown = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      if (typeof count !== 'number') throw new Error('The render program has no uniform inventory.');
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (info === null) continue;
        const location = gl.getUniformLocation(program, info.name);
        if (location !== null) uniforms.set(info.name.replace(/\[0\]$/, ''), location);
      }
      return { program, uniforms };
    } catch (error) {
      gl.deleteProgram(program); programs.delete(program); throw error;
    }
  }
  function releaseProgram(value: Program): void { gl.deleteProgram(value.program); programs.delete(value.program); }
  function texture(width: number, height: number, format: 'rgba8' | 'rgba16f' | 'r8' | 'r16f' | 'rg16f', data: Uint8Array | Float32Array | null, linear = false): Texture {
    const texture = gl.createTexture();
    if (texture === null) throw new Error('The WebGL texture could not be created.');
    textures.add(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const internal = { rgba8: gl.RGBA8, rgba16f: gl.RGBA16F, r8: gl.R8, r16f: gl.R16F, rg16f: gl.RG16F }[format];
    const components = format === 'r8' || format === 'r16f' ? gl.RED : format === 'rg16f' ? gl.RG : gl.RGBA;
    const floating = format === 'rgba16f' || format === 'r16f' || format === 'rg16f';
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, components,
      floating ? data instanceof Float32Array ? gl.FLOAT : gl.HALF_FLOAT : gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { texture, width, height };
  }
  function bitmap(bitmap: ImageBitmap): Texture {
    const tex = texture(bitmap.width, bitmap.height, 'rgba8', null);
    gl.bindTexture(gl.TEXTURE_2D, tex.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    return tex;
  }
  function target(width: number, height: number, format: boolean | 'r16f' | 'rg16f' = false, linear = false): Target {
    const tex = texture(width, height, typeof format === 'boolean' ? format ? 'rgba16f' : 'rgba8' : format, null, linear);
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) { release(tex); throw new Error('The WebGL framebuffer could not be created.'); }
    framebuffers.add(framebuffer);
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The render framebuffer is incomplete.');
      return { ...tex, framebuffer };
    } catch (error) { gl.deleteFramebuffer(framebuffer); framebuffers.delete(framebuffer); release(tex); throw error; }
  }
  function draw(program: Program, destination: Target | null, uniforms: Readonly<Record<string, Uniform>>, mesh: Mesh | null = null): void {
    gl.useProgram(program.program);
    gl.bindVertexArray(mesh?.vao ?? vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination?.framebuffer ?? null);
    gl.viewport(0, 0, destination?.width ?? canvas.width, destination?.height ?? canvas.height);
    let unit = 0;
    for (const [name, uniform] of Object.entries(uniforms)) {
      const location = program.uniforms.get(name);
      if (location === undefined) continue;
      switch (uniform.kind) {
        case 'texture':
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, uniform.value.texture);
          gl.uniform1i(location, unit++); break;
        case 'int': gl.uniform1i(location, uniform.value); break;
        case 'uint': gl.uniform1ui(location, uniform.value); break;
        case 'float': gl.uniform1f(location, uniform.value); break;
        case 'ivec2': gl.uniform2i(location, ...uniform.value); break;
        case 'vec3': gl.uniform3f(location, ...uniform.value); break;
        case 'floatArray': gl.uniform1fv(location, uniform.value); break;
        case 'vec3Array': gl.uniform3fv(location, uniform.value); break;
        default: { const exhaustive: never = uniform; throw new Error(String(exhaustive)); }
      }
    }
    if (mesh === null) gl.drawArrays(gl.TRIANGLES, 0, 3);
    else gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }
  function mesh(data: { readonly vertices: Float32Array; readonly indices: Uint16Array }): Mesh {
    const array = gl.createVertexArray(), vertices = gl.createBuffer(), indices = gl.createBuffer();
    if (array === null || vertices === null || indices === null) {
      if (array !== null) gl.deleteVertexArray(array);
      if (vertices !== null) gl.deleteBuffer(vertices);
      if (indices !== null) gl.deleteBuffer(indices);
      throw new Error('The geometry buffers could not be created.');
    }
    gl.bindVertexArray(array);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    const result = { vao: array, vertices, indices, count: data.indices.length };
    meshes.add(result);
    return result;
  }
  function releaseMesh(mesh: Mesh): void {
    gl.deleteVertexArray(mesh.vao); gl.deleteBuffer(mesh.vertices); gl.deleteBuffer(mesh.indices);
    meshes.delete(mesh);
  }
  /** Additional outputs remain readable through their own framebuffers. */
  function attachMany(destination: Target, attachments: readonly Target[]): void {
    if (attachments.some((target) => target.width !== destination.width || target.height !== destination.height)) {
      throw new Error('The render attachments must have the same dimensions.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
    for (let i = 0; i < 3; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1 + i, gl.TEXTURE_2D, attachments[i]?.texture ?? null, 0);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, ...attachments.map((_, i) => gl.COLOR_ATTACHMENT1 + i)]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The render attachments are incomplete.');
  }
  function attachDepth(destination: Target): void {
    const depth = gl.createRenderbuffer();
    if (depth === null) throw new Error('The geometry depth buffer could not be created.');
    depths.set(destination.framebuffer, depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, destination.width, destination.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The geometry depth attachment is incomplete.');
  }
  function attach(destination: Target, secondary: Target | null): void {
    attachMany(destination, secondary === null ? [] : [secondary]);
  }
  function release(resource: Texture): void {
    gl.deleteTexture(resource.texture);
    textures.delete(resource.texture);
    if ('framebuffer' in resource && resource.framebuffer instanceof WebGLFramebuffer) {
      const depth = depths.get(resource.framebuffer);
      if (depth !== undefined) { gl.deleteRenderbuffer(depth); depths.delete(resource.framebuffer); }
      gl.deleteFramebuffer(resource.framebuffer);
      framebuffers.delete(resource.framebuffer);
    }
  }
  function dispose(): void {
    for (const mesh of meshes) releaseMesh(mesh);
    for (const depth of depths.values()) gl.deleteRenderbuffer(depth);
    depths.clear();
    for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
    for (const texture of textures) gl.deleteTexture(texture);
    for (const program of programs) gl.deleteProgram(program);
    gl.deleteVertexArray(vao);
    framebuffers.clear(); textures.clear(); programs.clear();
  }
  const resources = () => ({ textures: textures.size, buffers: meshes.size * 2,
    framebuffers: framebuffers.size, renderbuffers: depths.size, programs: programs.size });
  return { gl, program, releaseProgram, texture, bitmap, target, draw, mesh, releaseMesh, attach, attachMany, attachDepth, release, dispose, resources };
}
