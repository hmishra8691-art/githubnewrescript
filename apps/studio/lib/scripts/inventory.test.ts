import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { codeInventory, filterInventory } from "./inventory.ts";

/* S3b item 3: every piece of code in the survey, one row each — kind, where, events, on/off, verdict, reads/writes, health id */

export const fixture = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [
    { id: "q_age", code: "AGE", variableName: "AGE", type: "numeric", text: "Age?", customCss: ".x{color:red}" },
    { id: "q_w", code: "W1", variableName: "W1", type: "custom_component", text: "Widget", customJs: "api.onChange((v) => { el.textContent = v; });", customHtml: "<b>hi</b>" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_age", "q_w"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [{ id: "sc1", name: "Total", scope: "question", ref: "q_age", event: "on_change", code: "setCalc('TOTAL', get('AGE'));", enabled: false }],
  branding: { headerHtml: "<p onclick=\"x()\">Hi</p>", customCss: "body{}" },
  ux: { styles: [], animations: [], behaviors: [
    { id: "b1", label: "Warn", target: { kind: "question", questionId: "q_age" }, effects: [], script: 'rs.listen("answer", "AGE", (e) => { if (rs.getAnswer("AGE") > 90) rs.addClass("self", "warn"); });' },
    { id: "b2", label: "Bad", target: { kind: "survey" }, effects: [], script: "fetch('https://x.example');", enabled: false },
    { id: "b3", label: "Plain", target: { kind: "survey" }, on: "page_enter", effects: [{ do: "animate", preset: "pulse" }] },
  ] },
});

test("one row per code item, with where / events / on-off / verdict / refs / health id", () => {
  const rows = codeInventory(fixture());
  const by = (k: string) => rows.find((r) => r.key === k)!;
  assert.deepEqual(rows.map((r) => r.key).sort(), ["branding_css:branding:css", "branding_header:branding:header", "component_html:q_w:html", "component_js:q_w:js", "logic_script:sc1", "question_css:q_age:css", "ux_script:b1", "ux_script:b2"]);
  const w = by("ux_script:b1");
  assert.equal(w.where, "AGE");
  assert.ok(w.events.includes("answer AGE"), w.events.join());
  assert.equal(w.enabled, true);
  assert.equal(w.verdict.status, "passed");
  assert.deepEqual(w.reads, ["AGE"]);
  assert.equal(w.healthId, "b1");
  assert.deepEqual(w.edit, { type: "behavior", id: "b1" });
  const bad = by("ux_script:b2");
  assert.equal(bad.enabled, false);
  assert.equal(bad.verdict.status, "refused");
  const l = by("logic_script:sc1");
  assert.deepEqual([l.where, l.events, l.enabled, l.writes], ["question AGE", ["on_change"], false, ["TOTAL"]]);
  const c = by("component_js:q_w:js");
  assert.deepEqual([c.healthId, c.events, c.enabled], ["uxb_component_q_w", ["render", "answer change"], null]);
  assert.equal(by("branding_header:branding:header").verdict.status, "sanitised");
  assert.deepEqual(by("question_css:q_age:css").edit, { type: "question", questionId: "q_age", field: "customCss" });
});

test("filters: kind group, text (name, code, refs), problems (verdict or failing live), switched off", () => {
  const rows = codeInventory(fixture());
  assert.deepEqual(filterInventory(rows, { kind: "behaviour" }).map((r) => r.id), ["b1", "b2"]);
  assert.deepEqual(filterInventory(rows, { kind: "logic" }).map((r) => r.id), ["sc1"]);
  assert.deepEqual(filterInventory(rows, { text: "total" }).map((r) => r.id), ["sc1"]);
  assert.deepEqual(filterInventory(rows, { text: "rs.addClass" }).map((r) => r.id), ["b1"]);
  assert.deepEqual(filterInventory(rows, { problems: true }).map((r) => r.id).sort(), ["b2", "branding:header"]);
  assert.deepEqual(filterInventory(rows, { problems: true }, (h) => h === "b1").map((r) => r.id).sort(), ["b1", "b2", "branding:header"]);
  assert.deepEqual(filterInventory(rows, { off: true }).map((r) => r.id).sort(), ["b2", "sc1"]);
});
