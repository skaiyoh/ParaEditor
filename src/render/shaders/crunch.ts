import { head } from './shared.ts';

const basis = Array.from({ length: 64 }, (_, i) => {
  const k = Math.floor(i / 8), x = i % 8;
  return (0.5 * (k === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * k * Math.PI / 16)).toFixed(12);
}).join(',');
const common = head + `
uniform sampler2D src;
const float basis[64] = float[64](${basis});
vec2 sampleAt(ivec2 p) { return texelFetch(src, clamp(p, ivec2(0), textureSize(src, 0)-1), 0).rg; }
`;

export const crunchExtract = head + `
uniform sampler2D src;
uniform int chroma;
vec3 ycc(ivec2 p) {
  vec3 rgb = texelFetch(src, clamp(p, ivec2(0), textureSize(src, 0)-1), 0).rgb;
  return vec3(dot(rgb, vec3(.299, .587, .114)) - 128./255.,
    dot(rgb, vec3(-.168736, -.331264, .5)), dot(rgb, vec3(.5, -.418688, -.081312)));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (chroma == 0) o = vec4(ycc(p).x, 0., 0., 1.);
  else {
    p *= 2;
    vec3 v = .25 * (ycc(p) + ycc(p+ivec2(1,0)) + ycc(p+ivec2(0,1)) + ycc(p+ivec2(1,1)));
    o = vec4(v.yz, 0., 1.);
  }
}
`;

export const crunchRowDct = common + `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int k = p.x % 8;
  ivec2 base = ivec2((p.x / 8) * 8, p.y); vec2 v = vec2(0.);
  for (int x = 0; x < 8; x++) v += basis[k*8+x] * sampleAt(base+ivec2(x,0));
  o = vec4(v, 0., 1.);
}
`;
export const crunchColumnDct = common + `
uniform float table[64];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int k = p.y % 8;
  ivec2 base = ivec2(p.x, (p.y / 8) * 8); vec2 v = vec2(0.);
  for (int y = 0; y < 8; y++) v += basis[k*8+y] * sampleAt(base+ivec2(0,y));
  float step = table[k*8 + p.x%8] / 255.;
  // JPEG nearest integer, ties away from zero, explicitly on both signs.
  v = sign(v) * floor(abs(v)/step + .5) * step;
  o = vec4(v, 0., 1.);
}
`;
export const crunchColumnIdct = common + `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int y = p.y % 8;
  ivec2 base = ivec2(p.x, (p.y / 8) * 8); vec2 v = vec2(0.);
  for (int k = 0; k < 8; k++) v += basis[k*8+y] * sampleAt(base+ivec2(0,k));
  o = vec4(v, 0., 1.);
}
`;
export const crunchRowIdct = common + `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); int x = p.x % 8;
  ivec2 base = ivec2((p.x / 8) * 8, p.y); vec2 v = vec2(0.);
  for (int k = 0; k < 8; k++) v += basis[k*8+x] * sampleAt(base+ivec2(k,0));
  o = vec4(v, 0., 1.);
}
`;
export const crunchCombine = head + `
uniform sampler2D luma;
uniform sampler2D chroma;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float y = texelFetch(luma, p, 0).r + 128./255.;
  vec2 c = texelFetch(chroma, p/2, 0).rg;
  o = vec4(clamp(vec3(y + 1.402*c.y, y - .344136*c.x - .714136*c.y, y + 1.772*c.x), 0., 1.), 1.);
}
`;
