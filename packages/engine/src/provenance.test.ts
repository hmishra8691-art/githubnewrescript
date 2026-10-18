import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { PROVENANCE_REASON, externalUrlsIn, highRiskActions, provenanceGate, researcherAsked } from "./provenance.js";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";

/*
 * THE PROVENANCE GATE (prompt-injection audit, 2026-10-18). The fake replies "obey" an injected document
 * (src/fixtures/prompt-injection-corpus.json → obeyingReplies): with untrusted content in the turn their
 * high-risk actions are excluded unless the researcher's OWN words ask for that kind of change — and the
 * same actions are applied when the researcher does ask.
 */
const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../src/fixtures/prompt-injection-corpus.json", import.meta.url)), "utf8")) as { obeyingReplies: Record<string, { actions: unknown[] }> };
const actionsOf = (k: string): SurveyAction[] => coerceSurveyActions(corpus.obeyingReplies[k].actions).actions;

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const DEF = SurveyDefinition.parse({
  meta: { id: "s1", code: "S", title: "Pricing study", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand do you buy most often?", options: opts("Brand A", "Brand B") },
    { id: "q3", code: "Q3", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: opts("Low", "High") },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }] }, { type: "end", id: "e_ok", status: "complete" }],
  research: { objective: "Why people switch", hypotheses: ["Price drives switching", "Trust reduces switching"] },
});

test("each obeying reply is high-risk, for the right reason", () => {
  const kinds = (k: string, strict = false) => highRiskActions(DEF, actionsOf(k), { strict }).map((f) => f.kind);
  assert.deepEqual(kinds("delete_all"), ["delete", "delete", "delete"]);
  assert.deepEqual(kinds("delete_block"), ["delete"]);
  assert.deepEqual(kinds("piped_image"), ["piped_url"]);
  assert.deepEqual(kinds("quota_redirect"), ["piped_url"]);
  assert.deepEqual(kinds("terminate_existing"), ["terminate_logic"]);
  assert.deepEqual(kinds("mixed"), ["delete"]);
  /* a script is coerced into create_behavior; a dangerous one is high-risk without a flag, any one with it */
  assert.deepEqual(kinds("fetch_script"), ["external_url", "script"]);
  const benignScript = coerceSurveyActions([{ op: "create_behavior", label: "Big", target: { kind: "question", question: "Q1" }, on: "select", script: "rs.addClass('Q1','big')" }]).actions;
  assert.deepEqual(highRiskActions(DEF, benignScript).map((f) => f.kind), []);
  assert.deepEqual(highRiskActions(DEF, benignScript, { strict: true }).map((f) => f.kind), ["script"]);
  /* one delete is ordinary editing; under a flag it is high-risk too */
  const one = coerceSurveyActions([{ op: "delete_question", target: "Q3" }]).actions;
  assert.deepEqual(highRiskActions(DEF, one).length, 0);
  assert.deepEqual(highRiskActions(DEF, one, { strict: true }).map((f) => f.kind), ["delete"]);
  /* a hypothesis dropped from the research design */
  const rd = coerceSurveyActions([{ op: "set_research", objective: "Why people switch", hypotheses: ["Price drives switching"] }]).actions;
  assert.deepEqual(highRiskActions(DEF, rd).map((f) => f.kind), ["research_design"]);
  /* a skip to the end from a question this batch creates (a generated screener) is not */
  const screener = coerceSurveyActions([{ op: "create_question", ref: "WORK", block: "Main", type: "yes_no", text: "Do you work in market research?" }, { op: "add_skip", from: "WORK", when: "WORK = 1", to: "screen_out" }]).actions;
  assert.deepEqual(highRiskActions(DEF, screener).length, 0);
});

