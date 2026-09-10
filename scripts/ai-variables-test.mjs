/**
 * AI-DERIVED VARIABLES — the whole path, end to end.
 *
 *   Studio: a calculated question whose expression is ai_classify(...)
 *       ↓
 *   Runtime: the page with the open end is submitted
 *       ↓
 *   /api/session/ai resolves it BEFORE the flow advances (the List Fill slot)
 *       ↓
 *   the classification is an ordinary answer under its own variable
 *       ↓
 *   display logic on the NEXT page reads it
 *       ↓
 *   the browser's own recomputation never erases it
 *
 * Runs against the FAKE provider (`AI_API_URL=fake:` on the runtime), which is
 * deterministic and keyless — the point is to prove the plumbing, not the
 * model. Preview is allowed to resolve only against that provider, which is
 * what lets this suite run without a database or a session.
 *
 * Requires the runtime dev server to have been started with AI_API_URL=fake:.
 * If it was not, the first runtime check fails with a message saying so.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

/* is the runtime on the fake provider? ask it directly, so a wrong env fails loudly and early */
{
  const r = await fetch(`${RUNTIME}/api/session/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "preview", definition: {} }) });
  const j = await r.json().catch(() => ({}));
  assert.equal(r.status, 400, `runtime must be started with AI_API_URL=fake: — got ${r.status} ${JSON.stringify(j)}`);
  assert.match(j.error ?? "", /needs the definition/, "…and reach the preview branch");
}

console.log("\nSTUDIO — an AI classification is an ordinary calculated question");
const def = {
  meta: { id: "sandbox", code: "AIX", title: "AI variables", version: "1.0" },
  questions: [
    { id: "q5", code: "Q5", variableName: "WHY", type: "long_text", text: "Why did you rate us that way?" },
    { id: "qcat", code: "Q5_CAT", variableName: "Q5_CAT", type: "calculated", text: "", settings: { expression: 'ai_classify(Q5, "Price|Product quality|Customer service|Other")' } },
    { id: "qsent", code: "Q5_SENT", variableName: "Q5_SENT", type: "calculated", text: "", settings: { expression: "ai_sentiment(Q5)" } },
    { id: "qflag", code: "Q5_NEG", variableName: "Q5_NEG", type: "calculated", text: "", settings: { expression: 'if(Q5_SENT = "negative", 1, 0)' } },
    {
      id: "q6", code: "Q6", variableName: "Q6", type: "single_select", text: "You mentioned price — which of these applies?",
      options: [{ code: 1, label: "Too high" }, { code: 2, label: "Hidden fees" }],
      displayLogic: { type: "rule", source: { kind: "question", ref: "Q5_CAT" }, operator: "eq", value: "Price" },
    },
    { id: "q7", code: "Q7", variableName: "Q7", type: "single_select", text: "Anything else?", options: [{ code: 1, label: "No" }, { code: 2, label: "Yes" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q5"] },
    { type: "page", id: "p2", questionIds: ["q6", "q7"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};
await h.loadDef(def);
const stored = await h.readDef();
assert.equal(stored.questions.find((q) => q.id === "qcat").settings.expression, 'ai_classify(Q5, "Price|Product quality|Customer service|Other")');
console.log("  ok   the expression is stored on a calculated question, nothing else added to the definition");

console.log("\nSTUDIO — lint refuses a nested AI call and names the fix");
await h.page.click(".leftnav >> text=Calculations");
await h.page.waitForTimeout(400);
const lintText = await h.page.evaluate(() => document.body.innerText);
assert.ok(!/must be the whole expression/.test(lintText), "the well-formed definition lints clean");
const bad = JSON.parse(JSON.stringify(def));
bad.questions.find((q) => q.id === "qflag").settings.expression = 'if(ai_sentiment(Q5) = "negative", 1, 0)';
await h.loadDef(bad);
await h.page.click(".leftnav >> text=Calculations");
await h.page.waitForTimeout(400);
const lintBad = await h.page.evaluate(() => document.body.innerText);
assert.match(lintBad, /must be the whole expression/, "the nested form is reported");
assert.match(lintBad, /own calculated question/, "…with the remedy");
console.log("  ok   nested ai_sentiment() inside if() is refused with the remedy stated");
await h.loadDef(def);

console.log("\nRUNTIME — the classification arrives before the next page, and its display logic reads it");
let pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q5"]' });
await pv.fill('[data-qid="q5"] textarea', "Far too expensive — the price is absurd for what you get, and it was slow to arrive.");
await h.next(pv);
await pv.waitForSelector('[data-qid="q7"]');
assert.ok(await pv.$('[data-qid="q6"]'), "Q6 is shown: its display logic Q5_CAT = \"Price\" held, so the value existed BEFORE the page was built");
assert.equal(await h.answerOf(pv, "qcat"), "Price", "Q5_CAT is a plain answer under the calculated question's id");
assert.equal(await h.answerOf(pv, "qsent"), "negative", "Q5_SENT too");
assert.equal(await h.answerOf(pv, "qflag"), 1, "and the ordinary calculation that READS Q5_SENT composed on it in the browser");
console.log("  ok   Q5_CAT=Price, Q5_SENT=negative, Q5_NEG=1; Q6 rendered because the value preceded navigation");

console.log("\nRUNTIME — a different verbatim, a different branch, and nothing is stale");
await pv.close();
pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q5"]' });
await pv.fill('[data-qid="q5"] textarea', "It arrived on a Tuesday. Fine.");
await h.next(pv);
await pv.waitForSelector('[data-qid="q7"]');
assert.ok(!(await pv.$('[data-qid="q6"]')), "Q6 hidden: Q5_CAT is not Price");
assert.equal(await h.answerOf(pv, "qcat"), "Other", "nothing matched → the last category, the programmer's Other");
assert.equal(await h.answerOf(pv, "qsent"), "neutral");
assert.equal(await h.answerOf(pv, "qflag"), 0);
console.log("  ok   Q5_CAT=Other, Q6 hidden, flag 0");

console.log("\nRUNTIME — the browser's recomputation never erases a server-resolved value");
// Q7 is on this page; answering it fires on_change → runCalculations. The AI answers must survive.
await pv.click('[data-qid="q7"] input[value="2"]');
await pv.waitForTimeout(200);
assert.equal(await h.answerOf(pv, "qcat"), "Other", "still there after an unrelated on_change");
assert.equal(await h.answerOf(pv, "qsent"), "neutral");
console.log("  ok   values kept through on_change on the next page");

console.log("\nRUNTIME — going back and resubmitting the SAME text does not re-ask the provider");
const calls = [];
await pv.route("**/api/session/ai", (route) => { calls.push(1); route.continue(); });
await pv.click(".rs-nav .rs-btn.secondary"); // back
await pv.waitForSelector('[data-qid="q5"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="q7"]');
assert.equal(calls.length, 0, "unchanged source text → no second call");
console.log("  ok   unchanged verbatim is not re-classified");

console.log("\nRUNTIME — the inspector says what was decided and from where");
await pv.close();
pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="q5"]' });
await pv.fill('[data-qid="q5"] textarea', "customer service never answered the phone");
await h.next(pv);
await pv.waitForSelector('[data-qid="q7"]');
await pv.click('[data-testid="debug-toggle"]');
await pv.waitForTimeout(300);
const trace = await pv.evaluate(() => document.body.innerText);
assert.match(trace, /\[ai\] Q5_CAT = "Customer service" from Q5/, "the trace line names the variable, the value and the source question");
assert.match(trace, /\[ai\] Q5_SENT = "negative" from Q5/, "…and the sentiment ('never' is in the negative lexicon)");
assert.equal(await h.answerOf(pv, "qcat"), "Customer service");
console.log("  ok   inspector shows [ai] Q5_CAT = \"Customer service\" from Q5");
await pv.close();

await h.close();
console.log("\nALL AI VARIABLE CHECKS PASSED");
