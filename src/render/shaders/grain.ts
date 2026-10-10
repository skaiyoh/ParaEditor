import { head, labelLookup, oklab } from './shared.ts';

// Keep this exported fragment shared with the browser's exact uint readback.
export const grainHashGlsl = `
uint fmix32(uint h) {
  h ^= h >> 16u; h *= 0x85ebca6bu;
  h ^= h >> 13u; h *= 0xc2b2ae35u;
  return h ^ (h >> 16u);
}
uint grainHash(uint seed, uint hold, uvec2 cell, int channel) {
  const uint salts[3] = uint[3](0x243f6a88u, 0x85a308d3u, 0x13198a2eu);
  return fmix32(fmix32(fmix32(fmix32(seed ^ salts[channel]) ^ hold) ^ cell.x) ^ cell.y);
}
float noise(uint seed, uint hold, uvec2 cell, int channel) {
  return float(grainHash(seed, hold, cell, channel) >> 8u) / 16777215. * 2. - 1.;
}
`;

export const grain = head + labelLookup + oklab + grainHashGlsl + `
uniform sampler2D src;
uniform sampler2D label;
uniform uint seed;
uniform uint hold;
uniform int grainSize;
uniform float amount;
uniform float colorNoise;
uniform float clarity[256];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), sz = textureSize(src, 0);
  uvec2 cell = uvec2(p / grainSize);
  int id = int(floor(labelOf(label, p, sz) * 255. + 0.5));
  float scale = 1. - 0.5 * clarity[id];
  vec3 lab = srgbToOklab(texelFetch(src, p, 0).rgb);
  lab += scale * vec3(0.12 * amount * noise(seed, hold, cell, 0),
    0.06 * colorNoise * noise(seed, hold, cell, 1), 0.06 * colorNoise * noise(seed, hold, cell, 2));
  o = vec4(clamp(oklabToSrgb(lab), 0., 1.), 1.);
}
`;

export const grainHashReadback = head + grainHashGlsl + `
void main() {
  int i = int(gl_FragCoord.x);
  const uint seeds[4] = uint[4](0u, 123456789u, 4294967295u, 123456789u);
  const uint holds[4] = uint[4](0u, 7u, 34u, 7u);
  const uvec2 cells[4] = uvec2[4](uvec2(0u), uvec2(123u,456u), uvec2(2047u,1535u), uvec2(1u));
  const int channels[4] = int[4](0, 1, 2, 0);
  uint h = grainHash(seeds[i], holds[i], cells[i], channels[i]);
  o = vec4(float(h & 255u), float((h >> 8u) & 255u), float((h >> 16u) & 255u), float(h >> 24u)) / 255.;
}
`;
