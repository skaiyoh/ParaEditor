import { head, oklab } from './shared.ts';

export const clipping = `
float clipLightness(float L, float amount) {
  if (amount == 0.) return L;
  float width = .05, start = 1. - .35 * amount - width;
  if (L <= start) return L;
  if (L >= 1.) return 1.;
  float span = 1. - start, rest = span - width;
  float a = amount * rest / (2. * width * span), t = L - start;
  if (t <= width) return start + t + a*t*t;
  float u = t - width, b = -a*width*(2.*span-width)/(rest*rest);
  return start + width + a*width*width + (1.+2.*a*width)*u + b*u*u;
}
`;
export const clip = head + oklab + clipping + `
uniform sampler2D src;
uniform float amount;
void main() {
  vec3 rgb = texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb;
  vec3 lab = srgbToOklab(rgb);
  float L = clipLightness(lab.x, amount);
  // Preserve bytes below the knee, avoiding a needless color round trip.
  o = vec4(L == lab.x ? rgb : clamp(oklabToSrgb(vec3(L, lab.yz)), 0., 1.), 1.);
}
`;
