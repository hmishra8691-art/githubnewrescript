import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImport, buildImportGraph, dependenciesOf, dependentsOf, type CanonicalSurvey, type CanonicalQuestion, type CExpr } from "./index.js";

/**
 * I2 — the dependency graph over the canonical source: edges by kind, the
 * execution order, the embedded-data map, and every integrity finding the
 * brief names (missing references, cycles, unreachable questions, undefined
 * embedded data, broken branches, invalid redirects).
 */
const Q = (id: string, over: Partial<CanonicalQuestion> = {}): CanonicalQuestion => ({ sourceId: id, variable: id.replace("QID", "Q"), text: `Question ${id}`, kind: "single", sourceType: "MC/SAVR", options: [{ sourceId: "1", code: 1, label: "Yes" }, { sourceId: "2", code: 2, label: "No" }], rows: [], required: false, validation: [], skips: [], custom: [], confidence: "confirmed", notes: [], ...over });
const sel = (id: string, choice = "1"): CExpr => ({ t: "cmp", ref: { kind: "question", id, choice }, op: "selected" });
const survey = (questions: CanonicalQuestion[], flow: CanonicalSurvey["flow"], more: Partial<CanonicalSurvey> = {}): CanonicalSurvey => ({ source: { platform: "qualtrics", format: "qsf", fileName: "t.qsf", fingerprint: "x" }, questions, flow, embedded: [], quotas: [], custom: [], issues: [], ...more } as CanonicalSurvey);
const block = (id: string, qids: string[][]): CanonicalSurvey["flow"][number] => ({ t: "block", sourceId: id, pages: qids });
const kinds = (g: ReturnType<typeof buildImportGraph>) => g.findings.map((f) => f.kind);

test("edges by kind and the execution order: display, skip, piping, carry-forward, loop, branch, quota, redirect", () => {
  const g = buildImportGraph(survey([
    Q("QID1"),
    Q("QID2", { displayLogic: sel("QID1"), text: "You said {{@QID1}} — and {{ed.Region}}" }),
    Q("QID3", { carryForward: { questionId: "QID2", filter: "selected", into: "options" }, skips: [{ when: sel("QID3", "2"), to: { kind: "question", id: "QID5" } }] }),
    Q("QID4"), Q("QID5"),
  ], [
    { t: "embedded", sourceId: "FL_e", fields: [{ name: "Region", source: "url" }] },
    block("BL_a", [["QID1", "QID2"], ["QID3"]]),
    { t: "branch", sourceId: "FL_b", when: sel("QID1", "2"), children: [block("BL_b", [["QID4"]]), { t: "end", sourceId: "FL_x", status: "screened", redirectUrl: "https://p.example.com/x?pid=${e://Field/Region}" }] },
    { ...block("BL_c", [["QID5"]]), loop: { kind: "question", questionId: "QID1", loopVar: "lv" } } as never,
  ], { quotas: [{ sourceId: "QO_1", name: "Yes", limit: 10, when: sel("QID1"), onFull: "terminate" }] }));
  assert.deepEqual(g.order, ["QID1", "QID2", "QID3", "QID4", "QID5"]);
  for (const k of ["display", "piping", "carry_forward", "skip", "skip_target", "branch", "loop", "quota", "redirect"] as const) assert.ok((g.stats.byKind[k] ?? 0) > 0, `has ${k} edges`);
  assert.deepEqual(dependenciesOf(g, "QID2").map((d) => `${d.kind}:${d.to}`).sort(), ["display:q:QID1", "piping:ed:REGION", "piping:q:QID1"]);
  assert.ok(dependentsOf(g, "QID1").some((d) => d.from === "quota:QO_1"));
  const region = g.embedded.find((v) => v.name === "Region")!;
  assert.equal(region.defined, true);
  assert.deepEqual(region.assigned.map((a) => `${a.by}/${a.stage}`), ["url/before_questions"]);
  assert.deepEqual(region.readBy.map((r) => r.how).sort(), ["piping", "redirect"]);
  assert.equal(g.findings.filter((f) => f.severity !== "info").length, 0, `a clean survey has no findings: ${JSON.stringify(g.findings)}`);
});

test("missing references: a question, a choice, a skip target block, a carry-forward source, a loop source", () => {
  const g = buildImportGraph(survey([
    Q("QID1", { displayLogic: sel("QID99") }),
    Q("QID2", { displayLogic: sel("QID1", "7"), skips: [{ when: sel("QID2"), to: { kind: "block", id: "BL_gone" } }] }),
    Q("QID3", { carryForward: { questionId: "QID77", filter: "selected", into: "options" }, text: "Hello {{@QID88}}" }),
  ], [block("BL_a", [["QID1", "QID2", "QID3"]]), { ...block("BL_l", []), loop: { kind: "question", questionId: "QID66", loopVar: "x" } } as never]));
  const msgs = g.findings.filter((f) => f.kind === "missing_reference").map((f) => f.refs[0]);
  for (const r of ["QID99", "QID1", "BL_gone", "QID77", "QID88", "QID66"]) assert.ok(msgs.includes(r), `${r} is named: ${msgs}`);
});

