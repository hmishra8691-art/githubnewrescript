import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { cleanPastedText, cleanPastedLines, cleanPastedHtml, parsePastedQuestions, stripListMarker, stripInvisible, classifyInstruction, extractInstructions, conditionFromExpression, applyPasteInstructions } from "./pasteClean.js";

const q = (s: string) => cleanPastedText(s, "question").text;
const o = (s: string) => cleanPastedText(s, "option").text;

test("the request's own examples", () => {
  assert.equal(q("1. How often do you purchase this product?"), "How often do you purchase this product?");
  assert.equal(q("2) Which brand do you currently use?"), "Which brand do you currently use?");
  assert.equal(o("• Apple"), "Apple");
  assert.equal(o("▪ Samsung"), "Samsung");
  assert.equal(o("a) Other"), "Other");
  assert.equal(o("- Option 1"), "Option 1");
  assert.deepEqual(cleanPastedLines("1. Apple\n2. Samsung\n3. OnePlus\n4. Other (Please specify)").lines, ["Apple", "Samsung", "OnePlus", "Other (Please specify)"]);
  assert.deepEqual(parsePastedQuestions("1. What is your age?\n2. Which city do you live in?\n3. What is your occupation?")!.map((x) => x.text), ["What is your age?", "Which city do you live in?", "What is your occupation?"]);
});

test("numbers, hyphens and symbols that are content are never touched", () => {
  for (const keep of ["18-24", "1,000", "Option 1", "Q1", "1.5 litres", "-5", "3 times a week", "100%", "5+ years", "$50 – $99", "2024", "A. Smith & Sons", "e.g. tea or coffee", "i.e. never", "10. 5", "(Please specify)", "*Required", "#1 brand", "24/7 support", "Under 18", "1 - Not at all likely", "5 – Extremely likely", "R&D", "50/50"]) {
    if (keep === "10. 5") continue; // "10." followed by text IS a marker: covered below
    assert.equal(o(keep), keep, keep);
    assert.equal(q(keep), keep, keep);
  }
  assert.equal(o("10. 5 or more"), "5 or more");
  assert.equal(o("3. 18-24"), "18-24");
  assert.equal(o("(4) 1,000 or more"), "1,000 or more");
  assert.equal(o("b) Option 1"), "Option 1");
});

test("every marker style a document uses", () => {
  const cases: [string, string][] = [
    ["1. Apple", "Apple"], ["12) Apple", "Apple"], ["(3) Apple", "Apple"], ["a) Apple", "Apple"], ["(b) Apple", "Apple"], ["iv) Apple", "Apple"], ["(ii) Apple", "Apple"],
    ["• Apple", "Apple"], ["◦ Apple", "Apple"], ["■ Apple", "Apple"], ["➢ Apple", "Apple"], ["✓ Apple", "Apple"], ["☐ Apple", "Apple"], ["· Apple", "Apple"], ["– Apple", "Apple"], ["* Apple", "Apple"],
    ["\uF0B7 Apple", "Apple"], ["\uF0A7\tApple", "Apple"], ["1.\tApple", "Apple"], ["  2.   Apple", "Apple"], ["Q7. Apple or pear?", "Apple or pear?"], ["Q12a: Why?", "Why?"], ["Question 3) Why?", "Why?"], ["1. • Apple", "Apple"],
  ];
  for (const [input, want] of cases) assert.equal(o(input), want, JSON.stringify(input));
});

test("a letter with a full stop is a marker only inside a list that runs in order", () => {
  assert.deepEqual(cleanPastedLines("A. Very satisfied\nB. Satisfied\nC. Dissatisfied").lines, ["Very satisfied", "Satisfied", "Dissatisfied"]);
  assert.deepEqual(cleanPastedLines("i. Daily\nii. Weekly\niii. Monthly").lines, ["Daily", "Weekly", "Monthly"]);
  assert.deepEqual(cleanPastedLines("A. Smith\nJ. Jones\nP. Patel").lines, ["A. Smith", "J. Jones", "P. Patel"], "initials are not a sequence");
  assert.equal(stripListMarker("A. Smith"), "A. Smith");
});

