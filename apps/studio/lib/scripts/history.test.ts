import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { diffStats, diffText, itemAuditEntries, itemCode, lineDiff } from "./history.ts";

/* S3b item 5 (MM-09): one item's code from any version, and a line diff of it — not a JSON line diff */

const def = (script: string | null, logic = "set('X', 1);") => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [{ id: "q1", code: "Q1", variableName: "A", type: "custom_component", text: "?", customJs: "el.textContent = 'a';", customCss: ".a{}" }],
  flow: [{ type: "page", id: "p", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [{ id: "sc1", name: "S", code: logic, enabled: true }],
  branding: { headerHtml: "<p>Hi</p>" },
  ux: { styles: [], animations: [], behaviors: script == null ? [] : [{ id: "b1", label: "B", target: { kind: "survey" }, effects: [], script }] },
});

test("itemCode: by the audit log's key, in any definition; null when the item is not there", () => {
  const d = def("rs.addClass('Q1','x');");
  assert.equal(itemCode(d, "ux_script:b1"), "rs.addClass('Q1','x');");
  assert.equal(itemCode(d, "logic_script:sc1"), "set('X', 1);");
  assert.equal(itemCode(d, "component_js:q1:js"), "el.textContent = 'a';");
  assert.equal(itemCode(d, "question_css:q1:css"), ".a{}");
  assert.equal(itemCode(d, "branding_header:branding:header"), "<p>Hi</p>");
  assert.equal(itemCode(def(null), "ux_script:b1"), null);
  assert.equal(itemCode(null, "ux_script:b1"), null);
});

test("lineDiff: one changed line in the middle, with line numbers on both sides; additions and removals at the ends", () => {
  const a = "line 1\nline 2\nline 3\nline 4";
  const b = "line 1\nline two\nline 3\nline 4\nline 5";
  const d = lineDiff(a, b);
  assert.deepEqual(d.map((x) => `${x.op}:${x.text}`), ["same:line 1", "del:line 2", "add:line two", "same:line 3", "same:line 4", "add:line 5"]);
  assert.deepEqual(d.find((x) => x.op === "del"), { op: "del", text: "line 2", a: 2 });
  assert.deepEqual(d.find((x) => x.text === "line two"), { op: "add", text: "line two", b: 2 });
  assert.deepEqual(d.find((x) => x.text === "line 4"), { op: "same", text: "line 4", a: 4, b: 4 });
  assert.deepEqual(diffStats(d), { added: 2, removed: 1 });
  assert.deepEqual(lineDiff(null, "x\ny").map((x) => x.op), ["add", "add"]);
  assert.deepEqual(lineDiff("x", null).map((x) => x.op), ["del"]);
  assert.deepEqual(lineDiff("same", "same").map((x) => x.op), ["same"]);
  // an insertion keeps the rest aligned (LCS, not a positional compare)
  assert.deepEqual(lineDiff("a\nb\nc", "a\nNEW\nb\nc").map((x) => x.op), ["same", "add", "same", "same"]);
});

test("diffText folds long unchanged runs; itemAuditEntries picks one item's entries", () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l10", "L10");
  const t = diffText(lineDiff(a, b), 2);
  assert.match(t, /… 8 unchanged lines/);
  assert.match(t, /- l10\n\+ L10/);
  const entries = [
    { action: "script.changed", at: "1", who: "Ana", detail: { kind: "ux_script", itemId: "b1" }, text: "x" },
    { action: "script.changed", at: "2", who: "Ana", detail: { kind: "logic_script", itemId: "b1" }, text: "y" },
    { action: "script.disabled", at: "3", who: "Di", detail: { kind: "ux_script", itemId: "b1" }, text: "z" },
  ];
  assert.deepEqual(itemAuditEntries(entries, "ux_script:b1").map((e) => e.at), ["1", "3"]);
});
