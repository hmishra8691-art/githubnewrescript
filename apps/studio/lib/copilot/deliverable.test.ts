import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type SurveyDefinition as Def } from "@rescript/schema";
import { localizeDefinition, registerBuiltinQuestionTypes, type ExecStep, type ExecTask } from "@rescript/engine";
import {
  checkDeliverable, examKeyLeaks, examReportLines, executionView, itemRangeOf, nextStatusFor,
  resumePoint, scoreExam, specFromRequest, stepOutcomeProblems,
  type ExamAnswerKey,
} from "./deliverable.ts";

registerBuiltinQuestionTypes();

/* ------------------------------------------------------------ fixtures */

const mcq = (n: number, topic: string) => ({
  id: `q${n}`, code: `Q${n}`, variableName: `Q${n}`, type: "single_select",
  text: `Question ${n} (${topic})`,
  options: [{ code: "1", label: "A" }, { code: "2", label: "B" }, { code: "3", label: "C" }, { code: "4", label: "D" }],
});

const TOPICS = ["Polity", "History", "Geography", "Economy"];

/** an exam with `n` questions, every one on a page, and nothing else */
function exam(n: number): Def {
  const questions = Array.from({ length: n }, (_, i) => mcq(i + 1, TOPICS[i % TOPICS.length]));
  return SurveyDefinition.parse({
    meta: { id: "upsc", code: "UPSC", title: "UPSC prelims mock", version: "1.0" },
    questions,
    flow: [{ type: "page", id: "p1", questionIds: questions.map((q) => q.id) }, { type: "end", id: "e", status: "complete" }],
  });
}

/** the key, held where the scoring engine reads it and NOWHERE in the definition */
function keyFor(n: number): ExamAnswerKey {
  return {
    surveyId: "upsc",
    rule: { correct: 2, incorrect: -0.66, skipped: 0 },
    items: Array.from({ length: n }, (_, i) => ({
      questionId: `q${i + 1}`,
      correct: String((i % 4) + 1),
      topic: TOPICS[i % TOPICS.length],
    })),
  };
}

const EXAM_SPEC = (count: number) => ({
  kind: "scored_exam" as const,
  questionCount: count,
  keyCoverage: count,
  scoring: { correct: 2, incorrect: -0.66, skipped: 0 },
});

const step = (over: Partial<ExecStep> & Pick<ExecStep, "stepId">): ExecStep => ({
  taskId: "t1", planVersion: 1, dependsOn: [], status: "pending", retryCount: 0,
  idempotencyKey: `k:${over.stepId}`, ...over,
});

const task = (steps: ExecStep[], over: Partial<ExecTask> = {}): ExecTask => ({
  id: "t1", surveyId: "s1", kind: "survey_build", request: "build it", status: "running",
  planVersion: 1, deliverable: { kind: "survey_build" }, steps, ...over,
});

/* ============================================ THE UPSC ACCEPTANCE SCENARIO */

test("a 100-question exam that stopped at 64 is INCOMPLETE, names what is missing, and resumes at 65 — not failed, not restarted", () => {
  const def = exam(64);
  const key = keyFor(64);
  const report = checkDeliverable(EXAM_SPEC(100), def, { examKey: key });

  assert.equal(report.ok, false, "64 of 100 is not done");
  assert.equal(report.measured!.questions, 64);
  assert.equal(report.measured!.required, 100);
  assert.equal(report.measured!.missing, 36);
  assert.equal(report.measured!.resumeAt, 65, "the next slice starts at question 65");
  assert.ok(report.problems.some((p) => /64 of 100 questions built/.test(p) && /resuming at question 65/.test(p)), report.problems.join(" | "));
  assert.ok(report.problems.some((p) => /answer key covers 64 of 100/.test(p)), report.problems.join(" | "));

  const r = resumePoint(report)!;
  assert.deepEqual({ unit: r.unit, at: r.at, remaining: r.remaining }, { unit: "question", at: 65, remaining: 36 });

  /* INCOMPLETE IS NOT FAILED: every step that ran is completed, so the task stays running */
  const t = task([step({ stepId: "a", status: "completed" }), step({ stepId: "b", status: "completed" })], { kind: "scored_exam" });
  assert.equal(nextStatusFor(t, report), "running", "a short deliverable keeps the task running, so 1–64 stand");

  /* and a terminal step failure — and only that — makes it failed */
  const broken = task([step({ stepId: "a", status: "failed", failureKind: "auth", failureMessage: "the provider key was rejected" })], { kind: "scored_exam" });
  assert.equal(nextStatusFor(broken, report), "failed");
  const transient = task([step({ stepId: "a", status: "failed", failureKind: "transient", failureMessage: "overloaded" })], { kind: "scored_exam" });
  assert.equal(nextStatusFor(transient, report), "running", "a retryable failure is not a failed task");
});

