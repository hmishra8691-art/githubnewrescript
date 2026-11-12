/**
 * THE INTELLIGENT IMPORT, END TO END (2026-11-13): the same orchestrated run — scan → understand → analyze →
 * clarify → program → validate → test → finalize — on a Word questionnaire, an Excel specification, Qualtrics QSF
 * exports and Decipher XML projects (the real corpus). What is asserted is behaviour: what was understood, what was
 * asked, that an answer changes the programmed survey and is re-tested, that exercises become placeholders and are
 * never reported as built, and that the final report accounts for everything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import { SurveyDefinition } from "@rescript/schema";
import { wordDocFixture } from "./fixtures.js";
import { runIntelligentImport, continueIntelligentImport, advanceIntelligentImport, type IntelligentImport } from "./intelligence/pipeline.js";
import { detectMethodologies } from "./intelligence/methodology.js";
import { reviewContent } from "./intelligence/content.js";
import { readSource } from "./sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = (rel: string) => new Uint8Array(readFileSync(join(here, "..", "fixtures", "corpus", rel)));
const stageOf = (r: IntelligentImport, id: string) => r.stages.find((s) => s.id === id)!;
const qOf = (r: IntelligentImport, code: string) => r.definition!.questions.find((q) => q.code === code || q.variableName === code);

const WORD = () => wordDocFixture([
  { p: "Smartphone Features Study 2026", style: "Heading1" },
  { p: "SECTION A: SCREENER", style: "Heading1" },
  "S1. Do you agree to take part in this survey?",
  "1. Yes",
  "2. No (TERMINATE)",
  "S2. Which age group are you in? [SINGLE ANSWER]",
  "1. Under 18 (TERMINATE)",
  "2. 18-25",
  "3. 25-34",
  "4. 36-50",
  "5. 51+",
  "S3. Which of these smartphone brands do you currently own? [SELECT ALL THAT APPLY] [RANDOMIZE]",
  "1. Apex",
  "2. Nova",
  "3. Zen",
  "4. None of these [EXCLUSIVE]",
  { p: "SECTION B: MAIN", style: "Heading1" },
  "Q1. Which brand is your main phone? [SINGLE ANSWER]",
  "ASK IF S3 = 1 OR S3 = 2 OR S3 = 3",
  "1. Apex",
  "2. Nova",
  "3. Zen",
  "Q2. Don't you agree that battery life matters most? [SINGLE ANSWER]",
  "1. Yes",
  "2. No",
  "ASK ONLY EXISTING CUSTOMERS",
  "Q3. Why did you choose your main brand?",
  "QUOTA: STOP IF 200 COMPLETES",
  "Q4. PROGRAMMER NOTE: MAXDIFF EXERCISE - 8 items, 4 per screen, 6 screens. Which of these features is MOST important and which is LEAST important to you?",
  "1. Battery life",
  "2. Camera quality",
  "3. Screen size",
  "4. Price",
  "5. Storage",
  "6. Water resistance",
  "7. Charging speed",
  "8. Durability",
  "Q5. Of the phones below, which is the most appealing and which the least appealing? [SINGLE ANSWER]",
  "1. Phone A",
  "2. Phone B",
  "3. Phone C",
  "4. Phone D",
  { p: "SECTION C: CLOSING", style: "Heading1" },
  "Q6. Any final comments?",
]);

test("WORD: understood, asked in plain words, programmed around the open question, answered, re-programmed and re-tested", async () => {
  const r = await runIntelligentImport(WORD(), "smartphone.docx");
  assert.equal(r.ok, true);
  assert.deepEqual(r.stages.map((s) => s.id), ["scan", "understand", "analyze", "clarify", "program", "validate", "test", "finalize"]);

  /* understanding: sections with a purpose, the programming, the method */
  const u = r.understanding!;
  assert.deepEqual(u.sections.map((s) => s.purpose), ["screener", "exercise", "closing"], JSON.stringify(u.sections.map((s) => [s.title, s.purpose, s.because])));
  assert.ok(u.programming.terminations >= 2 && u.programming.displayLogic >= 1 && u.programming.randomizedLists >= 1, JSON.stringify(u.programming));
  assert.match(u.objective.text, /MaxDiff/);
  assert.ok(u.objective.basis.length >= 2, "the purpose says what it was inferred from");

  /* methods: the NAMED MaxDiff is a placeholder with what the source stated; the look-alike is only asked about */
  const stated = r.methodologies.find((m) => m.method === "maxdiff" && m.certainty === "stated")!;
  assert.deepEqual(stated.questions, ["Q4"]);
  assert.deepEqual(stated.stated, { items: 8, perSet: 4, sets: 6 });
  const q4 = qOf(r, "Q4")!;
  assert.equal(q4.type, "maxdiff_task", "the named exercise is a MaxDiff placeholder, not an ordinary list");
  assert.equal(q4.options.length + q4.rows.length >= 8, true, "its eight items are kept");
  assert.equal(qOf(r, "Q5")!.type, "single_select", "a question that only looks like the method is left as written");
  assert.ok(r.final!.pending.some((p) => /Q4 — MaxDiff/.test(p.what) && /design/i.test(p.needs)), "the placeholder is pending, with what to add");
  assert.equal(r.final!.completed.some((c) => /MaxDiff/.test(c)), false, "…and is never listed as completed");

  /* content review: flagged, never changed */
  const kinds = r.content.map((c) => `${c.kind}@${c.question}`);
  for (const k of ["range_overlap@S2", "range_gap@S2", "leading@Q2", "programmer_text@Q4"]) assert.ok(kinds.includes(k), `${k} in ${kinds.join(", ")}`);
  assert.match(String(qOf(r, "Q2")!.text), /Don't you agree/, "the wording is the researcher's — untouched");

  /* clarifications: plain, with where, why, the source's words, a recommendation where there is one, and a free answer */
  const logic = r.clarifications.find((c) => c.about === "logic" && /Q3/.test(c.where))!;
  assert.ok(logic, r.clarifications.map((c) => `${c.about}:${c.where}`).join(" | "));
  assert.match(logic.quote, /EXISTING CUSTOMERS/i);
  assert.ok(logic.why.length > 20 && logic.options.length >= 2 && logic.allowsOwnAnswer);
  assert.equal(/\b(?:CExpr|canonical|sourceId|regex)\b/.test(`${logic.found} ${logic.why}`), false, "no technical terms");
  const method = r.clarifications.find((c) => c.about === "method")!;
  assert.equal(method.where, "Q5");
  assert.equal(method.options[0].recommended, true, "keeping it as written is the recommendation");

  /* an instruction the reader could not turn into logic is put to the person, never left as a line in a report */
  const unread = r.clarifications.find((c) => c.id.startsWith("unread:"))!;
  assert.ok(unread, r.clarifications.map((c) => c.id).join(" | "));
  assert.match(unread.quote, /200 COMPLETES/);
  assert.equal(unread.options[0].recommended, true);

  /* nothing stopped: everything else is programmed, validated and tested while two questions wait */
  assert.equal(stageOf(r, "clarify").state, "waiting");
  assert.equal(r.final!.verdict, "waiting_for_answers");
  assert.ok(r.definition!.questions.length >= 9);
  assert.ok(r.final!.tests.walks > 0, "the survey was run as respondents");
  assert.equal(r.final!.tests.walkErrors, 0);
  assert.equal(qOf(r, "Q3")!.displayLogic ?? null, null, "Q3 has no condition yet — it was not guessed");
  assert.doesNotThrow(() => SurveyDefinition.parse(r.definition));

  /* answer: Q3 is shown to people who own a brand (the option the engine built), Q5 becomes the exercise */
  const pick = logic.options.findIndex((o) => !/leave|studio|everyone|no condition/i.test(o.label));
  assert.ok(pick >= 0, logic.options.map((o) => o.label).join(" | "));
  const r2 = continueIntelligentImport(r.session!, [{ id: logic.id, choice: pick }]);
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  assert.ok(qOf(r2, "Q3")!.displayLogic, "the answer became Q3's display condition");
  assert.equal(r2.clarifications.find((c) => c.id === logic.id)!.answered!.choice, pick, "the decision is on record");
  assert.equal(r2.clarifications.filter((c) => !c.answered).length, r.clarifications.length - 1);
  assert.ok(r2.final!.tests.walks > 0, "re-tested after the change");

  const rest = r2.clarifications.filter((c) => !c.answered && c.id !== method.id).map((c) => ({ id: c.id, choice: 0 }));
  const r3 = continueIntelligentImport(r2.session!, [{ id: method.id, choice: 1 }, ...rest]);
  assert.equal(qOf(r3, "Q5")!.type, "maxdiff_task", "the second answer is applied on top of the first");
  assert.ok(qOf(r3, "Q3")!.displayLogic, "…and the first answer is still in force");
  assert.equal(stageOf(r3, "clarify").state, "done");
  assert.equal(r3.final!.verdict === "waiting_for_answers", false);
  assert.equal(r3.session!.answers.length, r.clarifications.length);
  assert.equal(r3.final!.verdict, "passed_with_pending", JSON.stringify(r3.final!.unresolved));
  assert.equal(r3.final!.tests.scenariosFailed, 0);

  /* the session is plain data: stored, restored, same result */
  const restored = advanceIntelligentImport(JSON.parse(JSON.stringify(r3.session)));
  assert.deepEqual(restored.definition!.questions.map((q) => [q.code, q.type]), r3.definition!.questions.map((q) => [q.code, q.type]));

  /* an own-words answer is recorded and left for a person — never programmed as a guess */
  const r4 = continueIntelligentImport(r.session!, [{ id: logic.id, own: "Only people who bought in the last 12 months" }]);
  assert.equal(qOf(r4, "Q3")!.displayLogic ?? null, null);
  assert.ok(r4.final!.pending.some((p) => /last 12 months/.test(p.needs)));
  /* an answer that is not one of the choices changes nothing and says so */
  const r5 = continueIntelligentImport(r.session!, [{ id: logic.id, choice: 99 }, { id: "nope", choice: 0 }]);
  assert.equal(r5.rejected.length, 2);
  assert.equal(qOf(r5, "Q3")!.displayLogic ?? null, null);
});

