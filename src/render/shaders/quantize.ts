import { head, labelLookup, oklab } from './shared.ts';

export const quantize = head + labelLookup + oklab + `
uniform sampler2D src;
uniform sampler2D label;
uniform sampler2D lut;
uniform vec3 entries[32];
uniform float bandCounts[256];
uniform int symbolsEnabled;
uniform float p01;
uniform float p99;
layout(location=1) out vec4 variant;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 lab = srgbToOklab(texelFetch(src, p, 0).rgb);
  int id = int(round(255. * labelOf(label, p, textureSize(src, 0))));
  int winner = 0;
  float nearest = 1e10;
  for (int i = 0; i < 32; i++) {
    vec3 d = lab - entries[i];
    float distance = dot(d*d, vec3(0.5, 1., 1.));
    if (distance < nearest) { nearest = distance; winner = i; }
  }
  float L = entries[winner].x;
  float W = clamp(L - 0.25, 0., 0.55);
  float s = L - 0.25 - W;
  float t = clamp((lab.x - L + s) / 0.45 + 0.55, 0., 1.);
  int n = int(bandCounts[id]);
  int band = clamp(int(floor(t * float(n))), 0, n - 1);
  o = texelFetch(lut, ivec2(winner * 6 + band, id), 0);
  if (symbolsEnabled != 0) {
    // Without lights, pre-banding L is lab.x, before t is clamped.
    float tone = clamp((lab.x - p01) / max(p99 - p01, 1e-6), 0., 1.);
    variant = vec4(float(winner)/255., float(band)/255., float(id)/255., tone);
  }
}
`;
