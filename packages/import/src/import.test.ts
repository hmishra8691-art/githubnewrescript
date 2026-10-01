import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import type { CanonicalQuestion, CanonicalSurvey } from "./canonical.js";
import { detectFormat, readSource, mapCanonical, buildReport, analyzeImport, parseXml, extractPdfText, readZip } from "./index.js";
import { qsfFixture, DECIPHER_FIXTURE, DOC_LINES, docxFixture, pdfFixture } from "./fixtures.js";
import { isEmptyJsTemplate } from "./adapters/qsf.js";

const enc = (s: string) => new TextEncoder().encode(s);
const qsfBytes = () => enc(JSON.stringify(qsfFixture()));
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const find = (def: SurveyDefinition, id: string) => def.questions.find((q) => q.id === id)!;
const walk = (ns: FlowNode[], out: FlowNode[] = []): FlowNode[] => { for (const x of ns) { out.push(x); const k = x as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] }; if (k.children) walk(k.children, out); if (k.branches) for (const b of k.branches) walk(b.children, out); if (k.otherwise) walk(k.otherwise, out); } return out; };

/* ------------------------------------------------------------ detection */

test("detection reads content, not extensions", async () => {
  assert.equal(detectFormat(qsfBytes(), "survey.qsf").format, "qsf");
  const renamed = detectFormat(qsfBytes(), "survey.txt");
  assert.equal(renamed.format, "qsf"); assert.equal(renamed.platform, "qualtrics");
  assert.ok(renamed.reasons.some((r) => /ignored/.test(r)), "a misleading extension is noted");
  const dx = detectFormat(enc(DECIPHER_FIXTURE), "automotive_study.xml");
  assert.equal(dx.format, "decipher"); assert.equal(dx.confidence, "high"); assert.match(dx.reasons[0], /<radio>/);
  assert.equal(detectFormat(enc("<?xml version='1.0'?><note><to>x</to></note>"), "a.xml").format, "unknown");
  assert.equal(detectFormat(docxFixture(), "q.bin").format, "docx");
  assert.equal(detectFormat(pdfFixture([["Q1. Hello?"]]), "q").format, "pdf");
  const wb = new ExcelJS.Workbook(); wb.addWorksheet("S").addRow(["QID", "Question"]);
  assert.equal(detectFormat(new Uint8Array(await wb.xlsx.writeBuffer()), "x.dat").format, "xlsx");
  assert.equal(detectFormat(enc("ID,Question,Type,Options\nQ1,Age?,numeric,\nQ2,Gender,single,1=M;2=F\n"), "q.csv").format, "csv");
  assert.equal(detectFormat(enc(DOC_LINES.join("\n")), "q.txt").format, "text");
  assert.match(detectFormat(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), "old.doc").label, /Legacy Office/);
  assert.equal(detectFormat(new Uint8Array(), "e").format, "unknown");
});

test("the XML, ZIP and PDF readers read what the fixtures wrote", () => {
  const x = parseXml(`<a b="1 &amp; 2"><c>t<![CDATA[<raw>]]></c><d/><!-- x --></a>`);
  assert.equal(x.root?.attrs.b, "1 & 2"); assert.equal(x.root?.children[0].text, "t<raw>"); assert.equal(x.root?.children.length, 2);
  assert.ok(parseXml("<a><b></a>").errors.length, "a missing close is reported, not fatal");
  const z = readZip(docxFixture());
  assert.ok(z.has("word/document.xml"));
  const pdf = extractPdfText(pdfFixture([["Q1. Do you like tea?", "1. Yes", "2. No"], ["Q2. Why (really)?"]]));
  assert.deepEqual(pdf.pages, [["Q1. Do you like tea?", "1. Yes", "2. No"], ["Q2. Why (really)?"]], "an uncompressed page and a FlateDecode page, parentheses escaped");
  assert.equal(pdf.scanned, false);
  assert.equal(extractPdfText(pdfFixture([[]])).scanned, true, "no text layer: a scan");
});

/* ------------------------------------------------------------ Qualtrics */

