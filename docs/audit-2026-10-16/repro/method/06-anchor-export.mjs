// Anchored MaxDiff: does the anchor answer reach flattened variables / export columns?
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { createResponseState, flattenVariables, buildVariableDictionary } from "/home/claude/rescript/packages/engine/dist/index.js";
const def = SurveyDefinition.parse({
  meta: { id: "t", code: "T", title: "Tasks", version: "1.0" },
  designs: [{ id: "d1", kind: "maxdiff", name: "MD", version: 1, config: { anchored: true }, file: { columns: ["version", "task", "position", "item_index", "item_label"], rows: [1, 2].flatMap((t) => [1, 2, 3, 4].map((pos) => ({ version: 1, task: t, position: pos, item_index: pos + t, item_label: `Item ${pos + t}` }))) } }],
  questions: [{ id: "q1", code: "Q1", variableName: "MD", type: "maxdiff_task", text: "Choose", required: true, settings: { designRef: "d1" } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});
const state = createResponseState(def, { seed: 1 });
state.answers.q1 = { "1": { best: "2", worst: "3", anchor: "some" }, "2": { best: "3", worst: "4", anchor: "all" } };
console.log("dictionary MD_*:", buildVariableDictionary(def).filter((v) => v.name.startsWith("MD")).map((v) => v.name).join(","));
console.log("flattened MD_*:", JSON.stringify(Object.fromEntries(Object.entries(flattenVariables(def, state)).filter(([k]) => k.startsWith("MD")))));
