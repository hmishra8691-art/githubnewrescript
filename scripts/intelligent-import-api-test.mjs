/**
 * THE INTELLIGENT IMPORT OVER HTTP (2026-11-13) — the Studio's own routes, with the sandbox project and the fake AI
 * provider (no account, no database):
 *
 *   POST /api/import/analyze (phase=run)            → stages, understanding, questions, final report, definition
 *   POST /api/import/sessions/:id/intelligent       → answers applied in place; survey re-programmed and re-tested
 *
 * on a Word questionnaire (built here), a Qualtrics QSF and a Decipher XML from the corpus.
 *
 *   AI_API_URL=fake: next dev -p 3000   (apps/studio), then   node scripts/intelligent-import-api-test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wordDocFixture } from "../packages/import/dist/fixtures.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
async function analyze(bytes, name) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  form.append("surveyId", "sandbox"); form.append("phase", "run"); form.append("scope", "full"); form.append("into", "new");
  const r = await fetch(`${STUDIO}/api/import/analyze`, { method: "POST", body: form });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d).slice(0, 300));
  return d;
}
const answer = async (sessionId, answers) => { const r = await fetch(`${STUDIO}/api/import/sessions/${sessionId}/intelligent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) }); return { status: r.status, d: await r.json() }; };

console.log("\nWORD — upload, questions, answers in place");
{
  const doc = wordDocFixture([
    "S1. Which brands do you own? [SELECT ALL THAT APPLY]", "1. Apex", "2. Nova", "3. None of these",
    "ASK ONLY EXISTING CUSTOMERS",
    "Q1. Why did you choose your brand?",
    "Q2. PROGRAMMER NOTE: MAXDIFF - 6 items, 3 per screen, 4 screens. Which matters most and least?", "1. Price", "2. Quality", "3. Design", "4. Service", "5. Speed", "6. Range",
    "Q3. Which of these is the most important and which the least important to you?", "1. A", "2. B", "3. C", "4. D",
  ]);
  const d = await analyze(doc, "brands.docx");
  assert.ok(d.intelligence, "the response carries the orchestrated run");
  assert.deepEqual(d.intelligence.stages.map((s) => s.id), ["scan", "understand", "analyze", "clarify", "program", "validate", "test", "finalize"]);
  assert.equal(d.intelligence.session, undefined, "the stored model is not sent to the browser");
  assert.ok(d.session?.id, "a session was kept");
  assert.equal(d.definition.questions.find((q) => q.code === "Q2").type, "maxdiff_task");
  assert.equal(d.intelligence.final.verdict, "waiting_for_answers");
  SurveyDefinition.parse(d.definition);
  ok(`8 stages; ${d.intelligence.clarifications.length} questions for the person; the named MaxDiff is a placeholder; verdict “waiting for answers”`);

  const logic = d.intelligence.clarifications.find((c) => c.about === "logic" && /Q1/.test(c.where));
  const method = d.intelligence.clarifications.find((c) => c.about === "method");
  const a1 = await answer(d.session.id, [{ id: logic.id, choice: 0 }]);
  assert.equal(a1.status, 200, JSON.stringify(a1.d).slice(0, 300));
  assert.ok(a1.d.definition.questions.find((q) => q.code === "Q1").displayLogic, "Q1 has its condition now");
  assert.equal(a1.d.intelligence.clarifications.find((c) => c.id === logic.id).answered.choice, 0);
  ok("first answer: applied to Q1, on record, survey re-tested");
  const a2 = await answer(d.session.id, [{ id: method.id, choice: 1 }]);
  assert.equal(a2.status, 200);
  assert.equal(a2.d.definition.questions.find((q) => q.code === "Q3").type, "maxdiff_task");
  assert.ok(a2.d.definition.questions.find((q) => q.code === "Q1").displayLogic, "the first answer is still in force");
  assert.equal(a2.d.intelligence.clarifications.filter((c) => !c.answered).length, 0);
  assert.equal(a2.d.intelligence.final.verdict, "passed_with_pending", JSON.stringify(a2.d.intelligence.final.unresolved));
  ok(`second answer on top of the first: nothing left to ask; verdict “${a2.d.intelligence.final.verdict}”, ${a2.d.intelligence.final.pending.length} pending (the two exercise designs)`);
  const bad = await answer(d.session.id, { nope: true });
  assert.equal(bad.status, 400);
  const none = await answer("00000000-0000-0000-0000-000000000000", []);
  assert.ok(none.status === 401 || none.status === 404, String(none.status));
  ok("a malformed body is refused (400); an unknown session is not served (401 without an account)");
}

console.log("\nQSF and DECIPHER — the corpus through the same route");
for (const rel of ["qualtrics/qualtrics_2.qsf", "decipher/decipher_3.xml"]) {
  const t0 = Date.now();
  const d = await analyze(readFileSync(new URL(`../packages/import/fixtures/corpus/${rel}`, import.meta.url)), rel.split("/")[1]);
  assert.equal(d.intelligence.stages.length, 8);
  const a = d.intelligence.final.accounting;
  assert.equal(a.programmed + a.partial + a.notProgrammed, a.detected);
  SurveyDefinition.parse(d.definition);
  ok(`${rel.split("/")[1]}: ${d.definition.questions.length} questions, ${d.intelligence.understanding.sections.length} sections, ${a.programmed}/${a.detected} items programmed, ${d.intelligence.final.tests.walks} interviews simulated, verdict “${d.intelligence.final.verdict}” (${Date.now() - t0} ms)`);
}
console.log(`\nINTELLIGENT IMPORT API: ${passed} checks passed`);
