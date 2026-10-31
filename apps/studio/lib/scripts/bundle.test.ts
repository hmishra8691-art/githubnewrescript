import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { exportScripts, importScripts, parseBundle } from "./bundle.ts";

/* S3b item 4 (MM-08): a bundle carries questions by CODE; import maps to the other survey's ids, gates, arrives off */

const source = () => SurveyDefinition.parse({
  meta: { id: "src", code: "SRC", title: "Source" },
  questions: [
    { id: "q_aaa1", code: "AGE", variableName: "AGE", type: "numeric", text: "Age?" },
    { id: "q_aaa2", code: "BRAND", variableName: "BRAND", type: "single_select", text: "Brand?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
    { id: "q_aaa3", code: "ONLYHERE", variableName: "OH", type: "numeric", text: "?" },
  ],
  flow: [{ type: "block", id: "blk_src", title: "Screener", children: [{ type: "page", id: "pg_src1", questionIds: ["q_aaa1", "q_aaa2"] }, { type: "page", id: "pg_src2", questionIds: ["q_aaa3"] }] }, { type: "end", id: "e", status: "complete" }],
  scripts: [
    { id: "sc1", name: "Age band", scope: "question", ref: "q_aaa1", event: "on_change", code: "setCalc('BAND', get('AGE') > 30 ? 2 : 1);", enabled: true },
    { id: "sc2", name: "Leaky", scope: "survey", event: "on_load", code: "fetch('https://x.example');", enabled: false },
    { id: "sc3", name: "Page two", scope: "page", ref: "pg_src2", event: "on_load", code: "log('p2');", enabled: true },
  ],
  ux: { styles: [], animations: [], behaviors: [
    { id: "uxb_s1", label: "Highlight B", target: { kind: "question", questionId: "q_aaa2" }, effects: [], script: 'rs.listen("select", "self", () => { document.querySelector(\'[data-qid="q_aaa2"]\')?.classList.add("hl"); });' },
    { id: "uxb_s2", label: "Pulse on option 2", target: { kind: "option", questionId: "q_aaa2", code: "2" }, on: "select_option", effects: [{ do: "animate", preset: "pulse", target: { kind: "question", questionId: "q_aaa1" } }] },
    { id: "uxb_s3", label: "Only here", target: { kind: "question", questionId: "q_aaa3" }, effects: [], script: 'rs.addClass("self", "x");' },
    { id: "uxb_s4", label: "Block banner", target: { kind: "block", blockId: "blk_src" }, effects: [], script: 'rs.addClass("self", "b");' },
  ] },
});
const target = () => SurveyDefinition.parse({
  meta: { id: "dst", code: "DST", title: "Target" },
  questions: [
    { id: "q_zz9", code: "BRAND", variableName: "BRAND", type: "single_select", text: "Brand?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
    { id: "q_zz8", code: "AGE", variableName: "AGE", type: "numeric", text: "Age?" },
  ],
  flow: [{ type: "block", id: "blk_dst", title: "Screener", children: [{ type: "page", id: "pg_dst1", questionIds: ["q_zz8", "q_zz9"] }] }, { type: "end", id: "e", status: "complete" }],
});

let n = 0;
const ids = (p: string) => `${p}_imp${++n}`;

test("export: format, version, targets by code / block title / page number, ids inside the code carried as id → code", () => {
  const b = exportScripts(source(), undefined, "2026-10-31T00:00:00Z");
  assert.equal(b.format, "rescript-scripts");
  assert.equal(b.version, 1);
  // "all scripts": behaviours with a script + every logic script
  assert.deepEqual(b.items.map((i) => i.name), ["Highlight B", "Only here", "Block banner", "Age band", "Leaky", "Page two"]);
  const hl = b.items[0]!;
  assert.deepEqual(hl.target, { kind: "question", question: "BRAND" });
  assert.deepEqual(hl.ids, { q_aaa2: "BRAND" });
  assert.deepEqual(b.items.find((i) => i.name === "Block banner")!.target, { kind: "block", block: "Screener" });
  assert.equal(b.items.find((i) => i.name === "Age band")!.ref, "AGE");
  assert.equal(b.items.find((i) => i.name === "Page two")!.ref, 2);
  assert.ok(!JSON.stringify(b.items.find((i) => i.name === "Age band")).includes("q_aaa1"), "no source ids in a logic item without them in its code");
  // a selection, including a declarative behaviour, whose effect target is by code too
  const sel = exportScripts(source(), { behaviors: ["uxb_s2"], logic: [] });
  assert.deepEqual(sel.items[0]!.target, { kind: "option", question: "BRAND", code: "2" });
  assert.deepEqual(sel.items[0]!.effects![0]!.target, { kind: "question", question: "AGE" });
});

test("round trip into a survey with different ids: mapped, gated, switched off with a note; unmapped and refused are listed", () => {
  const text = JSON.stringify(exportScripts(source(), { behaviors: ["uxb_s1", "uxb_s2", "uxb_s3", "uxb_s4"], logic: ["sc1", "sc2", "sc3"] }, "2026-10-31T00:00:00Z"));
  const bundle = parseBundle(text);
  assert.ok(typeof bundle !== "string", String(bundle));
  const r = importScripts(target(), bundle, ids, "2026-10-31T00:00:00Z");
  assert.deepEqual(r.added.map((a) => a.name), ["Highlight B", "Pulse on option 2", "Block banner", "Age band"]);
  assert.deepEqual(r.unmapped.map((u) => u.name), ["Only here", "Page two"]);
  assert.match(r.unmapped[0]!.reason, /no question ONLYHERE/);
  assert.match(r.unmapped[1]!.reason, /no page 2/);
  assert.deepEqual(r.refused.map((x) => x.name), ["Leaky"]);
  const hl = r.def.ux!.behaviors.find((b) => b.label === "Highlight B")!;
  assert.equal(hl.target.questionId, "q_zz9");
  assert.ok(hl.script!.includes('[data-qid="q_zz9"]') && !hl.script!.includes("q_aaa2"), "the id inside the code is the new survey's");
  assert.equal(hl.enabled, false);
  assert.match(hl.notes!, /Imported from SRC on 2026-10-31 — switched off/);
  const pulse = r.def.ux!.behaviors.find((b) => b.label === "Pulse on option 2")!;
  assert.deepEqual([pulse.target.questionId, pulse.target.code, pulse.effects[0]!.target!.questionId, pulse.enabled], ["q_zz9", "2", "q_zz8", false]);
  assert.equal(r.def.ux!.behaviors.find((b) => b.label === "Block banner")!.target.blockId, "blk_dst");
  const age = r.def.scripts.find((s) => s.name === "Age band")!;
  assert.deepEqual([age.scope, age.ref, age.event, age.enabled], ["question", "q_zz8", "on_change", false]);
  // the result passes the schema, and the input survey is untouched
  assert.ok(SurveyDefinition.safeParse(r.def).success);
  assert.equal(target().ux?.behaviors.length ?? 0, 0);
  // and back again: what was imported exports by the same codes
  const back = exportScripts(r.def, { behaviors: [hl.id], logic: [age.id] });
  assert.deepEqual(back.items.map((i) => [i.name, i.kind === "logic" ? i.ref : i.target?.question]), [["Highlight B", "BRAND"], ["Age band", "AGE"]]);
});

test("parseBundle: not JSON, another format, another version", () => {
  assert.match(String(parseBundle("{")), /not JSON/);
  assert.match(String(parseBundle(JSON.stringify({ format: "x", version: 1, items: [] }))), /not a script bundle/);
  assert.match(String(parseBundle(JSON.stringify({ format: "rescript-scripts", version: 2, items: [] }))), /version 2 is not supported/);
});
