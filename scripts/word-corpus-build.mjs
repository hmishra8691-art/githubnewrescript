#!/usr/bin/env node
/**
 * THE WORD CORPUS (import brief §16, I8) — synthetic questionnaires in the shapes research teams write them,
 * built as real .docx files (OOXML in a zip) with the package's own fixture writer. No client names, no real
 * brands, no personal data.
 *
 *   node scripts/word-corpus-build.mjs     writes packages/import/corpus/word/*.docx (+ README.md)
 *
 * The files are committed; this script is how they were made and how a case is added. What each file is meant
 * to exercise is listed in CASES[].covers, and packages/import/src/i8Corpus.test.ts holds the expectations.
 *
 * Also writes packages/import/corpus/qsf-invalid/* — broken Qualtrics exports the reader must refuse or
 * degrade on, never crash on.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wordDocFixture } from "../packages/import/dist/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "import", "corpus");
const WORD = join(ROOT, "word");
const BAD = join(ROOT, "qsf-invalid");
mkdirSync(WORD, { recursive: true });
mkdirSync(BAD, { recursive: true });

const q = (code, text, answers = [], instr = []) => [`${code}. ${text}`, ...instr.map((i) => `[${i}]`), ...answers.map((a, i) => typeof a === "string" ? `${i + 1}. ${a}` : `${a[0]}. ${a[1]}`)];
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));

export const CASES = [
  {
    file: "01-simple.docx", covers: "a short questionnaire: headings, numbered answers, an open end, a scale",
    items: [{ p: "Customer Feedback", style: "Title" }, ...q("Q1", "How satisfied are you with our service?", ["Very satisfied", "Satisfied", "Neutral", "Dissatisfied", "Very dissatisfied"]), ...q("Q2", "How likely are you to recommend us?", ["Very likely", "Likely", "Unlikely"]), "Q3. What could we do better?"],
  },
  {
    file: "02-complex-instructions.docx", covers: "readable logic: ASK IF, TERMINATE IF, SKIP TO, RANDOMIZE … EXCEPT, a hidden variable, a programmer note",
    items: [{ p: "Category Study", style: "Title" }, { p: "Screener", style: "Heading1" },
      ...q("S1", "Are you 18 or older?", ["Yes", "No"], ["TERMINATE IF S1 = 2"]),
      ...q("S2", "Do you buy snacks at least once a month?", ["Yes", "No"], ["IF S2 = 2 SKIP TO Q4"]),
      { p: "Main", style: "Heading1" },
      ...q("Q1", "Which brands have you heard of? SELECT ALL THAT APPLY", [[1, "Alpha"], [2, "Beta"], [3, "Gamma"], [99, "None of these"]], ["RANDOMIZE ALL OPTIONS EXCEPT 99"]),
      ...q("Q2", "Which of these brands is your favourite?", ["Alpha", "Beta", "Gamma"], ["ASK IF Q1 = 1"]),
      ...q("Q3", "How often do you buy it?", ["Weekly", "Monthly", "Rarely"]),
      "[PROGRAMMER NOTE: STORE VARIABLE CALLED panel_source FROM THE LINK]",
      "Q4. Anything else you would like to tell us?"],
  },
  {
    file: "03-tables-nested.docx", covers: "a grid written as a table, a table with a nested table in a cell, an image with alt text",
    items: [{ p: "Attribute Ratings", style: "Title" }, "Q1. How much do you agree with each statement?",
      { table: [["", "Agree", "Neutral", "Disagree"], ["The product is good value", "", "", ""], ["The product is easy to use", "", "", ""]] },
      "Q2. Which pack do you prefer?", { image: PNG, name: "pack", ext: "png", alt: "Two pack designs side by side" },
      "1. Pack A", "2. Pack B",
      "Q3. Rate each brand.", { table: [["Brand", "Notes"], ["Alpha", { table: [["Taste", "Price"], ["4", "3"]] }]] }],
  },
  {
    file: "04-contradictory.docx", covers: "instructions that contradict each other (ASK IF and SKIP on the same question) and a skip to a question that does not exist",
    items: [{ p: "Contradictions", style: "Title" },
      ...q("Q1", "Do you own a pet?", ["Yes", "No"], ["IF Q1 = 2 SKIP TO Q9"]),
      ...q("Q2", "What kind of pet?", ["Dog", "Cat", "Other"], ["ASK IF Q1 = 1", "ASK IF Q1 = 2"]),
      ...q("Q3", "How old is it?", ["Under 1", "1 to 5", "Over 5"])],
  },
  {
    file: "05-missing-information.docx", covers: "instructions without a condition or target, a question with no answers, a reference to an unknown question",
    items: [{ p: "Gaps", style: "Title" },
      ...q("Q1", "Do you drive?", ["Yes", "No"]),
      ...q("Q2", "How many km a year?", ["Under 5,000", "5,000 to 15,000", "Over 15,000"], ["ASK ONLY IF THEY DRIVE"]),
      ...q("Q3", "What do you drive?", [], ["SKIP THIS QUESTION IF NOT RELEVANT"]),
      ...q("Q4", "Any comments?", [], ["ASK IF Q42 = 1"])],
  },
  {
    file: "06-poorly-formatted.docx", covers: "no styles, inconsistent numbering, answers on lettered lines, stray blank paragraphs, mixed case instructions",
    items: ["", "survey about lunch", "", "1) where do you eat lunch", "a) at home", "b) at work", "c) out", "", "Q 2 - how much do you spend", "[ask if q1 = c]", "1 - under 5", "2 - 5 to 10", "3 - over 10", "", "q3: any comments"],
  },
  {
    file: "07-large.docx", covers: "a long questionnaire (150 questions in 10 sections) with a display rule every fifth question",
    items: (() => {
      const out = [{ p: "Large Tracker", style: "Title" }];
      for (let s = 1; s <= 10; s++) {
        out.push({ p: `Section ${s}`, style: "Heading1" });
        for (let i = 1; i <= 15; i++) {
          const n = (s - 1) * 15 + i;
          out.push(...q(`Q${n}`, `Statement ${n}: how much do you agree?`, ["Agree", "Neither", "Disagree"], n % 5 === 0 ? [`ASK IF Q${n - 1} = 1`] : []));
        }
      }
      return out;
    })(),
  },
  {
    file: "08-carry-forward-masking.docx", covers: "carry forward of selected options, masking (not selected), a list carried from a carried list, the same list as an earlier question, codes kept",
    items: [{ p: "Brand Funnel", style: "Title" },
      ...q("Q1", "Which of these brands are you aware of? SELECT ALL THAT APPLY", [[1, "Brand A"], [2, "Brand B"], [3, "Brand C"], [4, "Brand D"], [99, "None of these"]]),
      ...q("Q2", "Which of these brands have you purchased? SELECT ALL THAT APPLY", [], ["CARRY FORWARD BRANDS SELECTED AT Q1"]),
      ...q("Q3", "Which brands have you NOT purchased? SELECT ALL THAT APPLY", [], ["SHOW ONLY BRANDS NOT SELECTED AT Q2"]),
      ...q("Q4", "Which brand do you use most often?", [], ["SHOW ONLY BRANDS SELECTED AT Q2"]),
      ...q("Q5", "Which of these brands would you consider in the future? SELECT ALL THAT APPLY", [], ["SAME LIST AS Q1"]),
      ...q("Q6", "Which of these brands do you trust? SELECT ALL THAT APPLY", [[1, "Brand A"], [2, "Brand B"], [3, "Brand C"], [4, "Brand D"]], ["CARRY FORWARD SELECTED FROM Q1"])],
  },
  {
    file: "09-loops-piping.docx", covers: "a loop over the brands selected (two questions), the current brand piped, an answer piped into later text, a numeric answer piped, a carried list piped",
    items: [{ p: "Brand Usage", style: "Title" },
      ...q("Q1", "Which brands have you used in the last year? SELECT ALL THAT APPLY", [[1, "Alpha"], [2, "Beta"], [3, "Gamma"], [4, "Delta"]]),
      ...q("Q2", "How satisfied are you with [BRAND]?", ["Very satisfied", "Satisfied", "Neutral", "Dissatisfied", "Very dissatisfied"], ["ASK FOR EACH BRAND SELECTED AT Q1"]),
      "Q3. Why do you say that about [BRAND]?", "[ASK FOR EACH BRAND SELECTED AT Q1]",
      ...q("Q4", "You said you use [INSERT ANSWER FROM Q1]. Which one is your favourite?", [], ["SHOW ONLY BRANDS SELECTED AT Q1"]),
      "Q5. How old are you?", "[NUMERIC, 18 TO 99]",
      ...q("Q6", "At [Q5 ANSWER] years old, how often do you buy [INSERT Q4]?", ["Weekly", "Monthly", "Less often"]),
      "Q7. Any other comments about {Q4}?"],
  },
  {
    file: "10-informal-instructions.docx", covers: "the same behaviours written informally: previous question, mask out, use the same list, repeat for every brand, pipe in — and one instruction no rule reads",
    items: [{ p: "Informal programming notes", style: "Title" },
      ...q("Q1", "Which supermarkets do you shop at? Select all", [[1, "Tesco"], [2, "Sainsbury's"], [3, "Asda"], [4, "Aldi"], [5, "Lidl"]]),
      ...q("Q2", "And which of these is your main supermarket?", [], ["Programmer: only show the supermarkets they picked in the previous question"]),
      ...q("Q3", "Which of these supermarkets would you never use? Select all", [], ["Mask out whatever they chose in Q1"]),
      ...q("Q4", "How would you rate [SUPERMARKET] overall?", ["Excellent", "Good", "Fair", "Poor"], ["Repeat this question for every supermarket selected in Q1"]),
      ...q("Q5", "Which supermarket would you recommend? Select all", [], ["Use the same answer list as Q1"]),
      ...q("Q6", "What do you like most about [INSERT Q2 RESPONSE]?", []),
      ...q("Q7", "Which of these would you like to see near you?", [], ["Only show the supermarkets they like"])],
  },
];

for (const c of CASES) writeFileSync(join(WORD, c.file), wordDocFixture(c.items));
writeFileSync(join(WORD, "README.md"), `# Word corpus (synthetic)\n\nBuilt by \`scripts/word-corpus-build.mjs\`; expectations in \`packages/import/src/i8Corpus.test.ts\`.\n\n${CASES.map((c) => `- **${c.file}** — ${c.covers}`).join("\n")}\n`);

/* --------------------------------------------------------------- broken Qualtrics exports */
const BROKEN = {
  "01-not-json.qsf": "this is not a Qualtrics export at all",
  "02-truncated.qsf": '{"SurveyEntry":{"SurveyID":"SV_x","SurveyName":"Cut off"},"SurveyElements":[{"SurveyID":"SV_x","Element":"BL","Payload":{"1":{"Type":"Default","ID":"BL_1","BlockElements":[{"Type":"Question","QuestionID":"QI',
  "03-no-elements.qsf": JSON.stringify({ SurveyEntry: { SurveyID: "SV_x", SurveyName: "No elements" } }),
  "04-elements-not-array.qsf": JSON.stringify({ SurveyEntry: { SurveyID: "SV_x", SurveyName: "Wrong shape" }, SurveyElements: { BL: 1 } }),
  "05-question-without-choices.qsf": JSON.stringify({ SurveyEntry: { SurveyID: "SV_x", SurveyName: "Broken question" }, SurveyElements: [
    { SurveyID: "SV_x", Element: "BL", Payload: { 1: { Type: "Default", ID: "BL_1", Description: "B", BlockElements: [{ Type: "Question", QuestionID: "QID1" }, { Type: "Question", QuestionID: "QID404" }] } } },
    { SurveyID: "SV_x", Element: "FL", Payload: { Type: "Root", FlowID: "FL_1", Flow: [{ Type: "Block", ID: "BL_1", FlowID: "FL_2" }] } },
    { SurveyID: "SV_x", Element: "SQ", PrimaryAttribute: "QID1", Payload: { QuestionID: "QID1", QuestionText: "Pick one", QuestionType: "MC", Selector: "SAVR", ChoiceOrder: [1, 2] } },
  ] }),
  "06-flow-cycle.qsf": JSON.stringify({ SurveyEntry: { SurveyID: "SV_x", SurveyName: "Odd flow" }, SurveyElements: [
    { SurveyID: "SV_x", Element: "BL", Payload: [{ Type: "Default", ID: "BL_1", Description: "B", BlockElements: [{ Type: "Question", QuestionID: "QID1" }] }] },
    { SurveyID: "SV_x", Element: "FL", Payload: { Type: "Root", FlowID: "FL_1", Flow: [{ Type: "Block", ID: "BL_1", FlowID: "FL_2" }, { Type: "Block", ID: "BL_1", FlowID: "FL_3" }, { Type: "Block", ID: "BL_missing", FlowID: "FL_4" }] } },
    { SurveyID: "SV_x", Element: "SQ", PrimaryAttribute: "QID1", Payload: { QuestionID: "QID1", QuestionText: "Name?", QuestionType: "TE", Selector: "SL" } },
  ] }),
};
for (const [f, body] of Object.entries(BROKEN)) writeFileSync(join(BAD, f), body);
console.log(`wrote ${CASES.length} Word files and ${Object.keys(BROKEN).length} broken QSF files`);
