import { head } from './shared.ts';

export const blur = head + `uniform sampler2D src; uniform ivec2 dir;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 s = textureSize(src,0); vec4 acc = vec4(0.); float n = 0.;
  for (int i=-4;i<=4;i++){ float w = exp(-float(i*i)/8.); acc += w*texelFetch(src, clamp(p+dir*i, ivec2(0), s-1), 0); n += w; }
  o = acc/n; }`;
