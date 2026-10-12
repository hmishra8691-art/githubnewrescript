/**
 * JSON.stringify with object keys sorted, so two structurally equal values give
 * the same string. "Unsaved changes" and "Results are out of date" compare
 * strings; Postgres `jsonb` hands keys back in its own order (shorter first),
 * so a plain stringify called a freshly opened, untouched analysis "changed".
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return v;
  });
}
