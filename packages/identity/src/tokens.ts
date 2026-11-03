import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * MATCH TOKENS — how an identifier becomes something this platform can match on without holding it.
 *
 * Every token is `HMAC-SHA256(RTID_MATCH_KEY, kind + ":" + normalised value)`, truncated to 32 hex characters.
 * The raw value is never stored, never logged and never returned; `identity_match_tokens` has no column it
 * could be put in. A token is not reversible and, because the key is per-organisation-deployment rather than
 * global, a token leaked from here cannot be matched against a token from anywhere else.
 *
 * ## Why a separate key from QUALITY_HASH_SALT
 *
 * `qualitySalt(surveyId)` is per SURVEY, which makes a device hash in one study incomparable with one in
 * another. That is a real privacy property and it exists on purpose. Matching people ACROSS projects requires
 * relaxing it, so it is relaxed narrowly: a different key, a different table, a different purpose, and only for
 * organisations that have opted in. The per-survey hashes in `responses` are untouched, a match token is never
 * written to `responses`, and a `responses` hash is never usable as a match token.
 *
 * ## The keyed prefix
 *
 * The kind is inside the HMAC, so the token for the e-mail "x@y.z" and the token for an external id that
 * happens to be the string "x@y.z" are different values. Without it, a vendor whose participant ids look like
 * e-mail addresses would collide with real e-mail tokens and merge two unrelated people.
 */

