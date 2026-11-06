import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { adviseSettings, describeSettingsAdvice } from "./settingsAdvice.js";
import { dateWords } from "./nlIntent.js";
import { fieldworkWindow, isAnonymous } from "./deploymentActions.js";

/* INTELLIGENT MODE IM2 — every deployment setting by action and by sentence; settings advice with a because */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const base = (extra: Record<string, unknown> = {}, qs: unknown[] = []) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Study" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q2", code: "Q2", variableName: "SPEC", type: "single_select", text: "What is your specialty?", options: opts("Cardiology", "Oncology") },
    ...qs,
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2", ...qs.map((q) => (q as { id: string }).id)] }] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});
const one = (def: SurveyDefinition, s: string) => {
  const out = interpretRequest(def, s);
  assert.equal(out.kind, "actions", `${s}: ${JSON.stringify(out).slice(0, 300)}`);
  const applied = applySurveyActions(def, (out as unknown as { actions: never[] }).actions);
  assert.ok(applied.valid, JSON.stringify(applied.errors));
  return applied.def;
};

test("set_deployment through the gate: every field", () => {
  const c = coerceSurveyActions([{ op: "set_deployment", access: "password", password: "pharma26", allowRetake: false, activeFrom: "2026-12-01", activeUntil: "2026-12-21", speechInput: false, speechServer: false, anonymous: true }]);
  assert.equal(c.rejected.length, 0, JSON.stringify(c.rejected));
  const out = applySurveyActions(base(), c.actions);
  assert.ok(out.valid, JSON.stringify(out));
  const d = out.def.deployment;
  assert.equal(d.access.mode, "password"); assert.equal(d.access.password, "pharma26");
  assert.equal(d.activeFrom, "2026-12-01T00:00:00.000Z"); assert.equal(d.activeUntil, "2026-12-21T00:00:00.000Z");
  assert.equal(d.speechInput, false); assert.equal(isAnonymous(out.def), true);
});

test("the gate refuses what cannot hold", () => {
  assert.equal(coerceSurveyActions([{ op: "set_deployment", access: "secret" }]).rejected.length, 1);
  assert.equal(coerceSurveyActions([{ op: "set_deployment", activeUntil: "next week" }]).rejected.length, 1);
  const pwless = applySurveyActions(base(), coerceSurveyActions([{ op: "set_deployment", access: "password" }]).actions);
  assert.equal(pwless.results[0].ok, false);
  const backwards = applySurveyActions(base(), coerceSurveyActions([{ op: "set_deployment", activeFrom: "2026-12-10", activeUntil: "2026-12-01" }]).actions);
  assert.equal(backwards.results[0].ok, false);
  /* a model writing the access into set_survey_settings means set_deployment */
  assert.equal((coerceSurveyActions([{ op: "set_survey_settings", anonymous: true }]).actions[0] as { op: string }).op, "set_deployment");
});

test("anonymity names the questions that would break it", () => {
  const def = base({}, [{ id: "q3", code: "Q3", variableName: "EMAIL", type: "open_text", text: "What is your email address?" }]);
  const out = applySurveyActions(def, [{ op: "set_deployment", anonymous: true } as never]);
  assert.ok(out.results[0].ok);
  assert.ok(out.warnings.some((w) => /Q3/.test(w) && /not anonymous/.test(w)), JSON.stringify(out.warnings));
});

test("settings sentences, read without a model", () => {
  const def = base();
  assert.equal(isAnonymous(one(def, "Make the survey anonymous")), true);
  assert.equal(one(def, "Password protect the survey with Oncology26").deployment.access.mode, "password");
  assert.equal(one(def, "Use unique links").deployment.access.mode, "unique_links");
  assert.equal(one(def, "Invitation only").deployment.access.mode, "invitation");
  assert.equal(one(def, "Allow retakes").deployment.access.allowRetake, true);
  assert.match(one(def, "Close the survey on 21 December 2026").deployment.activeUntil ?? "", /^2026-12-21T23:59:59/);
  assert.match(one(def, "Open the survey on 2026-12-01").deployment.activeFrom ?? "", /^2026-12-01/);
  assert.equal(one(def, "Turn off dictation").deployment.speechInput, false);
  assert.equal(one(def, "Hide the progress bar").branding.layout.progressBar, "none");
  assert.equal(one(def, "Disable the back button").branding.buttons.showBack, false);
  const noop = interpretRequest(def, "Respondents should be able to save and resume later") as { kind: string; noop?: boolean; reason: string };
  assert.equal(noop.kind, "refused"); assert.ok(noop.noop); assert.match(noop.reason, /always on/);
  assert.equal((interpretRequest(def, "One response per person") as { noop?: boolean }).noop, true);
});

test("dates in words", () => {
  const now = new Date("2026-11-06T10:00:00Z");
  assert.equal(dateWords("1 December 2026", now), "2026-12-01");
  assert.equal(dateWords("December 1st", now), "2026-12-01");
  assert.equal(dateWords("3 March", now), "2027-03-03");
  assert.equal(dateWords("31 February", now), null);
});

