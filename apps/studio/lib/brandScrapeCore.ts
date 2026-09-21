/**
 * URL -> BRAND COLORS, THE PART THAT DOESN'T NEED NEXT.JS.
 *
 * Deliberately no `import "server-only"` here (unlike the API route that
 * calls this module) — this file's only Node built-ins are `node:dns`,
 * `node:http`/`node:https`, which a browser bundle can't resolve anyway, so
 * the guard would add nothing except making this file un-importable from a
 * plain `node --test` run. Keeping it plain is what lets the SSRF guard and
 * the HTML/CSS extraction get exhaustively unit-tested with no server, no
 * browser and no real network — see brandScrapeCore.test.ts.
 *
 * Three layers, in the order a request actually flows:
 *
 *   1. `validateScrapeUrl` / `isPrivateAddress` — is this URL even allowed?
 *      (§7: "validate the URL", SSRF defense)
 *   2. `fetchHtmlSafely` — get its HTML, safely.
 *      (§7: redirects, size caps, timeouts, no credential leakage — there
 *      are none to leak, this module never touches an API key)
 *   3. `analyzeBrandHtml` — pure text-in, colors-out. No network, no DOM.
 *      (§2/§3 of the brief: detect brand colors, prioritizing real brand
 *      signals over incidental ones)
 *
 * The palette itself — turning a handful of seed colors into a full,
 * contrast-checked `Branding.colors` object — is NOT reimplemented here.
 * That's `generatePalette` in `./paletteFromImage.ts`, already shipped and
 * tested for the logo-detection and brand-hex paths; this module's whole
 * job is producing the same kind of seed-color input those paths already
 * feed it, from a URL instead of an image or a typed hex.
 */
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { hexToRgb, rgbToHex, type RGB } from "./paletteFromImage.ts";

/* ============================================================ URL validation */

const MAX_URL_LENGTH = 2048;

export function validateScrapeUrl(input: string): { ok: true; url: URL } | { ok: false; error: string } {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return { ok: false, error: "Enter a website URL first." };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, error: "That URL is too long." };
  let url: URL;
  try {
    /*
     * A bare domain ("example.com") is the common case people actually
     * type, so a string with no scheme at all gets "https://" prepended.
     * The detection has to be "does this have ANY scheme", not
     * specifically "does this have http(s)" — testing for http(s) only
     * meant "ftp://example.com" (no http/https prefix) fell into the
     * bare-domain branch and became "https://ftp://example.com", which
     * `new URL()` accepts without error (the "ftp://..." part just
     * becomes part of the path), so the protocol check two lines down
     * saw "https:" and let it straight through — an ftp:// URL was
     * never actually rejected. Caught by the scheme-rejection test.
     */
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported." };
  }
  if (!url.hostname) return { ok: false, error: "That URL has no host." };
  // credentials-in-URL ("https://user:pass@evil.example") are a phishing/
  // SSRF-adjacent smell with no legitimate use for "here's my brand site"
  if (url.username || url.password) return { ok: false, error: "URLs with embedded credentials aren't supported." };
  return { ok: true, url };
}

/* ============================================================ SSRF defense */

/**
 * Every reserved/private/link-local block a request must never reach,
 * including the cloud-metadata address (169.254.169.254) and IPv4-mapped
 * IPv6 (`::ffff:10.0.0.1`, unwrapped before the v4 check).
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
    if (a >= 224) return true; // multicast (224-239) + reserved (240-255)
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique local fc00::/7
  if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local fe80::/10
  return false;
}

/** DNS-resolve a hostname and refuse if ANY resolved address is private — closes the "public DNS name, private answer" gap a bare hostname check misses. */
async function resolveSafeAddress(hostname: string, isAllowed: (ip: string) => boolean): Promise<string> {
  // a literal IP given as the "hostname" skips DNS but still gets the same check
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (!isAllowed(hostname)) throw new Error("That address isn't reachable from here.");
    return hostname;
  }
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!results.length) throw new Error("That host name doesn't resolve to anything.");
  const safe = results.find((r) => isAllowed(r.address));
  if (!safe) throw new Error("That address isn't reachable from here.");
  return safe.address;
}

/* ============================================================ safe fetching */

export interface FetchedPage { html: string; finalUrl: string }

