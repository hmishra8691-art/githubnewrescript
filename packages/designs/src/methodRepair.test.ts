import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, autoFixMethodAction, coerceSurveyActions, explainMethodRefusal } from "@rescript/engine";
import { registerBuiltinDesignGenerators } from "./index.js";

/*
 * ENGINE WEAKNESS #13 (2026-10-22): a refused MaxDiff / conjoint action — at the gate or by the generator — gets the
 * Studio's own correction where exactly one exists (then passes the gate and the generator), and otherwise a precise
 * reason for the one repair call. Through the REAL generators (as the copilot route and its replay load them).
 */
registerBuiltinDesignGenerators();

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Phones", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];

/** refused (at the gate or on apply) → the Studio's correction → applied */
function refusedThenFixed(raw: Record<string, unknown>, def = empty()) {
  const c = coerceSurveyActions([raw]);
  const reason = c.rejected[0]?.reason ?? applySurveyActions(def, c.actions).results[0]?.error ?? "";
  assert.ok(reason, `precondition: ${raw.op} is refused`);
  const fix = autoFixMethodAction(raw, reason, def);
  assert.ok(fix, `a correction exists for: ${reason}`);
  const c2 = coerceSurveyActions([fix!.action]);
  assert.deepEqual(c2.rejected, [], `the correction passes the gate: ${JSON.stringify(c2.rejected)}`);
  const out = applySurveyActions(def, c2.actions);
  assert.equal(out.results[0]!.ok, true, `the correction applies: ${out.errors.join(" | ")}`);
  return { reason, fix: fix!, out };
}

test("#13 MaxDiff: 5 per task from 5 items → 4 per task (generator refusal), and 2 per task → 3 (gate refusal)", () => {
  const a = refusedThenFixed({ op: "create_maxdiff", items: ["A", "B", "C", "D", "E"], perTask: 5 });
  assert.equal(a.fix.action.perTask, 4);
  assert.match(a.fix.note, /4 items per task instead of 5/);
  const b = refusedThenFixed({ op: "create_maxdiff", items: ["A", "B", "C", "D", "E", "F"], perTask: 2 });
  assert.equal(b.fix.action.perTask, 3);
});

test("#13 MaxDiff: itemsFrom a question is counted from its options (None / Other left out)", () => {
  const def = empty();
  const seeded = applySurveyActions(def, coerceSurveyActions([{ op: "create_question", ref: "FEAT", type: "multi", text: "Which matter?", options: ["Battery", "Camera", "Price", "Screen", "None of these"] }]).actions);
  const d2 = seeded.def;
  (d2.questions[0]!.options!.at(-1) as { flags?: string[] }).flags = ["none_of_above"];
  const r = refusedThenFixed({ op: "create_maxdiff", itemsFrom: d2.questions[0]!.code, perTask: 4 }, d2);
  assert.equal(r.fix.action.perTask, 3, "4 items → at most 3 per task");
});

test("#13 MaxDiff: a repeated item is dropped; too few tasks for the appearances asked → the fewest that work", () => {
  const a = refusedThenFixed({ op: "create_maxdiff", items: ["A", "B", "C", "D", "a", "E"] });
  assert.deepEqual(a.fix.action.items, ["A", "B", "C", "D", "E"]);
  /* tasks the researcher STATED are theirs (more tasks, versions, items per task or fewer appearances would each fix it): no correction */
  const stated = { op: "create_maxdiff", items: ["A", "B", "C", "D", "E", "F", "G", "H"], perTask: 3, tasks: 1, versions: 1 };
  const why0 = applySurveyActions(empty(), coerceSurveyActions([stated]).actions).results[0]!.error!;
  assert.match(why0, /cannot show all 8 items even once/);
  assert.equal(autoFixMethodAction(stated, why0, empty()), null);
  /* an update that raised the appearances and kept the stored tasks: the fewest tasks that carry them */
  const upd = autoFixMethodAction({ op: "update_maxdiff", target: "MD", appearances: 3 }, "this MaxDiff design is not feasible — 2 tasks × 4 items = 8 places per version, but 8 items × 3 appearances need 24. Use at least 6 tasks, or lower the target.");
  assert.equal(upd?.action.tasks, 6);
  const both = { op: "create_maxdiff", items: ["A", "B", "C", "D", "E", "F", "G", "H"], perTask: 4, tasks: 2, appearances: 3 };
  const why = applySurveyActions(empty(), coerceSurveyActions([both]).actions).results[0]!.error!;
  assert.match(why, /Use at least \d+ tasks/);
  assert.equal(autoFixMethodAction(both, why, empty()), null);
});

