/**
 * THE REPORT DESIGN SYSTEM — presets, colour rules, brand themes, and the
 * reading of a design request in words.
 *
 * A design is a `DesignConfig`: explicit tokens a person can see and edit.
 * A request in words ("dark navy background, white text, teal accents",
 * "use our brand", "make it a five-minute vertical video") is read into a
 * PATCH of those tokens with a list of what was understood — never into an
 * opaque look. Every patch goes through `applyDesignPatch`, which enforces
 * the contrast rules (text 4.5:1, chart marks 3:1 against the background,
 * series distinguishable from each other) and says what it adjusted.
 */
import type { AspectRatio, DesignColors, DesignConfig, FontFamilyId, MotionStyle, PresetId, TitleStyle, Transition, TypeScale, Density } from "./types.js";

/* ------------------------------------------------------------ colour math */

export interface RGB { r: number; g: number; b: number }
export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function toHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(hex: string): number { const c = parseHex(hex) ?? { r: 0, g: 0, b: 0 }; return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
export function contrast(a: string, b: string): number { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
export function mix(a: string, b: string, t: number): string { const x = parseHex(a)!, y = parseHex(b)!; return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t }); }
export const isDark = (hex: string) => luminance(hex) < 0.18;

function rgbToHsl({ r, g, b }: RGB) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}
function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex({ r: 255 * f(0), g: 255 * f(8), b: 255 * f(4) });
}
export const hueOf = (hex: string) => rgbToHsl(parseHex(hex)!).h;

/** move a colour's lightness away from `against` until it reaches `min` contrast; null if it cannot */
export function ensureContrast(color: string, against: string, min: number): string {
  if (contrast(color, against) >= min) return color.toUpperCase();
  const { h, s, l } = rgbToHsl(parseHex(color)!);
  const darker = !isDark(against);
  for (let i = 1; i <= 40; i++) {
    const nl = darker ? Math.max(0, l - i * 0.025) : Math.min(1, l + i * 0.025);
    const c = hslToHex(h, s, nl);
    if (contrast(c, against) >= min) return c;
  }
  return darker ? "#000000" : "#FFFFFF";
}

/** two series colours are distinguishable when they differ enough in hue or in lightness */
export function distinguishable(a: string, b: string): boolean {
  const x = rgbToHsl(parseHex(a)!), y = rgbToHsl(parseHex(b)!);
  const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
  return (dh >= 28 && Math.min(x.s, y.s) > 0.15) || Math.abs(x.l - y.l) >= 0.18;
}

/* ------------------------------------------------------------ named colours (for requests in words) */

export const NAMED_COLORS: Record<string, string> = {
  navy: "#1B2A4A", "dark navy": "#0B1630", "midnight": "#0F172A", blue: "#2563EB", "corporate blue": "#1F4E99", "royal blue": "#1D4ED8", "sky blue": "#38BDF8", "light blue": "#93C5FD",
  teal: "#14B8A6", "dark teal": "#0F766E", turquoise: "#06B6D4", cyan: "#06B6D4", green: "#16A34A", "forest green": "#166534", emerald: "#059669", mint: "#6EE7B7", olive: "#65741B",
  gold: "#C9A227", yellow: "#EAB308", amber: "#F59E0B", orange: "#EA580C", coral: "#F97362", red: "#DC2626", crimson: "#B91C1C", burgundy: "#7F1D1D", maroon: "#7F1D1D",
  pink: "#DB2777", magenta: "#C026D3", purple: "#7C3AED", violet: "#7C3AED", indigo: "#4F46E5", lavender: "#A78BFA",
  black: "#0A0A0A", charcoal: "#1F2933", graphite: "#2E3440", slate: "#475569", grey: "#6B7280", gray: "#6B7280", "light grey": "#E5E7EB", "light gray": "#E5E7EB", silver: "#C0C4CC",
  white: "#FFFFFF", "off-white": "#FAF7F2", "off white": "#FAF7F2", cream: "#FBF6EC", ivory: "#FFFDF5", beige: "#EFE6D6", sand: "#E7DCC8", brown: "#7C4A2D",
};

/* ------------------------------------------------------------ presets */

const SCALE: TypeScale = { display: 84, title: 54, headline: 36, body: 30, caption: 20, stat: 150, label: 22 };