test("QSF: identity is preserved — QIDs, export tags, recodes, block ids", async () => {
  const r = await readSource(qsfBytes(), "Customer_Satisfaction.qsf");
  const c = r.canonical!;
  assert.equal(c.source.title, "Customer Satisfaction 2026");
  assert.deepEqual(c.questions.map((q) => q.sourceId), ["QID1", "QID2", "QID3", "QID4", "QID5", "QID6", "QID7", "QID8", "QID9", "QID10"], "the trash is not read");
  const m = mapCanonical(c, { surveyId: "s1", uid, now: "2026-09-27T00:00:00Z" });
  assert.ok(m.def, JSON.stringify(m.issues.filter((i) => i.severity === "high").slice(0, 3)));
  const def = m.def!;
  assert.ok(def.questions.some((q) => q.id === "QID1" && q.variableName === "Q1"), "QID1 stays QID1, its export tag is the variable");
  assert.equal(find(def, "QID2").variableName, "Age");
  assert.deepEqual(find(def, "QID3").options.map((o) => o.code), [10, 20, 99], "recode values are the codes the data carries");
  assert.ok(find(def, "QID3").options[2].flags.includes("other_specify"));
  assert.ok(find(def, "QID4").options[3].flags.includes("exclusive"));
  assert.ok(!def.questions.some((q) => q.id === "QID99"), "the trash is not imported");
  assert.ok(m.issues.some((i) => /trash/.test(i.message)));
  const nodes = walk(def.flow as FlowNode[]);
  assert.ok(nodes.some((x) => x.id === "BL_screen" && x.type === "block"), "BL_screen keeps its id, and is a block of two pages (a page break)");
  const screen = nodes.find((x) => x.id === "BL_screen") as { children: { questionIds: string[] }[] };
  assert.deepEqual(screen.children.map((p) => p.questionIds), [["QID1", "QID2"], ["QID3"]]);
  assert.ok(m.mapping.some((e) => e.kind === "question" && e.source === "QID1" && e.rescript === "QID1"));
  assert.ok(m.mapping.some((e) => e.kind === "option" && e.source === "QID3/1" && e.rescript === "Region=10"));
  assert.equal(def.imports?.[0].platform, "qualtrics");
  assert.equal(def.imports?.[0].fingerprint, c.source.fingerprint);
});

test("QSF: the survey flow is reconstructed — embedded data, branch to a screen-out, randomizer, loop, end", async () => {
  const c = (await readSource(qsfBytes(), "s.qsf")).canonical!;
  const def = mapCanonical(c, { surveyId: "s1", uid }).def!;
  const top = (def.flow as FlowNode[]).map((x) => x.type).filter((t) => t !== "quota_check");
  assert.deepEqual(top, ["embedded_data", "block", "branch", "randomizer", "loop", "page", "end"], top.join(","));
  const of = <T extends FlowNode["type"]>(t: T) => (def.flow as FlowNode[]).find((x) => x.type === t) as Extract<FlowNode, { type: T }>;
  const ed = def.flow[0] as Extract<FlowNode, { type: "embedded_data" }>;
  assert.deepEqual(ed.fields.map((f) => [f.name, f.source, f.value ?? null]), [["Country", "static", "India"], ["PanelID", "url", null]]);
  const br = of("branch");
  assert.deepEqual(br.branches[0].when, { type: "rule", source: { kind: "question", ref: "QID1" }, operator: "selected", value: 2 });
  assert.equal((br.branches[0].children[0] as { status: string }).status, "screened", "EndSurvey with ScreenOutResponse ends screened");
  const rnd = of("randomizer");
  assert.equal(rnd.show, 1); assert.equal(rnd.evenPresentation, true);
  const lp = of("loop");
  assert.deepEqual(lp.source, { kind: "question", questionId: "QID4", filter: "selected" }, "Loop & Merge over QID4's selected choices");
  assert.equal(find(def, "QID7").text, "How often do you use {{loop.label}}?", "loop-merge piping");
  assert.equal(find(def, "QID5").text, "How satisfied are you with {{Products}}?", "question piping → the Rescript code");
  assert.equal(def.flow[def.flow.length - 1].type, "end");
  const qc = def.flow.find((x) => x.type === "quota_check") as Extract<FlowNode, { type: "quota_check" }>;
  assert.ok(qc, "the quota is checked after the block that asks what it counts");
  assert.ok(def.flow.indexOf(qc) > (def.flow as FlowNode[]).findIndex((x) => x.id === "BL_screen"));
  assert.equal(def.quotas[0].cells[0].limit, 100);
});

