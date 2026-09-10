/**
 * FOLLOW-UP PROBES — the whole path, end to end.
 *
 *   Studio: "ask a follow-up after this answer" on an open end
 *       ↓
 *   Runtime: the page is submitted; a probe is due
 *       ↓
 *   its wording is fixed (rendered here) or written by the provider
 *       ↓
 *   one screen, one question, the flow has not moved
 *       ↓
 *   the answer and the wording land under Q5_PROBE_n / Q5_PROBE_n_Q
 *       ↓
 *   Next continues to exactly where the flow was already going
 *
 * Runs the AI-written case against the FAKE provider (`AI_API_URL=fake:` on
 * the runtime) and the fixed-wording case against nothing at all — the second
 * is the classic conditional follow-up, and it must work with no provider.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

{
  const r = await fetch(`${RUNTIME}/api/session/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "preview", definition: {} }) });
  assert.equal(r.status, 400, `runtime must be started with AI_API_URL=fake: — got ${r.status}`);
}

const base = () => ({
  meta: { id: "sandbox", code: "PRB", title: "Probes", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SCORE", type: "numeric", text: "Score us 0–10", settings: { min: 0, max: 10 } },
    { id: "q5", code: "Q5", variableName: "WHY", type: "long_text", text: "Why that score?" },
    { id: "q6", code: "Q6", variableName: "NEXT", type: "single_select", text: "Anything else?", options: [{ code: 1, label: "No" }, { code: 2, label: "Yes" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q5"] },
    { type: "page", id: "p2", questionIds: ["q6"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

console.log("\nSTUDIO — the probe is configured on the question, in the Properties panel");
await h.loadDef(base());
await h.goTab("Questions");
await h.page.click('[data-qid="q5"]');
await h.page.waitForSelector('[data-testid="psec-head-probe"]');
await h.page.click('[data-testid="psec-head-probe"]');
await h.page.waitForSelector('[data-testid="probe-toggle"]');
await h.page.click('[data-testid="probe-toggle"]');
await h.page.waitForSelector('[data-testid="probe-prompt"]');
let lint = await h.page.$$eval('[data-testid="probe-lint"]', (els) => els.map((e) => e.textContent));
assert.ok(lint.some((t) => /neither a fixed wording nor an instruction/.test(t)), "an empty probe is warned about, in words, right there");
await h.page.fill('[data-testid="probe-instruction"]', "Find out which part of the experience they mean.");
await h.page.fill('[data-testid="probe-max"]', "2");
await h.page.waitForTimeout(300);
lint = await h.page.$$eval('[data-testid="probe-lint"]', (els) => els.map((e) => e.textContent));
assert.equal(lint.length, 0, "with an instruction and AI wording, nothing to warn about");
let def = await h.readDef();
let q5 = def.questions.find((q) => q.id === "q5");
assert.equal(q5.probe.maxProbes, 2);
assert.equal(q5.probe.instruction, "Find out which part of the experience they mean.");
assert.equal(q5.probe.prompt, undefined);
assert.equal(def.flow.length, 3, "the flow is untouched — a probe is not a page");
console.log("  ok   probe stored on Q5 (AI wording, 2 max, instruction); flow unchanged");

// a numeric question offers no probe section
await h.goTab("Questions");
await h.page.click('[data-qid="q1"]');
await h.page.waitForTimeout(200);
assert.ok(!(await h.page.$('[data-testid="psec-head-probe"]')), "a numeric question has no follow-up probe section");
console.log("  ok   only open ends offer a probe");

console.log("\nRUNTIME — AI-written probe: two follow-ups, then the flow continues where it was going");
let pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q1"]' });
await pv.fill('[data-qid="q1"] input', "3");
await pv.fill('[data-qid="q5"] textarea', "Far too expensive for what you get. And the app kept crashing.");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-probe"]');
assert.equal(await pv.getAttribute('[data-testid="rs-probe"]', "data-probe-of"), "q5");
assert.equal(await pv.getAttribute('[data-testid="rs-probe"]', "data-probe-n"), "1");
const bodyText = await pv.evaluate(() => document.body.innerText);
assert.match(bodyText, /You mentioned “Far too expensive for what you get”\. Could you tell me a bit more about that\?/, "the fake writer quoted the first clause");
assert.ok(!(await pv.$('[data-qid="q6"]')), "Q6 (next page) is NOT shown — the flow has not moved");
assert.equal(await pv.evaluate(() => window.__rescriptState.stepIndex), 0, "step index still on page 1");
await pv.fill('[data-testid="rs-probe"] textarea', "The monthly fee doubled.");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-probe"][data-probe-n="2"]');
const body2 = await pv.evaluate(() => document.body.innerText);
assert.match(body2, /Thanks\. Thinking about find out which part of the experience they mean — what else comes to mind\?/, "the second wording used the instruction");
// an optional probe may be skipped
await h.next(pv);
await pv.waitForSelector('[data-qid="q6"]');
assert.equal(await pv.evaluate(() => window.__rescriptState.stepIndex), 1, "now on page 2");
assert.equal(await h.answerOf(pv, "q5"), "Far too expensive for what you get. And the app kept crashing.");
assert.equal(await h.answerOf(pv, "q5__probe_1"), "The monthly fee doubled.");
assert.equal(await h.answerOf(pv, "q5__probe_1_q"), "You mentioned “Far too expensive for what you get”. Could you tell me a bit more about that?");
assert.equal(await h.answerOf(pv, "q5__probe_2"), undefined, "skipped follow-up: no answer…");
assert.match(await h.answerOf(pv, "q5__probe_2_q"), /Thanks\./, "…but the wording that was shown is kept");
console.log("  ok   probe 1 answered, probe 2 shown and skipped, Q6 reached; answers under q5__probe_n, wording under __probe_n_q");

console.log("\nRUNTIME — Back from a probe returns to its page, and the abandoned probe is forgotten");
await pv.close();
pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q1"]' });
await pv.fill('[data-qid="q1"] input', "2");
await pv.fill('[data-qid="q5"] textarea', "Slow delivery.");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-probe"]');
await pv.click('[data-testid="rs-back"]');
await pv.waitForSelector('[data-qid="q5"]');
assert.equal(await pv.inputValue('[data-qid="q5"] textarea'), "Slow delivery.", "the page and its answer are as they were");
assert.equal(await h.answerOf(pv, "q5__probe_1_q"), undefined, "the abandoned probe left nothing behind");
await pv.fill('[data-qid="q5"] textarea', "Slow delivery, and rude driver.");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-probe"]');
assert.match(await pv.evaluate(() => document.body.innerText), /“Slow delivery, and rude driver”/, "re-asked from the edited answer");
console.log("  ok   back → page; probe re-derived from the new answer");
await pv.close();

console.log("\nRUNTIME — fixed wording with `when`: no provider needed, gated by the same Condition tree");
const fixed = base();
fixed.questions[1].probe = {
  maxProbes: 1, minWords: 0, required: true,
  prompt: "You gave us {{Q1}} and said “{answer}”. What one thing would change your mind?",
  when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "lte", value: 6 },
};
await h.loadDef(fixed);
def = await h.readDef();
// the probe route is never called for a fixed wording
pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q1"]' });
const calls = [];
await pv.route("**/api/session/probe", (route) => { calls.push(1); route.continue(); });
await pv.fill('[data-qid="q1"] input', "4");
await pv.fill('[data-qid="q5"] textarea', "meh");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-probe"]');
assert.equal(calls.length, 0, "fixed wording is rendered in the browser; the provider is not asked");
assert.match(await pv.evaluate(() => document.body.innerText), /You gave us 4 and said “meh”\. What one thing would change your mind\?/, "{answer} and {{Q1}} both piped");
// required: Next without an answer is refused
await h.next(pv);
await pv.waitForTimeout(200);
assert.ok(await pv.$('[data-testid="rs-probe"]'), "still on the probe — it is required");
assert.ok(await pv.$(".rs-error-banner"), "…and says so");
await pv.fill('[data-testid="rs-probe"] textarea', "A lower price.");
await h.next(pv);
await pv.waitForSelector('[data-qid="q6"]');
assert.equal(await h.answerOf(pv, "q5__probe_1"), "A lower price.");
await pv.close();

// `when` false → no probe at all
pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q1"]' });
await pv.fill('[data-qid="q1"] input', "9");
await pv.fill('[data-qid="q5"] textarea', "great");
await h.next(pv);
await pv.waitForSelector('[data-qid="q6"]');
assert.equal(await h.answerOf(pv, "q5__probe_1_q"), undefined, "score 9 > 6 → `when` false → straight to page 2");
console.log("  ok   fixed wording piped, required enforced, `when` gates it, provider never called");
await pv.close();

console.log("\nRUNTIME — the inspector says what was asked");
pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q1"]' });
await pv.fill('[data-qid="q1"] input', "1");
await pv.fill('[data-qid="q5"] textarea', "no");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-probe"]');
await pv.click('[data-testid="debug-toggle"]');
await pv.waitForTimeout(300);
assert.match(await pv.evaluate(() => document.body.innerText), /\[probe\] Q5 follow-up 1: "You gave us 1 and said “no”/, "trace line names question, number and wording");
console.log("  ok   [probe] trace line present");
await pv.close();

await h.close();
console.log("\nALL PROBE CHECKS PASSED");