export const PRESETS: Record<PresetId, DesignConfig> = {
  corporate_executive: {
    preset: "corporate_executive", name: "Corporate Executive",
    colors: { primary: "#1F3A5F", secondary: "#3E6A9A", accent: "#B8892B", background: "#FFFFFF", surface: "#F3F5F8", text: "#141B26", textMuted: "#4A5568", grid: "#D7DDE5", chart: ["#1F3A5F", "#B8892B", "#5B8DB8", "#7A8B99", "#2F7D6D", "#A35D5D"], tableHeaderBg: "#1F3A5F", tableHeaderText: "#FFFFFF", highlight: "#B8892B", positive: "#2F7D4F", negative: "#B03A2E" },
    typography: { heading: "Inter", body: "Inter", numeric: "Inter", headingWeight: 700, scale: SCALE },
    density: "balanced", titleStyle: "left_rule", imagery: "logo_only",
    motion: { style: "subtle", speed: 1, transition: "fade" }, dataLabels: { show: true, decimals: 0 },
    footer: { text: "", showLogo: true, pageNumbers: true, sources: true },
    video: { aspect: "16:9", height: 1080, fps: 30, narration: false, subtitles: false },
  },
  modern_analytics: {
    preset: "modern_analytics", name: "Modern Analytics",
    colors: { primary: "#4F46E5", secondary: "#0EA5E9", accent: "#0D9488", background: "#F7F8FB", surface: "#FFFFFF", text: "#111827", textMuted: "#4B5563", grid: "#E3E6EE", chart: ["#4F46E5", "#0D9488", "#F59E0B", "#0EA5E9", "#DB2777", "#64748B"], tableHeaderBg: "#EEF0FF", tableHeaderText: "#312E81", highlight: "#0D9488", positive: "#15803D", negative: "#B91C1C" },
    typography: { heading: "Inter", body: "Inter", numeric: "Inter", headingWeight: 700, scale: SCALE },
    density: "balanced", titleStyle: "kicker", imagery: "geometric",
    motion: { style: "standard", speed: 1, transition: "fade" }, dataLabels: { show: true, decimals: 0 },
    footer: { text: "", showLogo: true, pageNumbers: true, sources: true },
    video: { aspect: "16:9", height: 1080, fps: 30, narration: false, subtitles: false },
  },
  premium_editorial: {
    preset: "premium_editorial", name: "Premium Editorial",
    colors: { primary: "#7A2E1D", secondary: "#3F3A36", accent: "#B4652F", background: "#FBF8F3", surface: "#F2ECE2", text: "#1C1917", textMuted: "#57534E", grid: "#E2D9CC", chart: ["#7A2E1D", "#B4652F", "#3F6B6E", "#8C7B6B", "#4D5A3A", "#A88B52"], tableHeaderBg: "#2A2522", tableHeaderText: "#FBF8F3", highlight: "#B4652F", positive: "#3F6B4E", negative: "#9A2B1C" },
    typography: { heading: "Source Serif 4", body: "Inter", numeric: "Source Serif 4", headingWeight: 700, scale: { ...SCALE, title: 58, stat: 170 } },
    density: "airy", titleStyle: "kicker", imagery: "none",
    motion: { style: "subtle", speed: 0.9, transition: "fade" }, dataLabels: { show: true, decimals: 0 },
    footer: { text: "", showLogo: true, pageNumbers: true, sources: true },
    video: { aspect: "16:9", height: 1080, fps: 30, narration: false, subtitles: false },
  },
  minimal_research: {
    preset: "minimal_research", name: "Minimal Research",
    colors: { primary: "#111827", secondary: "#374151", accent: "#2563EB", background: "#FFFFFF", surface: "#F6F7F9", text: "#111827", textMuted: "#4B5563", grid: "#E5E7EB", chart: ["#2563EB", "#111827", "#9CA3AF", "#0F766E", "#B45309", "#7C3AED"], tableHeaderBg: "#F3F4F6", tableHeaderText: "#111827", highlight: "#2563EB", positive: "#15803D", negative: "#B91C1C" },
    typography: { heading: "Inter", body: "Inter", numeric: "Inter", headingWeight: 700, scale: { ...SCALE, title: 50 } },
    density: "dense", titleStyle: "left_rule", imagery: "none",
    motion: { style: "subtle", speed: 1.1, transition: "cut" }, dataLabels: { show: true, decimals: 0 },
    footer: { text: "", showLogo: false, pageNumbers: true, sources: true },
    video: { aspect: "16:9", height: 1080, fps: 30, narration: false, subtitles: false },
  },
  cinematic_data_story: {
    preset: "cinematic_data_story", name: "Cinematic Data Story",
    colors: { primary: "#2DD4BF", secondary: "#818CF8", accent: "#F59E0B", background: "#0B1220", surface: "#131C30", text: "#F8FAFC", textMuted: "#B6C2D6", grid: "#2A3654", chart: ["#2DD4BF", "#818CF8", "#F59E0B", "#F472B6", "#60A5FA", "#A3E635"], tableHeaderBg: "#1E293B", tableHeaderText: "#F8FAFC", highlight: "#F59E0B", positive: "#4ADE80", negative: "#F87171" },
    typography: { heading: "Montserrat", body: "Inter", numeric: "Montserrat", headingWeight: 700, scale: { ...SCALE, display: 92, stat: 170 } },
    density: "airy", titleStyle: "band", imagery: "geometric",
    motion: { style: "expressive", speed: 1, transition: "slide" }, dataLabels: { show: true, decimals: 0 },
    footer: { text: "", showLogo: true, pageNumbers: true, sources: true },
    video: { aspect: "16:9", height: 1080, fps: 30, narration: false, subtitles: false },
  },
  custom_brand: {
    preset: "custom_brand", name: "Custom Brand",
    colors: { primary: "#1F3A5F", secondary: "#3E6A9A", accent: "#B8892B", background: "#FFFFFF", surface: "#F3F5F8", text: "#141B26", textMuted: "#4A5568", grid: "#D7DDE5", chart: ["#1F3A5F", "#B8892B", "#5B8DB8", "#7A8B99", "#2F7D6D", "#A35D5D"], tableHeaderBg: "#1F3A5F", tableHeaderText: "#FFFFFF", highlight: "#B8892B", positive: "#2F7D4F", negative: "#B03A2E" },
    typography: { heading: "Inter", body: "Inter", numeric: "Inter", headingWeight: 700, scale: SCALE },
    density: "balanced", titleStyle: "left_rule", imagery: "logo_only",
    motion: { style: "subtle", speed: 1, transition: "fade" }, dataLabels: { show: true, decimals: 0 },
    footer: { text: "", showLogo: true, pageNumbers: true, sources: true },
    video: { aspect: "16:9", height: 1080, fps: 30, narration: false, subtitles: false },
  },
};
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
export const defaultDesign = (preset: PresetId = "corporate_executive"): DesignConfig => structuredClone(PRESETS[preset]);

