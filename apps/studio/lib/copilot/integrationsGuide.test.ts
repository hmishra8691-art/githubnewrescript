import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, capabilityRegistry } from "@rescript/engine";
import { COPILOT_INTEGRATIONS_GUIDE, integrationsIntent } from "./integrationsGuide.ts";
import { COPILOT_SYSTEM_PROMPT, copilotUserPrompt } from "./prompt.ts";
import { COPILOT_STABLE_GUIDES, copilotCall } from "../aiPromptCache.ts";

/*
 * THE PANELS & ALERTS GUIDE (2026-10-22, G3): sent with requests about panels or alerts only, cached like every
 * guide; its worked examples are the two sentences of the brief and apply as written; secrets are refused.
 */
const lines = (g: string) => g.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l));
const def = () => SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "Study" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });

test("sent for panel and alert requests, not otherwise; cached; the system prompt untouched", () => {
  for (const m of ["connect this study to Prolific with completion code ABC123", "send distress alerts to #research-ops on Slack and to me by email", "set up Cint end links with hashing", "notify me when the quota is full", "alerts via webhook please", "प्रोलिफिक से जोड़ो"]) {
    assert.ok(integrationsIntent(m), m);
    const p = copilotUserPrompt({ outline: "(survey)", surveyLanguage: "English", mode: "edit", message: m });
    const [system] = copilotCall(p);
    assert.ok(system.some((b) => b.includes(COPILOT_INTEGRATIONS_GUIDE)), `lifted into the cached prefix: ${m}`);
  }
  for (const m of ["Add a question about price", "make Q3 required", "show an alert popup when Q2 is empty", "Which panel of the dashboard shows awareness?"]) assert.ok(!integrationsIntent(m), m);
  assert.ok(COPILOT_STABLE_GUIDES.includes(COPILOT_INTEGRATIONS_GUIDE));
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800);
  assert.ok(COPILOT_INTEGRATIONS_GUIDE.length < 2_600, `${COPILOT_INTEGRATIONS_GUIDE.length}`);
  for (const w of ["NEVER put a webhook URL", "verified with the panel's current docs", "Never say alerts were sent"]) assert.ok(COPILOT_INTEGRATIONS_GUIDE.includes(w), w);
});

test("the two worked examples are the brief's sentences and apply as written", () => {
  const [prolific, alerts] = lines(COPILOT_INTEGRATIONS_GUIDE);
  const c = coerceSurveyActions([prolific, alerts]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(def(), c.actions);
  assert.deepEqual(r.errors, []);
  assert.equal(r.def.panels![0].codes.complete, "ABC123");
  assert.deepEqual(r.def.alerts!.rules[0].channels, [{ kind: "slack", to: "#research-ops" }, { kind: "email", to: "@me" }]);
});

test("the registry knows panels and alerts (the actions it names exist), and their configuration", () => {
  const reg = capabilityRegistry();
  const panels = reg.find((x) => x.id === "platform:panels")!, alerts = reg.find((x) => x.id === "platform:alerts")!;
  assert.deepEqual(panels.implementedAs?.actions, ["connect_panel", "disconnect_panel"]);
  assert.deepEqual(alerts.implementedAs?.actions, ["configure_alerts"]);
  assert.equal(panels.status, "supported"); assert.deepEqual(panels.services, [], "configuring never needs a database: the sandbox is not refused");
  assert.deepEqual(reg.find((x) => x.id === "platform:alert_channels")!.configuration, ["INTEGRATIONS_SECRET_KEY"]);
});
