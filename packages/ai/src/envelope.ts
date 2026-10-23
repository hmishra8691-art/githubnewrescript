import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * ENVELOPE ENCRYPTION FOR INTEGRATION SECRETS (2026-10-22, G3) — alert-channel webhook URLs (Slack, Teams, a
 * generic webhook and its signing secret) and panel signing secrets.
 *
 * THE SAME SCHEME AS THE BYOK VAULT (apps/studio/lib/byok/vault.ts), on purpose, and with its own master key:
 *
 *   plaintext ──AES-256-GCM(data key, AAD)──▶ ciphertext
 *   data key (random per secret) ──AES-256-GCM(master key, AAD)──▶ wrapped data key
 *   stored: {v:1, kid, wn, wk, n, c} — the vault's blob, byte-compatible (a test opens one with the vault)
 *
 * The master key is `INTEGRATIONS_SECRET_KEY` (32 bytes, hex or base64), never the BYOK key: the BYOK containment
 * tests keep `AI_CREDENTIAL_KEY` inside the vault, and a leak of one key must not open the other's secrets. Unlike
 * BYOK keys, a panel's signing secret must be opened by the RESPONDENT runtime (it signs the end link), so this
 * lives in a package both apps import. `INTEGRATIONS_SECRET_KEY_PREVIOUS` (comma-separated) still opens what older
 * keys sealed (rotation, as the vault). AAD binds a blob to its row ("notify-channel|<org>|<id>",
 * "panel|<survey>|<key>"): a blob copied to another row fails instead of decrypting.
 *
 * No key, no secret: `sealEnvelope` throws `EnvelopeError("not_configured")` — nothing is ever stored in clear.
 *
 * `deriveKey(purpose)` gives a sub-key for one purpose (HMAC of the master key) — used to authenticate the
 * runtime's alert events to the Studio without a second shared variable.
 */

export class EnvelopeError extends Error {
  code: "not_configured" | "bad_master_key" | "cannot_open" | "malformed";
  constructor(code: EnvelopeError["code"], message: string) { super(message); this.name = "EnvelopeError"; this.code = code; }
}

interface Master { id: string; key: Buffer }
export type EnvLike = Record<string, string | undefined>;

function parseKey(raw: string): Buffer | null {
  const t = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, "hex");
  try { const b = Buffer.from(t, "base64"); return b.length === 32 && b.toString("base64").replace(/=+$/, "") === t.replace(/=+$/, "") ? b : null; } catch { return null; }
}
/* the vault's fingerprint, so a key's id reads the same in both */
const fingerprint = (key: Buffer) => createHash("sha256").update("rescript-vault-key-id\0").update(key).digest("hex").slice(0, 12);

/**
 * The active key and the retired ones. `sandboxKey` (a development sandbox with no database, never production)
 * stands in when the variable is unset, so the same code path runs.
 */
export function envelopeKeys(env: EnvLike = process.env, sandboxKey?: Buffer | null): { active: Master | null; all: Master[]; problem?: string } {
  const raw = (env.INTEGRATIONS_SECRET_KEY ?? "").trim();
  let active: Master | null = null;
  let problem: string | undefined;
  if (raw) { const k = parseKey(raw); if (k) active = { id: fingerprint(k), key: k }; else problem = "INTEGRATIONS_SECRET_KEY must be 32 random bytes, as 64 hex characters or base64."; }
  else if (sandboxKey && sandboxKey.length === 32) active = { id: fingerprint(sandboxKey), key: sandboxKey };
  const all: Master[] = active ? [active] : [];
  for (const part of (env.INTEGRATIONS_SECRET_KEY_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) { const k = parseKey(part); if (k) all.push({ id: fingerprint(k), key: k }); }
  return { active, all, ...(problem ? { problem } : {}) };
}

export function envelopeStatus(env: EnvLike = process.env, sandboxKey?: Buffer | null): { ready: boolean; reason?: string } {
  const m = envelopeKeys(env, sandboxKey);
  return m.active ? { ready: true } : { ready: false, reason: m.problem ?? "Integration secrets cannot be stored on this installation (INTEGRATIONS_SECRET_KEY is not set)." };
}

function gcmSeal(key: Buffer, plain: Buffer, ad: Buffer): { nonce: string; ct: string } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}
function gcmOpen(key: Buffer, nonceB64: string, ctB64: string, ad: Buffer): Buffer {
  const nonce = Buffer.from(nonceB64, "base64"), all = Buffer.from(ctB64, "base64");
  if (nonce.length !== 12 || all.length < 17) throw new EnvelopeError("malformed", "The stored secret is damaged.");
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(ad);
  d.setAuthTag(all.subarray(all.length - 16));
  try { return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]); }
  catch { throw new EnvelopeError("cannot_open", "The stored secret could not be opened."); }
}