export const TOKEN_KINDS = ["email", "phone", "external_id", "vendor_pid", "device", "network", "behaviour"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Which kinds may settle an identity on their own, and which may only contribute evidence. */
export const TOKEN_STRENGTH: Readonly<Record<TokenKind, "deterministic" | "probabilistic">> = Object.freeze({
  email: "deterministic",
  phone: "deterministic",
  external_id: "deterministic",
  vendor_pid: "deterministic",
  // a device, a network and a behavioural signature are circumstantial, however strong they feel
  device: "probabilistic",
  network: "probabilistic",
  behaviour: "probabilistic",
});

/** How long a token of each kind stays meaningful. A device moves house; an e-mail address does not. */
export const TOKEN_TTL_DAYS: Readonly<Record<TokenKind, number | null>> = Object.freeze({
  email: null, phone: null, external_id: null, vendor_pid: null,
  device: 180, network: 30, behaviour: 90,
});

export interface MatchToken {
  kind: TokenKind;
  token: string;
  key_id: string;
  strength: "deterministic" | "probabilistic";
  expires_at?: string;
}

export class IdentityKeyError extends Error {
  constructor(message: string) { super(message); this.name = "IdentityKeyError"; }
}

/**
 * The key, and the keys that can still open what they sealed.
 *
 * `RTID_MATCH_KEY` is required: there is deliberately no default and no fallback to the quality salt. A system
 * that silently derived matchable tokens under a guessable key would be worse than one that refused to run,
 * because nobody would find out until the tokens were already written.
 */
export interface KeyRing {
  current: { id: string; key: Buffer };
  previous: { id: string; key: Buffer }[];
}

function keyId(key: Buffer): string {
  return createHmac("sha256", key).update("rtid-key-id").digest("hex").slice(0, 8);
}

function parseKey(raw: string, where: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new IdentityKeyError(`${where} is empty`);
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (buf.length < 32) {
    throw new IdentityKeyError(`${where} must be at least 32 bytes (64 hex characters or base64); got ${buf.length}`);
  }
  return buf;
}

/** Read the key ring from the environment. Throws rather than degrading — see above. */
export function keyRing(env: Record<string, string | undefined> = process.env): KeyRing {
  const raw = env.RTID_MATCH_KEY;
  if (!raw) {
    throw new IdentityKeyError(
      "RTID_MATCH_KEY is not set. Cross-project identity matching derives tokens under its own key, separate " +
      "from QUALITY_HASH_SALT, and will not run without it.",
    );
  }
  const current = parseKey(raw, "RTID_MATCH_KEY");
  const previous = (env.RTID_MATCH_KEY_PREVIOUS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((s, i) => { const key = parseKey(s, `RTID_MATCH_KEY_PREVIOUS[${i}]`); return { id: keyId(key), key }; });
  return { current: { id: keyId(current), key: current }, previous };
}

/* ------------------------------------------------------------ normalisation */

/**
 * Normalise an e-mail address: trim and lower-case, and nothing else.
 *
 * It is tempting to go further — strip dots, drop `+tags` — because Gmail treats those as equivalent. Doing so
 * is wrong everywhere else: plenty of providers deliver `a.b@` and `ab@` to different people, and a `+` is a
 * legal, meaningful character in a local part. Over-normalising MERGES TWO PEOPLE, which in this system means
 * refusing one of them entry and their day's earnings. Under-normalising merely fails to match, which is
 * recoverable. The asymmetry decides it.
 */
export function normaliseEmail(value: string): string | null {
  const s = value.trim().toLowerCase();
  if (!s || s.length > 320) return null;
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  if (!s.slice(at + 1).includes(".")) return null;
  return s;
}

/**
 * Normalise a telephone number to digits with a leading `+` when one was given.
 *
 * No country is inferred. A bare "07700 900123" could be British, and could be a dozen other things; guessing
 * a country code and matching on the guess would merge strangers. A number without an international prefix is
 * normalised as given and will only ever match another written the same way.
 */
export function normalisePhone(value: string): string | null {
  const trimmed = value.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (plus ? "+" : "") + digits;
}

/** Everything else is matched as given, bar whitespace: a vendor's id is opaque and must not be reinterpreted. */
export function normaliseOpaque(value: string): string | null {
  const s = value.trim();
  return s && s.length <= 400 ? s : null;
}

export function normalise(kind: TokenKind, value: string): string | null {
  if (kind === "email") return normaliseEmail(value);
  if (kind === "phone") return normalisePhone(value);
  return normaliseOpaque(value);
}

/* ------------------------------------------------------------ derivation */

/**
 * Derive a match token. Returns null when the value does not normalise, which is a real answer: an unparseable
 * e-mail is not an identity and must not become one by being hashed anyway.
 */
export function matchToken(ring: KeyRing, kind: TokenKind, value: string, now = new Date()): MatchToken | null {
  const normalised = normalise(kind, value);
  if (normalised === null) return null;
  const ttl = TOKEN_TTL_DAYS[kind];
  return {
    kind,
    token: createHmac("sha256", ring.current.key).update(`${kind}:${normalised}`).digest("hex").slice(0, 32),
    key_id: ring.current.id,
    strength: TOKEN_STRENGTH[kind],
    ...(ttl === null ? {} : { expires_at: new Date(now.getTime() + ttl * 86_400_000).toISOString() }),
  };
}

/**
 * Every token this value could be under the current key AND the previous ones.
 *
 * Rotation works by LOOKING UP under every key and WRITING under the current one: an identity written months
 * ago under a retired key is still found, and is re-written under the new one the next time it is seen. Nothing
 * has to be re-derived in bulk and no identity is lost on the day a key changes.
 */
export function matchTokensForLookup(ring: KeyRing, kind: TokenKind, value: string): MatchToken[] {
  const normalised = normalise(kind, value);
  if (normalised === null) return [];
  const strength = TOKEN_STRENGTH[kind];
  return [ring.current, ...ring.previous].map((k) => ({
    kind,
    token: createHmac("sha256", k.key).update(`${kind}:${normalised}`).digest("hex").slice(0, 32),
    key_id: k.id,
    strength,
  }));
}

/** Derive the tokens for a whole arrival, dropping what does not normalise. */
export function tokensForArrival(
  ring: KeyRing,
  signals: Partial<Record<TokenKind, string | null | undefined>>,
  now = new Date(),
): MatchToken[] {
  const out: MatchToken[] = [];
  for (const kind of TOKEN_KINDS) {
    const value = signals[kind];
    if (typeof value !== "string" || !value) continue;
    const t = matchToken(ring, kind, value, now);
    if (t) out.push(t);
  }
  return out;
}

/** Constant-time comparison, for the rare path that compares two tokens directly. */
export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
