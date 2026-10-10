import { SDF_SCALE } from '../symbols.ts';

export const cellsDraw = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D cells;
uniform sampler2D decisions;
uniform sampler2D lut;
uniform sampler2D atlas;
uniform int cellSize;
uniform ivec2 frameSize;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 anchor = (vec2(frameSize) - float(cellSize)) * .5;
  vec2 origin = anchor - ceil(anchor / float(cellSize)) * float(cellSize);
  ivec2 c = ivec2(floor((p - origin) / float(cellSize)));
  ivec4 v = ivec4(floor(texelFetch(cells, c, 0) * 255. + .5));
  ivec4 d = ivec4(floor(texelFetch(decisions, c, 0) * 255. + .5));
  vec4 paper = texelFetch(lut, ivec2(v.y * 6 + d.z, v.x), 0);
  o = paper;
  if (d.x == 0) return;
  vec4 ink = texelFetch(lut, ivec2(v.y * 6 + d.y, v.x), 0);
  vec2 local = (p - origin - vec2(c * cellSize)) / float(cellSize);
  vec2 uv = vec2((float(d.x-1) + local.x) / 5., local.y);
  float distance = (texture(atlas, uv).r * 255. - 128.) / ${SDF_SCALE.toFixed(1)};
  float halfPixel = .5 / float(cellSize);
  o = mix(paper, ink, 1. - smoothstep(-halfPixel, halfPixel, distance));
}
`;
