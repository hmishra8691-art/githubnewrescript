import { test } from "node:test";
import assert from "node:assert/strict";
import { variantRegistry, questionSettingField, QUESTION_VARIANTS } from "@rescript/schema";
import { COMPONENT_API, LOGIC_HELPER_DOCS, NATIVE_FEATURES, NATIVE_ROUTES, SANDBOX_API, SANDBOX_EVENTS, SANDBOX_LIMITS, capabilityGuideText, nativeRouteFor, settableSettings, settingProblem, variantCatalogue, variantCatalogueText, validationKinds } from "./capabilityRegistry.js";
import { UX_SCRIPT_API, UX_SCRIPT_EVENTS, UX_SCRIPT_WRITES } from "./ux.js";
import { SURVEY_ACTION_OPS } from "./surveyActions.js";
import { LOGIC_HELPERS } from "./codeGate.js";
import { scriptAuthoringProblems } from "./uxScriptGuard.js";
import { SurveyDefinition } from "@rescript/schema";

/* S2b item 1: the JavaScript capability registry stays in sync with what it describes */

test("every rs method is in the registry, and nothing else", () => {
  assert.deepEqual(Object.keys(SANDBOX_API).sort(), [...UX_SCRIPT_API].sort(), "a method added to UX_SCRIPT_API must be described in SANDBOX_API (and the other way round)");
  for (const w of UX_SCRIPT_WRITES) assert.equal(SANDBOX_API[w].write, true, `rs.${w} is a write request`);
  for (const [k, v] of Object.entries(SANDBOX_API)) assert.ok(v.effect.length > 8, `rs.${k} has an effect`);
});

test("S3a: every rs method has a signature; every logic helper and the component api are documented", () => {
  for (const [k, v] of Object.entries(SANDBOX_API)) assert.ok(v.sig.startsWith(`rs.${k}`), `rs.${k} signature: ${v.sig}`);
  assert.deepEqual(Object.keys(LOGIC_HELPER_DOCS).sort(), [...LOGIC_HELPERS].sort(), "a helper added to LOGIC_HELPERS must be documented");
  for (const [k, v] of Object.entries(LOGIC_HELPER_DOCS)) { assert.ok(v.sig.startsWith(k), k); assert.ok(v.effect.length > 8, k); }
  for (const w of ["set", "setCalc", "setEmbedded", "flag"] as const) assert.equal(LOGIC_HELPER_DOCS[w].write, true, w);
  assert.deepEqual(Object.keys(COMPONENT_API).sort(), ["api", "api.getValue", "api.onChange", "api.question", "api.setValue", "el"]);
});

test("every script event is in the registry, validate and submit included", () => {
  assert.deepEqual(Object.keys(SANDBOX_EVENTS).sort(), [...UX_SCRIPT_EVENTS].sort());
  assert.match(SANDBOX_EVENTS.validate, /rs\.error/);
  assert.ok(SANDBOX_LIMITS.some((l) => /no network/.test(l)) && SANDBOX_LIMITS.some((l) => /60 s/.test(l)) && SANDBOX_LIMITS.some((l) => /never another question on screen/.test(l)));
});

test("every variant is catalogued with its base type, a purpose and settings the schema knows", () => {
  const cat = variantCatalogue();
  assert.equal(cat.length, variantRegistry.all().length);
  assert.equal(cat.length, QUESTION_VARIANTS.length, "a variant added to variants.ts is in the catalogue");
  assert.ok(cat.length >= 173);
  for (const v of cat) {
    assert.ok(v.baseType && v.purpose.length > 3, `${v.id} has a base type and a purpose`);
    for (const s of v.settings) assert.ok(questionSettingField(s.key), `${v.id}.${s.key} is a schema settings field`);
  }
  // every key a variant declares in the registry is settable unless another action owns it
  for (const v of variantRegistry.all()) {
    const declared = Object.keys((v.defaults as { settings?: Record<string, unknown> } | undefined)?.settings ?? {});
    const settable = settableSettings(v.id);
    for (const k of declared) if (questionSettingField(k) && !["expression", "hidden", "defaultValue", "designRef", "mediaUrl", "imageUrl", "mediaItems", "adaptive", "versionBalance", "videos", "interviewVideo", "accessibility", "mapCenter", "swipeDirections", "scalePointLabels", "mediaDisplay", "readOnly"].includes(k)) assert.ok(settable.includes(k), `${v.id} declares ${k}`);
  }
});

