import { head, oklab } from './shared.ts';
import { grainHashGlsl } from './grain.ts';

// Heights and their analytic gradients live in master pixels, in front of
// Geometry. Circular caps are cut just before their vertical tangent so the
// largest slope is one: refraction at 1 then reaches 2% of the long edge.
// Pattern keys use the grain's integer finalizer and the document's seed.
const surfaceFields = oklab + grainHashGlsl + `
uniform sampler2D src;
uniform uint seed;
uniform int pattern;
uniform float relief;
uniform float refraction;
uniform float shine;
uniform float scale;
uniform float phase;
uniform vec3 cameraDirection;

struct Field { float height; vec2 gradient; float crack; };

uint key(ivec2 cell, uint salt) {
  return fmix32(seed ^ (uint(cell.x) * 0x9e3779b9u) ^ (uint(cell.y) * 0x85ebca6bu) ^ salt);
}
vec2 randomPair(ivec2 cell, uint salt) {
  uint h = key(cell, salt);
  return vec2(float(h & 65535u), float(h >> 16u)) / 65535.;
}

Field bars(vec2 p, vec2 size) {
  float meanWidth = size.x * mix(1. / 60., 1. / 8., scale);
  float pitch = meanWidth / 0.65;
  int cell = int(floor(p.x / pitch));
  vec2 widths = randomPair(ivec2(cell, 0), 0x243f6a88u);
  vec2 motion = randomPair(ivec2(cell, 0), 0x13198a2eu);
  // Whole seeded cycle counts close the loop; a still always has phase zero.
  float cycles = 1. + floor(motion.x * 3.);
  float width = pitch * (0.5 + 0.3 * widths.x) *
    (1. + (0.08 + 0.12 * motion.y) * sin(6.28318530718 * (cycles * phase + widths.y)));
  float radius = width * 0.5;
  float t = (p.x - (float(cell) + 0.5) * pitch) / radius;
  if (abs(t) >= 1.) return Field(0., vec2(0.), 0.);
  // h = .35 R (sqrt(1.125 - t²) - sqrt(.125)): a cylindrical arc.
  float root = sqrt(1.125 - t * t);
  return Field(0.35 * radius * (root - sqrt(0.125)), vec2(-0.35 * t / root, 0.), 0.);
}

Field cracks(vec2 p, vec2 size) {
  float count = mix(120., 12., scale);
  float spacing = sqrt(size.x * size.y / count);
  vec2 q = p / spacing;
  ivec2 cell = ivec2(floor(q));
  vec2 sites[9];
  float nearest = 1.e10;
  int winner = 0;
  ivec2 winnerCell = cell;
  int i = 0;
  // Sites stay in the central half of their grid square. A 3x3 neighborhood
  // contains every possible nearest site, including at the frame boundary.
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 candidate = cell + ivec2(x, y);
    vec2 site = vec2(candidate) + 0.25 + 0.5 * randomPair(candidate, 0xa4093822u);
    sites[i] = site;
    float distanceSquared = dot(q - site, q - site);
    if (distanceSquared < nearest) { nearest = distanceSquared; winner = i; winnerCell = candidate; }
    i++;
  }
  float edge = 1.e10;
  for (int j = 0; j < 9; j++) {
    if (j == winner) continue;
    vec2 delta = sites[j] - sites[winner];
    // Distance to the actual Voronoi bisector, rather than F2 - F1.
    edge = min(edge, dot(0.5 * (sites[j] + sites[winner]) - q, delta) / length(delta));
  }
  vec2 tilt = 2. * randomPair(winnerCell, 0x082efa98u) - 1.;
  tilt *= 0.9 / max(1., length(tilt));
  // Each shard is h = tilt · (p - site); its edge is a height discontinuity.
  // Each side covers half a master pixel, making a one-pixel dark crack.
  return Field(dot(p - sites[winner] * spacing, tilt), tilt,
    1. - smoothstep(0.25, 0.75, max(0., edge) * spacing));
}

Field scales(vec2 p, vec2 size) {
  float rowHeight = max(size.x, size.y) * mix(1. / 60., 1. / 8., scale);
  float radius = rowHeight / 0.72;
  float pitch = 1.7 * radius;
  int row = int(floor(p.y / rowHeight + 0.5));
  // The lowest containing row lies on top. Adjacent staggered circles overlap,
  // so the visible arc of each cap is the edge of a fish scale, without holes.
  for (int j = -1; j <= 1; j++) {
    int r = row + j;
    float stagger = (r & 1) == 0 ? 0. : 0.5;
    float column = floor(p.x / pitch - stagger + 0.5) + stagger;
    vec2 local = (p - vec2(column * pitch, float(r) * rowHeight)) / radius;
    float d2 = dot(local, local);
    if (d2 >= 1.) continue;
    // h = .16 R (sqrt(1.0256 - |q|²) - .16). The narrow highlight
    // reaches its strongest normal near the visible arc, rather than its top.
    float root = sqrt(1.0256 - d2);
    return Field(0.16 * radius * (root - 0.16), -0.16 * local / root, 0.);
  }
  return Field(0., vec2(0.), 0.);
}

vec4 sampleColor(vec2 pixel, ivec2 size) {
  vec2 q = clamp(pixel - 0.5, vec2(0.), vec2(size - 1));
  ivec2 lo = ivec2(floor(q)), hi = min(lo + 1, size - 1);
  vec2 f = fract(q);
  return mix(mix(texelFetch(src, lo, 0), texelFetch(src, ivec2(hi.x, lo.y), 0), f.x),
    mix(texelFetch(src, ivec2(lo.x, hi.y), 0), texelFetch(src, hi, 0), f.x), f.y);
}

`;

