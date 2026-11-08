import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { understand } from "./understand.ts";
import { applyAnswer } from "./understandShared.ts";
import { LAUNCHERS, launchMessage } from "./launch.ts";

const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" }, questions: [], flow: [] });
const one = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" }, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Age?", options: [{ code: 1, label: "a" }, { code: 2, label: "b" }] }], flow: [{ id: "b1", type: "block", title: "Main", children: [{ id: "p1", type: "page", questionIds: ["q1"] }] }] });

test("the brief's example: objective, audience, screening and a length of interview become a questionnaire task — with the count assumption said out loud", () => {
  const u = understand({ text: "Create a questionnaire for a healthcare study targeting patients aged 25–45, with appropriate screening questions and a 10-minute LOI", survey: empty });
  assert.equal(u.launcher, "build");
  assert.equal(u.fields.count, "30");
  assert.ok(u.understood.includes("Audience: patients aged 25–45"));
  assert.ok(u.understood.includes("Length of interview: 10 minutes"));
  assert.ok(u.understood.some((x) => /Screening/.test(x)));
  assert.match(u.assumptions[0], /About 30 questions for a 10-minute interview/);
  assert.deepEqual(u.questions, []);
  assert.match(launchMessage(LAUNCHERS.find((l) => l.id === "build")!, u.fields), /^Write a 30 question survey: Create a questionnaire for a healthcare study/);
});

test("each agent is chosen by what the sentence asks, with its fields filled", () => {
  const cases: [string, typeof empty, string, Record<string, string>][] = [
    ["Translate the whole survey into Hindi and French", one, "translate", { language: "Hindi and French", scope: "the whole survey" }],
    ["Run the analysis plan on the clean test data", one, "analyse", { dataset: "TEST", clean: "clean" }],
    ["Draft the findings deck for the board, leading with the NPS gap", one, "report", { audience: "executive", focus: "the NPS gap" }],
    ["Should we launch the premium tier in Q1? Recommend next steps", one, "decide", { question: "Should we launch the premium tier in Q1?" }],
    ["Make every question shorter and more neutral", one, "edit", { goal: "Make every question shorter and more neutral" }],
    ["Create a 30 question UPSC exam on Indian polity with answer key", empty, "exam", { count: "30" }],
  ];
  for (const [t, d, launcher, fields] of cases) {
    const u = understand({ text: t, survey: d });
    assert.equal(u.launcher, launcher, t);
    for (const [k, v] of Object.entries(fields)) assert.equal(u.fields[k], v, `${t}: ${k}`);
  }
});

test("a spoken Hindi request is read through its English reading, and what was said is kept", () => {
  const u = understand({ text: "मरीज़ों के लिए स्वास्थ्य पर 20 सवालों का सर्वे बनाओ", english: "Create a 20 question survey on health for patients", language: "hi", survey: empty });
  assert.equal(u.launcher, "build");
  assert.equal(u.fields.count, "20");
  assert.match(u.understood[0], /You wrote in Hindi/);
  assert.ok(u.assumptions.some((a) => /written in English unless you add “in Hindi”/.test(a)));
});

test("gaps become questions, never guesses: no count, no language, nothing to translate, an unclear sentence", () => {
  const b = understand({ text: "Design a questionnaire about electric scooters", survey: empty });
  assert.deepEqual(b.questions.map((q) => q.key), ["count"]);
  const answered = applyAnswer(b, "count", "15-minute LOI");
  assert.equal(answered.fields.count, "45");
  assert.deepEqual(answered.questions, []);
  assert.equal(applyAnswer(b, "count", "forty-ish"), b, "an answer that is not a number or a length changes nothing");
  assert.ok(understand({ text: "Translate the survey into Hindi", survey: empty }).questions.some((q) => q.key === "nothing"));
  const what = understand({ text: "hello there", survey: one });
  assert.equal(what.launcher, null);
  assert.ok(what.alternatives.length >= 5);
});
