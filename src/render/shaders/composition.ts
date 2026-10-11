import { head, oklab } from './shared.ts';
import { motionProjection, perspectiveProjection } from './geometry.ts';

export function resolvedDepth(perspective: boolean): string {
  return `#version 300 es
precision highp float;
precision highp int;
${perspective ? 'in vec3 sourceProjective;' : 'in vec2 frameUV;'}
uniform sampler2D mask;
uniform int objectId;
layout(location=0) out float resolved;
void main() {
  ${perspective ? 'vec2 frameUV = sourceProjective.xy / sourceProjective.z;' : ''}
  if (objectId > 0 && texture(mask, frameUV).r < .5) discard;
  resolved = gl_FragCoord.z;
}`;
}

export function paintVertex(perspective: boolean): string {
  return `#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec2 point;
uniform vec2 origin;
uniform vec2 tileSize;
uniform vec2 imageSize;
uniform vec2 tileStart;
uniform float disparity;
out vec2 tilePoint;
${perspective ? perspectiveProjection : motionProjection}
void main() {
  tilePoint = tileStart + point * tileSize;
  gl_Position = projectPhoto((origin + tilePoint) / imageSize, disparity);
}`;
}

export const paintFragment = head + oklab + `
uniform sampler2D tile;
uniform sampler2D resolved;
uniform float opacity;
uniform int neighbors;
// Center bit is the resident tile; the eight surrounding bits describe its neighbors.
bool resident(ivec2 cell) {
  return all(lessThanEqual(abs(cell), ivec2(1))) && (neighbors & (1 << ((cell.y + 1) * 3 + cell.x + 1))) != 0;
}
in vec2 tilePoint;
vec4 linearPremultiplied(ivec2 p) {
  vec4 c = texelFetch(tile, p, 0);
  return vec4(srgbToLinear(c.rgb) * c.a, c.a);
}
void main() {
  // The depth attachment's clear value is 1; even disparity zero maps below it.
  // A tiny arithmetic tolerance only covers float interpolation at equal depth.
  if (gl_FragCoord.z > texelFetch(resolved, ivec2(gl_FragCoord.xy), 0).r + 1.e-7) discard;
  ivec2 cell = ivec2(floor(tilePoint / 256.));
  if (any(notEqual(cell, ivec2(0)))) {
    // Resident destination cells draw their own quad. Missing cells receive a
    // half-texel halo, owned once by the earliest contributing resident tile.
    if (resident(cell)) discard;
    ivec2 low = ivec2(floor(tilePoint - .5));
    for (int y=0; y<2; y++) for (int x=0; x<2; x++) {
      ivec2 contributor = ivec2(floor(vec2(low + ivec2(x,y)) / 256.));
      if (resident(contributor) && (contributor.y < 0 || (contributor.y == 0 && contributor.x < 0))) discard;
    }
  }
  vec2 p = tilePoint + .5;
  ivec2 lo = ivec2(floor(p));
  vec2 f = fract(p);
  // Convert each stored straight-sRGB texel once BEFORE interpolating or blending.
  o = opacity * mix(mix(linearPremultiplied(lo), linearPremultiplied(lo + ivec2(1,0)), f.x),
    mix(linearPremultiplied(lo + ivec2(0,1)), linearPremultiplied(lo + ivec2(1,1)), f.x), f.y);
}`;
export const compositionDecode = head + oklab + `uniform sampler2D src;
void main() { o = vec4(srgbToLinear(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb), 1.); }`;
export const compositionEncode = head + oklab + `uniform sampler2D src;
void main() { o = vec4(linearToSrgb(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb), 1.); }`;
