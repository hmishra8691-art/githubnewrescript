/**
 * READING A LARGE TABLE IN PAGES, SAFELY (audit F-5).
 *
 * Two rules the loaders below used to break:
 *
 *  1. A paged read needs an ORDER that never ties. Ordering by start time alone
 *     lets two responses with the same timestamp trade places between page 3 and
 *     page 4 — one is then read twice and another not at all, and no error says
 *     so. Every paged read orders by its sort key and then by `id`.
 *
 *  2. "Truncated" means there is more to read, not that the limit was reached. A
 *     survey of exactly `max` responses used to be flagged as cut short, putting
 *     a "computed on the first 250,000" warning on a complete result. After a
 *     full read we ask for one more row; only if it exists is the read truncated.
 *
 * No framework imports and no `@/` aliases, so it is tested on its own.
 */
export interface PageResult { data: unknown[] | null; error: { message: string } | null }

/** a query that can be ordered; the database client's builder satisfies this */
export interface Orderable<Q> { order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): Q }

/** `order(key)` then `order("id")` — the pair that never ties */
export function stableOrder<Q extends Orderable<Q>>(q: Q, key: string, ascending = true, nullsFirst?: boolean): Q {
  return q.order(key, nullsFirst === undefined ? { ascending } : { ascending, nullsFirst }).order("id", { ascending });
}

/**
 * Read every row up to `max`, `chunk` at a time. `page(from, to, columns)`
 * returns rows from..to inclusive, in a stable order. Stops on the first short
 * page; after reading exactly `max` rows, peeks one past them.
 */
export async function readAllRows<T>(page: (from: number, to: number, columns: string) => PromiseLike<PageResult>, o: { chunk: number; max: number; columns: string }): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let start = 0; start < o.max; start += o.chunk) {
    const to = Math.min(start + o.chunk, o.max) - 1;
    const { data, error } = await page(start, to, o.columns);
    if (error) throw new Error(error.message);
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < to - start + 1) return { rows, truncated: false };
  }
  const { data, error } = await page(o.max, o.max, "id");
  if (error) throw new Error(error.message);
  return { rows, truncated: (data ?? []).length > 0 };
}
