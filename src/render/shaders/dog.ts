import { head } from './shared.ts';

export const dog = head + `uniform sampler2D src;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(src,0); float a1=0., n1=0., a2=0., n2=0.;
  for (int y=-4;y<=4;y++) for (int x=-4;x<=4;x++){ float L = dot(texelFetch(src, clamp(p+ivec2(x,y), ivec2(0), sz-1), 0).rgb, vec3(.2126,.7152,.0722));
    float d2 = float(x*x+y*y); float w1 = exp(-d2/2.), w2 = exp(-d2/5.12); a1 += w1*L; n1 += w1; a2 += w2*L; n2 += w2; }
  o = vec4(texelFetch(src, p, 0).rgb, clamp(0.5 + 4.*(a1/n1 - a2/n2), 0., 1.)); }`;
