import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { validateSurveyDeliverable, parseCompletionCriteria, designProblems, type DeliverableErrorKind } from "./deliverableValidation.js";
import { seededIds } from "./generationPlan.js";

/*
 * THE DELIVERABLE CHECK (K2, 2026-10-25): one deterministic verdict with STRUCTURED errors — each class is found,
 * named by question code, and routed to the repair that can fix it.
 */

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
function survey(): SurveyDefinition {
  const acts: SurveyAction[] = [
    { op: "create_block", title: "Screening" } as SurveyAction,
    { op: "create_question", code: "Q1", type: "single", text: "Do you use streaming services?", options: ["Yes", "No"] } as SurveyAction,
    { op: "create_question", code: "Q2", type: "single", text: "What is your gender?", options: ["Male", "Female"] } as SurveyAction,
    { op: "create_block", title: "Usage" } as SurveyAction,
    { op: "create_question", code: "Q3", type: "multi", text: "Which services do you use?", options: ["A", "B", "None"] } as SurveyAction,
    { op: "create_question", code: "Q4", type: "matrix", text: "Rate each service", rows: ["A", "B"], scale: { points: 5 } } as SurveyAction,
    { op: "create_block", title: "Profile" } as SurveyAction,
    { op: "create_question", code: "Q5", type: "numeric", text: "How old are you?" } as SurveyAction,
    { op: "set_display_logic", target: "Q4", expression: "(Q3 = 1 OR Q3 = 2) AND NOT Q1 = 2" } as SurveyAction,
    { op: "add_skip", from: "Q1", when: "Q1 = 2", to: "screen_out" } as SurveyAction,
    { op: "create_randomizer", blocks: ["Usage", "Profile"] } as SurveyAction,
    { op: "create_quota", name: "Gender", cells: [{ label: "M", when: "Q2 = 1", limit: 50 }, { label: "F", when: "Q2 = 2", limit: 50 }] } as SurveyAction,
  ];
  const r = applySurveyActions(empty(), acts, { ids: seededIds("v"), now: "2026-01-01T00:00:00.000Z" });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  return r.def;
}
const ALL = parseCompletionCriteria(["questions>=5", "codes:Q1..Q5", "unique_codes", "logic_refs", "quotas>=1", "randomizers>=1", "scripts_valid", "runtime_compatible", "no_duplicate_text"]);
const kinds = (def: unknown, c = ALL) => validateSurveyDeliverable(def, c).errors.map((e) => e.kind);
const has = (def: unknown, k: DeliverableErrorKind, c = ALL) => assert.ok(kinds(def, c).includes(k), `expected ${k}, got ${JSON.stringify(validateSurveyDeliverable(def, c).errors.slice(0, 6))}`);
const q = (d: SurveyDefinition, code: string) => d.questions.find((x) => x.code === code)!;

test("a complete, valid survey passes every check (logic, nested AND/OR, quota, randomizer, runtime)", () => {
  const r = validateSurveyDeliverable(survey(), ALL);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stats.respondentQuestions, 5); assert.equal(r.stats.quotas, 1); assert.equal(r.stats.randomizers, 1);
  assert.ok(r.stats.conditions >= 3);
});

test("count and planned codes", () => {
  has(survey(), "count", parseCompletionCriteria(["questions>=6"]));
  has(survey(), "count", parseCompletionCriteria(["questions=4"]));
  const r = validateSurveyDeliverable(survey(), parseCompletionCriteria(["codes:Q1..Q7"]));
  assert.deepEqual(r.errors.map((e) => [e.kind, e.code, e.repair]), [["missing_code", "Q6", "content"], ["missing_code", "Q7", "content"]]);
});

test("unique codes, variables and ids", () => {
  const a = survey(); q(a, "Q2").code = "Q1"; has(a, "duplicate_code");
  const b = survey(); q(b, "Q2").variableName = "Q1"; has(b, "duplicate_variable");
  const c = survey(); c.questions.push({ ...structuredClone(q(c, "Q5")), code: "Q9", variableName: "Q9" }); has(c, "duplicate_id");
});

test("required text and options, placement, duplicate wording", () => {
  const a = survey(); q(a, "Q3").text = ""; has(a, "missing_text");
  const b = survey(); q(b, "Q2").options = []; const e = validateSurveyDeliverable(b, ALL).errors.find((x) => x.kind === "missing_options")!; assert.equal(e.code, "Q2"); assert.equal(e.repair, "content");
  const c = survey(); q(c, "Q4").rows = []; has(c, "missing_options");
  const d = survey(); d.questions.push({ ...structuredClone(q(d, "Q5")), id: "q_lost", code: "Q8", variableName: "Q8", text: "Never placed anywhere?" }); has(d, "unplaced");
  const f = survey(); q(f, "Q3").text = q(f, "Q1").text; has(f, "duplicate_text");
});