test("invisible characters and odd spaces go; joiners inside words stay", () => {
  assert.equal(q("What\u00A0is\u200B your\uFEFF age\u00AD?"), "What is your age?");
  assert.equal(q("How   often\t\tdo you  shop?"), "How often do you shop?");
  assert.equal(q("\u202AHello\u202C world"), "Hello world");
  const hindi = "क्\u200Dष and न\u200Cही";
  assert.equal(stripInvisible(hindi), hindi, "ZWJ / ZWNJ between letters are part of the word");
  assert.equal(stripInvisible("\u200DApple\u200C"), "Apple", "a joiner with nothing to join is noise");
  assert.equal(q("Pourquoi ?"), "Pourquoi ?", "French spacing is wording, not noise");
  assert.equal(q("“Smart” quotes and it’s fine"), "“Smart” quotes and it’s fine");
  assert.equal(cleanPastedText("\"He said \"\"yes\"\"\nand left\"", "question").text, "He said \"yes\"\nand left", "a spreadsheet's quoted cell is unwrapped");
  assert.equal(q('"Quoted on purpose"'), '"Quoted on purpose"');
});

test("survey syntax survives every cleaning step, byte for byte", () => {
  const kept = ["{{Q1}}", "{{Q1:label}}", "${Q1}", "${q://QID1/ChoiceGroup/SelectedChoices}", "${e://Field/Country}", "[pipe: q1]", "[% Q1 %]", "[[Q1]]", "%%FirstName%%", "<<Q1>>", "[BRAND]", "[Q1]", "&amp;", "&lt;b&gt;", "&#8217;"];
  for (const k of kept) {
    assert.equal(q(`1. Why did you choose ${k} over others?`), `Why did you choose ${k} over others?`, k);
    assert.equal(o(`• ${k}`), k, `alone as an option: ${k}`);
  }
  assert.equal(q("You said ${q://QID1/ChoiceTextEntryValue}.  Why  ${e://Field/Brand\u00A0Name}?"), "You said ${q://QID1/ChoiceTextEntryValue}. Why ${e://Field/Brand\u00A0Name}?", "nothing inside a token is normalised");
  assert.deepEqual(cleanPastedText("Why {{Q1}}? [BRAND]", "question").instructions, [], "a lone placeholder is not a programmer note");
});

test("programmer notes are taken out of the wording, classified, and never lost", () => {
  const r = cleanPastedText("Q3. Which brands do you know? [PROGRAMMER: RANDOMIZE OPTIONS] (MULTI RESPONSE)", "question");
  assert.equal(r.text, "Which brands do you know?");
  assert.deepEqual(r.instructions.map((i) => i.kind), ["randomize", "multi"]);
  const kinds = (s: string) => extractInstructions(s).instructions.map((i) => i.kind);
  assert.deepEqual(kinds("[DO NOT RANDOMIZE]"), ["no_randomize"]);
  assert.deepEqual(kinds("[ASK ONLY IF Q1 = 1]"), ["condition"]);
  assert.equal(extractInstructions("[ASK ONLY IF Q1 = 1]").instructions[0].expression, "Q1 = 1");
  assert.deepEqual(kinds("[SHOW THIS QUESTION ONLY TO USERS WHO SELECTED OPTION 2]"), ["unknown"], "understood as a note, not guessed into a rule");
  assert.deepEqual(kinds("[INSERT BRAND LIST HERE]"), ["unknown"]);
  assert.deepEqual(kinds("PN: terminate if under 18"), ["terminate"]);
  assert.deepEqual(kinds("Programmer note - show on a new page"), ["unknown"]);
  assert.equal(classifyInstruction("PROGRAMMER: ANCHOR").kind, "anchor");
  /* wording that only looks like a note */
  for (const wording of ["Other (Please specify)", "How satisfied are you (overall)?", "Select all that apply", "Ask your doctor if unsure", "(e.g. tea)", "If yes, why?", "Show me more [link]"]) {
    const x = cleanPastedText(wording, "question");
    assert.equal(x.text, wording, wording); assert.deepEqual(x.instructions, [], wording);
  }
  const opt = cleanPastedLines("1. Alpha\n2. Beta [ANCHOR]\n3. Other (SPECIFY)\n4. None of these [EXCLUSIVE]\n[RANDOMIZE]");
  assert.deepEqual(opt.lines, ["Alpha", "Beta", "Other", "None of these"]);
  assert.deepEqual(opt.instructions.map((i) => [i.kind, i.line]), [["anchor", 1], ["other_specify", 2], ["exclusive", 3], ["randomize", -1]]);
});

