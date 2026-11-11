import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { analyzeImport } from "./index.js";
import { wordDocFixture, pdfFixture } from "./fixtures.js";

/**
 * THE SAME QUESTIONNAIRE AS TEXT, WORD, PDF AND EXCEL (2026-11-10).
 *
 * A programmer's questionnaire reaches the platform in whichever format the client used. The reading must not depend
 * on it: the same questions, types, special answers, anchors, logic, missing-asset finding and broken reference from
 * every format. (Word, PDF and text go through the document reader; Excel through the table reader, which hands logic
 * and option annotations to the same reader.)
 */
const LINES = [
  "Customer survey", "",
  "Q1. Which of these brands have you heard of? (Select all that apply) [RANDOMIZE]",
  "1. Alpha", "2. Beta", "3. Gamma", "4. Other (please specify)", "5. None of the above", "6. Don't know", "",
  "Q2. How satisfied are you with Alpha? (ASK IF Q1 = Alpha)",
  "1. Very dissatisfied", "2. Satisfied", "3. Very satisfied", "98. Prefer not to say", "",
  "Q3. Please look at the picture below and tell us what you think. [SHOW IMAGE: pack_shot.png]", "",
  "Q4. How old are you?", "",
  "Q5. Which do you prefer? (ASK IF Q9 = 2)",
  "1. Option one", "2. Option two", "3. No preference",
];
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
type Q = { code: string; type: string; text: string; displayLogic?: unknown; options: { label: string; flags?: string[] }[]; randomization?: { enabled?: boolean } };
async function read(bytes: Uint8Array, name: string) {
  const a = await analyzeImport(bytes, name, { surveyId: "s1", uid });
  assert.ok(a.result?.def, `${name}: ${a.issues.map((i) => i.message).join(" | ")}`);
  return { format: a.detection.format, qs: a.result!.def!.questions as unknown as Q[], issues: [...a.issues, ...a.result!.issues] };
}
const summary = (qs: Q[]) => qs.map((q) => ({
  code: q.code, type: q.type, text: q.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), logic: q.displayLogic ?? null,
  options: q.options.map((o) => `${o.label}${o.flags?.length ? ` [${[...o.flags].sort().join(",")}]` : ""}`), randomized: q.randomization?.enabled === true,
}));

const EXPECTED = [
  { code: "Q1", type: "multi_select", text: "Which of these brands have you heard of? (Select all that apply)", logic: null, randomized: true,
    options: ["Alpha", "Beta", "Gamma", "Other [anchor_bottom,other_specify]", "None of the above [anchor_bottom,exclusive]", "Don't know [anchor_bottom,exclusive]"] },
  { code: "Q2", type: "single_select", text: "How satisfied are you with Alpha?", logic: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 1 }, randomized: false,
    options: ["Very dissatisfied", "Satisfied", "Very satisfied", "Prefer not to say"] },
  { code: "Q3", type: "long_text", text: "Please look at the picture below and tell us what you think. [Image to add: pack_shot.png]", logic: null, randomized: false, options: [] },
  { code: "Q4", type: "numeric", text: "How old are you?", logic: null, randomized: false, options: [] },
  { code: "Q5", type: "single_select", text: "Which do you prefer?", logic: null, randomized: false, options: ["Option one", "Option two", "No preference"] },
];
const findings = (issues: { severity: string; message: string }[]) => ({
  missingAsset: issues.some((i) => i.severity === "high" && /pack_shot\.png.*not in the document.*nothing was substituted/.test(i.message)),
  brokenRef: issues.some((i) => i.severity === "high" && /Q9 is not a question/.test(i.message)),
  anchorsSaid: issues.some((i) => /kept fixed at the end/.test(i.message)),
});

test("plain text, Word and PDF read the same questionnaire identically", async () => {
  const txt = await read(new TextEncoder().encode(LINES.join("\n")), "survey.txt");
  const docx = await read(wordDocFixture(LINES.filter((l) => l !== "")), "survey.docx");
  const pdf = await read(pdfFixture([LINES.slice(0, 16), LINES.slice(16)]), "survey.pdf");
  assert.deepEqual([txt.format, docx.format, pdf.format], ["text", "docx", "pdf"]);
  for (const r of [txt, docx, pdf]) {
    assert.deepEqual(summary(r.qs), EXPECTED, r.format);
    assert.deepEqual(findings(r.issues), { missingAsset: true, brokenRef: true, anchorsSaid: true }, r.format);
  }
});

test("Excel: the same questions, special answers, logic, missing picture and broken reference", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Questionnaire");
  ws.addRow(["Q No.", "Question Text", "Question Type", "Answer Options", "Routing"]);
  ws.addRow(["Q1", "Which of these brands have you heard of?", "Multi", "Alpha\nBeta\nGamma\nOther (please specify)\nNone of the above\nDon't know", "RANDOMIZE"]);
  ws.addRow(["Q2", "How satisfied are you with Alpha?", "Single", "Very dissatisfied\nSatisfied\nVery satisfied\nPrefer not to say", "ASK IF Q1 = Alpha"]);
  ws.addRow(["Q3", "Please look at the picture below and tell us what you think.", "Open", "", "SHOW IMAGE: pack_shot.png"]);
  ws.addRow(["Q4", "How old are you?", "Numeric", "", ""]);
  ws.addRow(["Q5", "Which do you prefer?", "Single", "Option one\nOption two\nNo preference", "ASK IF Q9 = 2"]);
  const x = await read(new Uint8Array(await wb.xlsx.writeBuffer()), "survey.xlsx");
  const got = summary(x.qs);
  assert.deepEqual(got.map((q) => [q.code, q.type]), EXPECTED.map((q) => [q.code, q.code === "Q3" ? "open_text" : q.type]), "the sheet says Open; a document with no type says long text");
  assert.deepEqual(got[0].options, EXPECTED[0].options, "special answers flagged and anchored under RANDOMIZE");
  assert.equal(got[0].randomized, true);
  assert.deepEqual(got[1].logic, EXPECTED[1].logic);
  assert.deepEqual(got[1].options, EXPECTED[1].options, "no exclusive flag on a single choice");
  assert.equal(got[4].logic, null);
  assert.match(got[2].text, /\[Image to add: pack_shot\.png\]/);
  assert.deepEqual(findings(x.issues), { missingAsset: true, brokenRef: true, anchorsSaid: true });
});