test("the completed exam passes only when the key covers every question, the codes exist and the scoring rule is stated", () => {
  const def = exam(100);
  assert.equal(checkDeliverable(EXAM_SPEC(100), def, { examKey: keyFor(100) }).ok, true, JSON.stringify(checkDeliverable(EXAM_SPEC(100), def, { examKey: keyFor(100) }).problems));

  /* no key at all */
  const noKey = checkDeliverable(EXAM_SPEC(100), def, {});
  assert.ok(noKey.problems.some((p) => /No answer key was supplied/.test(p)));

  /* a key that marks an option the question does not offer, and one that names a question that is not there */
  const bad = keyFor(100);
  bad.items[3] = { ...bad.items[3], correct: "9" };
  bad.items[7] = { ...bad.items[7], questionId: "q999" };
  const r = checkDeliverable(EXAM_SPEC(100), def, { examKey: bad });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /name a question this survey does not have/.test(p)), r.problems.join(" | "));
  assert.ok(r.problems.some((p) => /mark an option code the question does not offer/.test(p)), r.problems.join(" | "));

  /* no scoring rule stated */
  const noRule = checkDeliverable({ kind: "scored_exam", questionCount: 100, keyCoverage: 100 }, def, { examKey: keyFor(100) });
  assert.ok(noRule.problems.some((p) => /No scoring rule in the spec/.test(p)));
});

test("the definition a respondent is served carries no answer key — inspected key by key", () => {
  const def = exam(100);
  const key = keyFor(100);

  /*
   * What the runtime serves: `getCachedVersionDefinition` parses the stored
   * JSON and hands it back verbatim (packages/quality/src/server.ts:263,
   * apps/runtime/app/api/runtime-definition/[versionId]/route.ts), and the
   * Runner localises that same object in the browser (Runner.tsx:592). So the
   * served document is exactly this round trip.
   */
  const served = SurveyDefinition.parse(JSON.parse(JSON.stringify(def)));
  const inBrowser = localizeDefinition(served, "en");

  const KEY_WORDS = /correct|answer_?key|marking|is_?correct|scoring_?key/i;
  const walk = (v: unknown, path: string, hits: string[]) => {
    if (!v || typeof v !== "object") return hits;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, hits)); return hits; }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (KEY_WORDS.test(k)) hits.push(`${path}.${k}`);
      walk(child, `${path}.${k}`, hits);
    }
    return hits;
  };
  assert.deepEqual(walk(served, "served", []), [], "no key-shaped property anywhere in the served definition");
  assert.deepEqual(walk(inBrowser, "runner", []), [], "nor in what the Runner localises");

  /* and the key's own answers are not recoverable from the served text */
  const text = JSON.stringify(served);
  assert.ok(!/"correct"/.test(text) && !/answerKey/i.test(text), "the served JSON names no answer");
  assert.equal(examKeyLeaks(served).length, 0);
  assert.equal(key.items.length, 100, "the key exists — beside the definition, not inside it");

  /* the gate catches a key smuggled into the definition, wherever it is put */
  const leaky = SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), meta_extensions: { answer_key: { q1: "2" } } });
  assert.equal(examKeyLeaks(leaky).length, 1);
  assert.ok(checkDeliverable(EXAM_SPEC(100), leaky, { examKey: key }).problems.some((p) => /carries an answer key/.test(p)));

  /* a key stuffed into a question's settings: the Question schema drops the unknown field, so it never
     reaches a respondent — and the gate still names it in the raw object a buggy writer would have stored */
  const inSettings = JSON.parse(JSON.stringify(def));
  inSettings.questions[0].settings = { ...(inSettings.questions[0].settings ?? {}), correct: "2" };
  assert.ok(examKeyLeaks(inSettings as never).some((m) => /questions\[0\].settings.correct/.test(m)), examKeyLeaks(inSettings as never).join(" | "));
  assert.equal(examKeyLeaks(SurveyDefinition.parse(inSettings)).length, 0, "the schema itself refuses to carry it");

  const inScript = SurveyDefinition.parse({
    ...JSON.parse(JSON.stringify(def)),
    scripts: [{ id: "s1", name: "marker", scope: "survey", event: "on_load", code: "const answerKey = {q1:'2'};" }],
  });
  assert.ok(examKeyLeaks(inScript).some((m) => /mentions an answer key in its source/.test(m)), examKeyLeaks(inScript).join(" | "));
});

