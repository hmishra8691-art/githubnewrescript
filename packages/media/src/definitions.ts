/**
 * PUBLISHED SURVEY VERSIONS IN OBJECT STORAGE (scale readiness step 4, phase A, 2026-11-22).
 *
 * A published version is immutable and averages 849 KB (up to 2.6 MB). At a billion surveys a year that is
 * hundreds of terabytes of `survey_versions.definition` jsonb — more than any Postgres tier holds comfortably. This
 * module puts each version in the object store instead, CONTENT-ADDRESSED:
 *
 *   key   = sha256/<aa>/<bb>/<sha256 of the canonical JSON>.json.gz    in bucket `rescript-definitions`
 *   bytes = gzip(canonical JSON)
 *
 * Canonical JSON (object keys sorted, no whitespace) means the same definition always has the same hash, whatever
 * key order Postgres or the editor produced — so a template used by a million surveys, or a clone, is stored ONCE.
 * Writing is idempotent: an object already there is not written again. Reading verifies the hash, so a corrupted or
 * swapped object is refused rather than served.
 *
 * PHASE A (this file's first use) only COPIES: Postgres keeps the jsonb, `survey_versions.definition_hash` records
 * the copy, and nothing reads from the store yet. Phase B reads from here with Postgres as the fallback; phase C stops
 * writing the jsonb. Web-standard APIs only (crypto.subtle, CompressionStream), so the runtime can use it too.
 */
import type { ObjectStore } from "./objectStore.js";

export const DEFINITIONS_BUCKET = "rescript-definitions";

/** JSON with object keys sorted at every level: one spelling per value */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && (v as object).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

const enc = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as unknown as ArrayBuffer]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function definitionKey(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a sha256 hash: ${hash}`);
  return `sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.json.gz`;
}

export interface StoredDefinition {
  hash: string;
  /** canonical JSON size, uncompressed */
  bytes: number;
  /** size in the store */
  storedBytes: number;
  /** false when an identical definition was already there (deduplicated) */
  written: boolean;
  /** the store's name, recorded so a later read asks the same store */
  store: string;
}

/** The hash a definition would be stored under, without storing it. */
export async function definitionHash(definition: unknown): Promise<{ hash: string; canonical: Uint8Array }> {
  const canonical = enc.encode(canonicalJson(definition));
  return { hash: await sha256Hex(canonical), canonical };
}

/** Store a definition (idempotent). Throws only when the store itself fails. */
export async function storeDefinition(store: ObjectStore, definition: unknown): Promise<StoredDefinition> {
  if (definition === null || typeof definition !== "object") throw new Error("a definition must be an object");
  const { hash, canonical } = await definitionHash(definition);
  const key = definitionKey(hash);
  const there = await store.head(DEFINITIONS_BUCKET, key);
  if (there) return { hash, bytes: canonical.length, storedBytes: there.size, written: false, store: store.name };
  const gz = await pipe(canonical, new CompressionStream("gzip"));
  try {
    const head = await store.put(DEFINITIONS_BUCKET, key, gz, { contentType: "application/gzip" });
    return { hash, bytes: canonical.length, storedBytes: head.size, written: true, store: store.name };
  } catch (e) {
    // another writer stored the same content between our HEAD and PUT: that is success
    const raced = await store.head(DEFINITIONS_BUCKET, key).catch(() => null);
    if (raced) return { hash, bytes: canonical.length, storedBytes: raced.size, written: false, store: store.name };
    throw e;
  }
}

/** Read a definition back, refusing anything whose content does not match its hash. */
export async function readDefinition(store: ObjectStore, hash: string): Promise<unknown> {
  const gz = await store.read(DEFINITIONS_BUCKET, definitionKey(hash));
  const canonical = await pipe(gz, new DecompressionStream("gzip"));
  const got = await sha256Hex(canonical);
  if (got !== hash) throw new Error(`definition ${hash} failed its integrity check (content hashes to ${got})`);
  return JSON.parse(new TextDecoder().decode(canonical));
}
