import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { decideListFill, listFillVariables, listFillVariableNames, customListVariable, listFillCustomScript } from "./listFill.js";
import { applyListFillAction, coerceListFillAction } from "./listFillActions.js";
import type { ResponseState } from "./state.js";
import "./listFillSettled.js";

/* S4c item 5 (D21 / PU-13): List Fill method "custom" — the logic script's list decides; foreign codes dropped and
   logged; quotas / limits after it; priority + quota ONLY when the script produced nothing, with a note */

const base = {
  meta: { id: "s", code: "S", title: "List fill custom", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands?", options: ["A", "B", "C", "D", "E"].map((c) => ({ code: c, label: `Brand ${c}` })) },
    { id: "q2", code: "Q2", variableName: "PICK", type: "single_select", text: "Rate", options: [{ code: "x", label: "x" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [{ id: "scr1", name: "Pick brands", scope: "survey", event: "on_submit", enabled: true, code: "setCalc('LISTFILL_BRANDS_CUSTOM', ['C','A'])" }],
};
const lf = (selection: Record<string, unknown> = {}, options: Record<string, unknown>[] = ["A", "B", "C", "D", "E"].map((c, i) => ({ code: c, priority: i + 1 }))) => ({
  id: "lf1", name: "BRANDS", enabled: true,
  source: { kind: "question", questionId: "q1", take: "selected" },
  selection: { count: { kind: "fixed", n: 2 }, method: "custom", scriptId: "scr1", ...selection },
  tracking: { sampleLevel: true }, options, destinations: [],
});
const def = (l = lf()) => SurveyDefinition.parse({ ...base, listFills: [l] });
const st = (calc: Record<string, unknown> = {}): ResponseState => ({
  surveyId: "s", surveyVersion: "1", sessionId: "sess-custom", seed: 42, startedAt: "2026-11-01T10:00:00Z", status: "in_progress",
  answers: { q1: ["A", "B", "C", "D"] } as ResponseState["answers"], embedded: {}, calculated: calc as ResponseState["calculated"], flags: [], stepIndex: 0,
});

test("the script's list is the selection, in its order (not priority order)", () => {
  const d = def();
  const r = decideListFill({ def: d, listFill: d.listFills[0]!, state: st({ LISTFILL_BRANDS_CUSTOM: ["C", "A"] }) });
  assert.deepEqual(r.items.map((i) => i.code), ["C", "A"]);
  assert.equal(r.trace.custom?.fallback, false);
  assert.equal(r.trace.note, undefined);
  assert.equal(listFillVariables(d.listFills[0]!, r).LISTFILL_BRANDS_CUSTOM_FALLBACK, 0);
  // a comma string works too; the count still limits
  const s2 = decideListFill({ def: d, listFill: d.listFills[0]!, state: st({ LISTFILL_BRANDS_CUSTOM: "D,C,B" }) });
  assert.deepEqual(s2.items.map((i) => i.code), ["D", "C"]);
});

test("foreign / ineligible codes are dropped and logged; quotas and maximums still apply; no top-up from the fallback", () => {
  const d = def(lf({}, [{ code: "A", priority: 1, maximum: 5 }, { code: "B", priority: 2 }, { code: "C", priority: 3 }, { code: "D", priority: 4 }, { code: "E", priority: 5 }]));
  const r = decideListFill({ def: d, listFill: d.listFills[0]!, state: st({ LISTFILL_BRANDS_CUSTOM: ["Z", "E", "A"] }), counts: { lf1: { A: 5 } } });
  // Z is no code at all, E was not selected by the respondent (not a candidate), A is at its maximum
  assert.deepEqual(r.items.map((i) => i.code), []);
  assert.deepEqual(r.trace.custom?.dropped.map((x) => x.code), ["Z", "E", "A"]);
  assert.match(r.trace.custom!.dropped[2]!.why, /maximum/i);
  assert.match(r.trace.steps.join("\n"), /Custom: LISTFILL_BRANDS_CUSTOM = Z, E, A — dropped Z/);
  assert.match(r.trace.note ?? "", /dropped/);
});

test("the script produced nothing → priority + quota decides, with a note and LISTFILL_<NAME>_CUSTOM_FALLBACK = 1", () => {
  const d = def();
  for (const calc of [{}, { LISTFILL_BRANDS_CUSTOM: [] }, { LISTFILL_BRANDS_CUSTOM: "" }]) {
    const r = decideListFill({ def: d, listFill: d.listFills[0]!, state: st(calc) });
    assert.deepEqual(r.items.map((i) => i.code), ["A", "B"], JSON.stringify(calc));
    assert.equal(r.trace.custom?.fallback, true);
    assert.match(r.trace.note ?? "", /produced no list .* priority \+ quota/);
    assert.equal(listFillVariables(d.listFills[0]!, r).LISTFILL_BRANDS_CUSTOM_FALLBACK, 1);
  }
  assert.ok(listFillVariableNames(d.listFills[0]!).some((v) => v.name === "LISTFILL_BRANDS_CUSTOM_FALLBACK"));
});

test("customList names the variable; listFillCustomScript resolves by id or name, enabled only", () => {
  const d = def(lf({ customList: "MY_PICKS", scriptId: "Pick brands" }));
  assert.equal(customListVariable(d.listFills[0]!), "MY_PICKS");
  assert.equal(listFillCustomScript(d, d.listFills[0]!)?.id, "scr1");
  const r = decideListFill({ def: d, listFill: d.listFills[0]!, state: st({ MY_PICKS: ["B"] }) });
  assert.deepEqual(r.items.map((i) => i.code), ["B"]);
  const off = SurveyDefinition.parse({ ...base, scripts: [{ ...base.scripts[0], enabled: false }], listFills: [lf()] });
  assert.equal(listFillCustomScript(off, off.listFills[0]!), null);
});

test("IM: create_list_fill method custom with script (by name) — refused without a script or with an unknown one", () => {
  const env = { question: (ref: string) => def().questions.find((q) => q.code === ref || q.variableName === ref || q.id === ref), condition: () => { throw new Error("no condition"); }, ids: (p: string) => `${p}_1` } as never;
  const d0 = SurveyDefinition.parse({ ...base, listFills: [] });
  const a = coerceListFillAction("create_list_fill", { name: "TOP2", source: "Q1", count: 2, method: "custom", script: "Pick brands" });
  assert.equal(typeof a, "object", String(a));
  applyListFillAction(d0, a as never, env);
  const l = d0.listFills.find((x) => x.name === "TOP2");
  assert.ok(l);
  assert.equal(l!.selection.method, "custom");
  assert.equal(l!.selection.scriptId, "scr1");
  const none = coerceListFillAction("create_list_fill", { name: "T3", source: "Q1", count: 2, method: "custom" });
  assert.throws(() => applyListFillAction(d0, none as never, env), /method custom needs a script/);
  const bad = coerceListFillAction("create_list_fill", { name: "T4", source: "Q1", count: 2, method: "custom", script: "Nope" });
  assert.throws(() => applyListFillAction(d0, bad as never, env), /no logic script “Nope”/);
});
