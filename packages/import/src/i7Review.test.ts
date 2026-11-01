import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { analyzeImport, readSource, outline, exprText, selectBlocks, blockList, mapCanonical, buildImportGraph, COMPAT_LABELS } from "./index.js";
import { qsfFixture } from "./fixtures.js";

/** I7 — the review: six compatibility categories, the flow outline in words, selected blocks */
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
let n = 0;
const uid = (p: string) => `${p}_${++n}`;

test("compatibility: every question in exactly one category, the other elements by their measured outcome, open questions as 'clarify'", async () => {
  const a = await analyzeImport(enc(qsfFixture()), "demo.qsf", { surveyId: "s", uid });
  const comp = a.report!.compatibility;
  assert.deepEqual(Object.keys(comp.counts).sort(), Object.keys(COMPAT_LABELS).sort());
  const qs = comp.items.filter((i) => i.feature === "question");
  assert.equal(qs.length, a.canonical!.questions.length, "one line per source question");
  assert.equal(qs.find((i) => i.sourceId === "QID11")!.category, "unsupported", "the Captcha");
  assert.equal(qs.find((i) => i.sourceId === "QID8")!.category, "configure", "a question carrying custom JavaScript needs configuration");
  assert.ok(comp.items.some((i) => i.category === "configure" && i.feature === "custom_js" && i.sourceId === "QID8"));
  assert.ok(comp.items.some((i) => i.category === "unsupported" && i.feature === "flow_element"), "the WebService element");
  assert.equal(Object.values(comp.counts).reduce((x, y) => x + y, 0), comp.items.length);
});

test("the outline: blocks, branches with their conditions in words, randomizers, embedded data, ends with redirects", async () => {
  const c = (await readSource(enc(qsfFixture()), "demo.qsf")).canonical!;
  const o = outline(c);
  const branch = o.find((x) => x.kind === "branch")!;
  assert.equal(branch.condition, "Q1 = No", "a condition in words, with the answer's label");
  assert.ok(o.some((x) => x.kind === "randomizer" && /show 1.*evenly/.test(x.label)));
  assert.ok(o.some((x) => x.kind === "embedded" && /Country = India/.test(x.label)));
  const q3 = o.find((x) => x.kind === "question" && x.sourceId === "QID3")!;
  assert.equal(q3.condition, "Q1 = Yes"); assert.equal(q3.depth, 1, "a question sits under its block");
  assert.ok(o.findIndex((x) => x.sourceId === "QID1") < o.findIndex((x) => x.sourceId === "QID10"), "in flow order");
  assert.equal(exprText({ t: "group", op: "and", children: [{ t: "cmp", ref: { kind: "question", id: "QID1", choice: "1" }, op: "selected" }, { t: "group", op: "not", children: [{ t: "cmp", ref: { kind: "embedded", id: "Country" }, op: "eq", value: "India" }] }] }, c), "Q1 = Yes AND NOT (ED.Country = India)");
});

test("import selected blocks: only those blocks and their questions; references outside the selection are reported, not rewritten", async () => {
  const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "qsf");
  const c = (await readSource(new Uint8Array(readFileSync(join(DIR, "04-large-121-questions.qsf"))), "04.qsf")).canonical!;
  assert.equal(blockList(c).length, 13);
  const sub = selectBlocks(c, ["BL_2", "BL_3"]);
  assert.equal(sub.questions.length, 20);
  assert.deepEqual(blockList(sub).map((b) => b.id), ["BL_2", "BL_3"]);
  const m = mapCanonical(sub, { surveyId: "s", uid });
  assert.ok(m.def && SurveyDefinition.safeParse(m.def).success);
  /* BL_2's first question is shown on an answer in BL_1, which is not imported */
  assert.ok(buildImportGraph(sub).findings.some((f) => f.kind === "missing_reference" && f.refs[0] === "QID1"), "the dependency on the unselected block is named");
  assert.ok(sub.issues.some((i) => /Only 2 selected blocks were imported \(20 questions\)/.test(i.message)));
  assert.equal(selectBlocks(c, []), c, "no selection = everything");
});