test("logic references, nested AND/OR validity, piping", () => {
  const a = survey(); const dl = structuredClone(q(a, "Q4").displayLogic) as unknown as { children: { children?: { source: { ref: string } }[]; source?: { ref: string } }[] };
  const firstRule = (n: unknown): { source: { ref: string } } => { const x = n as { children?: unknown[]; source?: { ref: string } }; return x.source ? (x as { source: { ref: string } }) : firstRule(x.children![0]); };
  firstRule(dl).source.ref = "q_gone"; q(a, "Q4").displayLogic = dl as never;
  const e = validateSurveyDeliverable(a, ALL).errors.find((x) => x.code === "Q4")!; assert.ok(e, "the dangling reference is found on Q4"); assert.equal(e.repair, "logic");
  const b = survey(); q(b, "Q4").displayLogic = { type: "group", op: "and", children: [] } as never; has(b, "nested_condition");
  const c = survey(); q(c, "Q4").displayLogic = { type: "group", op: "not", children: [q(c, "Q4").displayLogic, q(c, "Q4").displayLogic] } as never; has(c, "nested_condition");
  const d = survey(); q(d, "Q5").text = "You said {{NOPE_VAR}} — how old are you?"; assert.ok(validateSurveyDeliverable(d, ALL).errors.some((x) => x.code === "Q5"), JSON.stringify(validateSurveyDeliverable(d, ALL).errors));
});

test("quotas and randomizers: present as asked, and valid", () => {
  const a = survey(); a.quotas = []; has(a, "quota");
  const b = survey();
  const rnd = (b.flow as { type: string; children?: unknown[] }[]).find((n) => n.type === "randomizer")!;
  rnd.children = rnd.children!.slice(0, 1);
  has(b, "randomization");
  const c = survey(); c.flow = (c.flow as unknown as { type: string; children?: unknown[] }[]).flatMap((n) => (n.type === "randomizer" ? n.children! : [n])) as never; has(c, "randomization");
});

test("calculations and embedded data", () => {
  const a = survey(); a.calculations = [{ id: "c1", targetVariable: "SCORE", expression: "NOPE_NAME + 1", dataType: "numeric", trigger: "on_change" }] as never; has(a, "calculation");
  const b = survey(); b.calculations = [{ id: "c1", targetVariable: "SRC", expression: "ed.campaign + 1", dataType: "numeric", trigger: "on_change" }] as never; assert.ok(kinds(b).some((k) => k === "embedded" || k === "calculation"));
});

test("scripts and schema", () => {
  const a = survey(); a.ux = { styles: [], animations: [], behaviors: [{ id: "b1", label: "Broken", target: { kind: "survey" }, effects: [] }] } as never; has(a, "script");
  has({ meta: {} }, "schema");
});

test("designs: a MaxDiff with too few items and no rows; a conjoint with no design; criteria ask for a method that is not there", () => {
  const a = survey();
  a.designs = [{ id: "d1", kind: "maxdiff", name: "MD", version: 1, config: { items: ["a", "b"], itemsPerTask: 2 }, file: { format: "json", columns: [], rows: [] } }] as never;
  a.questions.push({ ...structuredClone(q(a, "Q5")), id: "q_md", code: "MD1", variableName: "MD1", type: "maxdiff_task", variant: "maxdiff.best_worst", text: "Most and least important?", settings: { designRef: "d1" } } as never);
  const md = designProblems(a, q(a, "MD1"));
  assert.ok(md.some((x) => x.error && /at least 3 items/.test(x.message)) && md.some((x) => x.error && /no rows/.test(x.message)));
  const crit = parseCompletionCriteria(["design_valid:MD1", "design_valid:cbc"]);
  const errs = validateSurveyDeliverable(a, crit).errors;
  assert.ok(errs.some((e) => e.kind === "design" && e.code === "MD1" && e.repair === "design"));
  assert.ok(errs.some((e) => e.kind === "design" && /CBC/.test(e.message)), "no CBC question exists");
  const b = survey();
  b.questions.push({ ...structuredClone(q(b, "Q5")), id: "q_cj", code: "CJ1", variableName: "CJ1", type: "conjoint_task", variant: "conjoint.cbc", text: "Which would you choose?", settings: {} } as never);
  assert.ok(designProblems(b, q(b, "CJ1")).some((x) => x.error && /no design/.test(x.message)));
});

test("assessment: K4's validator is passed in and its errors are routed by question code; scope limits per-question checks", () => {
  const a = survey();
  const r = validateSurveyDeliverable(a, parseCompletionCriteria(["assessment:5"]), { assessment: () => ({ ok: false, errors: [{ questionCode: "Q3", message: "Q3 has no correct answer" }] }) });
  assert.deepEqual(r.errors.map((e) => [e.kind, e.code, e.repair]), [["assessment", "Q3", "content"]]);
  const b = survey(); q(b, "Q2").options = []; q(b, "Q3").options = [];
  const scoped = validateSurveyDeliverable(b, { scope: ["Q3"] });
  assert.deepEqual(scoped.errors.filter((e) => e.kind === "missing_options").map((e) => e.code), ["Q3"]);
});
