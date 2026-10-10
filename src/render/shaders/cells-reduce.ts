export const cellsReduce = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D variant;
uniform int cellSize;
uniform float amount;
uniform float modes[33]; // slider=0, always=1, never=2; label zero is the plate.
uniform float bandCounts[256];
layout(location=0) out vec4 cell;
layout(location=1) out vec4 decision;
void main() {
  ivec2 size = textureSize(variant, 0);
  vec2 anchor = (vec2(size) - float(cellSize)) * .5;
  vec2 origin = anchor - ceil(anchor / float(cellSize)) * float(cellSize);
  ivec2 start = ivec2(ceil(origin - .5)) + ivec2(gl_FragCoord.xy) * cellSize;
  ivec2 lo = max(start, ivec2(0)), hi = min(start + cellSize, size);
  cell = vec4(0.); decision = vec4(0.);
  if (any(greaterThanEqual(lo, hi))) return;
  int labels[33]; int entries[32]; int bands[6];
  for (int i=0; i<33; i++) labels[i]=0;
  for (int i=0; i<32; i++) entries[i]=0;
  for (int i=0; i<6; i++) bands[i]=0;
  for (int y=lo.y; y<hi.y; y++) for (int x=lo.x; x<hi.x; x++) {
    ivec4 v = ivec4(floor(texelFetch(variant, ivec2(x,y), 0) * 255. + .5));
    labels[v.z]++;
  }
  int label=0;
  for (int i=1; i<33; i++) if (labels[i] > labels[label]) label=i;
  for (int y=lo.y; y<hi.y; y++) for (int x=lo.x; x<hi.x; x++) {
    ivec4 v = ivec4(floor(texelFetch(variant, ivec2(x,y), 0) * 255. + .5));
    if (v.z == label) entries[v.x]++;
  }
  int entry=0;
  for (int i=1; i<32; i++) if (entries[i] > entries[entry]) entry=i;
  float sum=0.;
  for (int y=lo.y; y<hi.y; y++) for (int x=lo.x; x<hi.x; x++) {
    ivec4 v = ivec4(floor(texelFetch(variant, ivec2(x,y), 0) * 255. + .5));
    if (v.z == label && v.x == entry) { bands[v.y]++; sum += float(v.w); }
  }
  int band=0;
  for (int i=1; i<6; i++) if (bands[i] > bands[band]) band=i;
  float tone = sum / (255. * float(entries[entry]));
  cell = vec4(float(label)/255., float(entry)/255., float(band)/255., tone);
  // Pure twin: symbolDecision in symbols.ts. Strict > above resolves ties low.
  float e = abs(tone - .5);
  bool glyph = modes[label] == 1. || (modes[label] != 2. && amount > 0. && e >= .5 * (1. - amount));
  int index=-1, ink=band, paper=band;
  if (glyph) {
    index = amount > 0. ? clamp(int(floor(5. * (e - .5 * (1. - amount)) / (.5 * amount))), 0, 4) : 0;
    int side = tone < .5 ? -1 : 1;
    ink = clamp(band + side, 0, int(bandCounts[label])-1);
    paper = ink - side;
  }
  decision = vec4(float(index+1), float(ink), float(paper), 0.) / 255.;
}
`;
