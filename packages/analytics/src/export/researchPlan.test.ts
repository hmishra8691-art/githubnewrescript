import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { SurveyDefinition } from "@rescript/schema";
import { buildProposalDocx, buildResearchPlanDocx } from "./docx.js";
import { buildSapDocx } from "./sap.js";
import { checkDocx, unzipEntries, xmlProblem } from "./docxCheck.js";

/*
 * THE WORD RESEARCH PLAN (2026-10-17): one exporter (the proposal's research-plan edition), checked as a
 * package before a link is offered, carrying the actual survey's hypotheses, questions and traceability —
 * and no number the design does not contain.
 */
const scale = () => ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"].map((l, i) => ({ code: i + 1, label: l }));
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
export const RP_FIXTURE = {
  meta: { id: "s1", code: "BRAND26", title: "Brand choice & trust — “Café” study", version: "1.2" },
  research: {
    objective: "Why consumers choose Brand A over Brand B",
    hypotheses: ["Brand trust increases purchase intention", "Advertising exposure raises awareness"],
    hypothesisDetails: [{ note: "Trust lowers perceived risk, so trusting buyers commit sooner (prior wave)." }],
    researchQuestions: ["What drives purchase intention for Brand A?"],
    population: "US and UK adults 18–45 <who buy coffee>",
    methodology: "Online quantitative survey, 12 minutes",
    sampleSize: 400,
    brief: { background: "Brand A lost share in 2025 & the board wants to know why.", businessQuestion: "Should we invest in trust or in reach?", stakeholders: ["CMO"], deliverables: [] },
    constructs: [
      { name: "Brand trust", role: "independent", questionIds: ["t1", "t2"] },
      { name: "Purchase intention", role: "dependent", questionIds: ["pi"] },
      { name: "Advertising exposure", role: "independent", questionIds: ["ad"] },
      { name: "Awareness", role: "dependent", questionIds: ["aware"] },
    ],
    analysis: [], assumptions: ["Panel respondents resemble the buying population"], sources: [],
  },
  questions: [
    { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other") },
    { id: "aware", code: "Q1", variableName: "AWARE", type: "multi_select", text: "Which brands have you heard of?", options: opts("Brand A", "Brand B", "Brand C") },
    { id: "ad", code: "Q2", variableName: "AD_EXPOSE", type: "single_select", text: "Seen advertising for Brand A recently?", options: opts("Yes", "No") },
    { id: "t1", code: "Q3", variableName: "TRUST_1", type: "single_select", text: "Brand A keeps its promises", options: scale() },
    { id: "t2", code: "Q4", variableName: "TRUST_2", type: "single_select", text: "Brand A is honest", options: scale() },
    { id: "pi", code: "Q5", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy Brand A?", options: scale() },
  ],
  flow: [{ type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["gender", "aware", "ad", "t1", "t2", "pi"] }] }, { type: "end", id: "e", status: "complete" }],
};
const def = SurveyDefinition.parse(RP_FIXTURE);

test("the research plan is a valid Word package: required parts, well-formed XML, header and footer, headings, repeating table headers, unsplittable rows", async () => {
  const buf = await buildResearchPlanDocx(def, { date: "2026-10-17", client: "Acme & Co" });
  const c = checkDocx(buf);
  assert.deepEqual(c.problems, []);
  assert.equal(c.ok, true);
  assert.ok(c.headers >= 1 && c.footers >= 1, `header ${c.headers}, footer ${c.footers}`);
  assert.ok(c.headings >= 12, `${c.headings} headings`);
  assert.ok(c.tables >= 8, `${c.tables} tables`);
  const doc = unzipEntries(buf).get("word/document.xml")!.toString("utf8");
  assert.match(doc, /<w:tblHeader\/>/, "header rows repeat on each page");
  assert.match(doc, /<w:cantSplit\/>/, "rows are kept on one page");
  assert.match(doc, /<w:keepNext\/>/, "headings stay with what follows");
  const footer = unzipEntries(buf).get("word/footer1.xml")!.toString("utf8");
  assert.match(footer, /PAGE/); assert.match(footer, /NUMPAGES/);
});

test("the research plan carries the brief's sections, in order, numbered", async () => {
  const t = checkDocx(await buildResearchPlanDocx(def, { date: "2026-10-17" })).text;
  const sections = ["Executive summary", "Business context, problem and objectives", "Research questions and KPIs", "Hypotheses and rationale", "Methodology", "Questionnaire and interview guide", "How each question serves the objectives and hypotheses", "Variables and scales", "Population, sampling and fieldwork", "Analysis plan", "Hypothesis tests", "Proposed tables and charts", "Expected outputs and interpretation framework", "Quality control requirements", "Deliverables", "Limitations, assumptions and recommendations", "Ethics, consent and data protection"];
  let at = 0;
  sections.forEach((s, i) => { const k = t.indexOf(`${i + 1}. ${s}`, at); assert.ok(k >= 0, `section ${i + 1}. ${s} (after ${at})`); at = k; });
  assert.match(t, /RESEARCH PLAN/);
});