/* ------------------------------------------------------------ contrast enforcement */

export interface DesignAdjustment { token: string; from: string; to: string; why: string }

/**
 * The rules every design obeys, whatever was asked: body and muted text
 * 4.5:1 on the background and on surfaces, table header text 4.5:1 on its
 * header, chart marks 3:1 on the background (WCAG 1.4.11), and series that
 * can be told apart. A colour that breaks a rule is moved — lightness only,
 * its hue kept — and the move is reported.
 */
export function enforceDesign(d: DesignConfig): { design: DesignConfig; adjustments: DesignAdjustment[] } {
  const design = structuredClone(d);
  const adj: DesignAdjustment[] = [];
  const c = design.colors;
  const fix = (token: keyof DesignColors, against: string, min: number, why: string) => {
    const was = c[token] as string;
    const now = ensureContrast(was, against, min);
    if (now.toUpperCase() !== was.toUpperCase()) { (c[token] as string) = now; adj.push({ token, from: was, to: now, why }); }
  };
  fix("text", c.background, 7, "body text must stay readable on the background (7:1)");
  fix("text", c.surface, 4.5, "body text must stay readable on cards (4.5:1)");
  fix("textMuted", c.background, 4.5, "secondary text must stay readable (4.5:1)");
  fix("tableHeaderText", c.tableHeaderBg, 4.5, "table headers must stay readable (4.5:1)");
  fix("primary", c.background, 3, "the primary colour draws titles' rules and the first series (3:1)");
  fix("accent", c.background, 3, "the accent marks highlights on the background (3:1)");
  fix("highlight", c.background, 3, "a highlighted bar must stand out from the background (3:1)");
  fix("grid", c.background, 1.25, "gridlines must be visible but quiet");
  c.chart = c.chart.slice(0, 8).map((col, i) => {
    const now = ensureContrast(col, c.background, 3);
    if (now.toUpperCase() !== col.toUpperCase()) adj.push({ token: `chart[${i}]`, from: col, to: now, why: "every series needs 3:1 against the background" });
    return now;
  });
  /* series that cannot be told apart: the later one is moved in lightness, then replaced from a spaced hue */
  for (let i = 1; i < c.chart.length; i++) {
    for (let j = 0; j < i; j++) {
      if (distinguishable(c.chart[i], c.chart[j])) continue;
      const { h, s, l } = rgbToHsl(parseHex(c.chart[i])!);
      let next = hslToHex((h + 137.5 * i) % 360, Math.max(0.45, s), Math.min(0.6, Math.max(0.35, l)));
      next = ensureContrast(next, c.background, 3);
      adj.push({ token: `chart[${i}]`, from: c.chart[i], to: next, why: `series ${i + 1} was too close to series ${j + 1} to tell apart` });
      c.chart[i] = next;
      break;
    }
  }
  if (c.chart.length < 4) for (let i = c.chart.length; i < 6; i++) c.chart.push(ensureContrast(hslToHex((hueOf(c.chart[0] ?? c.primary) + 60 * i) % 360, 0.55, 0.45), c.background, 3));
  design.video.fps = ([24, 25, 30] as const).includes(design.video.fps) ? design.video.fps : 30;
  design.motion.speed = Math.min(1.6, Math.max(0.6, design.motion.speed));
  return { design, adjustments: adj };
}

/* ------------------------------------------------------------ brand themes */

export interface BrandInput {
  /** the brand's colours, most important first (from a logo, a guideline, a reference deck) */
  colors: string[];
  fonts?: { heading?: string; body?: string };
  logo?: DesignConfig["logo"];
  name?: string;
}

/** map a font named in a brand kit to the nearest family the renderer carries (a serif to Source Serif 4, a geometric to Montserrat) */
export function nearestFamily(font: string | undefined): FontFamilyId | null {
  if (!font) return null;
  const f = font.toLowerCase();
  if (/serif|garamond|georgia|times|merriweather|playfair|caslon|baskerville|lora|cambria/.test(f) && !/sans/.test(f)) return "Source Serif 4";
  if (/montserrat|gotham|futura|avenir|poppins|century gothic|proxima|raleway|nunito/.test(f)) return "Montserrat";
  return "Inter";
}

