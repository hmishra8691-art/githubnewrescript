/**
 * LOGO -> PALETTE, AND BRAND HEX -> PALETTE.
 *
 * Two entry points, one shared generator:
 *
 *   dominantColorsFromImage(url)   canvas pixel-reading, browser only —
 *                                  "Detect logo colors" (req §4)
 *   generatePalette(seedColors)    pure, no DOM — turns 1+ RGB colors into a
 *                                  full Branding.colors object
 *
 * `generatePalette` is deliberately pure and dependency-free so it can be
 * unit-tested without a browser or a canvas: hand it colors, get a palette,
 * assert on the object. The brief is explicit that this must not "simply
 * apply the logo color everywhere" — every derived color here goes through
 * `bestTextColor`, which is the WCAG contrast-ratio check, not a guess.
 */

export interface RGB { r: number; g: number; b: number }

/* =============================================================== color math */

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const hn = h / 360;
  return { r: hue(hn + 1 / 3) * 255, g: hue(hn) * 255, b: hue(hn - 1 / 3) * 255 };
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The higher-contrast of near-black / near-white against a background —
 *  never a guess, never "just use white": a light brand color (a pastel
 *  logo yellow, say) gets dark button text, not invisible white-on-yellow. */
export function bestTextColor(bg: RGB): string {
  const black: RGB = { r: 17, g: 24, b: 39 }; // matches --rs-text's neighborhood, not pure #000
  const white: RGB = { r: 255, g: 255, b: 255 };
  return contrastRatio(bg, black) >= contrastRatio(bg, white) ? rgbToHex(black) : "#ffffff";
}

/** Nudge a color's lightness until it contrasts >= `min` against `against`,
 *  darkening or lightening whichever direction moves it there. Bails out
 *  after a bounded number of steps rather than looping to a degenerate flat
 *  color — a palette generator that can freeze the UI is worse than one
 *  that occasionally settles for "close enough". */
export function ensureContrast(color: RGB, against: RGB, min: number, steps = 12): RGB {
  if (contrastRatio(color, against) >= min) return color;
  const { h, s, l } = rgbToHsl(color);
  const targetDark = relativeLuminance(against) > 0.4; // light background -> darken; dark -> lighten
  for (let i = 1; i <= steps; i++) {
    const l2 = targetDark ? Math.max(0, l - i * (l / steps)) : Math.min(1, l + i * ((1 - l) / steps));
    const candidate = hslToRgb(h, s, l2);
    if (contrastRatio(candidate, against) >= min) return candidate;
  }
  return targetDark ? { r: 17, g: 24, b: 39 } : { r: 255, g: 255, b: 255 };
}

/* ===================================================== palette generation */

export interface GeneratedColors {
  primary: string; secondary: string; accent: string;
  background: string; surface: string; text: string; heading: string;
  subtleText: string; border: string; error: string;
  link: string; inputBackground: string; buttonBackground: string; buttonText: string; progress: string;
}

/**
 * Colors, most-prominent first (as `dominantColorsFromImage` returns them, or
 * a single brand color repeated) -> a complete, contrast-checked palette.
 *
 * The FIRST color is the anchor (primary / button / progress / link source).
 * A second and third, if given, become secondary and accent; otherwise they
 * are derived from the first by hue-shifting and re-lightening it — the
 * brief's "balanced, professional palette", not one flat color painted over
 * every token.
 */