interface Sealed { v: 1; kid: string; wn: string; wk: string; n: string; c: string }

/** seal `plain` bound to `aad` (the row it belongs to) */
export function sealEnvelope(plain: string, aad: string, env: EnvLike = process.env, sandboxKey?: Buffer | null): { sealed: string; keyId: string } {
  const { active, problem } = envelopeKeys(env, sandboxKey);
  if (!active) throw new EnvelopeError(problem ? "bad_master_key" : "not_configured", problem ?? "Integration secrets cannot be stored on this installation (INTEGRATIONS_SECRET_KEY is not set).");
  const ad = Buffer.from(aad, "utf8");
  const dataKey = randomBytes(32);
  const body = gcmSeal(dataKey, Buffer.from(plain, "utf8"), ad);
  const w = gcmSeal(active.key, dataKey, ad);
  dataKey.fill(0);
  return { sealed: JSON.stringify({ v: 1, kid: active.id, wn: w.nonce, wk: w.ct, n: body.nonce, c: body.ct } satisfies Sealed), keyId: active.id };
}

/** open a sealed blob for `aad`; throws EnvelopeError for a wrong row, a missing key or tampering */
export function openEnvelope(sealed: string, aad: string, env: EnvLike = process.env, sandboxKey?: Buffer | null): string {
  let blob: Sealed;
  try { blob = JSON.parse(sealed) as Sealed; } catch { throw new EnvelopeError("malformed", "The stored secret is damaged."); }
  if (!blob || blob.v !== 1 || !blob.kid) throw new EnvelopeError("malformed", "The stored secret is damaged.");
  const { all } = envelopeKeys(env, sandboxKey);
  const master = all.find((m) => m.id === blob.kid);
  if (!master) throw new EnvelopeError(all.length ? "cannot_open" : "not_configured", "The key that protects this secret is not available on this server.");
  const ad = Buffer.from(aad, "utf8");
  const dataKey = gcmOpen(master.key, blob.wn, blob.wk, ad);
  try { return gcmOpen(dataKey, blob.n, blob.c, ad).toString("utf8"); } finally { dataKey.fill(0); }
}

/** a purpose-bound sub-key of the master key (null without one) */
export function deriveKey(purpose: string, env: EnvLike = process.env, sandboxKey?: Buffer | null): Buffer | null {
  const { active } = envelopeKeys(env, sandboxKey);
  return active ? createHmac("sha256", active.key).update(`rescript-derive\0${purpose}`).digest() : null;
}

/** what a screen may show of a secret URL: its host and the last four characters of its path */
export function maskSecretUrl(url: string): string {
  try { const u = new URL(url); const tail = (u.pathname + u.search).replace(/\/+$/, "").slice(-4); return `${u.host}/…/••••${tail}`; }
  catch { const s = String(url ?? ""); return s.length <= 8 ? "••••••••" : `••••••••${s.slice(-4)}`; }
}

/* ------------------------------------------------------------ signed requests */

/**
 * A timestamped HMAC-SHA256 signature over a request body, Stripe-style: `t=<unix seconds>,v1=<hex>` where the
 * MAC is over `${t}.${body}`. Used for the generic alert webhook (`X-Rescript-Signature`, keyed by the channel's
 * signing secret — the receiver's example is `verifySignedHeader`) and for the runtime's events to the Studio
 * (keyed by `deriveKey("notify-ingest")`).
 */
export function signedHeader(key: Buffer | string, body: string, nowMs: number = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`, "utf8").digest("hex")}`;
}

/** check a `t=…,v1=…` header: right MAC (constant time), timestamp within `toleranceSec` (replays refused) */
export function verifySignedHeader(key: Buffer | string, header: string | null | undefined, body: string, nowMs: number = Date.now(), toleranceSec = 300): boolean {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=") as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const want = createHmac("sha256", key).update(`${t}.${body}`, "utf8").digest();
  const got = Buffer.from(parts.v1, "hex");
  if (got.length !== want.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want[i] ^ got[i];
  return d === 0;
}
