import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { SurveyDefinition } from "@rescript/schema";
import { exportSurveyDocx, EXPORT_PRESETS } from "./index.js";

/**
 * READING THE DOCUMENT BACK.
 *
 * Every docx assertion in this package was `buf.length > 5000` — which passes
 * just as happily for a document that says nothing about masking as for one
 * that says everything. A .docx is a zip, and `word/document.xml` inside it is
 * a single deflate stream, so it can be read with nothing but `node:zlib`: no
 * new dependency, and from here on a test can assert what the document
 * actually says.
 */
export function docxText(buf: Buffer): string {
  const name = Buffer.from("word/document.xml");
  // scan local file headers (PK\x03\x04) for the entry, then inflate its data
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    if (nameLen !== name.length) continue;
    if (!buf.subarray(i + 30, i + 30 + nameLen).equals(name)) continue;
    const method = buf.readUInt16LE(i + 8);
    let size = buf.readUInt32LE(i + 18);
    const start = i + 30 + nameLen + extraLen;
    // streamed entries write 0 here and put the sizes in a trailing
    // descriptor; inflating to the end of the buffer is safe either way
    const raw = buf.subarray(start, size ? start + size : buf.length);
    const xml = (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");
    return xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  throw new Error("word/document.xml not found in the .docx");
}

const brands = [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }];

function def() {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "MASKED", title: "Masked survey" },
    calculations: [{ id: "c1", targetVariable: "N_USED", label: "Brands used", expression: "count(USED)" }],
    quotas: [{
      id: "qt1", name: "Gender", mode: "hard", targetTotal: 100,
      cells: [{ id: "c", label: "Women", limit: 50, limitType: "count",
        when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 } }],
    }],
    listFills: [{
      id: "lf1", name: "PICKS",
      source: { kind: "question", questionId: "q1", take: "selected" },
      selection: { count: { kind: "fixed", value: 2 } },
      options: [{ code: "1", label: "Alpha", priority: 1, target: 40, maximum: 50 }, { code: "2", label: "Beta", priority: 2 }],
      destinations: [{ id: "d1", questionId: "q3", position: 1, write: "answer" }],
    }],
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Aware?", required: true, options: brands },
      {
        id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Used?", options: brands,
        mask: { label: "only the aware", expr: { kind: "ref", questionId: "q1", selection: "selected" }, action: "display" },
      },
      {
        id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Segment", options: [{ code: "hi", label: "High" }, { code: "lo", label: "Low" }],
        punches: [
          { id: "p1", source: { kind: "codes", codes: ["hi"] }, action: "select", mode: "if", recompute: "always",
            when: { type: "rule", source: { kind: "question", ref: "q1", count: { of: "selected", scope: "options" } }, operator: "gte", value: 2 } },
          { id: "p2", source: { kind: "codes", codes: ["lo"] }, action: "select", mode: "else" },
        ],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
      { type: "end", id: "e_screen", status: "screened", redirectUrl: "https://example.org/out" },
      { type: "end", id: "e1", status: "complete", redirectUrl: "https://example.com/done" },
    ],
  });
}

test("a mask appears in the document, as an expression AND as a sentence", async () => {
  const text = docxText(await exportSurveyDocx(def(), EXPORT_PRESETS.full));
  assert.match(text, /MASKING/, "the section exists");
  assert.match(text, /Show only: Q1\.Selected/, "the expression a programmer retypes");
  assert.match(text, /what Q1 selected/, "and the sentence a client reads");
  assert.match(text, /only the aware/, "the mask's own label");
});

test("unticking Masking removes it, rather than leaving it empty", async () => {
  const text = docxText(await exportSurveyDocx(def(), { ...EXPORT_PRESETS.full, masking: false }));
  assert.ok(!text.includes("MASKING"), "no masking section");
  assert.ok(!text.includes("Q1.Selected"), "and no expression either");
  assert.match(text, /Used\?/, "but the question is still documented");
});

test("an auto-punch chain is documented in if / else order", async () => {
  const text = docxText(await exportSurveyDocx(def(), EXPORT_PRESETS.full));
  assert.match(text, /AUTO-PUNCH/);
  assert.match(text, /IF .*THEN SELECT \[hi\] into Q3/);
  assert.match(text, /ELSE SELECT \[lo\] into Q3/);
  const off = docxText(await exportSurveyDocx(def(), { ...EXPORT_PRESETS.full, autoPunch: false }));
  assert.ok(!off.includes("AUTO-PUNCH"));
});

test("a question marked required in the Studio is not exported as optional", async () => {
  const text = docxText(await exportSurveyDocx(def(), EXPORT_PRESETS.full));
  const line = text.split("\n").find((l) => l.includes("variable Q1")) ?? "";
  assert.match(line, /Required/, `Q1 has required: true — got “${line.trim()}”`);
});

test("an end node says where the respondent is sent", async () => {
  const text = docxText(await exportSurveyDocx(def(), EXPORT_PRESETS.full));
  assert.match(text, /Redirect to https:\/\/example\.org\/out/, "the screen-out URL");
  assert.match(text, /Redirect to https:\/\/example\.com\/done/, "and the completion URL");
});

test("the appendix carries the calculations, quotas and List Fill", async () => {
  const text = docxText(await exportSurveyDocx(def(), EXPORT_PRESETS.full));
  assert.match(text, /CALCULATED VARIABLES/);
  assert.match(text, /QUOTAS/);
  assert.match(text, /LIST FILL ALLOCATION/);
  assert.match(text, /PICKS/, "the List Fill is named");

  const off = docxText(await exportSurveyDocx(def(), {
    ...EXPORT_PRESETS.full, calculations: false, quotas: false, listFill: false,
  }));
  assert.ok(!off.includes("CALCULATED VARIABLES"));
  assert.ok(!off.includes("LIST FILL ALLOCATION"));
});

test("the basic preset is still a client-facing questionnaire, not a spec", async () => {
  const text = docxText(await exportSurveyDocx(def(), EXPORT_PRESETS.basic));
  assert.ok(!text.includes("MASKING"), "no masking");
  assert.ok(!text.includes("AUTO-PUNCH"), "no punches");
  assert.ok(!text.includes("CALCULATED VARIABLES"), "no appendix");
  assert.match(text, /Aware\?/, "but every question is there");
});
