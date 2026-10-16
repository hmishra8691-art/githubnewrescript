import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const { parseLogicExpression, formatCondition, evaluateCondition, createResponseState, setAnswer, canonicalizeSurveyConditions, lintSurveyLogic, applyOptionAction, pruneReferencesTo, referencesTo, conditionSummary } = E;

const mk = () => SurveyDefinition.parse({
  meta: { id: "r", code: "R", title: "Ref", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "COLOR", type: "single_select", text: "Colour?",
      options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }, { code: "3", label: "Green" }] },
    { id: "qm", code: "QM", variableName: "SAT", type: "matrix_single", text: "Rate",
      options: [{ code: "1", label: "Poor" }, { code: "2", label: "Great" }],
      rows: [{ code: "svc", label: "Service", flags: [], validation: [], required: false }, { code: "prc", label: "Price", flags: [], validation: [], required: false }] },
    { id: "q2", code: "Q2", variableName: "WHY", type: "text", text: "Why blue?" },
    { id: "q3", code: "Q3", variableName: "WHY2", type: "text", text: "Why service great?" },
    { id: "q4", code: "Q4", variableName: "MASKED", type: "multi_select", text: "masked", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
    { id: "q5", code: "Q5", variableName: "PIPE", type: "text", text: "You said {{Q1}} / {{Q1.label}} / {{COLOR}}" },
    { id: "q6", code: "Q6", variableName: "CALC", type: "text", text: "calc", },
  ],
  calculations: [{ id: "c1", targetVariable: "ISBLUE", expression: "Q1 == 2", trigger: "on_change" }],
  quotas: [{ id: "qt1", name: "Blue quota", type: "hard", limitType: "count", cells: [{ id: "cell1", label: "Blue", limit: 10, when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" } }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "qm"] }, { type: "page", id: "p2", questionIds: ["q2", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
});

let def = mk();
def.questions[2].displayLogic = parseLogicExpression(def, "Q1 = 2").condition;             // Q2 shown when Blue (code 2)
def.questions[3].displayLogic = parseLogicExpression(def, "QM.svc.2").condition;           // Q3 shown when Service rated Great (code 2)
def.questions[4].mask = { expr: { kind: "ref", questionId: "q1", selection: "selected" } };

const show = (d, label) => {
  const state = createResponseState(d);
  const blueCode = d.questions[0].options[1].code;
  setAnswer(d, state, "q1", blueCode, null);
  setAnswer(d, state, "qm", { [d.questions[1].rows[0].code]: d.questions[1].options[1].code }, null);
  const ctx = { def: d, state, loop: null };
  const q2 = evaluateCondition(d.questions[2].displayLogic, ctx);
  const q3 = evaluateCondition(d.questions[3].displayLogic, ctx);
  const lint = (lintSurveyLogic ? lintSurveyLogic(d) : []).filter((i) => /q2|q3|Q2|Q3|cell|quota|ISBLUE|c1/.test(JSON.stringify(i)));
  console.log(`\n[${label}] answer Q1=${JSON.stringify(blueCode)} QM=${JSON.stringify(state.answers.qm)}`);
  console.log(`  Q2 rule: ${formatCondition(d, d.questions[2].displayLogic)}  -> visible=${q2}   stored value=${JSON.stringify(d.questions[2].displayLogic.value)}`);
  console.log(`  Q3 rule: ${formatCondition(d, d.questions[3].displayLogic)}  -> visible=${q3}   stored src=${JSON.stringify(d.questions[3].displayLogic.source)}`);
  console.log(`  quota cell when: ${JSON.stringify(d.quotas[0].cells[0].when.value)}  calc expr: ${d.calculations[0].expression}  pipe text: ${d.questions[5].text}`);
  console.log(`  lint hits: ${lint.length ? lint.map((i) => `${i.level}: ${i.message}`).join(" || ") : "none"}`);
};
show(def, "baseline");

// 1) RAW option-code edit, the way the Studio Options editor does it (QuestionsPanel set(i,{code}))
let d1 = structuredClone(def);
d1 = SurveyDefinition.parse(d1);
d1.questions[0].options[1].code = "20";
const canon = canonicalizeSurveyConditions(d1);         // what the store runs on every update
console.log("\n=== 1) raw option code edit 2 -> 20 (Studio path); canonicalize changes:", canon.changes, "unresolved:", canon.unresolved);
show(canon.def, "after raw recode");

// 2) Intelligent-mode action update_option {code}
let d2 = SurveyDefinition.parse(structuredClone(def));
const env = { question: (ref) => d2.questions.find((q) => q.id === ref || q.code === ref || q.variableName === ref), condition: (c) => typeof c === "string" ? parseLogicExpression(d2, c).condition : c, ids: (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`, now: new Date().toISOString() };
const applied = applyOptionAction(d2, { op: "update_option", target: "Q1", option: "2", code: "20" }, env);
console.log("\n=== 2) applyOptionAction update_option code 2->20:", applied.description, "|", applied.destructive);
show(d2, "after action recode");

// 3) RAW matrix row code edit svc -> service (Studio rows editor path)
let d3 = SurveyDefinition.parse(structuredClone(def));
d3.questions[1].rows[0].code = "service";
const canon3 = canonicalizeSurveyConditions(d3);
console.log("\n=== 3) raw ROW code edit svc -> service; changes:", canon3.changes, "unresolved:", canon3.unresolved);
show(canon3.def, "after raw row recode");

// 4) delete option Blue (raw splice) — does anything prune / warn?
let d4 = SurveyDefinition.parse(structuredClone(def));
d4.questions[0].options.splice(1, 1);
const canon4 = canonicalizeSurveyConditions(d4);
console.log("\n=== 4) raw option delete (Blue); changes:", canon4.changes, "unresolved:", canon4.unresolved);
const lint4 = lintSurveyLogic(canon4.def).map((i) => `${i.level}: ${i.questionCode ?? ""} ${i.message}`);
console.log("  lint:", lint4.join(" || ") || "none");

// 5) delete question Q1 via pruneReferencesTo — what is pruned
let d5 = SurveyDefinition.parse(structuredClone(def));
const refs = referencesTo(d5, "q1");
console.log("\n=== 5) referencesTo(q1):", refs.map((r) => `${r.kind}@${r.path}${r.where ? " " + r.where : ""}`).join(" | "));
const pruned = pruneReferencesTo(d5, "q1");
d5.questions = d5.questions.filter((q) => q.id !== "q1");
console.log("  pruned:", pruned.map((r) => `${r.kind}@${r.path}`).join(" | "));
console.log("  Q2 displayLogic after prune:", JSON.stringify(d5.questions.find((q) => q.id === "q2").displayLogic), " Q4 mask:", JSON.stringify(d5.questions.find((q) => q.id === "q4").mask), " quota cell:", JSON.stringify(d5.quotas[0].cells), " calc:", d5.calculations.length, " pipe:", d5.questions.find((q) => q.id === "q5").text);

// 6) rename question CODE Q1 -> Q1B raw (Studio patch({code})) — rules store ids; RHS $question / calc / pipes use the code
let d6 = SurveyDefinition.parse(structuredClone(def));
d6.questions[2].displayLogic = parseLogicExpression(d6, "Q1 = Q6").condition; // RHS question ref
d6.questions[0].code = "Q1B";
const d6c = canonicalizeSurveyConditions(d6);
console.log("\n=== 6) raw question code rename Q1 -> Q1B; changes:", d6c.changes, "unresolved:", d6c.unresolved);
console.log("  Q2 rule:", formatCondition(d6c.def, d6c.def.questions[2].displayLogic), " stored:", JSON.stringify(d6c.def.questions[2].displayLogic));
console.log("  calc expr still:", d6c.def.calculations[0].expression, " pipe text:", d6c.def.questions[5].text);
const lint6 = lintSurveyLogic(d6c.def).map((i) => `${i.level}: ${i.message}`);
console.log("  lint:", lint6.join(" || ") || "none");
