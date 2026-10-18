import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, INTENT_CATEGORIES, requestScope, isLongBrief, outsideNote, scopeCategories, UNSUPPORTED_MESSAGE, AMBIGUOUS_QUESTION } from "./nlIntent.js";

/*
 * WHAT INTELLIGENT MODE IS FOR (2026-10-17). A request is read for its scope
 * before anything is generated: supported, mixed, unsupported or ambiguous.
 * Conservative — the long list of real research phrasings below (English,
 * Hinglish, Devanagari, the production evidence) must never be refused.
 */

function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "PS", title: "Pricing study" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand do you buy most often?", options: [{ code: 1, label: "Brand A" }, { code: 2, label: "Brand B" }] },
      { id: "q3", code: "Q3", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: [{ code: 1, label: "Low" }, { code: 2, label: "High" }] },
    ],
    flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }] }, { type: "end", id: "e", status: "complete" }],
  });
}

const MUMBAI = "मैं मुंबई में रहता हूँ और यहाँ पे पानी की समस्या बहुत सारी है और यहाँ पे जो एक demographic population है, कुछ slum में रहते हैं और कुछ अच्छे residential apartments में तो पानी एलग-एलग तरीके से बढ़ रहा है तो मेरा मानना ही है कि slums में रहने वारे लोगों को purified पानी नहीं मिलता, please help me design a survey";

/** a pasted brief: headings, numbered sections, bullets and a table — long and AI-written */
const BRIEF = [
  "# Master Prompt: Global Coffee Habits Study", "## 1. Your Role", "Act as a senior market research consultant and survey methodologist.",
  "## 2. Business Problem", "Our client is losing share among under-35 coffee drinkers and needs to know why before the next brand plan.",
  "## 3. Objectives", ...Array.from({ length: 8 }, (_, i) => `${i + 1}. Objective ${i + 1}: measure how coffee choice depends on price, taste, convenience and brand image among segment ${i + 1}.`),
  "## 4. Hypotheses", ...Array.from({ length: 6 }, (_, i) => `- H${i + 1}: younger drinkers weigh convenience more than taste in occasion ${i + 1}.`),
  "## 5. Method", "| Item | Value |", "|---|---|", "| Mode | online, 15 minutes |", "| Sample | n=800, 18–54 |", "| Markets | UK, US, India |",
  "## 6. Analysis", "- crosstabs by age and market; regression on purchase intent; MaxDiff of 10 attributes.",
  "## 7. Reporting", "- a deck and a dashboard.",
].join("\n");

const SUPPORTED = [
  // research planning, hypotheses, methods
  "I want to understand why customers churn from our streaming service",
  "Help me write hypotheses about price sensitivity for premium coffee",
  "Plan four focus groups and a follow-up quant survey — a mixed methods design",
  "What sample size do I need for a 95% confidence level?",
  "Design a MaxDiff with 12 items and a Van Westendorp section",
  "Write a discussion guide for in-depth interviews with nurses",
  // survey creation / modification / programming
  "Create a survey to measure brand awareness among Gen Z",
  "Make Q3 required", "Add display logic", "Create three questions to measure it", "Include it in the analysis plan",
  "Add a chart to the report", "Update the Word document", "make it shorter", "undo that", "yes, go ahead", "build it", "continue",
  "So, question number two as a men's flip-flop mode.",
  "For now only program the survey, rest we will do later.",
  "I want to design a full survey, a new separate survey, yes, please add some screening criteria and yes, please also turn with 30, 35 minutes, yeah, that's good, yeah, you can add more list if you have, you can also ask certain loops, keep things manageable, yeah.",
  // analysis, data quality, reporting, translation, scripting
  "Run a regression of satisfaction on price and quality", "Remove speeders and straight-liners from the data",
  "Draft the executive summary from the findings", "Translate the survey into Hindi and Tamil",
  "When Q2 has option 1 selected show a popup", "Make the theme dark navy with white buttons",
  // off-topic words that serve the survey — supported, not mixed
  "Write a poem-style introduction for the survey", "Add a question about the weather on the day of the visit",
  "Survey travellers who book flights to Goa about their booking experience", "Design a survey for a hotel booking website",
  "Ask respondents to rate the stock price sensitivity question wording",
  // Hinglish and Devanagari
  "Mujhe ek customer satisfaction survey banana hai. Pehle screening karo",
  "Q4 ke jo bhi option select hai, wo Q5 me loop me dikhne chahiye",
  MUMBAI,
  "सारे कोशन सेपरेट पेज़ पे चाहिए।",
  "दो क्वेशन बनाओ पहला क्वेशन ग्रीड बनाओ जिसमें 10 ब्रांड रहेगा",
  "मैं चाहता हूँ कि मेरे सर्वे का जो बैग्क्राउंड थीम है वो चेंज हो जाया",
  BRIEF,
];

