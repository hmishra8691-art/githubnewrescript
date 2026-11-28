import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { analyzeImport, runScenarios } from "./index.js";
import { walkSurvey, readByOthers } from "./verify.js";

/*
 * I2, EXAMINED (2026-11-27). Of the 131 behaviour scenarios failing on the ten-file corpus, most were the scenario
 * builder's or the walker's fault, and one was the engine's. These hold each fix on a small survey of its own, and
 * the corpus figure where it is checked: the bench's import.fidelity.
 */
const opts = [{ code: "1", label: "One" }, { code: "2", label: "Two" }, { code: "3", label: "Three" }];
const page = (id: string, ...q: string[]) => ({ type: "page", id, questionIds: q });
const end = (id: string, status = "screened") => ({ type: "end", id, status });
const branch = (id: string, when: unknown, children: unknown[]) => ({ type: "branch", id, branches: [{ id: `${id}_a`, when, children }], otherwise: [] });
const rule = (ref: string, operator: string, value?: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator, ...(value === undefined ? {} : { value }) });
const walk = (def: SurveyDefinition, force: Record<string, unknown> = {}) => walkSurvey(def, "deepest", 7, { force, readBy: readByOthers(def), keepState: true });

test("a number screened on both sides (under 18 or over 44) is passed: candidates come from the rule's own thresholds", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "n", code: "N", title: "N", version: "1" },
    questions: [{ id: "age", code: "AGE", variableName: "AGE", type: "numeric", text: "Age", validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 99 }] }, { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "After" }],
    flow: [page("p1", "age"), branch("t", { type: "group", op: "or", children: [rule("age", "lt", 18), rule("age", "gt", 44)] }, [end("t_end")]), page("p2", "q2"), end("done", "complete")],
  });
  const w = walk(def);
  assert.equal(w.end, "complete");
  assert.ok(w.seen.has("q2"));
  const a = w.state!.answers.age as number;
  assert.ok(a >= 18 && a <= 44, String(a));
});

test("a grid screener that counts high ratings is passed: the walk tries every row in one column", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "g", code: "G", title: "G", version: "1" },
    questions: [
      { id: "grid", code: "GRID", variableName: "GRID", type: "matrix_single", text: "Rate", rows: [{ code: "r1", label: "A" }, { code: "r2", label: "B" }], options: opts },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "After" },
    ],
    flow: [page("p1", "grid"), branch("t", { type: "group", op: "or", children: [{ type: "rule", source: { kind: "question", ref: "grid", rowCode: "r1" }, operator: "notSelected", value: "3" }] }, [end("t_end")]), page("p2", "q2"), end("done", "complete")],
  });
  const w = walk(def);
  assert.equal(w.end, "complete", JSON.stringify(w.state!.answers.grid));
});

test("equally deep answers: the one that switches on fewer ends is kept (a term placed at the end of the screener)", () => {
  /* S2 is unanswered when S1 is answered, so "S2 is not 1 → screened" is already on; S1's own term sits behind it */
  const def = SurveyDefinition.parse({
    meta: { id: "t", code: "T", title: "T", version: "1" },
    questions: ["s1", "s2", "q3"].map((id) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: id === "q3" ? "open_text" : "single_select", text: id, ...(id === "q3" ? {} : { options: opts }) })),
    flow: [page("p1", "s1"), page("p2", "s2"), branch("t2", rule("s2", "notSelected", "1"), [end("e2")]), branch("t1", rule("s1", "selected", "1"), [end("e1")]), page("p3", "q3"), end("done", "complete")],
  });
  const w = walk(def);
  assert.equal(w.end, "complete");
  assert.notEqual(String(w.state!.answers.s1), "1", "S1's first answer is the one that screens");
});

test("a hidden flag the scenario fixes holds from the start, even with no page of its own before it is read", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "h", code: "H", title: "H", version: "1" },
    questions: [
      { id: "flag", code: "FLAG", variableName: "FLAG", type: "single_select", text: "Hidden", options: opts, settings: { hidden: true } },
      { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Shown when FLAG is 2", displayLogic: rule("flag", "selected", "2") },
    ],
    flow: [page("p1", "q1"), page("p9", "flag"), end("done", "complete")],
  });
  assert.equal(walk(def).seen.has("q1"), false);
  assert.equal(walk(def, { flag: "2" }).seen.has("q1"), true);
});

test("the corpus: scenarios driven through a script-set flag, randomizer draws tried, \"not this answer\" avoiding a sibling term", async () => {
  const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "corpus");
  /* decipher_1: qTesting is set by the survey from the link field testing2 — the scenario drives the field */
  const d1 = await analyzeImport(new Uint8Array(readFileSync(join(corpus, "decipher", "decipher_1.xml"))), "decipher_1.xml", { surveyId: "s" });
  const b1 = runScenarios(d1.canonical!, d1.result!, { max: 300, budgetMs: 600_000 });
  const flag = b1.scenarios.find((s) => s.id.startsWith("display:") && /S02TermFlag shown if qTesting/.test(s.rule) && s.met)!;
  assert.equal(flag.result, "pass", flag.observed);
  assert.ok(flag.given.some((g) => /^ED\.testing2 = 1/.test(g)), flag.given.join(", "));
  assert.equal(b1.failed, 0, JSON.stringify(b1.scenarios.filter((s) => s.result === "fail").slice(0, 3)));
  /* qualtrics_5: brand blocks inside "randomly present 1 of 4" — tested on a draw that presents them, or not testable */
  const q5 = await analyzeImport(new Uint8Array(readFileSync(join(corpus, "qualtrics", "qualtrics_5.qsf"))), "qualtrics_5.qsf", { surveyId: "s" });
  const b5 = runScenarios(q5.canonical!, q5.result!, { max: 300, budgetMs: 600_000 });
  assert.equal(b5.failed, 0, JSON.stringify(b5.scenarios.filter((s) => s.result === "fail").slice(0, 3)));
  for (const s of b5.scenarios.filter((x) => x.result === "not_testable" && /randomizer/.test(x.observed))) assert.match(s.observed, /none of 16 draws/);
  /* decipher_2: "not Straightliner" is an answer no rule mentions, so the Speeder term does not end the interview instead */
  const d2 = await analyzeImport(new Uint8Array(readFileSync(join(corpus, "decipher", "decipher_2.xml"))), "decipher_2.xml", { surveyId: "s" });
  const b2 = runScenarios(d2.canonical!, d2.result!, { max: 300, budgetMs: 600_000 });
  const qc = b2.scenarios.find((s) => /QC Term: Straightliner/.test(s.rule) && !s.met)!;
  assert.equal(qc.result, "pass", `${qc.given.join(", ")} — ${qc.observed}`);
  assert.ok(!qc.given.some((g) => /Speeder/.test(g)), qc.given.join(", "));
});
