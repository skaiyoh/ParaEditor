/** Displacement endpoints come from core/parallaxDisplacement, not duplicate math. */
export const geometryVertex = `#version 300 es
precision highp float;
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
