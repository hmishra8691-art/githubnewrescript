import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, AlertSettings } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { routeEvent, deliveryDecision, renderWebhook, renderSlack, renderEmail, renderTeams, normaliseNotifyInput, responseEventData, isLikelyPiiQuestion, RESPONSE_EVENT_OF, type NotifyEvent } from "./notifyEvents.js";
import { buildVariableDictionary } from "./variables.js";
import { flattenVariables } from "./flatten.js";

/* S5b item 6 (AP-09): per-response events */

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Broadband" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Provider?", options: [{ code: "1", label: "A" }, { code: "2", label: "B" }, { code: "9", label: "Other", flags: ["other_specify"] }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Devices?", options: [{ code: "1", label: "Phone" }, { code: "2", label: "TV" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Age?" },
    { id: "q4", code: "Q4", variableName: "EMAIL", type: "open_text", text: "Your e-mail?" },
    { id: "q5", code: "Q5", variableName: "WHY", type: "long_text", text: "Why?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
});
const state = { surveyId: "s", surveyVersion: "1", sessionId: "sess-1", seed: 1, startedAt: "2026-11-01T10:00:00.000Z", status: "complete", answers: { q1: "9", q1__other_9: "SECRET-OTHER", q2: ["1", "2"], q3: 41, q4: "jo@example.com", q5: "SECRET because" }, embedded: { PID: "panel-77" }, calculated: {}, flags: [] } as never;
const R = { sessionId: "sess-1", status: "complete", startedAt: "2026-11-01T10:00:00.000Z", completedAt: "2026-11-01T10:07:00.000Z" };

test("responseEventData: ids, status and times only by default; with includeAnswers closed answers by variable name, likely PII withheld", () => {
  const flat = flattenVariables(def, state) as Record<string, unknown>;
  const dict = buildVariableDictionary(def);
  const bare = responseEventData(def, dict, flat, R, { includeAnswers: false });
  assert.deepEqual(bare, { responseId: "sess-1", status: "complete", startedAt: R.startedAt, completedAt: R.completedAt });
  const full = responseEventData(def, dict, flat, R, { includeAnswers: true });
  assert.equal(full.answers!.Q1, "9");
  assert.equal(full.answers!.Q3, 41);
  assert.ok(Object.keys(full.answers!).some((k) => k.startsWith("Q2")), JSON.stringify(full.answers));
  assert.ok(!("EMAIL" in full.answers!) && !("WHY" in full.answers!), "typed text withheld");
  assert.ok(full.withheld!.includes("EMAIL") && full.withheld!.includes("WHY"));
  assert.doesNotMatch(JSON.stringify(full), /SECRET|jo@example|panel-77/, "no typed text, other text or embedded data");
  const allowed = responseEventData(def, dict, flat, R, { includeAnswers: true, allowFields: ["why"] });
  assert.equal(allowed.answers!.WHY, "SECRET because", "explicitly allowed by name");
  assert.ok(!("EMAIL" in allowed.answers!));
});

test("isLikelyPiiQuestion: typed text, contact semantics / validation, places, files, embedded — not closed answers", () => {
  assert.equal(isLikelyPiiQuestion({ type: "single_select" }), false);
  assert.equal(isLikelyPiiQuestion({ type: "numeric", settings: { semantic: "age" } }), false);
  assert.equal(isLikelyPiiQuestion({ type: "numeric", settings: { semantic: "phone" } }), true);
  assert.equal(isLikelyPiiQuestion({ type: "open_text" }), true);
  assert.equal(isLikelyPiiQuestion({ type: "geo" }), true);
  assert.equal(isLikelyPiiQuestion({ type: "upload" }), true);
  assert.equal(isLikelyPiiQuestion({ type: "numeric_list", fields: [{ type: "email" }] }), true);
  assert.equal(isLikelyPiiQuestion({ type: "single_select", variant: "text.email" }), true);
});

