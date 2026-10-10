import { head } from './shared.ts';

// Stored row zero is the photo's top row; the browser's framebuffer is bottom-up.
export const present = head + `uniform sampler2D src;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = textureSize(src, 0).y - 1 - p.y;
  o = vec4(texelFetch(src, p, 0).rgb, 1.);
}`;
