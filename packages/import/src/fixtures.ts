import { deflateSync } from "node:zlib";

/**
 * FIXTURES — source files shaped like the real thing, for the tests and the
 * browser suites. The QSF follows the structure Qualtrics exports
 * (SurveyEntry + SurveyElements with BL / FL / SQ / QO elements, numbered
 * logic sets, `Conjuction`, locators like q://QID1/SelectableChoice/2);
 * the Decipher XML uses Decipher's element vocabulary and Python conditions;
 * the Word file is a real OOXML package; the PDF a real PDF with a
 * compressed content stream.
 */

export function qsfFixture(): Record<string, unknown> {
  const q = (id: string, payload: Record<string, unknown>) => ({ SurveyID: "SV_demo", Element: "SQ", PrimaryAttribute: id, SecondaryAttribute: String(payload.QuestionText ?? "").slice(0, 40), Payload: { QuestionID: id, Language: [], DataVisibility: { Private: false, Hidden: false }, ...payload } });
  const selected = (qid: string, choice: string, conj?: string) => ({ LogicType: "Question", QuestionID: qid, QuestionIsInLoop: "no", ChoiceLocator: `q://${qid}/SelectableChoice/${choice}`, Operator: "Selected", QuestionIDFromLocator: qid, LeftOperand: `q://${qid}/SelectableChoice/${choice}`, Type: "Expression", Description: `<span class="ConjDesc">If</span> ${qid} ${choice} Is Selected`, ...(conj ? { Conjuction: conj } : {}) });
  return {
    SurveyEntry: { SurveyID: "SV_demo", SurveyName: "Customer Satisfaction 2026", SurveyLanguage: "EN", SurveyStatus: "Inactive" },
    SurveyElements: [
      { SurveyID: "SV_demo", Element: "BL", PrimaryAttribute: "Survey Blocks", Payload: [
        { Type: "Default", Description: "Screener", ID: "BL_screen", BlockElements: [{ Type: "Question", QuestionID: "QID1" }, { Type: "Question", QuestionID: "QID2" }, { Type: "Page Break" }, { Type: "Question", QuestionID: "QID3" }], Options: { BlockLocking: "false", RandomizeQuestions: "false" } },
        { Type: "Standard", Description: "Products", ID: "BL_products", BlockElements: [{ Type: "Question", QuestionID: "QID4" }, { Type: "Question", QuestionID: "QID5" }, { Type: "Question", QuestionID: "QID6" }], Options: {} },
        { Type: "Standard", Description: "Per product", ID: "BL_loop", BlockElements: [{ Type: "Question", QuestionID: "QID7" }], Options: { Looping: "Question", LoopingOptions: { QID: "QID4", ChoiceLocator: "q://QID4/ChoiceGroup/SelectedChoices", Randomization: "None" } } },
        { Type: "Standard", Description: "Wrap up", ID: "BL_end", BlockElements: [{ Type: "Question", QuestionID: "QID8" }, { Type: "Question", QuestionID: "QID9" }, { Type: "Question", QuestionID: "QID10" }], Options: {} },
        { Type: "Trash", Description: "Trash / Unused Questions", ID: "BL_trash", BlockElements: [{ Type: "Question", QuestionID: "QID99" }] },
      ] },
      { SurveyID: "SV_demo", Element: "FL", PrimaryAttribute: "Survey Flow", Payload: { Type: "Root", FlowID: "FL_1", Flow: [
        { Type: "EmbeddedData", FlowID: "FL_2", EmbeddedData: [{ Description: "Country", Type: "Custom", Field: "Country", VariableType: "String", Value: "India" }, { Description: "PanelID", Type: "Recipient", Field: "PanelID", VariableType: "String", Value: "" }] },
        { Type: "Block", ID: "BL_screen", FlowID: "FL_3" },
        { Type: "Branch", FlowID: "FL_4", Description: "New Branch", BranchLogic: { 0: { 0: selected("QID1", "2"), Type: "If" }, Type: "BooleanExpression" }, Flow: [{ Type: "EndSurvey", FlowID: "FL_5", Options: { Advanced: "true", ScreenOutResponse: "true" } }] },
        { Type: "Randomizer", FlowID: "FL_6", SubSet: 1, EvenPresentation: true, Flow: [{ Type: "Block", ID: "BL_products", FlowID: "FL_7" }] },
        { Type: "Block", ID: "BL_loop", FlowID: "FL_8" },
        { Type: "Block", ID: "BL_end", FlowID: "FL_9" },
        { Type: "WebService", FlowID: "FL_10", URL: "https://example.com/api" },
      ], Properties: { Count: 10 } } },
      q("QID1", { QuestionText: "Do you agree to take part?", DataExportTag: "Q1", QuestionType: "MC", Selector: "SAVR", SubSelector: "TX", Choices: { 1: { Display: "Yes" }, 2: { Display: "No" } }, ChoiceOrder: [1, 2], Validation: { Settings: { ForceResponse: "ON", ForceResponseType: "ON", Type: "None" } } }),
      q("QID2", { QuestionText: "How old are you?", DataExportTag: "Age", QuestionType: "TE", Selector: "SL", Validation: { Settings: { ForceResponse: "ON", Type: "ContentType", ContentType: "ValidNumber", ValidNumber: { Min: "18", Max: "99", NumDecimals: "0" } } },
        SkipLogic: [{ SkipLogicID: 1, ChoiceLocator: "q://QID2/ChoiceTextEntryValue", Condition: "Selected", SkipToDestination: "ENDOFSURVEY", SkipToDestinationType: "EndOfSurvey" }] }),
      q("QID3", { QuestionText: "Which region do you live in?", DataExportTag: "Region", QuestionType: "MC", Selector: "DL", Choices: { 1: { Display: "North" }, 2: { Display: "South" }, 4: { Display: "Other", TextEntry: "true" } }, ChoiceOrder: [1, 2, 4], RecodeValues: { 1: "10", 2: "20", 4: "99" },
        DisplayLogic: { 0: { 0: selected("QID1", "1"), Type: "If" }, Type: "BooleanExpression", inPage: false } }),
      q("QID4", { QuestionText: "Which of these products do you use? Select all that apply.", DataExportTag: "Products", QuestionType: "MC", Selector: "MAVR", Choices: { 1: { Display: "Alpha" }, 2: { Display: "Beta" }, 3: { Display: "Gamma" }, 5: { Display: "None of these", ExclusiveAnswer: true } }, ChoiceOrder: [1, 2, 3, 5], Randomization: { Type: "All" },
        Validation: { Settings: { ForceResponse: "ON", Type: "MinChoices", MinChoices: "1" } } }),
      q("QID5", { QuestionText: "How satisfied are you with ${q://QID4/ChoiceGroup/SelectedChoices}?", DataExportTag: "Sat", QuestionType: "Matrix", Selector: "Likert", SubSelector: "SingleAnswer", Choices: { 1: { Display: "Quality" }, 2: { Display: "Price" } }, ChoiceOrder: [1, 2], Answers: { 1: { Display: "Low" }, 2: { Display: "Medium" }, 3: { Display: "High" } }, AnswerOrder: [1, 2, 3],
        DisplayLogic: { 0: { 0: selected("QID4", "1"), 1: selected("QID4", "2", "Or"), Type: "If" }, Type: "BooleanExpression" },
        QuestionJS: "Qualtrics.SurveyEngine.addOnload(function()\n{\n\t/*Place your JavaScript here to run when the page loads*/\n\n});" }),
      q("QID6", { QuestionText: "Your email address", DataExportTag: "Email", QuestionType: "TE", Selector: "SL", Validation: { Settings: { ForceResponse: "OFF", Type: "ContentType", ContentType: "ValidEmail" } },
        DisplayLogic: { 0: { 0: { LogicType: "EmbeddedField", LeftOperand: "Country", Operator: "EqualTo", RightOperand: "India", Type: "Expression", Description: "If Country Is Equal to India" }, Type: "If" }, Type: "BooleanExpression" } }),
      q("QID7", { QuestionText: "How often do you use ${lm://Field/1}?", DataExportTag: "Freq", QuestionType: "MC", Selector: "SAVR", Choices: { 1: { Display: "Daily" }, 2: { Display: "Weekly" } }, ChoiceOrder: [1, 2] }),
      q("QID8", { QuestionText: "Anything else?", DataExportTag: "Q8", QuestionType: "TE", Selector: "ESTB",
        QuestionJS: "Qualtrics.SurveyEngine.addOnload(function(){ var c = \"${e://Field/Country}\"; if (c == 'India') { this.hideNextButton(); } Qualtrics.SurveyEngine.setEmbeddedData('Seen8', '1'); });",
        DisplayLogic: { 0: { 0: { LogicType: "GeoIP", Operator: "Selected", Type: "Expression", Description: "If location is India" }, Type: "If" }, Type: "BooleanExpression" } }),
      q("QID9", { QuestionText: "Thank you!", DataExportTag: "Q9", QuestionType: "DB", Selector: "TB" }),
      q("QID10", { QuestionText: "Rate us", DataExportTag: "Q10", QuestionType: "Draw", Selector: "Signature" }),
      q("QID99", { QuestionText: "Old question", DataExportTag: "Old", QuestionType: "MC", Selector: "SAVR", Choices: { 1: { Display: "A" } }, ChoiceOrder: [1] }),
      { SurveyID: "SV_demo", Element: "QO", PrimaryAttribute: "QO_1", Payload: { ID: "QO_1", Name: "North region", Occurrences: 100, Logic: { 0: { 0: selected("QID3", "1"), Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "EndCurrentSurvey" } },
      { SurveyID: "SV_demo", Element: "SO", PrimaryAttribute: "Survey Options", Payload: { BackButton: "false", Header: "" } },
    ],
  };
}

export const DECIPHER_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<survey alt="Automotive Study" builder:wizardCompleted="1" builderCompatible="1" compat="153" name="Survey" state="testing" xmlns:builder="http://decipherinc.com/builder" xmlns:ss="http://decipherinc.com/ss">
<samplesources default="1">
  <samplesource list="1">
    <title>Panel</title>
    <var name="psid" unique="1"/>
    <var name="source"/>
    <exit cond="terminated">Sorry</exit>
  </samplesource>
</samplesources>
<radio label="q1" optional="0">
  <title>Do you own a car?</title>
  <row label="r1" value="1">Yes</row>
  <row label="r2" value="2">No</row>
</radio>
<term label="t_nocar" cond="q1.r2">No car</term>
<suspend/>
<number label="q2" size="3" verify="range(18,99)">
  <title>How old are you?</title>
</number>
<checkbox label="q3" atleast="1">
  <title>Which brands have you heard of?</title>
  <comment>Select all that apply</comment>
  <row label="r1">Toyota</row>
  <row label="r2">Ford</row>
  <row label="r3">BMW</row>
  <noanswer label="r99">None of these</noanswer>
</checkbox>
<suspend/>
<radio label="q4" cond="q3.r1 or q3.r2" shuffle="rows">
  <title>How would you rate each brand?</title>
  <row label="r1">Toyota</row>
  <row label="r2">Ford</row>
  <col label="c1">Poor</col>
  <col label="c2">Good</col>
  <col label="c3">Excellent</col>
</radio>
<goto target="q7" cond="q2.ival &lt; 25"/>
<radio label="q5" where="execute">
  <title>Age group (hidden)</title>
  <row label="r1">Under 35</row>
  <row label="r2">35+</row>
</radio>
<exec>
if q2.ival &lt; 35: q5.val = q5.r1.index
else: q5.val = q5.r2.index
</exec>
<text label="q6" optional="1" cond="hasMarker('qualified') and q1.r1">
  <title>Any comments about [pipe: q1]?</title>
</text>
<loop label="lp1" vars="model">
  <title>Per model</title>
  <block label="b_loop">
    <radio label="q7_[loopvar: model]">
      <title>Would you buy the [loopvar: model]?</title>
      <row label="r1">Yes</row>
      <row label="r2">No</row>
    </radio>
  </block>
  <looprow label="1"><loopvar name="model">Corolla</loopvar></looprow>
  <looprow label="2"><loopvar name="model">Focus</loopvar></looprow>
</loop>
<radio label="q7">
  <title>Final question</title>
  <row label="r1">A</row>
  <row label="r2">B</row>
</radio>
<quota label="quota_age" sheet="Age"/>
</survey>`;

export const DOC_LINES = [
  "Consumer Snacking Study",
  "SECTION A: SCREENER",
  "Q1. Do you ever buy snacks?",
  "1. Yes",
  "2. No (TERMINATE)",
  "Q2. How old are you?",
  "[NUMERIC, 18-99]",
  "PAGE BREAK",
  "Q3. Which of these brands have you bought? Select all that apply.",
  "1. Crunchy Co",
  "2. Salty Ltd",
  "3. Sweet Inc",
  "99. None of these",
  "SECTION B: USAGE",
  "ASK Q4 ONLY IF Q3 = 1 OR 2",
  "Q4. Why do you buy them?",
  "Q5. Do you buy snacks online?",
  "1. Yes",
  "2. No",
  "IF NO, SKIP TO Q7",
  "Q6. Which website do you use most?",
  "Q7. Ask only existing customers: How long have you been a customer?",
  "ASK ONLY IF EXISTING CUSTOMER",
  "Q8. Any other comments?",
];

/* ------------------------------------------------------------ a real .docx */

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** a STORE zip, enough for a test document */
export function makeZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text); const nm = enc.encode(name); const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(files).length, true); e.setUint16(10, Object.keys(files).length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * A Word questionnaire: headings styled as headings, the answer lists as REAL
 * auto-numbered lists (so their "1." is not in the text — the list level is),
 * and a grid written as a table.
 */
export function docxFixture(): Uint8Array {
  const p = (text: string, opts: { style?: string; num?: number; level?: number; bold?: boolean } = {}) =>
    `<w:p><w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${opts.num ? `<w:numPr><w:ilvl w:val="${opts.level ?? 0}"/><w:numId w:val="${opts.num}"/></w:numPr>` : ""}</w:pPr><w:r>${opts.bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const table = (rows: string[][]) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  const body = [
    p("Hotel Experience Survey", { style: "Title" }),
    p("Section 1: About your stay", { style: "Heading1" }),
    p("Q1. Did you stay with us in the last 12 months?", { bold: true }),
    p("Yes", { num: 2, level: 1 }), p("No (TERMINATE)", { num: 2, level: 1 }),
    p("Q2. What was the purpose of your stay? (Select all that apply)", { bold: true }),
    p("Business", { num: 3, level: 1 }), p("Leisure", { num: 3, level: 1 }), p("Other (please specify)", { num: 3, level: 1 }),
    p("Section 2: Ratings", { style: "Heading1" }),
    p("ASK IF Q2 = Business", {}),
    p("Q3. Please rate each of the following.", { bold: true }),
    table([["", "Poor", "Fair", "Good", "Excellent"], ["Room", "", "", "", ""], ["Service", "", "", "", ""], ["Breakfast", "", "", "", ""]]),
    p("Q4. How many nights did you stay?", { bold: true }),
    p("Q5. Any other comments?", { bold: true }),
  ].join("");
  return makeZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`,
  });
}

/* ------------------------------------------------------------ a real PDF */

/** a two-page PDF: page 1 an uncompressed content stream, page 2 FlateDecode; Helvetica, WinAnsi */
/** a tiny, valid JPEG (1×1 grey) — what a scanner's page image looks like to the extractor */
export const TINY_JPEG = Uint8Array.from([0xff,0xd8,0xff,0xdb,0x00,0x43,0x00,...Array(64).fill(1),0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x11,0x00,0xff,0xc4,0x00,0x14,0x00,0x01,...Array(15).fill(0),0xff,0xc4,0x00,0x14,0x10,...Array(16).fill(0),0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0x00,0xff,0xd9]);

export function pdfFixture(lines: string[][], opts: { images?: Record<number, Uint8Array | Uint8Array[]> } = {}): Uint8Array {
  const enc = new TextEncoder();
  const objs: (string | { dict: string; stream: Uint8Array })[] = [];
  const add = (o: string | { dict: string; stream: Uint8Array }) => { objs.push(o); return objs.length; };
  const catalog = add(""); const pages = add(""); const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];
  lines.forEach((ls, i) => {
    const ops = ["BT", "/F1 11 Tf", "72 760 Td", ...ls.flatMap((l, k) => [k === 0 ? "" : "0 -16 Td", `(${l.replace(/[()\\]/g, (m) => `\\${m}`)}) Tj`]).filter(Boolean), "ET"].join("\n");
    const raw = enc.encode(ops);
    const stream = i % 2 ? new Uint8Array(deflateSync(raw)) : raw;
    const given = opts.images?.[i];
    const imgs = given ? (Array.isArray(given) ? given : [given]) : [];
    // several images on a page get different sizes (a logo and the page scan): the last is the largest
    const imageIds = imgs.map((img, k) => add({ dict: `<< /Type /XObject /Subtype /Image /Width ${k === imgs.length - 1 ? 1700 : 120} /Height ${k === imgs.length - 1 ? 2200 : 80} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>`, stream: img }));
    // a scanned page: its content draws the image (uncompressed, so the fixture stays readable)
    const body = imgs.length ? new Uint8Array([...raw, ...enc.encode(imageIds.map((_, k) => `\nq 612 0 0 792 0 0 cm /Im${k + 1} Do Q`).join(""))]) : stream;
    const content = add({ dict: `<< /Length ${body.length}${i % 2 && !imgs.length ? " /Filter /FlateDecode" : ""} >>`, stream: body });
    pageIds.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >>${imageIds.length ? ` /XObject << ${imageIds.map((id, k) => `/Im${k + 1} ${id} 0 R`).join(" ")} >>` : ""} >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const chunks: Uint8Array[] = [enc.encode("%PDF-1.4\n")];
  let off = chunks[0].length;
  const xref: number[] = [];
  objs.forEach((o, i) => {
    xref.push(off);
    const head = enc.encode(`${i + 1} 0 obj\n${typeof o === "string" ? o : `${o.dict}\nstream\n`}`);
    const tail = enc.encode(typeof o === "string" ? "\nendobj\n" : "\nendstream\nendobj\n");
    const body = typeof o === "string" ? new Uint8Array() : o.stream;
    chunks.push(head, body, tail); off += head.length + body.length + tail.length;
  });
  chunks.push(enc.encode(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((x) => `${String(x).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${off}\n%%EOF`));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
