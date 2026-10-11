import assert from 'node:assert/strict';
import test from 'node:test';
import { createGl } from '../src/render/gl.ts';

// Uniform dispatch is the CPU/driver boundary; shaders and pixels are tested in math-remix-proof.depth.
test('float vec2 uses uniform2f without integer truncation', () => {
  const calls: unknown[][] = [];
  const gl = new Proxy({}, { get(_target, name) {
    if (name === 'getExtension' || name === 'createVertexArray') return () => ({});
    if (name === 'uniform2f' || name === 'uniform2i') return (...values: unknown[]) => { calls.push([name, ...values]); };
    return () => undefined;
  } });
  // Minimal WebGL host boundary, validated by the invoked method inventory above.
  const canvas = { getContext: () => gl, width: 1, height: 1 } as unknown as HTMLCanvasElement;
  const gpu = createGl(canvas), location = {} satisfies WebGLUniformLocation;
  gpu.draw({ program: {}, uniforms: new Map([['origin', location], ['size', location]]) }, null,
    { origin: { kind: 'vec2', value: [.125, -7.75] }, size: { kind: 'ivec2', value: [3, 4] } });
  assert.deepEqual(calls, [['uniform2f', location, .125, -7.75], ['uniform2i', location, 3, 4]]);
});