test("each family has at least one settable key", () => {
  const fams = new Set(variantRegistry.all().map((v) => v.family));
  for (const f of fams) assert.ok(variantRegistry.all().filter((v) => v.family === f).some((v) => settableSettings(v.id).length > 0), f);
});

test("every action the registry names exists in the action vocabulary", () => {
  const ops = new Set<string>(SURVEY_ACTION_OPS);
  for (const f of NATIVE_FEATURES) for (const a of f.actions) assert.ok(ops.has(a), `${f.id}: ${a} is an action`);
  for (const r of NATIVE_ROUTES) for (const a of r.actions) assert.ok(ops.has(a), `${r.id}: ${a} is an action`);
});

test("validation kinds include severity-capable universal kinds", () => {
  const k = validationKinds();
  for (const x of ["required", "condition", "min_value", "max_value", "min_selections", "pattern"]) assert.ok(k.includes(x), x);
  assert.match(capabilityGuideText(), /severity "warning"/);
});

test("nativeRouteFor: deterministic routes for needs and refusals", () => {
  assert.equal(nativeRouteFor("click the Next button after 5 seconds")?.id, "press_next");
  assert.equal(nativeRouteFor("use localStorage to remember the answer")?.id, "storage");
  assert.equal(nativeRouteFor("fetch the price from our API")?.id, "network");
  assert.equal(nativeRouteFor("randomize the four concepts equally")?.id, "randomizer");
  assert.equal(nativeRouteFor("warn when the total exceeds 100")?.id, "validation");
  assert.equal(nativeRouteFor("prefill Q1 from the URL")?.kind, "cannot");
  assert.equal(nativeRouteFor("terminate respondents under 18")?.id, "skip_terminate");
  assert.equal(nativeRouteFor(""), null);
  assert.equal(nativeRouteFor("hello"), null);
  const a = nativeRouteFor("click the Next button"), b = nativeRouteFor("click the Next button");
  assert.deepEqual(a, b);
});

test("the gate's refusals end with the registry's route text", () => {
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const text = scriptAuthoringProblems(`rs.after(30000, function(){ document.querySelector('[data-testid="rs-next"]').click(); });`, def as never).join(" ");
  assert.ok(text.includes(NATIVE_ROUTES.find((x) => x.id === "press_next")!.route), text);
});

test("settingProblem: undeclared keys refused with the declared list; values checked", () => {
  assert.match(settingProblem("single_select.radio", "timeLimitSeconds", 30)!, /its settings are .*columnsLayout/);
  assert.equal(settingProblem("gamified.timed", "timeLimitSeconds", 30), null);
  assert.match(settingProblem("gamified.timed", "timeLimitSeconds", 0)!, /between 1 and 3600/);
  assert.match(settingProblem("gamified.timed", "onTimeout", "explode")!, /not a valid onTimeout/);
  assert.equal(settingProblem("single_select.radio", "columnsLayout", 2), null);
  assert.match(settingProblem("single_select.radio", "columnsLayout", 9)!, /between 1 and 4/);
});

test("the renderings are compact and complete", () => {
  const g = capabilityGuideText();
  for (const m of UX_SCRIPT_API) assert.ok(g.includes(`rs.${m}`), m);
  const c = variantCatalogueText();
  assert.equal(c.split("\n").length, variantRegistry.all().length);
  assert.ok(c.includes("gamified.timed (single_select)") || c.includes("gamified.timed ("), c.slice(0, 200));
  assert.ok(variantCatalogueText({ families: ["hotspot"] }).split("\n").every((l) => l.startsWith("hotspot.")));
});

test("the explain answer names the native route for a refused script", async () => {
  const { explainScripts } = await import("./scriptExplain.js");
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], scripts: [{ id: "ls1", name: "Sender", scope: "survey", event: "on_load", code: "fetch('https://x.example/p?a=' + get('Q1'));" }] });
  const r = explainScripts(def, "why does the script Sender not work");
  assert.match(r.answer, /refused by the script check/);
  assert.match(r.answer, /Native route: A script cannot send anything off the page/);
});