test("scoring is computed in application code from the saved answers, with negative marking, per topic and weak areas", () => {
  const def = exam(8);
  const key: ExamAnswerKey = {
    surveyId: "upsc",
    rule: { correct: 2, incorrect: -0.5, skipped: 0 },
    items: [
      { questionId: "q1", correct: "1", topic: "Polity" },
      { questionId: "q2", correct: "2", topic: "Polity" },
      { questionId: "q3", correct: "3", topic: "History" },
      { questionId: "q4", correct: "4", topic: "History" },
      { questionId: "q5", correct: "1", topic: "Geography" },
      { questionId: "q6", correct: "2", topic: "Geography" },
      { questionId: "q7", correct: "3", topic: "Economy" },
      { questionId: "q8", correct: "4", topic: "Economy" },
    ],
  };
  const answers = {
    q1: "1", q2: "2",            // Polity: 2 right        → 4 of 4
    q3: "1", q4: "4",            // History: 1 wrong 1 right → 1.5 of 4
    q5: "", q6: [],              // Geography: both blank  → 0 of 4
    q7: "1", q8: "1",            // Economy: both wrong    → -1 of 4
  };
  const r = scoreExam(key, answers, { def });
  assert.deepEqual({ correct: r.correct, incorrect: r.incorrect, skipped: r.skipped }, { correct: 3, incorrect: 3, skipped: 2 });
  assert.equal(r.max, 16);
  assert.equal(r.score, 2 * 3 + -0.5 * 3);
  assert.deepEqual(r.byTopic.map((t) => [t.topic, t.score]), [["Economy", -1], ["Geography", 0], ["History", 1.5], ["Polity", 4]]);
  assert.deepEqual(r.weakAreas, ["Economy", "Geography", "History"], "weakest first, Polity is not weak");
  assert.ok(examReportLines(r)[0].includes("3 right, 3 wrong, 2 not attempted of 8"));

  /* a key item for a question the survey does not have is never silently scored */
  const stray = scoreExam({ ...key, items: [...key.items, { questionId: "q404", correct: "1" }] }, answers, { def });
  assert.deepEqual(stray.unscored, ["q404"]);
  assert.equal(stray.max, r.max, "the stray item adds no marks");
});

/* ============================================ THE SURVEY-BUILD BATTERY */

