import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { coerceSurveyActions, applySurveyActions, reviewAnalysisPlan } from "/home/claude/rescript/packages/engine/dist/index.js";
let n = 0; const ids = (p) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const r = applySurveyActions(empty(), coerceSurveyActions([
  { op: "set_research", hypotheses: ["H1: Ad recall increases consideration"] },
  { op: "create_block", title: "B" },
  { op: "create_question", ref: "AD_RECALL", type: "yes_no", text: "Seen ads?" },
  { op: "create_question", ref: "CONSIDER", type: "matrix", text: "Consider?", rows: ["Brand A", "Brand B"], scale: { points: 5 } },
  { op: "set_question_analysis", target: "CONSIDER", role: "dependent", hypotheses: ["H1"] },
  { op: "set_question_analysis", target: "AD_RECALL", role: "independent", hypotheses: ["H1"] },
  { op: "propose_analysis_plan" },
  { op: "add_analysis_test", method: "chi_square", outcome: "CONSIDER", variables: ["AD_RECALL"], hypotheses: ["H1"] },
]).actions, { ids });
console.log("errors:", r.errors, "warnings:", r.warnings);
for (const t of r.def.research.analysisPlan.tests) console.log(" test", t.method, "outcome", t.outcome, "vars", t.variables, "by", t.groupBy);
console.log("reviewAnalysisPlan:"); for (const i of reviewAnalysisPlan(r.def)) console.log("  ", i.level, i.message, i.suggestion ?? "");