test("where the text is going decides how it is cleaned", () => {
  const src = "1.\u00A0If Q1 = 1\u200B then\n   2. show {{Q2}} [RANDOMIZE]";
  assert.equal(cleanPastedText(src, "code").text, "1. If Q1 = 1 then\n   2. show {{Q2}} [RANDOMIZE]", "a logic editor: invisible characters only");
  assert.equal(cleanPastedText("1. First line\n\n2. Second line", "open").text, "1. First line\n\n2. Second line", "open text keeps its numbering");
  assert.equal(cleanPastedText("3.  Section B:\nBrand usage", "title").text, "Section B: Brand usage", "a title is one line");
  assert.equal(cleanPastedText("• Please answer honestly.\n• There are no wrong answers.", "instruction").text, "Please answer honestly.\nThere are no wrong answers.");
});

test("lines a PDF broke mid-sentence are rejoined; separate items never are", () => {
  assert.equal(q("Thinking about the last time you visited one of our\nstores, how satisfied were you with the service you\nreceived?"), "Thinking about the last time you visited one of our stores, how satisfied were you with the service you received?");
  assert.equal(q("How well-\nknown is this brand in your area and among your friends?").includes("well-known"), false, "too short a first line to be a wrapped sentence");
  assert.equal(q("Please tell us how long you have been using this pro-\nduct in total."), "Please tell us how long you have been using this pro-duct in total.", "the hyphen is kept: it may be part of the word");
  assert.equal(cleanPastedText("• a very long first bullet without a full stop at all\n• second bullet", "instruction").text, "a very long first bullet without a full stop at all\nsecond bullet");
  assert.equal(q("What is your age?\nwhich city do you live in?"), "What is your age?\nwhich city do you live in?", "a finished sentence is not joined to the next line");
});

test("Word and web HTML: Word's list numbers, block markers, &nbsp;, notes — tags are left for the sanitiser", () => {
  const word = `<p class=MsoListParagraph style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>1.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>How often do you <b>purchase</b> this product?<o:p></o:p></p>`;
  const w = cleanPastedHtml(word, "question");
  assert.ok(!/1\./.test(w.html.replace(/<[^>]+>/g, "")), w.html);
  assert.match(w.html.replace(/<[^>]+>/g, "").trim(), /^How often do you purchase this product\?$/);
  assert.match(w.html, /<b>purchase<\/b>/, "formatting survives");
  const web = cleanPastedHtml("<ul><li>• Apple&nbsp;</li><li>2) Samsung {{Q1}}</li></ul><p>3. Which\u200B one? [RANDOMIZE]</p>", "question");
  assert.deepEqual(web.html.replace(/<[^>]+>/g, "|").split("|").map((x) => x.trim()).filter(Boolean), ["Apple", "Samsung {{Q1}}", "Which one?"]);
  assert.deepEqual(web.instructions.map((i) => i.kind), ["randomize"]);
  assert.equal(cleanPastedHtml("<p>1. keep&nbsp;me</p>", "code").html, "<p>1. keep&nbsp;me</p>");
});

test("a paste of several questions with their options is read as questions", () => {
  const doc = "Q1. Which brand do you use? [SINGLE RESPONSE]\n1. Apple\n2. Samsung\n3. Other (SPECIFY)\n[RANDOMIZE]\n\nQ2. Why did you choose ${Q1}?\n\nQ3. How likely are you to recommend it? (ASK IF Q1 = 1)\na) Very likely\nb) Not likely";
  const qs = parsePastedQuestions(doc)!;
  assert.deepEqual(qs.map((x) => x.text), ["Which brand do you use?", "Why did you choose ${Q1}?", "How likely are you to recommend it?"]);
  assert.deepEqual(qs.map((x) => x.options), [["Apple", "Samsung", "Other"], [], ["Very likely", "Not likely"]]);
  assert.deepEqual(qs[0].instructions.map((i) => i.kind), ["single", "randomize"]);
  assert.deepEqual(qs[0].optionInstructions.map((x) => [x.option, x.instruction.kind]), [[2, "other_specify"]]);
  assert.equal(qs[2].instructions[0].expression, "Q1 = 1");
  /* not question lists */
  assert.equal(parsePastedQuestions("1. Apple\n2. Samsung\n3. OnePlus"), null, "a numbered list of labels is an option list");
  assert.equal(parsePastedQuestions("How satisfied are you?"), null);
  assert.equal(parsePastedQuestions("Please read carefully.\nWhat is your age?\nWhere do you live?"), null, "text before the first question: left as one paste");
});