/** a theme built on a preset, recoloured with the brand: primary and accent from the brand, the rest derived */
export function brandTheme(preset: PresetId, brand: BrandInput): { design: DesignConfig; adjustments: DesignAdjustment[] } {
  const d = defaultDesign(preset === "custom_brand" ? "corporate_executive" : preset);
  d.preset = preset; d.name = preset === "custom_brand" ? (brand.name ? `${brand.name} brand` : "Custom Brand") : `${PRESETS[preset].name} · brand colours`;
  const colors = brand.colors.map((x) => parseHex(x) ? toHex(parseHex(x)!) : null).filter((x): x is string => !!x)
    /* near-white and near-black are backgrounds and text, not brand marks */
    .filter((x) => luminance(x) > 0.02 && luminance(x) < 0.85);
  const p = colors[0] ?? d.colors.primary;
  const a = colors.find((x, i) => i > 0 && distinguishable(x, p)) ?? d.colors.accent;
  const s = colors.find((x) => x !== p && x !== a) ?? mix(p, isDark(d.colors.background) ? "#FFFFFF" : "#000000", 0.25);
  const dark = isDark(d.colors.background);
  d.colors.primary = p; d.colors.accent = a; d.colors.secondary = s; d.colors.highlight = a;
  if (preset === "custom_brand") {
    /* the brand's own: its primary on the title band and table headers, a tint of it as surface */
    d.colors.surface = mix(p, "#FFFFFF", 0.93);
    d.colors.tableHeaderBg = p; d.colors.tableHeaderText = contrast("#FFFFFF", p) >= 4.5 ? "#FFFFFF" : "#111111";
    d.titleStyle = "band";
  } else if (!dark) {
    d.colors.tableHeaderBg = preset === "minimal_research" ? d.colors.tableHeaderBg : p;
    d.colors.tableHeaderText = preset === "minimal_research" ? d.colors.tableHeaderText : (contrast("#FFFFFF", p) >= 4.5 ? "#FFFFFF" : "#111111");
  }
  const rest = colors.filter((x) => x !== p && x !== a);
  d.colors.chart = [p, a, ...rest, ...d.colors.chart.filter((x) => x !== p && x !== a)].slice(0, 6);
  const hf = nearestFamily(brand.fonts?.heading), bf = nearestFamily(brand.fonts?.body);
  if (hf) d.typography.heading = hf;
  if (bf) d.typography.body = bf;
  if (brand.logo) d.logo = brand.logo;
  return enforceDesign(d);
}

/* ------------------------------------------------------------ a design request in words */

export interface DesignPatch {
  preset?: PresetId;
  colors?: Partial<DesignColors>;
  typography?: { heading?: FontFamilyId; body?: FontFamilyId; numeric?: FontFamilyId; scaleFactor?: number; statFactor?: number };
  density?: Density;
  titleStyle?: TitleStyle;
  imagery?: DesignConfig["imagery"];
  motion?: { style?: MotionStyle; speed?: number; transition?: Transition };
  dataLabels?: { show?: boolean; decimals?: number };
  footer?: Partial<DesignConfig["footer"]>;
  video?: { aspect?: AspectRatio; height?: 720 | 1080 | 1440 | 2160; fps?: 24 | 25 | 30; targetDurationSec?: number | null; narration?: boolean; subtitles?: boolean };
  /** dark ↔ light: the palette inverted around the brand colours */
  mode?: "dark" | "light";
  useBrand?: boolean;
}
export interface DesignReading { patch: DesignPatch; understood: string[]; unclear: string[] }

const colorWord = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length).map((w) => w.replace(/[-]/g, "[- ]?")).join("|");
const COLOR = `(#[0-9a-f]{6}|#[0-9a-f]{3}|${colorWord})`;
const resolveColor = (w: string): string | null => {
  const t = w.trim().toLowerCase().replace(/-/g, " ");
  if (/^#/.test(t)) return parseHex(t) ? toHex(parseHex(t)!) : null;
  return NAMED_COLORS[t] ?? NAMED_COLORS[t.replace(/ /g, "-")] ?? null;
};
const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, ninety: 90 };

/**
 * Read a design request into a patch. Each clause the engine understands is
 * listed in words; what it could not place is returned as `unclear` (the
 * Studio may put that remainder to a configured model, which must answer
 * in the same patch vocabulary).
 */