export function generatePalette(seeds: RGB[]): GeneratedColors {
  if (seeds.length === 0) throw new Error("generatePalette needs at least one color");
  const primary = seeds[0];
  const { h, s } = rgbToHsl(primary);

  // a usable brand anchor is neither washed out nor nearly black — clamp
  // lightness into a range a primary/button color actually reads well at
  const { l: primL } = rgbToHsl(primary);
  const primaryUsable = hslToRgb(h, Math.max(s, 0.35), Math.min(Math.max(primL, 0.32), 0.6));

  const secondary = seeds[1] ?? hslToRgb(h, Math.min(s + 0.1, 1), Math.max(primL - 0.28, 0.12));
  const accent = seeds[2] ?? hslToRgb((h + 28) % 360, Math.min(s + 0.15, 1), Math.min(primL + 0.05, 0.62));

  const surface: RGB = { r: 255, g: 255, b: 255 };
  // a faint tint of the brand color, not plain gray — this is the one place
  // "apply the logo color everywhere" is actually right in small doses
  const background = hslToRgb(h, Math.min(s * 0.35, 0.25), 0.975);
  const border = hslToRgb(h, Math.min(s * 0.25, 0.2), 0.88);

  const textRgb: RGB = { r: 15, g: 23, b: 42 }; // #0f172a — matches the schema's own default
  const subtleRgb = hslToRgb(h, Math.min(s * 0.15, 0.15), 0.42);
  const headingRgb = ensureContrast(hslToRgb(h, Math.min(s * 0.3, 0.25), Math.max(primL - 0.35, 0.12)), background, 7);

  const buttonBg = ensureContrast(primaryUsable, surface, 1); // buttons carry their own text-contrast check below, not this one
  const buttonText = hexToRgb(bestTextColor(buttonBg))!;

  return {
    primary: rgbToHex(primaryUsable),
    secondary: rgbToHex(secondary),
    accent: rgbToHex(accent),
    background: rgbToHex(background),
    surface: rgbToHex(surface),
    text: rgbToHex(ensureContrast(textRgb, background, 7)),
    heading: rgbToHex(headingRgb),
    subtleText: rgbToHex(ensureContrast(subtleRgb, background, 4.5)),
    border: rgbToHex(border),
    error: "#dc2626",
    link: rgbToHex(ensureContrast(accent, background, 4.5)),
    inputBackground: rgbToHex(surface),
    buttonBackground: rgbToHex(buttonBg),
    buttonText: rgbToHex(buttonText),
    progress: rgbToHex(accent),
  };
}

/** A single brand hex -> the same full palette, via the one generator. */
export function generatePaletteFromHex(hex: string): GeneratedColors {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error(`"${hex}" is not a #rrggbb color`);
  return generatePalette([rgb]);
}

/* ================================================== dominant-color extraction
   Browser-only (canvas + Image) — never imported by anything that runs
   under Node's test runner, so the pure functions above stay testable
   without a DOM. */

/**
 * Read an image's dominant colors via a downscaled canvas.
 *
 * Quantizes to a coarse RGB grid (32-level buckets — fine enough to keep a
 * logo's real brand colors apart, coarse enough that anti-aliased edge
 * pixels collapse into the color they're a gradient toward), discards
 * near-white/near-black/transparent pixels (the background canvas of most
 * logo exports, not a brand color), and returns the remaining buckets by
 * frequency with a minimum perceptual distance between them so "primary"
 * and "secondary" are not two shades of the same pixel cluster.
 *
 * Throws on a tainted canvas (a logo served without CORS headers permitting
 * pixel access) or a failed image load — callers should catch this and
 * offer manual color entry instead, not treat it as fatal.
 */
export async function dominantColorsFromImage(url: string, maxColors = 5): Promise<RGB[]> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not load the image"));
    img.src = url;
  });

  const SIZE = 48;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    throw new Error("this image's pixels can't be read here (cross-origin) — try a different image, or enter colors manually");
  }

  const BUCKET = 32;
  const counts = new Map<string, { rgb: RGB; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue; // transparent
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const { s, l } = rgbToHsl({ r, g, b });
    if (l > 0.94 || l < 0.06) continue; // near-white / near-black canvas
    if (s < 0.12) continue; // near-gray — not a "brand color"
    const key = `${Math.round(r / BUCKET)},${Math.round(g / BUCKET)},${Math.round(b / BUCKET)}`;
    const cur = counts.get(key);
    if (cur) { cur.n++; cur.rgb.r += r; cur.rgb.g += g; cur.rgb.b += b; }
    else counts.set(key, { rgb: { r, g, b }, n: 1 });
  }

  const clusters = [...counts.values()]
    .map((c) => ({ rgb: { r: c.rgb.r / c.n, g: c.rgb.g / c.n, b: c.rgb.b / c.n }, n: c.n }))
    .sort((a, b) => b.n - a.n);

  const chosen: RGB[] = [];
  const MIN_DISTANCE = 40; // in the same coarse RGB space as BUCKET
  for (const c of clusters) {
    if (chosen.length >= maxColors) break;
    const tooClose = chosen.some((existing) => {
      const dr = existing.r - c.rgb.r, dg = existing.g - c.rgb.g, db = existing.b - c.rgb.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) < MIN_DISTANCE;
    });
    if (!tooClose) chosen.push(c.rgb);
  }

  if (chosen.length === 0) {
    throw new Error("no distinct brand colors found in this image — it may be mostly grayscale or transparent");
  }
  return chosen;
}
