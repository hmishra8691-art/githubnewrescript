import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";
import { accessibilityReview, accessibleColor, adviseLook, contrastRatio, deviceReview } from "./accessibility.js";
import { readResearchBrief } from "./researchBrief.js";

/* IM8 — accessibility, devices and the look, from the definition */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const def = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "x" },
  branding: { colors: { text: "#9aa0a6", surface: "#ffffff", primary: "#7fb3ff" }, typography: { baseSize: "13px" } },
  questions: [
    { id: "q1", code: "Q1", variableName: "PACK", type: "single_select", text: "Which pack do you prefer?", options: opts("A", "B"), settings: { imageUrl: "https://cdn.example.com/pack.png" } },
    { id: "q2", code: "Q2", variableName: "GRID", type: "matrix_single", text: "Rate each", rows: [{ code: "r1", label: "Taste" }], options: opts("1", "2", "3", "4", "5", "6", "7", "8", "9") },
    { id: "q3", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Brands?", options: opts(...Array.from({ length: 15 }, (_, i) => `Brand ${i + 1}`)) },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }],
});

test("contrast arithmetic and the nearest accessible colour", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  const fixed = accessibleColor("#9aa0a6", "#ffffff");
  assert.ok((contrastRatio(fixed, "#ffffff") ?? 0) >= 4.5, fixed);
});

test("the review: contrast, alt text, text size, a wide grid — with the fixes one change makes", () => {
  const r = accessibilityReview(def());
  const crit = r.findings.map((f) => f.criterion);
  assert.ok(crit.some((c) => c.includes("1.4.3")));
  assert.ok(crit.some((c) => c.includes("1.1.1")));
  assert.ok(crit.some((c) => c.includes("1.4.4")));
  assert.ok(crit.some((c) => c.includes("1.3.2")));
  const actions = r.findings.flatMap((f) => f.actions ?? []);
  const after = applySurveyActions(def(), actions as never);
  assert.ok(after.valid, JSON.stringify(after.errors));
  const again = accessibilityReview(after.def);
  assert.ok(!again.findings.some((f) => f.criterion.includes("1.4.3") && f.level === "error"), JSON.stringify(again.findings));
});

test("the sentences", () => {
  assert.equal(interpretRequest(def(), "Check accessibility").kind, "actions");
  assert.equal(interpretRequest(def(), "Fix the contrast").kind, "actions");
  const alt = interpretRequest(def(), "Set the alt text of Q1 to two biscuit packs side by side") as unknown as { kind: string; actions: never[] };
  assert.equal(alt.kind, "actions");
  const a = applySurveyActions(def(), alt.actions);
  assert.equal((a.def.questions[0].settings as { accessibility?: { altText?: string } }).accessibility?.altText, "two biscuit packs side by side");
  assert.ok(!accessibilityReview(a.def).findings.some((f) => f.where === "Q1" && f.criterion.includes("1.1.1")));
  const mob = interpretRequest(def(), "How does it look on a phone?") as { kind: string; answer?: string };
  assert.equal(mob.kind, "answer"); assert.match(mob.answer ?? "", /Q2 is a 9-column grid/); assert.match(mob.answer ?? "", /Q3 lists 15 options/);
  assert.equal(deviceReview(def(), "desktop").findings.length, 0);
});

test("the look from who answers — properties, never a type table", () => {
  const pro = adviseLook(def(), readResearchBrief("Survey of 300 oncologists in Germany about treatment choices"));
  assert.equal((pro.patch.layout as { spacing?: string }).spacing, "compact");
  assert.ok(pro.because.some((b) => /restrained/.test(b)));
  const older = adviseLook(def(), readResearchBrief("Study among adults aged 65+ about pensions"));
  assert.equal((older.patch.typography as { baseSize?: string }).baseSize, "18px");
  const out = interpretRequest(def(), "Make it look right for older patients") as unknown as { kind: string; actions: never[]; understood: string };
  assert.equal(out.kind, "actions"); assert.match(out.understood, /older respondents/);
  assert.ok(applySurveyActions(def(), out.actions).valid);
});
