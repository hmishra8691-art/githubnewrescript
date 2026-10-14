import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * THE CREDENTIAL VAULT — envelope encryption for users' provider keys.
 *
 *   plaintext key ──AES-256-GCM(data key, AAD)──▶ ciphertext
 *   data key (random, one per credential) ──AES-256-GCM(master key, AAD)──▶ wrapped data key
 *
 * What is stored (`sealed`, a JSON string) is the ciphertext, the wrapped data
 * key, their nonces and the id of the master key that wrapped it. The MASTER
 * KEY lives only in the server's environment (`AI_CREDENTIAL_KEY`), never in
 * the database: a copy of the table without the environment is noise.
 *
 * AAD — "additional authenticated data" — binds a ciphertext to its owner and
 * its row: `user | credential id`. A sealed blob copied into another user's
 * row (or another credential's) fails authentication instead of decrypting.
 *
 * ROTATION. `AI_CREDENTIAL_KEY` is the key new secrets are sealed with;
 * `AI_CREDENTIAL_KEY_PREVIOUS` (comma-separated) are older keys that can
 * still OPEN what they sealed. A key's id is a fingerprint of the key, so
 * nothing needs naming. `rewrap` re-seals the data key under the active key
 * without touching the ciphertext; when no row names an old id, the old key
 * can be dropped.
 *
 * NO MASTER KEY, NO VAULT. Without `AI_CREDENTIAL_KEY` nothing is sealed and
 * nothing is stored — the API says so; it never falls back to storing a key
 * unencrypted. This is KMS-ready: `wrapKey`/`unwrapKey` are the only two
 * operations that touch the master key, so a managed key service replaces
 * those two functions and nothing else.
 *
 * Decryption (`openSecret`) is called from exactly one place — the resolver —
 * and its result is held in memory for one request.
 */

export class VaultError extends Error {
  code: "not_configured" | "bad_master_key" | "cannot_open" | "malformed";
  constructor(code: "not_configured" | "bad_master_key" | "cannot_open" | "malformed", message: string) { super(message); this.name = "VaultError"; this.code = code; }
}

interface Master { id: string; key: Buffer }

function parseKey(raw: string): Buffer | null {
  const t = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, "hex");
  try { const b = Buffer.from(t, "base64"); return b.length === 32 && b.toString("base64").replace(/=+$/, "") === t.replace(/=+$/, "") ? b : null; } catch { return null; }
}
const fingerprint = (key: Buffer) => createHash("sha256").update("rescript-vault-key-id\0").update(key).digest("hex").slice(0, 12);

/** the active key and the retired ones, from the environment (read per call, so a rotation needs no restart of tests) */
export function masterKeys(env: Record<string, string | undefined> = process.env): { active: Master | null; all: Master[]; problem?: string } {
  const raw = (env.AI_CREDENTIAL_KEY ?? "").trim();
  if (!raw) return { active: null, all: [] };
  const key = parseKey(raw);
  if (!key) return { active: null, all: [], problem: "AI_CREDENTIAL_KEY must be 32 random bytes, as 64 hex characters or base64." };
  const active = { id: fingerprint(key), key };
  const all: Master[] = [active];
  for (const part of (env.AI_CREDENTIAL_KEY_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const k = parseKey(part);
    if (k) all.push({ id: fingerprint(k), key: k });
  }
  return { active, all };
}

export function vaultStatus(env: Record<string, string | undefined> = process.env): { ready: boolean; reason?: string } {
  const m = masterKeys(env);
  return m.active ? { ready: true } : { ready: false, reason: m.problem ?? "Saving your own API key is not enabled on this installation (the server has no credential encryption key)." };
}

const aad = (userId: string, credentialId: string) => Buffer.from(`rescript.ai.credential.v1|${userId}|${credentialId}`, "utf8");

function gcmSeal(key: Buffer, plain: Buffer, ad: Buffer): { nonce: string; ct: string } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}
function gcmOpen(key: Buffer, nonceB64: string, ctB64: string, ad: Buffer): Buffer {
  const nonce = Buffer.from(nonceB64, "base64"), all = Buffer.from(ctB64, "base64");
  if (nonce.length !== 12 || all.length < 17) throw new VaultError("malformed", "The stored credential is damaged.");
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(ad);
  d.setAuthTag(all.subarray(all.length - 16));
  try { return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]); }
  catch { throw new VaultError("cannot_open", "The stored credential could not be opened."); }
}

