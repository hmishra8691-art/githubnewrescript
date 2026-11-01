import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { readSource, clarifications, applyDecisions, mapCanonical, buildReport, buildImportGraph, type CanonicalSurvey, type Decision } from "./index.js";

/**
 * I5 — the clarification engine: one specific question per decision the source leaves open, a recommended
 * answer with its reason, structured alternatives; decisions are checked before they are applied and the survey
 * is re-analysed afterwards. Corpus: packages/import/corpus/brand-instructions.txt (synthetic).
 */
const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "brand-instructions.txt");
const load = async () => (await readSource(new TextEncoder().encode(readFileSync(FILE, "utf8")), "brand.txt")).canonical!;
const pick = (c: CanonicalSurvey) => Object.fromEntries(clarifications(c).map((x) => [x.kind + ":" + (x.questionId ?? ""), x]));

test("the reader states what it could not decide; nothing is guessed", async () => {
  const c = await load();
  const q1 = c.questions.find((q) => q.sourceId === "Q1")!;
  assert.deepEqual(q1.randomization?.anchorsBottom, ["99"], "RANDOMIZE ALL OPTIONS EXCEPT 99 keeps 99 in place — no question needed");
  const q2 = c.questions.find((q) => q.sourceId === "Q2")!;
  assert.equal(q2.displayLogic, undefined, "“existing customer” defines nothing in the document: no rule is written");
  assert.deepEqual(c.embedded.map((f) => f.name), ["REGION"]);
  const asks = pick(c);
  assert.deepEqual(Object.keys(asks).sort(), ["embedded_source:Q4", "missing_condition:Q2", "missing_condition:Q5", "missing_target:Q4", "randomize_scope:S2"].sort());
});

test("each question is specific, with a recommended answer and why — or none when nothing points to one", async () => {
  const a = pick(await load());
  const r = a["randomize_scope:S2"];
  assert.match(r.question, /Should all of S2's options be randomized, or should “Other” stay fixed at the end\?/);
  assert.match(r.recommended!.label, /keep “Other” fixed/);
  const t = a["missing_target:Q4"];
  assert.match(t.question, /names no question or section/);
  assert.equal(t.recommended!.label, "Do not show Q4 when Q3 = No", "“skip this question if No” → do not ask it");
  assert.ok(t.alternatives.some((x) => /Go to Q5/.test(x.label)) && t.alternatives.some((x) => /End the survey/.test(x.label)));
  const e = a["embedded_source:Q4"];
  assert.match(e.recommended!.label, /From the answer to S2/); assert.match(e.because!, /S2 asks about region/);
  const m = a["missing_condition:Q2"];
  assert.equal(m.recommended, null, "“existing customer” names no answer: no recommendation, the person chooses");
  assert.ok(m.alternatives.some((x) => x.label === "S1 = Yes"), "the alternatives include the earlier closed questions' answers");
});

test("applying decisions: checked, applied to a copy, the ambiguity resolved, the survey valid and re-analysed", async () => {
  const c = await load();
  const a = pick(c);
  const yes = a["missing_condition:Q2"].alternatives.find((x) => x.label === "S1 = Yes")!.decision;
  const decisions: Decision[] = [a["randomize_scope:S2"].recommended!.decision, a["missing_target:Q4"].recommended!.decision, a["embedded_source:Q4"].recommended!.decision, yes,
    { id: "bad", type: "display", questionId: "Q3", when: { t: "cmp", ref: { kind: "question", id: "Q1", choice: "7" }, op: "selected" } }];
  const r = applyDecisions(c, decisions);
  assert.deepEqual(r.rejected, [{ id: "bad", reason: "Q1 has no answer 7" }], "a decision naming an answer that does not exist is refused, not approximated");
  assert.equal(r.applied.length, 4);
  assert.equal(c.questions.find((q) => q.sourceId === "Q2")!.displayLogic, undefined, "the source canonical is untouched");
  const q2 = r.canonical.questions.find((q) => q.sourceId === "Q2")!;
  assert.deepEqual(q2.displayLogic, { t: "cmp", ref: { kind: "question", id: "S1", choice: "1" }, op: "selected" });
  assert.deepEqual(r.canonical.questions.find((q) => q.sourceId === "S2")!.randomization?.anchorsBottom, ["3"]);
  assert.equal(r.canonical.embedded[0].source, "expression"); assert.equal(r.canonical.embedded[0].value, "{{@S2}}");
  const left = clarifications(r.canonical).map((x) => x.kind + ":" + x.questionId);
  assert.deepEqual(left, ["missing_condition:Q5"], "only the unanswered question is still open");
  /* "leave it" closes the question and keeps the item on the review list */
  const q5 = clarifications(r.canonical)[0];
  const r2 = applyDecisions(r.canonical, [q5.alternatives.at(-1)!.decision]);
  assert.equal(clarifications(r2.canonical).length, 0);
  assert.ok(r2.canonical.issues.some((i) => /^Left to do in Studio: .*Q42/.test(i.message)));
  const m = mapCanonical(r.canonical, { surveyId: "s1" });
  assert.ok(m.def && SurveyDefinition.safeParse(m.def).success);
  const q4 = m.def!.questions.find((q) => q.variableName === "Q4" || q.code === "Q4")!;
  assert.ok(JSON.stringify(q4.displayLogic ?? q4).includes("not"), "Q4 is not shown when Q3 = No");
  const report = buildReport({ format: "text", platform: "document", importType: "x", label: "doc", confidence: "high", reasons: [] } as never, r.canonical, m, "full");
  assert.equal(report.clarifications.length, 1);
  assert.ok(report.summary.some((s) => /1 decision the source left open needs your answer/.test(s)));
});

test("conflicts and undefined references become questions too", async () => {
  const c = await load();
  const q5 = c.questions.find((q) => q.sourceId === "Q5")!;
  /* two instructions for one question that cannot both hold (single choice) */
  q5.displayLogic = { t: "group", op: "and", children: [{ t: "cmp", ref: { kind: "question", id: "S1", choice: "1" }, op: "selected" }, { t: "cmp", ref: { kind: "question", id: "S1", choice: "2" }, op: "selected" }] };
  const q3 = c.questions.find((q) => q.sourceId === "Q3")!;
  q3.displayLogic = { t: "cmp", ref: { kind: "question", id: "S11", choice: "1" }, op: "selected" };
  const asks = clarifications(c);
  const conflict = asks.find((x) => x.kind === "conflict")!;
  assert.match(conflict.question, /S1 is “Yes” and “No” at the same time/);
  const ref = asks.find((x) => x.kind === "undefined_reference")!;
  assert.match(ref.question, /S11.*Which question did it mean\?/);
  assert.match(ref.recommended!.label, /^S1 —/, "S11 ~ S1");
  const r = applyDecisions(c, [conflict.recommended!.decision, ref.recommended!.decision]);
  assert.equal(r.canonical.questions.find((q) => q.sourceId === "Q5")!.displayLogic!.t === "group" && (r.canonical.questions.find((q) => q.sourceId === "Q5")!.displayLogic as { op: string }).op, "or");
  assert.equal(buildImportGraph(r.canonical).findings.filter((f) => f.kind === "missing_reference").length, 0, "the reference now resolves");
});