test("the build battery runs the existing validators: ids, logic, structure, quotas, variables, embedded data", () => {
  const def = exam(3);
  assert.equal(checkDeliverable({ kind: "survey_build", questionCount: 3 }, def).ok, true);

  /* a logic reference that does not resolve */
  const broken = JSON.parse(JSON.stringify(def));
  broken.questions[2].displayLogic = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q99" }, operator: "eq", value: "1" }] };
  const r = checkDeliverable({ kind: "survey_build", questionCount: 3 }, SurveyDefinition.parse(broken));
  assert.equal(r.ok, false);
  assert.ok(Number(r.measured!.invariantFailures) > 0);

  /* a quota whose percentages have no total to be a percentage of */
  const q = JSON.parse(JSON.stringify(def));
  q.quotas = [{ id: "qa", name: "Region", mode: "hard", cells: [{ id: "c1", label: "North", limit: 50, limitType: "percent", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "1" } }] }];
  const rq = checkDeliverable({ kind: "survey_build" }, SurveyDefinition.parse(q));
  assert.ok(rq.problems.some((p) => /percentage limits but has no total sample size/.test(p)), rq.problems.join(" | "));

  /* a randomisation target that cannot be met */
  const rand = JSON.parse(JSON.stringify(def));
  rand.questions[0].randomization = { options: "shuffle", pick: 0 };
  const rr = checkDeliverable({ kind: "survey_build" }, SurveyDefinition.parse(rand));
  assert.ok(rr.problems.some((p) => /show only/.test(p) && /whole number of at least 1/.test(p)), rr.problems.join(" | "));

  /* import / runtime schema validity: a definition that would not parse is not a deliverable */
  const notASurvey = { ...JSON.parse(JSON.stringify(def)), questions: [{ id: "x" }] } as never;
  const rs = checkDeliverable({ kind: "survey_build", invariants: ["schema_valid"] }, notASurvey);
  assert.equal(rs.ok, false);
  assert.ok(rs.problems.some((p) => /^questions\.0\./.test(p)), rs.problems.join(" | "));

  /* an invariant name nobody implements is reported, never silently skipped */
  assert.ok(checkDeliverable({ kind: "other", invariants: ["no_such_rule"] }, def).problems.some((p) => /Unknown invariant/.test(p)));
});

test("an analysis task is gated on the analytics plan checker, not on a count", () => {
  const def = exam(3);
  const ok = checkDeliverable({ kind: "analysis" }, def, {
    analysisItems: [{ kind: "crosstab", crosstab: { rows: ["Q1"], columns: ["Q2"] } }],
    analysisVariables: [{ name: "Q1" }, { name: "Q2" }] as never,
  });
  assert.equal(ok.measured!.analysisItems, 1);
  const bad = checkDeliverable({ kind: "analysis" }, def, {
    analysisItems: [{ kind: "crosstab", crosstab: { rows: [], columns: [] } }],
    analysisVariables: [] as never,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.measured!.analysisNotReady, 1);
});

test("B20 (23/10/2026): two variable names that differ only in case are a deliverable failure", () => {
  const base = JSON.parse(JSON.stringify(exam(2)));
  base.questions[1].code = "Q1a";
  base.questions[1].variableName = "Q1a";
  const ok = checkDeliverable({ kind: "survey_build", questionCount: 2 }, SurveyDefinition.parse(base));
  assert.equal(ok.ok, true, ok.problems.join(" | "));

  base.questions[1].variableName = "Q1A";
  base.questions[1].code = "Q1A";
  const clash = JSON.parse(JSON.stringify(base));
  clash.questions[0].variableName = "Q1a";
  clash.questions[0].code = "Q1a";
  const r = checkDeliverable({ kind: "survey_build", questionCount: 2 }, SurveyDefinition.parse(clash));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /differ only in case/.test(p) && /B20/.test(p)), r.problems.join(" | "));
});

/* ============================================ CONJOINT AND MAXDIFF */

