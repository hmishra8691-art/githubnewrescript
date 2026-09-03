/**
 * Did the schema actually lose anything we sent?
 *
 * The save route needs to warn a programmer when the server's schema does not
 * recognise part of the definition the editor sent, because Zod strips unknown
 * keys and storing the parsed copy would then discard their work while
 * reporting success.
 *
 * The obvious test — `JSON.stringify(parsed) !== JSON.stringify(sent)` — is
 * wrong in three ways, all of which fire in normal use:
 *
 *  1. **Defaults are additions.** Every `.default(...)` in the schema puts a
 *     key into the parsed copy that was never in the input. An editor running
 *     one build behind the server is missing exactly those keys, so every save
 *     it makes reports data loss when the server in fact knows MORE than it
 *     does. (`punches: []` did this the day it was added.)
 *  2. **`JSON.stringify` is key-order sensitive.** Zod rebuilds an object in
 *     schema-declaration order; the editor patches one by spreading, which
 *     appends new keys at the end. So the first mask a programmer builds
 *     puts `mask` in a different position than the schema declares it, and
 *     every subsequent save of that question claims the mask was not stored —
 *     while it is being stored perfectly.
 *  3. It cannot say WHAT was lost, so the warning is unactionable.
 *
 * What we actually care about is one direction only: every scalar the editor
 * sent must still be there, with the same value. Keys the schema ADDED are
 * fine, and order is not information. So this walks the sent value and
 * reports the paths that did not survive.
 *
 * The schema has no `coerce`, `transform`, `preprocess` or `catch` anywhere
 * (checked), so a primitive whose value changed during parsing is a genuine
 * loss and not normalisation. If one is ever added, exempt it here explicitly
 * rather than loosening the comparison.
 */

const MAX_PATHS = 8;
const MAX_DEPTH = 60;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(sent: unknown, stored: unknown, path: string, out: string[], depth: number): void {
  if (out.length >= MAX_PATHS || depth > MAX_DEPTH) return;
  const here = path || "(root)";

  // undefined never survives JSON transport, so it cannot have been "lost"
  if (sent === undefined) return;

  if (Array.isArray(sent)) {
    if (!Array.isArray(stored)) {
      out.push(here);
      return;
    }
    for (let i = 0; i < sent.length; i++) {
      if (i >= stored.length) {
        out.push(`${path}[${i}]`);
        if (out.length >= MAX_PATHS) return;
        continue;
      }
      walk(sent[i], stored[i], `${path}[${i}]`, out, depth + 1);
      if (out.length >= MAX_PATHS) return;
    }
    return;
  }

  if (isPlainObject(sent)) {
    if (!isPlainObject(stored)) {
      out.push(here);
      return;
    }
    for (const key of Object.keys(sent)) {
      const child = path ? `${path}.${key}` : key;
      if (sent[key] === undefined) continue;
      if (!(key in stored)) {
        out.push(child);
        if (out.length >= MAX_PATHS) return;
        continue;
      }
      walk(sent[key], stored[key], child, out, depth + 1);
      if (out.length >= MAX_PATHS) return;
    }
    return;
  }

  // primitive
  if (sent !== stored) out.push(here);
}

/**
 * Paths in `sent` that are missing or changed in `stored`. Empty means the
 * save is lossless — which is the normal case, including when the server's
 * schema is newer than the editor's.
 *
 * Capped at 8 paths: this feeds a one-line warning, not a diff.
 */
export function droppedFieldPaths(sent: unknown, stored: unknown): string[] {
  const out: string[] = [];
  walk(sent, stored, "", out, 0);
  return out;
}

/** True when the schema lost something the editor sent. */
export function hasDroppedFields(sent: unknown, stored: unknown): boolean {
  return droppedFieldPaths(sent, stored).length > 0;
}
