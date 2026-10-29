import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { assessmentSecretsPresent } from "@rescript/engine";
import { assessmentResultRow, respondentDefinition, resultForSession, scoreForSubmission } from "./assessmentPayload.ts";
import { attemptOf, launchPaper, paperByToken, paperResponses, submitAttempt } from "./assessmentSandbox.ts";

/*
 * ASSESSMENTS ON THE RUNTIME (K4, 2026-10-25; ported 2026-10-29, step 4A): the answer key never reaches a respondent's browser before
 * submission — every entry point that hands a definition to the browser strips it — and a completed paper is
 * scored on the server against the full definition.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", p), "utf8");
const paper = () => SurveyDefinition.parse({
  meta: { id: "s", code: "UPSC", title: "Mock" },
  questions: [1, 2, 3].map((n) => ({ id: `q${n}`, code: `Q${n}`, variableName: `Q${n}`, type: "single_select", text: `Question ${n}`, options: [{ code: 1, label: "Alpha", meta: n === 1 ? { correct: true, explanation: "SECRET-META" } : undefined }, { code: 2, label: "Beta" }], assessment: { correct: [2], topic: "Polity", explanation: `SECRET-EXPLANATION-${n}`, optionExplanations: { "1": `SECRET-WRONG-${n}` } } })),
  flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
  assessment: { defaultMarks: 2, defaultNegativeMarks: 0.66, passPercent: 50 },
});

test("respondentDefinition strips the key, explanations and mistake notes; marks and topics stay; a raw stored JSON works too", () => {
  for (const d of [paper(), JSON.parse(JSON.stringify(paper()))]) {
    const out = respondentDefinition(d);
    const json = JSON.stringify(out);
    assert.doesNotMatch(json, /SECRET/);
    assert.deepEqual(assessmentSecretsPresent(out as never), []);
    assert.equal((out as typeof d).questions[0].assessment!.withheld, true);
    assert.equal((out as typeof d).questions[0].assessment!.topic, "Polity");
    assert.match(JSON.stringify(d), /SECRET-EXPLANATION-1/, "the stored definition is untouched");
  }
  assert.equal(respondentDefinition(null), null);
});

test("every entry point that sends a definition to a respondent's browser goes through respondentDefinition", () => {
  assert.match(src("app/api/runtime-definition/[versionId]/route.ts"), /NextResponse\.json\(respondentDefinition\(definition\)/, "live (/s → RunnerLive → runtime-definition)");
  assert.match(src("app/t/[client]/[study]/page.tsx"), /definition=\{respondentDefinition\(dep\.definition\)\}/, "test link");
  assert.match(src("app/x/[token]/page.tsx"), /definition=\{respondentDefinition\(paper\.def\)\}/, "sandbox take page");
  assert.match(src("app/preview/page.tsx"), /definition=\{respondentView \? respondentPreviewDef : def\}/, "preview as a respondent");
  assert.match(src("app/api/session/save/route.ts"), /scoreForSubmission\(def/, "the save route scores against the server's definition");
  assert.match(src("app/api/session/save/route.ts"), /from\("assessment_results"\)\.upsert\(assessmentResultRow\(existing, sessionId/, "and stores the result per session (0076)");
  /* the results route is token-bound: the session id, a completed session only */
  const results = src("app/api/session/assessment/route.ts");
  assert.match(results, /\.eq\("session_id", sessionId\)/);
  assert.match(results, /row\.status !== "complete"/);
  /* the sandbox report of an attempt needs the paper token AND the attempt id */
  assert.match(src("app/api/assessment/sandbox/route.ts"), /attemptOf\(p, String\(body\.attemptId/);
  assert.match(src("app/x/[token]/page.tsx"), /attemptOf\(paper, attemptId\)/);
});

test("scoreForSubmission: UPSC marking against the server's definition; the respondent's report", () => {
  const s = scoreForSubmission(paper(), { q1: 2, q2: 1 })!;
  assert.equal(s.result.marks, 1.34);
  assert.equal(s.result.passed, false); assert.equal(s.result.questions[2].status, "unattempted");
  assert.equal(s.report!.questions![1].mistakeExplanation, "SECRET-WRONG-2", "after submission the respondent sees why their option was wrong");
  assert.equal(scoreForSubmission(SurveyDefinition.parse({ meta: { id: "x", title: "x" } }), {}), null, "not an assessment");
  assert.equal(scoreForSubmission(null, {}), null);
});

test("the sandbox store: launch keeps the full paper server-side; submit scores; responses give the CSV with score columns", () => {
  const p = launchPaper(paper());
  assert.equal(paperByToken(p.token), p);
  assert.equal(paperByToken("not-a-token"), null);
  const a = submitAttempt(p, { q1: 2, q2: 2, q3: 2 });
  assert.equal(a.result.marks, 6); assert.equal(a.result.passed, true);
  const r = paperResponses(p);
  assert.match(r.csv.split("\n")[0], /SCORE,SCORE_MAX,PCT,PASS/);
  assert.match(r.csv.split("\n")[1], /,6,6,100,1,/);
  assert.equal(r.analytics.n, 1);
  /* attempt ids are 128-bit; a reload needs the paper token AND the id */
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.equal(attemptOf(p, a.id), a);
  assert.equal(attemptOf(p, a.id.slice(0, 16)), null);
  assert.equal(attemptOf(launchPaper(paper()), a.id), null, "another paper's token does not open this attempt");
});

test("the stored result per session (0076): the row; served again only when scored against the same key, else re-scored", () => {
  const def = paper();
  const s = scoreForSubmission(def, { q1: 2, q2: 2 })!;
  const row = assessmentResultRow({ id: "r1", survey_id: "s1", version_id: "v1", is_test: true }, "sess-0123456789abcdef", s.result);
  assert.deepEqual([row.session_id, row.response_id, row.survey_id, row.version_id, row.is_test, row.score, row.max_score, row.passed], ["sess-0123456789abcdef", "r1", "s1", "v1", true, 4, 6, true]);
  assert.equal(row.key_fingerprint, s.result.keyFingerprint);
  assert.equal(resultForSession(def, { q1: 2, q2: 2 }, s.result)!.source, "stored");
  /* the key changed since: re-scored from the answers, deterministically */
  const changed = structuredClone(def); changed.questions[0].assessment!.correct = [1];
  const again = resultForSession(changed, { q1: 2, q2: 2 }, s.result)!;
  assert.equal(again.source, "rescored"); assert.equal(again.result.marks, 1.34);
  /* before 0076 (nothing stored): re-scored */
  assert.equal(resultForSession(def, { q1: 2, q2: 2 }, null)!.source, "rescored");
  /* the show-results policy: never → no report, the score is still computed for the researcher */
  const never = structuredClone(def); never.assessment!.showResults = "never";
  const n = resultForSession(never, { q1: 2 }, null)!;
  assert.equal(n.report, null); assert.equal(n.result.marks, 2);
  assert.equal(resultForSession(SurveyDefinition.parse({ meta: { id: "x", title: "x" } }), {}, null), null, "not an assessment");
});
