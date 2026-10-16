import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as A from "/home/claude/rescript/packages/analytics/dist/index.js";
import { buildAnalysisFramework } from "/home/claude/rescript/packages/engine/dist/index.js";

const def = SurveyDefinition.parse({
  meta: { id: "ctl", code: "CTL", title: "Controlled", version: "1.0" },
  questions: [
    { id: "q_gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
    { id: "q_sat", code: "Q6", variableName: "SAT", type: "single_select", text: "Satisfaction", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `${c}` })) },
    { id: "q_age", code: "Q3", variableName: "AGE", type: "numeric", text: "Age" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_gender", "q_sat", "q_age"] }],
  research: { analysisPlan: {
    crosstabs: [
      { id: "x1", rows: ["Q6"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] },     // row by CODE
      { id: "x2", rows: ["SAT"], columns: ["REGION"], priority: 2 },                        // column does not exist
      { id: "x3", rows: ["SAT"], columns: ["GENDER"], priority: 1 },                         // fine
    ],
    tests: [
      { id: "t1", method: "t_test", outcome: "AGE", groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
      { id: "t2", method: "anova", outcome: "NOPE", groupBy: "GENDER", priority: 2 },
    ],
    derived: [{ name: "SAT_T2B", kind: "top_box", from: ["SAT"] }, { name: "BAD", kind: "mean_score", from: ["GHOST"] }],
    segments: [{ name: "Gender", by: ["GENDER"] }],
  } },
});
const rows = [];
for (let i = 0; i < 40; i++) rows.push({ id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, started_at: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString(), completed_at: new Date(Date.UTC(2026, 9, 1, 10, i + 5)).toISOString(), answers: { q_gender: i % 2 ? 2 : 1, q_sat: 1 + (i % 5), q_age: 20 + i }, calculated: {}, embedded: {}, flags: [] });
const spec = { environment: "LIVE", dataset: "all" };
const ds0 = A.buildDataset(def, rows, { spec });
const pv = A.withPlannedVariables(def, ds0);
console.log("planned variables computed:", pv.computed, "warnings:", pv.warnings);
const ds = pv.dataset;
const items = A.plannedAnalyses(def, spec);
console.log("planned items:", items.map((i) => `${i.source.kind}:${i.source.id ?? i.source.questionId} vars=${i.definition.variables.join(",")}`));
const vars = [...ds.byName.values()];
const review = A.reviewPlanned(items, vars, A.surveyKnownNames(def, vars));
console.log("kept:", review.kept.map((k) => k.definition.options.planned));
console.log("blocked:", review.blocked.map((b) => `${b.item.definition.options.planned}: ${b.reason}`));
console.log("duplicates:", review.duplicates.map((b) => `${b.item.definition.options.planned}: ${b.reason}`));
for (const k of review.kept) {
  const r = A.runAnalysis(k.definition, ds);
  console.log(`RUN ${k.definition.options.planned}: base.n=${r.base.n} tables=${r.tables.length} error=${r.error?.code ?? "-"} warnings=${JSON.stringify(r.warnings)}`);
}
// the engine-built default framework: what names does it use?
const fw = buildAnalysisFramework(def);
console.log("engine framework crosstabs:", JSON.stringify(fw.crosstabs.slice(0, 3)), "tests:", JSON.stringify(fw.tests.slice(0, 2)));
// runPlan
const run = A.runPlan(def, ds, spec, { trigger: "audit" });
console.log("runPlan n:", run.n, "items:", run.items.map((it) => `${it.definition.options?.planned}:${it.status ?? ""}:${it.result?.error?.code ?? "ok"}`), "verdicts:", JSON.stringify(run.verdicts), "warnings:", run.warnings);
