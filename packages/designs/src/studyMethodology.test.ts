import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, STUDY_METHODOLOGIES, recommendMethodology, designAdvice, parseAttributes } from "@rescript/engine";
import { registerBuiltinDesignGenerators } from "./index.js";

registerBuiltinDesignGenerators();
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Study" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const INPUTS = {
  product: "the Premium plan", currency: "$", prices: [5, 10, 15, 20, 25], concepts: ["Concept A", "Concept B", "Concept C"], brands: ["Acme", "Globex", "Initech"],
  items: Array.from({ length: 12 }, (_, i) => `Feature ${i + 1}`), statements: ["I like new things", "Price matters most", "I research before buying", "I stay loyal"],
  attributes: parseAttributes("Price: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat"), organisation: "Acme",
};

test("every methodology builds a valid study through the real gate and generators — questions, logic, designs, no refusals", () => {
  for (const m of STUDY_METHODOLOGIES) {
    const c = coerceSurveyActions(m.build(m.id === "menu_conjoint" ? { ...INPUTS, attributes: parseAttributes("Extra storage: $2, $4\nPriority support: $5, $9\nFamily sharing: $3, $6") } : INPUTS));
    assert.deepEqual(c.rejected, [], `${m.id}: ${JSON.stringify(c.rejected).slice(0, 300)}`);
    const r = applySurveyActions(empty(), c.actions);
    assert.deepEqual(r.errors, [], `${m.id}: ${r.errors.join(" | ").slice(0, 300)}`);
    assert.ok(r.def.questions.length >= 1, `${m.id} wrote questions`);
    if (/conjoint|acbc|maxdiff|innovation/.test(m.id)) assert.ok((r.def.designs ?? []).length >= 1, `${m.id} generated its design file`);
  }
});

test("the objective decides the category and method — with reasons, alternatives and what is missing", () => {
  const cases: [string, string, string][] = [
    ["We need to find the acceptable price range for our new subscription", "pricing", "van_westendorp"],
    ["What price maximises revenue for the new snack? We want a demand curve", "pricing", "gabor_granger"],
    ["How much would customers pay for each feature of our new laptop bundle, against competitors?", "pricing", "conjoint_pricing"],
    ["We have 20 product features and need to know which matter most to customers", "product", "maxdiff"],
    ["Test three packaging designs to see which one performs best", "product", "sequential_monadic"],
    ["Measure brand awareness and consideration against our competitors", "brand", "brand_funnel"],
    ["Run a quarterly brand tracker for our 5 brands", "brand", "brand_tracking"],
    ["Did our TV campaign work? Compare exposed and control groups", "advertising", "brand_lift"],
    ["Employee engagement survey with eNPS for 2,000 staff", "employee", "employee_engagement"],
    ["We want to understand the different types of customers in our market and build personas", "segmentation", "segmentation"],
    ["Voting intention poll before the election", "opinion", "public_opinion"],
  ];
  for (const [text, cat, id] of cases) {
    const r = recommendMethodology(text)!;
    assert.ok(r, text);
    assert.equal(r.category, cat, `${text} → ${r.category}/${r.recommended.id}`);
    assert.equal(r.recommended.id, id, `${text} → ${r.recommended.id}`);
    assert.ok(r.why.length >= 3 && r.alternatives.length >= 1, text);
  }
  assert.ok(recommendMethodology("Find the acceptable price range for our new product")!.missing.some((m) => /Who the respondents are/.test(m)));
});

test("a proposed method that does not answer the objective is flagged, with a better one", () => {
  const r = recommendMethodology("I want to use MaxDiff to find out how much customers would pay for our new plan")!;
  assert.equal(r.proposed?.method.id, "maxdiff");
  assert.equal(r.proposed?.fits, false);
  assert.match(String(r.proposed?.problem), /cannot measure price sensitivity/);
  assert.equal(r.category, "pricing");
  const ok = recommendMethodology("Use Van Westendorp to find the acceptable price range for the Premium plan")!;
  assert.equal(ok.recommended.id, "van_westendorp"); assert.equal(ok.proposed?.fits, true);
});

test("design advice: CBC with the minimum sample from the standard rule, ACBC for many attributes, CVA for specialists, MaxDiff for items", () => {
  const cbc = designAdvice({ attributes: INPUTS.attributes, sample: 200 })!;
  assert.equal(cbc.method, "cbc"); assert.equal(cbc.tasks, 12); assert.equal(cbc.alternatives, 3);
  assert.ok(cbc.minSample >= 300);
  assert.ok(cbc.warnings.some((w) => /below the ≈ \d+/.test(w)));
  const many = designAdvice({ attributes: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, levels: ["x", "y", "z"] })) })!;
  assert.equal(many.method, "acbc");
  assert.equal(designAdvice({ attributes: INPUTS.attributes, specialist: true })!.method, "cva");
  const md = designAdvice({ items: INPUTS.items })!;
  assert.equal(md.method, "maxdiff"); assert.equal(md.perTask, 4); assert.equal(md.tasks, 9);
  const short = designAdvice({ attributes: INPUTS.attributes, maxMinutes: 4 })!;
  assert.ok(short.tasks < 12 && short.warnings.some((w) => /time budget/.test(w)));
});
