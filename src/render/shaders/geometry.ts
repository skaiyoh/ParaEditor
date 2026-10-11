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

// Both geometry paths use MOT1's two-master-pixel inward coverage kernel.
const coverageBody = `  float coverage = 1.;
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
  composite = vec4(texelFetch(styled, ivec2(gl_FragCoord.xy), 0).rgb, coverage);`;
const coverageUniforms = `uniform sampler2D styled;
uniform sampler2D mask;
uniform int objectId;
uniform ivec2 masterSize;
layout(location=3) out vec4 composite;
`;

/** Color coverage only. Labels, disparity and the selection boundary stay hard. */
export const geometryCoverage = `#version 300 es
precision highp float;
precision highp int;
in vec2 frameUV;
${coverageUniforms}
void main() {
${coverageBody}
}`;

export const perspectiveCoverage = `#version 300 es
precision highp float;
precision highp int;
in vec3 sourceProjective;
${coverageUniforms}
void main() {
  vec2 frameUV = sourceProjective.xy / sourceProjective.z;
${coverageBody}
}`;

/** The same fixed-screen ray intersection as core/perspective; stored textures remain y down. */
export const perspectiveVertex = `#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec2 point;
uniform sampler2D depthPlane;
uniform vec3 apertureCenter;
uniform vec3 apertureSizeCrop;
uniform vec3 depthFactors;
uniform vec3 eye;
out vec3 sourceProjective;
void main() {
  float d = clamp(texture(depthPlane, point).r, 0., 1.);
  float t = mix(depthFactors.y, depthFactors.x, d);
  // The photo is a projection from E0, not a UV parametrization of the 3D triangle.
  // Carry homogeneous source coordinates so neutral interpolation reproduces it exactly.
  sourceProjective = vec3(point * t, t);
  vec2 screen = apertureCenter.xy + (point - .5) * vec2(1., -1.) * apertureSizeCrop.xy / (1. - 2. * apertureSizeCrop.z);
  vec3 world = vec3(t * screen, depthFactors.z * (1. - t));
  float w = eye.z - world.z;
  vec2 projected = (eye.z * world.xy - world.z * eye.xy) / w;
  vec2 p = (projected - apertureCenter.xy) / apertureSizeCrop.xy * vec2(1., -1.);
  gl_Position = vec4(p * 2. * w, (1. - 2. * d) * w, w);
}`;

export const perspectiveGeometry = `#version 300 es
precision highp float;
precision highp int;
in vec3 sourceProjective;
uniform sampler2D simplified;
uniform sampler2D depthPlane;
uniform sampler2D mask;
uniform sampler2D hole;
uniform int objectId;
layout(location=0) out vec4 colorEdge;
layout(location=1) out vec4 label;
layout(location=2) out vec4 disparity;
layout(location=3) out vec4 sourceUV;
void main() {
  vec2 frameUV = sourceProjective.xy / sourceProjective.z;
  if (objectId > 0 && texture(mask, frameUV).r < .5) discard;
  colorEdge = texture(simplified, frameUV);
  bool original = true;
  if (objectId == 0) {
    ivec2 size = textureSize(hole, 0), p = ivec2(frameUV * vec2(size));
    // backsource's feather also contains generated pixels outside the hard mask.
    for (int y=-2; y<=2; y++) for (int x=-2; x<=2; x++) {
      if (texelFetch(hole, clamp(p + ivec2(x,y), ivec2(0), size-1), 0).r > 0.) original = false;
    }
  }
  label = vec4(float(objectId) / 255., original ? 1. : 0., 0., 1.);
  disparity = vec4(texture(depthPlane, frameUV).r, 0., 0., 1.);
  // Two bytes per UV component give <= 1/65535 source error without float readback assumptions.
  uvec2 encoded = uvec2(round(clamp(frameUV, 0., 1.) * 65535.));
  sourceUV = vec4(float(encoded.x >> 8u), float(encoded.x & 255u), float(encoded.y >> 8u), float(encoded.y & 255u)) / 255.;
}`;
