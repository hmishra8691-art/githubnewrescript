import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImport } from "./index.js";

/** I8 — the Word corpus (synthetic) and the invalid-QSF corpus: what each must produce, and what it must say */
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const load = (dir: string, f: string) => analyzeImport(new Uint8Array(readFileSync(join(CORPUS, dir, f))), f, { surveyId: "s", uid });
const codes = (a: Awaited<ReturnType<typeof load>>) => a.result!.def!.questions.map((q) => `${q.code}:${q.type}`);

test("word corpus: seven files, each read as Word and imported", async () => {
  const files = readdirSync(join(CORPUS, "word")).filter((f) => f.endsWith(".docx"));
  assert.equal(files.length, 7);
  for (const f of files) {
    const a = await load("word", f);
    assert.equal(a.detection.format, "docx", f);
    assert.ok(a.result?.def && a.result.def.questions.length > 0, f);
  }
});

test("word: simple, tables with a nested table and a picture, poorly formatted", async () => {
  const s = await load("word", "01-simple.docx");
  assert.deepEqual(codes(s), ["Q1:single_select", "Q2:single_select", "Q3:long_text"]);
  assert.equal(s.result!.def!.questions[0].options!.length, 5);
  const t = await load("word", "03-tables-nested.docx");
  const grid = t.result!.def!.questions.find((q) => q.code === "Q1")!;
  assert.equal(grid.type, "matrix_single");
  assert.equal(grid.rows!.length, 2);
  const pic = t.result!.def!.questions.find((q) => q.code === "Q2")!;
  assert.match(pic.text, /<img [^>]*src="data:image\/png;base64,/);
  assert.match(pic.text, /alt="Two pack designs side by side"/);
  assert.match(t.result!.def!.questions.find((q) => q.code === "Q3")!.text, /Taste \| Price/, "a nested table's cells survive as lines");
  const p = await load("word", "06-poorly-formatted.docx");
  const q1 = p.result!.def!.questions[0];
  assert.equal(q1.options!.length, 3, "lettered answers a) b) c)");
  const q2 = p.result!.def!.questions[1];
  assert.ok(q2.displayLogic, "the lower-case [ask if q1 = c] is read");
});

test("word: complex instructions are logic — screener codes (S1), TERMINATE IF, IF … SKIP TO, ASK IF, RANDOMIZE … EXCEPT", async () => {
  const a = await load("word", "02-complex-instructions.docx");
  const c = a.canonical!;
  const S1 = c.questions.find((q) => q.code === "S1")!;
  assert.deepEqual(S1.skips.map((s) => s.to), [{ kind: "end", status: "screened" }]);
  const S2 = c.questions.find((q) => q.code === "S2")!;
  assert.deepEqual(S2.skips.map((s) => s.to), [{ kind: "question", id: "Q4" }]);
  assert.ok(c.questions.find((q) => q.code === "Q2")!.displayLogic);
  const q1 = a.result!.def!.questions.find((q) => q.code === "Q1")!;
  assert.equal(q1.type, "multi_select");
  assert.equal(a.canonical!.issues.filter((i) => i.severity === "high").length, 0, a.canonical!.issues.map((i) => i.message).join(" | "));
});

test("word: contradictions and missing information become questions for the person, never guesses", async () => {
  const c = await load("word", "04-contradictory.docx");
  const kinds = c.report!.clarifications.map((x) => x.kind);
  assert.ok(kinds.includes("conflict"), kinds.join(","));
  assert.ok(c.canonical!.issues.some((i) => /skip to “Q9”/.test(i.message)));
  const m = await load("word", "05-missing-information.docx");
  const mk = m.report!.clarifications.map((x) => x.kind).sort();
  assert.deepEqual(mk, ["missing_condition", "missing_condition", "missing_target"]);
  assert.equal(m.result!.def!.questions.filter((q) => q.displayLogic).length, 0, "nothing invented");
});

test("word: an instruction in wording the reader does not know is REPORTED, not dropped", async () => {
  const { wordDocFixture } = await import("./fixtures.js");
  const doc = wordDocFixture(["Q1. Do you cook?", "1. Yes", "2. No", "Q2. What do you cook?", "[ONLY FOR THE KITCHEN-PROUD AMONG THEM]", "1. Pasta", "2. Rice"]);
  const a = await analyzeImport(doc, "odd.docx", { surveyId: "s", uid });
  assert.ok(a.canonical!.issues.some((i) => i.type === "dropped" && /KITCHEN-PROUD/.test(i.message) && /not turned into logic/.test(i.message)), a.canonical!.issues.map((i) => i.message).join(" | "));
});

test("word: a 150-question document keeps every question and every rule", async () => {
  const a = await load("word", "07-large.docx");
  assert.equal(a.result!.def!.questions.length, 150);
  assert.equal(a.result!.def!.questions.filter((q) => q.displayLogic).length, 30);
  assert.equal(a.report!.detected.blocks, 10);
});

test("invalid QSF corpus: each broken export is refused or degraded WITH a reason — none crashes, none imports in silence", async () => {
  const files = readdirSync(join(CORPUS, "qsf-invalid")).sort();
  assert.equal(files.length, 6);
  const said: Record<string, string> = {};
  for (const f of files) {
    const a = await load("qsf-invalid", f);
    const messages = [...(a.issues ?? []), ...(a.canonical?.issues ?? [])].map((i) => i.message).join(" | ");
    assert.ok(messages.length > 0, `${f}: says nothing`);
    said[f] = messages;
  }
  assert.match(said["02-truncated.qsf"], /not valid JSON/);
  assert.match(said["03-no-elements.qsf"], /could not be imported/);
  assert.match(said["04-elements-not-array.qsf"], /SurveyElements is not a list/);
  assert.match(said["05-question-without-choices.qsf"], /no choices in the file/);
  assert.match(said["05-question-without-choices.qsf"], /QID404, which is not in the file/);
  assert.match(said["06-flow-cycle.qsf"], /BL_missing, which is not in the file/);
  assert.match(said["01-not-json.qsf"], /No questions were recognised/);
});
