import { head } from './shared.ts';

export const akf = head + `uniform sampler2D src; uniform sampler2D tfm; uniform float R; uniform float clarity[256];
void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 sz = textureSize(src,0);
  vec4 c0 = texelFetch(src, p, 0); float l0 = c0.a;
  float rad = R * (1. - clarity[int(round(l0 * 255.))]);
  if (rad < 1.0) { o = c0; return; }
  vec3 t = texelFetch(tfm, p, 0).xyz;
  float disc = sqrt(max(0., (t.x-t.z)*(t.x-t.z) + 4.*t.y*t.y));
  float l1 = 0.5*(t.x+t.z+disc), l2 = 0.5*(t.x+t.z-disc);
  vec2 v0 = vec2(l1 - t.x, -t.y); vec2 d = dot(v0,v0) > 1e-12 ? normalize(v0) : vec2(0.,1.);
  float A = (l1+l2) > 1e-9 ? (l1-l2)/(l1+l2) : 0.; A = min(A, 0.5);
  float a = rad*(1.+A), b = rad/(1.+A);
  float cs = d.x, sn = -d.y;
  mat2 SR = mat2(0.5/a, 0., 0., 0.5/b) * mat2(cs, -sn, sn, cs);
  int mx = int(sqrt(a*a*cs*cs + b*b*sn*sn)), my = int(sqrt(a*a*sn*sn + b*b*cs*cs));
  float zeta = 2./rad; float zc = 0.58; float eta = (zeta + cos(zc)) / (sin(zc)*sin(zc));
  vec4 m[8]; vec3 s[8]; for (int k=0;k<8;k++){ m[k]=vec4(0.); s[k]=vec3(0.); }
  for (int y=-my;y<=my;y++) for (int x=-mx;x<=mx;x++){
    vec2 v = SR*vec2(float(x),float(y)); float d2 = dot(v,v);
    if (d2 <= 0.25){
      vec4 cc = texelFetch(src, clamp(p+ivec2(x,y), ivec2(0), sz-1), 0); vec3 c = cc.rgb;
      float agree = abs(cc.a - l0) < 0.002 ? 1. : 0.;
      float sum = 0.; float w[8]; float z, vxx, vyy;
      vxx = zeta - eta*v.x*v.x; vyy = zeta - eta*v.y*v.y;
      z = max(0., v.y+vxx); w[0]=z*z; sum+=w[0]; z = max(0., -v.x+vyy); w[2]=z*z; sum+=w[2];
      z = max(0., -v.y+vxx); w[4]=z*z; sum+=w[4]; z = max(0., v.x+vyy); w[6]=z*z; sum+=w[6];
      v = 0.70710678*vec2(v.x-v.y, v.x+v.y);
      vxx = zeta - eta*v.x*v.x; vyy = zeta - eta*v.y*v.y;
      z = max(0., v.y+vxx); w[1]=z*z; sum+=w[1]; z = max(0., -v.x+vyy); w[3]=z*z; sum+=w[3];
      z = max(0., -v.y+vxx); w[5]=z*z; sum+=w[5]; z = max(0., v.x+vyy); w[7]=z*z; sum+=w[7];
      float g = exp(-3.125*d2) * (1. - smoothstep(0.16, 0.25, d2)) * agree / max(sum, 1e-9);
      for (int k=0;k<8;k++){ float wk = w[k]*g; m[k] += vec4(c*wk, wk); s[k] += c*c*wk; }
    }
  }
  vec4 acc = vec4(0.);
  for (int k=0;k<8;k++){ if (m[k].w <= 1e-9) continue; vec3 mu = m[k].rgb/m[k].w; vec3 var = abs(s[k]/m[k].w - mu*mu);
    float s2 = var.r+var.g+var.b; float wgt = 1./(1. + pow(8000.*s2, 4.)); acc += vec4(mu*wgt, wgt); }
  o = vec4(acc.w > 0. ? acc.rgb/acc.w : c0.rgb, l0); }`;
