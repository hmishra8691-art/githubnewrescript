import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * LIVE-SESSION CREDENTIALS, MINTED ON THE SERVER (2026-10-22, G2) — node:crypto only, no SDK.
 *
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
export interface IceConfig { iceServers: IceServer[]; turn: "rest" | "static" | "none"; expiresAt?: string; warning?: string }

const list = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
export const TURN_WARNING = "No TURN relay is configured (WEBRTC_TURN_URLS): people behind strict corporate firewalls or on some mobile networks will not be able to connect.";

export function turnStatus(env: EnvLike): { mode: "rest" | "static" | "none"; urls: number } {
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
  const status = turnStatus(env);
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