test("cycles and order: mutual display logic, a backward skip, a forward reference", () => {
  const g = buildImportGraph(survey([
    Q("QID1", { displayLogic: sel("QID2") }),
    Q("QID2", { displayLogic: sel("QID1") }),
    Q("QID3", { skips: [{ when: sel("QID3"), to: { kind: "question", id: "QID1" } }] }),
  ], [block("BL_a", [["QID1"], ["QID2"], ["QID3"]])]));
  const cyc = g.findings.filter((f) => f.kind === "circular_dependency");
  assert.equal(cyc.length, 2, JSON.stringify(cyc));
  assert.ok(cyc.some((f) => /Q1 → Q2|Q2 → Q1/.test(f.message)), "the mutual display logic is one cycle");
  assert.ok(cyc.some((f) => /jumps BACK/.test(f.message)));
  assert.ok(g.findings.some((f) => f.kind === "forward_reference" && f.refs[0] === "QID2"), "Q1 reads Q2, which is asked later");
});

test("unreachable questions, broken branches, embedded data used undefined / before assignment / never, invalid redirects", () => {
  const g = buildImportGraph(survey([
    Q("QID1", { text: "Hi {{ed.panel}} from {{ed.city}}" }),
    Q("QID2"), Q("QID3"), Q("QID4"),
  ], [
    block("BL_a", [["QID1"]]),
    { t: "embedded", sourceId: "FL_e2", fields: [{ name: "city", source: "static", value: "Pune" }, { name: "unused", source: "static", value: "1" }] },
    { t: "branch", sourceId: "FL_never", when: { t: "const", value: false }, children: [block("BL_b", [["QID2"]])] },
    { t: "branch", sourceId: "FL_raw", when: { t: "raw", text: "GeoIP", language: "qualtrics", refs: [], reason: "GeoIP is not supported" }, children: [block("BL_c", [["QID3"]])] },
    { t: "end", sourceId: "FL_end", status: "complete", redirectUrl: "javascript:alert(1)" },
  ]));
  const k = kinds(g);
  assert.ok(k.includes("unreachable") && g.findings.some((f) => f.kind === "unreachable" && f.refs[0] === "QID2"), "inside a never-true branch");
  assert.ok(g.findings.some((f) => f.kind === "unreachable" && f.refs[0] === "QID4" && /not placed/.test(f.message)), "not in the flow at all");
  assert.equal(g.findings.filter((f) => f.kind === "broken_branch").length, 2);
  assert.ok(g.findings.some((f) => f.kind === "undefined_embedded" && f.refs[0] === "panel"));
  assert.ok(g.findings.some((f) => f.kind === "embedded_used_before_assignment" && f.refs[0] === "city"), "city is piped on Q1 but set after it");
  assert.ok(g.findings.some((f) => f.kind === "unused_embedded" && f.refs[0] === "unused" && f.severity === "info"));
  assert.ok(g.findings.some((f) => f.kind === "invalid_redirect"));
  assert.equal(g.embedded.find((v) => v.name === "city")!.assigned[0].stage, "during");
});

test("custom JavaScript: setEmbeddedData defines a field, getEmbeddedData and ${e://} read it", () => {
  const g = buildImportGraph(survey([
    Q("QID1", { custom: [{ language: "javascript", code: "Qualtrics.SurveyEngine.setEmbeddedData('score', 3);", location: "QID1", role: "question JavaScript", refs: [] }] }),
    Q("QID2", { custom: [{ language: "javascript", code: "var s = Qualtrics.SurveyEngine.getEmbeddedData('score'); var t = '${e://Field/tier}';", location: "QID2", role: "question JavaScript", refs: [] }] }),
  ], [block("BL_a", [["QID1"], ["QID2"]])]));
  const score = g.embedded.find((v) => v.name === "score")!;
  assert.equal(score.defined, true); assert.equal(score.assigned[0].by, "script");
  assert.equal(score.readBy[0].how, "script");
  assert.ok(g.findings.some((f) => f.kind === "undefined_embedded" && f.refs[0] === "tier"));
  assert.ok((g.stats.byKind.script_write ?? 0) === 1 && (g.stats.byKind.script_read ?? 0) >= 2);
});

test("the corpus: report.graph is present for every file; known source problems are found and nothing else is invented", async () => {
  const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "qsf");
  let n = 0;
  const run = async (f: string) => (await analyzeImport(new Uint8Array(readFileSync(join(DIR, f))), f, { surveyId: "s1", uid: (p) => `${p}_${++n}` })).report!.graph;
  const g2 = await run("02-screener-logic-quotas.qsf");
  assert.deepEqual(g2.findings.filter((f) => f.severity !== "info").map((f) => `${f.kind}:${f.refs[0]}`).sort(), ["missing_reference:QID42", "missing_reference:QID99"], "the two deliberately broken references");
  const g3 = await run("03-brand-tracker-complex.qsf");
  assert.ok(g3.findings.some((f) => f.kind === "unreachable" && /not in the source's survey flow/.test(f.message)), "the orphan block is named as such, not as a broken branch");
  assert.equal(g3.findings.filter((f) => f.kind === "broken_branch").length, 1, "only the unreadable IsMobile branch");
  const g4 = await run("04-large-121-questions.qsf");
  assert.equal(g4.order.length, 121);
  assert.equal(g4.findings.filter((f) => f.severity !== "info").length, 0);
  assert.equal(g4.embedded.find((v) => v.name === "PID")!.readBy.filter((r) => r.how === "redirect").length, 2, "both panel redirects carry PID");
});