const UNSUPPORTED = [
  "write me a poem", "Write a poem about the sea", "tell me a joke", "Book a flight to Delhi", "book me a hotel in Goa",
  "What's the weather today?", "What is the weather in Mumbai", "play some music", "set an alarm for 7am",
  "generate an image of a cat", "who won the world cup", "what is the capital of France", "write my cover letter",
  "मौसम कैसा है आज", "joke sunao", "kavita likho",
];

test("real research requests are never unsupported — English, Hinglish, Devanagari, the production evidence, a long pasted brief", () => {
  for (const t of SUPPORTED) {
    const s = requestScope(t);
    assert.equal(s.scope, "supported", `${s.scope}: ${t.slice(0, 80)}`);
  }
});

test("clearly unrelated requests are unsupported, with the exact sentence and no model call", () => {
  const def = survey();
  for (const t of UNSUPPORTED) {
    const s = requestScope(t);
    assert.equal(s.scope, "unsupported", t);
    const it = interpretRequest(def, t);
    assert.equal(it.kind, "refused", t);
    if (it.kind === "refused") { assert.equal(it.category, "unsupported"); assert.equal(it.reason, UNSUPPORTED_MESSAGE); }
  }
  assert.equal(UNSUPPORTED_MESSAGE, "This request is outside the supported capabilities of Intelligent Mode. You can use this engine for research planning, hypothesis development, survey design and programming, supported analysis, data-quality workflows, translation, and research reporting.");
  assert.ok(INTENT_CATEGORIES.includes("unsupported"));
});

test("a mixed request: the supported part goes on to the model, the outside part is named", () => {
  const def = survey();
  const a = requestScope("Add an NPS question to the survey and book me a flight to Delhi");
  assert.equal(a.scope, "mixed");
  if (a.scope === "mixed") { assert.deepEqual(a.outside, ["book me a flight to Delhi"]); assert.ok(a.categories.includes("survey")); }
  const b = requestScope("Create a survey about coffee habits. Also write me a poem about coffee.");
  assert.equal(b.scope, "mixed");
  if (b.scope === "mixed") assert.match(b.outside[0], /poem about coffee/);
  const it = interpretRequest(def, "Make Q3 required and tell me a joke");
  assert.equal(it.kind, "model");
  assert.ok(it.detected.some((d) => d.what === "outside the platform" && /joke/.test(d.value)));
  assert.match(outsideNote(["book me a flight to Delhi"]), /^This part of your request is outside the supported capabilities of Intelligent Mode and was not done: “book me a flight to Delhi”\./);
});

test("a greeting or a bare help is ambiguous: one focused question, with choices the engine reads", () => {
  for (const t of ["hi", "Hello!", "help", "नमस्ते", "what can you do?"]) {
    assert.equal(requestScope(t).scope, "ambiguous", t);
    const it = interpretRequest(survey(), t);
    assert.equal(it.kind, "clarify", t);
    if (it.kind === "clarify") { assert.equal(it.question, AMBIGUOUS_QUESTION); assert.ok(it.choices.length >= 3); }
  }
});

test("a long brief is recognised as one — never refused for being long, nested, tabular or AI-written; the categories it touches are listed", () => {
  assert.ok(isLongBrief(BRIEF));
  assert.ok(!isLongBrief("Make Q3 required"));
  const s = requestScope(`${BRIEF}\n\nAlso write me a poem about coffee.`);
  assert.equal(s.scope, "supported", "a long brief is never refused or split, whatever is in it");
  assert.equal(s.longBrief, true);
  for (const c of ["research_planning", "hypotheses", "survey", "advanced_methods", "analysis", "reporting"] as const) assert.ok(scopeCategories(BRIEF).includes(c), c);
  assert.ok(scopeCategories(MUMBAI).includes("hypotheses"), "मेरा मानना — a belief to test");
});

test("'add a hypothesis about X' names a topic: the model writes the statement; an explicit one is still recorded by the engine", () => {
  const def = survey();
  const topic = interpretRequest(def, "Add a hypothesis about price sensitivity");
  assert.equal(topic.kind, "model");
  assert.equal(topic.category, "research_design");
  const explicit = interpretRequest(def, "Add hypothesis: price-sensitive shoppers switch brands more often");
  assert.equal(explicit.kind, "actions");
});

test("a pasted brief that mentions MaxDiff is handed on as a research brief, not as a MaxDiff design to configure", () => {
  const it = interpretRequest(survey(), `${BRIEF}\n\nUse a MaxDiff of 12 criteria and design the questionnaire.`);
  assert.equal(it.kind, "model");
  assert.match(it.kind === "model" ? it.reason : "", /a research brief/);
});
