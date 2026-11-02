import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImport, runScenarios, verifyImport } from "./index.js";
import { walkSurvey, readByOthers } from "./verify.js";

/** I8 — behavioural equivalence: the source's own rules, run on the engine, met and not met */
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const load = (dir: string, f: string) => analyzeImport(new Uint8Array(readFileSync(join(CORPUS, dir, f))), f, { surveyId: "s", uid });

test("every rule of a Word questionnaire becomes a met and a not-met scenario, and the engine does what the document says", async () => {
  const a = await load("word", "02-complex-instructions.docx");
  const b = runScenarios(a.canonical!, a.result!);
  const ids = b.scenarios.map((s) => s.id).sort();
  assert.deepEqual(ids, ["display:Q2:met", "display:Q2:not", "skip:S1:0:met", "skip:S1:0:not", "skip:S2:0:met", "skip:S2:0:not"]);
  assert.equal(b.failed, 0, JSON.stringify(b.scenarios.filter((s) => s.result !== "pass"), null, 1));
  assert.equal(b.passed, 6);
  const term = b.scenarios.find((s) => s.id === "skip:S1:0:met")!;
  assert.deepEqual(term.given, ["S1 = No"]);
  assert.match(term.observed, /ended screened/);
  const skip = b.scenarios.find((s) => s.id === "skip:S2:0:met")!;
  assert.match(skip.observed, /Q4 shown; Q1 not shown/);
});

test("a deliberately broken import FAILS its scenarios — the check is not a rubber stamp", async () => {
  const a = await load("word", "02-complex-instructions.docx");
  const def = a.result!.def!;
  /* flip Q2's rule to the other answer and point S2's skip at the wrong question */
  const q2 = def.questions.find((q) => q.code === "Q2")! as unknown as { displayLogic: { value: unknown } };
  q2.displayLogic.value = 2;
  const s2 = def.questions.find((q) => q.code === "S2")! as unknown as { skipLogic?: { targetId?: string }[] };
  const b = runScenarios(a.canonical!, a.result!);
  assert.equal(b.scenarios.find((s) => s.id === "display:Q2:met")!.result, "fail");
  assert.equal(b.scenarios.find((s) => s.id === "display:Q2:not")!.result, "fail");
  assert.ok(s2, "S2 exists");
  /* a survey whose screener never ends the interview */
  const a2 = await load("word", "02-complex-instructions.docx");
  const s1 = a2.result!.def!.questions.find((q) => q.code === "S1")! as unknown as { skipLogic?: unknown[] };
  s1.skipLogic = [];
  const b2 = runScenarios(a2.canonical!, a2.result!);
  assert.equal(b2.scenarios.find((s) => s.id === "skip:S1:0:met")!.result, "fail");
});

test("QSF corpus: what cannot be driven is 'not testable' with its reason — never a pass; the rest passes", async () => {
  const a = await load("qsf", "02-screener-logic-quotas.qsf");
  const b = verifyImport(a.canonical!, a.result!).behaviour!;
  assert.equal(b.failed, 0, JSON.stringify(b.scenarios.filter((s) => s.result === "fail"), null, 1));
  assert.ok(b.passed >= 4, `passed ${b.passed}`);
  const why = b.scenarios.filter((s) => s.result === "not_testable").map((s) => s.observed);
  assert.ok(why.some((w) => /set by the survey's flow \(= 3\)/.test(w)), "ED.wave is fixed by the flow");
  assert.ok(why.some((w) => /QID99 is not in the imported survey/.test(w)), "a dangling reference is not testable");
  assert.ok(why.some((w) => /quota/.test(w)), "a quota condition is not testable");
  /* a count condition IS driven now: "aware: 2 answers chosen" */
  assert.ok(b.scenarios.some((s) => s.result === "pass" && s.given.some((g) => /2 answers chosen/.test(g))));
});

test("a rule on a question on the SAME page is judged after the page settles (the runtime page is live)", async () => {
  const a = await load("qsf", "03-brand-tracker-complex.qsf");
  const b = runScenarios(a.canonical!, a.result!);
  const not = b.scenarios.find((s) => s.id === "display:QID4:not")!;
  assert.equal(not.result, "pass", not.observed);
  const def = a.result!.def!;
  const w = walkSurvey(def, "deepest", 7, { force: { QID3: [9] } });
  assert.equal(w.seen.has("QID4"), false, "choosing 'None of these' hides the follow-up on the same page");
});

test("scenarios are bounded: a count limit and a time budget, the rest reported as not run", async () => {
  const a = await load("word", "07-large.docx");
  const b = runScenarios(a.canonical!, a.result!, { max: 5 });
  assert.equal(b.scenarios.length, 60, "30 display rules × met / not met");
  assert.equal(b.passed + b.failed, 5);
  assert.equal(b.notRun, 55);
  assert.equal(b.failed, 0);
  assert.ok(b.scenarios.filter((s) => s.result === "not_run").every((s) => /not run/.test(s.observed)));
  /* the look-ahead only tries questions something reads: Q4, Q9, … (every 5th rule reads the one before) */
  const rb = readByOthers(a.result!.def!);
  assert.equal(rb.size, 30);
});
