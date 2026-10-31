import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import type { VerificationReport, VerifyItem } from "@rescript/engine";
import { editorRunInput, runEditorTest, runLog, runMarkers } from "./testRun.ts";

/* S3b item 6 (MM-15): the editor's test run hands the harness the UNSAVED text, never the stored code */

const def = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [
    { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "W", variableName: "W", type: "custom_component", text: "W", customJs: "el.textContent = 'saved';" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [{ id: "sc1", name: "Calc", scope: "question", ref: "Q1", event: "on_change", code: "setCalc('X', 1);", enabled: false }],
  ux: { styles: [], animations: [], behaviors: [{ id: "b1", label: "Hl", target: { kind: "question", questionId: "q1" }, effects: [], script: "rs.addClass('self','saved');", enabled: false }] },
});

const report = (item: VerifyItem, errors: { message: string; line?: number }[] = []): VerificationReport => ({
  signature: "x", at: "now", durationMs: 5,
  items: [{ key: item.key, kind: item.kind, label: item.label, ran: true, hostRefusals: [], watchdog: [], timedOut: false, durationMs: 5,
    scenarios: [{ id: "s1", label: "select Q1 = 1", errors, effects: [{ kind: "class", target: "Q1", detail: "hl" }], writes: [{ call: 'setCalc("X")', target: "X", ok: true, value: 1 }], logs: ["hello"], next: { blocked: false, errors: [], byScript: 0 } }] }],
  verdicts: [{ key: item.key, label: item.label, verdict: errors.length ? "ran-error" : "ran-ok", summary: errors.length ? "error" : "ok", detail: [], scenarios: 1 }],
});

test("the harness gets the editor's unsaved text — in the item AND in the survey it runs — and a switched-off item runs", async () => {
  const d = def();
  let got: { def: SurveyDefinition; items: VerifyItem[] } | null = null;
  const r = await runEditorTest(d, { kind: "behaviour", id: "b1" }, "rs.addClass('self','UNSAVED');", async (def2, items) => { got = { def: def2, items }; return report(items[0]!); });
  assert.ok(!("error" in r));
  assert.equal(got!.items[0]!.code, "rs.addClass('self','UNSAVED');");
  assert.equal(got!.items[0]!.questionId, "q1");
  const b = got!.def.ux!.behaviors[0]!;
  assert.equal(b.script, "rs.addClass('self','UNSAVED');");
  assert.equal(b.enabled, undefined, "switched on in the clone");
  assert.equal(d.ux!.behaviors[0]!.script, "rs.addClass('self','saved');", "the survey itself is untouched");
  assert.equal(d.ux!.behaviors[0]!.enabled, false);
});

test("logic and component items: the unsaved code, event / scope / question", () => {
  const l = editorRunInput(def(), { kind: "logic", id: "sc1" }, "setCalc('X', 2);");
  assert.ok(!("error" in l));
  assert.deepEqual([l.item.kind, l.item.code, l.item.event, l.item.scope, l.item.questionId, l.def.scripts[0]!.code, l.def.scripts[0]!.enabled], ["logic", "setCalc('X', 2);", "on_change", "question", "q1", "setCalc('X', 2);", true]);
  const c = editorRunInput(def(), { kind: "component", questionId: "q2" }, "el.textContent = 'new';");
  assert.ok(!("error" in c));
  assert.deepEqual([c.item.kind, c.item.code, c.def.questions[1]!.customJs], ["component", "el.textContent = 'new';", "el.textContent = 'new';"]);
  assert.match((editorRunInput(def(), { kind: "behaviour", id: "nope" }, "x") as { error: string }).error, /save the script once/);
  assert.match((editorRunInput(def(), { kind: "logic", id: "sc1" }, "  ") as { error: string }).error, /no code/);
});

test("the run log lists logs, errors with lines, effects, writes, Next; errors with a line become markers on that line", () => {
  const code = "const a = 1;\nboom();\nrs.log(a);";
  const item = editorRunInput(def(), { kind: "behaviour", id: "b1" }, code) as { item: VerifyItem };
  const rep = report(item.item, [{ message: "boom is not defined", line: 2 }, { message: "again", line: 2 }, { message: "no line" }]);
  const log = runLog(rep);
  assert.deepEqual(log.map((l) => l.kind), ["log", "error", "error", "error", "effect", "write", "next"]);
  assert.equal(log[1]!.line, 2);
  const m = runMarkers(rep, code);
  assert.equal(m.length, 1, "one marker per line");
  assert.deepEqual([m[0]!.from, m[0]!.to, m[0]!.severity], [13, 20, "error"]);
  assert.match(m[0]!.message, /boom is not defined/);
  assert.deepEqual(runMarkers(report(item.item), code), []);
});