test("its content is the actual survey: hypotheses with rationale, every question, the variables and their coding, the tests that serve each hypothesis", async () => {
  const t = checkDocx(await buildResearchPlanDocx(def, { date: "2026-10-17" })).text;
  assert.match(t, /H1 Brand trust increases purchase intention/);
  assert.match(t, /Trust lowers perceived risk, so trusting buyers commit sooner \(prior wave\)\./, "the recorded rationale");
  assert.match(t, /No rationale is recorded — add a note to the hypothesis/, "H2 has none, and says so");
  for (const q of def.questions) { assert.ok(t.includes(q.variableName), q.variableName); }
  assert.match(t, /PURCHASE_INT Q5 — How likely are you to buy Brand A\? single select ordinal 1 = Strongly disagree; 2 = Disagree/);
  assert.match(t, /Q5 How likely are you to buy Brand A\? PURCHASE_INT H1/, "the traceability row of Q5 serves H1");
  assert.match(t, /H1: Brand trust → purchase intention/i);
  assert.match(t, /H1 Correlation; Linear regression PURCHASE_INT/, "the tests that serve H1, once each");
  assert.match(t, /H1: Brand trust increases purchase intention Brand trust, Purchase intention Q3, Q4, Q5 .*Planned — not yet tested/, "the matrix reads the plan this document prints");
  assert.doesNotMatch(t, /add_analysis_test|"hypotheses":/, "no copilot action names in a client document");
  assert.match(t, /at α = 0\.05 \(two-sided\)/);
  assert.match(t, /Untested — no executed analysis serves it/);
  assert.match(t, /Causal — not claimed/);
});

test("special characters survive: ampersands, angle brackets, curly quotes and accents", async () => {
  const t = checkDocx(await buildResearchPlanDocx(def, { date: "2026-10-17", client: "Acme & Co" })).text;
  assert.match(t, /Brand choice & trust — “Café” study/);
  assert.match(t, /US and UK adults 18–45 <who buy coffee>/);
  assert.match(t, /lost share in 2025 & the board/);
});

test("no number is invented: no p-value, no percentage of respondents, no verdict reached — the plan is a design", async () => {
  const t = checkDocx(await buildResearchPlanDocx(def, { date: "2026-10-17" })).text;
  assert.doesNotMatch(t, /p = \.\d|p < \.001/);
  assert.doesNotMatch(t, /\d+(\.\d+)?% of (respondents|the sample)/);
  assert.doesNotMatch(t, /Tested — (supported|not supported|mixed)/);
  assert.match(t, /every hypothesis is untested until the analysis plan runs/);
});

test("the proposal edition is unchanged in its numbering, and every research document passes the same package check", async () => {
  const proposal = checkDocx(await buildProposalDocx(def, { date: "2026-10-17" }));
  assert.equal(proposal.ok, true, proposal.problems.join("; "));
  assert.match(proposal.text, /RESEARCH PROPOSAL/);
  assert.match(proposal.text, /1\. Background and objective .* 2\. Research questions and KPIs .* 3\. Hypotheses .* 4\. Questionnaire .* 5\. Sample and fieldwork/);
  assert.doesNotMatch(proposal.text, /Hypothesis tests|Quality control requirements/);
  const sap = checkDocx(await buildSapDocx(def, { date: "2026-10-17" }));
  assert.equal(sap.ok, true, sap.problems.join("; "));
});

test("an empty design still makes a valid plan that says what is missing", async () => {
  const bare = SurveyDefinition.parse({ meta: { id: "b", code: "B", title: "Bare" }, questions: [{ id: "q", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick", options: opts("A", "B") }], flow: [{ type: "page", id: "p", questionIds: ["q"] }] });
  const c = checkDocx(await buildResearchPlanDocx(bare, { date: "2026-10-17" }));
  assert.equal(c.ok, true, c.problems.join("; "));
  assert.match(c.text, /No hypotheses are recorded/);
  assert.match(c.text, /No methodology is recorded/);
});

test("the package check refuses what Word cannot open, naming why", () => {
  assert.match(checkDocx(Buffer.alloc(0)).problems[0], /too small/);
  assert.match(checkDocx(Buffer.from("<html>not a document</html>".repeat(10))).problems[0], /does not start as a ZIP/);
  assert.equal(xmlProblem("<a><b></a>"), "</a> closes <b>");
  assert.equal(xmlProblem('<a x="1"><b/></a>'), null);
  assert.match(xmlProblem("<a x=1></a>") ?? "", /malformed attribute/);
  // a ZIP holding only a broken document.xml
  const name = Buffer.from("word/document.xml"), data = deflateRawSync(Buffer.from("<w:document><w:body></w:document>"));
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdStart = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdStart, 16);
  const c = checkDocx(Buffer.concat([local, name, data, central, name, eocd, Buffer.alloc(40)]));
  assert.equal(c.ok, false);
  assert.ok(c.problems.some((p) => /\[Content_Types\]\.xml is missing/.test(p)), c.problems.join("; "));
  assert.ok(c.problems.some((p) => /document\.xml is not well-formed XML/.test(p)), c.problems.join("; "));
});
