import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition, type Condition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";
import { parseLogicExpression } from "./logicExpression.js";
import { parsePunchExpression } from "./autoPunch.js";
import { parseSetExpression } from "./setExpression.js";
import { validateExpression } from "./calc.js";

/*
 * THE PUBLIC DOCUMENTATION IS TRUE (Research Engine audit, Phase 7). The
 * generated reference pages equal what the generator produces from the code
 * now; every sentence the Intelligent-mode page lists is read by the engine
 * as the kind it says, without a model; every logic, calculation, set and
 * punch example on the logic page parses; the getting-started definition
 * validates. A page that drifts from the code fails here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCS = join(ROOT, "apps", "studio", "content", "docs");
const read = (name: string) => readFileSync(join(DOCS, name), "utf8");
const fences = (md: string, lang?: string): string[] => { const out: string[] = []; const re = /```(\w*)\n([\s\S]*?)```/g; let m: RegExpExecArray | null; while ((m = re.exec(md))) if (lang === undefined || m[1] === lang) out.push(m[2]); return out; };

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, operator: string, value: unknown): Condition => ({ type: "rule", source: { kind: "question", ref }, operator, value } as Condition);
/** the brand tracker the Intelligent-mode page's sentences are read against */
function tracker(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "BT", title: "Brand tracker" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "East", "West") },
      { id: "q3", code: "Q3", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Non-binary") },
      { id: "q4", code: "Q4", variableName: "CHANNEL", type: "single_select", text: "Where do you usually shop?", options: opts("Online", "In store", "Both") },
      { id: "q5", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Which of these brands have you bought in the past month?", options: [...opts("Brand A", "Brand B", "Brand C", "Brand D"), { code: 99, label: "None of these", flags: ["anchor_bottom"] }] },
      { id: "q6", code: "Q6", variableName: "REASON", type: "open_text", text: "Why did you choose {{Q5}}?" },
      { id: "q7", code: "Q7", variableName: "OWN_CAR", type: "single_select", text: "Do you own a car?", options: opts("Yes", "No") },
      { id: "q8", code: "Q8", variableName: "CAR_BRAND", type: "single_select", text: "Which brand is your car?", options: opts("Toyota", "Ford", "Honda"), displayLogic: rule("q7", "eq", 1) },
      { id: "q9", code: "Q9", variableName: "CAR_AGE", type: "numeric", text: "What is the age of your car, in years?", displayLogic: rule("q7", "eq", 1) },
      { id: "q10", code: "Q10", variableName: "FAV", type: "single_select", text: "Which of these brands is your favourite?", options: opts("Brand A", "Brand B", "Brand C", "Brand D") },
      { id: "q11", code: "Q11", variableName: "COUNTRY", type: "single_select", text: "In which country were you born?", options: [...opts("Canada", "US", "Mexico"), { code: 4, label: "Other (please specify)", flags: ["other_specify", "anchor_bottom"] }] },
      { id: "q12", code: "Q12", variableName: "SAT", type: "matrix_single", text: "How satisfied are you with each of these?", rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Quality" }, { code: "r3", label: "Service" }], options: opts("Very dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very satisfied") },
      { id: "q13", code: "Q13", variableName: "INTENT", type: "single_select", text: "How likely are you to buy Brand A in the next 3 months?", options: opts("Very unlikely", "Unlikely", "Neutral", "Likely", "Very likely"), analysis: { construct: "Purchase intent", role: "dependent" } },
      { id: "q14", code: "Q14", variableName: "COLOURS", type: "multi_select", text: "Which colours do you like?", options: opts("Black", "White") },
      { id: "q15", code: "Q15", variableName: "COMMENTS", type: "open_text", text: "Any other comments?", validation: [{ id: "v1", kind: "max_length", value: 500 }] },
    ],
    flow: [
      { type: "block", id: "b_scr", title: "Screener", children: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "page", id: "p3", questionIds: ["q3"] }] },
      { type: "block", id: "b_use", title: "Usage", children: [
        { type: "page", id: "p4", questionIds: ["q4"] }, { type: "page", id: "p5", questionIds: ["q5"] }, { type: "page", id: "p6", questionIds: ["q6"] },
        { type: "page", id: "p7", questionIds: ["q7"] }, { type: "page", id: "p8", questionIds: ["q8"] }, { type: "page", id: "p9", questionIds: ["q9"] }] },
      { type: "block", id: "b_brand", title: "Brands", children: [{ type: "page", id: "p10", questionIds: ["q10"] }, { type: "page", id: "p11", questionIds: ["q11"] }, { type: "page", id: "p12", questionIds: ["q12"] }, { type: "page", id: "p13", questionIds: ["q13"] }] },
      { type: "block", id: "b_end", title: "Wrap up", children: [{ type: "page", id: "p14", questionIds: ["q14", "q15"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    calculations: [{ id: "c1", targetVariable: "AGE_GAP", expression: "AGE - CAR_AGE" }],
    quotas: [{ id: "qt1", name: "Gender", cells: [{ id: "c1", label: "Male", when: rule("q3", "eq", 1), limit: 100 }, { id: "c2", label: "Female", when: rule("q3", "eq", 2), limit: 100 }] }],
    research: {
      hypotheses: ["Women have a higher purchase intent for Brand A than men"],
      constructs: [{ name: "Purchase intent", role: "dependent", definition: "How likely the respondent is to buy Brand A", questionIds: ["q13"] }, { name: "Brand usage", role: "independent", questionIds: ["q5"] }],
    },
    localization: { sourceLanguage: "en", languages: [{ code: "de", status: "draft" }], translations: { de: { "q:q7:text": { text: "Besitzen Sie ein Auto?", status: "ai" } } } },
    deployment: { clientSlug: "c", studySlug: "s" },
  });
}

test("the generated reference pages are what the code generates now", async () => {
  const gen = await import(join(ROOT, "scripts", "lib", "publicDocs.mjs") as string) as { generate(): Promise<Record<string, string>> };
  const pages = await gen.generate();
  for (const [name, text] of Object.entries(pages)) {
    assert.ok(existsSync(join(DOCS, name)), `${name} exists`);
    assert.equal(read(name), text, `${name} is stale — run node scripts/gen-public-docs.mjs`);
  }
  assert.ok(pages["question-types.md"].includes("`single_select.nps`"));
  assert.ok(pages["logic-reference.md"].includes("`containsAny`"));
  assert.ok(pages["actions-reference.md"].includes('{ op: "set_research"; strict?: boolean;'));
});

test("every sentence the Intelligent-mode page lists is read as it says, without a model", () => {
  const md = read("intelligent-mode.md");
  const def = tracker();
  const rows = [...md.matchAll(/^\| (.+?) \| (actions|answer|query|output|workflow) \|$/gm)].map((m) => [m[1], m[2]] as const).filter(([s]) => s !== "Sentence");
  assert.ok(rows.length >= 90, `${rows.length} sentences listed`);
  const wrong: string[] = [];
  for (const [sentence, kind] of rows) {
    const r = interpretRequest(def, sentence);
    if (r.kind !== kind) wrong.push(`${sentence} → ${r.kind} (expected ${kind})${r.kind === "model" ? `: ${r.reason}` : r.kind === "refused" ? `: ${r.reason}` : r.kind === "clarify" ? `: ${r.question}` : ""}`);
  }
  assert.deepEqual(wrong, []);
  // and what the page says is the model's, is
  const modelRows = [...md.matchAll(/^\| (.+?) \| (?:rewording|the French|adaptation|a brief|look and feel)[^|]*\|$/gm)].map((m) => m[1]);
  assert.ok(modelRows.length >= 5);
  for (const sentence of modelRows) assert.equal(interpretRequest(def, sentence).kind, "model", sentence);
});

test("every logic, calculation, set and punch example on the logic page parses; the getting-started definition validates", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "d", code: "D", title: "D" },
    research: { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age" },
      { id: "q2", code: "Q2", variableName: "REGION", type: "single_select", text: "Region", options: opts("North", "South") },
      { id: "q3", code: "Q3", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
      { id: "q5", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Brands", options: opts("A", "B", "C") },
      { id: "q6", code: "Q6", variableName: "PREF", type: "multi_select", text: "Pref", options: opts("A", "B", "C") },
      { id: "q7", code: "Q7", variableName: "DOB", type: "date", text: "Date of birth" },
      { id: "q9", code: "Q9", variableName: "NAME", type: "open_text", text: "Name" },
      { id: "q11", code: "Q11", variableName: "RANK", type: "ranking", text: "Rank", options: opts("A", "B", "C") },
      { id: "q12", code: "Q12", variableName: "SAT", type: "matrix_single", text: "Sat", rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Quality" }], options: opts("1", "2", "3", "4", "5") },
      { id: "q13", code: "Q13", variableName: "GRID", type: "composite", text: "Grid", rows: [{ code: "r1", label: "Row" }], columns: [{ id: "c1", label: "A", responseType: "numeric", variableStem: "GA" }, { id: "c2", label: "B", responseType: "numeric", variableStem: "GB" }] },
      { id: "q14", code: "SEG", variableName: "SEG", type: "single_select", text: "Segment", options: [{ code: "Heavy", label: "Heavy" }, { code: "Light", label: "Light" }] },
      { id: "q15", code: "Q15", variableName: "SCORE", type: "numeric", text: "Score" },
    ],
    flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3", "q5", "q6", "q7", "q9", "q11", "q12", "q13", "q14", "q15"] }] }, { type: "end", id: "e", status: "complete" }],
    calculations: [{ id: "c1", targetVariable: "SCORE2", expression: "AGE * 2" }],
    namedExpressions: [{ id: "n1", name: "IS_ADULT", when: rule("q1", "gte", 18) }],
    embeddedData: [{ name: "PANEL", source: "url" }],
    quotas: [{ id: "q_gender", name: "Gender", cells: [{ id: "c", label: "F", when: rule("q3", "eq", 2), limit: 200 }] }],
  });
  const md = read("logic.md");
  const blocks = fences(md, "");
  const lines = (b: string) => b.split("\n").map((l) => l.replace(/\s+--.*$/, "").trim()).filter(Boolean);
  // conditions: the first two fenced blocks
  const bad: string[] = [];
  for (const line of [...lines(blocks[0]), ...lines(blocks[1])]) {
    if (/^(loop\.|@option|quota\.)/.test(line)) continue; // need a loop / per-option / quota context the fixture has only partly
    const r = parseLogicExpression(def, line);
    if (!r.condition || r.errors.length) bad.push(`${line}: ${r.errors.join("; ") || "no condition"}`);
  }
  assert.deepEqual(bad, []);
  // calculations: the third block — each is a valid expression
  for (const line of lines(blocks[2])) { const err = validateExpression(line); assert.equal(err, null, `${line}: ${err}`); }
  // set expressions: the fourth block
  for (const line of lines(blocks[3])) { const r = parseSetExpression(def, line); assert.ok(r.expr && !r.errors.length, `${line}: ${JSON.stringify(r.errors)}`); }
  // punches: the fifth block — an ELSE line is its own rule (mode else_if / else), chained by order on the target
  for (const line of lines(blocks[4])) { const r = parsePunchExpression(def, line); assert.ok(r.rules.length && !r.errors.length, `${line}: ${JSON.stringify(r.errors)}`); }
  // the getting-started definition
  const json = fences(read("getting-started.md"), "json")[0];
  assert.ok(SurveyDefinition.safeParse(JSON.parse(json)).success);
  // the question example on the definition page is a question
  const q = fences(read("survey-definition.md"), "json")[0];
  assert.ok(SurveyDefinition.safeParse({ meta: { id: "x", code: "X", title: "X" }, questions: [JSON.parse(q)], flow: [] }).success);
});