/**
 * Fetch a URL's HTML, refusing anything that isn't allowed at every hop.
 *
 * Deliberately NOT the global `fetch` — Node's `dns.lookup` and `fetch`'s
 * own connection step happen at different times, and an attacker's DNS
 * record can answer differently between them ("DNS rebinding"): the check
 * passes, the connection goes somewhere else. `http.request`/`https.request`
 * accept a `lookup` override, so the address this function already
 * validated is the SAME address the socket connects to — no gap for a
 * second lookup to reintroduce.
 *
 * `isAddressAllowed` defaults to the real SSRF guard (`isPrivateAddress`,
 * inverted) and should only ever be overridden by a test that needs to
 * point this at a local fixture server — never by anything request-
 * controllable, which is why it isn't threaded through from the API route's
 * request body.
 */
export async function fetchHtmlSafely(startUrl: string, opts: {
  isAddressAllowed?: (ip: string) => boolean;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  /** defaults to text/html — a stylesheet fetch passes `/text\/css|octet-stream/i` (or omits the check with `null`) since it isn't fetching a page. */
  allowedContentType?: RegExp | null;
  accept?: string;
} = {}): Promise<FetchedPage> {
  const isAllowed = opts.isAddressAllowed ?? ((ip: string) => !isPrivateAddress(ip));
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const allowedContentType = opts.allowedContentType === undefined ? /text\/html|application\/xhtml/i : opts.allowedContentType;
  const accept = opts.accept ?? "text/html,application/xhtml+xml";

  let current = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = validateScrapeUrl(current);
    if (!validated.ok) throw new Error(validated.error);
    const url = validated.url;
    const address = await resolveSafeAddress(url.hostname, isAllowed);
    const lib = url.protocol === "https:" ? https : http;

    const result = await new Promise<{ status: number; location?: string; body?: string; contentType: string }>((resolve, reject) => {
      const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        // connect to the address we already validated, not whatever a
        // second DNS lookup might answer at connect time
        lookup: (_host, _opts2, cb) => cb(null, address, address.includes(":") ? 6 : 4),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": "Rescript-Survey/1.0 (brand theme import; +https://rescript.example/about-brand-import)",
          accept,
        },
        timeout: timeoutMs,
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain, don't read a redirect's body
          resolve({ status, location: res.headers.location, contentType: "" });
          return;
        }
        const contentType = String(res.headers["content-type"] ?? "");
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`the site responded with ${status}`));
          return;
        }
        if (allowedContentType && !allowedContentType.test(contentType) && contentType) {
          res.resume();
          reject(new Error(`that URL isn't a web page (${contentType.split(";")[0]})`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(); reject(new Error("that page is too large to analyze")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), contentType }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timed out reaching that site")));
      req.on("error", reject);
      req.end();
    });

    if (result.location) {
      if (hop === maxRedirects) throw new Error("too many redirects");
      current = new URL(result.location, url).toString();
      continue;
    }
    return { html: result.body ?? "", finalUrl: url.toString() };
  }
  throw new Error("too many redirects");
}

/* ================================================== pure HTML/CSS analysis */

/** `<style>…</style>` blocks and every inline `style="…"` attribute, concatenated into one text corpus for the color scorer below. No HTML parser — a heuristic feature doesn't need one, and a malformed fragment just contributes fewer matches, never an error. */
export function collectInlineAndBlockCss(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const inline = [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => `[inline]{${m[1]}}`).join("\n");
  return `${blocks}\n${inline}`;
}

/** `<link rel="stylesheet" href="…">`, resolved to absolute URLs, capped. */
export function extractStylesheetLinks(html: string, baseUrl: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?\s*stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(tag);
    const raw = href?.[1] ?? href?.[2];
    if (!raw) continue;
    try { out.push(new URL(raw, baseUrl).toString()); } catch { /* skip an unparseable href */ }
    if (out.length >= max) break;
  }
  return out;
}