test("notes become settings when they can be read with confidence, and Notes for review when they cannot", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }, { code: 3, label: "Unsure" }] },
      { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Brands", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Other" }, { code: 3, label: "None" }] },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  });
  assert.deepEqual(conditionFromExpression(def, "Q1 = 1"), { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 });
  assert.deepEqual(conditionFromExpression(def, "Q1 = 1 OR 2"), { type: "rule", source: { kind: "question", ref: "q1" }, operator: "containsAny", value: [1, 2] });
  assert.deepEqual(conditionFromExpression(def, "Q1 != 3"), { type: "rule", source: { kind: "question", ref: "q1" }, operator: "notSelected", value: 3 });
  assert.equal(conditionFromExpression(def, "Q9 = 1"), null, "an unknown question is not guessed");
  assert.equal(conditionFromExpression(def, "Q1 = 7"), null, "a code the question does not have is not guessed");
  assert.equal(conditionFromExpression(def, "Q1 = 1 OR Q2 = 2"), null, "OR between questions is left for review");
  assert.equal(conditionFromExpression(def, "respondent is a parent"), null);
  const q2 = def.questions[1];
  const ins = [
    ...cleanPastedLines("1. Alpha\n2. Other (SPECIFY)\n3. None [EXCLUSIVE]\n[RANDOMIZE]").instructions,
    ...cleanPastedText("Which? [ASK ONLY IF Q1 = 1] [MANDATORY] [INSERT BRAND LIST HERE]", "question").instructions.map((i) => ({ ...i, line: undefined })),
  ];
  const r = applyPasteInstructions(def, q2, ins);
  assert.equal(q2.randomization?.enabled, true);
  assert.ok(q2.options[1].flags.includes("other_specify") && q2.options[2].flags.includes("exclusive"));
  assert.deepEqual(q2.displayLogic, { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 });
  assert.equal(q2.required, true);
  assert.deepEqual(r.review.map((x) => x.raw), ["INSERT BRAND LIST HERE"]);
  assert.match(q2.notes!, /\[from paste — review\] INSERT BRAND LIST HERE/);
  assert.equal(r.applied.length, 5);
  SurveyDefinition.parse(def);
  /* applying the same notes again does not repeat the review line */
  applyPasteInstructions(def, q2, ins);
  assert.equal(q2.notes!.match(/INSERT BRAND LIST HERE/g)!.length, 1);
});

test("realistic pastes from each source", () => {
  /* Microsoft Word: numbered questions, symbol-font bullets, non-breaking spaces */
  assert.deepEqual(cleanPastedLines("\uF0B7\tVery\u00A0satisfied\n\uF0B7\tSatisfied\n\uF0B7\tNot satisfied").lines, ["Very satisfied", "Satisfied", "Not satisfied"]);
  /* Excel: a column of cells (one per line), one of them quoted because it holds a comma and a quote */
  assert.deepEqual(cleanPastedLines("Apple\nSamsung\n\"OnePlus, the \"\"flagship killer\"\"\"\nOther").lines, ["Apple", "Samsung", "OnePlus, the \"flagship killer\"", "Other"]);
  /* PDF: hard wraps, a ligature-free hyphen break, bullets as "•" */
  assert.equal(cleanPastedText("12. In the past three months, how many times have you\nordered food online from any restaurant or delivery\nservice?", "question").text, "In the past three months, how many times have you ordered food online from any restaurant or delivery service?");
  /* a web page: zero-width spaces between words and a bullet character */
  assert.equal(cleanPastedText("•\u200B Free\u200B delivery\u00A0on orders over $50", "option").text, "Free delivery on orders over $50");
  /* Qualtrics' Word export: "o" bullets, the recode in brackets after each choice, piped text */
  const qx = cleanPastedLines("o Very satisfied  (1) \no Somewhat satisfied  (2) \no ${q://QID3/ChoiceGroup/SelectedChoices}  (3) ");
  assert.deepEqual(qx.lines, ["Very satisfied (1)", "Somewhat satisfied (2)", "${q://QID3/ChoiceGroup/SelectedChoices} (3)"], "the recode is content and stays; the bullet goes");
  assert.deepEqual(cleanPastedLines("on the way\noff the grid").lines, ["on the way", "off the grid"], "words that start with o are not bullets");
  /* Forsta / Decipher: pipes and python-style references must survive in wording */
  assert.equal(cleanPastedText("Q5. Why did you choose [pipe: q1] over ${q2.r1.text}? [res: q3.r2]", "question").text, "Why did you choose [pipe: q1] over ${q2.r1.text}? [res: q3.r2]");
  assert.equal(cleanPastedText("<radio label=\"q1\">\n  <title>1. Pick one</title>\n  <row label=\"r1\">Apple</row>\n</radio>", "code").text, "<radio label=\"q1\">\n  <title>1. Pick one</title>\n  <row label=\"r1\">Apple</row>\n</radio>", "a script pasted into a code field is not edited");
  /* QuestionPro document: numbered question, numbered options, a custom variable */
  const qp = parsePastedQuestions("1. How did you hear about ${custom1}?\n1. Friend\n2. Online ad\n3. Other\n2. Would you recommend us?\n1. Yes\n2. No");
  assert.deepEqual(qp!.map((x) => [x.text, x.options]), [["How did you hear about ${custom1}?", ["Friend", "Online ad", "Other"]], ["Would you recommend us?", ["Yes", "No"]]], "questions and options numbered alike are told apart by the question mark");
  const qp2 = parsePastedQuestions("Q1. How did you hear about ${custom1}?\n1. Friend\n2. Online ad\n3. Other\nQ2. Would you recommend us?\n1. Yes\n2. No")!;
  assert.deepEqual(qp2.map((x) => [x.text, x.options.length]), [["How did you hear about ${custom1}?", 3], ["Would you recommend us?", 2]], "and by Q labels");
  /* a plain-text specification with notes and piping mixed in */
  const spec = cleanPastedText("Q7.  Which of these did you buy at {{Q6}}?   [MULTI RESPONSE] [RANDOMIZE; ANCHOR NONE] [ASK IF Q6 = 1 OR 2]", "question");
  assert.equal(spec.text, "Which of these did you buy at {{Q6}}?");
  assert.deepEqual(spec.instructions.map((i) => i.kind), ["multi", "randomize", "condition"]);
  assert.equal(spec.instructions[2].expression, "Q6 = 1 OR 2");
});