test("QSF: logic is converted where readable and reported where not — nothing guessed", async () => {
  const c = (await readSource(qsfBytes(), "s.qsf")).canonical!;
  const m = mapCanonical(c, { surveyId: "s1", uid });
  const def = m.def!;
  assert.deepEqual(find(def, "QID3").displayLogic, { type: "rule", source: { kind: "question", ref: "QID1" }, operator: "selected", value: 1 });
  assert.deepEqual(find(def, "QID5").displayLogic, { type: "group", op: "or", children: [
    { type: "rule", source: { kind: "question", ref: "QID4" }, operator: "selected", value: 1 },
    { type: "rule", source: { kind: "question", ref: "QID4" }, operator: "selected", value: 2 },
  ] }, "Conjuction: Or → OR");
  assert.deepEqual(find(def, "QID6").displayLogic, { type: "rule", source: { kind: "embedded", ref: "Country" }, operator: "eq", value: "India" });
  assert.equal(find(def, "QID8").displayLogic, undefined, "a GeoIP condition is NOT approximated");
  assert.ok(m.issues.some((i) => i.severity === "high" && /could not be converted.*location is India/.test(i.message)));
  assert.match(find(def, "QID8").notes ?? "", /Source display logic \(not converted\)/);
  assert.equal(m.issues.filter((i) => i.severity === "high" && /location is India/.test(i.message)).length, 1, "one problem, one line: the reader's report is not repeated by the mapper");
  assert.deepEqual(find(def, "QID2").skipLogic.map((s) => s.target), [{ kind: "end" }]);
  assert.deepEqual(find(def, "QID2").validation.map((v) => [v.kind, v.value ?? null]), [["min_value", 18], ["max_value", 99], ["integer", null]]);
  assert.equal(find(def, "QID2").type, "numeric", "a text entry with number validation is numeric");
  assert.equal(find(def, "QID6").type, "open_text"); assert.equal(find(def, "QID6").variant, "text.email");
  assert.equal(find(def, "QID4").randomization?.enabled, true);
  assert.deepEqual(find(def, "QID4").validation.map((v) => v.kind), ["min_selections"]);
  assert.equal(find(def, "QID5").type, "matrix_single"); assert.deepEqual(find(def, "QID5").rows.map((r) => r.label), ["Quality", "Price"]); assert.deepEqual(find(def, "QID5").options.map((o) => o.label), ["Low", "Medium", "High"]);
});

test("QSF: risks are explicit — JavaScript, unsupported types and flow elements", async () => {
  const a = await analyzeImport(qsfBytes(), "Customer_Survey.qsf", { surveyId: "s1", uid });
  const rep = a.report!;
  assert.ok(rep.ok);
  assert.ok(isEmptyJsTemplate('Qualtrics.SurveyEngine.addOnload(function()\n{\n\t/*Place your JavaScript here*/\n});'), "Qualtrics' empty template is not custom logic");
  const js = rep.risks.high.find((i) => /QID8 · JavaScript/.test(i.location));
  assert.ok(js, "real JavaScript is a high risk");
  assert.deepEqual(js!.refs?.includes("Country"), true, "with the fields it reads");
  assert.ok(!rep.risks.high.some((i) => /QID5 · JavaScript/.test(i.location)), "the empty template on QID5 is not flagged");
  assert.ok(rep.risks.high.some((i) => /Signature|Draw/.test(i.message)), "an unsupported question type is high risk");
  assert.ok(find(a.result!.def!, "QID10").text.includes("Not migrated"), "…and a placeholder keeps its position");
  assert.ok(rep.risks.high.some((i) => /WebService/.test(i.message)));
  assert.ok(rep.review.length >= 3);
  for (const i of [...rep.risks.high, ...rep.risks.medium]) { assert.ok(i.location && i.type && i.message, JSON.stringify(i)); assert.equal(typeof i.autoAttempted, "boolean"); }
  assert.equal(rep.detected.questions, 9, "QID1–QID10 less the descriptive QID9 — the trash excluded");
  assert.equal(rep.detected.loops, 1); assert.equal(rep.detected.quotas, 1); assert.equal(rep.detected.embeddedFields, 2);
  assert.match(rep.summary[0], /imported your Qualtrics survey \(QSF\)/);
  assert.ok(rep.audit.some((l) => /^Detected Qualtrics/.test(l)) && rep.audit.some((l) => /^Validation completed/.test(l)));
  assert.equal(a.workload!.questions, 9);
  assert.ok(a.workload!.aiRequests >= 1);
});