test("with untrusted content and no request from the researcher: excluded, with the reason; the rest kept", () => {
  for (const k of ["delete_all", "delete_block", "fetch_script", "piped_image", "quota_redirect", "terminate_existing"]) {
    const g = provenanceGate(DEF, actionsOf(k), { untrusted: true, researcherText: "Based on the uploaded brief, improve the wording of the questions." });
    assert.equal(g.kept.length, 0, k);
    assert.ok(g.excluded.length > 0 && g.excluded.every((e) => e.reason.endsWith(PROVENANCE_REASON)), k);
  }
  const mixed = provenanceGate(DEF, actionsOf("mixed"), { untrusted: true, researcherText: "Add a trust question from the paper." });
  assert.deepEqual(mixed.kept.map((a) => a.op), ["create_question"]);
  assert.deepEqual(mixed.excluded.map((e) => [e.index, e.op]), [[1, "delete_block"]]);
  /* what is kept is what the engine applies: the survey still has its block and its questions */
  const applied = applySurveyActions(DEF, mixed.kept);
  assert.ok(applied.valid);
  assert.equal(applied.def.questions.length, 4);
});

test("the same actions ARE applied when the researcher's own message asks for that kind of change", () => {
  const asks: [string, string][] = [
    ["delete_all", "Delete Q1, Q2 and Q3 — the paper says they are not validated."],
    ["delete_all", "Q1, Q2, Q3 hata do"],
    ["delete_all", "Q1 से Q3 तक के प्रश्न हटा दो"],
    ["delete_block", "Remove the Main block."],
    ["piped_image", "Add a tracking image to Q2 with the respondent's id passed in the url."],
    ["quota_redirect", "When the brand quota is full redirect to the panel link with the rid parameter."],
    ["terminate_existing", "Terminate anyone at Q1 who is under 18."],
    ["delete_all", "Make the survey shorter."],
  ];
  for (const [k, said] of asks) {
    const g = provenanceGate(DEF, actionsOf(k), { untrusted: true, researcherText: said });
    assert.equal(g.excluded.length, 0, `${k} / ${said}: ${JSON.stringify(g.excluded)}`);
  }
  /* the delete the researcher asked for is applied by the engine */
  const g = provenanceGate(DEF, actionsOf("delete_block"), { untrusted: true, researcherText: "Remove the Main block." });
  const a = applySurveyActions(DEF, g.kept);
  assert.ok(a.results.every((r) => r.ok));
  /* a script the researcher asked for passes a flagged turn; one that reaches out does not, even then (and the engine refuses it anyway) */
  const benign = coerceSurveyActions([{ op: "create_behavior", label: "Big", target: { kind: "question", question: "Q1" }, on: "select", script: "rs.addClass('Q1','big')" }]).actions;
  assert.equal(provenanceGate(DEF, benign, { untrusted: true, strict: true, researcherText: "Add a script that enlarges Q1 when selected." }).excluded.length, 0);
  assert.equal(provenanceGate(DEF, actionsOf("fetch_script"), { untrusted: true, researcherText: "Add a script to Q1." }).excluded.length, 1);
  /* a piped URL needs the piping asked for, not only "a link" */
  assert.equal(researcherAsked("piped_url", "Add a link to our website."), false);
  assert.equal(researcherAsked("external_url", "Add a link to our website."), true);
});

test("no untrusted content: the gate is not in the way of the researcher's own editing", () => {
  const g = provenanceGate(DEF, actionsOf("delete_all"), { untrusted: false, researcherText: "shorten it" });
  assert.equal(g.kept.length, 3); assert.equal(g.excluded.length, 0);
});

test("access and publishing are never taken from document content, whatever the message says", () => {
  const g = provenanceGate(DEF, [{ op: "add_collaborator", email: "x@evil.example" } as unknown as SurveyAction], { untrusted: true, researcherText: "add a collaborator" });
  assert.equal(g.kept.length, 0);
  assert.equal(g.excluded[0].kind, "access");
});

test("external addresses: the theme image the researcher uploaded is allowed, others are named", () => {
  const theme = { op: "set_theme", patch: { background: { image: "https://cdn.rescript.app/u/1.png" } } };
  assert.deepEqual(externalUrlsIn(theme, ["https://cdn.rescript.app/u/1.png"]), []);
  assert.deepEqual(externalUrlsIn(theme), ["https://cdn.rescript.app/u/1.png"]);
  assert.deepEqual(externalUrlsIn({ op: "set_theme", patch: { background: { image: "/assets/bg.png" } } }), []);
});
