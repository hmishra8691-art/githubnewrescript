import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * LIVE-SESSION CREDENTIALS, MINTED ON THE SERVER (2026-10-22, G2) — node:crypto only, no SDK.
 *
 *   iceServersFor  Cloudflare TURN (minted per person through its API) when CLOUDFLARE_TURN_KEY_ID / _API_TOKEN are set,
 *                else `iceServers`.
 *   iceServers   STUN (default Google's public STUN; WEBRTC_STUN_URLS overrides, "none" disables) and TURN from
 *                WEBRTC_TURN_URLS with either static WEBRTC_TURN_USERNAME / WEBRTC_TURN_CREDENTIAL or — better — a
 *                shared secret WEBRTC_TURN_SECRET from which a time-limited credential is minted per person (the
 *                "TURN REST API" scheme coturn implements as `use-auth-secret`: username = "<expiry>:<id>",
 *                credential = base64(HMAC-SHA1(secret, username))). WITHOUT TURN SOME CORPORATE AND MOBILE
 *                NETWORKS WILL FAIL TO CONNECT — the Studio says so.
 *   livekitToken an access token for LiveKit (an HS256 JWT: iss = API key, sub = identity, a `video` grant),
 *                when LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are set.
 *   inviteToken  an invitation link's token, DERIVED from a server secret and the invitation's id + version, so
 *                the Studio can show the link again later while the database keeps only its SHA-256 hash.
 *
 * Server-only (`@rescript/analytics/live/server`). Never logs or returns a secret.
 */

export interface EnvLike { [k: string]: string | undefined }
export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface IceConfig { iceServers: IceServer[]; turn: "cloudflare" | "rest" | "static" | "none"; expiresAt?: string; warning?: string }

const list = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
export const TURN_WARNING = "No TURN relay is configured (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN, or WEBRTC_TURN_URLS): people behind strict corporate firewalls or on some mobile networks will not be able to connect.";

/**
 * CLOUDFLARE TURN (2026-10-23). Cloudflare does not hand out a static username / password: a back end mints
 * short-lived credentials per person with the TURN key's API token —
 *   POST https://rtc.live.cloudflare.com/v1/turn/keys/<CLOUDFLARE_TURN_KEY_ID>/credentials/generate-ice-servers
 *   Authorization: Bearer <CLOUDFLARE_TURN_API_TOKEN>   body {"ttl": seconds}
 * → { iceServers: [{ urls: [...], username, credential }] } (the older …/credentials/generate answers
 * { iceServers: { urls, username, credential } } — both are read). Addresses on port 53 are dropped: browsers block
 * that port, and trying it only delays the connection (Cloudflare's own advice).
 */
export interface CloudflareTurnConfig { keyId: string; apiToken: string; ttl: number }
export function cloudflareTurnConfig(env: EnvLike): CloudflareTurnConfig | null {
  const keyId = (env.CLOUDFLARE_TURN_KEY_ID ?? "").trim(), apiToken = (env.CLOUDFLARE_TURN_API_TOKEN ?? "").trim();
  if (!keyId || !apiToken || !/^[\w-]{8,128}$/.test(keyId)) return null;
  const ttl = Math.max(600, Math.min(86_400, Math.round(Number(env.WEBRTC_TURN_TTL_SECONDS) || 6 * 3600)));
  return { keyId, apiToken, ttl };
}

const notPort53 = (u: string) => !/:53(?:[?/]|$)/.test(u);

/** the ICE servers Cloudflare answered, normalised (string or list urls; one object or a list), port 53 dropped */
export function readCloudflareIce(body: unknown): IceServer[] {
  const raw = (body as { iceServers?: unknown } | null)?.iceServers;
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: IceServer[] = [];
  for (const it of items as Array<{ urls?: unknown; username?: unknown; credential?: unknown }>) {
    const urls = (Array.isArray(it?.urls) ? it.urls : typeof it?.urls === "string" ? [it.urls] : []).filter((u): u is string => typeof u === "string" && /^(?:stuns?|turns?):/i.test(u)).filter(notPort53);
    if (!urls.length) continue;
    out.push({ urls, ...(typeof it.username === "string" ? { username: it.username } : {}), ...(typeof it.credential === "string" ? { credential: it.credential } : {}) });
  }
  return out;
}

/**
 * ICE servers for one person, minting Cloudflare TURN credentials when Cloudflare is configured (it wins over the
 * other TURN settings). If Cloudflare does not answer in time, the configuration falls back to `iceServers` (STUN
 * and any other TURN settings) with a warning — a session never fails to load because of the relay.
 */
export async function iceServersFor(env: EnvLike, opts: { identity: string; now?: number; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<IceConfig> {
  const cf = cloudflareTurnConfig(env);
  if (!cf) return iceServers(env, opts);
  try {
    const f = opts.fetchImpl ?? fetch;
    const r = await f(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cf.keyId)}/credentials/generate-ice-servers`, {
      method: "POST", headers: { authorization: `Bearer ${cf.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: cf.ttl }), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!r.ok) throw new Error(`Cloudflare TURN answered ${r.status}`);
    const servers = readCloudflareIce(await r.json());
    if (!servers.some((s) => s.urls.some((u) => /^turns?:/i.test(u)) && s.username && s.credential)) throw new Error("Cloudflare TURN answered without relay credentials");
    const exp = Math.floor((opts.now ?? Date.now()) / 1000) + cf.ttl;
    return { iceServers: servers, turn: "cloudflare", expiresAt: new Date(exp * 1000).toISOString() };
  } catch (e) {
    const base = iceServers(env, opts);
    const why = `Cloudflare TURN credentials could not be minted (${e instanceof Error ? e.message.slice(0, 120) : "error"})`;
    return { ...base, warning: base.warning ? `${why}. ${base.warning}` : `${why}; using the other connection settings.` };
  }
}

