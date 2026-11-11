import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codeGate } from "@rescript/engine";
import { analyzeImport, analyzeQualtricsJs } from "./index.js";
import { qsfFixture } from "./fixtures.js";

/**
 * I3 — Qualtrics JavaScript is read, never run: a verdict per script, a
 * translated logic script (switched off) when every call has an equivalent,
 * a native setting when the code is a known pattern, the reasons otherwise.
 */
const js = (body: string, hook = "addOnload") => `Qualtrics.SurveyEngine.${hook}(function(){ ${body} });`;

test("verdicts: compatible, native, partial, incompatible — each with the calls it found", () => {
  const ed = analyzeQualtricsJs(js(`var c = "\${e://Field/Country}"; Qualtrics.SurveyEngine.setEmbeddedData('Seen', c + '1');`), "QID8");
  assert.equal(ed.verdict, "compatible");
  assert.deepEqual(ed.writes.embedded, ["Seen"]); assert.deepEqual(ed.reads.embedded, ["Country"]);
  assert.equal(ed.translated!.event, "on_load");
  assert.equal(ed.translated!.code, `let c = getEmbedded("Country"); setEmbedded('Seen', c + '1');`);
  assert.ok(codeGate(ed.translated!.code, "logic").ok, "the translation passes the real script check");

  const t = analyzeQualtricsJs(js(`Qualtrics.SurveyEngine.setEmbeddedData('s6', '1'); this.hideNextButton(); var that = this; setTimeout(function(){ that.showNextButton(); }, 4500);`), "QID9");
  assert.equal(t.verdict, "native"); assert.deepEqual(t.native && t.native.kind === "page_timer" ? [t.native.kind, t.native.minSeconds] : [], ["page_timer", 5]);
  assert.equal(t.translated!.code, "setEmbedded('s6', '1');", "only the embedded write is translated, not the timer code");

  const mixed = analyzeQualtricsJs(js(`this.setChoiceValue(2, true); Qualtrics.SurveyEngine.setEmbeddedData('x', 1);`), "QID3");
  assert.equal(mixed.verdict, "partial"); assert.equal(mixed.translated, undefined, "no half translation");
  assert.ok(mixed.findings.some((f) => f.call === "setChoiceValue" && /punch rule/.test(f.becomes)));

  assert.equal(analyzeQualtricsJs(js(`jQuery('#'+this.questionId).hide();`, "addOnReady"), "QID4").verdict, "incompatible");
  const net = analyzeQualtricsJs(js(`fetch('https://x.example.com/p?id=\${e://Field/PID}');`, "addOnPageSubmit"), "QID5");
  assert.equal(net.verdict, "incompatible"); assert.equal(net.network, true); assert.deepEqual(net.hooks, [{ hook: "addOnPageSubmit", event: "on_submit" }]);
  assert.equal(analyzeQualtricsJs(js(`window.location = "https://x.example.com";`), "QID6").verdict, "incompatible");
});

test("comments do not count, submit hooks map to on_submit, and a translation the script check refuses is not offered as compatible", () => {
  const c = analyzeQualtricsJs(js(`/* jQuery('#x').hide(); */ // fetch('https://x')\n Qualtrics.SurveyEngine.setEmbeddedData('a', 1);`, "addOnPageSubmit"), "QID1");
  assert.equal(c.verdict, "compatible"); assert.equal(c.network, false); assert.equal(c.translated!.event, "on_submit");
  /* every call translates, but the leftover code reaches for something the gate refuses */
  const g = analyzeQualtricsJs(js(`Qualtrics.SurveyEngine.setEmbeddedData('a', eval('1'));`), "QID2");
  assert.notEqual(g.verdict, "compatible");
});

test("the importer: the fixture's conditional hideNextButton needs a person; the original stays switched off and carries the migration note", async () => {
  let n = 0;
  const a = await analyzeImport(new TextEncoder().encode(JSON.stringify(qsfFixture())), "demo.qsf", { surveyId: "s1", uid: (p) => `${p}_${++n}` });
  const m = a.result!.jsMigrations.find((x) => x.location === "QID8")!;
  assert.equal(m.verdict, "partial");
  const scripts = a.result!.def!.scripts as { name: string; enabled: boolean; notes?: string; code: string }[];
  const orig = scripts.find((s) => s.name === m.scriptName)!;
  assert.equal(orig.enabled, false);
  assert.match(orig.notes ?? "", /Migration: Needs a person/);
  assert.ok(a.report!.scripts.length >= 1);
  assert.ok(a.report!.summary.some((s) => /custom script.* read, none run/.test(s)));
  assert.ok(!scripts.some((s) => s.enabled), "the importer never switches a script on");
});

test("corpus 04: the 'hide Next for 3 s' script becomes the page's native minimum time, its embedded write a migrated script (off)", async () => {
  const f = "04-large-121-questions.qsf";
  const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "qsf");
  let n = 0;
  const a = await analyzeImport(new Uint8Array(readFileSync(join(DIR, f))), f, { surveyId: "s1", uid: (p) => `${p}_${++n}` });
  const mig = a.result!.jsMigrations;
  assert.equal(mig.length, 1); assert.equal(mig[0].verdict, "native");
  const def = a.result!.def!;
  const q = def.questions.find((x) => x.variableName === "B7_2")!;
  const page = JSON.parse(JSON.stringify(def.flow)).flatMap(function all(nd: { children?: unknown[]; questionIds?: string[] }): unknown[] { return [nd, ...((nd.children ?? []) as never[]).flatMap(all)]; }).find((nd: { type: string; questionIds?: string[] }) => nd.type === "page" && nd.questionIds?.includes(q.id)) as { timer?: { minSeconds?: number } };
  assert.equal(page.timer?.minSeconds, 3);
  const scripts = def.scripts as { name: string; enabled: boolean; code: string }[];
  const migrated = scripts.find((s) => s.name.startsWith("Migrated JS"))!;
  assert.equal(migrated.enabled, false); assert.equal(migrated.code, "setEmbedded('seen6', '1');");
  assert.equal(a.result!.inventory.find((i) => i.feature === "custom_js" && i.sourceId === "QID62")?.status, "imported");
});
