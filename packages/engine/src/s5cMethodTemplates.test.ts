import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, describeAction, SURVEY_ACTION_OPS, type SurveyAction } from "./surveyActions.js";
import { NATIVE_FEATURES } from "./capabilityRegistry.js";
import { runQualityCheck } from "./qualityCheck.js";

/* S5c: research-method templates through the real action path (coerce → apply), and what they leave in the survey */

const base = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const coerce = (raw: unknown[]) => coerceSurveyActions(raw);
const act = (def: SurveyDefinition, raw: unknown[]) => {
  const c = coerce(raw); assert.equal(c.rejected.length, 0, JSON.stringify(c.rejected));
  const r = applySurveyActions(def, c.actions); assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results)); return r;
};

test("add_method_template pricing_psm: four VW prices, the NMS pair piped, one block before the end, the pricing plan item", () => {
  const r = act(base(), [{ op: "add_method_template", template: "pricing_psm", product: "the Aurora kettle", currency: "€", vwCurves: "textbook" }]);
  const codes = r.def.questions.map((q) => q.variableName);
  assert.deepEqual(codes, ["PSM_TOO_CHEAP", "PSM_CHEAP", "PSM_EXPENSIVE", "PSM_TOO_EXPENSIVE", "NMS_CHEAP", "NMS_EXPENSIVE"]);
  assert.equal(r.def.flow[0].type, "block");
  assert.equal(r.def.flow[r.def.flow.length - 1].type, "end", "the block goes before the end screen");
  const nms = r.def.questions.find((q) => q.variableName === "NMS_CHEAP")!;
  assert.match(nms.text, /At €\{\{PSM_CHEAP\}\}, how likely/);
  assert.deepEqual(nms.options.map((o) => o.code), [5, 4, 3, 2, 1]);
  const t = r.def.research!.analysisPlan!.tests[0];
  assert.equal(t.method, "pricing");
  assert.deepEqual(t.options, { method: "van_westendorp", vwCurves: "textbook", nmsCheap: "NMS_CHEAP", nmsExpensive: "NMS_EXPENSIVE" });
  assert.deepEqual(t.variables, ["PSM_TOO_CHEAP", "PSM_CHEAP", "PSM_EXPENSIVE", "PSM_TOO_EXPENSIVE"]);
  const qc = runQualityCheck(r.def);
  assert.equal(qc.deployable, true, JSON.stringify(qc.areas.filter((a) => a.status === "fail")));
  assert.match(r.results[0].description ?? "", /Van Westendorp \+ Newton–Miller–Smith/);
});

test("add_method_template: a clash is refused with the names, a prefix adds a second copy, nms:false and plan:false", () => {
  const once = act(base(), [{ op: "add_method_template", template: "pricing_psm", nms: false }]);
  assert.equal(once.def.questions.length, 4);
  assert.equal(once.def.research!.analysisPlan!.tests[0].options!.nmsCheap, undefined);
  const c = coerce([{ op: "add_method_template", template: "pricing_psm" }]);
  const again = applySurveyActions(once.def, c.actions);
  assert.equal(again.results[0].ok, false);
  assert.match(JSON.stringify(again.results[0]), /already has PSM_TOO_CHEAP.*prefix/);
  const second = act(once.def, [{ op: "add_method_template", template: "pricing_psm", prefix: "b_", plan: false }]);
  assert.ok(second.def.questions.some((q) => q.variableName === "B_PSM_CHEAP"));
  assert.equal(second.def.research!.analysisPlan!.tests.length, 1, "plan:false adds no plan item");
  const bad = coerce([{ op: "add_method_template", template: "focus_group" }]);
  assert.equal(bad.actions.length, 0);
  assert.match(String(bad.rejected[0]?.reason ?? JSON.stringify(bad.rejected[0])), /one of pricing_psm/);
  assert.match(describeAction(coerce([{ op: "add_method_template", template: "pricing_psm", product: "Aurora" }]).actions[0] as SurveyAction), /Add a pricing psm template for Aurora/);
});

test("add_method_template is a registered action with a capability record", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("add_method_template"));
  const f = NATIVE_FEATURES.find((x) => x.id === "method_templates")!;
  assert.deepEqual(f.actions, ["add_method_template"]);
  assert.ok(f.need.test("a Van Westendorp with Newton-Miller-Smith"));
});

test("add_method_template sequential_monadic: a block per concept under a Williams randomizer, the plan item names the stored order", () => {
  const r = act(base(), [{ op: "add_method_template", template: "sequential_monadic", concepts: ["Fresh", "Bold", "Calm"] }]);
  const rnd = r.def.flow[0] as unknown as { type: string; id: string; order?: string; children: { id: string; title?: string }[] };
  assert.equal(rnd.type, "randomizer");
  assert.equal(rnd.order, "williams");
  assert.deepEqual(rnd.children.map((b) => b.title), ["Fresh", "Bold", "Calm"]);
  const t = r.def.research!.analysisPlan!.tests[0];
  assert.equal(t.method, "sequential_monadic");
  assert.deepEqual(t.variables, ["C1_APPEAL", "C2_APPEAL", "C3_APPEAL"]);
  assert.equal(t.options!.order, `ORDER_${rnd.id.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`);
  assert.deepEqual(t.options!.blocks, rnd.children.map((b) => b.id));
  const qc = runQualityCheck(r.def);
  assert.equal(qc.deployable, true, JSON.stringify(qc.areas.filter((a) => a.status === "fail")));
  assert.match(JSON.stringify(coerce([{ op: "add_method_template", template: "sequential_monadic", concepts: ["One"] }]).rejected), /2–8 different names/);
});

test("add_method_template brand_funnel and ad_test: the AI-coded open ends, carry-forward stages, forced exposure, plan items; refusals", () => {
  const r = act(base(), [{ op: "add_method_template", template: "brand_funnel", product: "coffee", brands: ["Alpha", "Beta", "Gamma"] }, { op: "add_method_template", template: "ad_test", brands: ["Alpha", "Beta"], videoUrl: "https://example.com/ad.mp4" }]);
  const by = (v: string) => r.def.questions.find((q) => q.variableName === v)!;
  assert.equal(by("UNAIDED_CODED").type, "calculated");
  assert.match(String(by("UNAIDED_CODED").settings.expression), /ai_classify\(UNAIDED, "Alpha\|Beta\|Gamma\|Other\|None"\)/);
  assert.equal(by("PURCHASED").carryForward?.sourceQuestionId, by("CONSIDER").id);
  assert.equal(by("AD_LIKE").settings.mediaUrl, "https://example.com/ad.mp4");
  assert.equal(by("AD_LIKE").settings.requireComplete, true);
  const methods = r.def.research!.analysisPlan!.tests.map((t) => t.method);
  assert.deepEqual(methods, ["brand_funnel", "frequencies", "frequencies", "mean", "top_box"]);
  const qc = runQualityCheck(r.def);
  assert.equal(qc.deployable, true, JSON.stringify(qc.areas.filter((a) => a.status === "fail")));
  assert.match(JSON.stringify(coerce([{ op: "add_method_template", template: "ad_test", videoUrl: "http://x" }]).rejected), /videoUrl must be https/);
  assert.match(JSON.stringify(coerce([{ op: "add_method_template", template: "brand_funnel", brands: ["A|B", "C"] }]).rejected), /2–15 different names/);
});
