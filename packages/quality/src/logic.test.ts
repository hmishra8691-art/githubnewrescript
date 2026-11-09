import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { assess } from "./engine.js";
import { logicChecksFor } from "./rules/logic.js";

const brands = [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }, { code: "3", label: "Gamma" }, { code: "4", label: "Delta" }, { code: "99", label: "None of these" }];
const DEF = SurveyDefinition.parse({
  meta: { id: "lg", code: "LG", title: "Logic", version: "1.0" },
  quality: { enabled: true, strictness: "standard" },
  questions: [
    { id: "aw", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which of these brands have you heard of?", options: brands },
    { id: "us", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which of these brands have you used in the past year?", options: brands },
    { id: "pr", code: "Q3", variableName: "Q3", type: "single_select", text: "Which is your favourite brand?", options: brands.slice(0, 4) },
    { id: "age", code: "Q4", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "hh", code: "Q5", variableName: "Q5", type: "numeric", text: "How many people live in your household, including yourself?" },
    { id: "ch", code: "Q6", variableName: "Q6", type: "numeric", text: "How many children under 18 live with you?" },
    { id: "cars", code: "Q7", variableName: "Q7", type: "numeric", text: "How many cars does your household have?" },
    { id: "ev", code: "Q8", variableName: "Q8", type: "numeric", text: "How many of them are electric?" },
    { id: "yrs", code: "Q9", variableName: "Q9", type: "numeric", text: "For how long have you lived at your current address? Number of years." },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["aw", "us", "pr", "age", "hh", "ch", "cars", "ev", "yrs"] }, { type: "end", id: "e", status: "complete" }],
});
const run = (answers: Record<string, unknown>) => assess({ def: DEF, response: { sessionId: "s", status: "complete", answers, startedAt: null, completedAt: null }, peers: [], now: Date.UTC(2026, 10, 9) });
const ids = (a: ReturnType<typeof run>) => a.flags.map((f) => f.ruleId).filter((r) => r.startsWith("consistency."));
const CLEAN = { aw: ["1", "2", "3"], us: ["1", "2"], pr: "1", age: 40, hh: 4, ch: 2, cars: 2, ev: 1, yrs: 10 };

test("a consistent respondent carries none of the new flags", () => {
  assert.deepEqual(ids(run(CLEAN)), []);
});

test("exclusive answer combined with others", () => {
  const a = run({ ...CLEAN, aw: ["1", "99"], us: ["1"] });
  const f = a.flags.find((x) => x.ruleId === "consistency.exclusive_combined")!;
  assert.ok(f);
  assert.match(f.observed!, /"None of these" together with "Alpha"/);
});

test("brand funnel: used / preferred but never heard of", () => {
  const a = run({ ...CLEAN, aw: ["1"], us: ["1", "3"], pr: "4" });
  const f = a.flags.filter((x) => x.ruleId === "consistency.funnel");
  assert.ok(f.some((x) => /Q2 names "Gamma", not chosen at Q1/.test(x.observed!)), f.map((x) => x.observed).join(" | "));
  assert.ok(f.some((x) => /Q3 names "Delta"/.test(x.observed!)));
});

test("part larger than its whole: children vs household (incl. yourself), 'how many of them'", () => {
  const a = run({ ...CLEAN, hh: 3, ch: 3, cars: 1, ev: 2 });
  const obs = a.flags.filter((x) => x.ruleId === "consistency.part_whole").map((x) => x.observed);
  assert.ok(obs.includes("Q6 = 3 but Q5 = 3"), obs.join(" | "));
  assert.ok(obs.includes("Q8 = 2 but Q7 = 1"), obs.join(" | "));
});

test("more years than age", () => {
  const a = run({ ...CLEAN, age: 25, yrs: 30 });
  const f = a.flags.find((x) => x.ruleId === "consistency.age_years")!;
  assert.equal(f.observed, "Q9 = 30 years but Q4 (age) = 25");
});

test("the checks a questionnaire supports, listed before any data", () => {
  const c = logicChecksFor(DEF);
  const by = (r: string) => c.filter((x) => x.ruleId === r).map((x) => x.questions.join("→"));
  assert.deepEqual(by("consistency.exclusive_combined"), ["Q1", "Q2"]);
  assert.ok(by("consistency.funnel").includes("Q1→Q2") && by("consistency.funnel").includes("Q2→Q3"));
  assert.deepEqual(by("consistency.part_whole").sort(), ["Q5→Q6", "Q7→Q8"]);
  assert.deepEqual(by("consistency.age_years"), ["Q4→Q9"]);
});

test("cleaning sentences name the new rules", async () => {
  const { rulesNamed } = await import("./cleaning.js");
  assert.ok(rulesNamed("remove people who use brands they have never heard of").includes("consistency.funnel"));
  assert.ok(rulesNamed("flag anyone who ticked none of these along with a brand").includes("consistency.exclusive_combined"));
  assert.ok(rulesNamed("flag households with more children than people").includes("consistency.part_whole"));
  assert.ok(rulesNamed("flag respondents reporting more years than their age").includes("consistency.age_years"));
  assert.ok(rulesNamed("remove contradictory respondents").includes("consistency."));
});
