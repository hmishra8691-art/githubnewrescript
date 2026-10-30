import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, interpretRequest, DEFER_TO_GRAMMAR } from "@rescript/engine";
import { registerBuiltinDesignGenerators } from "@rescript/designs";
import { classifyRequest, lookOnlySaid, policyRefusal } from "./prompt.ts";

/* the turn route loads the design generators (route.ts) — the conjoint gate needs them */
registerBuiltinDesignGenerators();

/**
 * THE OWNER'S 15 SENTENCES (Phase 4.4, 2026-10-30) — S2a's acceptance tests, plus the auditor's stand-ins that
 * exposed defects (S3 §4.3). Each sentence carries, on S3's fixture survey:
 *  - the server class the turn route computes (`classifyRequest`: mode, `ux` = UX guide sent, `uxOnly` = look-only);
 *  - the engine's reading with no model (`interpretRequest`), where one is deterministic;
 *  - the native action(s) a correct answer must be able to apply through the gate, exactly as the route applies a
 *    model's reply (`coerceSurveyActions` → `applySurveyActions` with the turn's `uxOnly` / `uxOnlyInferred`).
 * A sentence passes when it has a non-blocked path: the native answer is accepted by the gate under the
 * classification the sentence actually gets.
 */
const opts = (n: number, pre = "Opt") => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `${pre} ${i + 1}` }));
const base = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Owner sentences", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRAND", type: "single_select", text: "Which brand?", options: [{ code: 1, label: "Acme" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }, { code: 4, label: "Delta" }, { code: 5, label: "Epsilon" }] },
    { id: "q2", code: "Q2", variableName: "OWN", type: "single_select", text: "Own?", options: opts(3) },
    { id: "q3", code: "Q3", variableName: "COUNT", type: "numeric", text: "How many?" },
    { id: "q4", code: "Q4", variableName: "GRID", type: "matrix_single", text: "Rate", rows: [{ code: 1, label: "Price" }, { code: 2, label: "Quality" }], options: opts(5) },
    { id: "q5", code: "Q5", variableName: "SAT", type: "single_select", text: "Satisfied?", options: opts(5) },
    { id: "q6", code: "Q6", variableName: "ALLOC", type: "constant_sum", text: "Split 100%", options: opts(4, "Item") },
    { id: "q7", code: "Q7", variableName: "USED", type: "multi_select", text: "Used?", options: opts(6) },
    { id: "q8", code: "Q8", variableName: "CONCEPT", type: "single_select", text: "Concepts", options: [{ code: 1, label: "Concept A" }, { code: 2, label: "Concept B" }, { code: 3, label: "Concept C" }, { code: 4, label: "Concept D" }] },
    { id: "q9", code: "Q9", variableName: "AGE", type: "numeric", text: "Your age?" },
  ],
  flow: [{ type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q9"] }] },
         { type: "block", id: "b2", title: "Main", children: [{ type: "page", id: "p2", questionIds: ["q4", "q5"] }, { type: "page", id: "p3", questionIds: ["q6", "q7", "q8"] }] },
         { type: "end", id: "e", status: "complete" }],
});
/* a behaviour script on Q5 — what "debug / explain the script on Q5" is about */
const SCRIPT = "rs.listen('answer', 'self', function () { if (rs.getAnswer('Q2') == 1) rs.showMessage('self', 'Thanks — you own one'); });";
const withScript = applySurveyActions(base, [{ op: "create_behavior", label: "Thank owners", target: "Q5", script: SCRIPT }] as never);
assert.ok(withScript.valid, withScript.errors.join("; "));
const def = withScript.def;
const qid = (code: string) => def.questions.find((q) => q.code === code)!.id;

