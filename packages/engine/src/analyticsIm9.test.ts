import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";

/* IM9 — banners, weighting and trackers from a sentence */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const def = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "x" },
  questions: [
    { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
    { id: "q2", code: "Q2", variableName: "AGEG", type: "single_select", text: "Which age group are you in?", options: opts("18-34", "35-54", "55+") },
    { id: "q3", code: "Q3", variableName: "SAT", type: "single_select", text: "How satisfied are you overall?", options: opts("1", "2", "3", "4", "5") },
    { id: "q4", code: "Q4", variableName: "AWARE", type: "single_select", text: "Are you aware of Brand A?", options: opts("Yes", "No") },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }],
});
const run = (d: SurveyDefinition, s: string) => {
  const out = interpretRequest(d, s) as unknown as { kind: string; actions: never[]; understood: string };
  assert.equal(out.kind, "actions", `${s}: ${JSON.stringify(out).slice(0, 300)}`);
  const a = applySurveyActions(d, out.actions);
  assert.ok(a.valid && a.results.every((x) => x.ok), JSON.stringify(a.results.filter((x) => !x.ok)));
  return { def: a.def, understood: out.understood, warnings: a.warnings };
};

test("a banner: satisfaction by age and gender with significance testing", () => {
  const { def: d } = run(def(), "Cross-tab satisfaction by age and gender with significance testing");
  const x = d.research!.analysisPlan!.crosstabs.at(-1)!;
  assert.deepEqual(x.rows, ["SAT"]); assert.deepEqual(x.columns, ["AGEG", "GENDER"]);
});

test("weighting to the census, by named groups and by a split", () => {
  const { def: d, understood, warnings } = run(def(), "Weight the data to the census: 48% male, 52% female");
  const w = d.research!.analysisPlan!.weightingScheme!;
  assert.deepEqual(w.rim, [{ variable: "GENDER", targets: { "1": 48, "2": 52 } }]);
  assert.equal(w.basis, "census"); assert.deepEqual(w.cap, [0.3, 3]);
  assert.match(understood, /Male 48 %, Female 52 %/);
  assert.ok(warnings.some((x) => /Prefer not to say/.test(x)), "an answer with no target is said");
  const two = run(def(), "Weight by age group 30/40/30 to the population").def.research!.analysisPlan!.weightingScheme!;
  assert.deepEqual(two.rim[0].targets, { "1": 30, "2": 40, "3": 30 });
  assert.equal(interpretRequest(def(), "Weight the data: 60% male, 52% female").kind, "refused");
  assert.equal(interpretRequest(def(), "Weight the data").kind, "clarify");
  assert.equal(run(run(def(), "Weight the data to the census: 48% women, 52% men").def, "Remove the weighting").def.research!.analysisPlan!.weightingScheme, undefined);
});

test("a tracker: awareness and satisfaction by wave", () => {
  const { def: d, understood } = run(def(), "Track awareness and satisfaction by wave");
  assert.ok(d.questions.some((q) => q.variableName === "WAVE" && q.type === "hidden"));
  const x = d.research!.analysisPlan!.crosstabs.at(-1)!;
  assert.deepEqual(x.rows, ["AWARE", "SAT"]); assert.deepEqual(x.columns, ["WAVE"]);
  assert.match(understood, /\?WAVE=3/);
});

test("qualitative depth and the infographic, read from sentences", async () => {
  const { interpretQualRequest } = await import("./qualIntent.js");
  const e = interpretQualRequest("What themes are emerging since 1 November 2026?") as { op: string; since?: string };
  assert.equal(e.op, "emerging"); assert.equal(e.since, "2026-11-01");
  const w = interpretQualRequest("Which themes are new in the last two weeks?") as { op: string; since?: string };
  assert.equal(w.op, "emerging"); assert.match(w.since ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(interpretQualRequest("What emotions come through in the price theme?"), { op: "emotion", text: "What emotions come through in the price theme", theme: "price" });
  const o = interpretRequest(def(), "Make an infographic of the key findings") as { kind: string; output?: { type: string } };
  assert.equal(o.kind, "output"); assert.equal(o.output?.type, "infographic");
});
