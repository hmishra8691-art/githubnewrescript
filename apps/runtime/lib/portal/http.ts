import { aiConfigured, writeResultSummary } from "@rescript/ai";
import { meteredSessionAi } from "@/lib/metering";
import "server-only";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@rescript/quality/server";
import { limited, type LimitedRoute } from "@/lib/rateLimit";
import { portalSandbox, portalSandboxAvailable } from "./sandbox";
import { supabasePortalStore } from "./supabaseStore";
import { PortalError, authenticate, type PortalContext, type PortalDeps, type SummaryRequest, type RequestMeta } from "./service";

/**
 * THE PORTAL'S HTTP EDGE (phase 1, 2026-11-20): the cookie, the request checks and the error shape, once, for every
 * /api/portal route.
 *
 *   - The session is an httpOnly, SameSite=Lax cookie holding a random token; only its SHA-256 is stored. It is a
 *     browser-session cookie: closing the browser ends it, and the server ends it after thirty idle minutes anyway.
 *   - A request that changes anything must carry `x-rescript-portal: 1` (a header a cross-site form cannot send) and,
 *     when the browser says where it came from, come from this site.
 *   - Every answer is `no-store`: a shared computer's cache must not keep somebody's results.
 *   - Refusals are `{ error, code }` in the respondent's words; anything unexpected is a plain 500 and a server log
 *     line with no personal data in it.
 */
export const PORTAL_COOKIE = "rescript_portal";
const NO_STORE = { "cache-control": "no-store, private", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * The AI re-wording of a person's result sentences (phase 5), under the survey's meter like every other AI call a
 * respondent causes: reserved before, settled after, and refused — which reads as "no summary" — when the
 * project's budget says no. What is sent is in @rescript/ai `writeResultSummary`: the sentences, nothing else.
 */
async function summarise(req: SummaryRequest): Promise<string | null> {
  if (!aiConfigured()) return null;
  const billing = dbConfigured() ? { customerId: req.customerId, surveyId: req.surveyId, environment: "LIVE" as const, sessionId: req.sessionId } : null;
  const out = await meteredSessionAi(billing, { estimateText: req.sentences.join(" "), maxTokens: 260, operation: "portal_result_summary" }, () => writeResultSummary({ sentences: req.sentences, noun: req.noun }));
  return "refused" in out ? null : out.value;
}

export async function portalDeps(): Promise<PortalDeps> {
  if (dbConfigured()) return { store: supabasePortalStore(), now: Date.now, summarise };
  /* no database: the developer sandbox (memory, seeded) — never in production, never beside a database */
  if (portalSandboxAvailable()) return { store: (await portalSandbox()).store, now: Date.now, summarise };
  throw new PortalError(503, "unavailable", "The portal is not available on this installation.");
}

/** "Chrome on Windows" — enough to recognise a device in the session list, nothing that identifies it */
export function deviceLabel(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "a device";
  return `${browser} on ${os}`;
}

export function requestMeta(req: NextRequest): RequestMeta {
  const ip = clientIp(req.headers);
  return { device: deviceLabel(req.headers.get("user-agent")), ipHash: ip ? createHash("sha256").update(`rescript-portal|${ip}`).digest("hex").slice(0, 32) : null };
}

function sameSite(req: NextRequest): boolean {
  if (req.headers.get("x-rescript-portal") !== "1") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0]!.trim().toLowerCase();
    return new URL(origin).host.toLowerCase() === host;
  } catch { return false; }
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export function withSessionCookie(res: NextResponse, token: string | null): NextResponse {
  res.cookies.set(PORTAL_COOKIE, token ?? "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", ...(token ? {} : { maxAge: 0 }) });
  return res;
}

export const sessionToken = (req: NextRequest): string | null => req.cookies.get(PORTAL_COOKIE)?.value ?? null;

export interface RouteOptions { limit?: LimitedRoute; mutate?: boolean }

/** run a portal handler: rate limit, same-site check for changes, errors in one shape */
export async function portalRoute(req: NextRequest, opts: RouteOptions, run: (deps: PortalDeps) => Promise<NextResponse>): Promise<Response> {
  const flood = limited(opts.limit ?? "portal", clientIp(req.headers) ?? "");
  if (flood) return flood;
  if (opts.mutate && !sameSite(req)) return json({ error: "This request could not be verified. Please reload the page and try again.", code: "bad_origin" }, 403);
  try {
    return await run(await portalDeps());
  } catch (e) {
    if (e instanceof PortalError) {
      const res = json({ error: e.message, code: e.code, ...e.extra }, e.status);
      /* a session that has ended takes its cookie with it */
      return e.status === 401 ? withSessionCookie(res, null) : res;
    }
    console.warn("[rescript:portal] request failed", JSON.stringify({ path: req.nextUrl.pathname, error: (e as Error).message?.slice(0, 200) }));
    return json({ error: "Something went wrong. Please try again in a moment.", code: "error" }, 500);
  }
}

/** the signed-in respondent of this request, or a 401 */
export const signedIn = (req: NextRequest, deps: PortalDeps): Promise<PortalContext> => authenticate(deps, sessionToken(req));

export async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const raw = await req.text().catch(() => "");
  if (raw.length > 100_000) throw new PortalError(413, "too_large", "That request is too large.");
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; }
  catch { throw new PortalError(400, "bad_json", "That request could not be read."); }
}
