import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { scriptLiteralRefs } from "./scriptRefs.js";
import { buildDependencyIndex, objectKey } from "./dependencyIndex.js";
import { impactOf } from "./impact.js";

/* S2b item 5 (D18 / MM-10): scripts in the dependency graph */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Brand?", options: ["Acme", "Beta"] },
    { op: "create_question", type: "numeric", text: "Age?" },
    { op: "create_question", type: "numeric", text: "Spend?" },
    { op: "create_embedded", name: "SRC", source: "url" },
    { op: "create_logic_script", name: "Spend check", event: "on_change", code: "var a = get('Q3'); if (a > 100) { setEmbedded('SRC', 'high'); } var m = new Map(); m.get('Q1');" },
    { op: "create_behavior", label: "Age note", target: "Q2", on: "answer", script: "rs.listen('answer', function(){ if (rs.getAnswer(\"Q2\") < 18) rs.showMessage('Q2', 'Under 18'); });" },
  ] as SurveyAction[]);
  assert.ok(r.results.every((x) => x.ok), r.results.map((x) => x.error).join("; "));
  return r.def;
})();

test("literal references are read; a method of something else and a built name are not", () => {
  const refs = scriptLiteralRefs("var a = get('Q3'); rs.setAnswer(\"SEG\", 1); m.get('Q1'); get('Q' + i); ctx.getCalc('TOT'); document.querySelector('[data-qid=\"q_abc\"]');");
  assert.deepEqual(refs.map((r) => `${r.name}${r.write ? "!" : ""}/${r.via}`), ["Q3/call", "SEG!/call", "TOT/call", "q_abc/hook"]);
});

test("the index has script nodes with edges to what they read and write", () => {
  const ix = buildDependencyIndex(base);
  const q3 = base.questions[2], q2 = base.questions[1];
  const readers = ix.usedBy(objectKey("question", q3.id)).filter((e) => e.kind === "script");
  assert.equal(readers.length, 1);
  assert.match(readers[0].label, /script “Spend check” — reads Q3/);
  assert.ok(ix.usedBy(objectKey("embedded", "SRC")).some((e) => e.kind === "script" && /writes SRC/.test(e.label)));
  assert.ok(ix.usedBy(objectKey("question", q2.id)).some((e) => e.kind === "script" && /Age note/.test(e.label)));
  assert.equal(ix.usedBy(objectKey("question", base.questions[0].id)).filter((e) => e.kind === "script").length, 0, "m.get('Q1') is not a survey read");
});

test("deleting a question: the impact and the action's description name the script that reads it", () => {
  const q3 = base.questions[2];
  const imp = impactOf(base, { questions: [q3.id] }, { change: "delete" });
  assert.ok(imp.items.some((i) => i.via === "script" && /Spend check/.test(i.text) && i.severity === "breaks"), JSON.stringify(imp.items.map((i) => [i.via, i.text, i.severity])));
  const r = applySurveyActions(base, [{ op: "delete_question", target: "Q3" } as SurveyAction]);
  assert.ok(r.results[0].ok, r.results[0].error);
  assert.match(r.destructive.join(" "), /script “Spend check” reads Q3 \(literal references; not changed\)/);
});

test("renaming a question rewrites the scripts' literal references and they still pass their checks", () => {
  const r = applySurveyActions(base, [{ op: "update_question", target: "Q2", code: "AGE" } as SurveyAction]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const b = r.def.ux!.behaviors.find((x) => x.label === "Age note")!;
  assert.ok(b.script!.includes('rs.getAnswer("AGE")'), b.script);
  assert.match(r.results[0].description, /1 literal script reference to Q2 rewritten \(“Age note”\)/);
  const s = applySurveyActions(base, [{ op: "update_question", target: "Q3", code: "SPEND" } as SurveyAction]);
  assert.ok(s.def.scripts[0].code.includes("get('SPEND')"));
  assert.ok(s.def.scripts[0].code.includes("m.get('Q1')"), "an unrelated string is untouched");
});
