import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCacheReport, windowOf } from "./aiCacheReport.ts";

/* the admin panel's reader: paged, windowed, the platform's own eval runs optionally left out — the arithmetic is @rescript/billing's (cacheReport.test) */
const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `e${i}`, created_at: new Date(Date.UTC(2026, 9, 17, 10, 0, i)).toISOString(), event_type: "AI_REQUEST", category: "ai", environment: "LIVE",
  provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", input_units: "8000", output_units: "400", provider_cost: "0.02", infra_cost: "0", customer_charge: "0.05",
  metadata: { operation: "copilot_question", tokens: { input: 8000, output: 400, cachedInput: 4000, cacheWrite: 0, uncachedInput: 4000 }, ...extra },
});

test("pages through every row of the window and stops at the last short page", async () => {
  const all = Array.from({ length: 2300 }, (_, i) => row(i % 60));
  const asked: number[] = [];
  const r = await buildCacheReport(async (offset, limit) => { asked.push(offset); return all.slice(offset, offset + limit); }, { days: 7 });
  assert.deepEqual(asked, [0, 1000, 2000]);
  assert.equal(r.totals.calls, 2300); assert.equal(r.truncated, false);
  assert.equal(r.totals.cacheReadTokens, 2300 * 4000);
});

test("a cap on rows says the report is truncated; eval runs can be left out", async () => {
  const all = Array.from({ length: 3000 }, (_, i) => row(i % 60, i % 2 ? { source: "platform_eval" } : {}));
  const capped = await buildCacheReport(async (o, l) => all.slice(o, o + l), { maxRows: 1500 });
  assert.equal(capped.truncated, true); assert.equal(capped.totals.calls, 2000);
  const noEval = await buildCacheReport(async (o, l) => all.slice(o, o + l), { excludeEval: true });
  assert.equal(noEval.totals.calls, 1500);
});

test("the window: days back from now, or explicit bounds; nonsense falls back", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  assert.deepEqual(windowOf({ days: 2 }, now), { since: "2026-10-16T12:00:00.000Z", until: "2026-10-18T12:00:00.000Z" });
  assert.equal(windowOf({ since: "2026-10-17", until: "2026-10-18" }, now).since, "2026-10-17T00:00:00.000Z");
  assert.equal(windowOf({ days: 9999, since: "nope" }, now).since, "2025-10-18T12:00:00.000Z", "at most a year");
});

test("the admin route is platform-admin only and reads with the meter's own rates", () => {
  const src = readFileSync(new URL("../app/api/admin/ai-cache/route.ts", import.meta.url), "utf8");
  assert.match(src, /export async function GET\(req: NextRequest\) \{\n  const admin = await requireAdmin\(req\);/);
  assert.match(src, /meter\.rates\(\), meter\.config\(\)/);
});