test("EXCEL: a specification sheet with a conjoint and an unavailable method — placeholders, pending, the rest programmed", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Questionnaire");
  ws.addRow(["Q ID", "Question", "Type", "Options", "Logic", "Notes"]);
  ws.addRow(["S1", "Are you the main decision maker for software in your company?", "Single", "1=Yes; 2=No", "", "TERMINATE IF S1 = 2"]);
  ws.addRow(["S2", "How many employees does your company have?", "Single", "1=1-9; 2=10-49; 3=50-249; 4=250+", "", ""]);
  ws.addRow(["Q1", "Which of these tools do you use?", "Multi", "1=Alpha; 2=Beta; 3=Gamma; 4=None of these", "", "Randomize"]);
  ws.addRow(["Q2", "How satisfied are you with your main tool?", "Single", "1=Very dissatisfied; 2=Dissatisfied; 3=Neutral; 4=Satisfied; 5=Very satisfied", "ASK IF Q1 = 1 OR Q1 = 2 OR Q1 = 3", ""]);
  ws.addRow(["Q3", "Which subscription would you choose?", "Single", "1=Plan A; 2=Plan B; 3=Plan C; 4=None", "", "CBC conjoint: 4 attributes, 10 tasks, 3 alternatives per task plus none"]);
  ws.addRow(["Q4", "Please sort these statements.", "Single", "1=Statement one; 2=Statement two; 3=Statement three", "", "Q-sort exercise"]);
  ws.addRow(["Q5", "Anything else you would like to tell us?", "Open", "", "", ""]);
  const r = await runIntelligentImport(new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer), "spec.xlsx");
  assert.equal(r.ok, true, r.error);
  const methods = Object.fromEntries(r.methodologies.map((m) => [m.method, m]));
  assert.equal(methods.cbc.support, "needs_design");
  assert.deepEqual(methods.cbc.questions, ["Q3"]);
  assert.equal(methods.cbc.stated.sets, 10);
  assert.equal(methods.q_sort.support, "pending");
  assert.equal(qOf(r, "Q3")!.type, "conjoint_task");
  assert.equal(qOf(r, "Q4")!.type, "single_select", "no engine yet: the question stays as written, flagged — never dressed up as the method");
  assert.ok(r.final!.pending.some((p) => /Q3 — Choice-based conjoint/.test(p.what)));
  assert.ok(r.final!.pending.some((p) => /Q4 — Q-sort/.test(p.what) && /no engine/i.test(p.needs)));
  /* the surrounding questions and logic are all there */
  assert.deepEqual(r.definition!.questions.map((q) => q.code), ["S1", "S2", "Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.ok(qOf(r, "Q2")!.displayLogic, "the display condition around the exercises is programmed");
  assert.ok((qOf(r, "S1")!.skipLogic ?? []).length >= 1, "the termination is programmed");
  assert.equal(r.final!.tests.walkErrors, 0);
  assert.ok(["passed_with_pending", "waiting_for_answers"].includes(r.final!.verdict), r.final!.verdict);
  assert.match(r.final!.headline, /still to complete|waiting/);
});

