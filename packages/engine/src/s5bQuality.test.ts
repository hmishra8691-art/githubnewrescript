import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, QUALITY_RULE_PARAMS, TELEMETRY_CATEGORIES } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, describeAction, type SurveyAction } from "./surveyActions.js";
import { SANDBOX_API, NATIVE_FEATURES, nativeRouteFor, capabilityGuideText } from "./capabilityRegistry.js";
import { UX_SCRIPT_API, UX_SCRIPT_WRITES, validateUxScript } from "./ux.js";

/* S5b item 5 (TE-12, TE-13): read-only timing for scripts; set_quality_settings */

const base = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const coerce = (raw: unknown[]) => coerceSurveyActions(raw);
const act = (def: SurveyDefinition, raw: unknown[]) => { const c = coerce(raw); assert.equal(c.rejected.length, 0, JSON.stringify(c.rejected)); const r = applySurveyActions(def, c.actions); assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results)); return r; };

test("set_quality_settings: telemetry switches, idle settings, strictness, rule thresholds — merged and schema-checked", () => {
  const r = act(base, [{ op: "set_quality_settings", enabled: true, strictness: "strict",
    telemetry: { visibility: false, idle: true, idleSeconds: 45, idlePrompt: true, idlePromptText: "Still there?", disclosure: "We time answers." },
    rules: { "timing.overall_speeding": { params: { ratio: 0.35 }, severity: "critical" }, "interaction.flip_flop": { enabled: false }, "matrix.straightline": true } }]);
  const q = r.def.quality!;
  assert.equal(q.enabled, true);
  assert.equal(q.strictness, "strict");
  assert.equal(q.telemetry.visibility, false);
  assert.equal(q.telemetry.idleSeconds, 45);
  assert.equal(q.telemetry.idlePrompt, true);
  assert.equal(q.telemetry.idlePromptText, "Still there?");
  assert.equal(q.telemetry.disclosure, "We time answers.");
  assert.equal(q.telemetry.timing, true, "untouched switches keep their value");
  assert.deepEqual(q.rules["timing.overall_speeding"], { params: { ratio: 0.35 }, severity: "critical" });
  assert.equal(q.rules["interaction.flip_flop"].enabled, false);
  assert.equal(q.rules["matrix.straightline"].enabled, true);
  assert.match(r.results[0].destructive ?? "", /stops recording visibility/);
  // a second call merges, and null removes a text
  const r2 = act(r.def, [{ op: "set_quality_settings", telemetry: { idlePromptText: null }, rules: { "timing.overall_speeding": { params: { ratio: 0.3 } } } }]);
  assert.equal(r2.def.quality!.telemetry.idlePromptText, undefined);
  assert.equal(r2.def.quality!.rules["timing.overall_speeding"].params!.ratio, 0.3);
  assert.equal(r2.def.quality!.rules["timing.overall_speeding"].severity, "critical");
  assert.match(describeAction(coerce([{ op: "set_quality_settings", strictness: "relaxed", rules: { "openend.gibberish": { enabled: false } } }]).actions[0] as SurveyAction), /Set quality settings \(relaxed; 1 rule\)/);
});

test("set_quality_settings refuses unknown rules, thresholds, switches and bad values — with the alternatives", () => {
  const bad = (o: Record<string, unknown>) => { const c = coerce([{ op: "set_quality_settings", ...o }]); assert.equal(c.actions.length, 0); return String(c.rejected[0]?.reason ?? JSON.stringify(c.rejected[0])); };
  assert.match(bad({ rules: { "timing.speedy": { enabled: true } } }), /no quality rule "timing.speedy" — did you mean timing\./);
  assert.match(bad({ rules: { "timing.overall_speeding": { params: { threshold: 1 } } } }), /has no threshold "threshold" — it takes ratio/);
  assert.match(bad({ rules: { "timing.overall_speeding": { severity: "extreme" } } }), /severity must be low \| medium \| high \| critical/);
  assert.match(bad({ telemetry: { keystrokes: true } }), /telemetry.keystrokes is not a setting/);
  assert.match(bad({ telemetry: { idleSeconds: 2 } }), /idleSeconds must be 10–3600/);
  assert.match(bad({ telemetry: { focus: "yes" } }), /telemetry.focus must be true or false/);
  assert.match(bad({ strictness: "paranoid" }), /strictness must be/);
  assert.match(bad({}), /changes nothing/);
});

test("the rule map and the telemetry switches the action accepts are the schema's", () => {
  assert.ok(Object.keys(QUALITY_RULE_PARAMS).length >= 70);
  assert.deepEqual(QUALITY_RULE_PARAMS["interaction.flip_flop"], ["reversals", "questions"]);
  for (const k of TELEMETRY_CATEGORIES) {
    const c = coerce([{ op: "set_quality_settings", telemetry: { [k]: false } }]);
    assert.equal(c.actions.length, 1, k);
  }
});

test("rs.getTiming is a read-only script API, registered, and the capability registry routes paradata to set_quality_settings", () => {
  assert.ok((UX_SCRIPT_API as readonly string[]).includes("getTiming"));
  assert.ok(!(UX_SCRIPT_WRITES as readonly string[]).includes("getTiming" as never), "not a write");
  assert.equal(SANDBOX_API.getTiming.write, undefined);
  assert.match(SANDBOX_API.getTiming.sig, /rs\.getTiming\(\)/);
  assert.deepEqual(validateUxScript("var t = rs.getTiming(); if (t && t.pageSeconds > 30) rs.addClass('self', 'slow');", base).errors, [], "the gate allows it");
  assert.ok(validateUxScript("rs.setTiming(1);", base).errors.length > 0, "there is no write twin");
  const f = NATIVE_FEATURES.find((x) => x.id === "quality_settings")!;
  assert.deepEqual(f.actions, ["set_quality_settings"]);
  assert.equal(nativeRouteFor("turn off the telemetry for scroll depth")?.id, "quality_settings");
  assert.match(capabilityGuideText(), /rs\.getTiming[,.]/);
  assert.match(capabilityGuideText(), /set_quality_settings \{enabled, strictness/);
});
