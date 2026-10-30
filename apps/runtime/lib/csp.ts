/**
 * THE RESPONDENT PAGES' CONTENT-SECURITY-POLICY (S0b, audit 2026-10-30 §9).
 *
 * Author code that runs on the respondent's page itself (logic scripts, Custom Components) now passes a static
 * gate, and behaviour scripts run in a sandboxed frame — but a static gate can be outwitted and the frame shares
 * the page's network. The CSP is the backstop for the one thing that matters most: respondent data leaving the
 * page. `connect-src` lists exactly where the runtime's own client code talks to, built from the environment at
 * boot, so `fetch` / XHR / `sendBeacon` / WebSocket / EventSource to anywhere else is blocked by the browser.
 *
 * What the runtime's client code connects to (grep of fetch / WebSocket / EventSource / sendBeacon in
 * apps/runtime and packages/renderer, 2026-10-30):
 *   - its own origin: every /api/session/*, /api/live, /api/ai-interview/*, /api/geocode, /api/group … call;
 *     Next's dev HMR socket (same origin);
 *   - object storage for respondent uploads (signed PUT URLs): R2_ENDPOINT or https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
 *     (and <bucket>.<host> when R2_FORCE_PATH_STYLE=0), or MEDIA_STORAGE_URL for the in-memory store;
 *   - the realtime voice provider: AI_REALTIME_API_URL (the browser posts its SDP offer there);
 *   - live sessions on an SFU: LIVEKIT_URL (signalling, https and wss) — the livekit-client module itself is a
 *     script import from LIVEKIT_CLIENT_URL (script-src, not restricted here);
 *   - SUPABASE_URL (https and wss), listed although the runtime's client does not call it today;
 *   - anything an operator adds: RUNTIME_CSP_CONNECT (space-separated origins).
 * GEOCODE_API_URL is called by the runtime SERVER (/api/geocode), never by the browser, so it is not listed.
 * WebRTC media and TURN/STUN are not governed by connect-src.
 *
 * Enforced: connect-src, form-action 'self', base-uri 'self', object-src 'none'. Not enforced (author images,
 * media from anywhere and Next's inline scripts would break): img-src, media-src, script-src — a parallel
 * Content-Security-Policy-Report-Only carries a stricter version of those to learn from. There is no report
 * endpoint, so no report-uri: violations show in the browser console only. frame-ancestors is not set (the
 * Studio frames the runtime for preview; nothing set it before).
 *
 *   RUNTIME_CSP=enforce   (default) both headers
 *   RUNTIME_CSP=report    the enforce policy is sent as Report-Only too (nothing blocked)
 *   RUNTIME_CSP=off       no CSP headers
 */

export type CspMode = "off" | "report" | "enforce";
type Env = Record<string, string | undefined>;

export function cspMode(env: Env): CspMode {
  const v = (env.RUNTIME_CSP ?? "").trim().toLowerCase();
  return v === "off" || v === "report" ? v : "enforce";
}

/** an origin from a URL-ish value, or null */
function originOf(raw: string | undefined): URL | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return /^(https?|wss?):$/.test(u.protocol) ? u : null;
  } catch { return null; }
}
/** the https and wss (or http and ws) spellings of one origin */
function both(u: URL): string[] {
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  return [`${secure ? "https" : "http"}://${u.host}`, `${secure ? "wss" : "ws"}://${u.host}`];
}
const plain = (u: URL) => `${u.protocol}//${u.host}`;

/** where the runtime's own client code connects (the connect-src list), from the environment */
export function connectSources(env: Env): string[] {
  const out = new Set<string>(["'self'"]);
  const add = (...xs: string[]) => { for (const x of xs) out.add(x); };
  const supa = originOf(env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL);
  if (supa) add(...both(supa));
  const r2 = originOf(env.R2_ENDPOINT ?? (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined));
  if (r2) {
    add(plain(r2));
    if (env.R2_FORCE_PATH_STYLE === "0" && env.R2_BUCKET) add(`${r2.protocol}//${env.R2_BUCKET}.${r2.host}`);
  }
  const mem = originOf(env.MEDIA_STORAGE_URL ?? (env.MEDIA_STORAGE === "memory" ? "http://127.0.0.1:4598" : undefined));
  if (mem) add(plain(mem));
  const rt = originOf(env.AI_REALTIME_API_URL);
  if (rt) add(plain(rt));
  const lk = originOf(env.LIVEKIT_URL);
  if (lk) {
    add(...both(lk));
    // LiveKit Cloud hands the client region hosts under the same domain
    if (/\.livekit\.cloud$/i.test(lk.hostname)) add("https://*.livekit.cloud", "wss://*.livekit.cloud");
  }
  // an operator's additions must spell the scheme (https://…, wss://…): a bare word is not an origin
  for (const x of (env.RUNTIME_CSP_CONNECT ?? "").split(/[\s,]+/)) { if (!/^(https?|wss?):\/\//i.test(x)) continue; const u = originOf(x); if (u) add(plain(u)); }
  return [...out];
}

export interface RuntimeCsp {
  mode: CspMode;
  /** the Content-Security-Policy header value, when enforcing */
  enforce: string | null;
  /** the Content-Security-Policy-Report-Only header value */
  reportOnly: string | null;
}

/** the two policies for respondent pages, from the environment (read once at boot by the middleware) */
export function buildRuntimeCsp(env: Env): RuntimeCsp {
  const mode = cspMode(env);
  if (mode === "off") return { mode, enforce: null, reportOnly: null };
  const connect = connectSources(env);
  const base = [`connect-src ${connect.join(" ")}`, "form-action 'self'", "base-uri 'self'", "object-src 'none'"];
  const enforce = base.join("; ");
  /* stricter, to learn from: what would break if images / media / scripts were limited too */
  const storage = connect.filter((c) => c !== "'self'" && /^https?:/.test(c));
  const strict = [
    ...base,
    `img-src 'self' data: blob: ${storage.join(" ")}`.trim(),
    `media-src 'self' data: blob: ${storage.join(" ")}`.trim(),
    "script-src 'self'",
  ].join("; ");
  return mode === "enforce" ? { mode, enforce, reportOnly: strict } : { mode, enforce: null, reportOnly: enforce };
}
