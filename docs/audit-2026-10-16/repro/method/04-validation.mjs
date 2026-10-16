// MaxDiff answer validation: required-completeness and best==worst.
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { createResponseState, validatePage, flattenVariables, buildVariableDictionary } from "/home/claude/rescript/packages/engine/dist/index.js";
import { writeFileSync } from "node:fs";
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const def = SurveyDefinition.parse({
  meta: { id: "t", code: "T", title: "Tasks", version: "1.0" },
  designs: [{ id: "d1", kind: "maxdiff", name: "MD", version: 1, config: {}, file: { columns: ["version", "task", "position", "item_index", "item_label"], rows: [1, 2].flatMap((t) => [1, 2, 3, 4].map((pos) => ({ version: 1, task: t, position: pos, item_index: pos + t, item_label: `Item ${pos + t}` }))) } }],
  questions: [{ id: "q1", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Choose", required: true, settings: { designRef: "d1" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});
const state = createResponseState(def, { seed: 1 });
const ctx = { def, state, loop: null };
const run = (label, v) => { state.answers.q1 = v; log(`  ${label}:`, JSON.stringify(validatePage(def, [def.questions[0]], ctx).map((e) => e.message)) ); };
log("## MaxDiff required validation (2 tasks, required=true)");
run("empty", undefined);
run("task 1 best only", { "1": { best: "2" } });
run("task 1 best+worst, task 2 untouched", { "1": { best: "2", worst: "3" } });
run("task 1 best == worst (same item 2)", { "1": { best: "2", worst: "2" }, "2": { best: "3", worst: "4" } });
run("best is an item NOT in task 1's set (item 9)", { "1": { best: "9", worst: "3" }, "2": { best: "3", worst: "4" } });
run("complete", { "1": { best: "2", worst: "3" }, "2": { best: "3", worst: "4" } });
state.answers.q1 = { "1": { best: "2", worst: "2" } };
log("  flatten of best==worst:", JSON.stringify(Object.fromEntries(Object.entries(flattenVariables(def, state)).filter(([k]) => k.startsWith("MD")))));
writeFileSync("/tmp/audit/method/04-validation.out.txt", out.join("\n"));