test("QSF and DECIPHER (the real corpus): every stage runs; an export is reported as it is built, never re-built; the report accounts for every item", async () => {
  for (const rel of ["qualtrics/qualtrics_1.qsf", "qualtrics/qualtrics_3.qsf", "decipher/decipher_1.xml", "decipher/decipher_2.xml"]) {
    const r = await runIntelligentImport(corpus(rel), rel.split("/")[1]);
    assert.equal(r.ok, true, rel);
    assert.equal(r.stages.length, 8, rel);
    assert.equal(r.stages.every((s) => s.summary.length > 10), true, rel);
    assert.ok(r.understanding!.sections.length >= 1 && r.understanding!.questions.total === r.session!.canonical.questions.length, rel);
    const a = r.final!.accounting;
    assert.equal(a.programmed + a.partial + a.notProgrammed, a.detected, `${rel}: every detected item is accounted for`);
    assert.ok(r.final!.tests.walks > 0, `${rel}: tested`);
    assert.doesNotThrow(() => SurveyDefinition.parse(r.definition), rel);
    /* the same file through the plain import builds the same questions: the orchestrator adds understanding, not a second programming path */
    const read = await readSource(corpus(rel), rel.split("/")[1]);
    assert.equal(r.definition!.questions.length >= read.canonical!.questions.length, true, rel);
    assert.equal(r.clarifications.filter((c) => c.about === "method").length, 0, `${rel}: an export is not asked how its questions should be built`);
  }
  /* Decipher project 1 reads a MaxDiff design file: recognised, pending on the file, its questions left as the project built them */
  const d1 = await runIntelligentImport(corpus("decipher/decipher_1.xml"), "decipher_1.xml");
  const md = d1.methodologies.filter((m) => m.method === "maxdiff");
  assert.ok(md.length >= 1);
  assert.equal(d1.definition!.questions.some((q) => q.type === "maxdiff_task"), false, "nothing was converted");
  assert.ok(d1.final!.pending.some((p) => /MaxDiff/.test(p.what)), "…and the exercise is listed as pending");
  assert.ok(d1.final!.pending.some((p) => /QB1_Maxdiff/.test(p.what)), "with the design file it waits for");
  assert.equal(detectMethodologies(d1.session!.canonical).every((m) => m.sourceIds.every((id) => { const q = d1.session!.canonical.questions.find((x) => x.sourceId === id)!; return q.kind !== "hidden" && q.kind !== "calculated"; })), true, "a hidden variable that mentions the method is never the exercise");
});

test("content review flags and never edits: bands, duplicates, notes left in the wording", async () => {
  const read = await readSource(WORD(), "smartphone.docx");
  const before = JSON.stringify(read.canonical);
  const f = reviewContent(read.canonical!);
  assert.equal(JSON.stringify(read.canonical), before, "the review reads; it does not write");
  const s2 = f.filter((x) => x.question === "S2");
  assert.ok(s2.some((x) => x.kind === "range_overlap" && /25/.test(x.message)));
  assert.ok(s2.some((x) => x.kind === "range_gap" && /35/.test(x.message)));
});
