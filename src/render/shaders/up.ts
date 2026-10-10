import { head, labelLookup } from './shared.ts';

export const up = head + labelLookup + `uniform sampler2D simp; uniform sampler2D low; uniform sampler2D master; uniform sampler2D label; uniform int div; uniform float dBg; uniform float clarity[256]; uniform float simplify;
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 ws = textureSize(simp,0); ivec2 ms = textureSize(master,0);
  vec3 M = texelFetch(master, p, 0).rgb; float l0 = labelOf(label, p, ms);
  vec2 g = (vec2(p)+0.5)/float(div) - 0.5; ivec2 b = ivec2(floor(g)); vec2 f = g - vec2(b);
  vec3 S = vec3(0.), Lo = vec3(0.); float n = 0., D = 0., nd = 0.;
  for (int j=0;j<2;j++) for (int i=0;i<2;i++){ ivec2 t = clamp(b+ivec2(i,j), ivec2(0), ws-1);
    float w = (i==0 ? 1.-f.x : f.x) * (j==0 ? 1.-f.y : f.y); vec4 lo = texelFetch(low, t, 0); vec4 sv = texelFetch(simp, t, 0);
    D += w*sv.a; nd += w;
    if (abs(lo.a - l0) < 0.002){ S += w*sv.rgb; Lo += w*lo.rgb; n += w; } }
  float d = max(dBg, clarity[int(round(l0 * 255.))]);
  vec3 rgb = n > 1e-6 ? S/n + d*(M - Lo/n) : M;
  if (simplify == 0. || clarity[int(round(l0 * 255.))] == 1.) rgb = M;
  o = vec4(clamp(rgb, 0., 1.), D/max(nd, 1e-6)); }`;
