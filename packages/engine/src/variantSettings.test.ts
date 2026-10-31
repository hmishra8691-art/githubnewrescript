import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry, type Question } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { settableSettings, variantCatalogue } from "./capabilityRegistry.js";

/* S2b item 2: every family has a settable key that round-trips through the gate; an undeclared key is refused with the list */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [{ op: "create_block", title: "Main" }, { op: "create_question", type: "single", text: "Brand?", options: ["Acme", "Beta"] }] as SurveyAction[]).def;
})();

/** a value the setting accepts, from the registry's own description */
function sample(spec: { type: string; limits?: string }): unknown {
  if (spec.type === "boolean") return true;
  if (spec.type === "enum") return spec.limits!.split("|").slice(-1)[0];
  if (spec.type === "number" || spec.type === "integer") { const lo = Number(spec.limits?.split("–")[0]); return Number.isFinite(lo) && lo > 0 ? lo : 2; }
  if (spec.type === "string") return "x";
  if (spec.type === "list" && spec.limits) return [spec.limits.split("|")[0]];
  return undefined;
}

/** a def whose Q1 is a question of this variant (the variant's own maker, through the definition, like a picker change) */
function withVariant(id: string) {
  const v = variantRegistry.get(id)!;
  const def = structuredClone(base);
  const q = def.questions[0] as Question & { variant?: string };
  q.type = v.baseType as never; q.variant = v.id;
  return def;
}

test("each family: a settable key round-trips through coerce → apply → the stored setting", () => {
  const cat = variantCatalogue();
  const fams = [...new Set(cat.map((v) => v.family))];
  const done: string[] = [];
  for (const f of fams) {
    let ok = false; const tried: string[] = [];
    for (const v of cat.filter((x) => x.family === f)) {
      for (const spec of v.settings.filter((s) => s.key !== "validationPosition").concat(v.settings.filter((s) => s.key === "validationPosition"))) {
        const val = sample(spec); if (val === undefined) continue;
        const c = coerceSurveyActions([{ op: "update_question", target: "Q1", settings: { [spec.key]: val } }]);
        if (!c.actions.length) { tried.push(`${v.id}.${spec.key}: coerce ${c.rejected[0]?.reason}`); continue; }
        const r = applySurveyActions(withVariant(v.id), c.actions);
        const stored = (r.def.questions[0].settings as Record<string, unknown>)[spec.key];
        if (r.results[0].ok && JSON.stringify(stored) === JSON.stringify(val)) { ok = true; done.push(`${v.id}.${spec.key}`); break; }
        tried.push(`${v.id}.${spec.key}=${JSON.stringify(val)}: ${r.results[0].error ?? r.errors.join("; ")}`);
      }
      if (ok) break;
    }
    assert.ok(ok, `${f}: no settable key round-tripped — ${tried.slice(0, 4).join(" | ")}`);
  }
  assert.equal(done.length, fams.length);
  // the first variant of matrix, dragdrop, calculated and ai round-trips the universal key; every other family its own
  assert.ok(done.filter((d) => !d.endsWith(".validationPosition")).length >= fams.length - 4, done.join(", "));
});

test("an undeclared key is refused with the declared list; a bad value with its type", () => {
  const r = applySurveyActions(withVariant(variantCatalogue().find((v) => v.family === "hotspot")!.id), [{ op: "update_question", target: "Q1", settings: { timeLimitSeconds: 30 } } as SurveyAction]);
  assert.equal(r.results[0].ok, false);
  const list = settableSettings(variantCatalogue().find((v) => v.family === "hotspot")!.id).join(", ");
  assert.ok((r.results[0].error ?? "").includes(`its settings are ${list}`), r.results[0].error);
  const bad = applySurveyActions(withVariant("single_select.radio"), [{ op: "update_question", target: "Q1", settings: { columnsLayout: "two" } } as SurveyAction]);
  assert.match(bad.results[0].error ?? "", /columnsLayout must be|not a valid columnsLayout/);
});

test("create_question accepts settings, checked against the variant it makes", () => {
  const c = coerceSurveyActions([{ op: "create_question", type: "gamified.timed", text: "Pick fast", options: ["A", "B"], settings: { timeLimitSeconds: 20, onTimeout: "advance" } }]);
  assert.equal(c.actions.length, 1);
  assert.deepEqual((c.actions[0] as { settings?: unknown }).settings, { timeLimitSeconds: 20, onTimeout: "advance" });
  const r = applySurveyActions(base, c.actions);
  assert.ok(r.results[0].ok, r.results[0].error);
  const q = r.def.questions.find((x) => x.text === "Pick fast")!;
  assert.deepEqual([q.settings.timeLimitSeconds, q.settings.onTimeout], [20, "advance"]);
  const refused = applySurveyActions(base, coerceSurveyActions([{ op: "create_question", type: "single", text: "Plain", options: ["A", "B"], settings: { timeLimitSeconds: 20 } }]).actions);
  assert.equal(refused.results[0].ok, false);
  assert.match(refused.results[0].error ?? "", /has no setting timeLimitSeconds an action can set — its settings are /);
  // a list setting (tools) survives coercion
  const t = coerceSurveyActions([{ op: "update_question", target: "Q1", settings: { tools: ["pin", "pen"] } }]);
  assert.deepEqual((t.actions[0] as { settings?: unknown }).settings, { tools: ["pin", "pen"] });
});
