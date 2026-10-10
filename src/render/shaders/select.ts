import { head, labelLookup } from './shared.ts';

/** One CSS pixel on each side of the selected label's boundary. */
export const select = head + labelLookup + `
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
  o = vec4(edge ? vec3(1.) : texelFetch(src, p, 0).rgb, 1.);
}
`;
