import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { SurveyDefinition } from "@rescript/schema";
import { buildCleaningPlanDocx, cleaningPlanRules, definitionHash, stableJson, stampLine, exportSurveyDocx, EXPORT_PRESETS, exportResponsesXlsx } from "./index.js";

/** word/document.xml of a .docx as plain text — the same zip + inflate reader docxText.test.ts uses. */
function docxText(buf: Buffer): string {
  const name = Buffer.from("word/document.xml");
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    if (nameLen !== name.length || !buf.subarray(i + 30, i + 30 + nameLen).equals(name)) continue;
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const start = i + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, size ? start + size : buf.length);
    const xml = (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");
    return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  throw new Error("word/document.xml not found in the .docx");
}

const survey = (quality?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  SurveyDefinition.parse({
    meta: { id: "cp", code: "CLEANP", title: "Plan survey", version: "2.1" },
    ...(quality ? { quality } : {}),
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick the third option", options: [{ code: "a", label: "A" }, { code: "b", label: "B" }, { code: "c", label: "C" }], attentionCheck: { expected: ["c"] } },
      { id: "q2", code: "Q2", variableName: "Q2", type: "long_text", text: "Why?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
    ...extra,
  });

const AT = new Date("2026-10-16T14:03:45Z");

test("DOC-04: the cleaning plan builds, is a real .docx, and has every section", async () => {
  const buf = await buildCleaningPlanDocx(survey(), { generatedAt: AT, revision: 12 });
  assert.equal(buf.subarray(0, 2).toString(), "PK");
  const text = docxText(buf);
  for (const h of ["Data-Cleaning Plan — Plan survey", "1. Purpose", "2. Dataset scope", "3. Settings in force", "4. Rules, thresholds and actions", "5. Duplicates and arrival order", "6. Verdicts and what follows", "7. Review workflow", "8. Override policy", "9. Raw-data preservation", "10. Document stamp"]) {
    assert.ok(text.includes(h), `missing section: ${h}`);
  }
  assert.match(text, /No automatic check deletes or alters a response/, "raw-data preservation statement");
  assert.match(text, /KEEP \(include\), REMOVE \(exclude\), REVIEW LATER/, "review workflow names the decisions");
  assert.match(text, /A researcher may override it either way/, "override policy");
  assert.match(text, /Overall speeding/, "a rule from the catalogue is listed");
  assert.match(text, /Pick the third option — passes with c/, "attention checks are listed");
  assert.match(text, /generated 2026-10-16 14:03 UTC {2}· {2}revision 12 {2}· {2}definition #[0-9a-f]{12}/, "stamp: time, revision, definition hash");
});

test("DOC-04: the plan states the thresholds the engine uses, and follows the survey's settings", async () => {
  const std = cleaningPlanRules(survey());
  const rule = (list: ReturnType<typeof cleaningPlanRules>, id: string) => list.find((r) => r.id === id)!;
  assert.match(rule(std, "timing.overall_speeding").thresholds, /0\.4 × benchmark/, "standard strictness threshold from the catalogue");
  const strict = cleaningPlanRules(survey({ enabled: true, strictness: "strict" }));
  assert.match(rule(strict, "timing.overall_speeding").thresholds, /0\.5 × benchmark/);
  const custom = cleaningPlanRules(survey({ enabled: true, rules: { "timing.overall_speeding": { params: { ratio: 0.55 }, role: "informational" }, "timing.uniform": { enabled: false } } }));
  assert.match(rule(custom, "timing.overall_speeding").thresholds, /0\.55 × benchmark/, "a per-survey override is what the plan states");
  assert.equal(rule(custom, "timing.overall_speeding").role, "informational");
  assert.match(rule(custom, "timing.overall_speeding").action, /never excludes/i);
  assert.equal(rule(custom, "timing.uniform").running, false);
  assert.ok(custom.filter((r) => r.running).length < std.filter((r) => r.running).length + 1);
  const text = docxText(await buildCleaningPlanDocx(survey({ enabled: true, strictness: "strict", rules: { "timing.overall_speeding": { params: { ratio: 0.55 } } } }), { generatedAt: AT }));
  assert.match(text, /0\.55 × benchmark/);
  assert.match(text, /Strict/);
});

test("DOC-04: deterministic — the same definition and time give the same text; a changed threshold changes it", async () => {
  const a = docxText(await buildCleaningPlanDocx(survey(), { generatedAt: AT }));
  const b = docxText(await buildCleaningPlanDocx(survey(), { generatedAt: AT }));
  assert.equal(a, b);
  const c = docxText(await buildCleaningPlanDocx(survey({ enabled: true, bands: { review: 15 } }), { generatedAt: AT }));
  assert.notEqual(a, c);
  assert.match(c, /REVIEW from 15/);
});

test("DOC-04: a survey with quality switched off says so plainly instead of listing rules as running", async () => {
  const text = docxText(await buildCleaningPlanDocx(survey({ enabled: false }), { generatedAt: AT }));
  assert.match(text, /Quality checks are switched OFF for this survey/);
  assert.match(text, /No rule runs under the current settings/);
});

test("CLEAN-03: a survey that says nothing about quality gets a plan with the rules running at standard strictness", async () => {
  const d = survey();
  assert.equal(d.quality.enabled, true);
  assert.ok(cleaningPlanRules(d).filter((r) => r.running).length > 10);
  assert.match(docxText(await buildCleaningPlanDocx(d, { generatedAt: AT })), /Standard/);
});

test("DOC-13: the hash is stable across key order, changes with the definition, and the stamp carries time, revision and hash", () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(definitionHash(survey()), definitionHash(survey()));
  assert.match(definitionHash(survey()), /^[0-9a-f]{12}$/);
  assert.notEqual(definitionHash(survey()), definitionHash(survey({ enabled: true, strictness: "strict" })));
  assert.equal(stampLine({ at: AT, revision: 7, hash: "abc123abc123" }), "exported 2026-10-16 14:03 UTC  ·  revision 7  ·  definition #abc123abc123");
  assert.equal(stampLine({ at: AT, hash: "abc123abc123" }), "exported 2026-10-16 14:03 UTC  ·  definition #abc123abc123", "no revision known → none printed");
});

test("DOC-13: the questionnaire document's stamp line carries time, revision and definition hash", async () => {
  const d = survey();
  const text = docxText(await exportSurveyDocx(d, EXPORT_PRESETS.basic, { version: "2.1", generatedAt: AT, revision: 41 }));
  assert.ok(text.includes(`CLEANP  ·  version 2.1  ·  2 questions  ·  exported 2026-10-16 14:03 UTC  ·  revision 41  ·  definition #${definitionHash(d)}`), text.slice(0, 400));
  const noRev = docxText(await exportSurveyDocx(d, EXPORT_PRESETS.basic, { generatedAt: AT }));
  assert.ok(!/revision/.test(noRev.split("\n").slice(0, 3).join(" ")), "an unknown revision is omitted, not printed as 0");
  assert.ok(noRev.includes(`definition #${definitionHash(d)}`));
});

test("DOC-13: the data workbook's About sheet carries the definition hash", async () => {
  const d = survey();
  const buf = await exportResponsesXlsx(d, [{
    state: { sessionId: "s1", surveyVersion: "2.1", startedAt: "2026-01-01T00:00:00Z", status: "complete", answers: { q1: "c", q2: "x" }, embedded: {}, calculated: {} } as any,
    quality: null, review: { status: null },
  }], {});
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const about = wb.getWorksheet("About")!;
  const cells: string[] = [];
  about.eachRow((r) => cells.push(String(r.getCell(2).value ?? "")));
  assert.ok(cells.some((c) => c.includes(`definition #${definitionHash(d)}`)), cells.join(" | "));
});
