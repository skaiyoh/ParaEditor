import { head, labelLookup } from './shared.ts';

// The written rule is 0.04 per working texel. Retain 0.16 for C1 tuning:
// the lower threshold inks DoG side-lobe ghosts about 13 master px from an edge.
export const OUTLINE_SLOPE_PER_WORKING_TEXEL = 0.16;

export const outline = head + labelLookup + `
uniform sampler2D src;
uniform sampler2D simplified;
uniform sampler2D label;
uniform float amount;
uniform vec3 ink;
uniform float slopePerMasterPixel;
// D2b supplies optional depth discontinuities alongside texture and id edges.
uniform sampler2D depth;
uniform int hasDepth;
uniform float depthRange;
vec3 crossing(ivec2 p, ivec2 sz) {
  float D = texelFetch(simplified, p, 0).a - 0.5;
  float gx = texelFetch(simplified, clamp(p+ivec2(1,0), ivec2(0), sz-1), 0).a
    - texelFetch(simplified, clamp(p-ivec2(1,0), ivec2(0), sz-1), 0).a;
  float gy = texelFetch(simplified, clamp(p+ivec2(0,1), ivec2(0), sz-1), 0).a
    - texelFetch(simplified, clamp(p-ivec2(0,1), ivec2(0), sz-1), 0).a;
  return vec3(0.5 * vec2(gx, gy), D);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(src, 0);
  vec3 rgb = texelFetch(src, p, 0).rgb;
  float width = floor(6. * amount + 0.5);
  if (width > 0.) {
    vec3 c = crossing(p, sz);
    float gm = length(c.xy);
    bool edge = gm > slopePerMasterPixel && abs(c.z) / max(gm, 1e-6) < 0.5 * width;
    // The DoG is curved away from its zero. Refine the same distance/slope
    // tests near the crossing instead of letting that curvature thin the ink.
    if (!edge && gm > 1e-6) {
      vec2 stepToZero = -c.z * c.xy / (gm * gm);
      float reach = length(stepToZero);
      stepToZero *= min(1., (0.5 * width) / max(reach, 1e-6));
      ivec2 q = clamp(p + ivec2(round(stepToZero)), ivec2(0), sz - 1);
      vec3 near = crossing(q, sz);
      float slope = length(near.xy);
      vec2 zero = vec2(q) - near.z * near.xy / max(slope * slope, 1e-12);
      edge = slope > slopePerMasterPixel && length(zero - vec2(p)) < 0.5 * width;
    }
    float id = labelOf(label, p, sz);
    if (textureSize(label, 0) != ivec2(1)) {
      for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
        if (length(vec2(x, y)) <= 0.5 * width && abs(labelOf(label, p + ivec2(x, y), sz) - id) > 0.002) edge = true;
      }
    }
    if (hasDepth != 0 && depthRange > 0.) {
      vec2 uv = (vec2(p) + .5) / vec2(sz);
      float center = texture(depth, uv).r;
      for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
        if (length(vec2(x, y)) <= .5 * width &&
          abs(texture(depth, uv + vec2(x, y) / vec2(sz)).r - center) > .05 * depthRange) edge = true;
      }
    }
    if (edge) rgb = mix(rgb, ink, amount);
  }
  o = vec4(rgb, 1.);
}
`;