export function turnStatus(env: EnvLike): { mode: "cloudflare" | "rest" | "static" | "none"; urls: number } {
  if (cloudflareTurnConfig(env)) return { mode: "cloudflare", urls: 4 };
  const urls = list(env.WEBRTC_TURN_URLS).filter((u) => /^turns?:/i.test(u));
  if (!urls.length) return { mode: "none", urls: 0 };
  if ((env.WEBRTC_TURN_SECRET ?? "").trim()) return { mode: "rest", urls: urls.length };
  if ((env.WEBRTC_TURN_USERNAME ?? "").trim() && (env.WEBRTC_TURN_CREDENTIAL ?? "").trim()) return { mode: "static", urls: urls.length };
  return { mode: "none", urls: urls.length };
}

/** the TURN REST credential for one identity (coturn `use-auth-secret`) */
export function turnRestCredential(secret: string, identity: string, expiresAtSeconds: number): { username: string; credential: string } {
  const username = `${expiresAtSeconds}:${identity.replace(/[^\w-]/g, "").slice(0, 64) || "user"}`;
  return { username, credential: createHmac("sha1", secret).update(username).digest("base64") };
}

export function iceServers(env: EnvLike, opts: { identity: string; now?: number }): IceConfig {
  const stunRaw = (env.WEBRTC_STUN_URLS ?? "").trim();
  const stun = /^(?:none|off|false|0)$/i.test(stunRaw) ? [] : (list(stunRaw).filter((u) => /^stuns?:/i.test(u)).length ? list(stunRaw).filter((u) => /^stuns?:/i.test(u)) : ["stun:stun.l.google.com:19302"]);
  const out: IceServer[] = stun.length ? [{ urls: stun }] : [];
  const turnUrls = list(env.WEBRTC_TURN_URLS).filter((u) => /^turns?:/i.test(u));
  const status = turnStatus({ ...env, CLOUDFLARE_TURN_KEY_ID: undefined, CLOUDFLARE_TURN_API_TOKEN: undefined });
  if (status.mode === "rest") {
    const ttl = Math.max(600, Math.min(86_400, Math.round(Number(env.WEBRTC_TURN_TTL_SECONDS) || 6 * 3600)));
    const exp = Math.floor((opts.now ?? Date.now()) / 1000) + ttl;
    out.push({ urls: turnUrls, ...turnRestCredential(env.WEBRTC_TURN_SECRET!.trim(), opts.identity, exp) });
    return { iceServers: out, turn: "rest", expiresAt: new Date(exp * 1000).toISOString() };
  }
  if (status.mode === "static") {
    out.push({ urls: turnUrls, username: env.WEBRTC_TURN_USERNAME!.trim(), credential: env.WEBRTC_TURN_CREDENTIAL!.trim() });
    return { iceServers: out, turn: "static" };
  }
  return { iceServers: out, turn: "none", warning: TURN_WARNING };
}

