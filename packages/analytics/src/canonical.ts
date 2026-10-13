/**
 * CANONICAL JSON AND STABLE HASHES.
 *
 * Two values that mean the same thing must hash the same: object keys are
 * sorted at every depth and `undefined` is dropped before hashing, so a
 * definition rebuilt from a form, a plan and a copied row hashes alike. (The
 * old `hashDefinition` hashed `JSON.stringify` of the object as it came, so
 * the same analysis with its keys in another order had another hash — audit
 * S-14.)
 */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}

export const canonicalJson = (v: unknown): string => JSON.stringify(sortKeys(v));

/** FNV-1a, 32 bits, as 8 hex digits */
export function fnv1a(s: string, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** 64 bits as 16 hex digits (two FNV passes with different seeds) — for keys that identify stored results, where 32 bits is too few */
export const hash64 = (s: string): string => fnv1a(s) + fnv1a(s, 0x9747b28c);