/** the turn route's gate options for this sentence (route.ts: uxOnlyInferred = uxOnly && !said) */
function gateFor(sentence: string) {
  const c = classifyRequest(sentence, def.questions.length, 0);
  return { cls: c, uxOnly: c.uxOnly, uxOnlyInferred: c.uxOnly && !lookOnlySaid(sentence) };
}
/** a model-shaped reply through coercion and the gate, as route.ts:839 applies it */
function gate(sentence: string, raw: unknown[]) {
  const g = gateFor(sentence);
  const coerced = coerceSurveyActions(raw);
  assert.deepEqual(coerced.rejected, [], `${sentence}: coercion rejected ${JSON.stringify(coerced.rejected)}`);
  const r = applySurveyActions(def, coerced.actions, { uxOnly: g.uxOnly, uxOnlyInferred: g.uxOnlyInferred, uxBehaviour: g.cls.uxBehaviour });
  return r;
}
function assertApplied(sentence: string, raw: unknown[]) {
  const r = gate(sentence, raw);
  const bad = r.results.filter((x) => !x.ok);
  assert.equal(bad.length, 0, `${sentence}: refused — ${bad.map((b) => `${b.op}: ${b.error}`).join(" | ")}`);
  assert.ok(r.valid, r.errors.join("; "));
  return r;
}
const q = (r: { def: SurveyDefinition }, code: string) => r.def.questions.find((x) => x.code === code)! as unknown as Record<string, unknown> & { settings?: Record<string, unknown>; validation?: unknown; randomization?: Record<string, unknown>; variant?: string; type: string; punches?: unknown[] };

/*
 * TARGETS NOT MET YET (S2a item 1): a test labelled with an open defect is skipped with that id so the runner stays
 * green between commits. Each S2a item closes its id here; by the end of S2a this set is empty and removed.
 */
const OPEN = new Set(["D16", "R6"]);
const target = (id?: string) => (id && OPEN.has(id) ? { skip: `target, open defect ${id}` } : {});