test("QSF into an existing survey: identical questions are reused, changed ones renamed, nothing overwritten (§24, §27)", async () => {
  const c = (await readSource(qsfBytes(), "s.qsf")).canonical!;
  const first = mapCanonical(c, { surveyId: "s1", uid }).def!;
  const edited = structuredClone(first);
  find(edited, "QID1").text = "Do you agree to participate? (edited)";
  const m = mapCanonical(c, { surveyId: "s1", existing: edited, uid });
  const def = m.def!;
  assert.ok(m.merge!.unchanged.includes("QID2"), "an identical question is not duplicated");
  assert.equal(def.questions.filter((q) => q.variableName === "Age").length, 1);
  const ch = m.merge!.changed.find((x) => x.source === "QID1");
  assert.ok(ch && ch.differences.includes("text"));
  assert.ok(def.questions.some((q) => q.id === "QID1_Imported" && q.variableName === "Q1_Imported"), "the changed one is added renamed");
  assert.equal(find(def, "QID1").text, "Do you agree to participate? (edited)", "the existing question is untouched");
  assert.ok(m.mapping.some((e) => e.source === "QID1" && e.rescript === "QID1_Imported" && /already used/.test(e.reason ?? "")));
  // logic in the import that reads an unchanged question reads the EXISTING one
  const q3 = def.questions.find((q) => q.id === "QID3_Imported" || (q.id === "QID3" && q !== find(edited, "QID3")));
  assert.ok(q3);
  assert.equal(def.imports?.length, 2); assert.equal(def.imports?.[1].mode, "merge");
});

test("scopes: questions only, structure only, full", async () => {
  const c = (await readSource(qsfBytes(), "s.qsf")).canonical!;
  const q = mapCanonical(c, { surveyId: "s1", scope: "questions", uid }).def!;
  assert.ok(q.questions.every((x) => !x.displayLogic && !x.skipLogic.length));
  assert.ok(!(q.flow as FlowNode[]).some((x) => x.type === "branch" || x.type === "embedded_data"));
  const s = mapCanonical(c, { surveyId: "s1", scope: "structure", uid }).def!;
  assert.ok((s.flow as FlowNode[]).some((x) => x.type === "loop") && (s.flow as FlowNode[]).some((x) => x.type === "embedded_data"));
  assert.ok(s.questions.every((x) => !x.displayLogic), "structure without logic");
  assert.equal(s.quotas.length, 0);
});

/* ------------------------------------------------------------ Decipher */

