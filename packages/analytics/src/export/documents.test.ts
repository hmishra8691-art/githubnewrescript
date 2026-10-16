import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { SurveyDefinition, AnalysisPlan } from "@rescript/schema";
import { buildProposalDocx } from "./docx.js";
import { buildSapDocx } from "./sap.js";

/*
 * DOC-02 / DOC-03 — the research proposal's missing sections (sampling design, screening, timeline, ethics, the
 * label on a plan nobody saved) and the standalone statistical analysis plan, read back from the .docx.
 */

function docxText(buf: Buffer): string {
  const name = Buffer.from("word/document.xml");
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    if (nameLen !== name.length || !buf.subarray(i + 30, i + 30 + nameLen).equals(name)) continue;
    return inflateRawSync(buf.subarray(i + 30 + nameLen + extraLen)).toString("utf8").replace(/<[^>]+>/g, " ").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  }
  return "";
}

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, operator: string, value: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator, value });

const QUESTIONS = [
  { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?", skipLogic: [{ id: "s", when: rule("AGE", "lt", 18), target: { kind: "terminate", status: "screened" } }] },
  { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
  { id: "q3", code: "Q3", variableName: "PREF", type: "single_select", text: "Preferred brand", options: opts("Brand A", "Brand B", "Brand C") },
  { id: "q4", code: "Q4", variableName: "SAT", type: "single_select", text: "Satisfaction", options: opts("1", "2", "3", "4", "5"), displayLogic: rule("PREF", "eq", 1) },
];
function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "STUDY", title: "Brand health", version: "2.1" },
    research: { objective: "Understand what drives brand preference", population: "Adults 18+ who bought in the last year", hypotheses: ["Women prefer Brand A more than men do"], sampleSize: 400 },
    questions: QUESTIONS,
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }, { type: "end", id: "e", status: "complete" }],
    quotas: [{ id: "qt1", name: "Gender", mode: "hard", cells: [{ id: "c1", label: "Male", when: rule("GENDER", "eq", 1), limit: 200, target: 200 }, { id: "c2", label: "Female", when: rule("GENDER", "eq", 2), limit: 200 }], onFull: { kind: "terminate" } }],
    ...extra,
  });
}

test("DOC-02: the proposal has a sampling design from the quotas, the screening rules, a timeline with placeholders and an ethics statement", async () => {
  const t = docxText(await buildProposalDocx(survey(), { date: "2026-10-16" }));
  // sampling design
  assert.match(t, /Sampling design Quota sample: 1 quota \(1 hard, 0 soft\), 2 cells\./);
  assert.match(t, /Gender \(hard\) Male .* 200 200 close \(screen out\)/);
  assert.match(t, /Female .* 200 — close/);
  // screening: the terminate rule, with its condition in words
  assert.match(t, /Screening and eligibility Eligible population: Adults 18\+ who bought in the last year\./);
  assert.match(t, /Q1 — How old are you\? .*18.* screened out/);
  // timeline: no dates anywhere, so placeholders and the sentence that says so
  assert.match(t, /Timeline Phase Dates Notes Questionnaire sign-off \[to be agreed\]/);
  assert.match(t, /Fieldwork \[to be agreed\] Target 400 completes/);
  assert.match(t, /no fieldwork dates and the brief no deadline/);
  // ethics: the questionnaire has no consent item, and the document says so before the standard statement
  assert.match(t, /Ethics, consent and data protection The questionnaire has no consent statement yet; the standard statement below applies/);
  assert.match(t, /Participation is voluntary\./);
  assert.match(t, /Definition [0-9a-f]{16} · survey STUDY v2\.1 · generated 2026-10-16/);
});