const conjointSurvey = (rows: Record<string, unknown>[], designId: string | null) => SurveyDefinition.parse({
  meta: { id: "cj", code: "CJ", title: "Conjoint", version: "1.0" },
  questions: [{
    id: "c1", code: "C1", variableName: "C1", type: "conjoint_task", text: "Which would you choose?",
    settings: designId ? { designRef: designId } : {},
  }],
  designs: designId ? [{ id: designId, kind: "conjoint", name: "CBC", version: 1, config: {}, file: { format: "json", columns: ["version", "task", "alt", "brand"], rows } }] : [],
  flow: [{ type: "page", id: "p1", questionIds: ["c1"] }, { type: "end", id: "e", status: "complete" }],
});

const maxdiffSurvey = (rows: Record<string, unknown>[], designId: string | null, kind = "maxdiff") => SurveyDefinition.parse({
  meta: { id: "md", code: "MD", title: "MaxDiff", version: "1.0" },
  questions: [{
    id: "m1", code: "M1", variableName: "M1", type: "maxdiff_task", text: "Best and worst?",
    settings: designId ? { designRef: designId } : {},
  }],
  designs: designId ? [{ id: designId, kind, name: "MD", version: 1, config: {}, file: { format: "json", columns: ["version", "task", "position", "item_label"], rows } }] : [],
  flow: [{ type: "page", id: "p1", questionIds: ["m1"] }, { type: "end", id: "e", status: "complete" }],
});

test("conjoint completion is the design-structure validator, not a question count", () => {
  const rows = [{ version: 1, task: 1, alt: 1, brand: "A" }, { version: 1, task: 1, alt: 2, brand: "B" }];
  const good = checkDeliverable({ kind: "conjoint" }, conjointSurvey(rows, "d1"));
  assert.equal(good.ok, true, good.problems.join(" | "));
  assert.equal(good.measured!.methods, "cbc");
  assert.equal(good.measured!.designsReady, 1);

  /* ONE conjoint question is still one question — a count would call this done. The design says otherwise. */
  const noRows = checkDeliverable({ kind: "conjoint" }, conjointSurvey([], "d1"));
  assert.equal(noRows.ok, false);
  assert.ok(noRows.problems.some((p) => /has no rows/.test(p)), noRows.problems.join(" | "));
  assert.equal(noRows.measured!.conjointQuestions, 1, "the count is 1 either way — it is not what decides");

  const noDesign = checkDeliverable({ kind: "conjoint" }, conjointSurvey([], null));
  assert.equal(noDesign.ok, false);
  assert.ok(noDesign.problems.some((p) => /no design is selected/.test(p) || /has no design/.test(p)), noDesign.problems.join(" | "));
});

test("MaxDiff completion is the design-structure validator too — a design reference that resolves, and rows to render", () => {
  const rows = [{ version: 1, task: 1, position: 1, item_label: "Battery" }, { version: 1, task: 1, position: 2, item_label: "Camera" }];
  const good = checkDeliverable({ kind: "maxdiff" }, maxdiffSurvey(rows, "d1"));
  assert.equal(good.ok, true, good.problems.join(" | "));
  assert.equal(good.measured!.designsWithRows, 1);

  const empty = checkDeliverable({ kind: "maxdiff" }, maxdiffSurvey([], "d1"));
  assert.equal(empty.ok, false);
  assert.ok(empty.problems.some((p) => /has no rows/.test(p)), empty.problems.join(" | "));

  const dangling = SurveyDefinition.parse({
    ...JSON.parse(JSON.stringify(maxdiffSurvey(rows, "d1"))),
    designs: [],
  });
  const r = checkDeliverable({ kind: "maxdiff" }, dangling);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /not in this survey/.test(p)), r.problems.join(" | "));
});

/* ============================================ THE SPEC, READ FROM A REQUEST */

