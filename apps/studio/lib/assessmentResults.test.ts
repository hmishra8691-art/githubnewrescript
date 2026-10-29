import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SurveyDefinition } from "@rescript/schema";
import { assessmentKeyFingerprint, scoreAssessment } from "@rescript/engine";
import { docxName, researcherAssessment } from "./assessmentResults.ts";

const opts = () => [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }];
const q = (n: number, topic: string, correct: number) => ({ id: `q${n}`, code: `Q${n}`, variableName: `Q${n}`, type: "single_select", text: `Q ${n}`, options: opts(), assessment: { correct: [correct], topic } });
const paper = (key2 = 2) => SurveyDefinition.parse({
  meta: { id: "s", code: "UPSC", title: "UPSC GS / Paper 1", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [q(1, "Polity", 1), q(2, "Economy", key2), q(3, "Economy", 3)],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e1", status: "complete" }],
  assessment: { defaultMarks: 2, defaultNegativeMarks: 0.66, passPercent: 50 },
});

test("stored results scored against the current key are used; missing or stale ones are re-scored", () => {
  const def = paper();
  const a = { q1: 1, q2: 2, q3: 3 };      // 6
  const b = { q1: 2, q2: 2 };             // 2 − 0.66
  const c = { q1: 1 };                    // 2
  const storedA = scoreAssessment(def, a);
  const stale = scoreAssessment(paper(4), b);   // scored against another key
  const out = researcherAssessment(def, [
    { session_id: "a", answers: a }, { session_id: "b", answers: b }, { session_id: "c", answers: c },
  ], [
    { session_id: "a", key_fingerprint: assessmentKeyFingerprint(def), result: storedA },
    { session_id: "b", key_fingerprint: stale.keyFingerprint, result: stale },
  ]);
  assert.equal(out.n, 3);
  assert.equal(out.rescored, 2, "b (stale key) and c (no row) re-scored");
  assert.equal(out.results[0], storedA, "a's stored result reused as is");
  assert.deepEqual(out.results.map((r) => r.marks), [6, 1.34, 2]);
  assert.equal(out.analytics.n, 3);
  assert.equal(out.analytics.passRate, 33.33);
  assert.equal(out.analytics.items.length, 3);
  assert.deepEqual(out.analytics.topics.map((t) => t.topic).sort(), ["Economy", "Polity"]);
});

test("a malformed stored row never reaches the card: it is re-scored", () => {
  const def = paper();
  const out = researcherAssessment(def, [{ session_id: "x", answers: { q1: 1 } }], [{ session_id: "x", key_fingerprint: assessmentKeyFingerprint(def), result: { v: 1 } }]);
  assert.equal(out.rescored, 1);
  assert.equal(out.results[0].marks, 2);
});

test("docx filename is safe", () => {
  assert.equal(docxName("UPSC GS / Paper 1"), "UPSC_GS_Paper_1-assessment.docx");
  assert.equal(docxName(""), "assessment-assessment.docx");
});

test("the route guards first (requireUser → requireProjectFor project.read), then needs responses.read for scores", () => {
  const src = readFileSync(new URL("../app/api/surveys/[id]/assessment/route.ts", import.meta.url), "utf8");
  for (const fn of ["GET", "POST"]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`));
    const first = body.slice(body.indexOf(") {") + 3).trim().split("\n")[0];
    assert.match(first, /await requireUser\(req\)/, `${fn}: the first statement is the guard`);
  }
  assert.match(src, /requireProjectFor\(authed, params\.id, "project\.read"\)/);
  assert.match(src, /can\(gate\.grant, "responses\.read"\)/);
  assert.match(src, /dbConfigured\(\)/, "the sandbox branch exists only without a database");
});