test("DOC-02: dates and a deadline replace the placeholders; the questionnaire's own consent item is quoted; a bare survey with no quotas or screening says so", async () => {
  const def = survey({ quotas: [], questions: [...QUESTIONS, { id: "q0", code: "C1", variableName: "CONSENT", type: "single_select", text: "I consent to take part in this research and agree to the privacy notice.", options: opts("I agree", "I do not agree") }] });
  def.questions[0].skipLogic = [];
  def.research!.brief = { stakeholders: [], deliverables: [], deadline: "30 November 2026" } as never;
  const t = docxText(await buildProposalDocx(def, { fieldwork: { from: "2026-11-01", to: "2026-11-21" } }));
  assert.match(t, /Fieldwork 2026-11-01 to 2026-11-21 Target 400 completes/);
  assert.match(t, /Analysis and findings by 30 November 2026/);
  assert.doesNotMatch(t, /no fieldwork dates and the brief no deadline/);
  assert.match(t, /The questionnaire carries its own consent statement \(C1\): “I consent to take part in this research/);
  assert.match(t, /Respondents answer: I agree \/ I do not agree\./);
  assert.match(t, /No quotas are defined: respondents are taken as they come/);
  assert.match(t, /No screening or termination logic is programmed/);
});

test("DOC-02: a plan nobody saved is labelled as derived; a saved plan is not", async () => {
  const unsaved = docxText(await buildProposalDocx(survey()));
  assert.match(unsaved, /Analysis plan \(derived from the design — not yet saved\) No analysis plan has been saved for this survey\./);
  const def = survey();
  def.research!.analysisPlan = AnalysisPlan.parse({ tests: [{ id: "t1", method: "chi_square", variables: ["GENDER", "PREF"], hypotheses: ["H1"] }] });
  const saved = docxText(await buildProposalDocx(def));
  assert.doesNotMatch(saved, /not yet saved/);
  assert.match(saved, /\d\. Analysis plan Analysis Serves Why this method Output Base/);
});

test("DOC-03: the schema takes the SAP decisions as optional fields, validates them, and a plan without them is unchanged", () => {
  const old = AnalysisPlan.parse({ tests: [{ id: "t1", method: "t_test", variables: ["SAT"], groupBy: "GENDER" }] });
  for (const k of ["alpha", "multipleComparisons", "weighting", "missingData", "sampleSize", "interimAnalyses", "software"]) assert.ok(!(k in old), `${k} is absent unless set`);
  const full = AnalysisPlan.parse({ alpha: 0.01, multipleComparisons: "bh", weighting: "rim weights to age × gender", missingData: "pairwise", sampleSize: { target: 400, rationale: "±5% at 95%" }, interimAnalyses: "none", software: "SPSS 29" });
  assert.equal(full.alpha, 0.01); assert.equal(full.sampleSize?.target, 400);
  assert.equal(AnalysisPlan.safeParse({ alpha: 1.5 }).success, false);
  assert.equal(AnalysisPlan.safeParse({ alpha: 0 }).success, false);
  assert.equal(AnalysisPlan.safeParse({ multipleComparisons: "sidak" }).success, false);
  assert.equal(AnalysisPlan.safeParse({ missingData: "mean_impute" }).success, false);
  assert.equal(AnalysisPlan.safeParse({ sampleSize: { target: -3 } }).success, false);
});