/** A `<meta name="theme-color" content="#...">` — an explicit, deliberate "this is our brand color" declaration when a site bothers to set one. The single strongest signal available, so it's checked first and used as-is. */
export function extractMetaThemeColor(html: string): string | null {
  const m = /<meta\b[^>]*name\s*=\s*["']theme-color["'][^>]*>/i.exec(html)
    ?? /<meta\b[^>]*content\s*=\s*["'][^"']*["'][^>]*name\s*=\s*["']theme-color["'][^>]*>/i.exec(html);
  if (!m) return null;
  const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(m[0]);
  const raw = (content?.[1] ?? content?.[2] ?? "").trim();
  return normalizeColor(raw);
}

/** A favicon / apple-touch-icon / og:image / an `<img>` that looks like a logo by its own alt/class/id — best-effort, first plausible match wins. */
export function extractLogoCandidate(html: string, baseUrl: string): string | null {
  const resolve = (raw: string | undefined) => {
    if (!raw) return null;
    try { return new URL(raw, baseUrl).toString(); } catch { return null; }
  };
  const ogImage = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html)
    ?? /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i.exec(html);
  const logoImg = /<img\b[^>]*(?:class|id|alt)\s*=\s*["'][^"']*logo[^"']*["'][^>]*>/i.exec(html);
  const logoSrc = logoImg ? /src\s*=\s*["']([^"']+)["']/i.exec(logoImg[0]) : null;
  const appleTouch = /<link\b[^>]*rel\s*=\s*["']apple-touch-icon[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html);
  const favicon = /<link\b[^>]*rel\s*=\s*["'](?:shortcut )?icon["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html);
  return resolve(ogImage?.[1]) ?? resolve(logoSrc?.[1]) ?? resolve(appleTouch?.[1]) ?? resolve(favicon?.[1]) ?? resolve("/favicon.ico");
}

function normalizeColor(raw: string): string | null {
  const hex = hexToRgb(raw.startsWith("#") ? raw : `#${raw}`);
  if (hex) return rgbToHex(hex);
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (rgb) return rgbToHex({ r: +rgb[1], g: +rgb[2], b: +rgb[3] });
  return null;
}

/**
 * A color's declaration context -> which brand bucket it counts toward and
 * how strongly. A `--brand`/`--primary` CSS CUSTOM PROPERTY is as
 * deliberate a declaration as `theme-color` and scores accordingly; a color
 * on a button/CTA/header/nav/link selector is a real design decision;
 * `color`/`background` with no such context still counts, just weakly — the
 * brief's "prioritize actual brand colors rather than random colors that
 * happen to appear" is implemented as a weight, not a hard include/exclude.
 */
const ROLE_PATTERNS: { role: string; selector: RegExp; weight: number }[] = [
  { role: "primary", selector: /--(?:color-)?(?:brand|primary|theme)\b/i, weight: 100 },
  { role: "secondary", selector: /--(?:color-)?secondary\b/i, weight: 90 },
  { role: "accent", selector: /--(?:color-)?accent\b/i, weight: 90 },
  { role: "primary", selector: /\b(?:btn|button|cta)[a-z-]*(?:primary)?\b/i, weight: 70 },
  { role: "header", selector: /\b(?:header|navbar|nav|masthead)\b/i, weight: 55 },
  /*
   * The block-splitting regex above captures the selector WITHOUT its
   * trailing "{" (`([^{}]+)\{`), so a pattern anchored on "a { " (looking
   * for the brace) never matches the captured selector text — it only
   * ever gets to see "a" with nothing after it. Anchored on end-of-string
   * instead, since that's genuinely where the captured selector ends.
   * Caught by the role-scoring test expecting `a:hover { color: ... }`
   * to score as "link" and getting the low-weight "text" catch-all instead.
   */
  { role: "link", selector: /(?:^|[^a-z])a(?::hover|:visited)?\s*$|\.link\b/i, weight: 45 },
  { role: "background", selector: /\bbody\b|\bbg\b|background(?:-color)?/i, weight: 20 },
  { role: "text", selector: /\bcolor\s*:/i, weight: 10 },
];

interface ColorSignal { hex: string; role: string; weight: number }

/** Scans CSS text rule-by-rule (a light hand-rolled split, not a real parser — good enough for "which selector was this declared under"), scoring every color literal it finds by declaration context. */
export function extractCssColorSignals(cssText: string): ColorSignal[] {
  const signals: ColorSignal[] = [];
  // split into rough "selector { declarations }" blocks
  for (const block of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = block[1];
    const decls = block[2];
    const colorLiterals = [
      ...decls.matchAll(/#[0-9a-f]{3,8}\b/gi),
      ...decls.matchAll(/rgba?\([^)]+\)/gi),
    ].map((m) => m[0]);
    for (const literal of colorLiterals) {
      const hex = normalizeColor(literal);
      if (!hex) continue;
      const match = ROLE_PATTERNS.find((p) => p.selector.test(selector) || p.selector.test(decls));
      signals.push({ hex, role: match?.role ?? "other", weight: match?.weight ?? 5 });
    }
  }
  // inline style="" fragments (collectInlineAndBlockCss wraps them as `[inline]{...}`) fall through the same loop above (selector "[inline]" matches nothing role-specific, so they score as "other" at low weight — exactly right, since an inline style is the weakest brand signal)
  return signals;
}

/** Near-white / near-black / low-saturation / pure-transparent literals aren't brand colors — they're page chrome. Mirrors `dominantColorsFromImage`'s own filter so both extraction paths agree on what counts as "not actually a color decision". */
function isUsableBrandColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  if (l > 0.94 || l < 0.06) return false;
  if (s < 0.12) return false;
  return true;
}

export interface RankedSeed { hex: string; role: string }

/** Signals -> a short, ordered, de-duplicated seed list (closest match to `dominantColorsFromImage`'s clustering: highest-weight first, at least `MIN_DISTANCE` apart in RGB space so "primary" and "secondary" aren't two shades of the same swatch). */
export function rankSeedColors(signals: ColorSignal[], max = 4): RankedSeed[] {
  const usable = signals.filter((s) => isUsableBrandColor(s.hex));
  // aggregate: the same hex declared 40 times in one stylesheet shouldn't
  // out-rank a `--primary` custom property declared once
  const byHex = new Map<string, { role: string; weight: number; count: number }>();
  for (const s of usable) {
    const cur = byHex.get(s.hex);
    if (!cur || s.weight > cur.weight) byHex.set(s.hex, { role: s.role, weight: s.weight, count: (cur?.count ?? 0) + 1 });
    else cur.count++;
  }
  const ranked = [...byHex.entries()]
    .map(([hex, v]) => ({ hex, role: v.role, score: v.weight + Math.min(v.count, 10) }))
    .sort((a, b) => b.score - a.score);

  const chosen: RankedSeed[] = [];
  const MIN_DISTANCE = 40;
  for (const c of ranked) {
    if (chosen.length >= max) break;
    const rgb = hexToRgb(c.hex)!;
    const tooClose = chosen.some((existing) => {
      const e = hexToRgb(existing.hex)!;
      const dr = e.r - rgb.r, dg = e.g - rgb.g, db = e.b - rgb.b;
      return Math.sqrt(dr * dr + dg * dg + db * db) < MIN_DISTANCE;
    });
    if (!tooClose) chosen.push({ hex: c.hex, role: c.role });
  }
  return chosen;
}

/* ==================================================== the pure orchestrator */

export interface BrandAnalysis {
  seeds: RankedSeed[];
  source: "meta" | "css" | "none";
  logoUrl: string | null;
}

/**
 * HTML text (+ any extra CSS already fetched for it, e.g. from linked
 * stylesheets) -> a ranked seed-color list. No network here — the caller
 * (the API route) fetches the page and any stylesheets first, via
 * `fetchHtmlSafely`, and hands the text in.
 */
export function analyzeBrandHtml(html: string, baseUrl: string, extraCss = ""): BrandAnalysis {
  const logoUrl = extractLogoCandidate(html, baseUrl);
  const metaColor = extractMetaThemeColor(html);
  const cssCorpus = `${collectInlineAndBlockCss(html)}\n${extraCss}`;
  const signals = extractCssColorSignals(cssCorpus);
  const cssSeeds = rankSeedColors(signals);

  if (metaColor && isUsableBrandColor(metaColor)) {
    // the meta tag is the single strongest signal: it leads, and CSS-derived
    // colors (excluding a near-duplicate of the meta color) fill in behind it
    const rest = cssSeeds.filter((s) => s.hex.toLowerCase() !== metaColor.toLowerCase()).slice(0, 3);
    return { seeds: [{ hex: metaColor, role: "primary" }, ...rest], source: "meta", logoUrl };
  }
  if (cssSeeds.length) return { seeds: cssSeeds, source: "css", logoUrl };
  return { seeds: [], source: "none", logoUrl };
}

export type { RGB };
