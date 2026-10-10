export const head = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) out vec4 o;
`;

export const labelLookup = `
float labelOf(sampler2D label, ivec2 m, ivec2 ms) {
  ivec2 ls = textureSize(label, 0);
  m = clamp(m, ivec2(0), ms - 1);
  return texelFetch(label, min(((2*m + 1) * ls) / (2*ms), ls - 1), 0).r;
}
`;

// The same transfer function and matrices as core/color.ts, shared by every color pass.
export const oklab = `
vec3 srgbToLinear(vec3 v) {
  return mix(pow((v + 0.055) / 1.055, vec3(2.4)), v / 12.92, lessThanEqual(v, vec3(0.04045)));
}
vec3 linearToSrgb(vec3 v) {
  return mix(1.055 * pow(max(v, vec3(0.)), vec3(1. / 2.4)) - 0.055, 12.92 * v, lessThanEqual(v, vec3(0.0031308)));
}
vec3 srgbToOklab(vec3 rgb) {
  vec3 v = srgbToLinear(rgb);
  float l = pow(dot(v, vec3(0.4122214708, 0.5363325363, 0.0514459929)), 1. / 3.);
  float m = pow(dot(v, vec3(0.2119034982, 0.6806995451, 0.1073969566)), 1. / 3.);
  float s = pow(dot(v, vec3(0.0883024619, 0.2817188376, 0.6299787005)), 1. / 3.);
  return vec3(0.2104542553*l + 0.793617785*m - 0.0040720468*s,
    1.9779984951*l - 2.428592205*m + 0.4505937099*s,
    0.0259040371*l + 0.7827717662*m - 0.808675766*s);
}
vec3 oklabToSrgb(vec3 v) {
  vec3 roots = vec3(v.x + 0.3963377774*v.y + 0.2158037573*v.z,
    v.x - 0.1055613458*v.y - 0.0638541728*v.z,
    v.x - 0.0894841775*v.y - 1.291485548*v.z);
  roots = roots * roots * roots;
  float l = roots.x, m = roots.y, s = roots.z;
  return linearToSrgb(vec3(4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
    -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
    -0.0041960863*l - 0.7034186147*m + 1.707614701*s));
}
`;
