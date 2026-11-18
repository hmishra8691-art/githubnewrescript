/**
 * OBSERVABILITY (audit 2026-11-17, P1-13): one error report, one structured log line, one alert path, one health
 * shape — shared by the Studio, the runtime and the Interviews app.
 *
 *   reportError(err, ctx)     a structured `[rescript:error]` line on stderr, always; and, when ERROR_WEBHOOK_URL is
 *                             set, a POST to it (Slack-compatible `text` plus the JSON fields). The same failure is
 *                             sent at most once a minute per fingerprint, so a crash loop is one alert, not a flood.
 *                             Every report has an incident id the user can quote; the response carries it.
 *   observed(handler, ctx)    wraps a route handler: a thrown error becomes a reported 500 with the incident id,
 *                             instead of Next's bare 500 and a stack only in the server console.
 *   runHealth(checks)         named checks with a timeout each → ok / degraded / down, for /api/health.
 *
 * What a report never carries: request bodies, cookies, headers, query strings, or anything that looks like an email
 * address, a bearer token or a key — messages are scrubbed before they leave the process.
 */

type Env = Record<string, string | undefined>;
export interface ErrorContext { app: string; route: string; method?: string; status?: number; /** the customer, when known — an id, never a name */ tenant?: string | null; extra?: Record<string, string | number | boolean | null> }
export interface ErrorReport { incident: string; fingerprint: string; at: string; app: string; route: string; method?: string; status?: number; tenant?: string | null; name: string; message: string; stack?: string; extra?: ErrorContext["extra"]; sent: "webhook" | "deduplicated" | "log-only" }

const SCRUB: [RegExp, string][] = [
  /* query strings first: their values are the likeliest place for a token */
  [/([?&])[^=\s&]+=[^&\s]+/g, "$1…"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b(?:bearer|token|apikey|api_key|secret|password|pw)\b\s*[:=]?\s*\S+/gi, "[secret]"],
  [/\b(?:sk|pk|rk|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g, "[key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[jwt]"],
];
export const scrub = (s: string): string => SCRUB.reduce((t, [re, to]) => t.replace(re, to), s).slice(0, 2000);

/** a stable identity for "the same failure": the app, the route and the first line of the message without numbers */
export const fingerprintOf = (app: string, route: string, err: { name?: string; message?: string }) =>
  `${app}|${route}|${err.name ?? "Error"}|${scrub(String(err.message ?? "")).split("\n")[0].replace(/\d+/g, "#").slice(0, 160)}`;

const recent = new Map<string, number>();
const DEDUPE_MS = 60_000;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<unknown>;

let seq = 0;
const incidentId = (now: number) => `inc_${now.toString(36)}${(seq++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;

/** report a failure; resolves when the alert (if any) was sent or given up on — never throws */
export async function reportError(err: unknown, ctx: ErrorContext, opts: { env?: Env; fetchImpl?: FetchLike; now?: number; timeoutMs?: number } = {}): Promise<ErrorReport> {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const now = opts.now ?? Date.now();
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err ?? null));
  const fingerprint = fingerprintOf(ctx.app, ctx.route, e);
  const base = {
    incident: incidentId(now), fingerprint, at: new Date(now).toISOString(), app: ctx.app, route: ctx.route,
    ...(ctx.method ? { method: ctx.method } : {}), ...(ctx.status ? { status: ctx.status } : {}), ...(ctx.tenant !== undefined ? { tenant: ctx.tenant } : {}),
    name: e.name, message: scrub(e.message), ...(e.stack ? { stack: scrub(e.stack.split("\n").slice(0, 8).join("\n")) } : {}), ...(ctx.extra ? { extra: ctx.extra } : {}),
  };
  const url = (env.ERROR_WEBHOOK_URL ?? "").trim();
  const last = recent.get(fingerprint);
  const dup = last != null && now - last < DEDUPE_MS;
  const report: ErrorReport = { ...base, sent: !url ? "log-only" : dup ? "deduplicated" : "webhook" };
  console.error(`[rescript:error] ${JSON.stringify(report)}`);
  if (!url || dup) return report;
  recent.set(fingerprint, now);
  if (recent.size > 500) for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 4000);
  try {
    const text = `:rotating_light: ${ctx.app} ${ctx.method ?? ""} ${ctx.route} — ${report.name}: ${report.message} (${report.incident})`.replace(/\s+/g, " ");
    await (opts.fetchImpl ?? (fetch as unknown as FetchLike))(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...report, environment: env.RESCRIPT_ENV ?? env.NODE_ENV ?? "unknown", release: env.RESCRIPT_RELEASE ?? env.VERCEL_GIT_COMMIT_SHA ?? null }), signal: ac.signal });
  } catch (x) {
    console.error(`[rescript:error] alert webhook failed: ${scrub(String((x as Error)?.message ?? x))}`);
  } finally { clearTimeout(timer); }
  return report;
}

/** for tests: forget which failures were already sent */
export const resetErrorDedupe = () => recent.clear();

/**
 * Wrap a route handler. A thrown error is reported and answered with a 500 that carries the incident id; a handler
 * that returns normally is untouched. Works with any handler `(req, ctx) => Response | Promise<Response>`.
 */
export function observed<A extends unknown[]>(handler: (...args: A) => Promise<Response> | Response, ctx: { app: string; route: string }, opts: { env?: Env; fetchImpl?: FetchLike } = {}) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      const method = (args[0] as { method?: string } | undefined)?.method;
      const r = await reportError(err, { ...ctx, ...(method ? { method } : {}), status: 500 }, opts);
      return new Response(JSON.stringify({ error: "Something went wrong on our side. It has been reported.", incident: r.incident }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
  };
}

/* ------------------------------------------------------------------- health */

export interface HealthCheck { name: string; critical?: boolean; run: () => Promise<string | void> }
export interface HealthResult { status: "ok" | "degraded" | "down"; at: string; release: string | null; checks: { name: string; ok: boolean; ms: number; critical: boolean; detail?: string }[] }

/** run each check with a timeout; a failed critical check is "down", a failed other one "degraded" */
export async function runHealth(checks: readonly HealthCheck[], opts: { timeoutMs?: number; env?: Env } = {}): Promise<HealthResult> {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const results = await Promise.all(checks.map(async (c) => {
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const detail = await Promise.race([c.run(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${opts.timeoutMs ?? 3000} ms`)), opts.timeoutMs ?? 3000); })]);
      return { name: c.name, ok: true, ms: Date.now() - t0, critical: c.critical !== false, ...(typeof detail === "string" && detail ? { detail: scrub(detail).slice(0, 120) } : {}) };
    } catch (e) {
      return { name: c.name, ok: false, ms: Date.now() - t0, critical: c.critical !== false, detail: scrub(String((e as Error)?.message ?? e)).slice(0, 160) };
    } finally { if (timer) clearTimeout(timer); }
  }));
  const status = results.some((r) => !r.ok && r.critical) ? "down" : results.some((r) => !r.ok) ? "degraded" : "ok";
  return { status, at: new Date().toISOString(), release: env.RESCRIPT_RELEASE ?? env.VERCEL_GIT_COMMIT_SHA ?? null, checks: results };
}
