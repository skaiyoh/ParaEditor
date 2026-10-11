import { clipping } from './clip.ts';
import { head, labelLookup, oklab } from './shared.ts';
import { LOCAL_EFFECT_BATCH } from '../local-effects.ts';

const scopes = Array.from({ length: LOCAL_EFFECT_BATCH }, (_, i) => `uniform sampler2D scope${i};`).join('\n');
const samples = Array.from({ length: LOCAL_EFFECT_BATCH }, (_, i) => `if (index == ${i}) return texelFetch(scope${i}, min(ivec2(uv * vec2(textureSize(scope${i}, 0))), textureSize(scope${i}, 0) - 1), 0).r;`).join('\n');
const coverage = `
uniform sampler2D labels;
uniform sampler2D sourceMap;
uniform float owners[${LOCAL_EFFECT_BATCH}];
uniform float masked[${LOCAL_EFFECT_BATCH}];
${scopes}
vec2 decodeUV(vec4 value) {
  vec4 bytes = round(value * 255.);
  return vec2(bytes.x * 256. + bytes.y, bytes.z * 256. + bytes.w) / 65535.;
}
float scopeAt(int index, vec2 uv) {
  ${samples}
  return 0.;
}
float coverageAt(int index, ivec2 pixel) {
  vec4 owner = texelFetch(labels, pixel, 0);
  if (owner.a == 0. || round(owner.r * 255.) != owners[index]) return 0.;
  if (masked[index] == 0.) return 1.;
  vec2 uv = decodeUV(texelFetch(sourceMap, pixel, 0));
  return scopeAt(index, uv);
}
`;

/** No neighborhood reads follow this stage. Zero coverage preserves bytes. */
export const localEffects = head + oklab + clipping + coverage + `
uniform sampler2D src;
uniform int count;
uniform float kinds[${LOCAL_EFFECT_BATCH}];
uniform vec3 colors[${LOCAL_EFFECT_BATCH}];
uniform float amounts[${LOCAL_EFFECT_BATCH}];
vec3 recolorAtLightness(float L, vec3 target) {
  vec2 direction = vec2(cos(target.z), sin(target.z));
  vec3 rgb = oklabToSrgb(vec3(L, target.y * direction));
  if (all(greaterThanEqual(rgb, vec3(0.))) && all(lessThanEqual(rgb, vec3(1.)))) return rgb;
  // Reduce chroma along the target hue, preserving the treated lightness.
  float lo = 0., hi = target.y;
  for (int step = 0; step < 14; step++) {
    float chroma = .5 * (lo + hi);
    vec3 candidate = oklabToSrgb(vec3(L, chroma * direction));
    if (all(greaterThanEqual(candidate, vec3(0.))) && all(lessThanEqual(candidate, vec3(1.)))) lo = chroma;
    else hi = chroma;
  }
  return clamp(oklabToSrgb(vec3(L, lo * direction)), 0., 1.);
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 original = texelFetch(src, pixel, 0);
  vec3 rgb = original.rgb;
  for (int index = 0; index < ${LOCAL_EFFECT_BATCH}; index++) {
    if (index >= count) break;
    float weight = coverageAt(index, pixel);
    if (weight == 0.) continue;
    vec3 target = colors[index], changed;
    if (kinds[index] == 1.) {
      changed = clamp(oklabToSrgb(vec3(target.x, target.y * cos(target.z), target.y * sin(target.z))), 0., 1.);
    } else {
      vec3 lab = srgbToOklab(rgb);
      if (kinds[index] == 0.) {
        changed = recolorAtLightness(lab.x, target);
      } else {
        float L = clipLightness(lab.x, amounts[index]);
        changed = L == lab.x ? rgb : clamp(oklabToSrgb(vec3(L, lab.yz)), 0., 1.);
      }
    }
    rgb = mix(rgb, changed, weight);
  }
  o = vec4(rgb, original.a);
}
`;

/** Dev scope readback uses exactly the evaluator's owner and UV rule. */
export const localCoverage = head + coverage + `
void main() { o = vec4(coverageAt(0, ivec2(gl_FragCoord.xy)), 0., 0., 1.); }
`;

/** Canonical still lookup: preserve existing static owner labels and framing. */
export const stillLookup = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) out vec4 mappedLabel;
layout(location=1) out vec4 mappedSource;
uniform sampler2D labels;
uniform ivec2 frameSize;
` + labelLookup + `
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  mappedLabel = vec4(labelOf(labels, pixel, frameSize), 1., 0., 1.);
  uvec2 encoded = uvec2(round(gl_FragCoord.xy / vec2(frameSize) * 65535.));
  mappedSource = vec4(float(encoded.x >> 8u), float(encoded.x & 255u), float(encoded.y >> 8u), float(encoded.y & 255u)) / 255.;
}
`;
