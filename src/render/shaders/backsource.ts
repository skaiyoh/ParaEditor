import { head } from './shared.ts';

/** A radius-two triangular feather in master pixels, independent of aspect. */
export const backsource = head + `
uniform sampler2D master;
uniform sampler2D plate;
uniform sampler2D hole;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(master, 0);
  float coverage = 0.;
  for (int y=-2; y<=2; y++) for (int x=-2; x<=2; x++) {
    float weight = float((3-abs(x)) * (3-abs(y)));
    coverage += weight * texelFetch(hole, clamp(p + ivec2(x,y), ivec2(0), size-1), 0).r;
  }
  o = vec4(mix(texelFetch(master,p,0).rgb, texelFetch(plate,p,0).rgb, coverage/81.), 1.);
}`;