test("several questions pasted into one question: the first fills it, the rest follow it in order with their options and notes", async () => {
  const { insertPastedQuestions } = await import("./pasteClean.js");
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "", options: [{ code: 1, label: "Option 1" }, { code: 2, label: "Option 2" }] },
      { id: "q9", code: "Q9", variableName: "Q9", type: "open_text", text: "Last" },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["q1", "q9"] }, { type: "end", id: "e", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  });
  const blocks = parsePastedQuestions("Q1. Which brand do you use? [RANDOMIZE]\n1. Apple\n2. Samsung & Co\n3. Other (SPECIFY)\nQ2. Why did you choose ${Q1}?\nQ3. Would you recommend it? (ASK IF Q1 = 1) [MULTI RESPONSE] [INSERT LOGO]\na) Yes\nb) No")!;
  let n = 1;
  const make = (kind: "single" | "multi" | "open") => ({ id: `n${++n}`, code: `Q${n}`, variableName: `Q${n}`, type: kind === "open" ? "open_text" : kind === "multi" ? "multi_select" : "single_select", text: "", options: [], rows: [], columns: [], validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [] }) as never;
  const r = insertPastedQuestions(def, "q1", blocks, make);
  assert.deepEqual((def.flow[0] as { questionIds: string[] }).questionIds, ["q1", "n2", "n3", "q9"], "after the question pasted into, before what followed it");
  const [a, b, c] = ["q1", "n2", "n3"].map((id) => def.questions.find((x) => x.id === id)!);
  assert.equal(a.text, "Which brand do you use?");
  assert.deepEqual(a.options.map((o) => [o.code, o.label]), [[1, "Apple"], [2, "Samsung &amp; Co"], [3, "Other"]], "the starter options are replaced; text is stored as HTML");
  assert.ok(a.options[2].flags.includes("other_specify"));
  assert.equal(a.randomization?.enabled, true);
  assert.equal(b.type, "open_text"); assert.equal(b.text, "Why did you choose ${Q1}?");
  assert.equal(c.type, "multi_select"); assert.deepEqual(c.options.map((o) => o.label), ["Yes", "No"]);
  assert.deepEqual(c.displayLogic, { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 }, "ASK IF Q1 = 1 reads the options this same paste gave Q1");
  assert.deepEqual(r.review.map((x) => x.raw), ["INSERT LOGO"]);
  assert.match(c.notes!, /INSERT LOGO/);
  assert.deepEqual(r.questionIds, ["q1", "n2", "n3"]);
  SurveyDefinition.parse(def);
});
