// Intelligent Mode: can create_* actions configure a MaxDiff / conjoint?
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { coerceSurveyActions, applySurveyActions, variantForActionType } from "/home/claude/rescript/packages/engine/dist/index.js";
import { writeFileSync } from "node:fs";
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" }, questions: [], flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: [] }] }, { type: "end", id: "e", status: "complete" }] });
log("variantForActionType:", JSON.stringify({ maxdiff: variantForActionType("maxdiff"), conjoint: variantForActionType("conjoint"), cbc: variantForActionType("cbc"), "conjoint.cbc": variantForActionType("conjoint.cbc"), acbc: variantForActionType("acbc"), menu: variantForActionType("menu"), "conjoint.acbc": variantForActionType("conjoint.acbc") }));
const raw = [
  { op: "create_question", ref: "MD1", block: "Main", type: "maxdiff", text: "Which matters most / least?", options: ["Battery", "Camera", "Screen", "Price", "Speed", "Design"] },
  { op: "create_question", ref: "CJ1", block: "Main", type: "conjoint", text: "Which would you choose?", options: ["Brand: A, B", "Price: $10, $20"] },
  { op: "create_question", ref: "CJ2", block: "Main", type: "conjoint.cbc", text: "Which would you choose?" },
  { op: "create_design", kind: "maxdiff", items: ["a", "b", "c", "d", "e"] },
  { op: "generate_design", kind: "conjoint", attributes: [{ name: "Brand", levels: ["A", "B"] }] },
];
const co = coerceSurveyActions(raw);
log("coerced ops:", JSON.stringify(co.actions.map((a) => a.op)), "| rejected:", JSON.stringify(co.rejected ?? co.errors ?? co.problems ?? Object.keys(co)));
const res = applySurveyActions(def, co.actions);
log("apply ok:", JSON.stringify(Object.keys(res)), "errors:", JSON.stringify(res.errors ?? res.failed ?? null));
for (const q of res.def?.questions ?? res.after?.questions ?? []) log(`  question ${q.code} type=${q.type} variant=${q.variant} designRef=${q.settings?.designRef ?? "(none)"} options=${q.options.length}`);
log("designs after apply:", (res.def ?? res.after)?.designs?.length ?? "n/a");
writeFileSync("/tmp/audit/method/07-intelligent-mode.out.txt", out.join("\n"));