/** the two operations that touch the master key — what a KMS would replace */
function wrapKey(master: Master, dataKey: Buffer, ad: Buffer) { return gcmSeal(master.key, dataKey, ad); }
function unwrapKey(master: Master, nonce: string, wrapped: string, ad: Buffer) { return gcmOpen(master.key, nonce, wrapped, ad); }

interface Sealed { v: 1; kid: string; wn: string; wk: string; n: string; c: string }

/** Seal a secret for one credential row of one user. Returns the blob to store and the id of the master key used. */
export function sealSecret(plain: string, who: { userId: string; credentialId: string }, env: Record<string, string | undefined> = process.env): { sealed: string; keyId: string } {
  const { active, problem } = masterKeys(env);
  if (!active) throw new VaultError(problem ? "bad_master_key" : "not_configured", problem ?? "Saving your own API key is not enabled on this installation.");
  const ad = aad(who.userId, who.credentialId);
  const dataKey = randomBytes(32);
  const body = gcmSeal(dataKey, Buffer.from(plain, "utf8"), ad);
  const w = wrapKey(active, dataKey, ad);
  dataKey.fill(0);
  const blob: Sealed = { v: 1, kid: active.id, wn: w.nonce, wk: w.ct, n: body.nonce, c: body.ct };
  return { sealed: JSON.stringify(blob), keyId: active.id };
}

/** Open a sealed secret. Throws `VaultError` for a wrong owner, a wrong row, a missing master key or tampering. */
export function openSecret(sealed: string, who: { userId: string; credentialId: string }, env: Record<string, string | undefined> = process.env): string {
  let blob: Sealed;
  try { blob = JSON.parse(sealed) as Sealed; } catch { throw new VaultError("malformed", "The stored credential is damaged."); }
  if (!blob || blob.v !== 1 || !blob.kid) throw new VaultError("malformed", "The stored credential is damaged.");
  const { all } = masterKeys(env);
  const master = all.find((m) => m.id === blob.kid);
  if (!master) throw new VaultError(all.length ? "cannot_open" : "not_configured", "The key that protects this credential is not available on this server.");
  const ad = aad(who.userId, who.credentialId);
  const dataKey = unwrapKey(master, blob.wn, blob.wk, ad);
  try { return gcmOpen(dataKey, blob.n, blob.c, ad).toString("utf8"); } finally { dataKey.fill(0); }
}

/** Re-seal the data key under the active master key (key rotation); the secret itself is never decrypted. */
export function rewrap(sealed: string, who: { userId: string; credentialId: string }, env: Record<string, string | undefined> = process.env): { sealed: string; keyId: string } | null {
  const { active, all } = masterKeys(env);
  if (!active) throw new VaultError("not_configured", "No active credential key.");
  const blob = JSON.parse(sealed) as Sealed;
  if (blob.kid === active.id) return null;
  const old = all.find((m) => m.id === blob.kid);
  if (!old) throw new VaultError("cannot_open", "The key that protects this credential is not available on this server.");
  const ad = aad(who.userId, who.credentialId);
  const dataKey = unwrapKey(old, blob.wn, blob.wk, ad);
  try { const w = wrapKey(active, dataKey, ad); return { sealed: JSON.stringify({ ...blob, kid: active.id, wn: w.nonce, wk: w.ct } satisfies Sealed), keyId: active.id }; } finally { dataKey.fill(0); }
}

/** the only part of a key a screen ever shows: a few characters at each end, never enough to use it */
export function maskSecret(plain: string): string {
  const s = plain.trim();
  if (s.length <= 8) return "••••••••";
  const head = /^(sk-ant-|sk-or-|sk-proj-|sk-|gsk_|AIza|xai-)/.exec(s)?.[1] ?? s.slice(0, 2);
  return `${head}••••••••${s.slice(-4)}`;
}