test("DOC-03: the statistical analysis plan — sections, methods with their reasons, defaults marked as defaults, the definition hash", async () => {
  const def = survey();
  def.research!.analysisPlan = AnalysisPlan.parse({
    crosstabs: [{ id: "x1", rows: ["PREF"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }],
    tests: [{ id: "t1", method: "chi_square", outcome: "PREF", variables: ["GENDER"], groupBy: "GENDER", hypotheses: ["H1"], priority: 1 }, { id: "t2", method: "t_test", outcome: "AGE", groupBy: "GENDER", variables: ["AGE"], priority: 2 }],
    derived: [{ name: "SAT_TOP2", kind: "top_box", from: ["SAT"], reason: "the satisfaction KPI" }],
  });
  const buf = await buildSapDocx(def, { client: "Acme", date: "2026-10-16" });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const t = docxText(buf);
  assert.match(t, /STATISTICAL ANALYSIS PLAN Understand what drives brand preference Prepared for Acme 2026-10-16 Survey: Brand health v2\.1 Definition [0-9a-f]{16} · survey STUDY v2\.1/);
  for (const h of ["1. Objectives and hypotheses", "2. Populations, bases and dataset scope", "3. Variables and derived variables", "4. Planned analyses", "5. Statistical conventions", "6. Sample size", "7. Interim analyses and software"]) assert.ok(t.includes(h), h);
  assert.match(t, /H1 Women prefer Brand A more than men do/);
  assert.match(t, /Q4 Satisfaction Q3 is “Brand A”/, "the subset base is stated in words");
  // variables with coding, derived variables
  assert.match(t, /GENDER Q2 — Gender .* 1 = Male; 2 = Female/);
  assert.match(t, /SAT_TOP2 top box SAT the satisfaction KPI/);
  // methods, with the test named and a reason
  assert.match(t, /Pearson chi-square test of independence/);
  assert.match(t, /Independent-samples t-test \(Welch\)/);
  assert.match(t, /Crosstabulation \(column percentages; significance between columns\)/);
  // defaults are labelled as defaults, nothing recorded is mislabelled
  assert.match(t, /Significance level \(α\) 0\.05, two-sided default — not recorded in the plan/);
  assert.match(t, /Multiple comparisons Holm, within each hypothesis family default — not recorded in the plan/);
  assert.match(t, /Weighting None \(unweighted\) default — not recorded in the plan/);
  assert.match(t, /Missing data listwise default — not recorded in the plan/);
  assert.doesNotMatch(t, /derived by the engine from the questionnaire/, "the plan is saved");
  // the target comes from the research design, the minimum from the plan
  assert.match(t, /Target: 400 completes\./);
  assert.match(t, /The plan needs at least \d+ completes/);
  // deterministic: the same definition hashes the same, a change to it changes the hash
  const hash = (x: string) => /Definition ([0-9a-f]{16})/.exec(x)![1];
  assert.equal(hash(docxText(await buildSapDocx(def, { date: "2026-10-16" }))), hash(t));
  const changed = survey(); changed.research!.objective = "Something else";
  assert.notEqual(hash(docxText(await buildSapDocx(changed, { date: "2026-10-16" }))), hash(t));
});

test("DOC-03: recorded decisions are printed as decisions; an unsaved plan is labelled derived", async () => {
  const def = survey();
  def.research!.analysisPlan = AnalysisPlan.parse({
    tests: [{ id: "t1", method: "anova", outcome: "AGE", groupBy: "PREF", variables: ["AGE"] }],
    alpha: 0.01, multipleComparisons: "bonferroni", weighting: "Rim weights to age × gender, capped 0.3–3", missingData: "pairwise",
    sampleSize: { target: 600, rationale: "±4% at 95% on the total" }, interimAnalyses: "Topline at 100 completes, no stopping rule", software: "SPSS 29",
  });
  const t = docxText(await buildSapDocx(def));
  assert.match(t, /Significance level \(α\) 0\.01, two-sided recorded in the plan/);
  assert.match(t, /Multiple comparisons Bonferroni recorded in the plan/);
  assert.match(t, /Tests are read at α = 0\.01 \(two-sided\)\. Bonferroni: each p-value is multiplied/);
  assert.match(t, /Weighting Rim weights to age × gender, capped 0\.3–3 recorded in the plan/);
  assert.match(t, /Missing data pairwise recorded in the plan/);
  assert.match(t, /Target: 600 completes\. ±4% at 95% on the total/);
  assert.match(t, /Topline at 100 completes, no stopping rule/);
  assert.match(t, /SOFTWARE SPSS 29/);
  assert.doesNotMatch(t, /default — not recorded/);
  assert.match(t, /One-way analysis of variance/);
  // no saved plan: the engine's plan is labelled
  const none = docxText(await buildSapDocx(survey()));
  assert.match(none, /No analysis plan has been saved for this survey\. The analyses in this document were derived by the engine/);
});