test("#13 conjoint: dual-response with an in-task None → the None dropped; 5 alternatives from 4 concepts → 4; duplicate levels dropped", () => {
  const a = refusedThenFixed({ op: "create_conjoint", method: "cbc", attributes: ATTRS, dualResponse: true, none: true });
  assert.equal(a.fix.action.none, undefined);
  assert.equal(a.fix.action.dualResponse, true);
  const b = refusedThenFixed({ op: "create_conjoint", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha", "Beta"] }, { name: "Price", levels: ["$1", "$2"] }], alternatives: 5 });
  assert.equal(b.fix.action.alternatives, 4);
  const c = refusedThenFixed({ op: "create_conjoint", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Alpha"] }, ...ATTRS.slice(1)] });
  assert.deepEqual((c.fix.action.attributes as { levels: string[] }[])[0]!.levels, ["Alpha", "Beta"]);
});

test("#13 rating-based (CVA): too few profiles → the fewest that identify the part-worths", () => {
  const a = refusedThenFixed({ op: "create_conjoint", method: "cva", attributes: ATTRS, profiles: 4 });
  assert.ok(Number(a.fix.action.profiles) > 4);
  assert.match(a.fix.note, /part-worths/);
});

test("#13 never invented: missing attributes, a one-level attribute, prohibitions that rule out every concept — no correction, a precise reason", () => {
  for (const raw of [
    { op: "create_conjoint", method: "cbc" },
    { op: "create_conjoint", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha"] }, ATTRS[2]] },
    { op: "create_conjoint", method: "menu" },
    { op: "create_maxdiff", items: ["A", "B", "C"] },
  ] as Record<string, unknown>[]) {
    const c = coerceSurveyActions([raw]);
    const reason = c.rejected[0]?.reason ?? applySurveyActions(empty(), c.actions).results[0]?.error ?? "";
    assert.equal(autoFixMethodAction(raw, reason, empty()), null, `no correction for: ${reason}`);
  }
  const all = ["Alpha", "Beta", "Gamma"].flatMap((b) => ["$199", "$299", "$399"].map((p) => ({ Brand: b, Price: p })));
  const raw = { op: "create_conjoint", method: "cbc", attributes: ATTRS, prohibitions: all };
  const reason = applySurveyActions(empty(), coerceSurveyActions([raw]).actions).results[0]!.error!;
  assert.match(reason, /rule out every possible concept/);
  assert.equal(autoFixMethodAction(raw, reason, empty()), null);
  const said = explainMethodRefusal(raw, reason);
  assert.ok(said.startsWith(reason), "the engine's reason first, unchanged");
  assert.match(said, /The prohibitions given were: Brand Alpha with Price \$199; .*cannot choose which to drop/);
  assert.match(explainMethodRefusal({ op: "create_conjoint", method: "cbc" }, "create_conjoint (cbc) needs the attributes and their levels"), /Do not invent/);
  assert.equal(explainMethodRefusal({ op: "create_question" }, "x"), "x", "only design actions are explained");
});

test("#13 an update is corrected the same way; simulate_conjoint is never auto-corrected (a scenario is the researcher's)", () => {
  assert.equal(autoFixMethodAction({ op: "simulate_conjoint", target: "Q1" }, "“128GB” is not a level of Storage"), null);
  const fix = autoFixMethodAction({ op: "update_maxdiff", target: "MD", perTask: 9, items: ["A", "B", "C", "D", "E", "F"] }, "MaxDiff requires at least itemsPerTask + 1 items (need 10, got 6).");
  assert.equal(fix?.action.perTask, 5);
});
