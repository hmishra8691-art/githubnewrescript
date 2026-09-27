import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "@rescript/import";
import { qsfFixture } from "@rescript/import/fixtures";
import { importRequest, importReviewAnswer, formatCharge, codeFromTitle } from "./chat.ts";
import { coerceCustomLogic, customLogicUserPrompt, CUSTOM_LOGIC_SYSTEM_PROMPT } from "./customLogic.ts";
import { planProposal } from "../intelligent/proposal.ts";
import { buildDependencyIndex } from "@rescript/engine";
import type { Question } from "@rescript/schema";

test("import sentences: the picker, the report, and nothing else", () => {
  for (const s of ["import this file", "Upload a Qualtrics survey", "import a questionnaire from Word", "migrate my Decipher XML", "import", "reverse-engineer this QSF"]) assert.equal(importRequest(s), "pick", s);
  for (const s of ["What could not be migrated?", "what couldn't be imported", "what wasn't converted?", "show the migration report", "import issues", "what needs review", "What is left to review after the import?"]) assert.equal(importRequest(s), "report", s);
  for (const s of ["show Q5 only when Q3 = Yes", "add a question about imports", "what depends on Q3?", "Why is Q25 not showing?"]) assert.equal(importRequest(s), null, s);
});

test("“what could not be migrated?” is answered from the survey itself — any session later", async () => {
  const a = await analyzeImport(new TextEncoder().encode(JSON.stringify(qsfFixture())), "Customer_Survey.qsf", { surveyId: "s" });
  const def = a.result!.def!;
  const r = importReviewAnswer(def);
  assert.match(r.summary, /items from Customer_Survey\.qsf \(\d{4}-\d{2}-\d{2}\) need review — \d+ high risk:/);
  assert.ok(r.lines.some((l) => l.questionId === "QID8" && /^High · QID8 · JavaScript/.test(l.text)), JSON.stringify(r.lines.slice(0, 4)));
  assert.ok(r.lines.some((l) => /imported custom script.*kept in Scripts, disabled/.test(l.text)));
  const plain = structuredClone(def); plain.imports = [];
  assert.match(importReviewAnswer(plain).summary, /was not imported from a file/);
  const clean = structuredClone(def); clean.imports![0].review = []; clean.scripts = [];
  assert.match(importReviewAnswer(clean).summary, /Everything in Customer_Survey\.qsf was migrated/);
});

test("the model's custom-logic reading is gated: known fields only, and its intent is only a proposal the planner checks", async () => {
  assert.equal(coerceCustomLogic({}), null, "the fake provider's empty answer is no analysis");
  assert.equal(coerceCustomLogic({ effect: "display" }), null, "no explanation, no analysis");
  const r = coerceCustomLogic({ explanation: "Hides Q8 unless the embedded Country is India.", effect: "display", dependencies: ["Country", 7], equivalent: "exact", intent: { kind: "display", target: "Q8", action: "show", expression: "Country = India" } })!;
  assert.deepEqual(r.dependencies, ["Country"]);
  assert.equal(r.equivalent, "exact");
  assert.deepEqual(r.intent, { kind: "display", target: "Q8", action: "show", expression: "Country = India" });
  const ro = coerceCustomLogic({ explanation: "x", intent: { kind: "explain", target: "Q8" }, equivalent: "exact" })!;
  assert.equal(ro.intent, null, "a read-only shape is not a rebuild");
  assert.equal(ro.equivalent, "none", "no intent, no equivalent");
  assert.equal(coerceCustomLogic({ explanation: "x", effect: "bogus" })!.effect, "other");
  // the proposal is planned against the real survey: an invented question is refused, not applied
  const a = await analyzeImport(new TextEncoder().encode(JSON.stringify(qsfFixture())), "s.qsf", { surveyId: "s" });
  const def = a.result!.def!;
  let n = 0;
  const deps = { uid: (p: string) => `${p}_${++n}`, makeQuestion: () => ({}) as Question, index: buildDependencyIndex(def) };
  const good = planProposal(def, { kind: "display", target: "Q8", action: "show", expression: "Q1 = 1" }, "ai", deps);
  assert.equal(good.errors.length, 0, JSON.stringify(good.errors));
  const bad = planProposal(def, { kind: "display", target: "Q8", action: "show", expression: "Q404 = 1" }, "ai", deps);
  assert.ok(bad.errors.length || (bad.expression?.errors.length ?? 0) > 0, "a question the model made up does not pass");
  // the prompt carries the contract and the code, not the survey's data
  assert.match(CUSTOM_LOGIC_SYSTEM_PROMPT, /never invent one/);
  assert.match(CUSTOM_LOGIC_SYSTEM_PROMPT, /Intent shapes \(pick exactly one\)/);
  const u = customLogicUserPrompt("Q1 …", { language: "javascript", code: "var x = 1;", location: "QID8", role: "question JavaScript", refs: ["Country"], questionCode: "Q8" });
  assert.match(u, /belongs to question Q8/); assert.match(u, /read: Country/); assert.match(u, /var x = 1;/);
});

test("charges and codes", () => {
  assert.equal(formatCharge(0), "$0.00");
  assert.equal(formatCharge(0.0042), "$0.0042", "a fraction of a cent is not shown as free");
  assert.equal(formatCharge(1.5, "EUR"), "€1.50");
  assert.match(codeFromTitle("Customer Satisfaction 2026!"), /^CUSTOMER_SATISFACTION_2026_[A-Z0-9]{4}$/);
  assert.match(codeFromTitle("  "), /^IMPORTED_/);
});