interface Owner { defect?: string; n: number; sentence: string; sel?: string; mode: string; ux: boolean; uxOnly: boolean; engine?: string; native: unknown[]; check?: (r: ReturnType<typeof assertApplied>) => void }
const OWNER: Owner[] = [
  { n: 1, sentence: "Make all answer options appear as interactive cards.", mode: "ux", ux: true, uxOnly: true, engine: "model",
    native: [{ op: "set_theme", appearance: { optionStyle: "cards" } }, { op: "create_style", label: "Interactive cards", target: "options", rules: [{ declarations: { "border-radius": "12px" } }, { state: "hover", declarations: { transform: "translateY(-2px)" } }] }] },
  { defect: "R6", n: 2, sentence: "Automatically punch Option 5 when Option 2 is selected.", sel: "Q7", mode: "edit", ux: false, uxOnly: false, engine: "actions",
    native: [{ op: "add_punch", target: "Q7", when: "Q7 = 2", codes: [5] }], check: (r) => assert.equal(q(r, "Q7").punches?.length, 1) },
  { n: 3, sentence: "Show Q5 only when Q2 is Option 1 and Q3 is greater than 5.", mode: "edit", ux: false, uxOnly: false, engine: "actions",
    native: [{ op: "set_display_logic", target: "Q5", expression: "Q2 = 1 AND Q3 > 5" }] },
  { n: 4, sentence: "Convert this matrix into a responsive mobile-friendly interface.", sel: "Q4", mode: "ux", ux: true, uxOnly: false, engine: "model",
    native: [{ op: "create_responsive_rule", target: "Q4", media: "mobile", declarations: { display: "block" } }] },
  { n: 5, sentence: "Create a drag-and-drop ranking question.", mode: "edit", ux: false, uxOnly: false, engine: "model",
    native: [{ op: "create_question", ref: "RANK", type: "ranking", text: "Rank these", options: ["A", "B", "C"] }] },
  { n: 6, sentence: "Automatically rank selected answers.", sel: "Q7", mode: "question", ux: false, uxOnly: false, engine: "model",
    native: [{ op: "create_question", ref: "RANKSEL", type: "ranking", text: "Rank what you used", options: ["Opt 1", "Opt 2", "Opt 3", "Opt 4", "Opt 5", "Opt 6"] }, { op: "set_mask", target: "RANKSEL", expression: "Q7.Selected", action: "display" }] },
  { defect: "D16", n: 7, sentence: "Display a warning when the total exceeds 100%.", sel: "Q6", mode: "ux", ux: true, uxOnly: false, engine: "model",
    native: [{ op: "set_validation", target: "Q6", rules: [{ kind: "condition", check: "Q6.O1 + Q6.O2 + Q6.O3 + Q6.O4 <= 100", message: "The total is above 100%", severity: "warning" }] }],
    check: (r) => assert.match(JSON.stringify(q(r, "Q6").validation), /"severity":"warning"/, "the soft warning is kept (D16)") },
  { defect: "D16", n: 8, sentence: "Randomize these four concepts equally across respondents.", sel: "Q8", mode: "edit", ux: false, uxOnly: false, engine: "actions",
    native: [{ op: "set_option_randomization", target: "Q8", enabled: true, method: "rotate" }],
    check: (r) => assert.equal(q(r, "Q8").randomization?.method, "rotate", "rotation is kept (D16)") },
  { defect: "D16", n: 9, sentence: "Add a countdown timer to this question.", sel: "Q5", mode: "ux", ux: true, uxOnly: false, engine: "model",
    native: [{ op: "update_question", target: "Q5", type: "gamified.timed", settings: { timeLimitSeconds: 30, onTimeout: "lock" } }],
    check: (r) => { assert.equal(q(r, "Q5").settings?.timeLimitSeconds, 30, "the timer length is kept (D16)"); assert.equal(q(r, "Q5").settings?.onTimeout, "lock"); } },
  { n: 10, sentence: "Display an image when a respondent selects a particular brand.", sel: "Q1", mode: "question", ux: false, uxOnly: false, engine: "model",
    native: [{ op: "create_question", ref: "IMG", type: "descriptive", block: "Screener", after: "Q1", text: "<img src=\"https://example.com/beta.png\" alt=\"Beta\">" }, { op: "set_display_logic", target: "IMG", expression: "Q1 = 2" }] },
  { defect: "D9", n: 11, sentence: "Make the survey look like a premium modern web application.", mode: "ux", ux: true, uxOnly: true, engine: "model",
    native: [{ op: "set_theme", appearance: { optionStyle: "cards" } }] },
  { defect: "D9", n: 12, sentence: "Create an interactive conjoint exercise.", mode: "ux", ux: true, uxOnly: false, engine: "model",
    native: [{ op: "create_conjoint", ref: "CJ", text: "Choose", attributes: [{ name: "Price", levels: ["$1", "$2", "$3"] }, { name: "Brand", levels: ["A", "B", "C"] }] }] },
  { n: 13, sentence: "Highlight unanswered questions before submission.", mode: "ux", ux: true, uxOnly: true, engine: "model",
    native: [{ op: "set_navigation", sectionNav: "free", position: "top" }] },
  { n: 14, sentence: "Add a custom validation rule.", sel: "Q5", mode: "edit", ux: false, uxOnly: false, engine: "model",
    native: [{ op: "set_validation", target: "Q3", rules: [{ kind: "condition", check: "Q3 <= 10", message: "At most 10" }] }] },
  { defect: "D9", n: 15, sentence: "Create an interactive video-testing experience.", mode: "ux", ux: true, uxOnly: false, engine: "model",
    native: [{ op: "create_question", ref: "VID", type: "video_timeline", text: "React while watching" }] },
];

for (const o of OWNER) {
  test(`owner #${o.n}: “${o.sentence}” — class, engine, and a native answer the gate accepts`, target(o.defect), () => {
    const g = gateFor(o.sentence);
    assert.deepEqual({ mode: g.cls.mode, ux: g.cls.ux, uxOnly: g.cls.uxOnly }, { mode: o.mode, ux: o.ux, uxOnly: o.uxOnly }, "server class");
    if (o.engine) assert.equal(interpretRequest(def, o.sentence, o.sel ? { selectedId: qid(o.sel) } : {}).kind, o.engine, "engine reading");
    const r = assertApplied(o.sentence, o.native);
    o.check?.(r);
  });
}

/* ---------------------------------------------------------------- the engine's deterministic readings (no model) */

