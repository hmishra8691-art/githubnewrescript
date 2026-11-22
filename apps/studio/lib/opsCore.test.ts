import { test } from "node:test";
import assert from "node:assert/strict";
import { PORTAL_TEMPLATES, enforcePortalTemplate, interpretOpsRequest } from "@rescript/engine";
import { PortalSettings } from "@rescript/schema";
import { answerColumn, settingNotes, settingValue, settingsAfter } from "./opsCore.ts";

const templates = PORTAL_TEMPLATES.map((t) => ({ id: t.id, name: t.name }));
const changesOf = (s: string) => { const r = interpretOpsRequest(s, { hasFile: false, lists: [], templates }); assert.equal(r?.op, "settings", s); return (r as { changes: Parameters<typeof settingsAfter>[1] }).changes; };

test("a sentence changes exactly the settings it names, and leaves what was built", () => {
  const before = PortalSettings.parse({ enabled: true, show: { answers: true }, scorecard: { dimensions: [{ id: "wellbeing", label: "Wellbeing", source: { kind: "test_total" } }] }, maxAttempts: 3 });
  const after = settingsAfter(before, changesOf("Let respondents see their scores and change their answers for 48 hours, with two attempts"));
  assert.deepEqual([after.show.scores, after.editing.mode, after.editing.windowHours, after.maxAttempts], [true, "window", 48, 2]);
  assert.deepEqual(after.scorecard, before.scorecard, "the scorecard was touched");
  assert.equal(after.show.comparison, false);
  assert.equal(before.show.scores, false, "the settings passed in were changed in place");
  /* from nothing at all: defaults, then the change */
  assert.equal(settingsAfter(undefined, changesOf("Turn on the respondent portal")).enabled, true);
});

test("a template is applied whole, then the switches asked for; its fixed rules are reported, not hidden", () => {
  const health = PORTAL_TEMPLATES.find((t) => t.name === "Patient-reported outcomes")!;
  const after = settingsAfter(PortalSettings.parse({ enabled: true }), [{ key: "template", value: health.id }, { key: "show.projection", value: true }]);
  assert.equal(after.template, health.id);
  assert.equal(after.show.projection, true, "what was asked for is what is saved");
  /* …and the engine's reader refuses it, which is what the card's note says */
  assert.equal(enforcePortalTemplate(after).show.projection, false);
  assert.notEqual(settingValue(after, "show.projection"), settingValue(enforcePortalTemplate(after), "show.projection"));
  assert.equal(settingsAfter(after, [{ key: "template", value: null }]).template, undefined);
});

test("values are said the way the screen says them", () => {
  const p = PortalSettings.parse({ enabled: true, editing: { mode: "window", windowHours: 24 } });
  assert.deepEqual([settingValue(p, "enabled"), settingValue(p, "editing"), settingValue(p, "maxAttempts"), settingValue(p, "show.scores"), settingValue(p, "template"), settingValue(p, "identity")],
    ["on", "for 24 hours", "the survey's own rule", "off", "standard portal", "one account per person"]);
});

test("what depends on what is said before it is applied", () => {
  const p = (show: Record<string, boolean>, extra: Record<string, unknown> = {}) => PortalSettings.parse({ enabled: true, show, ...extra });
  assert.match(settingNotes(p({ history: true }), { scoredTest: false }).join(" "), /only shown when respondents can see their answers/);
  assert.match(settingNotes(p({ trends: true, scores: true }), { scoredTest: false }).join(" "), /needs two things/);
  assert.match(settingNotes(p({ comparison: true }), { scoredTest: false }).join(" "), /about scores/);
  assert.match(settingNotes(p({ scores: true }), { scoredTest: false }).join(" "), /No score is defined yet/);
  assert.doesNotMatch(settingNotes(p({ scores: true }), { scoredTest: true }).join(" "), /No score is defined/);
  assert.match(settingNotes(p({ answers: true }, { editing: { mode: "until_locked" } }), { scoredTest: true }).join(" "), /scored test/);
  assert.deepEqual(settingNotes(p({ answers: true, history: true }), { scoredTest: false }), []);
});

test("answering “which column is the email?” moves the field and keeps everything else", () => {
  const mapping = { "First name": "name", email: "email", "manager email": "embedded", id: "external_id" };
  const next = answerColumn(mapping, { field: "email", ask: "", options: ["email", "manager email"], chosen: "email" }, "manager email");
  assert.deepEqual(next, { "First name": "name", email: "embedded", "manager email": "email", id: "external_id" });
  assert.deepEqual(Object.keys(next), Object.keys(mapping), "the reading order changed");
});
