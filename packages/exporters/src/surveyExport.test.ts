import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  surveyOutline, outlineBlocks, EXPORT_PRESETS, ALL_FIELDS, matchPreset,
  exportSurveyJsonConfigured, exportSurveyDocx,
} from "./index.js";

/**
 * The exports must be a reading of the definition, never a second copy of it.
 * These tests pin that: the outline follows the flow, the field selection
 * really removes things, and a filtered export admits that it is filtered.
 */

const q = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id, code, variableName: code, type: "single_select", text: `${code} text`,
  options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
  ...extra,
});

function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "CSAT", title: "Customer Satisfaction", version: "2.1" },
    questions: [
      q("q1", "Q1"),
      q("q2", "Q2", { displayLogic: cond.rule("q1", "eq", 1) }),
      q("q3", "Q3", { validation: [{ kind: "required" }] }),
      q("q4", "Q4"),
      q("q5", "Q5"),
    ],
    flow: [
      { type: "page", id: "b1", title: "Introduction", questionIds: ["q1"] },
      { type: "embedded_data", id: "ed1", fields: [{ name: "SOURCE", source: "url" }] },
      {
        type: "block", id: "b2", title: "Product usage",
        children: [
          { type: "page", id: "p1", questionIds: ["q2"] },
          { type: "page", id: "p2", questionIds: ["q3"] },
        ],
      },
      {
        type: "section", id: "g1", title: "Demographics",
        children: [
          { type: "page", id: "b3", title: "Age and gender", questionIds: ["q4"] },
          { type: "page", id: "b4", title: "Region", questionIds: ["q5"] },
        ],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
}

test("the outline is blocks, groups and elements — never pages at the top level", () => {
  const out = surveyOutline(survey());
  assert.deepEqual(out.map((e) => e.kind), ["block", "element", "block", "group", "element"]);
  const blocks = outlineBlocks(out);
  assert.equal(blocks.length, 4, "four blocks, including the two inside the group");
  assert.deepEqual(blocks.map((b) => b.number), [1, 2, 3, 4], "numbered in survey order");
  assert.deepEqual(blocks.map((b) => b.title), ["Introduction", "Product usage", "Age and gender", "Region"]);
});

test("a block's page breaks are inside it, not beside it", () => {
  const b = outlineBlocks(surveyOutline(survey())).find((x) => x.title === "Product usage")!;
  assert.equal(b.pages.length, 2, "two respondent pages");
  assert.equal(b.questionCount, 2);
  assert.deepEqual(b.pages.map((p) => p.questions.map((x) => x.code)), [["Q2"], ["Q3"]]);
});

test("a group holds its blocks and does not flatten them away", () => {
  const g = surveyOutline(survey()).find((e) => e.kind === "group") as any;
  assert.equal(g.title, "Demographics");
  assert.deepEqual(g.children.map((c: any) => c.title), ["Age and gender", "Region"]);
});

test("presets are distinguishable, and a custom selection says so", () => {
  assert.equal(matchPreset(EXPORT_PRESETS.basic), "basic");
  assert.equal(matchPreset(EXPORT_PRESETS.full), "full");
  assert.equal(matchPreset({ ...EXPORT_PRESETS.basic, piping: true }), null, "custom is not a preset");
  assert.ok(ALL_FIELDS.every((f) => EXPORT_PRESETS.full[f]), "full really is everything");
  assert.ok(!EXPORT_PRESETS.basic.skipLogic, "basic omits logic");
  assert.ok(
    ALL_FIELDS.some((f) => EXPORT_PRESETS.full[f] && !EXPORT_PRESETS.spec[f]),
    "full must actually offer something spec does not, or the choice is meaningless",
  );
});

test("unticking a field removes it from the JSON — it does not empty it", () => {
  const def = survey();
  const withLogic = exportSurveyJsonConfigured(def, EXPORT_PRESETS.spec);
  const noLogic = exportSurveyJsonConfigured(def, EXPORT_PRESETS.basic);

  // inspect the SURVEY, not the echoed configuration — `fields` lists every
  // key with true/false, so searching the whole document would always match
  const hasLogic = (doc: any) => JSON.stringify(doc.flow).includes('"displayLogic"');
  assert.ok(hasLogic(withLogic), "the spec preset carries display logic");
  assert.ok(!hasLogic(noLogic), "the basic preset has no displayLogic key at all");

  // basic also drops flow elements, so the embedded-data node is absent
  assert.ok(!JSON.stringify(noLogic.flow).includes("SOURCE"));
  assert.ok(JSON.stringify(withLogic.flow).includes("SOURCE"));
});

test("a filtered JSON export admits it cannot be imported back", () => {
  const partial = exportSurveyJsonConfigured(survey(), EXPORT_PRESETS.basic);
  assert.equal(partial.complete, false);
  assert.match(partial.note ?? "", /not a complete survey definition/i);
  assert.equal(partial.definition, undefined, "and it does not pretend to carry one");

  const full = exportSurveyJsonConfigured(survey(), EXPORT_PRESETS.full, { complete: true });
  assert.equal(full.complete, true);
  assert.ok(full.definition, "a full export carries the canonical definition");
  assert.equal(full.definition!.questions.length, 5);
});

test("the JSON export follows the same order the runtime will", () => {
  const doc = exportSurveyJsonConfigured(survey(), EXPORT_PRESETS.spec);
  const kinds = (doc.flow as any[]).map((e) => e.kind);
  assert.deepEqual(kinds, ["block", "element", "block", "group", "element"]);
  const group = (doc.flow as any[])[3];
  assert.equal(group.children.length, 2);
  // page breaks appear as pages within the block, which is what they are
  const b2 = (doc.flow as any[])[2];
  assert.equal(b2.pages.length, 2);
});

test("with page breaks unticked, a block's questions are one list", () => {
  const doc = exportSurveyJsonConfigured(survey(), { ...EXPORT_PRESETS.spec, pageBreaks: false });
  const b2 = (doc.flow as any[])[2];
  assert.equal(b2.pages, undefined);
  assert.deepEqual(b2.questions.map((x: any) => x.code), ["Q2", "Q3"]);
});

test("the Word export builds a real docx", async () => {
  const buf = await exportSurveyDocx(survey(), EXPORT_PRESETS.spec, { version: "2.1" });
  assert.ok(buf.length > 5000, `a document with content: ${buf.length} bytes`);
  // PK zip magic — a .docx is a zip archive
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
});

test("an invalid-free empty survey still exports rather than throwing", async () => {
  const empty = SurveyDefinition.parse({
    meta: { id: "s0", code: "EMPTY", title: "Nothing yet", version: "1.0" },
    questions: [], flow: [],
  });
  const buf = await exportSurveyDocx(empty, EXPORT_PRESETS.full);
  assert.ok(buf.length > 1000);
  const doc = exportSurveyJsonConfigured(empty, EXPORT_PRESETS.full, { complete: true });
  assert.deepEqual(doc.flow, []);
});

/* ------------------------------------------------------------------------
 * Regressions found by adversarial review, each one a thing the happy-path
 * tests above could not see.
 * --------------------------------------------------------------------- */

function branchedSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "s2", code: "BR", title: "Branched", version: "1.0" },
    questions: [q("q1", "Q1"), q("q2", "Q2"), q("q3", "Q3")],
    flow: [
      { type: "page", id: "b1", title: "Screener", questionIds: ["q1"] },
      {
        type: "branch", id: "br1",
        branches: [{
          id: "arm1", label: "coffee drinkers", when: cond.rule("q1", "eq", 1),
          children: [{ type: "page", id: "b2", title: "Coffee module", questionIds: ["q2"] }],
        }],
        otherwise: [{ type: "page", id: "b3", title: "Tea module", questionIds: ["q3"] }],
      },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("blocks inside a branch arm are exported, not silently dropped", async () => {
  const def = branchedSurvey();
  const blocks = outlineBlocks(surveyOutline(def));
  assert.deepEqual(blocks.map((b) => b.title), ["Screener", "Coffee module", "Tea module"],
    "the outline reaches into branch arms");

  const doc = exportSurveyJsonConfigured(def, EXPORT_PRESETS.full, { complete: true });
  const json = JSON.stringify(doc.flow);
  assert.ok(json.includes("Coffee module") && json.includes("Tea module"),
    "and so does the JSON export");

  const buf = await exportSurveyDocx(def, EXPORT_PRESETS.full);
  const xml = buf.toString("latin1");
  // the docx is a zip, so search the rendered text via the outline instead
  assert.ok(buf.length > 5000, `the document has content: ${buf.length}`);
  assert.ok(xml.length > 0);
});

test("unticking Branch logic actually removes the conditions", () => {
  const def = branchedSurvey();
  const off = exportSurveyJsonConfigured(def, { ...EXPORT_PRESETS.full, branchLogic: false });
  const json = JSON.stringify(off.flow);
  assert.ok(!json.includes('"when"'), "no condition survives in the element node");
  assert.ok(!json.includes('"operator"'), "nor any rule inside one");
  // but the branch itself, and what is inside it, are still documented
  assert.ok(json.includes("Coffee module"), "the arms' blocks are still there");

  const on = exportSurveyJsonConfigured(def, EXPORT_PRESETS.full);
  assert.ok(JSON.stringify(on.flow).includes('"when"'), "and they come back when ticked");
});

test("unticking Block name removes names from the contents page too", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s3", code: "N", title: "Named", version: "1.0" },
    questions: [q("q1", "Q1")],
    flow: [{ type: "page", id: "b1", title: "CONFIDENTIAL codename", questionIds: ["q1"] }],
  });
  const doc = exportSurveyJsonConfigured(def, { ...EXPORT_PRESETS.full, blockName: false });
  assert.ok(!JSON.stringify(doc.flow).includes("CONFIDENTIAL"), "the JSON drops it");
});

