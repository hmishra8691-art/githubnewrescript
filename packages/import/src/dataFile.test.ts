/**
 * A SURVEY DRAFT FROM A DATA FILE (adapters/dataFile.ts): CSV, Excel with a codebook sheet, SPSS .sav.
 * What the file states is used; what its names and values show is inferred and marked for review; what it does
 * not contain — logic above all — is never made up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { Question } from "@rescript/schema";
import { analyzeImport } from "./index.js";
import { looksLikeDataFile, readSavDictionary } from "./adapters/dataFile.js";

const enc = (s: string) => new TextEncoder().encode(s);
const find = (qs: Question[], code: string) => { const q = qs.find((x) => x.code === code); assert.ok(q, code); return q!; };

/* 12 respondents. Q4 is asked only of some (blank otherwise) — a pattern, not a rule. */
const HEAD = "record,uuid,Q1,Q2_1,Q2_2,Q2_3,Q3_1,Q3_2,Q3_3,Q4,Q5r1,Q5r2,Q5r3,AGE,Q6";
const ROWS = [
  "1,a1,1,1,0,1,1,2,3,2,5,4,3,34,Good service",
  "2,a2,2,0,1,0,2,1,3,,4,4,2,51,",
  "3,a3,3,1,1,0,3,2,1,1,5,5,5,27,Too slow",
  "4,a4,1,0,0,1,1,3,2,,3,2,1,45,",
  "5,a5,2,1,0,0,2,3,1,2,4,3,3,62,Fine",
  "6,a6,1,1,1,1,3,1,2,,5,4,4,38,",
  "7,a7,3,0,1,1,1,2,3,1,2,2,2,29,OK",
  "8,a8,2,1,0,1,2,1,3,,4,5,3,55,",
  "9,a9,1,0,1,0,3,2,1,2,3,3,3,41,Great",
  "10,a10,2,1,1,0,1,3,2,,5,4,2,36,",
  "11,a11,3,0,0,1,2,3,1,1,4,4,4,48,No comment at all",
  "12,a12,1,1,0,0,3,1,2,,3,3,1,33,",
];
const CSV = [HEAD, ...ROWS].join("\n");

test("a CSV of responses is recognised as data, and drafted: types inferred from names and values, nothing else", async () => {
  const a = await analyzeImport(enc(CSV), "wave3.csv", { surveyId: "d1" });
  assert.equal(a.detection.importType, "Survey data file");
  const def = a.result!.def!;
  assert.deepEqual(def.questions.map((q) => [q.code, q.type]), [["Q1", "single_select"], ["Q2", "multi_select"], ["Q3", "ranking"], ["Q4", "single_select"], ["Q5", "matrix_single"], ["AGE", "numeric"], ["Q6", "open_text"]]);
  assert.deepEqual(find(def.questions, "Q2").options.map((o) => o.code), [1, 2, 3], "Q2_1…Q2_3 hold 0 / 1: three answers of one multiple choice");
  assert.deepEqual(find(def.questions, "Q3").options.length, 3, "Q3_1…Q3_3 are a 1…3 order in every row: a ranking");
  assert.deepEqual([find(def.questions, "Q5").rows.length, find(def.questions, "Q5").options.map((o) => o.code)], [3, [1, 2, 3, 4, 5]], "Q5r1…r3 share one scale: a grid");
  assert.deepEqual(find(def.questions, "Q1").options.map((o) => o.label), ["Code 1", "Code 2", "Code 3"], "no label in the file: the code, said as a code");
  /* bookkeeping columns are not questions */
  assert.ok(!def.questions.some((q) => /^(record|uuid)$/.test(q.code)));
  /* NOTHING the file does not hold: no logic of any kind, nothing required */
  for (const q of def.questions) { assert.equal(q.displayLogic, undefined, q.code); assert.deepEqual(q.skipLogic, [], q.code); assert.equal(q.required, false, q.code); }
  assert.ok(!JSON.stringify(def.flow).includes('"branch"'));
  /* Q4 is blank for half the sample: reported as probably conditional — and no condition is created */
  const cond = a.result!.issues.find((i) => i.location === "conditions")!;
  assert.match(cond.message, /Q4/);
  assert.match(cond.message, /no condition was created/);
  assert.ok(a.result!.issues.some((i) => i.location === "answer texts" && i.severity === "high" && /Q1/.test(i.message)), "missing answer texts are asked for");
  assert.ok(a.result!.issues.some((i) => /not a questionnaire/.test(i.message) && /none was added/.test(i.message)));
  assert.deepEqual(a.result!.quality!.errors, [], "the draft is a survey the engine accepts");
});

test("a questionnaire written as a table is still a questionnaire, not a data file", () => {
  assert.equal(looksLikeDataFile([["Question", "Type", "Options"], ["How old are you?", "numeric", ""], ["Gender", "single", "Male; Female"], ["City", "text", ""]]), false);
  assert.equal(looksLikeDataFile([HEAD.split(","), ...ROWS.map((r) => r.split(","))]), true);
});

