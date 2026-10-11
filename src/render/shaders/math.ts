import { MATH_BUILTINS, MATH_LIBRARY_REVISION, MATH_OPERATOR_TABLE } from '../../core/math-expression.ts';
import { grainHashGlsl } from './grain.ts';
import { oklab } from './shared.ts';

/** Only admitted arithmetic is emitted. These exact legacy helpers are inspectable. */
export const mathSupportGlsl = grainHashGlsl + oklab;

const sources: Readonly<Record<string, string>> = {
  vec2: 'vec2 m_vec2(float x, float y) { return vec2(x, y); }',
  vec3: 'vec3 m_vec3(float x, float y, float z) { return vec3(x, y, z); }',
  coord: 'vec2 m_coord(vec2 v) { return clamp(v, vec2(-1073741823.), vec2(1073741823.)); }',
  cells: 'uvec2 m_cells(vec2 p, float size) { return uvec2(ivec2(floor(p / max(1., floor(size))))); }',
  hashNoise: 'float m_hashNoise(uint seed, uint hold, uvec2 cell, float channel) { return noise(seed, hold, cell, int(clamp(floor(channel), 0., 2.))); }',
  holdAt: `uint m_holdAt(int frame, float count, float length) {
  int n = int(clamp(floor(count), 1., 16777215.));
  int h = int(clamp(floor(length), 1., 16777215.));
  int wrapped = frame % n;
  if (wrapped < 0) wrapped += n;
  return uint(wrapped / h);
}`,
  noise: 'float m_noise(float n) { return clamp(n, -1., 1.); }',
  coverage: 'float m_coverage(float n) { return clamp(n, 0., 1.); }',
  value: 'float m_value(float n) { return n; }\nfloat m_value(int n) { return float(n); }',
  rgb: 'vec3 m_rgb(vec3 color) { return color; }',
  srgb: 'vec3 m_srgb(vec3 channels) { return clamp(channels, 0., 1.); }',
  lab: 'vec3 m_lab(vec3 color) { return color; }',
  oklab: 'vec3 m_oklab(vec3 channels) { return channels; }',
  toOklab: 'vec3 m_toOklab(vec3 color) { return srgbToOklab(clamp(color, 0., 1.)); }',
  fromOklab: 'vec3 m_fromOklab(vec3 color) { return oklabToSrgb(color); }',
  toLinear: 'vec3 m_toLinear(vec3 color) { return srgbToLinear(clamp(color, 0., 1.)); }',
  fromLinear: 'vec3 m_fromLinear(vec3 color) { return linearToSrgb(color); }',
  clampSrgb: 'vec3 m_clampSrgb(vec3 color) { return clamp(color, 0., 1.); }',
  abs: 'float m_abs(float n) { return abs(n); }',
  floor: 'float m_floor(float n) { return floor(n); }',
  min: 'float m_min(float a, float b) { return min(a, b); }',
  max: 'float m_max(float a, float b) { return max(a, b); }',
  clamp: 'float m_clamp(float n, float a, float b) { return clamp(n, min(a, b), max(a, b)); }',
  step: 'float m_step(float edge, float n) { return step(edge, n); }',
  smoothstep: `float m_smoothstep(float a, float b, float n) {
  if (b <= a) return step(a, n);
  if (n <= a) return 0.;
  if (n >= b) return 1.;
  float width = b * 0.5 - a * 0.5;
  if (width < 1.1754943508222875e-38) return step(a, n);
  float t = clamp((n * 0.5 - a * 0.5) / width, 0., 1.);
  return t * t * (3. - 2. * t);
}`,
  mix: 'float m_mix(float a, float b, float t) { return a * (1. - t) + b * t; }',
};
export const mathBuiltinGlsl = Object.freeze(MATH_BUILTINS.map((builtin) => {
  const source = sources[builtin.name];
  if (source === undefined) throw new Error(`Missing GLSL for trusted math builtin ${builtin.name}.`);
  const rangeRule = MATH_OPERATOR_TABLE.find((rule) => rule.kind === 'builtin' && rule.name === builtin.name);
  if (!rangeRule) throw new Error(`Missing admission rule for ${builtin.name}.`);
  return Object.freeze({ ...builtin, label: 'Built-in' as const, revision: MATH_LIBRARY_REVISION,
    glslName: `m_${builtin.name}`, source, rangeRule });
}));
