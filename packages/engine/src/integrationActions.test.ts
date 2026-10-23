import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { changeItems } from "./changeItems.js";
import { alertEventsOf, panelPresetOf, alertsWords, panelsWords } from "./integrationActions.js";

const base = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S1", title: "Study", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [{ id: "q1", code: "Q1", type: "single_select", text: "Age?", variableName: "Q1", options: [{ code: 1, label: "18-34" }, { code: 2, label: "35+" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }, { type: "end", id: "e2", status: "screened" }],
});
const run = (def: SurveyDefinition, actions: unknown[]) => { const c = coerceSurveyActions(actions as never); assert.deepEqual(c.rejected, []); return applySurveyActions(def, c.actions); };

test("registered as survey actions", () => {
  for (const op of ["connect_panel", "disconnect_panel", "configure_alerts"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  assert.equal(panelPresetOf("Lucid Marketplace"), "cint");
  assert.equal(panelPresetOf("Pure Spectrum"), "purespectrum");
  assert.equal(panelPresetOf("Amazon Mechanical Turk"), "mturk");
  assert.equal(panelPresetOf("Qualtrics"), null);
});

test("“connect this study to Prolific with completion code ABC123” → def.panels; the survey link captures the id and its ends redirect", () => {
  const r = run(base(), [{ op: "connect_panel", panel: "Prolific", completionCode: "ABC123" }]);
  assert.deepEqual(r.errors, []);
  const p = r.def.panels![0];
  assert.equal(p.key, "prolific"); assert.equal(p.codes.complete, "ABC123"); assert.equal(p.idParam, "PROLIFIC_PID");
  const ed = r.def.flow.find((n) => n.type === "embedded_data") as { fields: { name: string; source: string }[] };
  assert.deepEqual(ed.fields.map((f) => `${f.name}:${f.source}`), ["PROLIFIC_PID:url", "STUDY_ID:url", "SESSION_ID:url"]);
  assert.equal(r.def.deployment.sample.respondentParam, "PROLIFIC_PID");
  const end = r.def.flow.find((n) => n.type === "end" && n.status === "complete") as { redirectUrl?: string };
  assert.equal(end.redirectUrl, "https://app.prolific.com/submissions/complete?cc=ABC123");
  const scr = r.def.flow.find((n) => n.type === "end" && n.status === "screened") as { redirectUrl?: string };
  assert.equal(scr.redirectUrl, undefined, "no screen-out code: that end is left alone");
  assert.ok(r.warnings.some((w) => /Verify with the panel's current integration docs/.test(w)));
  assert.ok(diffSurveys(base(), r.def).summary.includes("Connect the panel Prolific"));
  const items = changeItems(base(), r.def).items;
  assert.ok(items.some((i) => i.field === "panels" && /Prolific \(prolific\).*code ABC123/.test(i.to ?? "")), JSON.stringify(items.map((i) => [i.field, i.to])));
  /* patch by key; a second application is idempotent on the flow */
  const r2 = run(r.def, [{ op: "connect_panel", panel: "prolific", codes: { screenout: "SCR9" } }]);
  assert.equal(r2.def.panels!.length, 1); assert.equal(r2.def.panels![0].codes.screenout, "SCR9"); assert.equal(r2.def.panels![0].codes.complete, "ABC123");
  assert.equal(r2.def.flow.filter((n) => n.type === "embedded_data").length, 1);
});

test("a signing panel leaves the survey's ends alone; secrets and webhook URLs are refused", () => {
  const r = run(base(), [{ op: "connect_panel", panel: "Cint", targets: ["survey", "AI interviews"] }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.def.panels![0].signing.algorithm, "hmac-sha1");
  assert.ok(r.def.flow.filter((n) => n.type === "end").every((n) => !(n as { redirectUrl?: string }).redirectUrl));
  assert.ok(r.warnings.some((w) => /signing secret/.test(w)));
  const c = coerceSurveyActions([{ op: "connect_panel", panel: "Cint", secret: "abc" }, { op: "configure_alerts", events: ["distress"], slack: "https://hooks.slack.com/services/T0/B0/xyz" }] as never);
  assert.equal(c.actions.length, 0);
  assert.match(c.rejected.map((x) => x.reason).join(" | "), /never set through chat.*never set through chat/);
});

test("“send distress alerts to #research-ops on Slack and to me by email” → one rule; merged, removed, quiet hours", () => {
  const r = run(base(), [{ op: "configure_alerts", events: ["distress"], slack: "research-ops", email: "me" }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.def.alerts!.rules, [{ id: "r1", events: ["ai_interview.distress"], channels: [{ kind: "slack", to: "#research-ops" }, { kind: "email", to: "@me" }], digest: "immediate", enabled: true }]);
  assert.ok(r.warnings.some((w) => /matched by name to a channel added in Settings → Alerts/.test(w)));
  assert.equal(alertsWords(r.def.alerts), "ai_interview.distress → slack:#research-ops, email:@me | ≤ 30/h");
  const r2 = run(r.def, [{ op: "configure_alerts", events: ["distress"], teams: "Research" , quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" } }]);
  assert.equal(r2.def.alerts!.rules.length, 1); assert.equal(r2.def.alerts!.rules[0].channels.length, 3);
  assert.equal(r2.def.alerts!.quietHours!.timeZone, "Asia/Kolkata");
  const r3 = run(r2.def, [{ op: "configure_alerts", events: ["completed"], email: "the team", digest: "daily" }]);
  assert.deepEqual(r3.def.alerts!.rules[1], { id: "r2", events: ["ai_interview.completed"], channels: [{ kind: "email", to: "@team" }], digest: "daily", enabled: true });
  const r4 = run(r3.def, [{ op: "configure_alerts", events: ["distress"], remove: true }]);
  assert.equal(r4.def.alerts!.rules.length, 1);
  assert.match(r4.results[0].destructive ?? "", /removes alerts/);
  assert.ok(diffSurveys(r3.def, r4.def).summary.includes("Change the study's alerts"));
  assert.deepEqual(alertEventsOf(["safety flags"]), ["ai_interview.distress", "ai_interview.abuse", "ai_interview.injection", "group_session.flag"]);
  assert.ok("error" in (alertEventsOf(["weather"]) as object));
  const bad = coerceSurveyActions([{ op: "configure_alerts", events: ["distress"] }] as never);
  assert.match(bad.rejected[0].reason, /where should the alerts go/);
});

test("disconnect is destructive; panelsWords", () => {
  const r = run(base(), [{ op: "connect_panel", panel: "mturk", completionCode: "MT1", targets: ["ai_interview"] }]);
  assert.match(panelsWords(r.def.panels), /MTurk-style completion code \(mturk\): id workerId; no end links; code MT1/);
  const r2 = run(r.def, [{ op: "disconnect_panel", panel: "mturk" }]);
  assert.equal(r2.def.panels, undefined);
  assert.match(r2.results[0].destructive ?? "", /removes the MTurk/);
  const r3 = applySurveyActions(base(), coerceSurveyActions([{ op: "disconnect_panel", panel: "dynata" }] as never).actions);
  assert.match(r3.errors.join(), /no panel “dynata”/);
});
