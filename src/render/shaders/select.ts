import { head, labelLookup, oklab } from './shared.ts';

/** Screen-only dim, with one CSS pixel on each side of the selected boundary. */
export const select = head + labelLookup + oklab + `
uniform sampler2D src;
uniform sampler2D label;
uniform int selected;
uniform ivec2 pixelStep;
bool belongs(ivec2 p, ivec2 sz) {
  return int(round(255. * labelOf(label, p, sz))) == selected;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(src, 0);
  bool inside = belongs(p, sz);
  bool edge = belongs(p + ivec2(pixelStep.x, 0), sz) != inside
    || belongs(p - ivec2(pixelStep.x, 0), sz) != inside
    || belongs(p + ivec2(0, pixelStep.y), sz) != inside
    || belongs(p - ivec2(0, pixelStep.y), sz) != inside;
  vec3 color = texelFetch(src, p, 0).rgb;
  if (!inside && !edge) {
    float lightness = max(0., srgbToOklab(color).x - .35);
    float hue = radians(260.);
    vec3 blue = clamp(oklabToSrgb(vec3(lightness, .08 * cos(hue), .08 * sin(hue))), 0., 1.);
    color = mix(color, color * blue, .55);
  }
  o = vec4(edge ? vec3(1.) : color, 1.);
}
`;
