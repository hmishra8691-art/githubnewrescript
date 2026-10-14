import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

/**
 * SHARE-LINK PASSWORDS (audit R-4).
 *
 * A stored hash is `scrypt$<salt>$<hex>` — memory-hard, salted, compared in
 * constant time. Hashes written before this change are the old single-pass
 * `<salt>$<sha256 hex>`; they still verify (so no link breaks) and are
 * re-hashed on the first correct password (`needsRehash`).
 */

const KEYLEN = 32;
const COST = { N: 16384, r: 8, p: 1 } as const;

const derive = (pw: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(pw.normalize("NFKC"), salt, KEYLEN, COST, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashSharePassword(pw: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  return `scrypt$${salt}$${(await derive(pw, salt)).toString("hex")}`;
}

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export async function verifySharePassword(pw: string, stored: string): Promise<boolean> {
  if (!pw || !stored) return false;
  const parts = stored.split("$");
  if (parts[0] === "scrypt" && parts.length === 3) return same(await derive(pw, parts[1]), Buffer.from(parts[2], "hex"));
  if (parts.length === 2) {
    // legacy: sha-256 of `salt:password`
    const digest = createHash("sha256").update(`${parts[0]}:${pw}`).digest();
    return same(digest, Buffer.from(parts[1], "hex"));
  }
  return false;
}

export const needsRehash = (stored: string) => !stored.startsWith("scrypt$");

/** wrong guesses allowed per share inside the window before the door answers 429 */
export const SHARE_GUESS_LIMIT = 10;
export const SHARE_GUESS_WINDOW_MS = 15 * 60 * 1000;
export const tooManyGuesses = (recentDenied: number) => recentDenied >= SHARE_GUESS_LIMIT;

/** downloads per share per hour — every one is a full PowerPoint or workbook build, and a public link has no other brake (audit R-2) */
export const SHARE_DOWNLOAD_LIMIT = 30;
export const SHARE_DOWNLOAD_WINDOW_MS = 60 * 60 * 1000;
export const tooManyDownloads = (recent: number) => recent >= SHARE_DOWNLOAD_LIMIT;