test("Decipher: labels preserved, grids, hidden questions, Python conditions translated or flagged", async () => {
  const a = await analyzeImport(enc(DECIPHER_FIXTURE), "automotive_study.xml", { surveyId: "s2", uid });
  const def = a.result!.def!;
  assert.ok(def, JSON.stringify(a.report?.risks.high.slice(0, 3)));
  assert.equal(def.meta.title, "Automotive Study");
  assert.equal(find(def, "q1").type, "single_select"); assert.deepEqual(find(def, "q1").options.map((o) => o.code), [1, 2]);
  assert.equal(find(def, "q2").type, "numeric"); assert.deepEqual(find(def, "q2").validation.map((v) => [v.kind, v.value ?? null]), [["integer", null], ["min_value", 18], ["max_value", 99]]);
  assert.equal(find(def, "q3").type, "multi_select"); assert.ok(find(def, "q3").options.at(-1)!.flags.includes("exclusive"), "<noanswer> is exclusive");
  assert.equal(find(def, "q3").instruction, "Select all that apply");
  assert.equal(find(def, "q4").type, "matrix_single"); assert.deepEqual(find(def, "q4").rows.map((r) => r.code), ["r1", "r2"]);
  assert.deepEqual(find(def, "q4").displayLogic, { type: "group", op: "or", children: [{ type: "rule", source: { kind: "question", ref: "q3" }, operator: "selected", value: 1 }, { type: "rule", source: { kind: "question", ref: "q3" }, operator: "selected", value: 2 }] }, "q3.r1 or q3.r2");
  assert.equal(find(def, "q5").type, "hidden", "where=execute: a hidden variable");
  assert.equal(find(def, "q6").required, false, "optional=1");
  assert.equal(find(def, "q6").displayLogic, undefined, "hasMarker() is not guessed");
  assert.ok(a.report!.risks.high.some((i) => /hasMarker/.test(i.message)));
  assert.ok(a.report!.risks.high.some((i) => /Python <exec>/.test(i.message) && i.refs?.includes("q2")), "the exec is flagged with what it reads");
  assert.match(find(def, "q6").text, /\{\{q1\}\}/, "[pipe: q1] → {{q1}}");
  // term → a branch that screens out; goto → a skip rule on the question before it
  const term = (def.flow as FlowNode[]).find((x) => x.type === "branch") as Extract<FlowNode, { type: "branch" }>;
  assert.deepEqual(term.branches[0].when, { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 2 });
  assert.equal((term.branches[0].children[0] as { status: string }).status, "screened");
  assert.deepEqual(find(def, "q4").skipLogic.map((s) => [s.when, s.target]), [[{ type: "rule", source: { kind: "question", ref: "q2" }, operator: "lt", value: 25 }, { kind: "question", ref: "q7" }]]);
  // the loop, with its loopvar as a reference column
  const lp = walk(def.flow as FlowNode[]).find((x) => x.type === "loop") as Extract<FlowNode, { type: "loop" }>;
  assert.deepEqual(lp.source, { kind: "static", items: [{ code: "1", label: "Corolla" }, { code: "2", label: "Focus" }] });
  assert.equal(lp.loopVar, "model");
  const inner = walk(lp.children).flatMap((x) => (x.type === "page" ? x.questionIds : []));
  assert.equal(find(def, inner[0]).text, "Would you buy the {{loop.model}}?");
  assert.ok(a.result!.mapping.some((e) => e.source === "q7_[loopvar: model]" && e.rescript === "q7_loopvar_model" && /not a valid identifier/.test(e.reason ?? "")), "an invalid label is made valid, and the map says so");
  assert.ok(a.report!.risks.medium.some((i) => /quota sheet/.test(i.message)));
  assert.deepEqual((def.flow[0] as Extract<FlowNode, { type: "embedded_data" }>).fields.map((f) => [f.name, f.source]), [["psid", "url"], ["source", "url"]], "sample-source variables");
});

/* ------------------------------------------------------------ documents */

