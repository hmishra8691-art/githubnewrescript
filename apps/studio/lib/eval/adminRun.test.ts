import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminCapCeiling, adminRunStore, estimateCase, keptResult, mayRunCase, type AdminRun } from "./adminRun.ts";
import { adminCases } from "./cases.ts";
import type { CaseResult } from "./report.ts";

/* the /platform run: the estimate, the hard cap before every case, the store (database, else memory), sandbox only */
const price = (i: number, o: number) => (i * 3 + o * 15) / 1e6;

test("the estimate counts only turns that may call a model, at the typical size, with headroom", () => {
  const [edit] = adminCases().filter((c) => c.id === "edit-required");
  assert.equal(estimateCase(edit, price), Math.round((9000 * 3 + 1500 * 15) / 1e6 * 1.5 * 1e6) / 1e6);
  const [unsupported] = adminCases().filter((c) => c.id === "scope-unsupported");
  assert.equal(estimateCase(unsupported, price), 0, "answered without a model: free");
  const total = adminCases().reduce((n, c) => n + estimateCase(c, price), 0);
  assert.ok(total > 0 && total < adminCapCeiling({}), `the default subset fits the default $2 ceiling ($${total.toFixed(4)})`);
  assert.equal(adminCapCeiling({ PLATFORM_EVAL_MAX_USD: "50" }), 20, "never above $20");
  assert.equal(adminCapCeiling({ PLATFORM_EVAL_MAX_USD: "0.5" }), 0.5);
});

test("the cap is checked before each case with what is spent plus the case's estimate", () => {
  const run: AdminRun = { id: "r", createdBy: "u", status: "running", provider: "p", model: "m", caseIds: ["a", "b"], capUsd: 0.1, estimateUsd: 0.08, spentUsd: 0.07, results: [], report: null, createdAt: "" };
  assert.deepEqual(mayRunCase(run, "a", 0.02), { ok: true });
  const capped = mayRunCase(run, "a", 0.05);
  assert.equal(capped.ok, false); assert.equal((capped as { capped?: boolean }).capped, true);
  assert.equal(mayRunCase(run, "zzz", 0).ok, false, "only the run's own cases");
  assert.equal(mayRunCase({ ...run, results: [{ id: "a" } as CaseResult] }, "a", 0).ok, false, "never twice");
  assert.equal(mayRunCase({ ...run, status: "finished" }, "b", 0).ok, false);
});

test("without the database the runs are kept in memory; a missing table falls back to memory too", async () => {
  const mem = adminRunStore(null);
  assert.equal(mem.durable, false);
  const r = await mem.create({ createdBy: "u", provider: "p", model: "m", caseIds: ["a"], capUsd: 1, estimateUsd: 0.1 });
  assert.equal((await mem.get(r.id))?.status, "running");
  await mem.save({ ...r, spentUsd: 0.05 });
  assert.equal((await mem.get(r.id))?.spentUsd, 0.05);
  const missing = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "relation \"public.ai_eval_runs\" does not exist" } }) }) }) }) };
  const s = adminRunStore(missing);
  const r2 = await s.create({ createdBy: "u", provider: "p", model: "m", caseIds: ["a"], capUsd: 1, estimateUsd: 0.1 });
  assert.equal(s.durable, false); assert.ok(await s.get(r2.id));
});

test("a kept result has its replies shortened", () => {
  const r = keptResult({ id: "a", turns: [{ reply: "x".repeat(5000), message: "m".repeat(900) }] } as unknown as CaseResult);
  assert.equal(r.turns[0].reply.length, 600); assert.equal(r.turns[0].message.length, 200);
});

test("the admin route: platform administrators only, the sandbox project forced on every turn, the real turn handler", () => {
  const src = readFileSync(new URL("../../app/api/admin/ai-eval/route.ts", import.meta.url), "utf8");
  assert.match(src, /export async function GET\(req: NextRequest\) \{\n  const admin = await requireAdmin\(req\);/);
  assert.match(src, /export async function POST\(req: NextRequest\) \{\n  const admin = await requireAdmin\(req\);/);
  assert.match(src, /surveyId: "sandbox"/);
  assert.match(src, /import \{ POST as turnPOST \} from "@\/app\/api\/copilot\/turn\/route"/);
  assert.match(src, /mayRunCase\(run, c\.id, est\(c\)\)/);
});