export function interpretDesignRequest(text: string, ctx: { brand?: BrandInput | null; current?: DesignConfig } = {}): DesignReading {
  const t = ` ${text.toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, " ")} `;
  const patch: DesignPatch = {};
  const understood: string[] = [];
  const say = (s: string) => understood.push(s);
  const colors: Partial<DesignColors> = {};

  /* the look as a whole */
  const presetRules: [RegExp, PresetId, string][] = [
    [/\b(cinematic|dramatic|data story|storytelling)\b/, "cinematic_data_story", "cinematic data-story look"],
    [/\b(editorial|magazine|premium)\b/, "premium_editorial", "premium editorial look"],
    [/\b(minimal|minimalist|plain|simple)\b/, "minimal_research", "minimal research look"],
    [/\b(modern|contemporary|analytics|tech|dashboard)\b/, "modern_analytics", "modern analytics look"],
    [/\b(board|executive|corporate|c-suite|leadership|formal)\b/, "corporate_executive", "corporate executive look"],
  ];
  for (const [re, id, words] of presetRules) if (re.test(t)) { patch.preset = id; say(words); break; }
  if (/\b(our|my|the) (brand|corporate colou?rs|brand identity|brand colou?rs|organi[sz]ation'?s? (brand|colou?rs))\b|\bbrand(ed)? (identity|colou?rs|guidelines)\b|\bon-brand\b/.test(t)) {
    if (ctx.brand?.colors.length) { patch.useBrand = true; say("the organisation's brand colours"); }
    else understood.push("brand colours requested — none are on file yet; upload a logo or brand guide in Branding");
  }
  if (/\b(healthcare|clinical|medical|pharma|hospital)\b/.test(t)) {
    patch.preset ??= "corporate_executive";
    Object.assign(colors, { primary: "#1D4E6B", accent: "#2E7D6B", highlight: "#2E7D6B", secondary: "#557A95", chart: ["#1D4E6B", "#2E7D6B", "#7A9CB3", "#8C8C8C", "#5E8B7E", "#B08A57"] });
    patch.motion = { ...(patch.motion ?? {}), style: "subtle" };
    say("restrained healthcare palette (deep blue, clinical green) with subtle motion");
  }
  if (/\b(restrained|muted|conservative|understated|calm)\b/.test(t) && !/\bhealthcare|clinical|medical\b/.test(t)) { patch.motion = { ...(patch.motion ?? {}), style: "subtle" }; say("restrained, subtle motion"); }

  /* colours by role */
  const roleRe = new RegExp(`${COLOR}\\s+(background|backdrop|text|type|font colou?r|accents?|highlights?|headings?|titles?)`, "g");
  for (const m of t.matchAll(roleRe)) {
    const col = resolveColor(m[1]); if (!col) continue;
    const role = m[2];
    if (/background|backdrop/.test(role)) { colors.background = col; colors.surface = mix(col, isDark(col) ? "#FFFFFF" : "#000000", isDark(col) ? 0.07 : 0.04); say(`${m[1]} background`); }
    else if (/text|type|font/.test(role)) { colors.text = col; say(`${m[1]} text`); }
    else if (/accent|highlight/.test(role)) { colors.accent = col; colors.highlight = col; say(`${m[1]} accents`); }
    else { colors.primary = col; say(`${m[1]} headings`); }
  }
  const pairRe = new RegExp(`${COLOR}\\s+(?:and|&|\\+)\\s+${COLOR}(?:\\s+(?:palette|colou?rs|scheme|theme))?`, "g");
  for (const m of t.matchAll(pairRe)) {
    if (new RegExp(`${m[2]}\\s+(background|text|accent)`).test(t.slice(t.indexOf(m[0])))) continue;
    const a = resolveColor(m[1]), b = resolveColor(m[2]);
    if (!a || !b || colors.primary) continue;
    colors.primary = a; colors.accent = b; colors.highlight = b; say(`${m[1]} and ${m[2]} palette`);
  }
  const hexes = [...t.matchAll(/#[0-9a-f]{6}\b/g)].map((m) => toHex(parseHex(m[0])!)).filter((h) => !Object.values(colors).includes(h));
  if (hexes.length && !colors.primary) { colors.primary = hexes[0]; if (hexes[1]) { colors.accent = hexes[1]; colors.highlight = hexes[1]; } say(`colours ${hexes.join(", ")}`); }

  if (/\bdark (mode|theme|look|background|version)\b|\bon dark\b/.test(t) && !colors.background) { patch.mode = "dark"; say("dark background"); }
  if (/\blight (mode|theme|look|background|version)\b|\bwhite background\b/.test(t) && !colors.background) { patch.mode = "light"; say("light background"); }
  if (Object.keys(colors).length) patch.colors = colors;

  /* type */
  const typo: NonNullable<DesignPatch["typography"]> = {};
  if (/\bserif\b/.test(t) && !/\bsans[- ]?serif\b/.test(t)) { typo.heading = "Source Serif 4"; say("serif headings"); }
  if (/\bsans[- ]?serif\b/.test(t)) { typo.heading = "Inter"; typo.body = "Inter"; say("sans-serif type"); }
  if (/\bgeometric\b/.test(t)) { typo.heading = "Montserrat"; say("geometric headings"); }
  if (/\b(larger|bigger|increase( the)?) (labels?|text|type|fonts?)\b|\b(labels?|text|type|fonts?) (larger|bigger)\b/.test(t)) { typo.scaleFactor = 1.15; say("larger text and labels (+15%)"); }
  if (/\b(smaller|reduce( the)?) (labels?|text|type|fonts?)\b|\b(labels?|text|type|fonts?) smaller\b/.test(t)) { typo.scaleFactor = 0.9; say("smaller text (−10%)"); }
  if (/\b(large|big|bold|huge) (statistics|stats|numbers|figures)\b/.test(t)) { typo.statFactor = 1.2; say("large statistics"); }
  if (Object.keys(typo).length) patch.typography = typo;

  /* layout */
  if (/\b(airy|spacious|generous|breathing room|white ?space)\b/.test(t)) { patch.density = "airy"; say("airy layout"); }
  if (/\b(dense|compact|tight|information[- ]rich)\b/.test(t)) { patch.density = "dense"; say("compact layout"); }
  if (/\bcent(er|re)(ed)? titles?\b/.test(t)) { patch.titleStyle = "centered"; say("centred titles"); }

  /* motion */
  const motion: NonNullable<DesignPatch["motion"]> = { ...(patch.motion ?? {}) };
  if (/\b(no|without|zero) (animation|motion|transitions?)\b|\bstatic\b/.test(t)) { motion.style = "none"; motion.transition = "cut"; say("no animation"); }
  else if (/\b(less|fewer|minimal|reduce(d)?|subtle|gentle) (animation|motion|transitions?)\b|\bless animated\b/.test(t)) { motion.style = "subtle"; say("less animation"); }
  else if (/\b(more|lively|energetic|dynamic|bold) (animation|motion)\b|\bmore dynamic\b/.test(t)) { motion.style = "expressive"; say("more expressive motion"); }
  if (/\bsmooth (transitions?|animation)\b/.test(t)) { motion.transition = "fade"; motion.style ??= "standard"; say("smooth transitions"); }
  if (/\b(faster|quicker|snappier)\b/.test(t)) { motion.speed = 1.25; say("faster pacing"); }
  if (/\b(slower|unhurried|relaxed pace)\b/.test(t)) { motion.speed = 0.8; say("slower pacing"); }
  if (Object.keys(motion).length) patch.motion = motion;

  /* video */
  const video: NonNullable<DesignPatch["video"]> = {};
  const dur = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|ninety)[- ](minutes?|mins?|seconds?|secs?)\b/.exec(t);
  if (dur) { const n = numberWords[dur[1]] ?? Number(dur[1]); const sec = /^s/.test(dur[2]) ? n : n * 60; if (sec >= 20 && sec <= 1800) { video.targetDurationSec = Math.round(sec); say(`about ${sec >= 60 ? `${Math.round(sec / 6) / 10} minutes` : `${sec} seconds`} long`); } }
  if (/\b(vertical|portrait|9:16|9x16|stories|reels|tiktok|mobile)\b/.test(t)) { video.aspect = "9:16"; say("vertical 9:16 video"); }
  else if (/\b(square|1:1|1x1)\b/.test(t)) { video.aspect = "1:1"; say("square 1:1 video"); }
  else if (/\b(widescreen|16:9|16x9|landscape)\b/.test(t)) { video.aspect = "16:9"; say("widescreen 16:9"); }
  if (/\b(4k|2160p|uhd)\b/.test(t)) { video.height = 2160; say("4K resolution"); }
  else if (/\b1440p?\b/.test(t)) { video.height = 1440; say("1440p resolution"); }
  else if (/\b(1080p?|full hd)\b/.test(t)) { video.height = 1080; say("1080p"); }
  else if (/\b720p?\b/.test(t)) { video.height = 720; say("720p"); }
  if (/\b(no|without) (narration|voice[- ]?over|voice)\b/.test(t)) { video.narration = false; say("no narration"); }
  else if (/\b(narrat(ion|ed|e)|voice[- ]?over|voiced)\b/.test(t)) { video.narration = true; say("narration"); }
  if (/\b(no|without) (subtitles|captions)\b/.test(t)) { video.subtitles = false; say("no subtitles"); }
  else if (/\b(subtitles|captions|captioned)\b/.test(t)) { video.subtitles = true; say("subtitles"); }
  if (Object.keys(video).length) patch.video = video;

  /* data labels */
  if (/\b(hide|no|without) (data )?labels\b/.test(t)) { patch.dataLabels = { show: false }; say("no data labels"); }
  const dec = /\b(one|1|two|2|zero|0|no) decimals?\b/.exec(t);
  if (dec) { const n = { one: 1, "1": 1, two: 2, "2": 2, zero: 0, "0": 0, no: 0 }[dec[1] as "one"] ?? 0; patch.dataLabels = { ...(patch.dataLabels ?? {}), decimals: n }; say(`${n} decimal${n === 1 ? "" : "s"} on data labels`); }
  if (/\b(no|hide|without) (page )?numbers\b/.test(t)) { patch.footer = { ...(patch.footer ?? {}), pageNumbers: false }; say("no page numbers"); }
  if (/\b(no|hide|without) logo\b/.test(t)) { patch.footer = { ...(patch.footer ?? {}), showLogo: false }; say("no logo"); }

  /* what was not placed: the clauses that matched nothing above */
  const clauses = text.split(/[.;,]|\band\b/i).map((s) => s.trim()).filter((s) => s.length > 3);
  const keywords = /(look|style|presentation|report|video|deck|slides?|make|use|create|with|our|board|executive|modern|clean|minimal|editorial|cinematic|dark|light|navy|teal|blue|gold|white|colou?r|background|text|accent|font|serif|label|animation|motion|transition|minute|second|vertical|square|4k|1080|narrat|subtitle|caption|brand|logo|statistic|decimal|airy|dense|healthcare|formal|restrained|smooth|faster|slower|palette|minimal|meeting|clear)/i;
  const unclear = understood.length ? clauses.filter((c) => !keywords.test(c)) : clauses;
  return { patch, understood, unclear };
}

/** apply a patch to a design; the result always passes `enforceDesign` */
export function applyDesignPatch(base: DesignConfig, patch: DesignPatch, ctx: { brand?: BrandInput | null } = {}): { design: DesignConfig; adjustments: DesignAdjustment[] } {
  let d = structuredClone(base);
  if (patch.preset && patch.preset !== d.preset) {
    const keep = { logo: d.logo, video: d.video, footer: d.footer };
    d = patch.useBrand && ctx.brand ? brandTheme(patch.preset, ctx.brand).design : defaultDesign(patch.preset);
    d.logo = keep.logo ?? d.logo; d.video = { ...keep.video }; d.footer = { ...d.footer, text: keep.footer.text };
  } else if (patch.useBrand && ctx.brand) {
    const branded = brandTheme(d.preset, ctx.brand).design;
    d.colors = branded.colors; d.typography = { ...d.typography, heading: branded.typography.heading, body: branded.typography.body }; d.logo = branded.logo ?? d.logo;
  }
  if (patch.mode === "dark" && !isDark(d.colors.background)) {
    d.colors = { ...d.colors, background: "#0B1220", surface: "#131C30", text: "#F8FAFC", textMuted: "#B6C2D6", grid: "#2A3654", tableHeaderBg: "#1E293B", tableHeaderText: "#F8FAFC" };
  } else if (patch.mode === "light" && isDark(d.colors.background)) {
    d.colors = { ...d.colors, background: "#FFFFFF", surface: "#F3F5F8", text: "#141B26", textMuted: "#4A5568", grid: "#D7DDE5", tableHeaderBg: d.colors.primary, tableHeaderText: "#FFFFFF" };
  }
  if (patch.colors) {
    d.colors = { ...d.colors, ...patch.colors };
    /* a new background flips the text, the grid and the surface with it */
    if (patch.colors.background) {
      const dark = isDark(patch.colors.background);
      if (!patch.colors.text) d.colors.text = dark ? "#F8FAFC" : "#141B26";
      d.colors.textMuted = dark ? "#B6C2D6" : "#4A5568";
      d.colors.grid = mix(patch.colors.background, dark ? "#FFFFFF" : "#000000", dark ? 0.18 : 0.12);
      if (!patch.colors.surface) d.colors.surface = mix(patch.colors.background, dark ? "#FFFFFF" : "#000000", dark ? 0.07 : 0.04);
      if (dark) { d.colors.tableHeaderBg = mix(patch.colors.background, "#FFFFFF", 0.12); d.colors.tableHeaderText = "#F8FAFC"; }
    }
    if (patch.colors.primary || patch.colors.accent) {
      const p = patch.colors.primary ?? d.colors.primary, a = patch.colors.accent ?? d.colors.accent;
      if (!patch.colors.chart) d.colors.chart = [p, a, ...d.colors.chart.filter((x) => x !== p && x !== a)].slice(0, 6);
      if (patch.colors.primary && !isDark(d.colors.background)) { d.colors.tableHeaderBg = p; d.colors.tableHeaderText = contrast("#FFFFFF", p) >= 4.5 ? "#FFFFFF" : "#111111"; }
    }
  }
  if (patch.typography) {
    const t = patch.typography;
    if (t.heading) d.typography.heading = t.heading;
    if (t.body) d.typography.body = t.body;
    if (t.numeric) d.typography.numeric = t.numeric;
    if (t.scaleFactor) { const f = t.scaleFactor; const s = d.typography.scale; d.typography.scale = { display: Math.round(s.display * f), title: Math.round(s.title * f), headline: Math.round(s.headline * f), body: Math.round(s.body * f), caption: Math.round(s.caption * f), stat: Math.round(s.stat * f), label: Math.round(s.label * f) }; }
    if (t.statFactor) d.typography.scale.stat = Math.round(d.typography.scale.stat * t.statFactor);
  }
  if (patch.density) d.density = patch.density;
  if (patch.titleStyle) d.titleStyle = patch.titleStyle;
  if (patch.imagery) d.imagery = patch.imagery;
  if (patch.motion) d.motion = { ...d.motion, ...patch.motion };
  if (patch.dataLabels) d.dataLabels = { ...d.dataLabels, ...patch.dataLabels };
  if (patch.footer) d.footer = { ...d.footer, ...patch.footer };
  if (patch.video) {
    const { targetDurationSec, ...rest } = patch.video;
    d.video = { ...d.video, ...rest };
    if (targetDurationSec === null) delete d.video.targetDurationSec;
    else if (typeof targetDurationSec === "number") d.video.targetDurationSec = targetDurationSec;
  }
  if (patch.preset === "custom_brand") d.preset = "custom_brand";
  return enforceDesign(d);
}

/** the patch a model answered with, kept to the vocabulary above — anything else is dropped */
export function sanitizeDesignPatch(raw: unknown): DesignPatch {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: DesignPatch = {};
  const hex = (v: unknown) => (typeof v === "string" && parseHex(v) ? toHex(parseHex(v)!) : undefined);
  if (typeof o.preset === "string" && o.preset in PRESETS) out.preset = o.preset as PresetId;
  if (o.colors && typeof o.colors === "object") {
    const c: Partial<DesignColors> = {};
    for (const k of ["primary", "secondary", "accent", "background", "surface", "text", "textMuted", "grid", "tableHeaderBg", "tableHeaderText", "highlight", "positive", "negative"] as const) { const v = hex((o.colors as Record<string, unknown>)[k]); if (v) (c[k] as string) = v; }
    const chart = (o.colors as { chart?: unknown }).chart;
    if (Array.isArray(chart)) { const xs = chart.map(hex).filter((x): x is string => !!x); if (xs.length >= 2) c.chart = xs.slice(0, 8); }
    if (Object.keys(c).length) out.colors = c;
  }
  const fam = (v: unknown) => (typeof v === "string" && ["Inter", "Source Serif 4", "Montserrat"].includes(v) ? v as FontFamilyId : undefined);
  if (o.typography && typeof o.typography === "object") {
    const t = o.typography as Record<string, unknown>; const typo: NonNullable<DesignPatch["typography"]> = {};
    if (fam(t.heading)) typo.heading = fam(t.heading); if (fam(t.body)) typo.body = fam(t.body);
    if (typeof t.scaleFactor === "number" && t.scaleFactor >= 0.8 && t.scaleFactor <= 1.4) typo.scaleFactor = t.scaleFactor;
    if (Object.keys(typo).length) out.typography = typo;
  }
  if (o.density === "airy" || o.density === "balanced" || o.density === "dense") out.density = o.density;
  if (o.mode === "dark" || o.mode === "light") out.mode = o.mode;
  if (o.motion && typeof o.motion === "object") {
    const m = o.motion as Record<string, unknown>; const mm: NonNullable<DesignPatch["motion"]> = {};
    if (["none", "subtle", "standard", "expressive"].includes(m.style as string)) mm.style = m.style as MotionStyle;
    if (["cut", "fade", "slide"].includes(m.transition as string)) mm.transition = m.transition as Transition;
    if (typeof m.speed === "number" && m.speed >= 0.6 && m.speed <= 1.6) mm.speed = m.speed;
    if (Object.keys(mm).length) out.motion = mm;
  }
  if (o.video && typeof o.video === "object") {
    const v = o.video as Record<string, unknown>; const vv: NonNullable<DesignPatch["video"]> = {};
    if (["16:9", "9:16", "1:1"].includes(v.aspect as string)) vv.aspect = v.aspect as AspectRatio;
    if (typeof v.targetDurationSec === "number" && v.targetDurationSec >= 20 && v.targetDurationSec <= 1800) vv.targetDurationSec = Math.round(v.targetDurationSec);
    if (typeof v.narration === "boolean") vv.narration = v.narration;
    if (typeof v.subtitles === "boolean") vv.subtitles = v.subtitles;
    if (Object.keys(vv).length) out.video = vv;
  }
  return out;
}

/** "Corporate Executive · navy/gold on white · Inter · subtle motion · 16:9 1080p" */
export function describeDesign(d: DesignConfig): string {
  return `${d.name} · ${isDark(d.colors.background) ? "dark" : "light"} background · ${d.typography.heading}${d.typography.heading !== d.typography.body ? ` / ${d.typography.body}` : ""} · ${d.motion.style} motion · ${d.video.aspect} ${d.video.height}p${d.video.targetDurationSec ? ` · ~${Math.round(d.video.targetDurationSec / 6) / 10} min` : ""}`;
}

export const DESIGN_PATCH_INSTRUCTIONS = `Read a design request for a research report into a JSON patch. Answer as JSON with only these keys, each optional: {"preset": one of corporate_executive|modern_analytics|premium_editorial|minimal_research|cinematic_data_story|custom_brand, "mode": "dark"|"light", "colors": {"primary","secondary","accent","background","surface","text","highlight": "#RRGGBB", "chart": ["#RRGGBB", …]}, "typography": {"heading","body": "Inter"|"Source Serif 4"|"Montserrat", "scaleFactor": 0.8–1.4}, "density": "airy"|"balanced"|"dense", "motion": {"style": "none"|"subtle"|"standard"|"expressive", "transition": "cut"|"fade"|"slide", "speed": 0.6–1.6}, "video": {"aspect": "16:9"|"9:16"|"1:1", "targetDurationSec": number, "narration": boolean, "subtitles": boolean}}. Include only what the request asks for. Never change data, numbers or wording — this is the look only.`;
