import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "./index.js";
import { DECIPHER_FIXTURE } from "./fixtures.js";
import { bulkAccept, type SidePair } from "./sideBySide.js";

const enc = (s: string) => new TextEncoder().encode(s);

test("every source question is paired with what it became, with a confidence per part and the weakest overall", async () => {
  const r = await analyzeImport(enc(DECIPHER_FIXTURE), "project.xml", { surveyId: "d" });
  const pairs = r.report!.sideBySide;
  assert.equal(pairs.length, r.canonical!.questions.length);
  const made = pairs.filter((p) => p.result);
  assert.ok(made.length > 0);
  for (const p of made) {
    assert.ok(p.parts.some((x) => x.part === "type") && p.parts.some((x) => x.part === "text") && p.parts.some((x) => x.part === "options"));
    const order = ["lost", "check", "converted", "same"];
    const weakest = p.parts.map((x) => order.indexOf(x.level)).reduce((a, b) => Math.min(a, b), 3);
    assert.ok(order.indexOf(p.level) <= weakest, `${p.sourceId}: overall is never better than its weakest part`);
  }
  assert.ok(made.some((p) => p.level === "same"), "a plain question converts as written");
});

test("a condition kept as text and a question with no result are flagged; bulk accept never takes a lost part", async () => {
  const forsta = `<?xml version="1.0"?><Project Name="p"><Routing><Nodes>
<Single Name="q1"><Title><Text>Network?</Text></Title><Answers><Answer Precode="1"><Texts><Text>Airtel</Text></Texts></Answer><Answer Precode="2"><Texts><Text>Jio</Text></Texts></Answer></Answers></Single>
<Open Name="q2"><Title><Text>Why?</Text></Title><Condition Expression="f('q1').get() == '1' &amp;&amp; IsMobile()"/></Open>
</Nodes></Routing></Project>`;
  const r = await analyzeImport(enc(forsta), "p.xml", { surveyId: "f" });
  const pairs = r.report!.sideBySide;
  const q1 = pairs.find((p) => p.source.variable === "q1")!, q2 = pairs.find((p) => p.source.variable === "q2")!;
  assert.deepEqual(q1.source.options, ["Airtel", "Jio"]);
  assert.equal(q1.parts.find((x) => x.part === "options")!.level, "same");
  const logic = q2.parts.find((x) => x.part === "logic")!;
  assert.ok(logic.level === "check" || logic.level === "lost", JSON.stringify(logic));
  const all = bulkAccept(pairs, { atLeast: "check" });
  assert.ok(all.accept.includes(q1.sourceId));
  if (logic.level === "lost") {
    assert.ok(!all.accept.includes(q2.sourceId));
    const asked = bulkAccept(pairs, { sourceIds: [q2.sourceId] });
    assert.deepEqual(asked.accept, [], "even named, a lost part is held");
    assert.match(asked.held[0]!.why, /^logic:/);
  }
  const strict = bulkAccept(pairs, { atLeast: "same" });
  assert.ok(!strict.accept.includes(q2.sourceId));
});

test("bulk accept: a rule by level or by ids, holding unresolved references and lost parts with the reason", () => {
  const P = (id: string, level: SidePair["level"], extra: Partial<SidePair> = {}): SidePair => ({ sourceId: id, questionId: id, source: { variable: id, type: "t", text: "", options: [], rows: [], logic: null }, result: { code: id, type: "t", text: "", options: [], rows: [], logic: false }, parts: [{ part: "type", level, detail: "d" }], level, unresolved: [], ...extra });
  const pairs = [P("a", "same"), P("b", "converted"), P("c", "check"), P("d", "lost"), P("e", "same", { unresolved: ["Q9 is not in the survey"] })];
  assert.deepEqual(bulkAccept(pairs, { atLeast: "converted" }).accept, ["a", "b"]);
  const byId = bulkAccept(pairs, { sourceIds: ["c", "d", "e"] });
  assert.deepEqual(byId.accept, ["c"]);
  assert.deepEqual(byId.held.map((h) => h.sourceId), ["d", "e"]);
  assert.match(byId.held[1]!.why, /unresolved: Q9/);
});
