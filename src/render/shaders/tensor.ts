import { head } from './shared.ts';

export const tensor = head + `uniform sampler2D src;
vec3 f(ivec2 p, int x, int y){ ivec2 s = textureSize(src,0); return texelFetch(src, clamp(p+ivec2(x,y), ivec2(0), s-1), 0).rgb; }
void main(){ ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sx = (f(p,1,-1)+2.*f(p,1,0)+f(p,1,1) - f(p,-1,-1)-2.*f(p,-1,0)-f(p,-1,1))/4.;
  vec3 sy = (f(p,-1,1)+2.*f(p,0,1)+f(p,1,1) - f(p,-1,-1)-2.*f(p,0,-1)-f(p,1,-1))/4.;
  o = vec4(dot(sx,sx), dot(sx,sy), dot(sy,sy), 1.); }`;