test("the fieldwork window", () => {
  const d = { activeFrom: "2026-12-01T00:00:00Z", activeUntil: "2026-12-21T23:59:59Z" };
  assert.deepEqual(fieldworkWindow(d, Date.parse("2026-12-10T00:00:00Z")), { open: true });
  assert.equal((fieldworkWindow(d, Date.parse("2026-11-30T00:00:00Z")) as { reason: string }).reason, "not_yet");
  assert.equal((fieldworkWindow(d, Date.parse("2026-12-22T00:00:00Z")) as { reason: string }).reason, "closed");
  assert.deepEqual(fieldworkWindow({ activeUntil: "garbage" }), { open: true });
  assert.deepEqual(fieldworkWindow(undefined), { open: true });
});

test("advice from the master prompt's brief: every recommendation has a because and evidence", () => {
  const def = base({}, [{ id: "q3", code: "Q3", variableName: "TREAT", type: "single_select", text: "Which treatment do you prescribe first for this diagnosis?", options: opts("A", "B") }]);
  const brief = "I am conducting healthcare research among doctors in India. I need 1,000 completed responses, with age, specialty, and geographic quotas. Finish in three weeks, no back button, with a consent screen. I want a production-like test before launching the survey.";
  const advice = adviseSettings(def, brief, Date.parse("2026-11-06T00:00:00Z"));
  const by = Object.fromEntries(advice.map((a) => [a.id, a]));
  for (const a of advice) { assert.ok(a.because.length > 20, a.id); }
  assert.equal(by.anonymous.status, "change"); assert.match(by.anonymous.because, /health/);
  assert.equal(by.access.status, "change"); assert.match(by.access.because, /professional/);
  assert.equal(by.retakes.status, "keep");
  assert.equal(by.back_button.status, "change");
  assert.equal(by.closing_date.status, "change"); assert.match(by.closing_date.recommended, /2026-11-27/);
  assert.equal(by.consent.status, "change"); assert.ok(by.consent.sentence);
  /* every proposed action applies */
  const applied = applySurveyActions(def, advice.flatMap((a) => a.actions));
  assert.ok(applied.valid && applied.results.every((x) => x.ok), JSON.stringify(applied.results.filter((x) => !x.ok)));
  assert.match(describeSettingsAdvice(advice), /because/);
});

test("no research type table: the same brief words without sensitive questions do not ask for anonymity", () => {
  const advice = adviseSettings(base(), "Consumer research among 1,500 urban adults on snacking habits, 15 minutes.");
  assert.ok(!advice.some((a) => a.id === "anonymous"));
  assert.ok(!advice.some((a) => a.id === "access"), "an open general-population study keeps its open link");
});

test("'Recommend the settings for this study' proposes the changes with their reasons", () => {
  const def = base({ research: { objective: "Understand how oncologists in Germany choose a first-line treatment for this diagnosis", population: "oncologists in Germany", sampleSize: 300, hypotheses: [] } });
  const out = interpretRequest(def, "Recommend the settings for this study") as { kind: string; understood: string; actions: { op: string }[] };
  assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 400));
  assert.match(out.understood, /because/);
  assert.ok(out.actions.some((a) => a.op === "set_deployment"));
});

test("bots and duplicates: the rules that detect them, switched on", () => {
  const def = base();
  const out = interpretRequest(def, "Prevent duplicate responses and add bot protection") as { kind: string; actions: { op: string; rules?: Record<string, unknown> }[]; understood: string };
  assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 300));
  const applied = applySurveyActions(def, out.actions as never);
  assert.ok(applied.valid);
  for (const id of ["bot.machine_timing", "device.webdriver", "duplicate.multi_signal", "network.duplicate_ip"]) assert.equal(applied.def.quality.rules[id]?.enabled, true, id);
});

test("a consent screen and an expiry date, in one sentence", () => {
  const def = base();
  const out = interpretRequest(def, "Add a consent screen at the start and set the survey to expire on 30 November 2026") as unknown as { kind: string; actions: never[] };
  assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 300));
  const applied = applySurveyActions(def, out.actions);
  assert.ok(applied.valid, JSON.stringify(applied.errors));
  const consent = applied.def.questions.find((q) => q.variableName === "CONSENT")!;
  assert.ok(consent && consent.required);
  const first = (applied.def.flow[0] as { children: { questionIds: string[] }[] }).children[0].questionIds;
  assert.deepEqual(first, [consent.id], "alone on the first page");
  assert.match(applied.def.deployment.activeUntil ?? "", /^2026-11-30/);
  assert.equal((interpretRequest(applied.def, "Add a consent screen") as { noop?: boolean }).noop, true);
});

test("the study's context in the same sentence as the ask", () => {
  const def = base({}, [{ id: "q3", code: "Q3", variableName: "RX", type: "single_select", text: "Which treatment do you prescribe first?", options: opts("A", "B") }]);
  const out = interpretRequest(def, "This is pharmaceutical research among 300 physicians in Germany; configure the survey settings") as unknown as { kind: string; understood: string; actions: { op: string; access?: string }[] };
  assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 300));
  assert.ok(out.actions.some((a) => a.op === "set_deployment" && a.access === "unique_links"), JSON.stringify(out.actions));
  assert.match(out.understood, /because/);
});

test("the consent advice's sentence is one the reader acts on", () => {
  const advice = adviseSettings(base(), "Survey of 200 nurses about workplace harassment, with an ethics consent page.");
  const c = advice.find((a) => a.id === "consent")!;
  assert.ok(c?.sentence);
  assert.equal(interpretRequest(base(), c.sentence!).kind, "actions");
});
