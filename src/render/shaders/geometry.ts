/** Displacement endpoints come from core/parallaxDisplacement, not duplicate math. */
export const geometryVertex = `#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec2 point;
uniform sampler2D depthPlane;
uniform vec3 displacementX;
uniform vec3 displacementY;
uniform float zoom;
out vec2 frameUV;
void main() {
  frameUV = point;
  float d = clamp(texture(depthPlane, point).r, 0., 1.);
  vec2 displacement = vec2(mix(displacementX.x, displacementX.y, d), mix(displacementY.x, displacementY.y, d));
  vec2 p = (point + displacement - .5) * zoom + .5;
  gl_Position = vec4(p * 2. - 1., 1. - 2. * d, 1.);
}`;

export const geometry = `#version 300 es
precision highp float;
precision highp int;
in vec2 frameUV;
uniform sampler2D simplified;
uniform sampler2D depthPlane;
uniform sampler2D mask;
uniform int objectId;
layout(location=0) out vec4 colorEdge;
layout(location=1) out vec4 label;
layout(location=2) out vec4 disparity;
void main() {
  if (objectId > 0 && texture(mask, frameUV).r < .5) discard;
  colorEdge = texture(simplified, frameUV);
  label = vec4(float(objectId) / 255., 0., 0., 1.);
  disparity = vec4(texture(depthPlane, frameUV).r, 0., 0., 1.);
}`;

/** Color coverage only. Labels, disparity and the selection boundary stay hard. */
export const geometryCoverage = `#version 300 es
precision highp float;
precision highp int;
in vec2 frameUV;
uniform sampler2D styled;
uniform sampler2D mask;
uniform int objectId;
uniform ivec2 masterSize;
layout(location=3) out vec4 composite;
void main() {
  float coverage = 1.;
  if (objectId > 0) {
    if (texture(mask, frameUV).r < .5) discard;
    // Threshold every sample before filtering: a low-resolution, linearly
    // sampled mask must still feather in master pixels, not mask texels.
    float sum = 0.;
    for (int y=-2; y<=2; y++) for (int x=-2; x<=2; x++) {
      float weight = float((3-abs(x)) * (3-abs(y)));
      sum += weight * step(.5, texture(mask, frameUV + vec2(x,y) / vec2(masterSize)).r);
    }
    // Feather inward so the stored silhouette and the source color's domain
    // remain exact. Beyond two master pixels coverage is exactly one.
    coverage = clamp(2. * sum / 81. - 1., 0., 1.);
  }
  composite = vec4(texelFetch(styled, ivec2(gl_FragCoord.xy), 0).rgb, coverage);
}`;
