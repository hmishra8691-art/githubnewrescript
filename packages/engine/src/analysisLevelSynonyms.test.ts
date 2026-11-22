import { test } from "node:test";
import assert from "node:assert/strict";
import { measurementLevelOf } from "./analysisActions.js";

test("a measurement level written with a description, or as a common synonym, is read as the level meant", () => {
  assert.equal(measurementLevelOf("ordinal (1=never, 2=sometimes, 3=often)"), "ordinal");
  assert.equal(measurementLevelOf("nominal (class label assigned by lca)"), "nominal");
  assert.equal(measurementLevelOf("Continuous"), "interval");
  assert.equal(measurementLevelOf("categorical"), "nominal");
  assert.equal(measurementLevelOf("interval"), "interval");
  assert.equal(measurementLevelOf("banana"), "banana", "anything else is passed through and refused as before");
});

test("a planned test written with type / indicators / classes_min reads as the method and settings meant", async () => {
  const { methodNameOf, testOptions } = await import("./analysisActions.js");
  assert.equal(methodNameOf("latent_class_analysis"), "latent_class");
  assert.equal(methodNameOf("omega"), "reliability");
  assert.equal(methodNameOf("mediation", { mediator: "TRUST" }), "regression");
  assert.equal(methodNameOf("mediation", {}), "mediation", "no mediator named: not guessed");
  assert.deepEqual(testOptions("latent_class", { classes_min: 2, classes_max: 5 }), { minClasses: 2, maxClasses: 5 });
});

test("the model's own latent class action from the live eval is planned", async () => {
  const { SurveyDefinition } = await import("@rescript/schema");
  const { applySurveyActions, coerceSurveyActions } = await import("./surveyActions.js");
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1.0" }, questions: [1, 2, 3, 4].map((k) => ({ id: `u${k}`, code: `U${k}`, variableName: `U${k}`, type: "single_select", text: `Feature ${k}`, options: ["Never", "Sometimes", "Often"].map((l, i) => ({ code: i + 1, label: l })) })), flow: [{ type: "page", id: "p1", questionIds: ["u1", "u2", "u3", "u4"] }] });
  const raw = [{ op: "add_analysis_test", id: "LCA_FEATURE_USAGE", type: "latent_class_analysis", label: "LCA on Feature Usage (U1–U4)", indicators: ["U1", "U2", "U3", "U4"], indicator_scale: "ordinal", classes_min: 2, classes_max: 5, fit_criteria: ["BIC", "AIC"] }];
  const c = coerceSurveyActions(raw);
  const r = applySurveyActions(def, c.actions);
  assert.equal(r.results[0]?.ok, true, JSON.stringify({ c, r: r.results[0] }));
});
