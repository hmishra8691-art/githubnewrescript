import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "./index.js";
import { detectFormat } from "./detect.js";

/* synthetic fixtures written to each format's published structure — no real client export was available */
const enc = (s: string) => new TextEncoder().encode(s);

const TRIPLES = `<?xml version="1.0"?>
<sss version="2.0"><survey><title>Brand health</title><record ident="A">
<variable ident="1" type="single"><name>Q1</name><label>Which brand do you use most?</label><position start="1" finish="1"/><values><value code="1">Alpha</value><value code="2">Beta</value><value code="3">Gamma</value></values></variable>
<variable ident="2" type="multiple"><name>Q2</name><label>Which have you heard of?</label><position start="2" finish="4"/><spread subfields="3"/><values><value code="1">Alpha</value><value code="2">Beta</value><value code="3">Gamma</value></values></variable>
<variable ident="3" type="quantity"><name>AGE</name><label>Age</label><position start="5" finish="6"/><values><range from="18" to="99"/></values></variable>
<variable ident="4" type="character"><name>WHY</name><label>Why?</label><position start="7" finish="106"/></variable>
<variable ident="5" type="logical"><name>OPTIN</name><label>Opt in</label><position start="107" finish="107"/></variable>
</record></survey></sss>`;

const SPS = `* codebook.
VARIABLE LABELS Q1 'Overall satisfaction' /Q2 'Recommend?' /Q3_1 'Price' /Q3_2 'Quality' /NOTE 'Comment'.
VALUE LABELS Q1 1 'Very dissatisfied' 2 'Dissatisfied' 3 'Neutral' 4 'Satisfied' 5 'Very satisfied' 9 'Don''t know'
 /Q2 1 'Yes' 2 'No'.
MISSING VALUES Q1 (9).
MRSETS /MDGROUP NAME=$Q3 LABEL='What matters?' CATEGORYLABELS=VARLABELS VARIABLES=Q3_1 Q3_2 VALUE=1.
FREQUENCIES VARIABLES=Q1.
`;

const MONKEY = JSON.stringify({ title: "Café feedback", pages: [{ id: "p1", questions: [
  { id: "101", family: "single_choice", subtype: "vertical", headings: [{ heading: "<p>How often do you visit?</p>" }], answers: { choices: [{ id: "1a", text: "Weekly" }, { id: "1b", text: "Monthly" }], other: { id: "1o", text: "Other (please specify)", is_answer_choice: true } }, required: { text: "This question requires an answer.", type: "all" } },
  { id: "102", family: "multiple_choice", subtype: "vertical", headings: [{ heading: "What do you order?" }], answers: { choices: [{ id: "2a", text: "Coffee" }, { id: "2b", text: "Tea" }, { id: "2c", text: "Cake" }] } },
]}, { id: "p2", questions: [
  { id: "103", family: "matrix", subtype: "rating", headings: [{ heading: "Rate us" }], answers: { rows: [{ id: "r1", text: "Taste" }, { id: "r2", text: "Price" }], choices: [{ id: "c1", text: "Poor" }, { id: "c2", text: "Good" }] } },
  { id: "104", family: "open_ended", subtype: "essay", headings: [{ heading: "Anything else?" }] },
  { id: "105", family: "mystery_widget", headings: [{ heading: "?" }] },
]}] });

const ALCHEMER = JSON.stringify({ result_ok: true, data: { id: 9, _type: "Survey", title: { English: "Gym survey" }, pages: [{ id: 1, _type: "SurveyPage", questions: [
  { id: 11, _type: "SurveyQuestion", _subtype: "radio", type: "RADIO", shortname: "GYM_FREQ", title: { English: "How often do you train?" }, properties: { required: true }, options: [{ id: 101, _type: "SurveyOption", value: "1", title: { English: "Daily" } }, { id: 102, _type: "SurveyOption", value: "2", title: { English: "Weekly" } }] },
  { id: 12, _type: "SurveyQuestion", type: "TABLE", title: { English: "Rate the facilities" }, options: [{ id: 1, value: "1", title: { English: "Bad" } }, { id: 2, value: "2", title: { English: "Good" } }], sub_questions: [{ id: 121, title: { English: "Showers" } }, { id: 122, title: { English: "Machines" } }] },
  { id: 13, _type: "SurveyQuestion", type: "ESSAY", title: { English: "Why?" }, properties: { logic: { operator: "and", terms: [{ question: 11, option: 101 }] } } },
]}] } });

const FORSTA = `<?xml version="1.0" encoding="utf-8"?>
<Project Name="p1234567"><ProjectInfo><Name>Telecom tracker</Name></ProjectInfo><Routing><Nodes>
<Single Name="q1" Required="true"><Title><Text>Which network do you use?</Text></Title><Answers><Answer Precode="1"><Texts><Text>Airtel</Text></Texts></Answer><Answer Precode="2"><Texts><Text>Jio</Text></Texts></Answer><Answer Precode="98" Other="true"><Texts><Text>Other</Text></Texts></Answer></Answers></Single>
<Multi Name="q2"><Title><Text>Which services do you use?</Text></Title><Answers><Answer Precode="1"><Texts><Text>Calls</Text></Texts></Answer><Answer Precode="2"><Texts><Text>Data</Text></Texts></Answer><Answer Precode="99" Exclusive="true"><Texts><Text>None</Text></Texts></Answer></Answers><Condition Expression="q1.toBoolean()"/></Multi>
<Grid Name="q3"><Title><Text>Rate your network</Text></Title><Answers><Answer Precode="1"><Texts><Text>Coverage</Text></Texts></Answer><Answer Precode="2"><Texts><Text>Speed</Text></Texts></Answer></Answers><Scale><ScaleItem Precode="1">Poor</ScaleItem><ScaleItem Precode="2">Good</ScaleItem></Scale></Grid>
<Open Name="q4"><Title><Text>Why?</Text></Title></Open>
<Script Name="s1">f('q5').set(1)</Script>
</Nodes></Routing></Project>`;

