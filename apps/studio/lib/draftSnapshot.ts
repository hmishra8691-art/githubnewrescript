/**
 * R6 — SHOULD THE WORKING DRAFT BE SAVED BEFORE IT IS DESTROYED?
 *
 * Restoring a version clears the survey's draft. That is correct — a draft
 * always wins when the editor loads, so leaving it behind would make
 * "Restore v25" reopen on something that is not v25 — and it is also the
 * silent destruction of unsaved work behind a button. The resolution is to
 * snapshot the draft as a version of its own first.
 *
 * The decision is small enough to be obvious and just subtle enough to get
 * wrong in both directions, which is why it lives here with a test rather
 * than inline in the route:
 *
 *   · snapshot work that exists        — or the restore destroys it
 *   · do NOT snapshot when there is nothing to lose — or every restore
 *     litters the version list with snapshots of the version being restored,
 *     and a list nobody can read is a list nobody checks
 */

/** Deep value equality by canonical JSON — the definitions are plain JSON. */
function sameDefinition(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * JSON with object keys sorted, so two definitions that differ only in the
 * order their keys were serialised in compare equal. Without this a draft
 * that had merely been round-tripped through a different code path would be
 * "different" and snapshot on every restore.
 */
function stable(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.keys(x as Record<string, unknown>).sort().map((k) => [k, walk((x as Record<string, unknown>)[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(walk(v) ?? null);
}

export function shouldSnapshotDraft(draft: unknown, targetDefinition: unknown): boolean {
  if (!draft || typeof draft !== "object") return false;
  if (Array.isArray(draft)) return false;
  /* an empty object is not work */
  if (Object.keys(draft as Record<string, unknown>).length === 0) return false;
  return !sameDefinition(draft, targetDefinition);
}