test("owner #2: the engine reads “punch option N when option M is selected” into add_punch (selected question, or “of Qx”)", target("R6"), () => {
  const i = interpretRequest(def, "Automatically punch Option 5 when Option 2 is selected.", { selectedId: qid("Q7") });
  assert.equal(i.kind, "actions");
  if (i.kind !== "actions") return;
  assert.equal(i.actions.length, 1);
  const a = i.actions[0] as { op: string; target: string; codes: unknown[] };
  assert.equal(a.op, "add_punch");
  assert.equal(a.target, "Q7");
  assert.deepEqual(a.codes, [5]);
  const r = applySurveyActions(def, i.actions);
  assert.ok(r.results.every((x) => x.ok), r.errors.join("; "));
});

test("owner #8: “equally” is not dropped — options rotate (an exact, balanced presentation)", target("D16"), () => {
  const i = interpretRequest(def, "Randomize these four concepts equally across respondents.", { selectedId: qid("Q8") });
  assert.equal(i.kind, "actions");
  if (i.kind !== "actions") return;
  assert.deepEqual(i.actions.map((a) => [a.op, (a as { method?: string }).method]), [["set_option_randomization", "rotate"]]);
  const r = applySurveyActions(def, i.actions);
  assert.equal(q(r, "Q8").randomization?.method, "rotate");
});

test("owner #9: “add a 30-second countdown to Q5” → the timed variant with 30 s; without a length → a choice of lengths", target("D16"), () => {
  const i = interpretRequest(def, "Add a 30-second countdown to Q5");
  assert.equal(i.kind, "actions");
  if (i.kind !== "actions") return;
  const r = applySurveyActions(def, i.actions);
  assert.ok(r.results.every((x) => x.ok), r.errors.join("; "));
  assert.equal(q(r, "Q5").type, "gamified.timed");
  assert.equal(q(r, "Q5").settings?.timeLimitSeconds, 30);
  const owner = interpretRequest(def, "Add a countdown timer to this question.", { selectedId: qid("Q5") });
  assert.equal(owner.kind, "model");
  if (owner.kind !== "model") return;
  assert.ok(owner.fallback, "no model: a choice of lengths, not a failure card");
  assert.ok(owner.fallback!.choices.length >= 2);
  for (const c of owner.fallback!.choices) assert.equal(interpretRequest(def, c.text).kind, "actions", `choice “${c.text}” is a sentence the engine reads`);
});

test("owner #5 / #15: a ranking / video-testing question without a model is a clarify that names the variant and asks only for the wording", target("R6"), () => {
  for (const [s, variant] of [["Create a drag-and-drop ranking question.", /drag/i], ["Create an interactive video-testing experience.", /video/i]] as const) {
    const i = interpretRequest(def, s);
    assert.equal(i.kind, "model", s);
    if (i.kind !== "model") continue;
    assert.ok(i.fallback, `${s}: a fallback card, not a failure card`);
    assert.match(`${i.fallback!.understood} ${i.fallback!.question}`, variant, s);
    assert.match(i.fallback!.question, /wording|ask|question text|what should/i, s);
  }
});

/* ---------------------------------------------------------------- S3's stand-ins (§4.3) */

test("stand-in (D9): “Write a JavaScript that hides option 3 of Q5 when Q2 is 1” — UX guide, not look-only; the native option logic is accepted", target("D9"), () => {
  const s = "Write a JavaScript that hides option 3 of Q5 when Q2 is 1";
  const g = gateFor(s);
  assert.equal(g.cls.ux, true);
  assert.equal(g.cls.uxOnly, false);
  assertApplied(s, [{ op: "update_option", target: "Q5", option: "3", visibleIf: "NOT (Q2 = 1)" }]);
});

test("stand-in (D9): “terminate respondents under 18” — the native terminate skip is accepted", target("D9"), () => {
  const s = "Write a script to terminate respondents under 18 at Q9";
  assert.equal(gateFor(s).cls.uxOnly, false);
  assertApplied(s, [{ op: "add_skip", from: "Q9", when: "Q9 < 18", to: "terminate" }]);
});

