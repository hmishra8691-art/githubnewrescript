/**
 * A BRAND GUIDELINES PDF → SEED COLOURS AND FONTS (Intelligent Mode IM8, 2026-11-06).
 *
 * Brand books state their colours as text — "Primary blue #0B3D91", "RGB 11 61 145", "HEX: 0B3D91" — and their
 * typefaces as text ("Primary typeface: Montserrat"). This reads the PDF's text (@rescript/import's extractPdfText,
 * no network, no model) for exactly those: hex and RGB colours, the role the words around each one give it, and the
 * named typefaces. What it returns is SEEDS for the same palette generator the website import and the logo use — it
 * never writes a theme. A scanned PDF has no text to read and is said to be.
 */
export interface GuideSeed { hex: string; role: string; context: string }
export interface GuideReading { seeds: GuideSeed[]; fonts: string[]; scanned: boolean }

const ROLE_WORDS: [RegExp, string][] = [[/\bprimary|main|core|hero\b/i, "primary"], [/\bsecondary\b/i, "secondary"], [/\baccent|highlight|call[-\s]?to[-\s]?action|cta\b/i, "accent"], [/\bbackground|neutral|grey|gray|light\b/i, "background"], [/\btext|body|dark|ink\b/i, "text"]];
const FONT_NAMES = ["Montserrat", "Roboto", "Open Sans", "Lato", "Inter", "Source Sans Pro", "Source Sans 3", "Helvetica Neue", "Helvetica", "Arial", "Poppins", "Nunito", "Raleway", "Merriweather", "Playfair Display", "Georgia", "Garamond", "EB Garamond", "Futura", "Gotham", "Proxima Nova", "Avenir", "Frutiger", "Univers", "Gill Sans", "Noto Sans", "Work Sans", "IBM Plex Sans", "DM Sans", "Manrope", "Segoe UI", "Calibri", "Verdana", "Tahoma", "Times New Roman"];

const hex2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");

export function readBrandGuide(pages: string[][]): GuideReading {
  const text = pages.map((p) => p.join(" ")).join("\n");
  const seeds: GuideSeed[] = [];
  const seen = new Set<string>();
  /* every colour mention in reading order; each one's role from the words since the previous mention */
  const hits: { hex: string; at: number; end: number }[] = [];
  for (const m of text.matchAll(/(?:#|\bhex\s*:?\s*#?|\bhtml\s*:?\s*#?)([0-9a-f]{6})\b/gi)) hits.push({ hex: m[1], at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const m of text.matchAll(/\brgb\s*[:(]?\s*(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})\b/gi)) hits.push({ hex: hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3]), at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  hits.sort((a, b) => a.at - b.at);
  let prevEnd = 0;
  for (const h of hits) {
    const hexs = `#${h.hex.toLowerCase()}`;
    const context = text.slice(Math.max(prevEnd, h.at - 60), h.at).replace(/\s+/g, " ").trim();
    prevEnd = h.end;
    if (seen.has(hexs) || hexs === "#ffffff" || hexs === "#000000") continue;
    seen.add(hexs);
    seeds.push({ hex: hexs, role: ROLE_WORDS.find(([re]) => re.test(context))?.[1] ?? "brand", context });
  }
  const fonts = FONT_NAMES.filter((f) => new RegExp(`\\b${f.replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
  /* a longer name wins over its prefix ("Helvetica Neue" over "Helvetica") */
  const kept = fonts.filter((f) => !fonts.some((g) => g !== f && g.startsWith(f)));
  const order = ["primary", "secondary", "accent", "brand", "text", "background"];
  return { seeds: seeds.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)).slice(0, 8), fonts: kept.slice(0, 3), scanned: !text.trim() };
}