test("text questionnaire: questions, codes, types inferred, sections and page breaks", async () => {
  const a = await analyzeImport(enc(DOC_LINES.join("\n")), "snacks.txt", { surveyId: "s3", uid });
  const c = a.canonical!;
  assert.equal(c.source.title, "Consumer Snacking Study");
  assert.deepEqual(c.questions.map((q) => [q.sourceId, q.kind]), [["Q1", "single"], ["Q2", "numeric"], ["Q3", "multi"], ["Q4", "textarea"], ["Q5", "single"], ["Q6", "textarea"], ["Q7", "textarea"], ["Q8", "textarea"]]);
  const q3 = c.questions[2];
  assert.deepEqual(q3.options.map((o) => o.code), [1, 2, 3, 99]); assert.equal(q3.options[3].exclusive, true);
  assert.deepEqual(c.questions[1].validation, [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }]);
  const blocks = c.flow.filter((f) => f.t === "block") as { title?: string; pages: string[][] }[];
  assert.deepEqual(blocks.map((b) => b.title), ["SCREENER", "USAGE"]);
  assert.deepEqual(blocks[0].pages, [["Q1", "Q2"], ["Q3"]], "PAGE BREAK splits the screener");
  const def = a.result!.def!;
  assert.deepEqual(find(def, "Q1").skipLogic.map((s) => s.target), [{ kind: "terminate", status: "screened" }], "“No (TERMINATE)” screens out");
  assert.equal(find(def, "Q1").options[1].label, "No", "the annotation leaves the label");
  assert.deepEqual(find(def, "Q4").displayLogic, { type: "group", op: "or", children: [{ type: "rule", source: { kind: "question", ref: "Q3" }, operator: "selected", value: 1 }, { type: "rule", source: { kind: "question", ref: "Q3" }, operator: "selected", value: 2 }] });
  assert.deepEqual(find(def, "Q5").skipLogic.map((s) => [s.when, s.target]), [[{ type: "rule", source: { kind: "question", ref: "Q5" }, operator: "selected", value: 2 }, { kind: "question", ref: "Q7" }]], "IF NO, SKIP TO Q7");
  // §36: "existing customers" is not invented
  assert.equal(find(def, "Q8").displayLogic, undefined);
  const amb = a.report!.risks.high.find((i) => i.type === "ambiguous" && /EXISTING CUSTOMER/.test(i.message));
  assert.ok(amb, "the undefined condition is reported as ambiguous");
  assert.match(amb!.message, /no question or answer in it defines that/);
});

test("Word: styled headings, auto-numbered answer lists, a grid from a table, option annotations", async () => {
  const a = await analyzeImport(docxFixture(), "hotel.docx", { surveyId: "s4", uid });
  const c = a.canonical!;
  assert.equal(c.source.title, "Hotel Experience Survey");
  assert.deepEqual(c.questions.map((q) => [q.sourceId, q.kind]), [["Q1", "single"], ["Q2", "multi"], ["Q3", "matrix_single"], ["Q4", "numeric"], ["Q5", "textarea"]]);
  assert.deepEqual(c.questions[0].options.map((o) => [o.code, o.label]), [[1, "Yes"], [2, "No"]], "Word's list numbering is the code");
  assert.equal(c.questions[1].options[2].otherSpecify, true);
  assert.deepEqual(c.questions[2].rows.map((r) => r.label), ["Room", "Service", "Breakfast"]);
  assert.deepEqual(c.questions[2].options.map((o) => o.label), ["Poor", "Fair", "Good", "Excellent"]);
  const def = a.result!.def!;
  assert.deepEqual(find(def, "Q3").displayLogic, { type: "rule", source: { kind: "question", ref: "Q2" }, operator: "selected", value: 1 }, "ASK IF Q2 = Business → by the option's label");
  assert.deepEqual(find(def, "Q1").skipLogic.map((s) => s.target), [{ kind: "terminate", status: "screened" }]);
  assert.deepEqual((c.flow as { title?: string }[]).map((b) => b.title), ["About your stay", "Ratings"]);
});

test("PDF: text extracted, questionnaire read; a scan is reported, not imported", async () => {
  const pdf = pdfFixture([["Q1. Do you drink coffee?", "1. Yes", "2. No"], ["Q2. How many cups a day?"]]);
  const a = await analyzeImport(pdf, "coffee.pdf", { surveyId: "s5", uid });
  assert.deepEqual(a.canonical!.questions.map((q) => [q.sourceId, q.kind]), [["Q1", "single"], ["Q2", "numeric"]]);
  assert.ok(a.result!.def);
  const scan = await analyzeImport(pdfFixture([[], []]), "scan.pdf", { surveyId: "s6", uid });
  assert.equal(scan.canonical, null);
  assert.match(scan.issues[0].message, /no text layer/);
  assert.match(scan.issues[0].suggestion ?? "", /OCR/);
});

