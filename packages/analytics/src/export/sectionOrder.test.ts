import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { def as baseDef, synthRows, spec } from "../analyses/fixture.js";
import { buildDataset } from "../dataset.js";
import { runPlan } from "../findings.js";
import { deckFromRun } from "../deck.js";
import { buildResearchPlanDocx, buildFindingsDocx, buildProposalDocx } from "./docx.js";
import { buildSapDocx } from "./sap.js";
import { buildDeckPptx, orderDeckSlides } from "./deck.js";
import { buildQualReportDocx } from "./qualDocx.js";
import { buildQualDeckPptx } from "./qualSlides.js";
import { unzipEntries, checkDocx } from "./docxCheck.js";
import { checkPptx } from "./officeCheck.js";
import { sectionId, sectionOrderFor, orderSections, readSectionOrders, DOCUMENT_SECTIONS, type StructureRequest } from "../reportThemes.js";

/*
 * SECTION ORDER IN EVERY EXPORT (2026-10-22, engine item #18): the order is stored per document family and
 * applied identically in the Word file and the PowerPoint of that family — checked by reading the order of
 * the headings in word/document.xml and of the slide titles in the deck's presentation order.
 */

const def = (() => {
  const d = structuredClone(baseDef) as Record<string, unknown>;
  d.research = {
    objective: "Understand what drives satisfaction", population: "Adults", methodology: "Online panel", hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 2, hypotheses: ["H2"] }], derived: [], segments: [] },
  };
  return SurveyDefinition.parse(d);
})();
const run = runPlan(def, buildDataset(def, synthRows(300), { spec }), { trigger: "manual", now: "2026-10-01T10:00:00Z" });
const xml = (buf: Buffer, name: string) => unzipEntries(buf).get(name)?.toString("utf8") ?? "";
/** the Heading 1 texts of a Word file, in document order */
const headings = (buf: Buffer) => [...xml(buf, "word/document.xml").matchAll(/<w:p>(?:(?!<\/w:p>).)*?<w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(""));
/** the deck's slide texts, in PRESENTATION order (ppt/presentation.xml's sldIdLst → rels → slide files) */
const slideTexts = (buf: Buffer) => {
  const parts = unzipEntries(buf);
  const pres = parts.get("ppt/presentation.xml")!.toString("utf8");
  const rels = parts.get("ppt/_rels/presentation.xml.rels")!.toString("utf8");
  const target = (rid: string) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
  return [...pres.matchAll(/<p:sldId [^>]*r:id="(rId\d+)"/g)].map((m) => [...(parts.get(`ppt/${target(m[1])}`)?.toString("utf8") ?? "").matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join(" "));
};
const S = (sections: StructureRequest["sections"]): StructureRequest => ({ order: [], understood: "test", sections });

test("ids, the generic order and the stored-map reader", () => {
  assert.equal(sectionId("9. Analysis plan (derived from the design — not yet saved)"), "analysis-plan");
  assert.equal(sectionId("Business context, problem and objectives"), "business-context-problem-and-objectives");
  assert.deepEqual(orderSections([{ id: "a", items: [1] }, { id: "b", items: [2] }, { id: "c", items: [3] }], ["c", "x", "a"]).map((s) => s.id), ["c", "a", "b"]);
  assert.deepEqual(readSectionOrders({ findings: ["method", "method", "Bad Id!"], nope: ["x"] }), { findings: ["method"] });
  assert.deepEqual(sectionOrderFor({ order: ["recommendations", "hypotheses"], understood: "" }, "findings"), ["what-to-do-next", "the-hypotheses"], "the words-only order (2026-10-18) still works");
  assert.equal(sectionOrderFor(null, "qual"), null);
});

test("research plan Word: sections move whole, the cover stays first, the numbers follow the new order, nothing is lost", async () => {
  const plain = await buildResearchPlanDocx(def, { date: "2026-10-22" });
  const order = ["ethics-consent-and-data-protection", "hypotheses-and-rationale", "executive-summary"];
  const moved = await buildResearchPlanDocx(def, { date: "2026-10-22", structure: S({ research_plan: order }) });
  assert.ok(checkDocx(moved).ok);
  const a = headings(plain), b = headings(moved);
  assert.equal(b.length, a.length);
  assert.deepEqual(b.slice(0, 3), ["1. Ethics, consent and data protection", "2. Hypotheses and rationale", "3. Executive summary"]);
  assert.deepEqual(b.map((h) => h.replace(/^\d+\.\s/, "")).sort(), a.map((h) => h.replace(/^\d+\.\s/, "")).sort(), "the same sections");
  b.forEach((h, i) => assert.ok(h.startsWith(`${i + 1}. `), `renumbered: ${h}`));
  const text = (buf: Buffer) => [...xml(buf, "word/document.xml").matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1].replace(/^\d+\.\s/, "")).sort();
  assert.deepEqual(text(moved), text(plain), "no word added or dropped");
  // the cover is still the first thing in the body
  assert.ok(xml(moved, "word/document.xml").indexOf("Research plan") < xml(moved, "word/document.xml").indexOf("Ethics, consent"));
  // every id the plan has is in the catalog the Studio shows
  for (const h of a) assert.ok(DOCUMENT_SECTIONS.research_plan.some((s) => s.id === sectionId(h)), `catalog lacks ${h}`);
});

test("proposal and SAP follow their own families", async () => {
  const p = headings(await buildProposalDocx(def, { structure: S({ proposal: ["deliverables"] }) }));
  assert.equal(p[0], "1. Deliverables");
  const s = headings(await buildSapDocx(def, { structure: S({ sap: ["sample-size", "planned-analyses"] }) }));
  assert.deepEqual(s.slice(0, 2), ["1. Sample size", "2. Planned analyses"]);
  for (const h of headings(await buildProposalDocx(def, {}))) assert.ok(DOCUMENT_SECTIONS.proposal.some((x) => x.id === sectionId(h)), h);
  for (const h of headings(await buildSapDocx(def, {}))) assert.ok(DOCUMENT_SECTIONS.sap.some((x) => x.id === sectionId(h)), h);
});

test("findings: the Word report and the deck apply the SAME order (headings vs slides in presentation order)", async () => {
  const order = ["what-to-do-next", "method", "executive-summary"];
  const structure = S({ findings: order });
  const docx = await buildFindingsDocx(def, run, { date: "2026-10-22", structure });
  const h = headings(docx);
  assert.deepEqual(h.slice(0, 3), ["What to do next", "Method", "Executive summary"].filter((t) => h.includes(t)));
  const deck = deckFromRun(def, run, { audience: "executive", date: "2026-10-22" } as never);
  const pptx = await buildDeckPptx({ deck, results: {}, sectionOrder: sectionOrderFor(structure, "findings") });
  assert.ok(checkPptx(pptx).ok);
  const slides = slideTexts(pptx);
  const firstOf = (re: RegExp) => slides.findIndex((t) => re.test(t));
  const rec = firstOf(/RECOMMENDATIONS/), method = firstOf(/METHOD\b/), summary = firstOf(/SUMMARY/);
  assert.ok(rec > 0 && method > 0 && summary > 0, slides.map((s) => s.slice(0, 30)).join(" | "));
  assert.ok(rec < method && method < summary, `deck order: recommendations ${rec}, method ${method}, summary ${summary}`);
  assert.match(slides[0], new RegExp(deck.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the title slide stays first");
  // the deck without an order is exactly the old deck
  const same = orderDeckSlides(deck.slides, null);
  assert.deepEqual(same.map((s) => s.type), deck.slides.map((s) => s.type));
});

test("qualitative: the Word report and the deck follow the same `qual` order", async () => {
  const state = { codebook: { version: 1, method: "inductive" as const, codes: [{ id: "c1", name: "Price", definition: "", status: "human_reviewed" as const, origin: "manual" as const }], themes: [{ id: "th1", name: "Value", status: "human_reviewed" as const }], relationships: [] }, excerpts: [] };
  const structure = S({ qual: ["limitations", "themes", "objectives"] });
  const docx = await buildQualReportDocx(def, { state, segments: [], sources: [], date: "2026-10-22", structure });
  const h = headings(docx);
  assert.deepEqual(h.slice(0, 3), ["1. Limitations", "2. Themes", "3. Objectives"]);
  for (const x of headings(await buildQualReportDocx(def, { state, segments: [], sources: [] }))) assert.ok(DOCUMENT_SECTIONS.qual.some((s) => s.id === sectionId(x)), x);
  const comparison = { a: "Mumbai", b: "Delhi", rows: [{ theme: "Value", a: { segments: 2, share: 50 }, b: { segments: 1, share: 25 }, difference: 25 }] };
  const plain = slideTexts(await buildQualDeckPptx(def, { state, segments: [], sources: {}, comparison: comparison as never }));
  const moved = slideTexts(await buildQualDeckPptx(def, { state, segments: [], sources: {}, comparison: comparison as never, sectionOrder: ["method-and-coding", "group-differences"] }));
  const at = (sl: string[], re: RegExp) => sl.findIndex((t) => re.test(t));
  assert.ok(at(plain, /Mumbai vs Delhi/) < at(plain, /Method and limitations/), "as built: groups before method");
  assert.ok(at(moved, /Method and limitations/) < at(moved, /Mumbai vs Delhi/), "reordered: method first, like the report");
  assert.equal(at(moved, /Qualitative findings/), 0, "the title slide stays first");
});