/* ------------------------------------------------------------ JWT (HS256) */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** the payload when the signature and the time window hold; null otherwise */
export function verifyHs256(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const expect = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    if (head.alg !== "HS256") return null;
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof p.exp === "number" && p.exp < nowSeconds) return null;
    if (typeof p.nbf === "number" && p.nbf > nowSeconds + 30) return null;
    return p;
  } catch { return null; }
}

/* ------------------------------------------------------------ LiveKit */

export interface LiveKitConfig { url: string; apiKey: string; apiSecret: string; clientUrl: string | null }
export function livekitConfig(env: EnvLike): LiveKitConfig | null {
  const url = (env.LIVEKIT_URL ?? "").trim(), apiKey = (env.LIVEKIT_API_KEY ?? "").trim(), apiSecret = (env.LIVEKIT_API_SECRET ?? "").trim();
  if (!url || !apiKey || !apiSecret || !/^wss?:\/\//i.test(url)) return null;
  const client = (env.LIVEKIT_CLIENT_URL ?? "").trim();
  return { url, apiKey, apiSecret, clientUrl: /^https:\/\//i.test(client) ? client : null };
}

/**
 * A LiveKit access token (their documented claim set): iss = the API key, sub = the identity, nbf / exp, name,
 * metadata, and the `video` grant { room, roomJoin, canPublish, canSubscribe, canPublishData, hidden }.
 * Observers get canPublish false and hidden true (participants never see them in the SFU either).
 */
export function livekitToken(cfg: Pick<LiveKitConfig, "apiKey" | "apiSecret">, o: { identity: string; name: string; room: string; canPublish: boolean; canSubscribe?: boolean; hidden?: boolean; ttlSeconds?: number; metadata?: string; now?: number }): string {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  return signHs256({
    iss: cfg.apiKey, sub: o.identity, jti: o.identity, nbf: now, exp: now + Math.max(60, Math.min(24 * 3600, o.ttlSeconds ?? 4 * 3600)),
    name: o.name, ...(o.metadata ? { metadata: o.metadata } : {}),
    video: { room: o.room, roomJoin: true, canPublish: o.canPublish, canSubscribe: o.canSubscribe ?? true, canPublishData: true, hidden: !!o.hidden },
  }, cfg.apiSecret);
}

/* ------------------------------------------------------------ links and member tokens */

export const sha256Hex = (t: string) => createHash("sha256").update(t).digest("hex");
export const newMemberToken = () => randomBytes(24).toString("base64url");

/** the secret invitation links are derived from: LIVE_LINK_SECRET, else a key derived from the service-role key */
export function linkSecret(env: EnvLike): string | null {
  const own = (env.LIVE_LINK_SECRET ?? "").trim();
  if (own.length >= 16) return own;
  const svc = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return svc ? createHmac("sha256", svc).update("rescript live-session links v1").digest("hex") : null;
}

/** an invitation's link token: derived, 43 url-safe characters; a new version (a revoked link) gives a new token */
export function inviteToken(secret: string, inviteId: string, version: number): string {
  return createHmac("sha256", secret).update(`live-invite:${inviteId}:${version}`).digest("base64url");
}