test("Excel: the header row is found wherever it is; wide and long layouts; logic cells read", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Questionnaire");
  ws.addRow(["Study: Banking 2026"]);
  ws.addRow([]);
  ws.addRow(["Q No.", "Question Text", "Question Type", "Answer Options", "Routing"]);
  ws.addRow(["Q1", "Do you have a bank account?", "Single", "1=Yes; 2=No", "IF 2, TERMINATE"]);
  ws.addRow(["Q2", "Which banks do you use?", "Multi", "Alpha Bank\nBeta Bank\nNone of these", "ASK IF Q1 = 1"]);
  ws.addRow(["Q3", "How satisfied are you?", "Single", "", ""]);
  ws.addRow(["", "Very satisfied", "", "", ""]);
  ws.addRow(["", "Not satisfied", "", "", ""]);
  ws.addRow(["Q4", "Why?", "Open", "", "ASK IF Q3 = 2"]);
  const a = await analyzeImport(new Uint8Array(await wb.xlsx.writeBuffer()), "banking.xlsx", { surveyId: "s7", uid });
  const c = a.canonical!;
  assert.deepEqual(c.questions.map((q) => [q.sourceId, q.kind, q.options.length]), [["Q1", "single", 2], ["Q2", "multi", 3], ["Q3", "single", 2], ["Q4", "text", 0]]);
  assert.equal(c.questions[1].options[2].exclusive, true);
  const def = a.result!.def!;
  assert.deepEqual(find(def, "Q2").displayLogic, { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "selected", value: 1 });
  assert.deepEqual(find(def, "Q4").displayLogic, { type: "rule", source: { kind: "question", ref: "Q3" }, operator: "selected", value: 2 }, "a long-layout option row carries a code");
  assert.deepEqual(find(def, "Q1").skipLogic.map((s) => s.target), [{ kind: "terminate", status: "screened" }]);
  assert.ok(c.issues.some((i) => /header on row 3/.test(i.message)));
});

test("CSV behaves like a sheet; an unreadable file says why", async () => {
  const a = await analyzeImport(enc('ID,Question,Type,Options\nQ1,"Your age?",Numeric,\nQ2,Gender,Single,"1=Male;2=Female;3=Other"\n'), "q.csv", { surveyId: "s8", uid });
  assert.deepEqual(a.result!.def!.questions.map((q) => [q.id, q.type]), [["Q1", "numeric"], ["Q2", "single_select"]]);
  const bad = await analyzeImport(enc("<?xml version='1.0'?><note/>"), "a.xml", { surveyId: "s9", uid });
  assert.equal(bad.canonical, null);
  assert.match(bad.issues[0].message, /could not be imported/);
});

test("every mapped survey passes the schema and the engine's quality check runs on it", async () => {
  for (const [bytes, name] of [[qsfBytes(), "a.qsf"], [enc(DECIPHER_FIXTURE), "b.xml"], [docxFixture(), "c.docx"], [enc(DOC_LINES.join("\n")), "d.txt"]] as const) {
    const a = await analyzeImport(bytes, name, { surveyId: "s", uid });
    assert.ok(a.result?.def, `${name}: ${JSON.stringify(a.report?.risks.high.filter((i) => i.type === "validation").slice(0, 2))}`);
    assert.ok(a.result!.quality, `${name}: quality ran`);
    assert.ok(a.report!.audit.length >= 3);
  }
});

test("a was-displayed condition is approximated as answered/selected — and says so", () => {
  const q = (id: string, extra: Partial<CanonicalQuestion> = {}): CanonicalQuestion => ({ sourceId: id, variable: id, text: `${id}?`, kind: "single", sourceType: "MC", options: [{ sourceId: "1", code: 1, label: "Yes" }, { sourceId: "2", code: 2, label: "No" }], rows: [], required: true, validation: [], skips: [], custom: [], confidence: "high", notes: [], ...extra });
  const c: CanonicalSurvey = {
    source: { platform: "qualtrics", format: "qsf", fileName: "d.qsf", fingerprint: "x" },
    questions: [
      q("QID1"), q("QID2", { displayLogic: { t: "cmp", ref: { kind: "question", id: "QID1" }, op: "notDisplayed" } }),
      q("QID3", { displayLogic: { t: "cmp", ref: { kind: "question", id: "QID1", choice: "2" }, op: "displayed" } }),
    ],
    flow: [{ t: "block", sourceId: "BL", pages: [["QID1"], ["QID2"], ["QID3"]] }], embedded: [], quotas: [], custom: [], issues: [],
  };
  const m = mapCanonical(c, { surveyId: "d", uid });
  assert.deepEqual(find(m.def!, "QID2").displayLogic, { type: "rule", source: { kind: "question", ref: "QID1" }, operator: "unanswered" });
  assert.deepEqual(find(m.def!, "QID3").displayLogic, { type: "rule", source: { kind: "question", ref: "QID1" }, operator: "selected", value: 2 }, "a displayed choice → selected, by its code");
  assert.equal(m.issues.filter((i) => i.type === "converted" && /was-displayed/.test(i.message)).length, 2);
});

