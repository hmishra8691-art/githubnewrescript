import { test } from "node:test";
import assert from "node:assert/strict";
import { readAllRows, stableOrder, type PageResult } from "./rowPaging.ts";

/** a table of `n` rows read through `page`, the way the database serves range() */
function table(n: number, opts: { shuffleTies?: boolean; tied?: boolean } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, started_at: opts.tied ? "2026-10-01T10:00:00Z" : `2026-10-01T10:00:${String(i % 60).padStart(2, "0")}Z` }));
  let calls = 0;
  /* the database makes no promise about rows that tie on the sort key: here it reorders them on every request, as a real planner may */
  const page = (from: number, to: number, _columns: string, secondaryId: boolean): PageResult => {
    calls++;
    const sorted = [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at) || (secondaryId ? a.id.localeCompare(b.id) : (calls % 2 ? 1 : -1) * a.id.localeCompare(b.id)));
    return { data: sorted.slice(from, to + 1), error: null };
  };
  return { rows, page, calls: () => calls };
}

test("a paged read without a tiebreaker can lose and repeat rows; with `id` it reads each row once", async () => {
  const t = table(10, { tied: true });
  const bad = await readAllRows<{ id: string }>(async (f, to, c) => t.page(f, to, c, false), { chunk: 3, max: 100, columns: "id" });
  assert.notEqual(new Set(bad.rows.map((r) => r.id)).size, 10, "the failure this guards against is real: ties come back in a different order per page");
  const good = await readAllRows<{ id: string }>(async (f, to, c) => t.page(f, to, c, true), { chunk: 3, max: 100, columns: "id" });
  assert.equal(good.rows.length, 10);
  assert.equal(new Set(good.rows.map((r) => r.id)).size, 10);
  assert.equal(good.truncated, false);
});

test("truncation means rows were left out: exactly `max` rows is a complete read, one more is not", async () => {
  const exact = table(12);
  const a = await readAllRows<{ id: string }>(async (f, to, c) => exact.page(f, to, c, true), { chunk: 4, max: 12, columns: "id" });
  assert.equal(a.rows.length, 12); assert.equal(a.truncated, false, "a survey of exactly the limit is not cut short");
  const over = table(13);
  const b = await readAllRows<{ id: string }>(async (f, to, c) => over.page(f, to, c, true), { chunk: 4, max: 12, columns: "id" });
  assert.equal(b.rows.length, 12); assert.equal(b.truncated, true);
  const way = table(40);
  const c = await readAllRows<{ id: string }>(async (f, to, cols) => way.page(f, to, cols, true), { chunk: 5, max: 12, columns: "id" });
  assert.equal(c.rows.length, 12); assert.equal(c.truncated, true);
  assert.deepEqual(c.rows.map((r) => r.id), way.rows.slice(0, 12).map((r) => r.id).sort(), "the first 12 in order — never a partial chunk past the limit");
});

test("the read stops at the first short page, asks for no more than it needs, and reports a database error", async () => {
  const t = table(7);
  const r = await readAllRows<{ id: string }>(async (f, to, c) => t.page(f, to, c, true), { chunk: 3, max: 1000, columns: "id" });
  assert.equal(r.rows.length, 7); assert.equal(t.calls(), 3, "pages of 3, 3, 1 — then it stops");
  const empty = await readAllRows<{ id: string }>(async () => ({ data: null, error: null }), { chunk: 3, max: 9, columns: "id" });
  assert.deepEqual(empty, { rows: [], truncated: false });
  await assert.rejects(readAllRows(async () => ({ data: null, error: { message: "boom" } }), { chunk: 3, max: 9, columns: "id" }), /boom/);
  /* a chunk that does not divide the limit never reads past it */
  const odd = table(30);
  const o = await readAllRows<{ id: string }>(async (f, to, c) => odd.page(f, to, c, true), { chunk: 4, max: 10, columns: "id" });
  assert.equal(o.rows.length, 10); assert.equal(o.truncated, true);
});

test("stableOrder orders by the key, then by id in the same direction", () => {
  const calls: unknown[][] = [];
  const q = { order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) { calls.push([column, options]); return q; } };
  stableOrder(q, "started_at");
  stableOrder(q, "completed_at", false, false);
  assert.deepEqual(calls, [["started_at", { ascending: true }], ["id", { ascending: true }], ["completed_at", { ascending: false, nullsFirst: false }], ["id", { ascending: false }]]);
});