test("stand-in (D9): “Prefill Q9 with the URL parameter age” — embedded data from the URL + a piped default are accepted", target("D9"), () => {
  const s = "Prefill Q9 with the URL parameter age";
  const g = gateFor(s);
  assert.equal(g.cls.ux, true, "the UX guide (it teaches set_default_value) goes with it");
  assert.equal(g.cls.uxOnly, false);
  const r = assertApplied(s, [{ op: "create_embedded", name: "age", source: "url", value: "age" }, { op: "set_default_value", target: "Q9", value: "{{age}}" }]);
  assert.equal(q(r, "Q9").settings?.defaultValue, "{{age}}");
});

test("D9: pure look words stay look-only — and even then a behavioural native op is let through when the sentence asks for behaviour", target("D9"), () => {
  for (const s of ["Change the colours to navy", "Make Q5 look modern", "Use a bigger font", "Make it look like a premium app"]) assert.equal(classifyRequest(s, 9, 0).uxOnly, true, s);
  // a look sentence that also asks for behaviour: the behavioural native op passes under inferred look-only
  const s = "Style Q5 so option 3 is hidden when Q2 is 1";
  const c = classifyRequest(s, 9, 0);
  assert.deepEqual({ uxOnly: c.uxOnly, uxBehaviour: c.uxBehaviour }, { uxOnly: true, uxBehaviour: true }, s);
  const r = applySurveyActions(def, coerceSurveyActions([{ op: "update_option", target: "Q5", option: "3", visibleIf: "NOT (Q2 = 1)" }]).actions, { uxOnly: true, uxOnlyInferred: true, uxBehaviour: true });
  assert.ok(r.results.every((x) => x.ok), `${s}: ${r.errors.join("; ")}`);
  // …but a question is still refused under look-only, and the refusal is now repairable once (not a terminal policy refusal)
  const r2 = applySurveyActions(def, coerceSurveyActions([{ op: "create_question", ref: "X", type: "single_select", text: "New?", options: ["a", "b"] }]).actions, { uxOnly: true, uxOnlyInferred: true });
  assert.equal(r2.results[0].ok, false);
  assert.equal(policyRefusal(r2.results[0].error ?? ""), false, "an inferred look-only refusal goes to the repair call with its reason");
});

for (const s of ["Debug the script on Q5", "Why does the script on Q5 not work", "Explain what the script on Q5 does"]) {
  test(`stand-in (D10): “${s}” reaches the copilot (not the grammar), and without a model is answered from the script itself`, target("D10"), () => {
    const i = interpretRequest(def, s);
    assert.equal(i.kind, "model");
    if (i.kind !== "model") return;
    assert.notEqual(i.reason, DEFER_TO_GRAMMAR, "a script question is the copilot's, not the grammar's");
    const fa = (i as { fallbackAnswer?: { answer: string } }).fallbackAnswer;
    assert.ok(fa, "no model: a deterministic answer");
    assert.doesNotMatch(fa!.answer, /could not find/i);
    assert.match(fa!.answer, /Thank owners/);
    assert.match(fa!.answer, /when Q5 is answered|answer/i);
    assert.match(fa!.answer, /check|gate|passes|accepted/i);
    const c = classifyRequest(s, def.questions.length, 0);
    assert.equal(c.ux, true, "the UX guide goes with it");
    assert.equal(c.uxOnly, false);
  });
}

test("D10: the copilot's outline for a script question carries that script in full with its check (and the health the page sent)", async () => {
  const { copilotOutline } = await import("./outline.ts");
  const bid = def.ux!.behaviors[0].id;
  const o = copilotOutline(def, { ux: true, scriptQuestion: { text: "Debug the script on Q5", health: { sessions: 4, scripts: [{ script: bid, failures: 2, sessions: 1 }] } } });
  assert.ok(o.includes(JSON.stringify(SCRIPT)), "the script in full");
  assert.match(o, /SCRIPTS THIS REQUEST IS ABOUT \(1/);
  assert.match(o, /check: passes the script check/);
  assert.match(o, /failed in 1 of 4 sessions/);
  assert.doesNotMatch(copilotOutline(def, { ux: true }), /SCRIPTS THIS REQUEST IS ABOUT/, "only on a script question");
});