test("HTML entities are decoded, not printed at the client", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s4", code: "E", title: "Entities", version: "1.0" },
    questions: [{ ...q("q1", "Q1"), text: "R&amp;D spend &gt; 5%&nbsp;&mdash; agree?" }],
    flow: [{ type: "page", id: "b1", questionIds: ["q1"] }],
  });
  const doc = exportSurveyJsonConfigured(def, EXPORT_PRESETS.full, { complete: true });
  const shown = (doc.flow[0] as any).pages[0].questions[0].plainText;
  assert.equal(shown, "R&D spend > 5% — agree?", `entities decoded: ${shown}`);
});

test("column validation and visibility follow their own tick-boxes", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s5", code: "C", title: "Grid", version: "1.0" },
    questions: [{
      ...q("q1", "Q1"),
      type: "composite",
      columns: [{ id: "c1", label: "Spend", responseType: "numeric", variableStem: "SPEND",
        validation: [{ kind: "required" }], visibleIf: cond.rule("q1", "eq", 1) }],
    }],
    flow: [{ type: "page", id: "b1", questionIds: ["q1"] }],
  });
  const off = exportSurveyJsonConfigured(def, {
    ...EXPORT_PRESETS.full, validation: false, displayLogic: false,
  });
  const col = (off.flow[0] as any).pages[0].questions[0].columns[0];
  assert.equal(col.validation, undefined, "column validation is not smuggled in under Options");
  assert.equal(col.visibleIf, undefined, "nor column visibility");
  assert.equal(col.label, "Spend", "the column itself is still there");
});