test("custom code is preserved as DISABLED scripts; the project carries its review list; the stored map is compact", async () => {
  const a = await analyzeImport(qsfBytes(), "s.qsf", { surveyId: "s1", uid });
  const def = a.result!.def!;
  const js = def.scripts.filter((x) => x.scope === "question" && x.ref === "QID8");
  assert.equal(js.length, 1, "QID8's JavaScript is kept");
  assert.equal(js[0].enabled, false, "…and never run");
  assert.match(js[0].code, /Qualtrics\.SurveyEngine/);
  assert.match(js[0].notes ?? "", /not executed/);
  assert.ok(!def.scripts.some((x) => x.ref === "QID5"), "the empty template is not custom code");
  assert.match(find(def, "QID8").notes ?? "", /kept, disabled, in Scripts/);
  const dx = (await analyzeImport(enc(DECIPHER_FIXTURE), "b.xml", { surveyId: "s2", uid })).result!.def!;
  const exec = dx.scripts.find((x) => x.scope === "survey" && /exec/.test(x.name));
  assert.ok(exec && exec.enabled === false && /q5\.val/.test(exec.code), "a Decipher <exec> is kept, disabled");
  const rec = def.imports![0];
  assert.ok(rec.review.length >= 3);
  assert.ok(rec.review.every((r) => r.severity === "high" || r.severity === "medium"));
  assert.ok(rec.review.some((r) => r.questionId === "QID8" && /JavaScript/.test(r.location)), "a review item names the question it concerns");
  assert.ok(!rec.map.some((e) => e.kind === "option" && !e.reason), "option entries are not stored when the code is the source's own");
  assert.ok(a.result!.mapping.some((e) => e.kind === "option"), "…but the report has the full map");
  assert.ok(rec.map.some((e) => e.kind === "question" && e.source === "QID1"));
});

/* ------------------------------------------------------------ constants (nested-logic audit, 2026-10-01) */

test("a Qualtrics block that is not in the Survey Flow stays unreachable — FALSE is a real constant, not NOT(empty)", async () => {
  const { createResponseState, compileFlow, evaluateCondition, constantValueOf } = await import("@rescript/engine");
  const fx = qsfFixture() as { SurveyElements: { Element: string; Payload: { Flow?: { ID?: string }[] } }[] };
  const fl = fx.SurveyElements.find((e) => e.Element === "FL")!;
  fl.Payload.Flow = fl.Payload.Flow!.filter((f) => f.ID !== "BL_end");
  const c = (await readSource(enc(JSON.stringify(fx)), "s.qsf")).canonical!;
  const def = mapCanonical(c, { surveyId: "s1", uid }).def!;
  const branch = walk(def.flow as FlowNode[]).find((x) => x.type === "branch" && (x as { branches: { children: FlowNode[] }[] }).branches.some((b) => walk(b.children).some((k) => k.id === "BL_end"))) as unknown as { branches: { when: never }[] };
  assert.ok(branch, "the unused block is kept, behind a branch");
  assert.equal(constantValueOf(branch.branches[0].when), false);
  const state = createResponseState(def, { seed: 1 });
  assert.equal(evaluateCondition(branch.branches[0].when, { def, state, loop: null }), false, "before: NOT(empty AND) — vacuous, so TRUE");
  const pages = compileFlow(def, state).filter((s) => s.kind === "page") as { questionIds: string[] }[];
  assert.ok(!pages.some((p) => p.questionIds.includes("QID8")), "nobody is routed into it");
});