test("an Excel data file with a codebook sheet: labels and answer texts are explicit", async () => {
  const wb = new ExcelJS.Workbook();
  const data = wb.addWorksheet("Data");
  data.addRow(HEAD.split(","));
  for (const r of ROWS) data.addRow(r.split(",").map((c) => (/^-?\d+$/.test(c) ? Number(c) : c)));
  const cb = wb.addWorksheet("Codebook");
  cb.addRow(["Variable", "Label", "Values"]);
  cb.addRow(["Q1", "Which brand do you use most?", "1=Alpha; 2=Beta; 3=Gamma"]);
  cb.addRow(["Q2_1", "Brands heard of - Alpha", "0=No; 1=Yes"]);
  cb.addRow(["Q2_2", "Brands heard of - Beta", "0=No; 1=Yes"]);
  cb.addRow(["Q2_3", "Brands heard of - Gamma", "0=No; 1=Yes"]);
  cb.addRow(["Q4", "Would you recommend it?", "1=Yes; 2=No"]);
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);
  const a = await analyzeImport(bytes, "wave3.xlsx", { surveyId: "d2" });
  const def = a.result!.def!;
  assert.equal(find(def.questions, "Q1").text, "Which brand do you use most?");
  assert.deepEqual(find(def.questions, "Q1").options.map((o) => [o.code, o.label]), [[1, "Alpha"], [2, "Beta"], [3, "Gamma"]]);
  assert.equal(find(def.questions, "Q2").text, "Brands heard of");
  assert.deepEqual(find(def.questions, "Q2").options.map((o) => o.label), ["Alpha", "Beta", "Gamma"], "the part of each label after the shared stem");
  assert.ok(a.result!.issues.some((i) => i.location === "metadata" && /explicit/.test(i.message)));
  assert.ok(!a.result!.issues.find((i) => i.location === "answer texts")?.message.includes("Q1,"), "Q1 has its texts now");
});

/* a minimal SPSS system file: header, variable records, one value-label set, long names, end of dictionary */
function sav(): Uint8Array {
  const parts: number[] = [];
  const i32 = (n: number) => { const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, n, true); parts.push(...new Uint8Array(b.buffer)); };
  const f64 = (n: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, n, true); parts.push(...new Uint8Array(b.buffer)); };
  const str = (s: string, len: number) => { const b = new TextEncoder().encode(s.padEnd(len, " ")).subarray(0, len); parts.push(...b); };
  str("$FL2", 4); str("@(#) SPSS DATA FILE test", 60); i32(2); i32(3); i32(0); i32(0); i32(-1); f64(100); str("12 Nov 26", 9); str("10:00:00", 8); str("", 64); str("", 3);
  const variable = (name: string, type: number, label?: string, missing: number[] = []) => { i32(2); i32(type); i32(label ? 1 : 0); i32(missing.length); i32(0); i32(0); str(name, 8); if (label) { i32(label.length); str(label, Math.ceil(label.length / 4) * 4); } for (const m of missing) f64(m); };
  variable("Q1", 0, "Overall satisfaction", [99]);
  variable("V2", 0, "Number of visits");
  variable("Q3", 16, "Comments"); variable("", -1); /* a 16-byte string takes a second slot */
  i32(3); i32(3); for (const [v, l] of [[1, "Satisfied"], [2, "Neutral"], [99, "Refused"]] as [number, string][]) { f64(v); parts.push(l.length); str(l, Math.ceil((l.length + 1) / 8) * 8 - 1); }
  i32(4); i32(1); i32(1);
  const names = "V2=VisitsLastYear"; i32(7); i32(13); i32(1); i32(names.length); str(names, names.length);
  i32(999); i32(0);
  return new Uint8Array(parts);
}

test("an SPSS .sav: variable labels, value labels, missing values and long names come from the dictionary", async () => {
  const vars = readSavDictionary(sav());
  assert.deepEqual(vars.map((v) => [v.name, v.label, v.string ?? false]), [["Q1", "Overall satisfaction", false], ["VisitsLastYear", "Number of visits", false], ["Q3", "Comments", true]]);
  assert.deepEqual(vars[0].values, [["1", "Satisfied"], ["2", "Neutral"], ["99", "Refused"]]);
  assert.deepEqual(vars[0].missing, ["99"]);
  const a = await analyzeImport(sav(), "study.sav", { surveyId: "d3" });
  assert.equal(a.detection.format, "sav");
  const def = a.result!.def!;
  assert.deepEqual(def.questions.map((q) => [q.code, q.type, q.text]), [["Q1", "single_select", "Overall satisfaction"], ["VisitsLastYear", "numeric", "Number of visits"], ["Q3", "open_text", "Comments"]]);
  assert.deepEqual(find(def.questions, "Q1").options.map((o) => [o.code, o.label]), [[1, "Satisfied"], [2, "Neutral"]], "the declared missing value 99 is not offered as an answer");
  assert.match(find(def.questions, "Q1").notes ?? "", /missing \/ special values[^\n]*99/);
});