test("a spec is read off the request, conservatively", () => {
  const upsc = specFromRequest("Build a UPSC prelims mock: 100 MCQs with an answer key, 2 marks for each correct answer and negative marking of 0.66 for each wrong one");
  assert.equal(upsc.kind, "scored_exam");
  assert.equal(upsc.questionCount, 100);
  assert.equal(upsc.keyCoverage, 100);
  assert.deepEqual(upsc.scoring, { correct: 2, incorrect: -0.66, skipped: 0 });

  assert.equal(specFromRequest("Translate the whole survey into Hindi").kind, "translation");
  assert.equal(specFromRequest("Translate the whole survey into Hindi").language, "hi");
  assert.equal(specFromRequest("Set up a CBC conjoint for the pricing study").kind, "conjoint");
  assert.equal(specFromRequest("Run a MaxDiff on the twelve claims").kind, "maxdiff");
  assert.equal(specFromRequest("Add a screener and five brand questions").kind, "survey_build");
  assert.equal(specFromRequest("Add a screener and five brand questions").questionCount, undefined, "'five brand questions' in words is not a promise of a count");
  assert.equal(specFromRequest("Write 20 questions about shopping habits").questionCount, 20);
  /* the caller's hint always wins */
  assert.equal(specFromRequest("anything", { kind: "analysis" }).kind, "analysis");
  assert.equal(specFromRequest("Write 20 questions", { questionCount: 12 }).questionCount, 12);
});

/* ============================================ THE PANEL'S NUMBERS */

test("every number the panel shows comes from a step row", () => {
  const steps = [
    step({ stepId: "s1", title: "Questions 1–20", status: "completed", batchSize: 20, batchSizeUsed: 20, startedAt: 1_000, finishedAt: 5_000, usage: { tokensIn: 100, tokensOut: 50, charge: 2 }, validation: { status: "valid" } }),
    step({ stepId: "s2", title: "Questions 21–40", status: "completed", batchSize: 20, startedAt: 6_000, finishedAt: 10_000, usage: { tokensIn: 120, tokensOut: 60, tokensCached: 40, charge: 2 }, validation: { status: "valid" } }),
    step({ stepId: "s3", title: "Questions 41–60", status: "running", batchSize: 20, inputRef: "questions 41-60" }),
    step({ stepId: "s4", title: "Questions 61–80", status: "pending", batchSize: 20 }),
  ];
  const v = executionView(task(steps));
  assert.equal(v.rows.length, 4, "one row per step, and nothing else");
  assert.deepEqual([v.total, v.completed, v.remaining, v.failed, v.running], [4, 2, 2, 0, 1]);
  assert.equal(v.phase, "building");
  assert.equal(v.currentStep!.stepId, "s3");
  assert.deepEqual(v.itemRange, { from: 41, to: 60 });
  assert.deepEqual(v.spend, { tokensIn: 220, tokensOut: 110, tokensCached: 40, charge: 4, real: true });
  assert.equal(v.estimate.known, true, "two finished steps is enough to say something");
  assert.equal(v.estimate.seconds, 8, "4s a step × 2 left");
  assert.equal(v.rows[0].seconds, 4);
  assert.deepEqual(itemRangeOf({ inputRef: "keys 41–80" }), { from: 41, to: 80 });
  assert.equal(itemRangeOf({ inputRef: "the brief" }), null);
  /* the client's redacted step has no inputRef — the title carries the range instead */
  assert.deepEqual(itemRangeOf({ title: "Translate keys 41–80" }), { from: 41, to: 80 });
  const redacted = executionView({ status: "running", steps: [{ stepId: "s1", status: "running", retryCount: 0, title: "Questions 41–60", batchSize: 20 }] });
  assert.deepEqual(redacted.itemRange, { from: 41, to: 60 }, "a step with no inputRef still shows its range");
  assert.equal(redacted.spend.real, false);
});