export const surface = head + surfaceFields + `
void main() {
  ivec2 size = textureSize(src, 0), pixel = ivec2(gl_FragCoord.xy);
  vec4 color = texelFetch(src, pixel, 0);
  // Also exact when the shader is driven directly with all-zero effects.
  if (relief == 0. && refraction == 0. && shine == 0.) { o = color; return; }
  Field field;
  if (pattern == 0) field = bars(gl_FragCoord.xy, vec2(size));
  else if (pattern == 1) field = cracks(gl_FragCoord.xy, vec2(size));
  else field = scales(gl_FragCoord.xy, vec2(size));
  vec2 gradient = relief * field.gradient;
  if (refraction > 0. && relief > 0.) {
    color = sampleColor(gl_FragCoord.xy + refraction * 0.02 * float(max(size.x, size.y)) * gradient, size);
  }
  color.rgb *= 1. - 0.55 * relief * field.crack;
  if (shine > 0.) {
    vec3 view = normalize(cameraDirection);
    // Camera-relative up is perpendicular to the view, so the elevation
    // remains exactly 35 degrees even on an oblique supplied camera.
    const float cosine = 0.81915204429, sine = 0.57357643635;
    vec3 up = normalize(vec3(0., 1., 0.) - view * view.y);
    vec3 light = cosine * view + sine * up;
    vec3 halfVector = normalize(view + light);
    vec3 normal = normalize(vec3(-gradient, 1.));
    float highlight = shine * pow(max(0., dot(normal, halfVector)), 24.);
    color.rgb = linearToSrgb(srgbToLinear(color.rgb) + vec3(highlight));
  }
  o = vec4(clamp(color.rgb, 0., 1.), color.a);
}
`;

/** Reuse the exact refracting field for live labels and packed source coordinates. */
export const surfaceLookup = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) out vec4 mappedLabel;
layout(location=1) out vec4 mappedSource;
uniform sampler2D labels;
uniform sampler2D sourceMap;
` + surfaceFields + `
vec2 decodeUV(vec4 value) {
  vec4 bytes = round(value * 255.);
  return vec2(bytes.x * 256. + bytes.y, bytes.z * 256. + bytes.w) / 65535.;
}
void main() {
  ivec2 size = textureSize(sourceMap, 0);
  Field field;
  if (pattern == 0) field = bars(gl_FragCoord.xy, vec2(size));
  else if (pattern == 1) field = cracks(gl_FragCoord.xy, vec2(size));
  else field = scales(gl_FragCoord.xy, vec2(size));
  vec2 position = gl_FragCoord.xy + refraction * 0.02 * float(max(size.x,size.y)) * relief * field.gradient;
  vec2 q = clamp(position - .5, vec2(0.), vec2(size - 1));
  ivec2 nearest = ivec2(floor(q + .5));
  mappedLabel = texelFetch(labels, nearest, 0);
  // At blended layer edges there is no single original sample. Pick the dominant texel.
  vec2 uv = decodeUV(texelFetch(sourceMap, nearest, 0));
  ivec2 lo = ivec2(floor(q)), hi = min(lo + 1, size - 1);
  vec4 l00 = texelFetch(labels,lo,0), l10 = texelFetch(labels,ivec2(hi.x,lo.y),0);
  vec4 l01 = texelFetch(labels,ivec2(lo.x,hi.y),0), l11 = texelFetch(labels,hi,0);
  if (all(equal(l00,l10)) && all(equal(l00,l01)) && all(equal(l00,l11))) {
    vec2 f = fract(q);
    uv = mix(mix(decodeUV(texelFetch(sourceMap,lo,0)), decodeUV(texelFetch(sourceMap,ivec2(hi.x,lo.y),0)), f.x),
      mix(decodeUV(texelFetch(sourceMap,ivec2(lo.x,hi.y),0)), decodeUV(texelFetch(sourceMap,hi,0)), f.x), f.y);
  }
  uvec2 encoded = uvec2(round(clamp(uv,0.,1.) * 65535.));
  mappedSource = vec4(float(encoded.x >> 8u), float(encoded.x & 255u), float(encoded.y >> 8u), float(encoded.y & 255u)) / 255.;
}`;

/** Match the existing dominant-owner refraction lookup for the opaque scene's depth. */
export const surfaceDepth = head + surfaceFields + `
void main() {
  ivec2 size = textureSize(src, 0);
  Field field;
  if (pattern == 0) field = bars(gl_FragCoord.xy, vec2(size));
  else if (pattern == 1) field = cracks(gl_FragCoord.xy, vec2(size));
  else field = scales(gl_FragCoord.xy, vec2(size));
  vec2 position = gl_FragCoord.xy + refraction * .02 * float(max(size.x,size.y)) * relief * field.gradient;
  ivec2 nearest = ivec2(floor(clamp(position, vec2(.5), vec2(size) - .5)));
  o = texelFetch(src, nearest, 0);
}`;
