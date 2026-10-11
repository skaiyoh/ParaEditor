// Normalized sRGB and Björn Ottosson's Oklab matrices. No I/O or clipping:
// inverse conversions may represent colors outside the sRGB gamut.
export type Rgb = { readonly r: number; readonly g: number; readonly b: number };
export type Oklab = { readonly L: number; readonly a: number; readonly b: number };
export type Oklch = { readonly l: number; readonly c: number; readonly h: number };

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

export function linearToOklab({ r, g, b }: Rgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToLinear({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

export function srgbToOklab({ r, g, b }: Rgb): Oklab {
  return linearToOklab({ r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) });
}

export function oklabToSrgb(lab: Oklab): Rgb {
  const { r, g, b } = oklabToLinear(lab);
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const c = Math.hypot(a, b);
  return { l: L, c, h: c < 1e-12 ? 0 : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 };
}

export function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const angle = h * Math.PI / 180;
  return { L: l, a: c * Math.cos(angle), b: c * Math.sin(angle) };
}

/** Picker channels are sRGB bytes, unlike the normalized Rgb conversion inputs. */
export type SrgbChannels = { readonly r: number; readonly g: number; readonly b: number };
export type InputColor = { readonly hex: string; readonly srgb: SrgbChannels; readonly oklch: Oklch };
export type ColorInputResult =
  | { readonly kind: 'valid'; readonly color: InputColor }
  | { readonly kind: 'invalid'; readonly reason: string };

export function srgbToOklch(rgb: Rgb): Oklch { return oklabToOklch(srgbToOklab(rgb)); }
export function oklchToSrgb(color: Oklch): Rgb { return oklabToSrgb(oklchToOklab(color)); }

/** Accept finite channels in [0,255], rounding fractional input to the nearest byte. */
export function parseSrgbChannels({ r, g, b }: SrgbChannels): ColorInputResult {
  if (![r, g, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) {
    return { kind: 'invalid', reason: 'Enter sRGB channels between 0 and 255.' };
  }
  const srgb = { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
  const hex = '#' + [srgb.r, srgb.g, srgb.b].map((value) => value.toString(16).padStart(2, '0')).join('');
  const converted = srgbToOklch({ r: srgb.r / 255, g: srgb.g / 255, b: srgb.b / 255 });
  // Matrix roundoff must not push white outside the saved lightness range.
  const oklch = { ...converted, l: Math.max(0, Math.min(1, converted.l)) };
  return { kind: 'valid', color: { hex, srgb, oklch } };
}

/** Strict CSS opaque hex only; no trimming, alpha, names or missing '#'. */
export function parseHex(value: unknown): ColorInputResult {
  if (typeof value !== 'string' || (value.length !== 4 && value.length !== 7) || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) {
    return { kind: 'invalid', reason: 'Enter a color as #RGB or #RRGGBB.' };
  }
  const digits = value.length === 4 ? [...value.slice(1)].map((digit) => digit + digit).join('') : value.slice(1);
  return parseSrgbChannels({ r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16), b: Number.parseInt(digits.slice(4, 6), 16) });
}

/** Display conversion clips to sRGB; the caller's stored OKLCH remains untouched. */
export function colorInputFromOklch(color: Oklch): ColorInputResult {
  if (![color.l, color.c, color.h].every(Number.isFinite)) return { kind: 'invalid', reason: 'The color must be finite.' };
  const rgb = oklchToSrgb(color);
  const byte = (value: number): number => Math.max(0, Math.min(255, value * 255));
  return parseSrgbChannels({ r: byte(rgb.r), g: byte(rgb.g), b: byte(rgb.b) });
}
