import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memoryFromOps, OpsRecorder, type Send } from "./history.ts";
import { memoryFrom } from "./client.ts";
import { coerceOperation, LIMITS } from "./operations.ts";
import { COPILOT_REPLY_SCHEMA, replyCallOptions } from "./replySchema.ts";

/* AI-05: the conversation survives a reload — the memory and the last exchanges are read back from the server's records */
const rec = (at: string, prompt: string, over: Record<string, unknown> = {}) => ({ createdAt: at, prompt, source: "model" as const, status: "answered" as const, intent: {} as Record<string, string | number | boolean | null>, statusDetail: null as string | null, proposed: [] as { description: string }[], ...over });

test("the memory and the last three exchanges are read back from the records of an earlier page", () => {
  const ops = [
    rec("2026-10-16T09:00:00Z", "make a skincare survey", { status: "proposed", intent: { memory: "Skincare, 18–35, 10 minutes max.", reply: "I propose five blocks." }, proposed: [{ description: "a" }, { description: "b" }] }),
    rec("2026-10-16T09:05:00Z", "which scale did you use?", { statusDetail: "A 5-point scale.", intent: { memory: "Skincare, 18–35, 10 minutes max; 5-point scales." } }),
    rec("2026-10-16T09:06:00Z", "fail", { status: "failed", intent: { memory: "should not be read" } }),
    rec("2026-10-16T09:07:00Z", "grammar thing", { source: "grammar", intent: { memory: "not a model turn" } }),
    rec("2026-10-16T09:08:00Z", "shorter please", { status: "proposed", intent: { reply: "Cut to 3 blocks." }, proposed: [{ description: "x" }] }),
    rec("2026-10-16T08:00:00Z", "oldest exchange", { statusDetail: "ancient" }),
  ];
  const m = memoryFromOps(ops);
  assert.equal(m.memory, "Skincare, 18–35, 10 minutes max; 5-point scales.", "the newest memory of a turn that succeeded");
  assert.deepEqual(m.history.map((h) => h.role), ["user", "copilot", "user", "copilot", "user", "copilot"]);
  assert.equal(m.history[0].text, "make a skincare survey");
  assert.equal(m.history[1].text, "I propose five blocks. [proposed 2 actions]");
  assert.equal(m.history[3].text, "A 5-point scale.");
  assert.equal(m.history[4].text, "shorter please");
  assert.equal(m.history[5].text, "Cut to 3 blocks. [proposed 1 actions]");
  assert.ok(!JSON.stringify(m).includes("oldest"), "only the last three");
  assert.deepEqual(memoryFromOps([]), { history: [] });
});

test("after a reload the first turn is sent the seed; later turns keep the model's own newer memory", () => {
  const seed = { memory: "Agreed: under 10 minutes.", history: [{ role: "user" as const, text: "earlier" }] };
  assert.deepEqual(memoryFrom([], seed), seed, "no turns on the page: the seed is the memory");
  assert.deepEqual(memoryFrom([]), { history: [] });
  const live = memoryFrom([{ user: "next", reply: null }], seed);
  assert.equal(live.memory, "Agreed: under 10 minutes.", "a live turn with no memory of its own keeps the agreed one");
  assert.deepEqual(live.history, [{ role: "user", text: "next" }]);
});

test("the memory travels in the operation's intent (up to 1,000 characters) through the server's coercion", () => {
  const long = "m".repeat(1500);
  const c = coerceOperation({ prompt: "x", source: "model", status: "proposed", intent: { memory: long, reply: "r".repeat(900), mode: "edit" } }, "create");
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal((c.value.intent.memory as string).length, LIMITS.memory);
    assert.equal((c.value.intent.reply as string).length, LIMITS.text);
  }
});

test("the full loop: a record made on one page is listed by the server and seeds the next page's memory", async () => {
  const store: Record<string, unknown>[] = [];
  const send: Send = async (method, body) => {
    if (method === "POST") { const id = `srv_${store.length + 1}`; store.push({ id, surveyId: "s", createdBy: null, createdAt: `2026-10-16T09:0${store.length}:00Z`, updatedAt: "", changeN: null, hasBefore: false, hasAfter: false, applied: [], excluded: [], engineOps: [], savedRevision: null, detected: [], targets: [], failed: [], warnings: [], apiCalls: [], proposed: [], ...body }); return { status: 200, data: { id, durable: true } }; }
    if (method === "GET") return { status: 200, data: { operations: [...store].reverse(), durable: true } };
    return { status: 200, data: { operation: store[0] } };
  };
  const page1 = new OpsRecorder(send);
  const e = page1.create({ prompt: "plan a churn study", source: "model", status: "answered", intent: { memory: "Churn study, telecom, n=800", reply: "Understood." }, statusDetail: "Understood." });
  await page1.settled(e.key);
  // a reload: a new recorder, nothing in memory, the list read from the server
  const page2 = new OpsRecorder(send);
  await page2.refresh();
  const seed = memoryFromOps(page2.list());
  assert.equal(seed.memory, "Churn study, telecom, n=800");
  assert.deepEqual(seed.history.map((h) => h.text), ["plan a churn study", "Understood."]);
  assert.deepEqual(memoryFrom([], seed), seed);
});

/* AI-08: the repair call carries the reply schema, like every other call that asks for the reply */
test("the repair call is built with the reply schema, and so is every completeJson call of the turn route", () => {
  const o = replyCallOptions({ timeoutMs: 1, deadline: 2, continuations: 0, operation: "copilot_edit_repair" });
  assert.equal(o.schema, COPILOT_REPLY_SCHEMA);
  assert.equal(o.operation, "copilot_edit_repair");
  const src = readFileSync(new URL("../../app/api/copilot/turn/route.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/completeJson\(COPILOT_SYSTEM_PROMPT,[\s\S]*?operation: `?"?([a-z_${}]+)/g)].map((m) => ({ text: m[0], op: m[1] }));
  assert.ok(calls.length >= 5, `found ${calls.length} calls`);
  for (const c of calls) assert.ok(/schema: (COPILOT_REPLY_SCHEMA|CHANGE_PLAN_SCHEMA)|replyCallOptions\(/.test(c.text), `${c.op} passes a schema`);
  assert.ok(calls.some((c) => /_repair/.test(c.op) && /replyCallOptions\(/.test(c.text)), "the repair call is among them");
});
