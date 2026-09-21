import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import {
  validateScrapeUrl, fetchHtmlSafely, analyzeBrandHtml, extractStylesheetLinks,
} from "@/lib/brandScrapeCore";

export const dynamic = "force-dynamic";

/**
 * IMPORT A THEME FROM A WEBSITE (Sept 21 follow-up brief).
 *
 *     POST { url }   → { ok, source: "meta"|"css"|"none", seeds: [{hex, role}], logoUrl }
 *                     → { ok: false, error, logoUrl? }   on any failure — never a 500 with
 *                       a stack trace, because "that site couldn't be analyzed" is an
 *                       ordinary, expected outcome (§6: "do not fail the entire
 *                       theme-generation process just because one source can't be
 *                       detected"), not a server error.
 *
 * Gated exactly like `themes`'s POST (`survey.edit`) — this is a Studio
 * authoring tool, not a public endpoint, and reusing that gate means no new
 * auth pattern to reason about. A survey the caller can't edit answers the
 * same 404/403 `themes` would.
 *
 * WHAT THIS ROUTE DOES NOT DO, ON PURPOSE:
 *   - It never returns the page's HTML or CSS to the client — only short,
 *     regex-validated hex-color strings and (at most) one image URL. There
 *     is nothing here for `dangerouslySetInnerHTML` or an XSS payload to
 *     land in, because nothing but colors and a URL crosses the boundary.
 *   - It never calls an external color-scraping API, so there is no
 *     credential of any kind for this route to hold or leak.
 *   - It never runs `generatePalette` itself — that stays client-side,
 *     exactly like the existing logo-detection and brand-hex paths, so this
 *     is one more SOURCE of seed colors feeding the same, already-tested
 *     palette generator, not a second implementation of it.
 *
 * SSRF: the actual guard (DNS-resolve, reject private/reserved ranges,
 * connect to the pinned address, re-validate on every redirect hop) lives in
 * `fetchHtmlSafely` (brandScrapeCore.ts) so it can be unit-tested without a
 * server. This route just calls it with no overrides — the real guard,
 * always on.
 */

const TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_STYLESHEET_BYTES = 300_000;

/** In-memory, per-process: fine for "don't re-scrape the same site twice in a
 *  minute", not a durable cache — there's no existing KV/cache table in this
 *  codebase to reuse (see the module header for why this is intentionally
 *  the simple option, not a gap). */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; result: RouteResult }>();

/** A light, in-memory throttle per customer — this route fetches arbitrary
 *  third-party sites, so it's an easy thing to hammer by accident (or on
 *  purpose) without one. Not a substitute for real rate limiting
 *  infrastructure, which this codebase doesn't have yet (see research); good
 *  enough to stop one workspace's misbehaving client from turning this into
 *  an open scraping proxy. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const rateLog = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateLog.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateLog.set(key, hits);
  return hits.length > RATE_MAX;
}

type RouteResult =
  | { ok: true; source: "meta" | "css" | "none"; seeds: { hex: string; role: string }[]; logoUrl: string | null }
  | { ok: false; error: string; logoUrl?: string | null };

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const rawUrl = typeof body?.url === "string" ? body.url : "";

  const validated = validateScrapeUrl(rawUrl);
  if (!validated.ok) return NextResponse.json({ ok: false, error: validated.error } satisfies RouteResult, { status: 422 });

  const cacheKey = `${gate.user.customerId ?? "?"}:${validated.url.toString()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.result);
  }

  if (rateLimited(gate.user.customerId ?? gate.user.userId)) {
    return NextResponse.json({ ok: false, error: "Too many brand-import requests — try again in a minute." } satisfies RouteResult, { status: 429 });
  }

  const result = await scrape(validated.url.toString());
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, { at: Date.now(), result });

  return NextResponse.json(result); // a failed analysis is 200 + ok:false — an ordinary outcome, not a server error
}

async function scrape(url: string): Promise<RouteResult> {
  let page: { html: string; finalUrl: string };
  try {
    page = await fetchHtmlSafely(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES });
  } catch (e) {
    console.warn("[rescript:brand-scrape] page fetch failed", JSON.stringify({ error: (e as Error).message }));
    return { ok: false, error: friendlyError((e as Error).message) };
  }

  // up to 3 linked stylesheets, each capped and each individually
  // best-effort — one failing (blocked, too big, wrong type) just means
  // less CSS to score, never a failure of the whole request (§6)
  const stylesheetUrls = extractStylesheetLinks(page.html, page.finalUrl, 3);
  const stylesheetTexts = await Promise.all(stylesheetUrls.map(async (href) => {
    try {
      // a stylesheet is just text, not a page — same safe-fetch mechanics
      // (SSRF guard, redirect re-validation, size cap), content-type check
      // loosened since it isn't fetching text/html
      const sheet = await fetchHtmlSafely(href, {
        timeoutMs: TIMEOUT_MS, maxBytes: MAX_STYLESHEET_BYTES,
        allowedContentType: /text\/css|octet-stream/i, accept: "text/css,*/*;q=0.1",
      });
      return sheet.html;
    } catch {
      return ""; // one blocked/oversized/missing stylesheet costs nothing (§6)
    }
  }));

  const analysis = analyzeBrandHtml(page.html, page.finalUrl, stylesheetTexts.join("\n"));

  if (!analysis.seeds.length) {
    return { ok: false, error: "No usable brand colors found in that page's styles.", logoUrl: analysis.logoUrl };
  }
  return { ok: true, source: analysis.source, seeds: analysis.seeds, logoUrl: analysis.logoUrl };
}

function friendlyError(message: string): string {
  if (/isn't reachable|reachable from here/i.test(message)) return "That address can't be reached from here.";
  if (/too large/i.test(message)) return "That page was too large to analyze.";
  if (/timed out/i.test(message)) return "That site took too long to respond.";
  if (/too many redirects/i.test(message)) return "That URL redirects too many times.";
  if (/isn't a web page/i.test(message)) return message;
  if (/responded with/i.test(message)) return `That site ${message}.`;
  return "Couldn't reach that site.";
}
