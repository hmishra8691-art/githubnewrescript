import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { interpretRequest } from "./nlIntent.js";

/*
 * S2a item 6 (2026-10-30): the owner's deterministic sentences read WITHOUT A MODEL — each recogniser narrow, tested
 * on paraphrases in English and Devanagari Hindi (the productionIntents corpus pattern), with negatives.
 */
const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", ref: "A", type: "single", text: "Satisfied?", options: ["1", "2", "3", "4", "5"] },
    { op: "create_question", ref: "B", type: "multi", text: "Used?", options: ["a", "b", "c", "d", "e", "f"] },
    { op: "create_question", ref: "C", type: "single", text: "Concepts", options: ["Concept A", "Concept B", "Concept C", "Concept D"] },
    { op: "create_question", ref: "D", type: "numeric", text: "Count" },
  ] as SurveyAction[]);
  assert.ok(r.valid, r.errors.join("; "));
  return r.def;
})();
const id = (code: string) => def.questions.find((q) => q.code === code)!.id;
const ops = (s: string, sel?: string) => { const i = interpretRequest(def, s, sel ? { selectedId: id(sel) } : {}); return i.kind === "actions" ? i.actions : i; };

test("#2 punch option N when option M is selected → add_punch (selected question or “of Qx”), English and Hindi", () => {
  const cases: [string, string | undefined][] = [
    ["Automatically punch Option 5 when Option 2 is selected", "Q2"],
    ["Auto-punch option 5 if option 2 is chosen", "Q2"],
    ["Punch option 5 of Q2 when option 2 is selected", undefined],
    ["Automatically select option 5 whenever option 2 is selected in Q2", undefined],
    ["When option 2 is selected, automatically punch option 5", "Q2"],
    ["जब ऑप्शन 2 चुना जाए तो ऑप्शन 5 अपने आप पंच करो", "Q2"],
    ["Q2 में ऑप्शन 2 सिलेक्ट हो तो ऑप्शन 5 को ऑटोमैटिक पंच कर दो", undefined],
  ];
  for (const [s, sel] of cases) {
    const a = ops(s, sel);
    assert.ok(Array.isArray(a), `${s}: ${JSON.stringify(a).slice(0, 200)}`);
    assert.deepEqual((a as SurveyAction[]).map((x) => ({ ...x })), [{ op: "add_punch", target: "Q2", when: "Q2 = 2", codes: [5] }], s);
    const r = applySurveyActions(def, a as SurveyAction[]);
    assert.ok(r.results.every((x) => x.ok), `${s}: ${r.errors.join("; ")}`);
  }
  // a single-choice question cannot hold both: refused with the hidden-variable route; a missing option is named
  const single = interpretRequest(def, "Automatically punch option 5 when option 2 is selected", { selectedId: id("Q1") });
  assert.equal(single.kind, "refused");
  assert.match(single.kind === "refused" ? single.reason : "", /takes one answer/);
  const missing = interpretRequest(def, "Automatically punch option 9 when option 2 is selected", { selectedId: id("Q2") });
  assert.match(missing.kind === "refused" ? missing.reason : "", /no option 9/);
  // negatives: not a punch-by-option sentence
  for (const s of ["Punch SEGMENT as 2 when Q1 = 1", "Show option 5 when option 2 is selected", "Code Q4 as 1 when Q1 = 2"]) {
    const i = interpretRequest(def, s, { selectedId: id("Q2") });
    assert.ok(!(i.kind === "actions" && i.actions.some((x) => x.op === "add_punch" && (x as { codes?: unknown[] }).codes?.[0] === 5)), s);
  }
});

test("#8 “equally / evenly / balanced / rotate” → options rotate; Hindi बराबर; a plain randomize stays a shuffle", () => {
  for (const s of ["Randomize these four concepts equally across respondents", "Randomize the options evenly", "Randomize these concepts in a balanced way across all respondents", "Rotate the options of Q3", "इन चार कॉन्सेप्ट्स को सभी रेस्पोंडेंट्स में बराबर रैंडमाइज़ करो"]) {
    const a = ops(s, "Q3");
    assert.ok(Array.isArray(a), `${s}: ${JSON.stringify(a).slice(0, 200)}`);
    assert.deepEqual((a as SurveyAction[]).map((x) => [x.op, (x as { target?: string }).target, (x as { method?: string }).method]), [["set_option_randomization", "Q3", "rotate"]], s);
  }
  const plain = ops("Randomize the options of Q3");
  assert.equal((plain as SurveyAction[])[0] && (plain as { method?: string }[])[0].method, undefined);
});

test("#9 countdown: with a length → the timed variant; without → a choice of lengths; not single choice → the model (a script)", () => {
  for (const s of ["Add a 30-second countdown to Q1", "Put a 30 second timer on Q1", "Add a countdown timer of 30 seconds to this question", "Q1 में 30 सेकंड का काउंटडाउन टाइमर जोड़ो"]) {
    const a = ops(s, "Q1");
    assert.ok(Array.isArray(a), `${s}: ${JSON.stringify(a).slice(0, 200)}`);
    assert.deepEqual(a, [{ op: "update_question", target: "Q1", type: "gamified.timed", settings: { timeLimitSeconds: 30, onTimeout: "lock" } }], s);
  }
  assert.deepEqual(ops("Add a 1 minute countdown to Q1 and then go to the next page"), [{ op: "update_question", target: "Q1", type: "gamified.timed", settings: { timeLimitSeconds: 60, onTimeout: "advance" } }]);
  const noLen = interpretRequest(def, "Add a countdown timer to this question", { selectedId: id("Q1") });
  assert.equal(noLen.kind, "model");
  assert.deepEqual(noLen.kind === "model" ? noLen.fallback?.choices.map((c) => c.label) : [], ["10 seconds", "30 seconds", "60 seconds"]);
  const numeric = interpretRequest(def, "Add a 30-second countdown to Q4");
  assert.equal(numeric.kind, "model");
  assert.match(numeric.kind === "model" ? numeric.reason : "", /script/);
  // negatives
  for (const s of ["How long is the countdown on Q1?", "Remove the timer from Q1"]) { const i = interpretRequest(def, s); assert.ok(!(i.kind === "actions" && i.actions.some((x) => x.op === "update_question")), s); }
});

test("#5 / #15 a drag-and-drop ranking / video-testing question → the variant named, the wording asked (English and Hindi)", () => {
  for (const [s, v] of [["Create a drag-and-drop ranking question", "ranking.drag"], ["Add a drag and drop ranking exercise", "ranking.drag"], ["ड्रैग एंड ड्रॉप रैंकिंग सवाल बनाओ", "ranking.drag"],
    ["Create an interactive video-testing experience", "media.video_rating"], ["Add a video testing question", "media.video_rating"], ["वीडियो टेस्टिंग का सवाल बनाओ", "media.video_rating"]] as const) {
    const i = interpretRequest(def, s);
    assert.equal(i.kind, "model", s);
    if (i.kind !== "model") continue;
    assert.ok(i.fallback, s);
    assert.match(i.fallback!.understood, new RegExp(v.replace(".", "\\.")), s);
    assert.match(i.fallback!.question, /What should it ask/, s);
  }
  assert.equal(interpretRequest(def, "Create a ranking question “Rank these” with options A, B, C").kind === "model" && (interpretRequest(def, "Create a ranking question “Rank these” with options A, B, C") as { fallback?: { understood: string } }).fallback?.understood.includes("drag"), false, "a ranking with its wording is not this clarify");
});
