import { head } from './shared.ts';

// Stored row zero is the photo's top row; the browser's framebuffer is bottom-up.
export const present = head + `uniform sampler2D src;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = textureSize(src, 0).y - 1 - p.y;
  o = vec4(texelFetch(src, p, 0).rgb, 1.);
}`;

/** Offscreen copy keeps top-left rows intact and removes treatment metadata in alpha. */
export const copy = head + `uniform sampler2D src;
void main() { o = vec4(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb, 1.); }`;

/** Source lookup for the legacy still/loop geometry, with the same hard coverage. */
export const sourceLookup = `#version 300 es
precision highp float;
precision highp int;
in vec2 frameUV;
uniform sampler2D mask;
uniform sampler2D hole;
uniform int objectId;
layout(location=0) out vec4 label;
layout(location=1) out vec4 sourceUV;
void main() {
  if (objectId > 0 && texture(mask, frameUV).r < .5) discard;
  bool original = true;
  if (objectId == 0) {
    ivec2 size = textureSize(hole, 0), p = ivec2(frameUV * vec2(size));
    for (int y=-2; y<=2; y++) for (int x=-2; x<=2; x++) {
      if (texelFetch(hole, clamp(p + ivec2(x,y), ivec2(0), size-1), 0).r > 0.) original = false;
    }
  }
  label = vec4(float(objectId) / 255., original ? 1. : 0., 0., 1.);
  uvec2 encoded = uvec2(round(clamp(frameUV, 0., 1.) * 65535.));
  sourceUV = vec4(float(encoded.x >> 8u), float(encoded.x & 255u), float(encoded.y >> 8u), float(encoded.y & 255u)) / 255.;
}`;
