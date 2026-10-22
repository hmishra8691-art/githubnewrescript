import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { responsesToCSV } from "./csv.js";
import { responsesToSav } from "./statisticalExport.js";
import { choiceDataToCSV } from "./choiceExport.js";
import { stackedChoiceData } from "@rescript/engine";

/*
 * THE CONJOINT SUITE IN THE FILES A CLIENT RECEIVES (F4, 2026-10-22): a rating-based (CVA) question's
 * ratings and a dual-response CBC's follow-up in the CSV and the SPSS file (labelled 0/1), and the
 * stacked choice file's buy column — the CVA question is not a choice question and stays out of it.
 */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "SUITE", title: "Suite", version: "1" },
  designs: [
    { id: "d_cva", kind: "cva", name: "CVA", version: 1, config: { attributes: [{ name: "Brand", levels: ["A", "B"] }, { name: "Speed", levels: ["Slow", "Fast"] }] }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand", "Speed"], rows: [1, 2, 3].map((t) => ({ version: 1, task: t, alt: 1, is_holdout: 0, Brand: t === 2 ? "B" : "A", Speed: t === 3 ? "Fast" : "Slow" })) } },
    { id: "d_cbc", kind: "conjoint", name: "Dual", version: 1, config: { attributes: [{ name: "Brand", levels: ["A", "B"] }], dualResponseNone: true }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand", "none_option"], rows: [1, 2].flatMap((t) => [1, 2].map((a) => ({ version: 1, task: t, alt: a, is_holdout: 0, Brand: a === 1 ? "A" : "B", none_option: 0 }))) } },
  ],
  questions: [
    { id: "q_cva", code: "Q1", variableName: "CVA", type: "conjoint_task", variant: "conjoint.cva", text: "Rate", settings: { designRef: "d_cva" } },
    { id: "q_cbc", code: "Q2", variableName: "DUAL", type: "conjoint_task", text: "Choose", settings: { designRef: "d_cbc" } },
  ],
  flow: [{ type: "page", id: "p", questionIds: ["q_cva", "q_cbc"] }, { type: "end", id: "e", status: "complete" }],
});
const states = [
  { sessionId: "s1", seed: 3, status: "complete", answers: { q_cva: { "1": 8, "2": 3, "3": 10 }, q_cbc: { "1": "2", "1_buy": "yes", "2": "1", "2_buy": "no" } }, calculated: {}, embedded: {}, flags: [] },
  { sessionId: "s2", seed: 4, status: "complete", answers: { q_cva: { "1": 0, "2": 5, "3": 6 }, q_cbc: { "1": "1", "1_buy": "no", "2": "2", "2_buy": "no" } }, calculated: {}, embedded: {}, flags: [] },
];

test("CSV: CVA_T<n> ratings and DUAL_T<n>_BUY 0/1, no stray _buy task column", () => {
  const csv = responsesToCSV(def, states as never);
  const [head, r1, r2] = csv.trim().split(/\r?\n/).map((l) => l.split(","));
  const col = (n: string) => head.indexOf(n);
  for (const n of ["CVA_T1", "CVA_T2", "CVA_T3", "DUAL_T1", "DUAL_T1_BUY", "DUAL_T2_BUY"]) assert.ok(col(n) >= 0, `${n} in ${head.join(",")}`);
  assert.ok(!head.some((h) => /_buy$/.test(h)), "the follow-up is not mistaken for a task");
  assert.deepEqual([r1[col("CVA_T1")], r1[col("CVA_T3")], r1[col("DUAL_T1")], r1[col("DUAL_T1_BUY")], r1[col("DUAL_T2_BUY")]], ["8", "10", "2", "1", "0"]);
  assert.equal(r2[col("CVA_T1")], "0", "a rating of 0 is a rating, not a blank");
});

test("SPSS: the BUY columns are numeric with No / Yes value labels; the ratings numeric", () => {
  const sav = responsesToSav(def, states as never);
  const text = sav.toString("latin1");
  assert.ok(text.includes("DUAL_T1_BUY") && text.includes("CVA_T1"));
  assert.ok(/No[\s\S]{0,40}Yes|Yes[\s\S]{0,40}No/.test(text), "value labels for the follow-up");
});

test("stacked choice file: the dual-response design's buy column; the CVA question is not in it", () => {
  const st = stackedChoiceData(def, states.map((s) => ({ sessionId: s.sessionId, seed: s.seed, answers: s.answers })));
  assert.deepEqual(st.questions, ["DUAL"]);
  const out = choiceDataToCSV(def, states.map((s) => ({ sessionId: s.sessionId, seed: s.seed, answers: s.answers })));
  assert.deepEqual(out.questions, ["DUAL"]);
  const [head, ...rows] = out.csv.trim().split(/\r?\n/).map((l: string) => l.split(","));
  assert.equal(head.at(-1), "buy");
  const s1t1 = rows.filter((r: string[]) => r[head.indexOf("session_id")] === "s1" && r[head.indexOf("task")] === "1");
  assert.equal(s1t1.length, 2);
  assert.ok(s1t1.every((r: string[]) => r[head.indexOf("buy")] === "1"));
});
