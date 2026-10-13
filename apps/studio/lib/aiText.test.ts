import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeDb as FakeDbBase } from "../../../scripts/lib/fakeSupabase.mjs";
import { claimsFromRun, claimsHash, promptVersion, NARRATIVE_INSTRUCTIONS, INTERPRETATION_INSTRUCTIONS, redactRunForModel, type Finding } from "@rescript/analytics";
import { keepReply, recordAiRefused, recordAiText, replyFromCache, replyKey, setAiAuditor } from "./aiText.ts";
import { clearResultMemo } from "./resultCache.ts";

/*
 * A-6 — what a model wrote is recorded (model, prompt version, claims, what the checker did, what was withheld), and a
 * request that is the same is not paid for twice: the reply is kept under the claims it was shown and the prompt's
 * version, so a changed claim or a changed prompt is a different key and never a stale sentence.
 */
class FakeDb extends FakeDbBase { as(): SupabaseClient { return this as unknown as SupabaseClient; } }
const S = "11111111-1111-4111-8111-111111111111";
const f = (id: string, headline: string, a: number, b: number): Finding => ({ id, kind: "difference", strength: "moderate", significant: true, headline, evidence: { n: 400, p: 0.01, groups: [{ label: "Women", mean: a, n: 200 }, { label: "Men", mean: b, n: 200 }] }, variables: ["SAT"], hypotheses: [], analysis: { name: id, kind: "test", hash: id } });
const run = (a: number) => ({ n: 400, findings: [f("f1", `Women ${a} vs men 3.07`, a, 3.07)], verdicts: [], warnings: [] });

test("the key is the claims, the prompt's version and the model — change any and it is another key", () => {
  const pv = promptVersion(NARRATIVE_INSTRUCTIONS);
  const k = (r: ReturnType<typeof run>, p = pv, model = "m") => replyKey({ op: "narrative", pv: p, model, claims: claimsHash(claimsFromRun(r)) });
  assert.equal(k(run(3.86)), k(run(3.86)));
  assert.notEqual(k(run(3.86)), k(run(3.9)), "other numbers");
  assert.notEqual(k(run(3.86)), k(run(3.86), promptVersion(INTERPRETATION_INSTRUCTIONS)), "another prompt");
  assert.notEqual(k(run(3.86)), k(run(3.86), pv, "m2"), "another model");
  assert.match(k(run(3.86)), /^ai_[0-9a-f]+$/);
});

test("a reply kept is served again — from memory, and after a restart from the table — and a sandbox or a missing database keeps nothing", async () => {
  clearResultMemo();
  const db = new FakeDb();
  const key = replyKey({ x: 1 });
  assert.equal(await replyFromCache(db.as(), S, key), null);
  await keepReply(db.as(), S, key, { headline: { claims: ["C1"], text: "Women score higher." } });
  assert.deepEqual(await replyFromCache(db.as(), S, key), { headline: { claims: ["C1"], text: "Women score higher." } });
  clearResultMemo();
  assert.deepEqual(await replyFromCache(db.as(), S, key), { headline: { claims: ["C1"], text: "Women score higher." } }, "after a restart");
  assert.equal(await replyFromCache(db.as(), "22222222-2222-4222-8222-222222222222", key), null, "another project's reply is not served");
  assert.equal(await replyFromCache(undefined, S, key), null);
  await keepReply(db.as(), "sandbox", key, { a: 1 }); assert.equal(await replyFromCache(db.as(), "sandbox", key), null);
  await keepReply(db.as(), S, replyKey({ x: 2 }), null); assert.equal(await replyFromCache(db.as(), S, replyKey({ x: 2 })), null, "nothing is kept for a reply that was nothing");
});

test("every generated text leaves a record: model, prompt version, claims, the checker's result and what was withheld — and no sentence text", async () => {
  const seen: { action: string; surveyId: string | null; detail: Record<string, unknown> }[] = [];
  setAiAuditor(async (a) => { seen.push({ action: a.action, surveyId: a.surveyId, detail: a.detail }); });
  try {
    const red = redactRunForModel({ ...run(3.86), findings: [...run(3.86).findings, { ...f("f2", "West (1.7, n = 1)", 1.7, 3), evidence: { n: 1, p: 0.5, groups: [{ label: "West", mean: 1.7, n: 1 }] } } as Finding] });
    const claims = claimsFromRun(red.run);
    await recordAiText({ userId: "u1", surveyId: S }, { operation: "copilot_narrative", model: "m", promptVersion: promptVersion(NARRATIVE_INSTRUCTIONS), claimsHash: claimsHash(claims), claims: ["C1"], offered: 5, kept: 3, replaced: 1, rejected: [{ reason: "the number 4.2 is not in the cited claim" }], withheld: red.withheld, cached: false, charge: 0.02 });
    await recordAiRefused({ userId: "u1", surveyId: S }, "analytics_ask", "project_internal");
    await recordAiText({ userId: "u1", surveyId: "sandbox" }, { operation: "x", model: "m", promptVersion: "p", claimsHash: "h", claims: [], offered: 0, kept: 0, replaced: 0, rejected: [], withheld: [], cached: false, charge: 0 });
    assert.equal(seen.length, 2, "the sandbox has no project to record against");
    assert.deepEqual(seen.map((s) => s.action), ["analytics.ai_text_generated", "analytics.ai_refused"]);
    const d = seen[0].detail;
    assert.deepEqual([d.operation, d.model, d.offered, d.kept, d.replaced, d.cached], ["copilot_narrative", "m", 5, 3, 1, false]);
    assert.match(String(d.promptVersion), /^p_[0-9a-f]{10}$/);
    assert.deepEqual(d.claims, ["C1"]);
    assert.deepEqual((d.withheld as { reason: string }[]).map((w) => w.reason), ["small_group"]);
    assert.ok(!JSON.stringify(d).includes("Women score"), "the record names claims and reasons, not respondent-derived text");
    assert.deepEqual(seen[1].detail, { operation: "analytics_ask", why: "project_internal" });
  } finally { setAiAuditor(null); }
});

test("a failing auditor never fails the action it describes", async () => {
  setAiAuditor(async () => { throw new Error("audit table gone"); });
  try { await recordAiRefused({ userId: null, surveyId: S }, "analytics_ask", "feature_off"); } finally { setAiAuditor(null); }
});