test("no estimate where one is not defensible, and no spend claimed where the usage is not real", () => {
  const none = executionView(task([]));
  assert.equal(none.phase, "planning");
  assert.equal(none.estimate.known, false);
  assert.match(none.estimate.text, /No steps yet/);

  const one = executionView(task([
    step({ stepId: "a", status: "completed", startedAt: 0, finishedAt: 3_000 }),
    step({ stepId: "b", status: "pending" }),
  ]));
  assert.equal(one.estimate.known, false, "one timing is an anecdote, not a rate");
  assert.match(one.estimate.text, /No time estimate until two steps have finished/);
  assert.equal(one.spend.real, false, "no usage row, so nothing is claimed about spend");
  assert.deepEqual([one.spend.tokensIn, one.spend.charge], [0, 0]);
});

test("a failed batch shows recovering or needs attention — never success", () => {
  const retrying = executionView(task([
    step({ stepId: "a", status: "completed" }),
    step({ stepId: "b", status: "failed", failureKind: "rate_limited", failureMessage: "the provider asked us to slow down", retryCount: 1 }),
    step({ stepId: "c", status: "pending" }),
  ]));
  assert.equal(retrying.phase, "recovering");
  assert.notEqual(retrying.phase, "done");
  assert.match(retrying.recovery.message!, /slow down/);
  assert.equal(retrying.recovery.attention, false);

  const stuck = executionView(task([
    step({ stepId: "a", status: "completed" }),
    step({ stepId: "b", status: "failed", failureKind: "auth", failureMessage: "the provider key was rejected" }),
  ]));
  assert.equal(stuck.phase, "needs attention");
  assert.equal(stuck.recovery.attention, true);
  assert.equal(stuck.estimate.known, false);
  assert.match(stuck.estimate.text, /no estimate while a step needs attention/);
  assert.match(stuck.headline, /cannot continue/);

  /* a completed task with every step done and the deliverable passed is the only "done" */
  const done = executionView(task([step({ stepId: "a", status: "completed" })], { status: "completed", report: { ok: true, problems: [] } }));
  assert.equal(done.phase, "done");
});

test("the panel says so when the store is memory-only, and surfaces an invalid step's reasons", () => {
  const mem = executionView(task([step({ stepId: "a", status: "completed" })]), { durable: false });
  assert.equal(mem.durable, false);
  assert.match(mem.durabilityNote!, /memory only/);
  assert.equal(executionView(task([])).durabilityNote, null);

  const invalid = executionView(task([
    step({ stepId: "a", status: "completed", validation: { status: "invalid", errors: ["Q7 refers to Q99, which does not exist"] } }),
    step({ stepId: "b", status: "completed", validation: { status: "valid" } }),
  ]));
  assert.deepEqual(invalid.validation, { checked: 2, invalid: 1, problems: ["Q7 refers to Q99, which does not exist"] });
});

test("the panel shows WHY a task is not done, from the stored deliverable report", () => {
  const report = checkDeliverable(EXAM_SPEC(100), exam(64), { examKey: keyFor(64) });
  const v = executionView(task([step({ stepId: "a", status: "completed" })], { report, deliverable: EXAM_SPEC(100) }));
  assert.equal(v.phase, "validating");
  assert.match(v.headline, /64 of 100 questions built/);
  assert.equal(v.resume!.at, 65);
});

/* ============================================ ONE STEP'S OWN OUTPUT */

test("a step's own output is checked by the action layer's own validator", () => {
  const before = exam(3);
  const after = JSON.parse(JSON.stringify(before));
  after.questions[0].displayLogic = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: "1" }] };
  const r = stepOutcomeProblems(before, SurveyDefinition.parse(after), { op: "set_display_logic", question: "Q1" } as never, ["q1"]);
  assert.equal(r.status, "invalid", "Q1 cannot depend on Q3, which is asked later");
  assert.ok(r.errors.length > 0);

  const clean = stepOutcomeProblems(before, before, { op: "set_display_logic", question: "Q1" } as never, []);
  assert.deepEqual(clean, { status: "valid", errors: [] });
});