test("routing: response events go only to rules that name them (never a '*' rule, never the default bell); no hourly cap", () => {
  const star = AlertSettings.parse({ rules: [{ id: "r1", events: ["*"], channels: [{ kind: "slack", to: "#ops" }] }] });
  assert.deepEqual(routeEvent({ type: "response.completed" }, [{ scope: "study", settings: star }]), []);
  assert.deepEqual(routeEvent({ type: "response.completed" }, [{ scope: "study", settings: null }]), [], "low severity: no default route");
  const named = AlertSettings.parse({ rules: [{ id: "r1", events: ["response.*"], channels: [{ kind: "webhook", to: "crm" }] }] });
  assert.equal(routeEvent({ type: "response.screened_out" }, [{ scope: "study", settings: named }])[0].ref.to, "crm");
  assert.equal(routeEvent({ type: "ai_interview.distress" }, [{ scope: "study", settings: star }]).length, 1, "a '*' rule still gets operational alerts");
  const d = deliveryDecision({ type: "response.completed", at: new Date().toISOString() }, { digest: "immediate" }, { lastSameAt: null, sentLastHour: 999 }, { maxPerHour: 30, dedupeMinutes: 15 });
  assert.deepEqual(d, { action: "send" });
});

test("rendering: the generic webhook carries the response record; Slack, Teams and e-mail never carry answers", () => {
  const flat = flattenVariables(def, state) as Record<string, unknown>;
  const data = responseEventData(def, buildVariableDictionary(def), flat, R, { includeAnswers: true });
  const n = normaliseNotifyInput({ type: "response.completed", surveyId: "s", ref: "response:sess-1", response: data, detail: { status: "complete" } }, Date.parse(R.completedAt));
  assert.ok(!("error" in n));
  if ("error" in n) return;
  const e: NotifyEvent = { id: "ev1", type: n.type, surveyId: "s", studyTitle: "Broadband", detail: n.payload.detail, response: n.payload.response, at: n.payload.at };
  const hook = renderWebhook(e);
  assert.equal((hook.response as any).responseId, "sess-1");
  assert.equal((hook.response as any).answers.Q3, 41);
  for (const other of [renderSlack(e), renderTeams(e), renderEmail(e)]) assert.doesNotMatch(JSON.stringify(other), /"Q3"|41,|answers/, "no answers outside the webhook");
  // a non-response event never carries a response record, even if one is posted
  const x = normaliseNotifyInput({ type: "study.cost_cap", surveyId: "s", response: data }, 0);
  assert.ok(!("error" in x) && !("response" in x.payload));
  assert.equal(RESPONSE_EVENT_OF.screened.type, "response.screened_out");
});

test("configure_alerts: 'response completed' to a webhook turns the per-response events on; includeAnswers / allowFields; off", () => {
  const empty = SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const c = coerceSurveyActions([{ op: "configure_alerts", events: ["response completed", "screened out"], webhook: "crm-hook", responses: { includeAnswers: true, allowFields: ["AGE"] } }]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(empty, c.actions);
  assert.deepEqual(r.errors, []);
  const al = r.def.alerts!;
  assert.deepEqual(al.rules[0].events, ["response.completed", "response.screened_out"]);
  assert.deepEqual(al.rules[0].channels, [{ kind: "webhook", to: "crm-hook" }]);
  assert.deepEqual({ ...al.responses, events: [...al.responses!.events].sort() }, { enabled: true, events: ["completed", "screened_out"], includeAnswers: true, allowFields: ["AGE"], includeTest: false });
  assert.ok(r.warnings.some((w: string) => /WEBHOOK channels only/.test(w)), JSON.stringify(r.warnings));
  const off = applySurveyActions(r.def, coerceSurveyActions([{ op: "configure_alerts", responses: null }]).actions);
  assert.equal(off.def.alerts!.responses!.enabled, false);
  // without a channel, events alone are still refused; a secret never passes
  assert.ok(coerceSurveyActions([{ op: "configure_alerts", events: ["response completed"] }]).rejected.length === 1);
  assert.ok(coerceSurveyActions([{ op: "configure_alerts", events: ["response completed"], webhook: "https://hooks.example.com/x" }]).rejected.length === 1);
});
