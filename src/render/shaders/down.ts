import { head, labelLookup } from './shared.ts';

export const down = head + labelLookup + `uniform sampler2D master; uniform sampler2D label; uniform int div; uniform int aware;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 ms = textureSize(master,0); vec3 acc = vec3(0.), all = vec3(0.); float n = 0., na = 0.;
  float lc = labelOf(label, min(p*div + div/2, ms - 1), ms);
  for (int y=0;y<div;y++) for (int x=0;x<div;x++){ ivec2 t = p*div + ivec2(x,y); if (t.x < ms.x && t.y < ms.y){ vec3 c = texelFetch(master, t, 0).rgb; all += c; na += 1.;
    if (aware == 0 || abs(labelOf(label, t, ms) - lc) < 0.002){ acc += c; n += 1.; } } }
  o = vec4(n > 0. ? acc/n : all/max(na,1.), lc); }`;