test("each format is recognised from its content", () => {
  assert.equal(detectFormat(enc(TRIPLES), "x.xml").format, "triples");
  assert.equal(detectFormat(enc(SPS), "x.sps").format, "sps");
  assert.equal(detectFormat(enc(MONKEY), "x.json").format, "surveymonkey");
  assert.equal(detectFormat(enc(ALCHEMER), "x.json").format, "alchemer");
  assert.equal(detectFormat(enc(FORSTA), "x.xml").format, "forsta");
});

test("Triple-S: single, multiple, quantity with its range, character and logical become questions; no logic invented", async () => {
  const r = await analyzeImport(enc(TRIPLES), "brand.sss", { surveyId: "t" });
  const qs = r.canonical!.questions;
  assert.deepEqual(qs.map((q) => [q.variable, q.kind]), [["Q1", "single"], ["Q2", "multi"], ["AGE", "numeric"], ["WHY", "text"], ["OPTIN", "single"]]);
  assert.deepEqual(qs[0]!.options.map((o) => [o.code, o.label]), [[1, "Alpha"], [2, "Beta"], [3, "Gamma"]]);
  assert.deepEqual(qs[2]!.validation, [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }]);
  assert.ok(r.canonical!.issues.some((i) => /no routing.*none was invented/.test(i.message)));
  assert.ok(r.result && r.result.def?.questions.length === 5, "the mapper builds a survey from it");
});

test("SPSS syntax: labels, value labels (missing codes left out), and a multiple-response set; analysis commands ignored", async () => {
  const r = await analyzeImport(enc(SPS), "codebook.sps", { surveyId: "s" });
  const qs = r.canonical!.questions;
  const by = Object.fromEntries(qs.map((q) => [q.variable, q]));
  assert.equal(by.Q3!.kind, "multi");
  assert.deepEqual(by.Q3!.options.map((o) => o.label), ["Price", "Quality"]);
  assert.deepEqual(by.Q1!.options.map((o) => o.code), [1, 2, 3, 4, 5], "9 is declared missing");
  assert.equal(by.Q1!.text, "Overall satisfaction");
  assert.equal(by.NOTE!.kind, "text");
  assert.ok(!qs.some((q) => q.variable === "Q3_1"), "the set's variables are its choices, not questions");
  assert.ok(r.canonical!.issues.some((i) => /FREQUENCIES/.test(i.message)));
});

test("SurveyMonkey: families and subtypes, the 'other' choice, required, pages; skip logic said not to be carried; unknown family kept as a placeholder", async () => {
  const r = await analyzeImport(enc(MONKEY), "survey.json", { surveyId: "m" });
  const c = r.canonical!;
  assert.deepEqual(c.questions.map((q) => q.kind), ["single", "multi", "matrix_single", "textarea", "unknown"]);
  assert.equal(c.questions[0]!.text, "How often do you visit?");
  assert.equal(c.questions[0]!.required, true);
  assert.ok(c.questions[0]!.options.at(-1)!.otherSpecify);
  assert.equal(c.questions[2]!.rows.length, 2);
  assert.deepEqual((c.flow[0] as { pages: string[][] }).pages.map((p) => p.length), [2, 3]);
  assert.ok(c.issues.some((i) => /do not include skip logic/.test(i.message)));
  assert.ok(c.issues.some((i) => /mystery_widget/.test(i.message)));
  assert.ok(c.questions.every((q) => q.confidence === "review"), "not yet validated on a real export");
});

test("Alchemer: types, shortnames as variables, reporting values as codes, a table's sub-questions as rows, logic kept as raw text", async () => {
  const r = await analyzeImport(enc(ALCHEMER), "gym.json", { surveyId: "a" });
  const c = r.canonical!;
  assert.equal(c.source.title, "Gym survey");
  assert.deepEqual(c.questions.map((q) => [q.variable, q.kind]), [["GYM_FREQ", "single"], ["Q2", "matrix_single"], ["Q3", "textarea"]]);
  assert.equal(c.questions[0]!.required, true);
  assert.deepEqual(c.questions[1]!.rows.map((x) => x.label), ["Showers", "Machines"]);
  assert.equal(c.questions[2]!.displayLogic?.t, "raw");
});

test("Forsta Plus: question elements, precodes, exclusive and other answers, grid scale, conditions kept for review, scripts listed", async () => {
  const r = await analyzeImport(enc(FORSTA), "project.xml", { surveyId: "f" });
  const c = r.canonical!;
  assert.equal(c.source.title, "Telecom tracker");
  assert.deepEqual(c.questions.map((q) => [q.variable, q.kind]), [["q1", "single"], ["q2", "multi"], ["q3", "matrix_single"], ["q4", "textarea"]]);
  assert.deepEqual(c.questions[0]!.options.map((o) => o.code), [1, 2, 98]);
  assert.ok(c.questions[0]!.options[2]!.otherSpecify);
  assert.ok(c.questions[1]!.options[2]!.exclusive);
  assert.deepEqual(c.questions[2]!.options.map((o) => o.label), ["Poor", "Good"]);
  assert.deepEqual(c.questions[2]!.rows.map((x) => x.label), ["Coverage", "Speed"]);
  assert.equal(c.questions[1]!.displayLogic?.t, "raw");
  assert.ok(c.issues.some((i) => /Script node is not translated/.test(i.message)));
  assert.ok(r.result && r.result.def?.questions.length === 4);
});
